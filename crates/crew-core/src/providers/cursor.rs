use crew_protocol::{EditHunk, TodoItem, TodoStatus, ToolDetail, ToolStatus, TurnUsage};
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
    if let Some((path, _)) = command.as_deref().and_then(crew_command) {
        return format!("Crew {path}");
    }
    match name.to_ascii_lowercase().as_str() {
        "updatetodos" => return "Todos".into(),
        "task" => {
            return string_field(Some(input), "description")
                .map(|description| clip(&description, 72))
                .unwrap_or_else(|| "Subagent".into());
        }
        "getmcptools" => {
            return match string_field(Some(input), "toolName") {
                Some(tool) => format!("Look up {}", clip(&tool, 40)),
                None => "Look up tools".into(),
            };
        }
        "webfetch" => {
            if let Some(url) = string_field(Some(input), "url") {
                return format!("Fetch {}", clip(&url, 60));
            }
        }
        _ => {}
    }
    let path = path_argument(input);
    let query = string_field(Some(input), "pattern")
        .or_else(|| string_field(Some(input), "globPattern"))
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

/// A call answers with `success`, or with `failure` when it ran and went wrong
/// (a shell that exited non-zero). A call that never ran answers with neither,
/// yields `None`, and the row keeps what it already showed.
fn tool_detail(
    name: &str,
    args: &Map<String, Value>,
    result: Option<&Map<String, Value>>,
) -> Option<ToolDetail> {
    let success = result.and_then(|row| row.get("success")).and_then(as_record);
    let outcome = success.or_else(|| result.and_then(|row| row.get("failure")).and_then(as_record));
    match name.to_ascii_lowercase().as_str() {
        "shell" | "bash" => {
            let command = string_field(Some(args), "command")?;
            let exit_code = outcome
                .and_then(|row| row.get("exitCode"))
                .and_then(Value::as_i64)
                .map(|code| code as i32);
            if exit_code.is_none_or(|code| code == 0) {
                if let Some(message) = bridge_message(&command) {
                    return Some(message);
                }
                // Crew's answer is the row's body; with nothing printed the command is.
                if let (Some(_), Some(text)) = (crew_command(&command), text_field(outcome, "stdout")) {
                    return Some(ToolDetail::Output { text });
                }
            }
            Some(ToolDetail::Command {
                command,
                exit_code,
                output: shell_output(outcome),
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
        // The call streams only the new text; the result carries the file
        // before and after, which is a diff once it fits.
        "write" | "edit" | "multiedit" => Some(ToolDetail::Edit {
            path: path_argument(args)?,
            added: line_number(success, "linesAdded"),
            removed: line_number(success, "linesRemoved"),
            hunks: text_field(success, "afterFullFileContent").map(|after| {
                vec![EditHunk {
                    before: text_field(success, "beforeFullFileContent").unwrap_or_default(),
                    after,
                }]
            }),
        }),
        "glob" => Some(ToolDetail::Search {
            query: string_field(Some(args), "globPattern").or_else(|| string_field(Some(args), "pattern"))?,
            matches: line_number(success, "totalFiles"),
            output: success
                .and_then(|row| row.get("files"))
                .and_then(Value::as_array)
                .map(|files| files.iter().filter_map(Value::as_str).collect::<Vec<_>>().join("\n"))
                .filter(|text| !text.is_empty()),
        }),
        "grep" => Some(ToolDetail::Search {
            query: string_field(Some(args), "pattern")
                .or_else(|| string_field(Some(args), "query"))
                .or_else(|| string_field(Some(args), "regex"))?,
            matches: None,
            output: grep_output(success),
        }),
        "webfetch" => Some(ToolDetail::Fetch {
            url: string_field(Some(args), "url")?,
            title: None,
            output: text_field(success, "markdown"),
        }),
        // With `merge` the call names only what changed; the result holds the
        // whole list once it has merged them.
        "updatetodos" => Some(ToolDetail::Todo {
            items: success
                .and_then(|row| row.get("todos"))
                .or_else(|| args.get("todos"))
                .and_then(Value::as_array)?
                .iter()
                .filter_map(|row| {
                    let row = as_record(row)?;
                    Some(TodoItem {
                        text: string_field(Some(row), "content")?,
                        status: match string_field(Some(row), "status").as_deref() {
                            Some("TODO_STATUS_COMPLETED") => TodoStatus::Completed,
                            Some("TODO_STATUS_IN_PROGRESS") => TodoStatus::InProgress,
                            _ => TodoStatus::Pending,
                        },
                    })
                })
                .collect(),
        }),
        "task" => Some(ToolDetail::Agent {
            description: string_field(Some(args), "description").unwrap_or_else(|| "Subagent".into()),
            agent_type: None,
            prompt: text_field(Some(args), "prompt"),
            output: success
                .and_then(|row| row.get("conversationSteps"))
                .and_then(Value::as_array)
                .map(|steps| {
                    steps
                        .iter()
                        .filter_map(|step| {
                            as_record(step)?.get("assistantMessage").and_then(as_record)?.get("text")?.as_str()
                        })
                        .collect::<Vec<_>>()
                        .join("\n\n")
                })
                .filter(|text| !text.trim().is_empty()),
        }),
        // A tool's schema, fetched before the call: the JSON is the body.
        "getmcptools" => text_field(success, "content").map(|text| ToolDetail::Output { text }),
        _ => None,
    }
}

/// What a shell printed, in the order it printed it when cursor kept that.
fn shell_output(outcome: Option<&Map<String, Value>>) -> Option<String> {
    text_field(outcome, "interleavedOutput").or_else(|| {
        let joined = [text_field(outcome, "stdout"), text_field(outcome, "stderr")]
            .into_iter()
            .flatten()
            .collect::<Vec<_>>()
            .join("\n");
        Some(joined).filter(|text| !text.trim().is_empty())
    })
}

/// Grep answers per workspace, per file, per line: `file:line: text`, as rg prints.
fn grep_output(success: Option<&Map<String, Value>>) -> Option<String> {
    let workspaces = success?.get("workspaceResults").and_then(as_record)?;
    let mut lines = Vec::new();
    for workspace in workspaces.values() {
        let files = as_record(workspace)
            .and_then(|row| row.get("content"))
            .and_then(as_record)
            .and_then(|row| row.get("matches"))
            .and_then(Value::as_array);
        for file in files.into_iter().flatten() {
            let Some(file) = as_record(file) else { continue };
            let name = string_field(Some(file), "file").unwrap_or_default();
            for hit in file.get("matches").and_then(Value::as_array).into_iter().flatten() {
                let Some(hit) = as_record(hit) else { continue };
                let line = hit.get("lineNumber").and_then(Value::as_u64).unwrap_or(0);
                let text = hit.get("content").and_then(Value::as_str).unwrap_or("");
                lines.push(format!("{name}:{line}: {text}"));
            }
        }
    }
    Some(lines.join("\n")).filter(|text| !text.is_empty())
}

/// The Crew command a shell command runs, when cursor reaches one the only
/// way it can: `…/crew agents send <id> <text>`. The group and verb, and what
/// follows them.
fn crew_command(command: &str) -> Option<(String, Vec<String>)> {
    let words = shell_words(command);
    let (binary, rest) = words.split_first()?;
    let binary = binary.rsplit('/').next()?;
    if binary != "crew" && binary != "crewd" {
        return None;
    }
    // Global flags may come first; the ones that take a value are named.
    let mut rest = rest.iter().peekable();
    while let Some(word) = rest.peek() {
        if !word.starts_with('-') {
            break;
        }
        let takes_value = matches!(word.as_str(), "-w" | "--workspace" | "--data-dir");
        rest.next();
        if takes_value {
            rest.next();
        }
    }
    let rest: Vec<String> = rest.cloned().collect();
    let (group, verb) = (rest.first()?, rest.get(1)?);
    let named = |word: &str| !word.is_empty() && word.chars().all(|c| c.is_ascii_alphanumeric() || c == '-');
    if !named(group) || !named(verb) {
        return None;
    }
    Some((format!("{group} {verb}"), rest[2..].to_vec()))
}

/// Cursor reaches Crew's tools through the shell (`crew agents send <id>
/// <text>`), so a message to another agent arrives as a command. Read back as
/// the message it is, it shows who it went to and what it said, as it does for
/// the providers that call the tool by name.
fn bridge_message(command: &str) -> Option<ToolDetail> {
    let (path, args) = crew_command(command)?;
    if path != "agents send" {
        return None;
    }
    let (to, words) = args.split_first()?;
    // `-` reads the text from stdin, which the command line does not show.
    if words.is_empty() || words == ["-"] || to.starts_with('-') {
        return None;
    }
    let mut input = Map::new();
    input.insert("to".into(), Value::String(to.clone()));
    input.insert("text".into(), Value::String(words.join(" ")));
    super::crew_tool_detail("crew.message_agent", &input)
}

/// A command line split the way a POSIX shell splits words: single quotes
/// verbatim, double quotes with backslash escapes, and nothing past the first
/// unquoted `|`, `;`, `&` or redirection.
fn shell_words(command: &str) -> Vec<String> {
    let mut words = Vec::new();
    let mut word = String::new();
    let mut started = false;
    let mut chars = command.chars().peekable();
    while let Some(c) = chars.next() {
        match c {
            '\'' => {
                started = true;
                for q in chars.by_ref() {
                    if q == '\'' {
                        break;
                    }
                    word.push(q);
                }
            }
            '"' => {
                started = true;
                while let Some(q) = chars.next() {
                    match q {
                        '"' => break,
                        '\\' => {
                            if let Some(escaped) = chars.next() {
                                word.push(escaped);
                            }
                        }
                        _ => word.push(q),
                    }
                }
            }
            '\\' => {
                started = true;
                if let Some(escaped) = chars.next() {
                    word.push(escaped);
                }
            }
            '|' | ';' | '&' | '<' | '>' => break,
            c if c.is_whitespace() => {
                if started {
                    words.push(std::mem::take(&mut word));
                    started = false;
                }
            }
            c => {
                started = true;
                word.push(c);
            }
        }
    }
    if started {
        // A trailing `2` of `2>/dev/null` is the redirection's, not a word.
        if !(word == "2" && command.contains("2>")) {
            words.push(word);
        }
    }
    words
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
    if result.get("failure").is_some_and(|v| !v.is_null()) {
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
    use crew_protocol::{HarnessEvent, TodoStatus, ToolDetail, ToolStatus};
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

    /// Every tool cursor-agent ran in a real turn, captured in
    /// `crates/crew-core/tests/fixtures/protocols/cursor-tools.jsonl`: each one
    /// reads as what it did, not as a bare tool name.
    #[test]
    fn a_real_turns_tools_each_read_as_what_they_did() {
        let fixture = include_str!("../../tests/fixtures/protocols/cursor-tools.jsonl");
        let details: Vec<(String, Option<ToolDetail>, bool)> = fixture
            .lines()
            .map(|line| {
                let rec: Value = serde_json::from_str(line).unwrap();
                let call = parse_tool_call(rec.as_object().unwrap()).unwrap();
                (call.name, call.detail, call.failed)
            })
            .collect();
        let by = |name: &str| details.iter().find(|(n, ..)| n == name).cloned().unwrap();

        assert!(matches!(by("GetMcpTools").1, Some(ToolDetail::Output { .. })));
        assert!(matches!(
            by("Glob").1,
            Some(ToolDetail::Search { ref query, matches: Some(2), output: Some(ref out) }) if query == "*.js" && out == "src/math.js\ntest.js"
        ));
        let Some(ToolDetail::Search { output: Some(grep), .. }) = by("Grep").1 else { panic!("grep") };
        assert!(grep.starts_with("./src/math.js:2: function add(a, b) {"), "{grep}");

        let Some(ToolDetail::Todo { items }) = by("UpdateTodos").1 else { panic!("todos") };
        assert_eq!(items.len(), 10);
        assert_eq!(items[0].status, TodoStatus::Completed);
        assert_eq!(items[4].status, TodoStatus::InProgress);
        assert_eq!(items[9].status, TodoStatus::Pending);
        // A merge names six items; the row shows all ten, as merged.
        let merged = r#"{"type":"tool_call","subtype":"completed","call_id":"t2","tool_call":{"updateTodosToolCall":{"args":{"merge":true,"todos":[{"id":"5","content":"Run npm test","status":"TODO_STATUS_COMPLETED"}]},"result":{"success":{"todos":[{"id":"1","content":"Make a list","status":"TODO_STATUS_COMPLETED"},{"id":"5","content":"Run npm test","status":"TODO_STATUS_COMPLETED"},{"id":"6","content":"Fix it","status":"TODO_STATUS_PENDING"}]}}}}}"#;
        let merged: Value = serde_json::from_str(merged).unwrap();
        let Some(ToolDetail::Todo { items }) = parse_tool_call(merged.as_object().unwrap()).unwrap().detail else { panic!("merge") };
        assert_eq!(items.len(), 3);

        // A shell that exited non-zero answers with `failure`, not `success`.
        let (_, shell, failed) = by("Shell");
        assert!(failed, "a failing npm test is a failed row");
        let Some(ToolDetail::Command { exit_code: Some(1), output: Some(output), .. }) = shell else { panic!("shell") };
        assert!(output.contains("AssertionError"), "{output}");

        assert!(matches!(by("WebFetch").1, Some(ToolDetail::Fetch { output: Some(ref md), .. }) if md.contains("Example Domain")));

        let edit = |file: &str| {
            details
                .iter()
                .find_map(|(_, detail, _)| match detail {
                    Some(ToolDetail::Edit { path, .. }) if path.ends_with(file) => detail.clone(),
                    _ => None,
                })
                .unwrap()
        };
        let ToolDetail::Edit { added: Some(1), removed: Some(1), hunks: Some(hunks), .. } = edit("src/math.js") else { panic!("edit") };
        assert!(hunks[0].before.contains("a - b") && hunks[0].after.contains("a + b"));
        let ToolDetail::Edit { hunks: Some(created), .. } = edit("NOTES.md") else { panic!("write") };
        assert_eq!(created[0].before, "");

        let Some(ToolDetail::Agent { description, output: Some(report), .. }) = by("Task").1 else { panic!("task") };
        assert_eq!(description, "Count math.js lines");
        assert!(report.ends_with("10"), "{report}");
    }

    #[test]
    fn a_crew_tool_called_through_the_shell_is_named_as_crews() {
        let args = json!({ "command": "/Users/me/crew/target/debug/crew agents list --json" });
        assert_eq!(tool_label("Shell", args.as_object().unwrap()), "Crew agents list");
        let result = json!({ "success": { "exitCode": 0, "stdout": "[{\"name\": \"Ada\"}]" } });
        assert_eq!(
            tool_detail("Shell", args.as_object().unwrap(), result.as_object()),
            Some(ToolDetail::Output { text: "[{\"name\": \"Ada\"}]".into() })
        );
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
        let sent = r#"/bin/crew agents send abc 'it'\''s' "green, \"really\"" 2>/dev/null || true"#;
        match tool_detail("shell", &args(sent), ok) {
            Some(ToolDetail::Message { to, text }) => {
                assert_eq!(to, "abc");
                assert_eq!(text, "it's green, \"really\"");
            }
            other => panic!("expected a message, got {other:?}"),
        }
        // Text on stdin, a failed call, or another command stay the command they were.
        let piped = "git diff | crew agents send abc -";
        assert!(matches!(tool_detail("shell", &args(piped), ok), Some(ToolDetail::Command { .. })));
        let failed = serde_json::json!({ "success": { "exitCode": 1 } });
        assert!(matches!(tool_detail("shell", &args(sent), failed.as_object()), Some(ToolDetail::Command { .. })));
        let listed = "crew -w /tmp/x agents list";
        assert_eq!(tool_label("shell", &args(listed)), "Crew agents list");
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
