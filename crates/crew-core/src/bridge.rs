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

#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_support::{temp_dir, WITHIN};
    use std::io::Read;
    use std::sync::mpsc;

    /// Answers every call with who asked and what they asked for.
    struct Echo;

    impl ToolHost for Echo {
        fn handle(&self, session_id: &str, method: &str, params: Value) -> Result<Value, String> {
            if method == "fail" {
                return Err(format!("{session_id} may not {method}"));
            }
            Ok(json!({ "session": session_id, "method": method, "params": params }))
        }
    }

    /// Remembers whether it was reached at all.
    #[derive(Default)]
    struct Witness {
        reached: Mutex<Vec<String>>,
    }

    impl ToolHost for Witness {
        fn handle(&self, session_id: &str, _method: &str, _params: Value) -> Result<Value, String> {
            self.reached.lock().unwrap().push(session_id.to_string());
            Ok(Value::Null)
        }
    }

    fn started(handler: Arc<dyn ToolHost>) -> (tempfile::TempDir, Bridge) {
        let dir = temp_dir();
        let bridge = Bridge::start(dir.path().to_path_buf()).expect("bridge");
        bridge.set_handler(handler);
        (dir, bridge)
    }

    /// Sends one raw frame and returns everything the bridge wrote back before it hung up.
    fn exchange(bridge: &Bridge, frame: &[u8]) -> String {
        let mut stream = UnixStream::connect(&bridge.shared.socket_path).expect("connect");
        stream.set_read_timeout(Some(WITHIN)).expect("read timeout");
        stream.write_all(frame).expect("write");
        let mut reply = String::new();
        stream.read_to_string(&mut reply).expect("reply in time");
        reply
    }

    fn reply_to(bridge: &Bridge, frame: &str) -> Value {
        let reply = exchange(bridge, frame.as_bytes());
        serde_json::from_str(&reply).unwrap_or_else(|e| panic!("reply {reply:?} is not json: {e}"))
    }

    fn call(bridge: &Bridge, token: &str, method: &str, params: Value) -> Value {
        let request = json!({ "token": token, "method": method, "params": params });
        reply_to(bridge, &format!("{request}\n"))
    }

    #[test]
    fn a_minted_token_speaks_for_the_session_it_was_minted_for() {
        let (_dir, bridge) = started(Arc::new(Echo));
        let first = bridge.mint("s1");
        let second = bridge.mint("s2");
        assert_ne!(first, second);

        let reply = call(&bridge, &first, "tools/call", json!({ "name": "x" }));
        let asked = json!({ "session": "s1", "method": "tools/call", "params": { "name": "x" } });
        assert_eq!(reply, json!({ "result": asked }));
        assert_eq!(call(&bridge, &second, "tools/list", Value::Null)["result"]["session"], "s2");
    }

    #[test]
    fn minting_again_retires_the_sessions_previous_token() {
        let (_dir, bridge) = started(Arc::new(Echo));
        let old = bridge.mint("s1");
        let new = bridge.mint("s1");

        let refused = call(&bridge, &old, "tools/list", Value::Null);
        assert_eq!(refused, json!({ "error": "Bad token" }));
        assert_eq!(call(&bridge, &new, "tools/list", Value::Null)["result"]["session"], "s1");
    }

    #[test]
    fn a_revoked_token_is_refused_while_other_sessions_keep_theirs() {
        let (_dir, bridge) = started(Arc::new(Echo));
        let gone = bridge.mint("s1");
        let kept = bridge.mint("s2");

        bridge.revoke("s1");
        bridge.revoke("never-minted");

        let refused = call(&bridge, &gone, "tools/list", Value::Null);
        assert_eq!(refused, json!({ "error": "Bad token" }));
        assert_eq!(call(&bridge, &kept, "tools/list", Value::Null)["result"]["session"], "s2");
    }

    #[test]
    fn an_unknown_token_is_refused_before_the_handler_runs() {
        let witness = Arc::new(Witness::default());
        let (_dir, bridge) = started(witness.clone());
        bridge.mint("s1");

        let reply = call(&bridge, "not-a-token-anybody-minted", "tools/list", Value::Null);

        assert_eq!(reply, json!({ "error": "Bad token" }));
        assert!(witness.reached.lock().unwrap().is_empty());
        let token = bridge.mint("s2");
        call(&bridge, &token, "tools/list", Value::Null);
        assert_eq!(*witness.reached.lock().unwrap(), ["s2"]);
    }

    #[test]
    fn a_frame_that_is_not_a_request_is_a_bad_request() {
        let witness = Arc::new(Witness::default());
        let (_dir, bridge) = started(witness.clone());
        let token = bridge.mint("s1");

        for frame in [
            "not json\n".to_string(),
            format!("{}\n", json!({ "method": "tools/list" })),
            format!("{}\n", json!({ "token": token })),
        ] {
            let reply = reply_to(&bridge, &frame);
            let error = reply["error"].as_str().unwrap_or_default();
            assert!(error.starts_with("Bad request: "), "{frame:?} got {reply}");
        }
        assert!(witness.reached.lock().unwrap().is_empty());
        call(&bridge, &token, "tools/list", Value::Null);
        assert_eq!(*witness.reached.lock().unwrap(), ["s1"]);
    }

    #[test]
    fn a_caller_that_hangs_up_without_a_frame_gets_a_bad_request() {
        let (_dir, bridge) = started(Arc::new(Echo));
        let mut stream = UnixStream::connect(&bridge.shared.socket_path).expect("connect");
        stream.set_read_timeout(Some(WITHIN)).expect("read timeout");
        stream.shutdown(std::net::Shutdown::Write).expect("hang up");

        let mut reply = String::new();
        stream.read_to_string(&mut reply).expect("reply in time");

        assert!(reply.contains("Bad request"), "{reply:?}");
    }

    #[test]
    fn a_frame_that_is_not_utf8_is_dropped_without_a_reply() {
        let (_dir, bridge) = started(Arc::new(Echo));
        assert_eq!(exchange(&bridge, b"\xff\xfe\n"), "");
    }

    #[test]
    fn params_left_out_reach_the_handler_as_null() {
        let (_dir, bridge) = started(Arc::new(Echo));
        let token = bridge.mint("s1");
        let frame = format!("{}\n", json!({ "token": token, "method": "tools/list" }));

        let reply = reply_to(&bridge, &frame);

        assert_eq!(reply["result"]["params"], Value::Null);
        assert_eq!(reply["result"]["method"], "tools/list");
    }

    #[test]
    fn a_handler_error_comes_back_as_the_error() {
        let (_dir, bridge) = started(Arc::new(Echo));
        let token = bridge.mint("s1");
        let reply = call(&bridge, &token, "fail", Value::Null);
        assert_eq!(reply, json!({ "error": "s1 may not fail" }));
    }

    #[test]
    fn calls_before_a_handler_is_set_are_refused() {
        let dir = temp_dir();
        let bridge = Bridge::start(dir.path().to_path_buf()).expect("bridge");
        let token = bridge.mint("s1");
        assert_eq!(
            call(&bridge, &token, "tools/list", Value::Null),
            json!({ "error": "Tool handler is not set" })
        );
    }

    /// Holds a `wait` call inside the handler until a `release` call arrives,
    /// so a bridge that served one caller at a time would never get to the
    /// release.
    struct Gate {
        entered: Mutex<mpsc::Sender<()>>,
        release: Mutex<mpsc::Sender<()>>,
        released: Mutex<mpsc::Receiver<()>>,
    }

    impl ToolHost for Gate {
        fn handle(&self, session_id: &str, method: &str, _params: Value) -> Result<Value, String> {
            if method == "wait" {
                let released = self.released.lock().unwrap();
                self.entered.lock().unwrap().send(()).expect("entered");
                released.recv_timeout(WITHIN).map_err(|_| "never released".to_string())?;
            } else {
                self.release.lock().unwrap().send(()).expect("release");
            }
            Ok(json!(session_id))
        }
    }

    #[test]
    fn concurrent_callers_are_served_independently() {
        let (entered_tx, entered) = mpsc::channel();
        let (release, released) = mpsc::channel();
        let (_dir, bridge) = started(Arc::new(Gate {
            entered: Mutex::new(entered_tx),
            release: Mutex::new(release),
            released: Mutex::new(released),
        }));
        let waiter_token = bridge.mint("waiter");
        let releaser_token = bridge.mint("releaser");

        let waiter = thread::spawn({
            let bridge = bridge.clone();
            move || call(&bridge, &waiter_token, "wait", Value::Null)
        });
        entered.recv_timeout(WITHIN).expect("the waiter reached the handler");

        assert_eq!(
            call(&bridge, &releaser_token, "release", Value::Null),
            json!({ "result": "releaser" })
        );
        assert_eq!(waiter.join().expect("waiter"), json!({ "result": "waiter" }));
    }

    #[test]
    fn the_socket_replaces_a_stale_one_and_only_its_owner_may_use_it() {
        let dir = temp_dir();
        let stale = dir.path().join("crew.sock");
        std::fs::write(&stale, "left over").expect("stale file");

        let bridge = Bridge::start(dir.path().to_path_buf()).expect("bridge");
        bridge.set_handler(Arc::new(Echo));

        let mode = std::fs::metadata(&stale).expect("socket").permissions().mode();
        assert_eq!(mode & 0o777, 0o600);
        let token = bridge.mint("s1");
        assert_eq!(call(&bridge, &token, "tools/list", Value::Null)["result"]["session"], "s1");
    }

    #[test]
    fn info_names_the_socket_and_the_running_executable() {
        let dir = temp_dir();
        let bridge = Bridge::start(dir.path().to_path_buf()).expect("bridge");

        let info = bridge.info().expect("info");

        assert_eq!(info.socket_path, dir.path().join("crew.sock").to_string_lossy());
        assert_eq!(info.exe, std::env::current_exe().unwrap().to_string_lossy());
    }

    #[test]
    fn shutdown_takes_the_socket_away() {
        let dir = temp_dir();
        let bridge = Bridge::start(dir.path().to_path_buf()).expect("bridge");

        bridge.shutdown();

        assert!(!dir.path().join("crew.sock").exists());
        assert!(UnixStream::connect(dir.path().join("crew.sock")).is_err());
    }

    #[test]
    fn start_fails_where_the_directory_cannot_be_made() {
        let dir = temp_dir();
        let file = dir.path().join("file");
        std::fs::write(&file, "").expect("file");

        assert!(Bridge::start(file.join("sub")).is_err());
    }

    #[test]
    fn start_fails_where_the_socket_path_does_not_fit() {
        let dir = temp_dir();
        let deep = dir.path().join("d".repeat(120));

        assert!(Bridge::start(deep).is_err());
    }
}
