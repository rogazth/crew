use std::collections::HashMap;
use std::io::{BufRead, BufReader, Write};
use std::os::unix::fs::PermissionsExt;
use std::os::unix::net::{UnixListener, UnixStream};
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::thread;

use serde::Deserialize;
use serde_json::{json, Value};

/// There is no `session_id` here on purpose. It used to arrive on the wire and
/// be believed, which made the caller whoever the caller said it was: an
/// agent's own shell inherits the socket and could name anybody. The token is
/// the identity now — it says which session is calling, and nothing else does.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Request {
    token: String,
    method: String,
    #[serde(default)]
    params: Value,
}

#[derive(serde::Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct BridgeInfo {
    pub socket_path: String,
    pub exe: String,
}

pub trait ToolHost: Send + Sync {
    fn handle(&self, session_id: &str, method: &str, params: Value) -> Result<Value, String>;
}

struct Shared {
    handler: Mutex<Option<Arc<dyn ToolHost>>>,
    socket_path: PathBuf,
    /// token → the session that holds it. One per session, replaced whenever
    /// that session starts a turn, so a token that leaked out of a process
    /// stops working the next time its owner runs.
    tokens: Mutex<HashMap<String, String>>,
}

/// Relays `crew --mcp` / `crew call` into the daemon tool host.
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
                handler: Mutex::new(None),
                socket_path,
                tokens: Mutex::new(HashMap::new()),
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

    pub fn set_handler(&self, handler: Arc<dyn ToolHost>) {
        *self.shared.handler.lock().unwrap_or_else(|e| e.into_inner()) = Some(handler);
    }

    /// A fresh token for one session, and the end of whatever it held before.
    ///
    /// Minted per turn, because a turn is one process: when that process dies
    /// its token is worth having only until the next one starts. Cursor has no
    /// MCP and reaches the bridge through `crew call` in its shell, so the
    /// token is what stops that shell from speaking as anybody else.
    pub fn mint(&self, session_id: &str) -> String {
        let token = uuid::Uuid::new_v4().to_string();
        let mut tokens = self.shared.tokens.lock().unwrap_or_else(|e| e.into_inner());
        tokens.retain(|_, held| held != session_id);
        tokens.insert(token.clone(), session_id.to_string());
        token
    }

    /// Hand a session's token back, for a session that is gone.
    pub fn revoke(&self, session_id: &str) {
        self.shared
            .tokens
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .retain(|_, held| held != session_id);
    }

    fn whose(&self, token: &str) -> Option<String> {
        self.shared
            .tokens
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .get(token)
            .cloned()
    }

    pub fn shutdown(&self) {
        let _ = std::fs::remove_file(&self.shared.socket_path);
    }

    pub fn info(&self) -> Result<BridgeInfo, String> {
        let exe = std::env::current_exe().map_err(|e| e.to_string())?;
        Ok(BridgeInfo {
            socket_path: self.shared.socket_path.to_string_lossy().into_owned(),
            exe: exe.to_string_lossy().into_owned(),
        })
    }
}

fn serve(bridge: Bridge, stream: UnixStream) {
    let mut line = String::new();
    let mut reader = BufReader::new(match stream.try_clone() {
        Ok(reader) => reader,
        Err(_) => return,
    });
    if reader.read_line(&mut line).is_err() {
        return;
    }
    let request: Request = match serde_json::from_str(&line) {
        Ok(request) => request,
        Err(e) => return reply(stream, json!({ "error": format!("Bad request: {e}") })),
    };
    let Some(session_id) = bridge.whose(&request.token) else {
        return reply(stream, json!({ "error": "Bad token" }));
    };
    let handler = bridge
        .shared
        .handler
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .clone();
    let Some(handler) = handler else {
        return reply(stream, json!({ "error": "Tool handler is not set" }));
    };
    let body = match handler.handle(&session_id, &request.method, request.params) {
        Ok(result) => json!({ "result": result }),
        Err(error) => json!({ "error": error }),
    };
    reply(stream, body);
}

fn reply(mut stream: UnixStream, body: Value) {
    let mut text = body.to_string();
    text.push('\n');
    let _ = stream.write_all(text.as_bytes());
    let _ = stream.shutdown(std::net::Shutdown::Both);
}
