use std::collections::HashMap;
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
    self as proto, Auth, DaemonInfo, PtyAck, PtyAttach, PtyKill, PtyResize, PtySpawn, PtyWrite, Request,
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
}

struct Hub {
    clients: Mutex<HashMap<u64, mpsc::UnboundedSender<Outgoing>>>,
    next: AtomicU64,
}

impl Hub {
    fn new() -> Self {
        Self {
            clients: Mutex::new(HashMap::new()),
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

    fn unsubscribe(&self, id: u64) {
        self.clients
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
        self.broadcast(Outgoing::Binary(frame));
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
    let writer = tokio::spawn(async move {
        while let Some(msg) = outgoing.recv().await {
            let sent = match msg {
                Outgoing::Text(text) => sink.send(Message::Text(text.into())).await,
                Outgoing::Binary(bytes) => sink.send(Message::Binary(bytes.into())).await,
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
                    let reply = dispatch_text(&hosts, text.as_ref()).await;
                    hub.send(client_id, Outgoing::Text(reply));
                });
            }
            Message::Binary(bytes) => {
                if bytes.len() < 4 {
                    continue;
                }
                let stream_id = u32::from_le_bytes(bytes[..4].try_into().unwrap());
                enqueue_pty_input(&pty_in, &hosts, stream_id, bytes[4..].to_vec());
            }
            Message::Close(_) => break,
            Message::Ping(_) | Message::Pong(_) | Message::Frame(_) => {}
        }
    }

    hub.unsubscribe(client_id);
    writer.abort();
}

fn enqueue_pty_input(
    pty_in: &Mutex<HashMap<u32, mpsc::Sender<Vec<u8>>>>,
    hosts: &Hosts,
    stream_id: u32,
    data: Vec<u8>,
) {
    let mut map = pty_in.lock().unwrap_or_else(|e| e.into_inner());
    if let Some(tx) = map.get(&stream_id) {
        let _ = tx.try_send(data);
        return;
    }
    let (tx, rx) = mpsc::channel(32);
    let _ = tx.try_send(data);
    map.insert(stream_id, tx);
    drop(map);
    let host = hosts.pty.clone();
    tokio::spawn(async move {
        drain_pty_input(host, stream_id, rx).await;
    });
}

async fn drain_pty_input(host: PtyHost, stream_id: u32, mut rx: mpsc::Receiver<Vec<u8>>) {
    while let Some(data) = rx.recv().await {
        let host = host.clone();
        let _ = tokio::task::spawn_blocking(move || host.write_stream(stream_id, &data)).await;
    }
}

async fn dispatch_text(hosts: &Hosts, text: &str) -> String {
    let request = match serde_json::from_str::<Request>(text) {
        Ok(request) => request,
        Err(error) => return encode(&proto::err(0, format!("Bad request: {error}"))),
    };
    let result = dispatch(hosts, &request.method, request.params).await;
    encode(&match result {
        Ok(value) => proto::ok(request.id, value),
        Err(error) => proto::err(request.id, error),
    })
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
        "pty_attach" => {
            let PtyAttach { id, from } = parse(params)?;
            let host = hosts.pty.clone();
            json(block(move || host.attach(&id, from)).await?)
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

#[derive(Deserialize)]
struct Id {
    id: String,
}

#[derive(Deserialize)]
struct OptionalId {
    id: Option<String>,
}

#[derive(Deserialize)]
struct Ids {
    ids: Vec<String>,
}

#[derive(Deserialize)]
struct IdName {
    id: String,
    name: String,
}

#[derive(Deserialize)]
struct NamePath {
    name: String,
    path: String,
}

#[derive(Deserialize)]
struct Name {
    name: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct WorkspaceId {
    workspace_id: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct SessionId {
    session_id: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct SessionCreate {
    workspace_id: String,
    kind: String,
    name: String,
    provider: String,
    model: String,
    description: String,
    autonomy: String,
}

#[derive(Deserialize)]
struct SessionUpdate {
    id: String,
    name: String,
    provider: String,
    model: String,
    description: String,
    notifications: bool,
    autonomy: String,
}

#[derive(Deserialize)]
struct IdStatus {
    id: String,
    status: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct IdBlocks {
    id: String,
    blocks_json: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct IdProvider {
    id: String,
    provider_session_id: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct RoutineUpsert {
    id: Option<String>,
    session_id: String,
    name: String,
    enabled: bool,
    prompt: String,
    schedule: String,
    next_run_at: Option<i64>,
    created_by: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct RoutineMark {
    id: String,
    last_run_at: i64,
    next_run_at: Option<i64>,
    runs_json: String,
}

#[derive(Deserialize)]
struct Key {
    key: String,
}

#[derive(Deserialize)]
struct KeyValue {
    key: String,
    value: String,
}

#[derive(Deserialize)]
struct Cwd {
    cwd: String,
}

#[derive(Deserialize)]
struct PathArg {
    path: String,
}

#[derive(Deserialize)]
struct PathContents {
    path: String,
    contents: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct TempFile {
    extension: String,
    base64_contents: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct AgentSpawn {
    session_id: String,
    command: String,
    args: Vec<String>,
    cwd: String,
    env: Option<HashMap<String, String>>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct SessionLine {
    session_id: String,
    line: String,
}

#[derive(Deserialize)]
struct BridgeReply {
    id: u64,
    response: Value,
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
    async fn pty_keeps_flowing_after_disconnect_and_attach() {
        let dir = test_dir("pty-flood");
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

        wait_bytes(&mut ws, b"y").await;
        drop(ws);
        tokio::time::sleep(std::time::Duration::from_millis(400)).await;

        let mut ws = connect_authed(&handle).await;
        send_json(
            &mut ws,
            &Request {
                id: 2,
                method: "pty_attach".into(),
                params: serde_json::json!({ "id": "t", "from": 0 }),
            },
        )
        .await;
        let attached = wait_response(&mut ws, 2).await;
        assert!(attached.ok, "{}", attached.error.unwrap_or_default());
        send_json(
            &mut ws,
            &Request {
                id: 3,
                method: "pty_ack".into(),
                params: serde_json::json!({ "id": "t", "processed": 256 * 1024 }),
            },
        )
        .await;

        let mut got = 0usize;
        let mut processed = 256 * 1024u64;
        let deadline = tokio::time::Instant::now() + std::time::Duration::from_secs(5);
        while got < 300 * 1024 {
            let msg = tokio::time::timeout_at(deadline, ws.next())
                .await
                .expect("flood timeout")
                .expect("closed")
                .expect("ws");
            if let Message::Binary(bytes) = msg {
                if bytes.len() >= 4 {
                    let n = bytes.len() - 4;
                    got += n;
                    processed += n as u64;
                }
                if got % (32 * 1024) < bytes.len().saturating_sub(4) {
                    send_json(
                        &mut ws,
                        &Request {
                            id: 4,
                            method: "pty_ack".into(),
                            params: serde_json::json!({ "id": "t", "processed": processed }),
                        },
                    )
                    .await;
                }
            }
        }
        handle.shutdown();
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
