//! The vault between machines (plan `2026-10-23-integrations.md`, phase 3).
//!
//! One daemon holds the grants: the vault. Every other one sends it its tool
//! calls over a socket it opens to the vault, never the other way round. No
//! token crosses that socket (plan `2026-11-02-vault-calls.md`):
//!
//! - **The vault** takes machines' connections on its own socket (`crewd serve`
//!   on a remote) or, when it is this Mac, on a listener of its own on the
//!   tailnet address (`vault_listen`), which takes nothing but machine and
//!   handoff tokens. A machine's connection can run a tool and read the
//!   config, and hears when the config changes; nothing else of the daemon
//!   reaches it.
//! - **A member** keeps its link (`<data>/vault-link.json`, 0600: the vault's
//!   address, its machine token and the vault's name), replaces its copy of
//!   the config each time the vault's changes, and sends its calls there
//!   (`Connectors::set_link`). It reconnects on its own, and while it can't,
//!   a call says the vault is offline.
//! - **A move** goes new vault ← old vault, the window carrying only a public
//!   key and a handoff token: the new vault makes a key pair for the move
//!   (`vault_move_open`), the old one answers a handoff token for that key,
//!   good once and for two minutes (`vault_handoff`), and the new one pulls
//!   with it (`vault_move_pull`): the old vault seals the grants and the config
//!   to the key, the new one opens them, stores them and says so, and only
//!   then does the old one forget its grants and every machine's token. The
//!   window then joins every machine to the new vault.

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use crew_core::connectors::flow::Connectors;
use crew_core::connectors::machines::{self, InFlight, RateLimit, RelayError, VaultLink};
use crew_core::connectors::seal::{self, Opener};
use crew_core::store::{self as app_state, Store};
use crew_protocol::{self as proto, Request, VaultMachine, VaultMinted, VaultStatus};
use futures_util::stream::FuturesUnordered;
use futures_util::{SinkExt, StreamExt};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::{mpsc, oneshot, watch};
use tokio_tungstenite::tungstenite::Message;

/// How long a handoff token and a move's key last.
const MOVE_TTL_MS: i64 = 2 * 60 * 1000;
/// How long a move waits for the calls running on the old vault.
const MOVE_DRAIN: Duration = Duration::from_secs(30);
/// Calls one machine may make in a minute: there for runaway loops.
const CALLS_PER_MINUTE: usize = 600;
/// Calls one machine may have running at once.
const CALLS_IN_FLIGHT: usize = 32;
/// A short request to the vault that takes longer than this is the vault being away.
const CALL_TIMEOUT: Duration = Duration::from_secs(15);
/// How long a machine waits for a tool's answer: past a remote call's 300 s,
/// and short of the shim's 320 s, so the answer or this error reaches it first.
const TOOL_ANSWER_TIMEOUT: Duration = Duration::from_secs(315);
const STATE_LISTEN: &str = "vault:listen";

/// How a member reaches its vault, kept in `<data>/vault-link.json`.
#[derive(Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
struct LinkConfig {
    address: String,
    token: String,
    vault_name: String,
}

struct Handoff {
    public_key: String,
    expires_at: i64,
}

/// Who a peer connection is, from the token it brought.
pub enum PeerKind {
    Machine(VaultMachine),
    Handoff(String),
}

pub struct VaultHost {
    store: Store,
    connectors: Arc<Connectors>,
    data_dir: Option<PathBuf>,
    link: Mutex<Option<Arc<Link>>>,
    listener: Mutex<Option<(String, tokio::task::JoinHandle<()>)>>,
    opener: Mutex<Option<(Opener, i64)>>,
    handoffs: Mutex<HashMap<String, Handoff>>,
    limit: RateLimit,
    running: InFlight,
    /// Bumped on every change of the config: machines' connections tell theirs.
    changes: watch::Receiver<u64>,
}

impl VaultHost {
    pub fn new(store: Store, connectors: Arc<Connectors>, data_dir: Option<PathBuf>, changes: watch::Receiver<u64>) -> Arc<Self> {
        Arc::new(VaultHost {
            store,
            connectors,
            data_dir,
            link: Mutex::new(None),
            listener: Mutex::new(None),
            opener: Mutex::new(None),
            handoffs: Mutex::new(HashMap::new()),
            limit: RateLimit::new(CALLS_PER_MINUTE),
            running: InFlight::new(CALLS_IN_FLIGHT),
            changes,
        })
    }

    /// At the daemon's start: the link it kept, or the listener it had.
    pub fn resume(self: &Arc<Self>) {
        if let Some(config) = self.read_link() {
            self.start_link(config);
        } else if let Ok(Some(addr)) = app_state::get(&self.store, STATE_LISTEN.into()) {
            let host = self.clone();
            tokio::spawn(async move {
                if let Err(e) = host.listen(addr.clone()).await {
                    eprintln!("[crewd] vault: couldn't listen for machines on {addr}: {e}");
                }
            });
        }
    }

    fn link_file(&self) -> Option<PathBuf> {
        self.data_dir.as_ref().map(|d| d.join("vault-link.json"))
    }

    fn read_link(&self) -> Option<LinkConfig> {
        let bytes = std::fs::read(self.link_file()?).ok()?;
        serde_json::from_slice(&bytes).ok()
    }

    fn write_link(&self, config: Option<&LinkConfig>) -> Result<(), String> {
        let Some(file) = self.link_file() else { return Ok(()) };
        match config {
            None => match std::fs::remove_file(&file) {
                Err(e) if e.kind() != std::io::ErrorKind::NotFound => Err(e.to_string()),
                _ => Ok(()),
            },
            Some(config) => {
                use std::io::Write;
                use std::os::unix::fs::OpenOptionsExt;
                let tmp = file.with_extension("json.tmp");
                let mut out = std::fs::OpenOptions::new().write(true).create(true).truncate(true).mode(0o600).open(&tmp).map_err(|e| e.to_string())?;
                out.write_all(&serde_json::to_vec(config).map_err(|e| e.to_string())?).map_err(|e| e.to_string())?;
                std::fs::rename(&tmp, &file).map_err(|e| e.to_string())
            }
        }
    }

    fn start_link(self: &Arc<Self>, config: LinkConfig) {
        let link = Link::start(config, self.store.clone(), self.connectors.clone());
        self.connectors.set_link(Some(link.clone() as Arc<dyn VaultLink>));
        if let Some(old) = self.link.lock().unwrap_or_else(|e| e.into_inner()).replace(link) {
            old.stop();
        }
    }

    fn stop_link(&self) {
        if let Some(old) = self.link.lock().unwrap_or_else(|e| e.into_inner()).take() {
            old.stop();
        }
        self.connectors.set_link(None);
    }

    /* ── The window's calls (the user's token) ───────────────────────── */

    pub fn status(&self) -> Result<VaultStatus, String> {
        let link = self.link.lock().unwrap_or_else(|e| e.into_inner()).clone();
        let listening = self.listener.lock().unwrap_or_else(|e| e.into_inner()).as_ref().map(|(addr, _)| addr.clone());
        let grants = self.connectors.grant_count()? as u32;
        Ok(match link {
            Some(link) => {
                let (online, offline_since) = link.state();
                VaultStatus {
                    holds: false,
                    vault_name: Some(link.config.vault_name.clone()),
                    vault_address: Some(link.config.address.clone()),
                    online,
                    offline_since,
                    listening,
                    machines: Vec::new(),
                    grants,
                }
            }
            None => VaultStatus {
                holds: true,
                vault_name: None,
                vault_address: None,
                online: true,
                offline_since: None,
                listening,
                machines: machines::machines(&self.store)?,
                grants,
            },
        })
    }

    pub fn mint(&self, name: &str) -> Result<VaultMinted, String> {
        if self.link.lock().unwrap_or_else(|e| e.into_inner()).is_some() {
            return Err("This machine uses another vault".into());
        }
        let (machine, token) = machines::mint(&self.store, name)?;
        eprintln!("[crewd] vault: minted a token for {name} ({})", machine.id);
        Ok(VaultMinted { machine, token })
    }

    pub fn revoke(&self, id: &str) -> Result<(), String> {
        machines::revoke(&self.store, id)?;
        eprintln!("[crewd] vault: revoked machine {id}");
        Ok(())
    }

    /// Takes machines on `addr` too (this Mac's tailnet address), and again after a restart.
    pub async fn listen(self: &Arc<Self>, addr: String) -> Result<(), String> {
        let listener = TcpListener::bind(&addr).await.map_err(|e| format!("Couldn't listen on {addr}: {e}"))?;
        let host = self.clone();
        let task = tokio::spawn(async move {
            while let Ok((stream, _)) = listener.accept().await {
                let host = host.clone();
                tokio::spawn(async move { host.serve_listener(stream).await });
            }
        });
        if let Some((_, old)) = self.listener.lock().unwrap_or_else(|e| e.into_inner()).replace((addr.clone(), task)) {
            old.abort();
        }
        app_state::set(&self.store, STATE_LISTEN.into(), addr)?;
        Ok(())
    }

    pub fn unlisten(&self) -> Result<(), String> {
        if let Some((_, task)) = self.listener.lock().unwrap_or_else(|e| e.into_inner()).take() {
            task.abort();
        }
        app_state::delete(&self.store, STATE_LISTEN.into())
    }

    /// From now on this machine's calls run on the vault at `address`.
    pub fn join(self: &Arc<Self>, join: proto::VaultJoin) -> Result<(), String> {
        let config = LinkConfig { address: join.address, token: join.token, vault_name: join.vault_name };
        self.write_link(Some(&config))?;
        self.unlisten()?;
        machines::revoke_all(&self.store)?;
        self.start_link(config);
        Ok(())
    }

    /// Uses no other vault: this machine holds its own grants again (none, until a move lands).
    pub fn leave(&self) -> Result<(), String> {
        self.write_link(None)?;
        self.stop_link();
        Ok(())
    }

    /// The new vault's key for a move.
    pub fn move_open(&self) -> proto::VaultKey {
        let opener = Opener::new();
        let public_key = opener.public();
        *self.opener.lock().unwrap_or_else(|e| e.into_inner()) = Some((opener, app_state::now_millis() + MOVE_TTL_MS));
        proto::VaultKey { public_key }
    }

    /// The old vault answers a token the new one pulls with, once, within two minutes.
    pub async fn handoff(&self, key: proto::VaultKey) -> Result<String, String> {
        if self.link.lock().unwrap_or_else(|e| e.into_inner()).is_some() {
            return Err("This machine isn't the vault".into());
        }
        // No refresh from here on: one could spend a token already sealed.
        self.connectors.stop_calls(Duration::from_millis(MOVE_TTL_MS as u64), MOVE_DRAIN).await?;
        let token = format!("handoff-{}{}", crate::random_token(), crate::random_token());
        let now = app_state::now_millis();
        let mut handoffs = self.handoffs.lock().unwrap_or_else(|e| e.into_inner());
        handoffs.retain(|_, h| h.expires_at > now);
        handoffs.insert(token.clone(), Handoff { public_key: key.public_key, expires_at: now + MOVE_TTL_MS });
        eprintln!("[crewd] vault: a handoff was opened");
        Ok(token)
    }

    /// The new vault pulls the grants and the config from the old one.
    pub async fn move_pull(self: &Arc<Self>, pull: proto::VaultPull) -> Result<usize, String> {
        let opener = {
            let mut slot = self.opener.lock().unwrap_or_else(|e| e.into_inner());
            match slot.take() {
                Some((opener, until)) if until > app_state::now_millis() => opener,
                _ => return Err("The move ran out; start it again".into()),
            }
        };
        let mut peer = Peer::connect(&pull.address, &pull.token).await?;
        let taken = peer.call("vault_handoff_take", json!({ "publicKey": opener.public() })).await?;
        let sealed = taken["sealed"].as_str().ok_or("The old vault answered no grants")?;
        let bundle = opener.open(sealed)?;
        self.leave()?;
        let count = self.connectors.land_move(&bundle).await?;
        peer.call("vault_handoff_done", Value::Null).await?;
        eprintln!("[crewd] vault: {count} grants moved here");
        Ok(count)
    }

    /// The vault moves here without the old one's grants.
    pub fn move_empty(&self) -> Result<(), String> {
        self.leave()?;
        self.connectors.start_empty()
    }

    /* ── Peers: machines calling, and a new vault pulling ────────────── */

    /// Who a token is, other than the daemon's own.
    pub fn peer_of(&self, token: &str) -> Option<PeerKind> {
        if token.starts_with("handoff-") {
            let handoffs = self.handoffs.lock().unwrap_or_else(|e| e.into_inner());
            return handoffs.get(token).filter(|h| h.expires_at > app_state::now_millis()).map(|_| PeerKind::Handoff(token.to_string()));
        }
        // A member holds no one's grants: its old tokens reach nothing.
        if self.link.lock().unwrap_or_else(|e| e.into_inner()).is_some() {
            return None;
        }
        machines::machine_of(&self.store, token).ok().flatten().map(PeerKind::Machine)
    }

    /// The tailnet listener: a WebSocket with a machine or handoff token, nothing else.
    async fn serve_listener(self: Arc<Self>, stream: TcpStream) {
        let Some(ws) = crate::http::accept_socket_only(stream).await else { return };
        let (mut sink, mut source) = ws.split();
        let Some(Ok(Message::Text(text))) = source.next().await else { return };
        let Ok(proto::Auth { auth }) = serde_json::from_str::<proto::Auth>(text.as_ref()) else { return };
        let Some(peer) = self.peer_of(&auth) else {
            let _ = sink.close().await;
            return;
        };
        self.serve_peer(peer, sink, source).await;
    }

    /// A peer's connection, once its token said who it is.
    pub async fn serve_peer<S, R>(self: Arc<Self>, peer: PeerKind, mut sink: S, mut source: R)
    where
        S: futures_util::Sink<Message> + Unpin,
        R: futures_util::Stream<Item = Result<Message, tokio_tungstenite::tungstenite::Error>> + Unpin,
    {
        let hello = proto::event("hello", proto::Hello { protocol: proto::PROTOCOL, version: env!("CARGO_PKG_VERSION").to_string() });
        let Ok(hello) = hello.and_then(|event| serde_json::to_string(&event)) else { return };
        if sink.send(Message::Text(hello.into())).await.is_err() {
            return;
        }
        let mut changes = self.changes.clone();
        // Each request runs beside the others, so a slow call holds up neither
        // the next call nor the config. Its work is on the connectors' runtime:
        // it finishes even when this connection doesn't.
        let this = &*self;
        let peer = &peer;
        let mut running = FuturesUnordered::new();
        loop {
            tokio::select! {
                changed = changes.changed(), if matches!(peer, PeerKind::Machine(_)) => {
                    if changed.is_err() || !this.still_known(peer) {
                        break;
                    }
                    let Ok(event) = proto::event("vault-config", Value::Null).and_then(|e| serde_json::to_string(&e)) else { break };
                    if sink.send(Message::Text(event.into())).await.is_err() {
                        break;
                    }
                }
                msg = source.next() => {
                    let Some(Ok(msg)) = msg else { break };
                    let Message::Text(text) = msg else {
                        if matches!(msg, Message::Close(_)) { break; }
                        continue;
                    };
                    let Ok(request) = serde_json::from_str::<Request>(text.as_ref()) else { break };
                    // A token is checked at each request, not only on connecting:
                    // a revoked machine's open connection stops here.
                    if !this.still_known(peer) {
                        break;
                    }
                    running.push(async move {
                        let done = request.method == "vault_handoff_done";
                        let answer = match this.peer_call(peer, &request.method, request.params).await {
                            Ok(value) => proto::ok(request.id, value),
                            Err(error) => proto::err(request.id, error),
                        };
                        (done, answer)
                    });
                }
                Some((done, answer)) = running.next(), if !running.is_empty() => {
                    let Ok(text) = serde_json::to_string(&answer) else { break };
                    if sink.send(Message::Text(text.into())).await.is_err() || done {
                        break;
                    }
                }
            }
        }
        let _ = sink.close().await;
    }

    fn still_known(&self, peer: &PeerKind) -> bool {
        match peer {
            PeerKind::Machine(machine) => {
                self.link.lock().unwrap_or_else(|e| e.into_inner()).is_none() && machines::is_known(&self.store, &machine.id).unwrap_or(false)
            }
            PeerKind::Handoff(_) => true,
        }
    }

    async fn peer_call(&self, peer: &PeerKind, method: &str, params: Value) -> Result<Value, String> {
        match (peer, method) {
            (PeerKind::Machine(machine), "vault_config") => {
                let store = self.store.clone();
                let snap = tokio::task::spawn_blocking(move || machines::snapshot(&store)).await.map_err(|e| e.to_string())??;
                let _ = &machine.id;
                serde_json::to_value(snap).map_err(|e| e.to_string())
            }
            (PeerKind::Machine(machine), "vault_call") => {
                #[derive(Deserialize)]
                #[serde(rename_all = "camelCase")]
                struct Ask {
                    account_id: String,
                    tool: String,
                    #[serde(default)]
                    arguments: Value,
                }
                if !self.limit.allow(&machine.id) {
                    eprintln!("[crewd] vault: {} made too many calls", machine.name);
                    return Err("Too many calls from this machine in a minute; wait a moment and try again.".into());
                }
                let Some(counted) = self.running.enter(&machine.id) else {
                    eprintln!("[crewd] vault: {} has too many calls running", machine.name);
                    return Err("Too many calls running from this machine; wait for one to end and try again.".into());
                };
                let ask: Ask = serde_json::from_value(params).map_err(|e| e.to_string())?;
                let (account, tool) = (ask.account_id.clone(), ask.tool.clone());
                // On the connectors' runtime: it finishes even if this connection doesn't.
                let answer = self
                    .connectors
                    .run(move |c| async move {
                        let _counted = counted;
                        Ok(c.call_for_machine(&ask.account_id, &ask.tool, ask.arguments).await)
                    })
                    .await?;
                // Never the arguments or the answer: only who called what.
                let outcome = if answer["isError"] == true { "failed" } else { "ok" };
                eprintln!("[crewd] vault: {} called {tool} on account {account}: {outcome}", machine.name);
                let _ = machines::called(&self.store, &machine.id);
                Ok(answer)
            }
            (PeerKind::Machine(machine), "vault_tools_refresh") => {
                #[derive(Deserialize)]
                #[serde(rename_all = "camelCase")]
                struct Ask {
                    account_id: String,
                }
                if !self.limit.allow(&machine.id) {
                    return Err("Too many calls from this machine in a minute".into());
                }
                let Ask { account_id } = serde_json::from_value(params).map_err(|e| e.to_string())?;
                let connectors = self.connectors.clone();
                // Not waited for: a change comes back as `vault-config`.
                tokio::spawn(async move {
                    let _ = connectors.run(move |c| async move { c.tools_for_shim(&account_id).await }).await;
                });
                Ok(Value::Null)
            }
            (PeerKind::Handoff(token), "vault_handoff_take") => {
                let now = app_state::now_millis();
                let key = self.handoffs.lock().unwrap_or_else(|e| e.into_inner()).get(token).filter(|h| h.expires_at > now).map(|h| h.public_key.clone());
                let key = key.ok_or("The handoff ran out")?;
                if params["publicKey"].as_str() != Some(key.as_str()) {
                    return Err("The handoff is for another key".into());
                }
                let bundle = self.connectors.move_bundle()?;
                eprintln!("[crewd] vault: the grants were sealed for the new vault");
                Ok(json!({ "sealed": seal::seal(&key, &bundle)? }))
            }
            (PeerKind::Handoff(token), "vault_handoff_done") => {
                self.handoffs.lock().unwrap_or_else(|e| e.into_inner()).remove(token);
                self.connectors.forget_grants()?;
                machines::revoke_all(&self.store)?;
                self.unlisten()?;
                eprintln!("[crewd] vault: the grants moved away and were deleted here");
                Ok(Value::Null)
            }
            (_, other) => Err(format!("{other} is not for this connection")),
        }
    }
}

/* ── Calling the vault ────────────────────────────────────────────────── */

type Ws = tokio_tungstenite::WebSocketStream<tokio_tungstenite::MaybeTlsStream<TcpStream>>;

/// One connection to another daemon, for calls one at a time.
struct Peer {
    sink: futures_util::stream::SplitSink<Ws, Message>,
    source: futures_util::stream::SplitStream<Ws>,
    next: u32,
}

impl Peer {
    async fn connect(address: &str, token: &str) -> Result<Self, String> {
        let url = format!("ws://{address}");
        let (ws, _) = tokio::time::timeout(CALL_TIMEOUT, tokio_tungstenite::connect_async(url))
            .await
            .map_err(|_| format!("{address} didn't answer"))?
            .map_err(|e| format!("Couldn't reach {address}: {e}"))?;
        let (mut sink, mut source) = ws.split();
        sink.send(Message::Text(json!({ "auth": token }).to_string().into())).await.map_err(|e| e.to_string())?;
        // The hello; a refused token closes instead.
        match tokio::time::timeout(CALL_TIMEOUT, source.next()).await {
            Ok(Some(Ok(Message::Text(_)))) => Ok(Peer { sink, source, next: 0 }),
            _ => Err(format!("{address} refused the token")),
        }
    }

    async fn call(&mut self, method: &str, params: Value) -> Result<Value, String> {
        self.next += 1;
        let id = self.next;
        let request = json!({ "id": id, "method": method, "params": params });
        self.sink.send(Message::Text(request.to_string().into())).await.map_err(|e| e.to_string())?;
        loop {
            let msg = tokio::time::timeout(CALL_TIMEOUT, self.source.next()).await.map_err(|_| "The other vault went quiet".to_string())?;
            let Some(Ok(Message::Text(text))) = msg else { return Err("The other vault closed the connection".into()) };
            let answer: Value = serde_json::from_str(text.as_ref()).map_err(|e| e.to_string())?;
            if answer["id"].as_u64() != Some(u64::from(id)) {
                continue;
            }
            return match answer["ok"].as_bool() {
                Some(true) => Ok(answer["result"].clone()),
                _ => Err(answer["error"].as_str().unwrap_or("The other vault refused").to_string()),
            };
        }
    }
}

/// A member's link to its vault: one connection kept open, the config copied
/// over each time it changes, tool calls sent on it.
pub struct Link {
    config: LinkConfig,
    out: Mutex<Option<mpsc::UnboundedSender<String>>>,
    waiting: Mutex<HashMap<u32, oneshot::Sender<Value>>>,
    next: AtomicU32,
    state: Mutex<(bool, Option<i64>)>,
    task: Mutex<Option<tokio::task::JoinHandle<()>>>,
}

impl Link {
    fn start(config: LinkConfig, store: Store, connectors: Arc<Connectors>) -> Arc<Link> {
        let link = Arc::new(Link {
            config,
            out: Mutex::new(None),
            waiting: Mutex::new(HashMap::new()),
            next: AtomicU32::new(0),
            state: Mutex::new((false, Some(app_state::now_millis()))),
            task: Mutex::new(None),
        });
        let run = link.clone();
        let task = tokio::spawn(async move { run.run(store, connectors).await });
        *link.task.lock().unwrap_or_else(|e| e.into_inner()) = Some(task);
        link
    }

    fn stop(&self) {
        if let Some(task) = self.task.lock().unwrap_or_else(|e| e.into_inner()).take() {
            task.abort();
        }
        self.out.lock().unwrap_or_else(|e| e.into_inner()).take();
        // Whoever waits on an answer that can't come now hears at once.
        self.waiting.lock().unwrap_or_else(|e| e.into_inner()).clear();
    }

    fn state(&self) -> (bool, Option<i64>) {
        *self.state.lock().unwrap_or_else(|e| e.into_inner())
    }

    fn went(&self, online: bool) {
        let mut state = self.state.lock().unwrap_or_else(|e| e.into_inner());
        if state.0 != online {
            *state = (online, (!online).then(app_state::now_millis));
        }
    }

    /// Connects, copies the config, and keeps at it; waits longer each time the vault doesn't answer.
    async fn run(self: Arc<Self>, store: Store, connectors: Arc<Connectors>) {
        let mut wait = Duration::from_secs(1);
        loop {
            match self.session(&store, &connectors).await {
                Ok(()) => wait = Duration::from_secs(1),
                Err(e) => eprintln!("[crewd] vault link: {e}"),
            }
            self.went(false);
            self.out.lock().unwrap_or_else(|e| e.into_inner()).take();
            self.waiting.lock().unwrap_or_else(|e| e.into_inner()).clear();
            tokio::time::sleep(wait).await;
            wait = (wait * 2).min(Duration::from_secs(30));
        }
    }

    async fn session(self: &Arc<Self>, store: &Store, connectors: &Arc<Connectors>) -> Result<(), String> {
        let peer = Peer::connect(&self.config.address, &self.config.token).await?;
        let (mut sink, mut source) = (peer.sink, peer.source);
        let (tx, mut rx) = mpsc::unbounded_channel::<String>();
        *self.out.lock().unwrap_or_else(|e| e.into_inner()) = Some(tx);
        self.went(true);
        eprintln!("[crewd] vault link: using the vault on {}", self.config.vault_name);
        let writer = tokio::spawn(async move {
            while let Some(text) = rx.recv().await {
                if sink.send(Message::Text(text.into())).await.is_err() {
                    break;
                }
            }
        });
        let sync = |link: Arc<Link>, store: Store, connectors: Arc<Connectors>| async move {
            match link.request("vault_config", Value::Null, CALL_TIMEOUT).await {
                Ok(Ok(value)) => match serde_json::from_value::<machines::Snapshot>(value) {
                    Ok(snap) => {
                        let done = tokio::task::spawn_blocking(move || machines::import(&store, &snap)).await;
                        if matches!(done, Ok(Ok(()))) {
                            connectors.notify();
                        }
                    }
                    Err(e) => eprintln!("[crewd] vault link: the config didn't read: {e}"),
                },
                Ok(Err(e)) => eprintln!("[crewd] vault link: the vault refused the config: {e}"),
                Err(_) => {}
            }
        };
        tokio::spawn(sync(self.clone(), store.clone(), connectors.clone()));
        while let Some(msg) = source.next().await {
            let Ok(Message::Text(text)) = msg else {
                if matches!(msg, Ok(Message::Close(_)) | Err(_)) {
                    break;
                }
                continue;
            };
            let Ok(value) = serde_json::from_str::<Value>(text.as_ref()) else { continue };
            if value["event"].as_str() == Some("vault-config") {
                tokio::spawn(sync(self.clone(), store.clone(), connectors.clone()));
                continue;
            }
            if let Some(id) = value["id"].as_u64() {
                if let Some(waiter) = self.waiting.lock().unwrap_or_else(|e| e.into_inner()).remove(&(id as u32)) {
                    let _ = waiter.send(value);
                }
            }
        }
        writer.abort();
        Err(format!("{} closed the connection", self.config.vault_name))
    }

    /// A call on the open connection: `Offline` when it could not be sent,
    /// `Lost` when it was and no answer came, `Ok(Err)` when the vault refused.
    async fn request(&self, method: &str, params: Value, wait: Duration) -> Result<Result<Value, String>, RelayError> {
        let id = self.next.fetch_add(1, Ordering::Relaxed) + 1;
        let (tx, rx) = oneshot::channel();
        let out = self.out.lock().unwrap_or_else(|e| e.into_inner()).clone().ok_or(RelayError::Offline)?;
        self.waiting.lock().unwrap_or_else(|e| e.into_inner()).insert(id, tx);
        if out.send(json!({ "id": id, "method": method, "params": params }).to_string()).is_err() {
            self.waiting.lock().unwrap_or_else(|e| e.into_inner()).remove(&id);
            return Err(RelayError::Offline);
        }
        let answer = match tokio::time::timeout(wait, rx).await {
            Ok(Ok(answer)) => answer,
            Ok(Err(_)) => return Err(RelayError::Lost),
            Err(_) => {
                self.waiting.lock().unwrap_or_else(|e| e.into_inner()).remove(&id);
                return Err(RelayError::Lost);
            }
        };
        Ok(match answer["ok"].as_bool() {
            Some(true) => Ok(answer["result"].clone()),
            _ => Err(answer["error"].as_str().unwrap_or("The vault refused").to_string()),
        })
    }
}

impl VaultLink for Link {
    fn call<'a>(
        &'a self,
        account_id: &'a str,
        tool: &'a str,
        arguments: Value,
    ) -> std::pin::Pin<Box<dyn std::future::Future<Output = Result<Value, RelayError>> + Send + 'a>> {
        Box::pin(async move {
            let params = json!({ "accountId": account_id, "tool": tool, "arguments": arguments });
            self.request("vault_call", params, TOOL_ANSWER_TIMEOUT).await?.map_err(RelayError::Refused)
        })
    }

    fn refresh_tools(&self, account_id: &str) {
        // No one waits: the answer finds no waiter and is dropped.
        let id = self.next.fetch_add(1, Ordering::Relaxed) + 1;
        if let Some(out) = self.out.lock().unwrap_or_else(|e| e.into_inner()).as_ref() {
            let _ = out.send(json!({ "id": id, "method": "vault_tools_refresh", "params": { "accountId": account_id } }).to_string());
        }
    }

    fn vault_name(&self) -> String {
        self.config.vault_name.clone()
    }

    fn offline_since(&self) -> Option<i64> {
        self.state().1
    }
}
