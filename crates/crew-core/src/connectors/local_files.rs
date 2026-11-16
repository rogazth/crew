//! Files a built-in's tools take from, or leave in, the calling session's
//! folder. A tool's call crosses as JSON, maybe to the vault on another
//! machine, so a file crosses as base64: `crewd` reads each `path` a call
//! names into its content before it goes, and writes a `content_base64` an
//! answer brings to its `save_to` before the model reads it. Only paths in
//! the session's folder (its worktree, or the workspace's) are read or
//! written, and a file there is never replaced.

use std::path::{Component, Path, PathBuf};

use base64::Engine as _;
use serde_json::{json, Value};

use crate::session::Session;
use crate::store::Store;

/// The most one file read for a call takes: Gmail's limit for a message.
const MAX_READ: u64 = 25 << 20;

/// The folder a session works in.
pub fn session_folder(store: &Store, session: &Session) -> Result<PathBuf, String> {
    match &session.worktree {
        Some(tree) => Ok(PathBuf::from(tree)),
        None => crate::workspace::get(store, session.workspace_id.clone())?
            .map(|w| PathBuf::from(w.path))
            .ok_or_else(|| "The session's workspace is gone".into()),
    }
}

/// Reads each `path` of a call, at its top or in its `attachments`, into the
/// base64 its tool takes: `content_base64` at the top, `content` in an
/// attachment, with the file's own name when none was given.
pub fn read_paths(args: &mut Value, root: &Path) -> Result<(), String> {
    if let Some(path) = args.get("path").and_then(Value::as_str).map(str::to_string) {
        let (name, data) = read(root, &path)?;
        let map = args.as_object_mut().ok_or("The arguments are not an object")?;
        map.remove("path");
        map.insert("content_base64".into(), json!(data));
        if !map.contains_key("mime_type") {
            map.insert("mime_type".into(), json!(guess_mime(&name)));
        }
        if map.get("name").and_then(Value::as_str).is_none_or(|n| n.trim().is_empty()) && !map.contains_key("file_id") {
            map.insert("name".into(), json!(name));
        }
    }
    for item in args.get_mut("attachments").and_then(Value::as_array_mut).into_iter().flatten() {
        let Some(path) = item.get("path").and_then(Value::as_str).map(str::to_string) else { continue };
        let (name, data) = read(root, &path)?;
        let Some(map) = item.as_object_mut() else { continue };
        map.remove("path");
        map.insert("content".into(), json!(data));
        if !map.contains_key("mime_type") && !map.contains_key("mimeType") {
            map.insert("mime_type".into(), json!(guess_mime(&name)));
        }
        if map.get("filename").and_then(Value::as_str).is_none_or(|n| n.trim().is_empty()) {
            map.insert("filename".into(), json!(name));
        }
    }
    Ok(())
}

/// A type from a file's name, for a file that came without one.
pub fn guess_mime(name: &str) -> &'static str {
    let ext = name.rsplit_once('.').map(|(_, e)| e.to_ascii_lowercase()).unwrap_or_default();
    match ext.as_str() {
        "txt" | "log" => "text/plain",
        "md" | "markdown" => "text/markdown",
        "csv" => "text/csv",
        "tsv" => "text/tab-separated-values",
        "html" | "htm" => "text/html",
        "json" => "application/json",
        "xml" => "application/xml",
        "pdf" => "application/pdf",
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "svg" => "image/svg+xml",
        "zip" => "application/zip",
        "doc" => "application/msword",
        "xls" => "application/vnd.ms-excel",
        "ppt" => "application/vnd.ms-powerpoint",
        "docx" => "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        "xlsx" => "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        "pptx" => "application/vnd.openxmlformats-officedocument.presentationml.presentation",
        "odt" => "application/vnd.oasis.opendocument.text",
        "ods" => "application/vnd.oasis.opendocument.spreadsheet",
        "rtf" => "application/rtf",
        "mp3" => "audio/mpeg",
        "mp4" => "video/mp4",
        "ics" => "text/calendar",
        _ => "application/octet-stream",
    }
}

fn read(root: &Path, path: &str) -> Result<(String, String), String> {
    let file = inside(root, path)?;
    let real = file.canonicalize().map_err(|_| format!("{path}: no such file in your working folder"))?;
    if !real.starts_with(real_root(root)?) {
        return Err(format!("{path}: only files in your working folder ({}) are read", root.display()));
    }
    let meta = std::fs::metadata(&real).map_err(|e| format!("{path}: {e}"))?;
    if !meta.is_file() {
        return Err(format!("{path} is not a file"));
    }
    if meta.len() > MAX_READ {
        return Err(format!("{path} is over {} MB", MAX_READ >> 20));
    }
    let bytes = std::fs::read(&real).map_err(|e| format!("{path}: {e}"))?;
    let name = real.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_else(|| "file".into());
    Ok((name, base64::engine::general_purpose::STANDARD.encode(bytes)))
}

/// An answer that brings a file (`save_to` and `content_base64`) leaves it
/// in the folder and says where, without the bytes.
pub fn write_saved(answer: &mut Value, root: &Path) {
    if answer["isError"] == true {
        return;
    }
    let Some(text) = answer["content"][0]["text"].as_str() else { return };
    let Ok(Value::Object(mut file)) = serde_json::from_str::<Value>(text) else { return };
    let (Some(save_to), Some(data)) =
        (file.get("save_to").and_then(Value::as_str).map(str::to_string), file.get("content_base64").and_then(Value::as_str))
    else {
        return;
    };
    let written = base64::engine::general_purpose::STANDARD
        .decode(data)
        .map_err(|_| "The file came back damaged".to_string())
        .and_then(|bytes| write(root, &save_to, &bytes));
    *answer = match written {
        Ok(at) => {
            file.remove("content_base64");
            file.remove("save_to");
            file.insert("saved_to".into(), json!(at.to_string_lossy()));
            json!({ "content": [{ "type": "text", "text": Value::Object(file).to_string() }] })
        }
        Err(line) => json!({ "content": [{ "type": "text", "text": line }], "isError": true }),
    };
}

fn write(root: &Path, path: &str, bytes: &[u8]) -> Result<PathBuf, String> {
    let file = inside(root, path)?;
    if file.symlink_metadata().is_ok() {
        return Err(format!("{path} already exists; choose another save_to"));
    }
    let parent = file.parent().ok_or_else(|| format!("{path} has no folder"))?;
    std::fs::create_dir_all(parent).map_err(|e| format!("{path}: {e}"))?;
    let real_parent = parent.canonicalize().map_err(|e| format!("{path}: {e}"))?;
    if !real_parent.starts_with(real_root(root)?) {
        return Err(format!("{path}: files are saved only in your working folder ({})", root.display()));
    }
    let at = real_parent.join(file.file_name().ok_or_else(|| format!("{path} names no file"))?);
    let mut out = std::fs::OpenOptions::new().write(true).create_new(true).open(&at).map_err(|e| format!("{path}: {e}"))?;
    std::io::Write::write_all(&mut out, bytes).map_err(|e| format!("{path}: {e}"))?;
    Ok(at)
}

fn real_root(root: &Path) -> Result<PathBuf, String> {
    root.canonicalize().map_err(|e| format!("The working folder {}: {e}", root.display()))
}

/// `path` under `root`, relative or absolute, refused when its `..` would
/// climb out. Links are checked after, on the real path.
fn inside(root: &Path, path: &str) -> Result<PathBuf, String> {
    let path = path.trim();
    if path.is_empty() {
        return Err("The path is empty".into());
    }
    let given = Path::new(path);
    let joined = if given.is_absolute() { given.to_path_buf() } else { root.join(given) };
    let mut out = PathBuf::new();
    for part in joined.components() {
        match part {
            Component::ParentDir => {
                if !out.pop() {
                    return Err(format!("{path} is outside your working folder"));
                }
            }
            Component::CurDir => {}
            other => out.push(other),
        }
    }
    let root_lexical: PathBuf = root.components().filter(|c| !matches!(c, Component::CurDir)).collect();
    let real = real_root(root)?;
    if !(out.starts_with(&root_lexical) || out.starts_with(&real)) {
        return Err(format!("{path}: only your working folder ({}) is used", root.display()));
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn folder() -> PathBuf {
        let dir = std::env::temp_dir().join(format!("crew-files-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(dir.join("in")).unwrap();
        dir
    }

    #[test]
    fn paths_in_the_folder_are_read_and_others_refused() {
        let root = folder();
        std::fs::write(root.join("in/factura.pdf"), b"%PDF").unwrap();
        let mut args =
            json!({ "to": "a@x.dev", "attachments": [{ "path": "in/factura.pdf" }, { "filename": "b.txt", "content": "aGk=" }] });
        read_paths(&mut args, &root).unwrap();
        assert_eq!(
            args["attachments"][0],
            json!({ "filename": "factura.pdf", "content": "JVBERg==", "mime_type": "application/pdf" })
        );
        assert_eq!(args["attachments"][1]["content"], "aGk=");

        let mut upload = json!({ "path": root.join("in/factura.pdf").to_string_lossy() });
        read_paths(&mut upload, &root).unwrap();
        assert_eq!(upload, json!({ "content_base64": "JVBERg==", "name": "factura.pdf", "mime_type": "application/pdf" }));

        let outside = std::env::temp_dir().join(format!("crew-out-{}", uuid::Uuid::new_v4()));
        std::fs::write(&outside, b"secret").unwrap();
        std::os::unix::fs::symlink(&outside, root.join("in/link")).unwrap();
        for bad in ["../x", "/etc/hosts", "in/link", "in/missing.pdf", "in"] {
            let mut args = json!({ "attachments": [{ "path": bad }] });
            assert!(read_paths(&mut args, &root).is_err(), "{bad}");
        }
        let _ = std::fs::remove_file(outside);
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn a_file_an_answer_brings_is_saved_once_and_the_bytes_leave_the_answer() {
        let root = folder();
        let file = json!({ "name": "a.pdf", "size": 4, "save_to": "out/a.pdf", "content_base64": "JVBERg==" });
        let mut answer = json!({ "content": [{ "type": "text", "text": file.to_string() }] });
        write_saved(&mut answer, &root);
        let text: Value = serde_json::from_str(answer["content"][0]["text"].as_str().unwrap()).unwrap();
        assert!(text.get("content_base64").is_none());
        assert!(text["saved_to"].as_str().unwrap().ends_with("out/a.pdf"));
        assert_eq!(std::fs::read(root.join("out/a.pdf")).unwrap(), b"%PDF");

        let mut again = json!({ "content": [{ "type": "text", "text": file.to_string() }] });
        write_saved(&mut again, &root);
        assert_eq!(again["isError"], true, "an existing file is not replaced");
        let escape = json!({ "save_to": "../../x", "content_base64": "aGk=" });
        let mut out = json!({ "content": [{ "type": "text", "text": escape.to_string() }] });
        write_saved(&mut out, &root);
        assert_eq!(out["isError"], true);
        let mut plain = json!({ "content": [{ "type": "text", "text": "not json" }] });
        write_saved(&mut plain, &root);
        assert_eq!(plain["content"][0]["text"], "not json");
        let _ = std::fs::remove_dir_all(root);
    }
}
