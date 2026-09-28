//! The daemon's one port: a WebSocket upgrade goes to the RPC socket, and a
//! plain `GET /fs` serves a file, so a window on another machine can preview
//! what an agent wrote without a second listener.

use std::collections::HashMap;
use std::io::SeekFrom;
use std::path::{Component, Path, PathBuf};
use std::time::Duration;

use tokio::io::{AsyncReadExt, AsyncSeekExt, AsyncWriteExt};
use tokio::net::TcpStream;
use tokio_tungstenite::tungstenite::handshake::derive_accept_key;
use tokio_tungstenite::tungstenite::protocol::Role;
use tokio_tungstenite::WebSocketStream;

const HEAD_MAX: usize = 16 * 1024;
const HEAD_WAIT: Duration = Duration::from_secs(10);

struct Head {
    method: String,
    target: String,
    headers: HashMap<String, String>,
}

impl Head {
    fn header(&self, name: &str) -> Option<&str> {
        self.headers.get(name).map(String::as_str)
    }
}

/// The WebSocket a connection asked for, or None once a plain request was
/// answered (or the connection was not worth one).
pub async fn accept(mut stream: TcpStream, token: &str) -> Option<WebSocketStream<TcpStream>> {
    let (head, rest) = tokio::time::timeout(HEAD_WAIT, read_head(&mut stream)).await.ok()??;
    let upgrade = head
        .header("upgrade")
        .is_some_and(|value| value.eq_ignore_ascii_case("websocket"));
    if upgrade {
        let Some(key) = head.header("sec-websocket-key") else {
            let _ = respond(&mut stream, 400, "Bad Request", &[], b"Missing Sec-WebSocket-Key").await;
            return None;
        };
        let accept = derive_accept_key(key.as_bytes());
        let reply = format!(
            "HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: {accept}\r\n\r\n"
        );
        stream.write_all(reply.as_bytes()).await.ok()?;
        return Some(WebSocketStream::from_partially_read(stream, rest, Role::Server, None).await);
    }
    serve(&mut stream, &head, token).await;
    let _ = stream.shutdown().await;
    None
}

/// The request line and headers, and whatever arrived after them.
async fn read_head(stream: &mut TcpStream) -> Option<(Head, Vec<u8>)> {
    let mut buf = Vec::with_capacity(1024);
    let mut chunk = [0u8; 1024];
    let end = loop {
        let read = stream.read(&mut chunk).await.ok()?;
        if read == 0 {
            return None;
        }
        buf.extend_from_slice(&chunk[..read]);
        if let Some(at) = buf.windows(4).position(|window| window == b"\r\n\r\n") {
            break at;
        }
        if buf.len() > HEAD_MAX {
            return None;
        }
    };
    let text = std::str::from_utf8(&buf[..end]).ok()?;
    let mut lines = text.split("\r\n");
    let mut request = lines.next()?.split(' ');
    let method = request.next()?.to_string();
    let target = request.next()?.to_string();
    let headers = lines
        .filter_map(|line| {
            let (name, value) = line.split_once(':')?;
            Some((name.trim().to_ascii_lowercase(), value.trim().to_string()))
        })
        .collect();
    let rest = buf[end + 4..].to_vec();
    Some((Head { method, target, headers }, rest))
}

async fn respond(
    stream: &mut TcpStream,
    status: u16,
    reason: &str,
    headers: &[(&str, String)],
    body: &[u8],
) -> std::io::Result<()> {
    let mut head = format!("HTTP/1.1 {status} {reason}\r\nConnection: close\r\nContent-Length: {}\r\n", body.len());
    if !headers.iter().any(|(name, _)| name.eq_ignore_ascii_case("content-type")) {
        head.push_str("Content-Type: text/plain; charset=utf-8\r\n");
    }
    for (name, value) in headers {
        head.push_str(&format!("{name}: {value}\r\n"));
    }
    head.push_str("\r\n");
    stream.write_all(head.as_bytes()).await?;
    stream.write_all(body).await
}

async fn serve(stream: &mut TcpStream, head: &Head, token: &str) {
    let (path, query) = head.target.split_once('?').unwrap_or((head.target.as_str(), ""));
    if path != "/fs" {
        let _ = respond(stream, 404, "Not Found", &[], b"Not found").await;
        return;
    }
    if head.method != "GET" && head.method != "HEAD" {
        let _ = respond(stream, 405, "Method Not Allowed", &[("Allow", "GET, HEAD".into())], b"").await;
        return;
    }
    let bearer = head.header("authorization").and_then(|value| value.strip_prefix("Bearer "));
    if bearer != Some(token) {
        let _ = respond(stream, 401, "Unauthorized", &[], b"Unauthorized").await;
        return;
    }
    let params = parse_query(query);
    let (Some(root), Some(file)) = (params.get("root"), params.get("path")) else {
        let _ = respond(stream, 400, "Bad Request", &[], b"root and path are required").await;
        return;
    };
    let Some(real) = resolve(Path::new(root), file).await else {
        let _ = respond(stream, 404, "Not Found", &[], b"Not found").await;
        return;
    };
    let _ = send_file(stream, &real, head).await;
}

/// The file under `root` that `file` names, followed through its symlinks, or
/// None. A hidden segment is refused, which also keeps `..` out: a preview may
/// read the worktree it was opened from, never its .env, .git or its parents.
async fn resolve(root: &Path, file: &str) -> Option<PathBuf> {
    let lexical = served_path(root, file)?;
    let mut target = lexical;
    if tokio::fs::metadata(&target).await.ok()?.is_dir() {
        target.push("index.html");
    }
    let real_root = tokio::fs::canonicalize(root).await.ok()?;
    let real = tokio::fs::canonicalize(&target).await.ok()?;
    // Component-wise: `/a/bc` is not under `/a/b`.
    if !real.starts_with(&real_root) || !tokio::fs::metadata(&real).await.ok()?.is_file() {
        return None;
    }
    Some(real)
}

fn served_path(root: &Path, file: &str) -> Option<PathBuf> {
    if !root.is_absolute() || file.contains('\0') || file.contains('\\') {
        return None;
    }
    let segments: Vec<&str> = file.split('/').filter(|segment| !segment.is_empty()).collect();
    if segments.iter().any(|segment| segment.starts_with('.')) {
        return None;
    }
    let path = segments.iter().fold(root.to_path_buf(), |path, segment| path.join(segment));
    // A segment is plain text after the split, but a root like `/a/../b` is not.
    if path.components().any(|component| matches!(component, Component::ParentDir)) {
        return None;
    }
    Some(path)
}

async fn send_file(stream: &mut TcpStream, real: &Path, head: &Head) -> std::io::Result<()> {
    let mut file = tokio::fs::File::open(real).await?;
    let len = file.metadata().await?.len();
    let kind = ("Content-Type", content_type(real).to_string());
    let mut headers = vec![kind, ("Accept-Ranges", "bytes".into()), ("Cache-Control", "no-store".into())];
    let (status, reason, start, count) = match head.header("range") {
        None => (200, "OK", 0, len),
        Some(range) => match byte_range(range, len) {
            Some((start, end)) => {
                headers.push(("Content-Range", format!("bytes {start}-{end}/{len}")));
                (206, "Partial Content", start, end - start + 1)
            }
            None => {
                headers.push(("Content-Range", format!("bytes */{len}")));
                return respond(stream, 416, "Range Not Satisfiable", &headers, b"").await;
            }
        },
    };
    let mut out = format!("HTTP/1.1 {status} {reason}\r\nConnection: close\r\nContent-Length: {count}\r\n");
    for (name, value) in &headers {
        out.push_str(&format!("{name}: {value}\r\n"));
    }
    out.push_str("\r\n");
    stream.write_all(out.as_bytes()).await?;
    if head.method == "HEAD" {
        return Ok(());
    }
    file.seek(SeekFrom::Start(start)).await?;
    tokio::io::copy(&mut file.take(count), stream).await?;
    Ok(())
}

/// A single `bytes=` range as inclusive offsets, or None when it cannot be met.
fn byte_range(header: &str, len: u64) -> Option<(u64, u64)> {
    let spec = header.trim().strip_prefix("bytes=")?;
    if spec.contains(',') || len == 0 {
        return None;
    }
    let (from, to) = spec.split_once('-')?;
    let (from, to) = (from.trim(), to.trim());
    let (start, end) = if from.is_empty() {
        let suffix: u64 = to.parse().ok()?;
        if suffix == 0 {
            return None;
        }
        (len.saturating_sub(suffix), len - 1)
    } else {
        let start: u64 = from.parse().ok()?;
        let end = if to.is_empty() { len - 1 } else { to.parse::<u64>().ok()?.min(len - 1) };
        (start, end)
    };
    (start <= end && start < len).then_some((start, end))
}

fn parse_query(query: &str) -> HashMap<String, String> {
    query
        .split('&')
        .filter_map(|pair| {
            let (name, value) = pair.split_once('=').unwrap_or((pair, ""));
            Some((percent_decode(name)?, percent_decode(value)?))
        })
        .collect()
}

fn percent_decode(text: &str) -> Option<String> {
    let bytes = text.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        match bytes[i] {
            b'%' => {
                let hex = std::str::from_utf8(bytes.get(i + 1..i + 3)?).ok()?;
                out.push(u8::from_str_radix(hex, 16).ok()?);
                i += 3;
            }
            b'+' => {
                out.push(b' ');
                i += 1;
            }
            byte => {
                out.push(byte);
                i += 1;
            }
        }
    }
    String::from_utf8(out).ok()
}

fn content_type(path: &Path) -> &'static str {
    let extension = path
        .extension()
        .and_then(|extension| extension.to_str())
        .map(str::to_ascii_lowercase)
        .unwrap_or_default();
    match extension.as_str() {
        "html" | "htm" => "text/html; charset=utf-8",
        "css" => "text/css; charset=utf-8",
        "js" | "mjs" => "text/javascript; charset=utf-8",
        "json" | "map" => "application/json",
        "txt" | "log" => "text/plain; charset=utf-8",
        "md" => "text/markdown; charset=utf-8",
        "csv" => "text/csv; charset=utf-8",
        "xml" => "application/xml",
        "svg" => "image/svg+xml",
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "avif" => "image/avif",
        "ico" => "image/x-icon",
        "bmp" => "image/bmp",
        "pdf" => "application/pdf",
        "mp4" | "m4v" => "video/mp4",
        "webm" => "video/webm",
        "mov" => "video/quicktime",
        "mp3" => "audio/mpeg",
        "m4a" => "audio/mp4",
        "wav" => "audio/wav",
        "ogg" | "oga" => "audio/ogg",
        "flac" => "audio/flac",
        "wasm" => "application/wasm",
        "woff" => "font/woff",
        "woff2" => "font/woff2",
        "ttf" => "font/ttf",
        "otf" => "font/otf",
        _ => "application/octet-stream",
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn served_path_refuses_hidden_and_parent_segments() {
        let root = Path::new("/w");
        assert_eq!(served_path(root, "a/b.html"), Some(PathBuf::from("/w/a/b.html")));
        assert_eq!(served_path(root, "/a//b.html"), Some(PathBuf::from("/w/a/b.html")));
        assert_eq!(served_path(root, "../etc/passwd"), None);
        assert_eq!(served_path(root, "a/.env"), None);
        assert_eq!(served_path(root, ".git/config"), None);
        assert_eq!(served_path(root, "a\\b"), None);
        assert_eq!(served_path(Path::new("w"), "a"), None);
        assert_eq!(served_path(Path::new("/w/../etc"), "passwd"), None);
    }

    #[test]
    fn byte_ranges() {
        assert_eq!(byte_range("bytes=0-9", 100), Some((0, 9)));
        assert_eq!(byte_range("bytes=90-", 100), Some((90, 99)));
        assert_eq!(byte_range("bytes=-10", 100), Some((90, 99)));
        assert_eq!(byte_range("bytes=50-500", 100), Some((50, 99)));
        assert_eq!(byte_range("bytes=100-", 100), None);
        assert_eq!(byte_range("bytes=9-0", 100), None);
        assert_eq!(byte_range("bytes=0-1,4-5", 100), None);
        assert_eq!(byte_range("items=0-1", 100), None);
    }

    #[test]
    fn query_decodes() {
        let params = parse_query("root=%2Fhome%2Fme%20x&path=a+b.html");
        assert_eq!(params["root"], "/home/me x");
        assert_eq!(params["path"], "a b.html");
        assert!(percent_decode("%zz").is_none());
    }
}
