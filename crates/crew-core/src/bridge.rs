use std::io::{BufRead, BufReader, Write};
use std::os::unix::fs::PermissionsExt;
use std::os::unix::net::{UnixListener, UnixStream};
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::thread;

use serde::Deserialize;
use serde_json::{json, Value};

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Request {
    token: String,
    session_id: String,
    method: String,
    #[serde(default)]
    params: Value,
}

#[derive(serde::Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct BridgeInfo {
    pub socket_path: String,
    pub token: String,
    pub exe: String,
}

pub trait ToolHost: Send + Sync {
    fn handle(&self, session_id: &str, method: &str, params: Value) -> Result<Value, String>;
}

struct Shared {
    handler: Mutex<Option<Arc<dyn ToolHost>>>,
    socket_path: PathBuf,
    token: String,
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
                token: uuid::Uuid::new_v4().to_string(),
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

    pub fn shutdown(&self) {
        let _ = std::fs::remove_file(&self.shared.socket_path);
    }

    pub fn info(&self) -> Result<BridgeInfo, String> {
        let exe = std::env::current_exe().map_err(|e| e.to_string())?;
        Ok(BridgeInfo {
            socket_path: self.shared.socket_path.to_string_lossy().into_owned(),
            token: self.shared.token.clone(),
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
    if request.token != bridge.shared.token {
        return reply(stream, json!({ "error": "Bad token" }));
    }
    let handler = bridge
        .shared
        .handler
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .clone();
    let Some(handler) = handler else {
        return reply(stream, json!({ "error": "Crew could not reach its window" }));
    };
    let body = match handler.handle(&request.session_id, &request.method, request.params) {
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
