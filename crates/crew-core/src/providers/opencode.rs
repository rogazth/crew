//! opencode 2.x as Crew speaks to it: the config its one `opencode serve`
//! starts with, the bodies Crew sends, and what Crew reads from the events
//! the server streams. The server itself is `opencode_server.rs`; the driver
//! that turns these into a session's turns is `turns/opencode.rs`. Shapes
//! were read off 2.0.26 (`scratchpad/opencode-api/live`, step 5 §4).

use std::collections::HashMap;

use crew_protocol::{CommandEntry, EditHunk, McpServer, McpState, Question, QuestionOption, ToolDetail, ToolStatus, TurnUsage};
use serde_json::{json, Map, Value};

use super::runtime::Autonomy;
use super::{
    as_record, clip, crew_result_detail, crew_tool_detail, finite_number, leaf, string_field, subagent_report, todo_items,
};

/// How long opencode lets one call to Crew's server run, in milliseconds: a
/// wait plus its margin (plan §7e.2), the same 65 minutes Codex and Claude
/// get.
pub const MCP_TIMEOUT_MS: u64 = 3_900_000;

/// The oldest opencode whose API Crew speaks: the prompt, inbox and form
/// routes it uses settled in 2.0.4.
pub const MIN_VERSION: (u32, u32, u32) = (2, 0, 4);

/// The newest opencode Crew was tested on. Several routes are still under
/// `experimental/`, so a newer one runs with a word that it may misbehave.
pub const TESTED_VERSION: (u32, u32, u32) = (2, 0, 26);

/// What tells a 1.x install from a 2.x one, and how to get 2.x.
pub const INSTALL: &str = "Crew needs opencode 2.x: npm i -g @opencode/cli";

/// The config Crew's `opencode serve` starts with, a file `OPENCODE_CONFIG`
/// names, in the 2.x format: it merges over the user's own, so their
/// providers, servers and rules stand.
/// - Crew's MCP server, with only `timeout.execution`: a 1.x `timeout: N`
///   becomes `{catalog: N, execution: N}`, and a hung tool list would wait
///   the 65 minutes a call may take.
/// - `codemode: false`: by default opencode puts a server's tools behind its
///   `execute` tool, as `tools.crew.send_message()` in code the model writes,
///   and the persona's `crew_send_message` would name nothing the model sees
///   (measured on 2.0.26: with it off, the call is `crew_list_peers`).
/// - Crew's tools allowed: `crew_<tool>` is the permission action of one.
/// - `env` is the MCP server's own environment (Crew's socket, the run's host
///   token). opencode adds it to what the server process has, and only the MCP
///   server sees it: a shell inherits the server's environment, never this.
pub fn server_config(mcp: Option<&(String, Vec<String>)>, env: &[(String, String)]) -> String {
    let mut config = Map::new();
    config.insert("$schema".into(), json!("https://opencode.ai/config.json"));
    if let Some((exe, args)) = mcp {
        let mut command = vec![exe.clone()];
        command.extend(args.iter().cloned());
        config.insert(
            "mcp".into(),
            json!({ "servers": { "crew": {
                "type": "local",
                "command": command,
                "timeout": { "execution": MCP_TIMEOUT_MS },
                "codemode": false,
                "environment": env.iter().map(|(key, value)| (key.clone(), json!(value))).collect::<Map<String, Value>>(),
            } } }),
        );
        config.insert("permissions".into(), json!([crew_rule()]));
    }
    Value::Object(config).to_string()
}

fn rule(action: &str, effect: &str) -> Value {
    json!({ "action": action, "resource": "*", "effect": effect })
}

fn crew_rule() -> Value {
    rule("crew_*", "allow")
}

/// The rules a session runs under, by its autonomy. opencode's own agent
/// allows everything but reading `.env` files, and a session's rules come
/// after it, so a rule here is what makes it ask. Crew's tools are allowed
/// last, whatever the rest says, as the other drivers do. A bot has nobody
/// to put a question to: its question tool is denied, as Claude's is left out.
/// - Full: everything.
/// - Edits, and auto (which has no reviewer here): edits go, a command, a
///   fetch or a file outside the folder asks.
/// - Ask: edits ask too.
pub fn permission_rules(autonomy: &Autonomy, bot: bool) -> Value {
    let mut rules = match autonomy {
        Autonomy::Full => vec![rule("*", "allow")],
        Autonomy::Edits | Autonomy::Auto => {
            vec![rule("shell", "ask"), rule("webfetch", "ask"), rule("external_directory", "ask")]
        }
        Autonomy::Ask => vec![
            rule("edit", "ask"),
            rule("shell", "ask"),
            rule("webfetch", "ask"),
            rule("external_directory", "ask"),
        ],
    };
    if bot {
        rules.push(rule("question", "deny"));
    }
    rules.push(crew_rule());
    Value::Array(rules)
}

/// A Crew model id (`opencode/nemotron-3.5-lightning-free`, provider and
/// model) as opencode names it, with the effort as its variant. None for an
/// empty one: the server's default stands.
pub fn model_ref(model: &str, effort: &str) -> Option<Value> {
    let (provider, id) = model.trim().split_once('/')?;
    if provider.is_empty() || id.is_empty() {
        return None;
    }
    let mut out = json!({ "providerID": provider, "id": id });
    if !effort.trim().is_empty() {
        out["variant"] = json!(effort.trim());
    }
    Some(out)
}

/// `2.0.26` as numbers; a pre-release suffix is ignored.
pub fn parse_version(version: &str) -> Option<(u32, u32, u32)> {
    let version = version.trim().trim_start_matches("opencode").trim().trim_start_matches('v');
    let mut parts = version.split(['.', '-', '+']).map(|part| part.parse::<u32>());
    Some((parts.next()?.ok()?, parts.next()?.ok()?, parts.next().and_then(Result::ok).unwrap_or(0)))
}

/// What `/api/info`'s version means for Crew: refused below
/// [`MIN_VERSION`], with a word above [`TESTED_VERSION`], fine between.
pub fn version_check(version: &str) -> Result<Option<String>, String> {
    let Some(parsed) = parse_version(version) else {
        return Err(format!("opencode said its version is {version:?}, which Crew cannot read. {INSTALL}"));
    };
    let show = |(a, b, c): (u32, u32, u32)| format!("{a}.{b}.{c}");
    if parsed < MIN_VERSION {
        return Err(format!("{INSTALL} {} or newer (found {version}).", show(MIN_VERSION)));
    }
    Ok((parsed > TESTED_VERSION).then(|| {
        format!(
            "opencode {version} is newer than {}, the last one Crew was tested with. Its API is still moving: if something misbehaves, that may be why.",
            show(TESTED_VERSION)
        )
    }))
}

/// Where opencode is in moving a 1.x database to 2.x, from
/// `/api/experimental/migration/v1`.
#[derive(Debug, PartialEq)]
pub enum Migration {
    Done,
    Running { label: String, done: u64, total: u64 },
    Failed(String),
}

pub fn migration(status: &Value) -> Migration {
    match status.get("status").and_then(Value::as_str) {
        Some("running") => Migration::Running {
            label: status.pointer("/progress/label").and_then(Value::as_str).unwrap_or("Migrating").to_string(),
            done: status.pointer("/progress/numerator").and_then(Value::as_u64).unwrap_or(0),
            total: status.pointer("/progress/denominator").and_then(Value::as_u64).unwrap_or(0),
        },
        Some("failed" | "error") => Migration::Failed(
            status.get("error").and_then(Value::as_str).unwrap_or("opencode could not move its sessions to 2.x").to_string(),
        ),
        _ => Migration::Done,
    }
}

/// A turn's text with the paths of what was attached under it.
pub fn with_attached_paths(text: &str, files: &[String]) -> String {
    if files.is_empty() {
        return text.to_string();
    }
    let list = files.iter().map(|path| format!("- {path}")).collect::<Vec<_>>().join("\n");
    let note = format!("Attached files:\n{list}");
    if text.is_empty() {
        note
    } else {
        format!("{text}\n\n{note}")
    }
}

/// What a bot's turn sends: the tail of its conversation, then what is being
/// asked now. Its persona is the session's instruction entry, not text the
/// model could scroll past.
pub fn bot_text(history: Option<&str>, text: &str, files: &[String]) -> String {
    super::assemble(String::new(), history, &with_attached_paths(text.trim(), files))
}

/// The body of a prompt. `steer` delivers it at the next step of a running
/// turn (and starts one when none runs); the turn's own message goes the same
/// way, so a turn opencode started by itself in the meantime takes it in.
pub fn prompt_body(text: &str, skills: &[String]) -> Value {
    let mut body = json!({ "text": text, "delivery": "steer" });
    if !skills.is_empty() {
        body["skills"] = skills.iter().map(|id| json!({ "id": id })).collect();
    }
    body
}

/// The opencode session an event is about: its `sessionID`, a form's or a
/// shell's (`metadata.sessionID`). None for the server's own events.
pub fn session_of(event: &Value) -> Option<&str> {
    let data = event.get("data")?;
    data.get("sessionID")
        .or_else(|| data.pointer("/form/sessionID"))
        .or_else(|| data.pointer("/info/metadata/sessionID"))
        .and_then(Value::as_str)
}

/// The folder a server event names (`command.updated`, `skill.updated`).
pub fn directory_of(event: &Value) -> Option<&str> {
    event.pointer("/location/directory").and_then(Value::as_str)
}

fn count(rec: Option<&Value>, key: &str) -> u64 {
    finite_number(rec.and_then(|rec| rec.get(key))).filter(|n| *n >= 0.0).unwrap_or(0.0) as u64
}

/// How much of the window a step's request held: everything it sent and
/// everything it got back, the cache included. The last step's, not the sum
/// of a turn's steps, each of which sends the whole conversation again.
pub fn context_used(step: &Value) -> Option<u64> {
    let tokens = step.get("tokens")?;
    let cache = tokens.get("cache");
    Some(
        count(Some(tokens), "input")
            + count(cache, "read")
            + count(cache, "write")
            + count(Some(tokens), "output")
            + count(Some(tokens), "reasoning"),
    )
}

/// A turn's usage with one more step's counted in: each `step.ended` (and a
/// `step.failed`) counts its own step only. The cache is billed as input and
/// reasoning as output, so both land in the turn's counts.
pub fn add_usage(prev: Option<&TurnUsage>, step: &Value) -> TurnUsage {
    let tokens = step.get("tokens");
    let cache = tokens.and_then(|tokens| tokens.get("cache"));
    let input = count(tokens, "input") + count(cache, "read") + count(cache, "write");
    let output = count(tokens, "output") + count(tokens, "reasoning");
    let cost = finite_number(step.get("cost")).unwrap_or(0.0);
    TurnUsage {
        input_tokens: Some(prev.and_then(|prev| prev.input_tokens).unwrap_or(0) + input),
        output_tokens: Some(prev.and_then(|prev| prev.output_tokens).unwrap_or(0) + output),
        cost_usd: Some(prev.and_then(|prev| prev.cost_usd).unwrap_or(0.0) + cost),
        duration_ms: None,
    }
}

/// Why a step stopped, when that is not "it answered" or "it called tools":
/// a turn that died mid-answer must not paint green because nothing follows.
pub fn finish_failure(finish: &str) -> Option<String> {
    match finish {
        "stop" | "tool-calls" | "" => None,
        "length" => Some("The model ran out of room mid-answer.".into()),
        "content-filter" => Some("The provider stopped the answer.".into()),
        other => Some(format!("The turn ended early: {other}.")),
    }
}

/// What a failed execution or step says went wrong.
pub fn error_message(data: &Value) -> String {
    data.pointer("/error/message")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|message| !message.is_empty())
        .map(str::to_string)
        .unwrap_or_else(|| "opencode turn failed.".into())
}

/// The text a tool answered with: its content's text parts, in order.
pub fn tool_output(data: &Value) -> Option<String> {
    let text: Vec<&str> = data
        .get("content")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter(|part| part.get("type").and_then(Value::as_str) == Some("text"))
        .filter_map(|part| part.get("text").and_then(Value::as_str))
        .collect();
    Some(text.join("\n")).filter(|text| !text.is_empty())
}

/// How a tool call ended, in the terms both opencode formats share: 1.x
/// carries it on the part's `state`, 2.x on `session.tool.success|failed`.
#[derive(Default)]
pub struct ToolEnd<'a> {
    /// `completed` or `error`; None while it runs.
    pub status: Option<&'a str>,
    pub output: Option<String>,
    pub error: Option<String>,
    pub metadata: Option<&'a Map<String, Value>>,
}

/// A shell that answers with a non-zero exit failed as surely as a tool that
/// threw, and opencode calls both of those `completed`. A call the model got
/// wrong is reported as a completed tool named `invalid`.
pub fn tool_status(name: &str, end: &ToolEnd) -> ToolStatus {
    let failed = name == "invalid"
        || end.status == Some("error")
        || end.metadata.and_then(|meta| meta.get("exit")).and_then(Value::as_i64).is_some_and(|code| code != 0);
    if failed {
        ToolStatus::Failed
    } else if end.status.is_none() {
        ToolStatus::Pending
    } else {
        ToolStatus::Completed
    }
}

/// A tool that threw names no output, only the error, so the row shows that
/// instead of the shape it would have had.
pub fn tool_detail(name: &str, input: &Map<String, Value>, end: &ToolEnd) -> Option<ToolDetail> {
    if let Some(detail) = crew_tool_detail(name, input) {
        // Once it answered: the letter it made, or why Crew refused it.
        let done = match end.status {
            Some("completed") => end.output.as_deref().and_then(|out| crew_result_detail(name, input, out, false)),
            Some("error") => end.error.as_deref().and_then(|why| crew_result_detail(name, input, why, true)),
            _ => None,
        };
        return Some(done.unwrap_or(detail));
    }
    if end.status == Some("error") {
        return Some(ToolDetail::Output { text: end.error.clone()? });
    }
    let meta = end.metadata;
    let meta_text = |key: &str| meta.and_then(|meta| meta.get(key)).and_then(Value::as_str).filter(|t| !t.is_empty()).map(str::to_string);
    match name {
        // 1.x calls it `bash`, 2.x `shell`.
        "bash" | "shell" => Some(ToolDetail::Command {
            command: string_field(Some(input), "command")?,
            exit_code: meta.and_then(|meta| meta.get("exit")).and_then(Value::as_i64).map(|code| code as i32),
            output: meta_text("output").or_else(|| end.output.clone()),
        }),
        "read" => {
            let display = meta.and_then(|meta| meta.get("display")).and_then(as_record);
            Some(ToolDetail::File {
                path: string_field(display, "path")
                    .or_else(|| string_field(Some(input), "filePath"))
                    .or_else(|| string_field(Some(input), "path"))?,
                line_start: line_number(display, "lineStart"),
                line_end: line_number(display, "lineEnd"),
                preview: meta_text("preview").or_else(|| display.and_then(|d| d.get("text")).and_then(Value::as_str).map(str::to_string)),
            })
        }
        // opencode counts no lines on a write, so the counts stay unset; the
        // replacement is in the input, as it is for Claude.
        "write" | "edit" | "patch" => Some(ToolDetail::Edit {
            path: meta_text("filepath")
                .or_else(|| string_field(Some(input), "filePath"))
                .or_else(|| string_field(Some(input), "path"))?,
            added: None,
            removed: None,
            hunks: edit_hunk(name, input).map(|hunk| vec![hunk]),
        }),
        "grep" | "glob" => Some(ToolDetail::Search {
            query: string_field(Some(input), "pattern")?,
            matches: meta.and_then(|meta| meta.get("matches")).and_then(Value::as_u64).map(|n| n as u32),
            output: end.output.clone(),
        }),
        "webfetch" => Some(ToolDetail::Fetch { url: string_field(Some(input), "url")?, title: None, output: end.output.clone() }),
        "todowrite" => Some(ToolDetail::Todo { items: todo_items(input.get("todos"))? }),
        "task" | "subagent" => Some(ToolDetail::Agent {
            description: string_field(Some(input), "description").unwrap_or_else(|| "Subagent".into()),
            agent_type: string_field(Some(input), "subagent_type").or_else(|| string_field(Some(input), "agent")),
            prompt: text_field(Some(input), "prompt"),
            output: end.output.as_deref().map(subagent_report),
            background: None,
            state: None,
            activity: None,
            steps: None,
            thread: string_field(Some(input), "sessionID").or_else(|| meta_text("sessionID")),
        }),
        // Code the model ran against a server's tools (Code Mode): what it ran.
        "execute" => Some(ToolDetail::Command {
            command: string_field(Some(input), "code")?,
            exit_code: None,
            output: end.output.clone(),
        }),
        _ => Some(ToolDetail::Output { text: end.output.clone()? }),
    }
}

/// The row's one line: what the call did, to what.
pub fn tool_label(name: &str, input: &Map<String, Value>) -> String {
    if let Some((verb, input)) = super::crew_call(name, input) {
        let input: &Map<String, Value> = &input;
        let subject = string_field(Some(input), "to")
            .or_else(|| string_field(Some(input), "name"))
            .or_else(|| string_field(Some(input), "query"));
        let verb = format!("Crew {}", verb.replace('_', " "));
        return match subject {
            Some(subject) => format!("{verb} {}", clip(&subject, 40)),
            None => verb,
        };
    }
    if let Some(command) = string_field(Some(input), "command") {
        return clip(&command, 72);
    }
    let verb = pretty_tool(name);
    if let Some(path) = string_field(Some(input), "filePath").or_else(|| string_field(Some(input), "path")) {
        return format!("{verb} {}", leaf(&path));
    }
    if let Some(query) = string_field(Some(input), "pattern")
        .or_else(|| string_field(Some(input), "url"))
        .or_else(|| string_field(Some(input), "description"))
    {
        return format!("{verb} {}", clip(&query, 40));
    }
    verb
}

fn pretty_tool(name: &str) -> String {
    match name {
        "webfetch" => "Fetch".into(),
        "todowrite" | "todoread" => "Todo".into(),
        "execute" => "Code".into(),
        other => {
            let mut chars = other.chars();
            match chars.next() {
                Some(first) => first.to_uppercase().collect::<String>() + chars.as_str(),
                None => "Tool".into(),
            }
        }
    }
}

/// Output and file excerpts keep their whitespace: `string_field` trims, and a
/// preview that starts mid-indentation would lose its shape.
fn edit_hunk(name: &str, input: &Map<String, Value>) -> Option<EditHunk> {
    let (before, after) = match name {
        "edit" => (text_field(Some(input), "oldString"), text_field(Some(input), "newString")),
        "write" => (None, text_field(Some(input), "content")),
        _ => return None,
    };
    (before.is_some() || after.is_some()).then(|| EditHunk { before: before.unwrap_or_default(), after: after.unwrap_or_default() })
}

pub fn text_field(rec: Option<&Map<String, Value>>, key: &str) -> Option<String> {
    rec?.get(key).and_then(Value::as_str).filter(|text| !text.is_empty()).map(str::to_string)
}

fn line_number(rec: Option<&Map<String, Value>>, key: &str) -> Option<u32> {
    rec?.get(key).and_then(Value::as_u64).map(|line| line as u32)
}

/// What an approval card shows for a `permission.asked`: the tool that asks
/// (the call it names, else the permission's action), a line for the title,
/// and what it would do.
pub struct Ask {
    pub tool: String,
    pub title: String,
    pub input: Value,
}

/// `permission.asked` names the action (`shell`, `edit`) and the resources it
/// would touch (each command of a shell line apart); the call it came from
/// carries the input, which `calls` holds by call id when the driver saw it.
pub fn ask_of(asked: &Value, calls: &HashMap<String, (String, Map<String, Value>)>) -> Ask {
    let action = asked.get("action").and_then(Value::as_str).unwrap_or("tool").to_string();
    let resources: Vec<String> = asked
        .get("resources")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(|resource| resource.as_str().map(str::to_string))
        .collect();
    let call = asked.pointer("/source/id").and_then(Value::as_str).and_then(|id| calls.get(id));
    let (tool, input) = match call {
        Some((name, input)) => (name.clone(), Value::Object(input.clone())),
        None => (action.clone(), json!({ "resources": resources })),
    };
    let title = match &input {
        Value::Object(map) if call.is_some() => tool_label(&tool, map),
        _ => match resources.as_slice() {
            [] => pretty_tool(&action),
            many => clip(&many.join("; "), 72),
        },
    };
    // An edit's card is decided by a parent that may edit: it names the
    // action, which is what `may_decide` reads.
    let tool = if action == "edit" { action } else { tool };
    Ask { tool, title, input }
}

/// A form's fields as the questions Crew's card asks, each with its key.
/// opencode's question tool makes a string field per question, its header as
/// the title, its text as the description, its choices as options.
pub fn form_questions(form: &Value) -> Vec<(String, Question)> {
    form.get("fields")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter(|field| field.get("hidden").and_then(Value::as_bool) != Some(true))
        .filter_map(|field| {
            let key = field.get("key")?.as_str()?.to_string();
            let title = field.get("title").and_then(Value::as_str).unwrap_or_default();
            let description = field.get("description").and_then(Value::as_str).unwrap_or_default();
            let options = field
                .get("options")
                .and_then(Value::as_array)
                .into_iter()
                .flatten()
                .filter_map(|option| {
                    Some(QuestionOption {
                        label: option.get("label")?.as_str()?.to_string(),
                        description: option.get("description").and_then(Value::as_str).map(str::to_string),
                    })
                })
                .collect();
            let question = if description.is_empty() { title } else { description };
            Some((
                key,
                Question {
                    question: question.to_string(),
                    header: if title.is_empty() { "Question".into() } else { title.to_string() },
                    multi_select: field.get("type").and_then(Value::as_str) == Some("multiselect"),
                    options,
                },
            ))
        })
        .collect()
}

/// The answer a form takes for what Crew's card collected: each field's by its
/// question, its key or its header, an option's label turned back into its
/// value, a multi-select's picks (said as `a, b`) as a list.
pub fn form_answer(form: &Value, answers: &HashMap<String, String>) -> Value {
    let questions = form_questions(form);
    let fields: Vec<&Value> = form.get("fields").and_then(Value::as_array).into_iter().flatten().collect();
    let mut out = Map::new();
    for (key, question) in &questions {
        let said = answers
            .get(&question.question)
            .or_else(|| answers.get(key))
            .or_else(|| answers.get(&question.header))
            .or_else(|| (questions.len() == 1 && answers.len() == 1).then(|| answers.values().next()).flatten());
        let Some(said) = said else {
            continue;
        };
        let field = fields.iter().find(|field| field.get("key").and_then(Value::as_str) == Some(key.as_str()));
        let value_of = |label: &str| {
            field
                .and_then(|field| field.get("options"))
                .and_then(Value::as_array)
                .into_iter()
                .flatten()
                .find(|option| option.get("label").and_then(Value::as_str) == Some(label))
                .and_then(|option| option.get("value").and_then(Value::as_str))
                .unwrap_or(label)
                .to_string()
        };
        let value = if question.multi_select {
            Value::Array(said.split(", ").filter(|pick| !pick.is_empty()).map(|pick| Value::String(value_of(pick))).collect())
        } else {
            Value::String(value_of(said))
        };
        out.insert(key.clone(), value);
    }
    Value::Object(out)
}

/// The `/` menu entries of `/api/command`: opencode's commands in a folder.
pub fn command_entries(listed: &Value) -> Vec<CommandEntry> {
    entries(listed, "name", "command")
}

/// The skills of `/api/skill`, by the id a prompt names them with.
pub fn skill_entries(listed: &Value) -> Vec<CommandEntry> {
    entries(listed, "id", "skill")
}

fn entries(listed: &Value, name: &str, kind: &str) -> Vec<CommandEntry> {
    listed
        .get("data")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(|entry| {
            let name = entry.get(name)?.as_str()?.trim();
            if name.is_empty() {
                return None;
            }
            Some(CommandEntry {
                name: name.into(),
                description: entry.get("description").and_then(Value::as_str).unwrap_or_default().trim().to_string(),
                argument_hint: None,
                aliases: None,
                kind: kind.into(),
                path: entry.get("path").and_then(Value::as_str).map(str::to_string),
            })
        })
        .collect()
}

/// The commands Crew runs through routes of opencode's own rather than
/// `/command`. opencode does not list them, so the menu carries these.
pub fn crew_commands() -> Vec<CommandEntry> {
    vec![CommandEntry {
        name: "compact".into(),
        description: "Compact the conversation into a summary".into(),
        argument_hint: None,
        aliases: None,
        kind: "command".into(),
        path: None,
    }]
}

/// A model's window, from `/api/model`'s list: `limit.context` of the one
/// `model` names (`{providerID, id}`).
pub fn context_window(models: &Value, model: &Value) -> Option<u64> {
    let provider = model.get("providerID")?.as_str()?;
    let id = model.get("id")?.as_str()?;
    models
        .get("data")?
        .as_array()?
        .iter()
        .find(|row| {
            row.get("providerID").and_then(Value::as_str) == Some(provider)
                && (row.get("id").and_then(Value::as_str) == Some(id) || row.get("modelID").and_then(Value::as_str) == Some(id))
        })?
        .pointer("/limit/context")?
        .as_u64()
}

/// The servers of `GET /api/mcp`'s `data` (plan decision 20): each is
/// `{name, status: {status, error?}, integrationID?}`. A server that needs a
/// login names the integration its sign-in is started under, which is read
/// when the user asks, so no sign-in is named here.
pub fn mcp_servers(list: &Value) -> Vec<McpServer> {
    list.as_array()
        .map(Vec::as_slice)
        .unwrap_or_default()
        .iter()
        .filter_map(|row| {
            let row = as_record(row)?;
            let name = string_field(Some(row), "name")?;
            let status = row.get("status").and_then(as_record);
            let state = mcp_state(&string_field(status, "status").unwrap_or_default());
            let error = string_field(status, "error")
                .filter(|_| matches!(state, McpState::Failed | McpState::NeedsAuth))
                .map(|error| crate::mcp_status::clip(&error));
            Some(McpServer { name, state, error, sign_in: None })
        })
        .collect()
}

fn mcp_state(status: &str) -> McpState {
    match status {
        "connected" => McpState::Connected,
        "pending" => McpState::Pending,
        "failed" => McpState::Failed,
        "needs_auth" => McpState::NeedsAuth,
        "disabled" => McpState::Disabled,
        _ => McpState::Unknown,
    }
}

/// The integration a named server's sign-in is under (`integrationID`), when
/// the server has one.
pub fn mcp_integration(list: &Value, name: &str) -> Option<String> {
    list.as_array()?
        .iter()
        .filter_map(as_record)
        .find(|row| string_field(Some(row), "name").as_deref() == Some(name))
        .and_then(|row| string_field(Some(row), "integrationID"))
}

/// The OAuth method of an integration (`GET /api/integration/{id}`'s
/// `data.methods`), which is what a sign-in starts with.
pub fn oauth_method(integration: &Value) -> Option<String> {
    integration
        .pointer("/data/methods")?
        .as_array()?
        .iter()
        .filter_map(as_record)
        .find(|method| string_field(Some(method), "type").as_deref() == Some("oauth"))
        .and_then(|method| string_field(Some(method), "id"))
}

/// The page a started sign-in sends the user to, and how opencode finishes
/// it: `auto` when its own callback takes the browser's redirect, `code`
/// when the user has to copy a code back (`data.url`, `data.mode`).
pub fn sign_in_attempt(reply: &Value) -> Option<(String, String)> {
    let data = reply.get("data")?;
    Some((string_field(as_record(data), "url")?, string_field(as_record(data), "mode")?))
}

/// A value as one URL path segment: every byte but the unreserved ones is
/// percent-encoded, so a server named with a space or a slash still addresses
/// its own route.
pub fn path_segment(raw: &str) -> String {
    raw.bytes()
        .map(|byte| match byte {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'.' | b'_' | b'~' => (byte as char).to_string(),
            _ => format!("%{byte:02X}"),
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Each status says the state Crew shows; a failure or a login keeps the
    /// provider's words, clipped, and a connected server keeps none.
    #[test]
    fn mcp_servers_map_opencodes_statuses_to_crews_states() {
        let answer = json!({
            "location": { "directory": "/w" },
            "data": [
                { "name": "crew", "status": { "status": "connected" } },
                { "name": "figma", "status": { "status": "pending" } },
                { "name": "broken", "status": { "status": "failed", "error": "NotFound: ChildProcess.spawn (/nope)" } },
                { "name": "sentry", "status": { "status": "needs_auth", "error": "requires a login" }, "integrationID": "mcp_1" },
                { "name": "off", "status": { "status": "disabled" } },
                { "name": "odd", "status": { "status": "sleeping" } },
                { "status": { "status": "connected" } }
            ]
        });
        let servers = mcp_servers(&answer["data"]);
        let states: Vec<_> = servers.iter().map(|server| (server.name.as_str(), server.state)).collect();
        assert_eq!(
            states,
            [
                ("crew", McpState::Connected),
                ("figma", McpState::Pending),
                ("broken", McpState::Failed),
                ("sentry", McpState::NeedsAuth),
                ("off", McpState::Disabled),
                ("odd", McpState::Unknown),
            ]
        );
        assert_eq!(servers[2].error.as_deref(), Some("NotFound: ChildProcess.spawn (/nope)"));
        assert_eq!(servers[3].error.as_deref(), Some("requires a login"));
        assert!(servers.iter().all(|server| server.sign_in.is_none()));
        let long = json!([{ "name": "x", "status": { "status": "failed", "error": "e".repeat(900) } }]);
        assert!(mcp_servers(&long)[0].error.as_deref().is_some_and(|error| error.len() <= crate::mcp_status::ERROR_LIMIT + 3));
    }

    /// A sign-in is found under the server's integration, and its OAuth
    /// method is the integration's one `oauth` method.
    #[test]
    fn a_servers_sign_in_is_its_integration_and_oauth_method() {
        let list = json!({ "data": [
            { "name": "crew", "status": { "status": "connected" } },
            { "name": "sentry", "status": { "status": "needs_auth", "error": "x" }, "integrationID": "mcp_1" }
        ] });
        assert_eq!(mcp_integration(&list["data"], "sentry").as_deref(), Some("mcp_1"));
        assert_eq!(mcp_integration(&list["data"], "crew"), None);
        assert_eq!(mcp_integration(&list["data"], "nothing"), None);
        let info = json!({ "data": { "id": "mcp_1", "methods": [
            { "id": "mcp_1", "type": "oauth", "label": "sentry" }
        ] } });
        assert_eq!(oauth_method(&info).as_deref(), Some("mcp_1"));
        assert_eq!(oauth_method(&json!({ "data": { "methods": [{ "id": "k", "type": "key" }] } })), None);
    }

    /// The attempt names its page and how it finishes; without either, there
    /// is no sign-in to offer.
    #[test]
    fn a_started_sign_in_names_its_page_and_mode() {
        let reply = json!({ "location": {}, "data": { "attemptID": "con_1", "url": "https://auth.example/authorize?x=1", "mode": "auto" } });
        assert_eq!(sign_in_attempt(&reply), Some(("https://auth.example/authorize?x=1".into(), "auto".into())));
        assert_eq!(sign_in_attempt(&json!({ "data": { "url": "https://x" } })), None);
    }

    /// A server name goes into a route as one segment, spaces and slashes
    /// escaped, plain names untouched.
    #[test]
    fn a_server_name_is_one_percent_encoded_path_segment() {
        assert_eq!(path_segment("sentry"), "sentry");
        assert_eq!(path_segment("claude.ai Figma/x"), "claude.ai%20Figma%2Fx");
        assert_eq!(path_segment("mcp_10db8c72d861dde6"), "mcp_10db8c72d861dde6");
    }

    /// The rules a session runs under say what Crew's autonomy means, and
    /// Crew's own tools never ask.
    #[test]
    fn each_autonomy_is_a_set_of_rules_ending_with_crews_tools_allowed() {
        let effects = |autonomy: Autonomy, bot: bool| -> Vec<(String, String)> {
            permission_rules(&autonomy, bot)
                .as_array()
                .unwrap()
                .iter()
                .map(|rule| (rule["action"].as_str().unwrap().into(), rule["effect"].as_str().unwrap().into()))
                .collect()
        };
        let full = effects(Autonomy::Full, false);
        assert_eq!(full, [("*".into(), "allow".into()), ("crew_*".into(), "allow".into())]);
        let ask = effects(Autonomy::Ask, false);
        assert!(ask.contains(&("edit".into(), "ask".into())) && ask.contains(&("shell".into(), "ask".into())), "{ask:?}");
        let edits = effects(Autonomy::Edits, false);
        assert!(!edits.iter().any(|(action, _)| action == "edit") && edits.contains(&("shell".into(), "ask".into())), "{edits:?}");
        assert_eq!(effects(Autonomy::Auto, false), edits);
        let bot = effects(Autonomy::Full, true);
        assert!(bot.contains(&("question".into(), "deny".into())), "{bot:?}");
        for rules in [full, ask, edits, bot] {
            assert_eq!(rules.last().unwrap(), &("crew_*".to_string(), "allow".to_string()));
        }
    }

    /// The server's config is the 2.x format: one execution timeout, Crew's
    /// tools as tools of their own (not behind Code Mode), and allowed.
    #[test]
    fn the_server_config_names_crews_server_in_the_2x_format() {
        let env = [("CREW_TOKEN".to_string(), "host".to_string())];
        let config: Value = serde_json::from_str(&server_config(Some(&("/bin/crewd".into(), vec!["--mcp".into()])), &env)).unwrap();
        let crew = &config["mcp"]["servers"]["crew"];
        assert_eq!(crew["environment"], json!({ "CREW_TOKEN": "host" }));
        assert_eq!(crew["command"], json!(["/bin/crewd", "--mcp"]));
        assert_eq!(crew["timeout"], json!({ "execution": MCP_TIMEOUT_MS }), "a catalog timeout would wait the 65 minutes too");
        assert_eq!(crew["codemode"], json!(false));
        assert_eq!(config["permissions"], json!([{ "action": "crew_*", "resource": "*", "effect": "allow" }]));
        let bare: Value = serde_json::from_str(&server_config(None, &[])).unwrap();
        assert!(bare.get("mcp").is_none() && bare.get("permissions").is_none(), "{bare}");
    }

    #[test]
    fn a_model_id_is_its_provider_and_model_with_the_effort_as_variant() {
        assert_eq!(model_ref("opencode/mimo-v2.6-flash-free", ""), Some(json!({ "providerID": "opencode", "id": "mimo-v2.6-flash-free" })));
        assert_eq!(
            model_ref("openrouter/anthropic/claude-x", "high"),
            Some(json!({ "providerID": "openrouter", "id": "anthropic/claude-x", "variant": "high" }))
        );
        assert_eq!(model_ref("", ""), None);
        assert_eq!(model_ref("no-provider", ""), None);
    }

    /// Below 2.0.4 opencode is refused with the command that upgrades it;
    /// above the last tested version it runs with a word.
    #[test]
    fn a_version_is_refused_below_the_api_crew_speaks_and_warned_above_the_tested_one() {
        assert_eq!(parse_version("opencode v2.0.26"), Some((2, 0, 26)));
        assert_eq!(parse_version("2.1.0-beta.3"), Some((2, 1, 0)));
        let old = version_check("2.0.3").unwrap_err();
        assert!(old.contains("npm i -g @opencode/cli") && old.contains("2.0.4") && old.contains("2.0.3"), "{old}");
        assert!(version_check("1.18.35").is_err());
        assert_eq!(version_check("2.0.26"), Ok(None));
        assert_eq!(version_check("2.0.4"), Ok(None));
        let newer = version_check("2.1.0").unwrap().expect("a word");
        assert!(newer.contains("2.1.0") && newer.contains("2.0.26"), "{newer}");
        assert!(version_check("banana").is_err());
    }

    /// The migration as 2.0.26 reported it on a copy of a 264 MB 1.x
    /// database: running with a count, then completed.
    #[test]
    fn the_migration_is_read_as_running_with_its_count_until_it_completes() {
        let running = json!({ "status": "running", "progress": { "label": "Migrating sessions", "numerator": 119, "denominator": 276 } });
        assert_eq!(migration(&running), Migration::Running { label: "Migrating sessions".into(), done: 119, total: 276 });
        assert_eq!(migration(&json!({ "status": "completed" })), Migration::Done);
        assert!(matches!(migration(&json!({ "status": "failed", "error": "disk full" })), Migration::Failed(why) if why == "disk full"));
    }

    /// A prompt steers by default, and picked skills go in their own field.
    #[test]
    fn a_prompt_names_its_skills_by_id_and_steers() {
        assert_eq!(prompt_body("hi", &[]), json!({ "text": "hi", "delivery": "steer" }));
        assert_eq!(
            prompt_body("hi", &["review-pr".into()]),
            json!({ "text": "hi", "delivery": "steer", "skills": [{ "id": "review-pr" }] })
        );
    }

    /// An event names its session where opencode puts it: on the event, on a
    /// form, on a shell's metadata.
    #[test]
    fn an_event_is_routed_by_the_session_it_names() {
        assert_eq!(session_of(&json!({ "type": "session.text.delta", "data": { "sessionID": "ses_1" } })), Some("ses_1"));
        assert_eq!(session_of(&json!({ "type": "form.created", "data": { "form": { "sessionID": "ses_2" } } })), Some("ses_2"));
        assert_eq!(
            session_of(&json!({ "type": "shell.created", "data": { "info": { "metadata": { "sessionID": "ses_3" } } } })),
            Some("ses_3")
        );
        assert_eq!(session_of(&json!({ "type": "command.updated", "data": {} })), None);
    }

    /// The window holds what the last step sent and got back, the cache
    /// included; the turn's usage adds up every step.
    #[test]
    fn a_step_counts_its_window_and_adds_to_the_turns_usage() {
        let step = json!({ "finish": "tool-calls", "cost": 0.5, "tokens": { "input": 136, "output": 38, "reasoning": 8, "cache": { "read": 9088, "write": 4 } } });
        assert_eq!(context_used(&step), Some(136 + 38 + 8 + 9088 + 4));
        let once = add_usage(None, &step);
        let twice = add_usage(Some(&once), &step);
        assert_eq!((twice.input_tokens, twice.output_tokens, twice.cost_usd), (Some(2 * 9228), Some(2 * 46), Some(1.0)));
        assert_eq!(finish_failure("stop"), None);
        assert_eq!(finish_failure("tool-calls"), None);
        assert!(finish_failure("length").unwrap().contains("ran out of room"));
    }

    /// The question form 2.0.26 made of the question tool's call, and the
    /// answer it took (`{"q0": "Blue"}`).
    #[test]
    fn a_question_form_is_a_card_and_its_answer_goes_back_by_key_and_value() {
        let form = json!({
            "id": "frm_1", "sessionID": "ses_1", "title": "Questions",
            "metadata": { "kind": "question", "tool": { "messageID": "msg_1", "id": "call_q" } },
            "fields": [{ "key": "q0", "title": "Color preference", "description": "Do you prefer Red or Blue?", "type": "string",
                "options": [{ "value": "Red", "label": "Red", "description": "You prefer Red." }, { "value": "blue-ish", "label": "Blue" }], "custom": true }]
        });
        let questions = form_questions(&form);
        assert_eq!(questions.len(), 1);
        let (key, question) = &questions[0];
        assert_eq!((key.as_str(), question.header.as_str(), question.question.as_str()), ("q0", "Color preference", "Do you prefer Red or Blue?"));
        assert_eq!(question.options.iter().map(|o| o.label.as_str()).collect::<Vec<_>>(), ["Red", "Blue"]);
        let answers = HashMap::from([("Do you prefer Red or Blue?".to_string(), "Blue".to_string())]);
        assert_eq!(form_answer(&form, &answers), json!({ "q0": "blue-ish" }));
        let typed = HashMap::from([("q0".to_string(), "Green".to_string())]);
        assert_eq!(form_answer(&form, &typed), json!({ "q0": "Green" }), "a custom answer goes as typed");
        let multi = json!({ "fields": [{ "key": "k", "type": "multiselect", "title": "Pick", "options": [{ "value": "a", "label": "A" }, { "value": "b", "label": "B" }] }] });
        assert_eq!(form_answer(&multi, &HashMap::from([("k".to_string(), "A, B".to_string())])), json!({ "k": ["a", "b"] }));
    }

    /// A shell permission as 2.0.26 asks it: the card names the call's
    /// command, which the driver saw when the call began.
    #[test]
    fn a_permission_names_the_call_it_came_from() {
        let asked = json!({ "id": "per_1", "sessionID": "ses_1", "action": "shell", "resources": ["sleep 30", "echo slept"],
            "save": ["sleep *", "echo *"], "source": { "type": "tool", "messageID": "msg_1", "id": "call_6" } });
        let input = json!({ "command": "sleep 30; echo slept", "timeout": 60000 }).as_object().unwrap().clone();
        let calls = HashMap::from([("call_6".to_string(), ("shell".to_string(), input.clone()))]);
        let ask = ask_of(&asked, &calls);
        assert_eq!((ask.tool.as_str(), ask.title.as_str()), ("shell", "sleep 30; echo slept"));
        assert_eq!(ask.input, Value::Object(input));
        let unseen = ask_of(&asked, &HashMap::new());
        assert_eq!((unseen.tool.as_str(), unseen.title.as_str()), ("shell", "sleep 30; echo slept"));
        let edit = ask_of(&json!({ "action": "edit", "resources": ["src/a.rs"] }), &HashMap::new());
        assert_eq!(edit.tool, "edit", "a parent that may edit decides it");
    }

    #[test]
    fn the_menu_reads_commands_by_name_and_skills_by_id() {
        let commands = command_entries(&json!({ "data": [{ "name": "review", "description": "review changes" }, { "name": " " }] }));
        assert_eq!(commands.iter().map(|c| (c.name.as_str(), c.kind.as_str())).collect::<Vec<_>>(), [("review", "command")]);
        let skills = skill_entries(&json!({ "data": [{ "id": "opencode", "name": "OpenCode", "description": "About opencode", "path": "/builtin/opencode.md", "content": "…" }] }));
        assert_eq!(skills[0].name, "opencode");
        assert_eq!(skills[0].kind, "skill");
        assert_eq!(skills[0].path.as_deref(), Some("/builtin/opencode.md"));
    }

    #[test]
    fn a_models_window_is_its_context_limit() {
        let models = json!({ "data": [{ "id": "mimo", "modelID": "mimo", "providerID": "opencode", "limit": { "context": 200000, "output": 32000 } }] });
        assert_eq!(context_window(&models, &json!({ "providerID": "opencode", "id": "mimo" })), Some(200_000));
        assert_eq!(context_window(&models, &json!({ "providerID": "other", "id": "mimo" })), None);
    }

    /// A shell that exits non-zero failed; one that threw shows its error.
    #[test]
    fn a_tools_end_says_whether_it_failed() {
        let input = json!({ "command": "ls /nope" }).as_object().unwrap().clone();
        let meta = json!({ "exit": 2, "status": "completed" }).as_object().unwrap().clone();
        let end = ToolEnd { status: Some("completed"), output: Some("ls: /nope: No such file".into()), error: None, metadata: Some(&meta) };
        assert_eq!(tool_status("shell", &end), ToolStatus::Failed);
        assert_eq!(
            tool_detail("shell", &input, &end),
            Some(ToolDetail::Command { command: "ls /nope".into(), exit_code: Some(2), output: Some("ls: /nope: No such file".into()) })
        );
        let threw = ToolEnd { status: Some("error"), error: Some("Tool execution interrupted".into()), ..ToolEnd::default() };
        assert_eq!(tool_status("shell", &threw), ToolStatus::Failed);
        assert_eq!(tool_detail("shell", &input, &threw), Some(ToolDetail::Output { text: "Tool execution interrupted".into() }));
        assert_eq!(tool_status("shell", &ToolEnd::default()), ToolStatus::Pending);
        assert_eq!(tool_status("invalid", &ToolEnd { status: Some("completed"), ..ToolEnd::default() }), ToolStatus::Failed);
    }
}
