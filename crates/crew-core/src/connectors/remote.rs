//! The client side of MCP's streamable HTTP transport (spec 2025-06-18), for
//! one account's remote server.
//!
//! The daemon keeps one `RemoteClient` per account and calls it with the
//! access token it holds at the time, so a refreshed token needs no new
//! client. The client initializes on its first call and keeps the session
//! the server gave it; a 404 means the server dropped that session, and the
//! call initializes once more and is sent again.
//!
//! A server may answer a POST with JSON or with an event stream. Both are
//! read until the response with the request's id; what else the server sends
//! in the stream is ignored, except `notifications/tools/list_changed`, which
//! marks the account's tools for a fresh list (`take_list_changed`).
//!
//! The older HTTP+SSE transport (2024-11-05) is not spoken: a server that
//! answers like one gets a clear error, not a hang.
//!
//! The bearer goes to the server URL only: the client follows no redirect.

use std::fmt;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Arc;
use std::time::Duration;

use reqwest::header::{HeaderMap, ACCEPT, AUTHORIZATION, CONTENT_TYPE, WWW_AUTHENTICATE};
use reqwest::{Method, Response, StatusCode};
use serde_json::{json, Value};
use tokio::sync::Mutex;
use url::Url;

use super::{net, oauth};

/// The version Crew asks for.
pub const PROTOCOL_VERSION: &str = "2025-06-18";

/// The versions Crew speaks over streamable HTTP, should the server answer
/// with another one it supports.
const KNOWN_VERSIONS: &[&str] = &["2025-11-25", "2025-06-18", "2025-03-26"];

/// For the handshake and `tools/list`.
const HANDSHAKE_TIMEOUT: Duration = Duration::from_secs(30);

/// For a tool call, unless the client is given another.
pub const CALL_TIMEOUT: Duration = Duration::from_secs(300);

/// The most one answer may hold.
const MAX_BODY: usize = 32 << 20;

/// Pages of `tools/list` followed before giving up on a server that never
/// stops paging.
const MAX_PAGES: usize = 50;

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum RemoteError {
    /// 401: the token is not taken (expired, revoked). The header says what
    /// the server wants, for a fresh sign-in.
    Unauthorized { www_authenticate: Option<String> },
    /// 403 `insufficient_scope`: the account needs a sign-in with more scope.
    InsufficientScope { scope: Option<String> },
    Http(u16, String),
    Network(String),
    Protocol(String),
}

impl fmt::Display for RemoteError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            RemoteError::Unauthorized { .. } => f.write_str("The server did not take the sign-in"),
            RemoteError::InsufficientScope { .. } => f.write_str("The sign-in does not allow this; sign in again to allow it"),
            RemoteError::Http(code, text) if text.is_empty() => write!(f, "The server answered {code}"),
            RemoteError::Http(code, text) => write!(f, "The server answered {code}: {text}"),
            RemoteError::Network(m) | RemoteError::Protocol(m) => f.write_str(m),
        }
    }
}

impl std::error::Error for RemoteError {}

/// One account's connection to its server. Cheap to clone: clones share the
/// session.
#[derive(Clone)]
pub struct RemoteClient {
    inner: Arc<Inner>,
    call_timeout: Duration,
}

struct Inner {
    url: Url,
    session: Mutex<Option<Negotiated>>,
    next_id: AtomicU64,
    list_changed: AtomicBool,
}

#[derive(Clone, PartialEq, Eq)]
struct Negotiated {
    session_id: Option<String>,
    version: String,
}

impl fmt::Debug for RemoteClient {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("RemoteClient").field("url", &self.inner.url.as_str()).finish_non_exhaustive()
    }
}

impl RemoteClient {
    pub fn new(server_url: &str) -> Result<Self, RemoteError> {
        let url = net::check_url(server_url).map_err(RemoteError::Protocol)?;
        Ok(RemoteClient {
            inner: Arc::new(Inner {
                url,
                session: Mutex::new(None),
                next_id: AtomicU64::new(1),
                list_changed: AtomicBool::new(false),
            }),
            call_timeout: CALL_TIMEOUT,
        })
    }

    /// How long a tool call may take, start to end.
    pub fn with_call_timeout(mut self, timeout: Duration) -> Self {
        self.call_timeout = timeout;
        self
    }

    pub fn url(&self) -> &str {
        self.inner.url.as_str()
    }

    /// Whether the server said its tools changed since this was last asked.
    pub fn take_list_changed(&self) -> bool {
        self.inner.list_changed.swap(false, Ordering::Relaxed)
    }

    /// Every tool the server lists, following its pages.
    pub async fn list_tools(&self, access_token: &str) -> Result<Vec<Value>, RemoteError> {
        let mut tools = Vec::new();
        let mut cursor: Option<String> = None;
        for _ in 0..MAX_PAGES {
            let params = match &cursor {
                Some(c) => json!({ "cursor": c }),
                None => json!({}),
            };
            let page = self.request(access_token, "tools/list", params, HANDSHAKE_TIMEOUT).await?;
            tools.extend(page["tools"].as_array().cloned().unwrap_or_default());
            match page["nextCursor"].as_str().filter(|c| !c.is_empty()) {
                Some(next) if cursor.as_deref() != Some(next) => cursor = Some(next.to_string()),
                _ => return Ok(tools),
            }
        }
        Err(RemoteError::Protocol(format!("The server's tool list ran past {MAX_PAGES} pages")))
    }

    /// Calls a tool and answers its `CallToolResult`. A tool that fails says
    /// so in the result (`isError`); an `Err` is the transport's.
    pub async fn call_tool(
        &self,
        access_token: &str,
        name: &str,
        arguments: Value,
        meta: Option<Value>,
    ) -> Result<Value, RemoteError> {
        let mut params = json!({ "name": name, "arguments": arguments });
        if let Some(meta) = meta {
            params["_meta"] = meta;
        }
        self.request(access_token, "tools/call", params, self.call_timeout).await
    }

    async fn request(&self, token: &str, method: &str, params: Value, timeout: Duration) -> Result<Value, RemoteError> {
        let mut retried = false;
        loop {
            let negotiated = self.session(token).await?;
            let id = self.inner.next_id.fetch_add(1, Ordering::Relaxed);
            let body = json!({ "jsonrpc": "2.0", "id": id, "method": method, "params": params });
            let answer = match self.post(token, Some(&negotiated), &body, timeout).await {
                Ok(res) => self.read_response(res, id, method, token).await,
                Err(e) => Err(e),
            };
            match answer {
                Err(RemoteError::Http(404, _)) if !retried && negotiated.session_id.is_some() => {
                    self.forget(&negotiated).await;
                    retried = true;
                }
                other => return other,
            }
        }
    }

    /// The session, initializing it first when there is none. The lock is
    /// held while initializing, so calls that start together share one
    /// handshake.
    async fn session(&self, token: &str) -> Result<Negotiated, RemoteError> {
        let mut session = self.inner.session.lock().await;
        if let Some(n) = session.as_ref() {
            return Ok(n.clone());
        }
        let n = self.initialize(token).await?;
        *session = Some(n.clone());
        Ok(n)
    }

    async fn forget(&self, stale: &Negotiated) {
        let mut session = self.inner.session.lock().await;
        if session.as_ref() == Some(stale) {
            *session = None;
        }
    }

    async fn initialize(&self, token: &str) -> Result<Negotiated, RemoteError> {
        let id = self.inner.next_id.fetch_add(1, Ordering::Relaxed);
        let body = json!({
            "jsonrpc": "2.0", "id": id, "method": "initialize",
            "params": {
                "protocolVersion": PROTOCOL_VERSION,
                "capabilities": {},
                "clientInfo": { "name": "Crew", "version": env!("CARGO_PKG_VERSION") },
            },
        });
        let res = self.post(token, None, &body, HANDSHAKE_TIMEOUT).await?;
        let session_id = res.headers().get("mcp-session-id").and_then(|v| v.to_str().ok()).map(str::to_string);
        let result = self.read_response(res, id, "initialize", token).await?;
        let version = result["protocolVersion"].as_str().unwrap_or_default();
        if !KNOWN_VERSIONS.contains(&version) {
            return Err(RemoteError::Protocol(format!("The server speaks MCP {version:?}, which Crew does not")));
        }
        let negotiated = Negotiated { session_id, version: version.to_string() };
        let note = json!({ "jsonrpc": "2.0", "method": "notifications/initialized" });
        self.post(token, Some(&negotiated), &note, HANDSHAKE_TIMEOUT).await?;
        Ok(negotiated)
    }

    /// Sends one message; any answer but 2xx is an error here.
    async fn post(&self, token: &str, negotiated: Option<&Negotiated>, body: &Value, timeout: Duration) -> Result<Response, RemoteError> {
        let mut req = net::client()
            .request(Method::POST, self.inner.url.clone())
            .timeout(timeout)
            .header(AUTHORIZATION, format!("Bearer {token}"))
            .header(ACCEPT, "application/json, text/event-stream")
            .json(body);
        if let Some(n) = negotiated {
            req = req.header("MCP-Protocol-Version", &n.version);
            if let Some(id) = &n.session_id {
                req = req.header("Mcp-Session-Id", id);
            }
        }
        let res = req.send().await.map_err(|e| RemoteError::Network(net::describe(e)))?;
        let status = res.status();
        if status.is_success() {
            return Ok(res);
        }
        let challenge = header_text(res.headers(), WWW_AUTHENTICATE.as_str());
        match status {
            StatusCode::UNAUTHORIZED => Err(RemoteError::Unauthorized { www_authenticate: challenge }),
            StatusCode::FORBIDDEN
                if challenge.as_deref().and_then(|c| oauth::auth_param(c, "error")).as_deref() == Some("insufficient_scope") =>
            {
                Err(RemoteError::InsufficientScope { scope: challenge.as_deref().and_then(|c| oauth::auth_param(c, "scope")) })
            }
            StatusCode::METHOD_NOT_ALLOWED => Err(legacy()),
            _ => {
                let text = net::read_body(res, 4096).await.unwrap_or_default();
                let text = String::from_utf8_lossy(&text).replace(token, "…");
                let line = text.lines().find(|l| !l.trim().is_empty()).unwrap_or_default();
                Err(RemoteError::Http(status.as_u16(), net::shorten(line, 200)))
            }
        }
    }

    /// The result of the response to request `id`, from a JSON body or an
    /// event stream. A JSON-RPC error is a `Protocol` error.
    async fn read_response(&self, res: Response, id: u64, method: &str, token: &str) -> Result<Value, RemoteError> {
        let stream = header_text(res.headers(), CONTENT_TYPE.as_str()).is_some_and(|t| t.starts_with("text/event-stream"));
        if !stream {
            let body = net::read_body(res, MAX_BODY).await.map_err(RemoteError::Network)?;
            let message: Value = serde_json::from_slice(&body)
                .map_err(|_| RemoteError::Protocol("The server's answer is not JSON".to_string()))?;
            return self.take(&message, id, method, token).unwrap_or_else(|| Err(no_answer()));
        }
        let mut res = res;
        let mut parser = SseParser::default();
        let mut seen = 0usize;
        while let Some(chunk) = res.chunk().await.map_err(|e| RemoteError::Network(net::describe(e)))? {
            seen += chunk.len();
            if seen > MAX_BODY {
                return Err(RemoteError::Protocol("The server's answer is too large".to_string()));
            }
            for event in parser.feed(&chunk) {
                if event.name == "endpoint" {
                    return Err(legacy());
                }
                let Ok(message) = serde_json::from_str::<Value>(&event.data) else { continue };
                if let Some(answer) = self.take(&message, id, method, token) {
                    return answer;
                }
            }
        }
        Err(no_answer())
    }

    /// The answer to `id` in one message (or batch), noting a tools change.
    fn take(&self, message: &Value, id: u64, method: &str, token: &str) -> Option<Result<Value, RemoteError>> {
        if let Some(batch) = message.as_array() {
            return batch.iter().find_map(|m| self.take(m, id, method, token));
        }
        if message["method"] == "notifications/tools/list_changed" {
            self.inner.list_changed.store(true, Ordering::Relaxed);
        }
        if message["id"] != json!(id) || message.get("method").is_some() {
            return None;
        }
        if let Some(error) = message.get("error") {
            let text = error["message"].as_str().unwrap_or("an error").replace(token, "…");
            let code = error["code"].as_i64().unwrap_or_default();
            return Some(Err(RemoteError::Protocol(format!("{method} failed: {} ({code})", net::shorten(&text, 300)))));
        }
        Some(Ok(message.get("result").cloned().unwrap_or(Value::Null)))
    }
}

fn legacy() -> RemoteError {
    RemoteError::Protocol("The server speaks MCP's older HTTP+SSE transport, which Crew does not".to_string())
}

fn no_answer() -> RemoteError {
    RemoteError::Protocol("The server ended its answer without a response".to_string())
}

fn header_text(headers: &HeaderMap, name: &str) -> Option<String> {
    headers.get(name).and_then(|v| v.to_str().ok()).map(str::to_string)
}

/// One server-sent event.
#[derive(Debug, PartialEq, Eq)]
struct Event {
    name: String,
    data: String,
}

/// Server-sent events from chunks that may split a line anywhere.
#[derive(Default)]
struct SseParser {
    pending: Vec<u8>,
    name: String,
    data: Vec<String>,
}

impl SseParser {
    fn feed(&mut self, chunk: &[u8]) -> Vec<Event> {
        self.pending.extend_from_slice(chunk);
        let mut events = Vec::new();
        while let Some(end) = self.pending.iter().position(|&b| b == b'\n' || b == b'\r') {
            // A CR at the very end may be half of a CRLF: wait for the next chunk.
            if self.pending[end] == b'\r' && end + 1 == self.pending.len() {
                break;
            }
            let skip = if self.pending[end] == b'\r' && self.pending[end + 1] == b'\n' { 2 } else { 1 };
            let line = String::from_utf8_lossy(&self.pending[..end]).into_owned();
            self.pending.drain(..end + skip);
            if line.is_empty() {
                if !self.data.is_empty() {
                    let name = std::mem::take(&mut self.name);
                    events.push(Event { name: if name.is_empty() { "message".into() } else { name }, data: self.data.join("\n") });
                    self.data.clear();
                }
                self.name.clear();
                continue;
            }
            if line.starts_with(':') {
                continue;
            }
            let (field, value) = line.split_once(':').unwrap_or((&line, ""));
            let value = value.strip_prefix(' ').unwrap_or(value);
            match field {
                "data" => self.data.push(value.to_string()),
                "event" => self.name = value.to_string(),
                _ => {}
            }
        }
        events
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn events_are_read_across_chunks_and_line_endings() {
        let mut p = SseParser::default();
        let mut events = p.feed(b": ping\r\nevent: message\r\ndata: {\"a\"");
        assert!(events.is_empty());
        events.extend(p.feed(b":1}\r"));
        events.extend(p.feed(b"\n\r\ndata: x\ndata: y\n\nevent: endpoint\ndata:/messages\n\n"));
        assert_eq!(
            events,
            [
                Event { name: "message".into(), data: r#"{"a":1}"#.into() },
                Event { name: "message".into(), data: "x\ny".into() },
                Event { name: "endpoint".into(), data: "/messages".into() },
            ]
        );
    }

    #[test]
    fn the_answer_is_picked_by_id_and_a_tools_change_is_noted() {
        let c = RemoteClient::new("https://mcp.example.com/mcp").unwrap();
        let note = json!({ "jsonrpc": "2.0", "method": "notifications/tools/list_changed" });
        assert!(c.take(&note, 7, "m", "t").is_none());
        assert!(c.take_list_changed());
        assert!(!c.take_list_changed(), "taking it clears it");
        let request = json!({ "jsonrpc": "2.0", "id": 7, "method": "sampling/createMessage" });
        assert!(c.take(&request, 7, "m", "t").is_none(), "a server's own request with the same id is not the answer");
        let batch = json!([{ "jsonrpc": "2.0", "id": 6, "result": 1 }, { "jsonrpc": "2.0", "id": 7, "result": { "ok": true } }]);
        assert_eq!(c.take(&batch, 7, "m", "t").unwrap().unwrap(), json!({ "ok": true }));
        let error = json!({ "jsonrpc": "2.0", "id": 7, "error": { "code": -32602, "message": "bad token t0k" } });
        let Some(Err(RemoteError::Protocol(m))) = c.take(&error, 7, "m", "t0k") else { panic!() };
        assert!(!m.contains("t0k"), "a token echoed in an error is hidden: {m}");
    }

    #[test]
    fn a_clients_debug_shows_only_its_url() {
        let c = RemoteClient::new("https://mcp.example.com/mcp").unwrap();
        assert_eq!(format!("{c:?}"), r#"RemoteClient { url: "https://mcp.example.com/mcp", .. }"#);
    }
}
