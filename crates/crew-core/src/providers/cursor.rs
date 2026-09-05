use crew_protocol::{ToolStatus, TurnUsage};
use serde_json::{Map, Value};

use super::runtime::Autonomy;
use super::{as_record, as_record_owned, clip, finite_number, leaf, string_field, try_parse_json_record};

pub use super::parse_json_line;

pub struct CursorSpawn {
    pub prompt: String,
    pub model: Option<String>,
    pub resume: Option<String>,
    pub autonomy: Autonomy,
}

pub fn build_cursor_spawn_args(input: &CursorSpawn) -> Vec<String> {
    let mut args = vec![
        "-p".into(),
        "--output-format".into(),
        "stream-json".into(),
        "--stream-partial-output".into(),
        "--trust".into(),
    ];
    if let Some(model) = input.model.as_deref().filter(|m| !m.is_empty()) {
        args.push("--model".into());
        args.push(model.into());
    }
    if let Some(resume) = input.resume.as_deref().filter(|r| !r.is_empty()) {
        args.push("--resume".into());
        args.push(resume.into());
    }
    if input.autonomy == Autonomy::Full {
        args.push("-f".into());
    }
    args.push(input.prompt.clone());
    args
}

pub fn with_attached_files(text: &str, files: &[String]) -> String {
    if files.is_empty() {
        return text.to_string();
    }
    let list = files
        .iter()
        .map(|path| format!("- {path}"))
        .collect::<Vec<_>>()
        .join("\n");
    let note = format!("Attached files:\n{list}");
    if text.is_empty() {
        note
    } else {
        format!("{text}\n\n{note}")
    }
}

pub fn persona_prompt(name: &str, description: &str, tools: Option<&str>) -> String {
    let who = {
        let trimmed = name.trim();
        if trimmed.is_empty() {
            "the user's agent"
        } else {
            trimmed
        }
    };
    let job = description.trim();
    let rules = "You are chatting inside Crew, a desktop app. Do the work with your tools, then reply like a colleague in chat: short, direct, no headers or preamble unless asked.";
    let persona = if job.is_empty() {
        format!("You are {who}. {rules}")
    } else {
        format!("You are {who}. {job}\n\n{rules}")
    };
    match tools {
        Some(tools) if !tools.is_empty() => format!("{persona}\n\n{tools}"),
        _ => persona,
    }
}

pub fn with_persona(body: &str, persona: Option<&str>) -> String {
    match persona.filter(|p| !p.is_empty()) {
        None => body.to_string(),
        Some(persona) if body.is_empty() => persona.to_string(),
        Some(persona) => format!("{persona}\n\n{body}"),
    }
}

pub fn session_id_from_event(rec: &Map<String, Value>) -> Option<String> {
    string_field(Some(rec), "session_id")
}

pub fn assistant_text(rec: &Map<String, Value>) -> String {
    let Some(content) = rec
        .get("message")
        .and_then(as_record)
        .and_then(|msg| msg.get("content"))
        .and_then(Value::as_array)
    else {
        return String::new();
    };
    content
        .iter()
        .filter_map(|block| {
            let row = as_record(block)?;
            if string_field(Some(row), "type").as_deref() == Some("text") {
                row.get("text").and_then(Value::as_str).map(str::to_string)
            } else {
                None
            }
        })
        .collect::<Vec<_>>()
        .join("")
}

pub fn assistant_delta_text(rec: &Map<String, Value>) -> Option<String> {
    if string_field(Some(rec), "type").as_deref() != Some("assistant") {
        return None;
    }
    if !rec.get("timestamp_ms").is_some_and(Value::is_number) {
        return None;
    }
    if string_field(Some(rec), "model_call_id").is_some() {
        return None;
    }
    let text = assistant_text(rec);
    if text.is_empty() {
        None
    } else {
        Some(text)
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct CursorToolCall {
    pub call_id: String,
    pub name: String,
    pub title: String,
    pub phase: ToolPhase,
    pub failed: bool,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum ToolPhase {
    Started,
    Completed,
}

pub fn parse_tool_call(rec: &Map<String, Value>) -> Option<CursorToolCall> {
    if string_field(Some(rec), "type").as_deref() != Some("tool_call") {
        return None;
    }
    let phase = match string_field(Some(rec), "subtype").as_deref() {
        Some("completed") => ToolPhase::Completed,
        Some("started") => ToolPhase::Started,
        _ => return None,
    };
    let call_id = string_field(Some(rec), "call_id")?;
    let payload = tool_payload(rec.get("tool_call").and_then(as_record));
    let name = payload
        .as_ref()
        .map(|p| p.name.clone())
        .unwrap_or_else(|| "tool".into());
    let args = payload
        .as_ref()
        .map(|p| p.args.clone())
        .unwrap_or_default();
    let failed = phase == ToolPhase::Completed
        && tool_failed(payload.as_ref().and_then(|p| p.result.as_ref()));
    Some(CursorToolCall {
        call_id,
        title: tool_label(&name, &args),
        name,
        phase,
        failed,
    })
}

pub fn turn_usage(rec: &Map<String, Value>) -> TurnUsage {
    let usage = rec.get("usage").and_then(as_record);
    let cached = finite_number(usage.and_then(|u| u.get("cacheReadTokens"))).unwrap_or(0.0)
        + finite_number(usage.and_then(|u| u.get("cacheWriteTokens"))).unwrap_or(0.0);
    let input = finite_number(usage.and_then(|u| u.get("inputTokens")));
    let output = finite_number(usage.and_then(|u| u.get("outputTokens")));
    let duration = finite_number(rec.get("duration_ms"));
    TurnUsage {
        input_tokens: match input {
            Some(n) => Some((n + cached) as u64),
            None if cached != 0.0 => Some(cached as u64),
            None => None,
        },
        output_tokens: output.map(|n| n as u64),
        cost_usd: None,
        duration_ms: duration.map(|n| n as u64),
    }
}

pub fn turn_failed(rec: &Map<String, Value>) -> Option<String> {
    let subtype = string_field(Some(rec), "subtype");
    let failed = rec.get("is_error") == Some(&Value::Bool(true))
        || subtype.as_deref().is_some_and(|s| s != "success");
    if !failed {
        return None;
    }
    Some(string_field(Some(rec), "result").unwrap_or_else(|| "Cursor turn failed.".into()))
}

pub fn tool_label(name: &str, input: &Map<String, Value>) -> String {
    let command = string_field(Some(input), "command").or_else(|| string_field(Some(input), "cmd"));
    let path = string_field(Some(input), "path")
        .or_else(|| string_field(Some(input), "file_path"))
        .or_else(|| string_field(Some(input), "target_file"))
        .or_else(|| string_field(Some(input), "filePath"));
    let query = string_field(Some(input), "pattern")
        .or_else(|| string_field(Some(input), "glob"))
        .or_else(|| string_field(Some(input), "query"))
        .or_else(|| string_field(Some(input), "regex"));
    if let Some(command) = command {
        return clip(&command, 72);
    }
    let verb = pretty_tool(name);
    if let Some(path) = path {
        return format!("{verb} {}", leaf(&path));
    }
    if let Some(query) = query {
        return format!("{verb} {}", clip(&query, 40));
    }
    verb
}

pub fn tool_status(failed: bool) -> ToolStatus {
    if failed {
        ToolStatus::Failed
    } else {
        ToolStatus::Completed
    }
}

struct ToolPayload {
    name: String,
    args: Map<String, Value>,
    result: Option<Map<String, Value>>,
}

fn tool_payload(envelope: Option<&Map<String, Value>>) -> Option<ToolPayload> {
    let envelope = envelope?;
    if let Some(fn_body) = envelope.get("function").and_then(as_record) {
        let name = string_field(Some(fn_body), "name").unwrap_or_else(|| "function".into());
        let parsed_args = match fn_body.get("arguments") {
            Some(Value::String(raw)) => try_parse_json_record(raw),
            Some(other) => as_record_owned(other),
            None => None,
        };
        return Some(ToolPayload {
            name,
            args: parsed_args.unwrap_or_default(),
            result: fn_body.get("result").and_then(as_record_owned),
        });
    }
    for (key, value) in envelope {
        if !key.ends_with("ToolCall") {
            continue;
        }
        let Some(body) = as_record(value) else {
            continue;
        };
        return Some(ToolPayload {
            name: tool_name_from_key(key),
            args: body.get("args").and_then(as_record_owned).unwrap_or_default(),
            result: body.get("result").and_then(as_record_owned),
        });
    }
    None
}

fn tool_name_from_key(key: &str) -> String {
    let base = key.strip_suffix("ToolCall").unwrap_or(key);
    if base.is_empty() {
        return key.to_string();
    }
    let mut chars = base.chars();
    match chars.next() {
        Some(first) => first.to_uppercase().collect::<String>() + chars.as_str(),
        None => key.to_string(),
    }
}

fn tool_failed(result: Option<&Map<String, Value>>) -> bool {
    let Some(result) = result else {
        return false;
    };
    if result.get("error").is_some_and(|v| !v.is_null()) || result.get("spawnError").is_some_and(|v| !v.is_null())
    {
        return true;
    }
    if result.get("rejected").is_some_and(|v| !v.is_null()) || result.get("denied").is_some_and(|v| !v.is_null()) {
        return true;
    }
    result
        .get("success")
        .and_then(as_record)
        .and_then(|success| success.get("exitCode"))
        .and_then(Value::as_i64)
        .is_some_and(|code| code != 0)
}

fn pretty_tool(name: &str) -> String {
    if name.eq_ignore_ascii_case("bash") {
        return "Bash".into();
    }
    if name.eq_ignore_ascii_case("shell") {
        return "Shell".into();
    }
    if name.eq_ignore_ascii_case("read") {
        return "Read".into();
    }
    if name.eq_ignore_ascii_case("write") {
        return "Write".into();
    }
    if name.eq_ignore_ascii_case("edit") || name.eq_ignore_ascii_case("multiedit") {
        return "Edit".into();
    }
    if name.eq_ignore_ascii_case("delete") {
        return "Delete".into();
    }
    if name.eq_ignore_ascii_case("glob") {
        return "Glob".into();
    }
    if name.eq_ignore_ascii_case("grep") {
        return "Grep".into();
    }
    if name.eq_ignore_ascii_case("ls") {
        return "Ls".into();
    }
    if name.to_ascii_lowercase().contains("websearch") {
        return "Search".into();
    }
    name.to_string()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::turns::TurnHost;
    use crew_protocol::{HarnessEvent, ToolStatus};
    use serde_json::json;

    fn events(line: &Value) -> Vec<HarnessEvent> {
        let host = TurnHost::test_new();
        let cap = host.test_capture();
        host.test_install_cursor("s");
        host.handle_cursor_line("s", &line.to_string());
        cap.take()
    }

    #[test]
    fn assistant_delta_emits_message_delta() {
        let got = events(&json!({
            "type": "assistant",
            "timestamp_ms": 1,
            "message": { "content": [{ "type": "text", "text": "hello" }] }
        }));
        assert_eq!(got, vec![HarnessEvent::MessageDelta { text: "hello".into() }]);
    }

    #[test]
    fn tool_call_started_emits_tool_started() {
        let got = events(&json!({
            "type": "tool_call",
            "subtype": "started",
            "call_id": "t1",
            "tool_call": { "shellToolCall": { "args": { "command": "ls" } } }
        }));
        assert_eq!(
            got,
            vec![HarnessEvent::ToolStarted {
                call_id: "t1".into(),
                name: "Shell".into(),
                title: "ls".into(),
            }]
        );
    }

    #[test]
    fn tool_call_completed_marks_the_tool_done() {
        let got = events(&json!({
            "type": "tool_call",
            "subtype": "completed",
            "call_id": "t1",
            "tool_call": {
                "function": {
                    "name": "read",
                    "arguments": { "path": "/tmp/a.ts" },
                    "result": { "success": { "exitCode": 0 } }
                }
            }
        }));
        assert_eq!(
            got,
            vec![
                HarnessEvent::ToolStarted {
                    call_id: "t1".into(),
                    name: "read".into(),
                    title: "Read a.ts".into(),
                },
                HarnessEvent::ToolUpdated {
                    call_id: "t1".into(),
                    title: None,
                    status: Some(ToolStatus::Completed),
                },
            ]
        );
    }

    #[test]
    fn result_is_error_settles_the_turn() {
        let got = events(&json!({
            "type": "result",
            "is_error": true,
            "result": "Cursor exploded",
            "usage": { "inputTokens": 1, "outputTokens": 2 }
        }));
        assert!(
            !got.iter()
                .any(|event| matches!(event, HarnessEvent::SessionError { .. }))
        );
        assert!(matches!(got.last(), Some(HarnessEvent::TurnCompleted { .. })));
    }

    #[test]
    fn session_id_binds_the_provider_session() {
        let got = events(&json!({
            "type": "assistant",
            "timestamp_ms": 1,
            "session_id": "chat_9",
            "message": { "content": [{ "type": "text", "text": "ok" }] }
        }));
        assert_eq!(
            got.first(),
            Some(&HarnessEvent::SessionProviderBound {
                provider_session_id: "chat_9".into(),
            })
        );
    }
}
