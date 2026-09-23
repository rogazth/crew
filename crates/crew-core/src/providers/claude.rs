use std::collections::HashMap;

use crew_protocol::{ApprovalDecision, Question, QuestionOption, ToolDetail, TurnUsage};
use serde_json::{json, Map, Value};

use super::runtime::{Autonomy, InlineImage};
use super::{as_record, as_record_owned, clip, finite_number, leaf, string_field};

pub use super::{parse_json_line, try_parse_json_record};

#[derive(Clone, Debug, PartialEq)]
pub struct ClaudeSpawn {
    pub model: Option<String>,
    pub session_id: Option<String>,
    pub system_prompt: Option<String>,
    pub autonomy: Autonomy,
    pub mcp_config: Option<String>,
}

pub fn build_claude_spawn_args(input: &ClaudeSpawn) -> Vec<String> {
    let mut args = vec![
        "--output-format".into(),
        "stream-json".into(),
        "--verbose".into(),
        "--input-format".into(),
        "stream-json".into(),
        "--include-partial-messages".into(),
        // Only the workspace's own settings: the persona and Crew's rules are the
        // agent's whole configuration, and ~/.claude would inject a competing one.
        "--setting-sources=project,local".into(),
        "--settings".into(),
        json!({ "autoMemoryEnabled": false }).to_string(),
    ];
    if input.autonomy == Autonomy::Full {
        args.push("--dangerously-skip-permissions".into());
    } else {
        args.push("--permission-prompt-tool".into());
        args.push("stdio".into());
    }
    if let Some(model) = input.model.as_deref().filter(|m| !m.is_empty()) {
        args.push("--model".into());
        args.push(model.into());
    }
    if let Some(prompt) = input.system_prompt.as_deref().filter(|p| !p.is_empty()) {
        args.push("--append-system-prompt".into());
        args.push(prompt.into());
    }
    if let Some(session_id) = input.session_id.as_deref().filter(|s| !s.is_empty()) {
        args.push("--session-id".into());
        args.push(session_id.into());
    }
    if let Some(mcp) = input.mcp_config.as_deref().filter(|c| !c.is_empty()) {
        args.push("--mcp-config".into());
        args.push(mcp.into());
    }
    args
}

pub use super::persona_prompt;

/// Claude takes its system prompt on argv and the turn on stdin, so the tail of
/// the conversation rides in the user message, above what is being asked now.
pub fn build_claude_user_message(
    session_id: &str,
    history: Option<&str>,
    text: &str,
    files: &[String],
    images: &[InlineImage],
) -> Value {
    let body = super::assemble(String::new(), history, &with_attached_paths(text.trim(), files));
    let mut content: Vec<Value> = images
        .iter()
        .map(|image| {
            json!({
                "type": "image",
                "source": {
                    "type": "base64",
                    "media_type": image.media_type,
                    "data": image.data,
                }
            })
        })
        .collect();
    if !body.is_empty() || content.is_empty() {
        content.push(json!({ "type": "text", "text": body }));
    }
    json!({
        "type": "user",
        "session_id": session_id,
        "parent_tool_use_id": Value::Null,
        "message": { "role": "user", "content": content },
    })
}

fn with_attached_paths(text: &str, files: &[String]) -> String {
    if files.is_empty() {
        return text.to_string();
    }
    let list = files
        .iter()
        .map(|path| format!("- {path}"))
        .collect::<Vec<_>>()
        .join("\n");
    let note = format!("Attached files. Read them if you need their contents:\n{list}");
    if text.is_empty() {
        note
    } else {
        format!("{text}\n\n{note}")
    }
}

pub fn build_control_request(request_id: &str, request: Value) -> Value {
    json!({
        "type": "control_request",
        "request_id": request_id,
        "request": request,
    })
}

pub fn build_control_response(request_id: &str, response: Value) -> Value {
    json!({
        "type": "control_response",
        "response": {
            "subtype": "success",
            "request_id": request_id,
            "response": response,
        },
    })
}

pub fn to_permission_result(decision: ApprovalDecision, input: &Map<String, Value>, tool_name: &str) -> Value {
    match decision {
        ApprovalDecision::Deny => json!({
            "behavior": "deny",
            "message": "User declined tool execution.",
        }),
        ApprovalDecision::Allow => json!({
            "behavior": "allow",
            "updatedInput": Value::Object(input.clone()),
        }),
        ApprovalDecision::Always => json!({
            "behavior": "allow",
            "updatedInput": Value::Object(input.clone()),
            "updatedPermissions": [always_allow_rule(tool_name, input)],
        }),
    }
}

pub fn always_allow_rule(tool_name: &str, input: &Map<String, Value>) -> Value {
    let command = if tool_name.eq_ignore_ascii_case("bash") {
        string_field(Some(input), "command")
    } else {
        None
    };
    let program = command
        .as_deref()
        .map(str::trim)
        .and_then(|cmd| cmd.split_whitespace().next())
        .map(str::to_string);
    let rule = if let Some(program) = program {
        json!({ "toolName": tool_name, "ruleContent": format!("{program}:*") })
    } else {
        json!({ "toolName": tool_name })
    };
    json!({
        "type": "addRules",
        "rules": [rule],
        "behavior": "allow",
        "destination": "session",
    })
}

pub fn parse_questions(input: &Map<String, Value>) -> Vec<Question> {
    let Some(Value::Array(items)) = input.get("questions") else {
        return Vec::new();
    };
    items
        .iter()
        .flat_map(|item| {
            let row = as_record(item)?;
            let question = string_field(Some(row), "question")?;
            let Value::Array(raw_options) = row.get("options")? else {
                return None;
            };
            let options: Vec<QuestionOption> = raw_options
                .iter()
                .filter_map(|option| {
                    let opt = as_record(option)?;
                    let label = string_field(Some(opt), "label")?;
                    let description = string_field(Some(opt), "description")
                        .filter(|desc| desc != &label);
                    Some(QuestionOption { label, description })
                })
                .collect();
            if options.is_empty() {
                return None;
            }
            Some(Question {
                header: string_field(Some(row), "header").unwrap_or_else(|| question.clone()),
                question,
                multi_select: row.get("multiSelect") == Some(&Value::Bool(true)),
                options,
            })
        })
        .collect()
}

pub fn to_question_result(input: &Map<String, Value>, answers: Option<&HashMap<String, String>>) -> Value {
    match answers {
        None => json!({
            "behavior": "deny",
            "message": "User dismissed the question.",
        }),
        Some(answers) => {
            let mut updated = input.clone();
            updated.insert(
                "answers".into(),
                Value::Object(
                    answers
                        .iter()
                        .map(|(k, v)| (k.clone(), Value::String(v.clone())))
                        .collect(),
                ),
            );
            json!({
                "behavior": "allow",
                "updatedInput": Value::Object(updated),
            })
        }
    }
}

#[derive(Clone, Debug, PartialEq)]
pub struct ClaudeControlRequest {
    pub request_id: String,
    pub subtype: String,
    pub tool_name: Option<String>,
    pub input: Map<String, Value>,
    pub tool_use_id: Option<String>,
}

pub fn parse_control_request(rec: &Map<String, Value>) -> Option<ClaudeControlRequest> {
    let type_name = string_field(Some(rec), "type")?;
    if type_name != "control_request" && type_name != "sdk_control_request" {
        return None;
    }
    let nested = rec.get("request").and_then(as_record);
    let request_id = string_field(Some(rec), "request_id")
        .or_else(|| string_field(nested, "request_id"))
        .filter(|id| !id.is_empty())?;
    let subtype = string_field(nested, "subtype")
        .or_else(|| string_field(Some(rec), "subtype"))
        .filter(|id| !id.is_empty())?;
    let tool_name = string_field(nested, "tool_name").or_else(|| string_field(Some(rec), "tool_name"));
    let tool_use_id = string_field(nested, "tool_use_id").or_else(|| string_field(Some(rec), "tool_use_id"));
    let input = nested
        .and_then(|row| row.get("input"))
        .and_then(as_record_owned)
        .or_else(|| nested.and_then(|row| row.get("tool_input")).and_then(as_record_owned))
        .or_else(|| rec.get("input").and_then(as_record_owned))
        .unwrap_or_default();
    Some(ClaudeControlRequest {
        request_id,
        subtype,
        tool_name,
        input,
        tool_use_id,
    })
}

pub fn parse_control_cancel_id(rec: &Map<String, Value>) -> Option<String> {
    let type_name = string_field(Some(rec), "type")?;
    if type_name != "control_cancel_request" && type_name != "sdk_control_cancel_request" {
        return None;
    }
    string_field(Some(rec), "request_id")
        .or_else(|| string_field(rec.get("request").and_then(as_record), "request_id"))
}

pub fn session_id_from_message(rec: &Map<String, Value>) -> Option<String> {
    let subtype = string_field(Some(rec), "subtype");
    if string_field(Some(rec), "type").as_deref() == Some("system")
        && subtype.as_deref().is_some_and(|s| s.starts_with("hook_"))
    {
        return None;
    }
    string_field(Some(rec), "session_id")
}

pub fn stream_text_delta(rec: &Map<String, Value>) -> Option<String> {
    let event = rec.get("event").and_then(as_record)?;
    if string_field(Some(event), "type").as_deref() != Some("content_block_delta") {
        return None;
    }
    let delta = event.get("delta").and_then(as_record)?;
    if string_field(Some(delta), "type").as_deref() != Some("text_delta") {
        return None;
    }
    delta
        .get("text")
        .and_then(Value::as_str)
        .filter(|text| !text.is_empty())
        .map(str::to_string)
}

#[derive(Clone, Debug, PartialEq)]
pub struct ToolStart {
    pub index: i64,
    pub id: String,
    pub name: String,
    pub input: Map<String, Value>,
}

pub fn tool_start_from_event(rec: &Map<String, Value>) -> Option<ToolStart> {
    let event = rec.get("event").and_then(as_record)?;
    if string_field(Some(event), "type").as_deref() != Some("content_block_start") {
        return None;
    }
    let block = event.get("content_block").and_then(as_record)?;
    let kind = string_field(Some(block), "type").unwrap_or_default();
    if kind != "tool_use" && kind != "server_tool_use" && kind != "mcp_tool_use" {
        return None;
    }
    let id = string_field(Some(block), "id")?;
    let name = string_field(Some(block), "name")?;
    Some(ToolStart {
        index: event.get("index").and_then(Value::as_i64).unwrap_or(-1),
        id,
        name,
        input: block.get("input").and_then(as_record_owned).unwrap_or_default(),
    })
}

pub fn input_json_delta_from_event(rec: &Map<String, Value>) -> Option<(i64, String)> {
    let event = rec.get("event").and_then(as_record)?;
    if string_field(Some(event), "type").as_deref() != Some("content_block_delta") {
        return None;
    }
    let delta = event.get("delta").and_then(as_record)?;
    if string_field(Some(delta), "type").as_deref() != Some("input_json_delta") {
        return None;
    }
    let partial = delta
        .get("partial_json")
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_string();
    if partial.is_empty() {
        return None;
    }
    Some((
        event.get("index").and_then(Value::as_i64).unwrap_or(-1),
        partial,
    ))
}

pub fn is_subagent_message(rec: &Map<String, Value>) -> bool {
    rec.get("parent_tool_use_id")
        .and_then(Value::as_str)
        .is_some_and(|id| !id.is_empty())
}

pub fn assistant_text_blocks(rec: &Map<String, Value>) -> String {
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

#[derive(Clone, Debug, PartialEq)]
pub struct AssistantToolUse {
    pub id: String,
    pub name: String,
    pub input: Map<String, Value>,
}

pub fn assistant_tool_uses(rec: &Map<String, Value>) -> Vec<AssistantToolUse> {
    let Some(content) = rec
        .get("message")
        .and_then(as_record)
        .and_then(|msg| msg.get("content"))
        .and_then(Value::as_array)
    else {
        return Vec::new();
    };
    content
        .iter()
        .filter_map(|block| {
            let row = as_record(block)?;
            let kind = string_field(Some(row), "type").unwrap_or_default();
            if kind != "tool_use" && kind != "server_tool_use" && kind != "mcp_tool_use" {
                return None;
            }
            Some(AssistantToolUse {
                id: string_field(Some(row), "id")?,
                name: string_field(Some(row), "name")?,
                input: row.get("input").and_then(as_record_owned).unwrap_or_default(),
            })
        })
        .collect()
}

#[derive(Clone, Debug, PartialEq)]
pub struct ToolResult {
    pub tool_use_id: String,
    pub is_error: bool,
    pub content: String,
}

pub fn tool_results_from_user_message(rec: &Map<String, Value>) -> Vec<ToolResult> {
    let Some(content) = rec
        .get("message")
        .and_then(as_record)
        .and_then(|msg| msg.get("content"))
        .and_then(Value::as_array)
    else {
        return Vec::new();
    };
    content
        .iter()
        .filter_map(|block| {
            let row = as_record(block)?;
            if string_field(Some(row), "type").as_deref() != Some("tool_result") {
                return None;
            }
            Some(ToolResult {
                tool_use_id: string_field(Some(row), "tool_use_id")?,
                is_error: row.get("is_error") == Some(&Value::Bool(true)),
                content: result_text(row.get("content")),
            })
        })
        .collect()
}

/// A tool result is a string on simple calls and a list of content blocks once
/// images or MCP payloads are involved.
fn result_text(value: Option<&Value>) -> String {
    match value {
        Some(Value::String(text)) => text.clone(),
        Some(Value::Array(parts)) => parts
            .iter()
            .filter_map(|part| as_record(part)?.get("text")?.as_str().map(str::to_string))
            .collect::<Vec<_>>()
            .join("\n"),
        _ => String::new(),
    }
}

pub fn turn_usage(rec: &Map<String, Value>) -> TurnUsage {
    let usage = rec.get("usage").and_then(as_record);
    let cached = finite_number(usage.and_then(|u| u.get("cache_read_input_tokens"))).unwrap_or(0.0)
        + finite_number(usage.and_then(|u| u.get("cache_creation_input_tokens"))).unwrap_or(0.0);
    let input = finite_number(usage.and_then(|u| u.get("input_tokens")));
    let output = finite_number(usage.and_then(|u| u.get("output_tokens")));
    let cost = finite_number(rec.get("total_cost_usd"));
    let duration = finite_number(rec.get("duration_ms"));
    TurnUsage {
        input_tokens: input.map(|n| (n + cached) as u64),
        output_tokens: output.map(|n| n as u64),
        cost_usd: cost,
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
    let errors = rec
        .get("errors")
        .and_then(Value::as_array)
        .map(|items| {
            items
                .iter()
                .filter_map(Value::as_str)
                .filter(|item| !item.starts_with("[ede_diagnostic]"))
                .map(str::to_string)
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();
    errors
        .into_iter()
        .next()
        .or_else(|| string_field(Some(rec), "result"))
        .or_else(|| Some("Claude turn failed.".into()))
}

pub fn is_message_start(rec: &Map<String, Value>) -> bool {
    rec.get("event")
        .and_then(as_record)
        .and_then(|event| string_field(Some(event), "type"))
        .as_deref()
        == Some("message_start")
}

pub fn is_compact_boundary(rec: &Map<String, Value>) -> bool {
    string_field(Some(rec), "type").as_deref() == Some("system")
        && string_field(Some(rec), "subtype").as_deref() == Some("compact_boundary")
}

pub fn tool_label(name: &str, input: &Map<String, Value>) -> String {
    if let Some(verb_raw) = name.strip_prefix("mcp__crew__") {
        if !verb_raw.is_empty()
            && verb_raw
                .chars()
                .all(|c| c.is_ascii_alphanumeric() || c == '_')
        {
            let verb = format!("Crew {}", verb_raw.replace('_', " "));
            let subject = string_field(Some(input), "to")
                .or_else(|| string_field(Some(input), "name"))
                .or_else(|| string_field(Some(input), "routine_id"))
                .or_else(|| string_field(Some(input), "agent_id"));
            return match subject {
                Some(subject) => format!("{verb} {}", clip(&subject, 40)),
                None => verb,
            };
        }
    }
    let command = string_field(Some(input), "command").or_else(|| string_field(Some(input), "cmd"));
    let path = string_field(Some(input), "file_path")
        .or_else(|| string_field(Some(input), "path"))
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

/// What the row shows under its title, read off the input alone so a pending
/// call already names its command or its file.
pub fn tool_detail(name: &str, input: &Map<String, Value>) -> Option<ToolDetail> {
    if let Some(detail) = super::crew_tool_detail(name, input) {
        return Some(detail);
    }
    match name.to_ascii_lowercase().as_str() {
        "bash" => Some(ToolDetail::Command {
            command: string_field(Some(input), "command")?,
            exit_code: None,
            output: None,
        }),
        "read" => {
            let limit = input.get("limit").and_then(Value::as_u64);
            let start = input
                .get("offset")
                .and_then(Value::as_u64)
                .or_else(|| limit.map(|_| 1));
            Some(ToolDetail::File {
                path: string_field(Some(input), "file_path")?,
                line_start: start.map(|line| line as u32),
                line_end: limit.map(|count| (start.unwrap_or(1) + count.max(1) - 1) as u32),
                preview: None,
            })
        }
        "edit" => Some(ToolDetail::Edit {
            path: string_field(Some(input), "file_path")?,
            added: Some(line_count(input, "new_string")),
            removed: Some(line_count(input, "old_string")),
        }),
        // A write replaces whatever was there, and the call does not say what
        // that was: counting zero removed lines would be a claim, not a fact.
        "write" => Some(ToolDetail::Edit {
            path: string_field(Some(input), "file_path")?,
            added: Some(line_count(input, "content")),
            removed: None,
        }),
        // MultiEdit keeps its edits in an array we do not walk. The path is
        // worth showing; a tally we did not compute is not.
        "multiedit" => Some(ToolDetail::Edit {
            path: string_field(Some(input), "file_path")?,
            added: None,
            removed: None,
        }),
        "glob" | "grep" => Some(ToolDetail::Search {
            query: string_field(Some(input), "pattern")?,
            matches: None,
        }),
        "webfetch" => Some(ToolDetail::Fetch {
            url: string_field(Some(input), "url")?,
            title: None,
        }),
        "websearch" => Some(ToolDetail::Search {
            query: string_field(Some(input), "query")?,
            matches: None,
        }),
        _ => None,
    }
}

/// The detail again once the call returned. `None` means the row already says
/// everything the result could add, and keeps the detail it has.
pub fn tool_result_detail(name: &str, input: &Map<String, Value>, content: &str) -> Option<ToolDetail> {
    // The message row already shows the message. Its result is the delivery
    // receipt, and the input that would rebuild the row is no longer in hand
    // by then, so this kept replacing the message with its own receipt.
    if super::crew_tool(name) == Some("message_agent") {
        return None;
    }
    let text = || Some(content.to_string()).filter(|body| !body.is_empty());
    match tool_detail(name, input) {
        Some(ToolDetail::Command { command, .. }) => Some(ToolDetail::Command {
            command,
            exit_code: None,
            output: text(),
        }),
        Some(ToolDetail::File { path, line_start, line_end, .. }) => Some(ToolDetail::File {
            path,
            line_start,
            line_end,
            preview: text(),
        }),
        Some(_) => None,
        None => text().map(|text| ToolDetail::Output { text }),
    }
}

fn line_count(input: &Map<String, Value>, key: &str) -> u32 {
    input
        .get(key)
        .and_then(Value::as_str)
        .filter(|text| !text.is_empty())
        .map(|text| text.lines().count() as u32)
        .unwrap_or(0)
}

fn pretty_tool(name: &str) -> String {
    if name.eq_ignore_ascii_case("bash") {
        return "Bash".into();
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
    if name.eq_ignore_ascii_case("glob") {
        return "Glob".into();
    }
    if name.eq_ignore_ascii_case("grep") {
        return "Grep".into();
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
    use crew_protocol::{HarnessEvent, ToolDetail};
    use serde_json::json;

    /// The command Claude asked to run in capture 2 of
    /// `crates/crew-core/tests/fixtures/protocols/claude-permissions.jsonl`.
    const CURL: &str = "curl -s -o /dev/null -w '%{http_code}' https://example.com";
    const CALL: &str = "toolu_01NXryc1w4bSyP5MGzDE8Hbe";

    fn tool_details(lines: &[Value]) -> Vec<Option<ToolDetail>> {
        let host = TurnHost::test_new();
        let cap = host.test_capture();
        host.test_install_claude("s");
        for line in lines {
            host.handle_claude_line("s", &line.to_string());
        }
        cap.take()
            .into_iter()
            .filter_map(|event| match event {
                HarnessEvent::ToolStarted { detail, .. } | HarnessEvent::ToolUpdated { detail, .. } => {
                    Some(detail)
                }
                _ => None,
            })
            .collect()
    }

    /// The assistant frame of capture 2, with the tool swapped in.
    fn tool_use(name: &str, input: Value) -> Value {
        json!({
            "type": "assistant",
            "message": {
                "role": "assistant",
                "content": [{ "type": "tool_use", "id": CALL, "name": name, "input": input }]
            },
            "parent_tool_use_id": null,
            "session_id": "9cf6b7f7-b8ab-4de7-86da-b03fb297fcd7"
        })
    }

    fn tool_result(content: &str) -> Value {
        json!({
            "type": "user",
            "message": {
                "role": "user",
                "content": [{ "tool_use_id": CALL, "type": "tool_result", "content": content, "is_error": false }]
            },
            "parent_tool_use_id": null,
            "session_id": "9cf6b7f7-b8ab-4de7-86da-b03fb297fcd7"
        })
    }

    #[test]
    fn a_bash_call_carries_its_command() {
        assert_eq!(
            tool_details(&[tool_use("Bash", json!({ "command": CURL, "description": "Get HTTP status code" }))]),
            vec![Some(ToolDetail::Command {
                command: CURL.into(),
                exit_code: None,
                output: None,
            })]
        );
    }

    #[test]
    fn a_bash_result_puts_the_output_on_the_command() {
        let got = tool_details(&[
            tool_use("Bash", json!({ "command": CURL })),
            tool_result("200"),
        ]);
        assert_eq!(
            got.last().cloned().flatten(),
            Some(ToolDetail::Command {
                command: CURL.into(),
                exit_code: None,
                output: Some("200".into()),
            })
        );
    }

    #[test]
    fn a_read_carries_the_path_and_the_window() {
        let got = tool_details(&[
            tool_use("Read", json!({ "file_path": "/w/src/lib.rs", "offset": 40, "limit": 12 })),
            tool_result("    40→use std::fmt;"),
        ]);
        assert_eq!(
            got,
            vec![
                Some(ToolDetail::File {
                    path: "/w/src/lib.rs".into(),
                    line_start: Some(40),
                    line_end: Some(51),
                    preview: None,
                }),
                Some(ToolDetail::File {
                    path: "/w/src/lib.rs".into(),
                    line_start: Some(40),
                    line_end: Some(51),
                    preview: Some("    40→use std::fmt;".into()),
                }),
            ]
        );
    }

    #[test]
    fn an_edit_counts_the_lines_it_swaps() {
        let input = json!({
            "file_path": "/w/src/lib/sidebarPrefs.ts",
            "old_string": "  return prefs.hidden.includes(key);",
            "new_string": "  const set = hiddenSet(prefs);\n  return set.has(key);",
        });
        assert_eq!(
            tool_details(&[tool_use("Edit", input)]),
            vec![Some(ToolDetail::Edit {
                path: "/w/src/lib/sidebarPrefs.ts".into(),
                added: Some(2),
                removed: Some(1),
            })]
        );
    }

    #[test]
    fn an_edit_result_leaves_the_edit_alone() {
        let input = json!({ "file_path": "/w/a.ts", "old_string": "a", "new_string": "b" });
        let got = tool_details(&[tool_use("Edit", input), tool_result("The file has been updated.")]);
        assert_eq!(got.last(), Some(&None));
    }

    /// REVIEW: the CLI is spawned with `--include-partial-messages`, so a tool
    /// call arrives as content_block_start (empty input) + input_json_delta.
    /// The delta is folded into `tools_by_index` only; `tools_by_id` — the map
    /// the tool_result reads — keeps the empty input it was opened with.
    #[test]
    fn review_a_streamed_bash_keeps_its_command_when_the_result_lands() {
        let start = json!({
            "type": "stream_event",
            "event": {
                "type": "content_block_start",
                "index": 1,
                "content_block": { "type": "tool_use", "id": CALL, "name": "Bash", "input": {} }
            },
            "session_id": "s"
        });
        let delta = json!({
            "type": "stream_event",
            "event": {
                "type": "content_block_delta",
                "index": 1,
                "delta": { "type": "input_json_delta", "partial_json": "{\"command\":\"npm test\"}" }
            },
            "session_id": "s"
        });
        let got = tool_details(&[start, delta, tool_result("2 passing\n")]);
        assert_eq!(
            got.last().cloned().flatten(),
            Some(ToolDetail::Command {
                command: "npm test".into(),
                exit_code: None,
                output: Some("2 passing\n".into()),
            }),
            "the streamed command was lost; the row fell back to raw output"
        );
    }

    /// REVIEW: the realistic CLI order — the deltas, then the whole `assistant`
    /// frame, then the result. `claude_assistant` skips a call it already saw,
    /// so the complete input never reaches `tools_by_id` either.
    #[test]
    fn review_the_assistant_frame_does_not_repair_the_streamed_input() {
        let start = json!({
            "type": "stream_event",
            "event": {
                "type": "content_block_start",
                "index": 1,
                "content_block": { "type": "tool_use", "id": CALL, "name": "Bash", "input": {} }
            },
            "session_id": "s"
        });
        let delta = json!({
            "type": "stream_event",
            "event": {
                "type": "content_block_delta",
                "index": 1,
                "delta": { "type": "input_json_delta", "partial_json": "{\"command\":\"npm test\"}" }
            },
            "session_id": "s"
        });
        let got = tool_details(&[
            start,
            delta,
            tool_use("Bash", json!({ "command": "npm test" })),
            tool_result("2 passing\n"),
        ]);
        assert_eq!(
            got.last().cloned().flatten(),
            Some(ToolDetail::Command {
                command: "npm test".into(),
                exit_code: None,
                output: Some("2 passing\n".into()),
            }),
            "the assistant frame did not restore the command"
        );
    }

    /// REVIEW: `ToolDetail::Edit` documents that absent counts mean "the
    /// provider did not say", which "is not the same as a write that changed
    /// nothing". A `Write` over an existing file has no `old_string`, so
    /// `removed` comes back `Some(0)` and the row claims "+N -0" for a full
    /// overwrite of a file that had content.
    #[test]
    fn review_a_write_does_not_claim_it_removed_nothing() {
        let input = json!({ "file_path": "/w/a.ts", "content": "one\ntwo\nthree" });
        assert_eq!(
            tool_detail("Write", input.as_object().unwrap()),
            Some(ToolDetail::Edit {
                path: "/w/a.ts".into(),
                added: Some(3),
                removed: None,
            })
        );
    }

    #[test]
    fn a_tool_with_nothing_to_show_stays_none() {
        let input = json!({ "todos": [{ "content": "Ship it", "status": "pending" }] });
        assert_eq!(tool_details(&[tool_use("TodoWrite", input)]), vec![None]);
    }

    #[test]
    fn an_unrecognized_tool_falls_back_to_its_result_text() {
        let got = tool_details(&[
            tool_use("mcp__crew__list_agents", json!({})),
            tool_result("Ada, Grace"),
        ]);
        assert_eq!(
            got.last().cloned().flatten(),
            Some(ToolDetail::Output { text: "Ada, Grace".into() })
        );
    }

    #[test]
    fn searches_name_what_they_looked_for() {
        let grep = json!({ "pattern": "ToolDetail", "path": "crates" });
        assert_eq!(
            tool_detail("Grep", grep.as_object().unwrap()),
            Some(ToolDetail::Search { query: "ToolDetail".into(), matches: None })
        );
        let fetch = json!({ "url": "https://example.com", "prompt": "what is this" });
        assert_eq!(
            tool_detail("WebFetch", fetch.as_object().unwrap()),
            Some(ToolDetail::Fetch { url: "https://example.com".into(), title: None })
        );
    }

    fn ask() -> Value {
        json!({
            "type": "control_request",
            "request_id": "c909",
            "request": {
                "subtype": "can_use_tool",
                "tool_name": "AskUserQuestion",
                "input": {
                    "questions": [
                        {
                            "question": "Pick a color",
                            "header": "Color",
                            "options": [
                                { "label": "Red", "description": "Red" },
                                { "label": "Blue", "description": "Blue" }
                            ],
                            "multiSelect": false
                        },
                        {
                            "question": "Pick toppings",
                            "header": "Toppings",
                            "options": [{ "label": "Cheese", "description": "Cheese" }],
                            "multiSelect": true
                        }
                    ]
                },
                "tool_use_id": "toolu_1",
                "requires_user_interaction": true
            }
        })
    }

    #[test]
    fn parses_the_captured_request() {
        let rec = ask().as_object().cloned().unwrap();
        let control = parse_control_request(&rec).unwrap();
        assert_eq!(control.tool_name.as_deref(), Some("AskUserQuestion"));
        let questions = parse_questions(&control.input);
        assert_eq!(
            questions,
            vec![
                Question {
                    question: "Pick a color".into(),
                    header: "Color".into(),
                    multi_select: false,
                    options: vec![
                        QuestionOption { label: "Red".into(), description: None },
                        QuestionOption { label: "Blue".into(), description: None },
                    ],
                },
                Question {
                    question: "Pick toppings".into(),
                    header: "Toppings".into(),
                    multi_select: true,
                    options: vec![QuestionOption { label: "Cheese".into(), description: None }],
                },
            ]
        );
    }

    #[test]
    fn keeps_a_description_only_when_it_says_more_than_the_label() {
        let input = json!({
            "questions": [{ "question": "Q", "options": [{ "label": "A", "description": "Do the A thing" }] }]
        });
        let questions = parse_questions(input.as_object().unwrap());
        assert_eq!(
            questions[0].options[0],
            QuestionOption {
                label: "A".into(),
                description: Some("Do the A thing".into()),
            }
        );
        assert_eq!(questions[0].header, "Q");
    }

    #[test]
    fn is_not_a_question_without_options() {
        assert!(parse_questions(json!({ "command": "ls" }).as_object().unwrap()).is_empty());
        assert!(parse_questions(
            json!({ "questions": [{ "question": "Q", "options": [] }] })
                .as_object()
                .unwrap()
        )
        .is_empty());
    }

    #[test]
    fn answers_by_echoing_the_input_plus_answers() {
        let input = ask()["request"]["input"].as_object().unwrap().clone();
        let mut answers = HashMap::new();
        answers.insert("Pick a color".into(), "Red".into());
        answers.insert("Pick toppings".into(), "Cheese, Olives".into());
        let allowed = to_question_result(&input, Some(&answers));
        assert_eq!(allowed["behavior"], "allow");
        assert_eq!(allowed["updatedInput"]["answers"]["Pick a color"], "Red");
        assert_eq!(to_question_result(&input, None)["behavior"], "deny");
    }

    #[test]
    fn allows_with_the_input_untouched() {
        let input = json!({ "command": "ls" });
        assert_eq!(
            to_permission_result(ApprovalDecision::Allow, input.as_object().unwrap(), "Bash"),
            json!({ "behavior": "allow", "updatedInput": { "command": "ls" } })
        );
    }

    #[test]
    fn always_adds_a_session_rule_on_the_program_for_bash() {
        let input = json!({ "command": "curl -s https://x" });
        let result = to_permission_result(ApprovalDecision::Always, input.as_object().unwrap(), "Bash");
        assert_eq!(
            result["updatedPermissions"],
            json!([{
                "type": "addRules",
                "rules": [{ "toolName": "Bash", "ruleContent": "curl:*" }],
                "behavior": "allow",
                "destination": "session"
            }])
        );
    }

    #[test]
    fn always_names_the_tool_for_everything_else() {
        let input = json!({ "file_path": "a.ts" });
        assert_eq!(
            always_allow_rule("Edit", input.as_object().unwrap()),
            json!({
                "type": "addRules",
                "rules": [{ "toolName": "Edit" }],
                "behavior": "allow",
                "destination": "session"
            })
        );
    }

    #[test]
    fn a_message_to_another_agent_reads_as_the_message() {
        let details = tool_details(&[json!({
            "type": "assistant",
            "message": { "content": [{
                "type": "tool_use",
                "id": "toolu_1",
                "name": "mcp__crew__message_agent",
                "input": { "to": "Cuddles", "text": "the branch is green\nMR is up" }
            }] }
        })]);
        let Some(Some(ToolDetail::Message { to, text })) = details.first() else {
            panic!("expected a message detail, got {details:?}");
        };
        assert_eq!(to, "Cuddles");
        assert!(text.starts_with("the branch is green"));
    }

    #[test]
    fn a_message_keeps_its_detail_when_the_result_lands() {
        // The result arrives without the input that started it, which is when
        // the row used to lose the message and show the receipt instead.
        assert_eq!(
            tool_result_detail("mcp__crew__message_agent", &Map::new(), "{\"delivered\": true}"),
            None
        );
    }

    fn obj(value: Value) -> Map<String, Value> {
        value.as_object().cloned().unwrap_or_default()
    }

    fn flag<'a>(args: &'a [String], name: &str) -> Option<&'a str> {
        args.windows(2).find(|pair| pair[0] == name).map(|pair| pair[1].as_str())
    }

    #[test]
    fn spawn_args_open_with_the_stream_json_contract() {
        let args = build_claude_spawn_args(&ClaudeSpawn {
            model: None,
            session_id: None,
            system_prompt: None,
            autonomy: Autonomy::Ask,
            mcp_config: None,
        });
        assert_eq!(
            args,
            vec![
                "--output-format",
                "stream-json",
                "--verbose",
                "--input-format",
                "stream-json",
                "--include-partial-messages",
                "--setting-sources=project,local",
                "--settings",
                "{\"autoMemoryEnabled\":false}",
                "--permission-prompt-tool",
                "stdio",
            ]
        );
    }

    /// Every autonomy, model, session, persona and MCP combination, empty
    /// strings included: an empty value is no flag, never a flag with "" after it.
    #[test]
    fn spawn_args_carry_exactly_the_options_that_were_set() {
        fn set(value: &Option<String>) -> Option<&str> {
            value.as_deref().filter(|v| !v.is_empty())
        }
        let values = [None, Some(""), Some("value")];
        let mut spawns = Vec::new();
        for autonomy in [Autonomy::Ask, Autonomy::Full] {
            for model in values {
                for session in values {
                    for prompt in values {
                        for mcp in values {
                            spawns.push(ClaudeSpawn {
                                model: model.map(str::to_string),
                                session_id: session.map(str::to_string),
                                system_prompt: prompt.map(str::to_string),
                                autonomy: autonomy.clone(),
                                mcp_config: mcp.map(str::to_string),
                            });
                        }
                    }
                }
            }
        }
        for spawn in spawns {
            let args = build_claude_spawn_args(&spawn);
            let case = format!("{spawn:?}");
            assert_eq!(flag(&args, "--model"), set(&spawn.model), "{case}");
            assert_eq!(flag(&args, "--session-id"), set(&spawn.session_id), "{case}");
            assert_eq!(flag(&args, "--append-system-prompt"), set(&spawn.system_prompt), "{case}");
            assert_eq!(flag(&args, "--mcp-config"), set(&spawn.mcp_config), "{case}");
            let full = spawn.autonomy == Autonomy::Full;
            assert_eq!(args.iter().any(|a| a == "--dangerously-skip-permissions"), full, "{case}");
            assert_eq!(flag(&args, "--permission-prompt-tool"), (!full).then_some("stdio"), "{case}");
            assert!(!args.iter().any(|a| a.is_empty()), "an empty argument went out: {case}");
        }
    }

    #[test]
    fn a_full_spawn_lists_its_options_in_order() {
        let args = build_claude_spawn_args(&ClaudeSpawn {
            model: Some("claude-opus-4-1".into()),
            session_id: Some("sid".into()),
            system_prompt: Some("You are Planner.".into()),
            autonomy: Autonomy::Full,
            mcp_config: Some("{\"mcpServers\":{}}".into()),
        });
        assert_eq!(
            args[9..],
            [
                "--dangerously-skip-permissions",
                "--model",
                "claude-opus-4-1",
                "--append-system-prompt",
                "You are Planner.",
                "--session-id",
                "sid",
                "--mcp-config",
                "{\"mcpServers\":{}}",
            ]
        );
    }

    fn image(media_type: &str, data: &str) -> InlineImage {
        InlineImage {
            path: "/tmp/shot".into(),
            media_type: media_type.into(),
            data: data.into(),
        }
    }

    fn image_block(media_type: &str, data: &str) -> Value {
        json!({ "type": "image", "source": { "type": "base64", "media_type": media_type, "data": data } })
    }

    /// Images travel inline, every other attachment as a path the agent can
    /// open, and the text block is left out only when an image says it all.
    #[test]
    fn a_user_message_carries_the_text_the_files_and_the_images() {
        let note = "Attached files. Read them if you need their contents:";
        /// Name, tail, text, files, images, and the content blocks they make.
        type Case = (&'static str, Option<&'static str>, &'static str, Vec<String>, Vec<InlineImage>, Value);
        let cases: Vec<Case> = vec![
            ("plain text is trimmed", None, "  hola  ", vec![], vec![], json!([{ "type": "text", "text": "hola" }])),
            (
                "files are listed under the text",
                None,
                "mira",
                vec!["/w/a.rs".into(), "/w/b c.rs".into()],
                vec![],
                json!([{ "type": "text", "text": format!("mira\n\n{note}\n- /w/a.rs\n- /w/b c.rs") }]),
            ),
            (
                "files with no text are the whole message",
                None,
                "",
                vec!["/w/a.rs".into()],
                vec![],
                json!([{ "type": "text", "text": format!("{note}\n- /w/a.rs") }]),
            ),
            (
                "an image with no text is only the image",
                None,
                "   ",
                vec![],
                vec![image("image/png", "iVBOR")],
                json!([image_block("image/png", "iVBOR")]),
            ),
            (
                "images go above the text, in order",
                None,
                "what is this?",
                vec![],
                vec![image("image/png", "AAA"), image("image/jpeg", "BBB")],
                json!([
                    image_block("image/png", "AAA"),
                    image_block("image/jpeg", "BBB"),
                    { "type": "text", "text": "what is this?" }
                ]),
            ),
            (
                "an image and a file",
                None,
                "",
                vec!["/w/notes.md".into()],
                vec![image("image/gif", "R0lG")],
                json!([
                    image_block("image/gif", "R0lG"),
                    { "type": "text", "text": format!("{note}\n- /w/notes.md") }
                ]),
            ),
            ("nothing at all is still a message", None, "", vec![], vec![], json!([{ "type": "text", "text": "" }])),
            (
                "the tail rides above the turn",
                Some("## The conversation so far\n\n[user] hola"),
                "y ahora?",
                vec![],
                vec![],
                json!([{
                    "type": "text",
                    "text": "## The conversation so far\n\n[user] hola\n\n## This turn\n\ny ahora?"
                }]),
            ),
            (
                "a tail with only an image under it",
                Some("## tail"),
                "",
                vec![],
                vec![image("image/png", "AAA")],
                json!([image_block("image/png", "AAA"), { "type": "text", "text": "## tail" }]),
            ),
            (
                "a blank tail is no tail",
                Some("  \n "),
                "hola",
                vec![],
                vec![],
                json!([{ "type": "text", "text": "hola" }]),
            ),
        ];
        for (name, history, text, files, images, content) in cases {
            let message = build_claude_user_message("sid-1", history, text, &files, &images);
            assert_eq!(
                message,
                json!({
                    "type": "user",
                    "session_id": "sid-1",
                    "parent_tool_use_id": null,
                    "message": { "role": "user", "content": content },
                }),
                "{name}"
            );
        }
    }

    #[test]
    fn control_frames_wrap_the_request_and_the_response() {
        assert_eq!(
            build_control_request("req_1", json!({ "subtype": "interrupt" })),
            json!({ "type": "control_request", "request_id": "req_1", "request": { "subtype": "interrupt" } })
        );
        assert_eq!(
            build_control_response("c909", json!({ "behavior": "allow" })),
            json!({
                "type": "control_response",
                "response": { "subtype": "success", "request_id": "c909", "response": { "behavior": "allow" } }
            })
        );
    }

    #[test]
    fn a_decision_becomes_the_permission_result_claude_expects() {
        let rule = |tool: &str, content: Option<&str>| {
            let rule = match content {
                Some(content) => json!({ "toolName": tool, "ruleContent": content }),
                None => json!({ "toolName": tool }),
            };
            json!([{ "type": "addRules", "rules": [rule], "behavior": "allow", "destination": "session" }])
        };
        let cases = vec![
            (
                "deny",
                ApprovalDecision::Deny,
                "Bash",
                json!({ "command": "rm -rf /" }),
                json!({ "behavior": "deny", "message": "User declined tool execution." }),
            ),
            (
                "allow echoes the input",
                ApprovalDecision::Allow,
                "Edit",
                json!({ "file_path": "/w/a.rs", "old_string": "a", "new_string": "b" }),
                json!({
                    "behavior": "allow",
                    "updatedInput": { "file_path": "/w/a.rs", "old_string": "a", "new_string": "b" }
                }),
            ),
            (
                "always on a shell names its program",
                ApprovalDecision::Always,
                "Bash",
                json!({ "command": "  git   status --short" }),
                json!({
                    "behavior": "allow",
                    "updatedInput": { "command": "  git   status --short" },
                    "updatedPermissions": rule("Bash", Some("git:*")),
                }),
            ),
            (
                "the shell tool is matched whatever its case",
                ApprovalDecision::Always,
                "bash",
                json!({ "command": "npm test" }),
                json!({
                    "behavior": "allow",
                    "updatedInput": { "command": "npm test" },
                    "updatedPermissions": rule("bash", Some("npm:*")),
                }),
            ),
            (
                "a shell call with no command names the tool",
                ApprovalDecision::Always,
                "Bash",
                json!({ "command": "   " }),
                json!({
                    "behavior": "allow",
                    "updatedInput": { "command": "   " },
                    "updatedPermissions": rule("Bash", None),
                }),
            ),
            (
                "a command on another tool is not a program",
                ApprovalDecision::Always,
                "mcp__solo__run",
                json!({ "command": "ls" }),
                json!({
                    "behavior": "allow",
                    "updatedInput": { "command": "ls" },
                    "updatedPermissions": rule("mcp__solo__run", None),
                }),
            ),
        ];
        for (name, decision, tool, input, expected) in cases {
            assert_eq!(to_permission_result(decision, &obj(input), tool), expected, "{name}");
        }
    }

    #[test]
    fn a_malformed_question_is_skipped_and_the_rest_are_kept() {
        let option = |label: &str| QuestionOption { label: label.into(), description: None };
        let plain = |text: &str, label: &str| Question {
            question: text.into(),
            header: text.into(),
            multi_select: false,
            options: vec![option(label)],
        };
        let cases: Vec<(&str, Value, Vec<Question>)> = vec![
            ("no questions", json!({}), vec![]),
            ("questions is not a list", json!({ "questions": "Pick one" }), vec![]),
            ("a question that is not an object", json!({ "questions": [3, null, "Q"] }), vec![]),
            ("no question text", json!({ "questions": [{ "options": [{ "label": "A" }] }] }), vec![]),
            (
                "blank question text",
                json!({ "questions": [{ "question": "  ", "options": [{ "label": "A" }] }] }),
                vec![],
            ),
            ("no options", json!({ "questions": [{ "question": "Q" }] }), vec![]),
            (
                "options is not a list",
                json!({ "questions": [{ "question": "Q", "options": { "label": "A" } }] }),
                vec![],
            ),
            (
                "no option has a label",
                json!({ "questions": [{
                    "question": "Q",
                    "options": ["A", { "description": "d" }, { "label": " " }]
                }] }),
                vec![],
            ),
            (
                "unlabelled options are dropped, the rest kept",
                json!({ "questions": [{ "question": "Q", "options": ["A", { "label": "B" }, { "label": "" }] }] }),
                vec![plain("Q", "B")],
            ),
            (
                "multiSelect must be a real true",
                json!({ "questions": [{ "question": "Q", "multiSelect": "true", "options": [{ "label": "A" }] }] }),
                vec![plain("Q", "A")],
            ),
            (
                "a blank header falls back to the question",
                json!({ "questions": [{
                    "question": "Q",
                    "header": " ",
                    "options": [{ "label": "A", "description": "A" }]
                }] }),
                vec![plain("Q", "A")],
            ),
            (
                "a broken question between two good ones",
                json!({ "questions": [
                    {
                        "question": "First",
                        "header": "One",
                        "multiSelect": true,
                        "options": [{ "label": "A", "description": "Do A" }]
                    },
                    { "question": "Broken", "options": [] },
                    { "question": "Second", "options": [{ "label": "B" }] }
                ] }),
                vec![
                    Question {
                        question: "First".into(),
                        header: "One".into(),
                        multi_select: true,
                        options: vec![QuestionOption { label: "A".into(), description: Some("Do A".into()) }],
                    },
                    plain("Second", "B"),
                ],
            ),
        ];
        for (name, input, expected) in cases {
            assert_eq!(parse_questions(&obj(input)), expected, "{name}");
        }
    }

    #[test]
    fn a_control_request_is_read_from_either_nesting() {
        let request = |request_id: &str, subtype: &str, tool: Option<&str>, input: Value, tool_use_id: Option<&str>| {
            Some(ClaudeControlRequest {
                request_id: request_id.into(),
                subtype: subtype.into(),
                tool_name: tool.map(str::to_string),
                input: obj(input),
                tool_use_id: tool_use_id.map(str::to_string),
            })
        };
        let cases = vec![
            ("not a control frame", json!({ "type": "assistant", "request_id": "1" }), None),
            ("no type at all", json!({ "request_id": "1", "request": { "subtype": "can_use_tool" } }), None),
            ("no request id", json!({ "type": "control_request", "request": { "subtype": "can_use_tool" } }), None),
            ("no subtype", json!({ "type": "control_request", "request_id": "1", "request": {} }), None),
            (
                "the sdk spelling, with the id and the input nested",
                json!({
                    "type": "sdk_control_request",
                    "request": {
                        "request_id": "r7",
                        "subtype": "can_use_tool",
                        "tool_name": "Bash",
                        "tool_input": { "command": "ls" }
                    }
                }),
                request("r7", "can_use_tool", Some("Bash"), json!({ "command": "ls" }), None),
            ),
            (
                "everything at the top level",
                json!({
                    "type": "control_request",
                    "request_id": "r8",
                    "subtype": "can_use_tool",
                    "tool_name": "Edit",
                    "tool_use_id": "toolu_2",
                    "input": { "file_path": "/w/a.rs" }
                }),
                request("r8", "can_use_tool", Some("Edit"), json!({ "file_path": "/w/a.rs" }), Some("toolu_2")),
            ),
            (
                "an input that is not an object is an empty one",
                json!({
                    "type": "control_request",
                    "request_id": "r9",
                    "request": { "subtype": "can_use_tool", "input": "ls" }
                }),
                request("r9", "can_use_tool", None, json!({}), None),
            ),
        ];
        for (name, rec, expected) in cases {
            assert_eq!(parse_control_request(&obj(rec)), expected, "{name}");
        }
    }

    #[test]
    fn a_cancel_names_the_request_it_withdraws() {
        let cases = vec![
            ("no type", json!({ "request_id": "c1" }), None),
            ("a request, not a cancel", json!({ "type": "control_request", "request_id": "c1" }), None),
            ("top level id", json!({ "type": "control_cancel_request", "request_id": "c1" }), Some("c1")),
            (
                "nested id, sdk spelling",
                json!({ "type": "sdk_control_cancel_request", "request": { "request_id": "c2" } }),
                Some("c2"),
            ),
            ("a cancel with no id", json!({ "type": "control_cancel_request", "request": {} }), None),
        ];
        for (name, rec, expected) in cases {
            assert_eq!(parse_control_cancel_id(&obj(rec)).as_deref(), expected, "{name}");
        }
    }

    /// Hook frames carry the session of whatever ran the hook, which is not
    /// necessarily this one.
    #[test]
    fn a_hook_frame_never_names_the_session() {
        let cases = vec![
            ("init", json!({ "type": "system", "subtype": "init", "session_id": "s1" }), Some("s1")),
            ("a hook", json!({ "type": "system", "subtype": "hook_started", "session_id": "s2" }), None),
            (
                "hook-ish subtype on another frame",
                json!({ "type": "assistant", "subtype": "hook_x", "session_id": "s3" }),
                Some("s3"),
            ),
            ("system without a subtype", json!({ "type": "system", "session_id": "s4" }), Some("s4")),
            ("no session id", json!({ "type": "result" }), None),
        ];
        for (name, rec, expected) in cases {
            assert_eq!(session_id_from_message(&obj(rec)).as_deref(), expected, "{name}");
        }
    }

    fn stream(event: Value) -> Map<String, Value> {
        obj(json!({ "type": "stream_event", "event": event, "session_id": "s" }))
    }

    #[test]
    fn only_a_text_delta_streams_text() {
        let cases = vec![
            ("no event", obj(json!({ "type": "stream_event" })), None),
            ("another event", stream(json!({ "type": "message_start" })), None),
            ("no delta", stream(json!({ "type": "content_block_delta", "index": 0 })), None),
            (
                "a json delta",
                stream(json!({
                    "type": "content_block_delta",
                    "delta": { "type": "input_json_delta", "partial_json": "{" }
                })),
                None,
            ),
            (
                "an empty text delta",
                stream(json!({ "type": "content_block_delta", "delta": { "type": "text_delta", "text": "" } })),
                None,
            ),
            (
                "text keeps its whitespace",
                stream(json!({ "type": "content_block_delta", "delta": { "type": "text_delta", "text": " hola\n" } })),
                Some(" hola\n"),
            ),
        ];
        for (name, rec, expected) in cases {
            assert_eq!(stream_text_delta(&rec).as_deref(), expected, "{name}");
        }
    }

    #[test]
    fn a_tool_opens_on_its_content_block_start() {
        let start = |block: Value| stream(json!({ "type": "content_block_start", "index": 2, "content_block": block }));
        let tool = |index: i64, id: &str, name: &str, input: Value| {
            Some(ToolStart { index, id: id.into(), name: name.into(), input: obj(input) })
        };
        let cases = vec![
            ("no event", obj(json!({})), None),
            ("a delta, not a start", stream(json!({ "type": "content_block_delta", "index": 2 })), None),
            ("no content block", stream(json!({ "type": "content_block_start", "index": 2 })), None),
            ("a text block", start(json!({ "type": "text", "text": "" })), None),
            ("a block with no type", start(json!({ "id": "t", "name": "Bash" })), None),
            ("a tool with no id", start(json!({ "type": "tool_use", "name": "Bash" })), None),
            ("a tool with no name", start(json!({ "type": "tool_use", "id": "t1" })), None),
            (
                "a tool use",
                start(json!({ "type": "tool_use", "id": "t1", "name": "Bash", "input": {} })),
                tool(2, "t1", "Bash", json!({})),
            ),
            (
                "a server tool with its input",
                start(json!({
                    "type": "server_tool_use",
                    "id": "t2",
                    "name": "web_search",
                    "input": { "query": "rust" }
                })),
                tool(2, "t2", "web_search", json!({ "query": "rust" })),
            ),
            (
                "an mcp tool with no index and a bad input",
                stream(json!({
                    "type": "content_block_start",
                    "content_block": {
                        "type": "mcp_tool_use",
                        "id": "t3",
                        "name": "mcp__crew__list_agents",
                        "input": [1]
                    }
                })),
                tool(-1, "t3", "mcp__crew__list_agents", json!({})),
            ),
        ];
        for (name, rec, expected) in cases {
            assert_eq!(tool_start_from_event(&rec), expected, "{name}");
        }
    }

    #[test]
    fn a_partial_input_is_a_json_delta_with_something_in_it() {
        let delta = |delta: Value| stream(json!({ "type": "content_block_delta", "index": 1, "delta": delta }));
        let cases = vec![
            ("no event", obj(json!({})), None),
            ("a start, not a delta", stream(json!({ "type": "content_block_start", "index": 1 })), None),
            ("no delta", stream(json!({ "type": "content_block_delta", "index": 1 })), None),
            ("a text delta", delta(json!({ "type": "text_delta", "text": "hi" })), None),
            ("no partial json", delta(json!({ "type": "input_json_delta" })), None),
            ("an empty partial", delta(json!({ "type": "input_json_delta", "partial_json": "" })), None),
            (
                "a partial",
                delta(json!({ "type": "input_json_delta", "partial_json": "{\"command\":" })),
                Some((1, "{\"command\":".to_string())),
            ),
            (
                "a partial with no index",
                stream(json!({
                    "type": "content_block_delta",
                    "delta": { "type": "input_json_delta", "partial_json": "}" }
                })),
                Some((-1, "}".to_string())),
            ),
        ];
        for (name, rec, expected) in cases {
            assert_eq!(input_json_delta_from_event(&rec), expected, "{name}");
        }
    }

    #[test]
    fn frames_are_classified_by_their_markers() {
        let cases = vec![
            (json!({ "type": "stream_event", "event": { "type": "message_start" } }), true, false, false),
            (json!({ "type": "stream_event", "event": { "type": "message_stop" } }), false, false, false),
            (json!({ "type": "stream_event", "event": "message_start" }), false, false, false),
            (json!({ "type": "assistant", "parent_tool_use_id": "toolu_1" }), false, true, false),
            (json!({ "type": "assistant", "parent_tool_use_id": "" }), false, false, false),
            (json!({ "type": "assistant", "parent_tool_use_id": null }), false, false, false),
            (json!({ "type": "system", "subtype": "compact_boundary" }), false, false, true),
            (json!({ "type": "system", "subtype": "init" }), false, false, false),
            (json!({ "type": "user", "subtype": "compact_boundary" }), false, false, false),
            (json!({ "subtype": "compact_boundary" }), false, false, false),
        ];
        for (rec, start, subagent, compact) in cases {
            let rec = obj(rec);
            assert_eq!(is_message_start(&rec), start, "message start: {rec:?}");
            assert_eq!(is_subagent_message(&rec), subagent, "subagent: {rec:?}");
            assert_eq!(is_compact_boundary(&rec), compact, "compact boundary: {rec:?}");
        }
    }

    fn message(content: Value) -> Map<String, Value> {
        obj(json!({ "type": "assistant", "message": { "role": "assistant", "content": content } }))
    }

    #[test]
    fn assistant_text_is_its_text_blocks_joined() {
        let cases = vec![
            ("no message", obj(json!({ "type": "assistant" })), ""),
            ("a message that is a string", obj(json!({ "message": "hi" })), ""),
            ("content that is not a list", message(json!("hi")), ""),
            ("no blocks", message(json!([])), ""),
            (
                "text around a tool and junk",
                message(json!([
                    { "type": "text", "text": "Voy a " },
                    { "type": "tool_use", "id": "t1", "name": "Bash", "input": {} },
                    "loose string",
                    { "type": "text" },
                    { "type": "thinking", "thinking": "hm" },
                    { "type": "text", "text": "mirar." }
                ])),
                "Voy a mirar.",
            ),
        ];
        for (name, rec, expected) in cases {
            assert_eq!(assistant_text_blocks(&rec), expected, "{name}");
        }
    }

    #[test]
    fn assistant_tool_uses_are_every_well_formed_call() {
        let call = |id: &str, name: &str, input: Value| AssistantToolUse {
            id: id.into(),
            name: name.into(),
            input: obj(input),
        };
        let cases = vec![
            ("no message", obj(json!({})), vec![]),
            ("content that is not a list", message(json!({ "type": "tool_use" })), vec![]),
            (
                "every kind of call, and the malformed ones dropped",
                message(json!([
                    { "type": "text", "text": "running" },
                    { "type": "tool_use", "id": "t1", "name": "Bash", "input": { "command": "ls" } },
                    { "type": "server_tool_use", "id": "t2", "name": "web_search" },
                    { "type": "mcp_tool_use", "id": "t3", "name": "mcp__crew__list_agents", "input": "bad" },
                    { "type": "tool_use", "name": "NoId" },
                    { "type": "tool_use", "id": "t4" },
                    { "id": "t5", "name": "NoType" },
                    42
                ])),
                vec![
                    call("t1", "Bash", json!({ "command": "ls" })),
                    call("t2", "web_search", json!({})),
                    call("t3", "mcp__crew__list_agents", json!({})),
                ],
            ),
        ];
        for (name, rec, expected) in cases {
            assert_eq!(assistant_tool_uses(&rec), expected, "{name}");
        }
    }

    #[test]
    fn tool_results_read_string_and_block_content() {
        let result = |id: &str, is_error: bool, content: &str| ToolResult {
            tool_use_id: id.into(),
            is_error,
            content: content.into(),
        };
        let cases = vec![
            ("no message", obj(json!({ "type": "user" })), vec![]),
            ("content that is not a list", obj(json!({ "message": { "content": "hi" } })), vec![]),
            (
                "every shape of result",
                obj(json!({ "type": "user", "message": { "role": "user", "content": [
                    { "type": "tool_result", "tool_use_id": "t1", "content": "200" },
                    { "type": "tool_result", "tool_use_id": "t2", "is_error": true, "content": "Exit code 1" },
                    { "type": "tool_result", "tool_use_id": "t3", "content": [
                        { "type": "text", "text": "line one" },
                        { "type": "image", "source": {} },
                        "stray",
                        { "type": "text", "text": "line two" }
                    ] },
                    { "type": "tool_result", "tool_use_id": "t4", "is_error": "true", "content": null },
                    { "type": "tool_result", "tool_use_id": "t5", "content": { "text": "an object" } },
                    { "type": "tool_result", "content": "no id" },
                    { "type": "text", "text": "not a result" },
                    7
                ] } })),
                vec![
                    result("t1", false, "200"),
                    result("t2", true, "Exit code 1"),
                    result("t3", false, "line one\nline two"),
                    result("t4", false, ""),
                    result("t5", false, ""),
                ],
            ),
        ];
        for (name, rec, expected) in cases {
            assert_eq!(tool_results_from_user_message(&rec), expected, "{name}");
        }
    }

    /// The input a model reads includes what the cache served it, so the
    /// count adds the cache back in.
    #[test]
    fn usage_counts_the_cache_as_input() {
        let usage = |input, output, cost, duration| TurnUsage {
            input_tokens: input,
            output_tokens: output,
            cost_usd: cost,
            duration_ms: duration,
        };
        let cases = vec![
            ("nothing reported", json!({ "type": "result" }), usage(None, None, None, None)),
            (
                "the whole result",
                json!({
                    "type": "result",
                    "total_cost_usd": 0.0123,
                    "duration_ms": 4200,
                    "usage": {
                        "input_tokens": 10,
                        "output_tokens": 250,
                        "cache_read_input_tokens": 1000,
                        "cache_creation_input_tokens": 300
                    }
                }),
                usage(Some(1310), Some(250), Some(0.0123), Some(4200)),
            ),
            (
                "a cache with no input count is no input count",
                json!({ "usage": { "cache_read_input_tokens": 1000, "output_tokens": 5 } }),
                usage(None, Some(5), None, None),
            ),
            (
                "numbers that are strings are not numbers",
                json!({ "usage": { "input_tokens": "10", "output_tokens": 2 }, "total_cost_usd": "0.1" }),
                usage(None, Some(2), None, None),
            ),
            (
                "a usage that is not an object",
                json!({ "usage": [1, 2], "duration_ms": 9.7 }),
                usage(None, None, None, Some(9)),
            ),
        ];
        for (name, rec, expected) in cases {
            assert_eq!(turn_usage(&obj(rec)), expected, "{name}");
        }
    }

    #[test]
    fn a_failed_turn_says_why_in_the_best_words_it_has() {
        let cases = vec![
            ("a success", json!({ "type": "result", "subtype": "success", "result": "done" }), None),
            ("no subtype and no error flag", json!({ "type": "result", "result": "done" }), None),
            ("is_error must be a real true", json!({ "subtype": "success", "is_error": "true" }), None),
            (
                "the first real error wins over the result",
                json!({
                    "subtype": "error_during_execution",
                    "is_error": true,
                    "errors": ["[ede_diagnostic] noise", 42, "API Error: 529 Overloaded", "later"],
                    "result": "fallback"
                }),
                Some("API Error: 529 Overloaded"),
            ),
            (
                "only diagnostics fall back to the result",
                json!({
                    "subtype": "success",
                    "is_error": true,
                    "errors": ["[ede_diagnostic] x"],
                    "result": "  Prompt is too long  "
                }),
                Some("Prompt is too long"),
            ),
            ("errors that are not a list", json!({ "is_error": true, "errors": "boom", "result": "why" }), Some("why")),
            ("nothing to say", json!({ "subtype": "error_max_turns" }), Some("Claude turn failed.")),
            ("a blank result", json!({ "is_error": true, "result": "   " }), Some("Claude turn failed.")),
        ];
        for (name, rec, expected) in cases {
            assert_eq!(turn_failed(&obj(rec)).as_deref(), expected, "{name}");
        }
    }

    #[test]
    fn a_row_title_names_what_the_call_did() {
        let long_command = format!("echo {}", "x".repeat(100));
        let cases: Vec<(&str, Value, String)> = vec![
            ("mcp__crew__message_agent", json!({ "to": "Cuddles", "text": "hi" }), "Crew message agent Cuddles".into()),
            ("mcp__crew__spawn_agent", json!({ "name": "Planner" }), "Crew spawn agent Planner".into()),
            ("mcp__crew__run_routine", json!({ "routine_id": "r-1" }), "Crew run routine r-1".into()),
            ("mcp__crew__stop_agent", json!({ "agent_id": "a-1" }), "Crew stop agent a-1".into()),
            ("mcp__crew__list_agents", json!({}), "Crew list agents".into()),
            (
                "mcp__crew__message_agent",
                json!({ "to": "ñ".repeat(50) }),
                format!("Crew message agent {}…", "ñ".repeat(39)),
            ),
            ("mcp__crew__", json!({}), "mcp__crew__".into()),
            ("mcp__crew__bad-verb", json!({ "to": "x", "command": "ls" }), "ls".into()),
            ("Bash", json!({ "command": "  npm test\nnpm run lint" }), "npm test".into()),
            ("Bash", json!({ "command": long_command }), format!("echo {}…", "x".repeat(66))),
            ("exec", json!({ "cmd": "cargo build" }), "cargo build".into()),
            ("Bash", json!({ "command": "ls", "file_path": "/w/a.rs" }), "ls".into()),
            ("Read", json!({ "file_path": "/w/src/lib.rs" }), "Read lib.rs".into()),
            ("read", json!({ "path": "C:\\w\\main.rs" }), "Read main.rs".into()),
            ("Write", json!({ "target_file": "/w/new.ts" }), "Write new.ts".into()),
            ("Edit", json!({ "filePath": "/w/a.ts", "pattern": "x" }), "Edit a.ts".into()),
            ("MultiEdit", json!({ "file_path": "/w/b.ts" }), "Edit b.ts".into()),
            ("Glob", json!({ "pattern": "**/*.rs" }), "Glob **/*.rs".into()),
            ("Grep", json!({ "pattern": "a".repeat(60) }), format!("Grep {}…", "a".repeat(39))),
            ("Grep", json!({ "regex": "fn \\w+" }), "Grep fn \\w+".into()),
            ("WebSearch", json!({ "query": "rust ts-rs" }), "Search rust ts-rs".into()),
            ("mcp__search__websearch", json!({ "glob": "*.md" }), "Search *.md".into()),
            ("WebFetch", json!({ "url": "https://example.com" }), "WebFetch".into()),
            ("TodoWrite", json!({ "todos": [] }), "TodoWrite".into()),
            ("Task", json!({ "command": "   " }), "Task".into()),
        ];
        for (name, input, expected) in cases {
            assert_eq!(tool_label(name, &obj(input.clone())), expected, "{name} {input}");
        }
    }

    #[test]
    fn a_row_detail_is_read_off_the_input_of_every_known_tool() {
        let file = |path: &str, start: Option<u32>, end: Option<u32>| ToolDetail::File {
            path: path.into(),
            line_start: start,
            line_end: end,
            preview: None,
        };
        let edit = |path: &str, added: Option<u32>, removed: Option<u32>| ToolDetail::Edit {
            path: path.into(),
            added,
            removed,
        };
        let search = |query: &str| ToolDetail::Search { query: query.into(), matches: None };
        let cases: Vec<(&str, Value, Option<ToolDetail>)> = vec![
            (
                "mcp__crew__message_agent",
                json!({ "to": "Cuddles", "text": "hola" }),
                Some(ToolDetail::Message { to: "Cuddles".into(), text: "hola".into() }),
            ),
            ("mcp__crew__message_agent", json!({ "text": "to nobody" }), None),
            ("mcp__crew__list_agents", json!({}), None),
            (
                "BASH",
                json!({ "command": "ls -la" }),
                Some(ToolDetail::Command { command: "ls -la".into(), exit_code: None, output: None }),
            ),
            ("Bash", json!({ "description": "no command" }), None),
            ("Read", json!({ "file_path": "/w/a.rs" }), Some(file("/w/a.rs", None, None))),
            (
                "Read",
                json!({ "file_path": "/w/a.rs", "offset": 40, "limit": 12 }),
                Some(file("/w/a.rs", Some(40), Some(51))),
            ),
            ("Read", json!({ "file_path": "/w/a.rs", "limit": 20 }), Some(file("/w/a.rs", Some(1), Some(20)))),
            ("Read", json!({ "file_path": "/w/a.rs", "offset": 7 }), Some(file("/w/a.rs", Some(7), None))),
            (
                "Read",
                json!({ "file_path": "/w/a.rs", "offset": 7, "limit": 0 }),
                Some(file("/w/a.rs", Some(7), Some(7))),
            ),
            ("Read", json!({ "file_path": "/w/a.rs", "offset": "7", "limit": -3 }), Some(file("/w/a.rs", None, None))),
            ("Read", json!({ "path": "/w/a.rs" }), None),
            (
                "Edit",
                json!({ "file_path": "/w/a.rs", "old_string": "a\nb\nc", "new_string": "" }),
                Some(edit("/w/a.rs", Some(0), Some(3))),
            ),
            ("Edit", json!({ "file_path": "/w/a.rs" }), Some(edit("/w/a.rs", Some(0), Some(0)))),
            ("Edit", json!({ "old_string": "a", "new_string": "b" }), None),
            (
                "Write",
                json!({ "file_path": "/w/new.rs", "content": "one\ntwo\n" }),
                Some(edit("/w/new.rs", Some(2), None)),
            ),
            ("Write", json!({ "content": "x" }), None),
            (
                "MultiEdit",
                json!({ "file_path": "/w/b.rs", "edits": [{ "old_string": "a" }] }),
                Some(edit("/w/b.rs", None, None)),
            ),
            ("MultiEdit", json!({ "edits": [] }), None),
            ("Glob", json!({ "pattern": "**/*.rs" }), Some(search("**/*.rs"))),
            ("Grep", json!({ "pattern": "ToolDetail", "path": "crates" }), Some(search("ToolDetail"))),
            ("Grep", json!({ "query": "no pattern" }), None),
            (
                "WebFetch",
                json!({ "url": "https://example.com" }),
                Some(ToolDetail::Fetch { url: "https://example.com".into(), title: None }),
            ),
            ("WebFetch", json!({ "prompt": "no url" }), None),
            ("WebSearch", json!({ "query": "ts-rs enums" }), Some(search("ts-rs enums"))),
            ("WebSearch", json!({}), None),
            ("TodoWrite", json!({ "todos": [] }), None),
        ];
        for (name, input, expected) in cases {
            assert_eq!(tool_detail(name, &obj(input.clone())), expected, "{name} {input}");
        }
    }

    #[test]
    fn a_result_adds_output_only_where_the_row_has_room_for_it() {
        let cases: Vec<(&str, Value, &str, Option<ToolDetail>)> = vec![
            ("mcp__crew__message_agent", json!({ "to": "Cuddles", "text": "hi" }), "{\"delivered\":true}", None),
            (
                "Bash",
                json!({ "command": "ls" }),
                "a.rs\n",
                Some(ToolDetail::Command { command: "ls".into(), exit_code: None, output: Some("a.rs\n".into()) }),
            ),
            (
                "Bash",
                json!({ "command": "true" }),
                "",
                Some(ToolDetail::Command { command: "true".into(), exit_code: None, output: None }),
            ),
            (
                "Read",
                json!({ "file_path": "/w/a.rs", "limit": 2 }),
                "1→fn main() {}",
                Some(ToolDetail::File {
                    path: "/w/a.rs".into(),
                    line_start: Some(1),
                    line_end: Some(2),
                    preview: Some("1→fn main() {}".into()),
                }),
            ),
            ("Edit", json!({ "file_path": "/w/a.rs" }), "The file has been updated.", None),
            ("Grep", json!({ "pattern": "x" }), "3 matches", None),
            ("TodoWrite", json!({}), "Todos updated", Some(ToolDetail::Output { text: "Todos updated".into() })),
            ("TodoWrite", json!({}), "", None),
        ];
        for (name, input, content, expected) in cases {
            assert_eq!(tool_result_detail(name, &obj(input.clone()), content), expected, "{name} {input} {content:?}");
        }
    }

    #[test]
    fn a_tool_name_is_shown_the_way_the_chat_spells_it() {
        let cases = [
            ("bash", "Bash"),
            ("READ", "Read"),
            ("write", "Write"),
            ("Edit", "Edit"),
            ("multiedit", "Edit"),
            ("glob", "Glob"),
            ("GREP", "Grep"),
            ("WebSearch", "Search"),
            ("mcp__brave__websearch", "Search"),
            ("WebFetch", "WebFetch"),
            ("TodoWrite", "TodoWrite"),
            ("", ""),
        ];
        for (name, expected) in cases {
            assert_eq!(pretty_tool(name), expected, "pretty_tool({name:?})");
        }
    }
}
