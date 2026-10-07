//! Codex as Crew drives it: one `codex app-server` per session turn, spoken to
//! in JSON-RPC over its stdio (newline-delimited, no `jsonrpc` header). This
//! module is the protocol: the requests Crew sends, the server's requests it
//! answers, and the items it reads, turned into what the transcript shows.
//! The driver that holds the process is `turns/codex.rs`.
//!
//! Measured against codex-cli 0.160.0. A user's own terminal still runs the
//! `codex` TUI; only bots and children go through here.

use std::collections::HashMap;

use crew_protocol::{ApprovalDecision, AttachedFile, Question, QuestionOption, ToolDetail};
use serde_json::{json, Map, Value};

use super::runtime::Autonomy;
use super::{as_record, clip, leaf, mcp_label, pretty_input, string_field, todo_items, unwrap_shell};

pub use super::parse_json_line;

/// How long Codex lets one call to Crew's MCP server run: 65 minutes, past
/// the 60 a `wait` may take (plan §7e.2). Codex's own default is a minute.
pub const MCP_TOOL_TIMEOUT_SEC: u64 = 3900;

/// The key Crew's instructions travel under in `turn/start`'s
/// `additionalContext`.
pub const CONTEXT_KEY: &str = "crew";

/// The `-c` overrides that start Crew's MCP server under codex, with the
/// environment it needs to reach the bridge. For the TUI a user runs in a
/// terminal: codex takes them on the root command.
///
/// Codex does not hand an MCP server the environment it was started with —
/// its own servers declare `env` in config.toml for the same reason — and
/// `crew --mcp` exits at once without CREW_SOCKET.
pub fn codex_mcp_overrides(command: &str, mcp_args: &[String], env: &[(String, String)]) -> Vec<String> {
    let mut args = vec![
        "-c".to_string(),
        format!(
            "mcp_servers.crew.command={}",
            serde_json::to_string(command).unwrap_or_else(|_| "\"\"".into())
        ),
        "-c".to_string(),
        format!(
            "mcp_servers.crew.args={}",
            serde_json::to_string(mcp_args).unwrap_or_else(|_| "[]".into())
        ),
    ];
    if !env.is_empty() {
        let pairs = env
            .iter()
            .map(|(key, value)| {
                format!("{key}={}", serde_json::to_string(value).unwrap_or_else(|_| "\"\"".into()))
            })
            .collect::<Vec<_>>()
            .join(",");
        args.push("-c".into());
        args.push(format!("mcp_servers.crew.env={{{pairs}}}"));
    }
    args
}

/// What a session's thread is opened with, fresh or resumed.
pub struct CodexThread {
    pub cwd: String,
    /// A thread to carry on (`thread/resume`), for a child session. The id
    /// `codex exec` gave is the same thread id, so older children resume too.
    pub resume: Option<String>,
    pub model: Option<String>,
    /// `model_reasoning_effort`; `None` is the CLI's own.
    pub effort: Option<String>,
    /// `service_tier`; `None` is the CLI's own. `default` is Standard.
    pub service_tier: Option<String>,
    pub autonomy: Autonomy,
    /// Crew's MCP server: the command and its arguments.
    pub mcp: Option<(String, Vec<String>)>,
    /// What `crew --mcp` needs in its own environment to reach the bridge.
    pub mcp_env: Vec<(String, String)>,
}

/// The handshake: Crew's name, and the experimental API that carries
/// `turn/steer`, `additionalContext` and the user-input requests.
pub fn initialize_params() -> Value {
    json!({
        "clientInfo": { "name": "crew", "title": "Crew", "version": env!("CARGO_PKG_VERSION") },
        "capabilities": {
            "experimentalApi": true,
            // A diff of the whole turn on every edit, which Crew never shows.
            "optOutNotificationMethods": ["turn/diff/updated"],
        },
    })
}

/// The approval policy and sandbox an autonomy runs under, the way the TUI's
/// flags set them: full is `--dangerously-bypass-approvals-and-sandbox`, auto
/// is `--approve-for-me` (Codex's own reviewer answers), and the rest work in
/// the workspace and ask Crew for anything past it.
pub fn access(autonomy: &Autonomy) -> (&'static str, &'static str, Option<&'static str>) {
    match autonomy {
        Autonomy::Full => ("never", "danger-full-access", None),
        Autonomy::Auto => ("on-request", "workspace-write", Some("auto_review")),
        Autonomy::Edits | Autonomy::Ask => ("on-request", "workspace-write", None),
    }
}

/// `thread/start`, or `thread/resume` for a thread to carry on, with its params.
///
/// Crew's server rides on the thread's config, beside the user's own servers
/// (they merge): its env reaches the bridge, its calls may run as long as a
/// wait, and they never ask (plan §7e.5). The model goes again on a resume:
/// without it Codex falls back to the one in config.toml.
pub fn thread_request(input: &CodexThread) -> (&'static str, Value) {
    let (approval, sandbox, reviewer) = access(&input.autonomy);
    let mut config = Map::new();
    if let Some(effort) = input.effort.as_deref().filter(|e| !e.is_empty()) {
        config.insert("model_reasoning_effort".into(), json!(effort));
    }
    if let Some(tier) = input.service_tier.as_deref().filter(|tier| !tier.is_empty()) {
        config.insert("service_tier".into(), json!(tier));
    }
    // Without it `request_user_input` only exists in plan mode.
    config.insert("features.default_mode_request_user_input".into(), json!(true));
    if let Some((command, args)) = &input.mcp {
        let env: Map<String, Value> = input.mcp_env.iter().map(|(k, v)| (k.clone(), json!(v))).collect();
        config.insert(
            "mcp_servers".into(),
            json!({
                "crew": {
                    "command": command,
                    "args": args,
                    "env": env,
                    "tool_timeout_sec": MCP_TOOL_TIMEOUT_SEC,
                    "default_tools_approval_mode": "approve",
                }
            }),
        );
    }
    let mut params = Map::new();
    if let Some(model) = input.model.as_deref().filter(|m| !m.is_empty()) {
        params.insert("model".into(), json!(model));
    }
    params.insert("approvalPolicy".into(), json!(approval));
    params.insert("sandbox".into(), json!(sandbox));
    if let Some(reviewer) = reviewer {
        params.insert("approvalsReviewer".into(), json!(reviewer));
    }
    params.insert("config".into(), Value::Object(config));
    match input.resume.as_deref().filter(|id| !id.is_empty()) {
        Some(thread) => {
            params.insert("threadId".into(), json!(thread));
            // What was said is in the rollout and in Crew's transcript; the
            // answer need not carry it back.
            params.insert("excludeTurns".into(), json!(true));
            if !input.cwd.is_empty() {
                params.insert("cwd".into(), json!(input.cwd));
            }
            ("thread/resume", Value::Object(params))
        }
        None => {
            if !input.cwd.is_empty() {
                params.insert("cwd".into(), json!(input.cwd));
            }
            ("thread/start", Value::Object(params))
        }
    }
}

/// The id of the thread a `thread/start` or `thread/resume` answer opened.
pub fn thread_id(result: &Value) -> Option<String> {
    result.pointer("/thread/id").and_then(Value::as_str).map(str::to_string)
}

/// The id of the turn a `turn/start` answer began.
pub fn turn_id(result: &Value) -> Option<String> {
    result.pointer("/turn/id").and_then(Value::as_str).map(str::to_string)
}

/// A user message as Codex takes it.
pub fn text_input(text: &str) -> Value {
    json!([{ "type": "text", "text": text, "text_elements": [] }])
}

/// `turn/start`. The instructions go in `additionalContext` on every turn,
/// not in `developerInstructions`, which newer model catalogs override
/// (T3 Code found it; plan §7e.7).
pub fn turn_start_params(thread_id: &str, text: &str, instructions: Option<&str>) -> Value {
    let mut params = json!({ "threadId": thread_id, "input": text_input(text) });
    if let Some(instructions) = instructions.filter(|text| !text.trim().is_empty()) {
        params["additionalContext"] = json!({ CONTEXT_KEY: { "kind": "application", "value": instructions } });
    }
    params
}

/// `turn/steer`: the text goes into the turn that is running. Codex refuses
/// it (-32600) when that turn is over or another one runs.
pub fn steer_params(thread_id: &str, turn_id: &str, text: &str) -> Value {
    json!({ "threadId": thread_id, "expectedTurnId": turn_id, "input": text_input(text) })
}

pub fn interrupt_params(thread_id: &str, turn_id: &str) -> Value {
    json!({ "threadId": thread_id, "turnId": turn_id })
}

/// How a turn ended, from `turn/completed`.
#[derive(Clone, Debug, PartialEq)]
pub enum TurnEnd {
    Completed,
    Interrupted,
    Failed(String),
}

/// The turn a `turn/completed` is about, and how it ended.
pub fn turn_end(params: &Value) -> (Option<String>, TurnEnd) {
    let turn = params.get("turn");
    let id = turn.and_then(|turn| turn.get("id")).and_then(Value::as_str).map(str::to_string);
    let status = turn.and_then(|turn| turn.get("status")).and_then(Value::as_str);
    let error = turn
        .and_then(|turn| turn.pointer("/error/message"))
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|message| !message.is_empty())
        .map(str::to_string);
    let end = match (status, error) {
        (Some("interrupted"), _) => TurnEnd::Interrupted,
        (Some("failed"), error) => TurnEnd::Failed(error.unwrap_or_else(|| "Codex turn failed.".into())),
        (_, Some(error)) => TurnEnd::Failed(error),
        _ => TurnEnd::Completed,
    };
    (id, end)
}

/// The text of a user message item: what Crew sent, a steer included.
pub fn user_message_text(item: &Map<String, Value>) -> Option<String> {
    if string_field(Some(item), "type").as_deref() != Some("userMessage") {
        return None;
    }
    let parts = item.get("content")?.as_array()?;
    let text = parts
        .iter()
        .filter_map(|part| part.get("text").and_then(Value::as_str))
        .collect::<Vec<_>>()
        .join("\n");
    Some(text)
}

/// The checklist of `turn/plan/updated`, as the todo row shows it.
pub fn plan_detail(params: &Value) -> Option<ToolDetail> {
    let steps = params.get("plan")?.as_array()?;
    let rows: Vec<Value> = steps
        .iter()
        .filter_map(|step| {
            let text = step.get("step")?.as_str()?;
            let status = match step.get("status").and_then(Value::as_str) {
                Some("inProgress") => "in_progress",
                Some("completed") => "completed",
                _ => "pending",
            };
            Some(json!({ "content": text, "status": status }))
        })
        .collect();
    Some(ToolDetail::Todo { items: todo_items(Some(&Value::Array(rows)))? })
}

/// An app-server item in the shape `codex exec --json` gave the same item,
/// which is the shape the row helpers below read and the history decoder
/// builds from the rollout. `None` for an item that is not a tool call.
pub fn exec_item(item: &Map<String, Value>) -> Option<Map<String, Value>> {
    let kind = string_field(Some(item), "type")?;
    let mut out = Map::new();
    let copy = |out: &mut Map<String, Value>, from: &str, to: &str| {
        if let Some(value) = item.get(from).filter(|value| !value.is_null()) {
            out.insert(to.into(), value.clone());
        }
    };
    let exec_type = match kind.as_str() {
        "commandExecution" => {
            copy(&mut out, "command", "command");
            copy(&mut out, "aggregatedOutput", "aggregated_output");
            copy(&mut out, "exitCode", "exit_code");
            "command_execution"
        }
        "fileChange" => {
            let changes: Vec<Value> = item
                .get("changes")
                .and_then(Value::as_array)
                .map(|rows| {
                    rows.iter()
                        .map(|row| {
                            let kind = row
                                .pointer("/kind/type")
                                .or_else(|| row.get("kind"))
                                .and_then(Value::as_str)
                                .unwrap_or("update");
                            json!({ "path": row.get("path").cloned().unwrap_or(Value::Null), "kind": kind })
                        })
                        .collect()
                })
                .unwrap_or_default();
            out.insert("changes".into(), Value::Array(changes));
            "file_change"
        }
        "mcpToolCall" => {
            copy(&mut out, "server", "server");
            copy(&mut out, "tool", "tool");
            copy(&mut out, "arguments", "arguments");
            copy(&mut out, "result", "result");
            copy(&mut out, "error", "error");
            "mcp_tool_call"
        }
        "webSearch" => {
            copy(&mut out, "query", "query");
            "web_search"
        }
        "collabAgentToolCall" => {
            copy(&mut out, "tool", "tool");
            "collab_tool_call"
        }
        "imageView" => {
            copy(&mut out, "path", "path");
            "image_view"
        }
        "imageGeneration" => {
            copy(&mut out, "savedPath", "saved_path");
            copy(&mut out, "result", "result");
            copy(&mut out, "revisedPrompt", "revised_prompt");
            "image_generation"
        }
        _ => return None,
    };
    out.insert("type".into(), json!(exec_type));
    copy(&mut out, "id", "id");
    if let Some(status) = string_field(Some(item), "status") {
        let status = match status.as_str() {
            "inProgress" => "in_progress".to_string(),
            other => other.to_string(),
        };
        out.insert("status".into(), json!(status));
    }
    Some(out)
}

/// The name a Crew tool goes by in the shared helpers: `mcp__crew__<tool>`,
/// which is also how Codex shows it to the model. The item itself names the
/// server and the tool apart.
fn crew_name(item: &Map<String, Value>) -> Option<String> {
    if string_field(Some(item), "server").as_deref() != Some("crew") {
        return None;
    }
    string_field(Some(item), "tool").map(|tool| format!("mcp__crew__{tool}"))
}

/// A request the app server makes of Crew, and how it is answered.
#[derive(Clone, Debug, PartialEq)]
pub enum CodexAsk {
    /// Something to allow or deny, shown as an approval card.
    Approval { kind: ApprovalKind, name: String, title: String, input: Value },
    /// `request_user_input`: questions, each with the id its answer goes back under.
    Questions(Vec<(String, Question)>),
    /// Answered at once, without asking anyone.
    Reply(Value),
    /// A request Crew does not take.
    Unsupported,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ApprovalKind {
    Command,
    FileChange,
    Permissions,
    McpTool,
}

/// Read a server request. `items` are the items the turn has started, by id:
/// a file-change approval names only its item, and the item has the files.
pub fn classify_request(method: &str, params: &Value, items: &HashMap<String, Map<String, Value>>) -> CodexAsk {
    let reason = params.get("reason").and_then(Value::as_str).filter(|r| !r.trim().is_empty());
    match method {
        "item/commandExecution/requestApproval" => {
            let command = params.get("command").and_then(Value::as_str).map(unwrap_shell).unwrap_or_default();
            let mut input = json!({ "command": command });
            if let Some(cwd) = params.get("cwd").filter(|cwd| !cwd.is_null()) {
                input["cwd"] = cwd.clone();
            }
            if let Some(reason) = reason {
                input["reason"] = json!(reason);
            }
            let title = if command.is_empty() { "Command".to_string() } else { clip(&command, 72) };
            CodexAsk::Approval { kind: ApprovalKind::Command, name: "bash".into(), title, input }
        }
        "item/fileChange/requestApproval" => {
            let item = params
                .get("itemId")
                .and_then(Value::as_str)
                .and_then(|id| items.get(id))
                .and_then(exec_item);
            let title = item.as_ref().map(tool_label).unwrap_or_else(|| "Edit files".into());
            let paths: Vec<Value> = item
                .as_ref()
                .and_then(|item| item.get("changes"))
                .and_then(Value::as_array)
                .map(|rows| rows.iter().filter_map(|row| row.get("path").cloned()).collect())
                .unwrap_or_default();
            let mut input = json!({ "paths": paths });
            if let Some(root) = params.get("grantRoot").filter(|root| !root.is_null()) {
                input["grant_root"] = root.clone();
            }
            if let Some(reason) = reason {
                input["reason"] = json!(reason);
            }
            CodexAsk::Approval { kind: ApprovalKind::FileChange, name: "edit".into(), title, input }
        }
        "item/permissions/requestApproval" => {
            let title = match reason {
                Some(reason) => clip(&format!("More access: {reason}"), 72),
                None => "More access".into(),
            };
            let input = json!({ "permissions": params.get("permissions").cloned().unwrap_or(Value::Null) });
            CodexAsk::Approval { kind: ApprovalKind::Permissions, name: "permissions".into(), title, input }
        }
        "mcpServer/elicitation/request" => {
            let server = params.get("serverName").and_then(Value::as_str).unwrap_or("mcp").to_string();
            let tool_call = params.pointer("/_meta/codex_approval_kind").and_then(Value::as_str) == Some("mcp_tool_call");
            if !tool_call {
                // A form an MCP server wants filled: Crew has nowhere to show it.
                return CodexAsk::Reply(json!({ "action": "decline", "content": null, "_meta": null }));
            }
            let message = params.get("message").and_then(Value::as_str).unwrap_or_default();
            // "Allow the plain MCP server to run tool \"echo\"?"
            let tool = message.split('"').nth(1).filter(|tool| !tool.is_empty()).unwrap_or("tool").to_string();
            let input = params.pointer("/_meta/tool_params").cloned().unwrap_or(json!({}));
            CodexAsk::Approval {
                kind: ApprovalKind::McpTool,
                name: format!("mcp__{server}__{tool}"),
                title: mcp_label(&server, &tool),
                input,
            }
        }
        "item/tool/requestUserInput" => {
            let questions = params
                .get("questions")
                .and_then(Value::as_array)
                .map(|rows| rows.iter().filter_map(user_input_question).collect())
                .unwrap_or_default();
            CodexAsk::Questions(questions)
        }
        _ => CodexAsk::Unsupported,
    }
}

fn user_input_question(row: &Value) -> Option<(String, Question)> {
    let id = row.get("id")?.as_str()?.to_string();
    let question = row.get("question")?.as_str()?.to_string();
    let header = row
        .get("header")
        .and_then(Value::as_str)
        .filter(|header| !header.trim().is_empty())
        .map(str::to_string)
        .unwrap_or_else(|| question.clone());
    let options = row
        .get("options")
        .and_then(Value::as_array)
        .map(|options| {
            options
                .iter()
                .filter_map(|option| {
                    let label = option.get("label")?.as_str()?.to_string();
                    let description = option
                        .get("description")
                        .and_then(Value::as_str)
                        .filter(|desc| !desc.is_empty() && *desc != label)
                        .map(str::to_string);
                    Some(QuestionOption { label, description })
                })
                .collect()
        })
        .unwrap_or_default();
    Some((id, Question { question, header, multi_select: false, options }))
}

/// The answer to an approval request, in the shape its method takes.
pub fn approval_response(kind: ApprovalKind, decision: ApprovalDecision, params: &Value) -> Value {
    match kind {
        ApprovalKind::Command | ApprovalKind::FileChange => json!({
            "decision": match decision {
                ApprovalDecision::Allow => "accept",
                ApprovalDecision::Always => "acceptForSession",
                ApprovalDecision::Deny => "decline",
            }
        }),
        ApprovalKind::Permissions => match decision {
            ApprovalDecision::Deny => json!({ "permissions": {} }),
            ApprovalDecision::Allow => json!({ "permissions": params.get("permissions").cloned().unwrap_or(json!({})), "scope": "turn" }),
            ApprovalDecision::Always => json!({ "permissions": params.get("permissions").cloned().unwrap_or(json!({})), "scope": "session" }),
        },
        ApprovalKind::McpTool => json!({
            "action": if decision == ApprovalDecision::Deny { "decline" } else { "accept" },
            "content": null,
            "_meta": null,
        }),
    }
}

/// The answer to `request_user_input`. Crew's answers are keyed by the
/// question's text, Codex's by its id; a lone answer to a lone question fits
/// whatever it was keyed by. Dismissed, every question goes back unanswered.
pub fn questions_response(questions: &[(String, Question)], answers: Option<&HashMap<String, String>>) -> Value {
    let mut out = Map::new();
    if let Some(answers) = answers {
        for (id, question) in questions {
            let answer = answers
                .get(&question.question)
                .or_else(|| answers.get(id))
                .or_else(|| answers.get(&question.header))
                .or_else(|| (questions.len() == 1 && answers.len() == 1).then(|| answers.values().next()).flatten());
            if let Some(answer) = answer {
                out.insert(id.clone(), json!({ "answers": [answer] }));
            }
        }
    }
    json!({ "answers": out })
}

/// The JSON-RPC error a request Crew does not take is answered with.
pub fn unsupported_error(method: &str) -> Value {
    json!({ "code": -32601, "message": format!("Crew does not handle {method}") })
}

/// The message of a JSON-RPC error.
pub fn rpc_error_message(error: &Value) -> String {
    error
        .get("message")
        .and_then(Value::as_str)
        .map(str::to_string)
        .unwrap_or_else(|| error.to_string())
}

/// What a turn is handed besides its text: a list of the paths attached.
pub fn with_attached_paths(text: &str, files: &[String]) -> String {
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

pub fn is_tool_item(item: &Map<String, Value>) -> bool {
    matches!(
        string_field(Some(item), "type").as_deref(),
        Some(
            "command_execution"
                | "file_change"
                | "mcp_tool_call"
                | "web_search"
                | "collab_tool_call"
                | "todo_list"
                | "image_view"
                | "image_generation"
        )
    )
}

/// The images a call has to show: what an MCP tool sent back (a
/// screenshot), the file `view_image` looked at, the one it generated.
pub fn item_files(item: &Map<String, Value>) -> Vec<AttachedFile> {
    match string_field(Some(item), "type").as_deref() {
        Some("mcp_tool_call") => {
            crate::media::images(item.get("result").and_then(as_record).and_then(|result| result.get("content")))
        }
        Some("image_view") => {
            string_field(Some(item), "path").and_then(|path| crate::media::local(&path)).into_iter().collect()
        }
        Some("image_generation") => string_field(Some(item), "saved_path")
            .and_then(|path| crate::media::local(&path))
            .or_else(|| crate::media::save("image/png", &string_field(Some(item), "result")?))
            .into_iter()
            .collect(),
        _ => Vec::new(),
    }
}

pub fn tool_call_id(item: &Map<String, Value>) -> Option<String> {
    string_field(Some(item), "id")
}

pub fn tool_name(item: &Map<String, Value>) -> String {
    match string_field(Some(item), "type").as_deref() {
        Some("command_execution") => "bash".into(),
        Some("file_change") => "edit".into(),
        Some("mcp_tool_call") => string_field(Some(item), "tool").unwrap_or_else(|| "mcp".into()),
        Some("web_search") => "websearch".into(),
        Some("collab_tool_call") => string_field(Some(item), "tool").unwrap_or_else(|| "collab".into()),
        Some("todo_list") => "todo".into(),
        Some("image_view") => "view_image".into(),
        Some("image_generation") => "image_gen".into(),
        Some(other) => other.into(),
        None => "tool".into(),
    }
}

pub fn tool_label(item: &Map<String, Value>) -> String {
    match string_field(Some(item), "type").as_deref() {
        Some("command_execution") => string_field(Some(item), "command")
            .map(|command| clip(&unwrap_shell(&command), 72))
            .unwrap_or_else(|| "Command".into()),
        Some("file_change") => {
            let changes = item.get("changes").and_then(Value::as_array);
            let first = changes.and_then(|rows| rows.first()).and_then(as_record);
            let path = string_field(first, "path");
            let kind = string_field(first, "kind");
            let verb = match kind.as_deref() {
                Some("add") => "Write",
                Some("delete") => "Delete",
                _ => "Edit",
            };
            if changes.map(|rows| rows.len()).unwrap_or(0) > 1 {
                format!("{verb} {} files", changes.map(|rows| rows.len()).unwrap_or(0))
            } else if let Some(path) = path {
                format!("{verb} {}", leaf(&path))
            } else {
                verb.into()
            }
        }
        Some("mcp_tool_call") => {
            if let Some(titled) = string_field(item.get("arguments").and_then(as_record), "title") {
                return clip(&titled, 72);
            }
            let tool = string_field(Some(item), "tool");
            let server = string_field(Some(item), "server");
            if let Some(named) = crew_name(item) {
                let arguments = item.get("arguments").and_then(as_record).cloned().unwrap_or_default();
                if let Some(label) = super::crew_label(&named, &arguments) {
                    return label;
                }
            }
            match (tool, server) {
                (Some(tool), Some(server)) => mcp_label(&server, &tool),
                (Some(tool), None) => tool,
                (None, Some(server)) => server,
                _ => "MCP".into(),
            }
        }
        Some("web_search") => string_field(Some(item), "query")
            .map(|query| format!("Search {}", clip(&query, 40)))
            .unwrap_or_else(|| "Search".into()),
        Some("collab_tool_call") => string_field(Some(item), "tool").unwrap_or_else(|| "Collab".into()),
        Some("todo_list") => "Todos".into(),
        Some("image_view") => string_field(Some(item), "path")
            .and_then(|path| crate::media::local(&path))
            .map(|file| format!("View {}", file.name))
            .unwrap_or_else(|| "View image".into()),
        Some("image_generation") => "Generate image".into(),
        Some(other) => other.into(),
        None => "tool".into(),
    }
}

/// Codex sends the whole item on every phase, so the completed item already
/// carries the exit code and the output the started one could not.
pub fn tool_detail(item: &Map<String, Value>) -> Option<ToolDetail> {
    match string_field(Some(item), "type").as_deref() {
        Some("command_execution") => Some(ToolDetail::Command {
            command: unwrap_shell(&string_field(Some(item), "command")?),
            exit_code: item
                .get("exit_code")
                .and_then(Value::as_i64)
                .map(|code| code as i32),
            output: output_text(item.get("aggregated_output")),
        }),
        Some("file_change") => {
            let changes = item.get("changes").and_then(Value::as_array)?;
            // A multi-file change has no single path to name; the title already
            // counts them.
            let [only] = changes.as_slice() else {
                return None;
            };
            Some(ToolDetail::Edit {
                path: string_field(as_record(only), "path")?,
                added: None,
                removed: None,
                hunks: None,
            })
        }
        Some("mcp_tool_call") => {
            // codex splits the server from the tool instead of prefixing it, so
            // a Crew call arrives as server "crew" and tool "message_agent".
            // Without this every one of them rendered as its result JSON, and
            // the row that says who a message went to said nothing.
            if let Some(named) = crew_name(item) {
                if let Some(arguments) = item.get("arguments").and_then(as_record) {
                    if let Some(detail) = super::crew_tool_detail(&named, arguments) {
                        // Once it answered: the letter it made, or why Crew
                        // refused it (an `isError` result, or Codex's error).
                        let result = item.get("result").and_then(as_record);
                        let refused = string_field(Some(item), "status").as_deref() == Some("failed")
                            || result.and_then(|result| result.get("isError")).and_then(Value::as_bool) == Some(true);
                        let answer = output_text(result.and_then(|result| result.get("content"))).or_else(|| {
                            string_field(item.get("error").and_then(as_record), "message")
                        });
                        let done = answer.and_then(|answer| super::crew_result_detail(&named, arguments, &answer, refused));
                        return Some(done.unwrap_or(detail));
                    }
                }
            }
            let output = output_text(item.get("result").and_then(as_record).and_then(|result| result.get("content")));
            let server = string_field(Some(item), "server");
            let tool = string_field(Some(item), "tool");
            match (server, tool) {
                (Some(server), Some(tool)) if server != "crew" => Some(ToolDetail::Mcp {
                    server,
                    tool,
                    input: item.get("arguments").and_then(as_record).and_then(pretty_input),
                    output,
                }),
                _ => Some(ToolDetail::Output { text: output? }),
            }
        }
        Some("web_search") => Some(ToolDetail::Search {
            query: string_field(Some(item), "query")?,
            matches: None,
            output: None,
        }),
        Some("todo_list") => Some(ToolDetail::Todo {
            items: todo_items(item.get("items"))?,
        }),
        Some("image_view") => Some(ToolDetail::File {
            path: crate::media::local(&string_field(Some(item), "path")?)?.path,
            line_start: None,
            line_end: None,
            preview: None,
        }),
        Some("image_generation") => Some(ToolDetail::Output {
            text: string_field(Some(item), "revised_prompt")?,
        }),
        _ => None,
    }
}

/// MCP results arrive as a list of content blocks; everything else is a string.
fn output_text(value: Option<&Value>) -> Option<String> {
    let text = match value? {
        Value::String(text) => text.clone(),
        Value::Array(parts) => parts
            .iter()
            .filter_map(|part| as_record(part)?.get("text")?.as_str().map(str::to_string))
            .collect::<Vec<_>>()
            .join("\n"),
        _ => return None,
    };
    Some(text).filter(|text| !text.is_empty())
}

pub fn completed_tool_status(item: &Map<String, Value>) -> crew_protocol::ToolStatus {
    match string_field(Some(item), "status").as_deref() {
        Some("failed" | "declined") => crew_protocol::ToolStatus::Failed,
        Some("completed") => crew_protocol::ToolStatus::Completed,
        _ => {
            if item.get("exit_code").and_then(Value::as_i64).is_some_and(|code| code != 0) {
                crew_protocol::ToolStatus::Failed
            } else {
                crew_protocol::ToolStatus::Completed
            }
        }
    }
}


#[cfg(test)]
mod crew_row_tests {
    use super::*;
    use serde_json::json;

    fn item(value: Value) -> Map<String, Value> {
        value.as_object().expect("object").clone()
    }

    /// Measured, not guessed: a codex agent messaged another one through the
    /// MCP and its own chat showed a dump of the delivery receipt where the
    /// reader wanted "wrote to Cuddles: the branch is green".
    #[test]
    fn a_message_a_codex_agent_sent_reads_as_a_message() {
        let detail = tool_detail(&item(json!({
            "type": "mcp_tool_call",
            "server": "crew",
            "tool": "message_agent",
            "arguments": { "to": "6e854800-504b", "text": "the branch is green" },
            "result": { "content": [{ "type": "text", "text": "{\"delivered\": true}" }] }
        })));
        assert_eq!(
            detail,
            Some(ToolDetail::Message {
                to: "6e854800-504b".into(),
                text: "the branch is green".into(),
                letter_id: None,
                to_id: None,
                to_name: None,
                what: None,
                delivery: None,
                error: None,
            })
        );
    }

    /// Any other Crew tool keeps its result: the message row is the only one
    /// whose arguments say more than its answer does.
    #[test]
    fn another_crew_tool_still_shows_what_it_answered() {
        let detail = tool_detail(&item(json!({
            "type": "mcp_tool_call",
            "server": "crew",
            "tool": "list_agents",
            "arguments": {},
            "result": { "content": [{ "type": "text", "text": "[]" }] }
        })));
        assert_eq!(detail, Some(ToolDetail::Output { text: "[]".into() }));
    }

    /// And a server that is not Crew is left alone. `cua_repl`'s `js` tool
    /// takes `code` and a `title`, neither of which is a message.
    #[test]
    fn somebody_elses_mcp_tool_is_not_read_as_crews() {
        let detail = tool_detail(&item(json!({
            "type": "mcp_tool_call",
            "server": "cua_repl",
            "tool": "js",
            "arguments": { "code": "await cua.getState()", "title": "Inspect" },
            "result": { "content": [{ "type": "text", "text": "Window: Crew" }] }
        })));
        assert_eq!(
            detail,
            Some(ToolDetail::Mcp {
                server: "cua_repl".into(),
                tool: "js".into(),
                input: Some("{\n  \"code\": \"await cua.getState()\",\n  \"title\": \"Inspect\"\n}".into()),
                output: Some("Window: Crew".into()),
            })
        );
    }
}

#[cfg(test)]
mod protocol_tests {
    use super::*;
    use serde_json::json;

    fn thread(resume: Option<&str>, autonomy: Autonomy, mcp: bool) -> CodexThread {
        CodexThread {
            cwd: "/repo".into(),
            resume: resume.map(str::to_string),
            model: Some("gpt-5.6-luna".into()),
            effort: Some("low".into()),
            service_tier: None,
            autonomy,
            mcp: mcp.then(|| ("/bin/crewd".into(), vec!["--mcp".into()])),
            mcp_env: vec![("CREW_SOCKET".into(), "/tmp/crew.sock".into()), ("CREW_TOKEN".into(), "t-1".into())],
        }
    }

    /// The server codex starts does not inherit the agent's environment, so
    /// the address of the bridge travels in the thread's config with it; its
    /// calls may run as long as a wait, and never ask (plan §7e.2, §7e.5).
    #[test]
    fn crews_server_rides_on_the_thread_with_its_env_timeout_and_approval() {
        let (method, params) = thread_request(&thread(None, Autonomy::Ask, true));
        assert_eq!(method, "thread/start");
        assert_eq!(
            params["config"]["mcp_servers"]["crew"],
            json!({
                "command": "/bin/crewd",
                "args": ["--mcp"],
                "env": { "CREW_SOCKET": "/tmp/crew.sock", "CREW_TOKEN": "t-1" },
                "tool_timeout_sec": 3900,
                "default_tools_approval_mode": "approve",
            })
        );
        assert_eq!(params["config"]["model_reasoning_effort"], "low");
        assert!(params["config"].get("service_tier").is_none(), "{params}");
        assert_eq!(params["config"]["features.default_mode_request_user_input"], true);
        assert_eq!((params["cwd"].clone(), params["model"].clone()), (json!("/repo"), json!("gpt-5.6-luna")));
        let (_, bare) = thread_request(&thread(None, Autonomy::Ask, false));
        assert!(bare["config"].get("mcp_servers").is_none(), "{bare}");
    }

    #[test]
    fn a_service_tier_rides_on_the_thread_config() {
        let mut input = thread(None, Autonomy::Ask, false);
        input.service_tier = Some("fast".into());
        let (_, params) = thread_request(&input);
        assert_eq!(params["config"]["service_tier"], "fast");
        input.service_tier = Some("default".into());
        let (_, standard) = thread_request(&input);
        assert_eq!(standard["config"]["service_tier"], "default");
    }

    /// Measured: a resume without `model` runs the one in config.toml.
    #[test]
    fn a_resume_names_its_thread_and_its_model_again() {
        let (method, params) = thread_request(&thread(Some("01a10e16"), Autonomy::Full, true));
        assert_eq!(method, "thread/resume");
        assert_eq!(params["threadId"], "01a10e16");
        assert_eq!(params["model"], "gpt-5.6-luna");
        assert_eq!(params["excludeTurns"], true);
        assert_eq!(params["config"]["mcp_servers"]["crew"]["env"]["CREW_TOKEN"], "t-1");
        assert_eq!((params["approvalPolicy"].clone(), params["sandbox"].clone()), (json!("never"), json!("danger-full-access")));
    }

    #[test]
    fn autonomy_maps_to_the_policy_and_sandbox_the_tui_flags_set() {
        assert_eq!(access(&Autonomy::Full), ("never", "danger-full-access", None));
        assert_eq!(access(&Autonomy::Auto), ("on-request", "workspace-write", Some("auto_review")));
        assert_eq!(access(&Autonomy::Edits), ("on-request", "workspace-write", None));
        assert_eq!(access(&Autonomy::Ask), ("on-request", "workspace-write", None));
        let (_, params) = thread_request(&thread(None, Autonomy::Auto, false));
        assert_eq!(params["approvalsReviewer"], "auto_review");
    }

    #[test]
    fn the_instructions_ride_on_every_turn_as_additional_context() {
        let params = turn_start_params("t1", "do it", Some("You are Planner."));
        assert_eq!(params["input"], json!([{ "type": "text", "text": "do it", "text_elements": [] }]));
        assert_eq!(params["additionalContext"]["crew"], json!({ "kind": "application", "value": "You are Planner." }));
        assert!(turn_start_params("t1", "x", None).get("additionalContext").is_none());
        assert_eq!(steer_params("t1", "u1", "more")["expectedTurnId"], "u1");
    }

    #[test]
    fn a_turn_ends_the_way_codex_says() {
        let end = |status: &str, error: Value| turn_end(&json!({ "turn": { "id": "u1", "status": status, "error": error } }));
        assert_eq!(end("completed", Value::Null), (Some("u1".into()), TurnEnd::Completed));
        assert_eq!(end("interrupted", Value::Null).1, TurnEnd::Interrupted);
        assert_eq!(end("failed", json!({ "message": "usage limit" })).1, TurnEnd::Failed("usage limit".into()));
        assert_eq!(end("failed", Value::Null).1, TurnEnd::Failed("Codex turn failed.".into()));
    }

    /// The approvals Codex sends, as the card shows them and as they are answered.
    #[test]
    fn approvals_read_as_cards_and_answer_in_their_own_shape() {
        let items = HashMap::new();
        let ask = classify_request(
            "item/commandExecution/requestApproval",
            &json!({ "itemId": "e1", "command": "/bin/zsh -lc 'touch /out/cmd.txt'", "cwd": "/repo", "reason": "outside" }),
            &items,
        );
        let CodexAsk::Approval { kind, name, title, input } = ask else { panic!("{ask:?}") };
        assert_eq!((kind, name.as_str(), title.as_str()), (ApprovalKind::Command, "bash", "touch /out/cmd.txt"));
        assert_eq!(input, json!({ "command": "touch /out/cmd.txt", "cwd": "/repo", "reason": "outside" }));
        assert_eq!(approval_response(kind, ApprovalDecision::Allow, &Value::Null), json!({ "decision": "accept" }));
        assert_eq!(approval_response(kind, ApprovalDecision::Always, &Value::Null), json!({ "decision": "acceptForSession" }));
        assert_eq!(approval_response(kind, ApprovalDecision::Deny, &Value::Null), json!({ "decision": "decline" }));

        // A file change names only its item; the item started first has the files.
        let started = json!({ "type": "fileChange", "id": "e2", "status": "inProgress",
            "changes": [{ "path": "/repo/a.txt", "kind": { "type": "add" }, "diff": "x\n" }] });
        let items = HashMap::from([("e2".to_string(), started.as_object().unwrap().clone())]);
        let ask = classify_request("item/fileChange/requestApproval", &json!({ "itemId": "e2" }), &items);
        let CodexAsk::Approval { kind, title, input, .. } = ask else { panic!("{ask:?}") };
        assert_eq!((kind, title.as_str()), (ApprovalKind::FileChange, "Write a.txt"));
        assert_eq!(input["paths"], json!(["/repo/a.txt"]));

        // An MCP tool of the user's own that asks; a form Crew cannot show is declined.
        let ask = classify_request(
            "mcpServer/elicitation/request",
            &json!({ "serverName": "plain", "message": "Allow the plain MCP server to run tool \"echo\"?",
                     "_meta": { "codex_approval_kind": "mcp_tool_call", "tool_params": { "text": "one" } } }),
            &HashMap::new(),
        );
        let CodexAsk::Approval { kind, name, .. } = ask else { panic!("{ask:?}") };
        assert_eq!((kind, name.as_str()), (ApprovalKind::McpTool, "mcp__plain__echo"));
        assert_eq!(approval_response(kind, ApprovalDecision::Allow, &Value::Null)["action"], "accept");
        assert_eq!(approval_response(kind, ApprovalDecision::Deny, &Value::Null)["action"], "decline");
        assert_eq!(
            classify_request("mcpServer/elicitation/request", &json!({ "serverName": "x", "mode": "form" }), &HashMap::new()),
            CodexAsk::Reply(json!({ "action": "decline", "content": null, "_meta": null }))
        );
        assert_eq!(classify_request("item/somethingNew", &Value::Null, &HashMap::new()), CodexAsk::Unsupported);
    }

    /// Crew keys an answer by the question's text; Codex wants it by id.
    #[test]
    fn questions_go_out_by_text_and_come_back_by_id() {
        let ask = classify_request(
            "item/tool/requestUserInput",
            &json!({ "questions": [{ "id": "preferred_color", "header": "Color", "question": "Which color do you prefer?",
                     "isOther": true, "options": [{ "label": "Red", "description": "Choose red." }, { "label": "Blue", "description": "Blue" }] }] }),
            &HashMap::new(),
        );
        let CodexAsk::Questions(questions) = ask else { panic!("{ask:?}") };
        assert_eq!(questions[0].0, "preferred_color");
        assert_eq!(questions[0].1.header, "Color");
        assert_eq!(questions[0].1.options[0].description.as_deref(), Some("Choose red."));
        assert_eq!(questions[0].1.options[1].description, None);
        let answers = HashMap::from([("Which color do you prefer?".to_string(), "Blue".to_string())]);
        assert_eq!(
            questions_response(&questions, Some(&answers)),
            json!({ "answers": { "preferred_color": { "answers": ["Blue"] } } })
        );
        // One answer to one question fits, whatever it was keyed by.
        let loose = HashMap::from([("color".to_string(), "Red".to_string())]);
        assert_eq!(questions_response(&questions, Some(&loose))["answers"]["preferred_color"]["answers"], json!(["Red"]));
        assert_eq!(questions_response(&questions, None), json!({ "answers": {} }));
    }

    #[test]
    fn an_app_server_item_reads_in_the_shape_codex_exec_gave_it() {
        let item = json!({ "type": "commandExecution", "id": "e1", "command": "/bin/zsh -lc 'cargo test'",
            "status": "failed", "aggregatedOutput": "1 failed\n", "exitCode": 101 });
        let row = exec_item(item.as_object().unwrap()).unwrap();
        assert_eq!(
            tool_detail(&row),
            Some(ToolDetail::Command { command: "cargo test".into(), exit_code: Some(101), output: Some("1 failed\n".into()) })
        );
        assert_eq!(completed_tool_status(&row), crew_protocol::ToolStatus::Failed);
        assert!(exec_item(json!({ "type": "reasoning", "id": "r" }).as_object().unwrap()).is_none());
        let plan = plan_detail(&json!({ "plan": [{ "step": "a", "status": "completed" }, { "step": "b", "status": "inProgress" }] }));
        assert!(matches!(plan, Some(ToolDetail::Todo { ref items }) if items.len() == 2), "{plan:?}");
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::turns::TurnHost;
    use crew_protocol::{HarnessEvent, ToolDetail, ToolStatus};
    use serde_json::json;

    fn feed(lines: &[Value]) -> Vec<HarnessEvent> {
        let host = TurnHost::test_new();
        let cap = host.test_capture();
        host.test_install_codex("s");
        for line in lines {
            host.handle_codex_line("s", &line.to_string());
        }
        cap.take()
    }

    fn note(method: &str, params: Value) -> Value {
        json!({ "method": method, "params": params })
    }

    fn item(phase: &str, item: Value) -> Value {
        note(&format!("item/{phase}"), json!({ "threadId": "t", "turnId": "u", "item": item }))
    }

    #[test]
    fn a_command_starts_a_row_and_its_end_settles_it() {
        let cmd = json!({ "type": "commandExecution", "id": "c1", "command": "/bin/zsh -lc 'ls -la'", "status": "inProgress",
            "aggregatedOutput": null, "exitCode": null });
        let mut done = cmd.clone();
        done["status"] = json!("completed");
        done["exitCode"] = json!(0);
        assert_eq!(
            feed(&[item("started", cmd), item("completed", done)]),
            vec![
                HarnessEvent::ToolStarted {
                    call_id: "c1".into(),
                    name: "bash".into(),
                    title: "ls -la".into(),
                    detail: Some(ToolDetail::Command { command: "ls -la".into(), exit_code: None, output: None }),
                },
                HarnessEvent::ToolUpdated {
                    call_id: "c1".into(),
                    title: Some("ls -la".into()),
                    status: None,
                    detail: Some(ToolDetail::Command { command: "ls -la".into(), exit_code: Some(0), output: None }),
                },
                HarnessEvent::ToolUpdated { call_id: "c1".into(), title: None, status: Some(ToolStatus::Completed), detail: None },
            ]
        );
    }

    #[test]
    fn a_screenshot_and_an_image_looked_at_show_on_their_rows() {
        let png = crate::media::TEST_PNG;
        let shot = json!({ "type": "mcpToolCall", "id": "m1", "server": "chrome_devtools", "tool": "take_screenshot",
            "arguments": {}, "status": "completed",
            "result": { "content": [{ "type": "text", "text": "Took a screenshot" }, { "type": "image", "mimeType": "image/png", "data": png }] } });
        let view = json!({ "type": "imageView", "id": "v1", "path": "/tmp/logo.png" });
        let got = feed(&[item("started", view.clone()), item("completed", view), item("completed", shot)]);
        let files: Vec<(&str, Vec<String>)> = got
            .iter()
            .filter_map(|event| match event {
                HarnessEvent::ToolFiles { call_id, files } => {
                    Some((call_id.as_str(), files.iter().map(|file| file.path.clone()).collect()))
                }
                _ => None,
            })
            .collect();
        assert_eq!(files.len(), 2, "{got:?}");
        assert_eq!(files[0], ("v1", vec!["/tmp/logo.png".to_string()]));
        assert_eq!(files[1].0, "m1");
        assert!(std::path::Path::new(&files[1].1[0]).exists());
        assert!(got.iter().any(|event| matches!(event, HarnessEvent::ToolStarted { call_id, title, .. } if call_id == "v1" && title == "View logo.png")));
    }

    #[test]
    fn a_file_change_names_the_file() {
        let got = feed(&[item(
            "started",
            json!({ "type": "fileChange", "id": "e1", "status": "inProgress",
                    "changes": [{ "path": "/tmp/app/foo.ts", "kind": { "type": "add" }, "diff": "x" }] }),
        )]);
        assert_eq!(
            got,
            vec![HarnessEvent::ToolStarted {
                call_id: "e1".into(),
                name: "edit".into(),
                title: "Write foo.ts".into(),
                detail: Some(ToolDetail::Edit { path: "/tmp/app/foo.ts".into(), added: None, removed: None, hunks: None }),
            }]
        );
    }

    /// The deltas carry the text; the completed item adds only what they missed.
    #[test]
    fn a_message_streams_once_and_completes() {
        let got = feed(&[
            item("started", json!({ "type": "agentMessage", "id": "m1", "text": "" })),
            note("item/agentMessage/delta", json!({ "itemId": "m1", "delta": "hel" })),
            note("item/agentMessage/delta", json!({ "itemId": "m1", "delta": "lo" })),
            item("completed", json!({ "type": "agentMessage", "id": "m1", "text": "hello" })),
            item("completed", json!({ "type": "agentMessage", "id": "m2", "text": "unstreamed" })),
        ]);
        assert_eq!(
            got,
            vec![
                HarnessEvent::MessageDelta { text: "hel".into() },
                HarnessEvent::MessageDelta { text: "lo".into() },
                HarnessEvent::MessageCompleted {},
                HarnessEvent::MessageDelta { text: "unstreamed".into() },
                HarnessEvent::MessageCompleted {},
            ]
        );
    }

    #[test]
    fn the_end_of_the_turn_settles_it() {
        let got = feed(&[note("turn/completed", json!({ "threadId": "t", "turn": { "id": "u", "status": "completed", "error": null } }))]);
        assert_eq!(got, vec![HarnessEvent::MessageCompleted {}, HarnessEvent::TurnCompleted { usage: None }]);
    }

    /// Measured, not guessed: a codex agent messaged another one through the
    /// MCP and its own chat showed a dump of the delivery receipt where the
    /// reader wanted "wrote to Cuddles: the branch is green". The item names
    /// the server and the tool apart.
    #[test]
    fn a_crew_call_reads_as_the_tool_it_ran() {
        let got = feed(&[item(
            "started",
            json!({ "type": "mcpToolCall", "id": "x1", "server": "crew", "tool": "message_agent", "status": "inProgress",
                    "arguments": { "to": "6e85", "text": "green" } }),
        )]);
        assert_eq!(
            got,
            vec![HarnessEvent::ToolStarted {
                call_id: "x1".into(),
                name: "message_agent".into(),
                title: "Crew message agent 6e85".into(),
                detail: Some(ToolDetail::Message {
                    to: "6e85".into(),
                    text: "green".into(),
                    letter_id: None,
                    to_id: None,
                    to_name: None,
                    what: None,
                    delivery: None,
                    error: None,
                }),
            }]
        );
    }

    #[test]
    fn a_plan_is_one_todo_row_per_turn() {
        let plan = |status: &str| note("turn/plan/updated", json!({ "turnId": "u", "plan": [{ "step": "a", "status": status }] }));
        let got = feed(&[plan("inProgress"), plan("completed")]);
        assert!(matches!(&got[0], HarnessEvent::ToolStarted { call_id, name, .. } if call_id == "plan-u" && name == "todo"), "{got:?}");
        assert!(matches!(&got[1], HarnessEvent::ToolUpdated { call_id, detail: Some(ToolDetail::Todo { .. }), .. } if call_id == "plan-u"), "{got:?}");
    }

    /// The real stream of a turn in `tests/fixtures/protocols/codex.jsonl`,
    /// captured from codex-cli 0.160.0's app-server: a shell command, a file,
    /// an MCP call and the answer, each once, in order.
    #[test]
    fn a_captured_turn_reads_as_its_rows() {
        let lines: Vec<Value> = include_str!("../../tests/fixtures/protocols/codex.jsonl")
            .lines()
            .filter_map(|line| serde_json::from_str(line).ok())
            .collect();
        let got = feed(&lines);
        let started: Vec<&str> = got
            .iter()
            .filter_map(|event| match event {
                HarnessEvent::ToolStarted { title, .. } => Some(title.as_str()),
                _ => None,
            })
            .collect();
        assert_eq!(started, ["echo hi > hello.txt", "Write notes.txt", "echoer · echo"], "{got:?}");
        let text: String = got
            .iter()
            .filter_map(|event| match event {
                HarnessEvent::MessageDelta { text } => Some(text.as_str()),
                _ => None,
            })
            .collect();
        assert!(text.ends_with("PINEAPPLE ECHO:ping (marker=m1)"), "{text}");
        assert_eq!(got.last(), Some(&HarnessEvent::TurnCompleted { usage: None }));
    }
}
