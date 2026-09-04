use std::collections::{HashMap, HashSet};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{mpsc as std_mpsc, Arc, Mutex};
use std::thread;

use crew_core::agent::{AgentEvents, AgentHost};
use crew_core::bridge::{Bridge, BridgeEvents, ToolCall};
use crew_core::files;
use crew_core::pty::{PtyEvents, PtyHost};
use crew_core::routine;
use crew_core::session;
use crew_core::store::{self as app_state, Store};
use crew_core::workspace;
use crew_protocol::{
    self as proto, AgentSpawn, Auth, BridgeReply, Cwd, DaemonInfo, Id, IdBlocks, IdName, IdProvider, IdStatus,
    Ids, Key, KeyValue, Name, NamePath, OptionalId, PathArg, PathContents, PtyAck, PtyAttach, PtyAttached, PtyKill,
    PtyResize, PtySpawn, PtyWrite, Request, RoutineMark, RoutineUpsert, SessionCreate, SessionId, SessionLine,
    SessionUpdate, TempFile, WorkspaceId,
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
    agents: AgentHost,
    bridge: Bridge,
}

pub struct Handle {
    pub info: DaemonInfo,
    shutdown: Mutex<Option<tokio::sync::oneshot::Sender<()>>>,
}

impl Handle {
    pub fn url(&self) -> &str {
        &self.info.url
    }

    pub fn token(&self) -> &str {
        &self.info.token
    }

    pub fn shutdown(&self) {
        if let Some(tx) = self.shutdown.lock().unwrap_or_else(|e| e.into_inner()).take() {
            let _ = tx.send(());
        }
    }
}

enum Outgoing {
    Text(String),
    Binary(Vec<u8>),
    Pong(Vec<u8>),
}

struct Hub {
    clients: Mutex<HashMap<u64, mpsc::UnboundedSender<Outgoing>>>,
    pty_attached: Mutex<HashSet<u64>>,
    next: AtomicU64,
}

impl Hub {
    fn new() -> Self {
        Self {
            clients: Mutex::new(HashMap::new()),
            pty_attached: Mutex::new(HashSet::new()),
            next: AtomicU64::new(1),
        }
    }

    fn subscribe(&self) -> (u64, mpsc::UnboundedReceiver<Outgoing>) {
        let (tx, rx) = mpsc::unbounded_channel();
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
        if let Some(tx) = tx {
            let _ = tx.send(msg);
        }
    }

    fn broadcast(&self, msg: Outgoing) {
        let clients: Vec<mpsc::UnboundedSender<Outgoing>> = self
            .clients
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .values()
            .cloned()
            .collect();
        for tx in clients {
            let _ = tx.send(match &msg {
                Outgoing::Text(text) => Outgoing::Text(text.clone()),
                Outgoing::Binary(bytes) => Outgoing::Binary(bytes.clone()),
                Outgoing::Pong(payload) => Outgoing::Pong(payload.clone()),
            });
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

impl AgentEvents for Hub {
    fn lines(&self, event: &str, session_id: &str, lines: Vec<String>) {
        self.emit(
            event,
            proto::AgentLines {
                session_id: session_id.to_string(),
                lines,
            },
        );
    }

    fn exit(&self, session_id: &str, code: Option<i32>, pid: u32) {
        self.emit(
            "agent-exit",
            proto::AgentExit {
                session_id: session_id.to_string(),
                code,
                pid,
            },
        );
    }
}

impl BridgeEvents for Hub {
    fn tool(&self, call: ToolCall) {
        self.emit(
            "agent-tool",
            proto::ToolCall {
                id: call.id,
                session_id: call.session_id,
                method: call.method,
                params: call.params,
            },
        );
    }
}

pub fn serve(config: Config) -> Result<Handle, String> {
    let token = random_token();
    let hub = Arc::new(Hub::new());
    config.pty.set_events(hub.clone());
    config.agents.set_events(hub.clone());
    config.bridge.set_events(hub.clone());

    let (ready_tx, ready_rx) = std_mpsc::channel();
    let (stop_tx, stop_rx) = tokio::sync::oneshot::channel();
    let hosts = Hosts {
        pty: config.pty,
        store: config.store,
        agents: config.agents,
        bridge: config.bridge,
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
    for call in hosts.bridge.pending_tools() {
        hub.send(
            client_id,
            Outgoing::Text(encode(&match proto::event(
                "agent-tool",
                proto::ToolCall {
                    id: call.id,
                    session_id: call.session_id,
                    method: call.method,
                    params: call.params,
                },
            ) {
                Ok(event) => event,
                Err(_) => continue,
            })),
        );
    }
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
        "session_get_blocks" => {
            let Id { id } = parse(params)?;
            let store = hosts.store.clone();
            json(block(move || session::get_blocks(&store, id)).await?)
        }
        "session_set_blocks" => {
            let IdBlocks { id, blocks_json } = parse(params)?;
            let store = hosts.store.clone();
            block(move || session::set_blocks(&store, id, blocks_json)).await?;
            Ok(Value::Null)
        }
        "session_set_provider_session" => {
            let IdProvider { id, provider_session_id } = parse(params)?;
            let store = hosts.store.clone();
            block(move || session::set_provider_session(&store, id, provider_session_id)).await?;
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
        "agent_spawn" => {
            let p: AgentSpawn = parse(params)?;
            let host = hosts.agents.clone();
            json(block(move || host.spawn(p.session_id, p.command, p.args, p.cwd, p.env)).await?)
        }
        "agent_write" => {
            let SessionLine { session_id, line } = parse(params)?;
            let host = hosts.agents.clone();
            block(move || host.write(&session_id, &line)).await?;
            Ok(Value::Null)
        }
        "agent_close_stdin" => {
            let SessionId { session_id } = parse(params)?;
            let host = hosts.agents.clone();
            block(move || {
                host.close_stdin(&session_id);
                Ok(())
            })
            .await?;
            Ok(Value::Null)
        }
        "agent_kill" => {
            let SessionId { session_id } = parse(params)?;
            let host = hosts.agents.clone();
            block(move || {
                host.kill(&session_id);
                Ok(())
            })
            .await?;
            Ok(Value::Null)
        }
        "agent_kill_all" => {
            let host = hosts.agents.clone();
            block(move || {
                host.kill_all();
                Ok(())
            })
            .await?;
            Ok(Value::Null)
        }
        "agent_running" => {
            let host = hosts.agents.clone();
            json(block(move || Ok(host.running())).await?)
        }
        "bridge_info" => {
            let bridge = hosts.bridge.clone();
            json(block(move || bridge.info()).await?)
        }
        "bridge_reply" => {
            let BridgeReply { id, response } = parse(params)?;
            let bridge = hosts.bridge.clone();
            block(move || bridge.reply(id, response)).await?;
            Ok(Value::Null)
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
    async fn pending_tool_is_replayed_after_reconnect() {
        let dir = test_dir("tool-replay");
        let handle = test_serve(&dir);
        let mut ws = connect_authed(&handle).await;
        send_json(
            &mut ws,
            &Request {
                id: 1,
                method: "bridge_info".into(),
                params: serde_json::json!({}),
            },
        )
        .await;
        let info_resp = wait_response(&mut ws, 1).await;
        assert!(info_resp.ok, "{}", info_resp.error.unwrap_or_default());
        let info: proto::BridgeInfo = serde_json::from_value(info_resp.result.expect("info")).expect("BridgeInfo");
        drop(ws);

        let payload = serde_json::json!({
            "token": info.token,
            "sessionId": "s1",
            "method": "tools/list",
            "params": {}
        });
        {
            let mut stream = std::os::unix::net::UnixStream::connect(&info.socket_path).expect("unix");
            use std::io::Write;
            writeln!(stream, "{payload}").expect("write");
        }
        tokio::time::sleep(std::time::Duration::from_millis(150)).await;

        let mut ws = connect_authed(&handle).await;
        let event = wait_event(&mut ws, "agent-tool").await;
        let call: proto::ToolCall = serde_json::from_value(event.payload).expect("ToolCall");
        assert_eq!(call.session_id, "s1");
        assert_eq!(call.method, "tools/list");
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
}
