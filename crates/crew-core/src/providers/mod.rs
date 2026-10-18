pub mod claude;
pub mod codex;
pub mod cursor;
pub mod opencode;
pub mod runtime;

pub use runtime::{Autonomy, InlineImage};

use std::borrow::Cow;

use serde_json::{Map, Value};

pub fn as_record(value: &Value) -> Option<&Map<String, Value>> {
    value.as_object()
}

pub fn as_record_owned(value: &Value) -> Option<Map<String, Value>> {
    value.as_object().cloned()
}

pub fn string_field(rec: Option<&Map<String, Value>>, key: &str) -> Option<String> {
    rec.and_then(|map| map.get(key)).and_then(Value::as_str).map(str::trim).filter(|value| !value.is_empty()).map(str::to_string)
}

/// A message and the files attached to it, as one text.
pub fn with_files(text: &str, files: &[String]) -> String {
    if files.is_empty() {
        return text.to_string();
    }
    let list = files.iter().map(|path| format!("- {path}")).collect::<Vec<_>>().join("\n");
    let note = format!("Attached files. Read them if you need their contents:\n{list}");
    if text.is_empty() {
        note
    } else {
        format!("{text}\n\n{note}")
    }
}

/// Whether `/name` stands at byte `at` of `text` as a word of its own: at the
/// start or after a space, and not run on into more of a name (`/lint` is not
/// in `/linting`, `a/lint` or `/lint/x`). A full stop or a comma after it is
/// the sentence's.
pub(crate) fn invokes_at(text: &str, at: usize, name: &str) -> bool {
    let Some(rest) = text[at..].strip_prefix('/').and_then(|rest| rest.strip_prefix(name)) else {
        return false;
    };
    text[..at].chars().next_back().is_none_or(char::is_whitespace)
        && rest.chars().next().is_none_or(|c| !(c.is_alphanumeric() || matches!(c, '-' | '_' | ':' | '/')))
}

/// Every byte position of `text` where the skill `name` is invoked as
/// `/name`; see [`invokes_at`].
pub(crate) fn invocations(text: &str, name: &str) -> Vec<usize> {
    if name.is_empty() {
        return Vec::new();
    }
    text.match_indices(&format!("/{name}")).map(|(at, _)| at).filter(|&at| invokes_at(text, at, name)).collect()
}

/// The prompt a turn is: what the bot is, what has been said, then what is
/// being asked now.
///
/// The turn goes last because it is the instruction, and the tail above it is
/// memory. Reversed, the newest thing the user said sits behind a wall of what
/// they said before.
pub fn assemble(system: String, history: Option<&str>, turn: &str) -> String {
    let history = history.map(str::trim).filter(|tail| !tail.is_empty());
    let turn = turn.trim();
    let mut out = system;
    let mut push = |part: &str| {
        if !out.is_empty() {
            out.push_str("\n\n");
        }
        out.push_str(part);
    };
    if let Some(history) = history {
        push(history);
        // The header earns its place as a separator; with nothing above it, it
        // is a heading over the user's own message.
        if !turn.is_empty() {
            push("## This turn");
        }
    }
    if !turn.is_empty() {
        push(turn);
    }
    out
}

/// The machine's own date, the way a person here would write it.
pub fn today() -> String {
    const DAYS: [&str; 7] = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
    const MONTHS: [&str; 12] = [
        "January",
        "February",
        "March",
        "April",
        "May",
        "June",
        "July",
        "August",
        "September",
        "October",
        "November",
        "December",
    ];
    let secs = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|since| since.as_secs() as libc::time_t)
        .unwrap_or(0);
    let mut tm: libc::tm = unsafe { std::mem::zeroed() };
    unsafe {
        libc::localtime_r(&secs, &mut tm);
    }
    let day = DAYS.get(tm.tm_wday.clamp(0, 6) as usize).copied().unwrap_or("");
    let month = MONTHS.get(tm.tm_mon.clamp(0, 11) as usize).copied().unwrap_or("");
    format!("{day}, {} {month} {}", tm.tm_mday, tm.tm_year + 1900)
}

/// The bare name of a Crew tool, whatever the provider prefixed it with:
/// Claude and Codex spell it `mcp__crew__x`, opencode `crew_x`. Codex's items
/// name the server and the tool apart; its rows put them back together in the
/// spelling the model saw.
///
/// Getting one wrong is not a crash, which is what makes it worth a test: the
/// call still runs and the row still appears, but with no detail — a message to
/// another bot shows as a blob of result JSON instead of who it went to and
/// what it said, in the chat and in the sender's own tail.
pub fn crew_tool(name: &str) -> Option<&str> {
    ["mcp__crew__", "crew_"].iter().find_map(|prefix| name.strip_prefix(prefix)).filter(|verb| !verb.is_empty())
}

/// The Crew tool a call runs, and its arguments. Crew's tools are listed
/// directly now, but transcripts from before still hold `call_tool` calls
/// naming the tool, and are read for as long as they exist: a row read as the
/// gateway would show every message as "call tool" and a blob.
///
/// A model often writes `arguments` as a JSON string rather than an object.
/// Claude Code parses it against the schema before the call reaches the MCP
/// server, so the call works, but its stream carries the string: read as an
/// object only, a message sent that way showed up with no detail at all.
pub fn crew_call<'a>(name: &'a str, input: &'a Map<String, Value>) -> Option<(&'a str, Cow<'a, Map<String, Value>>)> {
    let verb = crew_tool(name)?;
    if verb != "call_tool" {
        return Some((verb, Cow::Borrowed(input)));
    }
    let inner = input.get("name").and_then(Value::as_str).filter(|inner| !inner.is_empty());
    let arguments = match input.get("arguments") {
        Some(Value::Object(arguments)) => Some(Cow::Borrowed(arguments)),
        Some(Value::String(raw)) => serde_json::from_str::<Map<String, Value>>(raw).ok().map(Cow::Owned),
        _ => None,
    };
    match (inner, arguments) {
        (Some(inner), Some(arguments)) => Some((inner, arguments)),
        (Some(inner), None) => Some((inner, Cow::Owned(Map::new()))),
        _ => Some((verb, Cow::Borrowed(input))),
    }
}

/// The Crew tools that write to somebody: `send_message`, and the two it
/// replaced, which old transcripts keep for as long as they exist.
pub fn is_message_tool(verb: &str) -> bool {
    matches!(verb, "send_message" | "message_agent" | "send_to_session")
}

/// The Crew tools that make a letter: the message tools, and `delegate` and
/// `start_session`, whose prompt is the new session's first letter.
pub fn is_letter_tool(verb: &str) -> bool {
    is_message_tool(verb) || matches!(verb, "delegate" | "start_session")
}

/// The Crew tools that act on sessions without writing a letter, whose rows
/// read from a [`crew_protocol::ToolDetail::Crew`].
pub fn is_control_tool(verb: &str) -> bool {
    matches!(verb, "start_sessions" | "interrupt_session" | "read_session" | "list_peers" | "stop_session" | "update_session")
}

/// A control tool's detail from its call alone: whom it names, before the
/// answer says who they are.
fn control_detail(verb: &str, input: &Map<String, Value>) -> crew_protocol::ToolDetail {
    use crew_protocol::{CrewTarget, ToolDetail};
    let named = |id: Option<String>, name: String, provider: Option<String>| CrewTarget { id, name, provider, note: None };
    // What the call names a session by: an id from `list_peers`, or a name.
    let session = || string_field(Some(input), "session").map(|session| named(Some(session.clone()), session, None));
    let mut text = None;
    let mut count = None;
    let mut note = None;
    let targets = match verb {
        "start_sessions" => {
            let list = input.get("sessions").and_then(Value::as_array).map(Vec::as_slice).unwrap_or_default();
            count = Some(list.len() as u32);
            list.iter()
                .map(|entry| {
                    let entry = as_record(entry);
                    let provider = string_field(entry, "provider");
                    let name = string_field(entry, "name").or_else(|| provider.clone()).unwrap_or_else(|| "new session".into());
                    named(None, name, provider)
                })
                .collect()
        }
        "interrupt_session" => {
            text = string_field(Some(input), "text");
            session().into_iter().collect()
        }
        "update_session" => {
            note = string_field(Some(input), "action");
            if note.as_deref() == Some("rename") {
                text = string_field(Some(input), "name");
            }
            session().into_iter().collect()
        }
        "list_peers" => Vec::new(),
        _ => session().into_iter().collect(),
    };
    ToolDetail::Crew { verb: verb.to_string(), targets, text, count, note }
}

/// A control tool's detail once its call answered: the ids and names Crew
/// gave, and the counts. `None` for an answer that adds nothing.
fn control_result(verb: &str, call: crew_protocol::ToolDetail, answer: &Value) -> Option<crew_protocol::ToolDetail> {
    use crew_protocol::{CrewTarget, ToolDetail};
    let ToolDetail::Crew { mut targets, text, mut count, mut note, .. } = call else {
        return None;
    };
    let field = |key: &str| string_field(answer.as_object(), key);
    match verb {
        "start_sessions" => {
            let entries = answer.get("sessions")?.as_array()?;
            let asked = std::mem::take(&mut targets);
            targets = entries
                .iter()
                .enumerate()
                .map(|(at, entry)| {
                    let entry = as_record(entry);
                    let ok = entry.and_then(|entry| entry.get("ok")).and_then(Value::as_bool) != Some(false);
                    let was = asked.get(at);
                    CrewTarget {
                        id: string_field(entry, "id"),
                        name: string_field(entry, "name")
                            .or_else(|| was.map(|was| was.name.clone()))
                            .unwrap_or_else(|| "new session".into()),
                        provider: string_field(entry, "provider").or_else(|| was.and_then(|was| was.provider.clone())),
                        note: if ok { None } else { string_field(entry, "error").or_else(|| Some("failed".into())) },
                    }
                })
                .collect();
            count = answer.get("started").and_then(Value::as_u64).map(|n| n as u32).or(count);
        }
        "interrupt_session" => {
            if let Some(target) = targets.first_mut() {
                target.id = field("session").or(target.id.take());
                target.name = field("name").unwrap_or_else(|| target.name.clone());
            }
            if answer.get("interrupted").and_then(Value::as_bool) == Some(false) {
                note = Some("idle".into());
            }
        }
        "read_session" => {
            if let Some(target) = targets.first_mut() {
                target.id = field("session").or(target.id.take());
            }
            let start = answer.get("start").and_then(Value::as_u64)?;
            let cursor = answer.get("cursor").and_then(Value::as_u64)?;
            count = Some(cursor.saturating_sub(start) as u32);
        }
        "list_peers" => {
            let peers = answer.as_array()?;
            let of = |kind: &str| peers.iter().filter(|peer| peer.get("type").and_then(Value::as_str) == Some(kind)).count();
            let words = [(of("session"), "session"), (of("subagent"), "subagent"), (of("bot"), "bot")]
                .iter()
                .filter(|(n, _)| *n > 0)
                .map(|(n, word)| format!("{n} {word}{}", if *n == 1 { "" } else { "s" }))
                .collect::<Vec<_>>();
            count = Some(peers.len() as u32);
            note = Some(words.join(", ")).filter(|words| !words.is_empty());
        }
        "stop_session" => {
            if let Some(target) = targets.first_mut() {
                target.id = field("session").or(target.id.take());
            }
            count = Some(answer.get("also_stopped").and_then(Value::as_array).map_or(0, Vec::len) as u32);
        }
        "update_session" => {
            if let Some(target) = targets.first_mut() {
                target.id = field("session").or(target.id.take());
            }
            if let Some(deleted) = answer.get("deleted").and_then(Value::as_array) {
                // The session itself is among them: the rest went with it.
                count = Some(deleted.len().saturating_sub(1) as u32);
            }
        }
        _ => return None,
    }
    Some(ToolDetail::Crew { verb: verb.to_string(), targets, text, count, note })
}

/// What a Crew tool did, for the one that is worth reading in a transcript: a
/// message to another bot is half of a conversation happening in two places,
/// and so is the prompt a session was started on.
pub fn crew_tool_detail(name: &str, input: &Map<String, Value>) -> Option<crew_protocol::ToolDetail> {
    let (verb, input) = crew_call(name, input)?;
    if matches!(verb, "delegate" | "start_session") {
        // `start_session` took an `owner` before `delegate` existed: a call
        // that still carries one is an old transcript's, and `me` was a child.
        let what = match (verb, string_field(Some(&input), "owner").as_deref()) {
            (_, Some("user")) => "handoff",
            ("delegate", _) | (_, Some(_)) => "start",
            _ => "launch",
        };
        return Some(crew_protocol::ToolDetail::Message {
            // The name is Crew's to pick when the call leaves it out; the
            // answer brings it (`to_name`).
            to: string_field(Some(&input), "name")
                .or_else(|| string_field(Some(&input), "provider"))
                .unwrap_or_else(|| "new session".into()),
            text: string_field(Some(&input), "prompt").unwrap_or_default(),
            letter_id: None,
            to_id: None,
            to_name: None,
            what: Some(what.into()),
            delivery: None,
            error: None,
        });
    }
    if is_control_tool(verb) {
        return Some(control_detail(verb, &input));
    }
    if !is_message_tool(verb) {
        return None;
    }
    Some(crew_protocol::ToolDetail::Message {
        // `send_to_session` named its reader `session`.
        to: string_field(Some(&input), "to").or_else(|| string_field(Some(&input), "session"))?,
        // A decision on an approval may come with no text: the row says it.
        text: match (string_field(Some(&input), "text"), string_field(Some(&input), "decision")) {
            (Some(text), _) => text,
            (None, Some(decision)) => format!("Decision: {decision}"),
            (None, None) => String::new(),
        },
        letter_id: None,
        to_id: None,
        to_name: None,
        what: None,
        delivery: None,
        error: None,
    })
}

/// A letter tool's row once its call answered: the letter it made, the
/// session it reached and how, or the reason Crew refused it. `None` for any
/// other tool, and for an answer that adds nothing to the row (a receipt
/// from a Crew that did not name its letters).
pub fn crew_result_detail(
    name: &str,
    input: &Map<String, Value>,
    result: &str,
    failed: bool,
) -> Option<crew_protocol::ToolDetail> {
    let call = crew_tool_detail(name, input)?;
    if let crew_protocol::ToolDetail::Crew { verb, .. } = &call {
        // A failed control call keeps the generic failed row, with the error.
        if failed {
            let text = result.trim();
            return (!text.is_empty()).then(|| crew_protocol::ToolDetail::Output { text: text.to_string() });
        }
        let answer: Value = serde_json::from_str(result.trim()).ok()?;
        let verb = verb.clone();
        return control_result(&verb, call, &answer);
    }
    let crew_protocol::ToolDetail::Message { to, text, what, .. } = call else {
        return None;
    };
    let row = |letter_id, to_id, to_name, delivery, error| crew_protocol::ToolDetail::Message {
        to: to.clone(),
        text: text.clone(),
        letter_id,
        to_id,
        to_name,
        what: what.clone(),
        delivery,
        error,
    };
    if failed {
        let error = result.trim();
        return (!error.is_empty()).then(|| row(None, None, None, None, Some(error.to_string())));
    }
    let answer: Map<String, Value> = serde_json::from_str(result.trim()).ok()?;
    let field = |key: &str| string_field(Some(&answer), key);
    let letter_id = field("letter_id")?;
    // `send_message` answers the reader's name as `to`, `delegate` and `start_session` as `name`.
    let to_name = if what.is_some() { field("name") } else { field("to") };
    Some(row(Some(letter_id), field("id"), to_name, field("delivery"), None))
}

/// The row line for a Crew call: `Crew message agent abc`, the tool it ran
/// (directly, or through the old `call_tool`) and whom or what it was about.
pub fn crew_label(name: &str, input: &Map<String, Value>) -> Option<String> {
    let (verb, input) = crew_call(name, input)?;
    let input: &Map<String, Value> = &input;
    let verb = format!("Crew {}", crew_words(verb, input));
    let subject = string_field(Some(input), "to")
        .or_else(|| string_field(Some(input), "session"))
        .or_else(|| string_field(Some(input), "name"))
        .or_else(|| string_field(Some(input), "process"))
        .or_else(|| string_field(Some(input), "query"));
    Some(match subject {
        Some(subject) => format!("{verb} {}", clip(&subject, 40)),
        None => verb,
    })
}

/// What a Crew call reads as: its name in words, or for a tool that merges
/// verbs, the one it ran. `control_process` with action start reads "start
/// process", as the `start_process` of older transcripts still does.
pub fn crew_words(verb: &str, input: &Map<String, Value>) -> String {
    let field = |key: &str| string_field(Some(input), key);
    let merged = match verb {
        "control_process" => field("action").map(|action| format!("{action} process")),
        "browser_act" => field("action").map(|action| format!("browser {action}")),
        "browser_activity" => field("kind").map(|kind| format!("browser {kind}")),
        _ => None,
    };
    merged.unwrap_or_else(|| verb.replace('_', " "))
}

/// An MCP tool's server and tool, from Claude's `mcp__server__tool` name.
/// Crew's own server is left to `crew_tool`.
pub fn mcp_name(name: &str) -> Option<(String, String)> {
    let rest = name.strip_prefix("mcp__")?;
    let (server, tool) = rest.split_once("__")?;
    if server.is_empty() || tool.is_empty() || server == "crew" {
        return None;
    }
    Some((server.to_string(), tool.to_string()))
}

/// The row line for an MCP call: `chrome-devtools · take snapshot`. Servers a
/// connector names `claude_ai_Notion` read as `Notion`.
pub fn mcp_label(server: &str, tool: &str) -> String {
    let server = server.strip_prefix("claude_ai_").unwrap_or(server).replace('_', " ");
    format!("{server} · {}", tool.replace(['_', '-'], " "))
}

/// Arguments as the JSON a person reads, or nothing for a call that took none.
pub fn pretty_input(input: &Map<String, Value>) -> Option<String> {
    if input.is_empty() {
        return None;
    }
    serde_json::to_string_pretty(input).ok()
}

/// A checklist in the `[{content|text, status}]` shape Claude and opencode
/// both write; codex marks `completed` instead of naming a status.
pub fn todo_items(value: Option<&Value>) -> Option<Vec<crew_protocol::TodoItem>> {
    use crew_protocol::{TodoItem, TodoStatus};
    let rows = value?.as_array()?;
    let items = rows
        .iter()
        .filter_map(|row| {
            let row = as_record(row)?;
            let text = string_field(Some(row), "content").or_else(|| string_field(Some(row), "text"))?;
            let status = match string_field(Some(row), "status").as_deref() {
                Some("completed") => TodoStatus::Completed,
                Some("in_progress") => TodoStatus::InProgress,
                Some(_) => TodoStatus::Pending,
                None if row.get("completed").and_then(Value::as_bool) == Some(true) => TodoStatus::Completed,
                None => TodoStatus::Pending,
            };
            Some(TodoItem { text, status })
        })
        .collect::<Vec<_>>();
    Some(items)
}

/// The command inside a login-shell wrapper: codex runs everything as
/// `/bin/zsh -lc "npm test"`, and the row should read `npm test`. Quoting is
/// undone as the shell would: a double-quoted body unescapes `\"`, `\\`, `\$`
/// and `` \` ``; a single-quoted one only rejoins `'\''`. Anything else is
/// returned as it came.
pub fn unwrap_shell(command: &str) -> String {
    let trimmed = command.trim();
    let Some(rest) = ["bash", "zsh", "sh"].iter().find_map(|shell| {
        let body =
            trimmed.strip_prefix("/usr/bin/").or_else(|| trimmed.strip_prefix("/bin/")).unwrap_or(trimmed).strip_prefix(shell)?;
        body.strip_prefix(" -lc ").or_else(|| body.strip_prefix(" -c "))
    }) else {
        return command.to_string();
    };
    let rest = rest.trim();
    if rest.len() >= 2 && rest.starts_with('"') && rest.ends_with('"') {
        let inner = &rest[1..rest.len() - 1];
        let mut out = String::with_capacity(inner.len());
        let mut chars = inner.chars().peekable();
        while let Some(c) = chars.next() {
            if c == '\\' {
                if let Some(&next) = chars.peek() {
                    if matches!(next, '"' | '\\' | '$' | '`') {
                        out.push(next);
                        chars.next();
                        continue;
                    }
                }
            }
            out.push(c);
        }
        return out;
    }
    if rest.len() >= 2 && rest.starts_with('\'') && rest.ends_with('\'') {
        return rest[1..rest.len() - 1].replace("'\\''", "'");
    }
    command.to_string()
}

/// A subagent's report without the frame its harness wraps it in. Claude
/// hands one back as "[Subagent hand-back] … The report follows:", every line
/// indented two spaces, then an `agentId:` line and a `<usage>` block; opencode
/// as `<task …><task_result>…</task_result></task>`. What the reader wants is
/// the report.
pub fn subagent_report(text: &str) -> String {
    if let Some(start) = text.find("<task_result>") {
        let body = &text[start + "<task_result>".len()..];
        let end = body.find("</task_result>").unwrap_or(body.len());
        return body[..end].trim().to_string();
    }
    // opencode 2.x: `<subagent sessionID="…" state="completed">\nreport\n</subagent>`.
    if let Some(open) = text.find("<subagent ") {
        if let Some(close) = text[open..].find('>') {
            let body = &text[open + close + 1..];
            let end = body.find("</subagent>").unwrap_or(body.len());
            return body[..end].trim().to_string();
        }
    }
    let Some(start) = text.find("[Subagent hand-back]") else {
        return text.to_string();
    };
    let framed = &text[start..];
    let Some(follows) = framed.find("The report follows:") else {
        return text.to_string();
    };
    let body = framed[follows + "The report follows:".len()..].trim_start_matches('\n');
    let mut lines = Vec::new();
    for line in body.lines() {
        // The harness indents the report; its own trailer starts at column zero.
        if !line.is_empty() && !line.starts_with(' ') {
            break;
        }
        lines.push(line.strip_prefix("  ").unwrap_or(line));
    }
    lines.join("\n").trim().to_string()
}

pub fn parse_json_line(line: &str) -> Option<Map<String, Value>> {
    let trimmed = line.trim();
    if !trimmed.starts_with('{') {
        return None;
    }
    serde_json::from_str::<Value>(trimmed).ok().and_then(|value| value.as_object().cloned())
}

pub fn try_parse_json_record(value: &str) -> Option<Map<String, Value>> {
    serde_json::from_str::<Value>(value).ok().and_then(|parsed| parsed.as_object().cloned())
}

pub fn finite_number(value: Option<&Value>) -> Option<f64> {
    value.and_then(Value::as_f64).filter(|n| n.is_finite())
}

pub fn clip(value: &str, max: usize) -> String {
    let line = value.split('\n').next().unwrap_or(value);
    if line.chars().count() > max {
        let take = max.saturating_sub(1);
        format!("{}…", line.chars().take(take).collect::<String>())
    } else {
        line.to_string()
    }
}

pub fn leaf(path: &str) -> String {
    let normalized = path.replace('\\', "/");
    normalized.rsplit('/').next().filter(|part| !part.is_empty()).unwrap_or(path).to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_subagent_report_loses_the_frame_its_harness_put_around_it() {
        let claude = "[Subagent hand-back] The text below is the final report of a subagent. The report follows:\n  10\n  \n  Command: `wc -l a.js`\nagentId: a48 (use SendMessage)\n<usage>subagent_tokens: 1</usage>";
        assert_eq!(subagent_report(claude), "10\n\nCommand: `wc -l a.js`");
        let opencode =
            "<task id=\"ses_1\" state=\"completed\">\n<task_result>\nExact line count: **10**\n</task_result>\n</task>";
        assert_eq!(subagent_report(opencode), "Exact line count: **10**");
        assert_eq!(subagent_report("just the report"), "just the report");
    }

    #[test]
    fn a_login_shell_wrapper_reads_as_the_command_inside() {
        assert_eq!(unwrap_shell("/bin/zsh -lc 'npm test'"), "npm test");
        assert_eq!(unwrap_shell(r#"/bin/zsh -lc "rg -n -F 'add(' .""#), "rg -n -F 'add(' .");
        assert_eq!(
            unwrap_shell(r#"/bin/zsh -lc "cat README.md && printf '\\n--- x ---\\n'""#),
            r"cat README.md && printf '\n--- x ---\n'"
        );
        assert_eq!(unwrap_shell(r#"bash -lc "echo \"hi\" \$HOME""#), r#"echo "hi" $HOME"#);
        assert_eq!(unwrap_shell("/bin/bash -lc 'echo it'\\''s'"), "echo it's");
        assert_eq!(unwrap_shell("npm test"), "npm test");
        assert_eq!(unwrap_shell("zshrc -lc x"), "zshrc -lc x");
    }

    /// Measured, not guessed: a misspelled Crew tool still runs, and its row
    /// carried a dump of the tool's result where the chat wanted "wrote to
    /// Cuddles: the branch is green".
    #[test]
    fn a_crew_tool_is_recognised_however_the_provider_spells_it() {
        for spelling in ["mcp__crew__message_agent", "crew_message_agent"] {
            assert_eq!(crew_tool(spelling), Some("message_agent"), "{spelling}");
        }
        for other in ["message_agent", "crew", "crew_", "spawn_agent", "mcp__solo__spawn_agent"] {
            assert_eq!(crew_tool(other), None, "{other}");
        }
    }

    /// `send_message` reads as the message it sent, and so do the two it
    /// replaced, in the transcripts that still hold them.
    #[test]
    fn a_message_reads_as_who_it_went_to_under_every_name_it_has_had() {
        let detail = |name: &str, input: serde_json::Value| crew_tool_detail(name, input.as_object().unwrap());
        for (name, input) in [
            ("mcp__crew__send_message", serde_json::json!({ "to": "abc", "text": "green", "steer": true })),
            ("crew_send_message", serde_json::json!({ "to": "abc", "text": "green" })),
            ("mcp__crew__message_agent", serde_json::json!({ "to": "abc", "text": "green" })),
            ("mcp__crew__send_to_session", serde_json::json!({ "session": "abc", "text": "green", "mode": "queue" })),
        ] {
            assert!(
                matches!(detail(name, input), Some(crew_protocol::ToolDetail::Message { ref to, ref text, .. }) if to == "abc" && text == "green"),
                "{name}"
            );
        }
        assert!(detail("mcp__crew__list_routines", serde_json::json!({})).is_none());
        let label =
            crew_label("mcp__crew__send_to_session", serde_json::json!({ "session": "abc", "text": "x" }).as_object().unwrap());
        assert_eq!(label.as_deref(), Some("Crew send to session abc"));
    }

    /// Transcripts from before tools were listed directly hold `call_tool`
    /// calls, and the row is about the tool it named: a message still reads as
    /// who it went to and what it said.
    #[test]
    fn a_call_through_the_gateway_reads_as_the_tool_it_ran() {
        let input = serde_json::json!({ "name": "message_agent", "arguments": { "to": "abc", "text": "green" } });
        let input = input.as_object().unwrap();
        for spelling in ["mcp__crew__call_tool", "crew_call_tool"] {
            let (verb, arguments) = crew_call(spelling, input).expect(spelling);
            assert_eq!(verb, "message_agent", "{spelling}");
            assert_eq!(arguments["to"], "abc");
            assert!(matches!(
                crew_tool_detail(spelling, input),
                Some(crew_protocol::ToolDetail::Message { ref to, ref text, .. }) if to == "abc" && text == "green"
            ));
        }
        let bare = serde_json::json!({ "name": "list_agents" });
        assert_eq!(crew_call("mcp__crew__call_tool", bare.as_object().unwrap()).map(|(verb, _)| verb), Some("list_agents"));
        let empty = serde_json::Map::new();
        assert_eq!(crew_call("mcp__crew__call_tool", &empty).map(|(verb, _)| verb), Some("call_tool"));
        assert_eq!(crate::providers::claude::tool_label("mcp__crew__call_tool", input), "Crew message agent abc");
    }

    /// A merged tool reads as the verb it ran, and the old names it replaced
    /// still read the same in the history that holds them.
    #[test]
    fn a_merged_tool_reads_as_the_action_it_took() {
        let label = |name: &str, input: serde_json::Value| {
            let input = input.as_object().unwrap().clone();
            (crew_label(name, &input).unwrap(), crate::providers::claude::tool_label(name, &input))
        };
        let start = label("mcp__crew__control_process", serde_json::json!({ "process": "web", "action": "start" }));
        assert_eq!(start, ("Crew start process web".to_string(), "Crew start process web".to_string()));
        let old = label("mcp__crew__start_process", serde_json::json!({ "process": "web" }));
        assert_eq!(old, start, "history keeps reading the same");
        assert_eq!(label("crew_browser_act", serde_json::json!({ "action": "click", "uid": "1_2" })).0, "Crew browser click");
        assert_eq!(label("crew_browser_click", serde_json::json!({ "uid": "1_2" })).0, "Crew browser click");
        assert_eq!(label("crew_browser_activity", serde_json::json!({ "kind": "console" })).0, "Crew browser console");
        assert_eq!(label("crew_control_process", serde_json::json!({})).0, "Crew control process");
    }

    /// Measured on Claude Code 2.1.286: the stream carries `arguments` as the
    /// JSON string the model wrote, and the MCP call gets it parsed.
    #[test]
    fn arguments_written_as_a_string_are_read_as_the_object_they_hold() {
        let input =
            serde_json::json!({ "name": "message_agent", "arguments": "{\"to\": \"abc\", \"text\": \"the branch is green\"}" });
        let input = input.as_object().unwrap();
        assert!(matches!(
            crew_tool_detail("mcp__crew__call_tool", input),
            Some(crew_protocol::ToolDetail::Message { ref to, ref text, .. }) if to == "abc" && text == "the branch is green"
        ));
        let junk = serde_json::json!({ "name": "list_agents", "arguments": "not json" });
        assert_eq!(crew_call("mcp__crew__call_tool", junk.as_object().unwrap()).map(|(verb, _)| verb), Some("list_agents"));
    }

    /// The date is said in a person's words.
    #[test]
    fn today_reads_as_a_date() {
        let today = today();
        assert!(today.contains(", "), "the date reads as a date: {today}");
    }

    /// What a turn is handed before the tail, in these tests.
    const PERSONA: &str = "## Crew bot\n\nYou are Planner. You have: `mcp__crew__send_message`.";

    const TAIL: &str = "## The conversation so far\n\n[user] hola\n[you] hola a ti";

    /// The providers that take the persona in the prompt itself. opencode's
    /// is an instruction entry of its session (`turns/opencode.rs`).
    fn turn_prompts(history: Option<&str>) -> Vec<String> {
        vec![cursor::build_cursor_prompt(PERSONA, history, "y ahora?", &[])]
    }

    /// The bug this replaced: every provider was resumed, so the persona and the
    /// tool sheet reached a bot once, on the turn it was created. By its
    /// fortieth turn it was running on whatever its CLI happened to have kept.
    #[test]
    fn every_provider_sends_the_persona_and_the_tail_on_every_turn() {
        for prompt in turn_prompts(Some(TAIL)) {
            assert!(prompt.starts_with(PERSONA), "{prompt}");
            assert!(prompt.contains("[you] hola a ti"), "{prompt}");
            assert!(prompt.trim_end().ends_with("y ahora?"), "{prompt}");
            assert!(
                prompt.find("[user] hola") < prompt.find("y ahora?"),
                "this turn goes under the tail, not above it: {prompt}"
            );
        }
    }

    /// A first turn has nothing behind it, so the separator would be a heading
    /// over the user's own message.
    #[test]
    fn a_first_turn_is_the_persona_and_the_message() {
        for prompt in turn_prompts(None) {
            assert!(!prompt.contains("## This turn"), "{prompt}");
            assert!(prompt.trim_end().ends_with("y ahora?"), "{prompt}");
        }
    }

    /// Claude takes the same three parts through two channels: the persona on
    /// argv, the tail on stdin above the turn.
    #[test]
    fn claude_splits_the_same_prompt_across_its_two_channels() {
        let persona = PERSONA.to_string();
        let args = claude::build_claude_spawn_args(&claude::ClaudeSpawn {
            model: Some("claude-haiku-4-5-20251001".into()),
            effort: None,
            session_id: Some("sid".into()),
            resume: None,
            replay_user_messages: false,
            asks_questions: false,
            system_prompt: Some(persona.clone()),
            autonomy: Autonomy::Full,
            mcp_config: None,
            user_settings: false,
            fast: false,
        });
        assert!(args.windows(2).any(|pair| pair[0] == "--append-system-prompt" && pair[1] == persona), "{args:?}");
        let message = claude::build_claude_user_message("sid", Some(TAIL), "y ahora?", &[], &[]);
        let text = message["message"]["content"][0]["text"].as_str().unwrap_or_default();
        assert!(text.starts_with("## The conversation so far"), "{text}");
        assert!(text.trim_end().ends_with("y ahora?"), "{text}");
    }

    /// What the composer picks reaches the CLI: the mode it starts in, and
    /// how hard its model thinks.
    #[test]
    fn access_and_effort_become_flags() {
        let claude = |autonomy| {
            claude::build_claude_spawn_args(&claude::ClaudeSpawn {
                model: None,
                effort: Some("xhigh".into()),
                session_id: None,
                resume: None,
                replay_user_messages: false,
                asks_questions: false,
                system_prompt: None,
                autonomy,
                mcp_config: None,
                user_settings: false,
                fast: false,
            })
        };
        let pair = |args: &[String], flag: &str, value: &str| args.windows(2).any(|w| w[0] == flag && w[1] == value);
        assert!(pair(&claude(Autonomy::Edits), "--permission-mode", "acceptEdits"));
        assert!(pair(&claude(Autonomy::Auto), "--permission-mode", "auto"));
        assert!(pair(&claude(Autonomy::Ask), "--permission-mode", "default"));
        assert!(pair(&claude(Autonomy::Ask), "--effort", "xhigh"));
        assert!(!claude(Autonomy::Full).iter().any(|a| a == "--permission-mode"));
        let (_, codex) = codex::thread_request(&codex_thread(None, Some("high")));
        assert_eq!(codex["config"]["model_reasoning_effort"], "high", "{codex}");
    }

    fn codex_thread(resume: Option<&str>, effort: Option<&str>) -> codex::CodexThread {
        codex::CodexThread {
            cwd: "/work".into(),
            resume: resume.map(str::to_string),
            model: Some("gpt".into()),
            effort: effort.map(str::to_string),
            service_tier: None,
            autonomy: Autonomy::Ask,
            mcp: None,
            mcp_env: Vec::new(),
        }
    }

    /// The whole point: a bot's memory is the tail Crew hands it, so nothing
    /// asks a CLI to pick a conversation back up for a bot's turn.
    #[test]
    fn no_provider_asks_its_cli_to_resume_a_bots_turn() {
        let runs = [
            claude::build_claude_spawn_args(&claude::ClaudeSpawn {
                model: None,
                effort: None,
                session_id: Some("sid".into()),
                resume: None,
                replay_user_messages: false,
                asks_questions: false,
                system_prompt: Some("persona".into()),
                autonomy: Autonomy::Ask,
                mcp_config: None,
                user_settings: false,
                fast: false,
            }),
            cursor::build_cursor_spawn_args(&cursor::CursorSpawn { model: None, autonomy: Autonomy::Ask }),
        ];
        for args in runs {
            for arg in &args {
                assert!(!matches!(arg.as_str(), "resume" | "--resume" | "--session" | "--continue"), "{args:?}");
            }
        }
        let (method, params) = codex::thread_request(&codex_thread(None, None));
        assert_eq!(method, "thread/start", "{params}");
        assert!(params.get("threadId").is_none(), "{params}");
        let (method, params) = cursor::session_request("/w", None, &serde_json::json!([]));
        assert_eq!(method, "session/new", "{params}");
    }

    /// A child session is the opposite case: it is its provider's own
    /// conversation, so every turn after the first carries it on.
    #[test]
    fn a_child_carries_its_conversation_on_the_way_each_cli_takes_it() {
        let claude = claude::build_claude_spawn_args(&claude::ClaudeSpawn {
            model: None,
            effort: None,
            session_id: Some("sid".into()),
            resume: Some("conv-1".into()),
            replay_user_messages: true,
            asks_questions: false,
            system_prompt: None,
            autonomy: Autonomy::Ask,
            mcp_config: None,
            user_settings: false,
            fast: false,
        });
        assert!(claude.windows(2).any(|pair| pair == ["--resume", "conv-1"]), "{claude:?}");
        assert!(!claude.contains(&"--session-id".to_string()), "a resume that also names a new session: {claude:?}");
        assert!(claude.contains(&"--replay-user-messages".to_string()), "a steer could never be seen read: {claude:?}");

        let (method, codex) = codex::thread_request(&codex_thread(Some("thread-1"), None));
        assert_eq!(method, "thread/resume", "{codex}");
        assert_eq!(codex["threadId"], "thread-1", "{codex}");
        assert_eq!(codex["model"], "gpt", "a resume without its model runs config.toml's: {codex}");

        let (method, cursor) = cursor::session_request("/w", Some("acp-1"), &serde_json::json!([]));
        assert_eq!(method, "session/load", "{cursor}");
        assert_eq!(cursor["sessionId"], "acp-1", "{cursor}");
    }

    /// A message row, once its call answers, names the letter it made and
    /// whom it reached; refused, it says why. `start_session` is a letter
    /// row too: its prompt went to the session it made.
    #[test]
    fn a_letter_row_takes_its_id_or_its_refusal_from_the_answer() {
        use crew_protocol::ToolDetail;
        let input = serde_json::json!({ "to": "abc", "text": "green" });
        let input = input.as_object().unwrap();
        let answer = r#"{ "to": "Auth", "id": "abc-1", "letter_id": "L1", "delivery": "queued", "waiting": 1 }"#;
        let Some(ToolDetail::Message { to, text, letter_id, to_id, to_name, what, delivery, error }) =
            crate::providers::claude::tool_result_detail("mcp__crew__send_message", input, answer, false)
        else {
            panic!("not a message row");
        };
        assert_eq!((to.as_str(), text.as_str()), ("abc", "green"));
        assert_eq!((letter_id.as_deref(), to_id.as_deref(), to_name.as_deref()), (Some("L1"), Some("abc-1"), Some("Auth")));
        assert_eq!((what, delivery.as_deref(), error), (None, Some("queued"), None));

        let refused = crew_result_detail("crew_send_message", input, "You can't message yourself.", true);
        assert!(
            matches!(refused, Some(ToolDetail::Message { error: Some(ref why), letter_id: None, .. }) if why == "You can't message yourself.")
        );

        let start = serde_json::json!({ "provider": "codex", "prompt": "fix it" });
        let start = start.as_object().unwrap();
        for (tool, said) in [("delegate", "start"), ("start_session", "launch")] {
            assert!(matches!(
                crew_tool_detail(&format!("mcp__crew__{tool}"), start),
                Some(ToolDetail::Message { ref to, ref what, .. }) if to == "codex" && what.as_deref() == Some(said)
            ));
        }
        // What an old transcript's `owner` said.
        let old = serde_json::json!({ "prompt": "fix it", "owner": "user" });
        assert!(matches!(
            crew_tool_detail("mcp__crew__start_session", old.as_object().unwrap()),
            Some(ToolDetail::Message { ref what, .. }) if what.as_deref() == Some("handoff")
        ));
        let started = crew_result_detail(
            "mcp__crew__start_session",
            start,
            r#"{ "id": "s9", "letter_id": "L2", "name": "codex: fix it" }"#,
            false,
        );
        assert!(matches!(
            started,
            Some(ToolDetail::Message { ref text, letter_id: Some(ref l), to_name: Some(ref n), .. }) if text == "fix it" && l == "L2" && n == "codex: fix it"
        ));
        // A tool with nothing to add to its row: a letter tool's answer that is not JSON.
        assert_eq!(crew_result_detail("mcp__crew__send_message", input, "ok", false), None);
    }

    fn crew_detail(name: &str, input: serde_json::Value, answer: Option<(&str, bool)>) -> crew_protocol::ToolDetail {
        let input = input.as_object().unwrap();
        let call = crew_tool_detail(name, input).expect("a call detail");
        match answer {
            Some((result, failed)) => crew_result_detail(name, input, result, failed).unwrap_or(call),
            None => call,
        }
    }

    fn target(id: Option<&str>, name: &str, provider: Option<&str>, note: Option<&str>) -> crew_protocol::CrewTarget {
        crew_protocol::CrewTarget {
            id: id.map(str::to_string),
            name: name.into(),
            provider: provider.map(str::to_string),
            note: note.map(str::to_string),
        }
    }

    fn crew(
        verb: &str,
        targets: Vec<crew_protocol::CrewTarget>,
        text: Option<&str>,
        count: Option<u32>,
        note: Option<&str>,
    ) -> crew_protocol::ToolDetail {
        crew_protocol::ToolDetail::Crew {
            verb: verb.into(),
            targets,
            text: text.map(str::to_string),
            count,
            note: note.map(str::to_string),
        }
    }

    /// The tools that act on sessions read as a row of their own, under both
    /// spellings, from the call and again once it answered.
    #[test]
    fn the_control_tools_carry_whom_they_acted_on_and_what_came_of_it() {
        use serde_json::json;
        for prefix in ["mcp__crew__", "crew_"] {
            let name = |verb: &str| format!("{prefix}{verb}");

            // start_sessions: one target per entry, a failed one with Crew's reason.
            let input = json!({ "sessions": [
                { "name": "billing-ui", "provider": "claude", "prompt": "a" },
                { "provider": "codex", "prompt": "b" },
                { "name": "docs", "prompt": "c" },
            ] });
            assert_eq!(
                crew_detail(&name("start_sessions"), input.clone(), None),
                crew(
                    "start_sessions",
                    vec![
                        target(None, "billing-ui", Some("claude"), None),
                        target(None, "codex", Some("codex"), None),
                        target(None, "docs", None, None),
                    ],
                    None,
                    Some(3),
                    None
                )
            );
            let answer = json!({ "started": 2, "failed": 1, "sessions": [
                { "index": 0, "ok": true, "id": "s1", "name": "billing-ui", "provider": "claude" },
                { "index": 1, "ok": true, "id": "s2", "name": "codex: b", "provider": "codex" },
                { "index": 2, "ok": false, "error": "no such worktree" },
            ] })
            .to_string();
            assert_eq!(
                crew_detail(&name("start_sessions"), input, Some((&answer, false))),
                crew(
                    "start_sessions",
                    vec![
                        target(Some("s1"), "billing-ui", Some("claude"), None),
                        target(Some("s2"), "codex: b", Some("codex"), None),
                        target(None, "docs", None, Some("no such worktree")),
                    ],
                    None,
                    Some(2),
                    None
                )
            );

            // interrupt_session: with and without a redirect, and one with nothing to interrupt.
            let redirect = json!({ "session": "s1", "text": "use the new API" });
            assert_eq!(
                crew_detail(&name("interrupt_session"), redirect.clone(), None),
                crew("interrupt_session", vec![target(Some("s1"), "s1", None, None)], Some("use the new API"), None, None)
            );
            let answer = r#"{ "session": "s1", "name": "billing-ui", "interrupted": true, "letter_id": "L1" }"#;
            assert_eq!(
                crew_detail(&name("interrupt_session"), redirect, Some((answer, false))),
                crew(
                    "interrupt_session",
                    vec![target(Some("s1"), "billing-ui", None, None)],
                    Some("use the new API"),
                    None,
                    None
                )
            );
            let idle = r#"{ "session": "s1", "name": "billing-ui", "interrupted": false }"#;
            assert_eq!(
                crew_detail(&name("interrupt_session"), json!({ "session": "s1" }), Some((idle, false))),
                crew("interrupt_session", vec![target(Some("s1"), "billing-ui", None, None)], None, None, Some("idle"))
            );

            // read_session: the count is what the read covered.
            let answer = r#"{ "session": "s1", "status": "idle", "text": "x", "start": 8, "cursor": 20, "more": false }"#;
            assert_eq!(
                crew_detail(&name("read_session"), json!({ "session": "s1" }), Some((answer, false))),
                crew("read_session", vec![target(Some("s1"), "s1", None, None)], None, Some(12), None)
            );

            // list_peers: counts per type in the note.
            let answer = json!([
                { "id": "a", "type": "session" }, { "id": "b", "type": "session" }, { "id": "c", "type": "session" },
                { "id": "d", "type": "subagent" },
                { "id": "e", "type": "bot" }, { "id": "f", "type": "bot" }, { "id": "g", "type": "bot" },
            ])
            .to_string();
            assert_eq!(
                crew_detail(&name("list_peers"), json!({}), Some((&answer, false))),
                crew("list_peers", vec![], None, Some(7), Some("3 sessions, 1 subagent, 3 bots"))
            );
            assert_eq!(
                crew_detail(&name("list_peers"), json!({}), Some(("[]", false))),
                crew("list_peers", vec![], None, Some(0), None)
            );

            // stop_session: the subagents stopped with it.
            let answer = r#"{ "session": "s1", "status": "exited", "cursor": 3, "also_stopped": [{ "id": "a", "name": "x" }, { "id": "b", "name": "y" }] }"#;
            assert_eq!(
                crew_detail(&name("stop_session"), json!({ "session": "s1" }), Some((answer, false))),
                crew("stop_session", vec![target(Some("s1"), "s1", None, None)], None, Some(2), None)
            );
            let alone = r#"{ "session": "s1", "status": "exited", "cursor": 3 }"#;
            assert_eq!(
                crew_detail(&name("stop_session"), json!({ "session": "s1" }), Some((alone, false))),
                crew("stop_session", vec![target(Some("s1"), "s1", None, None)], None, Some(0), None)
            );

            // update_session: rename or delete in the note.
            let rename = json!({ "session": "s1", "action": "rename", "name": "payments" });
            assert_eq!(
                crew_detail(&name("update_session"), rename.clone(), None),
                crew("update_session", vec![target(Some("s1"), "s1", None, None)], Some("payments"), None, Some("rename"))
            );
            let answer = r#"{ "session": "s1", "name": "payments", "note": "Renamed." }"#;
            assert_eq!(
                crew_detail(&name("update_session"), rename, Some((answer, false))),
                crew("update_session", vec![target(Some("s1"), "s1", None, None)], Some("payments"), None, Some("rename"))
            );
            let delete = json!({ "session": "s1", "action": "delete" });
            let answer = r#"{ "session": "s1", "deleted": ["a", "s1"], "note": "Deleted." }"#;
            assert_eq!(
                crew_detail(&name("update_session"), delete, Some((answer, false))),
                crew("update_session", vec![target(Some("s1"), "s1", None, None)], None, Some(1), Some("delete"))
            );

            // A failed call keeps the generic failed row with Crew's reason.
            let input = json!({ "session": "s1" });
            assert_eq!(
                crew_detail(&name("stop_session"), input, Some(("s1 was not started by you", true))),
                crew_protocol::ToolDetail::Output { text: "s1 was not started by you".into() }
            );
        }
    }

    /// The old `call_tool` gateway still names the tool in its arguments.
    #[test]
    fn a_control_tool_called_through_the_gateway_reads_the_same() {
        let input = serde_json::json!({ "name": "stop_session", "arguments": { "session": "s1" } });
        assert_eq!(
            crew_tool_detail("mcp__crew__call_tool", input.as_object().unwrap()),
            Some(crew("stop_session", vec![target(Some("s1"), "s1", None, None)], None, None, None))
        );
    }

    /// Claude's own result path hands the answer to the same reader.
    #[test]
    fn claude_reads_a_control_tools_answer_into_its_row() {
        let input = serde_json::json!({ "session": "s1" });
        let detail = crate::providers::claude::tool_result_detail(
            "mcp__crew__read_session",
            input.as_object().unwrap(),
            r#"{ "session": "s1", "start": 0, "cursor": 4 }"#,
            false,
        );
        assert_eq!(detail, Some(crew("read_session", vec![target(Some("s1"), "s1", None, None)], None, Some(4), None)));
    }
}
