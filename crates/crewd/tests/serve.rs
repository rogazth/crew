//! `crewd serve`: the daemon a window reaches on another machine. Run as the
//! binary, since what matters is how the process lives and dies.

use std::io::{BufRead, BufReader, Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::time::{Duration, Instant};

use futures_util::{SinkExt, StreamExt};
use serde_json::{json, Value};
use tokio_tungstenite::tungstenite::Message;
use tokio_tungstenite::{connect_async, MaybeTlsStream, WebSocketStream};

type Ws = WebSocketStream<MaybeTlsStream<tokio::net::TcpStream>>;

fn temp(name: &str) -> PathBuf {
    let dir = std::env::temp_dir().join(format!("crewd-serve-{name}-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).expect("dir");
    dir
}

struct Served {
    child: Child,
    url: String,
}

impl Served {
    fn start(dir: &Path) -> Self {
        let mut child = Command::new(env!("CARGO_BIN_EXE_crewd"))
            .args(["serve", "--listen", "127.0.0.1:0", "--data-dir"])
            .arg(dir)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .spawn()
            .expect("spawn");
        let mut line = String::new();
        BufReader::new(child.stdout.take().expect("stdout"))
            .read_line(&mut line)
            .expect("url line");
        let info: Value = serde_json::from_str(line.trim()).expect("json");
        assert!(info.get("token").is_none(), "the token must not reach stdout: {info}");
        let url = info["url"].as_str().expect("url").to_string();
        Self { child, url }
    }

    fn addr(&self) -> &str {
        self.url.trim_start_matches("ws://")
    }

    fn terminate(&mut self) {
        let status = Command::new("kill")
            .args(["-TERM", &self.child.id().to_string()])
            .status()
            .expect("kill");
        assert!(status.success());
        let start = Instant::now();
        loop {
            if let Some(status) = self.child.try_wait().expect("wait") {
                assert!(status.success(), "{status}");
                return;
            }
            assert!(start.elapsed() < Duration::from_secs(5), "crewd serve ignored SIGTERM");
            std::thread::sleep(Duration::from_millis(20));
        }
    }
}

impl Drop for Served {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

fn token(dir: &Path) -> String {
    std::fs::read_to_string(dir.join("token")).expect("token").trim().to_string()
}

/// The first message after `auth`, or None when the daemon hung up instead.
async fn authenticate(url: &str, token: &str) -> (Ws, Option<Value>) {
    let (mut ws, _) = connect_async(url).await.expect("connect");
    ws.send(Message::Text(json!({ "auth": token }).to_string().into()))
        .await
        .expect("auth");
    let first = tokio::time::timeout(Duration::from_secs(5), ws.next())
        .await
        .expect("auth reply timeout");
    let hello = match first {
        Some(Ok(Message::Text(text))) => Some(serde_json::from_str(&text).expect("json")),
        _ => None,
    };
    (ws, hello)
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
async fn answers_a_good_token_with_hello_and_hangs_up_on_a_bad_one() {
    let dir = temp("auth");
    let served = Served::start(&dir);

    let (_, hello) = authenticate(&served.url, &token(&dir)).await;
    let hello = hello.expect("hello");
    assert_eq!(hello["event"], "hello");
    assert_eq!(hello["payload"]["protocol"], crew_protocol::PROTOCOL);
    assert_eq!(hello["payload"]["version"], env!("CARGO_PKG_VERSION"));

    let (_, refused) = authenticate(&served.url, "not-the-token").await;
    assert!(refused.is_none(), "{refused:?}");
}

#[tokio::test]
async fn the_token_survives_a_restart() {
    let dir = temp("restart");
    let mut first = Served::start(&dir);
    let before = token(&dir);
    assert_eq!(before.len(), 32);
    first.terminate();

    let second = Served::start(&dir);
    assert_eq!(token(&dir), before);
    let (_, hello) = authenticate(&second.url, &before).await;
    assert!(hello.is_some());
}

#[tokio::test]
async fn closing_stdin_does_not_stop_it() {
    let dir = temp("stdin");
    let mut served = Served::start(&dir);
    drop(served.child.stdin.take());
    std::thread::sleep(Duration::from_millis(500));
    assert!(served.child.try_wait().expect("wait").is_none(), "crewd serve died on stdin EOF");
    let (_, hello) = authenticate(&served.url, &token(&dir)).await;
    assert!(hello.is_some());
    served.terminate();
}

#[tokio::test]
async fn daemon_info_and_dir_list() {
    let dir = temp("rpc");
    let served = Served::start(&dir);
    let (mut ws, _) = authenticate(&served.url, &token(&dir)).await;

    let info = call(&mut ws, 1, "daemon_info", json!({})).await.expect("daemon_info");
    assert_eq!(info["protocol"], crew_protocol::PROTOCOL);
    assert_eq!(info["version"], env!("CARGO_PKG_VERSION"));
    assert_eq!(info["agentsRunning"], 0);
    assert!(info["installed"].is_array(), "{info}");
    assert!(info["cpus"].as_u64().is_some_and(|cpus| cpus >= 1), "{info}");

    let tree = temp("tree");
    std::fs::create_dir_all(tree.join("app/.git")).unwrap();
    std::fs::create_dir_all(tree.join("Notes")).unwrap();
    std::fs::create_dir_all(tree.join("linked-target")).unwrap();
    std::fs::write(tree.join("linked-target/.git"), "gitdir: elsewhere").unwrap();
    std::os::unix::fs::symlink(tree.join("linked-target"), tree.join("wt")).unwrap();
    std::fs::write(tree.join("readme.md"), "").unwrap();

    let listing = call(&mut ws, 2, "dir_list", json!({ "path": tree })).await.expect("dir_list");
    assert_eq!(listing["repo"], false);
    let entries: Vec<(String, bool)> = listing["entries"]
        .as_array()
        .unwrap()
        .iter()
        .map(|entry| (entry["name"].as_str().unwrap().to_string(), entry["repo"].as_bool().unwrap()))
        .collect();
    assert_eq!(
        entries,
        vec![
            ("app".into(), true),
            ("linked-target".into(), true),
            ("Notes".into(), false),
            ("wt".into(), true),
        ]
    );

    let app = call(&mut ws, 3, "dir_list", json!({ "path": tree.join("app") })).await.expect("dir_list");
    assert_eq!(app["repo"], true);
    let home = call(&mut ws, 4, "dir_list", json!({ "path": "~" })).await.expect("home");
    assert_eq!(home["path"], info["home"]);
    assert!(call(&mut ws, 5, "dir_list", json!({ "path": tree.join("missing") })).await.is_err());

    assert_eq!(call(&mut ws, 6, "ping", json!({})).await.expect("ping"), Value::Null);
    let saved = call(
        &mut ws,
        7,
        "remote_upsert",
        json!({ "id": "", "name": "VPS", "host": "100.1.1.1", "port": 7777, "user": "agent" }),
    )
    .await
    .expect("upsert");
    assert!(!saved["id"].as_str().unwrap_or("").is_empty());
    let listed = call(&mut ws, 8, "remote_list", json!({})).await.expect("list");
    assert_eq!(listed.as_array().map(Vec::len), Some(1));
    call(&mut ws, 9, "remote_delete", json!({ "id": saved["id"] })).await.expect("delete");
    let empty = call(&mut ws, 10, "remote_list", json!({})).await.expect("list again");
    assert_eq!(empty.as_array().map(Vec::len), Some(0));
}

struct Reply {
    status: u16,
    headers: String,
    body: Vec<u8>,
}

fn get(addr: &str, target: &str, headers: &[&str]) -> Reply {
    let mut stream = std::net::TcpStream::connect(addr).expect("connect");
    let mut request = format!("GET {target} HTTP/1.1\r\nHost: {addr}\r\n");
    for header in headers {
        request.push_str(header);
        request.push_str("\r\n");
    }
    request.push_str("\r\n");
    stream.write_all(request.as_bytes()).expect("write");
    let mut raw = Vec::new();
    stream.read_to_end(&mut raw).expect("read");
    let split = raw.windows(4).position(|window| window == b"\r\n\r\n").expect("head");
    let head = String::from_utf8(raw[..split].to_vec()).expect("utf8");
    let status = head.split(' ').nth(1).expect("status").parse().expect("code");
    Reply {
        status,
        headers: head.to_ascii_lowercase(),
        body: raw[split + 4..].to_vec(),
    }
}

fn fs_target(root: &Path, path: &str) -> String {
    let encode = |text: &str| {
        text.bytes()
            .map(|byte| match byte {
                b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => (byte as char).to_string(),
                _ => format!("%{byte:02X}"),
            })
            .collect::<String>()
    };
    format!("/fs?root={}&path={}", encode(&root.to_string_lossy()), encode(path))
}

#[test]
fn fs_serves_files_under_the_root_and_nothing_else() {
    let dir = temp("fs-data");
    let served = Served::start(&dir);
    let bearer = format!("Authorization: Bearer {}", token(&dir));
    let auth = [bearer.as_str()];

    let root = temp("fs-root");
    let outside = temp("fs-outside");
    std::fs::create_dir_all(root.join("report")).unwrap();
    std::fs::write(root.join("report/index.html"), "<h1>report</h1>").unwrap();
    std::fs::write(root.join("clip.bin"), b"0123456789").unwrap();
    std::fs::write(root.join(".env"), "SECRET=1").unwrap();
    std::fs::write(outside.join("secret.txt"), "outside").unwrap();
    std::os::unix::fs::symlink(outside.join("secret.txt"), root.join("escape.txt")).unwrap();
    std::os::unix::fs::symlink(&outside, root.join("escape-dir")).unwrap();
    std::fs::write(root.join("inside.txt"), "inside").unwrap();
    std::os::unix::fs::symlink(root.join("inside.txt"), root.join("alias.txt")).unwrap();

    let page = get(served.addr(), &fs_target(&root, "report"), &auth);
    assert_eq!(page.status, 200);
    assert_eq!(page.body, b"<h1>report</h1>");
    assert!(page.headers.contains("content-type: text/html"), "{}", page.headers);

    let alias = get(served.addr(), &fs_target(&root, "alias.txt"), &auth);
    assert_eq!((alias.status, alias.body.as_slice()), (200, b"inside".as_slice()));

    let range = get(served.addr(), &fs_target(&root, "clip.bin"), &[auth[0], "Range: bytes=2-5"]);
    assert_eq!(range.status, 206);
    assert_eq!(range.body, b"2345");
    assert!(range.headers.contains("content-range: bytes 2-5/10"), "{}", range.headers);

    for path in ["escape.txt", "escape-dir/secret.txt", ".env", "../fs-outside/secret.txt", "missing.txt"] {
        let refused = get(served.addr(), &fs_target(&root, path), &auth);
        assert_eq!(refused.status, 404, "{path}");
        assert!(!String::from_utf8_lossy(&refused.body).contains("outside"), "{path}");
    }

    assert_eq!(get(served.addr(), &fs_target(&root, "report"), &[]).status, 401);
    assert_eq!(
        get(served.addr(), &fs_target(&root, "report"), &["Authorization: Bearer wrong"]).status,
        401
    );
    assert_eq!(get(served.addr(), "/elsewhere", &auth).status, 404);
}
