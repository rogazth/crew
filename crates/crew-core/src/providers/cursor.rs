use crew_protocol::{ToolDetail, ToolStatus, TurnUsage};
use serde_json::{Map, Value};

use super::runtime::Autonomy;
use super::{as_record, as_record_owned, clip, finite_number, leaf, string_field, try_parse_json_record};

pub use super::parse_json_line;

pub struct CursorSpawn {
    pub prompt: String,
    pub model: Option<String>,
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

pub use super::persona_prompt;

/// `cursor-agent -p` takes the whole prompt as one argument, so the turn is one
/// document: persona, the tail of the conversation, then what is being asked.
pub fn build_cursor_prompt(
    name: &str,
    description: &str,
    history: Option<&str>,
    text: &str,
    files: &[String],
    tools: Option<&str>,
) -> String {
    super::assemble(
        persona_prompt(name, description, tools),
        history,
        &with_attached_files(text.trim(), files),
    )
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

#[derive(Clone, Debug, PartialEq)]
pub struct CursorToolCall {
    pub call_id: String,
    pub name: String,
    pub title: String,
    pub detail: Option<ToolDetail>,
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
    let result = payload.as_ref().and_then(|p| p.result.as_ref());
    let failed = phase == ToolPhase::Completed && tool_failed(result);
    Some(CursorToolCall {
        call_id,
        title: tool_label(&name, &args),
        detail: tool_detail(&name, &args, result),
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
    let path = path_argument(input);
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

/// A failed call answers with an error instead of `success` and repeats none of
/// its arguments, so it yields `None` and the row keeps what it already showed.
fn tool_detail(
    name: &str,
    args: &Map<String, Value>,
    result: Option<&Map<String, Value>>,
) -> Option<ToolDetail> {
    let success = result.and_then(|row| row.get("success")).and_then(as_record);
    match name.to_ascii_lowercase().as_str() {
        "shell" | "bash" => {
            let command = string_field(Some(args), "command")?;
            let exit_code = success
                .and_then(|row| row.get("exitCode"))
                .and_then(Value::as_i64)
                .map(|code| code as i32);
            if exit_code.is_none_or(|code| code == 0) {
                if let Some(message) = bridge_message(&command) {
                    return Some(message);
                }
            }
            Some(ToolDetail::Command {
                command,
                exit_code,
                output: text_field(success, "interleavedOutput").or_else(|| text_field(success, "stdout")),
            })
        }
        "read" => {
            let range = success.and_then(|row| row.get("readRange")).and_then(as_record);
            Some(ToolDetail::File {
                path: string_field(Some(args), "path").or_else(|| string_field(success, "path"))?,
                line_start: line_number(range, "startLine"),
                line_end: line_number(range, "endLine"),
                preview: text_field(success, "content"),
            })
        }
        // Cursor names no before/after text on a write, so the counts stay 0.
        "write" | "edit" | "multiedit" => Some(ToolDetail::Edit {
            path: path_argument(args)?,
            added: None,
            removed: None,
        }),
        "glob" | "grep" => Some(ToolDetail::Search {
            query: string_field(Some(args), "pattern")
                .or_else(|| string_field(Some(args), "glob"))
                .or_else(|| string_field(Some(args), "query"))
                .or_else(|| string_field(Some(args), "regex"))?,
            matches: None,
        }),
        _ => None,
    }
}

/// Cursor reaches Crew's tools through the shell (`crew call message_agent
/// '<json>'`), so a message to another agent arrives as a command. Read back as
/// the message it is, it shows who it went to and what it said, as it does for
/// the providers that call the tool by name.
fn bridge_message(command: &str) -> Option<ToolDetail> {
    const CALL: &str = " call message_agent '";
    let start = command.find(CALL)? + CALL.len();
    let args = single_quoted(&command[start..])?;
    super::crew_tool_detail("crew.message_agent", &try_parse_json_record(&args)?)
}

/// The body of a shell single-quoted word, up to its closing quote. A quote
/// inside is written `'\''`: close, escaped quote, reopen.
fn single_quoted(rest: &str) -> Option<String> {
    let mut out = String::new();
    let mut tail = rest;
    loop {
        let end = tail.find('\'')?;
        out.push_str(&tail[..end]);
        tail = &tail[end + 1..];
        match tail.strip_prefix("\\''") {
            Some(reopened) => {
                out.push('\'');
                tail = reopened;
            }
            None => return Some(out),
        }
    }
}

fn path_argument(args: &Map<String, Value>) -> Option<String> {
    string_field(Some(args), "path")
        .or_else(|| string_field(Some(args), "file_path"))
        .or_else(|| string_field(Some(args), "target_file"))
        .or_else(|| string_field(Some(args), "filePath"))
}

/// Output and file excerpts keep their whitespace: `string_field` trims, and a
/// preview that starts mid-indentation would lose its shape.
fn text_field(rec: Option<&Map<String, Value>>, key: &str) -> Option<String> {
    rec?.get(key)
        .and_then(Value::as_str)
        .filter(|text| !text.is_empty())
        .map(str::to_string)
}

fn line_number(rec: Option<&Map<String, Value>>, key: &str) -> Option<u32> {
    rec?.get(key).and_then(Value::as_u64).map(|line| line as u32)
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
    use crew_protocol::{HarnessEvent, ToolDetail, ToolStatus};
    use serde_json::json;

    fn events(line: &Value) -> Vec<HarnessEvent> {
        let host = TurnHost::test_new();
        let cap = host.test_capture();
        host.test_install_cursor("s");
        host.handle_cursor_line("s", &line.to_string());
        cap.take()
    }

    fn detail(line: &Value) -> Option<ToolDetail> {
        events(line).into_iter().find_map(|event| match event {
            HarnessEvent::ToolUpdated { detail, .. } | HarnessEvent::ToolStarted { detail, .. } => detail,
            _ => None,
        })
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
                detail: Some(ToolDetail::Command {
                    command: "ls".into(),
                    exit_code: None,
                    output: None,
                }),
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
                    detail: Some(ToolDetail::File {
                        path: "/tmp/a.ts".into(),
                        line_start: None,
                        line_end: None,
                        preview: None,
                    }),
                },
                HarnessEvent::ToolUpdated {
                    call_id: "t1".into(),
                    title: None,
                    status: Some(ToolStatus::Completed),
                    detail: Some(ToolDetail::File {
                        path: "/tmp/a.ts".into(),
                        line_start: None,
                        line_end: None,
                        preview: None,
                    }),
                },
            ]
        );
    }

    /// The shell call of `crates/crew-core/tests/fixtures/protocols/cursor.jsonl`, with the exit code
    /// turned non-zero.
    #[test]
    fn a_failed_shell_call_carries_its_exit_code_and_output() {
        let got = events(&json!({
            "type": "tool_call",
            "subtype": "completed",
            "call_id": "t9",
            "tool_call": {
                "shellToolCall": {
                    "args": { "command": "echo hello-from-cursor", "workingDirectory": "", "timeout": 30000 },
                    "result": {
                        "success": {
                            "command": "echo hello-from-cursor",
                            "exitCode": 2,
                            "stdout": "",
                            "stderr": "boom\n",
                            "interleavedOutput": "boom\n"
                        }
                    }
                }
            }
        }));
        assert_eq!(
            got.last(),
            Some(&HarnessEvent::ToolUpdated {
                call_id: "t9".into(),
                title: None,
                status: Some(ToolStatus::Failed),
                detail: Some(ToolDetail::Command {
                    command: "echo hello-from-cursor".into(),
                    exit_code: Some(2),
                    output: Some("boom\n".into()),
                }),
            })
        );
    }

    /// The read of `crates/crew-core/tests/fixtures/protocols/cursor.jsonl`: `limit: 3` on the way in, a
    /// `readRange` on the way back.
    #[test]
    fn a_read_carries_the_window_it_returned() {
        assert_eq!(
            detail(&json!({
                "type": "tool_call",
                "subtype": "completed",
                "call_id": "t8",
                "tool_call": {
                    "readToolCall": {
                        "args": { "path": "/w/package.json", "limit": 3 },
                        "result": {
                            "success": {
                                "content": "{\n  \"name\": \"crew\",\n  \"private\": true,",
                                "totalLines": 64,
                                "path": "/w/package.json",
                                "readRange": { "startLine": 1, "endLine": 3 }
                            }
                        }
                    }
                }
            })),
            Some(ToolDetail::File {
                path: "/w/package.json".into(),
                line_start: Some(1),
                line_end: Some(3),
                preview: Some("{\n  \"name\": \"crew\",\n  \"private\": true,".into()),
            })
        );
    }

    /// The failed read of `crates/crew-core/tests/fixtures/protocols/cursor.jsonl`: an error result repeats
    /// no arguments, so the row keeps the detail it already had.
    #[test]
    fn a_bridge_call_to_message_an_agent_reads_as_the_message() {
        let args = |command: &str| {
            let mut map = Map::new();
            map.insert("command".into(), Value::String(command.into()));
            map
        };
        let ok = serde_json::json!({ "success": { "exitCode": 0 } });
        let ok = ok.as_object();
        let sent = r#"/bin/crewd call message_agent '{"to":"abc","text":"it'\''s green"}' 2>/dev/null || true"#;
        match tool_detail("shell", &args(sent), ok) {
            Some(ToolDetail::Message { to, text }) => {
                assert_eq!(to, "abc");
                assert_eq!(text, "it's green");
            }
            other => panic!("expected a message, got {other:?}"),
        }
        // Wrong arguments, a failed call, or another tool stay the command they were.
        let wrong = r#"crewd call message_agent '{"id":"abc","message":"hi"}'"#;
        assert!(matches!(tool_detail("shell", &args(wrong), ok), Some(ToolDetail::Command { .. })));
        let failed = serde_json::json!({ "success": { "exitCode": 1 } });
        assert!(matches!(tool_detail("shell", &args(sent), failed.as_object()), Some(ToolDetail::Command { .. })));
        let listed = "crewd call list_agents '{}'";
        assert!(matches!(tool_detail("shell", &args(listed), ok), Some(ToolDetail::Command { .. })));
    }

    #[test]
    fn a_failed_call_adds_no_detail() {
        assert_eq!(
            detail(&json!({
                "type": "tool_call",
                "subtype": "completed",
                "call_id": "t7",
                "tool_call": {
                    "readToolCall": {
                        "result": { "error": { "errorMessage": "Service temporarily unavailable." } }
                    }
                }
            })),
            None
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
