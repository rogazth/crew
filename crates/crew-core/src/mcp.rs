//! `crew mcp` and the bridge client under every `crew` command. Inside an
//! agent or a terminal session they only see the environment Crew handed the
//! process at spawn; from the user's own shell the `crew` CLI builds the link
//! out of `daemon.json` instead.

use std::io::{BufRead, BufReader, Write};
use std::os::unix::net::UnixStream;
use std::process::ExitCode;
use std::time::Duration;

use serde_json::{json, Value};

/// How long a call waits for the daemon before giving up on it.
const CALL_TIMEOUT: Duration = Duration::from_secs(20);
/// A tool that waits on purpose (`wait_for_log`) takes `timeout_s` and says
/// how long; the call then waits that long plus this much for the answer to
/// travel back. The wait is capped, so a model cannot hang its own turn.
const WAIT_CAP_S: u64 = 60;
const WAIT_SLACK_S: u64 = 10;
/// The newest revision this shim knows; a client that asks for an older one gets its own back.
const PROTOCOL_VERSION: &str = "2025-06-18";

/// One way into the bridge: where it is and who is knocking.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Link {
    socket: String,
    /// Who this process is, as far as the daemon is concerned. Crew minted it
    /// for this session when the turn started; the session id is not sent and
    /// would not be believed.
    token: String,
    /// The workspace a user's call acts in, an id or a path inside one. The
    /// daemon ignores it for a session's token, whose workspace is its own.
    workspace: Option<String>,
}

impl Link {
    pub fn new(socket: impl Into<String>, token: impl Into<String>, workspace: Option<String>) -> Self {
        Self { socket: socket.into(), token: token.into(), workspace }
    }

    pub fn socket(&self) -> &str {
        &self.socket
    }

    /// The link Crew handed this process, if it handed it one.
    pub fn from_env() -> Result<Self, String> {
        let var = |key: &str| {
            std::env::var(key).map_err(|_| format!("{key} is not set; run this from an agent or a terminal session Crew started"))
        };
        Ok(Self {
            socket: var("CREW_SOCKET")?,
            token: var("CREW_TOKEN")?,
            workspace: None,
        })
    }

    /// One connection per call: a line out, a line back.
    pub fn call(&self, method: &str, params: Value) -> Result<Value, String> {
        let mut stream = UnixStream::connect(&self.socket).map_err(|e| unreachable_error(&e))?;
        let _ = stream.set_read_timeout(Some(call_timeout(method, &params)));
        let mut request = json!({
            "token": self.token,
            "method": method,
            "params": params,
        });
        if let Some(workspace) = &self.workspace {
            request["workspace"] = json!(workspace);
        }
        let mut line = request.to_string();
        line.push('\n');
        stream.write_all(line.as_bytes()).map_err(|e| e.to_string())?;

        let mut reply = String::new();
        BufReader::new(stream)
            .read_line(&mut reply)
            .map_err(|e| format!("Crew did not answer ({e})"))?;
        let body: Value = serde_json::from_str(&reply).map_err(|e| format!("Bad reply: {e}"))?;
        if let Some(error) = body.get("error").and_then(Value::as_str) {
            return Err(error.to_string());
        }
        Ok(body.get("result").cloned().unwrap_or(Value::Null))
    }
}

/// Said when nothing answers on the socket, so a caller can tell "Crew is not
/// there" from "Crew said no" by the prefix alone.
pub const NOT_RUNNING: &str = "Crew isn't running";

fn unreachable_error(error: &std::io::Error) -> String {
    format!("{NOT_RUNNING} ({error}) — open it or run `crew open`")
}

/// How long one call may take. The tool is the one named, or the one
/// `call_tool` names in its `arguments`, which is how a hidden tool is called.
///
/// A tool with a budget of its own (the browser's: crewd waits on Crew's
/// window for it, mounting and loading pages) gets that budget plus the
/// slack, so crewd's answer, even its timeout, arrives before this gives up.
/// Any other tool whose arguments carry `timeout_s` is one that waits that
/// long on purpose, so the read waits `min(timeout_s, 60) + 10` seconds. The
/// convention is the whole mechanism there: a tool that blocks names its
/// wait `timeout_s` and caps it at 60 itself. Never less than the default.
fn call_timeout(method: &str, params: &Value) -> Duration {
    if method != "tools/call" {
        return CALL_TIMEOUT;
    }
    let (name, arguments) = match params.get("name").and_then(Value::as_str) {
        Some("call_tool") => {
            let inner = params.get("arguments");
            (inner.and_then(|args| args.get("name")).and_then(Value::as_str), inner.and_then(|args| args.get("arguments")))
        }
        name => (name, params.get("arguments")),
    };
    let no_args = Value::Null;
    if let Some(budget) = name.and_then(|name| crate::browser_tools::budget(name, arguments.unwrap_or(&no_args))) {
        return (budget + Duration::from_secs(WAIT_SLACK_S)).max(CALL_TIMEOUT);
    }
    let asked = arguments
        .and_then(|args| args.get("timeout_s"))
        .and_then(|value| value.as_f64().filter(|secs| secs.is_finite() && *secs > 0.0));
    match asked {
        Some(secs) => {
            let waited = Duration::from_secs((secs.ceil() as u64).min(WAIT_CAP_S) + WAIT_SLACK_S);
            waited.max(CALL_TIMEOUT)
        }
        None => CALL_TIMEOUT,
    }
}

/// Model Context Protocol over stdio. Only `tools/*` is forwarded; the rest is
/// the handshake every client sends first.
pub fn serve_stdio() -> ExitCode {
    match Link::from_env() {
        Ok(link) => serve_stdio_with(&link),
        Err(e) => {
            eprintln!("{e}");
            ExitCode::FAILURE
        }
    }
}

/// The same server over a link the caller built: the `crew` CLI outside a
/// session speaks as the user, from `daemon.json`.
pub fn serve_stdio_with(link: &Link) -> ExitCode {
    let stdin = std::io::stdin();
    let mut stdout = std::io::stdout();
    for line in stdin.lock().lines() {
        let Ok(line) = line else { break };
        if line.trim().is_empty() {
            continue;
        }
        let message: Value = match serde_json::from_str(&line) {
            Ok(message) => message,
            Err(_) => continue,
        };
        let Some(id) = message.get("id").filter(|id| !id.is_null()).cloned() else {
            continue;
        };
        let method = message.get("method").and_then(Value::as_str).unwrap_or("");
        let params = message.get("params").cloned().unwrap_or(Value::Null);
        let body = match handle(link, method, params) {
            Ok(result) => json!({ "jsonrpc": "2.0", "id": id, "result": result }),
            Err((code, text)) => {
                json!({ "jsonrpc": "2.0", "id": id, "error": { "code": code, "message": text } })
            }
        };
        let mut text = body.to_string();
        text.push('\n');
        if stdout.write_all(text.as_bytes()).and_then(|_| stdout.flush()).is_err() {
            break;
        }
    }
    ExitCode::SUCCESS
}

fn handle(link: &Link, method: &str, params: Value) -> Result<Value, (i64, String)> {
    match method {
        "initialize" => {
            let requested = params.get("protocolVersion").and_then(Value::as_str);
            let mut result = json!({
                "protocolVersion": requested.unwrap_or(PROTOCOL_VERSION),
                "capabilities": { "tools": {} },
                "serverInfo": { "name": "crew", "version": env!("CARGO_PKG_VERSION") },
            });
            // Asked of the daemon, because what is listed depends on who is
            // calling. The handshake does not fail without it: a daemon that
            // is slow to answer still leaves the tools usable.
            if let Some(text) = link
                .call("instructions", Value::Null)
                .ok()
                .and_then(|reply| reply.get("instructions").and_then(Value::as_str).map(str::to_string))
            {
                result["instructions"] = json!(text);
            }
            Ok(result)
        }
        "ping" => Ok(json!({})),
        "tools/list" => link.call(method, params).map_err(|e| (-32603, e)),
        // A failed call is an answer the model should read, not a protocol error.
        "tools/call" => Ok(link.call(method, params).unwrap_or_else(|e| {
            json!({ "content": [{ "type": "text", "text": e }], "isError": true })
        })),
        _ => Err((-32601, format!("Method not found: {method}"))),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// What one call puts on the wire, as a bridge that answers once sees it.
    fn sent(link_for: impl FnOnce(String) -> Link) -> Value {
        let path = std::env::temp_dir().join(format!("cm-{}.sock", &uuid::Uuid::new_v4().to_string()[..8]));
        let listener = std::os::unix::net::UnixListener::bind(&path).expect("bind");
        let link = link_for(path.to_string_lossy().into_owned());
        let seen = std::thread::spawn(move || {
            let (stream, _) = listener.accept().expect("accept");
            let mut line = String::new();
            BufReader::new(stream.try_clone().expect("clone")).read_line(&mut line).expect("read");
            (&stream).write_all(b"{\"result\":{}}\n").expect("reply");
            line
        });
        link.call("tools/list", Value::Null).expect("call");
        let _ = std::fs::remove_file(&path);
        serde_json::from_str(&seen.join().expect("join")).expect("json")
    }

    #[test]
    fn a_users_call_names_its_workspace_and_a_sessions_does_not() {
        let user = sent(|socket| Link::new(socket, "u", Some("/code/crew".into())));
        assert_eq!((user["token"].as_str(), user["workspace"].as_str()), (Some("u"), Some("/code/crew")));
        let session = sent(|socket| Link::new(socket, "s", None));
        assert!(session.get("workspace").is_none(), "{session}");
    }

    #[test]
    fn nobody_on_the_socket_reads_as_not_running() {
        let error = Link::new("/nonexistent/crew.sock", "t", None).call("tools/list", Value::Null).unwrap_err();
        assert!(error.starts_with(NOT_RUNNING), "{error}");
    }

    #[test]
    fn a_call_waits_twenty_seconds_by_default() {
        assert_eq!(call_timeout("tools/call", &json!({ "name": "list_agents", "arguments": {} })), CALL_TIMEOUT);
        assert_eq!(call_timeout("tools/list", &Value::Null), CALL_TIMEOUT);
    }

    #[test]
    fn a_tool_that_waits_is_given_its_wait_and_ten_seconds_more() {
        let direct = json!({ "name": "wait_for_log", "arguments": { "timeout_s": 45 } });
        assert_eq!(call_timeout("tools/call", &direct), Duration::from_secs(55));
        // Through the gateway, which is how a hidden tool is called.
        let gateway = json!({ "name": "call_tool", "arguments": { "name": "wait_for_log", "arguments": { "timeout_s": 30 } } });
        assert_eq!(call_timeout("tools/call", &gateway), Duration::from_secs(40));
    }

    /// crewd waits on the window for up to a mount and a page load; the
    /// client must outlast it, or the model reads "Crew did not answer" while
    /// the call is still going and runs it again.
    #[test]
    fn a_browser_tool_is_given_crewds_budget_and_ten_seconds_more() {
        let budget = |tool: &str, args: Value| crate::browser_tools::budget(tool, &args).unwrap();
        let slack = Duration::from_secs(WAIT_SLACK_S);
        for (tool, args) in [
            ("open_tab", json!({ "url": "https://example.com" })),
            ("browser_navigate", json!({ "url": "https://example.com" })),
            ("browser_click", json!({ "uid": "1_1" })),
            ("browser_wait_for", json!({ "text": "Ready", "timeout_s": 50 })),
        ] {
            let direct = json!({ "name": tool, "arguments": args });
            assert_eq!(call_timeout("tools/call", &direct), budget(tool, args.clone()) + slack, "{tool}");
            let gateway = json!({ "name": "call_tool", "arguments": { "name": tool, "arguments": args } });
            assert_eq!(call_timeout("tools/call", &gateway), budget(tool, args.clone()) + slack, "{tool} via call_tool");
        }
        // More than the 60 s cap a process wait gets: crewd's budget is what counts.
        let long = json!({ "name": "call_tool", "arguments": { "name": "browser_wait_for", "arguments": { "text": "x", "timeout_s": 50 } } });
        assert_eq!(call_timeout("tools/call", &long), Duration::from_secs(95));
    }

    #[test]
    fn the_wait_is_capped_and_never_shorter_than_the_default() {
        let long = json!({ "name": "wait_for_log", "arguments": { "timeout_s": 3600 } });
        assert_eq!(call_timeout("tools/call", &long), Duration::from_secs(70));
        let short = json!({ "name": "wait_for_log", "arguments": { "timeout_s": 1 } });
        assert_eq!(call_timeout("tools/call", &short), CALL_TIMEOUT);
        let junk = json!({ "name": "wait_for_log", "arguments": { "timeout_s": "soon" } });
        assert_eq!(call_timeout("tools/call", &junk), CALL_TIMEOUT);
    }
}
