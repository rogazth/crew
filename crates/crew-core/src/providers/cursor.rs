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
        "shell" | "bash" => Some(ToolDetail::Command {
            command: string_field(Some(args), "command")?,
            exit_code: success
                .and_then(|row| row.get("exitCode"))
                .and_then(Value::as_i64)
                .map(|code| code as i32),
            output: text_field(success, "interleavedOutput").or_else(|| text_field(success, "stdout")),
        }),
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

    fn obj(value: Value) -> Map<String, Value> {
        value.as_object().cloned().unwrap_or_default()
    }

    #[test]
    fn spawn_args_spell_out_each_combination() {
        let base = ["-p", "--output-format", "stream-json", "--stream-partial-output", "--trust"];
        let cases: Vec<(Autonomy, Option<&str>, Vec<&str>)> = vec![
            (Autonomy::Ask, None, vec!["hi"]),
            (Autonomy::Ask, Some(""), vec!["hi"]),
            (Autonomy::Ask, Some("gpt-5"), vec!["--model", "gpt-5", "hi"]),
            (Autonomy::Full, None, vec!["-f", "hi"]),
            (Autonomy::Full, Some(""), vec!["-f", "hi"]),
            (Autonomy::Full, Some("sonnet-4"), vec!["--model", "sonnet-4", "-f", "hi"]),
        ];
        for (autonomy, model, tail) in cases {
            let case = format!("{autonomy:?} {model:?}");
            let args = build_cursor_spawn_args(&CursorSpawn {
                prompt: "hi".into(),
                model: model.map(str::to_string),
                autonomy,
            });
            let expected: Vec<&str> = base.iter().copied().chain(tail).collect();
            assert_eq!(args, expected, "{case}");
        }
    }

    #[test]
    fn attached_files_are_listed_under_the_prompt() {
        let cases: Vec<(&str, Vec<String>, &str)> = vec![
            ("mira", vec![], "mira"),
            ("mira", vec!["/w/a.rs".into(), "/w/shot.png".into()], "mira\n\nAttached files:\n- /w/a.rs\n- /w/shot.png"),
            ("", vec!["/w/a.rs".into()], "Attached files:\n- /w/a.rs"),
        ];
        for (text, files, expected) in cases {
            assert_eq!(with_attached_files(text, &files), expected, "{text:?} {files:?}");
        }
        let prompt = build_cursor_prompt("Planner", "", None, " mira ", &["/w/a.rs".into()], None);
        assert!(prompt.ends_with("mira\n\nAttached files:\n- /w/a.rs"), "{prompt}");
    }

    #[test]
    fn assistant_text_is_its_text_blocks_joined() {
        let cases = vec![
            (json!({ "type": "assistant" }), ""),
            (json!({ "message": "hi" }), ""),
            (json!({ "message": { "content": "hi" } }), ""),
            (
                json!({ "message": { "content": [
                    { "type": "text", "text": "uno " },
                    { "type": "tool_use", "text": "not text" },
                    "loose",
                    { "type": "text" },
                    { "type": "text", "text": "dos" }
                ] } }),
                "uno dos",
            ),
        ];
        for (rec, expected) in cases {
            assert_eq!(assistant_text(&obj(rec.clone())), expected, "{rec}");
        }
    }

    /// A delta is a timestamped assistant frame; the one with a model call id
    /// repeats the whole message at the end and would print it twice.
    #[test]
    fn only_a_timestamped_partial_is_a_delta() {
        let content = json!({ "content": [{ "type": "text", "text": "hola" }] });
        let cases = vec![
            ("not an assistant frame", json!({ "type": "user", "timestamp_ms": 1, "message": content }), None),
            ("no timestamp", json!({ "type": "assistant", "message": content }), None),
            (
                "a timestamp that is a string",
                json!({ "type": "assistant", "timestamp_ms": "1", "message": content }),
                None,
            ),
            (
                "the closing full message",
                json!({ "type": "assistant", "timestamp_ms": 1, "model_call_id": "mc_1", "message": content }),
                None,
            ),
            (
                "a partial with no text",
                json!({ "type": "assistant", "timestamp_ms": 1, "message": { "content": [] } }),
                None,
            ),
            ("a partial", json!({ "type": "assistant", "timestamp_ms": 1, "message": content }), Some("hola")),
        ];
        for (name, rec, expected) in cases {
            assert_eq!(assistant_delta_text(&obj(rec)).as_deref(), expected, "{name}");
        }
    }

    #[test]
    fn a_tool_call_frame_becomes_a_row() {
        let call = |name: &str, title: &str, detail: Option<ToolDetail>, phase: ToolPhase, failed: bool| {
            Some(CursorToolCall {
                call_id: "t1".into(),
                name: name.into(),
                title: title.into(),
                detail,
                phase,
                failed,
            })
        };
        let frame = |subtype: &str, tool_call: Value| {
            json!({ "type": "tool_call", "subtype": subtype, "call_id": "t1", "tool_call": tool_call })
        };
        let cases = vec![
            ("not a tool call", json!({ "type": "assistant", "call_id": "t1" }), None),
            ("an unknown phase", json!({ "type": "tool_call", "subtype": "updated", "call_id": "t1" }), None),
            ("no phase", json!({ "type": "tool_call", "call_id": "t1" }), None),
            ("no call id", json!({ "type": "tool_call", "subtype": "started" }), None),
            (
                "no envelope",
                json!({ "type": "tool_call", "subtype": "started", "call_id": "t1" }),
                call("tool", "tool", None, ToolPhase::Started, false),
            ),
            (
                "an envelope with no tool in it",
                frame("started", json!({ "description": "x", "other": {} })),
                call("tool", "tool", None, ToolPhase::Started, false),
            ),
            (
                "a function call with its arguments as a string",
                frame("started", json!({ "function": { "name": "grep", "arguments": "{\"pattern\":\"TODO\"}" } })),
                call(
                    "grep",
                    "Grep TODO",
                    Some(ToolDetail::Search { query: "TODO".into(), matches: None }),
                    ToolPhase::Started,
                    false,
                ),
            ),
            (
                "a function call with arguments that do not parse",
                frame("started", json!({ "function": { "name": "grep", "arguments": "{\"pattern\":" } })),
                call("grep", "Grep", None, ToolPhase::Started, false),
            ),
            (
                "a function call with no name or arguments",
                frame("completed", json!({ "function": { "result": { "success": {} } } })),
                call("function", "function", None, ToolPhase::Completed, false),
            ),
            (
                "a function call whose arguments are a list",
                frame("started", json!({ "function": { "name": "ls", "arguments": ["/w"] } })),
                call("ls", "Ls", None, ToolPhase::Started, false),
            ),
            (
                "a failed read keeps no detail",
                frame("completed", json!({ "readToolCall": { "result": { "error": { "errorMessage": "gone" } } } })),
                call("Read", "Read", None, ToolPhase::Completed, true),
            ),
            (
                "a start never counts as failed",
                frame(
                    "started",
                    json!({ "readToolCall": { "args": { "path": "/w/a.rs" }, "result": { "error": {} } } }),
                ),
                call(
                    "Read",
                    "Read a.rs",
                    Some(ToolDetail::File { path: "/w/a.rs".into(), line_start: None, line_end: None, preview: None }),
                    ToolPhase::Started,
                    false,
                ),
            ),
            (
                "a tool whose body is not an object is passed over",
                frame(
                    "started",
                    json!({ "aaaToolCall": "junk", "notes": 1, "shellToolCall": { "args": { "command": "ls" } } }),
                ),
                call(
                    "Shell",
                    "ls",
                    Some(ToolDetail::Command { command: "ls".into(), exit_code: None, output: None }),
                    ToolPhase::Started,
                    false,
                ),
            ),
        ];
        for (name, rec, expected) in cases {
            assert_eq!(parse_tool_call(&obj(rec)), expected, "{name}");
        }
    }

    #[test]
    fn usage_counts_the_cache_as_input() {
        let usage = |input, output, duration| TurnUsage {
            input_tokens: input,
            output_tokens: output,
            cost_usd: None,
            duration_ms: duration,
        };
        let cases = vec![
            ("nothing", json!({ "type": "result" }), usage(None, None, None)),
            (
                "everything",
                json!({
                    "duration_ms": 1500,
                    "usage": { "inputTokens": 10, "outputTokens": 20, "cacheReadTokens": 100, "cacheWriteTokens": 5 }
                }),
                usage(Some(115), Some(20), Some(1500)),
            ),
            ("only the cache", json!({ "usage": { "cacheReadTokens": 100 } }), usage(Some(100), None, None)),
            ("a zero cache and no input", json!({ "usage": { "cacheReadTokens": 0 } }), usage(None, None, None)),
            (
                "counts that are strings",
                json!({ "usage": { "inputTokens": "1", "outputTokens": 2 } }),
                usage(None, Some(2), None),
            ),
        ];
        for (name, rec, expected) in cases {
            assert_eq!(turn_usage(&obj(rec)), expected, "{name}");
        }
    }

    #[test]
    fn a_failed_turn_says_why() {
        let cases = vec![
            (json!({ "type": "result", "subtype": "success", "result": "ok" }), None),
            (json!({ "type": "result", "result": "ok" }), None),
            (json!({ "subtype": "success", "is_error": true, "result": " Cursor exploded " }), Some("Cursor exploded")),
            (json!({ "subtype": "error" }), Some("Cursor turn failed.")),
            (json!({ "is_error": true, "result": "" }), Some("Cursor turn failed.")),
        ];
        for (rec, expected) in cases {
            assert_eq!(turn_failed(&obj(rec.clone())).as_deref(), expected, "{rec}");
        }
    }

    #[test]
    fn a_row_title_names_what_the_call_did() {
        let cases: Vec<(&str, Value, String)> = vec![
            ("Shell", json!({ "command": "npm test\nnpm run lint" }), "npm test".into()),
            ("Shell", json!({ "command": "x".repeat(80) }), format!("{}…", "x".repeat(71))),
            ("run", json!({ "cmd": "make", "path": "/w" }), "make".into()),
            ("Read", json!({ "path": "/w/src/lib.rs" }), "Read lib.rs".into()),
            ("write", json!({ "file_path": "/w/a.ts" }), "Write a.ts".into()),
            ("Edit", json!({ "target_file": "C:\\w\\b.ts" }), "Edit b.ts".into()),
            ("MultiEdit", json!({ "filePath": "/w/c.ts" }), "Edit c.ts".into()),
            ("Delete", json!({ "path": "/w/old.ts" }), "Delete old.ts".into()),
            ("Glob", json!({ "glob": "**/*.ts" }), "Glob **/*.ts".into()),
            ("Grep", json!({ "pattern": "ü".repeat(50) }), format!("Grep {}…", "ü".repeat(39))),
            ("grep", json!({ "regex": "fn\\s+main" }), "Grep fn\\s+main".into()),
            ("WebSearch", json!({ "query": "cursor agent" }), "Search cursor agent".into()),
            ("ls", json!({}), "Ls".into()),
            ("todo", json!({ "command": "  " }), "todo".into()),
        ];
        for (name, input, expected) in cases {
            assert_eq!(tool_label(name, &obj(input.clone())), expected, "{name} {input}");
        }
    }

    #[test]
    fn a_row_detail_comes_from_the_arguments_and_the_success() {
        let file = |path: &str, start: Option<u32>, end: Option<u32>, preview: Option<&str>| ToolDetail::File {
            path: path.into(),
            line_start: start,
            line_end: end,
            preview: preview.map(str::to_string),
        };
        let edit = |path: &str| ToolDetail::Edit { path: path.into(), added: None, removed: None };
        let search = |query: &str| ToolDetail::Search { query: query.into(), matches: None };
        let cases: Vec<(&str, Value, Option<Value>, Option<ToolDetail>)> = vec![
            (
                "Shell",
                json!({ "command": "ls" }),
                Some(json!({ "success": { "exitCode": 0, "stdout": "a\n", "interleavedOutput": "a\nwarn\n" } })),
                Some(ToolDetail::Command {
                    command: "ls".into(),
                    exit_code: Some(0),
                    output: Some("a\nwarn\n".into()),
                }),
            ),
            (
                "bash",
                json!({ "command": "ls" }),
                Some(json!({ "success": { "exitCode": 1, "stdout": "  a\n", "interleavedOutput": "" } })),
                Some(ToolDetail::Command { command: "ls".into(), exit_code: Some(1), output: Some("  a\n".into()) }),
            ),
            (
                "shell",
                json!({ "command": "ls" }),
                None,
                Some(ToolDetail::Command { command: "ls".into(), exit_code: None, output: None }),
            ),
            ("shell", json!({}), Some(json!({ "success": { "exitCode": 0 } })), None),
            (
                "Read",
                json!({ "path": "/w/a.rs" }),
                Some(json!({ "success": { "content": "  fn a()", "readRange": { "startLine": 3, "endLine": 9 } } })),
                Some(file("/w/a.rs", Some(3), Some(9), Some("  fn a()"))),
            ),
            (
                "read",
                json!({}),
                Some(json!({ "success": { "path": "/w/b.rs", "readRange": { "startLine": "3" } } })),
                Some(file("/w/b.rs", None, None, None)),
            ),
            ("read", json!({}), Some(json!({ "error": { "errorMessage": "gone" } })), None),
            ("Write", json!({ "path": "/w/a.rs" }), None, Some(edit("/w/a.rs"))),
            ("edit", json!({ "file_path": "/w/b.rs" }), None, Some(edit("/w/b.rs"))),
            ("MultiEdit", json!({ "target_file": "/w/c.rs" }), None, Some(edit("/w/c.rs"))),
            ("edit", json!({ "filePath": "/w/d.rs" }), None, Some(edit("/w/d.rs"))),
            ("write", json!({ "content": "x" }), None, None),
            ("Glob", json!({ "glob": "*.rs" }), None, Some(search("*.rs"))),
            ("grep", json!({ "pattern": "TODO", "query": "ignored" }), None, Some(search("TODO"))),
            ("grep", json!({ "query": "q" }), None, Some(search("q"))),
            ("grep", json!({ "regex": "r+" }), None, Some(search("r+"))),
            ("grep", json!({}), None, None),
            ("ls", json!({ "path": "/w" }), Some(json!({ "success": {} })), None),
        ];
        for (name, args, result, expected) in cases {
            let result = result.map(obj);
            assert_eq!(tool_detail(name, &obj(args.clone()), result.as_ref()), expected, "{name} {args} {result:?}");
        }
    }

    #[test]
    fn a_tool_key_is_named_after_its_prefix() {
        let cases = [
            ("shellToolCall", "Shell"),
            ("readToolCall", "Read"),
            ("mcpToolCall", "Mcp"),
            ("écrireToolCall", "Écrire"),
            ("ToolCall", "ToolCall"),
            ("grep", "Grep"),
        ];
        for (key, expected) in cases {
            assert_eq!(tool_name_from_key(key), expected, "{key}");
        }
    }

    #[test]
    fn a_payload_is_found_in_either_envelope() {
        let payload = |envelope: Option<Value>| {
            let envelope = envelope.map(obj);
            tool_payload(envelope.as_ref()).map(|p| (p.name, Value::Object(p.args), p.result.map(Value::Object)))
        };
        let cases = vec![
            ("no envelope", None, None),
            ("an empty envelope", Some(json!({})), None),
            ("only junk", Some(json!({ "readToolCall": 3, "notes": {} })), None),
            (
                "a function with object arguments",
                Some(json!({
                    "function": { "name": "read", "arguments": { "path": "/a" }, "result": { "success": {} } }
                })),
                Some(("read".to_string(), json!({ "path": "/a" }), Some(json!({ "success": {} })))),
            ),
            (
                "a function with no arguments",
                Some(json!({ "function": { "name": "read" } })),
                Some(("read".to_string(), json!({}), None)),
            ),
            (
                "a keyed tool",
                Some(json!({ "grepToolCall": { "args": { "pattern": "x" }, "result": "not an object" } })),
                Some(("Grep".to_string(), json!({ "pattern": "x" }), None)),
            ),
        ];
        for (name, envelope, expected) in cases {
            assert_eq!(payload(envelope), expected, "{name}");
        }
    }

    #[test]
    fn a_call_failed_when_its_result_says_so() {
        let cases = vec![
            (None, false),
            (Some(json!({})), false),
            (Some(json!({ "error": null })), false),
            (Some(json!({ "error": { "errorMessage": "x" } })), true),
            (Some(json!({ "spawnError": "ENOENT" })), true),
            (Some(json!({ "rejected": {} })), true),
            (Some(json!({ "denied": { "reason": "policy" } })), true),
            (Some(json!({ "rejected": null, "denied": null, "spawnError": null })), false),
            (Some(json!({ "success": { "exitCode": 0 } })), false),
            (Some(json!({ "success": { "exitCode": 2 } })), true),
            (Some(json!({ "success": { "exitCode": "2" } })), false),
            (Some(json!({ "success": {} })), false),
            (Some(json!({ "success": "yes" })), false),
        ];
        for (result, expected) in cases {
            let rec = result.clone().map(obj);
            assert_eq!(tool_failed(rec.as_ref()), expected, "{result:?}");
            if rec.is_some() {
                assert_eq!(tool_status(expected), if expected { ToolStatus::Failed } else { ToolStatus::Completed });
            }
        }
    }

    #[test]
    fn a_tool_name_is_shown_the_way_the_chat_spells_it() {
        let cases = [
            ("bash", "Bash"),
            ("SHELL", "Shell"),
            ("read", "Read"),
            ("Write", "Write"),
            ("edit", "Edit"),
            ("MultiEdit", "Edit"),
            ("delete", "Delete"),
            ("glob", "Glob"),
            ("Grep", "Grep"),
            ("LS", "Ls"),
            ("webSearch", "Search"),
            ("mcp_websearch_brave", "Search"),
            ("Todo", "Todo"),
            ("", ""),
        ];
        for (name, expected) in cases {
            assert_eq!(pretty_tool(name), expected, "pretty_tool({name:?})");
        }
    }
}
