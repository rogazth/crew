use std::collections::{HashMap, HashSet};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{mpsc as std_mpsc, Arc, Mutex};
use std::thread;
use std::time::Duration;

use crew_core::agent::{AgentEvents, AgentHost};
use crew_core::bridge::{Bridge, ToolHost};
use crew_core::files;
use crew_core::messages;
use crew_core::pty::{PtyEvents, PtyHost};
use crew_core::routine;
use crew_core::session;
use crew_core::store::{self as app_state, Store};
use crew_core::transcript::TranscriptEvents;
use crew_core::turns::TurnHost;
use crew_core::workspace;
use crew_protocol::{
    self as proto, Auth, Cwd, DaemonInfo, Id, IdName, IdStatus, Ids, Key, KeyValue, Name, NamePath,
    OptionalId, PathArg, PathContents, PtyAck, PtyAttach, PtyAttached, PtyKill, PtyResize, PtySpawn, PtyWrite,
    Request, RoutineMark, RoutineUpsert, SessionCreate, SessionCreated, SessionId, SessionUpdate, TempFile,
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
}

pub struct Handle {
    pub info: DaemonInfo,
    shutdown: Mutex<Option<tokio::sync::oneshot::Sender<()>>>,
    turns: TurnHost,
}

impl Handle {
    pub fn url(&self) -> &str {
        &self.info.url
    }

    pub fn token(&self) -> &str {
        &self.info.token
    }

    pub fn shutdown(&self) {
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

struct AgentFanout {
    turns: TurnHost,
}

struct ToolDispatch {
    store: crew_core::store::Store,
    transcripts: crew_core::transcript::TranscriptHub,
    turns: TurnHost,
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
    config.bridge.set_handler(Arc::new(ToolDispatch {
        store: config.store.clone(),
        transcripts,
        turns: turns.clone(),
        hub: hub.clone(),
    }));

    // A letter left waiting for an idle agent is invisible until someone
    // messages it: only the end of a turn looks in a box.
    turns.deliver_waiting();

    let (ready_tx, ready_rx) = std_mpsc::channel();
    let (stop_tx, stop_rx) = tokio::sync::oneshot::channel();
    let hosts = Hosts {
        pty: config.pty,
        store: config.store,
        bridge: config.bridge,
        turns: turns.clone(),
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
            block(move || session::delete(&store, id)).await?;
            Ok(Value::Null)
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
            json(block(move || {
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
            .await?)
        }
        "routine_delete" => {
            let Id { id } = parse(params)?;
            let store = hosts.store.clone();
            block(move || routine::delete(&store, id)).await?;
            Ok(Value::Null)
        }
        "routine_mark_run" => {
            let p: RoutineMark = parse(params)?;
            let store = hosts.store.clone();
            block(move || routine::mark_run(&store, p.id, p.last_run_at, p.next_run_at, p.runs_json)).await?;
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
        "bridge_info" => {
            let bridge = hosts.bridge.clone();
            json(block(move || bridge.info()).await?)
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
        serve(Config {
            pty: PtyHost::new(),
            store: Store::open(dir.join("crew.sqlite3")).expect("store"),
            agents: AgentHost::new(),
            bridge: Bridge::start(dir.to_path_buf()).expect("bridge"),
        })
        .expect("serve")
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
        let handle = test_serve(&dir);
        let mut ws = connect_authed(&handle).await;
        let session_id = seed_agent(&mut ws, dir.to_str().unwrap()).await;
        send_json(
            &mut ws,
            &Request {
                id: 3,
                method: "bridge_info".into(),
                params: serde_json::json!({}),
            },
        )
        .await;
        let info: proto::BridgeInfo =
            serde_json::from_value(wait_response(&mut ws, 3).await.result.expect("info")).expect("BridgeInfo");
        drop(ws);
        let payload = serde_json::json!({
            "token": info.token,
            "sessionId": session_id,
            "method": "tools/call",
            "params": { "name": "list_agents", "arguments": {} }
        });
        let reply = unix_call(&info.socket_path, &payload);
        let text = reply["result"]["content"][0]["text"].as_str().unwrap_or("");
        assert!(text.contains(&session_id), "reply: {reply}");
        handle.shutdown();
    }

    #[tokio::test]
    async fn create_agent_emits_session_created() {
        let dir = test_dir("tool-created");
        let handle = test_serve(&dir);
        let mut ws = connect_authed(&handle).await;
        let session_id = seed_agent(&mut ws, dir.to_str().unwrap()).await;
        send_json(
            &mut ws,
            &Request {
                id: 3,
                method: "bridge_info".into(),
                params: serde_json::json!({}),
            },
        )
        .await;
        let info: proto::BridgeInfo =
            serde_json::from_value(wait_response(&mut ws, 3).await.result.expect("info")).expect("BridgeInfo");
        let payload = serde_json::json!({
            "token": info.token,
            "sessionId": session_id,
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
        let dir = test_dir("turn-stop-init");
        let handle = test_serve(&dir);
        let fake = write_fake_claude_hang_init(&dir);
        handle.override_agent_binary("claude", fake.to_string_lossy().into_owned());
        let mut ws = connect_authed(&handle).await;
        let session_id = seed_agent(&mut ws, dir.to_str().unwrap()).await;
        start_turn(&mut ws, 3, &session_id, dir.to_str().unwrap()).await;
        send_json(
            &mut ws,
            &Request {
                id: 4,
                method: "turn_stop".into(),
                params: serde_json::json!({ "sessionId": session_id }),
            },
        )
        .await;
        assert!(wait_response(&mut ws, 4).await.ok);
        wait_status(&mut ws, &session_id, "idle").await;
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
}
