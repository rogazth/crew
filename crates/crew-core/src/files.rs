use std::path::{Path, PathBuf};
use std::process::Command;

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

pub fn list(cwd: &str) -> Result<Vec<ProjectFile>, String> {
    let root = PathBuf::from(cwd);
    if !root.is_dir() {
        return Err(format!("{cwd}: Not a directory"));
    }
    // git knows the ignore rules already; walking is the slow fallback.
    if let Some(files) = git_ls_files(&root, MAX_PROJECT_FILES) {
        return Ok(files);
    }
    Ok(walk(&root, MAX_PROJECT_FILES))
}

fn git_ls_files(root: &Path, limit: usize) -> Option<Vec<ProjectFile>> {
    let output = Command::new("git")
        .arg("-C")
        .arg(root)
        .args(["ls-files", "-co", "--exclude-standard", "-z"])
        .output()
        .ok()?;
    if !output.status.success() {
        return None;
    }

    let mut files = Vec::new();
    for chunk in output.stdout.split(|byte| *byte == 0) {
        if chunk.is_empty() {
            continue;
        }
        let relative = String::from_utf8_lossy(chunk).replace('\\', "/");
        if relative.ends_with('/') || has_skipped_dir(&relative) {
            continue;
        }
        if let Some(file) = make_file(root, relative) {
            files.push(file);
        }
        if files.len() >= limit {
            break;
        }
    }
    Some(files)
}

fn walk(root: &Path, limit: usize) -> Vec<ProjectFile> {
    let mut files = Vec::new();
    let mut stack = vec![root.to_path_buf()];
    while let Some(dir) = stack.pop() {
        let Ok(entries) = std::fs::read_dir(&dir) else {
            continue;
        };
        for entry in entries.flatten() {
            let path = entry.path();
            let Some(name) = path.file_name().and_then(|n| n.to_str()) else {
                continue;
            };
            if name.starts_with('.') || SKIPPED_DIRS.contains(&name) {
                continue;
            }
            if path.is_dir() {
                stack.push(path);
            } else if let Ok(relative) = path.strip_prefix(root) {
                let relative = relative.to_string_lossy().replace('\\', "/");
                if let Some(file) = make_file(root, relative) {
                    files.push(file);
                }
                if files.len() >= limit {
                    return files;
                }
            }
        }
    }
    files
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
    use super::*;
    use crate::test_support::temp_dir;
    use crew_protocol::{AttachedFile, AttachedFileKind};
    use std::os::unix::ffi::OsStrExt;
    use std::os::unix::fs::PermissionsExt;

    fn put(root: &Path, relative: &str, contents: &str) {
        let path = root.join(relative);
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(path, contents).unwrap();
    }

    /// Runs git on `root` alone, without the machine's global or system config.
    fn git(root: &Path, args: &[&str]) {
        let status = Command::new("git")
            .arg("-C")
            .arg(root)
            .args(["-c", "user.name=Crew", "-c", "user.email=crew@example.com"])
            .args(args)
            .env("GIT_CONFIG_GLOBAL", "/dev/null")
            .env("GIT_CONFIG_NOSYSTEM", "1")
            .env_remove("GIT_DIR")
            .env_remove("GIT_WORK_TREE")
            .env_remove("GIT_INDEX_FILE")
            .status()
            .expect("run git");
        assert!(status.success(), "git {args:?} failed");
    }

    fn relatives(files: &[ProjectFile]) -> Vec<&str> {
        let mut names: Vec<&str> = files.iter().map(|f| f.relative.as_str()).collect();
        names.sort();
        names
    }

    fn attached(name: &str, kind: Option<AttachedFileKind>) -> AttachedFile {
        AttachedFile {
            name: name.into(),
            path: format!("/nowhere/{name}"),
            kind,
            size: None,
        }
    }

    fn str_path(path: &Path) -> &str {
        path.to_str().unwrap()
    }

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

    #[test]
    fn a_git_project_lists_what_git_tracks_and_would_track() {
        let dir = temp_dir();
        let root = dir.path();
        git(root, &["init", "-q"]);
        put(root, "README.md", "# hi");
        put(root, "src/main.rs", "fn main() {}");
        put(root, ".gitignore", "secret.env\n");
        git(root, &["add", "."]);
        git(root, &["commit", "-qm", "init"]);
        put(root, "notes.txt", "untracked but not ignored");
        put(root, "secret.env", "ignored");
        put(root, "node_modules/pkg/index.js", "skipped dir");
        put(root, "build/out.js", "skipped dir");
        put(root, ".DS_Store", "finder litter");
        put(root, "nested/lib.rs", "");
        git(&root.join("nested"), &["init", "-q"]);

        let files = list(str_path(root)).unwrap();

        assert_eq!(
            relatives(&files),
            [".gitignore", "README.md", "notes.txt", "src/main.rs"]
        );
        let main = files.iter().find(|f| f.relative == "src/main.rs").unwrap();
        assert_eq!(main.name, "main.rs");
        assert_eq!(main.path, root.join("src/main.rs").to_string_lossy());
    }

    #[test]
    fn a_git_listing_stops_at_the_limit() {
        let dir = temp_dir();
        git(dir.path(), &["init", "-q"]);
        for name in ["a", "b", "c", "d"] {
            put(dir.path(), name, "");
        }
        assert_eq!(git_ls_files(dir.path(), 2).unwrap().len(), 2);
    }

    #[test]
    fn a_folder_outside_git_is_walked_skipping_hidden_and_build_dirs() {
        let dir = temp_dir();
        let root = dir.path();
        put(root, "a.txt", "");
        put(root, "src/b.rs", "");
        put(root, "src/deep/c.md", "");
        put(root, ".env", "");
        put(root, ".config/x", "");
        put(root, "node_modules/x.js", "");
        put(root, "target/debug/y", "");
        put(root, "src/dist/z.js", "");
        put(root, "locked/hidden.txt", "");
        // Not every filesystem takes a name that is not UTF-8.
        let _ = std::fs::write(root.join(std::ffi::OsStr::from_bytes(b"bad\xff.txt")), "");
        let locked = root.join("locked");
        std::fs::set_permissions(&locked, std::fs::Permissions::from_mode(0o000)).unwrap();

        let files = list(str_path(root));
        std::fs::set_permissions(&locked, std::fs::Permissions::from_mode(0o755)).unwrap();

        assert_eq!(relatives(&files.unwrap()), ["a.txt", "src/b.rs", "src/deep/c.md"]);
    }

    #[test]
    fn a_walk_stops_at_the_limit() {
        let dir = temp_dir();
        for name in ["a", "b", "c", "d", "e"] {
            put(dir.path(), name, "");
        }
        assert_eq!(walk(dir.path(), 3).len(), 3);
    }

    #[test]
    fn only_a_directory_can_be_listed() {
        let dir = temp_dir();
        put(dir.path(), "file.txt", "");
        let file = dir.path().join("file.txt");
        assert_eq!(
            list(str_path(&file)).unwrap_err(),
            format!("{}: Not a directory", file.display())
        );
        assert!(list(str_path(&dir.path().join("missing"))).is_err());
    }

    #[test]
    fn text_round_trips_through_write_and_read() {
        let dir = temp_dir();
        let path = dir.path().join("notes.md");
        write_text(str_path(&path), "first").unwrap();
        write_text(str_path(&path), "second\nline").unwrap();
        assert_eq!(read_text(str_path(&path)).unwrap(), "second\nline");
        assert!(write_text(str_path(&dir.path().join("no/such/dir.md")), "x").is_err());
        assert!(read_text(str_path(&dir.path().join("missing.md"))).is_err());
    }

    #[test]
    fn a_text_file_past_the_size_limit_is_not_opened() {
        let dir = temp_dir();
        let path = dir.path().join("big.log");
        let file = std::fs::File::create(&path).unwrap();
        file.set_len(MAX_TEXT_FILE_BYTES).unwrap();
        assert_eq!(read_text(str_path(&path)).unwrap().len() as u64, MAX_TEXT_FILE_BYTES);
        file.set_len(MAX_TEXT_FILE_BYTES + 1).unwrap();
        assert_eq!(read_text(str_path(&path)).unwrap_err(), "File is too large to open");
    }

    #[test]
    fn a_binary_file_is_not_opened_as_text() {
        let dir = temp_dir();
        let path = dir.path().join("blob.bin");
        std::fs::write(&path, [0xff, 0xfe, 0x00, 0x01]).unwrap();
        assert!(read_text(str_path(&path)).is_err());
    }

    #[test]
    fn base64_reads_carry_the_mime_of_the_extension() {
        let dir = temp_dir();
        let cases = [
            ("a.png", "image/png"),
            ("b.JPG", "image/jpeg"),
            ("c.jpeg", "image/jpeg"),
            ("d.gif", "image/gif"),
            ("e.webp", "image/webp"),
            ("f.svg", "image/svg+xml"),
            ("g.pdf", "application/octet-stream"),
            ("noext", "application/octet-stream"),
        ];
        for (name, mime) in cases {
            let path = dir.path().join(name);
            std::fs::write(&path, [1, 2, 3, 250]).unwrap();
            let read = read_base64(str_path(&path)).unwrap();
            assert_eq!(read.mime, mime, "{name}");
            let bytes = base64::engine::general_purpose::STANDARD.decode(read.data).unwrap();
            assert_eq!(bytes, [1, 2, 3, 250], "{name}");
        }
    }

    #[test]
    fn an_attachment_past_the_size_limit_is_not_read() {
        let dir = temp_dir();
        let path = dir.path().join("huge.png");
        std::fs::File::create(&path)
            .unwrap()
            .set_len(MAX_TEMP_FILE_BYTES as u64 + 1)
            .unwrap();
        assert_eq!(read_base64(str_path(&path)).unwrap_err(), "File is too large to attach");
        assert!(read_base64(str_path(&dir.path().join("missing.png"))).is_err());
    }

    #[test]
    fn inline_image_types_are_known_by_extension() {
        assert_eq!(image_mime("a.jpg"), Some("image/jpeg"));
        assert_eq!(image_mime("a.JPEG"), Some("image/jpeg"));
        assert_eq!(image_mime("a.gif"), Some("image/gif"));
        assert_eq!(image_mime("a.webp"), Some("image/webp"));
        assert_eq!(image_mime("a.svg"), None);
        assert_eq!(image_mime("Makefile"), None);
    }

    #[test]
    fn a_declared_kind_outranks_the_file_name() {
        assert!(is_image(&attached("shot.png", None)));
        assert!(!is_image(&attached("notes.txt", None)));
        assert!(is_image(&attached("clipboard", Some(AttachedFileKind::Image))));
        assert!(!is_image(&attached("shot.png", Some(AttachedFileKind::File))));
    }

    #[test]
    fn exists_sees_files_and_folders_only_when_there() {
        let dir = temp_dir();
        put(dir.path(), "here.txt", "");
        assert!(exists(str_path(&dir.path().join("here.txt"))));
        assert!(exists(str_path(dir.path())));
        assert!(!exists(str_path(&dir.path().join("gone.txt"))));
    }

    #[test]
    fn a_pasted_file_is_written_under_a_generated_name() {
        let data = base64::engine::general_purpose::STANDARD.encode(b"pixels");
        let path = PathBuf::from(write_temp("../PNG!", &data).unwrap());
        let written = std::fs::read(&path);
        let _ = std::fs::remove_file(&path);
        assert_eq!(written.unwrap(), b"pixels");
        assert_eq!(path.parent(), Some(std::env::temp_dir().join("crew").as_path()));
        assert_eq!(path.extension().and_then(|e| e.to_str()), Some("png"));

        let path = write_temp("", &data).unwrap();
        let _ = std::fs::remove_file(&path);
        assert!(path.ends_with(".bin"), "{path}");
    }

    #[test]
    fn a_paste_that_is_not_base64_is_refused() {
        let err = write_temp("png", "not base64!").unwrap_err();
        assert!(err.starts_with("Clipboard data is not valid base64"), "{err}");
    }

    #[test]
    fn a_paste_past_the_size_limit_is_refused() {
        let data = base64::engine::general_purpose::STANDARD.encode(vec![0_u8; MAX_TEMP_FILE_BYTES + 1]);
        assert_eq!(write_temp("png", &data).unwrap_err(), "Pasted file is too large");
    }
}
