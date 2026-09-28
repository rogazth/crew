//! Claude Code's session file, `~/.claude/projects/<slug>/<id>.jsonl`.
//!
//! Its `user` and `assistant` records carry the same message shapes as
//! `claude -p --output-format stream-json`, so they go through the same
//! helpers the agent turns use. What differs is framing: one record per
//! content block, several records sharing one `message.id`, and the CLI's own
//! bookkeeping (slash commands, hook output, caveats) written as user messages.

use std::collections::HashMap;

use crew_protocol::{HarnessEvent, ToolStatus, TurnUsage};
use serde::Deserialize;
use serde_json::{Map, Value};

use super::{Decoded, Decoder};
use crate::blocks::is_question_tool;
use crate::providers::claude::{
    assistant_text_blocks, assistant_tool_uses, is_compact_boundary, parse_questions, tool_detail, tool_label,
    tool_result_detail, tool_results_from_user_message,
};
use crate::providers::{as_record, string_field};

#[derive(Default)]
pub struct ClaudeDecoder {
    /// Calls seen, by id: a result names only the call, and the call's input
    /// is what turns the result into a detail.
    tools: HashMap<String, (String, Map<String, Value>)>,
    /// `AskUserQuestion` calls and the request id their card was given.
    questions: HashMap<String, u64>,
    next_request: u64,
    /// The last prompt shown, by `promptId`: `/compact` is written once as
    /// typed and again as a command after the boundary.
    last_prompt: Option<(String, String)>,
}

/// The flags that mark a record the CLI wrote for itself or for the model.
#[derive(Deserialize, Default)]
#[serde(rename_all = "camelCase", default)]
struct Probe {
    #[serde(rename = "type")]
    kind: String,
    is_sidechain: bool,
    is_meta: bool,
    is_synthetic: bool,
    is_compact_summary: bool,
    is_visible_in_transcript_only: bool,
}

impl Probe {
    fn hidden(&self) -> bool {
        self.is_meta || self.is_synthetic || self.is_compact_summary || self.is_visible_in_transcript_only
    }
}

fn flag(rec: &Map<String, Value>, key: &str) -> bool {
    rec.get(key) == Some(&Value::Bool(true))
}

impl Decoder for ClaudeDecoder {
    fn decode(&mut self, line: &str) -> Vec<Decoded> {
        let Ok(rec) = serde_json::from_str::<Map<String, Value>>(line) else {
            return Vec::new();
        };
        let at_ms = rec.get("timestamp").and_then(Value::as_str).and_then(parse_timestamp);
        let mut out = Out { at_ms, items: Vec::new() };
        if flag(&rec, "isSidechain") {
            return Vec::new();
        }
        let hidden = ["isMeta", "isSynthetic", "isCompactSummary", "isVisibleInTranscriptOnly"]
            .iter()
            .any(|key| flag(&rec, key));
        match rec.get("type").and_then(Value::as_str) {
            Some("assistant") if !hidden => self.assistant(&rec, &mut out),
            Some("user") => {
                self.tool_results(&rec, &mut out);
                if !hidden {
                    self.user_text(&rec, &mut out);
                }
            }
            Some("system") => self.system(&rec, &mut out),
            _ => {}
        }
        out.items
    }

    fn is_message(&self, line: &[u8]) -> bool {
        if !contains(line, br#""type":"user""#) && !contains(line, br#""type":"assistant""#) {
            return false;
        }
        let Ok(probe) = serde_json::from_slice::<Probe>(line) else {
            return false;
        };
        (probe.kind == "user" || probe.kind == "assistant")
            && !probe.is_sidechain
            && (!probe.hidden() || contains(line, br#""tool_result""#))
    }
}

struct Out {
    at_ms: Option<i64>,
    items: Vec<Decoded>,
}

impl Out {
    fn event(&mut self, event: HarnessEvent) {
        self.items.push(Decoded::Event { event, at_ms: self.at_ms });
    }

    fn note(&mut self, message: String) {
        self.event(HarnessEvent::SessionNote { message });
    }

    fn turn_ended(&mut self) {
        self.items.push(Decoded::TurnEnded { at_ms: self.at_ms });
    }
}

impl ClaudeDecoder {
    fn assistant(&mut self, rec: &Map<String, Value>, out: &mut Out) {
        for thinking in thinking_blocks(rec) {
            out.event(HarnessEvent::ReasoningDelta { text: thinking });
            out.event(HarnessEvent::MessageCompleted {});
        }
        // Each text record is a message of its own: without the completion
        // two records in a row would read as one bubble.
        let text = assistant_text_blocks(rec);
        if !text.trim().is_empty() {
            out.event(HarnessEvent::MessageDelta { text });
            out.event(HarnessEvent::MessageCompleted {});
        }
        for call in assistant_tool_uses(rec) {
            out.event(HarnessEvent::ToolStarted {
                call_id: call.id.clone(),
                name: call.name.clone(),
                title: tool_label(&call.name, &call.input),
                detail: tool_detail(&call.name, &call.input),
            });
            if is_question_tool(&call.name) {
                self.next_request += 1;
                self.questions.insert(call.id.clone(), self.next_request);
                out.event(HarnessEvent::QuestionRequested {
                    request_id: self.next_request,
                    questions: parse_questions(&call.input),
                });
            }
            self.tools.insert(call.id, (call.name, call.input));
        }
    }

    fn tool_results(&mut self, rec: &Map<String, Value>, out: &mut Out) {
        for result in tool_results_from_user_message(rec) {
            if let Some(request_id) = self.questions.remove(&result.tool_use_id) {
                // The picks are in the record's own `toolUseResult`, keyed by
                // question; the text result is the model's paraphrase of them.
                let answers = if result.is_error {
                    None
                } else {
                    question_answers(rec)
                };
                out.event(HarnessEvent::QuestionResolved { request_id, answers });
                continue;
            }
            let detail = self
                .tools
                .get(&result.tool_use_id)
                .and_then(|(name, input)| tool_result_detail(name, input, &result.content));
            out.event(HarnessEvent::ToolUpdated {
                call_id: result.tool_use_id,
                title: None,
                status: Some(if result.is_error {
                    ToolStatus::Failed
                } else {
                    ToolStatus::Completed
                }),
                detail,
            });
        }
    }

    fn user_text(&mut self, rec: &Map<String, Value>, out: &mut Out) {
        // A background task reporting back is the harness talking to the
        // model; its result shows on the task's own row.
        let origin = rec.get("origin").and_then(as_record);
        if string_field(origin, "kind").as_deref() == Some("task-notification") {
            return;
        }
        let Some(text) = user_text(rec) else {
            return;
        };
        match classify(&text) {
            Some(Said::Prompt(prompt)) => {
                let id = string_field(Some(rec), "promptId");
                if let Some(id) = id.as_ref() {
                    if self.last_prompt.as_ref().is_some_and(|(last, said)| last == id && *said == prompt) {
                        return;
                    }
                }
                self.last_prompt = id.map(|id| (id, prompt.clone()));
                out.event(HarnessEvent::UserMessage {
                    text: prompt,
                    hidden: None,
                    files: None,
                    from_agent: None,
                });
            }
            Some(Said::Note(note)) => out.note(note),
            Some(Said::Interrupted) => {
                // An error rather than a note, only so the calls left running
                // settle as interrupted: the block it adds is the same.
                out.event(HarnessEvent::SessionError {
                    message: "Interrupted".into(),
                });
                out.turn_ended();
            }
            None => {}
        }
    }

    fn system(&mut self, rec: &Map<String, Value>, out: &mut Out) {
        if is_compact_boundary(rec) {
            out.note("Context compacted".into());
            return;
        }
        match rec.get("subtype").and_then(Value::as_str) {
            Some("turn_duration") => {
                out.event(HarnessEvent::TurnCompleted {
                    usage: Some(TurnUsage {
                        input_tokens: None,
                        output_tokens: None,
                        cost_usd: None,
                        duration_ms: rec.get("durationMs").and_then(Value::as_u64),
                    }),
                });
                out.turn_ended();
            }
            // Some commands (`/resume`, `/context`) are written here instead
            // of as user messages, in the same tags.
            Some("local_command") => {
                let Some(text) = rec.get("content").and_then(Value::as_str) else {
                    return;
                };
                match classify(text) {
                    Some(Said::Prompt(prompt)) => out.event(HarnessEvent::UserMessage {
                        text: prompt,
                        hidden: None,
                        files: None,
                        from_agent: None,
                    }),
                    Some(Said::Note(note)) => out.note(note),
                    _ => {}
                }
            }
            _ => {}
        }
    }
}

/// What a user record's text turns out to be.
enum Said {
    Prompt(String),
    Note(String),
    Interrupted,
}

/// Wrappers the CLI puts around what it tells the model, never typed by the
/// user and never shown by the CLI as a message.
const INJECTED: &[&str] = &[
    "<local-command-caveat>",
    "<task-notification>",
    "<system-reminder>",
    "<user-prompt-submit-hook>",
    "<user-memory-input>",
];

fn classify(text: &str) -> Option<Said> {
    let trimmed = text.trim();
    if trimmed.is_empty() {
        return None;
    }
    if trimmed.starts_with("[Request interrupted by user") {
        return Some(Said::Interrupted);
    }
    if let Some(name) = tag(trimmed, "command-name") {
        let args = tag(trimmed, "command-args").unwrap_or_default();
        let command = format!("{} {}", name.trim(), args.trim());
        return Some(Said::Prompt(command.trim().to_string()));
    }
    if let Some(command) = tag(trimmed, "bash-input") {
        return Some(Said::Prompt(format!("! {}", command.trim())));
    }
    if trimmed.starts_with("<local-command-stdout>") || trimmed.starts_with("<local-command-stderr>") {
        let body = [tag(trimmed, "local-command-stdout"), tag(trimmed, "local-command-stderr")];
        return shown(&body);
    }
    if trimmed.starts_with("<bash-stdout>") || trimmed.starts_with("<bash-stderr>") {
        let body = [tag(trimmed, "bash-stdout"), tag(trimmed, "bash-stderr")];
        return shown(&body);
    }
    if INJECTED.iter().any(|wrapper| trimmed.starts_with(wrapper)) {
        return None;
    }
    Some(Said::Prompt(text.to_string()))
}

/// Command output as the CLI printed it, colours dropped; nothing when the
/// command printed nothing.
fn shown(parts: &[Option<&str>]) -> Option<Said> {
    let text = parts
        .iter()
        .flatten()
        .map(|part| strip_ansi(part).trim().to_string())
        .filter(|part| !part.is_empty())
        .collect::<Vec<_>>()
        .join("\n");
    (!text.is_empty()).then_some(Said::Note(text))
}

/// The inside of the first `<name>…</name>` in `text`.
fn tag<'a>(text: &'a str, name: &str) -> Option<&'a str> {
    let open = format!("<{name}>");
    let close = format!("</{name}>");
    let start = text.find(&open)? + open.len();
    let end = text[start..].find(&close)? + start;
    Some(&text[start..end])
}

/// A user record's words: the string, or its text parts. Images are left out:
/// the CLI already wrote `[Image #n]` where each one went.
fn user_text(rec: &Map<String, Value>) -> Option<String> {
    let content = rec.get("message").and_then(as_record)?.get("content")?;
    match content {
        Value::String(text) => Some(text.clone()),
        Value::Array(parts) => {
            let texts: Vec<&str> = parts
                .iter()
                .filter_map(as_record)
                .filter(|part| part.get("type").and_then(Value::as_str) == Some("text"))
                .filter_map(|part| part.get("text").and_then(Value::as_str))
                .collect();
            (!texts.is_empty()).then(|| texts.join("\n"))
        }
        _ => None,
    }
}

/// Thinking that was kept. Most records carry only a signature: the text is
/// redacted, and an empty reasoning row says nothing.
fn thinking_blocks(rec: &Map<String, Value>) -> Vec<String> {
    let Some(parts) = rec
        .get("message")
        .and_then(as_record)
        .and_then(|msg| msg.get("content"))
        .and_then(Value::as_array)
    else {
        return Vec::new();
    };
    parts
        .iter()
        .filter_map(as_record)
        .filter(|part| part.get("type").and_then(Value::as_str) == Some("thinking"))
        .filter_map(|part| part.get("thinking").and_then(Value::as_str))
        .filter(|text| !text.trim().is_empty())
        .map(str::to_string)
        .collect()
}

fn question_answers(rec: &Map<String, Value>) -> Option<HashMap<String, String>> {
    let answers = rec.get("toolUseResult").and_then(as_record)?.get("answers").and_then(as_record)?;
    let answers: HashMap<String, String> = answers
        .iter()
        .filter_map(|(question, answer)| Some((question.clone(), answer.as_str()?.to_string())))
        .collect();
    (!answers.is_empty()).then_some(answers)
}

fn contains(haystack: &[u8], needle: &[u8]) -> bool {
    haystack.windows(needle.len()).any(|window| window == needle)
}

fn strip_ansi(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut chars = text.chars().peekable();
    while let Some(c) = chars.next() {
        if c != '\u{1b}' {
            out.push(c);
            continue;
        }
        match chars.peek() {
            // CSI: parameters, then one final byte in `@`..=`~`.
            Some('[') => {
                chars.next();
                for c in chars.by_ref() {
                    if ('@'..='~').contains(&c) {
                        break;
                    }
                }
            }
            // OSC: up to BEL or ESC \.
            Some(']') => {
                chars.next();
                while let Some(c) = chars.next() {
                    if c == '\u{7}' {
                        break;
                    }
                    if c == '\u{1b}' && chars.peek() == Some(&'\\') {
                        chars.next();
                        break;
                    }
                }
            }
            _ => {
                chars.next();
            }
        }
    }
    out
}

/// `2026-09-28T18:15:16.464Z` (or with a `+hh:mm` offset) in ms since the epoch.
pub(super) fn parse_timestamp(text: &str) -> Option<i64> {
    let bytes = text.as_bytes();
    let num = |from: usize, len: usize| -> Option<i64> {
        let digits = text.get(from..from + len)?;
        digits.bytes().all(|b| b.is_ascii_digit()).then(|| digits.parse().ok())?
    };
    if bytes.len() < 19 || bytes[4] != b'-' || bytes[7] != b'-' || !matches!(bytes[10], b'T' | b' ') {
        return None;
    }
    let (year, month, day) = (num(0, 4)?, num(5, 2)?, num(8, 2)?);
    let (hour, minute, second) = (num(11, 2)?, num(14, 2)?, num(17, 2)?);
    let mut rest = &text[19..];
    let mut millis = 0;
    if let Some(fraction) = rest.strip_prefix('.') {
        let digits = fraction.bytes().take_while(u8::is_ascii_digit).count();
        let padded = format!("{:0<3}", &fraction[..digits.min(3)]);
        millis = padded.parse::<i64>().ok()?;
        rest = &fraction[digits..];
    }
    let offset_minutes = match rest {
        "" | "Z" | "z" => 0,
        _ => {
            let sign = match rest.as_bytes()[0] {
                b'+' => 1,
                b'-' => -1,
                _ => return None,
            };
            let clock = rest[1..].replace(':', "");
            if clock.len() != 4 || !clock.bytes().all(|b| b.is_ascii_digit()) {
                return None;
            }
            sign * (clock[..2].parse::<i64>().ok()? * 60 + clock[2..].parse::<i64>().ok()?)
        }
    };
    let days = days_from_civil(year, month, day);
    let seconds = days * 86_400 + hour * 3_600 + minute * 60 + second - offset_minutes * 60;
    Some(seconds * 1_000 + millis)
}

/// Days since 1970-01-01 in the proleptic Gregorian calendar (Howard Hinnant's
/// `days_from_civil`).
fn days_from_civil(year: i64, month: i64, day: i64) -> i64 {
    let year = if month <= 2 { year - 1 } else { year };
    let era = if year >= 0 { year } else { year - 399 } / 400;
    let yoe = year - era * 400;
    let mp = (month + 9) % 12;
    let doy = (153 * mp + 2) / 5 + day - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    era * 146_097 + doe - 719_468
}

#[cfg(test)]
mod tests {
    use crew_protocol::{Block, BlockRole};

    use super::super::History;
    use super::*;

    fn decode(name: &str, body: &str) -> Vec<Block> {
        let dir = std::env::temp_dir().join(format!("crew-claude-history-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).expect("temp dir");
        let path = dir.join(name);
        std::fs::write(&path, body).expect("write");
        let history = History::open(&path, ClaudeDecoder::default(), 300).expect("open");
        let _ = std::fs::remove_dir_all(&dir);
        history.blocks().to_vec()
    }

    fn approvals() -> Vec<Block> {
        decode("approvals.jsonl", include_str!("../../tests/fixtures/claude/claude-approvals.jsonl"))
    }

    fn compact() -> Vec<Block> {
        decode("compact.jsonl", include_str!("../../tests/fixtures/claude/claude-compact.jsonl"))
    }

    fn roles(blocks: &[Block]) -> Vec<BlockRole> {
        blocks.iter().map(|block| block.role.clone()).collect()
    }

    fn answers(block: &Block) -> HashMap<String, String> {
        block
            .question
            .as_ref()
            .and_then(|question| question.answers.clone())
            .expect("answered")
    }

    fn pairs(items: &[(&str, &str)]) -> HashMap<String, String> {
        items.iter().map(|(k, v)| (k.to_string(), v.to_string())).collect()
    }

    #[test]
    fn approvals_denials_and_questions() {
        use BlockRole::*;
        let blocks = approvals();
        assert_eq!(
            roles(&blocks),
            [
                User, Tool, Assistant, // approved
                User, Tool, System, // denied with Esc
                User, Question, Assistant, // two questions
                User, Question, Assistant, // free text
                User, Question, Assistant, // multiSelect
            ]
        );
        assert_eq!(blocks[0].text, "Run the shell command: touch made-by-claude.txt");
        let touch = blocks[1].tool.as_ref().expect("tool");
        assert_eq!((touch.name.as_str(), &touch.status), ("Bash", &ToolStatus::Completed));
        assert_eq!(blocks[1].text, "touch made-by-claude.txt");
        assert_eq!(blocks[2].text, "Done. The file `made-by-claude.txt` has been created.");
        // turn_duration hangs the turn's time on its last block.
        assert_eq!(blocks[2].usage.as_ref().and_then(|usage| usage.duration_ms), Some(3383));

        assert_eq!(blocks[4].tool.as_ref().map(|tool| &tool.status), Some(&ToolStatus::Failed));
        assert_eq!(blocks[5].text, "Interrupted");

        assert_eq!(blocks[7].text, "Color");
        assert_eq!(blocks[7].question.as_ref().map(|q| q.questions.len()), Some(2));
        assert_eq!(
            answers(&blocks[7]),
            pairs(&[
                ("What is your favorite color?", "Blue"),
                ("What is your favorite fruit?", "Apple"),
            ])
        );
        assert_eq!(answers(&blocks[10]), pairs(&[("What is your favorite pet?", "a parrot named Kiwi")]));
        let toppings = blocks[13].question.as_ref().expect("question");
        assert!(toppings.questions[0].multi_select);
        assert_eq!(
            answers(&blocks[13]),
            pairs(&[("Which toppings?", "Cheese, Olives"), ("Which size?", "medium please")])
        );
        // The thinking in these records is redacted: no empty reasoning rows.
        assert!(blocks.iter().all(|block| block.role != Reasoning));
        assert!(blocks.iter().all(|block| !crate::blocks::is_open(block)));
        assert!(blocks.iter().all(|block| block.at.is_some_and(|at| at > 1_790_000_000_000)));
    }

    #[test]
    fn an_interrupted_call_an_edit_a_subagent_and_compact() {
        use BlockRole::*;
        let blocks = compact();
        assert_eq!(
            roles(&blocks),
            [
                User, Question, Assistant, // tea or coffee
                User, Tool, System, // the interrupted sleep
                User, Tool, Tool, Assistant, // read, edit
                User, Tool, Assistant, Assistant, // the subagent, and its report
                User, System, System, // /compact
                User, Assistant, // after it
            ]
        );
        assert_eq!(answers(&blocks[1]), pairs(&[("Do you prefer tea or coffee?", "Coffee")]));

        let sleep = blocks[4].tool.as_ref().expect("tool");
        assert_eq!(sleep.status, ToolStatus::Failed);
        assert_eq!(blocks[5].text, "Interrupted");

        assert_eq!(blocks[8].text, "Edit notes.txt");
        let edit = blocks[8].tool.as_ref().expect("tool");
        assert_eq!(edit.status, ToolStatus::Completed);
        let Some(crew_protocol::ToolDetail::Edit { path, hunks, .. }) = &edit.detail else {
            panic!("an edit row: {:?}", edit.detail);
        };
        assert!(path.ends_with("/notes.txt"));
        assert_eq!(hunks.as_ref().map(|h| h[0].after.as_str()), Some("hello\nplanet"));

        // The subagent's own work lives in its own file; here there is only
        // the call and what the parent said once it reported back.
        let agent = blocks[11].tool.as_ref().expect("tool");
        assert_eq!(agent.name, "Agent");
        assert_eq!(blocks[13].text, "The file notes.txt has **3 lines**.");
        assert!(blocks.iter().all(|block| !block.text.contains("task-notification")));

        // Typed once, written twice: before the boundary and after it.
        assert_eq!(blocks[14].text, "/compact");
        assert_eq!(blocks[15].text, "Context compacted");
        assert!(blocks[16].text.starts_with("Compacted (ctrl+o to see full summary)"));
        assert!(!blocks[16].text.contains('\u{1b}'));
        assert!(blocks.iter().all(|block| !block.text.starts_with("This session is being continued")));
        assert_eq!(blocks[17].text, "What file did we edit? One line.");
        assert_eq!(blocks[18].usage.as_ref().and_then(|usage| usage.duration_ms), Some(1568));
    }

    #[test]
    fn a_cleared_session_opens_on_the_command() {
        let blocks = decode("cleared.jsonl", include_str!("../../tests/fixtures/claude/claude-cleared.jsonl"));
        assert_eq!(roles(&blocks), [BlockRole::User]);
        assert_eq!(blocks[0].text, "/clear");
    }

    fn record(value: serde_json::Value) -> String {
        value.to_string()
    }

    fn run(lines: &[String]) -> Vec<Decoded> {
        let mut decoder = ClaudeDecoder::default();
        lines.iter().flat_map(|line| decoder.decode(line)).collect()
    }

    fn events(lines: &[String]) -> Vec<HarnessEvent> {
        run(lines)
            .into_iter()
            .filter_map(|decoded| match decoded {
                Decoded::Event { event, .. } => Some(event),
                Decoded::TurnEnded { .. } => None,
            })
            .collect()
    }

    #[test]
    fn sidechains_and_injected_records_are_skipped() {
        let lines = [
            record(serde_json::json!({
                "type": "assistant", "isSidechain": true,
                "message": { "content": [{ "type": "text", "text": "subagent at work" }] },
            })),
            record(serde_json::json!({
                "type": "user", "isMeta": true,
                "message": { "content": "Continue from where you left off." },
            })),
            record(serde_json::json!({
                "type": "user",
                "message": { "content": "<system-reminder>be nice</system-reminder>" },
            })),
            record(serde_json::json!({ "type": "attachment", "attachment": { "type": "user" } })),
        ];
        assert!(run(&lines).is_empty());
        let decoder = ClaudeDecoder::default();
        assert!(!decoder.is_message(lines[0].as_bytes()));
        assert!(!decoder.is_message(lines[1].as_bytes()));
        assert!(decoder.is_message(lines[2].as_bytes()));
        assert!(!decoder.is_message(lines[3].as_bytes()));
    }

    #[test]
    fn a_meta_record_still_brings_its_tool_results() {
        let lines = [
            record(serde_json::json!({
                "type": "assistant",
                "message": { "content": [{ "type": "tool_use", "id": "t1", "name": "Bash", "input": { "command": "ls" } }] },
            })),
            record(serde_json::json!({
                "type": "user", "isMeta": true,
                "message": { "content": [
                    { "type": "tool_result", "tool_use_id": "t1", "content": "a\nb", "is_error": true },
                    { "type": "text", "text": "not shown" },
                ] },
            })),
        ];
        let events = events(&lines);
        assert_eq!(events.len(), 2);
        let HarnessEvent::ToolUpdated { status, detail, .. } = &events[1] else {
            panic!("{:?}", events[1]);
        };
        assert_eq!(status, &Some(ToolStatus::Failed));
        assert!(matches!(detail, Some(crew_protocol::ToolDetail::Command { output: Some(out), .. }) if out == "a\nb"));
        assert!(ClaudeDecoder::default().is_message(lines[1].as_bytes()));
    }

    #[test]
    fn user_words_commands_and_command_output() {
        let user = |content: serde_json::Value| record(serde_json::json!({ "type": "user", "message": { "content": content } }));
        let events = events(&[
            user(serde_json::json!("<command-name>/model</command-name>\n<command-message>model</command-message>\n<command-args>opus</command-args>")),
            user(serde_json::json!("<local-command-stdout>\u{1b}[1mSet model to opus\u{1b}[22m</local-command-stdout>")),
            user(serde_json::json!("<local-command-stdout></local-command-stdout>")),
            user(serde_json::json!("<bash-input>ls</bash-input>")),
            user(serde_json::json!([{ "type": "text", "text": "look [Image #1]" }, { "type": "image", "source": {} }])),
            user(serde_json::json!([{ "type": "text", "text": "[Request interrupted by user]" }])),
        ]);
        let said: Vec<String> = events
            .iter()
            .map(|event| match event {
                HarnessEvent::UserMessage { text, .. } => format!("user: {text}"),
                HarnessEvent::SessionNote { message } | HarnessEvent::SessionError { message } => {
                    format!("note: {message}")
                }
                other => format!("{other:?}"),
            })
            .collect();
        assert_eq!(
            said,
            ["user: /model opus", "note: Set model to opus", "user: ! ls", "user: look [Image #1]", "note: Interrupted"]
        );
        let ended = run(&[user(serde_json::json!("[Request interrupted by user for tool use]"))]);
        assert!(matches!(ended.last(), Some(Decoded::TurnEnded { .. })));
    }

    #[test]
    fn kept_thinking_becomes_a_reasoning_row_and_text_records_stay_apart() {
        let assistant = |part: serde_json::Value| {
            record(serde_json::json!({ "type": "assistant", "message": { "id": "m1", "content": [part] } }))
        };
        let blocks = crate::blocks::settle_streaming(
            events(&[
                assistant(serde_json::json!({ "type": "thinking", "thinking": "hmm", "signature": "x" })),
                assistant(serde_json::json!({ "type": "text", "text": "one" })),
                assistant(serde_json::json!({ "type": "text", "text": "two" })),
            ])
            .into_iter()
            .fold(Vec::new(), crate::blocks::apply_event),
        );
        assert_eq!(roles(&blocks), [BlockRole::Reasoning, BlockRole::Assistant, BlockRole::Assistant]);
        assert_eq!(blocks[2].text, "two");
    }

    #[test]
    fn a_dismissed_question_is_dismissed() {
        let lines = [
            record(serde_json::json!({
                "type": "assistant",
                "message": { "content": [{ "type": "tool_use", "id": "q1", "name": "AskUserQuestion", "input": {
                    "questions": [{ "question": "Tea?", "header": "Tea", "multiSelect": false,
                        "options": [{ "label": "Yes" }, { "label": "No" }] }],
                } }] },
            })),
            record(serde_json::json!({
                "type": "user",
                "message": { "content": [{ "type": "tool_result", "tool_use_id": "q1", "content": "dismissed", "is_error": true }] },
            })),
        ];
        let blocks = events(&lines).into_iter().fold(Vec::new(), crate::blocks::apply_event);
        assert_eq!(roles(&blocks), [BlockRole::Question]);
        assert_eq!(blocks[0].question.as_ref().and_then(|q| q.dismissed), Some(true));
    }

    #[test]
    fn timestamps() {
        assert_eq!(parse_timestamp("1970-01-01T00:00:00Z"), Some(0));
        assert_eq!(parse_timestamp("2000-03-01T00:00:00.5Z"), Some(951_868_800_500));
        assert_eq!(parse_timestamp("2026-09-28T18:15:16.464Z"), Some(1_790_619_316_464));
        assert_eq!(parse_timestamp("2026-09-28T20:15:16.464+02:00"), Some(1_790_619_316_464));
        assert_eq!(parse_timestamp("yesterday"), None);
    }
}
