use std::collections::{HashMap, HashSet};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{mpsc as std_mpsc, Arc, Mutex};
use std::thread;
use std::time::Duration;

use crew_core::agent::{AgentEvents, AgentHost};
use crew_core::bridge::{Bridge, ToolHost};
use crew_core::files;
use crew_core::messages;
use crew_core::provider_session;
use crew_core::pty::{PtyEvents, PtyHost};
use crew_core::routine;
use crew_core::scheduler::Scheduler;
use crew_core::session;
use crew_core::store::{self as app_state, Store};
use crew_core::transcript::TranscriptEvents;
use crew_core::turns::TurnHost;
use crew_core::workspace;
use crew_protocol::{
    self as proto, Auth, Cwd, DaemonInfo, Id, IdName, IdStatus, Ids, Key, KeyValue, Name, NamePath, Names, ProviderDiscover,
    OptionalId, PathArg, PathContents, PtyAck, PtyAttach, PtyAttached, PtyKill, PtyResize, PtySpawn, PtyWrite,
    Request, RoutineRunNow, RoutineUpsert, SessionCreate, SessionCreated, SessionId, SessionUpdate, TempFile,
    SearchQuery, TranscriptApply, TranscriptTail, TurnAnswer, TurnRespond,
    TurnStart, TurnStarted, WorkspaceId,
};
use futures_util::{SinkExt, StreamExt};
use serde::Deserialize;
use serde_json::Value;
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::mpsc;
use tokio_tungstenite::tungstenite::Message;

pub struct Config {
    pub pty: PtyHost,
    pub store: Store,
    pub agents: AgentHost,
    pub bridge: Bridge,
}

#[derive(Clone)]
struct Hosts {
    pty: PtyHost,
    store: Store,
    bridge: Bridge,
    turns: TurnHost,
    scheduler: Scheduler,
}

pub struct Handle {
    pub info: DaemonInfo,
    shutdown: Mutex<Option<tokio::sync::oneshot::Sender<()>>>,
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

    pub fn override_agent_binary(&self, name: &str, path: impl Into<String>) {
        self.turns.override_binary(name, path);
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
    pty_attached: Mutex<HashSet<u64>>,
    next: AtomicU64,
    runtime: Mutex<Option<tokio::runtime::Handle>>,
}

impl Hub {
    fn new() -> Self {
        Self {
            clients: Mutex::new(HashMap::new()),
            pty_attached: Mutex::new(HashSet::new()),
            next: AtomicU64::new(1),
            runtime: Mutex::new(None),
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

    fn watch_pty(&self, id: u64) {
        self.pty_attached
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .insert(id);
    }

    fn unsubscribe(&self, id: u64) {
        self.clients
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .remove(&id);
        self.pty_attached
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .remove(&id);
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

    fn broadcast(&self, msg: Outgoing) {
        let ids: Vec<u64> = self
            .clients
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .keys()
            .copied()
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
        let Ok(event) = proto::event(event, payload) else {
            return;
        };
        let Ok(text) = serde_json::to_string(&event) else {
            return;
        };
        self.broadcast(Outgoing::Text(text));
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
            .copied()
            .collect();
        for id in ids {
            self.send(id, Outgoing::Binary(frame.clone()));
        }
    }

    fn exit(&self, id: &str, code: Option<i32>) {
        self.emit("pty-exit", proto::PtyExit { id: id.to_string(), code });
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

struct ToolDispatch {
    store: crew_core::store::Store,
    transcripts: crew_core::transcript::TranscriptHub,
    turns: TurnHost,
    scheduler: Scheduler,
    hub: Arc<Hub>,
}

impl ToolDispatch {
    /// Hand the target its next letter. A busy agent refuses, and the letter
    /// waits in the box for the drain that runs when its turn ends.
    fn deliver(&self, target: &crew_core::session::Session) -> bool {
        self.turns.deliver_to(target)
    }
}

impl ToolHost for ToolDispatch {
    fn handle(&self, session_id: &str, method: &str, params: Value) -> Result<Value, String> {
        crew_core::tools::handle(
            &self.store,
            &self.transcripts,
            &|created| {
                self.hub.emit(
                    "session-created",
                    SessionCreated {
                        session: proto_session(created),
                    },
                );
            },
            &|| self.scheduler.arm(),
            &|target| self.deliver(target),
            session_id,
            method,
            params,
        )
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
        provider_session_id: row.provider_session_id.clone(),
        description: row.description.clone(),
        notifications: row.notifications,
        autonomy: row.autonomy.clone(),
        status: row.status.clone(),
        created_at: row.created_at,
        updated_at: row.updated_at,
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
    let token = random_token();
    let hub = Arc::new(Hub::new());
    let transcripts = crew_core::transcript::TranscriptHub::new(config.store.clone());
    transcripts.set_events(hub.clone());
    let turns = TurnHost::new(
        config.agents.clone(),
        config.store.clone(),
        transcripts.clone(),
        config.bridge.clone(),
    );
    config.pty.set_events(hub.clone());
    config.agents.set_events(Arc::new(AgentFanout {
        turns: turns.clone(),
    }));
    let scheduler = Scheduler::new(config.store.clone(), turns.clone());
    scheduler.set_events(hub.clone());
    config.bridge.set_handler(Arc::new(ToolDispatch {
        store: config.store.clone(),
        transcripts,
        turns: turns.clone(),
        scheduler: scheduler.clone(),
        hub: hub.clone(),
    }));

    // A letter left waiting for an idle agent is invisible until someone
    // messages it: only the end of a turn looks in a box.
    turns.deliver_waiting();

    // Before the window can list them, or it would show rows already gone.
    let _ = session::sweep_disposable(&config.store);

    let (ready_tx, ready_rx) = std_mpsc::channel();
    let (stop_tx, stop_rx) = tokio::sync::oneshot::channel();
    let hosts = Hosts {
        pty: config.pty,
        store: config.store,
        bridge: config.bridge,
        turns: turns.clone(),
        scheduler: scheduler.clone(),
    };
    let serve_token = token.clone();

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
            runtime.block_on(run(hosts, hub, serve_token, ready_tx, stop_rx));
        })
        .map_err(|e| e.to_string())?;

    let url = ready_rx.recv().map_err(|e| e.to_string())??;
    Ok(Handle {
        info: DaemonInfo { url, token },
        shutdown: Mutex::new(Some(stop_tx)),
        turns,
        scheduler,
    })
}

async fn run(
    hosts: Hosts,
    hub: Arc<Hub>,
    token: String,
    ready_tx: std_mpsc::Sender<Result<String, String>>,
    mut stop_rx: tokio::sync::oneshot::Receiver<()>,
) {
    let listener = match TcpListener::bind("127.0.0.1:0").await {
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
    hub.set_runtime(tokio::runtime::Handle::current());
    hosts.turns.set_runtime(tokio::runtime::Handle::current());
    hosts.turns.transcripts().set_runtime(tokio::runtime::Handle::current());
    // Routines are the daemon's to fire: a standing order outlives the window.
    hosts.scheduler.set_runtime(tokio::runtime::Handle::current());
    let scheduler = hosts.scheduler.clone();
    tokio::task::spawn_blocking(move || scheduler.arm());

    loop {
        tokio::select! {
            _ = &mut stop_rx => break,
            accepted = listener.accept() => {
                let Ok((stream, _)) = accepted else { break };
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

async fn handle_socket(stream: TcpStream, hosts: Hosts, hub: Arc<Hub>, token: String) {
    let Ok(ws) = tokio_tungstenite::accept_async(stream).await else {
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

    while let Some(msg) = source.next().await {
        let Ok(msg) = msg else { break };
        match msg {
            Message::Text(text) => {
                let hosts = hosts.clone();
                let hub = hub.clone();
                tokio::spawn(async move {
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
    if let Some(tx) = map.get(&stream_id) {
        if tx.try_send(data).is_err() {
            drop(map);
            emit_pty_error(hub, &hosts.pty, stream_id, "Terminal is not accepting input");
        }
        return;
    }
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

async fn handle_text(hosts: &Hosts, hub: &Arc<Hub>, client_id: u64, text: &str) -> Option<String> {
    let request = match serde_json::from_str::<Request>(text) {
        Ok(request) => request,
        Err(error) => return Some(encode(&proto::err(0, format!("Bad request: {error}")))),
    };
    if request.method == "pty_attach" {
        attach_pty(hosts, hub, client_id, request.id, request.params).await;
        return None;
    }
    let result = dispatch(hosts, &request.method, request.params).await;
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
            hub_c.watch_pty(client_id);
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

/// The new id when Claude moved to another session since the last look.
fn rebind_claude_session(store: &Store, id: String) -> Result<Option<String>, String> {
    let Some(found) = provider_session::claude_bound(&id) else {
        return Ok(None);
    };
    let row = session::get(store, id.clone())?.ok_or("Session not found")?;
    if found == row.provider_session_id.unwrap_or_else(|| id.clone()) {
        return Ok(None);
    }
    session::set_provider_session(store, id, found.clone())?;
    Ok(Some(found))
}

async fn block<T: Send + 'static>(
    work: impl FnOnce() -> Result<T, String> + Send + 'static,
) -> Result<T, String> {
    tokio::task::spawn_blocking(work)
        .await
        .map_err(|e| e.to_string())?
}

fn json(value: impl serde::Serialize) -> Result<Value, String> {
    serde_json::to_value(value).map_err(|e| e.to_string())
}

async fn dispatch(hosts: &Hosts, method: &str, params: Value) -> Result<Value, String> {
    match method {
        "pty_spawn" => {
            let PtySpawn { id, cwd, command, cols, rows } = parse(params)?;
            let host = hosts.pty.clone();
            json(block(move || host.spawn(id, cwd, command, cols, rows)).await?)
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
            block(move || workspace::delete(&store, id)).await?;
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
                session::create(
                    &store,
                    p.workspace_id,
                    p.kind,
                    p.name,
                    p.provider,
                    p.model,
                    p.description,
                    p.autonomy,
                )
            })
            .await?)
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
            let store = hosts.store.clone();
            // Its process may still be running with a token in its environment;
            // a session that no longer exists should not still be able to call.
            hosts.bridge.revoke(&id);
            block(move || session::delete(&store, id)).await?;
            Ok(Value::Null)
        }
        "session_is_disposable" => {
            let Id { id } = parse(params)?;
            let store = hosts.store.clone();
            json(block(move || session::is_disposable(&store, id)).await?)
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
            json(block(move || rebind_claude_session(&store, id)).await?)
        }
        "session_sync_title" => {
            let Id { id } = parse(params)?;
            let store = hosts.store.clone();
            json(block(move || session::sync_title(&store, id)).await?)
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
        "list_project_files" => {
            let Cwd { cwd } = parse(params)?;
            json(block(move || files::list(&cwd)).await?)
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
        "read_file_base64" => {
            let PathArg { path } = parse(params)?;
            json(block(move || files::read_base64(&path)).await?)
        }
        "write_temp_file" => {
            let TempFile { extension, base64_contents } = parse(params)?;
            json(block(move || files::write_temp(&extension, &base64_contents)).await?)
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
            let started = block(move || turns.start(p)).await;
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
        _ => Err(format!("Unknown method: {method}")),
    }
}

fn parse<T: for<'de> Deserialize<'de>>(params: Value) -> Result<T, String> {
    serde_json::from_value(params).map_err(|e| e.to_string())
}

fn encode(value: &impl serde::Serialize) -> String {
    serde_json::to_string(value).unwrap_or_else(|_| r#"{"id":0,"ok":false,"error":"encode"}"#.into())
}

fn random_token() -> String {
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
        let handle = serve(Config {
            pty: PtyHost::new(),
            store: Store::open(dir.join("crew.sqlite3")).expect("store"),
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

        send_json(
            &mut ws,
            &Request {
                id: 2,
                method: "pty_ack".into(),
                params: serde_json::json!({ "id": "t", "processed": attached.start + replay.len() as u64 }),
            },
        )
        .await;
        let ack = wait_response(&mut ws, 2).await;
        assert!(ack.ok, "{}", ack.error.unwrap_or_default());

        let extra = collect_bytes(&mut ws, std::time::Duration::from_secs(1)).await;
        assert!(
            extra <= 256 * 1024 + 64 * 1024,
            "flow control disabled: extra={extra}"
        );
        assert!(extra >= 128 * 1024, "reader did not refill the window: extra={extra}");
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
    async fn list_agents_runs_without_a_window() {
        let dir = test_dir("tool-headless");
        let (handle, bridge) = test_serve_bridged(&dir);
        let mut ws = connect_authed(&handle).await;
        let session_id = seed_agent(&mut ws, dir.to_str().unwrap()).await;
        let info = bridge.info().expect("info");
        drop(ws);
        let payload = serde_json::json!({
            "token": bridge.mint(&session_id),
            "method": "tools/call",
            "params": { "name": "list_agents", "arguments": {} }
        });
        let reply = unix_call(&info.socket_path, &payload);
        let text = reply["result"]["content"][0]["text"].as_str().unwrap_or("");
        assert!(text.contains(&session_id), "reply: {reply}");
        handle.shutdown();
    }

    /// The token is the identity. An agent's shell inherits CREW_SOCKET and
    /// CREW_TOKEN, and used to be able to name any session on the request and
    /// be believed — which, with a child inheriting its creator's autonomy, is
    /// how an `ask` agent would have had a `full` one built for it.
    #[tokio::test]
    async fn a_token_speaks_only_for_the_session_it_was_minted_for() {
        let dir = test_dir("tool-identity");
        let (handle, bridge) = test_serve_bridged(&dir);
        let mut ws = connect_authed(&handle).await;
        let mine = seed_agent(&mut ws, dir.to_str().unwrap()).await;
        let info = bridge.info().expect("info");
        drop(ws);

        // The old shape of the request, with somebody else's id on it.
        let forged = serde_json::json!({
            "token": bridge.mint(&mine),
            "sessionId": "somebody-else",
            "method": "tools/call",
            "params": { "name": "list_agents", "arguments": {} }
        });
        let reply = unix_call(&info.socket_path, &forged);
        let text = reply["result"]["content"][0]["text"].as_str().unwrap_or("");
        assert!(text.contains(&mine), "the id on the wire was believed: {reply}");

        // And a token nobody minted is nobody.
        let stranger = serde_json::json!({
            "token": "not-a-token-anybody-minted",
            "method": "tools/call",
            "params": { "name": "list_agents", "arguments": {} }
        });
        let reply = unix_call(&info.socket_path, &stranger);
        assert_eq!(reply["error"].as_str(), Some("Bad token"), "reply: {reply}");
        handle.shutdown();
    }

    #[tokio::test]
    async fn create_agent_emits_session_created() {
        let dir = test_dir("tool-created");
        let (handle, bridge) = test_serve_bridged(&dir);
        let mut ws = connect_authed(&handle).await;
        let session_id = seed_agent(&mut ws, dir.to_str().unwrap()).await;
        let info = bridge.info().expect("info");
        let payload = serde_json::json!({
            "token": bridge.mint(&session_id),
            "method": "tools/call",
            "params": { "name": "create_agent", "arguments": { "name": "B", "description": "does B" } }
        });
        let reply = unix_call(&info.socket_path, &payload);
        let text = reply["result"]["content"][0]["text"].as_str().unwrap_or("");
        assert!(text.contains("\"name\": \"B\"") || text.contains("\"name\":\"B\""), "reply: {reply}");
        let event = wait_event(&mut ws, "session-created").await;
        let created: proto::SessionCreated = serde_json::from_value(event.payload).expect("created");
        assert_eq!(created.session.name, "B");
        handle.shutdown();
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
import json, time
time.sleep(0.05)
print(json.dumps({"type":"turn.failed","error":{"message":"Codex exploded"}}), flush=True)
"#,
        )
        .expect("fake codex");
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o755)).expect("chmod");
        path
    }

    async fn seed_agent(ws: &mut Ws, cwd: &str) -> String {
        seed_agent_provider(ws, cwd, "claude").await
    }

    async fn seed_agent_provider(ws: &mut Ws, cwd: &str, provider: &str) -> String {
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
                    "kind": "agent",
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
        let session_id = seed_agent(&mut ws, dir.to_str().unwrap()).await;
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
        let session_id = seed_agent(&mut ws, dir.to_str().unwrap()).await;
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
        let session_id = seed_agent(&mut ws, dir.to_str().unwrap()).await;
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
            if let Message::Text(text) = msg {
                if let Ok(event) = serde_json::from_str::<proto::Event>(text.as_ref()) {
                    if event.event == "session-status" {
                        if let Ok(status) = serde_json::from_value::<proto::SessionStatusEvent>(event.payload) {
                            if status.session_id == session_id && status.status == want {
                                return status;
                            }
                        }
                    }
                }
            }
        }
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
        let d = Daemon::start();
        d.fake("claude", &write_fake_claude_hang_init(d.path()));
        let mut c = d.client().await;
        let w = c.workspace("w", &d.cwd()).await;
        let session = c.session(&w.id, "agent", "A", "claude").await;
        c.ok("turn_start", serde_json::json!({ "sessionId": session.id, "cwd": d.cwd(), "text": "hi" })).await;
        // The idle status can beat the reply to the stop; the client keeps it.
        c.ok("turn_stop", serde_json::json!({ "sessionId": session.id })).await;
        c.status(&session.id, "idle").await;
        let snap = c.transcript(&session.id).await;
        assert_eq!(snap.status, "idle");
        assert!(!snap.working);
        assert_eq!(system_errors(&snap), vec!["Stopped"]);
    }

    #[tokio::test]
    async fn claude_is_error_fails_the_turn() {
        let dir = test_dir("turn-claude-error");
        let handle = test_serve(&dir);
        let fake = write_fake_claude_error(&dir);
        handle.override_agent_binary("claude", fake.to_string_lossy().into_owned());
        let mut ws = connect_authed(&handle).await;
        let session_id = seed_agent(&mut ws, dir.to_str().unwrap()).await;
        start_turn(&mut ws, 3, &session_id, dir.to_str().unwrap()).await;
        wait_status(&mut ws, &session_id, "error").await;
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
        let session_id = seed_agent_provider(&mut ws, dir.to_str().unwrap(), "codex").await;
        start_turn(&mut ws, 3, &session_id, dir.to_str().unwrap()).await;
        wait_status(&mut ws, &session_id, "error").await;
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
        let session_id = seed_agent(&mut starter, dir.to_str().unwrap()).await;
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

    // The RPC surface, one behavior per test. Each test runs its own daemon on
    // its own store in its own folder, and every wait is bounded by WITHIN.

    use serde_json::json;
    use std::collections::VecDeque;
    use tokio::time::Instant;

    /// Long enough for a spawned process on a loaded machine, short enough that
    /// a hang fails the run in seconds.
    const WITHIN: Duration = Duration::from_secs(10);

    /// A daemon on a store of its own, shut down however the test ends.
    struct Daemon {
        handle: Handle,
        bridge: Bridge,
        store: Store,
        dir: tempfile::TempDir,
    }

    impl Daemon {
        fn start() -> Self {
            // Short and under /tmp: the bridge socket inside has to fit in sun_path.
            let dir = tempfile::Builder::new()
                .prefix("crewd")
                .tempdir_in("/tmp")
                .expect("temp dir");
            let bridge = Bridge::start(dir.path().to_path_buf()).expect("bridge");
            let store = Store::open(dir.path().join("crew.sqlite3")).expect("store");
            let handle = serve(Config {
                pty: PtyHost::new(),
                store: store.clone(),
                agents: AgentHost::new(),
                bridge: bridge.clone(),
            })
            .expect("serve");
            Self { handle, bridge, store, dir }
        }

        fn path(&self) -> &std::path::Path {
            self.dir.path()
        }

        fn cwd(&self) -> String {
            self.dir.path().to_string_lossy().into_owned()
        }

        fn folder(&self, name: &str) -> String {
            let path = self.dir.path().join(name);
            std::fs::create_dir_all(&path).expect("folder");
            path.to_string_lossy().into_owned()
        }

        fn fake(&self, provider: &str, script: &std::path::Path) {
            self.handle.override_agent_binary(provider, script.to_string_lossy().into_owned());
        }

        /// Authenticated, and subscribed: the round trip only answers once the
        /// daemon has the client on its list.
        async fn client(&self) -> Client {
            let mut client = Client {
                ws: connect_authed(&self.handle).await,
                next: 100,
                backlog: VecDeque::new(),
            };
            client.ok("workspace_list", Value::Null).await;
            client
        }

        async fn unauthed(&self) -> Ws {
            connect_async(self.handle.url()).await.expect("connect").0
        }

        /// What `crew call` in the agent's shell gets back from a tool.
        fn tool(&self, caller: &str, name: &str, arguments: Value) -> String {
            let info = self.bridge.info().expect("bridge info");
            let reply = unix_call(
                &info.socket_path,
                &json!({
                    "token": self.bridge.mint(caller),
                    "method": "tools/call",
                    "params": { "name": name, "arguments": arguments }
                }),
            );
            assert_ne!(reply["result"]["isError"], true, "{name} refused: {reply}");
            reply["result"]["content"][0]["text"].as_str().expect("tool text").to_string()
        }
    }

    impl Drop for Daemon {
        fn drop(&mut self) {
            self.handle.shutdown();
        }
    }

    /// One socket. Whatever arrives while a test waits for something else is
    /// kept, so an event that beats a reply is still there to be waited for.
    struct Client {
        ws: Ws,
        next: u32,
        backlog: VecDeque<Message>,
    }

    fn as_response(msg: &Message) -> Option<proto::Response> {
        let Message::Text(text) = msg else { return None };
        serde_json::from_str(text.as_ref()).ok()
    }

    fn as_event(msg: &Message) -> Option<proto::Event> {
        let Message::Text(text) = msg else { return None };
        serde_json::from_str(text.as_ref()).ok()
    }

    fn output_of(msg: &Message, stream: u32) -> Option<Vec<u8>> {
        let Message::Binary(frame) = msg else { return None };
        (frame.len() >= 4 && frame[..4] == stream.to_le_bytes()).then(|| frame[4..].to_vec())
    }

    impl Client {
        async fn take_by<T>(&mut self, deadline: Instant, pick: &impl Fn(&Message) -> Option<T>) -> Option<T> {
            if let Some(at) = self.backlog.iter().position(|msg| pick(msg).is_some()) {
                return self.backlog.remove(at).and_then(|msg| pick(&msg));
            }
            loop {
                let msg = match tokio::time::timeout_at(deadline, self.ws.next()).await {
                    Err(_) => return None,
                    Ok(next) => next.expect("socket closed").expect("socket error"),
                };
                if let Some(found) = pick(&msg) {
                    return Some(found);
                }
                self.backlog.push_back(msg);
            }
        }

        async fn take<T>(&mut self, what: &str, pick: impl Fn(&Message) -> Option<T>) -> T {
            self.take_by(Instant::now() + WITHIN, &pick)
                .await
                .unwrap_or_else(|| panic!("no {what} within {WITHIN:?}"))
        }

        async fn call(&mut self, method: &str, params: Value) -> proto::Response {
            self.next += 1;
            let id = self.next;
            send_json(&mut self.ws, &Request { id, method: method.into(), params }).await;
            self.take(method, |msg| as_response(msg).filter(|r| r.id == id)).await
        }

        async fn ok(&mut self, method: &str, params: Value) -> Value {
            let reply = self.call(method, params).await;
            assert!(reply.ok, "{method} failed: {}", reply.error.unwrap_or_default());
            reply.result.unwrap_or(Value::Null)
        }

        async fn fail(&mut self, method: &str, params: Value) -> String {
            let reply = self.call(method, params).await;
            assert!(!reply.ok, "{method} should have failed, answered {:?}", reply.result);
            reply.error.unwrap_or_default()
        }

        async fn event_where(&mut self, name: &str, keep: impl Fn(&Value) -> bool) -> Value {
            self.take(name, |msg| {
                as_event(msg)
                    .filter(|e| e.event == name && keep(&e.payload))
                    .map(|e| e.payload)
            })
            .await
        }

        async fn event(&mut self, name: &str) -> Value {
            self.event_where(name, |_| true).await
        }

        fn events_seen(&self, name: &str) -> Vec<Value> {
            self.backlog
                .iter()
                .filter_map(as_event)
                .filter(|e| e.event == name)
                .map(|e| e.payload)
                .collect()
        }

        async fn status(&mut self, session_id: &str, want: &str) {
            self.event_where("session-status", |p| p["sessionId"] == session_id && p["status"] == want)
                .await;
        }

        async fn output_until(&mut self, stream: u32, needle: &str) -> String {
            let mut out = Vec::new();
            self.backlog.retain(|msg| match output_of(msg, stream) {
                Some(bytes) => {
                    out.extend_from_slice(&bytes);
                    false
                }
                None => true,
            });
            let deadline = Instant::now() + WITHIN;
            while !String::from_utf8_lossy(&out).contains(needle) {
                let msg = tokio::time::timeout_at(deadline, self.ws.next())
                    .await
                    .unwrap_or_else(|_| panic!("no {needle:?} in {:?}", String::from_utf8_lossy(&out)))
                    .expect("socket closed")
                    .expect("socket error");
                match output_of(&msg, stream) {
                    Some(bytes) => out.extend_from_slice(&bytes),
                    None => self.backlog.push_back(msg),
                }
            }
            String::from_utf8_lossy(&out).into_owned()
        }

        async fn input(&mut self, stream: u32, bytes: &[u8]) {
            let mut frame = stream.to_le_bytes().to_vec();
            frame.extend_from_slice(bytes);
            self.ws.send(Message::Binary(frame.into())).await.expect("input");
        }

        async fn spawn_pty(&mut self, id: &str, command: &[&str]) -> u32 {
            let stream = self
                .ok(
                    "pty_spawn",
                    json!({ "id": id, "cwd": std::env::temp_dir(), "command": command, "cols": 80, "rows": 24 }),
                )
                .await;
            stream.as_u64().expect("stream id") as u32
        }

        async fn workspace(&mut self, name: &str, path: &str) -> proto::Workspace {
            let row = self.ok("workspace_create", json!({ "name": name, "path": path })).await;
            serde_json::from_value(row).expect("workspace")
        }

        async fn session(&mut self, workspace_id: &str, kind: &str, name: &str, provider: &str) -> proto::Session {
            let row = self.ok("session_create", new_session(workspace_id, kind, name, provider)).await;
            serde_json::from_value(row).expect("session")
        }

        async fn session_row(&mut self, id: &str) -> Option<proto::Session> {
            serde_json::from_value(self.ok("session_get", json!({ "id": id })).await).expect("session")
        }

        async fn transcript(&mut self, session_id: &str) -> proto::MessagePage {
            let page = self.ok("transcript_tail", json!({ "sessionId": session_id })).await;
            serde_json::from_value(page).expect("page")
        }

        async fn save_routine(&mut self, params: Value) -> proto::Routine {
            serde_json::from_value(self.ok("routine_upsert", params).await).expect("routine")
        }

        async fn routines(&mut self, session_id: &str) -> Vec<proto::Routine> {
            let rows = self.ok("routine_list_for_session", json!({ "sessionId": session_id })).await;
            serde_json::from_value(rows).expect("routines")
        }
    }

    fn new_session(workspace_id: &str, kind: &str, name: &str, provider: &str) -> Value {
        json!({
            "workspaceId": workspace_id,
            "kind": kind,
            "name": name,
            "provider": provider,
            "model": "m",
            "description": "",
            "autonomy": "ask"
        })
    }

    fn ids(rows: Value) -> Vec<String> {
        rows.as_array()
            .expect("rows")
            .iter()
            .map(|row| row["id"].as_str().expect("id").to_string())
            .collect()
    }

    fn fake_cli(dir: &std::path::Path, name: &str, body: &str) -> std::path::PathBuf {
        use std::os::unix::fs::PermissionsExt;
        let path = dir.join(name);
        std::fs::write(&path, body).expect("fake cli");
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o755)).expect("chmod");
        path
    }

    /// Asks one question with AskUserQuestion and says back what it was told.
    fn write_fake_claude_question(dir: &std::path::Path) -> std::path::PathBuf {
        fake_cli(
            dir,
            "fake-claude-question",
            r#"#!/usr/bin/env python3
import json, sys
def say(rec):
    print(json.dumps(rec), flush=True)
say({"type": "system", "subtype": "init"})
for line in sys.stdin:
    try:
        rec = json.loads(line)
    except Exception:
        continue
    if rec.get("type") == "control_request":
        say({"type": "control_response"})
        continue
    if rec.get("type") != "user":
        continue
    say({"type": "control_request", "request_id": "q1", "request": {
        "subtype": "can_use_tool", "tool_name": "AskUserQuestion",
        "input": {"questions": [{"question": "Pick a color", "header": "Color", "multiSelect": False,
            "options": [{"label": "Red", "description": "warm"}, {"label": "Blue", "description": "cool"}]}]}}})
    for reply in sys.stdin:
        try:
            got = json.loads(reply)
        except Exception:
            continue
        if got.get("type") == "control_response":
            break
    answers = got["response"]["response"]["updatedInput"]["answers"]
    say({"type": "stream_event", "event": {"type": "content_block_delta",
        "delta": {"type": "text_delta", "text": "picked " + answers["Pick a color"]}}})
    say({"type": "result", "subtype": "success", "usage": {"input_tokens": 1, "output_tokens": 1}})
"#,
        )
    }

    /// Starts fine, then dies on the first message with a word on stderr.
    fn write_fake_claude_dies(dir: &std::path::Path) -> std::path::PathBuf {
        fake_cli(
            dir,
            "fake-claude-dies",
            r#"#!/usr/bin/env python3
import json, sys
print(json.dumps({"type": "system", "subtype": "init"}), flush=True)
for line in sys.stdin:
    try:
        rec = json.loads(line)
    except Exception:
        continue
    if rec.get("type") == "control_request":
        print(json.dumps({"type": "control_response"}), flush=True)
    elif rec.get("type") == "user":
        sys.stderr.write("boom\n")
        sys.stderr.flush()
        sys.exit(3)
"#,
        )
    }

    // ---- connection and auth ----

    /// The daemon hung up without answering anything on the socket.
    async fn assert_hung_up(ws: &mut Ws) {
        let deadline = Instant::now() + WITHIN;
        loop {
            match tokio::time::timeout_at(deadline, ws.next()).await.expect("the socket stayed open") {
                None | Some(Err(_)) | Some(Ok(Message::Close(_))) => return,
                Some(Ok(Message::Text(text))) => panic!("answered on a socket it should have dropped: {text}"),
                Some(Ok(_)) => {}
            }
        }
    }

    #[tokio::test]
    async fn a_wrong_token_is_refused() {
        let d = Daemon::start();
        let mut ws = d.unauthed().await;
        send_json(&mut ws, &Auth { auth: "not-the-token".into() }).await;
        let _ = ws
            .send(Message::Text(r#"{"id":1,"method":"workspace_list","params":null}"#.into()))
            .await;
        assert_hung_up(&mut ws).await;
    }

    #[tokio::test]
    async fn a_missing_token_is_refused() {
        let d = Daemon::start();
        let mut ws = d.unauthed().await;
        ws.send(Message::Text("{}".into())).await.expect("send");
        assert_hung_up(&mut ws).await;
    }

    #[tokio::test]
    async fn a_request_before_auth_is_refused_unanswered() {
        let d = Daemon::start();
        let mut ws = d.unauthed().await;
        send_json(&mut ws, &Request { id: 1, method: "workspace_list".into(), params: Value::Null }).await;
        assert_hung_up(&mut ws).await;
    }

    #[tokio::test]
    async fn a_binary_frame_before_auth_is_refused() {
        let d = Daemon::start();
        let mut ws = d.unauthed().await;
        ws.send(Message::Binary(vec![1u8, 0, 0, 0, b'x'].into())).await.expect("send");
        assert_hung_up(&mut ws).await;
    }

    #[tokio::test]
    async fn a_connection_that_never_upgrades_is_dropped_and_the_daemon_keeps_serving() {
        use std::io::{Read, Write};
        let d = Daemon::start();
        let addr = d.handle.url().trim_start_matches("ws://").to_string();
        let mut raw = std::net::TcpStream::connect(&addr).expect("tcp");
        raw.set_read_timeout(Some(WITHIN)).expect("timeout");
        raw.write_all(b"GET / HTTP/1.1\r\nHost: crew\r\n\r\n").expect("write");
        let mut reply = Vec::new();
        raw.read_to_end(&mut reply).expect("the daemon kept a socket that never upgraded");
        assert!(!String::from_utf8_lossy(&reply).contains(" 101 "), "upgraded anyway");

        let mut c = d.client().await;
        assert_eq!(c.ok("workspace_list", Value::Null).await, json!([]));
    }

    #[tokio::test]
    async fn malformed_json_gets_an_error_reply_and_the_socket_stays_up() {
        let d = Daemon::start();
        let mut c = d.client().await;
        for garbage in ["{not json", r#"{"id":7}"#] {
            c.ws.send(Message::Text(garbage.into())).await.expect("send");
            let reply = c.take("bad request reply", |msg| as_response(msg).filter(|r| r.id == 0)).await;
            assert!(!reply.ok);
            let error = reply.error.unwrap_or_default();
            assert!(error.starts_with("Bad request: "), "{garbage}: {error}");
        }
        assert_eq!(c.ok("workspace_list", Value::Null).await, json!([]));
    }

    #[tokio::test]
    async fn an_unknown_method_is_named_in_the_error() {
        let d = Daemon::start();
        let mut c = d.client().await;
        assert_eq!(c.fail("workspace_frobnicate", json!({})).await, "Unknown method: workspace_frobnicate");
    }

    #[tokio::test]
    async fn every_method_refuses_params_it_cannot_read() {
        let d = Daemon::start();
        let mut c = d.client().await;
        for method in [
            "pty_spawn",
            "pty_write",
            "pty_resize",
            "pty_ack",
            "pty_kill",
            "pty_attach",
            "workspace_create",
            "workspace_rename",
            "workspace_delete",
            "workspace_reorder",
            "active_workspace_set",
            "session_list",
            "session_get",
            "session_create",
            "session_update",
            "session_rename",
            "session_delete",
            "session_is_disposable",
            "session_reorder",
            "session_set_status",
            "session_provider_create",
            "session_provider_discover",
            "session_claude_rebind",
            "session_sync_title",
            "session_mark_read",
            "routine_list_for_session",
            "routine_upsert",
            "routine_delete",
            "routine_run_now",
            "state_get",
            "state_set",
            "list_project_files",
            "read_text_file",
            "write_text_file",
            "path_exists",
            "read_file_base64",
            "write_temp_file",
            "agent_resolve",
            "agent_installed",
            "turn_start",
            "turn_stop",
            "turn_respond",
            "turn_answer",
            "transcript_tail",
            "messages_search",
        ] {
            let error = c.fail(method, json!(42)).await;
            assert!(error.starts_with("invalid type: integer `42`"), "{method}: {error}");
        }
    }

    #[tokio::test]
    async fn frames_the_daemon_has_no_use_for_are_ignored() {
        let d = Daemon::start();
        let mut c = d.client().await;
        c.ws.send(Message::Binary(vec![1u8, 2, 3].into())).await.expect("short frame");
        c.ws.send(Message::Pong(b"unasked".to_vec().into())).await.expect("pong");
        assert_eq!(c.ok("workspace_list", Value::Null).await, json!([]));
        assert!(c.events_seen("pty-error").is_empty());
    }

    #[tokio::test]
    async fn a_client_that_closes_is_let_go() {
        let d = Daemon::start();
        let mut c = d.client().await;
        c.ws.send(Message::Close(None)).await.expect("close");
        assert_hung_up(&mut c.ws).await;
    }

    // ---- the hub: fan-out and a client that falls behind ----

    fn text(body: &str) -> Outgoing {
        Outgoing::Text(body.into())
    }

    fn describe(msg: Outgoing) -> String {
        match msg {
            Outgoing::Text(text) => format!("text:{text}"),
            Outgoing::Binary(bytes) => format!("binary:{bytes:?}"),
            Outgoing::Pong(bytes) => format!("pong:{bytes:?}"),
        }
    }

    fn drain(rx: &mut mpsc::Receiver<Outgoing>) -> Vec<String> {
        std::iter::from_fn(|| rx.try_recv().ok()).map(describe).collect()
    }

    fn subscribed(hub: &Hub, id: u64) -> bool {
        hub.clients.lock().unwrap().contains_key(&id)
    }

    fn fill(hub: &Hub, id: u64) {
        for n in 0..OUT_CAP {
            hub.send(id, text(&n.to_string()));
        }
    }

    /// Frees one slot of a full queue, but only once another sender is parked
    /// on it, so the slot goes to that sender and not to a fresh `try_send`.
    /// Returns how many messages it took out.
    fn free_a_slot_for_the_parked_sender(tx: &mpsc::Sender<Outgoing>, rx: &mut mpsc::Receiver<Outgoing>) -> usize {
        use std::future::Future;
        use std::task::{Context, Poll, Waker};
        let mut cx = Context::from_waker(Waker::noop());
        // Slots this probe won while nobody was parked: holding them keeps the
        // queue full for the sender still on its way.
        let mut held = Vec::new();
        let deadline = std::time::Instant::now() + WITHIN;
        loop {
            let mut probe = std::pin::pin!(tx.reserve());
            assert!(probe.as_mut().poll(&mut cx).is_pending(), "the queue has room");
            rx.try_recv().expect("a queued message");
            // A freed slot goes to the first in line; if that was not the probe,
            // the sender was parked ahead of it.
            match probe.as_mut().poll(&mut cx) {
                Poll::Pending => return held.len() + 1,
                Poll::Ready(permit) => held.push(permit.expect("open")),
            }
            assert!(std::time::Instant::now() < deadline, "nothing parked on the full queue");
            std::thread::sleep(Duration::from_millis(1));
        }
    }

    #[test]
    fn broadcast_reaches_every_client_in_every_frame_kind() {
        let hub = Hub::new();
        let (_, mut a) = hub.subscribe();
        let (_, mut b) = hub.subscribe();
        hub.broadcast(text("hi"));
        hub.broadcast(Outgoing::Binary(vec![1, 2]));
        hub.broadcast(Outgoing::Pong(vec![3]));
        let want = vec!["text:hi", "binary:[1, 2]", "pong:[3]"];
        assert_eq!(drain(&mut a), want);
        assert_eq!(drain(&mut b), want);
    }

    #[test]
    fn terminal_output_goes_only_to_clients_that_attached() {
        let hub = Hub::new();
        let (watcher, mut watching) = hub.subscribe();
        let (_, mut other) = hub.subscribe();
        hub.watch_pty(watcher);
        hub.data(7, b"ls");
        assert_eq!(drain(&mut watching), vec![format!("binary:{:?}", [7u8, 0, 0, 0, b'l', b's'])]);
        assert!(drain(&mut other).is_empty());
        hub.unsubscribe(watcher);
        assert!(hub.pty_attached.lock().unwrap().is_empty(), "a client that left still watches");
    }

    #[test]
    fn an_event_that_cannot_be_encoded_is_not_sent() {
        let hub = Hub::new();
        let (_, mut rx) = hub.subscribe();
        hub.emit("bad", HashMap::from([((1, 2), "a tuple key is not JSON")]));
        hub.emit("good", json!({}));
        assert_eq!(drain(&mut rx), vec![r#"text:{"event":"good","payload":{}}"#]);
    }

    #[test]
    fn a_client_whose_queue_closed_is_dropped() {
        let hub = Hub::new();
        let (id, rx) = hub.subscribe();
        hub.send(id + 1, text("to nobody"));
        assert!(subscribed(&hub, id));
        drop(rx);
        hub.send(id, text("late"));
        assert!(!subscribed(&hub, id));
    }

    #[test]
    fn a_full_client_is_dropped_when_no_runtime_can_wait_for_it() {
        let hub = Hub::new();
        let (id, mut rx) = hub.subscribe();
        fill(&hub, id);
        hub.send(id, text("late"));
        assert!(!subscribed(&hub, id));
        let got = drain(&mut rx);
        assert_eq!(got.len(), OUT_CAP);
        assert_eq!(got.last(), Some(&format!("text:{}", OUT_CAP - 1)));
        assert!(matches!(rx.try_recv(), Err(mpsc::error::TryRecvError::Disconnected)));
    }

    #[test]
    fn a_full_client_keeps_what_a_terminal_thread_sends_once_it_drains() {
        let runtime = tokio::runtime::Builder::new_multi_thread()
            .worker_threads(1)
            .enable_all()
            .build()
            .expect("runtime");
        let hub = Arc::new(Hub::new());
        hub.set_runtime(runtime.handle().clone());
        let (id, mut rx) = hub.subscribe();
        fill(&hub, id);
        let tx = hub.clients.lock().unwrap()[&id].clone();
        let sender = {
            let hub = hub.clone();
            thread::spawn(move || hub.send(id, text("late")))
        };
        let freed = free_a_slot_for_the_parked_sender(&tx, &mut rx);
        sender.join().expect("sender");
        assert!(subscribed(&hub, id));
        let rest = drain(&mut rx);
        assert_eq!(freed + rest.len(), OUT_CAP + 1);
        assert_eq!(rest.last().map(String::as_str), Some("text:late"));
    }

    #[test]
    fn a_full_client_keeps_what_a_task_sends_once_it_drains() {
        let runtime = tokio::runtime::Builder::new_multi_thread()
            .worker_threads(2)
            .enable_all()
            .build()
            .expect("runtime");
        let hub = Arc::new(Hub::new());
        let (id, mut rx) = hub.subscribe();
        fill(&hub, id);
        let tx = hub.clients.lock().unwrap()[&id].clone();
        let sender = runtime.spawn({
            let hub = hub.clone();
            async move { hub.send(id, text("late")) }
        });
        let freed = free_a_slot_for_the_parked_sender(&tx, &mut rx);
        runtime.block_on(sender).expect("sender");
        assert!(subscribed(&hub, id));
        let rest = drain(&mut rx);
        assert_eq!(freed + rest.len(), OUT_CAP + 1);
        assert_eq!(rest.last().map(String::as_str), Some("text:late"));
    }

    #[tokio::test]
    async fn a_terminal_exit_reaches_every_client() {
        let d = Daemon::start();
        let mut a = d.client().await;
        let mut b = d.client().await;
        a.spawn_pty("t", &["/bin/sh", "-c", "exit 3"]).await;
        let exit = json!({ "id": "t", "code": 3 });
        assert_eq!(a.event("pty-exit").await, exit);
        assert_eq!(b.event("pty-exit").await, exit);
    }

    // ---- terminals ----

    #[tokio::test]
    async fn written_text_and_a_new_size_reach_the_terminal() {
        let d = Daemon::start();
        let mut c = d.client().await;
        let stream = c.spawn_pty("t", &["/bin/sh"]).await;
        let attached: proto::PtyAttached =
            serde_json::from_value(c.ok("pty_attach", json!({ "id": "t", "from": 0 })).await).expect("attached");
        assert_eq!(attached.start, 0);
        assert_eq!(c.ok("pty_resize", json!({ "id": "t", "cols": 132, "rows": 50 })).await, Value::Null);
        c.ok("pty_write", json!({ "id": "t", "data": "stty size; echo written-$((6*7))\n" })).await;
        let out = c.output_until(stream, "written-42").await;
        assert!(out.contains("50 132"), "{out}");

        assert_eq!(c.ok("pty_kill", json!({ "id": "t" })).await, Value::Null);
        assert_eq!(c.fail("pty_write", json!({ "id": "t", "data": "x" })).await, "Terminal is not running");
    }

    #[tokio::test]
    async fn calls_on_a_terminal_that_is_not_running_fail_or_do_nothing() {
        let d = Daemon::start();
        let mut c = d.client().await;
        for (method, params) in [
            ("pty_write", json!({ "id": "ghost", "data": "x" })),
            ("pty_resize", json!({ "id": "ghost", "cols": 80, "rows": 24 })),
            ("pty_attach", json!({ "id": "ghost", "from": 0 })),
        ] {
            assert_eq!(c.fail(method, params).await, "Terminal is not running", "{method}");
        }
        assert_eq!(c.ok("pty_ack", json!({ "id": "ghost", "processed": 10 })).await, Value::Null);
        assert_eq!(c.ok("pty_kill", json!({ "id": "ghost" })).await, Value::Null);
        let error = c
            .fail(
                "pty_spawn",
                json!({ "id": "t", "cwd": d.cwd(), "command": ["/no/such/program"], "cols": 80, "rows": 24 }),
            )
            .await;
        assert!(error.starts_with("Failed to start /no/such/program"), "{error}");
    }

    #[tokio::test]
    async fn terminal_input_is_written_in_the_order_it_was_sent() {
        let d = Daemon::start();
        let mut c = d.client().await;
        let echo = "import sys\nfor line in sys.stdin:\n    sys.stdout.write('IN' + line.strip() + '\\n'); sys.stdout.flush()\n";
        let stream = c.spawn_pty("t", &["/usr/bin/python3", "-c", echo]).await;
        c.ok("pty_attach", json!({ "id": "t", "from": 0 })).await;
        // Fewer than the queue holds, so none is refused for want of room.
        for n in 0..30 {
            c.input(stream, format!("k{n}\n").as_bytes()).await;
        }
        let out = c.output_until(stream, "INk29").await;
        let order: Vec<u32> = out
            .split("INk")
            .skip(1)
            .map(|rest| rest.chars().take_while(char::is_ascii_digit).collect::<String>().parse().expect("n"))
            .collect();
        assert_eq!(order, (0..30).collect::<Vec<_>>());
        c.ok("pty_kill", json!({ "id": "t" })).await;
    }

    #[tokio::test]
    async fn input_past_the_queue_cap_is_refused_with_a_pty_error() {
        let d = Daemon::start();
        let mut c = d.client().await;
        // It never reads, so the terminal's input buffer fills, the writer
        // blocks, and the frames behind it pile up in the queue.
        let stream = c.spawn_pty("t", &["/bin/sleep", "30"]).await;
        let chunk = [b"x".repeat(63), b"\n".to_vec()].concat().repeat(256);
        for _ in 0..48 {
            c.input(stream, &chunk).await;
        }
        assert_eq!(
            c.event("pty-error").await,
            json!({ "id": "t", "error": "Terminal is not accepting input" })
        );
        c.ok("pty_kill", json!({ "id": "t" })).await;
    }

    #[tokio::test]
    async fn input_for_a_terminal_that_is_gone_raises_a_pty_error() {
        let d = Daemon::start();
        let mut c = d.client().await;
        let ghost = u32::MAX;
        c.input(ghost, b"ls\n").await;
        assert_eq!(
            c.event("pty-error").await,
            json!({ "id": ghost.to_string(), "error": "Terminal is not running" })
        );
        // Its queue died with the writer, and says so for every later frame.
        // A frame can slip in before the queue is dropped, so keep sending.
        let deadline = Instant::now() + WITHIN;
        let refused = loop {
            c.input(ghost, b"ls\n").await;
            let pick = |msg: &Message| as_event(msg).filter(|e| e.event == "pty-error").map(|e| e.payload);
            if let Some(error) = c.take_by(Instant::now() + Duration::from_millis(200), &pick).await {
                break error;
            }
            assert!(Instant::now() < deadline, "no refusal for input to a dead queue");
        };
        assert_eq!(refused, json!({ "id": ghost.to_string(), "error": "Terminal is not accepting input" }));
    }

    // ---- workspaces ----

    #[tokio::test]
    async fn workspaces_are_created_listed_renamed_reordered_and_deleted() {
        let d = Daemon::start();
        let mut c = d.client().await;
        let one = c.workspace(" One ", &d.folder("one")).await;
        assert_eq!(one.name, "One");
        let two = c.workspace("Two", &d.folder("two")).await;

        c.ok("workspace_reorder", json!({ "ids": [two.id, one.id] })).await;
        assert_eq!(ids(c.ok("workspace_list", Value::Null).await), vec![two.id.clone(), one.id.clone()]);
        c.ok("workspace_reorder", json!({ "ids": [one.id, two.id] })).await;
        assert_eq!(ids(c.ok("workspace_list", Value::Null).await), vec![one.id.clone(), two.id.clone()]);

        c.ok("workspace_rename", json!({ "id": one.id, "name": "Uno" })).await;
        assert_eq!(c.ok("workspace_list", Value::Null).await[0]["name"], "Uno");

        let doomed = c.session(&two.id, "agent", "A", "claude").await;
        c.ok("workspace_delete", json!({ "id": two.id })).await;
        assert_eq!(ids(c.ok("workspace_list", Value::Null).await), vec![one.id.clone()]);
        assert_eq!(c.ok("session_list", json!({ "workspaceId": two.id })).await, json!([]));
        assert!(c.session_row(&doomed.id).await.is_none());
    }

    #[tokio::test]
    async fn workspace_writes_refuse_bad_input() {
        let d = Daemon::start();
        let mut c = d.client().await;
        let folder = d.folder("one");
        assert_eq!(
            c.fail("workspace_create", json!({ "name": " ", "path": folder })).await,
            "Workspace name is required"
        );
        let gone = d.path().join("gone").to_string_lossy().into_owned();
        assert_eq!(
            c.fail("workspace_create", json!({ "name": "Gone", "path": gone })).await,
            format!("{gone}: Not a directory")
        );
        let one = c.workspace("One", &folder).await;
        assert_eq!(
            c.fail("workspace_create", json!({ "name": "Again", "path": folder })).await,
            "Already open as \"One\""
        );
        assert_eq!(
            c.fail("workspace_rename", json!({ "id": one.id, "name": "" })).await,
            "Workspace name is required"
        );
    }

    #[tokio::test]
    async fn the_active_workspace_is_remembered_and_can_be_cleared() {
        let d = Daemon::start();
        let mut c = d.client().await;
        let w = c.workspace("w", &d.cwd()).await;
        assert_eq!(c.ok("active_workspace_get", Value::Null).await, Value::Null);
        c.ok("active_workspace_set", json!({ "id": w.id })).await;
        assert_eq!(c.ok("active_workspace_get", Value::Null).await, json!(w.id));
        c.ok("active_workspace_set", json!({ "id": null })).await;
        assert_eq!(c.ok("active_workspace_get", Value::Null).await, Value::Null);
    }

    // ---- sessions ----

    #[tokio::test]
    async fn sessions_are_created_listed_edited_reordered_and_deleted() {
        let d = Daemon::start();
        let mut c = d.client().await;
        let w = c.workspace("w", &d.cwd()).await;
        let a = c.session(&w.id, "agent", "  Ada  ", "claude").await;
        assert_eq!(
            (a.name.as_str(), a.kind.as_str(), a.status.as_str(), a.autonomy.as_str()),
            ("Ada", "agent", "idle", "ask")
        );
        let t = c.session(&w.id, "terminal", "codex", "codex").await;

        c.ok(
            "session_update",
            json!({
                "id": a.id, "name": "Ada 2", "provider": "claude", "model": "m2",
                "description": "writes", "notifications": false, "autonomy": "full"
            }),
        )
        .await;
        let row = c.session_row(&a.id).await.expect("row");
        assert_eq!(
            (row.name.as_str(), row.model.as_str(), row.description.as_str(), row.notifications, row.autonomy.as_str()),
            ("Ada 2", "m2", "writes", false, "full")
        );
        c.ok("session_rename", json!({ "id": a.id, "name": "Grace" })).await;
        assert_eq!(c.session_row(&a.id).await.expect("row").name, "Grace");

        c.ok("session_reorder", json!({ "ids": [t.id, a.id] })).await;
        assert_eq!(ids(c.ok("session_list", json!({ "workspaceId": w.id })).await), vec![t.id.clone(), a.id.clone()]);
        c.ok("session_reorder", json!({ "ids": [a.id, t.id] })).await;
        assert_eq!(ids(c.ok("session_list", json!({ "workspaceId": w.id })).await), vec![a.id.clone(), t.id.clone()]);

        c.ok("session_delete", json!({ "id": t.id })).await;
        assert_eq!(ids(c.ok("session_list", json!({ "workspaceId": w.id })).await), vec![a.id.clone()]);
        assert!(c.session_row(&t.id).await.is_none());
    }

    #[tokio::test]
    async fn session_writes_refuse_bad_input() {
        let d = Daemon::start();
        let mut c = d.client().await;
        let w = c.workspace("w", &d.cwd()).await;
        let a = c.session(&w.id, "agent", "Ada", "claude").await;
        assert_eq!(c.fail("session_create", new_session(&w.id, "agent", " ", "claude")).await, "Name is required");
        assert_eq!(
            c.fail("session_create", new_session(&w.id, "robot", "R", "claude")).await,
            "Unknown session kind: robot"
        );
        let orphan = c.fail("session_create", new_session("nowhere", "agent", "O", "claude")).await;
        assert!(orphan.contains("FOREIGN KEY"), "{orphan}");
        assert_eq!(
            c.fail(
                "session_update",
                json!({
                    "id": a.id, "name": "", "provider": "claude", "model": "m",
                    "description": "", "notifications": true, "autonomy": "ask"
                })
            )
            .await,
            "Name is required"
        );
        assert_eq!(c.fail("session_rename", json!({ "id": a.id, "name": " " })).await, "Name is required");
        assert_eq!(
            c.fail("session_set_status", json!({ "id": a.id, "status": "asleep" })).await,
            "Unknown session status: asleep"
        );
        assert!(c.session_row("missing").await.is_none());
    }

    #[tokio::test]
    async fn deleting_a_session_revokes_its_bridge_token() {
        let d = Daemon::start();
        let mut c = d.client().await;
        let w = c.workspace("w", &d.cwd()).await;
        let a = c.session(&w.id, "agent", "Ada", "claude").await;
        let info = d.bridge.info().expect("bridge info");
        let call = json!({
            "token": d.bridge.mint(&a.id),
            "method": "tools/call",
            "params": { "name": "list_agents", "arguments": {} }
        });
        assert!(unix_call(&info.socket_path, &call)["result"].is_object());
        c.ok("session_delete", json!({ "id": a.id })).await;
        assert_eq!(unix_call(&info.socket_path, &call)["error"], "Bad token");
    }

    #[tokio::test]
    async fn switching_provider_drops_the_provider_session() {
        let d = Daemon::start();
        let mut c = d.client().await;
        let w = c.workspace("w", &d.cwd()).await;
        let t = c.session(&w.id, "terminal", "Build", "claude").await;
        session::set_provider_session(&d.store, t.id.clone(), "claude-1".into()).expect("bind");
        let update = |provider: &str| {
            json!({
                "id": t.id, "name": "Build", "provider": provider, "model": "m",
                "description": "", "notifications": true, "autonomy": "ask"
            })
        };
        c.ok("session_update", update("claude")).await;
        assert_eq!(c.session_row(&t.id).await.expect("row").provider_session_id.as_deref(), Some("claude-1"));
        c.ok("session_update", update("codex")).await;
        assert_eq!(c.session_row(&t.id).await.expect("row").provider_session_id, None);
    }

    #[tokio::test]
    async fn busy_sessions_are_replayed_to_a_client_that_connects_later() {
        let d = Daemon::start();
        let mut c = d.client().await;
        let w = c.workspace("w", &d.cwd()).await;
        let working = c.session(&w.id, "agent", "W", "claude").await;
        let asking = c.session(&w.id, "agent", "Q", "claude").await;
        c.session(&w.id, "agent", "I", "claude").await;
        c.ok("session_set_status", json!({ "id": working.id, "status": "working" })).await;
        c.ok("session_set_status", json!({ "id": asking.id, "status": "needs-input" })).await;

        // The replay is sent before the socket reads anything, so it is all in
        // the backlog by the time the client's first reply is.
        let late = d.client().await;
        let mut replayed: Vec<(String, String)> = late
            .events_seen("session-status")
            .iter()
            .map(|p| (p["sessionId"].as_str().unwrap().to_string(), p["status"].as_str().unwrap().to_string()))
            .collect();
        replayed.sort();
        let mut want = vec![(working.id, "working".to_string()), (asking.id, "needs-input".to_string())];
        want.sort();
        assert_eq!(replayed, want);
    }

    #[tokio::test]
    async fn mark_read_settles_a_finished_turn_but_not_a_running_one() {
        let d = Daemon::start();
        let mut c = d.client().await;
        let w = c.workspace("w", &d.cwd()).await;
        let done = c.session(&w.id, "agent", "D", "claude").await;
        let busy = c.session(&w.id, "agent", "B", "claude").await;
        c.ok("session_set_status", json!({ "id": done.id, "status": "done" })).await;
        c.ok("session_set_status", json!({ "id": busy.id, "status": "working" })).await;
        c.ok("session_mark_read", json!({ "id": done.id })).await;
        c.ok("session_mark_read", json!({ "id": busy.id })).await;
        assert_eq!(c.session_row(&done.id).await.expect("row").status, "idle");
        assert_eq!(c.session_row(&busy.id).await.expect("row").status, "working");
    }

    #[tokio::test]
    async fn only_an_unnamed_terminal_nothing_was_said_in_is_disposable() {
        let d = Daemon::start();
        let mut c = d.client().await;
        let w = c.workspace("w", &d.cwd()).await;
        let fresh = c.session(&w.id, "terminal", "codex", "codex").await;
        let named = c.session(&w.id, "terminal", "Build", "codex").await;
        let used = c.session(&w.id, "terminal", "codex 2", "codex").await;
        session::set_provider_session(&d.store, used.id.clone(), "rollout-1".into()).expect("bind");
        let agent = c.session(&w.id, "agent", "codex", "codex").await;
        for (id, want) in [(&fresh.id, true), (&named.id, false), (&used.id, false), (&agent.id, false)] {
            assert_eq!(c.ok("session_is_disposable", json!({ "id": id })).await, json!(want), "{id}");
        }
        assert_eq!(c.ok("session_is_disposable", json!({ "id": "missing" })).await, json!(false));
    }

    #[tokio::test]
    async fn sync_title_leaves_agents_and_unbound_terminals_alone() {
        let d = Daemon::start();
        let mut c = d.client().await;
        let w = c.workspace("w", &d.cwd()).await;
        let agent = c.session(&w.id, "agent", "Ada", "claude").await;
        let terminal = c.session(&w.id, "terminal", "codex", "codex").await;
        for row in [&agent, &terminal] {
            assert_eq!(c.ok("session_sync_title", json!({ "id": row.id })).await, Value::Null);
            assert_eq!(c.session_row(&row.id).await.expect("row").name, row.name);
        }
        assert_eq!(c.fail("session_sync_title", json!({ "id": "missing" })).await, "Session not found");
    }

    // ---- provider sessions ----

    #[tokio::test]
    async fn provider_create_hands_back_a_binding_and_refuses_what_cannot_create_ahead() {
        let d = Daemon::start();
        let mut c = d.client().await;
        let w = c.workspace("w", &d.cwd()).await;
        let unbound = c.session(&w.id, "terminal", "claude", "claude").await;
        let bound = c.session(&w.id, "terminal", "cursor", "cursor").await;
        session::set_provider_session(&d.store, bound.id.clone(), "chat-7".into()).expect("bind");
        assert_eq!(
            c.fail("session_provider_create", json!({ "id": unbound.id })).await,
            "claude does not create sessions ahead of time"
        );
        assert_eq!(c.ok("session_provider_create", json!({ "id": bound.id })).await, json!("chat-7"));
        assert_eq!(c.fail("session_provider_create", json!({ "id": "missing" })).await, "Session not found");
        assert_eq!(c.session_row(&unbound.id).await.expect("row").provider_session_id, None);
    }

    #[tokio::test]
    async fn provider_discover_keeps_a_binding_and_finds_nothing_for_claude() {
        let d = Daemon::start();
        let mut c = d.client().await;
        let w = c.workspace("w", &d.cwd()).await;
        let unbound = c.session(&w.id, "terminal", "claude", "claude").await;
        let bound = c.session(&w.id, "terminal", "codex", "codex").await;
        session::set_provider_session(&d.store, bound.id.clone(), "rollout-7".into()).expect("bind");
        let discover = |id: &str| json!({ "id": id, "cwd": d.cwd(), "since": 0 });
        assert_eq!(c.ok("session_provider_discover", discover(&bound.id)).await, json!("rollout-7"));
        assert_eq!(c.ok("session_provider_discover", discover(&unbound.id)).await, Value::Null);
        assert_eq!(c.session_row(&unbound.id).await.expect("row").provider_session_id, None);
        assert_eq!(c.fail("session_provider_discover", discover("missing")).await, "Session not found");
    }

    #[tokio::test]
    async fn claude_rebind_without_a_hook_record_changes_nothing() {
        let d = Daemon::start();
        let mut c = d.client().await;
        let w = c.workspace("w", &d.cwd()).await;
        let t = c.session(&w.id, "terminal", "claude", "claude").await;
        session::set_provider_session(&d.store, t.id.clone(), "claude-1".into()).expect("bind");
        assert_eq!(c.ok("session_claude_rebind", json!({ "id": t.id })).await, Value::Null);
        assert_eq!(c.session_row(&t.id).await.expect("row").provider_session_id.as_deref(), Some("claude-1"));
    }

    // ---- routines ----

    fn routine_params(id: Option<&str>, session_id: &str, name: &str) -> Value {
        json!({
            "id": id,
            "sessionId": session_id,
            "name": name,
            "enabled": true,
            "prompt": "check the build",
            "schedule": r#"{"kind":"interval","minutes":60}"#,
            "createdBy": null
        })
    }

    #[tokio::test]
    async fn routines_are_saved_listed_updated_and_deleted() {
        let d = Daemon::start();
        let mut c = d.client().await;
        let w = c.workspace("w", &d.cwd()).await;
        let a = c.session(&w.id, "agent", "Ada", "claude").await;
        let saved = c.save_routine(routine_params(None, &a.id, "Nightly")).await;
        assert_eq!(
            (saved.session_id.as_str(), saved.name.as_str(), saved.next_run_at),
            (a.id.as_str(), "Nightly", None)
        );
        let mine: Vec<String> = c.routines(&a.id).await.into_iter().map(|r| r.id).collect();
        assert_eq!(mine, vec![saved.id.clone()]);

        let all: Vec<proto::ScheduledRoutine> =
            serde_json::from_value(c.ok("routine_list", Value::Null).await).expect("scheduled");
        assert_eq!(all.len(), 1);
        assert_eq!((all[0].routine.id.as_str(), all[0].session.id.as_str()), (saved.id.as_str(), a.id.as_str()));
        assert_eq!(all[0].cwd, d.cwd());

        c.save_routine(routine_params(Some(&saved.id), &a.id, "Weekly")).await;
        let rows = c.routines(&a.id).await;
        assert_eq!((rows.len(), rows[0].id.as_str(), rows[0].name.as_str()), (1, saved.id.as_str(), "Weekly"));

        c.ok("routine_delete", json!({ "id": saved.id })).await;
        assert!(c.routines(&a.id).await.is_empty());
    }

    #[tokio::test]
    async fn a_routine_needs_a_session_and_run_now_needs_a_routine() {
        let d = Daemon::start();
        let mut c = d.client().await;
        let orphan = c.fail("routine_upsert", routine_params(None, "nobody", "Lost")).await;
        assert!(orphan.contains("FOREIGN KEY"), "{orphan}");
        assert_eq!(c.fail("routine_run_now", json!({ "routineId": "nope" })).await, "No routine nope");
    }

    #[tokio::test]
    async fn run_now_on_a_busy_agent_records_a_skip_and_tells_every_client() {
        let d = Daemon::start();
        let mut c = d.client().await;
        let mut other = d.client().await;
        let w = c.workspace("w", &d.cwd()).await;
        let a = c.session(&w.id, "agent", "Ada", "claude").await;
        c.ok("session_set_status", json!({ "id": a.id, "status": "working" })).await;
        let saved = c.save_routine(routine_params(None, &a.id, "Nightly")).await;

        c.ok("routine_run_now", json!({ "routineId": saved.id })).await;
        assert_eq!(c.event("routines-changed").await, json!({}));
        assert_eq!(other.event("routines-changed").await, json!({}));
        let runs = routine::parse_runs(&c.routines(&a.id).await[0].runs_json);
        assert_eq!(runs.len(), 1);
        assert_eq!(runs[0].status, routine::RunStatus::Skipped);
        assert_eq!(runs[0].trigger, routine::RunTrigger::Manual);
    }

    #[tokio::test]
    async fn an_agent_sets_up_a_routine_and_removes_it_over_the_bridge() {
        let d = Daemon::start();
        let mut c = d.client().await;
        let w = c.workspace("w", &d.cwd()).await;
        let a = c.session(&w.id, "agent", "Ada", "claude").await;
        d.tool(
            &a.id,
            "upsert_routine",
            json!({ "name": "Standup", "prompt": "report", "schedule": { "kind": "interval", "minutes": 60 } }),
        );
        let rows = c.routines(&a.id).await;
        assert_eq!(rows.len(), 1);
        assert_eq!((rows[0].name.as_str(), rows[0].created_by.as_deref()), ("Standup", Some(a.id.as_str())));
        assert!(rows[0].next_run_at.is_some(), "an enabled routine gets a next run");

        let said = d.tool(&a.id, "delete_routine", json!({ "routine_id": rows[0].id }));
        assert!(said.starts_with("Deleted \"Standup\""), "{said}");
        assert!(c.routines(&a.id).await.is_empty());
    }

    // ---- app state, files, agent lookups ----

    #[tokio::test]
    async fn app_state_round_trips_and_a_missing_key_reads_null() {
        let d = Daemon::start();
        let mut c = d.client().await;
        assert_eq!(c.ok("state_get", json!({ "key": "tabs:w" })).await, Value::Null);
        c.ok("state_set", json!({ "key": "tabs:w", "value": "one" })).await;
        c.ok("state_set", json!({ "key": "tabs:w", "value": "two" })).await;
        assert_eq!(c.ok("state_get", json!({ "key": "tabs:w" })).await, json!("two"));
    }

    #[tokio::test]
    async fn project_files_are_listed_read_written_and_probed() {
        let d = Daemon::start();
        let mut c = d.client().await;
        let root = std::path::PathBuf::from(d.folder("proj"));
        std::fs::create_dir_all(root.join("sub")).expect("sub");
        std::fs::write(root.join("a.txt"), "alpha").expect("a");
        std::fs::write(root.join("sub/b.rs"), "fn b() {}").expect("b");
        std::fs::write(root.join("p.png"), [0x89, b'P', b'N', b'G']).expect("png");
        let at = |name: &str| root.join(name).to_string_lossy().into_owned();

        let files: Vec<proto::ProjectFile> =
            serde_json::from_value(c.ok("list_project_files", json!({ "cwd": root })).await).expect("files");
        let mut relative: Vec<&str> = files.iter().map(|f| f.relative.as_str()).collect();
        relative.sort();
        assert_eq!(relative, vec!["a.txt", "p.png", "sub/b.rs"]);

        assert_eq!(c.ok("read_text_file", json!({ "path": at("a.txt") })).await, json!("alpha"));
        c.ok("write_text_file", json!({ "path": at("c.txt"), "contents": "gamma" })).await;
        assert_eq!(std::fs::read_to_string(root.join("c.txt")).expect("c"), "gamma");
        assert_eq!(c.ok("path_exists", json!({ "path": at("c.txt") })).await, json!(true));
        assert_eq!(c.ok("path_exists", json!({ "path": at("nope") })).await, json!(false));
        assert_eq!(
            c.ok("read_file_base64", json!({ "path": at("p.png") })).await,
            json!({ "mime": "image/png", "data": "iVBORw==" })
        );

        let temp = c.ok("write_temp_file", json!({ "extension": "P.N.G!", "base64Contents": "aGk=" })).await;
        let temp = temp.as_str().expect("temp path");
        assert!(temp.ends_with(".png"), "{temp}");
        assert_eq!(std::fs::read(temp).expect("temp file"), b"hi");
        std::fs::remove_file(temp).expect("clean up");
    }

    #[tokio::test]
    async fn file_calls_on_paths_that_are_not_there_fail() {
        let d = Daemon::start();
        let mut c = d.client().await;
        let gone = d.path().join("gone");
        let at = |name: &str| gone.join(name).to_string_lossy().into_owned();
        assert_eq!(
            c.fail("list_project_files", json!({ "cwd": gone })).await,
            format!("{}: Not a directory", gone.display())
        );
        for (method, params) in [
            ("read_text_file", json!({ "path": at("a.txt") })),
            ("write_text_file", json!({ "path": at("a.txt"), "contents": "x" })),
            ("read_file_base64", json!({ "path": at("a.png") })),
        ] {
            let error = c.fail(method, params).await;
            assert!(error.contains("No such file"), "{method}: {error}");
        }
        let error = c.fail("write_temp_file", json!({ "extension": "png", "base64Contents": "not base64!" })).await;
        assert!(error.starts_with("Clipboard data is not valid base64"), "{error}");
    }

    #[tokio::test]
    async fn agent_lookups_refuse_paths_and_blank_names() {
        let d = Daemon::start();
        let mut c = d.client().await;
        assert_eq!(c.fail("agent_resolve", json!({ "name": "" })).await, "Not a binary name: ");
        assert_eq!(c.fail("agent_resolve", json!({ "name": "bin/claude" })).await, "Not a binary name: bin/claude");
        assert_eq!(c.ok("agent_installed", json!({ "names": ["bin/claude", "./codex"] })).await, json!([]));
    }

    // ---- turns ----

    #[tokio::test]
    async fn a_retried_send_is_answered_without_running_the_turn_twice() {
        let d = Daemon::start();
        d.fake("claude", &write_fake_claude(d.path()));
        let mut c = d.client().await;
        let w = c.workspace("w", &d.cwd()).await;
        let a = c.session(&w.id, "agent", "Ada", "claude").await;
        let send = json!({ "sessionId": a.id, "cwd": d.cwd(), "text": "hi", "nonce": "enter-1" });
        assert_eq!(c.ok("turn_start", send.clone()).await, json!({ "working": true }));
        assert!(c.ok("turn_start", send).await["working"].is_boolean());
        c.status(&a.id, "done").await;
        let users = c.transcript(&a.id).await.blocks.into_iter().filter(|b| b.role == proto::BlockRole::User).count();
        assert_eq!(users, 1);
    }

    #[tokio::test]
    async fn turn_calls_with_nothing_to_act_on_fail() {
        let d = Daemon::start();
        let mut c = d.client().await;
        let w = c.workspace("w", &d.cwd()).await;
        let a = c.session(&w.id, "agent", "Ada", "claude").await;
        assert_eq!(
            c.fail("turn_start", json!({ "sessionId": "missing", "cwd": d.cwd(), "text": "hi" })).await,
            "Session not found"
        );
        assert_eq!(
            c.fail("turn_respond", json!({ "sessionId": a.id, "requestId": 1, "decision": "allow" })).await,
            "No approval is waiting"
        );
        assert_eq!(
            c.fail("turn_answer", json!({ "sessionId": a.id, "requestId": 1, "answers": null })).await,
            "No question is waiting"
        );
        assert_eq!(c.ok("turn_stop", json!({ "sessionId": a.id })).await, Value::Null);
    }

    #[tokio::test]
    async fn an_answer_reaches_claude_and_resolves_the_question() {
        let d = Daemon::start();
        d.fake("claude", &write_fake_claude_question(d.path()));
        let mut c = d.client().await;
        let w = c.workspace("w", &d.cwd()).await;
        let a = c.session(&w.id, "agent", "Ada", "claude").await;
        c.ok("turn_start", json!({ "sessionId": a.id, "cwd": d.cwd(), "text": "pick one" })).await;
        let asked = c.event_where("transcript-apply", |p| p["event"]["type"] == "question.requested").await;
        let request_id = asked["event"]["requestId"].as_u64().expect("request id");
        c.status(&a.id, "needs-input").await;

        c.ok(
            "turn_answer",
            json!({ "sessionId": a.id, "requestId": request_id, "answers": { "Pick a color": "Red" } }),
        )
        .await;
        c.status(&a.id, "done").await;
        let page = c.transcript(&a.id).await;
        let question = page.blocks.iter().find_map(|b| b.question.as_ref()).expect("question block");
        assert_eq!(question.answers, Some(HashMap::from([("Pick a color".to_string(), "Red".to_string())])));
        let said: Vec<&str> =
            page.blocks.iter().filter(|b| b.role == proto::BlockRole::Assistant).map(|b| b.text.as_str()).collect();
        assert_eq!(said, vec!["picked Red"]);
    }

    #[tokio::test]
    async fn a_claude_that_dies_mid_turn_fails_the_turn_with_its_stderr() {
        let d = Daemon::start();
        d.fake("claude", &write_fake_claude_dies(d.path()));
        let mut c = d.client().await;
        let w = c.workspace("w", &d.cwd()).await;
        let a = c.session(&w.id, "agent", "Ada", "claude").await;
        c.ok("turn_start", json!({ "sessionId": a.id, "cwd": d.cwd(), "text": "hi" })).await;
        c.status(&a.id, "error").await;
        let page = c.transcript(&a.id).await;
        assert_eq!(system_errors(&page), vec!["Claude Code exited with code 3.\nboom"]);
    }

    #[tokio::test]
    async fn messages_search_finds_what_a_turn_said() {
        let d = Daemon::start();
        d.fake("claude", &write_fake_claude(d.path()));
        let mut c = d.client().await;
        let w = c.workspace("w", &d.cwd()).await;
        let a = c.session(&w.id, "agent", "Ada", "claude").await;
        c.ok("turn_start", json!({ "sessionId": a.id, "cwd": d.cwd(), "text": "hi" })).await;
        c.status(&a.id, "done").await;
        let hits: Vec<proto::SearchHit> =
            serde_json::from_value(c.ok("messages_search", json!({ "query": "hello", "workspaceId": w.id })).await)
                .expect("hits");
        assert_eq!(hits.len(), 1, "{hits:?}");
        assert_eq!((hits[0].session_id.as_str(), &hits[0].role), (a.id.as_str(), &proto::BlockRole::Assistant));
        assert_eq!(c.ok("messages_search", json!({ "query": "  " })).await, json!([]));
    }

    #[tokio::test]
    async fn a_message_to_an_idle_agent_is_delivered_at_once() {
        let d = Daemon::start();
        d.fake("claude", &write_fake_claude(d.path()));
        let mut c = d.client().await;
        let w = c.workspace("w", &d.cwd()).await;
        let from = c.session(&w.id, "agent", "Ada", "claude").await;
        let to = c.session(&w.id, "agent", "Bob", "claude").await;
        let reply: Value =
            serde_json::from_str(&d.tool(&from.id, "message_agent", json!({ "to": to.id, "text": "ping" })))
                .expect("reply");
        assert_eq!(reply["delivered"], true, "{reply}");
        c.status(&to.id, "done").await;
        let page = c.transcript(&to.id).await;
        let letter = page.blocks.iter().find(|b| b.from_agent.is_some()).expect("letter");
        assert_eq!(letter.text, "ping");
        assert_eq!(letter.from_agent.as_ref().map(|f| f.id.as_str()), Some(from.id.as_str()));
    }
}
