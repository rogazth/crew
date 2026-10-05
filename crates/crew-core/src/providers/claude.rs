use std::collections::HashMap;

use crew_protocol::{ApprovalDecision, EditHunk, Question, QuestionOption, ToolDetail, TurnUsage};
use serde_json::{json, Map, Value};

use super::runtime::{Autonomy, InlineImage};
use super::{
    as_record, as_record_owned, clip, finite_number, leaf, mcp_label, mcp_name, pretty_input, string_field,
    subagent_report, todo_items,
};

pub use super::{parse_json_line, try_parse_json_record};

#[derive(Clone, Debug, PartialEq)]
pub struct ClaudeSpawn {
    pub model: Option<String>,
    /// `--effort`: low, medium, high, xhigh or max; `None` is the CLI's own.
    pub effort: Option<String>,
    pub session_id: Option<String>,
    /// A conversation to carry on (`--resume`), for a child session; a bot's
    /// turns never resume, they start clean with the tail (`session_id`).
    pub resume: Option<String>,
    /// Have Claude echo each user message as it takes it in. A message
    /// written mid-turn (a steer) is read at its next step, not when it
    /// arrives; the echo is how Crew knows it was read.
    pub replay_user_messages: bool,
    pub system_prompt: Option<String>,
    pub autonomy: Autonomy,
    pub mcp_config: Option<String>,
}

/// The `--mcp-config` value that starts Crew's MCP server. Claude merges it
/// with the user's own servers unless `--strict-mcp-config` is also passed.
pub fn claude_mcp_config(command: &str, args: &[String]) -> String {
    json!({ "mcpServers": { "crew": { "command": command, "args": args } } }).to_string()
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
        // bot's whole configuration, and ~/.claude would inject a competing one.
        "--setting-sources=project,local".into(),
        "--settings".into(),
        json!({ "autoMemoryEnabled": false }).to_string(),
    ];
    match input.autonomy {
        Autonomy::Full => args.push("--dangerously-skip-permissions".into()),
        ref mode => {
            let permission = match mode {
                Autonomy::Edits => "acceptEdits",
                Autonomy::Auto => "auto",
                _ => "default",
            };
            args.extend(["--permission-mode".into(), permission.into()]);
            args.push("--permission-prompt-tool".into());
            args.push("stdio".into());
        }
    }
    if let Some(model) = input.model.as_deref().filter(|m| !m.is_empty()) {
        args.push("--model".into());
        args.push(model.into());
    }
    if let Some(effort) = input.effort.as_deref().filter(|e| !e.is_empty()) {
        args.push("--effort".into());
        args.push(effort.into());
    }
    if let Some(prompt) = input.system_prompt.as_deref().filter(|p| !p.is_empty()) {
        args.push("--append-system-prompt".into());
        args.push(prompt.into());
    }
    if let Some(resume) = input.resume.as_deref().filter(|s| !s.is_empty()) {
        args.push("--resume".into());
        args.push(resume.into());
    } else if let Some(session_id) = input.session_id.as_deref().filter(|s| !s.is_empty()) {
        args.push("--session-id".into());
        args.push(session_id.into());
    }
    if input.replay_user_messages {
        args.push("--replay-user-messages".into());
    }
    if let Some(mcp) = input.mcp_config.as_deref().filter(|c| !c.is_empty()) {
        args.push("--mcp-config".into());
        args.push(mcp.into());
    }
    args
}

/// The text of a user message Claude echoed back (`--replay-user-messages`),
/// when it is one: a string, or the text parts of a list. A tool result is a
/// user message too, and has none.
pub fn replayed_text(rec: &Map<String, Value>) -> Option<String> {
    let content = rec.get("message").and_then(as_record)?.get("content")?;
    let text = match content {
        Value::String(text) => text.clone(),
        Value::Array(parts) => parts
            .iter()
            .filter_map(|part| {
                let part = as_record(part)?;
                (string_field(Some(part), "type").as_deref() == Some("text"))
                    .then(|| part.get("text").and_then(Value::as_str).unwrap_or_default().to_string())
            })
            .collect::<Vec<_>>()
            .join("\n"),
        _ => return None,
    };
    let text = text.trim().to_string();
    (!text.is_empty()).then_some(text)
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
    if let Some((verb_raw, input)) = name.strip_prefix("mcp__crew__").and(super::crew_call(name, input)) {
        let input: &Map<String, Value> = &input;
        if !verb_raw.is_empty()
            && verb_raw
                .chars()
                .all(|c| c.is_ascii_alphanumeric() || c == '_')
        {
            let verb = format!("Crew {}", verb_raw.replace('_', " "));
            let subject = string_field(Some(input), "to")
                .or_else(|| string_field(Some(input), "name"))
                .or_else(|| string_field(Some(input), "routine_id"))
                .or_else(|| string_field(Some(input), "bot_id"))
                // Older transcripts named the owner of a routine this way.
                .or_else(|| string_field(Some(input), "agent_id"));
            return match subject {
                Some(subject) => format!("{verb} {}", clip(&subject, 40)),
                None => verb,
            };
        }
    }
    if let Some((server, tool)) = mcp_name(name) {
        return mcp_label(&server, &tool);
    }
    match name.to_ascii_lowercase().as_str() {
        "task" | "agent" => {
            return match string_field(Some(input), "description") {
                Some(description) => clip(&description, 72),
                None => "Subagent".into(),
            };
        }
        "todowrite" => return "Todos".into(),
        "exitplanmode" => return "Plan".into(),
        "skill" => {
            return match string_field(Some(input), "skill") {
                Some(skill) => format!("Skill {}", clip(&skill, 40)),
                None => "Skill".into(),
            };
        }
        // `select:A,B` loads tools it already knows by name; anything else searches.
        "toolsearch" => {
            return match string_field(Some(input), "query") {
                Some(query) => match query.strip_prefix("select:") {
                    Some(names) => format!("Load {}", clip(&names.replace(',', ", "), 60)),
                    None => format!("Find tools for \u{201c}{}\u{201d}", clip(&query, 40)),
                },
                None => "Find tools".into(),
            };
        }
        _ => {}
    }
    let command = string_field(Some(input), "command").or_else(|| string_field(Some(input), "cmd"));
    let path = string_field(Some(input), "file_path")
        .or_else(|| string_field(Some(input), "notebook_path"))
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
    if let Some((server, tool)) = mcp_name(name) {
        return Some(ToolDetail::Mcp {
            server,
            tool,
            input: pretty_input(input),
            output: None,
        });
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
            hunks: hunk(input, "old_string", "new_string").map(|hunk| vec![hunk]),
        }),
        // A write replaces whatever was there, and the call does not say what
        // that was: counting zero removed lines would be a claim, not a fact.
        "write" => Some(ToolDetail::Edit {
            path: string_field(Some(input), "file_path")?,
            added: Some(line_count(input, "content")),
            removed: None,
            hunks: raw(input, "content").map(|after| {
                vec![EditHunk {
                    before: String::new(),
                    after: after.to_string(),
                }]
            }),
        }),
        "multiedit" => {
            let edits = input
                .get("edits")
                .and_then(Value::as_array)
                .map(|rows| rows.iter().filter_map(as_record).collect::<Vec<_>>())
                .unwrap_or_default();
            let hunks = edits
                .iter()
                .filter_map(|edit| hunk(edit, "old_string", "new_string"))
                .collect::<Vec<_>>();
            let tally = |key: &str| edits.iter().map(|edit| line_count(edit, key)).sum::<u32>();
            Some(ToolDetail::Edit {
                path: string_field(Some(input), "file_path")?,
                added: (!edits.is_empty()).then(|| tally("new_string")),
                removed: (!edits.is_empty()).then(|| tally("old_string")),
                hunks: (!hunks.is_empty()).then_some(hunks),
            })
        }
        "notebookedit" => Some(ToolDetail::Edit {
            path: string_field(Some(input), "notebook_path")?,
            added: Some(line_count(input, "new_source")),
            removed: None,
            hunks: None,
        }),
        "glob" | "grep" => Some(ToolDetail::Search {
            query: string_field(Some(input), "pattern")?,
            matches: None,
            output: None,
        }),
        "webfetch" => Some(ToolDetail::Fetch {
            url: string_field(Some(input), "url")?,
            title: None,
            output: None,
        }),
        "websearch" => Some(ToolDetail::Search {
            query: string_field(Some(input), "query")?,
            matches: None,
            output: None,
        }),
        "todowrite" => Some(ToolDetail::Todo {
            items: todo_items(input.get("todos"))?,
        }),
        "task" | "agent" => Some(ToolDetail::Agent {
            description: string_field(Some(input), "description").unwrap_or_else(|| "Subagent".into()),
            agent_type: string_field(Some(input), "subagent_type"),
            prompt: raw(input, "prompt").map(str::to_string),
            output: None,
        }),
        "exitplanmode" => Some(ToolDetail::Plan {
            text: raw(input, "plan")?.to_string(),
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
    if super::crew_call(name, input).map(|(verb, _)| verb) == Some("message_agent") {
        return None;
    }
    let text = || Some(content.to_string()).filter(|body| !body.trim().is_empty());
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
            preview: text().map(|body| without_line_numbers(&body)),
        }),
        Some(ToolDetail::Search { query, matches, .. }) => Some(ToolDetail::Search {
            query,
            matches,
            output: text(),
        }),
        Some(ToolDetail::Fetch { url, title, .. }) => Some(ToolDetail::Fetch { url, title, output: text() }),
        Some(ToolDetail::Agent { description, agent_type, prompt, .. }) => Some(ToolDetail::Agent {
            description,
            agent_type,
            prompt,
            output: text().map(|report| subagent_report(&report)),
        }),
        Some(ToolDetail::Mcp { server, tool, input, .. }) => Some(ToolDetail::Mcp {
            server,
            tool,
            input,
            output: text(),
        }),
        // An edit's result is "the file was updated"; a checklist's is "todos
        // modified"; a plan's is the approval. The row already holds more.
        Some(_) => None,
        None => text().map(|text| ToolDetail::Output { text }),
    }
}

/// Read answers `cat -n` style, `     1\t# title`, and the row already says
/// which lines it read. The numbers go when every line carries one; a file
/// that happens to start a line with digits and a tab is left as it is.
fn without_line_numbers(body: &str) -> String {
    let numbered = |line: &str| {
        let digits = line.trim_start();
        let tab = digits.find(['\t', '→']);
        tab.is_some_and(|at| at > 0 && digits[..at].chars().all(|c| c.is_ascii_digit()))
    };
    let lines: Vec<&str> = body.lines().collect();
    if lines.is_empty() || !lines.iter().all(|line| numbered(line)) {
        return body.to_string();
    }
    lines
        .iter()
        .map(|line| {
            let digits = line.trim_start();
            let at = digits.find(['\t', '→']).unwrap_or(0);
            &digits[at + digits[at..].chars().next().map_or(0, char::len_utf8)..]
        })
        .collect::<Vec<_>>()
        .join("\n")
}

/// A string argument exactly as sent: `string_field` trims, and a diff of
/// trimmed text shows changes that were never made.
fn raw<'a>(input: &'a Map<String, Value>, key: &str) -> Option<&'a str> {
    input.get(key).and_then(Value::as_str)
}

fn hunk(input: &Map<String, Value>, before: &str, after: &str) -> Option<EditHunk> {
    let before = raw(input, before).unwrap_or_default();
    let after = raw(input, after).unwrap_or_default();
    (!before.is_empty() || !after.is_empty()).then(|| EditHunk {
        before: before.to_string(),
        after: after.to_string(),
    })
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
    use crew_protocol::{HarnessEvent, TodoItem, TodoStatus, ToolDetail};
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
                    preview: Some("use std::fmt;".into()),
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
                hunks: Some(vec![EditHunk {
                    before: "  return prefs.hidden.includes(key);".into(),
                    after: "  const set = hiddenSet(prefs);\n  return set.has(key);".into(),
                }]),
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
                hunks: Some(vec![EditHunk {
                    before: String::new(),
                    after: "one\ntwo\nthree".into(),
                }]),
            })
        );
    }

    #[test]
    fn a_read_shows_the_file_without_the_line_numbers_it_came_with() {
        assert_eq!(without_line_numbers("1\t# ask\n2\t"), "# ask\n");
        assert_eq!(without_line_numbers("   9\tfn a() {}\n  10\t}"), "fn a() {}\n}");
        assert_eq!(without_line_numbers("12→const a = 1;"), "const a = 1;");
        // Not every line numbered: the file's own text.
        assert_eq!(without_line_numbers("1\tone\nplain"), "1\tone\nplain");
    }

    #[test]
    fn a_checklist_reads_as_its_items() {
        let input = json!({ "todos": [
            { "content": "Ship it", "status": "pending", "activeForm": "Shipping it" },
            { "content": "Test it", "status": "in_progress", "activeForm": "Testing it" },
            { "content": "Write it", "status": "completed", "activeForm": "Writing it" },
        ] });
        assert_eq!(
            tool_details(&[tool_use("TodoWrite", input)]),
            vec![Some(ToolDetail::Todo {
                items: vec![
                    TodoItem { text: "Ship it".into(), status: TodoStatus::Pending },
                    TodoItem { text: "Test it".into(), status: TodoStatus::InProgress },
                    TodoItem { text: "Write it".into(), status: TodoStatus::Completed },
                ]
            })]
        );
    }

    #[test]
    fn a_tool_with_nothing_to_show_stays_none() {
        assert_eq!(tool_details(&[tool_use("Skill", json!({ "skill": "simplify" }))]), vec![None]);
    }

    /// The row that read `[` because it showed the first line of a JSON result:
    /// an MCP call names its server and tool, and keeps its answer for the body.
    #[test]
    fn an_mcp_call_names_its_server_and_keeps_what_it_answered() {
        let got = tool_details(&[
            tool_use("mcp__chrome-devtools__take_snapshot", json!({ "verbose": true })),
            tool_result("[\n  {\"uid\": 1}\n]"),
        ]);
        assert_eq!(
            got.last().cloned().flatten(),
            Some(ToolDetail::Mcp {
                server: "chrome-devtools".into(),
                tool: "take_snapshot".into(),
                input: Some("{\n  \"verbose\": true\n}".into()),
                output: Some("[\n  {\"uid\": 1}\n]".into()),
            })
        );
        assert_eq!(
            tool_label("mcp__chrome-devtools__take_snapshot", &Map::new()),
            "chrome-devtools · take snapshot"
        );
        assert_eq!(tool_label("mcp__claude_ai_Notion__notion-fetch", &Map::new()), "Notion · notion fetch");
    }

    #[test]
    fn a_subagent_shows_what_it_was_asked_and_what_it_said() {
        let input = json!({ "description": "Find the parser", "subagent_type": "Explore", "prompt": "Where is it?" });
        let got = tool_details(&[tool_use("Task", input.clone()), tool_result("In src/parse.rs")]);
        assert_eq!(
            got.last().cloned().flatten(),
            Some(ToolDetail::Agent {
                description: "Find the parser".into(),
                agent_type: Some("Explore".into()),
                prompt: Some("Where is it?".into()),
                output: Some("In src/parse.rs".into()),
            })
        );
        assert_eq!(tool_label("Task", input.as_object().unwrap()), "Find the parser");
    }

    #[test]
    fn a_multiedit_keeps_every_hunk_and_counts_them_all() {
        let input = json!({ "file_path": "/w/a.ts", "edits": [
            { "old_string": "a", "new_string": "b\nc" },
            { "old_string": "d\ne", "new_string": "f" },
        ] });
        assert_eq!(
            tool_detail("MultiEdit", input.as_object().unwrap()),
            Some(ToolDetail::Edit {
                path: "/w/a.ts".into(),
                added: Some(3),
                removed: Some(3),
                hunks: Some(vec![
                    EditHunk { before: "a".into(), after: "b\nc".into() },
                    EditHunk { before: "d\ne".into(), after: "f".into() },
                ]),
            })
        );
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
            Some(ToolDetail::Search { query: "ToolDetail".into(), matches: None, output: None })
        );
        let fetch = json!({ "url": "https://example.com", "prompt": "what is this" });
        assert_eq!(
            tool_detail("WebFetch", fetch.as_object().unwrap()),
            Some(ToolDetail::Fetch { url: "https://example.com".into(), title: None, output: None })
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
    fn a_message_to_another_bot_reads_as_the_message() {
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
}
