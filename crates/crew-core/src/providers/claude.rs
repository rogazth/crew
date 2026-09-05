use std::collections::HashMap;

use crew_protocol::{ApprovalDecision, Question, QuestionOption, TurnUsage};
use serde_json::{json, Map, Value};

use super::runtime::{Autonomy, InlineImage, ProviderRuntime, TurnInput};
use super::{as_record, as_record_owned, clip, finite_number, leaf, string_field};

pub use super::{parse_json_line, try_parse_json_record};

pub struct ClaudeRuntime;

impl ProviderRuntime for ClaudeRuntime {
    fn send(&self, _input: TurnInput, _on_event: &dyn Fn(crew_protocol::HarnessEvent)) -> Result<(), String> {
        Err("turn driver not wired".into())
    }
    fn cancel(&self, _session_id: &str) {}
    fn stop(&self, _session_id: &str) {}
    fn respond_approval(&self, _session_id: &str, _request_id: u64, _decision: ApprovalDecision) {}
    fn respond_question(
        &self,
        _session_id: &str,
        _request_id: u64,
        _answers: Option<HashMap<String, String>>,
    ) {
    }
    fn is_live(&self, _session_id: &str) -> bool {
        false
    }
}

#[derive(Clone, Debug, PartialEq)]
pub struct ClaudeSpawn {
    pub model: Option<String>,
    pub resume: Option<String>,
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
    if let Some(resume) = input.resume.as_deref().filter(|r| !r.is_empty()) {
        args.push("--resume".into());
        args.push(resume.into());
    } else if let Some(session_id) = input.session_id.as_deref().filter(|s| !s.is_empty()) {
        args.push("--session-id".into());
        args.push(session_id.into());
    }
    if let Some(mcp) = input.mcp_config.as_deref().filter(|c| !c.is_empty()) {
        args.push("--mcp-config".into());
        args.push(mcp.into());
    }
    args
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
    let body = if job.is_empty() {
        format!("You are {who}. {rules}")
    } else {
        format!("You are {who}. {job}\n\n{rules}")
    };
    match tools {
        Some(tools) if !tools.is_empty() => format!("{body}\n\n{tools}"),
        _ => body,
    }
}

pub fn build_claude_user_message(
    session_id: &str,
    text: &str,
    files: &[String],
    images: &[InlineImage],
) -> Value {
    let body = with_attached_paths(text.trim(), files);
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
            })
        })
        .collect()
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
            let subject = string_field(Some(input), "name")
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
    use serde_json::json;

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
}
