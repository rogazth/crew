use std::path::{Path, PathBuf};
use std::process::Command;

use serde::Serialize;

/// Above this the in-memory fuzzy match on the frontend stops feeling instant.
const MAX_PROJECT_FILES: usize = 20_000;
const MAX_TEXT_FILE_BYTES: u64 = 8 * 1024 * 1024;
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

#[tauri::command]
pub async fn list_project_files(cwd: String) -> Result<Vec<ProjectFile>, String> {
    tauri::async_runtime::spawn_blocking(move || list_sync(&cwd))
        .await
        .map_err(|e| e.to_string())?
}

fn list_sync(cwd: &str) -> Result<Vec<ProjectFile>, String> {
    let root = PathBuf::from(cwd);
    if !root.is_dir() {
        return Err(format!("{cwd}: Not a directory"));
    }
    // git knows the ignore rules already; walking is the slow fallback.
    if let Some(files) = git_ls_files(&root) {
        return Ok(files);
    }
    Ok(walk(&root))
}

fn git_ls_files(root: &Path) -> Option<Vec<ProjectFile>> {
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
        if files.len() >= MAX_PROJECT_FILES {
            break;
        }
    }
    Some(files)
}

fn walk(root: &Path) -> Vec<ProjectFile> {
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
                if files.len() >= MAX_PROJECT_FILES {
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

#[tauri::command]
pub async fn read_text_file(path: String) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let meta = std::fs::metadata(&path).map_err(|e| e.to_string())?;
        if meta.len() > MAX_TEXT_FILE_BYTES {
            return Err("File is too large to open".into());
        }
        std::fs::read_to_string(&path).map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn write_text_file(path: String, contents: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        std::fs::write(&path, contents).map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub fn path_exists(path: String) -> bool {
    std::path::Path::new(&path).exists()
}
