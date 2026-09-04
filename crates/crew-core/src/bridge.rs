use std::collections::HashMap;
use std::io::{BufRead, BufReader, Write};
use std::os::unix::fs::PermissionsExt;
use std::os::unix::net::{UnixListener, UnixStream};
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::Duration;

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

/// A reload drops every listener; a call that arrives meanwhile fails instead of hanging.
const REPLY_TIMEOUT: Duration = Duration::from_secs(15);

/// One line in from `crew --mcp` / `crew call`: who is asking and what for.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Request {
    token: String,
    session_id: String,
    method: String,
    #[serde(default)]
    params: Value,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct ToolCall {
    pub id: u64,
    pub session_id: String,
    pub method: String,
    pub params: Value,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BridgeInfo {
    pub socket_path: String,
    pub token: String,
    pub exe: String,
}

pub trait BridgeEvents: Send + Sync {
    fn tool(&self, call: ToolCall);
}

struct Shared {
    pending: Mutex<HashMap<u64, UnixStream>>,
    next_id: AtomicU64,
    socket_path: PathBuf,
    token: String,
    events: Mutex<Option<Arc<dyn BridgeEvents>>>,
}

/// Relays tool calls from agent processes to the webview and their replies back.
/// Rust never interprets a call; the handlers live in `src/lib/agentTools.ts`.
#[derive(Clone)]
pub struct Bridge {
    shared: Arc<Shared>,
}

impl Bridge {
    pub fn start(dir: PathBuf) -> Result<Self, String> {
        std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
        let socket_path = dir.join("crew.sock");
        let _ = std::fs::remove_file(&socket_path);
        let listener = UnixListener::bind(&socket_path).map_err(|e| e.to_string())?;
        std::fs::set_permissions(&socket_path, std::fs::Permissions::from_mode(0o600))
            .map_err(|e| e.to_string())?;

        let bridge = Self {
            shared: Arc::new(Shared {
                pending: Mutex::new(HashMap::new()),
                next_id: AtomicU64::new(1),
                socket_path,
                token: uuid::Uuid::new_v4().to_string(),
                events: Mutex::new(None),
            }),
        };
        let serve_bridge = bridge.clone();
        thread::spawn(move || {
            for stream in listener.incoming().flatten() {
                let bridge = serve_bridge.clone();
                thread::spawn(move || serve(bridge, stream));
            }
        });
        Ok(bridge)
    }

    pub fn set_events(&self, events: Arc<dyn BridgeEvents>) {
        *self.shared.events.lock().unwrap_or_else(|e| e.into_inner()) = Some(events);
    }

    fn events(&self) -> Option<Arc<dyn BridgeEvents>> {
        self.shared.events.lock().unwrap_or_else(|e| e.into_inner()).clone()
    }

    pub fn shutdown(&self) {
        let _ = std::fs::remove_file(&self.shared.socket_path);
    }

    fn take(&self, id: u64) -> Option<UnixStream> {
        self.shared.pending.lock().ok()?.remove(&id)
    }

    pub fn info(&self) -> Result<BridgeInfo, String> {
        let exe = std::env::current_exe().map_err(|e| e.to_string())?;
        Ok(BridgeInfo {
            socket_path: self.shared.socket_path.to_string_lossy().into_owned(),
            token: self.shared.token.clone(),
            exe: exe.to_string_lossy().into_owned(),
        })
    }

    pub fn reply(&self, id: u64, response: Value) -> Result<(), String> {
        match self.take(id) {
            Some(stream) => {
                reply(stream, response);
                Ok(())
            }
            None => Err("No call is waiting on that id".into()),
        }
    }
}

fn serve(bridge: Bridge, stream: UnixStream) {
    let mut line = String::new();
    let mut reader = BufReader::new(match stream.try_clone() {
        Ok(reader) => reader,
        Err(_) => return,
    });
    let _ = stream.set_read_timeout(Some(REPLY_TIMEOUT));
    if reader.read_line(&mut line).is_err() {
        return;
    }
    let request: Request = match serde_json::from_str(&line) {
        Ok(request) => request,
        Err(e) => return reply(stream, json!({ "error": format!("Bad request: {e}") })),
    };
    if request.token != bridge.shared.token {
        return reply(stream, json!({ "error": "Bad token" }));
    }

    let id = bridge.shared.next_id.fetch_add(1, Ordering::Relaxed);
    if let Ok(mut pending) = bridge.shared.pending.lock() {
        pending.insert(id, stream);
    }
    let Some(events) = bridge.events() else {
        if let Some(stream) = bridge.take(id) {
            reply(stream, json!({ "error": "Crew could not reach its window" }));
        }
        return;
    };
    events.tool(ToolCall {
        id,
        session_id: request.session_id,
        method: request.method,
        params: request.params,
    });

    thread::sleep(REPLY_TIMEOUT);
    if let Some(stream) = bridge.take(id) {
        reply(stream, json!({ "error": "Crew did not answer in time" }));
    }
}

fn reply(mut stream: UnixStream, body: Value) {
    let mut text = body.to_string();
    text.push('\n');
    let _ = stream.write_all(text.as_bytes());
    let _ = stream.shutdown(std::net::Shutdown::Both);
}
