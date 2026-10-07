//! The images a tool brought back, as files a block can name. Providers hand
//! screenshots back inline, as base64 in the call's result; transcripts are
//! persisted and sent over the socket on every reconnect, so the bytes go to
//! disk once and the block keeps the path.

use std::path::{Path, PathBuf};
use std::sync::OnceLock;

use base64::Engine as _;
use crew_protocol::{AttachedFile, AttachedFileKind};
use serde_json::{Map, Value};
use sha2::{Digest, Sha256};

/// Bigger than any screenshot; a result this size is not one worth a tile.
const MAX_IMAGE_BYTES: usize = 32 * 1024 * 1024;

static DIR: OnceLock<PathBuf> = OnceLock::new();

/// Where saved images go: next to the database, so they last as long as the
/// transcripts that name them. Set once, at startup.
pub fn set_dir(dir: PathBuf) {
    let _ = DIR.set(dir);
}

fn dir() -> PathBuf {
    DIR.get().cloned().unwrap_or_else(|| std::env::temp_dir().join("crew").join("media"))
}

/// The images in a result's content blocks, saved. Reads the shapes the
/// providers write: Claude's `{type: image, source: {data, media_type}}`,
/// MCP's `{type: image, data, mimeType}`, and Codex's rollout
/// `{type: input_image, image_url: "data:…"}`.
pub fn images(content: Option<&Value>) -> Vec<AttachedFile> {
    let Some(Value::Array(parts)) = content else {
        return Vec::new();
    };
    parts.iter().filter_map(Value::as_object).filter_map(image).collect()
}

fn image(part: &Map<String, Value>) -> Option<AttachedFile> {
    let text = |row: &Map<String, Value>, key: &str| row.get(key).and_then(Value::as_str).map(str::to_string);
    match part.get("type").and_then(Value::as_str)? {
        "image" => {
            if let Some(source) = part.get("source").and_then(Value::as_object) {
                return save(&text(source, "media_type")?, &text(source, "data")?);
            }
            save(&text(part, "mimeType")?, &text(part, "data")?)
        }
        "input_image" => {
            let url = text(part, "image_url")?;
            let (head, data) = url.strip_prefix("data:")?.split_once(',')?;
            let mime = head.strip_suffix(";base64")?;
            save(mime, data)
        }
        _ => None,
    }
}

/// One image, named by its content: reading the same history again writes
/// nothing, and the row names the same file it did before.
pub fn save(mime: &str, base64: &str) -> Option<AttachedFile> {
    let extension = extension(mime)?;
    let bytes = base64::engine::general_purpose::STANDARD.decode(base64.trim()).ok()?;
    if bytes.is_empty() || bytes.len() > MAX_IMAGE_BYTES {
        return None;
    }
    let hash: String = Sha256::digest(&bytes).iter().take(16).map(|byte| format!("{byte:02x}")).collect();
    let name = format!("image-{}.{extension}", &hash[..8]);
    let dir = dir();
    let path = dir.join(format!("{hash}.{extension}"));
    if !path.exists() {
        std::fs::create_dir_all(&dir).ok()?;
        // Written aside and moved in, so a reader never opens half an image.
        let partial = dir.join(format!("{hash}.{}.part", uuid::Uuid::new_v4()));
        std::fs::write(&partial, &bytes).ok()?;
        if std::fs::rename(&partial, &path).is_err() {
            let _ = std::fs::remove_file(&partial);
            if !path.exists() {
                return None;
            }
        }
    }
    Some(AttachedFile {
        name,
        path: path.to_string_lossy().into_owned(),
        kind: Some(AttachedFileKind::Image),
        size: Some(bytes.len() as u64),
    })
}

fn extension(mime: &str) -> Option<&'static str> {
    match mime.trim().to_ascii_lowercase().as_str() {
        "image/png" => Some("png"),
        "image/jpeg" | "image/jpg" => Some("jpg"),
        "image/gif" => Some("gif"),
        "image/webp" => Some("webp"),
        _ => None,
    }
}

/// A file already on disk, as a provider named it: a plain path or a
/// `file://` URL.
pub fn local(path: &str) -> Option<AttachedFile> {
    let path = file_path(path)?;
    let name = Path::new(&path).file_name()?.to_string_lossy().into_owned();
    let size = std::fs::metadata(&path).ok().map(|meta| meta.len());
    let kind = if crate::files::image_mime(&name).is_some() {
        AttachedFileKind::Image
    } else {
        AttachedFileKind::File
    };
    Some(AttachedFile { name, path, kind: Some(kind), size })
}

fn file_path(raw: &str) -> Option<String> {
    let raw = raw.trim();
    let Some(url) = raw.strip_prefix("file://") else {
        return (!raw.is_empty()).then(|| raw.to_string());
    };
    let path = url.strip_prefix("localhost").unwrap_or(url);
    let bytes = path.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut at = 0;
    while at < bytes.len() {
        let hex = (bytes[at] == b'%')
            .then(|| bytes.get(at + 1..at + 3))
            .flatten()
            .and_then(|pair| u8::from_str_radix(std::str::from_utf8(pair).ok()?, 16).ok());
        match hex {
            Some(byte) => {
                out.push(byte);
                at += 3;
            }
            None => {
                out.push(bytes[at]);
                at += 1;
            }
        }
    }
    String::from_utf8(out).ok().filter(|path| path.starts_with('/'))
}

/// A 1×1 PNG, for the tests of whatever reads one.
#[cfg(test)]
pub(crate) const TEST_PNG: &str =
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    const PNG: &str = TEST_PNG;

    #[test]
    fn reads_every_providers_image_block_and_names_it_by_content() {
        let content = json!([
            { "type": "text", "text": "Took a screenshot" },
            { "type": "image", "source": { "type": "base64", "media_type": "image/png", "data": PNG } },
            { "type": "image", "mimeType": "image/png", "data": PNG },
            { "type": "input_image", "image_url": format!("data:image/png;base64,{PNG}") },
        ]);
        let files = images(Some(&content));
        assert_eq!(files.len(), 3);
        // The same bytes are the same file, however they came.
        assert!(files.iter().all(|file| file.path == files[0].path));
        assert_eq!(files[0].kind, Some(AttachedFileKind::Image));
        assert!(files[0].name.starts_with("image-") && files[0].name.ends_with(".png"));
        assert_eq!(std::fs::read(&files[0].path).unwrap().len() as u64, files[0].size.unwrap());
    }

    #[test]
    fn what_is_not_an_image_is_left_alone() {
        let content = json!([
            { "type": "text", "text": "hi" },
            { "type": "image", "mimeType": "application/pdf", "data": PNG },
            { "type": "image", "mimeType": "image/png", "data": "not base64!" },
        ]);
        assert!(images(Some(&content)).is_empty());
        assert!(images(Some(&json!("plain text"))).is_empty());
    }

    #[test]
    fn a_file_url_reads_as_its_path() {
        let file = local("file:///tmp/My%20Shot.png").unwrap();
        assert_eq!(file.path, "/tmp/My Shot.png");
        assert_eq!(file.name, "My Shot.png");
        assert_eq!(file.kind, Some(AttachedFileKind::Image));
        assert_eq!(local("/tmp/notes.md").unwrap().kind, Some(AttachedFileKind::File));
        assert!(local("").is_none());
    }
}
