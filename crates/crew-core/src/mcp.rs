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

struct Link {
    socket: String,
    token: String,
    session_id: String,
}

impl Link {
    fn from_env() -> Result<Self, String> {
        let var = |key: &str| {
            std::env::var(key).map_err(|_| format!("{key} is not set; run this from an agent Crew started"))
        };
        Ok(Self {
            socket: var("CREW_SOCKET")?,
            token: var("CREW_TOKEN")?,
            session_id: var("CREW_SESSION_ID")?,
        })
    }

    /// One connection per call: a line out, a line back.
    fn call(&self, method: &str, params: Value) -> Result<Value, String> {
        let mut stream = UnixStream::connect(&self.socket)
            .map_err(|e| format!("Crew is not running ({e})"))?;
        let _ = stream.set_read_timeout(Some(CALL_TIMEOUT));
        let mut line = json!({
            "token": self.token,
            "sessionId": self.session_id,
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
            Ok(json!({
                "protocolVersion": requested.unwrap_or(PROTOCOL_VERSION),
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
