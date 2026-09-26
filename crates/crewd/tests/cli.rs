use std::io::{BufRead, BufReader};
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

use futures_util::{SinkExt, StreamExt};
use tokio_tungstenite::connect_async;
use tokio_tungstenite::tungstenite::Message;

fn crewd() -> Command {
    Command::new(env!("CARGO_BIN_EXE_crewd"))
}

fn data_dir(name: &str) -> std::path::PathBuf {
    let dir = std::env::temp_dir().join(format!("crewd-cli-{name}-{}", std::process::id()));
    let _ = std::fs::create_dir_all(&dir);
    dir
}

fn wait_exit(child: &mut std::process::Child, timeout: Duration) {
    let start = Instant::now();
    loop {
        if let Some(status) = child.try_wait().expect("wait") {
            assert!(status.success(), "{status}");
            return;
        }
        if start.elapsed() > timeout {
            let _ = child.kill();
            panic!("crewd did not exit within {timeout:?}");
        }
        std::thread::sleep(Duration::from_millis(20));
    }
}

#[test]
fn prints_json_and_exits_on_stdin_eof() {
    let dir = data_dir("eof");
    let mut child = crewd()
        .arg("--data-dir")
        .arg(&dir)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .expect("spawn");
    let stdout = child.stdout.take().expect("stdout");
    let mut line = String::new();
    BufReader::new(stdout)
        .read_line(&mut line)
        .expect("json line");
    let info: serde_json::Value = serde_json::from_str(line.trim()).expect("json");
    assert!(
        info["url"]
            .as_str()
            .is_some_and(|url| url.starts_with("ws://127.0.0.1:")),
        "{info}"
    );
    assert!(
        info["token"]
            .as_str()
            .is_some_and(|token| !token.is_empty()),
        "{info}"
    );
    assert!(dir.join("crew.sqlite3").exists());
    drop(child.stdin.take());
    wait_exit(&mut child, Duration::from_secs(5));
}

#[test]
fn exits_on_sigterm() {
    let dir = data_dir("term");
    let mut child = crewd()
        .arg("--data-dir")
        .arg(&dir)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .expect("spawn");
    let stdout = child.stdout.take().expect("stdout");
    let mut line = String::new();
    BufReader::new(stdout)
        .read_line(&mut line)
        .expect("json line");
    assert!(line.contains("ws://127.0.0.1:"), "{line}");
    let status = Command::new("kill")
        .arg("-TERM")
        .arg(child.id().to_string())
        .status()
        .expect("kill");
    assert!(status.success());
    wait_exit(&mut child, Duration::from_secs(5));
}

#[test]
fn mcp_flag_does_not_print_daemon_info() {
    let output = crewd().arg("--mcp").output().expect("run");
    assert!(!output.status.success());
    let stdout = String::from_utf8_lossy(&output.stdout);
    assert!(!stdout.contains("ws://"), "{stdout}");
}

/// daemon.json is how the `crew` CLI finds a daemon it did not start: there
/// while the daemon runs, private, and gone once it stops cleanly. Its user
/// token is good for the MCP shim, whose handshake says which tools there are.
#[test]
fn daemon_json_lives_as_long_as_the_daemon_and_speaks_as_the_user() {
    use std::io::Write;
    use std::os::unix::fs::PermissionsExt;
    // Short: the bridge socket lives here and must fit in SUN_LEN.
    let dir = std::env::temp_dir().join(format!("cdj-{}", std::process::id()));
    let _ = std::fs::create_dir_all(&dir);
    let mut child = crewd()
        .arg("--data-dir")
        .arg(&dir)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .expect("spawn");
    let stdout = child.stdout.take().expect("stdout");
    let mut line = String::new();
    BufReader::new(stdout).read_line(&mut line).expect("json line");
    let info: serde_json::Value = serde_json::from_str(line.trim()).expect("json");

    let path = dir.join("daemon.json");
    let file: serde_json::Value = serde_json::from_slice(&std::fs::read(&path).expect("daemon.json")).expect("json");
    assert_eq!(file["url"], info["url"]);
    assert_eq!(file["token"], info["token"]);
    assert_eq!(file["version"], env!("CARGO_PKG_VERSION"));
    assert_eq!(std::fs::metadata(&path).expect("meta").permissions().mode() & 0o777, 0o600);

    let mut mcp = crewd()
        .arg("--mcp")
        .env("CREW_SOCKET", file["socket"].as_str().expect("socket"))
        .env("CREW_TOKEN", file["userToken"].as_str().expect("userToken"))
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .spawn()
        .expect("mcp");
    let mut stdin = mcp.stdin.take().expect("stdin");
    writeln!(stdin, r#"{{"jsonrpc":"2.0","id":1,"method":"initialize","params":{{"protocolVersion":"2025-06-18"}}}}"#)
        .expect("write");
    let mut reply = String::new();
    BufReader::new(mcp.stdout.take().expect("stdout")).read_line(&mut reply).expect("reply");
    drop(stdin);
    let _ = mcp.wait();
    let reply: serde_json::Value = serde_json::from_str(&reply).expect("json");
    let instructions = reply["result"]["instructions"].as_str().unwrap_or_default();
    assert!(instructions.contains("find_tool") && instructions.contains("list_agents"), "{reply}");
    assert!(!instructions.contains("continue_after_turn"), "the user has no turns: {instructions}");

    drop(child.stdin.take());
    wait_exit(&mut child, Duration::from_secs(5));
    assert!(!path.exists(), "daemon.json outlived its daemon");
}

fn alive(pid: u32) -> bool {
    Command::new("kill")
        .args(["-0", &pid.to_string()])
        .status()
        .map(|status| status.success())
        .unwrap_or(false)
}

fn children_of(pid: u32) -> Vec<u32> {
    let output = Command::new("pgrep")
        .args(["-P", &pid.to_string()])
        .output()
        .expect("pgrep");
    String::from_utf8_lossy(&output.stdout)
        .split_whitespace()
        .filter_map(|word| word.parse().ok())
        .collect()
}

fn wait_until(timeout: Duration, mut pred: impl FnMut() -> bool) -> bool {
    let start = Instant::now();
    loop {
        if pred() {
            return true;
        }
        if start.elapsed() > timeout {
            return false;
        }
        std::thread::sleep(Duration::from_millis(20));
    }
}

#[tokio::test]
async fn killed_node_parent_reaps_pty_sleep() {
    let dir = data_dir("killed-parent");
    let mut parent = Command::new("node")
        .arg("-e")
        .arg(
            r#"
const { spawn } = require("node:child_process");
const crewd = spawn(process.env.CREWD, ["--data-dir", process.env.CREWD_DIR], {
  stdio: ["pipe", "pipe", "inherit"],
});
process.stdout.write(`crewd-pid ${crewd.pid}\n`);
crewd.stdout.on("data", (chunk) => process.stdout.write(chunk));
setInterval(() => {}, 1 << 30);
"#,
        )
        .env("CREWD", env!("CARGO_BIN_EXE_crewd"))
        .env("CREWD_DIR", &dir)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .expect("spawn node parent");

    let stdout = parent.stdout.take().expect("stdout");
    let mut lines = BufReader::new(stdout).lines();
    let pid_line = lines.next().expect("pid line").expect("pid line");
    let crewd_pid: u32 = pid_line
        .strip_prefix("crewd-pid ")
        .expect("crewd-pid prefix")
        .parse()
        .expect("crewd pid");
    let handshake = lines.next().expect("handshake").expect("handshake");
    let info: serde_json::Value = serde_json::from_str(handshake.trim()).expect("json");
    let url = info["url"].as_str().expect("url").to_string();
    let token = info["token"].as_str().expect("token").to_string();

    let (mut ws, _) = connect_async(&url).await.expect("connect");
    ws.send(Message::Text(format!(r#"{{"auth":"{token}"}}"#).into()))
        .await
        .expect("auth");
    ws.send(Message::Text(
        format!(
            r#"{{"id":1,"method":"pty_spawn","params":{{"id":"t","cwd":"{}","command":["/bin/sleep","1000"],"cols":80,"rows":24}}}}"#,
            dir.display()
        )
        .into(),
    ))
    .await
    .expect("spawn");

    let mut spawned = false;
    while let Some(msg) = ws.next().await {
        let Message::Text(text) = msg.expect("ws") else {
            continue;
        };
        let value: serde_json::Value = serde_json::from_str(&text).expect("response");
        if value["id"] == 1 {
            assert!(value["ok"].as_bool().unwrap_or(false), "{text}");
            spawned = true;
            break;
        }
    }
    assert!(spawned, "pty_spawn did not finish");
    drop(ws);

    let sleep_pids = wait_until(Duration::from_secs(2), || !children_of(crewd_pid).is_empty())
        .then(|| children_of(crewd_pid))
        .expect("sleep child of crewd");
    assert!(
        sleep_pids.iter().any(|&pid| alive(pid)),
        "sleep {sleep_pids:?} should be running"
    );

    let status = Command::new("kill")
        .args(["-9", &parent.id().to_string()])
        .status()
        .expect("sigkill parent");
    assert!(status.success());
    let _ = parent.wait();

    assert!(
        wait_until(Duration::from_secs(3), || !alive(crewd_pid) && sleep_pids.iter().all(|&pid| !alive(pid))),
        "crewd {crewd_pid} or sleep {sleep_pids:?} still alive after parent SIGKILL"
    );
}

/// The LaunchAgent's crewd: stdin is /dev/null, so its end is no reason to
/// stop, and stdout is a log file, so the handshake (which holds the token)
/// is never printed. `daemon_shutdown` from the user stops it cleanly, and a
/// clean stop exits 0, which is what keeps launchd from starting it again.
#[test]
fn under_launchd_it_outlives_stdin_prints_no_token_and_stops_when_asked() {
    use std::io::{Read, Write};
    let dir = std::env::temp_dir().join(format!("cla-{}", std::process::id()));
    let _ = std::fs::create_dir_all(&dir);
    let path = dir.join("daemon.json");
    let _ = std::fs::remove_file(&path);
    let mut child = crewd()
        .arg("--data-dir")
        .arg(&dir)
        .args(["--supervised-by", "launchd"])
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .expect("spawn");
    assert!(wait_until(Duration::from_secs(10), || path.exists()), "no daemon.json");
    std::thread::sleep(Duration::from_millis(300));
    assert!(child.try_wait().expect("wait").is_none(), "stopped on the end of stdin");

    let file: serde_json::Value = serde_json::from_slice(&std::fs::read(&path).expect("read")).expect("json");
    let mut stream = std::os::unix::net::UnixStream::connect(file["socket"].as_str().expect("socket")).expect("unix");
    writeln!(stream, r#"{{"token":"{}","method":"daemon/shutdown"}}"#, file["userToken"].as_str().expect("token"))
        .expect("write");
    let mut reply = String::new();
    BufReader::new(stream).read_line(&mut reply).expect("reply");
    assert!(reply.contains("result"), "{reply}");
    wait_exit(&mut child, Duration::from_secs(10));
    assert!(!path.exists(), "daemon.json outlived its daemon");

    let mut out = String::new();
    child.stdout.take().expect("stdout").read_to_string(&mut out).expect("stdout");
    let token = file["token"].as_str().expect("token");
    assert!(!out.contains(token), "the handshake went to the log: {out}");
}

/// A second crewd on a data dir used to unlink the live one's socket and
/// bind its own, cutting every session off the daemon that holds them. It
/// leaves now: with 0 under launchd, so KeepAlive does not bring it back
/// every ten seconds, and with a failure for the app, which says why.
#[test]
fn a_second_crewd_leaves_the_live_one_alone() {
    let dir = std::env::temp_dir().join(format!("c2d-{}", std::process::id()));
    let _ = std::fs::create_dir_all(&dir);
    let mut first = crewd()
        .arg("--data-dir")
        .arg(&dir)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .expect("spawn");
    let mut line = String::new();
    BufReader::new(first.stdout.take().expect("stdout")).read_line(&mut line).expect("json line");
    let path = dir.join("daemon.json");
    let before = std::fs::read(&path).expect("daemon.json");

    let launchd = crewd()
        .arg("--data-dir")
        .arg(&dir)
        .args(["--supervised-by", "launchd"])
        .stdin(Stdio::null())
        .output()
        .expect("second under launchd");
    assert!(launchd.status.success(), "{launchd:?}");
    let said = String::from_utf8_lossy(&launchd.stderr);
    assert!(said.contains("another crewd is already running"), "{said}");

    let child = crewd().arg("--data-dir").arg(&dir).stdin(Stdio::piped()).output().expect("second as a child");
    assert!(!child.status.success(), "{child:?}");
    assert!(String::from_utf8_lossy(&child.stderr).contains("another crewd is already running"));
    assert!(child.stdout.is_empty(), "a refused crewd printed a handshake");

    assert_eq!(std::fs::read(&path).expect("daemon.json"), before, "daemon.json is still the first one's");
    let file: serde_json::Value = serde_json::from_slice(&before).expect("json");
    let mut stream = std::os::unix::net::UnixStream::connect(file["socket"].as_str().expect("socket")).expect("unix");
    {
        use std::io::Write;
        writeln!(stream, r#"{{"token":"{}","method":"whoami"}}"#, file["userToken"].as_str().expect("token")).expect("write");
    }
    let mut reply = String::new();
    BufReader::new(stream).read_line(&mut reply).expect("reply");
    assert!(reply.contains("result"), "the first crewd no longer answers: {reply}");

    drop(first.stdin.take());
    wait_exit(&mut first, Duration::from_secs(10));
}

/// A start that cannot succeed used to exit 1, which launchd answers by
/// starting crewd again every ten seconds for the rest of the session.
#[test]
fn a_start_that_cannot_succeed_is_not_retried_by_launchd() {
    let base = data_dir("bad-dir");
    let file = base.join("not-a-dir");
    std::fs::write(&file, "").expect("file");
    let dir = file.join("data");
    let launchd = crewd()
        .arg("--data-dir")
        .arg(&dir)
        .args(["--supervised-by", "launchd"])
        .stdin(Stdio::null())
        .output()
        .expect("run");
    assert!(launchd.status.success(), "{launchd:?}");
    assert!(String::from_utf8_lossy(&launchd.stderr).contains("won't be restarted"), "{launchd:?}");
    let child = crewd().arg("--data-dir").arg(&dir).stdin(Stdio::piped()).output().expect("run");
    assert!(!child.status.success(), "the app has to hear it failed: {child:?}");
}

/// The handlers used to go in after startup, so a SIGTERM during it (a
/// bootout, the app quitting) killed crewd half started: no cleanup, and a
/// signal death, which launchd restarts.
#[test]
fn a_sigterm_during_startup_is_a_clean_stop() {
    use std::io::Read;
    let dir = std::env::temp_dir().join(format!("cst-{}", std::process::id()));
    let _ = std::fs::create_dir_all(&dir);
    let mut child = crewd()
        .arg("--data-dir")
        .arg(&dir)
        .args(["--supervised-by", "launchd"])
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::piped())
        .spawn()
        .expect("spawn");
    let mut stderr = BufReader::new(child.stderr.take().expect("stderr"));
    let mut line = String::new();
    stderr.read_line(&mut line).expect("starting line");
    assert!(line.contains("starting"), "{line}");
    let status = Command::new("kill").args(["-TERM", &child.id().to_string()]).status().expect("kill");
    assert!(status.success());
    wait_exit(&mut child, Duration::from_secs(10));
    let mut rest = String::new();
    let _ = stderr.read_to_string(&mut rest);
    assert!(rest.contains("stopping"), "{rest}");
    assert!(!dir.join("daemon.json").exists(), "daemon.json outlived its daemon");
    assert!(!dir.join("crew.sock").exists(), "the socket outlived its daemon");
}

#[test]
fn an_unknown_supervisor_is_refused() {
    let output = crewd()
        .arg("--data-dir")
        .arg(data_dir("bad-supervisor"))
        .args(["--supervised-by", "systemd"])
        .stdin(Stdio::null())
        .output()
        .expect("run");
    assert!(!output.status.success());
    assert!(String::from_utf8_lossy(&output.stderr).contains("--supervised-by"));
}
