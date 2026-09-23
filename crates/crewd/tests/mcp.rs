//! `crewd --mcp` and `crewd call`, the agent-side ends of the bridge, run as
//! the real binary against a real bridge the way a provider CLI runs them.

use std::io::{BufRead, BufReader, Read, Write};
use std::os::unix::net::UnixListener;
use std::process::{Child, ChildStdin, Command, ExitStatus, Stdio};
use std::sync::{mpsc, Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant};

use crew_core::bridge::{Bridge, ToolHost};
use serde_json::{json, Value};

const IN_TIME: Duration = Duration::from_secs(3);

/// Stands in for the daemon's tool dispatch, and remembers every call.
#[derive(Default)]
struct Tools {
    calls: Mutex<Vec<Value>>,
}

impl ToolHost for Tools {
    fn handle(&self, session_id: &str, method: &str, params: Value) -> Result<Value, String> {
        self.calls
            .lock()
            .unwrap()
            .push(json!({ "session": session_id, "method": method, "params": params }));
        match (method, params["name"].as_str()) {
            ("tools/list", _) => Ok(json!({ "tools": [{
                "name": "echo",
                "description": "Says it back.",
                "inputSchema": { "type": "object" },
            }] })),
            ("tools/call", Some("echo")) => Ok(json!({ "content": [{
                "type": "text",
                "text": format!("{session_id} said {}", params["arguments"]),
            }] })),
            ("tools/call", Some("refuse")) => Ok(json!({
                "content": [{ "type": "text", "text": "not today" }],
                "isError": true,
            })),
            (_, name) => Err(format!("No tool {}", name.unwrap_or("?"))),
        }
    }
}

/// A bridge with [`Tools`] behind it, in its own directory.
struct Crew {
    _dir: tempfile::TempDir,
    bridge: Bridge,
    socket: String,
    tools: Arc<Tools>,
}

fn temp_dir() -> tempfile::TempDir {
    // Short, so the socket inside fits in sun_path.
    tempfile::Builder::new()
        .prefix("c")
        .tempdir_in("/tmp")
        .expect("temp dir")
}

fn crew() -> Crew {
    let dir = temp_dir();
    let bridge = Bridge::start(dir.path().to_path_buf()).expect("bridge");
    let tools = Arc::new(Tools::default());
    bridge.set_handler(tools.clone());
    let socket = bridge.info().expect("info").socket_path;
    Crew {
        _dir: dir,
        bridge,
        socket,
        tools,
    }
}

impl Crew {
    /// crewd holding a fresh token for `session`.
    fn crewd(&self, session: &str) -> Command {
        crewd_at(&self.socket, &self.bridge.mint(session))
    }

    fn calls(&self) -> Vec<Value> {
        self.tools.calls.lock().unwrap().clone()
    }
}

fn crewd_at(socket: &str, token: &str) -> Command {
    let mut command = Command::new(env!("CARGO_BIN_EXE_crewd"));
    command.env("CREW_SOCKET", socket).env("CREW_TOKEN", token);
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
        thread::sleep(Duration::from_millis(5));
    }
}

struct Ran {
    status: ExitStatus,
    stdout: String,
    stderr: String,
}

/// Runs crewd to the end with nothing on stdin.
fn run(mut command: Command) -> Ran {
    let mut child = command
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .expect("spawn crewd");
    let status = wait_exit(&mut child);
    Ran {
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

/// `crewd --mcp`, driven over its stdin and stdout.
struct Shim {
    child: Child,
    stdin: Option<ChildStdin>,
    lines: mpsc::Receiver<String>,
}

impl Shim {
    fn spawn(mut command: Command) -> Self {
        let mut child = command
            .arg("--mcp")
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .spawn()
            .expect("spawn crewd --mcp");
        let stdout = child.stdout.take().expect("stdout");
        let (tx, lines) = mpsc::channel();
        thread::spawn(move || {
            for line in BufReader::new(stdout).lines() {
                let Ok(line) = line else { return };
                if tx.send(line).is_err() {
                    return;
                }
            }
        });
        Self {
            stdin: child.stdin.take(),
            child,
            lines,
        }
    }

    fn send_bytes(&mut self, bytes: &[u8]) {
        let stdin = self.stdin.as_mut().expect("stdin open");
        stdin
            .write_all(bytes)
            .and_then(|_| stdin.write_all(b"\n"))
            .and_then(|_| stdin.flush())
            .expect("write to the shim");
    }

    fn send(&mut self, message: Value) {
        self.send_bytes(message.to_string().as_bytes());
    }

    fn next(&self) -> Value {
        let line = self
            .lines
            .recv_timeout(IN_TIME)
            .expect("a line from the shim in time");
        serde_json::from_str(&line).unwrap_or_else(|e| panic!("{line:?} is not json: {e}"))
    }

    /// Sends a request and returns its response, which has to be the next line.
    fn request(&mut self, id: u64, method: &str, params: Value) -> Value {
        self.send(json!({ "jsonrpc": "2.0", "id": id, "method": method, "params": params }));
        let reply = self.next();
        assert_eq!(reply["jsonrpc"], "2.0", "{reply}");
        assert_eq!(reply["id"], id, "{reply}");
        reply
    }

    /// Closes stdin and returns how the shim exited and whatever it still printed.
    fn finish(mut self) -> (ExitStatus, Vec<String>) {
        drop(self.stdin.take());
        let status = wait_exit(&mut self.child);
        (status, self.rest())
    }

    /// Waits for the shim to exit on its own, having printed nothing more.
    fn exited(mut self) -> ExitStatus {
        let status = wait_exit(&mut self.child);
        assert_eq!(self.rest(), Vec::<String>::new());
        status
    }

    fn rest(&self) -> Vec<String> {
        let mut rest = Vec::new();
        loop {
            match self.lines.recv_timeout(IN_TIME) {
                Ok(line) => rest.push(line),
                Err(mpsc::RecvTimeoutError::Disconnected) => return rest,
                Err(mpsc::RecvTimeoutError::Timeout) => panic!("stdout still open after exit"),
            }
        }
    }
}

impl Drop for Shim {
    /// Hangs up the way a client does, so the shim exits on its own.
    fn drop(&mut self) {
        drop(self.stdin.take());
        let start = Instant::now();
        while matches!(self.child.try_wait(), Ok(None)) && start.elapsed() < IN_TIME {
            thread::sleep(Duration::from_millis(5));
        }
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

#[test]
fn initialize_gives_an_older_client_its_revision_and_a_newer_one_the_shims() {
    let crew = crew();
    let mut shim = Shim::spawn(crew.crewd("agent-1"));

    let older = shim.request(1, "initialize", json!({ "protocolVersion": "2024-11-05" }));
    assert_eq!(older["result"]["protocolVersion"], "2024-11-05");
    assert_eq!(older["result"]["capabilities"], json!({ "tools": {} }));
    assert_eq!(older["result"]["serverInfo"]["name"], "crew");

    let newer = shim.request(2, "initialize", json!({ "protocolVersion": "2099-01-01" }));
    assert_eq!(newer["result"]["protocolVersion"], "2025-06-18");
    let unknown = shim.request(3, "initialize", json!({ "protocolVersion": "draft" }));
    assert_eq!(unknown["result"]["protocolVersion"], "2025-06-18");

    let (status, rest) = shim.finish();
    assert!(status.success(), "{status}");
    assert!(rest.is_empty(), "{rest:?}");
    assert!(crew.calls().is_empty(), "the handshake asked crew: {:?}", crew.calls());
}

#[test]
fn notifications_get_no_response() {
    let crew = crew();
    let mut shim = Shim::spawn(crew.crewd("agent-1"));

    shim.send(json!({ "jsonrpc": "2.0", "method": "notifications/initialized" }));
    shim.send(json!({ "jsonrpc": "2.0", "id": null, "method": "ping" }));

    assert_eq!(shim.request(7, "ping", json!({}))["result"], json!({}));
}

#[test]
fn tools_list_returns_the_bridges_tools() {
    let crew = crew();
    let mut shim = Shim::spawn(crew.crewd("agent-1"));

    let reply = shim.request(1, "tools/list", json!({}));

    assert_eq!(reply["result"]["tools"][0]["name"], "echo");
    assert_eq!(reply["result"]["tools"][0]["inputSchema"], json!({ "type": "object" }));
    assert_eq!(
        crew.calls(),
        vec![json!({ "session": "agent-1", "method": "tools/list", "params": {} })]
    );
}

#[test]
fn tools_call_round_trips_to_the_daemon_and_back() {
    let crew = crew();
    let mut shim = Shim::spawn(crew.crewd("agent-1"));
    let params = json!({ "name": "echo", "arguments": { "x": 1 } });

    let reply = shim.request(4, "tools/call", params.clone());

    assert_eq!(
        reply["result"],
        json!({ "content": [{ "type": "text", "text": r#"agent-1 said {"x":1}"# }] })
    );
    assert_eq!(
        crew.calls(),
        vec![json!({ "session": "agent-1", "method": "tools/call", "params": params })]
    );
}

#[test]
fn a_call_the_daemon_refuses_is_an_error_result_for_the_model() {
    let crew = crew();
    let mut shim = Shim::spawn(crew.crewd("agent-1"));

    let reply = shim.request(1, "tools/call", json!({ "name": "nope" }));

    assert!(reply.get("error").is_none(), "{reply}");
    assert_eq!(
        reply["result"],
        json!({ "content": [{ "type": "text", "text": "No tool nope" }], "isError": true })
    );
}

#[test]
fn a_token_crew_never_minted_is_refused_by_the_bridge() {
    let crew = crew();
    let mut shim = Shim::spawn(crewd_at(&crew.socket, "forged"));

    let call = shim.request(1, "tools/call", json!({ "name": "echo" }));
    assert_eq!(call["result"]["isError"], true);
    assert_eq!(call["result"]["content"][0]["text"], "Bad token");

    let list = shim.request(2, "tools/list", json!({}));
    assert_eq!(list["error"], json!({ "code": -32603, "message": "Bad token" }));
    assert!(crew.calls().is_empty());
}

#[test]
fn an_unknown_method_is_a_json_rpc_error() {
    let crew = crew();
    let mut shim = Shim::spawn(crew.crewd("agent-1"));

    let reply = shim.request(9, "resources/list", json!({}));

    assert_eq!(
        reply["error"],
        json!({ "code": -32601, "message": "Method not found: resources/list" })
    );
    let bare = shim.request(10, "", Value::Null);
    assert_eq!(bare["error"]["code"], -32601);
}

#[test]
fn malformed_lines_are_skipped_and_the_shim_keeps_serving() {
    let crew = crew();
    let mut shim = Shim::spawn(crew.crewd("agent-1"));

    shim.send_bytes(b"{not json");
    shim.send_bytes(b"");
    shim.send_bytes(b"   ");
    shim.send_bytes(b"[1, 2");

    assert_eq!(shim.request(3, "ping", Value::Null)["result"], json!({}));
}

#[test]
fn a_bridge_that_is_down_yields_an_error_result_not_a_hang() {
    let dir = temp_dir();
    let socket = dir.path().join("crew.sock");
    let mut shim = Shim::spawn(crewd_at(socket.to_str().unwrap(), "t"));

    let call = shim.request(1, "tools/call", json!({ "name": "echo" }));
    assert_eq!(call["result"]["isError"], true);
    let text = call["result"]["content"][0]["text"].as_str().unwrap_or_default();
    assert!(text.starts_with("Crew is not running"), "{call}");

    let list = shim.request(2, "tools/list", json!({}));
    assert_eq!(list["error"]["code"], -32603);
}

#[test]
fn a_bridge_that_hangs_up_mid_call_yields_an_error_result() {
    let dir = temp_dir();
    let socket = dir.path().join("fake.sock");
    let listener = UnixListener::bind(&socket).expect("bind");
    thread::spawn(move || {
        let (stream, _) = listener.accept().expect("accept");
        let mut request = String::new();
        let _ = BufReader::new(stream).read_line(&mut request);
    });
    let mut shim = Shim::spawn(crewd_at(socket.to_str().unwrap(), "t"));

    let call = shim.request(1, "tools/call", json!({ "name": "echo" }));

    assert_eq!(call["result"]["isError"], true);
    let text = call["result"]["content"][0]["text"].as_str().unwrap_or_default();
    assert!(text.starts_with("Bad reply"), "{call}");
}

#[test]
fn eof_on_stdin_exits_cleanly() {
    let crew = crew();
    let shim = Shim::spawn(crew.crewd("agent-1"));

    let (status, rest) = shim.finish();

    assert!(status.success(), "{status}");
    assert!(rest.is_empty(), "{rest:?}");
}

#[test]
fn a_line_that_is_not_utf8_ends_the_session_cleanly() {
    let crew = crew();
    let mut shim = Shim::spawn(crew.crewd("agent-1"));

    shim.send_bytes(b"\xff\xfe");

    let status = shim.exited();
    assert!(status.success(), "{status}");
}

#[test]
fn a_client_that_stops_reading_ends_the_shim() {
    let crew = crew();
    let mut child = crew
        .crewd("agent-1")
        .arg("--mcp")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .expect("spawn");
    drop(child.stdout.take());
    let mut stdin = child.stdin.take().expect("stdin");

    // Until the answers have nowhere to go. A child another test forks at the
    // same moment can hold the read end open for an instant, so one answer
    // may still land in the pipe.
    let start = Instant::now();
    let status = loop {
        if let Some(status) = child.try_wait().expect("try_wait") {
            break status;
        }
        assert!(start.elapsed() < IN_TIME, "crewd kept serving a closed stdout");
        let _ = writeln!(stdin, r#"{{"jsonrpc":"2.0","id":1,"method":"ping"}}"#);
        thread::sleep(Duration::from_millis(5));
    };
    assert!(status.success(), "{status}");
}

#[test]
fn the_shim_needs_crew_socket_and_crew_token() {
    let mut no_socket = Command::new(env!("CARGO_BIN_EXE_crewd"));
    no_socket
        .arg("--mcp")
        .env_remove("CREW_SOCKET")
        .env("CREW_TOKEN", "t");
    let ran = run(no_socket);
    assert_eq!(ran.status.code(), Some(1));
    assert!(ran.stderr.contains("CREW_SOCKET is not set"), "{}", ran.stderr);
    assert_eq!(ran.stdout, "");

    let mut no_token = Command::new(env!("CARGO_BIN_EXE_crewd"));
    no_token
        .arg("--mcp")
        .env("CREW_SOCKET", "/nowhere")
        .env_remove("CREW_TOKEN");
    let ran = run(no_token);
    assert_eq!(ran.status.code(), Some(1));
    assert!(ran.stderr.contains("CREW_TOKEN is not set"), "{}", ran.stderr);
}

#[test]
fn call_prints_the_tools_text_and_succeeds() {
    let crew = crew();
    let mut command = crew.crewd("agent-1");
    command.args(["call", "echo", r#"{"x":1}"#]);

    let ran = run(command);

    assert!(ran.status.success(), "{}: {}", ran.status, ran.stderr);
    assert_eq!(ran.stdout, "agent-1 said {\"x\":1}\n");
    assert_eq!(
        crew.calls(),
        vec![json!({
            "session": "agent-1",
            "method": "tools/call",
            "params": { "name": "echo", "arguments": { "x": 1 } },
        })]
    );
}

#[test]
fn call_without_arguments_sends_an_empty_object() {
    let crew = crew();
    let mut command = crew.crewd("agent-1");
    command.args(["call", "echo"]);

    let ran = run(command);

    assert!(ran.status.success(), "{}", ran.status);
    assert_eq!(ran.stdout, "agent-1 said {}\n");
}

#[test]
fn call_of_a_tool_that_reports_an_error_prints_it_and_fails() {
    let crew = crew();
    let mut command = crew.crewd("agent-1");
    command.args(["call", "refuse"]);

    let ran = run(command);

    assert_eq!(ran.status.code(), Some(1));
    assert_eq!(ran.stdout, "not today\n");
}

#[test]
fn call_the_daemon_refuses_fails_with_its_error_on_stderr() {
    let crew = crew();
    let mut command = crew.crewd("agent-1");
    command.args(["call", "nope", "{}"]);

    let ran = run(command);

    assert_eq!(ran.status.code(), Some(1));
    assert_eq!(ran.stdout, "");
    assert_eq!(ran.stderr.trim(), "No tool nope");
}

#[test]
fn call_with_arguments_that_are_not_json_fails_before_asking_crew() {
    let crew = crew();
    let mut command = crew.crewd("agent-1");
    command.args(["call", "echo", "{x: 1"]);

    let ran = run(command);

    assert_eq!(ran.status.code(), Some(1));
    assert!(
        ran.stderr.starts_with("Arguments must be a JSON object"),
        "{}",
        ran.stderr
    );
    assert!(crew.calls().is_empty());
}

#[test]
fn call_without_a_tool_lists_the_tools() {
    let crew = crew();
    for args in [&["call"][..], &["call", "--help"][..]] {
        let mut command = crew.crewd("agent-1");
        command.args(args);

        let ran = run(command);

        assert!(ran.status.success(), "{args:?}: {}", ran.status);
        assert!(ran.stdout.starts_with("usage: crew call <tool>"), "{}", ran.stdout);
        assert!(
            ran.stdout
                .contains("echo\n  Says it back.\n  arguments: {\"type\":\"object\"}\n"),
            "{}",
            ran.stdout
        );
    }
}

#[test]
fn call_with_crew_down_fails_with_a_message() {
    let dir = temp_dir();
    let socket = dir.path().join("crew.sock");
    for args in [&["call"][..], &["call", "echo"][..]] {
        let mut command = crewd_at(socket.to_str().unwrap(), "t");
        command.args(args);

        let ran = run(command);

        assert_eq!(ran.status.code(), Some(1), "{args:?}");
        assert!(ran.stderr.starts_with("Crew is not running"), "{}", ran.stderr);
        assert_eq!(ran.stdout, "");
    }
}

#[test]
fn call_needs_the_environment_crew_gives_an_agent() {
    let mut command = Command::new(env!("CARGO_BIN_EXE_crewd"));
    command
        .args(["call", "echo"])
        .env_remove("CREW_SOCKET")
        .env_remove("CREW_TOKEN");

    let ran = run(command);

    assert_eq!(ran.status.code(), Some(1));
    assert!(ran.stderr.contains("CREW_SOCKET is not set"), "{}", ran.stderr);
}

/// The whole path with nothing stood in: the daemon's own tool dispatch over
/// a store holding the calling agent.
#[test]
fn the_real_daemon_answers_the_shim_and_call() {
    use crew_core::agent::AgentHost;
    use crew_core::pty::PtyHost;
    use crew_core::store::Store;

    let dir = temp_dir();
    let bridge = Bridge::start(dir.path().to_path_buf()).expect("bridge");
    let store = Store::open(dir.path().join("crew.sqlite3")).expect("store");
    let handle = crewd::serve(crewd::Config {
        pty: PtyHost::new(),
        store: store.clone(),
        agents: AgentHost::new(),
        bridge: bridge.clone(),
    })
    .expect("serve");
    let path = dir.path().to_string_lossy().into_owned();
    let workspace = crew_core::workspace::create(&store, "w".into(), path).expect("workspace");
    let agent = crew_core::session::create(
        &store,
        workspace.id,
        "agent".into(),
        "A".into(),
        "claude".into(),
        "m".into(),
        String::new(),
        "ask".into(),
    )
    .expect("agent");
    let socket = bridge.info().expect("info").socket_path;

    let mut shim = Shim::spawn(crewd_at(&socket, &bridge.mint(&agent.id)));
    let list = shim.request(1, "tools/list", json!({}));
    let names: Vec<&str> = list["result"]["tools"]
        .as_array()
        .expect("tools")
        .iter()
        .filter_map(|tool| tool["name"].as_str())
        .collect();
    assert!(names.contains(&"list_agents"), "{list}");
    drop(shim);

    let mut command = crewd_at(&socket, &bridge.mint(&agent.id));
    command.args(["call", "list_agents"]);
    let ran = run(command);
    assert!(ran.status.success(), "{}: {}", ran.status, ran.stderr);
    assert!(ran.stdout.contains(&agent.id), "{}", ran.stdout);

    handle.shutdown();
}
