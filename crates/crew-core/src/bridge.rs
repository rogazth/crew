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
///
/// `opencode_session` is the one id that is believed, and only from the
/// opencode host token, for a session Crew bound on that token's server run:
/// opencode's one server cannot hand each session its own token, so it says
/// which session is calling, and the bridge checks that against what Crew
/// bound. Sent with any other token it is ignored; the token is the identity.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Request {
    token: String,
    method: String,
    #[serde(default)]
    params: Value,
    #[serde(default)]
    workspace: Option<String>,
    #[serde(default)]
    opencode_session: Option<String>,
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
    /// One run of opencode's shared server, by its run id. It speaks for no
    /// session: the bridge answers it the list of tools and the calls of
    /// sessions Crew bound to that run, and never resolves it to a caller.
    OpencodeHost(String),
}

pub trait ToolHost: Send + Sync {
    /// The caller behind a bearer, with the workspace a user's call named.
    fn resolve(&self, bearer: &Bearer, workspace: Option<&str>) -> Result<Caller, String>;
    fn handle(&self, caller: &Caller, method: &str, params: Value) -> Result<Value, String>;
    /// A call that came through opencode's shared server. `caller` is `None`
    /// for the host token alone, which is only ever sent a method that needs
    /// no one in particular (the tool list).
    fn handle_opencode(&self, caller: Option<&Caller>, method: &str, params: Value) -> Result<Value, String>;
}

/// A token's lifetime is its process's.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Lease {
    /// One per session, replaced when the next turn starts.
    Turn,
    /// The user's, for as long as the daemon runs.
    User,
    /// One opencode server run's, until [`OpencodeHost::end_run`].
    Host,
    /// One opencode session's, for its shell: until
    /// [`OpencodeHost::unbind`] or the end of the run.
    Bound,
}

struct Grant {
    bearer: Bearer,
    lease: Lease,
}

struct Shared {
    handler: Mutex<Option<Arc<dyn ToolHost>>>,
    socket_path: PathBuf,
    tokens: Mutex<HashMap<String, Grant>>,
    /// Always taken before `tokens`, wherever both are.
    runs: Mutex<HashMap<String, Run>>,
    user_token: String,
}

/// One run of `opencode serve` and the sessions Crew bound on it.
struct Run {
    host_token: String,
    /// By opencode session id.
    bound: HashMap<String, Binding>,
}

struct Binding {
    session_id: String,
    /// The `CREW_TOKEN` of that session's shell.
    token: String,
}

/// Relays `crew mcp` and the `crew` commands into the daemon tool host.
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
                runs: Mutex::new(HashMap::new()),
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

    /// A fresh token for one session's process, and the end of the turn token
    /// it held before.
    ///
    /// Minted when the process is spawned, and never again while it lives: a
    /// process a driver keeps across turns holds the token in its environment
    /// (and in its MCP server's), so a later mint would cut it off. When that
    /// process dies its token is worth having only until the next one starts.
    /// Cursor has no MCP and reaches the bridge through `crew` in its shell,
    /// so the token is what stops that shell from speaking as anybody else.
    pub fn mint(&self, session_id: &str) -> String {
        let token = uuid::Uuid::new_v4().to_string();
        let mut tokens = self.tokens();
        tokens.retain(|_, grant| {
            !(grant.lease == Lease::Turn && grant.bearer == Bearer::Session(session_id.to_string()))
        });
        tokens.insert(token.clone(), Grant { bearer: Bearer::Session(session_id.to_string()), lease: Lease::Turn });
        token
    }

    /// Hand back every token a session holds, and every opencode binding it
    /// has, for a session that is gone.
    pub fn revoke(&self, session_id: &str) {
        let mut runs = self.runs();
        for run in runs.values_mut() {
            run.bound.retain(|_, binding| binding.session_id != session_id);
        }
        let bearer = Bearer::Session(session_id.to_string());
        self.tokens().retain(|_, grant| grant.bearer != bearer);
    }

    fn runs(&self) -> std::sync::MutexGuard<'_, HashMap<String, Run>> {
        self.shared.runs.lock().unwrap_or_else(|e| e.into_inner())
    }

    /// The way opencode's shared server gets its identities: see
    /// [`OpencodeHost`].
    pub fn opencode(&self) -> OpencodeHost {
        OpencodeHost { bridge: self.clone() }
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

    pub(crate) fn whose(&self, token: &str) -> Option<Bearer> {
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

/// One `opencode serve` run's standing with the bridge.
///
/// opencode 2.x runs one server for the whole daemon, with an MCP server
/// configured per folder and not per session, so a session cannot be handed
/// its own `CREW_TOKEN` through the process it runs in. The server gets a host
/// token instead, which by itself may list tools and nothing else, and opencode
/// names the calling session on every tool call. The bridge believes that name
/// only for an id Crew bound on that run, and then answers as the Crew session
/// it was bound to. The driver is the only one that binds, when it creates or
/// takes up an opencode session; nothing opencode says can add a binding.
///
/// Each binding also has a token of its own, for the `crew` commands in that
/// session's shell (set through opencode's `PUT /session/:id/environment`): the
/// host token must not be in that environment, or the shell could name any
/// bound session. Give the host token to the MCP server alone.
#[derive(Clone)]
pub struct OpencodeHost {
    bridge: Bridge,
}

/// What a started run hands the driver.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct OpencodeRun {
    pub run_id: String,
    /// For the server's MCP server (`CREW_TOKEN` there); it grants no tool call
    /// by itself.
    pub host_token: String,
}

impl OpencodeHost {
    /// A new server run, with the token its MCP server will call with.
    pub fn start_run(&self) -> OpencodeRun {
        let run_id = uuid::Uuid::new_v4().to_string();
        let host_token = uuid::Uuid::new_v4().to_string();
        let mut runs = self.bridge.runs();
        self.bridge
            .tokens()
            .insert(host_token.clone(), Grant { bearer: Bearer::OpencodeHost(run_id.clone()), lease: Lease::Host });
        runs.insert(run_id.clone(), Run { host_token: host_token.clone(), bound: HashMap::new() });
        OpencodeRun { run_id, host_token }
    }

    /// Say that an opencode session on this run is a Crew session, and get the
    /// token for that session's shell. Binding the same pair again replaces
    /// the token; an opencode id already bound to another Crew session is
    /// refused, since a second claim on it is a mistake or an attack and
    /// neither should win quietly.
    pub fn bind(&self, run_id: &str, opencode_id: &str, session_id: &str) -> Result<String, String> {
        if opencode_id.is_empty() || session_id.is_empty() {
            return Err("An opencode session and a Crew session are both needed to bind one to the other".into());
        }
        let mut runs = self.bridge.runs();
        let run = runs.get_mut(run_id).ok_or("That opencode server run has ended")?;
        if run.bound.get(opencode_id).is_some_and(|bound| bound.session_id != session_id) {
            return Err(format!("opencode session {opencode_id} is already bound to another Crew session"));
        }
        let token = uuid::Uuid::new_v4().to_string();
        let mut tokens = self.bridge.tokens();
        if let Some(old) = run.bound.remove(opencode_id) {
            tokens.remove(&old.token);
        }
        tokens.insert(
            token.clone(),
            Grant { bearer: Bearer::Session(session_id.to_string()), lease: Lease::Bound },
        );
        run.bound.insert(opencode_id.to_string(), Binding { session_id: session_id.to_string(), token: token.clone() });
        Ok(token)
    }

    /// End a binding and its shell token: the opencode session is gone, or no
    /// longer Crew's to speak for.
    pub fn unbind(&self, run_id: &str, opencode_id: &str) {
        let mut runs = self.bridge.runs();
        if let Some(old) = runs.get_mut(run_id).and_then(|run| run.bound.remove(opencode_id)) {
            self.bridge.tokens().remove(&old.token);
        }
    }

    /// The server stopped: its host token, every binding and every shell token
    /// go with it, so nothing a dead server's process still holds works.
    pub fn end_run(&self, run_id: &str) {
        let mut runs = self.bridge.runs();
        if let Some(run) = runs.remove(run_id) {
            let mut tokens = self.bridge.tokens();
            tokens.remove(&run.host_token);
            for binding in run.bound.values() {
                tokens.remove(&binding.token);
            }
        }
    }

    /// The Crew session an opencode session was bound to on this run, if it
    /// was: an id never bound, or bound on another run, is nobody.
    pub fn session_for(&self, run_id: &str, opencode_id: &str) -> Option<String> {
        self.bridge.runs().get(run_id)?.bound.get(opencode_id).map(|bound| bound.session_id.clone())
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
    let body = match answer(&bridge, handler.as_ref(), bearer, request) {
        Ok(result) => json!({ "result": result }),
        Err(error) => json!({ "error": error }),
    };
    reply(stream, body);
}

fn answer(bridge: &Bridge, handler: &dyn ToolHost, bearer: Bearer, request: Request) -> Result<Value, String> {
    if let Bearer::OpencodeHost(run) = &bearer {
        return answer_opencode(bridge, handler, run, request);
    }
    let workspace = match bearer {
        Bearer::User => request.workspace.as_deref(),
        Bearer::Session(_) | Bearer::OpencodeHost(_) => None,
    };
    let caller = handler.resolve(&bearer, workspace)?;
    handler.handle(&caller, &request.method, request.params)
}

/// What the host token of one opencode server run may do: list the tools, and
/// make a call that names a session Crew bound on this run, as that session.
/// Everything else, a method that acts for someone, is refused, so a host
/// token that leaks is worth no more than the list.
fn answer_opencode(bridge: &Bridge, handler: &dyn ToolHost, run: &str, request: Request) -> Result<Value, String> {
    match request.method.as_str() {
        "tools/list" | "instructions" => handler.handle_opencode(None, &request.method, request.params),
        "tools/call" => {
            let id = request.opencode_session.as_deref().filter(|id| !id.is_empty()).ok_or(
                "This call does not say which opencode session it is from, so Crew cannot tell whose it is. Calls through opencode's shared server are only answered for a session Crew started.",
            )?;
            let session = bridge.opencode().session_for(run, id).ok_or_else(|| {
                format!("opencode session {id} is not one Crew started on this server run, so Crew will not act for it.")
            })?;
            let caller = handler.resolve(&Bearer::Session(session), None)?;
            handler.handle_opencode(Some(&caller), &request.method, request.params)
        }
        other => Err(format!(
            "The opencode host token can list tools and make calls for a session Crew bound; {other} is not one of those."
        )),
    }
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
        // Bound in a process of its own: a listener bound here could be
        // inherited by a CLI another test spawns in the instant before it is
        // marked close-on-exec, and that child would keep answering on it.
        let bound = std::process::Command::new("python3")
            .args(["-c", "import socket, sys; socket.socket(socket.AF_UNIX).bind(sys.argv[1])"])
            .arg(&socket)
            .status()
            .expect("python3");
        assert!(bound.success());
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

    #[test]
    fn a_deleted_session_loses_every_token_it_held() {
        let bridge = bridge();
        let turn = bridge.mint("s");
        let other = bridge.mint("x");
        bridge.revoke("s");
        assert_eq!(bridge.whose(&turn), None);
        assert_eq!(bridge.whose(&other), session("x"));
    }

    #[test]
    fn the_user_token_speaks_as_the_user_and_is_not_handed_back() {
        let bridge = bridge();
        let user = bridge.user_token();
        assert_eq!(bridge.whose(&user), Some(Bearer::User));
        bridge.revoke("anyone");
        assert_eq!(bridge.whose(&user), Some(Bearer::User));
    }

    #[test]
    fn a_run_has_a_host_token_that_is_not_a_session() {
        let bridge = bridge();
        let host = bridge.opencode();
        let run = host.start_run();
        assert_eq!(bridge.whose(&run.host_token), Some(Bearer::OpencodeHost(run.run_id.clone())));
        // Two runs are two identities: a restarted server is not the old one.
        let next = host.start_run();
        assert_ne!(next.run_id, run.run_id);
        assert_ne!(next.host_token, run.host_token);
        // Nothing but the end of the run hands it back.
        bridge.revoke("anyone");
        assert_eq!(bridge.whose(&run.host_token), Some(Bearer::OpencodeHost(run.run_id)));
    }

    #[test]
    fn a_binding_has_a_shell_token_that_is_retired_with_it() {
        let bridge = bridge();
        let host = bridge.opencode();
        let run = host.start_run();
        let token = host.bind(&run.run_id, "ses_1", "crew-a").expect("bind");
        assert_eq!(bridge.whose(&token), session("crew-a"));
        assert_eq!(host.session_for(&run.run_id, "ses_1"), Some("crew-a".into()));
        // A turn's token for the same session neither replaces it nor is replaced by it.
        let turn = bridge.mint("crew-a");
        assert_eq!(bridge.whose(&token), session("crew-a"));
        host.unbind(&run.run_id, "ses_1");
        assert_eq!(bridge.whose(&token), None);
        assert_eq!(host.session_for(&run.run_id, "ses_1"), None);
        assert_eq!(bridge.whose(&turn), session("crew-a"));
        // The host token outlives one binding.
        assert!(bridge.whose(&run.host_token).is_some());
    }

    #[test]
    fn ending_a_run_retires_its_host_token_its_bindings_and_their_tokens() {
        let bridge = bridge();
        let host = bridge.opencode();
        let run = host.start_run();
        let other = host.start_run();
        let one = host.bind(&run.run_id, "ses_1", "a").expect("bind");
        let two = host.bind(&run.run_id, "ses_2", "b").expect("bind");
        let kept = host.bind(&other.run_id, "ses_1", "a").expect("bind");
        host.end_run(&run.run_id);
        for token in [&run.host_token, &one, &two] {
            assert_eq!(bridge.whose(token), None);
        }
        assert_eq!(host.session_for(&run.run_id, "ses_1"), None);
        assert!(host.bind(&run.run_id, "ses_3", "a").is_err(), "a run that has ended takes no bindings");
        // The other run is untouched, and so is the same opencode id on it.
        assert_eq!(bridge.whose(&kept), session("a"));
        assert_eq!(host.session_for(&other.run_id, "ses_1"), Some("a".into()));
    }

    #[test]
    fn an_opencode_session_cannot_be_claimed_by_a_second_crew_session() {
        let bridge = bridge();
        let host = bridge.opencode();
        let run = host.start_run();
        let first = host.bind(&run.run_id, "ses_1", "a").expect("bind");
        let error = host.bind(&run.run_id, "ses_1", "b").unwrap_err();
        assert!(error.contains("already bound to another Crew session"), "{error}");
        assert_eq!(host.session_for(&run.run_id, "ses_1"), Some("a".into()));
        assert_eq!(bridge.whose(&first), session("a"));
        // The same pair again is a new shell token for it, and the old one stops.
        let second = host.bind(&run.run_id, "ses_1", "a").expect("rebind");
        assert_ne!(first, second);
        assert_eq!(bridge.whose(&first), None);
        assert_eq!(bridge.whose(&second), session("a"));
        assert!(host.bind(&run.run_id, "", "a").is_err() && host.bind(&run.run_id, "ses_2", "").is_err());
    }

    #[test]
    fn a_deleted_session_loses_its_opencode_bindings_too() {
        let bridge = bridge();
        let host = bridge.opencode();
        let run = host.start_run();
        let token = host.bind(&run.run_id, "ses_1", "gone").expect("bind");
        host.bind(&run.run_id, "ses_2", "kept").expect("bind");
        bridge.revoke("gone");
        assert_eq!(bridge.whose(&token), None);
        assert_eq!(host.session_for(&run.run_id, "ses_1"), None);
        assert_eq!(host.session_for(&run.run_id, "ses_2"), Some("kept".into()));
    }

    // -- Through the socket, with the daemon's own tool dispatch ----------

    /// Answers like the daemon: the store says who a bearer is, and the real
    /// dispatch runs the tools it is handed.
    struct Daemon {
        store: crate::store::Store,
        transcripts: crate::transcript::TranscriptHub,
        toolbox: crate::tools::Toolbox,
    }

    impl Daemon {
        fn with_host<R>(&self, run: impl FnOnce(&crate::tools::Host<'_>) -> R) -> R {
            run(&crate::tools::Host {
                store: &self.store,
                transcripts: &self.transcripts,
                on_created: &|_| {},
                on_routines: &|| {},
                toolbox: &self.toolbox,
            })
        }
    }

    impl ToolHost for Daemon {
        fn resolve(&self, bearer: &Bearer, workspace: Option<&str>) -> Result<Caller, String> {
            Caller::resolve(&self.store, bearer, workspace)
        }

        fn handle(&self, caller: &Caller, method: &str, params: Value) -> Result<Value, String> {
            self.with_host(|host| crate::tools::handle(host, caller, method, params))
        }

        fn handle_opencode(&self, caller: Option<&Caller>, method: &str, params: Value) -> Result<Value, String> {
            self.with_host(|host| crate::tools::handle_opencode(host, caller, method, params))
        }
    }

    /// A tool every kind may call, that says who it took the caller for.
    struct WhoAmI;

    impl crate::tools::ToolFamily for WhoAmI {
        fn catalog(&self) -> Vec<crate::tools::Tool> {
            vec![crate::tools::Tool {
                name: "who_am_i",
                description: "Say who is calling.",
                schema: json!({ "type": "object", "properties": {} }),
                cli: vec![],
                audience: crate::tools::Audience::EVERYONE,
            }]
        }

        fn run(&self, caller: &Caller, _: &str, _: &Value) -> Result<crate::tools::ToolOutput, String> {
            Ok(json!(caller.label()).into())
        }
    }

    struct Rig {
        bridge: Bridge,
        workspace: String,
        store: crate::store::Store,
    }

    fn rig() -> Rig {
        let dir = std::env::temp_dir().join(format!("crew-bridge-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).expect("dir");
        let store = crate::store::Store::open(dir.join("crew.sqlite3")).expect("store");
        let workspace = crate::workspace::create(&store, "w".into(), dir.to_string_lossy().into()).expect("ws").id;
        let toolbox = crate::tools::Toolbox::default();
        toolbox.register(Arc::new(crate::tools::CatalogOnly(crate::session_tools::catalog)));
        toolbox.register(Arc::new(WhoAmI));
        let bridge = bridge();
        bridge.set_handler(Arc::new(Daemon {
            transcripts: crate::transcript::TranscriptHub::new(store.clone()),
            store: store.clone(),
            toolbox,
        }));
        Rig { bridge, workspace, store }
    }

    impl Rig {
        fn bot(&self, name: &str) -> String {
            self.session("bot", name)
        }

        fn child(&self, name: &str) -> String {
            crate::session::create_child(
                &self.store,
                self.workspace.clone(),
                name.into(),
                "opencode".into(),
                "".into(),
                "ask".into(),
                None,
                None,
            )
            .expect("child")
            .id
        }

        fn session(&self, kind: &str, name: &str) -> String {
            crate::session::create(
                &self.store,
                self.workspace.clone(),
                kind.into(),
                name.into(),
                "opencode".into(),
                "".into(),
                "".into(),
                "ask".into(),
            )
            .expect("session")
            .id
        }

        /// One request, as `crewd --mcp` sends it.
        fn ask(&self, token: &str, method: &str, params: Value, opencode_session: Option<&str>) -> Value {
            let mut request = json!({ "token": token, "method": method, "params": params });
            if let Some(id) = opencode_session {
                request["opencodeSession"] = json!(id);
            }
            let mut stream = UnixStream::connect(self.bridge.socket_path()).expect("connect");
            stream.write_all(format!("{request}\n").as_bytes()).expect("write");
            let mut line = String::new();
            BufReader::new(stream).read_line(&mut line).expect("read");
            serde_json::from_str(&line).expect("json")
        }

        fn call(&self, token: &str, tool: &str, opencode_session: Option<&str>) -> Value {
            self.ask(token, "tools/call", json!({ "name": tool, "arguments": {} }), opencode_session)
        }
    }

    fn said(reply: &Value) -> String {
        reply["error"]
            .as_str()
            .or_else(|| reply["result"]["content"][0]["text"].as_str())
            .unwrap_or_default()
            .to_string()
    }

    #[test]
    fn the_host_token_alone_cannot_call_any_tool() {
        let rig = rig();
        let run = rig.bridge.opencode().start_run();
        let bot = rig.bot("Coder");
        rig.bridge.opencode().bind(&run.run_id, "ses_1", &bot).expect("bind");

        let anonymous = rig.call(&run.host_token, "who_am_i", None);
        assert!(said(&anonymous).contains("does not say which opencode session"), "{anonymous}");
        let empty = rig.call(&run.host_token, "who_am_i", Some(""));
        assert!(said(&empty).contains("does not say which opencode session"), "{empty}");
        // Nor can it act for anyone in any other way.
        for method in ["whoami", "tools/catalog", "daemon/shutdown"] {
            let reply = rig.ask(&run.host_token, method, json!({}), Some("ses_1"));
            assert!(said(&reply).contains("can list tools and make calls"), "{method}: {reply}");
        }
    }

    #[test]
    fn the_host_token_lists_what_any_kind_may_call() {
        let rig = rig();
        let run = rig.bridge.opencode().start_run();
        let reply = rig.ask(&run.host_token, "tools/list", json!({}), None);
        let listed: Vec<&str> = reply["result"]["tools"]
            .as_array()
            .expect("tools")
            .iter()
            .filter_map(|tool| tool["name"].as_str())
            .collect();
        // A parent's tool and a bot's own are both in it.
        for name in ["start_session", "update_description", "who_am_i", "send_message"] {
            assert!(listed.contains(&name), "{name} missing from {listed:?}");
        }
        let told = rig.ask(&run.host_token, "instructions", Value::Null, None);
        assert!(told["result"]["instructions"].as_str().is_some_and(|text| text.contains("refused saying so")), "{told}");
    }

    #[test]
    fn an_unknown_or_foreign_session_id_is_refused() {
        let rig = rig();
        let host = rig.bridge.opencode();
        let ours = host.start_run();
        let theirs = host.start_run();
        let bot = rig.bot("Coder");
        host.bind(&ours.run_id, "ses_ours", &bot).expect("bind");
        host.bind(&theirs.run_id, "ses_theirs", &bot).expect("bind");

        let unknown = rig.call(&ours.host_token, "who_am_i", Some("ses_made_up"));
        assert!(said(&unknown).contains("not one Crew started on this server run"), "{unknown}");
        // Bound, but on another server run: not this token's to name.
        let foreign = rig.call(&ours.host_token, "who_am_i", Some("ses_theirs"));
        assert!(said(&foreign).contains("not one Crew started on this server run"), "{foreign}");
        // A Crew session id is not an opencode session id.
        let crew_id = rig.call(&ours.host_token, "who_am_i", Some(&bot));
        assert!(said(&crew_id).contains("not one Crew started"), "{crew_id}");
        let fine = rig.call(&ours.host_token, "who_am_i", Some("ses_ours"));
        assert!(fine.get("error").is_none(), "{fine}");
    }

    #[test]
    fn a_bound_id_acts_as_that_session_and_is_held_to_its_kind() {
        let rig = rig();
        let host = rig.bridge.opencode();
        let run = host.start_run();
        let bot = rig.bot("Coder");
        let kid = rig.child("Kid");
        host.bind(&run.run_id, "ses_bot", &bot).expect("bind");
        host.bind(&run.run_id, "ses_kid", &kid).expect("bind");

        let who = |id: &str| said(&rig.call(&run.host_token, "who_am_i", Some(id)));
        assert_eq!(who("ses_bot"), format!("Coder (bot {bot})"));
        assert_eq!(who("ses_kid"), format!("Kid (session {kid})"));

        // A bot may read a session (the stand-in family says "not here"); a
        // child may not, and is told so before the tool is asked.
        let bot_start = said(&rig.call(&run.host_token, "read_session", Some("ses_bot")));
        assert!(bot_start.starts_with("not here"), "{bot_start}");
        let kid_start = said(&rig.call(&run.host_token, "read_session", Some("ses_kid")));
        assert_eq!(kid_start, "This session cannot use read_session: it is not offered to a child session.");
    }

    #[test]
    fn a_session_deleted_after_binding_is_not_acted_for() {
        let rig = rig();
        let host = rig.bridge.opencode();
        let run = host.start_run();
        host.bind(&run.run_id, "ses_1", "no-such-session").expect("bind");
        let reply = rig.call(&run.host_token, "who_am_i", Some("ses_1"));
        assert!(said(&reply).contains("no longer exists"), "{reply}");
    }

    #[test]
    fn ending_the_run_cuts_off_the_host_token_and_the_shell_tokens() {
        let rig = rig();
        let host = rig.bridge.opencode();
        let run = host.start_run();
        let bot = rig.bot("Coder");
        let shell = host.bind(&run.run_id, "ses_1", &bot).expect("bind");
        assert!(rig.call(&run.host_token, "who_am_i", Some("ses_1")).get("error").is_none());
        host.end_run(&run.run_id);
        for token in [&run.host_token, &shell] {
            assert_eq!(rig.ask(token, "whoami", json!({}), None)["error"], "Bad token");
        }
    }

    #[test]
    fn the_shell_token_speaks_as_its_session_on_the_cli_path_until_unbound() {
        let rig = rig();
        let host = rig.bridge.opencode();
        let run = host.start_run();
        let kid = rig.child("Kid");
        let shell = host.bind(&run.run_id, "ses_1", &kid).expect("bind");

        let whoami = rig.ask(&shell, "whoami", json!({}), None);
        assert_eq!(whoami["result"]["kind"], "child");
        assert_eq!(whoami["result"]["sessionId"], kid.as_str());
        // The same limits as its own token: no reading sessions.
        let refused = said(&rig.call(&shell, "read_session", None));
        assert!(refused.starts_with("Unknown tool \"read_session\""), "{refused}");

        host.unbind(&run.run_id, "ses_1");
        assert_eq!(rig.ask(&shell, "whoami", json!({}), None)["error"], "Bad token");
    }

    /// The id rides on every call, but only the host token is believed about it.
    #[test]
    fn an_opencode_session_id_sent_with_a_session_token_is_ignored() {
        let rig = rig();
        let host = rig.bridge.opencode();
        let run = host.start_run();
        let mine = rig.child("Mine");
        let theirs = rig.bot("Theirs");
        host.bind(&run.run_id, "ses_theirs", &theirs).expect("bind");
        let token = rig.bridge.mint(&mine);

        let who = said(&rig.call(&token, "who_am_i", Some("ses_theirs")));
        assert_eq!(who, format!("Mine (session {mine})"));
    }

    #[test]
    fn the_user_token_is_still_the_user_whatever_session_it_names() {
        let rig = rig();
        let run = rig.bridge.opencode().start_run();
        rig.bridge.opencode().bind(&run.run_id, "ses_1", &rig.bot("Coder")).expect("bind");
        let who = said(&rig.call(&rig.bridge.user_token(), "who_am_i", Some("ses_1")));
        assert_eq!(who, "the user");
    }
}
