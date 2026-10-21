//! Grok as Crew drives it: one `grok agent stdio` per session, spoken to in
//! the Agent Client Protocol (JSON-RPC 2.0, one message per line). This
//! module is the protocol. The driver that holds the process is
//! `turns/grok.rs`.
//!
//! Measured against grok 1.0.62. `grok agent --model` does not select the
//! session's model (a campaign default wins); `session/set_config_option`
//! does, for `model` and `reasoning_effort`, with the value as a string.
//! `session/set_mode` accepts any `modeId` and changes nothing. Permission
//! mode is the process: `--permission-mode` before `agent`, and
//! `agent --always-approve` for full access. There is no accept-edits agent
//! mode. Without `_GROK_CLAUDE_MARKER_OVERRIDE`, grok seeds Auto from
//! Claude's `permissions.defaultMode` and Ask never prompts. Auto also needs
//! `initialize` `_meta.clientType` of `extension`, or it denies without asking.

use std::collections::HashMap;

use crew_protocol::{ApprovalDecision, Question, QuestionOption, ToolDetail, ToolStatus};
use serde_json::{json, Map, Value};

use super::runtime::Autonomy;
use super::{as_record, clip, crew_label, crew_tool_detail, leaf, mcp_label, pretty_input, string_field};

/// The name Crew's MCP server goes by in `session/new`. The model calls its
/// tools through `use_tool` as `crew__<name>`.
pub const CREW_SERVER: &str = "crew";

/// Keeps a Crew-started grok from importing Claude's or Cursor's agents,
/// hooks, MCP servers, rules and skills, and from seeding its permission
/// mode off Claude's. The auto-updater stays off. Grok's own `~/.grok`
/// config stays. A model probe sets the same list. Names checked against
/// grok 1.0.62 (`grok inspect` and the debug log).
pub fn isolation_env() -> Vec<(&'static str, &'static str)> {
    vec![
        ("GROK_DISABLE_AUTOUPDATER", "1"),
        ("GROK_CLAUDE_AGENTS_ENABLED", "0"),
        ("GROK_CLAUDE_HOOKS_ENABLED", "0"),
        ("GROK_CLAUDE_MCPS_ENABLED", "0"),
        ("GROK_CLAUDE_RULES_ENABLED", "0"),
        ("GROK_CLAUDE_SKILLS_ENABLED", "0"),
        ("GROK_CURSOR_AGENTS_ENABLED", "0"),
        ("GROK_CURSOR_HOOKS_ENABLED", "0"),
        ("GROK_CURSOR_MCPS_ENABLED", "0"),
        ("GROK_CURSOR_RULES_ENABLED", "0"),
        ("GROK_CURSOR_SKILLS_ENABLED", "0"),
        ("_GROK_CLAUDE_MARKER_OVERRIDE", "1"),
    ]
}

/// The only `allow_always` option a turn may select on its own. It allows
/// edits for this session. Every other always-allow option is a project
/// grant that outlives the session.
pub const ALLOW_EDITS_SESSION: &str = "allow-edits-session";

/// `grok --no-auto-update [--permission-mode default|auto] agent
/// [--always-approve] --no-leader stdio`. `--permission-mode` is before
/// `agent`: on the root after it, the flag does not reach the agent.
/// Ask and Edits both launch as `default`. Edits then approves edit requests
/// itself. Full access is `agent --always-approve`, with no permission mode.
/// The model and the effort are not on argv.
pub fn build_grok_spawn_args(autonomy: &Autonomy) -> Vec<String> {
    let mut args = vec!["--no-auto-update".into()];
    if let Some(mode) = permission_flag(autonomy) {
        args.push("--permission-mode".into());
        args.push(mode.into());
    }
    args.push("agent".into());
    if *autonomy == Autonomy::Full {
        args.push("--always-approve".into());
    }
    args.push("--no-leader".into());
    args.push("stdio".into());
    args
}

/// The root flag. Full is `agent --always-approve` instead: the root
/// `--always-approve` does not reach the agent subcommand. Edits is `default`
/// too: grok treats `acceptEdits` as ask.
fn permission_flag(autonomy: &Autonomy) -> Option<&'static str> {
    match autonomy {
        Autonomy::Ask | Autonomy::Edits => Some("default"),
        Autonomy::Auto => Some("auto"),
        Autonomy::Full => None,
    }
}

/// ACP has no system channel, so a bot's turn is one document: persona, the
/// tail of the conversation, then what is being asked. Images go as paths:
/// an `image` content block is accepted and the model does not see it
/// (measured: a red PNG was called green; `read_file` on the same path was
/// right).
pub fn build_grok_prompt(persona: &str, history: Option<&str>, text: &str, files: &[String]) -> String {
    super::assemble(persona.to_string(), history, &super::with_files(text.trim(), files))
}

/// The handshake. Crew reads and writes no files and runs no terminals for
/// the agent: it does both itself. No `authenticate`: a cached login is enough.
pub fn initialize_params() -> Value {
    json!({
        "protocolVersion": 1,
        "clientCapabilities": { "fs": { "readTextFile": false, "writeTextFile": false }, "terminal": false },
        "clientInfo": { "name": "crew", "version": env!("CARGO_PKG_VERSION") },
        // Without `extension`, `--permission-mode auto` denies and never asks.
        "_meta": { "clientType": "extension" },
    })
}

/// Crew's MCP server over stdio. `type` is what grok's `session/new` takes.
pub fn mcp_servers(mcp: Option<&(String, Vec<String>)>, env: &[(String, String)]) -> Value {
    let Some((command, args)) = mcp else {
        return json!([]);
    };
    let env: Vec<Value> = env.iter().map(|(name, value)| json!({ "name": name, "value": value })).collect();
    json!([{ "type": "stdio", "name": CREW_SERVER, "command": command, "args": args, "env": env }])
}

/// `session/new`, or `session/load` of the conversation a child carries on.
/// The permission mode is the process, so neither request carries a mode in
/// `_meta`. A load uses the same folder and the same MCP servers.
pub fn session_request(cwd: &str, resume: Option<&str>, servers: &Value) -> (&'static str, Value) {
    match resume {
        Some(id) => ("session/load", json!({ "sessionId": id, "cwd": cwd, "mcpServers": servers })),
        None => ("session/new", json!({ "cwd": cwd, "mcpServers": servers })),
    }
}

/// A load failed because the session is not there. An auth failure is not
/// that: starting a new conversation would hide a login problem.
pub fn session_missing(error: &str) -> bool {
    let lower = error.to_lowercase();
    if lower.contains("auth") || lower.contains("unauthor") || lower.contains("login") || lower.contains("401") {
        return false;
    }
    lower.contains("not found")
        || lower.contains("no such")
        || lower.contains("does not exist")
        || lower.contains("unknown session")
}

pub fn new_session_id(result: &Value) -> Option<String> {
    result.get("sessionId").and_then(Value::as_str).map(str::to_string)
}

/// `session/set_config_option`. The value is a string: a nested `{"value": ...}`
/// is not what 1.0.62 applies.
pub fn set_config_params(session_id: &str, config_id: &str, value: &str) -> Value {
    json!({ "sessionId": session_id, "configId": config_id, "value": value })
}

/// `promptId` is Crew's. The prompt's own result can arrive late, after the
/// turn has already ended, and a completion notice names this id.
pub fn prompt_params(session_id: &str, text: &str, prompt_id: &str) -> Value {
    json!({
        "sessionId": session_id,
        "prompt": [{ "type": "text", "text": text }],
        "_meta": { "promptId": prompt_id, "requestId": prompt_id },
    })
}

pub fn cancel_params(session_id: &str) -> Value {
    json!({ "sessionId": session_id, "_meta": { "cancelTrigger": "ctrl_c" } })
}

/// How `session/prompt` said the turn ended.
#[derive(Clone, Debug, PartialEq)]
pub enum TurnEnd {
    Completed(Option<String>),
    Cancelled,
    Failed(String),
}

pub fn turn_end(result: &Value) -> TurnEnd {
    match result.get("stopReason").and_then(Value::as_str) {
        Some("cancelled") => TurnEnd::Cancelled,
        Some("rate_limit") => TurnEnd::Failed("Grok is rate limited.".into()),
        Some("error") => TurnEnd::Failed("Grok stopped with an error.".into()),
        Some("refusal") => TurnEnd::Failed("The model refused to go on.".into()),
        Some("max_tokens") => TurnEnd::Completed(Some("Grok stopped: the reply hit the model's output limit.".into())),
        Some("max_turn_requests") => TurnEnd::Completed(Some("Grok stopped: the turn hit its limit of model requests.".into())),
        _ => TurnEnd::Completed(None),
    }
}

pub fn rpc_error_message(error: &Value) -> String {
    // xAI's usage-limit code. The message under it is not what the chat shows.
    if error.get("code").and_then(Value::as_i64) == Some(-32003) {
        return "Grok is rate limited.".into();
    }
    let message = error.get("message").and_then(Value::as_str).unwrap_or_default();
    let detail = error.pointer("/data/message").and_then(Value::as_str).unwrap_or_default();
    match (message.is_empty(), detail.is_empty()) {
        (true, true) => error.to_string(),
        (false, true) => message.to_string(),
        (true, false) => detail.to_string(),
        (false, false) => format!("{message}: {detail}"),
    }
}

pub fn unsupported_error(method: &str) -> Value {
    json!({ "code": -32601, "message": format!("Method not found: {method}") })
}

/// A tool call as the updates have told it so far.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct AcpTool {
    pub id: String,
    pub kind: String,
    pub title: String,
    /// `_meta["x.ai/tool"].name`. The title is often the word "Tool".
    pub native: Option<String>,
    pub input: Map<String, Value>,
    pub path: Option<String>,
    /// A monitor or a background command, closed by `task_completed`.
    pub task_id: Option<String>,
}

impl AcpTool {
    pub fn new(id: &str) -> Self {
        Self { id: id.to_string(), ..Self::default() }
    }

    pub fn merge(&mut self, update: &Map<String, Value>) {
        // The first `tool_call` often names the kind only under `_meta`.
        if let Some(kind) = string_field(Some(update), "kind").or_else(|| string_field(xai_tool(update), "kind")) {
            self.kind = kind;
        }
        if let Some(title) = string_field(Some(update), "title") {
            self.title = title;
        }
        if let Some(name) = string_field(xai_tool(update), "name") {
            self.native = Some(name);
        }
        if let Some(input) = update.get("rawInput").and_then(as_record).filter(|input| !input.is_empty()) {
            self.input = input.clone();
        }
        if let Some(task) = task_field(Some(update))
            .or_else(|| task_field(update.get("rawInput").and_then(as_record)))
            .or_else(|| task_field(update.get("rawOutput").and_then(as_record)))
        {
            self.task_id = Some(task);
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

    /// An MCP call grok wraps as `use_tool`. Measured on 1.0.62, `rawInput`
    /// holds `tool_name` (`server__tool`) and `tool_input` (the arguments).
    /// A nested `tool_input.tool_name` is read when that is what arrived.
    /// The native name is `_meta["x.ai/tool"].name`, which is `use_tool`
    /// while the title is often just "Tool". A native name that is something
    /// else is that tool: `tool_name` in its input is an argument, not a
    /// wrapper. A later update can drop the meta and still carry `tool_name`;
    /// the native name stays on the call.
    pub fn use_tool(&self) -> Option<(String, String, Map<String, Value>)> {
        if self.native.as_deref().is_some_and(|name| name != "use_tool") {
            return None;
        }
        let wrapped = self.native.as_deref() == Some("use_tool")
            || self.title == "use_tool"
            || self.input.contains_key("tool_name")
            || self.input.get("tool_input").and_then(as_record).is_some_and(|inner| inner.contains_key("tool_name"));
        if !wrapped {
            return None;
        }
        let name = string_field(Some(&self.input), "tool_name").or_else(|| {
            self.input.get("tool_input").and_then(as_record).and_then(|inner| string_field(Some(inner), "tool_name"))
        })?;
        let (server, tool) = name.split_once("__")?;
        if server.is_empty() || tool.is_empty() {
            return None;
        }
        let args = if self.input.contains_key("tool_name") {
            self.input.get("tool_input").and_then(as_record).cloned().unwrap_or_default()
        } else {
            self.input
                .get("tool_input")
                .and_then(as_record)
                .and_then(|inner| inner.get("tool_input"))
                .and_then(as_record)
                .cloned()
                .unwrap_or_default()
        };
        Some((server.to_string(), tool.to_string(), args))
    }

    /// Enough is known to name the row. `use_tool` and `run_terminal_command`
    /// open before they say which tool or command, and the row waits. A title
    /// of "Tool" is not a name.
    pub fn named(&self) -> bool {
        self.use_tool().is_some() || self.input.contains_key("command") || (!self.kind.is_empty() && !generic_title(&self.title))
    }

    pub fn is_crew(&self) -> bool {
        match self.use_tool() {
            Some((server, ..)) => server == CREW_SERVER,
            None => self.title.starts_with("crew__") || self.title.starts_with("crew:") || self.title.starts_with("crew-"),
        }
    }

    fn path(&self) -> Option<String> {
        string_field(Some(&self.input), "path")
            .or_else(|| string_field(Some(&self.input), "file_path"))
            .or_else(|| string_field(Some(&self.input), "target_file"))
            .or_else(|| self.path.clone())
    }

    /// The kind the row is filed under. A shell opens with no kind, as
    /// `run_terminal_command`, and says `execute` on the update; the command
    /// is already in `rawInput`.
    pub fn kind_of(&self) -> &str {
        if self.use_tool().is_some() {
            return "other";
        }
        if self.native.as_deref() == Some("search_tool") || self.title == "search_tool" {
            return "search";
        }
        if self.kind == "execute" || self.input.contains_key("command") || variant_is(&self.input, "Bash") {
            return "execute";
        }
        if self.kind == "read" || self.input.contains_key("target_file") || self.title == "read_file" {
            return "read";
        }
        if self.kind.is_empty() {
            "other"
        } else {
            self.kind.as_str()
        }
    }
}

fn variant_is(input: &Map<String, Value>, name: &str) -> bool {
    input.get("variant").and_then(Value::as_str) == Some(name)
}

fn generic_title(title: &str) -> bool {
    matches!(title, "" | "Tool" | "use_tool" | "run_terminal_command")
}

fn task_field(row: Option<&Map<String, Value>>) -> Option<String> {
    string_field(row, "taskId").or_else(|| string_field(row, "task_id"))
}

/// The name a row goes by. A `use_tool` of Crew's server is
/// `mcp__crew__<tool>`, which is how every other provider's rows name it, so
/// the chat reads `send_message` rather than the wrapper.
pub fn tool_name(tool: &AcpTool) -> String {
    if let Some((server, name, _)) = tool.use_tool() {
        return format!("mcp__{server}__{name}");
    }
    match tool.kind_of() {
        "execute" => "bash".into(),
        "edit" => "edit".into(),
        "read" => "read".into(),
        "delete" => "delete".into(),
        "search" => "search".into(),
        "think" => "think".into(),
        _ => match tool.title.split(':').next().map(str::trim) {
            Some(head) if !head.is_empty() && !head.contains(' ') && head != "use_tool" => head.to_ascii_lowercase(),
            _ => "tool".into(),
        },
    }
}

fn bare(title: &str) -> String {
    title.replace('`', "")
}

pub fn tool_label(tool: &AcpTool) -> String {
    if let Some((server, name, args)) = tool.use_tool() {
        if server == CREW_SERVER {
            if let Some(label) = crew_label(&format!("mcp__crew__{name}"), &args) {
                return label;
            }
        }
        return mcp_label(&server, &name);
    }
    match tool.kind_of() {
        "execute" => match string_field(Some(&tool.input), "command") {
            Some(command) => clip(&command, 72),
            None => clip(&bare(&tool.title), 72),
        },
        "read" | "edit" | "delete" => {
            let verb = match tool.kind_of() {
                "read" => "Read",
                "edit" => "Edit",
                _ => "Delete",
            };
            match tool.path() {
                Some(path) => format!("{verb} {}", leaf(&path)),
                None => clip(&bare(&tool.title), 72),
            }
        }
        _ if tool.title.is_empty() || tool.title == "use_tool" => "Tool".into(),
        _ => clip(&bare(&tool.title), 72),
    }
}

pub fn tool_detail(tool: &AcpTool, update: &Map<String, Value>) -> Option<ToolDetail> {
    let output = update.get("rawOutput").and_then(as_record);
    let status = string_field(Some(update), "status").unwrap_or_default();
    let terminal = matches!(status.as_str(), "completed" | "failed");
    // An earlier update's `content` is the description, not the result.
    let printed = if terminal { content_text(update.get("content")).filter(|text| !text.trim().is_empty()) } else { None };
    if let Some((server, name, args)) = tool.use_tool() {
        if server == CREW_SERVER {
            return crew_tool_detail(&format!("mcp__crew__{name}"), &args);
        }
        let from_output = terminal.then(|| output.and_then(|raw| owned_str(raw.get("message")))).flatten();
        return Some(ToolDetail::Mcp { server, tool: name, input: pretty_input(&args), output: printed.or(from_output) });
    }
    let text = |key: &str| output.and_then(|row| owned_str(row.get(key)));
    match tool.kind_of() {
        "execute" => {
            let command = string_field(Some(&tool.input), "command")?;
            let printed =
                text("stdout").or_else(|| text("output")).or_else(|| text("stderr")).or_else(|| prompt_body(output)).or(printed);
            Some(ToolDetail::Command { command, exit_code: output.and_then(exit_code), output: printed })
        }
        "read" => {
            let preview = file_body(output).or_else(|| text("content")).or(printed);
            Some(ToolDetail::File { path: tool.path()?, line_start: None, line_end: None, preview })
        }
        _ => None,
    }
}

/// `_meta["x.ai/tool"]`, where grok names the tool the title does not.
fn xai_tool(update: &Map<String, Value>) -> Option<&Map<String, Value>> {
    update.get("_meta").and_then(as_record)?.get("x.ai/tool").and_then(as_record)
}

fn owned_str(value: Option<&Value>) -> Option<String> {
    value.and_then(Value::as_str).map(str::to_string).filter(|text| !text.trim().is_empty())
}

/// The text of a content block. A chunk is one `{type: text}` object. A tool
/// result is a list of `{type: content, content: {type: text}}` parts.
pub(crate) fn content_text(content: Option<&Value>) -> Option<String> {
    let content = content?;
    if let Some(text) = text_part(content) {
        return Some(text);
    }
    let mut out = String::new();
    for part in content.as_array()? {
        let text = part.as_object().and_then(|part| part.get("content")).and_then(text_part).or_else(|| text_part(part));
        if let Some(text) = text {
            out.push_str(&text);
        }
    }
    (!out.is_empty()).then_some(out)
}

fn text_part(value: &Value) -> Option<String> {
    let rec = as_record(value)?;
    if rec.get("type").and_then(Value::as_str) != Some("text") {
        return None;
    }
    value_str(rec.get("text"))
}

fn value_str(value: Option<&Value>) -> Option<String> {
    value.and_then(Value::as_str).map(str::to_string)
}

/// A finished read. `raw_output` is the file. `content` is the same text with
/// line numbers, used when that is all grok wrote.
fn file_body(raw: Option<&Map<String, Value>>) -> Option<String> {
    let file = raw?.get("FileContent").and_then(as_record)?;
    owned_str(file.get("raw_output")).or_else(|| owned_str(file.get("content")))
}

/// `output_for_prompt` leads with `exit: 0`. The text after that line is the output.
fn prompt_body(raw: Option<&Map<String, Value>>) -> Option<String> {
    let text = owned_str(raw?.get("output_for_prompt"))?;
    let body = match text.split_once('\n') {
        Some((head, tail)) if head.trim_start().starts_with("exit:") => tail.to_string(),
        _ => text,
    };
    (!body.trim().is_empty()).then_some(body)
}

fn exit_code(row: &Map<String, Value>) -> Option<i32> {
    row.get("exitCode").or_else(|| row.get("exit_code")).and_then(Value::as_i64).map(|code| code as i32)
}

/// Whether this update can open the row. `use_tool` waits until it names a
/// tool, even when grok already says the call is running. A title of "Tool"
/// is not a name.
pub fn tool_ready(tool: &AcpTool, status: &str) -> bool {
    let unnamed = tool.use_tool().is_none() && (tool.title == "use_tool" || tool.native.as_deref() == Some("use_tool"));
    !unnamed && (tool.named() || matches!(status, "in_progress" | "completed" | "failed"))
}

pub fn tool_end(status: &str, output: Option<&Map<String, Value>>) -> Option<ToolStatus> {
    match status {
        "failed" => Some(ToolStatus::Failed),
        "completed" => {
            let failed = output.is_some_and(|row| {
                row.get("error").is_some_and(|value| !value.is_null())
                    || row.get("success").and_then(Value::as_bool) == Some(false)
                    || exit_code(row).is_some_and(|code| code != 0)
            });
            Some(if failed { ToolStatus::Failed } else { ToolStatus::Completed })
        }
        _ => None,
    }
}

/// One question inside `ask_user_question`.
#[derive(Clone, Debug, PartialEq)]
pub struct GrokQuestion {
    pub question: Question,
}

/// A request the agent makes of Crew.
#[derive(Clone, Debug, PartialEq)]
pub enum GrokAsk {
    /// Shown as an approval card. `allow` and `reject` are option ids.
    /// `session_edits` is `allow-edits-session` when the request offers it,
    /// the only always-allow a person may choose.
    Approval {
        name: String,
        title: String,
        input: Value,
        allow: Option<String>,
        reject: Option<String>,
        session_edits: Option<String>,
    },
    /// Allowed at once, with this option id.
    Allow(String),
    /// `x.ai/ask_user_question` or `_x.ai/ask_user_question`.
    Questions(Vec<GrokQuestion>),
    /// `x.ai/exit_plan_mode` or `_x.ai/exit_plan_mode`. Answered at once.
    Plan {
        text: String,
    },
    Unsupported,
}

pub fn classify_request(method: &str, params: &Value, tools: &HashMap<String, AcpTool>, autonomy: &Autonomy) -> GrokAsk {
    if method == "x.ai/ask_user_question" || method == "_x.ai/ask_user_question" {
        return GrokAsk::Questions(read_questions(params));
    }
    if method == "x.ai/exit_plan_mode" || method == "_x.ai/exit_plan_mode" {
        return GrokAsk::Plan { text: plan_text(params) };
    }
    if method != "session/request_permission" {
        return GrokAsk::Unsupported;
    }
    let call = params.get("toolCall").and_then(as_record);
    let id = string_field(call, "toolCallId").unwrap_or_default();
    let mut tool = tools.get(&id).cloned().unwrap_or_else(|| AcpTool::new(&id));
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
    let session_edits = params.get("options").and_then(Value::as_array).and_then(|rows| {
        rows.iter()
            .filter_map(as_record)
            .find_map(|row| string_field(Some(row), "optionId").filter(|id| id == ALLOW_EDITS_SESSION))
    });
    if *autonomy == Autonomy::Full {
        return GrokAsk::Allow(allow.clone().unwrap_or_else(|| "allow-once".into()));
    }
    if let Some(option) = session_edits
        .clone()
        .filter(|_| *autonomy == Autonomy::Edits && tool.kind_of() == "edit")
        .or_else(|| allow.clone().filter(|_| tool.is_crew() || (*autonomy == Autonomy::Edits && tool.kind_of() == "edit")))
    {
        return GrokAsk::Allow(option);
    }
    let mut input = match tool.use_tool() {
        Some((_, _, args)) => Value::Object(args),
        None => Value::Object(tool.input.clone()),
    };
    if let Some(path) = tool.path() {
        input["path"] = json!(path);
    }
    GrokAsk::Approval { name: tool_name(&tool), title: tool_label(&tool), input, allow, reject, session_edits }
}

fn read_questions(params: &Value) -> Vec<GrokQuestion> {
    let body = if params.get("questions").is_some() { params } else { params.get("params").unwrap_or(params) };
    body.get("questions")
        .and_then(Value::as_array)
        .map(|rows| {
            rows.iter()
                .filter_map(as_record)
                .filter_map(|row| {
                    let question = string_field(Some(row), "question")?;
                    let options = row
                        .get("options")
                        .and_then(Value::as_array)?
                        .iter()
                        .filter_map(as_record)
                        .filter_map(|option| {
                            Some(QuestionOption {
                                label: string_field(Some(option), "label")?,
                                description: string_field(Some(option), "description"),
                            })
                        })
                        .collect::<Vec<_>>();
                    if options.is_empty() {
                        return None;
                    }
                    Some(GrokQuestion {
                        question: Question {
                            question,
                            header: "Question".into(),
                            multi_select: row.get("multiSelect").and_then(Value::as_bool).unwrap_or(false),
                            options,
                        },
                    })
                })
                .collect()
        })
        .unwrap_or_default()
}

fn plan_text(params: &Value) -> String {
    let body = if params.get("planContent").is_some() { params } else { params.get("params").unwrap_or(params) };
    body.get("planContent").and_then(Value::as_str).unwrap_or("").trim().to_string()
}

pub fn permission_response(option: Option<&str>) -> Value {
    match option {
        Some(option) => json!({ "outcome": { "outcome": "selected", "optionId": option } }),
        None => json!({ "outcome": { "outcome": "cancelled" } }),
    }
}

/// "Always" selects `allow-edits-session` when the card offered it, and
/// `allow_once` otherwise. Any other always-allow option is a project grant.
pub fn permission_answer(
    decision: &ApprovalDecision,
    allow: Option<&str>,
    reject: Option<&str>,
    session_edits: Option<&str>,
) -> Value {
    permission_response(match decision {
        ApprovalDecision::Allow => allow,
        ApprovalDecision::Always => session_edits.or(allow),
        ApprovalDecision::Deny => reject,
    })
}

/// What `ask_user_question` is answered with. Keys are the question text and
/// values are the chosen labels. No answer is `cancelled`, so the turn ends.
pub fn questions_response(questions: &[GrokQuestion], answers: Option<&HashMap<String, String>>) -> Value {
    let Some(answers) = answers else {
        return json!({ "outcome": "cancelled" });
    };
    let mut picked = Map::new();
    for asked in questions {
        if let Some(answer) = answers.get(&asked.question.question) {
            picked.insert(asked.question.question.clone(), json!([answer]));
        }
    }
    if picked.is_empty() {
        return json!({ "outcome": "cancelled" });
    }
    json!({ "outcome": "accepted", "answers": picked })
}

/// Plan mode is not a Crew mode. The plan is shown and the gate is abandoned,
/// which is what lets the turn finish.
pub fn plan_response() -> Value {
    json!({
        "outcome": "abandoned",
        "feedback": "Crew showed your plan. Stop here and wait for the user's next message.",
    })
}

/// A notice that the prompt is over, when `session/prompt` itself has not
/// answered. `task-completed-*` is a background task waking, not this turn.
#[derive(Clone, Debug, PartialEq)]
pub struct PromptSignal {
    pub prompt_id: String,
    pub stop_reason: String,
}

pub fn prompt_signal(method: &str, params: &Value) -> Option<PromptSignal> {
    let direct = method == "x.ai/session/prompt_complete" || method == "_x.ai/session/prompt_complete";
    let fields = if direct {
        params
    } else if session_channel(method) {
        let update = params.get("update")?;
        if update.get("sessionUpdate").and_then(Value::as_str) != Some("turn_completed") {
            return None;
        }
        update
    } else {
        return None;
    };
    let fields = as_record(fields)?;
    let prompt_id = string_field(Some(fields), "promptId").or_else(|| string_field(Some(fields), "prompt_id"))?;
    if prompt_id.starts_with("task-completed-") {
        return None;
    }
    let stop_reason = string_field(Some(fields), "stopReason")
        .or_else(|| string_field(Some(fields), "stop_reason"))
        .unwrap_or_else(|| "end_turn".into());
    Some(PromptSignal { prompt_id, stop_reason })
}

/// A monitor or background command finishing. An `in_progress` update whose
/// `exit_code` is already 0 is not this.
#[derive(Clone, Debug, PartialEq)]
pub struct TaskDone {
    pub tool_call_id: Option<String>,
    pub task_id: Option<String>,
    pub exit_code: Option<i64>,
}

pub fn task_done(method: &str, params: &Value) -> Option<TaskDone> {
    let update = if method == "x.ai/task_completed" || method == "_x.ai/task_completed" {
        params.get("update").unwrap_or(params)
    } else if session_channel(method) {
        let update = params.get("update")?;
        if update.get("sessionUpdate").and_then(Value::as_str) != Some("task_completed") {
            return None;
        }
        update
    } else {
        return None;
    };
    let row = as_record(update)?;
    let snap = row.get("task_snapshot").and_then(as_record);
    let tool_call_id = string_field(Some(row), "tool_call_id").or_else(|| string_field(Some(row), "toolCallId"));
    let task_id = task_field(Some(row)).or_else(|| task_field(snap));
    if tool_call_id.is_none() && task_id.is_none() {
        return None;
    }
    Some(TaskDone { tool_call_id, task_id, exit_code: snap.and_then(|snap| snap.get("exit_code").and_then(Value::as_i64)) })
}

fn session_channel(method: &str) -> bool {
    matches!(
        method,
        "session/update"
            | "x.ai/session/update"
            | "_x.ai/session/update"
            | "x.ai/session_notification"
            | "_x.ai/session_notification"
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn spawn_args_follow_autonomy_and_leave_the_model_off_argv() {
        let full = build_grok_spawn_args(&Autonomy::Full);
        assert_eq!(full, vec!["--no-auto-update", "agent", "--always-approve", "--no-leader", "stdio"]);
        let ask = build_grok_spawn_args(&Autonomy::Ask);
        assert_eq!(ask, vec!["--no-auto-update", "--permission-mode", "default", "agent", "--no-leader", "stdio"]);
        let edits = build_grok_spawn_args(&Autonomy::Edits);
        assert_eq!(edits, ask, "edits launches as default: {edits:?}");
        let auto = build_grok_spawn_args(&Autonomy::Auto);
        assert!(auto.windows(2).any(|pair| pair == ["--permission-mode", "auto"]), "{auto:?}");
        assert_eq!(auto[0], "--no-auto-update");
        for args in [&full, &ask, &edits, &auto] {
            assert!(!args.iter().any(|arg| arg == "--model" || arg == "--reasoning-effort" || arg == "acceptEdits"), "{args:?}");
        }
    }

    #[test]
    fn isolation_env_disables_foreign_imports_and_the_claude_permission_seed() {
        let env: HashMap<_, _> = isolation_env().into_iter().collect();
        for key in [
            "GROK_CLAUDE_AGENTS_ENABLED",
            "GROK_CLAUDE_HOOKS_ENABLED",
            "GROK_CLAUDE_MCPS_ENABLED",
            "GROK_CLAUDE_RULES_ENABLED",
            "GROK_CLAUDE_SKILLS_ENABLED",
            "GROK_CURSOR_AGENTS_ENABLED",
            "GROK_CURSOR_HOOKS_ENABLED",
            "GROK_CURSOR_MCPS_ENABLED",
            "GROK_CURSOR_RULES_ENABLED",
            "GROK_CURSOR_SKILLS_ENABLED",
        ] {
            assert_eq!(env[key], "0", "{key}");
        }
        assert_eq!(env["GROK_DISABLE_AUTOUPDATER"], "1");
        assert_eq!(env["_GROK_CLAUDE_MARKER_OVERRIDE"], "1");
        assert_eq!(env.len(), 12);
    }

    #[test]
    fn a_use_tool_call_is_the_tool_it_names() {
        let mut tool = AcpTool::new("t");
        tool.merge(
            &json!({
                "title": "use_tool",
                "rawInput": { "tool_name": "crew__send_message", "tool_input": { "to": "lead", "text": "hi" } }
            })
            .as_object()
            .unwrap()
            .clone(),
        );
        assert_eq!(tool_name(&tool), "mcp__crew__send_message");
        assert!(tool_label(&tool).contains("lead"), "{}", tool_label(&tool));
        assert!(matches!(tool_detail(&tool, &Map::new()), Some(ToolDetail::Message { .. })));
        assert!(tool.is_crew());
    }

    #[test]
    fn a_shell_is_bash_and_its_exit_code_is_snake_case() {
        let mut tool = AcpTool::new("s");
        tool.merge(
            &json!({ "title": "run_terminal_command", "rawInput": { "command": "echo hi" } }).as_object().unwrap().clone(),
        );
        assert_eq!(tool_name(&tool), "bash");
        let output = json!({ "exit_code": 1, "output": "no" });
        assert_eq!(tool_end("completed", output.as_object()), Some(ToolStatus::Failed));
        assert_eq!(tool_end("completed", json!({ "exit_code": 0 }).as_object()), Some(ToolStatus::Completed));
        let update = json!({ "status": "completed", "rawOutput": { "exit_code": 0, "output_for_prompt": "exit: 0\nhi\n" } });
        let Some(ToolDetail::Command { command, exit_code, output }) = tool_detail(&tool, update.as_object().unwrap()) else {
            panic!("command");
        };
        assert_eq!(command, "echo hi");
        assert_eq!(exit_code, Some(0));
        assert_eq!(output.as_deref(), Some("hi\n"));
    }

    #[test]
    fn ask_mode_shows_a_shell_and_allows_crews_own_tool() {
        let params = json!({
            "toolCall": {
                "toolCallId": "c",
                "kind": "execute",
                "title": "Execute `printf hi`",
                "rawInput": { "variant": "Bash", "command": "printf hi" }
            },
            "options": [
                { "kind": "allow_once", "optionId": "allow-once", "name": "Yes" },
                { "kind": "reject_once", "optionId": "reject-once", "name": "No" }
            ]
        });
        match classify_request("session/request_permission", &params, &HashMap::new(), &Autonomy::Ask) {
            GrokAsk::Approval { name, allow, reject, .. } => {
                assert_eq!(name, "bash");
                assert_eq!(allow.as_deref(), Some("allow-once"));
                assert_eq!(reject.as_deref(), Some("reject-once"));
            }
            other => panic!("{other:?}"),
        }
        let crew = json!({
            "toolCall": {
                "toolCallId": "m",
                "title": "use_tool",
                "rawInput": { "tool_name": "crew__list_peers", "tool_input": {} }
            },
            "options": [{ "kind": "allow_once", "optionId": "allow-once", "name": "Yes" }]
        });
        assert_eq!(
            classify_request("session/request_permission", &crew, &HashMap::new(), &Autonomy::Ask),
            GrokAsk::Allow("allow-once".into())
        );
    }

    #[test]
    fn config_and_session_requests_carry_the_session_not_a_fixed_model() {
        let params = set_config_params("sid", "model", "grok-4.5");
        assert_eq!(params["value"], "grok-4.5");
        assert!(params["value"].as_str().is_some(), "the value is a string, not an object");
        let (method, created) = session_request("/work", None, &json!([]));
        assert_eq!(method, "session/new");
        assert!(created.get("_meta").is_none(), "permission mode is the process, not session meta");
        let (method, loaded) = session_request("/work", Some("sid"), &json!([]));
        assert_eq!(method, "session/load");
        assert_eq!(loaded["mcpServers"], json!([]));
        assert_eq!(loaded["cwd"], "/work");
        assert_eq!(loaded["sessionId"], "sid");
        assert_eq!(initialize_params()["_meta"]["clientType"], "extension");
        let prompt = prompt_params("sid", "hi", "p1");
        assert_eq!(prompt["_meta"]["promptId"], "p1");
        assert_eq!(cancel_params("sid")["_meta"]["cancelTrigger"], "ctrl_c");
    }

    #[test]
    fn a_title_of_tool_still_unwraps_use_tool_from_the_native_name() {
        let mut tool = AcpTool::new("t");
        tool.merge(
            &json!({
                "title": "Tool",
                "_meta": { "x.ai/tool": { "name": "use_tool" } },
                "rawInput": { "tool_name": "crew__echo", "tool_input": { "text": "ping" } }
            })
            .as_object()
            .unwrap()
            .clone(),
        );
        assert_eq!(tool_name(&tool), "mcp__crew__echo");
        let mut nested = AcpTool::new("n");
        nested.merge(
            &json!({
                "title": "Tool",
                "_meta": { "x.ai/tool": { "name": "use_tool" } },
                "rawInput": { "tool_input": { "tool_name": "crew__echo", "tool_input": { "text": "ping" } } }
            })
            .as_object()
            .unwrap()
            .clone(),
        );
        assert_eq!(tool_name(&nested), "mcp__crew__echo");
    }

    #[test]
    fn edits_approve_only_edits_and_full_access_allows_once() {
        let edit = json!({
            "toolCall": { "toolCallId": "e", "kind": "edit", "title": "edit file", "rawInput": { "path": "a.txt" } },
            "options": [
                { "kind": "allow_always", "optionId": "allow-edits-session", "name": "edits" },
                { "kind": "allow_always", "optionId": "always-allow", "name": "always" },
                { "kind": "allow_once", "optionId": "allow-once", "name": "Yes" },
                { "kind": "reject_once", "optionId": "reject-once", "name": "No" }
            ]
        });
        assert_eq!(
            classify_request("session/request_permission", &edit, &HashMap::new(), &Autonomy::Edits),
            GrokAsk::Allow("allow-edits-session".into())
        );
        assert!(matches!(
            classify_request("session/request_permission", &edit, &HashMap::new(), &Autonomy::Ask),
            GrokAsk::Approval { session_edits: Some(id), .. } if id == "allow-edits-session"
        ));
        let shell = json!({
            "toolCall": { "toolCallId": "s", "kind": "execute", "title": "run", "rawInput": { "command": "ls" } },
            "options": [
                { "kind": "allow_always", "optionId": "always-allow" },
                { "kind": "allow_once", "optionId": "allow-once" }
            ]
        });
        assert_eq!(
            classify_request("session/request_permission", &shell, &HashMap::new(), &Autonomy::Full),
            GrokAsk::Allow("allow-once".into())
        );
        let answer =
            permission_answer(&ApprovalDecision::Always, Some("allow-once"), Some("reject-once"), Some("allow-edits-session"));
        assert_eq!(answer["outcome"]["optionId"], "allow-edits-session");
        let once = permission_answer(&ApprovalDecision::Always, Some("allow-once"), Some("reject-once"), None);
        assert_eq!(once["outcome"]["optionId"], "allow-once");
    }

    #[test]
    fn a_rate_limit_is_a_failure_and_a_missing_session_is_not_an_auth_error() {
        assert_eq!(turn_end(&json!({ "stopReason": "rate_limit" })), TurnEnd::Failed("Grok is rate limited.".into()));
        assert_eq!(rpc_error_message(&json!({ "code": -32003, "message": "usage limit" })), "Grok is rate limited.");
        assert!(session_missing("Session not found"));
        assert!(!session_missing("authentication required"));
        assert!(prompt_signal("_x.ai/session/prompt_complete", &json!({ "promptId": "p", "stopReason": "end_turn" })).is_some());
        assert!(prompt_signal(
            "x.ai/session/prompt_complete",
            &json!({ "promptId": "task-completed-p", "stopReason": "end_turn" })
        )
        .is_none());
        let done =
            task_done("_x.ai/task_completed", &json!({ "update": { "tool_call_id": "c", "task_snapshot": { "exit_code": 0 } } }))
                .expect("task");
        assert_eq!(done.tool_call_id.as_deref(), Some("c"));
        assert_eq!(tool_end("in_progress", json!({ "exit_code": 0 }).as_object()), None);
    }
}
