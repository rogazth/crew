//! Electron main as the browser host, over the wire: it registers on its own
//! connection, a tool call reaches it as `browser-call`, and its
//! `browser_result` goes back to whoever called.

use std::time::Duration;

use crew_core::agent::AgentHost;
use crew_core::bridge::Bridge;
use crew_core::pty::PtyHost;
use crew_core::store::Store;
use crewd::{serve, Config, Handle};
use futures_util::{SinkExt, StreamExt};
use serde_json::{json, Value};
use tokio_tungstenite::tungstenite::Message;
use tokio_tungstenite::{connect_async, MaybeTlsStream, WebSocketStream};

type Ws = WebSocketStream<MaybeTlsStream<tokio::net::TcpStream>>;

fn daemon(name: &str) -> Handle {
    let dir = std::env::temp_dir().join(format!("crewd-browser-host-{name}-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).expect("dir");
    let pty = PtyHost::new();
    let store = Store::open(dir.join("crew.sqlite3")).expect("store");
    serve(Config {
        processes: crew_core::process::ProcessHost::new(store.clone(), pty.clone(), &dir),
        pty,
        store,
        agents: AgentHost::new(),
        bridge: Bridge::start(dir).expect("bridge"),
    })
    .expect("serve")
}

async fn connect(handle: &Handle) -> Ws {
    let (mut ws, _) = connect_async(handle.url()).await.expect("connect");
    let auth = json!({ "auth": handle.token() }).to_string();
    ws.send(Message::Text(auth.into())).await.expect("auth");
    ws
}

async fn send(ws: &mut Ws, id: u32, method: &str, params: Value) {
    let request = json!({ "id": id, "method": method, "params": params }).to_string();
    ws.send(Message::Text(request.into())).await.expect("send");
}

/// The next text frame that `keep` accepts, skipping the rest.
async fn next_where(ws: &mut Ws, keep: impl Fn(&Value) -> bool) -> Value {
    loop {
        let message = tokio::time::timeout(Duration::from_secs(10), ws.next())
            .await
            .expect("timed out")
            .expect("closed")
            .expect("ws");
        let Message::Text(text) = message else { continue };
        let value: Value = serde_json::from_str(&text).expect("json");
        if keep(&value) {
            return value;
        }
    }
}

async fn response(ws: &mut Ws, id: u32) -> Value {
    next_where(ws, |v| v["id"] == id && v.get("ok").is_some()).await
}

async fn event(ws: &mut Ws, name: &str) -> Value {
    next_where(ws, |v| v["event"] == name).await["payload"].clone()
}

fn strip(tab: &str) -> Value {
    json!({
        "key": "tabs:w1",
        "value": json!({ "tabs": [{ "id": tab, "kind": "browser", "url": "http://localhost:5173/", "title": "App" }] })
            .to_string()
    })
}

#[tokio::test]
async fn a_tool_call_goes_to_the_host_and_its_answer_comes_back() {
    let handle = daemon("roundtrip");
    let mut window = connect(&handle).await;
    send(&mut window, 1, "state_set", strip("browser:a")).await;
    assert_eq!(response(&mut window, 1).await["ok"], true);

    // No host yet: the call says what to do about it.
    send(&mut window, 2, "browser_tool", json!({ "workspaceId": "w1", "tool": "browser_snapshot", "args": { "tab": "browser:a" } })).await;
    let refused = response(&mut window, 2).await;
    assert_eq!(refused["error"], "Open Crew to use the browser.");

    let mut host = connect(&handle).await;
    send(&mut host, 1, "browser_host_register", json!({})).await;
    assert_eq!(response(&mut host, 1).await["ok"], true);

    send(&mut window, 3, "browser_tool", json!({ "workspaceId": "w1", "tool": "browser_snapshot", "args": { "tab": "browser:a" } })).await;
    let call = event(&mut host, "browser-call").await;
    assert_eq!(call["tab"], "browser:a");
    assert_eq!(call["tool"], "browser_snapshot");
    assert_eq!(call["page"]["context"], "w1");
    let content = json!([{ "type": "text", "text": "RootWebArea \"App\"" }]);

    // The window cannot answer in the host's place.
    send(&mut window, 4, "browser_result", json!({ "callId": call["callId"], "ok": true, "result": "forged" })).await;
    assert_eq!(response(&mut window, 4).await["ok"], false);

    send(&mut host, 2, "browser_result", json!({ "callId": call["callId"], "ok": true, "result": content })).await;
    assert_eq!(response(&mut host, 2).await["ok"], true);
    let answered = response(&mut window, 3).await;
    assert_eq!(answered["result"], content);

    // The call took the tab.
    send(&mut window, 7, "browser_leases_list", json!({})).await;
    let leases = response(&mut window, 7).await["result"].clone();
    assert_eq!(leases["leases"][0]["tab"], "browser:a");
    assert_eq!(leases["leases"][0]["holder"], "you");

    // The user takes it back.
    send(&mut window, 5, "browser_lease_release", json!({ "tab": "browser:a" })).await;
    // Announced to everyone, the quiet host included: it detaches from the page.
    let freed = |v: &Value| v["event"] == "browser-leases" && v["payload"]["leases"] == json!([]);
    next_where(&mut window, freed).await;
    next_where(&mut host, freed).await;
    send(&mut window, 6, "browser_leases_list", json!({})).await;
    assert_eq!(response(&mut window, 6).await["result"]["leases"], json!([]));
}

#[tokio::test]
async fn a_failed_tool_and_a_departed_host_both_answer_the_caller() {
    let handle = daemon("failures");
    let mut window = connect(&handle).await;
    send(&mut window, 1, "state_set", strip("browser:b")).await;
    response(&mut window, 1).await;
    let mut host = connect(&handle).await;
    send(&mut host, 1, "browser_host_register", json!({})).await;
    response(&mut host, 1).await;

    send(&mut window, 2, "browser_tool", json!({ "workspaceId": "w1", "tool": "browser_click", "args": { "tab": "browser:b", "uid": "9_9" } })).await;
    let call = event(&mut host, "browser-call").await;
    send(&mut host, 2, "browser_result", json!({ "callId": call["callId"], "ok": false, "error": "Take a new snapshot" })).await;
    assert_eq!(response(&mut window, 2).await["error"], "Take a new snapshot");

    send(&mut window, 3, "browser_tool", json!({ "workspaceId": "w1", "tool": "browser_snapshot", "args": {} })).await;
    event(&mut host, "browser-call").await;
    host.close(None).await.expect("close");
    drop(host);
    let gone = response(&mut window, 3).await;
    assert!(gone["error"].as_str().unwrap_or_default().contains("went away"), "{gone}");
}
