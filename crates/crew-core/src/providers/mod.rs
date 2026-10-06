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
    rec.and_then(|map| map.get(key))
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string)
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
    const DAYS: [&str; 7] = [
        "Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday",
    ];
    const MONTHS: [&str; 12] = [
        "January", "February", "March", "April", "May", "June", "July", "August", "September",
        "October", "November", "December",
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
    ["mcp__crew__", "crew_"]
        .iter()
        .find_map(|prefix| name.strip_prefix(prefix))
        .filter(|verb| !verb.is_empty())
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

/// The Crew tools that make a letter: the message tools, and `start_session`,
/// whose prompt is the new session's first letter.
pub fn is_letter_tool(verb: &str) -> bool {
    is_message_tool(verb) || verb == "start_session"
}

/// What a Crew tool did, for the one that is worth reading in a transcript: a
/// message to another bot is half of a conversation happening in two places,
/// and so is the prompt a session was started on.
pub fn crew_tool_detail(name: &str, input: &Map<String, Value>) -> Option<crew_protocol::ToolDetail> {
    let (verb, input) = crew_call(name, input)?;
    if verb == "start_session" {
        let handoff = string_field(Some(&input), "owner").as_deref() == Some("user");
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
            what: Some(if handoff { "handoff" } else { "start" }.into()),
            delivery: None,
            error: None,
        });
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
    let Some(crew_protocol::ToolDetail::Message { to, text, what, .. }) = crew_tool_detail(name, input) else {
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
    // `send_message` answers the reader's name as `to`, `start_session` as `name`.
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
        let body = trimmed
            .strip_prefix("/usr/bin/")
            .or_else(|| trimmed.strip_prefix("/bin/"))
            .unwrap_or(trimmed)
            .strip_prefix(shell)?;
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
    serde_json::from_str::<Value>(trimmed)
        .ok()
        .and_then(|value| value.as_object().cloned())
}

pub fn try_parse_json_record(value: &str) -> Option<Map<String, Value>> {
    serde_json::from_str::<Value>(value)
        .ok()
        .and_then(|parsed| parsed.as_object().cloned())
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
    normalized
        .rsplit('/')
        .next()
        .filter(|part| !part.is_empty())
        .unwrap_or(path)
        .to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_subagent_report_loses_the_frame_its_harness_put_around_it() {
        let claude = "[Subagent hand-back] The text below is the final report of a subagent. The report follows:\n  10\n  \n  Command: `wc -l a.js`\nagentId: a48 (use SendMessage)\n<usage>subagent_tokens: 1</usage>";
        assert_eq!(subagent_report(claude), "10\n\nCommand: `wc -l a.js`");
        let opencode = "<task id=\"ses_1\" state=\"completed\">\n<task_result>\nExact line count: **10**\n</task_result>\n</task>";
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
        assert!(detail("mcp__crew__list_peers", serde_json::json!({})).is_none());
        let label = crew_label("mcp__crew__send_to_session", serde_json::json!({ "session": "abc", "text": "x" }).as_object().unwrap());
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
        let input = serde_json::json!({ "name": "message_agent", "arguments": "{\"to\": \"abc\", \"text\": \"the branch is green\"}" });
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

    fn turn_prompts(history: Option<&str>) -> Vec<String> {
        vec![
            opencode::build_opencode_prompt(PERSONA, history, "y ahora?", &[]),
            cursor::build_cursor_prompt(PERSONA, history, "y ahora?", &[]),
        ]
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
        });
        assert!(
            args.windows(2).any(|pair| pair[0] == "--append-system-prompt" && pair[1] == persona),
            "{args:?}"
        );
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
            }),
            cursor::build_cursor_spawn_args(&cursor::CursorSpawn { model: None, autonomy: Autonomy::Ask }),
            opencode::build_opencode_spawn_args(&opencode::OpencodeSpawn {
                model: None,
                autonomy: Autonomy::Ask,
                resume: None,
            }),
        ];
        for args in runs {
            for arg in &args {
                assert!(
                    !matches!(arg.as_str(), "resume" | "--resume" | "--session" | "--continue"),
                    "{args:?}"
                );
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

        let opencode = opencode::build_opencode_spawn_args(&opencode::OpencodeSpawn {
            model: None,
            autonomy: Autonomy::Ask,
            resume: Some("ses_1".into()),
        });
        assert!(opencode.windows(2).any(|pair| pair == ["--session", "ses_1"]), "{opencode:?}");
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
        assert!(matches!(refused, Some(ToolDetail::Message { error: Some(ref why), letter_id: None, .. }) if why == "You can't message yourself."));

        let start = serde_json::json!({ "provider": "codex", "prompt": "fix it", "owner": "user" });
        let start = start.as_object().unwrap();
        assert!(matches!(
            crew_tool_detail("mcp__crew__start_session", start),
            Some(ToolDetail::Message { ref to, ref what, .. }) if to == "codex" && what.as_deref() == Some("handoff")
        ));
        let started = crew_result_detail("mcp__crew__start_session", start, r#"{ "id": "s9", "letter_id": "L2", "name": "codex: fix it" }"#, false);
        assert!(matches!(
            started,
            Some(ToolDetail::Message { ref text, letter_id: Some(ref l), to_name: Some(ref n), .. }) if text == "fix it" && l == "L2" && n == "codex: fix it"
        ));
        assert_eq!(crew_result_detail("mcp__crew__list_peers", start, "[]", false), None);
    }
}
