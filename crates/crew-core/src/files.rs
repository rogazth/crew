use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::{Arc, Mutex};

use base64::Engine as _;
use crew_protocol::{AttachedFile, AttachedFileKind};
use serde::Serialize;

use crate::providers::InlineImage;

/// Above this the in-memory fuzzy match on the frontend stops feeling instant.
const MAX_PROJECT_FILES: usize = 20_000;
const MAX_TEXT_FILE_BYTES: u64 = 8 * 1024 * 1024;
const MAX_TEMP_FILE_BYTES: usize = 32 * 1024 * 1024;
const SKIPPED_DIRS: &[&str] = &[
    "node_modules", ".git", "target", "dist", "build", ".next", ".venv", "vendor",
];

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct ProjectFile {
    pub name: String,
    pub path: String,
    pub relative: String,
}

/// `include` names folders indexed even when git ignores them or their name starts with a dot.
pub fn list(cwd: &str, include: &[String]) -> Result<Vec<ProjectFile>, String> {
    let root = PathBuf::from(cwd);
    if !root.is_dir() {
        return Err(format!("{cwd}: Not a directory"));
    }
    // git knows the ignore rules already; walking is the slow fallback.
    let mut files = git_ls_files(&root).unwrap_or_else(|| walk_ignoring(&root));
    let mut seen: HashSet<String> = files.iter().map(|file| file.relative.clone()).collect();
    for folder in include.iter().filter_map(|folder| included_folder(folder)) {
        let start = root.join(&folder);
        if !start.is_dir() {
            continue;
        }
        let before = files.len();
        walk(&root, &start, &mut files, &seen);
        seen.extend(files[before..].iter().map(|file| file.relative.clone()));
    }
    Ok(files)
}

/// A folder relative to the workspace; anything that could escape it, or name `.git`, is dropped.
fn included_folder(folder: &str) -> Option<String> {
    let trimmed = folder.trim().trim_matches('/');
    let segments: Vec<&str> = trimmed.split('/').filter(|segment| !segment.is_empty()).collect();
    if segments.is_empty()
        || folder.trim().starts_with('/')
        || segments.iter().any(|segment| *segment == "." || *segment == ".." || *segment == ".git")
    {
        return None;
    }
    Some(segments.join("/"))
}

fn git_ls_files(root: &Path) -> Option<Vec<ProjectFile>> {
    let mut files = Vec::new();
    ls_repo(root, root, &mut files)?;
    Some(files)
}

/// git lists a nested repo as a single `dir/` entry, so each one is asked for its own files.
fn ls_repo(root: &Path, repo: &Path, files: &mut Vec<ProjectFile>) -> Option<()> {
    let output = Command::new("git")
        .arg("-C")
        .arg(repo)
        .args(["ls-files", "-co", "--exclude-standard", "-z"])
        .output()
        .ok()?;
    if !output.status.success() {
        return None;
    }
    let prefix = repo
        .strip_prefix(root)
        .ok()?
        .to_string_lossy()
        .replace('\\', "/");

    for chunk in output.stdout.split(|byte| *byte == 0) {
        if files.len() >= MAX_PROJECT_FILES {
            break;
        }
        if chunk.is_empty() {
            continue;
        }
        let entry = String::from_utf8_lossy(chunk).replace('\\', "/");
        let relative = if prefix.is_empty() { entry } else { format!("{prefix}/{entry}") };
        if has_skipped_dir(&relative) {
            continue;
        }
        if let Some(dir) = relative.strip_suffix('/') {
            let nested = root.join(dir);
            if nested.join(".git").is_dir() {
                let _ = ls_repo(root, &nested, files);
            }
            continue;
        }
        if let Some(file) = make_file(root, relative) {
            files.push(file);
        }
    }
    Some(())
}

/// Outside a repo, nested repos list their own files through git, so ignored
/// caches and logs cannot eat the cap before the real sources are reached.
/// Worktrees and submodules (a `.git` file) are copies of other code and are skipped.
fn walk_ignoring(root: &Path) -> Vec<ProjectFile> {
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
        if files.len() >= MAX_PROJECT_FILES {
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
        if files.len() >= MAX_PROJECT_FILES {
            break;
        }
        let _ = ls_repo(root, &repo, &mut files);
    }
    files
}

/// Dot-named entries are kept, as git would list them; only the heavy folders are skipped.
fn walk(root: &Path, start: &Path, files: &mut Vec<ProjectFile>, seen: &HashSet<String>) {
    let mut stack = vec![start.to_path_buf()];
    while let Some(dir) = stack.pop() {
        let Ok(entries) = std::fs::read_dir(&dir) else {
            continue;
        };
        for entry in entries.flatten() {
            if files.len() >= MAX_PROJECT_FILES {
                return;
            }
            let path = entry.path();
            let Some(name) = path.file_name().and_then(|n| n.to_str()) else {
                continue;
            };
            if SKIPPED_DIRS.contains(&name) {
                continue;
            }
            if path.is_dir() {
                stack.push(path);
            } else if let Ok(relative) = path.strip_prefix(root) {
                let relative = relative.to_string_lossy().replace('\\', "/");
                if seen.contains(&relative) {
                    continue;
                }
                if let Some(file) = make_file(root, relative) {
                    files.push(file);
                }
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
    use super::{image_mime, included_folder, list, load_inline_images, safe_extension};
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

    fn relatives(dir: &std::path::Path, include: &[&str]) -> Vec<String> {
        let include: Vec<String> = include.iter().map(|folder| folder.to_string()).collect();
        let mut found: Vec<String> = list(dir.to_str().unwrap(), &include)
            .unwrap()
            .into_iter()
            .map(|file| file.relative)
            .collect();
        found.sort();
        found
    }

    #[test]
    fn walk_keeps_dot_entries_but_skips_heavy_folders() {
        let dir = scratch(&[".ai/plan.md", ".env.example", "src/main.rs", "node_modules/x/index.js", ".git/HEAD"]);
        assert_eq!(relatives(&dir, &[]), [".ai/plan.md", ".env.example", "src/main.rs"]);
    }

    #[test]
    fn include_brings_back_folders_git_ignores_once() {
        let dir = scratch(&[".gitignore", ".ai/plan.md", ".ai/notes/a.md", ".ai/node_modules/x.js", "logs/run.log"]);
        std::fs::write(dir.join(".gitignore"), ".ai/\nlogs/\n").unwrap();
        let init = std::process::Command::new("git").arg("-C").arg(&dir).arg("init").output().unwrap();
        assert!(init.status.success());
        assert_eq!(relatives(&dir, &[]), [".gitignore"]);
        assert_eq!(
            relatives(&dir, &[".ai", "/.ai/", "missing", "../"]),
            [".ai/notes/a.md", ".ai/plan.md", ".gitignore"]
        );
    }

    fn git_init(dir: &std::path::Path) {
        let init = std::process::Command::new("git").arg("-C").arg(dir).arg("init").output().unwrap();
        assert!(init.status.success());
    }

    #[test]
    fn walk_outside_a_repo_respects_nested_gitignores() {
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
        assert_eq!(relatives(&dir, &[]), ["api/.gitignore", "api/app.php", "web/src/index.ts"]);
    }

    #[test]
    fn nested_repos_inside_a_repo_are_listed() {
        let dir = scratch(&["README.md", "api/.gitignore", "api/app.php", "api/storage/a.log"]);
        std::fs::write(dir.join("api/.gitignore"), "storage/\n").unwrap();
        git_init(&dir);
        git_init(&dir.join("api"));
        assert_eq!(relatives(&dir, &[]), ["README.md", "api/.gitignore", "api/app.php"]);
    }

    #[test]
    fn included_folder_stays_inside_the_workspace() {
        assert_eq!(included_folder(" .ai/ ").as_deref(), Some(".ai"));
        assert_eq!(included_folder("docs//private").as_deref(), Some("docs/private"));
        assert_eq!(included_folder("/etc"), None);
        assert_eq!(included_folder("../secrets"), None);
        assert_eq!(included_folder("a/../../b"), None);
        assert_eq!(included_folder(".git"), None);
        assert_eq!(included_folder("  "), None);
    }
}
