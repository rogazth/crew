//! The browser methods over the wire, fed the exact JSON the renderer sends:
//! a casing slip between `api.ts` and the Rust structs only shows up here.

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
    let dir = std::env::temp_dir().join(format!("crewd-browser-{name}-{}", std::process::id()));
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

async fn call(ws: &mut Ws, id: u32, method: &str, params: Value) -> Result<Value, String> {
    let request = json!({ "id": id, "method": method, "params": params }).to_string();
    ws.send(Message::Text(request.into())).await.expect("send");
    loop {
        let message = tokio::time::timeout(Duration::from_secs(5), ws.next())
            .await
            .expect("rpc timeout")
            .expect("closed")
            .expect("ws");
        let Message::Text(text) = message else { continue };
        let response: Value = serde_json::from_str(&text).expect("json");
        if response["id"] != id {
            continue;
        }
        return match response["ok"].as_bool() {
            Some(true) => Ok(response["result"].clone()),
            _ => Err(response["error"].as_str().unwrap_or_default().to_string()),
        };
    }
}

#[tokio::test]
async fn history_answers_the_json_the_renderer_sends() {
    let handle = daemon("history");
    let mut ws = connect(&handle).await;

    // The renderer reports every navigation; one that is not http(s) is
    // dropped, not refused.
    let blank = call(&mut ws, 1, "browser_history_visit", json!({ "url": "about:blank", "title": "" })).await;
    assert_eq!(blank, Ok(Value::Null));
    let visit = json!({ "url": "https://me:pw@GitHub.com/#top", "title": "", "workspaceId": "w1" });
    call(&mut ws, 2, "browser_history_visit", visit).await.expect("visit");
    call(&mut ws, 3, "browser_history_title", json!({ "url": "https://github.com", "title": "GitHub" }))
        .await
        .expect("title");
    call(&mut ws, 4, "browser_history_visit", json!({ "url": "https://docs.rs/tokio", "title": "tokio - Rust" }))
        .await
        .expect("visit");

    let found = call(&mut ws, 5, "browser_history_suggest", json!({ "text": "git", "limit": 5 }))
        .await
        .expect("suggest");
    assert_eq!(found.as_array().map(Vec::len), Some(1), "{found}");
    let entry = &found[0];
    assert_eq!(entry["urlKey"], "https://github.com");
    assert_eq!(entry["url"], "https://GitHub.com/");
    assert_eq!(entry["host"], "github.com");
    assert_eq!(entry["title"], "GitHub");
    assert_eq!(entry["visitCount"], 1);
    assert_eq!(entry["workspaceId"], "w1");
    assert!(entry["lastVisitedAt"].is_i64(), "{entry}");

    let listed = call(&mut ws, 6, "browser_history_list", json!({ "limit": 10 })).await.expect("list");
    assert_eq!(listed.as_array().map(Vec::len), Some(2), "{listed}");
    // Both visits may share a millisecond, so find the row rather than index it.
    let docs = listed.as_array().and_then(|rows| rows.iter().find(|row| row["host"] == "docs.rs"));
    assert_eq!(docs.map(|row| &row["workspaceId"]), Some(&Value::Null), "{listed}");
    let filtered = call(&mut ws, 7, "browser_history_list", json!({ "text": "tokio", "limit": 10 }))
        .await
        .expect("list");
    assert_eq!(filtered.as_array().map(Vec::len), Some(1), "{filtered}");
    let before = call(&mut ws, 8, "browser_history_list", json!({ "before": 0, "limit": 10 }))
        .await
        .expect("list");
    assert_eq!(before, json!([]));

    call(&mut ws, 9, "browser_history_delete", json!({ "urlKey": "https://docs.rs/tokio" }))
        .await
        .expect("delete");
    let left = call(&mut ws, 10, "browser_history_list", json!({ "limit": 10 })).await.expect("list");
    assert_eq!(left.as_array().map(Vec::len), Some(1), "{left}");

    call(&mut ws, 11, "browser_history_clear", json!({ "since": 0 })).await.expect("clear");
    call(&mut ws, 12, "browser_history_clear", json!({})).await.expect("clear all");
    let empty = call(&mut ws, 13, "browser_history_list", json!({ "limit": 10 })).await.expect("list");
    assert_eq!(empty, json!([]));
    handle.shutdown();
}

#[tokio::test]
async fn a_page_snapshot_round_trips_over_the_wire() {
    let handle = daemon("pages");
    let mut ws = connect(&handle).await;

    let save = json!({ "pageId": "browser:1", "entriesJson": "[{\"url\":\"https://a.com\"}]", "activeIndex": 0 });
    call(&mut ws, 1, "browser_page_save", save).await.expect("save");
    let page = call(&mut ws, 2, "browser_page_get", json!({ "pageId": "browser:1" })).await.expect("get");
    assert_eq!(page["pageId"], "browser:1");
    assert_eq!(page["entriesJson"], "[{\"url\":\"https://a.com\"}]");
    assert_eq!(page["activeIndex"], 0);
    assert!(page["updatedAt"].is_i64(), "{page}");

    call(&mut ws, 3, "browser_page_delete", json!({ "pageId": "browser:1" })).await.expect("delete");
    let gone = call(&mut ws, 4, "browser_page_get", json!({ "pageId": "browser:1" })).await;
    assert_eq!(gone, Ok(Value::Null));

    // The size cap reaches the renderer as an error, not a silent drop.
    let too_big = json!({ "pageId": "p", "entriesJson": "x".repeat(512 * 1024 + 1), "activeIndex": 0 });
    assert!(call(&mut ws, 5, "browser_page_save", too_big).await.is_err());
    handle.shutdown();
}
