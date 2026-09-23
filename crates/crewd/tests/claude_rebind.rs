//! `session_claude_rebind` reads the SessionStart hook's records from the
//! folder CREW_CLAUDE_BIND_DIR names. That is process environment, so this
//! runs in its own binary, and each test takes its turn on the variable.

use std::path::PathBuf;
use std::sync::{Mutex, MutexGuard};
use std::time::Duration;

use crew_core::agent::AgentHost;
use crew_core::bridge::Bridge;
use crew_core::provider_session::CLAUDE_BIND_ENV;
use crew_core::pty::PtyHost;
use crew_core::session;
use crew_core::store::Store;
use crew_protocol::{Auth, Request, Response};
use futures_util::{SinkExt, StreamExt};
use serde_json::{json, Value};
use tokio_tungstenite::connect_async;
use tokio_tungstenite::tungstenite::Message;

const IN_TIME: Duration = Duration::from_secs(10);

static ENV: Mutex<()> = Mutex::new(());

struct Daemon {
    handle: crewd::Handle,
    store: Store,
    bind: PathBuf,
    dir: tempfile::TempDir,
    _turn: MutexGuard<'static, ()>,
}

/// A daemon whose hook records live in its own folder.
fn daemon() -> Daemon {
    let turn = ENV.lock().unwrap_or_else(|e| e.into_inner());
    let dir = tempfile::Builder::new()
        .prefix("c")
        .tempdir_in("/tmp")
        .expect("temp dir");
    let bind = dir.path().join("claude-bind");
    std::fs::create_dir_all(&bind).expect("bind dir");
    std::env::set_var(CLAUDE_BIND_ENV, &bind);
    let bridge = Bridge::start(dir.path().to_path_buf()).expect("bridge");
    let store = Store::open(dir.path().join("crew.sqlite3")).expect("store");
    let handle = crewd::serve(crewd::Config {
        pty: PtyHost::new(),
        store: store.clone(),
        agents: AgentHost::new(),
        bridge,
    })
    .expect("serve");
    Daemon { handle, store, bind, dir, _turn: turn }
}

impl Daemon {
    fn terminal(&self) -> String {
        let workspace = crew_core::workspace::create(
            &self.store,
            "w".into(),
            self.dir.path().to_string_lossy().into_owned(),
        )
        .expect("workspace");
        session::create(
            &self.store,
            workspace.id,
            "terminal".into(),
            "claude".into(),
            "claude".into(),
            "".into(),
            "".into(),
            "".into(),
        )
        .expect("session")
        .id
    }

    fn hook_record(&self, crew_id: &str, claude_id: &str) {
        std::fs::write(
            self.bind.join(format!("{crew_id}.json")),
            json!({ "session_id": claude_id, "source": "startup" }).to_string(),
        )
        .expect("record");
    }

    fn bound(&self, id: &str) -> Option<String> {
        session::get(&self.store, id.to_string())
            .expect("read")
            .expect("row")
            .provider_session_id
    }

    /// One `session_claude_rebind` round trip over the daemon's socket.
    async fn rebind(&self, id: &str) -> Value {
        let (mut ws, _) = connect_async(self.handle.url()).await.expect("connect");
        let auth = Auth { auth: self.handle.token().to_string() };
        ws.send(Message::Text(serde_json::to_string(&auth).unwrap().into()))
            .await
            .expect("auth");
        let request = Request {
            id: 7,
            method: "session_claude_rebind".into(),
            params: json!({ "id": id }),
        };
        ws.send(Message::Text(serde_json::to_string(&request).unwrap().into()))
            .await
            .expect("send");
        let response = tokio::time::timeout(IN_TIME, async {
            loop {
                let Message::Text(text) = ws.next().await.expect("socket closed").expect("socket error") else {
                    continue;
                };
                if let Ok(response) = serde_json::from_str::<Response>(text.as_ref()) {
                    if response.id == 7 {
                        return response;
                    }
                }
            }
        })
        .await
        .expect("an answer in time");
        assert!(response.ok, "{:?}", response.error);
        response.result.unwrap_or(Value::Null)
    }
}

/// The hook's first record names the session Crew started claude under: it
/// is the one the terminal already runs, so there is nothing to rebind.
#[tokio::test]
async fn a_hook_record_naming_the_crew_session_itself_rebinds_nothing() {
    let d = daemon();
    let id = d.terminal();
    d.hook_record(&id, &id);

    assert_eq!(d.rebind(&id).await, Value::Null);
    assert_eq!(d.bound(&id), None);
}

/// After `/clear`, claude is in a new session, and only the record says so.
#[tokio::test]
async fn a_hook_record_naming_another_session_rebinds_to_it() {
    let d = daemon();
    let id = d.terminal();
    d.hook_record(&id, "60eb4dd5-1c2a");

    assert_eq!(d.rebind(&id).await, json!("60eb4dd5-1c2a"));
    assert_eq!(d.bound(&id).as_deref(), Some("60eb4dd5-1c2a"));

    // Asked again with nothing new, the answer is that nothing moved.
    assert_eq!(d.rebind(&id).await, Value::Null);
    assert_eq!(d.bound(&id).as_deref(), Some("60eb4dd5-1c2a"));
}
