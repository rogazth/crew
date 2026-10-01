use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::{Arc, Mutex};

use base64::Engine as _;
use crew_protocol::{AttachedFile, AttachedFileKind, FolderEntry};
use serde::Serialize;

use crate::providers::InlineImage;

/// Above this the in-memory fuzzy match on the frontend stops feeling instant.
const MAX_PROJECT_FILES: usize = 20_000;
const MAX_TEXT_FILE_BYTES: u64 = 8 * 1024 * 1024;
const MAX_TEMP_FILE_BYTES: usize = 32 * 1024 * 1024;
const SKIPPED_DIRS: &[&str] = &[
    "node_modules", ".git", "target", "dist", "build", ".next", ".venv", "vendor",
];
/// A git-ignored folder holding more files than this is a cache or a build,
/// not notes someone keeps out of the repo, and is left out whole.
const IGNORED_FOLDER_BUDGET: usize = 1_000;
/// All the ignored folders of a repo together.
const IGNORED_BUDGET: usize = 2_000;
/// More loose ignored files than this in one folder are generated, not kept.
const LOOSE_IGNORED_BUDGET: usize = 20;
/// Ignored folders that are always caches, however few files they hold.
const CACHE_DIRS: &[&str] = &[
    "__pycache__", ".cache", ".turbo", ".parcel-cache", ".pytest_cache", ".mypy_cache",
    ".ruff_cache", ".gradle", ".terraform", ".svelte-kit", ".nuxt", "coverage", "Pods",
    "DerivedData",
];

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct ProjectFile {
    pub name: String,
    pub path: String,
    pub relative: String,
}

/// What ⌘P matches against: what git tracks, what it has not seen yet, and
/// the small folders it ignores (`.ai/`, `.env`), which are notes more often than builds.
pub fn list(cwd: &str) -> Result<Vec<ProjectFile>, String> {
    list_capped(cwd, MAX_PROJECT_FILES)
}

pub(crate) fn list_capped(cwd: &str, cap: usize) -> Result<Vec<ProjectFile>, String> {
    let root = PathBuf::from(cwd);
    if !root.is_dir() {
        return Err(format!("{cwd}: Not a directory"));
    }
    // git knows the ignore rules already; walking is the slow fallback.
    Ok(git_ls_files(&root, cap).unwrap_or_else(|| walk_ignoring(&root, cap)))
}

fn git_ls_files(root: &Path, cap: usize) -> Option<Vec<ProjectFile>> {
    let mut files = Vec::new();
    ls_repo(root, root, &mut files, cap)?;
    Some(files)
}

/// The NUL-separated paths `git ls-files` prints for `args`, relative to the repo.
fn git_paths(repo: &Path, args: &[&str]) -> Option<Vec<String>> {
    let output = Command::new("git").arg("-C").arg(repo).args(args).output().ok()?;
    if !output.status.success() {
        return None;
    }
    Some(
        output
            .stdout
            .split(|byte| *byte == 0)
            .filter(|chunk| !chunk.is_empty())
            .map(|chunk| String::from_utf8_lossy(chunk).replace('\\', "/"))
            .collect(),
    )
}

fn repo_prefix(root: &Path, repo: &Path) -> Option<String> {
    Some(repo.strip_prefix(root).ok()?.to_string_lossy().replace('\\', "/"))
}

fn under(prefix: &str, entry: String) -> String {
    if prefix.is_empty() {
        entry
    } else {
        format!("{prefix}/{entry}")
    }
}

/// git lists a nested repo as a single `dir/` entry, so each one is asked for its own files.
fn ls_repo(root: &Path, repo: &Path, files: &mut Vec<ProjectFile>, cap: usize) -> Option<()> {
    // Both listings walk the tree; side by side they take the time of one.
    let ignored = {
        let repo = repo.to_path_buf();
        std::thread::spawn(move || git_paths(&repo, &["ls-files", "-oi", "--exclude-standard", "--directory", "-z"]))
    };
    let entries = git_paths(repo, &["ls-files", "-co", "--exclude-standard", "-z"])?;
    let prefix = repo_prefix(root, repo)?;
    for entry in entries {
        if files.len() >= cap {
            return Some(());
        }
        let relative = under(&prefix, entry);
        if has_skipped_dir(&relative) {
            continue;
        }
        if let Some(dir) = relative.strip_suffix('/') {
            let nested = root.join(dir);
            if nested.join(".git").is_dir() {
                let _ = ls_repo(root, &nested, files, cap);
            }
            continue;
        }
        if let Some(file) = make_file(root, relative) {
            files.push(file);
        }
    }
    if let Ok(Some(ignored)) = ignored.join() {
        ls_ignored(root, &prefix, ignored, files, cap);
    }
    Some(())
}

/// What the repo ignores, each folder whole or not at all: `--directory` names
/// an ignored folder without going in, and the walk gives up past the budget.
/// Loose ignored files go by the folder they sit in: a `.env` is kept, a folder
/// of compiled views is not.
fn ls_ignored(root: &Path, prefix: &str, entries: Vec<String>, files: &mut Vec<ProjectFile>, cap: usize) {
    let mut folders: Vec<String> = Vec::new();
    let mut loose: HashMap<&str, Vec<String>> = HashMap::new();
    let entries: Vec<String> = entries
        .into_iter()
        .map(|entry| under(prefix, entry))
        .filter(|relative| {
            !has_skipped_dir(relative) && !relative.split('/').any(|segment| CACHE_DIRS.contains(&segment))
        })
        .collect();
    for relative in &entries {
        // A folder of nothing but ignored files is listed, and so are its files.
        if folders.iter().any(|folder| relative.starts_with(folder.as_str())) {
            continue;
        }
        if relative.ends_with('/') {
            folders.push(relative.clone());
        } else {
            let parent = relative.rsplit_once('/').map_or("", |(parent, _)| parent);
            loose.entry(parent).or_default().push(relative.clone());
        }
    }
    // Notes sit near the top (`.ai/`); uploads and caches pile up deep inside an
    // app. The shallow ones go first, until everything ignored reaches the budget.
    folders.sort_by_key(|folder| (folder.matches('/').count(), folder.clone()));
    let mut left = IGNORED_BUDGET;
    for folder in folders {
        if files.len() >= cap || left == 0 {
            break;
        }
        if let Some(found) = walk(root, &root.join(&folder), IGNORED_FOLDER_BUDGET.min(left)) {
            left -= found.len();
            files.extend(found.into_iter().take(cap - files.len()));
        }
    }
    for (_, group) in loose.into_iter().filter(|(_, group)| group.len() <= LOOSE_IGNORED_BUDGET) {
        for relative in group {
            if files.len() >= cap {
                return;
            }
            if let Some(file) = make_file(root, relative) {
                files.push(file);
            }
        }
    }
}

/// Outside a repo, nested repos list their own files through git, so ignored
/// caches and logs cannot eat the cap before the real sources are reached.
/// Worktrees and submodules (a `.git` file) are copies of other code and are skipped.
fn walk_ignoring(root: &Path, cap: usize) -> Vec<ProjectFile> {
    let repos = Arc::new(Mutex::new(Vec::new()));
    let found = Arc::clone(&repos);
    let walker = ignore::WalkBuilder::new(root)
        .hidden(false)
        .require_git(false)
        .filter_entry(move |entry| {
            let name = entry.file_name().to_str();
            if name.is_some_and(|name| SKIPPED_DIRS.contains(&name)) {
                return false;
            }
            let git = entry.path().join(".git");
            if entry.depth() == 0 || !git.exists() {
                return true;
            }
            if git.is_dir() {
                found.lock().unwrap().push(entry.path().to_path_buf());
            }
            false
        })
        .build();
    let mut files = Vec::new();
    for entry in walker.flatten() {
        if files.len() >= cap {
            break;
        }
        if !entry.path().is_file() {
            continue;
        }
        let Ok(relative) = entry.path().strip_prefix(root) else {
            continue;
        };
        if let Some(file) = make_file(root, relative.to_string_lossy().replace('\\', "/")) {
            files.push(file);
        }
    }
    let mut repos = std::mem::take(&mut *repos.lock().unwrap());
    repos.sort();
    for repo in repos {
        if files.len() >= cap {
            break;
        }
        let _ = ls_repo(root, &repo, &mut files, cap);
    }
    files
}

/// Every file under `start`, or None once there are more than `budget`.
/// Folders holding a repo of their own are left out.
/// Dot-named entries are kept, as git would list them; only the heavy folders are skipped.
fn walk(root: &Path, start: &Path, budget: usize) -> Option<Vec<ProjectFile>> {
    let mut files = Vec::new();
    let mut stack = vec![start.to_path_buf()];
    while let Some(dir) = stack.pop() {
        let Ok(entries) = std::fs::read_dir(&dir) else {
            continue;
        };
        for entry in entries.flatten() {
            let path = entry.path();
            let Some(name) = path.file_name().and_then(|n| n.to_str()) else {
                continue;
            };
            if SKIPPED_DIRS.contains(&name) || CACHE_DIRS.contains(&name) {
                continue;
            }
            // Not followed: a link out of the folder is not its size.
            let Ok(kind) = entry.file_type() else {
                continue;
            };
            if kind.is_dir() {
                // Another repo or a worktree: someone else's code, or a copy of this one.
                if !path.join(".git").exists() {
                    stack.push(path);
                }
                continue;
            }
            if files.len() >= budget {
                return None;
            }
            if let Ok(relative) = path.strip_prefix(root) {
                if let Some(file) = make_file(root, relative.to_string_lossy().replace('\\', "/")) {
                    files.push(file);
                }
            }
        }
    }
    Some(files)
}

/// A folder's entries for the explorer: folders first, then by name as a person
/// sorts them. Everything on disk is here, with what git ignores marked.
pub fn list_folder(path: &str) -> Result<Vec<FolderEntry>, String> {
    let dir = Path::new(path);
    let mut entries: Vec<FolderEntry> = std::fs::read_dir(dir)
        .map_err(|e| e.to_string())?
        .flatten()
        .filter_map(|entry| {
            let name = entry.file_name().to_str()?.to_string();
            if name == ".git" || name == ".DS_Store" {
                return None;
            }
            let path = entry.path();
            // Followed, so a linked folder opens like any other.
            let is_dir = path.is_dir();
            Some(FolderEntry { name, path: path.to_string_lossy().into_owned(), dir: is_dir, ignored: false })
        })
        .collect();
    let ignored = git_ignored(dir, entries.iter().map(|entry| entry.name.as_str()));
    for entry in &mut entries {
        entry.ignored = ignored.contains(&entry.name);
    }
    entries.sort_by(|a, b| b.dir.cmp(&a.dir).then_with(|| natural(&a.name, &b.name)));
    Ok(entries)
}

/// Which of `names`, in `dir`, git ignores. Outside a repo, none.
fn git_ignored<'a>(dir: &Path, names: impl Iterator<Item = &'a str>) -> HashSet<String> {
    use std::io::Write as _;
    use std::process::Stdio;
    let input: Vec<u8> = names.flat_map(|name| name.bytes().chain([0])).collect();
    if input.is_empty() {
        return HashSet::new();
    }
    let Ok(mut child) = Command::new("git")
        .arg("-C")
        .arg(dir)
        .args(["check-ignore", "-z", "--stdin"])
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
    else {
        return HashSet::new();
    };
    // Written from its own thread: a folder big enough fills the pipe both ways.
    let stdin = child.stdin.take();
    let writer = std::thread::spawn(move || {
        if let Some(mut stdin) = stdin {
            let _ = stdin.write_all(&input);
        }
    });
    let output = child.wait_with_output();
    let _ = writer.join();
    let Ok(output) = output else {
        return HashSet::new();
    };
    output
        .stdout
        .split(|byte| *byte == 0)
        .filter(|chunk| !chunk.is_empty())
        .map(|chunk| String::from_utf8_lossy(chunk).into_owned())
        .collect()
}

/// Case-insensitive, with runs of digits compared as numbers: `file2` before `file10`.
fn natural(a: &str, b: &str) -> std::cmp::Ordering {
    use std::cmp::Ordering;
    let (mut a, mut b) = (a.chars().peekable(), b.chars().peekable());
    loop {
        match (a.peek().copied(), b.peek().copied()) {
            (None, None) => return Ordering::Equal,
            (None, Some(_)) => return Ordering::Less,
            (Some(_), None) => return Ordering::Greater,
            (Some(x), Some(y)) if x.is_ascii_digit() && y.is_ascii_digit() => {
                let take = |it: &mut std::iter::Peekable<std::str::Chars>| {
                    let mut digits = String::new();
                    while let Some(c) = it.peek().copied().filter(char::is_ascii_digit) {
                        digits.push(c);
                        it.next();
                    }
                    digits
                };
                let (x, y) = (take(&mut a), take(&mut b));
                let (tx, ty) = (x.trim_start_matches('0'), y.trim_start_matches('0'));
                let order = tx.len().cmp(&ty.len()).then_with(|| tx.cmp(ty));
                if order != Ordering::Equal {
                    return order;
                }
            }
            (Some(x), Some(y)) => {
                let order = x.to_lowercase().cmp(y.to_lowercase());
                if order != Ordering::Equal {
                    return order;
                }
                a.next();
                b.next();
            }
        }
    }
}

fn make_file(root: &Path, relative: String) -> Option<ProjectFile> {
    let path = root.join(&relative);
    let name = path.file_name()?.to_str()?.to_string();
    if name == ".DS_Store" {
        return None;
    }
    Some(ProjectFile {
        name,
        path: path.to_string_lossy().into_owned(),
        relative,
    })
}

fn has_skipped_dir(relative: &str) -> bool {
    relative
        .split('/')
        .any(|segment| SKIPPED_DIRS.contains(&segment))
}

pub fn read_text(path: &str) -> Result<String, String> {
    let meta = std::fs::metadata(path).map_err(|e| e.to_string())?;
    if meta.len() > MAX_TEXT_FILE_BYTES {
        return Err("File is too large to open".into());
    }
    std::fs::read_to_string(path).map_err(|e| e.to_string())
}

pub fn write_text(path: &str, contents: &str) -> Result<(), String> {
    std::fs::write(path, contents).map_err(|e| e.to_string())
}

#[derive(Serialize, Clone, Debug)]
pub struct FileBytes {
    pub mime: String,
    pub data: String,
}

/// Images the chat shows and sends inline. The webview cannot read the disk
/// itself and the asset protocol is off, so bytes travel as base64 over IPC.
pub fn read_base64(path: &str) -> Result<FileBytes, String> {
    let meta = std::fs::metadata(path).map_err(|e| e.to_string())?;
    if meta.len() > MAX_TEMP_FILE_BYTES as u64 {
        return Err("File is too large to attach".into());
    }
    let bytes = std::fs::read(path).map_err(|e| e.to_string())?;
    let mime = match Path::new(path)
        .extension()
        .and_then(|e| e.to_str())
        .map(|e| e.to_ascii_lowercase())
        .as_deref()
    {
        Some("png") => "image/png",
        Some("jpg") | Some("jpeg") => "image/jpeg",
        Some("gif") => "image/gif",
        Some("webp") => "image/webp",
        Some("svg") => "image/svg+xml",
        _ => "application/octet-stream",
    };
    Ok(FileBytes {
        mime: mime.into(),
        data: base64::engine::general_purpose::STANDARD.encode(bytes),
    })
}

pub fn image_mime(name: &str) -> Option<&'static str> {
    match Path::new(name)
        .extension()
        .and_then(|e| e.to_str())
        .map(|e| e.to_ascii_lowercase())
        .as_deref()
    {
        Some("png") => Some("image/png"),
        Some("jpg") | Some("jpeg") => Some("image/jpeg"),
        Some("gif") => Some("image/gif"),
        Some("webp") => Some("image/webp"),
        _ => None,
    }
}

pub fn is_image(file: &AttachedFile) -> bool {
    matches!(file.kind, Some(AttachedFileKind::Image))
        || (file.kind.is_none() && image_mime(&file.name).is_some())
}

pub fn load_inline_images(files: &[AttachedFile]) -> Vec<InlineImage> {
    files
        .iter()
        .filter(|file| is_image(file))
        .filter_map(|file| {
            let media_type = image_mime(&file.name)?.to_string();
            let bytes = read_base64(&file.path).ok()?;
            Some(InlineImage {
                path: file.path.clone(),
                media_type,
                data: bytes.data,
            })
        })
        .collect()
}

pub fn exists(path: &str) -> bool {
    std::path::Path::new(path).exists()
}

pub fn is_file(path: &str) -> bool {
    std::path::Path::new(path).is_file()
}

/// Clipboard images arrive as bytes with no path, and the CLIs Crew hosts take
/// paths. The name is generated here so a caller can never walk out of the dir.
pub fn write_temp(extension: &str, base64_contents: &str) -> Result<String, String> {
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(base64_contents.as_bytes())
        .map_err(|e| format!("Clipboard data is not valid base64: {e}"))?;
    if bytes.len() > MAX_TEMP_FILE_BYTES {
        return Err("Pasted file is too large".into());
    }
    let dir = std::env::temp_dir().join("crew");
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let path = dir.join(format!("{}.{}", uuid::Uuid::new_v4(), safe_extension(extension)));
    std::fs::write(&path, bytes).map_err(|e| e.to_string())?;
    Ok(path.to_string_lossy().into_owned())
}

/// A pasted or dropped image saved next to a note. Parent folders are created;
/// an existing file is an error, so a name clash can never eat someone's image.
pub fn create_base64(path: &str, base64_contents: &str) -> Result<(), String> {
    use std::io::Write as _;
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(base64_contents.as_bytes())
        .map_err(|e| format!("File data is not valid base64: {e}"))?;
    if bytes.len() > MAX_TEMP_FILE_BYTES {
        return Err("File is too large".into());
    }
    if let Some(parent) = Path::new(path).parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    let mut file = std::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(path)
        .map_err(|e| e.to_string())?;
    file.write_all(&bytes).map_err(|e| e.to_string())
}

fn safe_extension(extension: &str) -> String {
    let kept: String = extension
        .chars()
        .filter(|c| c.is_ascii_alphanumeric())
        .take(8)
        .collect();
    if kept.is_empty() {
        "bin".into()
    } else {
        kept.to_ascii_lowercase()
    }
}

#[cfg(test)]
mod tests {
    use super::{image_mime, list, list_folder, load_inline_images, safe_extension, IGNORED_FOLDER_BUDGET};
    use crew_protocol::{AttachedFile, AttachedFileKind};

    #[test]
    fn extension_keeps_only_alphanumerics() {
        assert_eq!(safe_extension("png"), "png");
        assert_eq!(safe_extension("../../etc/passwd"), "etcpassw");
        assert_eq!(safe_extension(""), "bin");
    }

    #[test]
    fn image_mime_knows_inline_types() {
        assert_eq!(image_mime("shot.PNG"), Some("image/png"));
        assert_eq!(image_mime("notes.txt"), None);
    }

    #[test]
    fn load_inline_images_reads_bytes() {
        let dir = std::env::temp_dir().join(format!("crew-inline-{}", uuid::Uuid::new_v4()));
        let _ = std::fs::create_dir_all(&dir);
        let path = dir.join("pic.png");
        std::fs::write(&path, [0x89, 0x50, 0x4e, 0x47]).unwrap();
        let files = [AttachedFile {
            name: "pic.png".into(),
            path: path.to_string_lossy().into_owned(),
            kind: Some(AttachedFileKind::Image),
            size: None,
        }];
        let images = load_inline_images(&files);
        assert_eq!(images.len(), 1);
        assert_eq!(images[0].media_type, "image/png");
        assert!(!images[0].data.is_empty());
    }

    fn scratch(files: &[&str]) -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!("crew-list-{}", uuid::Uuid::new_v4()));
        for file in files {
            let path = dir.join(file);
            std::fs::create_dir_all(path.parent().unwrap()).unwrap();
            std::fs::write(path, "").unwrap();
        }
        dir
    }

    fn relatives(dir: &std::path::Path) -> Vec<String> {
        let mut found: Vec<String> = list(dir.to_str().unwrap()).unwrap().into_iter().map(|file| file.relative).collect();
        found.sort();
        found
    }

    #[test]
    fn walk_keeps_dot_entries_but_skips_heavy_folders() {
        let dir = scratch(&[".ai/plan.md", ".env.example", "src/main.rs", "node_modules/x/index.js", ".git/HEAD"]);
        assert_eq!(relatives(&dir), [".ai/plan.md", ".env.example", "src/main.rs"]);
    }

    fn git_init(dir: &std::path::Path) {
        let init = std::process::Command::new("git").arg("-C").arg(dir).arg("init").output().unwrap();
        assert!(init.status.success());
    }

    #[test]
    fn small_ignored_folders_are_listed_and_caches_are_not() {
        let dir = scratch(&[
            ".gitignore",
            ".ai/plan.md",
            ".ai/notes/a.md",
            ".ai/node_modules/x.js",
            ".env",
            "src/app.ts",
            "src/__pycache__/app.pyc",
            "node_modules/x/index.js",
        ]);
        let big = dir.join("generated");
        std::fs::create_dir_all(&big).unwrap();
        for index in 0..=IGNORED_FOLDER_BUDGET {
            std::fs::write(big.join(format!("{index}.json")), "").unwrap();
        }
        std::fs::write(dir.join(".gitignore"), ".ai/\n.env\ngenerated/\nnode_modules/\n__pycache__/\n").unwrap();
        git_init(&dir);
        assert_eq!(relatives(&dir), [".ai/notes/a.md", ".ai/plan.md", ".env", ".gitignore", "src/app.ts"]);
    }

    #[test]
    fn walk_outside_a_repo_lists_nested_repos_through_git() {
        let dir = scratch(&[
            "api/.gitignore",
            "api/app.php",
            "api/storage/logs/a.log",
            "api/wt/copy.php",
            "web/src/index.ts",
        ]);
        std::fs::write(dir.join("api/.gitignore"), "storage/\n").unwrap();
        git_init(&dir.join("api"));
        // A worktree or submodule: `.git` is a file pointing elsewhere.
        let separate = std::process::Command::new("git")
            .arg("init")
            .arg("--separate-git-dir")
            .arg(dir.with_extension("wt-git"))
            .arg(dir.join("api/wt"))
            .output()
            .unwrap();
        assert!(separate.status.success());
        assert_eq!(
            relatives(&dir),
            ["api/.gitignore", "api/app.php", "api/storage/logs/a.log", "web/src/index.ts"]
        );
    }

    #[test]
    fn nested_repos_inside_a_repo_are_listed() {
        let dir = scratch(&["README.md", "api/.gitignore", "api/app.php", "api/cache/big/a"]);
        std::fs::write(dir.join("api/.gitignore"), ".cache/\n").unwrap();
        std::fs::rename(dir.join("api/cache"), dir.join("api/.cache")).unwrap();
        git_init(&dir);
        git_init(&dir.join("api"));
        assert_eq!(relatives(&dir), ["README.md", "api/.gitignore", "api/app.php"]);
    }

    #[test]
    fn list_folder_puts_folders_first_and_marks_what_git_ignores() {
        let dir = scratch(&[".gitignore", "b.txt", "file10.md", "file2.md", "A/x", "logs/x.log", ".DS_Store"]);
        std::fs::write(dir.join(".gitignore"), "logs/\n").unwrap();
        git_init(&dir);
        let entries = list_folder(dir.to_str().unwrap()).unwrap();
        let shown: Vec<(&str, bool, bool)> =
            entries.iter().map(|entry| (entry.name.as_str(), entry.dir, entry.ignored)).collect();
        assert_eq!(
            shown,
            [
                ("A", true, false),
                ("logs", true, true),
                (".gitignore", false, false),
                ("b.txt", false, false),
                ("file2.md", false, false),
                ("file10.md", false, false),
            ]
        );
    }
}
