//! Cursor as Crew drives it: one `cursor-agent acp` per session turn, spoken
//! to in the Agent Client Protocol (JSON-RPC 2.0, one message per line) over
//! its stdio. This module is the protocol: the requests Crew sends, the
//! agent's requests it answers, and the updates it reads, turned into what the
//! transcript shows. The driver that holds the process is `turns/cursor.rs`.
//!
//! Measured against cursor-agent 2026.10.01 (plan §7e.6). A user's own
//! terminal still runs the `cursor-agent` TUI; only bots and children go
//! through here.

use std::collections::HashMap;

use crew_protocol::{ApprovalDecision, EditHunk, Question, QuestionOption, ToolDetail, ToolStatus};
use serde_json::{json, Map, Value};

use super::runtime::Autonomy;
use super::{as_record, clip, crew_label, crew_tool_detail, leaf, mcp_label, pretty_input, string_field, todo_items};

pub use super::persona_prompt;

/// The name Crew's MCP server goes by in `session/new`: the namespace the
/// model finds its tools under, and the `providerIdentifier` of its calls.
pub const CREW_SERVER: &str = "crew";

pub struct CursorSpawn {
    pub model: Option<String>,
    pub autonomy: Autonomy,
}

/// `cursor-agent [--model m] [--force | --auto-review] acp`. The model goes on
/// argv rather than through `session/set_config_option`: argv takes the ids
/// Crew's model list names (`gpt-5.6-sol-medium`), ACP only its own
/// (`gpt-5.6-sol`). `--yolo` is not honoured in ACP mode; `--force` is.
pub fn build_cursor_spawn_args(input: &CursorSpawn) -> Vec<String> {
    let mut args = Vec::new();
    if let Some(model) = input.model.as_deref().filter(|m| !m.is_empty()) {
        args.push("--model".into());
        args.push(model.into());
    }
    match input.autonomy {
        Autonomy::Full => args.push("--force".into()),
        Autonomy::Auto => args.push("--auto-review".into()),
        Autonomy::Ask | Autonomy::Edits => {}
    }
    args.push("acp".into());
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

/// ACP has no system channel, so a bot's turn is one document: persona, the
/// tail of the conversation, then what is being asked.
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

/// The handshake. Crew reads and writes no files and runs no terminals for
/// the agent: it does both itself.
pub fn initialize_params() -> Value {
    json!({
        "protocolVersion": 1,
        "clientCapabilities": { "fs": { "readTextFile": false, "writeTextFile": false }, "terminal": false },
        "clientInfo": { "name": "crew", "version": env!("CARGO_PKG_VERSION") },
    })
}

/// The login the user already has (`cursor-agent login`).
pub fn authenticate_params() -> Value {
    json!({ "methodId": "cursor_login" })
}

/// Crew's MCP server over stdio, with what it needs to reach the bridge. ACP
/// agents drop injected HTTP servers (T3 Code), and stdio is what the spike
/// proved.
pub fn mcp_servers(mcp: Option<&(String, Vec<String>)>, env: &[(String, String)]) -> Value {
    let Some((command, args)) = mcp else {
        return json!([]);
    };
    let env: Vec<Value> = env.iter().map(|(name, value)| json!({ "name": name, "value": value })).collect();
    json!([{ "name": CREW_SERVER, "command": command, "args": args, "env": env }])
}

/// `session/new`, or `session/load` of the conversation a child carries on.
pub fn session_request(cwd: &str, resume: Option<&str>, servers: &Value) -> (&'static str, Value) {
    match resume {
        Some(id) => ("session/load", json!({ "sessionId": id, "cwd": cwd, "mcpServers": servers })),
        None => ("session/new", json!({ "cwd": cwd, "mcpServers": servers })),
    }
}

pub fn new_session_id(result: &Value) -> Option<String> {
    result.get("sessionId").and_then(Value::as_str).map(str::to_string)
}

pub fn prompt_params(session_id: &str, text: &str) -> Value {
    json!({ "sessionId": session_id, "prompt": [{ "type": "text", "text": text }] })
}

pub fn cancel_params(session_id: &str) -> Value {
    json!({ "sessionId": session_id })
}

/// How `session/prompt` said the turn ended.
#[derive(Clone, Debug, PartialEq)]
pub enum TurnEnd {
    /// Done; with a note when it stopped short of done.
    Completed(Option<String>),
    Cancelled,
    Failed(String),
}

pub fn turn_end(result: &Value) -> TurnEnd {
    match result.get("stopReason").and_then(Value::as_str) {
        Some("cancelled") => TurnEnd::Cancelled,
        Some("refusal") => TurnEnd::Failed("The model refused to go on.".into()),
        Some("max_tokens") => TurnEnd::Completed(Some("Cursor stopped: the reply hit the model's output limit.".into())),
        Some("max_turn_requests") => {
            TurnEnd::Completed(Some("Cursor stopped: the turn hit its limit of model requests.".into()))
        }
        _ => TurnEnd::Completed(None),
    }
}

/// The message of a JSON-RPC error, with the detail ACP keeps in `data`
/// (`Invalid params` alone does not say the session was not found).
pub fn rpc_error_message(error: &Value) -> String {
    let message = error.get("message").and_then(Value::as_str).unwrap_or_default();
    let detail = error.pointer("/data/message").and_then(Value::as_str).unwrap_or_default();
    match (message.is_empty(), detail.is_empty()) {
        (true, true) => error.to_string(),
        (false, true) => message.to_string(),
        (true, false) => detail.to_string(),
        (false, false) => format!("{message}: {detail}"),
    }
}

/// The JSON-RPC error a request Crew does not take is answered with.
pub fn unsupported_error(method: &str) -> Value {
    json!({ "code": -32601, "message": format!("Method not found: {method}") })
}

/// A tool call as the updates have told it so far: `tool_call` opens it,
/// often with nothing but a placeholder title, and `tool_call_update`s fill
/// in what it is.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct AcpTool {
    pub id: String,
    pub kind: String,
    pub title: String,
    pub input: Map<String, Value>,
    pub path: Option<String>,
}

impl AcpTool {
    pub fn new(id: &str) -> Self {
        Self { id: id.to_string(), ..Self::default() }
    }

    /// Take what an update or a permission request says of the call.
    pub fn merge(&mut self, update: &Map<String, Value>) {
        if let Some(kind) = string_field(Some(update), "kind") {
            self.kind = kind;
        }
        if let Some(title) = string_field(Some(update), "title") {
            self.title = title;
        }
        if let Some(input) = update.get("rawInput").and_then(as_record).filter(|input| !input.is_empty()) {
            self.input = input.clone();
        }
        let path = update
            .get("locations")
            .and_then(Value::as_array)
            .and_then(|rows| rows.first())
            .and_then(as_record)
            .and_then(|row| string_field(Some(row), "path"));
        if path.is_some() {
            self.path = path;
        }
    }

    /// Enough is known to name the row: its arguments are in. An MCP call
    /// opens as `MCP: tool` with none, and says which tool in the next update.
    pub fn named(&self) -> bool {
        !self.input.is_empty()
    }

    /// An MCP call: the server, the tool, and its arguments.
    pub fn mcp(&self) -> Option<(String, String, Map<String, Value>)> {
        let server = string_field(Some(&self.input), "providerIdentifier")?;
        let tool = string_field(Some(&self.input), "toolName")?;
        let args = self.input.get("args").and_then(as_record).cloned().unwrap_or_default();
        Some((server, tool, args))
    }

    /// One of Crew's own tools. A permission request titles it
    /// `crew-crew: <tool>` (server, the server's own name, tool), an update
    /// `crew: <tool>`.
    pub fn is_crew(&self) -> bool {
        match self.mcp() {
            Some((server, ..)) => server == CREW_SERVER,
            None => self.title.starts_with("crew-") || self.title.starts_with("crew:"),
        }
    }

    fn path(&self) -> Option<String> {
        string_field(Some(&self.input), "path")
            .or_else(|| string_field(Some(&self.input), "file_path"))
            .or_else(|| self.path.clone())
    }

    fn search_kind(&self) -> &'static str {
        let title = self.title.to_ascii_lowercase();
        if title.starts_with("grep") {
            "grep"
        } else if title.starts_with("find") || title.starts_with("glob") {
            "glob"
        } else {
            "search"
        }
    }
}

/// The name a row goes by: the shared one where there is one (`bash`,
/// `edit`, `read`), `mcp__<server>__<tool>` for an MCP call.
pub fn tool_name(tool: &AcpTool) -> String {
    if let Some((server, name, _)) = tool.mcp() {
        return format!("mcp__{server}__{name}");
    }
    match tool.kind.as_str() {
        "execute" => "bash".into(),
        "edit" => "edit".into(),
        "read" => "read".into(),
        "delete" => "delete".into(),
        "move" => "move".into(),
        "fetch" => "webfetch".into(),
        "search" => tool.search_kind().into(),
        "think" => "think".into(),
        "switch_mode" => "switch_mode".into(),
        _ => match tool.title.split(':').next().map(str::trim) {
            Some(head) if !head.is_empty() && !head.contains(' ') => head.to_ascii_lowercase(),
            _ => "tool".into(),
        },
    }
}

/// Cursor's titles wrap commands and paths in backticks.
fn bare(title: &str) -> String {
    title.replace('`', "")
}

pub fn tool_label(tool: &AcpTool) -> String {
    if let Some((server, name, args)) = tool.mcp() {
        if server == CREW_SERVER {
            if let Some(label) = crew_label(&format!("mcp__crew__{name}"), &args) {
                return label;
            }
        }
        return mcp_label(&server, &name);
    }
    let query = string_field(Some(&tool.input), "pattern").or_else(|| string_field(Some(&tool.input), "query"));
    match tool.kind.as_str() {
        "execute" => match string_field(Some(&tool.input), "command") {
            Some(command) => clip(&command, 72),
            None => clip(&bare(&tool.title), 72),
        },
        "read" | "edit" | "delete" => {
            let verb = match tool.kind.as_str() {
                "read" => "Read",
                "edit" => "Edit",
                _ => "Delete",
            };
            match tool.path() {
                Some(path) => format!("{verb} {}", leaf(&path)),
                None => clip(&bare(&tool.title), 72),
            }
        }
        "search" => {
            let verb = match tool.search_kind() {
                "grep" => "Grep",
                "glob" => "Glob",
                _ => "Search",
            };
            match query {
                Some(query) => format!("{verb} {}", clip(&query, 40)),
                None => verb.into(),
            }
        }
        "fetch" => match string_field(Some(&tool.input), "url") {
            Some(url) => format!("Fetch {}", clip(&url, 60)),
            None => clip(&bare(&tool.title), 72),
        },
        _ if tool.title.is_empty() => "Tool".into(),
        _ => clip(&bare(&tool.title), 72),
    }
}

/// What a call did, from its arguments, its `rawOutput` and the `content`
/// of its last update (an edit's diff).
pub fn tool_detail(tool: &AcpTool, output: Option<&Map<String, Value>>, content: Option<&Value>) -> Option<ToolDetail> {
    if let Some((server, name, args)) = tool.mcp() {
        if server == CREW_SERVER {
            // Cursor hands back no result text, only `{success}`: the row of
            // a message still says whom it went to and what it said.
            return crew_tool_detail(&format!("mcp__crew__{name}"), &args);
        }
        return Some(ToolDetail::Mcp { server, tool: name, input: pretty_input(&args), output: None });
    }
    let text = |key: &str| {
        output
            .and_then(|row| row.get(key))
            .and_then(Value::as_str)
            .filter(|text| !text.is_empty())
            .map(str::to_string)
    };
    let count = |key: &str| output.and_then(|row| row.get(key)).and_then(Value::as_u64).map(|n| n as u32);
    match tool.kind.as_str() {
        "execute" => {
            let command = string_field(Some(&tool.input), "command")?;
            let printed = [text("stdout"), text("stderr")].into_iter().flatten().collect::<Vec<_>>().join("\n");
            Some(ToolDetail::Command {
                command,
                exit_code: output
                    .and_then(|row| row.get("exitCode"))
                    .and_then(Value::as_i64)
                    .map(|code| code as i32),
                output: Some(printed).filter(|text| !text.trim().is_empty()),
            })
        }
        "read" => Some(ToolDetail::File {
            path: tool.path()?,
            line_start: None,
            line_end: None,
            preview: text("content"),
        }),
        "edit" => Some(ToolDetail::Edit {
            path: tool.path()?,
            added: None,
            removed: None,
            hunks: edit_hunks(content),
        }),
        "search" => Some(ToolDetail::Search {
            query: string_field(Some(&tool.input), "pattern").or_else(|| string_field(Some(&tool.input), "query"))?,
            matches: count("totalMatches").or_else(|| count("totalFiles")),
            output: None,
        }),
        "fetch" => Some(ToolDetail::Fetch {
            url: string_field(Some(&tool.input), "url")?,
            title: None,
            output: None,
        }),
        _ => None,
    }
}

/// An edit's `diff` content. A new file comes as `-- /dev/null` before and
/// `++ b/<path>` then the text after; the markers are cursor's, not the file's.
fn edit_hunks(content: Option<&Value>) -> Option<Vec<EditHunk>> {
    let hunks: Vec<EditHunk> = content?
        .as_array()?
        .iter()
        .filter_map(as_record)
        .filter(|part| string_field(Some(part), "type").as_deref() == Some("diff"))
        .map(|part| {
            let before = part.get("oldText").and_then(Value::as_str).unwrap_or_default();
            let after = part.get("newText").and_then(Value::as_str).unwrap_or_default();
            let before = if before.starts_with("-- /dev/null") { "" } else { before };
            let after = match after.split_once('\n') {
                Some((head, rest)) if head.starts_with("++ b/") => rest,
                _ if after.starts_with("++ b/") => "",
                _ => after,
            };
            EditHunk { before: before.to_string(), after: after.to_string() }
        })
        .collect();
    (!hunks.is_empty()).then_some(hunks)
}

/// How a call ended, when this update ends it. A rejected or failed call
/// still says `completed`, with the reason in `rawOutput`.
pub fn tool_end(status: &str, output: Option<&Map<String, Value>>) -> Option<ToolStatus> {
    match status {
        "failed" => Some(ToolStatus::Failed),
        "completed" => {
            let failed = output.is_some_and(|row| {
                row.get("error").is_some_and(|v| !v.is_null())
                    || row.get("rejected").is_some_and(|v| v.as_bool() != Some(false) && !v.is_null())
                    || row.get("success").and_then(Value::as_bool) == Some(false)
                    || row.get("exitCode").and_then(Value::as_i64).is_some_and(|code| code != 0)
            });
            Some(if failed { ToolStatus::Failed } else { ToolStatus::Completed })
        }
        _ => None,
    }
}

/// The checklist of a `plan` update, as the todo row shows it.
pub fn plan_detail(update: &Map<String, Value>) -> Option<ToolDetail> {
    Some(ToolDetail::Todo { items: todo_items(update.get("entries"))? })
}

/// One question of `cursor/ask_question`, with the ids its answer goes back
/// under.
#[derive(Clone, Debug, PartialEq)]
pub struct AcpQuestion {
    pub id: String,
    pub question: Question,
    /// (option id, label)
    pub options: Vec<(String, String)>,
}

/// A request the agent makes of Crew, and how it is answered.
#[derive(Clone, Debug, PartialEq)]
pub enum CursorAsk {
    /// Something to allow or deny, shown as an approval card. `allow` and
    /// `reject` are the option ids that answer it; `allow-always` is never
    /// one of them.
    Approval { name: String, title: String, input: Value, allow: Option<String>, reject: Option<String> },
    /// Allowed at once, with this option: Crew's own tools, and edits under
    /// the edits autonomy.
    Allow(String),
    /// `cursor/ask_question`.
    Questions(Vec<AcpQuestion>),
    /// `cursor/create_plan`: accepted at once; the plan goes on its row.
    Plan { call_id: Option<String>, title: String, text: String },
    /// A request Crew does not take.
    Unsupported,
}

/// Read an agent request. `tools` are the calls the turn has seen, by id: a
/// permission request names its call, and the call's updates said what it is.
pub fn classify_request(method: &str, params: &Value, tools: &HashMap<String, AcpTool>, autonomy: &Autonomy) -> CursorAsk {
    match method {
        "session/request_permission" => {
            let call = params.get("toolCall").and_then(as_record);
            let id = string_field(call, "toolCallId").unwrap_or_default();
            let mut tool = tools.get(&id).cloned().unwrap_or_else(|| AcpTool::new(&id));
            // What the earlier updates said is the better name: the request
            // titles an MCP call `crew-crew: tool`.
            let named = tool.named();
            if let Some(call) = call {
                let mut call = call.clone();
                if named {
                    call.remove("title");
                }
                tool.merge(&call);
            }
            let option = |kind: &str| {
                params
                    .get("options")
                    .and_then(Value::as_array)?
                    .iter()
                    .filter_map(as_record)
                    .find(|row| string_field(Some(row), "kind").as_deref() == Some(kind))
                    .and_then(|row| string_field(Some(row), "optionId"))
            };
            let allow = option("allow_once");
            let reject = option("reject_once");
            if let Some(allow) = allow.clone() {
                if tool.is_crew() || (*autonomy == Autonomy::Edits && tool.kind == "edit") {
                    return CursorAsk::Allow(allow);
                }
            }
            let mut input = match tool.mcp() {
                Some((_, _, args)) => Value::Object(args),
                None => Value::Object(tool.input.clone()),
            };
            if let Some(path) = tool.path() {
                input["path"] = json!(path);
            }
            // Why it asks, when it says: "Shell allowlist is empty".
            let reason = call
                .and_then(|call| call.get("content"))
                .and_then(Value::as_array)
                .and_then(|parts| parts.first())
                .and_then(|part| part.pointer("/content/text"))
                .and_then(Value::as_str)
                .filter(|text| !text.trim().is_empty() && !text.starts_with("```"));
            if let Some(reason) = reason {
                input["reason"] = json!(reason);
            }
            CursorAsk::Approval { name: tool_name(&tool), title: tool_label(&tool), input, allow, reject }
        }
        "cursor/ask_question" => CursorAsk::Questions(
            params
                .get("questions")
                .and_then(Value::as_array)
                .map(|rows| rows.iter().filter_map(ask_question).collect())
                .unwrap_or_default(),
        ),
        "cursor/create_plan" => {
            let name = string_field(as_record(params), "name");
            let text = params
                .get("plan")
                .and_then(Value::as_str)
                .map(str::to_string)
                .or_else(|| string_field(as_record(params), "overview"))
                .unwrap_or_default();
            CursorAsk::Plan {
                call_id: string_field(as_record(params), "toolCallId"),
                title: match name {
                    Some(name) => format!("Plan: {}", clip(&name, 60)),
                    None => "Plan".into(),
                },
                text,
            }
        }
        _ => CursorAsk::Unsupported,
    }
}

fn ask_question(row: &Value) -> Option<AcpQuestion> {
    let id = row.get("id")?.as_str()?.to_string();
    let prompt = row.get("prompt")?.as_str()?.trim().to_string();
    let options: Vec<(String, String)> = row
        .get("options")
        .and_then(Value::as_array)
        .map(|rows| {
            rows.iter()
                .filter_map(|option| {
                    Some((option.get("id")?.as_str()?.to_string(), option.get("label")?.as_str()?.to_string()))
                })
                .collect()
        })
        .unwrap_or_default();
    let question = Question {
        question: prompt.clone(),
        header: prompt,
        multi_select: row.get("allowMultiple").and_then(Value::as_bool).unwrap_or(false),
        options: options
            .iter()
            .map(|(_, label)| QuestionOption { label: label.clone(), description: None })
            .collect(),
    };
    Some(AcpQuestion { id, question, options })
}

/// The answer to `session/request_permission`: the option picked, or
/// `cancelled` when there is none to pick (the turn is being stopped).
pub fn permission_response(option: Option<&str>) -> Value {
    match option {
        Some(option) => json!({ "outcome": { "outcome": "selected", "optionId": option } }),
        None => json!({ "outcome": { "outcome": "cancelled" } }),
    }
}

/// Crew's decision as the option that carries it. "Always" is allowed once:
/// `allow-always` writes the user's global `~/.cursor/cli-config.json`.
pub fn permission_answer(decision: &ApprovalDecision, allow: Option<&str>, reject: Option<&str>) -> Value {
    permission_response(match decision {
        ApprovalDecision::Allow | ApprovalDecision::Always => allow,
        ApprovalDecision::Deny => reject,
    })
}

/// `cursor/create_plan`, taken as written.
pub fn plan_accepted() -> Value {
    json!({ "outcome": { "outcome": "accepted" } })
}

/// The answer to `cursor/ask_question`. Crew's answers are keyed by the
/// question's text and name an option by its label (several, comma-separated,
/// for a multi-select); Cursor's go back by id. An answer in words that names
/// no option goes back as a skip that carries the words, which the model
/// reads. Dismissed, the questions are skipped.
pub fn questions_response(questions: &[AcpQuestion], answers: Option<&HashMap<String, String>>) -> Value {
    let Some(answers) = answers else {
        return json!({ "outcome": { "outcome": "skipped", "reason": "The user skipped the questions." } });
    };
    let mut picked = Vec::new();
    let mut words = Vec::new();
    let mut in_words = false;
    for question in questions {
        let answer = answers
            .get(&question.question.question)
            .or_else(|| answers.get(&question.id))
            .or_else(|| (questions.len() == 1 && answers.len() == 1).then(|| answers.values().next()).flatten());
        let Some(answer) = answer else { continue };
        words.push(format!("{}: {answer}", question.question.question));
        let parts: Vec<&str> = if question.question.multi_select {
            answer.split(',').map(str::trim).filter(|part| !part.is_empty()).collect()
        } else {
            vec![answer.trim()]
        };
        let ids: Vec<String> = parts
            .iter()
            .filter_map(|part| {
                question
                    .options
                    .iter()
                    .find(|(_, label)| label.trim().eq_ignore_ascii_case(part))
                    .map(|(id, _)| id.clone())
            })
            .collect();
        if ids.len() == parts.len() && !ids.is_empty() {
            picked.push(json!({ "questionId": question.id, "selectedOptionIds": ids }));
        } else {
            in_words = true;
        }
    }
    if in_words {
        let reason = format!("The user answered in their own words. {}", words.join(" · "));
        return json!({ "outcome": { "outcome": "skipped", "reason": reason } });
    }
    if picked.is_empty() {
        return json!({ "outcome": { "outcome": "skipped", "reason": "The user skipped the questions." } });
    }
    json!({ "outcome": { "outcome": "answered", "answers": picked } })
}

/// `cursor/ask_question` with the turn being stopped.
pub fn questions_cancelled() -> Value {
    json!({ "outcome": { "outcome": "cancelled" } })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tool(update: Value) -> AcpTool {
        let update = update.as_object().unwrap();
        let mut tool = AcpTool::new(update["toolCallId"].as_str().unwrap());
        tool.merge(update);
        tool
    }

    fn permission(call: Value) -> Value {
        json!({
            "sessionId": "s",
            "toolCall": call,
            "options": [
                { "optionId": "allow-once", "name": "Allow once", "kind": "allow_once" },
                { "optionId": "allow-always", "name": "Allow always", "kind": "allow_always" },
                { "optionId": "reject-once", "name": "Reject", "kind": "reject_once" }
            ]
        })
    }

    #[test]
    fn autonomy_and_model_go_on_argv_before_acp() {
        let args = |autonomy| build_cursor_spawn_args(&CursorSpawn { model: Some("gpt-5.6-sol-medium".into()), autonomy });
        assert_eq!(args(Autonomy::Full), ["--model", "gpt-5.6-sol-medium", "--force", "acp"]);
        assert_eq!(args(Autonomy::Auto), ["--model", "gpt-5.6-sol-medium", "--auto-review", "acp"]);
        assert_eq!(args(Autonomy::Ask), ["--model", "gpt-5.6-sol-medium", "acp"]);
        assert_eq!(build_cursor_spawn_args(&CursorSpawn { model: None, autonomy: Autonomy::Edits }), ["acp"]);
    }

    #[test]
    fn crews_server_goes_over_stdio_with_its_env() {
        let servers = mcp_servers(
            Some(&("/bin/crewd".into(), vec!["--mcp".into()])),
            &[("CREW_SOCKET".into(), "/s".into()), ("CREW_TOKEN".into(), "t".into())],
        );
        assert_eq!(
            servers,
            json!([{ "name": "crew", "command": "/bin/crewd", "args": ["--mcp"], "env": [
                { "name": "CREW_SOCKET", "value": "/s" }, { "name": "CREW_TOKEN", "value": "t" }
            ] }])
        );
        let (method, params) = session_request("/w", Some("acp-1"), &servers);
        assert_eq!((method, params["sessionId"].clone(), params["cwd"].clone()), ("session/load", json!("acp-1"), json!("/w")));
        let (method, params) = session_request("/w", None, &json!([]));
        assert_eq!(method, "session/new");
        assert!(params.get("sessionId").is_none());
    }

    #[test]
    fn a_turn_ends_the_way_the_prompt_answer_says() {
        assert_eq!(turn_end(&json!({ "stopReason": "end_turn" })), TurnEnd::Completed(None));
        assert_eq!(turn_end(&json!({ "stopReason": "cancelled" })), TurnEnd::Cancelled);
        assert!(matches!(turn_end(&json!({ "stopReason": "refusal" })), TurnEnd::Failed(_)));
        assert!(matches!(turn_end(&json!({ "stopReason": "max_tokens" })), TurnEnd::Completed(Some(_))));
        let missing = json!({ "code": -32602, "message": "Invalid params", "data": { "message": "Session \"x\" not found" } });
        assert_eq!(rpc_error_message(&missing), "Invalid params: Session \"x\" not found");
    }

    /// The approval card never offers `allow-always` back to Cursor: "always"
    /// in Crew is "allow once" there, because the other writes the user's
    /// global config.
    #[test]
    fn a_permission_is_a_card_whose_answer_is_never_allow_always() {
        let tools = HashMap::new();
        let shell = permission(json!({
            "toolCallId": "t1", "title": "`touch made.txt`", "kind": "execute", "status": "pending",
            "rawInput": { "command": "touch made.txt" },
            "content": [{ "type": "content", "content": { "type": "text", "text": "Shell allowlist is empty" } }]
        }));
        let CursorAsk::Approval { name, title, input, allow, reject } = classify_request("session/request_permission", &shell, &tools, &Autonomy::Ask) else {
            panic!("not an approval")
        };
        assert_eq!((name.as_str(), title.as_str()), ("bash", "touch made.txt"));
        assert_eq!(input, json!({ "command": "touch made.txt", "reason": "Shell allowlist is empty" }));
        let (allow, reject) = (allow.as_deref(), reject.as_deref());
        for decision in [ApprovalDecision::Allow, ApprovalDecision::Always] {
            assert_eq!(permission_answer(&decision, allow, reject)["outcome"]["optionId"], "allow-once");
        }
        assert_eq!(permission_answer(&ApprovalDecision::Deny, allow, reject)["outcome"]["optionId"], "reject-once");
        assert_eq!(permission_response(None), json!({ "outcome": { "outcome": "cancelled" } }));
    }

    /// Crew's own tools are pre-approved (§7e.5): known by the call's earlier
    /// update, or by the `crew-` the request titles it with.
    #[test]
    fn crews_own_calls_and_edits_under_edits_are_allowed_at_once() {
        let mut tools = HashMap::new();
        let call = tool(json!({ "toolCallId": "m1", "title": "crew: list_agents", "rawInput": {
            "providerIdentifier": "crew", "toolName": "list_agents", "args": {} } }));
        tools.insert("m1".to_string(), call);
        let asked = permission(json!({ "toolCallId": "m1", "title": "crew-crew: list_agents", "kind": "other" }));
        assert_eq!(classify_request("session/request_permission", &asked, &tools, &Autonomy::Ask), CursorAsk::Allow("allow-once".into()));
        let unseen = permission(json!({ "toolCallId": "m2", "title": "crew-crew: list_routines", "kind": "other" }));
        assert_eq!(classify_request("session/request_permission", &unseen, &tools, &Autonomy::Ask), CursorAsk::Allow("allow-once".into()));

        let other = permission(json!({ "toolCallId": "m3", "title": "spike-echo: echo", "kind": "other" }));
        tools.insert("m3".into(), tool(json!({ "toolCallId": "m3", "title": "spike: echo", "rawInput": {
            "providerIdentifier": "spike", "toolName": "echo", "args": { "text": "hi" } } })));
        let CursorAsk::Approval { name, title, input, .. } = classify_request("session/request_permission", &other, &tools, &Autonomy::Ask) else {
            panic!("someone else's MCP tool asks")
        };
        assert_eq!((name.as_str(), title.as_str(), input), ("mcp__spike__echo", "spike · echo", json!({ "text": "hi" })));

        let edit = permission(json!({ "toolCallId": "e1", "title": "Edit `/w/b.txt`", "kind": "edit", "locations": [{ "path": "/w/b.txt" }] }));
        assert_eq!(classify_request("session/request_permission", &edit, &tools, &Autonomy::Edits), CursorAsk::Allow("allow-once".into()));
        let CursorAsk::Approval { title, .. } = classify_request("session/request_permission", &edit, &tools, &Autonomy::Ask) else {
            panic!("an edit under ask asks")
        };
        assert_eq!(title, "Edit b.txt");
    }

    #[test]
    fn questions_go_out_by_label_and_come_back_by_id() {
        let asked = json!({ "toolCallId": "q", "title": "Config", "questions": [
            { "id": "fmt", "prompt": "Which format?", "allowMultiple": false, "options": [
                { "id": "a", "label": "JSON" }, { "id": "b", "label": "YAML" } ] },
            { "id": "extras", "prompt": "Extras?", "allowMultiple": true, "options": [
                { "id": "x", "label": "Comments" }, { "id": "y", "label": "Schema" } ] }
        ] });
        let CursorAsk::Questions(questions) = classify_request("cursor/ask_question", &asked, &HashMap::new(), &Autonomy::Ask) else {
            panic!("not questions")
        };
        assert_eq!(questions[0].question.question, "Which format?");
        assert_eq!(questions[0].question.options[1].label, "YAML");
        assert!(questions[1].question.multi_select);
        let answers: HashMap<String, String> =
            [("Which format?".to_string(), "yaml".to_string()), ("Extras?".to_string(), "Comments, Schema".to_string())].into();
        assert_eq!(
            questions_response(&questions, Some(&answers)),
            json!({ "outcome": { "outcome": "answered", "answers": [
                { "questionId": "fmt", "selectedOptionIds": ["b"] },
                { "questionId": "extras", "selectedOptionIds": ["x", "y"] }
            ] } })
        );
        // Words that name no option reach the model as words.
        let free: HashMap<String, String> = [("Which format?".to_string(), "INI, please".to_string())].into();
        let out = questions_response(&questions, Some(&free));
        assert_eq!(out["outcome"]["outcome"], "skipped");
        assert!(out["outcome"]["reason"].as_str().unwrap().contains("Which format?: INI, please"), "{out}");
        assert_eq!(questions_response(&questions, None)["outcome"]["outcome"], "skipped");
        assert_eq!(questions_cancelled(), json!({ "outcome": { "outcome": "cancelled" } }));
    }

    #[test]
    fn a_plan_is_accepted_and_kept() {
        let asked = json!({ "toolCallId": "p1", "name": "Add hello.txt", "overview": "One file.", "plan": "# Add hello.txt\n\nhi", "todos": [] });
        assert_eq!(
            classify_request("cursor/create_plan", &asked, &HashMap::new(), &Autonomy::Ask),
            CursorAsk::Plan { call_id: Some("p1".into()), title: "Plan: Add hello.txt".into(), text: "# Add hello.txt\n\nhi".into() }
        );
        assert_eq!(plan_accepted(), json!({ "outcome": { "outcome": "accepted" } }));
        assert_eq!(classify_request("fs/read_text_file", &json!({}), &HashMap::new(), &Autonomy::Ask), CursorAsk::Unsupported);
    }

    /// The calls of the spike's turns (cursor-agent 2026.10.01), each read as
    /// what it did.
    #[test]
    fn a_turns_calls_read_as_what_they_did() {
        let shell = tool(json!({ "toolCallId": "t", "title": "`sleep 1 && echo done`", "kind": "execute", "rawInput": { "command": "sleep 1 && echo done" } }));
        assert_eq!((tool_name(&shell), tool_label(&shell)), ("bash".to_string(), "sleep 1 && echo done".to_string()));
        let out = json!({ "exitCode": 1, "stdout": "done\n", "stderr": "" });
        assert_eq!(
            tool_detail(&shell, out.as_object(), None),
            Some(ToolDetail::Command { command: "sleep 1 && echo done".into(), exit_code: Some(1), output: Some("done\n".into()) })
        );
        assert_eq!(tool_end("completed", out.as_object()), Some(ToolStatus::Failed));
        assert_eq!(tool_end("completed", json!({ "rejected": true }).as_object()), Some(ToolStatus::Failed));
        assert_eq!(tool_end("completed", json!({ "success": true }).as_object()), Some(ToolStatus::Completed));
        assert_eq!(tool_end("in_progress", None), None);

        let mut edit = tool(json!({ "toolCallId": "e", "title": "Edit File", "kind": "edit", "rawInput": {} }));
        assert!(!edit.named());
        edit.merge(json!({ "title": "Edit `/w/b.txt`", "rawInput": { "path": "/w/b.txt" }, "locations": [{ "path": "/w/b.txt" }] }).as_object().unwrap());
        let diff = json!([{ "type": "diff", "path": "/w/b.txt", "oldText": "-- /dev/null", "newText": "++ b//w/b.txt\nx" }]);
        assert_eq!(
            tool_detail(&edit, None, Some(&diff)),
            Some(ToolDetail::Edit { path: "/w/b.txt".into(), added: None, removed: None, hunks: Some(vec![EditHunk { before: String::new(), after: "x".into() }]) })
        );
        assert_eq!(tool_label(&edit), "Edit b.txt");

        let grep = tool(json!({ "toolCallId": "g", "title": "grep \"ask\"", "kind": "search", "rawInput": { "pattern": "ask", "path": "/w" } }));
        assert_eq!((tool_name(&grep), tool_label(&grep)), ("grep".to_string(), "Grep ask".to_string()));
        assert!(matches!(tool_detail(&grep, json!({ "totalMatches": 3 }).as_object(), None), Some(ToolDetail::Search { matches: Some(3), .. })));

        let read = tool(json!({ "toolCallId": "r", "title": "Read b.txt", "kind": "read", "rawInput": { "path": "/w/b.txt" } }));
        assert_eq!(tool_detail(&read, json!({ "content": "x" }).as_object(), None), Some(ToolDetail::File { path: "/w/b.txt".into(), line_start: None, line_end: None, preview: Some("x".into()) }));

        let message = tool(json!({ "toolCallId": "m", "title": "crew: message_agent", "kind": "other", "rawInput": {
            "providerIdentifier": "crew", "toolName": "message_agent", "args": { "to": "abc", "text": "green" } } }));
        assert_eq!(tool_name(&message), "mcp__crew__message_agent");
        assert_eq!(tool_label(&message), "Crew message agent abc");
        let echo = tool(json!({ "toolCallId": "s", "title": "spike: echo", "kind": "other", "rawInput": {
            "providerIdentifier": "spike", "toolName": "echo", "args": { "text": "hi" } } }));
        assert!(matches!(tool_detail(&echo, None, None), Some(ToolDetail::Mcp { ref server, .. }) if server == "spike"));
    }

    #[test]
    fn a_plan_update_is_a_checklist() {
        let update = json!({ "sessionUpdate": "plan", "entries": [
            { "content": "Add hello.txt", "priority": "medium", "status": "completed" },
            { "content": "Check it", "priority": "medium", "status": "pending" } ] });
        let Some(ToolDetail::Todo { items }) = plan_detail(update.as_object().unwrap()) else { panic!("todo") };
        assert_eq!(items.len(), 2);
        assert_eq!(items[0].status, crew_protocol::TodoStatus::Completed);
    }
}
