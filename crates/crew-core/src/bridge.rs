use std::collections::HashMap;
use std::io::{BufRead, BufReader, Write};
use std::os::unix::fs::PermissionsExt;
use std::os::unix::net::{UnixListener, UnixStream};
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::thread;

use serde::Deserialize;
use serde_json::{json, Value};

use crate::caller::Caller;

/// There is no `session_id` here on purpose. It used to arrive on the wire and
/// be believed, which made the caller whoever the caller said it was: an
/// agent's own shell inherits the socket and could name anybody. The token is
/// the identity now — it says who is calling, and nothing else does.
///
/// `workspace` is read for the user's token alone, which belongs to no
/// workspace: an id, or a path inside one. A session's workspace is its own
/// and one named on the wire is ignored, like the session id was.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Request {
    token: String,
    method: String,
    #[serde(default)]
    params: Value,
    #[serde(default)]
    workspace: Option<String>,
}

#[derive(serde::Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct BridgeInfo {
    pub socket_path: String,
    pub exe: String,
}

/// Who a token speaks for, before the store says what that is now: a session
/// is re-read on every call, so a rename or a new autonomy applies at once.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Bearer {
    Session(String),
    User,
}

pub trait ToolHost: Send + Sync {
    /// The caller behind a bearer, with the workspace a user's call named.
    fn resolve(&self, bearer: &Bearer, workspace: Option<&str>) -> Result<Caller, String>;
    fn handle(&self, caller: &Caller, method: &str, params: Value) -> Result<Value, String>;
}

/// A token's lifetime is its process's, and the two kinds of process end
/// differently: an agent's turn is replaced by the next turn, a terminal's
/// process by nothing.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Lease {
    /// One per session, replaced when the next turn starts.
    Turn,
    /// One per process, handed back when that process exits. A session can
    /// have more than one: a respawn starts the new process before the old
    /// one's exit is reaped.
    Process,
    /// The user's, for as long as the daemon runs.
    User,
}

struct Grant {
    bearer: Bearer,
    lease: Lease,
}

struct Shared {
    handler: Mutex<Option<Arc<dyn ToolHost>>>,
    socket_path: PathBuf,
    tokens: Mutex<HashMap<String, Grant>>,
    user_token: String,
}

/// Relays `crew --mcp` / `crew call` into the daemon tool host.
#[derive(Clone)]
pub struct Bridge {
    shared: Arc<Shared>,
}

/// Why a bridge did not start.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum StartError {
    /// A daemon already answers on this data dir's socket. Taking the socket
    /// over would cut every session and CLI off from it while it goes on
    /// running, so the newcomer stops instead.
    Taken(PathBuf),
    Failed(String),
}

impl std::fmt::Display for StartError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            StartError::Taken(socket) => write!(
                f,
                "another crewd is already running for this data dir: it answers on {}. Leaving it be.",
                socket.display()
            ),
            StartError::Failed(message) => f.write_str(message),
        }
    }
}

impl From<StartError> for String {
    fn from(error: StartError) -> Self {
        error.to_string()
    }
}

impl Bridge {
    pub fn start(dir: PathBuf) -> Result<Self, StartError> {
        let failed = |e: std::io::Error| StartError::Failed(e.to_string());
        std::fs::create_dir_all(&dir).map_err(failed)?;
        let socket_path = dir.join("crew.sock");
        // Only a socket nobody answers on is left over from a daemon that
        // died, and only that one is ours to replace.
        if UnixStream::connect(&socket_path).is_ok() {
            return Err(StartError::Taken(socket_path));
        }
        let _ = std::fs::remove_file(&socket_path);
        let listener = UnixListener::bind(&socket_path).map_err(failed)?;
        std::fs::set_permissions(&socket_path, std::fs::Permissions::from_mode(0o600)).map_err(failed)?;

        let user_token = uuid::Uuid::new_v4().to_string();
        let tokens = HashMap::from([(user_token.clone(), Grant { bearer: Bearer::User, lease: Lease::User })]);
        let bridge = Self {
            shared: Arc::new(Shared {
                handler: Mutex::new(None),
                socket_path,
                tokens: Mutex::new(tokens),
                user_token,
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

    fn tokens(&self) -> std::sync::MutexGuard<'_, HashMap<String, Grant>> {
        self.shared.tokens.lock().unwrap_or_else(|e| e.into_inner())
    }

    /// A fresh token for one session's turn, and the end of the turn token it
    /// held before.
    ///
    /// Minted per turn, because a turn is one process: when that process dies
    /// its token is worth having only until the next one starts. Cursor has no
    /// MCP and reaches the bridge through `crew call` in its shell, so the
    /// token is what stops that shell from speaking as anybody else.
    pub fn mint(&self, session_id: &str) -> String {
        let token = uuid::Uuid::new_v4().to_string();
        let mut tokens = self.tokens();
        tokens.retain(|_, grant| {
            !(grant.lease == Lease::Turn && grant.bearer == Bearer::Session(session_id.to_string()))
        });
        tokens.insert(token.clone(), Grant { bearer: Bearer::Session(session_id.to_string()), lease: Lease::Turn });
        token
    }

    /// A token for one process of a terminal session, that lives until
    /// [`Bridge::revoke_token`] hands it back. It replaces nothing: the process
    /// a respawn replaces may still be exiting, and its exit must take only
    /// its own token with it.
    pub fn mint_process(&self, session_id: &str) -> String {
        let token = uuid::Uuid::new_v4().to_string();
        self.tokens().insert(
            token.clone(),
            Grant { bearer: Bearer::Session(session_id.to_string()), lease: Lease::Process },
        );
        token
    }

    /// Hand one token back, for a process that has exited. The user's token
    /// is not handed back this way; it goes with the daemon.
    pub fn revoke_token(&self, token: &str) {
        let mut tokens = self.tokens();
        if tokens.get(token).is_some_and(|grant| grant.lease != Lease::User) {
            tokens.remove(token);
        }
    }

    /// Hand back every token a session holds, for a session that is gone.
    pub fn revoke(&self, session_id: &str) {
        let bearer = Bearer::Session(session_id.to_string());
        self.tokens().retain(|_, grant| grant.bearer != bearer);
    }

    /// The token that speaks as the user. It goes into `daemon.json` (0600)
    /// and nowhere else: no process Crew starts is handed it. That keeps it
    /// from other users, not from sessions. Every process Crew starts runs as
    /// the same UID and can read the file, and with it this token and the
    /// WebSocket token, which is the window's. That a session speaks as
    /// itself is the policy of the tools it is given (`crew` refuses to read
    /// the file for one), not something this token enforces.
    pub fn user_token(&self) -> String {
        self.shared.user_token.clone()
    }

    pub fn socket_path(&self) -> String {
        self.shared.socket_path.to_string_lossy().into_owned()
    }

    fn whose(&self, token: &str) -> Option<Bearer> {
        self.tokens().get(token).map(|grant| grant.bearer.clone())
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
    let Some(bearer) = bridge.whose(&request.token) else {
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
    let workspace = match bearer {
        Bearer::User => request.workspace.as_deref(),
        Bearer::Session(_) => None,
    };
    let body = match handler
        .resolve(&bearer, workspace)
        .and_then(|caller| handler.handle(&caller, &request.method, request.params))
    {
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

    fn short_dir() -> PathBuf {
        // Short: the socket path has to fit in SUN_LEN.
        std::env::temp_dir().join(format!("cb-{}", &uuid::Uuid::new_v4().to_string()[..8]))
    }

    fn bridge() -> Bridge {
        Bridge::start(short_dir()).expect("bridge")
    }

    /// It used to unlink the socket and bind its own, leaving the live
    /// daemon running where nobody could reach it.
    #[test]
    fn a_second_bridge_leaves_a_live_ones_socket_alone() {
        let dir = short_dir();
        let first = Bridge::start(dir.clone()).expect("first");
        let socket = dir.join("crew.sock");
        assert_eq!(Bridge::start(dir.clone()).err(), Some(StartError::Taken(socket.clone())));
        assert!(UnixStream::connect(&socket).is_ok(), "the first bridge lost its socket");
        drop(first);
    }

    #[test]
    fn a_socket_nobody_answers_on_is_replaced() {
        let dir = short_dir();
        std::fs::create_dir_all(&dir).expect("dir");
        let socket = dir.join("crew.sock");
        // What a daemon that died leaves behind: the file, and no listener.
        drop(UnixListener::bind(&socket).expect("bind"));
        assert!(socket.exists());
        let bridge = Bridge::start(dir).expect("replaced");
        assert!(UnixStream::connect(&socket).is_ok());
        bridge.shutdown();
    }

    fn session(id: &str) -> Option<Bearer> {
        Some(Bearer::Session(id.to_string()))
    }

    #[test]
    fn a_new_turn_retires_the_last_turns_token() {
        let bridge = bridge();
        let first = bridge.mint("a");
        let second = bridge.mint("a");
        assert_eq!(bridge.whose(&first), None);
        assert_eq!(bridge.whose(&second), session("a"));
    }

    /// The respawn case: the new process is running before the old one's
    /// exit is reaped, and that late exit must take only its own token.
    #[test]
    fn a_late_exit_hands_back_its_own_token_and_no_other() {
        let bridge = bridge();
        let old = bridge.mint_process("t");
        let new = bridge.mint_process("t");
        bridge.revoke_token(&old);
        assert_eq!(bridge.whose(&old), None);
        assert_eq!(bridge.whose(&new), session("t"));
    }

    #[test]
    fn a_turn_does_not_retire_a_process_token() {
        let bridge = bridge();
        let process = bridge.mint_process("s");
        bridge.mint("s");
        assert_eq!(bridge.whose(&process), session("s"));
    }

    #[test]
    fn a_deleted_session_loses_every_token_it_held() {
        let bridge = bridge();
        let turn = bridge.mint("s");
        let one = bridge.mint_process("s");
        let two = bridge.mint_process("s");
        let other = bridge.mint_process("x");
        bridge.revoke("s");
        for token in [&turn, &one, &two] {
            assert_eq!(bridge.whose(token), None);
        }
        assert_eq!(bridge.whose(&other), session("x"));
    }

    #[test]
    fn the_user_token_speaks_as_the_user_and_is_not_handed_back() {
        let bridge = bridge();
        let user = bridge.user_token();
        assert_eq!(bridge.whose(&user), Some(Bearer::User));
        bridge.revoke_token(&user);
        bridge.revoke("anyone");
        assert_eq!(bridge.whose(&user), Some(Bearer::User));
    }
}
