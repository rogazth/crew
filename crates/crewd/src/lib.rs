use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{mpsc as std_mpsc, Arc, Mutex};
use std::thread;

use crew_core::pty::{PtyEvents, PtyHost};
use crew_protocol::{self as proto, Auth, DaemonInfo, PtyAck, PtyKill, PtyResize, PtySpawn, PtyWrite, Request};
use futures_util::{SinkExt, StreamExt};
use serde_json::Value;
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::mpsc;
use tokio_tungstenite::tungstenite::Message;

pub struct Config {
    pub pty: PtyHost,
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
}

impl PtyEvents for Hub {
    fn data(&self, stream_id: u32, bytes: &[u8]) {
        let mut frame = Vec::with_capacity(4 + bytes.len());
        frame.extend_from_slice(&stream_id.to_le_bytes());
        frame.extend_from_slice(bytes);
        self.broadcast(Outgoing::Binary(frame));
    }

    fn exit(&self, id: &str, code: Option<i32>) {
        let Ok(event) = proto::event("pty-exit", proto::PtyExit { id: id.to_string(), code }) else {
            return;
        };
        let Ok(text) = serde_json::to_string(&event) else {
            return;
        };
        self.broadcast(Outgoing::Text(text));
    }
}

pub fn serve(config: Config) -> Result<Handle, String> {
    let token = random_token();
    let hub = Arc::new(Hub::new());
    config.pty.set_events(hub.clone());

    let (ready_tx, ready_rx) = std_mpsc::channel();
    let (stop_tx, stop_rx) = tokio::sync::oneshot::channel();
    let pty = config.pty;
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
            runtime.block_on(run(pty, hub, serve_token, ready_tx, stop_rx));
        })
        .map_err(|e| e.to_string())?;

    let url = ready_rx.recv().map_err(|e| e.to_string())??;
    Ok(Handle {
        info: DaemonInfo { url, token },
        shutdown: Mutex::new(Some(stop_tx)),
    })
}

async fn run(
    pty: PtyHost,
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
                let pty = pty.clone();
                let hub = hub.clone();
                let token = token.clone();
                tokio::spawn(async move {
                    handle_socket(stream, pty, hub, token).await;
                });
            }
        }
    }
}

async fn handle_socket(stream: TcpStream, pty: PtyHost, hub: Arc<Hub>, token: String) {
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

    while let Some(msg) = source.next().await {
        let Ok(msg) = msg else { break };
        match msg {
            Message::Text(text) => {
                let reply = dispatch_text(&pty, text.as_ref()).await;
                hub.send(client_id, Outgoing::Text(reply));
            }
            Message::Binary(bytes) => {
                if bytes.len() < 4 {
                    continue;
                }
                let stream_id = u32::from_le_bytes(bytes[..4].try_into().unwrap());
                let data = bytes[4..].to_vec();
                let host = pty.clone();
                let _ = tokio::task::spawn_blocking(move || host.write_stream(stream_id, &data)).await;
            }
            Message::Close(_) => break,
            Message::Ping(_) | Message::Pong(_) | Message::Frame(_) => {}
        }
    }

    hub.unsubscribe(client_id);
    writer.abort();
}

async fn dispatch_text(pty: &PtyHost, text: &str) -> String {
    let request = match serde_json::from_str::<Request>(text) {
        Ok(request) => request,
        Err(error) => return encode(&proto::err(0, format!("Bad request: {error}"))),
    };
    let result = dispatch(pty, &request.method, request.params).await;
    encode(&match result {
        Ok(value) => proto::ok(request.id, value),
        Err(error) => proto::err(request.id, error),
    })
}

async fn dispatch(pty: &PtyHost, method: &str, params: Value) -> Result<Value, String> {
    let host = pty.clone();
    match method {
        "pty_spawn" => {
            let PtySpawn { id, cwd, command, cols, rows } =
                serde_json::from_value(params).map_err(|e| e.to_string())?;
            let stream_id =
                tokio::task::spawn_blocking(move || host.spawn(id, cwd, command, cols, rows))
                    .await
                    .map_err(|e| e.to_string())??;
            Ok(Value::from(stream_id))
        }
        "pty_write" => {
            let PtyWrite { id, data } = serde_json::from_value(params).map_err(|e| e.to_string())?;
            tokio::task::spawn_blocking(move || host.write(&id, data.as_bytes()))
                .await
                .map_err(|e| e.to_string())??;
            Ok(Value::Null)
        }
        "pty_resize" => {
            let PtyResize { id, cols, rows } =
                serde_json::from_value(params).map_err(|e| e.to_string())?;
            tokio::task::spawn_blocking(move || host.resize(&id, cols, rows))
                .await
                .map_err(|e| e.to_string())??;
            Ok(Value::Null)
        }
        "pty_ack" => {
            let PtyAck { id, processed } =
                serde_json::from_value(params).map_err(|e| e.to_string())?;
            tokio::task::spawn_blocking(move || host.ack(&id, processed))
                .await
                .map_err(|e| e.to_string())?;
            Ok(Value::Null)
        }
        "pty_kill" => {
            let PtyKill { id } = serde_json::from_value(params).map_err(|e| e.to_string())?;
            tokio::task::spawn_blocking(move || host.kill(&id))
                .await
                .map_err(|e| e.to_string())?;
            Ok(Value::Null)
        }
        _ => Err(format!("Unknown method: {method}")),
    }
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
    use futures_util::{SinkExt, StreamExt};
    use tokio_tungstenite::connect_async;

    #[tokio::test]
    async fn pty_echoes_hi_over_the_stream() {
        let handle = serve(Config {
            pty: PtyHost::new(),
        })
        .expect("serve");
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

        let spawn = Request {
            id: 1,
            method: "pty_spawn".into(),
            params: serde_json::to_value(PtySpawn {
                id: "t".into(),
                cwd: std::env::temp_dir().to_string_lossy().into_owned(),
                command: vec!["/bin/sh".into()],
                cols: 80,
                rows: 24,
            })
            .unwrap(),
        };
        ws.send(Message::Text(serde_json::to_string(&spawn).unwrap().into()))
            .await
            .expect("spawn");

        let stream_id = wait_stream_id(&mut ws).await;
        let mut frame = Vec::from(stream_id.to_le_bytes());
        frame.extend_from_slice(b"echo hi\n");
        ws.send(Message::Binary(frame.into())).await.expect("write");

        let output = wait_bytes(&mut ws, b"hi").await;
        assert!(output.windows(2).any(|w| w == b"hi"), "output: {output:?}");
        handle.shutdown();
    }

    async fn wait_stream_id<S>(ws: &mut S) -> u32
    where
        S: StreamExt<Item = Result<Message, tokio_tungstenite::tungstenite::Error>> + Unpin,
    {
        let deadline = tokio::time::Instant::now() + std::time::Duration::from_secs(5);
        loop {
            let msg = tokio::time::timeout_at(deadline, ws.next())
                .await
                .expect("spawn timeout")
                .expect("closed")
                .expect("ws");
            if let Message::Text(text) = msg {
                let response: proto::Response = serde_json::from_str(text.as_ref()).expect("json");
                if response.id == 1 {
                    assert!(response.ok, "{}", response.error.unwrap_or_default());
                    return response.result.and_then(|v| v.as_u64()).expect("stream") as u32;
                }
            }
        }
    }

    async fn wait_bytes<S>(ws: &mut S, needle: &[u8]) -> Vec<u8>
    where
        S: StreamExt<Item = Result<Message, tokio_tungstenite::tungstenite::Error>> + Unpin,
    {
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
