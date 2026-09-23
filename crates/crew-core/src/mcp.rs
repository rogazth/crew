//! `crew --mcp` and `crew call`: the agent-side ends of the bridge. Both run
//! inside the agent's process tree, not the app, so they only see the
//! environment Crew handed the agent at spawn.

use std::io::{BufRead, BufReader, Write};
use std::os::unix::net::UnixStream;
use std::process::ExitCode;
use std::time::Duration;

use serde_json::{json, Value};

const CALL_TIMEOUT: Duration = Duration::from_secs(20);
/// The newest revision this shim knows; a client that asks for an older one gets its own back.
const PROTOCOL_VERSION: &str = "2025-06-18";
/// Every revision the shim can answer in. Anything else, newer or unheard of,
/// is offered [`PROTOCOL_VERSION`] and the client decides whether to go on.
const PROTOCOL_VERSIONS: &[&str] = &["2024-11-05", "2025-03-26", PROTOCOL_VERSION];

struct Link {
    socket: String,
    /// Who this process is, as far as the daemon is concerned. Crew minted it
    /// for this session when the turn started; the session id is not sent and
    /// would not be believed.
    token: String,
    /// How long a call waits for the daemon's answer.
    timeout: Duration,
}

impl Link {
    fn from_env() -> Result<Self, String> {
        let var = |key: &str| {
            std::env::var(key).map_err(|_| format!("{key} is not set; run this from an agent Crew started"))
        };
        Ok(Self {
            socket: var("CREW_SOCKET")?,
            token: var("CREW_TOKEN")?,
            timeout: CALL_TIMEOUT,
        })
    }

    /// One connection per call: a line out, a line back.
    fn call(&self, method: &str, params: Value) -> Result<Value, String> {
        let mut stream = UnixStream::connect(&self.socket)
            .map_err(|e| format!("Crew is not running ({e})"))?;
        let _ = stream.set_read_timeout(Some(self.timeout));
        let mut line = json!({
            "token": self.token,
            "method": method,
            "params": params,
        })
        .to_string();
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

/// Model Context Protocol over stdio. Only `tools/*` is forwarded; the rest is
/// the handshake every client sends first.
pub fn serve_stdio() -> ExitCode {
    let link = match Link::from_env() {
        Ok(link) => link,
        Err(e) => {
            eprintln!("{e}");
            return ExitCode::FAILURE;
        }
    };
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
        let body = match handle(&link, method, params) {
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
            let version = requested
                .filter(|requested| PROTOCOL_VERSIONS.contains(requested))
                .unwrap_or(PROTOCOL_VERSION);
            Ok(json!({
                "protocolVersion": version,
                "capabilities": { "tools": {} },
                "serverInfo": { "name": "crew", "version": env!("CARGO_PKG_VERSION") },
            }))
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

/// `crew call <tool> [json-arguments]` for CLIs without a per-run MCP flag.
pub fn call(args: &[String]) -> ExitCode {
    let link = match Link::from_env() {
        Ok(link) => link,
        Err(e) => {
            eprintln!("{e}");
            return ExitCode::FAILURE;
        }
    };
    let Some(name) = args.first().filter(|name| !name.starts_with('-')) else {
        return match link.call("tools/list", Value::Null) {
            Ok(result) => {
                println!("usage: crew call <tool> ['{{\"json\": \"arguments\"}}']\n");
                for tool in result.get("tools").and_then(Value::as_array).into_iter().flatten() {
                    let name = tool.get("name").and_then(Value::as_str).unwrap_or("?");
                    let about = tool.get("description").and_then(Value::as_str).unwrap_or("");
                    let schema = tool.get("inputSchema").cloned().unwrap_or(Value::Null);
                    println!("{name}\n  {about}\n  arguments: {schema}\n");
                }
                ExitCode::SUCCESS
            }
            Err(e) => {
                eprintln!("{e}");
                ExitCode::FAILURE
            }
        };
    };
    let arguments: Value = match args.get(1) {
        Some(raw) => match serde_json::from_str(raw) {
            Ok(value) => value,
            Err(e) => {
                eprintln!("Arguments must be a JSON object: {e}");
                return ExitCode::FAILURE;
            }
        },
        None => json!({}),
    };
    match link.call("tools/call", json!({ "name": name, "arguments": arguments })) {
        Ok(result) => {
            let failed = result.get("isError").and_then(Value::as_bool).unwrap_or(false);
            for part in result.get("content").and_then(Value::as_array).into_iter().flatten() {
                if let Some(text) = part.get("text").and_then(Value::as_str) {
                    println!("{text}");
                }
            }
            if failed {
                ExitCode::FAILURE
            } else {
                ExitCode::SUCCESS
            }
        }
        Err(e) => {
            eprintln!("{e}");
            ExitCode::FAILURE
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::bridge::{Bridge, ToolHost};
    use crate::test_support::{temp_dir, WITHIN};
    use std::os::unix::net::UnixListener;
    use std::sync::{mpsc, Arc};
    use std::thread;

    /// The daemon's side, answering for whichever session the token names.
    struct Tools;

    impl ToolHost for Tools {
        fn handle(&self, session_id: &str, method: &str, params: Value) -> Result<Value, String> {
            match (method, params["name"].as_str()) {
                ("tools/list", _) => {
                    Ok(json!({ "tools": [{ "name": "echo" }], "caller": session_id }))
                }
                ("tools/call", Some("echo")) => Ok(json!({
                    "content": [{ "type": "text", "text": params["arguments"].to_string() }],
                    "caller": session_id,
                })),
                _ => Err(format!("{method} broke")),
            }
        }
    }

    /// A link holding session s1's token on a real bridge.
    fn linked() -> (tempfile::TempDir, Link) {
        let dir = temp_dir();
        let bridge = Bridge::start(dir.path().to_path_buf()).expect("bridge");
        bridge.set_handler(Arc::new(Tools));
        let link = Link {
            socket: bridge.info().expect("info").socket_path,
            token: bridge.mint("s1"),
            timeout: WITHIN,
        };
        (dir, link)
    }

    /// A link to a socket nobody listens on.
    fn crew_down() -> (tempfile::TempDir, Link) {
        let dir = temp_dir();
        let link = Link {
            socket: dir.path().join("crew.sock").to_string_lossy().into_owned(),
            token: "t".into(),
            timeout: WITHIN,
        };
        (dir, link)
    }

    /// A link to a stand-in daemon that reads one request and hands it, with
    /// the connection, to `answer`.
    fn scripted(
        timeout: Duration,
        answer: impl FnOnce(String, UnixStream) + Send + 'static,
    ) -> (tempfile::TempDir, Link) {
        let dir = temp_dir();
        let socket = dir.path().join("fake.sock");
        let listener = UnixListener::bind(&socket).expect("bind");
        thread::spawn(move || {
            let (stream, _) = listener.accept().expect("accept");
            let mut request = String::new();
            BufReader::new(stream.try_clone().expect("clone"))
                .read_line(&mut request)
                .expect("request");
            answer(request, stream);
        });
        let link = Link {
            socket: socket.to_string_lossy().into_owned(),
            token: "tok".into(),
            timeout,
        };
        (dir, link)
    }

    fn version_for(requested: Value) -> Value {
        let (_dir, link) = crew_down();
        let params = if requested.is_null() {
            json!({})
        } else {
            json!({ "protocolVersion": requested })
        };
        handle(&link, "initialize", params).expect("initialize")["protocolVersion"].clone()
    }

    #[test]
    fn initialize_gives_a_client_on_a_known_revision_its_own_back() {
        for known in ["2024-11-05", "2025-03-26", "2025-06-18"] {
            assert_eq!(version_for(json!(known)), known);
        }
    }

    #[test]
    fn initialize_offers_the_shims_revision_to_a_newer_or_unknown_client() {
        for requested in [json!("2099-01-01"), json!("banana"), json!(20250618), Value::Null] {
            assert_eq!(version_for(requested.clone()), PROTOCOL_VERSION, "asked for {requested}");
        }
    }

    #[test]
    fn initialize_offers_tools_under_the_crew_name_without_asking_crew() {
        let (_dir, link) = crew_down();
        let result = handle(&link, "initialize", json!({})).expect("initialize");
        assert_eq!(result["capabilities"], json!({ "tools": {} }));
        assert_eq!(result["serverInfo"]["name"], "crew");
        assert_eq!(result["serverInfo"]["version"], env!("CARGO_PKG_VERSION"));
    }

    #[test]
    fn ping_is_answered_without_asking_crew() {
        let (_dir, link) = crew_down();
        assert_eq!(handle(&link, "ping", Value::Null), Ok(json!({})));
    }

    #[test]
    fn an_unknown_method_is_method_not_found() {
        let (_dir, link) = linked();
        assert_eq!(
            handle(&link, "resources/list", Value::Null),
            Err((-32601, "Method not found: resources/list".to_string()))
        );
    }

    #[test]
    fn tools_list_is_what_crew_answers_for_the_token() {
        let (_dir, link) = linked();
        assert_eq!(
            handle(&link, "tools/list", json!({})),
            Ok(json!({ "tools": [{ "name": "echo" }], "caller": "s1" }))
        );
    }

    #[test]
    fn tools_list_with_crew_down_is_an_internal_error() {
        let (_dir, link) = crew_down();
        let (code, message) = handle(&link, "tools/list", json!({})).expect_err("crew is down");
        assert_eq!(code, -32603);
        assert!(message.starts_with("Crew is not running"), "{message}");
    }

    #[test]
    fn tools_call_relays_the_tools_result() {
        let (_dir, link) = linked();
        let params = json!({ "name": "echo", "arguments": { "x": 1 } });
        let result = handle(&link, "tools/call", params).expect("call");
        assert_eq!(result["content"][0]["text"], r#"{"x":1}"#);
        assert_eq!(result["caller"], "s1");
    }

    #[test]
    fn a_failed_tools_call_is_an_error_result_the_model_can_read() {
        let (_dir, link) = linked();
        let result = handle(&link, "tools/call", json!({ "name": "missing" })).expect("an answer");
        assert_eq!(
            result,
            json!({ "content": [{ "type": "text", "text": "tools/call broke" }], "isError": true })
        );
    }

    #[test]
    fn a_tools_call_with_crew_down_is_an_error_result() {
        let (_dir, link) = crew_down();
        let result = handle(&link, "tools/call", json!({ "name": "echo" })).expect("an answer");
        assert_eq!(result["isError"], true);
        let text = result["content"][0]["text"].as_str().unwrap_or_default();
        assert!(text.starts_with("Crew is not running"), "{result}");
    }

    #[test]
    fn a_call_is_one_line_carrying_the_token_method_and_params() {
        let (seen_tx, seen) = mpsc::channel();
        let (_dir, link) = scripted(WITHIN, move |request, mut stream| {
            seen_tx.send(request).expect("seen");
            stream.write_all(b"{\"result\":7}\n").expect("reply");
        });

        assert_eq!(link.call("tools/list", json!({ "a": 1 })), Ok(json!(7)));

        let request = seen.recv_timeout(WITHIN).expect("request");
        assert!(request.ends_with('\n'), "{request:?}");
        let request: Value = serde_json::from_str(&request).expect("json");
        assert_eq!(
            request,
            json!({ "token": "tok", "method": "tools/list", "params": { "a": 1 } })
        );
    }

    #[test]
    fn a_reply_without_a_result_is_null() {
        let (_dir, link) = scripted(WITHIN, |_, mut stream| {
            stream.write_all(b"{}\n").expect("reply")
        });
        assert_eq!(link.call("tools/list", Value::Null), Ok(Value::Null));
    }

    #[test]
    fn a_reply_that_is_not_json_is_a_bad_reply() {
        let (_dir, link) = scripted(WITHIN, |_, mut stream| {
            stream.write_all(b"<html>\n").expect("reply")
        });
        let error = link.call("tools/list", Value::Null).expect_err("bad reply");
        assert!(error.starts_with("Bad reply: "), "{error}");
    }

    #[test]
    fn crew_hanging_up_without_a_reply_is_a_bad_reply() {
        let (_dir, link) = scripted(WITHIN, |_, stream| drop(stream));
        let error = link.call("tools/list", Value::Null).expect_err("no reply");
        assert!(error.starts_with("Bad reply: "), "{error}");
    }

    #[test]
    fn crew_not_answering_in_time_is_an_error_not_a_hang() {
        let (hold, held) = mpsc::channel::<()>();
        let (_dir, link) = scripted(Duration::from_millis(50), move |_, stream| {
            let _ = held.recv();
            drop(stream);
        });

        let error = link.call("tools/call", Value::Null).expect_err("timed out");

        assert!(error.starts_with("Crew did not answer"), "{error}");
        drop(hold);
    }
}
