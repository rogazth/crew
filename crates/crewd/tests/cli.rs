use std::io::{BufRead, BufReader, Read, Write};
use std::path::Path;
use std::process::{Child, ChildStdin, ChildStdout, Command, ExitStatus, Stdio};
use std::sync::mpsc;
use std::time::{Duration, Instant};

use futures_util::{SinkExt, StreamExt};
use tokio_tungstenite::connect_async;
use tokio_tungstenite::tungstenite::{self, Message};

const IN_TIME: Duration = Duration::from_secs(3);

const SIGHUP: i32 = 1;
const SIGINT: i32 = 2;
const SIGTERM: i32 = 15;

extern "C" {
    fn kill(pid: i32, sig: i32) -> i32;
}

fn signal(pid: u32, sig: i32) {
    assert_eq!(unsafe { kill(pid as i32, sig) }, 0, "signal {sig} to {pid}");
}

fn alive(pid: u32) -> bool {
    unsafe { kill(pid as i32, 0) == 0 }
}

/// Short, so the bridge socket inside fits in sun_path.
fn temp_dir() -> tempfile::TempDir {
    tempfile::Builder::new()
        .prefix("c")
        .tempdir_in("/tmp")
        .expect("temp dir")
}

/// crewd with a home of its own and no login shell to read, so it never
/// touches the user's dotfiles.
fn crewd(home: &Path) -> Command {
    let mut command = Command::new(env!("CARGO_BIN_EXE_crewd"));
    command
        .env("HOME", home)
        .env_remove("SHELL")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    command
}

fn wait_exit(child: &mut Child) -> ExitStatus {
    let start = Instant::now();
    loop {
        if let Some(status) = child.try_wait().expect("try_wait") {
            return status;
        }
        if start.elapsed() > IN_TIME {
            let _ = child.kill();
            panic!("crewd did not exit within {IN_TIME:?}");
        }
        std::thread::sleep(Duration::from_millis(5));
    }
}

/// A running daemon, past its handshake. Killed if the test ends early.
struct Daemon {
    child: Child,
    stdin: Option<ChildStdin>,
    _stdout: BufReader<ChildStdout>,
    url: String,
    token: String,
}

impl Daemon {
    fn start(mut command: Command) -> Self {
        let mut child = command.spawn().expect("spawn crewd");
        let mut stdout = BufReader::new(child.stdout.take().expect("stdout"));
        // Bounded: a daemon that never prints its line fails here, not by hanging.
        let (tx, rx) = mpsc::channel();
        let reader = std::thread::spawn(move || {
            let mut line = String::new();
            let read = stdout.read_line(&mut line);
            let _ = tx.send(read.map(|_| line));
            stdout
        });
        let line = match rx.recv_timeout(IN_TIME) {
            Ok(Ok(line)) => line,
            other => {
                let _ = child.kill();
                panic!("no handshake from crewd: {other:?}");
            }
        };
        let info: serde_json::Value = serde_json::from_str(line.trim()).expect("handshake json");
        let url = info["url"].as_str().expect("url").to_string();
        let token = info["token"].as_str().expect("token").to_string();
        assert!(url.starts_with("ws://127.0.0.1:"), "{info}");
        assert!(!token.is_empty(), "{info}");
        Self {
            stdin: child.stdin.take(),
            child,
            _stdout: reader.join().expect("reader"),
            url,
            token,
        }
    }

    fn pid(&self) -> u32 {
        self.child.id()
    }

    /// Opens a terminal running `sleep` and returns its pid.
    fn spawn_terminal(&self, cwd: &Path) -> u32 {
        let (mut ws, _) = tungstenite::connect(&self.url).expect("connect");
        if let tungstenite::stream::MaybeTlsStream::Plain(tcp) = ws.get_mut() {
            tcp.set_read_timeout(Some(IN_TIME)).expect("read timeout");
        }
        ws.send(Message::Text(
            serde_json::json!({ "auth": self.token }).to_string().into(),
        ))
        .expect("auth");
        ws.send(Message::Text(
            serde_json::json!({
                "id": 1,
                "method": "pty_spawn",
                "params": {
                    "id": "t",
                    "cwd": cwd,
                    "command": ["/bin/sleep", "1000"],
                    "cols": 80,
                    "rows": 24,
                },
            })
            .to_string()
            .into(),
        ))
        .expect("pty_spawn");
        loop {
            let Message::Text(text) = ws.read().expect("pty_spawn answer in time") else {
                continue;
            };
            let value: serde_json::Value = serde_json::from_str(&text).expect("json");
            if value["id"] == 1 {
                assert_eq!(value["ok"], true, "{text}");
                break;
            }
        }
        let start = Instant::now();
        loop {
            if let Some(&pid) = children_of(self.pid()).first() {
                return pid;
            }
            assert!(start.elapsed() < IN_TIME, "no terminal under crewd");
            std::thread::sleep(Duration::from_millis(5));
        }
    }

    fn close_stdin(&mut self) {
        drop(self.stdin.take());
    }

    fn wait(&mut self) -> ExitStatus {
        wait_exit(&mut self.child)
    }
}

impl Drop for Daemon {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
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

struct Failed {
    status: ExitStatus,
    stdout: String,
    stderr: String,
}

/// Runs crewd until it gives up on its own.
fn run_to_exit(mut command: Command) -> Failed {
    let mut child = command.stdin(Stdio::piped()).spawn().expect("spawn crewd");
    let status = wait_exit(&mut child);
    Failed {
        status,
        stdout: drain(child.stdout.take()),
        stderr: drain(child.stderr.take()),
    }
}

fn drain(pipe: Option<impl Read>) -> String {
    let mut text = String::new();
    if let Some(mut pipe) = pipe {
        pipe.read_to_string(&mut text).expect("read pipe");
    }
    text
}

#[test]
fn prints_json_and_exits_on_stdin_eof() {
    let dir = temp_dir();
    let mut command = crewd(dir.path());
    command.arg("--data-dir").arg(dir.path());
    let mut daemon = Daemon::start(command);

    assert!(dir.path().join("crew.sqlite3").exists());
    assert!(dir.path().join("crew.sock").exists());
    assert!(dir.path().join("claude-bind").is_dir());

    // Input is not a request to leave; only its end is.
    daemon
        .stdin
        .as_mut()
        .expect("stdin")
        .write_all(b"anything\n")
        .expect("write");
    daemon.close_stdin();
    let status = daemon.wait();
    assert!(status.success(), "{status}");
    assert!(!dir.path().join("crew.sock").exists());
}

#[test]
fn the_data_dir_can_be_given_after_an_equals_sign() {
    let home = temp_dir();
    let dir = home.path().join("data");
    let mut command = crewd(home.path());
    command.arg("--verbose").arg(format!("--data-dir={}", dir.display()));

    let mut daemon = Daemon::start(command);

    assert!(dir.join("crew.sqlite3").exists());
    daemon.close_stdin();
    assert!(daemon.wait().success());
}

#[test]
fn without_a_data_dir_the_daemon_makes_its_own_in_the_temp_dir() {
    for args in [&[][..], &["--data-dir"][..]] {
        let tmp = temp_dir();
        let mut command = crewd(tmp.path());
        command.env("TMPDIR", tmp.path()).args(args);

        let mut daemon = Daemon::start(command);

        let own = tmp.path().join(format!("crewd-{}", daemon.pid()));
        assert!(own.join("crew.sqlite3").exists(), "{args:?}");
        daemon.close_stdin();
        assert!(daemon.wait().success());
    }
}

/// The signal a parent sends ends the daemon cleanly: a success status, its
/// terminals killed and the bridge socket gone.
fn ends_cleanly_on(sig: i32) {
    let dir = temp_dir();
    let mut command = crewd(dir.path());
    command.arg("--data-dir").arg(dir.path());
    let mut daemon = Daemon::start(command);
    let terminal = daemon.spawn_terminal(dir.path());
    assert!(alive(terminal));

    signal(daemon.pid(), sig);

    let status = daemon.wait();
    assert!(status.success(), "signal {sig}: {status}");
    assert!(!alive(terminal), "terminal {terminal} outlived crewd");
    assert!(!dir.path().join("crew.sock").exists());
}

#[test]
fn exits_cleanly_on_sigterm() {
    ends_cleanly_on(SIGTERM);
}

#[test]
fn exits_cleanly_on_sigint() {
    ends_cleanly_on(SIGINT);
}

#[test]
fn exits_cleanly_on_sighup() {
    ends_cleanly_on(SIGHUP);
}

#[test]
fn stdin_eof_also_kills_the_terminals() {
    let dir = temp_dir();
    let mut command = crewd(dir.path());
    command.arg("--data-dir").arg(dir.path());
    let mut daemon = Daemon::start(command);
    let terminal = daemon.spawn_terminal(dir.path());

    daemon.close_stdin();

    assert!(daemon.wait().success());
    assert!(!alive(terminal), "terminal {terminal} outlived crewd");
}

/// The parent may signal the moment it has read the handshake line, so the
/// handlers have to exist before that line is printed.
#[test]
fn a_sigterm_right_after_the_handshake_still_exits_cleanly() {
    let dir = temp_dir();
    for round in 0..20 {
        let mut command = crewd(dir.path());
        command.arg("--data-dir").arg(dir.path());
        let mut daemon = Daemon::start(command);

        signal(daemon.pid(), SIGTERM);

        let status = daemon.wait();
        assert!(status.success(), "round {round}: {status}");
    }
}

#[test]
fn a_data_dir_that_cannot_be_made_fails_startup_with_a_message() {
    let home = temp_dir();
    let file = home.path().join("file");
    std::fs::write(&file, "").expect("file");
    let mut command = crewd(home.path());
    command.arg("--data-dir").arg(file.join("data"));

    let failed = run_to_exit(command);

    assert_eq!(failed.status.code(), Some(1));
    assert_eq!(failed.stdout, "", "a failed start printed a handshake");
    assert!(failed.stderr.contains("claude-bind"), "{}", failed.stderr);
}

#[test]
fn a_data_dir_too_deep_for_the_bridge_socket_fails_startup() {
    let home = temp_dir();
    let mut command = crewd(home.path());
    command.arg("--data-dir").arg(home.path().join("d".repeat(120)));

    let failed = run_to_exit(command);

    assert_eq!(failed.status.code(), Some(1));
    assert_eq!(failed.stdout, "");
    assert!(!failed.stderr.trim().is_empty());
}

#[test]
fn a_store_that_cannot_be_opened_fails_startup() {
    let dir = temp_dir();
    std::fs::create_dir(dir.path().join("crew.sqlite3")).expect("dir in the store's place");
    let mut command = crewd(dir.path());
    command.arg("--data-dir").arg(dir.path());

    let failed = run_to_exit(command);

    assert_eq!(failed.status.code(), Some(1));
    assert_eq!(failed.stdout, "");
    assert!(!failed.stderr.trim().is_empty());
}

#[test]
fn a_parent_gone_before_the_handshake_fails_startup() {
    let dir = temp_dir();
    let (reader, writer) = std::io::pipe().expect("pipe");
    drop(reader);
    let mut command = crewd(dir.path());
    command.arg("--data-dir").arg(dir.path()).stdout(writer);

    let failed = run_to_exit(command);

    assert_eq!(failed.status.code(), Some(1));
    assert!(!failed.stderr.trim().is_empty());
}

#[test]
fn mcp_flag_does_not_print_daemon_info() {
    let dir = temp_dir();
    let mut command = crewd(dir.path());
    command
        .arg("--mcp")
        .env_remove("CREW_SOCKET")
        .env_remove("CREW_TOKEN");

    let failed = run_to_exit(command);

    assert!(!failed.status.success());
    assert!(!failed.stdout.contains("ws://"), "{}", failed.stdout);
}

#[tokio::test]
async fn killed_node_parent_reaps_pty_sleep() {
    let dir = temp_dir();
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
        .env("CREWD_DIR", dir.path())
        .env("HOME", dir.path())
        .env_remove("SHELL")
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
            dir.path().display()
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
