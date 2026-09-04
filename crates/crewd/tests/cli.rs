use std::io::{BufRead, BufReader};
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

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
