use std::collections::{HashMap, HashSet};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{mpsc as std_mpsc, Arc, Mutex};
use std::thread;
use std::time::Duration;

use crew_core::agent::{AgentEvents, AgentHost};
use crew_core::bridge::{Bearer, Bridge, ToolHost};
use crew_core::browser_leases::{Holder, Leases};
use crew_core::browser_relay::BrowserRelay;
use crew_core::browser_tools::BrowserTools;
use crew_core::caller::Caller;
use crew_core::file_search;
use crew_core::files;
use crew_core::mailbox;
use crew_core::messages;
use crew_core::provider_session;
use crew_core::process::{ProcessEvents, ProcessHost, ProcessPatch, RunRequest};
use crew_core::process_tools::ProcessTools;
use crew_core::session_tools::SessionTools;
use crew_core::pty::{self, PtyEvents, PtyHost, SpawnOptions};
use crew_core::remote;
use crew_core::routine;
use crew_core::scheduler::Scheduler;
use crew_core::session;
use crew_core::store::{self as app_state, Store};
use crew_core::tools::{self, Toolbox};
use crew_core::transcript::TranscriptEvents;
use crew_core::turns::TurnHost;
use crew_core::workspace;
use crew_core::worktree;
use crew_protocol::{
    self as proto, Auth, DaemonInfo, Id, IdName, IdStatus, Ids, Key, KeyValue, ListProjectFiles, Name, NamePath, Names, ProviderDiscover,
    OptionalId, PathArg, PathBytes, PathContents, PtyAck, PtyAttach, PtyAttached, PtyDetach, PtyKill, PtyResize, PtySpawn, PtyWrite,
    RemoteEnv, Request, RoutineRunNow, RoutineUpsert, SessionCreate, SessionCreated, SessionId, SessionOptions, SessionUpdated, SessionUpdate, SessionsDeleted,
    SessionsRetention, TempFile,
    SearchQuery, TranscriptApply, TranscriptTail, TurnAnswer, TurnRespond,
    TurnStart, TurnStarted, WorkspaceId, WorktreeAdd, WorktreeRemove,
};
use futures_util::{SinkExt, StreamExt};
use serde::Deserialize;
use serde_json::Value;
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::{mpsc, oneshot};
use tokio_tungstenite::tungstenite::Message;

mod http;
pub mod lock;
pub mod machine;
mod sessions;
mod socks;

pub struct Config {
    pub pty: PtyHost,
    pub store: Store,
    pub agents: AgentHost,
    pub bridge: Bridge,
    /// Built on the same store and PTY host. Nothing in it starts on its own.
    pub processes: ProcessHost,
}

#[derive(Clone)]
struct Hosts {
    hub: Arc<Hub>,
    pty: PtyHost,
    processes: ProcessHost,
    store: Store,
    bridge: Bridge,
    turns: TurnHost,
    scheduler: Scheduler,
    /// Browser tabs agents drive: the leases, and the relay to Electron main.
    browser: BrowserTools,
    /// `daemon_shutdown`: the main thread stops the daemon as it would on a signal.
    exit: std_mpsc::Sender<()>,
    /// Sessions' CLIs: what their hooks say, and their histories while a chat reads them.
    sessions: sessions::SessionWatch,
    /// Sessions started with `start_session`: the tools, and the reaper of idle ones.
    children: Arc<SessionTools>,
    /// `crewd serve` only. Zero on the window's daemon.
    socks_port: u16,
}

/// Where the daemon listens and the token a client has to bring.
pub struct Listen {
    pub addr: String,
    pub token: String,
    /// Keep trying an address that is not up yet: a tailnet IP appears some
    /// time after boot, and a service should wait for it rather than die.
    pub wait_for_addr: bool,
}

impl Listen {
    /// The window's own daemon: loopback, any port, a token for this run.
    pub fn local() -> Self {
        Self {
            addr: "127.0.0.1:0".into(),
            token: random_token(),
            wait_for_addr: false,
        }
    }
}

pub struct Handle {
    pub info: DaemonInfo,
    shutdown: Mutex<Option<tokio::sync::oneshot::Sender<()>>>,
    exit_requests: Mutex<Option<std_mpsc::Receiver<()>>>,
    turns: TurnHost,
    scheduler: Scheduler,
}

impl Handle {
    pub fn url(&self) -> &str {
        &self.info.url
    }

    pub fn token(&self) -> &str {
        &self.info.token
    }

    pub fn shutdown(&self) {
        self.scheduler.stop();
        self.turns.transcripts().flush_all();
        if let Some(tx) = self.shutdown.lock().unwrap_or_else(|e| e.into_inner()).take() {
            let _ = tx.send(());
        }
    }

    /// Where `daemon_shutdown` lands, from the window or from the user's
    /// `crew`. It only asks: whoever runs the daemon stops it, in the same
    /// order as for a signal. Taken once.
    pub fn exit_requests(&self) -> Option<std_mpsc::Receiver<()>> {
        self.exit_requests.lock().unwrap_or_else(|e| e.into_inner()).take()
    }

    pub fn override_agent_binary(&self, name: &str, path: impl Into<String>) {
        self.turns.override_binary(name, path);
    }
}

/// `<data-dir>/daemon.json`: how the `crew` CLI, or anything else that did
/// not launch this daemon, finds it and speaks to it as the user.
pub fn daemon_file_path(dir: &std::path::Path) -> std::path::PathBuf {
    dir.join("daemon.json")
}

/// Written to a temporary file created 0600 and renamed over, so a reader never
/// sees half of it and the tokens are never readable by anyone else, not even
/// for the moment between a create and a chmod.
pub fn write_daemon_file(dir: &std::path::Path, file: &proto::DaemonFile) -> Result<std::path::PathBuf, String> {
    use std::io::Write as _;
    use std::os::unix::fs::OpenOptionsExt;
    let path = daemon_file_path(dir);
    let temp = dir.join(format!("daemon.json.{}", std::process::id()));
    let body = serde_json::to_vec_pretty(file).map_err(|e| e.to_string())?;
    let written = std::fs::OpenOptions::new()
        .write(true)
        .create(true)
        .truncate(true)
        .mode(0o600)
        .open(&temp)
        .and_then(|mut out| out.write_all(&body))
        .and_then(|_| std::fs::rename(&temp, &path));
    if let Err(error) = written {
        let _ = std::fs::remove_file(&temp);
        return Err(format!("{}: {error}", path.display()));
    }
    Ok(path)
}

/// Only if it is still ours: a second daemon on the same data dir may have
/// written its own since, and removing that would strand its CLI.
pub fn remove_daemon_file(dir: &std::path::Path, url: &str) {
    let path = daemon_file_path(dir);
    let ours = std::fs::read(&path)
        .ok()
        .and_then(|bytes| serde_json::from_slice::<proto::DaemonFile>(&bytes).ok())
        .is_some_and(|file| file.url == url);
    if ours {
        let _ = std::fs::remove_file(path);
    }
}

const OUT_CAP: usize = 1024;
const SEND_WAIT: Duration = Duration::from_secs(5);

enum Outgoing {
    Text(String),
    Binary(Vec<u8>),
    Pong(Vec<u8>),
}

struct Hub {
    clients: Mutex<HashMap<u64, mpsc::Sender<Outgoing>>>,
    /// The streams each client attached, and so gets the frames of. Only
    /// those: a window watching one terminal has no use for another's bytes,
    /// and ones it never asked for would be painted as if they were the start
    /// of the stream it attaches next.
    pty_attached: Mutex<HashMap<u64, HashSet<u32>>>,
    /// Clients that only hear `browser-*` events: Electron main's browser
    /// host has no use for transcripts and statuses, and would pay for them.
    quiet: Mutex<HashSet<u64>>,
    next: AtomicU64,
    runtime: Mutex<Option<tokio::runtime::Handle>>,
    /// Told when a session's terminal ends: its CLI is not there to type into any more.
    sessions: std::sync::OnceLock<sessions::SessionWatch>,
    /// Told when the last client watching a terminal goes.
    unwatch: std::sync::OnceLock<Box<dyn Fn(u32) + Send + Sync>>,
}

impl Hub {
    fn new() -> Self {
        Self {
            clients: Mutex::new(HashMap::new()),
            pty_attached: Mutex::new(HashMap::new()),
            quiet: Mutex::new(HashSet::new()),
            next: AtomicU64::new(1),
            runtime: Mutex::new(None),
            sessions: std::sync::OnceLock::new(),
            unwatch: std::sync::OnceLock::new(),
        }
    }

    fn set_runtime(&self, handle: tokio::runtime::Handle) {
        *self.runtime.lock().unwrap_or_else(|e| e.into_inner()) = Some(handle);
    }

    fn subscribe(&self) -> (u64, mpsc::Receiver<Outgoing>) {
        let (tx, rx) = mpsc::channel(OUT_CAP);
        let id = self.next.fetch_add(1, Ordering::Relaxed);
        self.clients
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .insert(id, tx);
        (id, rx)
    }

    fn watch_pty(&self, id: u64, stream_id: u32) {
        self.pty_attached
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .entry(id)
            .or_default()
            .insert(stream_id);
    }

    /// The client let go of the stream: its frames stop reaching it.
    fn unwatch_pty(&self, id: u64, stream_id: u32) {
        if let Some(streams) = self.pty_attached.lock().unwrap_or_else(|e| e.into_inner()).get_mut(&id) {
            streams.remove(&stream_id);
        }
    }

    fn unsubscribe(&self, id: u64) {
        self.clients
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .remove(&id);
        let orphaned: Vec<u32> = {
            let mut attached = self.pty_attached.lock().unwrap_or_else(|e| e.into_inner());
            let mine = attached.remove(&id).unwrap_or_default();
            mine.into_iter()
                .filter(|stream| !attached.values().any(|streams| streams.contains(stream)))
                .collect()
        };
        self.quiet.lock().unwrap_or_else(|e| e.into_inner()).remove(&id);
        if let Some(unwatch) = self.unwatch.get() {
            for stream in orphaned {
                unwatch(stream);
            }
        }
    }

    fn hush(&self, id: u64) {
        self.quiet.lock().unwrap_or_else(|e| e.into_inner()).insert(id);
    }

    /// One event to one client. False when that client is gone.
    fn send_event(&self, id: u64, event: &str, payload: Value) -> bool {
        let connected = self.clients.lock().unwrap_or_else(|e| e.into_inner()).contains_key(&id);
        if !connected {
            return false;
        }
        let Ok(event) = proto::event(event, payload) else {
            return false;
        };
        let Ok(text) = serde_json::to_string(&event) else {
            return false;
        };
        self.send(id, Outgoing::Text(text));
        true
    }

    fn send(&self, id: u64, msg: Outgoing) {
        let tx = self
            .clients
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .get(&id)
            .cloned();
        let Some(tx) = tx else {
            return;
        };
        match tx.try_send(msg) {
            Ok(()) => {}
            Err(mpsc::error::TrySendError::Closed(_)) => self.unsubscribe(id),
            Err(mpsc::error::TrySendError::Full(msg)) => {
                if !self.send_wait(&tx, msg) {
                    self.unsubscribe(id);
                }
            }
        }
    }

    fn send_wait(&self, tx: &mpsc::Sender<Outgoing>, msg: Outgoing) -> bool {
        let send = async {
            tokio::time::timeout(SEND_WAIT, tx.send(msg)).await
        };
        let result = if tokio::runtime::Handle::try_current().is_ok() {
            tokio::task::block_in_place(|| tokio::runtime::Handle::current().block_on(send))
        } else {
            let Some(handle) = self.runtime.lock().unwrap_or_else(|e| e.into_inner()).clone() else {
                return false;
            };
            handle.block_on(send)
        };
        matches!(result, Ok(Ok(())))
    }

    fn broadcast(&self, msg: Outgoing, to_quiet: bool) {
        let quiet = self.quiet.lock().unwrap_or_else(|e| e.into_inner()).clone();
        let ids: Vec<u64> = self
            .clients
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .keys()
            .copied()
            .filter(|id| to_quiet || !quiet.contains(id))
            .collect();
        for id in ids {
            self.send(
                id,
                match &msg {
                    Outgoing::Text(text) => Outgoing::Text(text.clone()),
                    Outgoing::Binary(bytes) => Outgoing::Binary(bytes.clone()),
                    Outgoing::Pong(payload) => Outgoing::Pong(payload.clone()),
                },
            );
        }
    }

    fn emit(&self, event: &str, payload: impl serde::Serialize) {
        let to_quiet = event.starts_with("browser-");
        let Ok(event) = proto::event(event, payload) else {
            return;
        };
        let Ok(text) = serde_json::to_string(&event) else {
            return;
        };
        self.broadcast(Outgoing::Text(text), to_quiet);
    }
}

impl PtyEvents for Hub {
    fn data(&self, stream_id: u32, bytes: &[u8]) {
        let mut frame = Vec::with_capacity(4 + bytes.len());
        frame.extend_from_slice(&stream_id.to_le_bytes());
        frame.extend_from_slice(bytes);
        let ids: Vec<u64> = self
            .pty_attached
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .iter()
            .filter(|(_, streams)| streams.contains(&stream_id))
            .map(|(id, _)| *id)
            .collect();
        for id in ids {
            self.send(id, Outgoing::Binary(frame.clone()));
        }
    }

    fn exit(&self, id: &str, code: Option<i32>) {
        self.emit("pty-exit", proto::PtyExit { id: id.to_string(), code });
        // A CLI that crashed ran no SessionEnd hook.
        if let (Some(sessions), Some(session)) = (self.sessions.get(), pty::session_of(id)) {
            sessions.exited(self, session);
        }
    }

    fn resync(&self, id: &str) {
        self.emit("pty-resync", proto::PtyResync { id: id.to_string() });
    }
}

impl ProcessEvents for Hub {
    fn changed(&self, process: &proto::Process) {
        self.emit("process-changed", process);
    }

    fn removed(&self, workspace_id: &str, id: &str) {
        self.emit(
            "process-removed",
            proto::ProcessRemoved { workspace_id: workspace_id.to_string(), id: id.to_string() },
        );
    }
}

impl TranscriptEvents for Hub {
    fn apply(&self, session_id: &str, seq: u64, event: &crew_protocol::HarnessEvent) {
        self.emit(
            "transcript-apply",
            TranscriptApply {
                session_id: session_id.to_string(),
                seq,
                event: event.clone(),
            },
        );
    }

    fn status(
        &self,
        session_id: &str,
        status: &str,
        provider_session_id: Option<&str>,
        updated_at: i64,
    ) {
        self.emit(
            "session-status",
            proto::SessionStatusEvent {
                session_id: session_id.to_string(),
                status: status.to_string(),
                provider_session_id: provider_session_id.map(str::to_string),
                updated_at,
            },
        );
    }
}

impl crew_core::scheduler::RoutineEvents for Hub {
    /// A run started, skipped or ended. The screen re-reads; the payload would
    /// only be a row it is about to ask for anyway.
    fn routines_changed(&self) {
        self.emit("routines-changed", serde_json::json!({}));
    }
}

struct AgentFanout {
    turns: TurnHost,
}

/// The daemon side of the tool bridge. Host handles live here: a family of
/// tools that needs one (the process host, the browser channel) gets a clone
/// when it is built in `serve` and registered on `toolbox`.
struct ToolDispatch {
    store: crew_core::store::Store,
    transcripts: crew_core::transcript::TranscriptHub,
    scheduler: Scheduler,
    hub: Arc<Hub>,
    /// Shared with `turns`, so what is registered here is also named on the
    /// tool sheet in a bot's prompt.
    toolbox: Toolbox,
    exit: std_mpsc::Sender<()>,
}


impl ToolHost for ToolDispatch {
    fn resolve(&self, bearer: &Bearer, workspace: Option<&str>) -> Result<Caller, String> {
        Caller::resolve(&self.store, bearer, workspace)
    }

    fn handle(&self, caller: &Caller, method: &str, params: Value) -> Result<Value, String> {
        // `crew daemon stop`. Only the user's token: a session that could stop
        // the daemon could stop every other session with it.
        if method == "daemon/shutdown" {
            if caller.kind() != crew_core::caller::CallerKind::User {
                return Err("Only the user can stop Crew's daemon.".into());
            }
            let _ = self.exit.send(());
            return Ok(Value::Null);
        }
        let on_created = |created: &crew_core::session::Session| {
            self.hub.emit(
                "session-created",
                SessionCreated {
                    session: proto_session(created),
                    // A terminal a tool makes is a handoff: the window opens
                    // its tab and starts its CLI.
                    open: created.kind == "terminal",
                },
            );
        };
        let host = tools::Host {
            store: &self.store,
            transcripts: &self.transcripts,
            on_created: &on_created,
            on_routines: &|| self.scheduler.arm(),
            toolbox: &self.toolbox,
        };
        tools::handle(&host, caller, method, params)
    }
}

fn proto_session(row: &crew_core::session::Session) -> proto::Session {
    proto::Session {
        id: row.id.clone(),
        workspace_id: row.workspace_id.clone(),
        kind: row.kind.clone(),
        name: row.name.clone(),
        provider: row.provider.clone(),
        model: row.model.clone(),
        effort: row.effort.clone(),
        provider_session_id: row.provider_session_id.clone(),
        description: row.description.clone(),
        notifications: row.notifications,
        autonomy: row.autonomy.clone(),
        status: row.status.clone(),
        worktree: row.worktree.clone(),
        created_at: row.created_at,
        updated_at: row.updated_at,
        bot_id: row.bot_id.clone(),
        parent_id: row.parent_id.clone(),
        cursor: row.cursor,
        handed_off_by: row.handed_off_by.clone(),
        handed_off_by_name: row.handed_off_by_name.clone(),
        parent_name: row.parent_name.clone(),
        user_seen: row.user_seen,
        last_event: row.last_event.as_ref().map(|event| proto::SessionLastEvent {
            kind: event.kind.clone(),
            at: event.at,
            cursor: event.cursor,
        }),
    }
}

impl AgentEvents for AgentFanout {
    fn lines(&self, event: &str, session_id: &str, lines: Vec<String>) {
        self.turns.on_agent_lines(event, session_id, lines);
    }

    fn exit(&self, session_id: &str, code: Option<i32>, _pid: u32) {
        self.turns.on_agent_exit(session_id, code);
    }
}

pub fn serve(config: Config) -> Result<Handle, String> {
    serve_on(config, Listen::local())
}

pub fn serve_on(config: Config, listen: Listen) -> Result<Handle, String> {
    let token = listen.token.clone();
    let hub = Arc::new(Hub::new());
    // A box that changed, and a row whose derived fields did (a child's last
    // event, how far the user read it), reach every window.
    let heard = hub.clone();
    let rows = config.store.clone();
    config.store.set_listener(Arc::new(move |what| match what {
        crew_core::store::Changed::Mailbox(id) => {
            heard.emit("mailbox-changed", proto::MailboxChanged { session_id: id.to_string() })
        }
        crew_core::store::Changed::Session(id) => {
            if let Ok(Some(row)) = session::get(&rows, id.to_string()) {
                heard.emit("session-updated", SessionUpdated { session: proto_session(&row) });
            }
        }
    }));
    let transcripts = crew_core::transcript::TranscriptHub::new(config.store.clone());
    transcripts.set_events(hub.clone());
    let turns = TurnHost::new(
        config.agents.clone(),
        config.store.clone(),
        transcripts.clone(),
        config.bridge.clone(),
    );
    // What a turn left running in the background reaches every window.
    let tray = hub.clone();
    turns.background().set_listener(Arc::new(move |list| tray.emit("background-changed", list)));
    let leases = Leases::new();
    let browser = BrowserTools::new(config.store.clone(), BrowserRelay::new(), leases.clone());
    let to_client = hub.clone();
    browser
        .relay()
        .set_sender(Arc::new(move |client, event, payload| to_client.send_event(client, event, payload)));
    let to_all = hub.clone();
    leases.set_on_change(move |all| to_all.emit("browser-leases", all));
    config.pty.set_events(hub.clone());
    let _ = hub.unwatch.set(Box::new(config.pty.unwatcher()));
    config.agents.set_events(Arc::new(AgentFanout {
        turns: turns.clone(),
    }));
    let scheduler = Scheduler::new(config.store.clone(), turns.clone());
    scheduler.set_events(hub.clone());
    // Tool families register here, with the host handles they need.
    let toolbox = turns.toolbox();
    let (exit_tx, exit_rx) = std_mpsc::channel();
    let made = hub.clone();
    let children = Arc::new(SessionTools::new(
        turns.clone(),
        Arc::new(move |created: &crew_core::session::Session| {
            // A terminal it makes is a handoff (`start_session` with owner
            // user): the window opens its tab and starts its CLI on the prompt.
            made.emit("session-created", SessionCreated { session: proto_session(created), open: created.kind == "terminal" });
        }),
    )
    .with_processes(config.processes.clone()));
    toolbox.register(children.clone());
    toolbox.register(Arc::new(
        ProcessTools::new(config.processes.clone(), config.store.clone()).with_turns(turns.clone()),
    ));
    toolbox.register(Arc::new(browser.clone()));
    config.bridge.set_handler(Arc::new(ToolDispatch {
        store: config.store.clone(),
        transcripts,
        scheduler: scheduler.clone(),
        hub: hub.clone(),
        toolbox,
        exit: exit_tx.clone(),
    }));

    // A letter left waiting for an idle bot is invisible until someone
    // messages it: only the end of a turn looks in a box.
    turns.deliver_waiting();
    // A session somebody started, caught mid-turn by the restart, carries on:
    // its parent is still waiting for its report.
    turns.resume_interrupted();

    // Before the window can list them, or it would show rows already gone.
    let _ = session::sweep_disposable(&config.store);

    let (ready_tx, ready_rx) = std_mpsc::channel();
    let (stop_tx, stop_rx) = tokio::sync::oneshot::channel();
    config.processes.set_events(hub.clone());
    let sessions = sessions::SessionWatch::start(config.store.clone(), hub.clone());
    let _ = hub.sessions.set(sessions.clone());
    let hosts = Hosts {
        hub: hub.clone(),
        pty: config.pty,
        processes: config.processes,
        store: config.store,
        bridge: config.bridge,
        turns: turns.clone(),
        scheduler: scheduler.clone(),
        browser,
        exit: exit_tx,
        sessions,
        children,
        socks_port: 0,
    };

    thread::Builder::new()
        .name("crewd".into())
        .spawn(move || {
            let runtime = match tokio::runtime::Builder::new_multi_thread().enable_all().build() {
                Ok(runtime) => runtime,
                Err(error) => {
                    let _ = ready_tx.send(Err(error.to_string()));
                    return;
                }
            };
            runtime.block_on(run(hosts, hub, listen, ready_tx, stop_rx));
        })
        .map_err(|e| e.to_string())?;

    let url = ready_rx.recv().map_err(|e| e.to_string())??;
    Ok(Handle {
        info: DaemonInfo { url, token },
        shutdown: Mutex::new(Some(stop_tx)),
        exit_requests: Mutex::new(Some(exit_rx)),
        turns,
        scheduler,
    })
}

async fn bind(listen: &Listen) -> std::io::Result<TcpListener> {
    let mut wait = Duration::from_millis(500);
    loop {
        match TcpListener::bind(&listen.addr).await {
            Err(error)
                if listen.wait_for_addr
                    && matches!(
                        error.kind(),
                        std::io::ErrorKind::AddrNotAvailable | std::io::ErrorKind::AddrInUse
                    ) =>
            {
                eprintln!("[crewd] {}: {error}; trying again in {wait:?}", listen.addr);
                tokio::time::sleep(wait).await;
                wait = (wait * 2).min(Duration::from_secs(10));
            }
            bound => return bound,
        }
    }
}

fn socks_addr(ws: std::net::SocketAddr) -> Option<std::net::SocketAddr> {
    let port = ws.port().checked_add(1)?;
    Some(std::net::SocketAddr::new(ws.ip(), port))
}

async fn run(
    mut hosts: Hosts,
    hub: Arc<Hub>,
    listen: Listen,
    ready_tx: std_mpsc::Sender<Result<String, String>>,
    mut stop_rx: tokio::sync::oneshot::Receiver<()>,
) {
    let token = listen.token.clone();
    let listener = match bind(&listen).await {
        Ok(listener) => listener,
        Err(error) => {
            let _ = ready_tx.send(Err(error.to_string()));
            return;
        }
    };
    let addr = match listener.local_addr() {
        Ok(addr) => addr,
        Err(error) => {
            let _ = ready_tx.send(Err(error.to_string()));
            return;
        }
    };
    let _ = ready_tx.send(Ok(format!("ws://{addr}")));
    if listen.wait_for_addr {
        if let Some(socks_at) = socks_addr(addr) {
            match TcpListener::bind(socks_at).await {
                Ok(listener) => {
                    hosts.socks_port = socks_at.port();
                    let token = token.clone();
                    tokio::spawn(socks::run(listener, token));
                }
                Err(error) => eprintln!("[crewd] socks {socks_at}: {error}"),
            }
        }
    }
    hub.set_runtime(tokio::runtime::Handle::current());
    hosts.turns.set_runtime(tokio::runtime::Handle::current());
    hosts.turns.transcripts().set_runtime(tokio::runtime::Handle::current());
    // Routines are the daemon's to fire: a standing order outlives the window.
    hosts.scheduler.set_runtime(tokio::runtime::Handle::current());
    let scheduler = hosts.scheduler.clone();
    tokio::task::spawn_blocking(move || scheduler.arm());
    // A lease nobody renews runs out on its own; this is how the window hears
    // it did, and unpins the tab.
    let leases = hosts.browser.leases().clone();
    tokio::spawn(async move {
        let mut tick = tokio::time::interval(Duration::from_secs(5));
        loop {
            tick.tick().await;
            leases.sweep(app_state::now_millis());
        }
    });
    // A session nobody has given work for a while exits and frees its
    // parent's slot. Nothing runs between turns, so nothing is killed.
    let children = hosts.children.clone();
    tokio::spawn(async move {
        let mut every = tokio::time::interval(REAP_EVERY);
        loop {
            every.tick().await;
            let children = children.clone();
            if let Ok(Err(error)) = tokio::task::spawn_blocking(move || children.reap(SessionTools::idle_limit())).await {
                eprintln!("[crewd] reaping idle sessions: {error}");
            }
        }
    });
    // The first tick is now: what aged out while the app was closed goes before anyone looks.
    let expiring = hosts.clone();
    tokio::spawn(async move {
        let mut every = tokio::time::interval(EXPIRE_EVERY);
        loop {
            every.tick().await;
            let store = expiring.store.clone();
            if let Ok(Some(days)) = block(move || session::retention_days(&store)).await {
                if let Err(error) = expire_sessions(&expiring, days).await {
                    eprintln!("[crewd] expiring sessions: {error}");
                }
            }
        }
    });

    loop {
        tokio::select! {
            _ = &mut stop_rx => break,
            accepted = listener.accept() => {
                let Ok((stream, _)) = accepted else { break };
                // Nagle holds each small write (a keystroke's echo, a reply
                // behind another) until the last one is acked: one extra round
                // trip per burst to a remote window.
                let _ = stream.set_nodelay(true);
                notice_dead_peer(&stream);
                let hosts = hosts.clone();
                let hub = hub.clone();
                let token = token.clone();
                tokio::spawn(async move {
                    handle_socket(stream, hosts, hub, token).await;
                });
            }
        }
    }
    hosts.scheduler.stop();
    hosts.turns.transcripts().flush_all();
}

/// How long a window may go without answering before its socket is given up.
const PEER_TIMEOUT: Duration = Duration::from_secs(60);

/// A Mac that sleeps, or drops off the tailnet, never closes its socket: the
/// daemon would go on attached to a window that is not there, holding each
/// terminal it watched to that window's credit. Keepalive probes find a peer
/// that answers nothing, and the user timeout one that leaves what was sent
/// unacknowledged; either ends the socket, and the terminals run free.
fn notice_dead_peer(stream: &TcpStream) {
    use std::os::fd::AsRawFd;
    let fd = stream.as_raw_fd();
    let set = |level: libc::c_int, name: libc::c_int, value: libc::c_int| unsafe {
        libc::setsockopt(
            fd,
            level,
            name,
            (&value as *const libc::c_int).cast(),
            std::mem::size_of::<libc::c_int>() as libc::socklen_t,
        )
    };
    set(libc::SOL_SOCKET, libc::SO_KEEPALIVE, 1);
    #[cfg(target_os = "linux")]
    {
        set(libc::IPPROTO_TCP, libc::TCP_KEEPIDLE, 20);
        set(libc::IPPROTO_TCP, libc::TCP_KEEPINTVL, 10);
        set(libc::IPPROTO_TCP, libc::TCP_KEEPCNT, 4);
        set(libc::IPPROTO_TCP, libc::TCP_USER_TIMEOUT, PEER_TIMEOUT.as_millis() as libc::c_int);
    }
    #[cfg(target_os = "macos")]
    {
        set(libc::IPPROTO_TCP, libc::TCP_KEEPALIVE, 20);
        set(libc::IPPROTO_TCP, libc::TCP_KEEPINTVL, 10);
        set(libc::IPPROTO_TCP, libc::TCP_KEEPCNT, 4);
    }
}

async fn handle_socket(stream: TcpStream, hosts: Hosts, hub: Arc<Hub>, token: String) {
    let Some(ws) = http::accept(stream, &token).await else {
        return;
    };
    let (mut sink, mut source) = ws.split();
    let first = source.next().await;
    let Some(Ok(Message::Text(text))) = first else {
        let _ = sink.close().await;
        return;
    };
    let Ok(Auth { auth }) = serde_json::from_str::<Auth>(text.as_ref()) else {
        let _ = sink.close().await;
        return;
    };
    if auth != token {
        let _ = sink.close().await;
        return;
    }
    let hello = proto::event(
        "hello",
        proto::Hello {
            protocol: proto::PROTOCOL,
            version: env!("CARGO_PKG_VERSION").to_string(),
        },
    );
    let Ok(hello) = hello.and_then(|event| serde_json::to_string(&event)) else {
        return;
    };
    if sink.send(Message::Text(hello.into())).await.is_err() {
        return;
    }

    let (client_id, mut outgoing) = hub.subscribe();
    replay_busy_sessions(&hosts, &hub, client_id);
    let writer = tokio::spawn(async move {
        while let Some(msg) = outgoing.recv().await {
            let sent = match msg {
                Outgoing::Text(text) => sink.send(Message::Text(text.into())).await,
                Outgoing::Binary(bytes) => sink.send(Message::Binary(bytes.into())).await,
                Outgoing::Pong(payload) => sink.send(Message::Pong(payload.into())).await,
            };
            if sent.is_err() {
                break;
            }
        }
        let _ = sink.close().await;
    });

    let pty_in: Arc<Mutex<HashMap<u32, mpsc::Sender<Vec<u8>>>>> = Arc::new(Mutex::new(HashMap::new()));
    // The last call on each terminal: the next one on it waits for it to finish.
    let mut pty_last: HashMap<String, oneshot::Receiver<()>> = HashMap::new();

    while let Some(msg) = source.next().await {
        let Ok(msg) = msg else { break };
        match msg {
            Message::Text(text) => {
                let hosts = hosts.clone();
                let hub = hub.clone();
                // Calls run concurrently, except those on one terminal, which run
                // in the order sent: a respawn is a kill then a spawn, and a kill
                // that ran second would take the new process with it.
                let turn = pty_target(text.as_ref()).map(|id| {
                    if pty_last.len() > 64 {
                        pty_last.retain(|_, rx| matches!(rx.try_recv(), Err(oneshot::error::TryRecvError::Empty)));
                    }
                    let (done, rx) = oneshot::channel::<()>();
                    (pty_last.insert(id, rx), done)
                });
                tokio::spawn(async move {
                    let _done = match turn {
                        Some((before, done)) => {
                            if let Some(before) = before {
                                let _ = before.await;
                            }
                            Some(done)
                        }
                        None => None,
                    };
                    if let Some(reply) = handle_text(&hosts, &hub, client_id, text.as_ref()).await {
                        hub.send(client_id, Outgoing::Text(reply));
                    }
                });
            }
            Message::Binary(bytes) => {
                if bytes.len() < 4 {
                    continue;
                }
                let stream_id = u32::from_le_bytes(bytes[..4].try_into().unwrap());
                enqueue_pty_input(&pty_in, &hosts, &hub, stream_id, bytes[4..].to_vec());
            }
            Message::Close(_) => break,
            Message::Ping(payload) => {
                hub.send(client_id, Outgoing::Pong(payload.to_vec()));
            }
            Message::Pong(_) | Message::Frame(_) => {}
        }
    }

    hub.unsubscribe(client_id);
    hosts.browser.relay().client_gone(client_id);
    hosts.sessions.drop_client(client_id);
    writer.abort();
}

fn replay_busy_sessions(hosts: &Hosts, hub: &Hub, client_id: u64) {
    let Ok(rows) = session::list_busy(&hosts.store) else {
        return;
    };
    let updated_at = app_state::now_millis();
    for row in rows {
        if row.status != "working" && row.status != "needs-input" {
            continue;
        }
        let Ok(event) = proto::event(
            "session-status",
            proto::SessionStatusEvent {
                session_id: row.id,
                status: row.status,
                provider_session_id: row.provider_session_id,
                updated_at,
            },
        ) else {
            continue;
        };
        let Ok(text) = serde_json::to_string(&event) else {
            continue;
        };
        hub.send(client_id, Outgoing::Text(text));
    }
}

fn enqueue_pty_input(
    pty_in: &Mutex<HashMap<u32, mpsc::Sender<Vec<u8>>>>,
    hosts: &Hosts,
    hub: &Arc<Hub>,
    stream_id: u32,
    data: Vec<u8>,
) {
    let mut map = pty_in.lock().unwrap_or_else(|e| e.into_inner());
    let data = match map.get(&stream_id) {
        None => data,
        Some(tx) => match tx.try_send(data) {
            Ok(()) => return,
            Err(mpsc::error::TrySendError::Full(_)) => {
                drop(map);
                emit_pty_error(hub, &hosts.pty, stream_id, "Terminal is not accepting input");
                return;
            }
            // Its drain gave up on a stream that ended. Stream ids start over
            // with the daemon, so a new terminal can come to hold this one: it
            // gets a queue of its own rather than the dead one's refusal.
            Err(mpsc::error::TrySendError::Closed(data)) => {
                map.remove(&stream_id);
                data
            }
        },
    };
    let (tx, rx) = mpsc::channel(32);
    if tx.try_send(data).is_err() {
        drop(map);
        emit_pty_error(hub, &hosts.pty, stream_id, "Terminal is not accepting input");
        return;
    }
    map.insert(stream_id, tx);
    drop(map);
    let host = hosts.pty.clone();
    let hub = hub.clone();
    tokio::spawn(async move {
        drain_pty_input(host, hub, stream_id, rx).await;
    });
}

async fn drain_pty_input(
    host: PtyHost,
    hub: Arc<Hub>,
    stream_id: u32,
    mut rx: mpsc::Receiver<Vec<u8>>,
) {
    while let Some(data) = rx.recv().await {
        let writer = host.clone();
        let result = tokio::task::spawn_blocking(move || writer.write_stream(stream_id, &data)).await;
        let error = match result {
            Ok(Ok(())) => continue,
            Ok(Err(error)) => error,
            Err(error) => error.to_string(),
        };
        emit_pty_error(&hub, &host, stream_id, error);
        break;
    }
}

fn emit_pty_error(hub: &Hub, host: &PtyHost, stream_id: u32, error: impl Into<String>) {
    let id = host
        .session_of_stream(stream_id)
        .unwrap_or_else(|| stream_id.to_string());
    hub.emit("pty-error", proto::PtyError { id, error: error.into() });
}

/// The terminal a `pty_*` call is about.
fn pty_target(text: &str) -> Option<String> {
    #[derive(Deserialize)]
    struct Target {
        method: String,
        params: TargetId,
    }
    #[derive(Deserialize)]
    struct TargetId {
        id: String,
    }
    if !text.contains("\"pty_") {
        return None;
    }
    let target = serde_json::from_str::<Target>(text).ok()?;
    target.method.starts_with("pty_").then_some(target.params.id)
}

async fn handle_text(hosts: &Hosts, hub: &Arc<Hub>, client_id: u64, text: &str) -> Option<String> {
    let request = match serde_json::from_str::<Request>(text) {
        Ok(request) => request,
        Err(error) => return Some(encode(&proto::err(0, format!("Bad request: {error}")))),
    };
    if request.method == "pty_attach" {
        attach_pty(hosts, hub, client_id, request.id, request.params).await;
        return None;
    }
    // Its tab closed: this client stops getting the frames, and the process
    // runs on without waiting for it to read them.
    if request.method == "pty_detach" {
        let result = parse::<PtyDetach>(request.params).map(|PtyDetach { id }| {
            if let Some(stream_id) = hosts.pty.detach(&id) {
                hub.unwatch_pty(client_id, stream_id);
            }
            Value::Null
        });
        return Some(encode(&match result {
            Ok(value) => proto::ok(request.id, value),
            Err(error) => proto::err(request.id, error),
        }));
    }
    // These speak for the connection itself, so they need to know which one it is.
    if request.method == "browser_host_register" {
        hub.hush(client_id);
        hosts.browser.relay().register_host(client_id);
        let leases = hosts.browser.leases().list(app_state::now_millis());
        return Some(encode(&match json(leases) {
            Ok(value) => proto::ok(request.id, value),
            Err(error) => proto::err(request.id, error),
        }));
    }
    if request.method == "browser_result" {
        let result = parse::<proto::BrowserResult>(request.params).and_then(|answer| {
            let outcome = if answer.ok {
                Ok(answer.result.unwrap_or(Value::Null))
            } else {
                Err(answer.error.unwrap_or_else(|| "The browser tool failed".into()))
            };
            hosts.browser.relay().resolve(client_id, answer.call_id, outcome)
        });
        return Some(encode(&match result {
            Ok(()) => proto::ok(request.id, Value::Null),
            Err(error) => proto::err(request.id, error),
        }));
    }
    // A history is read for the windows that hold it open, so these know who asks.
    let result = match request.method.as_str() {
        "session_history_window" => history_window(hosts, client_id, request.params).await,
        "session_history_close" => parse::<Id>(request.params).map(|Id { id }| {
            hosts.sessions.close(client_id, &id);
            Value::Null
        }),
        method => dispatch(hosts, method, request.params).await,
    };
    Some(encode(&match result {
        Ok(value) => proto::ok(request.id, value),
        Err(error) => proto::err(request.id, error),
    }))
}

async fn attach_pty(hosts: &Hosts, hub: &Arc<Hub>, client_id: u64, req_id: u32, params: Value) {
    let PtyAttach { id, from } = match parse(params) {
        Ok(value) => value,
        Err(error) => {
            hub.send(client_id, Outgoing::Text(encode(&proto::err(req_id, error))));
            return;
        }
    };
    let host = hosts.pty.clone();
    let hub_c = hub.clone();
    let result = block(move || {
        host.attach(&id, from, |attached, stream_id, tail| {
            hub_c.watch_pty(client_id, stream_id);
            let value = match serde_json::to_value(PtyAttached {
                start: attached.start,
                emitted: attached.emitted,
            }) {
                Ok(value) => value,
                Err(error) => {
                    hub_c.send(client_id, Outgoing::Text(encode(&proto::err(req_id, error.to_string()))));
                    return;
                }
            };
            hub_c.send(client_id, Outgoing::Text(encode(&proto::ok(req_id, value))));
            if !tail.is_empty() {
                let mut frame = Vec::with_capacity(4 + tail.len());
                frame.extend_from_slice(&stream_id.to_le_bytes());
                frame.extend_from_slice(tail);
                hub_c.send(client_id, Outgoing::Binary(frame));
            }
        })
    })
    .await;
    if let Err(error) = result {
        hub.send(client_id, Outgoing::Text(encode(&proto::err(req_id, error))));
    }
}

async fn history_window(hosts: &Hosts, client_id: u64, params: Value) -> Result<Value, String> {
    let proto::SessionHistoryRequest { id, cwd, before } = parse(params)?;
    let sessions = hosts.sessions.clone();
    let store = hosts.store.clone();
    json(block(move || sessions.window(&store, client_id, &id, &cwd, before)).await?)
}

/// Providers that can hand out an id before the terminal starts get one now.
fn bind_new_provider_session(store: &Store, id: String) -> Result<String, String> {
    let row = session::get(store, id.clone())?.ok_or("Session not found")?;
    if let Some(bound) = row.provider_session_id {
        return Ok(bound);
    }
    let created = match row.provider.as_str() {
        "cursor" => provider_session::cursor_create_chat()?,
        other => return Err(format!("{other} does not create sessions ahead of time")),
    };
    session::set_provider_session(store, id, created.clone())?;
    Ok(created)
}

fn discover_provider_session(
    store: &Store,
    id: String,
    cwd: &str,
    since: i64,
) -> Result<Option<String>, String> {
    let row = session::get(store, id.clone())?.ok_or("Session not found")?;
    if row.provider_session_id.is_some() {
        return Ok(row.provider_session_id);
    }
    let claimed = session::claimed_provider_sessions(store, &id)?;
    let Some(found) = provider_session::discover(&row.provider, cwd, since, &claimed) else {
        return Ok(None);
    };
    session::set_provider_session(store, id, found.clone())?;
    Ok(Some(found))
}

/// The new id when Claude moved to another session since the last look. The
/// conversations it left with turns in them are sessions now; every window
/// hears of them, and of the renamed terminal.
fn rebind_claude_session(store: &Store, hub: &Hub, id: String) -> Result<Option<String>, String> {
    // The window asks, and the hook watcher follows every start: one at a time,
    // or both would split the same conversation off.
    static FOLLOWING: Mutex<()> = Mutex::new(());
    let _one = FOLLOWING.lock().unwrap_or_else(|e| e.into_inner());
    let before = session::get(store, id.clone())?.and_then(|row| row.provider_session_id);
    let Some(followed) = session::follow_claude(store, id)? else {
        return Ok(None);
    };
    announce(hub, &followed);
    let now = followed.session.provider_session_id;
    Ok(now.filter(|now| before.as_ref() != Some(now)))
}

fn announce(hub: &Hub, followed: &session::Followed) {
    for split in &followed.split {
        hub.emit("session-created", SessionCreated { session: proto_session(split), open: false });
    }
    hub.emit("session-updated", SessionUpdated { session: proto_session(&followed.session) });
}

async fn block<T: Send + 'static>(
    work: impl FnOnce() -> Result<T, String> + Send + 'static,
) -> Result<T, String> {
    tokio::task::spawn_blocking(work)
        .await
        .map_err(|e| e.to_string())?
}

/// A terminal session's process, completed so its CLI reaches Crew's tools:
/// a token of its own in the environment, and the provider's MCP flag.
///
/// The token lives as long as the process and is handed back by token when it
/// is reaped, not by session: a respawn starts the new process before the old
/// one's exit is seen, and that exit must not take the new token with it.
fn terminal_launch(
    store: &Store,
    bridge: &Bridge,
    leases: &Leases,
    session_id: &str,
    command: Vec<String>,
) -> Result<(Vec<String>, SpawnOptions), String> {
    let row = session::get(store, session_id.to_string())?
        .ok_or_else(|| format!("No session {session_id}"))?;
    if row.kind != "terminal" {
        return Err(format!("{} is not a terminal session", row.name));
    }
    let info = bridge.info()?;
    let token = bridge.mint_process(session_id);
    // The prompt a handoff (`start_session` with owner user) left it, taken
    // by the first launch whose CLI can start on it; a shell leaves it in the
    // box.
    let letter = mailbox::claim(store, session_id)?;
    let opening = letter.as_ref().map(|letter| mailbox::render(letter, None));
    let launch = crew_core::terminal::launch(
        &row.provider,
        command,
        opening.as_deref(),
        &crew_core::terminal::BridgeLink { exe: &info.exe, socket: &info.socket_path, token: &token },
    );
    // Handed over as the CLI's opening prompt, or back in the box for the
    // next launch that can take one.
    if let Some(letter) = letter {
        if launch.prompted {
            mailbox::delivered(store, &[letter.id])?;
        } else {
            mailbox::release(store, &letter.id)?;
        }
    }
    let bridge = bridge.clone();
    let leases = leases.clone();
    let session = session_id.to_string();
    // Its browser tabs are numbered for this process like its token, for the same reason.
    let process = leases.begin_process(session_id);
    Ok((
        launch.argv,
        SpawnOptions {
            env: launch.env,
            // The browser tabs it was driving go free with it, rather than at their TTL.
            on_exit: Some(Box::new(move || {
                bridge.revoke_token(&token);
                leases.end_process(&session, process, app_state::now_millis());
            })),
            ..SpawnOptions::default()
        },
    ))
}

async fn delete_session(hosts: &Hosts, id: String) -> Result<(), String> {
    let store = hosts.store.clone();
    // Closing its tab left its terminal running; the session going takes it.
    let host = hosts.pty.clone();
    let session = id.clone();
    block(move || {
        host.kill_session(&session);
        Ok(())
    })
    .await?;
    // A turn still running would write into a transcript that is gone.
    if hosts.turns.is_running(&id) {
        let turns = hosts.turns.clone();
        let running = id.clone();
        block(move || turns.stop(&running)).await?;
    }
    // A process that outlived that still has a token in its environment;
    // a session that no longer exists should not still be able to call.
    hosts.bridge.revoke(&id);
    hosts.browser.leases().release_all(&id, app_state::now_millis());
    block(move || session::delete(&store, id)).await
}

const DAY_MS: i64 = 24 * 60 * 60 * 1000;

/// How often the daemon lets go of sessions Settings no longer keeps.
const EXPIRE_EVERY: Duration = Duration::from_secs(60 * 60);

/// How often idle child sessions are looked at.
const REAP_EVERY: Duration = Duration::from_secs(20);

fn stale_before(days: u32) -> i64 {
    app_state::now_millis() - i64::from(days) * DAY_MS
}

/// Deletes the sessions untouched for `days`, spares any whose process still
/// runs, and tells every window which went.
async fn expire_sessions(hosts: &Hosts, days: u32) -> Result<Vec<String>, String> {
    let store = hosts.store.clone();
    let stale = block(move || session::stale(&store, stale_before(days))).await?;
    let mut gone = Vec::new();
    for id in stale.into_iter().filter(|id| !hosts.pty.runs_session(id)) {
        delete_session(hosts, id.clone()).await?;
        gone.push(id);
    }
    if !gone.is_empty() {
        hosts.hub.emit("sessions-deleted", SessionsDeleted { ids: gone.clone() });
    }
    Ok(gone)
}

fn json(value: impl serde::Serialize) -> Result<Value, String> {
    serde_json::to_value(value).map_err(|e| e.to_string())
}

async fn dispatch(hosts: &Hosts, method: &str, params: Value) -> Result<Value, String> {
    match method {
        "pty_spawn" => {
            let PtySpawn { id, cwd, command, cols, rows, session, reuse, dark } = parse(params)?;
            let host = hosts.pty.clone();
            let store = hosts.store.clone();
            let bridge = hosts.bridge.clone();
            let leases = hosts.browser.leases().clone();
            json(
                block(move || {
                    let prepare = move |command: Vec<String>| {
                        let (command, options) = match session {
                            Some(session) => terminal_launch(&store, &bridge, &leases, &session, command)?,
                            None => (command, SpawnOptions::default()),
                        };
                        Ok((command, SpawnOptions { dark, ..options }))
                    };
                    if reuse == Some(true) {
                        host.open(id, cwd, command, cols, rows, prepare)
                    } else {
                        let (command, options) = prepare(command)?;
                        host.spawn_with(id, cwd, command, cols, rows, options)
                    }
                })
                .await?,
            )
        }
        "pty_write" => {
            let PtyWrite { id, data } = parse(params)?;
            let host = hosts.pty.clone();
            block(move || host.write(&id, data.as_bytes())).await?;
            Ok(Value::Null)
        }
        "pty_resize" => {
            let PtyResize { id, cols, rows } = parse(params)?;
            let host = hosts.pty.clone();
            block(move || host.resize(&id, cols, rows)).await?;
            Ok(Value::Null)
        }
        "pty_ack" => {
            let PtyAck { id, processed } = parse(params)?;
            let host = hosts.pty.clone();
            block(move || {
                host.ack(&id, processed);
                Ok(())
            })
            .await?;
            Ok(Value::Null)
        }
        "pty_kill" => {
            let PtyKill { id } = parse(params)?;
            let host = hosts.pty.clone();
            block(move || {
                host.kill(&id);
                Ok(())
            })
            .await?;
            Ok(Value::Null)
        }
        "workspace_list" => {
            let store = hosts.store.clone();
            json(block(move || workspace::list(&store)).await?)
        }
        "workspace_home" => {
            let store = hosts.store.clone();
            json(block(move || workspace::home(&store, &machine::home_folder())).await?)
        }
        "workspace_create" => {
            let NamePath { name, path } = parse(params)?;
            let store = hosts.store.clone();
            json(block(move || workspace::create(&store, name, path)).await?)
        }
        "workspace_rename" => {
            let IdName { id, name } = parse(params)?;
            let store = hosts.store.clone();
            block(move || workspace::rename(&store, id, name)).await?;
            Ok(Value::Null)
        }
        "workspace_delete" => {
            let Id { id } = parse(params)?;
            let store = hosts.store.clone();
            let processes = hosts.processes.clone();
            let pty = hosts.pty.clone();
            block(move || {
                // Its rows would go with the workspace, but not its processes,
                // nor the terminals its closed tabs left running.
                processes.forget_workspace(&id);
                for session in session::list(&store, id.clone())? {
                    pty.kill_session(&session.id);
                }
                workspace::delete(&store, id)
            })
            .await?;
            Ok(Value::Null)
        }
        "workspace_reorder" => {
            let Ids { ids } = parse(params)?;
            let store = hosts.store.clone();
            block(move || workspace::reorder(&store, ids)).await?;
            Ok(Value::Null)
        }
        "active_workspace_get" => {
            let store = hosts.store.clone();
            json(block(move || workspace::active_get(&store)).await?)
        }
        "active_workspace_set" => {
            let OptionalId { id } = parse(params)?;
            let store = hosts.store.clone();
            block(move || workspace::active_set(&store, id)).await?;
            Ok(Value::Null)
        }
        "session_list" => {
            let WorkspaceId { workspace_id } = parse(params)?;
            let store = hosts.store.clone();
            json(block(move || session::list(&store, workspace_id)).await?)
        }
        "session_get" => {
            let Id { id } = parse(params)?;
            let store = hosts.store.clone();
            json(block(move || session::get(&store, id)).await?)
        }
        "session_create" => {
            let p: SessionCreate = parse(params)?;
            let store = hosts.store.clone();
            json(block(move || {
                let mut row = session::create_in_worktree(
                    &store,
                    p.workspace_id,
                    p.kind,
                    p.name,
                    p.provider,
                    p.model,
                    p.description,
                    p.autonomy,
                    p.worktree,
                )?;
                if let Some(effort) = p.effort.filter(|effort| !effort.is_empty()) {
                    session::set_options(&store, row.id.clone(), row.model.clone(), effort.clone(), row.autonomy.clone())?;
                    row.effort = effort;
                }
                Ok::<_, String>(row)
            })
            .await?)
        }
        "session_set_options" => {
            let p: SessionOptions = parse(params)?;
            let store = hosts.store.clone();
            let id = p.id.clone();
            let row = block(move || {
                session::set_options(&store, p.id, p.model, p.effort, p.autonomy)?;
                session::get(&store, id)
            })
            .await?;
            // Every window's composer shows the same chips.
            if let Some(row) = row {
                hosts.hub.emit("session-updated", SessionUpdated { session: proto_session(&row) });
            }
            Ok(Value::Null)
        }
        "session_update" => {
            let p: SessionUpdate = parse(params)?;
            let store = hosts.store.clone();
            block(move || {
                session::update(
                    &store,
                    p.id,
                    p.name,
                    p.provider,
                    p.model,
                    p.description,
                    p.notifications,
                    p.autonomy,
                )
            })
            .await?;
            Ok(Value::Null)
        }
        "session_rename" => {
            let IdName { id, name } = parse(params)?;
            let store = hosts.store.clone();
            block(move || session::rename(&store, id, name)).await?;
            Ok(Value::Null)
        }
        "session_delete" => {
            let Id { id } = parse(params)?;
            delete_session(hosts, id).await?;
            Ok(Value::Null)
        }
        // The session stays; the terminal it runs in, tab open or closed, ends.
        "session_stop" => {
            let Id { id } = parse(params)?;
            let host = hosts.pty.clone();
            block(move || {
                host.kill_session(&id);
                Ok(())
            })
            .await?;
            Ok(Value::Null)
        }
        // The workspace's sessions whose terminal runs, its tab open or not.
        "sessions_running" => {
            let WorkspaceId { workspace_id } = parse(params)?;
            let store = hosts.store.clone();
            let host = hosts.pty.clone();
            json(
                block(move || {
                    let rows = session::list(&store, workspace_id)?;
                    Ok(rows.into_iter().map(|row| row.id).filter(|id| host.runs_session(id)).collect::<Vec<_>>())
                })
                .await?,
            )
        }
        "sessions_stale" => {
            let SessionsRetention { days } = parse(params)?;
            let store = hosts.store.clone();
            let stale = block(move || session::stale(&store, stale_before(days))).await?;
            json(stale.iter().filter(|id| !hosts.pty.runs_session(id)).count())
        }
        "sessions_expire" => {
            let SessionsRetention { days } = parse(params)?;
            json(expire_sessions(hosts, days).await?)
        }
        "session_is_disposable" => {
            let Id { id } = parse(params)?;
            let store = hosts.store.clone();
            let hub = hosts.hub.clone();
            json(block(move || {
                // Judged on the conversation the CLI is in now, the ones it left split off first.
                if let Some(followed) = session::follow_claude(&store, id.clone())? {
                    announce(&hub, &followed);
                }
                session::is_disposable(&store, id)
            })
            .await?)
        }
        "session_reorder" => {
            let Ids { ids } = parse(params)?;
            let store = hosts.store.clone();
            block(move || session::reorder(&store, ids)).await?;
            Ok(Value::Null)
        }
        "session_set_status" => {
            let IdStatus { id, status } = parse(params)?;
            let store = hosts.store.clone();
            block(move || session::set_status(&store, id, status)).await?;
            Ok(Value::Null)
        }
        "session_provider_create" => {
            let Id { id } = parse(params)?;
            let store = hosts.store.clone();
            json(block(move || bind_new_provider_session(&store, id)).await?)
        }
        "session_provider_discover" => {
            let ProviderDiscover { id, cwd, since } = parse(params)?;
            let store = hosts.store.clone();
            json(block(move || discover_provider_session(&store, id, &cwd, since)).await?)
        }
        "session_claude_rebind" => {
            let Id { id } = parse(params)?;
            let store = hosts.store.clone();
            let hub = hosts.hub.clone();
            json(block(move || rebind_claude_session(&store, &hub, id)).await?)
        }
        "session_live_get" => {
            let Id { id } = parse(params)?;
            json(hosts.sessions.live(&id))
        }
        "session_live_stopped" => {
            let Id { id } = parse(params)?;
            hosts.sessions.stopped(&hosts.hub, &id);
            Ok(Value::Null)
        }
        "session_live_answered" => {
            let proto::SessionLiveAnswered { id, ask_id } = parse(params)?;
            hosts.sessions.answered(&hosts.hub, &id, ask_id);
            Ok(Value::Null)
        }
        "session_sync_title" => {
            let Id { id } = parse(params)?;
            let store = hosts.store.clone();
            json(block(move || session::sync_title(&store, id)).await?)
        }
        "session_mark_seen" => {
            let proto::SessionMarkSeen { id, cursor } = parse(params)?;
            let store = hosts.store.clone();
            json(block(move || session::mark_user_seen(&store, id, cursor)).await?)
        }
        "thread_pairs" => {
            let SessionId { session_id } = parse(params)?;
            let store = hosts.store.clone();
            json(block(move || mailbox::pairs(&store, &session_id)).await?)
        }
        "thread_messages" => {
            let proto::ThreadMessagesRequest { a, b, before, limit, .. } = parse(params)?;
            let store = hosts.store.clone();
            json(block(move || mailbox::thread(&store, &a, &b, before.as_deref(), limit)).await?)
        }
        "mailbox_pending" => {
            let SessionId { session_id } = parse(params)?;
            let store = hosts.store.clone();
            json(block(move || mailbox::pending(&store, &session_id)).await?)
        }
        "session_mark_read" => {
            let Id { id } = parse(params)?;
            let store = hosts.store.clone();
            block(move || session::mark_read(&store, id)).await?;
            Ok(Value::Null)
        }
        "routine_list_for_session" => {
            let SessionId { session_id } = parse(params)?;
            let store = hosts.store.clone();
            json(block(move || routine::list_for_session(&store, session_id)).await?)
        }
        "routine_list" => {
            let store = hosts.store.clone();
            json(block(move || routine::list(&store)).await?)
        }
        "routine_upsert" => {
            let p: RoutineUpsert = parse(params)?;
            let store = hosts.store.clone();
            let row = block(move || {
                routine::upsert(
                    &store,
                    p.id,
                    p.session_id,
                    p.name,
                    p.enabled,
                    p.prompt,
                    p.schedule,
                    p.next_run_at,
                    p.created_by,
                )
            })
            .await?;
            let scheduler = hosts.scheduler.clone();
            tokio::task::spawn_blocking(move || scheduler.arm());
            json(row)
        }
        "routine_delete" => {
            let Id { id } = parse(params)?;
            let store = hosts.store.clone();
            block(move || routine::delete(&store, id)).await?;
            let scheduler = hosts.scheduler.clone();
            tokio::task::spawn_blocking(move || scheduler.arm());
            Ok(Value::Null)
        }
        "routine_run_now" => {
            let RoutineRunNow { routine_id } = parse(params)?;
            let scheduler = hosts.scheduler.clone();
            block(move || scheduler.run_now(routine_id)).await?;
            Ok(Value::Null)
        }
        "state_get" => {
            let Key { key } = parse(params)?;
            let store = hosts.store.clone();
            json(block(move || app_state::get(&store, key)).await?)
        }
        "state_set" => {
            let KeyValue { key, value } = parse(params)?;
            let store = hosts.store.clone();
            block(move || app_state::set(&store, key, value)).await?;
            Ok(Value::Null)
        }
        "state_delete" => {
            let Key { key } = parse(params)?;
            let store = hosts.store.clone();
            block(move || app_state::delete(&store, key)).await?;
            Ok(Value::Null)
        }
        "list_project_files" => {
            let ListProjectFiles { cwd } = parse(params)?;
            json(block(move || files::list(&cwd)).await?)
        }
        "list_folder" => {
            let PathArg { path } = parse(params)?;
            json(block(move || files::list_folder(&path)).await?)
        }
        "search_files" => {
            let request: proto::SearchFiles = parse(params)?;
            json(block(move || file_search::search(&request)).await?)
        }
        "worktree_list" => {
            let PathArg { path } = parse(params)?;
            json(block(move || Ok::<_, String>(worktree::list(&path))).await?)
        }
        "worktree_add" => {
            let WorktreeAdd { path, branch } = parse(params)?;
            json(block(move || worktree::add(&path, &branch)).await?)
        }
        "worktree_remove" => {
            let WorktreeRemove { path, force } = parse(params)?;
            let store = hosts.store.clone();
            let processes = hosts.processes.clone();
            let doomed = block(move || {
                // Before git: a dev server still writing into it could leave
                // files behind that make the removal refuse.
                processes.forget_worktree(&path);
                let listed = worktree::remove(&path, force)?;
                if listed != path {
                    processes.forget_worktree(&listed);
                }
                // Stored as the window had it, which is how git lists it; the
                // path asked for is looked up too, in case they differ.
                let mut ids = session::in_worktree(&store, &listed)?;
                if listed != path {
                    ids.extend(session::in_worktree(&store, &path)?);
                }
                Ok::<_, String>(ids)
            })
            .await?;
            for id in doomed {
                delete_session(hosts, id).await?;
            }
            Ok(Value::Null)
        }
        "read_text_file" => {
            let PathArg { path } = parse(params)?;
            json(block(move || files::read_text(&path)).await?)
        }
        "write_text_file" => {
            let PathContents { path, contents } = parse(params)?;
            block(move || files::write_text(&path, &contents)).await?;
            Ok(Value::Null)
        }
        "path_exists" => {
            let PathArg { path } = parse(params)?;
            Ok(Value::from(files::exists(&path)))
        }
        "path_is_file" => {
            let PathArg { path } = parse(params)?;
            Ok(Value::from(files::is_file(&path)))
        }
        "read_file_base64" => {
            let PathArg { path } = parse(params)?;
            json(block(move || files::read_base64(&path)).await?)
        }
        "create_file_base64" => {
            let PathBytes { path, base64_contents } = parse(params)?;
            block(move || files::create_base64(&path, &base64_contents)).await?;
            Ok(Value::Null)
        }
        "write_temp_file" => {
            let TempFile { extension, base64_contents } = parse(params)?;
            json(block(move || files::write_temp(&extension, &base64_contents)).await?)
        }
        "ping" => Ok(Value::Null),
        "remote_list" => {
            let store = hosts.store.clone();
            json(block(move || remote::list(&store)).await?)
        }
        "remote_upsert" => {
            let env: RemoteEnv = parse(params)?;
            let store = hosts.store.clone();
            json(block(move || remote::upsert(&store, env)).await?)
        }
        "remote_delete" => {
            let Id { id } = parse(params)?;
            let store = hosts.store.clone();
            block(move || remote::delete(&store, &id)).await?;
            Ok(Value::Null)
        }
        "daemon_info" => {
            let store = hosts.store.clone();
            let socks_port = hosts.socks_port;
            let mut info = block(move || Ok(machine::info(session::list_busy(&store)?.len() as u32))).await?;
            if socks_port != 0 {
                info.socks_port = Some(socks_port);
            }
            json(info)
        }
        "dir_list" => {
            let proto::DirList { path } = parse(params)?;
            json(block(move || machine::dir_list(&path)).await?)
        }
        "agent_resolve_claude" => json(block(AgentHost::resolve_claude).await?),
        "agent_resolve" => {
            let Name { name } = parse(params)?;
            json(block(move || AgentHost::resolve(&name)).await?)
        }
        "agent_installed" => {
            let Names { names } = parse(params)?;
            json(block(move || Ok::<_, String>(AgentHost::installed(names))).await?)
        }
        "turn_start" => {
            let p: TurnStart = parse(params)?;
            if let Some(nonce) = p.nonce.clone() {
                let store = hosts.store.clone();
                let session_id = p.session_id.clone();
                let accepted = block(move || {
                    let fresh = messages::claim_nonce(&store, &session_id, &nonce)?;
                    if fresh {
                        return Ok(None);
                    }
                    // A retry of a send that already landed. Answer with the
                    // state the first one produced instead of running it twice.
                    let working = session::get(&store, session_id)?
                        .is_some_and(|row| row.status == "working" || row.status == "needs-input");
                    Ok(Some(TurnStarted { working }))
                })
                .await?;
                if let Some(started) = accepted {
                    return json(started);
                }
            }
            let turns = hosts.turns.clone();
            let store = hosts.store.clone();
            let claimed = p.nonce.clone().map(|nonce| (p.session_id.clone(), nonce));
            // The window's own: a letter id is the daemon's to give.
            let started = block(move || turns.start_by_user(p)).await;
            if started.is_err() {
                // The send was refused, so the id must not count as spent: the
                // retry has to run, not be answered with the turn that never was.
                if let Some((session_id, nonce)) = claimed {
                    let store = store.clone();
                    let _ = block(move || messages::release_nonce(&store, &session_id, &nonce)).await;
                }
            }
            json(started?)
        }
        "background_list" => {
            let SessionId { session_id } = parse(params)?;
            json(hosts.turns.background_list(&session_id))
        }
        "background_output" => {
            let proto::BackgroundRequest { session_id, id } = parse(params)?;
            let turns = hosts.turns.clone();
            json(block(move || turns.background_output(&session_id, &id)).await?)
        }
        "background_stop" => {
            let proto::BackgroundRequest { session_id, id } = parse(params)?;
            let turns = hosts.turns.clone();
            block(move || turns.background_stop(&session_id, &id)).await?;
            Ok(Value::Null)
        }
        "turn_stop" => {
            let SessionId { session_id } = parse(params)?;
            let turns = hosts.turns.clone();
            block(move || turns.stop(&session_id)).await?;
            Ok(Value::Null)
        }
        "turn_respond" => {
            let TurnRespond { session_id, request_id, decision } = parse(params)?;
            let turns = hosts.turns.clone();
            block(move || turns.respond(&session_id, request_id, decision)).await?;
            Ok(Value::Null)
        }
        "turn_answer" => {
            let TurnAnswer { session_id, request_id, answers } = parse(params)?;
            let turns = hosts.turns.clone();
            block(move || turns.answer(&session_id, request_id, answers)).await?;
            Ok(Value::Null)
        }
        "transcript_tail" => {
            let TranscriptTail { session_id, limit, before_pos } = parse(params)?;
            let turns = hosts.turns.clone();
            json(block(move || Ok(turns.transcripts().window(&session_id, limit, before_pos))).await?)
        }
        "messages_search" => {
            let query: SearchQuery = parse(params)?;
            let store = hosts.store.clone();
            json(block(move || messages::search(&store, query)).await?)
        }
        "browser_history_visit" => {
            let proto::HistoryVisit { url, title, workspace_id } = parse(params)?;
            let store = hosts.store.clone();
            let now = app_state::now_millis();
            block(move || crew_core::browser::visit(&store, &url, &title, workspace_id.as_deref(), now)).await?;
            Ok(Value::Null)
        }
        "browser_history_title" => {
            let proto::HistoryTitle { url, title } = parse(params)?;
            let store = hosts.store.clone();
            block(move || crew_core::browser::set_title(&store, &url, &title)).await?;
            Ok(Value::Null)
        }
        "browser_history_suggest" => {
            let proto::HistorySuggest { text, limit } = parse(params)?;
            let store = hosts.store.clone();
            let now = app_state::now_millis();
            json(block(move || crew_core::browser::suggest(&store, &text, limit, now)).await?)
        }
        "browser_history_list" => {
            let proto::HistoryList { text, before, limit } = parse(params)?;
            let store = hosts.store.clone();
            json(block(move || crew_core::browser::list(&store, text.as_deref(), before, limit)).await?)
        }
        "browser_history_delete" => {
            let proto::UrlKey { url_key } = parse(params)?;
            let store = hosts.store.clone();
            block(move || crew_core::browser::delete(&store, &url_key)).await?;
            Ok(Value::Null)
        }
        "browser_history_clear" => {
            let proto::HistoryClear { since } = parse(params)?;
            let store = hosts.store.clone();
            block(move || crew_core::browser::clear(&store, since)).await?;
            Ok(Value::Null)
        }
        "browser_page_save" => {
            let proto::PageSave { page_id, entries_json, active_index } = parse(params)?;
            let store = hosts.store.clone();
            let now = app_state::now_millis();
            block(move || crew_core::browser::page_save(&store, &page_id, &entries_json, active_index, now)).await?;
            Ok(Value::Null)
        }
        "browser_page_get" => {
            let proto::PageId { page_id } = parse(params)?;
            let store = hosts.store.clone();
            json(block(move || crew_core::browser::page_get(&store, &page_id)).await?)
        }
        "browser_page_delete" => {
            let proto::PageId { page_id } = parse(params)?;
            let store = hosts.store.clone();
            block(move || crew_core::browser::page_delete(&store, &page_id)).await?;
            Ok(Value::Null)
        }
        // "Quit Crew and Stop Everything". Answered before the daemon goes, so
        // the window hears it was heard.
        "daemon_shutdown" => {
            let _ = hosts.exit.send(());
            Ok(Value::Null)
        }
        "browser_leases_list" => json(hosts.browser.leases().list(app_state::now_millis())),
        // The user takes a tab back from the agent driving it.
        "browser_lease_release" => {
            let proto::BrowserTabArg { tab } = parse(params)?;
            hosts.browser.leases().force_release(&tab, app_state::now_millis());
            Ok(Value::Null)
        }
        // The user closed a tab: no agent's next call may bring it back.
        "browser_tab_closed" => {
            let proto::BrowserTabArg { tab } = parse(params)?;
            hosts.browser.tab_closed(&tab);
            Ok(Value::Null)
        }
        "browser_tool" => {
            let proto::BrowserToolRun { workspace_id, tool, args } = parse(params)?;
            let browser = hosts.browser.clone();
            block(move || browser.call(&workspace_id, &Holder::user(), &tool, &args)).await
        }
        "browser_cookie_sources" => json(block(|| Ok(crew_core::cookie_import::sources())).await?),
        "browser_cookies_read" => {
            let proto::CookieSourceId { source_id } = parse(params)?;
            json(block(move || crew_core::cookie_import::read(&source_id)).await?)
        }
        method if method.starts_with("process_") => process_rpc(hosts, method, params).await,
        _ => Err(format!("Unknown method: {method}")),
    }
}

/// The window's side of the process manager. It is the user at the keyboard:
/// nothing it writes waits for approval, and `created_by` stays empty.
async fn process_rpc(hosts: &Hosts, method: &str, params: Value) -> Result<Value, String> {
    let host = hosts.processes.clone();
    match method {
        "process_list" => {
            let WorkspaceId { workspace_id } = parse(params)?;
            json(block(move || host.list(&workspace_id)).await?)
        }
        "process_create" => {
            let proto::ProcessCreate { workspace_id, name, command, cwd, env, auto_restart } = parse(params)?;
            let spec = proto::ProcessSpec {
                name,
                command,
                cwd: cwd.unwrap_or_default(),
                env: env.unwrap_or_default(),
                auto_restart,
            };
            json(block(move || host.create(&workspace_id, spec, None, false)).await?)
        }
        "process_update" => {
            let proto::ProcessUpdate { workspace_id, id, name, command, cwd, env, auto_restart } = parse(params)?;
            let patch = ProcessPatch { name, command, cwd, env, auto_restart };
            json(block(move || host.update(&workspace_id, &id, patch, None, false)).await?)
        }
        "process_reorder" => {
            let proto::ProcessReorder { workspace_id, ids } = parse(params)?;
            block(move || host.reorder(&workspace_id, &ids)).await?;
            Ok(Value::Null)
        }
        "process_log_tail" => {
            let proto::ProcessLogTail { workspace_id, id, worktree, max_bytes } = parse(params)?;
            json(block(move || host.log_tail_raw(&workspace_id, &id, worktree.as_deref(), max_bytes)).await?)
        }
        "process_approve" => {
            let proto::ProcessApprove { workspace_id, id, revision } = parse(params)?;
            json(block(move || host.approve(&workspace_id, &id, revision)).await?)
        }
        // The window is the user: what it starts, nobody's session started.
        "process_start" | "process_restart" => {
            let proto::ProcessStart { workspace_id, id, worktree, env } = parse(params)?;
            let request = RunRequest { worktree, env, started_by: None };
            let restart = method == "process_restart";
            block(move || {
                json(if restart {
                    host.restart(&workspace_id, &id, request)?
                } else {
                    host.start(&workspace_id, &id, request)?
                })
            })
            .await
        }
        _ => {
            let proto::ProcessRef { workspace_id, id, worktree } = parse(params)?;
            let method = method.to_string();
            block(move || match method.as_str() {
                "process_delete" => host.delete(&workspace_id, &id).map(|()| Value::Null),
                "process_stop" => json(host.stop(&workspace_id, &id, worktree.as_deref())?),
                "process_pause" => json(host.pause(&workspace_id, &id, worktree.as_deref())?),
                "process_resume" => json(host.resume(&workspace_id, &id, worktree.as_deref())?),
                "process_reject" => json(host.reject(&workspace_id, &id)?),
                other => Err(format!("Unknown method: {other}")),
            })
            .await
        }
    }
}

fn parse<T: for<'de> Deserialize<'de>>(params: Value) -> Result<T, String> {
    serde_json::from_value(params).map_err(|e| e.to_string())
}

fn encode(value: &impl serde::Serialize) -> String {
    serde_json::to_string(value).unwrap_or_else(|_| r#"{"id":0,"ok":false,"error":"encode"}"#.into())
}

pub fn random_token() -> String {
    let mut bytes = [0u8; 16];
    rand::fill(&mut bytes);
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crew_core::store::Store;
    use futures_util::{SinkExt, StreamExt};
    use tokio_tungstenite::connect_async;
    use tokio_tungstenite::WebSocketStream;

    type Ws = WebSocketStream<tokio_tungstenite::MaybeTlsStream<TcpStream>>;

    fn test_dir(name: &str) -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!("crewd-{name}-{}", std::process::id()));
        let _ = std::fs::create_dir_all(&dir);
        dir
    }

    fn test_serve(dir: &std::path::Path) -> Handle {
        test_serve_bridged(dir).0
    }

    /// The bridge too, for a test that has to hold a session's token. Nothing
    /// hands one out over the wire: it is minted when a turn starts, and a test
    /// that never runs a turn has to ask the bridge itself.
    fn test_serve_bridged(dir: &std::path::Path) -> (Handle, Bridge) {
        let bridge = Bridge::start(dir.to_path_buf()).expect("bridge");
        let pty = PtyHost::new();
        let store = Store::open(dir.join("crew.sqlite3")).expect("store");
        let handle = serve(Config {
            processes: ProcessHost::new(store.clone(), pty.clone(), dir),
            pty,
            store,
            agents: AgentHost::new(),
            bridge: bridge.clone(),
        })
        .expect("serve");
        (handle, bridge)
    }

    async fn connect_authed(handle: &Handle) -> Ws {
        let (mut ws, _) = connect_async(handle.url()).await.expect("connect");
        ws.send(Message::Text(
            serde_json::to_string(&Auth {
                auth: handle.token().to_string(),
            })
            .unwrap()
            .into(),
        ))
        .await
        .expect("auth");
        ws
    }

    fn spawn_req(id: u32, pty: &str) -> Request {
        Request {
            id,
            method: "pty_spawn".into(),
            params: serde_json::to_value(PtySpawn {
                id: pty.into(),
                cwd: std::env::temp_dir().to_string_lossy().into_owned(),
                command: vec!["/bin/sh".into()],
                cols: 80,
                rows: 24,
                session: None,
                reuse: None,
                dark: None,
            })
            .unwrap(),
        }
    }

    async fn send_json(ws: &mut Ws, value: &impl serde::Serialize) {
        ws.send(Message::Text(serde_json::to_string(value).unwrap().into()))
            .await
            .expect("send");
    }

    #[tokio::test]
    async fn pty_echoes_hi_over_the_stream() {
        let dir = test_dir("pty");
        let handle = test_serve(&dir);
        let mut ws = connect_authed(&handle).await;
        send_json(&mut ws, &spawn_req(1, "t")).await;

        let stream_id = wait_response(&mut ws, 1).await.result.and_then(|v| v.as_u64()).expect("stream") as u32;
        let attached = attach_pty(&mut ws, 2, "t", 0).await;
        assert_eq!(attached.start, 0);
        let mut frame = Vec::from(stream_id.to_le_bytes());
        frame.extend_from_slice(b"echo hi\n");
        ws.send(Message::Binary(frame.into())).await.expect("write");

        let output = wait_bytes(&mut ws, b"hi").await;
        assert!(output.windows(2).any(|w| w == b"hi"), "output: {output:?}");
        handle.shutdown();
    }

    /// A window watching one terminal gets that terminal's frames and no
    /// other's: bytes from a stream it has not attached would be painted as
    /// the start of that stream once it did.
    #[tokio::test(flavor = "multi_thread")]
    async fn pty_frames_go_only_to_clients_attached_to_that_stream() {
        let dir = test_dir("pty-route");
        let handle = test_serve(&dir);
        let mut quiet = connect_authed(&handle).await;
        send_json(&mut quiet, &spawn_req(1, "mine")).await;
        let mine = wait_response(&mut quiet, 1).await.result.and_then(|v| v.as_u64()).expect("stream") as u32;
        attach_pty(&mut quiet, 2, "mine", 0).await;

        let mut busy = connect_authed(&handle).await;
        send_json(&mut busy, &spawn_req(1, "theirs")).await;
        let theirs = wait_response(&mut busy, 1).await.result.and_then(|v| v.as_u64()).expect("stream") as u32;
        attach_pty(&mut busy, 2, "theirs", 0).await;
        let mut frame = Vec::from(theirs.to_le_bytes());
        frame.extend_from_slice(b"echo from-theirs\n");
        busy.send(Message::Binary(frame.into())).await.expect("write");
        wait_bytes(&mut busy, b"from-theirs").await;

        let deadline = tokio::time::Instant::now() + std::time::Duration::from_millis(500);
        while let Ok(Some(Ok(msg))) = tokio::time::timeout_at(deadline, quiet.next()).await {
            if let Message::Binary(bytes) = msg {
                let stream = u32::from_le_bytes(bytes[..4].try_into().unwrap());
                assert_eq!(stream, mine, "a frame of a stream this client never attached");
            }
        }
        handle.shutdown();
    }

    /// A window that remounts a terminal sends kill and spawn back to back
    /// without waiting; the new process has to survive the kill sent before it.
    #[tokio::test]
    async fn a_respawn_sent_right_after_a_kill_survives_it() {
        let dir = test_dir("respawn-order");
        let handle = test_serve(&dir);
        let mut ws = connect_authed(&handle).await;
        for round in 0..20u32 {
            let pty = format!("t{round}");
            let req = round * 10;
            send_json(&mut ws, &spawn_req(req + 1, &pty)).await;
            send_json(
                &mut ws,
                &Request {
                    id: req + 2,
                    method: "pty_kill".into(),
                    params: serde_json::json!({ "id": pty }),
                },
            )
            .await;
            send_json(&mut ws, &spawn_req(req + 3, &pty)).await;
            let respawn = wait_response(&mut ws, req + 3).await;
            assert!(respawn.ok, "{}", respawn.error.unwrap_or_default());
            let attach = Request {
                id: req + 4,
                method: "pty_attach".into(),
                params: serde_json::json!({ "id": pty, "from": 0 }),
            };
            send_json(&mut ws, &attach).await;
            let attached = wait_response(&mut ws, req + 4).await;
            assert!(attached.ok, "round {round}: the respawned terminal is gone: {}", attached.error.unwrap_or_default());
        }
        handle.shutdown();
    }

    #[tokio::test]
    async fn slow_rpc_does_not_delay_pty_ack() {
        let dir = test_dir("slow-rpc");
        let handle = test_serve(&dir);
        let mut ws = connect_authed(&handle).await;
        send_json(&mut ws, &spawn_req(1, "t")).await;
        let spawn = wait_response(&mut ws, 1).await;
        assert!(spawn.ok, "{}", spawn.error.unwrap_or_default());

        let fifo = dir.join("block");
        assert!(
            std::process::Command::new("mkfifo")
                .arg(&fifo)
                .status()
                .expect("mkfifo")
                .success()
        );

        send_json(
            &mut ws,
            &Request {
                id: 2,
                method: "read_text_file".into(),
                params: serde_json::json!({ "path": fifo }),
            },
        )
        .await;
        send_json(
            &mut ws,
            &Request {
                id: 3,
                method: "pty_ack".into(),
                params: serde_json::json!({ "id": "t", "processed": 0 }),
            },
        )
        .await;

        let first = wait_one_of(&mut ws, &[2, 3]).await;
        assert_eq!(first.id, 3, "pty_ack must finish while read_text_file is blocked");
        assert!(first.ok, "{}", first.error.unwrap_or_default());

        std::fs::write(&fifo, "ok").expect("unblock");
        let slow = wait_response(&mut ws, 2).await;
        assert!(slow.ok, "{}", slow.error.unwrap_or_default());
        handle.shutdown();
    }

    #[tokio::test]
    async fn ping_is_answered_with_a_pong() {
        let dir = test_dir("ping");
        let handle = test_serve(&dir);
        let mut ws = connect_authed(&handle).await;
        ws.send(Message::Ping(b"crew".to_vec().into()))
            .await
            .expect("ping");
        let deadline = tokio::time::Instant::now() + std::time::Duration::from_secs(2);
        loop {
            let msg = tokio::time::timeout_at(deadline, ws.next())
                .await
                .expect("pong timeout")
                .expect("closed")
                .expect("ws");
            if let Message::Pong(payload) = msg {
                assert_eq!(payload.as_ref(), b"crew");
                handle.shutdown();
                return;
            }
        }
    }

    #[tokio::test]
    async fn pty_attach_after_wrap_keeps_flow_control() {
        let dir = test_dir("pty-wrap");
        let handle = test_serve(&dir);
        let mut ws = connect_authed(&handle).await;
        send_json(
            &mut ws,
            &Request {
                id: 1,
                method: "pty_spawn".into(),
                params: serde_json::to_value(PtySpawn {
                    id: "t".into(),
                    cwd: std::env::temp_dir().to_string_lossy().into_owned(),
                    command: vec!["/usr/bin/yes".into()],
                    cols: 80,
                    rows: 24,
                    session: None,
                    reuse: None,
                    dark: None,
                })
                .unwrap(),
            },
        )
        .await;
        let spawn = wait_response(&mut ws, 1).await;
        assert!(spawn.ok, "{}", spawn.error.unwrap_or_default());
        attach_pty(&mut ws, 2, "t", 0).await;
        drain_and_ack(&mut ws, "t", 10, 300 * 1024).await;
        drop(ws);
        tokio::time::sleep(std::time::Duration::from_millis(400)).await;

        let mut ws = connect_authed(&handle).await;
        let attached = attach_pty(&mut ws, 1, "t", 1000).await;
        assert!(attached.start > 1000, "start={} from=1000", attached.start);
        assert!(attached.emitted >= attached.start);

        let replay = next_binary(&mut ws).await;
        assert_eq!(replay.len() as u64, attached.emitted - attached.start);

        // Acking what it is sent, as xterm does, the window gets more: the
        // reader refills. What was flushed as the attach ran is acked too.
        let mut processed = attached.start + replay.len() as u64;
        let mut refilled = 0u64;
        let mut req = 2;
        let deadline = tokio::time::Instant::now() + std::time::Duration::from_secs(10);
        while refilled < 128 * 1024 {
            send_json(
                &mut ws,
                &Request {
                    id: req,
                    method: "pty_ack".into(),
                    params: serde_json::json!({ "id": "t", "processed": processed }),
                },
            )
            .await;
            req += 1;
            let msg = tokio::time::timeout_at(deadline, ws.next())
                .await
                .expect("reader did not refill the window")
                .expect("closed")
                .expect("ws");
            if let Message::Binary(bytes) = msg {
                let n = bytes.len().saturating_sub(4) as u64;
                refilled += n;
                processed += n;
            }
        }

        // And once it stops acking, it is held to the window again.
        let extra = collect_bytes(&mut ws, std::time::Duration::from_secs(1)).await;
        assert!(
            extra <= 256 * 1024 + 64 * 1024,
            "flow control disabled: extra={extra}"
        );
        handle.shutdown();
    }

    // The window closes, or its Mac sleeps, while a CLI works: the CLI goes on
    // instead of stopping at the credit that window will never give.
    #[tokio::test]
    async fn a_terminal_runs_on_once_its_window_is_gone() {
        let dir = test_dir("pty-unwatched");
        let handle = test_serve(&dir);
        let mut ws = connect_authed(&handle).await;
        let params = serde_json::to_value(PtySpawn {
            id: "t".into(),
            cwd: std::env::temp_dir().to_string_lossy().into_owned(),
            command: vec!["/usr/bin/yes".into()],
            cols: 80,
            rows: 24,
            session: None,
            reuse: None,
            dark: None,
        })
        .unwrap();
        let spawn = rpc(&mut ws, 1, "pty_spawn", params).await;
        assert!(spawn.ok, "{}", spawn.error.unwrap_or_default());
        // Watched and never acked: held at the window's limit.
        attach_pty(&mut ws, 2, "t", 0).await;
        tokio::time::sleep(std::time::Duration::from_millis(600)).await;
        drop(ws);
        tokio::time::sleep(std::time::Duration::from_millis(800)).await;

        let mut ws = connect_authed(&handle).await;
        let attached = attach_pty(&mut ws, 1, "t", 0).await;
        assert!(
            attached.emitted > 1024 * 1024,
            "the terminal stopped once its window went: emitted={}",
            attached.emitted
        );
        handle.shutdown();
    }

    #[tokio::test]
    async fn pty_attach_during_flood_is_ordered() {
        let dir = test_dir("pty-live-attach");
        let handle = test_serve(&dir);
        let mut producer = connect_authed(&handle).await;
        send_json(
            &mut producer,
            &Request {
                id: 1,
                method: "pty_spawn".into(),
                params: serde_json::to_value(PtySpawn {
                    id: "t".into(),
                    cwd: std::env::temp_dir().to_string_lossy().into_owned(),
                    command: vec![
                        "/usr/bin/python3".into(),
                        "-c".into(),
                        "import sys\ni=0\nwhile True:\n    sys.stdout.buffer.write(bytes([48+(i%10)])); i+=1\n    if i&4095==0: sys.stdout.flush()".into(),
                    ],
                    cols: 80,
                    rows: 24,
                    session: None,
                    reuse: None,
                    dark: None,
                })
                .unwrap(),
            },
        )
        .await;
        let spawn = wait_response(&mut producer, 1).await;
        assert!(spawn.ok, "{}", spawn.error.unwrap_or_default());
        attach_pty(&mut producer, 2, "t", 0).await;
        let producer_ack = tokio::spawn(async move {
            ack_forever(&mut producer, "t", 100).await;
        });
        tokio::time::sleep(std::time::Duration::from_millis(80)).await;

        let mut ws = connect_authed(&handle).await;
        let attached = attach_pty(&mut ws, 1, "t", 0).await;
        let mut bytes = Vec::new();
        let mut processed = attached.start;
        let mut req = 2u32;
        let deadline = tokio::time::Instant::now() + std::time::Duration::from_secs(5);
        while bytes.len() < 64 * 1024 {
            let msg = tokio::time::timeout_at(deadline, ws.next())
                .await
                .expect("counter timeout")
                .expect("closed")
                .expect("ws");
            if let Message::Binary(frame) = msg {
                if frame.len() >= 4 {
                    let chunk = &frame[4..];
                    bytes.extend_from_slice(chunk);
                    processed += chunk.len() as u64;
                    req += 1;
                    send_json(
                        &mut ws,
                        &Request {
                            id: req,
                            method: "pty_ack".into(),
                            params: serde_json::json!({ "id": "t", "processed": processed }),
                        },
                    )
                    .await;
                }
            }
        }
        assert_digit_run(&bytes);
        handle.shutdown();
        drop(producer_ack);
    }

    #[tokio::test]
    async fn list_peers_runs_without_a_window() {
        let dir = test_dir("tool-headless");
        let (handle, bridge) = test_serve_bridged(&dir);
        let mut ws = connect_authed(&handle).await;
        let session_id = seed_bot(&mut ws, dir.to_str().unwrap()).await;
        let info = bridge.info().expect("info");
        drop(ws);
        let payload = serde_json::json!({
            "token": bridge.mint(&session_id),
            "method": "tools/call",
            "params": { "name": "list_peers", "arguments": {} }
        });
        let reply = unix_call(&info.socket_path, &payload);
        let text = reply["result"]["content"][0]["text"].as_str().unwrap_or("");
        // Nobody else is here: the bot is not its own peer.
        assert!(reply["result"]["isError"].is_null() && text == "[]", "reply: {reply}");
        handle.shutdown();
    }

    /// `crew daemon stop` speaks as the user; an agent that could stop the
    /// daemon would stop every other session with it. The window asks over
    /// its own socket. Either only asks: the request lands where `main` waits.
    #[tokio::test]
    async fn only_the_user_and_the_window_can_ask_the_daemon_to_stop() {
        let dir = test_dir("shutdown");
        let (handle, bridge) = test_serve_bridged(&dir);
        let requests = handle.exit_requests().expect("requests");
        assert!(handle.exit_requests().is_none(), "taken once");
        let mut ws = connect_authed(&handle).await;
        let bot = seed_bot(&mut ws, dir.to_str().unwrap()).await;
        let socket = bridge.info().expect("info").socket_path;

        let refused = unix_call(&socket, &serde_json::json!({ "token": bridge.mint(&bot), "method": "daemon/shutdown" }));
        assert!(refused["error"].as_str().is_some_and(|e| e.contains("Only the user")), "{refused}");
        assert!(requests.try_recv().is_err(), "a bot asked and was heard");

        let asked = unix_call(&socket, &serde_json::json!({ "token": bridge.user_token(), "method": "daemon/shutdown" }));
        assert!(asked.get("error").is_none(), "{asked}");
        requests.recv_timeout(Duration::from_secs(2)).expect("the user's request");

        let reply = rpc(&mut ws, 900, "daemon_shutdown", serde_json::json!({})).await;
        assert!(reply.ok, "{:?}", reply.error);
        requests.recv_timeout(Duration::from_secs(2)).expect("the window's request");
        handle.shutdown();
    }

    /// The token is the identity. An agent's shell inherits CREW_SOCKET and
    /// CREW_TOKEN, and used to be able to name any session on the request and
    /// be believed — which, with a child inheriting its creator's autonomy, is
    /// how an `ask` bot would have had a `full` one built for it.
    #[tokio::test]
    async fn a_token_speaks_only_for_the_session_it_was_minted_for() {
        let dir = test_dir("tool-identity");
        let (handle, bridge) = test_serve_bridged(&dir);
        let mut ws = connect_authed(&handle).await;
        let mine = seed_bot(&mut ws, dir.to_str().unwrap()).await;
        let info = bridge.info().expect("info");
        drop(ws);

        // The old shape of the request, with somebody else's id on it.
        let forged = serde_json::json!({
            "token": bridge.mint(&mine),
            "sessionId": "somebody-else",
            "method": "whoami",
        });
        let reply = unix_call(&info.socket_path, &forged);
        assert_eq!(reply["result"]["sessionId"].as_str(), Some(mine.as_str()), "the id on the wire was believed: {reply}");

        // And a token nobody minted is nobody.
        let stranger = serde_json::json!({
            "token": "not-a-token-anybody-minted",
            "method": "tools/call",
            "params": { "name": "list_peers", "arguments": {} }
        });
        let reply = unix_call(&info.socket_path, &stranger);
        assert_eq!(reply["error"].as_str(), Some("Bad token"), "reply: {reply}");
        handle.shutdown();
    }

    #[tokio::test]
    async fn create_bot_emits_session_created() {
        let dir = test_dir("tool-created");
        let (handle, bridge) = test_serve_bridged(&dir);
        let mut ws = connect_authed(&handle).await;
        let session_id = seed_bot(&mut ws, dir.to_str().unwrap()).await;
        let info = bridge.info().expect("info");
        let payload = serde_json::json!({
            "token": bridge.mint(&session_id),
            "method": "tools/call",
            "params": { "name": "create_bot", "arguments": { "name": "B", "description": "does B" } }
        });
        let reply = unix_call(&info.socket_path, &payload);
        let text = reply["result"]["content"][0]["text"].as_str().unwrap_or("");
        assert!(text.contains("\"name\": \"B\"") || text.contains("\"name\":\"B\""), "reply: {reply}");
        let event = wait_event(&mut ws, "session-created").await;
        let created: proto::SessionCreated = serde_json::from_value(event.payload).expect("created");
        assert_eq!(created.session.name, "B");
        handle.shutdown();
    }

    /// The bot sheet shows the row the window loaded; a description the bot
    /// rewrote reaches it as `session-updated`, from this daemon or a remote one.
    #[tokio::test]
    async fn update_description_emits_session_updated() {
        let dir = test_dir("tool-description");
        let (handle, bridge) = test_serve_bridged(&dir);
        let mut ws = connect_authed(&handle).await;
        let session_id = seed_bot(&mut ws, dir.to_str().unwrap()).await;
        let info = bridge.info().expect("info");
        let payload = serde_json::json!({
            "token": bridge.mint(&session_id),
            "method": "tools/call",
            "params": { "name": "update_description", "arguments": { "text": "You keep the notes." } }
        });
        let reply = unix_call(&info.socket_path, &payload);
        assert!(reply["result"]["isError"].as_bool() != Some(true), "reply: {reply}");
        let event = wait_event(&mut ws, "session-updated").await;
        let updated: proto::SessionUpdated = serde_json::from_value(event.payload).expect("updated");
        assert_eq!((updated.session.id.as_str(), updated.session.description.as_str()), (session_id.as_str(), "You keep the notes."));
        handle.shutdown();
    }

    /// A workspace with one bot and one terminal session in it.
    async fn seed_terminal(ws: &mut Ws, cwd: &str) -> (String, String, String) {
        let workspace: proto::Workspace = serde_json::from_value(
            rpc(ws, 1, "workspace_create", serde_json::json!({ "name": "w", "path": cwd })).await.result.expect("ws"),
        )
        .expect("workspace");
        let mut ids = Vec::new();
        for (id, kind) in [(2, "bot"), (3, "terminal")] {
            let session: proto::Session = serde_json::from_value(
                rpc(
                    ws,
                    id,
                    "session_create",
                    serde_json::json!({
                        "workspaceId": workspace.id,
                        "kind": kind,
                        "name": kind,
                        "provider": "claude",
                        "model": "",
                        "description": "",
                        "autonomy": "ask"
                    }),
                )
                .await
                .result
                .expect("session"),
            )
            .expect("session");
            ids.push(session.id);
        }
        (workspace.id, ids.remove(0), ids.remove(0))
    }

    fn list_peers_as(socket: &str, token: &str) -> serde_json::Value {
        unix_call(
            socket,
            &serde_json::json!({
                "token": token,
                "method": "tools/call",
                "params": { "name": "list_peers", "arguments": {} }
            }),
        )
    }

    /// The whole of decision 1: a terminal session's process is handed a token
    /// of its own, calls with it as that session, and the token goes when the
    /// process does.
    #[tokio::test]
    async fn a_terminal_session_reaches_the_tools_until_its_process_exits() {
        let dir = test_dir("terminal-bridge");
        let (handle, bridge) = test_serve_bridged(&dir);
        let mut ws = connect_authed(&handle).await;
        let cwd = dir.to_string_lossy().into_owned();
        let (_, bot, terminal) = seed_terminal(&mut ws, &cwd).await;
        let token_file = dir.join(format!("token-{}", random_token()));
        let done = dir.join(format!("done-{}", random_token()));
        let script = format!(
            "printf %s \"$CREW_TOKEN\" > '{0}.tmp' && mv '{0}.tmp' '{0}'; while [ ! -e '{1}' ]; do sleep 0.05; done",
            token_file.display(),
            done.display()
        );
        let spawned = rpc(
            &mut ws,
            4,
            "pty_spawn",
            serde_json::to_value(PtySpawn {
                id: format!("pane-{}", random_token()),
                cwd: cwd.clone(),
                command: vec!["/bin/sh".into(), "-c".into(), script],
                cols: 80,
                rows: 24,
                session: Some(terminal.clone()),
                reuse: None,
                dark: None,
            })
            .unwrap(),
        )
        .await;
        assert!(spawned.ok, "{:?}", spawned.error);

        let deadline = std::time::Instant::now() + Duration::from_secs(10);
        let token = loop {
            if let Ok(token) = std::fs::read_to_string(&token_file) {
                break token;
            }
            assert!(std::time::Instant::now() < deadline, "the process never saw a token");
            tokio::time::sleep(Duration::from_millis(50)).await;
        };
        assert!(!token.is_empty(), "CREW_TOKEN was empty");

        let socket = bridge.info().expect("info").socket_path;
        let reply = list_peers_as(&socket, &token);
        let text = reply["result"]["content"][0]["text"].as_str().unwrap_or("");
        assert!(text.contains(&bot), "reply: {reply}");
        // Seen as a terminal: every tool it may call is listed, nothing to
        // continue turns with, and no gateway.
        let listed = unix_call(&socket, &serde_json::json!({ "token": token, "method": "tools/list" }));
        let names = listed["result"]["tools"].to_string();
        assert!(names.contains("send_message") && names.contains("start_session") && names.contains("read_logs"), "{names}");
        assert!(!names.contains("update_description") && !names.contains("find_tool"), "{names}");
        let catalog = unix_call(&socket, &serde_json::json!({ "token": token, "method": "tools/catalog" }));
        let names = catalog["result"]["tools"].to_string();
        assert!(names.contains("send_message") && !names.contains("update_description"), "{names}");

        std::fs::write(&done, "").expect("done");
        let deadline = std::time::Instant::now() + Duration::from_secs(10);
        loop {
            if list_peers_as(&socket, &token)["error"].as_str() == Some("Bad token") {
                break;
            }
            assert!(std::time::Instant::now() < deadline, "the token outlived its process");
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
        handle.shutdown();
    }

    #[tokio::test]
    async fn only_a_terminal_session_is_launched_with_a_token() {
        let dir = test_dir("terminal-kind");
        let (handle, _bridge) = test_serve_bridged(&dir);
        let mut ws = connect_authed(&handle).await;
        let cwd = dir.to_string_lossy().into_owned();
        let (_, bot, _) = seed_terminal(&mut ws, &cwd).await;
        for (id, session) in [(4, bot.as_str()), (5, "no-such-session")] {
            let spawned = rpc(
                &mut ws,
                id,
                "pty_spawn",
                serde_json::to_value(PtySpawn {
                    id: format!("pane-{}", random_token()),
                    cwd: cwd.clone(),
                    command: vec!["/bin/sh".into()],
                    cols: 80,
                    rows: 24,
                    session: Some(session.to_string()),
                    reuse: None,
                    dark: None,
                })
                .unwrap(),
            )
            .await;
            assert!(!spawned.ok, "{session} was launched as a terminal");
        }
        handle.shutdown();
    }

    /// The token in daemon.json speaks as the user, in the workspace the call
    /// names by a path inside it.
    #[tokio::test]
    async fn the_user_token_calls_in_the_workspace_it_names() {
        let dir = test_dir("user-token");
        let (handle, bridge) = test_serve_bridged(&dir);
        let mut ws = connect_authed(&handle).await;
        let cwd = dir.to_string_lossy().into_owned();
        let (workspace, bot, _) = seed_terminal(&mut ws, &cwd).await;
        let socket = bridge.info().expect("info").socket_path;
        for named in [cwd.clone(), workspace.clone()] {
            let reply = unix_call(
                &socket,
                &serde_json::json!({
                    "token": bridge.user_token(),
                    "workspace": named,
                    "method": "tools/call",
                    "params": { "name": "list_peers", "arguments": {} }
                }),
            );
            let text = reply["result"]["content"][0]["text"].as_str().unwrap_or("");
            assert!(text.contains(&bot), "{named}: {reply}");
        }
        let reply = list_peers_as(&socket, &bridge.user_token());
        let text = reply["result"]["content"][0]["text"].as_str().unwrap_or("");
        assert!(text.contains("--workspace"), "{reply}");
        handle.shutdown();
    }

    /// The process tools are registered: listed to a bot, and answering
    /// with the process the window made, in the caller's workspace.
    #[tokio::test]
    async fn list_processes_answers_over_the_bridge() {
        let dir = test_dir("process-tools");
        let (handle, bridge) = test_serve_bridged(&dir);
        let mut ws = connect_authed(&handle).await;
        let cwd = dir.to_string_lossy().into_owned();
        let (workspace, bot, _) = seed_terminal(&mut ws, &cwd).await;
        let created = rpc(
            &mut ws,
            4,
            "process_create",
            serde_json::json!({ "workspaceId": workspace, "name": "web", "command": "sleep 30" }),
        )
        .await;
        assert!(created.ok, "{:?}", created.error);
        let socket = bridge.info().expect("info").socket_path;
        let token = bridge.mint(&bot);

        let listed = unix_call(&socket, &serde_json::json!({ "token": token, "method": "tools/catalog" }));
        assert!(listed["result"]["tools"].to_string().contains("list_processes"), "{listed}");
        for (token, workspace) in [(token.clone(), None), (bridge.user_token(), Some(workspace.clone()))] {
            let reply = unix_call(
                &socket,
                &serde_json::json!({
                    "token": token,
                    "workspace": workspace,
                    "method": "tools/call",
                    "params": { "name": "list_processes", "arguments": {} }
                }),
            );
            let text = reply["result"]["content"][0]["text"].as_str().unwrap_or("");
            let rows: serde_json::Value = serde_json::from_str(text).unwrap_or_default();
            assert_eq!(rows[0]["name"], "web", "{reply}");
            assert_eq!(rows[0]["created_by"], "the user", "{reply}");
        }

        // The bot's autonomy is ask: what it writes waits for the user.
        let reply = unix_call(
            &socket,
            &serde_json::json!({
                "token": token,
                "method": "tools/call",
                "params": { "name": "save_process", "arguments": { "name": "api", "command": "sleep 30" } }
            }),
        );
        let text = reply["result"]["content"][0]["text"].as_str().unwrap_or("");
        assert!(text.contains("waiting for the user to approve it"), "{reply}");
        handle.shutdown();
    }

    #[test]
    fn daemon_json_is_private_and_goes_with_its_daemon() {
        use std::os::unix::fs::PermissionsExt;
        let dir = test_dir(&format!("daemon-file-{}", random_token()));
        let file = proto::DaemonFile {
            url: "ws://127.0.0.1:1".into(),
            token: "t".into(),
            socket: "/s".into(),
            user_token: "u".into(),
            version: "0".into(),
            pid: Some(7),
        };
        let path = write_daemon_file(&dir, &file).expect("write");
        let mode = std::fs::metadata(&path).expect("meta").permissions().mode() & 0o777;
        assert_eq!(mode, 0o600);
        let read: serde_json::Value = serde_json::from_slice(&std::fs::read(&path).expect("read")).expect("json");
        assert_eq!(read["userToken"], "u");
        assert_eq!(read["socket"], "/s");
        // Somebody else's file stays.
        remove_daemon_file(&dir, "ws://127.0.0.1:2");
        assert!(path.exists());
        remove_daemon_file(&dir, &file.url);
        assert!(!path.exists());
    }

    fn unix_call(path: &str, payload: &serde_json::Value) -> serde_json::Value {
        let mut stream = std::os::unix::net::UnixStream::connect(path).expect("unix");
        use std::io::{BufRead, Write};
        writeln!(stream, "{payload}").expect("write");
        let mut reply = String::new();
        std::io::BufReader::new(stream)
            .read_line(&mut reply)
            .expect("read");
        serde_json::from_str(&reply).expect("json")
    }

    fn write_fake_claude(dir: &std::path::Path) -> std::path::PathBuf {
        write_fake_claude_script(dir, false, false)
    }

    fn write_fake_claude_approval(dir: &std::path::Path) -> std::path::PathBuf {
        write_fake_claude_script(dir, true, false)
    }

    fn write_fake_claude_approval_tool(dir: &std::path::Path) -> std::path::PathBuf {
        write_fake_claude_script(dir, true, true)
    }

    fn write_fake_claude_script(dir: &std::path::Path, approval: bool, after_tool: bool) -> std::path::PathBuf {
        let path = dir.join(if after_tool {
            "fake-claude-approval-tool"
        } else if approval {
            "fake-claude-approval"
        } else {
            "fake-claude"
        });
        let wait_approval = if approval { "True" } else { "False" };
        let emit_tool = if after_tool { "True" } else { "False" };
        std::fs::write(
            &path,
            format!(
                r#"#!/usr/bin/env python3
import json, sys, time
WAIT_APPROVAL = {wait_approval}
EMIT_TOOL = {emit_tool}
print(json.dumps({{"type":"system","subtype":"init"}}), flush=True)
for line in sys.stdin:
    line = line.strip()
    if not line:
        continue
    try:
        rec = json.loads(line)
    except Exception:
        continue
    if rec.get("type") == "control_request":
        print(json.dumps({{"type":"control_response"}}), flush=True)
        continue
    if rec.get("type") != "user":
        continue
    if WAIT_APPROVAL:
        print(json.dumps({{
            "type": "control_request",
            "request_id": "c1",
            "request": {{"subtype": "can_use_tool", "tool_name": "Bash", "input": {{"command": "ls"}}}}
        }}), flush=True)
        for line2 in sys.stdin:
            try:
                rec2 = json.loads(line2)
            except Exception:
                continue
            if rec2.get("type") == "control_response":
                break
        if EMIT_TOOL:
            print(json.dumps({{
                "type": "stream_event",
                "event": {{
                    "type": "content_block_start",
                    "index": 0,
                    "content_block": {{"type": "tool_use", "id": "toolu_1", "name": "Bash", "input": {{"command": "ls"}}}}
                }}
            }}), flush=True)
    time.sleep(0.25)
    print(json.dumps({{"type":"stream_event","event":{{"type":"content_block_delta","delta":{{"type":"text_delta","text":"hello"}}}}}}), flush=True)
    print(json.dumps({{"type":"result","subtype":"success","usage":{{"input_tokens":1,"output_tokens":1}}}}), flush=True)
"#
            ),
        )
        .expect("fake claude");
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o755)).expect("chmod");
        path
    }

    fn write_fake_claude_hang_init(dir: &std::path::Path) -> std::path::PathBuf {
        let path = dir.join("fake-claude-hang-init");
        std::fs::write(
            &path,
            r#"#!/usr/bin/env python3
import time
time.sleep(60)
"#,
        )
        .expect("fake claude hang");
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o755)).expect("chmod");
        path
    }

    fn write_fake_claude_error(dir: &std::path::Path) -> std::path::PathBuf {
        let path = dir.join("fake-claude-error");
        std::fs::write(
            &path,
            r#"#!/usr/bin/env python3
import json, sys
print(json.dumps({"type":"system","subtype":"init"}), flush=True)
for line in sys.stdin:
    line = line.strip()
    if not line:
        continue
    try:
        rec = json.loads(line)
    except Exception:
        continue
    if rec.get("type") == "control_request":
        print(json.dumps({"type":"control_response"}), flush=True)
        continue
    if rec.get("type") != "user":
        continue
    print(json.dumps({"type":"result","subtype":"error","is_error":True,"result":"Claude exploded"}), flush=True)
"#,
        )
        .expect("fake claude error");
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o755)).expect("chmod");
        path
    }

    fn write_fake_codex_failed(dir: &std::path::Path) -> std::path::PathBuf {
        let path = dir.join("fake-codex-failed");
        std::fs::write(
            &path,
            r#"#!/usr/bin/env python3
# A `codex app-server` whose turn fails, for the paths Crew drives.
import json, sys
def out(m): print(json.dumps(m), flush=True)
for line in sys.stdin:
    m = json.loads(line)
    rid, method = m.get("id"), m.get("method")
    if rid is None:
        continue
    if method == "initialize":
        out({"id": rid, "result": {}})
    elif method == "thread/start":
        out({"id": rid, "result": {"thread": {"id": "thr-1"}}})
    elif method == "turn/start":
        out({"id": rid, "result": {"turn": {"id": "turn-1", "status": "inProgress"}}})
        out({"method": "turn/completed", "params": {"threadId": "thr-1", "turn": {"id": "turn-1", "status": "failed", "error": {"message": "Codex exploded"}}}})
"#,
        )
        .expect("fake codex");
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o755)).expect("chmod");
        path
    }

    async fn seed_bot(ws: &mut Ws, cwd: &str) -> String {
        seed_bot_provider(ws, cwd, "claude").await
    }

    async fn seed_bot_provider(ws: &mut Ws, cwd: &str, provider: &str) -> String {
        send_json(
            ws,
            &Request {
                id: 1,
                method: "workspace_create".into(),
                params: serde_json::json!({ "name": "w", "path": cwd }),
            },
        )
        .await;
        let workspace: proto::Workspace =
            serde_json::from_value(wait_response(ws, 1).await.result.expect("ws")).expect("workspace");
        send_json(
            ws,
            &Request {
                id: 2,
                method: "session_create".into(),
                params: serde_json::json!({
                    "workspaceId": workspace.id,
                    "kind": "bot",
                    "name": "A",
                    "provider": provider,
                    "model": "m",
                    "description": "",
                    "autonomy": "ask"
                }),
            },
        )
        .await;
        let session: proto::Session =
            serde_json::from_value(wait_response(ws, 2).await.result.expect("session")).expect("session");
        session.id
    }

    #[tokio::test]
    async fn turn_survives_disconnect() {
        let dir = test_dir("turn-disconnect");
        let handle = test_serve(&dir);
        let fake = write_fake_claude(&dir);
        handle.override_agent_binary("claude", fake.to_string_lossy().into_owned());
        let mut ws = connect_authed(&handle).await;
        let session_id = seed_bot(&mut ws, dir.to_str().unwrap()).await;
        send_json(
            &mut ws,
            &Request {
                id: 3,
                method: "turn_start".into(),
                params: serde_json::json!({
                    "sessionId": session_id,
                    "cwd": dir.to_string_lossy(),
                    "text": "hi"
                }),
            },
        )
        .await;
        let started = wait_response(&mut ws, 3).await;
        assert!(started.ok, "{}", started.error.unwrap_or_default());
        drop(ws);
        let mut ws = connect_authed(&handle).await;
        let deadline = tokio::time::Instant::now() + std::time::Duration::from_secs(5);
        let mut req = 1u32;
        let snap = loop {
            let snap = transcript_of(&mut ws, req, &session_id).await;
            req += 1;
            if !snap.working {
                break snap;
            }
            assert!(
                tokio::time::Instant::now() < deadline,
                "turn still working after disconnect"
            );
            tokio::time::sleep(std::time::Duration::from_millis(50)).await;
        };
        assert!(snap.blocks.iter().any(|b| b.role == proto::BlockRole::Assistant && b.text.contains("hello")));
        handle.shutdown();
    }

    #[tokio::test]
    async fn turn_respond_unblocks_approval() {
        let dir = test_dir("turn-approval");
        let handle = test_serve(&dir);
        let fake = write_fake_claude_approval(&dir);
        handle.override_agent_binary("claude", fake.to_string_lossy().into_owned());
        let mut ws = connect_authed(&handle).await;
        let session_id = seed_bot(&mut ws, dir.to_str().unwrap()).await;
        send_json(
            &mut ws,
            &Request {
                id: 3,
                method: "turn_start".into(),
                params: serde_json::json!({
                    "sessionId": session_id,
                    "cwd": dir.to_string_lossy(),
                    "text": "hi"
                }),
            },
        )
        .await;
        assert!(wait_response(&mut ws, 3).await.ok);
        let deadline = tokio::time::Instant::now() + std::time::Duration::from_secs(5);
        let mut request_id = None;
        while request_id.is_none() {
            let msg = tokio::time::timeout_at(deadline, ws.next())
                .await
                .expect("approval timeout")
                .expect("closed")
                .expect("ws");
            if let Message::Text(text) = msg {
                if let Ok(event) = serde_json::from_str::<proto::Event>(text.as_ref()) {
                    if event.event == "transcript-apply" {
                        if let Ok(apply) = serde_json::from_value::<proto::TranscriptApply>(event.payload) {
                            if let crew_protocol::HarnessEvent::ApprovalRequested { request_id: id, .. } = apply.event {
                                request_id = Some(id);
                            }
                        }
                    }
                }
            }
        }
        send_json(
            &mut ws,
            &Request {
                id: 4,
                method: "turn_respond".into(),
                params: serde_json::json!({
                    "sessionId": session_id,
                    "requestId": request_id.unwrap(),
                    "decision": "allow"
                }),
            },
        )
        .await;
        assert!(wait_response(&mut ws, 4).await.ok);
        tokio::time::sleep(std::time::Duration::from_millis(800)).await;
        let snap = transcript_of(&mut ws, 5, &session_id).await;
        let approval = snap.blocks.iter().find(|b| b.approval.is_some());
        let row = approval.expect("approval block").approval.as_ref().expect("approval");
        assert_eq!(row.decided, Some(proto::ApprovalDecision::Allow));
        handle.shutdown();
    }

    #[tokio::test]
    async fn allowed_tool_row_keeps_decided() {
        let dir = test_dir("turn-approval-tool");
        let handle = test_serve(&dir);
        let fake = write_fake_claude_approval_tool(&dir);
        handle.override_agent_binary("claude", fake.to_string_lossy().into_owned());
        let mut ws = connect_authed(&handle).await;
        let session_id = seed_bot(&mut ws, dir.to_str().unwrap()).await;
        start_turn(&mut ws, 3, &session_id, dir.to_str().unwrap()).await;
        let deadline = tokio::time::Instant::now() + std::time::Duration::from_secs(5);
        let mut request_id = None;
        while request_id.is_none() {
            let msg = tokio::time::timeout_at(deadline, ws.next())
                .await
                .expect("approval timeout")
                .expect("closed")
                .expect("ws");
            if let Message::Text(text) = msg {
                if let Ok(event) = serde_json::from_str::<proto::Event>(text.as_ref()) {
                    if event.event == "transcript-apply" {
                        if let Ok(apply) = serde_json::from_value::<proto::TranscriptApply>(event.payload) {
                            if let crew_protocol::HarnessEvent::ApprovalRequested { request_id: id, .. } = apply.event {
                                request_id = Some(id);
                            }
                        }
                    }
                }
            }
        }
        send_json(
            &mut ws,
            &Request {
                id: 4,
                method: "turn_respond".into(),
                params: serde_json::json!({
                    "sessionId": session_id,
                    "requestId": request_id.unwrap(),
                    "decision": "allow"
                }),
            },
        )
        .await;
        assert!(wait_response(&mut ws, 4).await.ok);
        wait_status(&mut ws, &session_id, "done").await;
        let snap = transcript_of(&mut ws, 5, &session_id).await;
        let tool = snap
            .blocks
            .iter()
            .find(|b| b.role == proto::BlockRole::Tool)
            .expect("folded tool row");
        assert_eq!(
            tool.approval.as_ref().and_then(|row| row.decided.clone()),
            Some(proto::ApprovalDecision::Allow)
        );
        handle.shutdown();
    }

    async fn start_turn(ws: &mut Ws, id: u32, session_id: &str, cwd: &str) {
        send_json(
            ws,
            &Request {
                id,
                method: "turn_start".into(),
                params: serde_json::json!({
                    "sessionId": session_id,
                    "cwd": cwd,
                    "text": "hi"
                }),
            },
        )
        .await;
        assert!(wait_response(ws, id).await.ok);
    }

    async fn wait_status(ws: &mut Ws, session_id: &str, want: &str) -> proto::SessionStatusEvent {
        let deadline = tokio::time::Instant::now() + std::time::Duration::from_secs(5);
        loop {
            let msg = tokio::time::timeout_at(deadline, ws.next())
                .await
                .expect("status timeout")
                .expect("closed")
                .expect("ws");
            if let Some(status) = status_in(&msg, session_id, want) {
                return status;
            }
        }
    }

    fn status_in(msg: &Message, session_id: &str, want: &str) -> Option<proto::SessionStatusEvent> {
        let Message::Text(text) = msg else {
            return None;
        };
        let event = serde_json::from_str::<proto::Event>(text.as_ref()).ok()?;
        if event.event != "session-status" {
            return None;
        }
        let status = serde_json::from_value::<proto::SessionStatusEvent>(event.payload).ok()?;
        (status.session_id == session_id && status.status == want).then_some(status)
    }

    /// Send a request whose work ends in `want`, and wait for both. The status
    /// event is broadcast by the turn thread and the response is written by the
    /// handler, so either can reach the socket first; waiting for the response
    /// alone would read past, and drop, a status that beat it.
    async fn request_until_status(ws: &mut Ws, request: &Request, session_id: &str, want: &str) -> proto::Response {
        send_json(ws, request).await;
        let deadline = tokio::time::Instant::now() + std::time::Duration::from_secs(5);
        let mut response = None;
        let mut reached = false;
        while response.is_none() || !reached {
            let msg = tokio::time::timeout_at(deadline, ws.next())
                .await
                .expect(if response.is_none() { "rpc timeout" } else { "status timeout" })
                .expect("closed")
                .expect("ws");
            if status_in(&msg, session_id, want).is_some() {
                reached = true;
            } else if let Message::Text(text) = &msg {
                if let Ok(reply) = serde_json::from_str::<proto::Response>(text.as_ref()) {
                    if reply.id == request.id {
                        response = Some(reply);
                    }
                }
            }
        }
        response.unwrap()
    }

    /// `start_turn` for a turn that ends on its own, waiting until it has.
    async fn start_turn_until(ws: &mut Ws, id: u32, session_id: &str, cwd: &str, want: &str) {
        let request = Request {
            id,
            method: "turn_start".into(),
            params: serde_json::json!({
                "sessionId": session_id,
                "cwd": cwd,
                "text": "hi"
            }),
        };
        assert!(request_until_status(ws, &request, session_id, want).await.ok);
    }

    async fn transcript_of(ws: &mut Ws, id: u32, session_id: &str) -> proto::MessagePage {
        send_json(
            ws,
            &Request {
                id,
                method: "transcript_tail".into(),
                params: serde_json::json!({ "sessionId": session_id }),
            },
        )
        .await;
        serde_json::from_value(wait_response(ws, id).await.result.expect("page")).expect("page")
    }

    fn system_errors(snap: &proto::MessagePage) -> Vec<&str> {
        snap.blocks
            .iter()
            .filter(|b| b.role == proto::BlockRole::System)
            .map(|b| b.text.as_str())
            .collect()
    }

    #[tokio::test]
    async fn stop_during_claude_init_ends_idle() {
        let dir = test_dir("turn-stop-init");
        let handle = test_serve(&dir);
        let fake = write_fake_claude_hang_init(&dir);
        handle.override_agent_binary("claude", fake.to_string_lossy().into_owned());
        let mut ws = connect_authed(&handle).await;
        let session_id = seed_bot(&mut ws, dir.to_str().unwrap()).await;
        start_turn(&mut ws, 3, &session_id, dir.to_str().unwrap()).await;
        let stop = Request {
            id: 4,
            method: "turn_stop".into(),
            params: serde_json::json!({ "sessionId": session_id }),
        };
        assert!(request_until_status(&mut ws, &stop, &session_id, "idle").await.ok);
        let snap = transcript_of(&mut ws, 5, &session_id).await;
        assert_eq!(snap.status, "idle");
        assert!(!snap.working);
        let systems: Vec<&str> = snap
            .blocks
            .iter()
            .filter(|b| b.role == proto::BlockRole::System)
            .map(|b| b.text.as_str())
            .collect();
        assert_eq!(systems, vec!["Stopped"]);
        handle.shutdown();
    }

    #[tokio::test]
    async fn claude_is_error_fails_the_turn() {
        let dir = test_dir("turn-claude-error");
        let handle = test_serve(&dir);
        let fake = write_fake_claude_error(&dir);
        handle.override_agent_binary("claude", fake.to_string_lossy().into_owned());
        let mut ws = connect_authed(&handle).await;
        let session_id = seed_bot(&mut ws, dir.to_str().unwrap()).await;
        start_turn_until(&mut ws, 3, &session_id, dir.to_str().unwrap(), "error").await;
        let snap = transcript_of(&mut ws, 4, &session_id).await;
        assert_eq!(snap.status, "error");
        let errors = system_errors(&snap);
        assert_eq!(errors, vec!["Claude exploded"]);
        handle.shutdown();
    }

    #[tokio::test]
    async fn codex_turn_failed_fails_the_turn() {
        let dir = test_dir("turn-codex-failed");
        let handle = test_serve(&dir);
        let fake = write_fake_codex_failed(&dir);
        handle.override_agent_binary("codex", fake.to_string_lossy().into_owned());
        let mut ws = connect_authed(&handle).await;
        let session_id = seed_bot_provider(&mut ws, dir.to_str().unwrap(), "codex").await;
        start_turn_until(&mut ws, 3, &session_id, dir.to_str().unwrap(), "error").await;
        let snap = transcript_of(&mut ws, 4, &session_id).await;
        assert_eq!(snap.status, "error");
        let errors = system_errors(&snap);
        assert_eq!(errors, vec!["Codex exploded"]);
        handle.shutdown();
    }

    #[tokio::test]
    async fn second_client_sees_user_block_before_delta() {
        let dir = test_dir("turn-two-clients");
        let handle = test_serve(&dir);
        let fake = write_fake_claude(&dir);
        handle.override_agent_binary("claude", fake.to_string_lossy().into_owned());
        let mut starter = connect_authed(&handle).await;
        let mut watcher = connect_authed(&handle).await;
        let session_id = seed_bot(&mut starter, dir.to_str().unwrap()).await;
        start_turn(&mut starter, 3, &session_id, dir.to_str().unwrap()).await;
        let deadline = tokio::time::Instant::now() + std::time::Duration::from_secs(5);
        let mut saw_user = false;
        loop {
            let msg = tokio::time::timeout_at(deadline, watcher.next())
                .await
                .expect("apply timeout")
                .expect("closed")
                .expect("ws");
            let Message::Text(text) = msg else {
                continue;
            };
            let Ok(event) = serde_json::from_str::<proto::Event>(text.as_ref()) else {
                continue;
            };
            if event.event != "transcript-apply" {
                continue;
            }
            let Ok(apply) = serde_json::from_value::<proto::TranscriptApply>(event.payload) else {
                continue;
            };
            if apply.session_id != session_id {
                continue;
            }
            match apply.event {
                crew_protocol::HarnessEvent::UserMessage { text, .. } => {
                    assert_eq!(text, "hi");
                    saw_user = true;
                }
                crew_protocol::HarnessEvent::MessageDelta { .. } => {
                    assert!(saw_user, "watcher saw a delta before the user block");
                    break;
                }
                _ => {}
            }
        }
        assert!(saw_user);
        handle.shutdown();
    }

    async fn attach_pty(ws: &mut Ws, id: u32, pty: &str, from: u64) -> proto::PtyAttached {
        send_json(
            ws,
            &Request {
                id,
                method: "pty_attach".into(),
                params: serde_json::json!({ "id": pty, "from": from }),
            },
        )
        .await;
        let response = wait_response(ws, id).await;
        assert!(response.ok, "{}", response.error.unwrap_or_default());
        serde_json::from_value(response.result.expect("attach result")).expect("PtyAttached")
    }

    async fn drain_and_ack(ws: &mut Ws, pty: &str, mut req: u32, want: usize) -> u64 {
        let mut got = 0usize;
        let mut processed = 0u64;
        let deadline = tokio::time::Instant::now() + std::time::Duration::from_secs(10);
        while got < want {
            let msg = tokio::time::timeout_at(deadline, ws.next())
                .await
                .expect("drain timeout")
                .expect("closed")
                .expect("ws");
            if let Message::Binary(bytes) = msg {
                if bytes.len() >= 4 {
                    let n = bytes.len() - 4;
                    got += n;
                    processed += n as u64;
                    req += 1;
                    send_json(
                        ws,
                        &Request {
                            id: req,
                            method: "pty_ack".into(),
                            params: serde_json::json!({ "id": pty, "processed": processed }),
                        },
                    )
                    .await;
                }
            }
        }
        processed
    }

    async fn ack_forever(ws: &mut Ws, pty: &str, mut req: u32) {
        let mut processed = 0u64;
        while let Some(Ok(msg)) = ws.next().await {
            if let Message::Binary(bytes) = msg {
                if bytes.len() >= 4 {
                    processed += (bytes.len() - 4) as u64;
                    req += 1;
                    send_json(
                        ws,
                        &Request {
                            id: req,
                            method: "pty_ack".into(),
                            params: serde_json::json!({ "id": pty, "processed": processed }),
                        },
                    )
                    .await;
                }
            }
        }
    }

    async fn next_binary(ws: &mut Ws) -> Vec<u8> {
        let deadline = tokio::time::Instant::now() + std::time::Duration::from_secs(5);
        loop {
            let msg = tokio::time::timeout_at(deadline, ws.next())
                .await
                .expect("binary timeout")
                .expect("closed")
                .expect("ws");
            if let Message::Binary(bytes) = msg {
                if bytes.len() >= 4 {
                    return bytes[4..].to_vec();
                }
            }
        }
    }

    async fn collect_bytes(ws: &mut Ws, duration: std::time::Duration) -> usize {
        let deadline = tokio::time::Instant::now() + duration;
        let mut got = 0usize;
        loop {
            match tokio::time::timeout_at(deadline, ws.next()).await {
                Ok(Some(Ok(Message::Binary(bytes)))) if bytes.len() >= 4 => {
                    got += bytes.len() - 4;
                }
                Ok(Some(Ok(_))) => {}
                _ => break,
            }
        }
        got
    }

    fn assert_digit_run(bytes: &[u8]) {
        assert!(bytes.len() >= 2, "need a run to check order");
        for window in bytes.windows(2) {
            let step = (i16::from(window[1]) - i16::from(window[0]) + 10) % 10;
            assert_eq!(step, 1, "unordered or duplicate bytes around {window:?}");
        }
    }

    async fn wait_event(ws: &mut Ws, name: &str) -> proto::Event {
        let deadline = tokio::time::Instant::now() + std::time::Duration::from_secs(5);
        loop {
            let msg = tokio::time::timeout_at(deadline, ws.next())
                .await
                .expect("event timeout")
                .expect("closed")
                .expect("ws");
            if let Message::Text(text) = msg {
                if let Ok(event) = serde_json::from_str::<proto::Event>(text.as_ref()) {
                    if event.event == name {
                        return event;
                    }
                }
            }
        }
    }

    async fn wait_response(ws: &mut Ws, id: u32) -> proto::Response {
        wait_one_of(ws, &[id]).await
    }

    async fn wait_one_of(ws: &mut Ws, ids: &[u32]) -> proto::Response {
        let deadline = tokio::time::Instant::now() + std::time::Duration::from_secs(5);
        loop {
            let msg = tokio::time::timeout_at(deadline, ws.next())
                .await
                .expect("rpc timeout")
                .expect("closed")
                .expect("ws");
            if let Message::Text(text) = msg {
                if let Ok(response) = serde_json::from_str::<proto::Response>(text.as_ref()) {
                    if ids.contains(&response.id) {
                        return response;
                    }
                }
            }
        }
    }

    async fn wait_bytes(ws: &mut Ws, needle: &[u8]) -> Vec<u8> {
        let deadline = tokio::time::Instant::now() + std::time::Duration::from_secs(5);
        let mut acc = Vec::new();
        loop {
            let msg = tokio::time::timeout_at(deadline, ws.next())
                .await
                .expect("stream timeout")
                .expect("closed")
                .expect("ws");
            if let Message::Binary(bytes) = msg {
                if bytes.len() >= 4 {
                    acc.extend_from_slice(&bytes[4..]);
                }
                if acc.windows(needle.len()).any(|w| w == needle) {
                    return acc;
                }
            }
        }
    }

    /// The nonce is written before the turn is attempted, so a `turn_start`
    /// that *failed* has still burned its id. The client's retry — the whole
    /// reason the nonce exists — is answered with a success it never got.
    #[tokio::test]
    async fn a_retry_after_a_failed_turn_start_is_not_swallowed() {
        let dir = test_dir("nonce-retry");
        let handle = test_serve(&dir);
        let mut ws = connect_authed(&handle).await;
        send_json(
            &mut ws,
            &Request {
                id: 1,
                method: "workspace_create".into(),
                params: serde_json::json!({ "name": "w", "path": dir.to_string_lossy() }),
            },
        )
        .await;
        let workspace: proto::Workspace =
            serde_json::from_value(wait_response(&mut ws, 1).await.result.expect("ws")).expect("workspace");
        // A session a turn cannot run on: `TurnHost::start` refuses it outright,
        // which is the same shape of refusal as "Turn already running".
        send_json(
            &mut ws,
            &Request {
                id: 2,
                method: "session_create".into(),
                params: serde_json::json!({
                    "workspaceId": workspace.id,
                    "kind": "terminal",
                    "name": "T",
                    "provider": "claude",
                    "model": "m",
                    "description": "",
                    "autonomy": "ask"
                }),
            },
        )
        .await;
        let session: proto::Session =
            serde_json::from_value(wait_response(&mut ws, 2).await.result.expect("session")).expect("session");

        let send = serde_json::json!({
            "sessionId": session.id,
            "cwd": dir.to_string_lossy(),
            "text": "hi",
            "nonce": "n-1"
        });
        send_json(&mut ws, &Request { id: 3, method: "turn_start".into(), params: send.clone() }).await;
        let first = wait_response(&mut ws, 3).await;
        assert!(!first.ok, "the first send should have failed");

        // The client never got a turn, so it replays the same Enter.
        send_json(&mut ws, &Request { id: 4, method: "turn_start".into(), params: send }).await;
        let retry = wait_response(&mut ws, 4).await;
        assert!(
            !retry.ok,
            "the retry was answered with success ({:?}) although no turn ever ran",
            retry.result
        );
    }

    #[tokio::test]
    async fn two_floods_never_cross_streams() {
        let dir = test_dir("pty-cross");
        let handle = test_serve(&dir);
        let mut ws = connect_authed(&handle).await;
        let script = |mark: char| {
            format!(
                "import sys,threading\ndef rd():\n    for l in sys.stdin:\n        sys.stdout.write('IN'+l.strip()+'\\n'); sys.stdout.flush()\nthreading.Thread(target=rd,daemon=True).start()\nwhile True:\n    sys.stdout.write('{mark}'*200+'\\n'); sys.stdout.flush()\n"
            )
        };
        let mut streams = HashMap::new();
        for (req, (pty, mark)) in [("a", 'P'), ("b", 'Q')].into_iter().enumerate() {
            let req = req as u32 + 1;
            send_json(
                &mut ws,
                &Request {
                    id: req,
                    method: "pty_spawn".into(),
                    params: serde_json::to_value(PtySpawn {
                        id: pty.into(),
                        cwd: std::env::temp_dir().to_string_lossy().into_owned(),
                        command: vec!["/usr/bin/python3".into(), "-c".into(), script(mark)],
                        cols: 80,
                        rows: 24,
                        session: None,
                        reuse: None,
                        dark: None,
                    })
                    .unwrap(),
                },
            )
            .await;
            let stream = wait_response(&mut ws, req).await.result.and_then(|v| v.as_u64()).expect("stream") as u32;
            streams.insert(stream, pty);
            attach_pty(&mut ws, req + 10, pty, 0).await;
        }
        let mut got: HashMap<&str, Vec<u8>> = HashMap::new();
        let mut processed: HashMap<&str, u64> = HashMap::new();
        let mut req = 100u32;
        let deadline = tokio::time::Instant::now() + std::time::Duration::from_secs(8);
        let mut sent = 0;
        while got.values().map(Vec::len).sum::<usize>() < 8 * 1024 * 1024 {
            let Ok(Some(Ok(msg))) = tokio::time::timeout_at(deadline, ws.next()).await else { break };
            let Message::Binary(frame) = msg else { continue };
            let stream = u32::from_le_bytes(frame[..4].try_into().unwrap());
            let pty = streams[&stream];
            got.entry(pty).or_default().extend_from_slice(&frame[4..]);
            let done = processed.entry(pty).or_default();
            *done += (frame.len() - 4) as u64;
            req += 1;
            send_json(&mut ws, &Request { id: req, method: "pty_ack".into(), params: serde_json::json!({ "id": pty, "processed": *done }) }).await;
            if sent < 200 && req % 20 == 0 {
                for (s, p) in &streams {
                    let tag = if *p == "a" { "xa" } else { "yb" };
                    let mut f = Vec::from(s.to_le_bytes());
                    f.extend_from_slice(format!("{tag}{sent}\n").as_bytes());
                    ws.send(Message::Binary(f.into())).await.unwrap();
                }
                sent += 1;
            }
        }
        let a = &got["a"];
        let b = &got["b"];
        assert!(!a.contains(&b'Q') && !a.windows(2).any(|w| w == b"yb"), "b leaked into a");
        assert!(!b.contains(&b'P') && !b.windows(2).any(|w| w == b"xa"), "a leaked into b");
        assert!(a.windows(4).any(|w| w == b"INxa") && b.windows(4).any(|w| w == b"INyb"), "input did not arrive");
        handle.shutdown();
    }

    /// A terminal session's tab closing detaches its terminal: it runs on, and
    /// stops only when asked to, or with its session or its workspace.
    #[tokio::test]
    async fn a_detached_session_terminal_runs_until_stopped_or_deleted() {
        let dir = test_dir("detach");
        let handle = test_serve(&dir);
        let mut ws = connect_authed(&handle).await;
        let workspace = rpc(&mut ws, 1, "workspace_create", serde_json::json!({ "name": "w", "path": dir.to_string_lossy() })).await;
        let workspace: proto::Workspace = serde_json::from_value(workspace.result.expect("ws")).expect("workspace");
        let (stopped, stopped_pty) = detached_session(&mut ws, 10, &workspace.id).await;
        let (deleted, deleted_pty) = detached_session(&mut ws, 20, &workspace.id).await;
        let (kept, kept_pty) = detached_session(&mut ws, 30, &workspace.id).await;
        let mut all = vec![stopped.clone(), deleted.clone(), kept.clone()];
        all.sort();
        assert_eq!(running(&mut ws, 100, &workspace.id).await, all, "a detached terminal stopped running");

        assert!(rpc(&mut ws, 101, "session_stop", serde_json::json!({ "id": stopped })).await.ok);
        assert!(rpc(&mut ws, 102, "session_delete", serde_json::json!({ "id": deleted })).await.ok);
        assert_eq!(running(&mut ws, 103, &workspace.id).await, vec![kept.clone()]);
        for (id, pty) in [(104, &stopped_pty), (105, &deleted_pty)] {
            let attach = rpc(&mut ws, id, "pty_attach", serde_json::json!({ "id": pty, "from": 0 })).await;
            assert!(!attach.ok, "{pty} still runs");
        }
        assert!(rpc(&mut ws, 106, "session_get", serde_json::json!({ "id": stopped })).await.result.is_some_and(|row| !row.is_null()), "stop took the session");

        // Reopened, the tab finds the same process.
        attach_pty(&mut ws, 107, &kept_pty, 0).await;
        assert!(rpc(&mut ws, 108, "workspace_delete", serde_json::json!({ "id": workspace.id })).await.ok);
        let attach = rpc(&mut ws, 109, "pty_attach", serde_json::json!({ "id": kept_pty, "from": 0 })).await;
        assert!(!attach.ok, "the workspace went, its terminal stayed");
        handle.shutdown();
    }

    /// A terminal session whose terminal was spawned, watched, and let go: its tab closed.
    async fn detached_session(ws: &mut Ws, id: u32, workspace: &str) -> (String, String) {
        let created = rpc(
            ws,
            id,
            "session_create",
            serde_json::json!({
                "workspaceId": workspace,
                "kind": "terminal",
                "name": "T",
                "provider": "claude",
                "model": "m",
                "description": "",
                "autonomy": "ask"
            }),
        )
        .await;
        let session: proto::Session = serde_json::from_value(created.result.expect("session")).expect("session");
        let pty = format!("{workspace}/session:{}", session.id);
        send_json(ws, &spawn_req(id + 1, &pty)).await;
        assert!(wait_response(ws, id + 1).await.ok);
        attach_pty(ws, id + 2, &pty, 0).await;
        let detached = rpc(ws, id + 3, "pty_detach", serde_json::json!({ "id": pty })).await;
        assert!(detached.ok, "{}", detached.error.unwrap_or_default());
        (session.id, pty)
    }

    async fn running(ws: &mut Ws, id: u32, workspace: &str) -> Vec<String> {
        let listed = rpc(ws, id, "sessions_running", serde_json::json!({ "workspaceId": workspace })).await;
        let mut ids: Vec<String> = serde_json::from_value(listed.result.expect("running")).expect("ids");
        ids.sort();
        ids
    }

    async fn rpc(ws: &mut Ws, id: u32, method: &str, params: Value) -> proto::Response {
        send_json(ws, &Request { id, method: method.into(), params }).await;
        wait_response(ws, id).await
    }

    fn git(dir: &std::path::Path, args: &[&str]) {
        let out = std::process::Command::new("git")
            .arg("-C")
            .arg(dir)
            .args(["-c", "user.name=crew", "-c", "user.email=crew@test", "-c", "commit.gpgsign=false"])
            .args(args)
            .output()
            .expect("git");
        assert!(out.status.success(), "git {args:?}: {}", String::from_utf8_lossy(&out.stderr));
    }

    /// Removing a worktree takes the sessions that ran in it, and only those;
    /// refused for unsaved work, it takes nothing.
    #[tokio::test]
    async fn removing_a_worktree_takes_its_sessions_with_it() {
        let dir = std::fs::canonicalize(test_dir("worktree-remove")).expect("dir");
        let repo = dir.join(format!("repo-{}", random_token()));
        std::fs::create_dir_all(&repo).expect("repo");
        git(&repo, &["init", "-q", "-b", "main"]);
        std::fs::write(repo.join("a.txt"), "a\n").expect("file");
        git(&repo, &["add", "."]);
        git(&repo, &["commit", "-q", "-m", "init"]);
        let tree = repo.with_extension("feat");
        git(&repo, &["worktree", "add", "-q", "-b", "feat", &tree.to_string_lossy()]);
        let handle = test_serve(&dir);
        let mut ws = connect_authed(&handle).await;

        let listed = rpc(&mut ws, 1, "worktree_list", serde_json::json!({ "path": repo })).await;
        let listed = listed.result.expect("list");
        assert_eq!(listed.as_array().map(Vec::len), Some(2), "{listed}");
        let feat = listed[1]["path"].as_str().expect("path").to_string();
        for field in ["add", "del", "dirty"] {
            assert_eq!(listed[1][field], 0, "{field} in {listed}");
        }
        let made = rpc(&mut ws, 2, "workspace_create", serde_json::json!({ "name": "w", "path": repo })).await;
        let workspace: proto::Workspace = serde_json::from_value(made.result.expect("ws")).expect("workspace");
        let mut ids = Vec::new();
        for (n, worktree) in [(3, Some(feat.clone())), (4, None)] {
            let made = rpc(
                &mut ws,
                n,
                "session_create",
                serde_json::json!({
                    "workspaceId": workspace.id, "kind": "bot", "name": "A", "provider": "claude",
                    "model": "m", "description": "", "autonomy": "ask", "worktree": worktree
                }),
            )
            .await;
            let session: proto::Session = serde_json::from_value(made.result.expect("session")).expect("session");
            assert_eq!(session.worktree, worktree);
            ids.push(session.id);
        }

        std::fs::write(tree.join("a.txt"), "changed\n").expect("edit");
        let refused = rpc(&mut ws, 5, "worktree_remove", serde_json::json!({ "path": feat, "force": false })).await;
        assert!(refused.error.unwrap_or_default().contains("uncommitted"), "unsaved work was thrown away");
        let kept = rpc(&mut ws, 6, "session_get", serde_json::json!({ "id": ids[0] })).await;
        assert!(kept.result.is_some_and(|row| !row.is_null()), "a refused removal still took the session");

        let removed = rpc(&mut ws, 7, "worktree_remove", serde_json::json!({ "path": feat, "force": true })).await;
        assert!(removed.ok, "{}", removed.error.unwrap_or_default());
        assert!(!tree.exists());
        let gone = rpc(&mut ws, 8, "session_get", serde_json::json!({ "id": ids[0] })).await;
        assert!(gone.ok && gone.result.is_none_or(|row| row.is_null()), "the worktree's session outlived it");
        let main = rpc(&mut ws, 9, "session_get", serde_json::json!({ "id": ids[1] })).await;
        assert!(main.result.is_some_and(|row| !row.is_null()), "the main checkout's session went too");
        let main_removal = rpc(&mut ws, 10, "worktree_remove", serde_json::json!({ "path": repo, "force": true })).await;
        assert!(main_removal.error.unwrap_or_default().contains("main checkout"));
        handle.shutdown();
    }

    /// A worktree's strip is deleted with it, not saved empty: the same path may come back.
    #[tokio::test]
    async fn a_deleted_state_key_reads_as_never_set() {
        let dir = test_dir("state-delete");
        let handle = test_serve(&dir);
        let mut ws = connect_authed(&handle).await;
        for (n, key) in [(1, "tabs:w@/tmp/feat"), (2, "tabs:w")] {
            let set = rpc(&mut ws, n, "state_set", serde_json::json!({ "key": key, "value": "{}" })).await;
            assert!(set.ok, "{}", set.error.unwrap_or_default());
        }

        let deleted = rpc(&mut ws, 3, "state_delete", serde_json::json!({ "key": "tabs:w@/tmp/feat" })).await;
        assert!(deleted.ok, "{}", deleted.error.unwrap_or_default());
        let gone = rpc(&mut ws, 4, "state_get", serde_json::json!({ "key": "tabs:w@/tmp/feat" })).await;
        assert!(gone.ok && gone.result.is_none_or(|value| value.is_null()), "the deleted key still reads");
        let kept = rpc(&mut ws, 5, "state_get", serde_json::json!({ "key": "tabs:w" })).await;
        assert_eq!(kept.result, Some(serde_json::json!("{}")), "a neighbouring key went too");
        let again = rpc(&mut ws, 6, "state_delete", serde_json::json!({ "key": "tabs:w@/tmp/feat" })).await;
        assert!(again.ok, "deleting a missing key is not an error");
        handle.shutdown();
    }
}
