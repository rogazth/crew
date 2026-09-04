use std::collections::HashMap;
use std::io::{BufRead, BufReader, Write};
use std::os::unix::fs::PermissionsExt;
use std::os::unix::net::{UnixListener, UnixStream};
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Mutex;
use std::thread;
use std::time::Duration;

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tauri::{AppHandle, Emitter, Manager, State};

const TOOL_EVENT: &str = "agent-tool";
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
struct ToolCall {
    id: u64,
    session_id: String,
    method: String,
    params: Value,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BridgeInfo {
    pub socket_path: String,
    pub token: String,
    pub exe: String,
}

/// Relays tool calls from agent processes to the webview and their replies back.
/// Rust never interprets a call; the handlers live in `src/lib/agentTools.ts`.
pub struct Bridge {
    pending: Mutex<HashMap<u64, UnixStream>>,
    next_id: AtomicU64,
    socket_path: PathBuf,
    token: String,
}

impl Bridge {
    pub fn start(app: AppHandle, dir: PathBuf) -> Result<Self, String> {
        std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
        let socket_path = dir.join("crew.sock");
        let _ = std::fs::remove_file(&socket_path);
        let listener = UnixListener::bind(&socket_path).map_err(|e| e.to_string())?;
        std::fs::set_permissions(&socket_path, std::fs::Permissions::from_mode(0o600))
            .map_err(|e| e.to_string())?;

        thread::spawn(move || {
            for stream in listener.incoming().flatten() {
                let app = app.clone();
                thread::spawn(move || serve(app, stream));
            }
        });

        Ok(Self {
            pending: Mutex::new(HashMap::new()),
            next_id: AtomicU64::new(1),
            socket_path,
            token: uuid::Uuid::new_v4().to_string(),
        })
    }

    pub fn shutdown(&self) {
        let _ = std::fs::remove_file(&self.socket_path);
    }

    fn take(&self, id: u64) -> Option<UnixStream> {
        self.pending.lock().ok()?.remove(&id)
    }
}

fn serve(app: AppHandle, stream: UnixStream) {
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
    let Some(bridge) = app.try_state::<Bridge>() else {
        return reply(stream, json!({ "error": "Crew is shutting down" }));
    };
    if request.token != bridge.token {
        return reply(stream, json!({ "error": "Bad token" }));
    }

    let id = bridge.next_id.fetch_add(1, Ordering::Relaxed);
    if let Ok(mut pending) = bridge.pending.lock() {
        pending.insert(id, stream);
    }
    let emitted = app.emit(
        TOOL_EVENT,
        ToolCall {
            id,
            session_id: request.session_id,
            method: request.method,
            params: request.params,
        },
    );
    if emitted.is_err() {
        if let Some(stream) = bridge.take(id) {
            reply(stream, json!({ "error": "Crew could not reach its window" }));
        }
        return;
    }

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

#[tauri::command(async)]
pub fn bridge_info(bridge: State<Bridge>) -> Result<BridgeInfo, String> {
    let exe = std::env::current_exe().map_err(|e| e.to_string())?;
    Ok(BridgeInfo {
        socket_path: bridge.socket_path.to_string_lossy().into_owned(),
        token: bridge.token.clone(),
        exe: exe.to_string_lossy().into_owned(),
    })
}

#[tauri::command(async)]
pub fn bridge_reply(bridge: State<Bridge>, id: u64, response: Value) -> Result<(), String> {
    match bridge.take(id) {
        Some(stream) => {
            reply(stream, response);
            Ok(())
        }
        None => Err("No call is waiting on that id".into()),
    }
}
