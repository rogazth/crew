//! `crew --mcp` and `crew call`: the agent-side ends of the bridge. Both run
//! inside the agent's process tree, not the app, so they only see the
//! environment Crew handed the agent at spawn.

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

struct Link {
    socket: String,
    /// Who this process is, as far as the daemon is concerned. Crew minted it
    /// for this session when the turn started; the session id is not sent and
    /// would not be believed.
    token: String,
}

impl Link {
    fn from_env() -> Result<Self, String> {
        let var = |key: &str| {
            std::env::var(key).map_err(|_| format!("{key} is not set; run this from an agent or a terminal session Crew started"))
        };
        Ok(Self {
            socket: var("CREW_SOCKET")?,
            token: var("CREW_TOKEN")?,
        })
    }

    /// One connection per call: a line out, a line back.
    fn call(&self, method: &str, params: Value) -> Result<Value, String> {
        let mut stream = UnixStream::connect(&self.socket)
            .map_err(|e| format!("Crew is not running ({e})"))?;
        let _ = stream.set_read_timeout(Some(call_timeout(method, &params)));
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

/// How long one call may take. A tool call whose arguments carry `timeout_s`
/// — directly, or through `call_tool`'s `arguments` — is one that waits that
/// long on purpose, so the read waits `min(timeout_s, 60) + 10` seconds; never
/// less than the default. The convention is the whole mechanism: a tool that
/// blocks names its wait `timeout_s` and caps it at 60 itself.
fn call_timeout(method: &str, params: &Value) -> Duration {
    if method != "tools/call" {
        return CALL_TIMEOUT;
    }
    let arguments = params.get("arguments");
    let asked = arguments
        .and_then(|args| args.get("timeout_s"))
        .or_else(|| arguments.and_then(|args| args.get("arguments")).and_then(|args| args.get("timeout_s")))
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
