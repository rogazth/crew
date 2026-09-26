//! `crew` against a real crewd, found the way a user's shell finds it: through
//! the daemon.json in its data dir.

use std::io::{BufRead, BufReader};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Output, Stdio};
use std::time::{Duration, Instant};

use serde_json::{json, Value};
use tokio_tungstenite::tungstenite::{connect, Message};

/// crewd is another package's binary, so Cargo does not hand its path to this
/// test. It is built beside `crew`; a lone `cargo test -p crew-cli` builds it.
fn crewd_path() -> PathBuf {
    let path = Path::new(env!("CARGO_BIN_EXE_crew")).with_file_name("crewd");
    if !path.exists() {
        let cargo = std::env::var("CARGO").unwrap_or_else(|_| "cargo".into());
        let status = Command::new(cargo).args(["build", "-p", "crewd"]).status().expect("cargo build");
        assert!(status.success(), "cargo build -p crewd");
    }
    path
}

struct Daemon {
    child: Child,
    dir: PathBuf,
    url: String,
    token: String,
}

impl Daemon {
    fn start(name: &str) -> Self {
        // Short: the bridge socket lives here and must fit in SUN_LEN.
        let dir = std::env::temp_dir().join(format!("ccli-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).expect("dir");
        let mut child = Command::new(crewd_path())
            .arg("--data-dir")
            .arg(&dir)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .spawn()
            .expect("spawn crewd");
        let mut line = String::new();
        BufReader::new(child.stdout.take().expect("stdout")).read_line(&mut line).expect("handshake");
        let info: Value = serde_json::from_str(line.trim()).expect("json");
        Self {
            child,
            dir,
            url: info["url"].as_str().expect("url").to_string(),
            token: info["token"].as_str().expect("token").to_string(),
        }
    }

    /// A workspace at `folder` with one agent in it, made the way the window
    /// makes them.
    fn seed(&self, folder: &Path, agent: &str) -> (String, String) {
        let (mut ws, _) = connect(self.url.as_str()).expect("connect");
        ws.send(Message::Text(json!({ "auth": self.token }).to_string().into())).expect("auth");
        let mut rpc = |id: u32, method: &str, params: Value| -> Value {
            ws.send(Message::Text(json!({ "id": id, "method": method, "params": params }).to_string().into()))
                .expect("send");
            loop {
                let Message::Text(text) = ws.read().expect("read") else { continue };
                let reply: Value = serde_json::from_str(&text).expect("json");
                if reply["id"] == id {
                    assert_eq!(reply["ok"], true, "{method}: {reply}");
                    return reply["result"].clone();
                }
            }
        };
        let workspace = rpc(1, "workspace_create", json!({ "name": "cli", "path": folder }));
        let session = rpc(
            2,
            "session_create",
            json!({
                "workspaceId": workspace["id"],
                "kind": "agent",
                "name": agent,
                "provider": "claude",
                "model": "",
                "description": "",
                "autonomy": "ask"
            }),
        );
        (workspace["id"].as_str().expect("id").to_string(), session["id"].as_str().expect("id").to_string())
    }

    fn stop(mut self) {
        drop(self.child.stdin.take());
        let deadline = Instant::now() + Duration::from_secs(5);
        while self.child.try_wait().expect("wait").is_none() {
            assert!(Instant::now() < deadline, "crewd did not exit");
            std::thread::sleep(Duration::from_millis(20));
        }
    }
}

/// `crew` as the user's shell runs it: no session in the environment.
fn crew(daemon_dir: &Path, cwd: &Path, args: &[&str]) -> Output {
    Command::new(env!("CARGO_BIN_EXE_crew"))
        .args(args)
        .current_dir(cwd)
        .env("CREW_DATA_DIR", daemon_dir)
        .env_remove("CREW_TOKEN")
        .env_remove("CREW_SOCKET")
        .env("NO_COLOR", "1")
        .stdin(Stdio::null())
        .output()
        .expect("run crew")
}

fn stdout(output: &Output) -> String {
    String::from_utf8_lossy(&output.stdout).into_owned()
}

#[test]
fn crew_speaks_as_the_user_through_daemon_json() {
    let daemon = Daemon::start("user");
    let folder = daemon.dir.join("repo");
    std::fs::create_dir_all(folder.join("src")).expect("folder");
    let (workspace, agent) = daemon.seed(&folder, "Reviewer");

    // From a folder inside the workspace, which is the default workspace.
    let out = crew(&daemon.dir, &folder.join("src"), &["agents"]);
    assert!(out.status.success(), "{out:?}");
    let table = stdout(&out);
    assert!(table.starts_with("NAME"), "{table}");
    assert!(table.contains("Reviewer") && table.contains(&agent), "{table}");

    // The raw MCP answer, under --json.
    let out = crew(&daemon.dir, &folder, &["call", "list_agents", "--json"]);
    assert!(out.status.success(), "{out:?}");
    let raw: Value = serde_json::from_slice(&out.stdout).expect("json");
    let rows: Value = serde_json::from_str(raw["content"][0]["text"].as_str().expect("text")).expect("rows");
    assert_eq!(rows[0]["id"], agent.as_str(), "{rows}");

    // Named by id from anywhere.
    let elsewhere = std::env::temp_dir();
    let out = crew(&daemon.dir, &elsewhere, &["agents", "--json", "--workspace", &workspace]);
    assert!(out.status.success(), "{out:?}");
    let rows: Value = serde_json::from_slice(&out.stdout).expect("json");
    assert_eq!(rows[0]["name"], "Reviewer");

    // Status says who it took us for.
    let out = crew(&daemon.dir, &folder, &["status", "--json"]);
    assert!(out.status.success(), "{out:?}");
    let status: Value = serde_json::from_slice(&out.stdout).expect("json");
    assert_eq!(status["running"], true);
    assert_eq!(status["caller"]["kind"], "user");
    assert_eq!(status["caller"]["workspace"]["id"], workspace.as_str());
    assert_eq!(status["version"], env!("CARGO_PKG_VERSION"));

    // The catalog lists what the gateway hides, and one tool describes itself.
    let out = crew(&daemon.dir, &folder, &["call", "--help"]);
    let catalog = stdout(&out);
    assert!(out.status.success() && catalog.contains("list_routines"), "{catalog}");
    assert!(!catalog.contains("find_tool"), "{catalog}");
    let out = crew(&daemon.dir, &folder, &["call", "message_agent", "--help"]);
    let help = stdout(&out);
    assert!(help.contains("Arguments:") && help.contains("to") && help.contains("required"), "{help}");

    // A refusal is an answer on stdout and a failed exit.
    let out = crew(&daemon.dir, &folder, &["call", "no_such_tool"]);
    assert_eq!(out.status.code(), Some(1), "{out:?}");
    assert!(stdout(&out).contains("Unknown tool"), "{out:?}");

    // Outside any workspace, a tool that needs one says how to name one.
    let out = crew(&daemon.dir, &elsewhere, &["agents"]);
    assert_eq!(out.status.code(), Some(1), "{out:?}");
    assert!(String::from_utf8_lossy(&out.stderr).contains("--workspace"), "{out:?}");

    daemon.stop();
}

#[test]
fn crew_says_when_crew_is_not_running() {
    let daemon = Daemon::start("gone");
    let dir = daemon.dir.clone();
    daemon.stop();
    let out = crew(&dir, &dir, &["agents"]);
    assert_eq!(out.status.code(), Some(3), "{out:?}");
    assert!(String::from_utf8_lossy(&out.stderr).contains("Crew isn't running"), "{out:?}");
    let out = crew(&dir, &dir, &["status"]);
    assert_eq!(out.status.code(), Some(3), "{out:?}");
    assert!(stdout(&out).contains("not running"), "{out:?}");
}

/// `crewd call` is kept for a version as the same command.
#[test]
fn crewd_call_is_crew_call() {
    let daemon = Daemon::start("alias");
    let folder = daemon.dir.join("repo");
    std::fs::create_dir_all(&folder).expect("folder");
    let (_, agent) = daemon.seed(&folder, "Coder");
    let out = Command::new(crewd_path())
        .args(["call", "list_agents"])
        .current_dir(&folder)
        .env("CREW_DATA_DIR", &daemon.dir)
        .env_remove("CREW_TOKEN")
        .env_remove("CREW_SOCKET")
        .output()
        .expect("crewd call");
    assert!(out.status.success(), "{out:?}");
    assert!(stdout(&out).contains(&agent), "{out:?}");
    daemon.stop();
}
