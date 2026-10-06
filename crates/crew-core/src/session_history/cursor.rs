//! cursor-agent's transcript, `~/.cursor/projects/<slug>/agent-transcripts/<id>/<id>.jsonl`.
//!
//! The chat's own store (`~/.cursor/chats/<hash>/<id>/store.db`) is a tree of
//! content-addressed blobs that is rewritten, not appended to. This file is
//! the CLI's plain record of the same conversation: one line per user prompt,
//! one per assistant message with its text and tool calls, and a
//! `turn_ended` line. It is lossy where the store is not: calls carry no id
//! and no result, and only prompts carry a time, so each call shows what it
//! was asked to do and settles when its turn does.

use std::sync::LazyLock;

use crew_protocol::{EditHunk, HarnessEvent, ToolDetail};
use serde_json::{Map, Value};

use super::claude::days_from_civil;
use super::{Decoded, Decoder};
use crate::providers::cursor::{tool_detail, tool_label, AcpTool};
use crate::providers::{as_record, clip, leaf, string_field, todo_items};

#[derive(Default)]
pub struct CursorDecoder {
    /// Calls have no id of their own; each row needs one to be updated by.
    next_call: u64,
    /// The time of the prompt the current turn answers: nothing else in the
    /// file is dated, and a row dated by when it was read would be wrong.
    turn_at: Option<i64>,
}

impl Decoder for CursorDecoder {
    fn decode(&mut self, line: &str) -> Vec<Decoded> {
        let Ok(rec) = serde_json::from_str::<Map<String, Value>>(line) else {
            return Vec::new();
        };
        if rec.get("type").and_then(Value::as_str) == Some("turn_ended") {
            return self.turn_ended(&rec);
        }
        let content = rec.get("message").and_then(as_record).and_then(|message| message.get("content"));
        match rec.get("role").and_then(Value::as_str) {
            Some("user") => self.user(content),
            Some("assistant") => self.assistant(content),
            _ => Vec::new(),
        }
    }

    fn is_message(&self, line: &[u8]) -> bool {
        line.starts_with(br#"{"role":"user""#) || line.starts_with(br#"{"role":"assistant""#)
    }
}

impl CursorDecoder {
    fn event(&self, event: HarnessEvent) -> Decoded {
        Decoded::Event { event, at_ms: self.turn_at }
    }

    /// Only what sits in `<user_query>` was typed. A record without one is
    /// what the CLI tells the model (tool catalogs, skills, a summary).
    fn user(&mut self, content: Option<&Value>) -> Vec<Decoded> {
        let text = texts(content);
        let Some(query) = tag(&text, "user_query") else {
            return Vec::new();
        };
        let query = query.trim();
        if query.is_empty() {
            return Vec::new();
        }
        // Older CLIs write no `turn_ended`: a prompt is the only sign the
        // calls before it are done. Settled ones are left as they are.
        let settled = self.event(HarnessEvent::TurnCompleted { usage: None });
        if let Some(at) = tag(&text, "timestamp").and_then(parse_timestamp) {
            self.turn_at = Some(at);
        }
        let prompt = self.event(HarnessEvent::UserMessage {
            text: query.to_string(),
            hidden: None,
            files: None,
            from_bot: None,
            letter_id: None,
        });
        vec![settled, prompt]
    }

    fn assistant(&mut self, content: Option<&Value>) -> Vec<Decoded> {
        let Some(parts) = content.and_then(Value::as_array) else {
            return Vec::new();
        };
        let mut out = Vec::new();
        // Each text part is a message of its own: without the completion two
        // records in a row would read as one bubble.
        for part in parts.iter().filter_map(as_record) {
            match part.get("type").and_then(Value::as_str) {
                Some("text") => {
                    let Some(text) = part.get("text").and_then(Value::as_str).filter(|text| !text.trim().is_empty())
                    else {
                        continue;
                    };
                    out.push(self.event(HarnessEvent::MessageDelta { text: text.to_string() }));
                    out.push(self.event(HarnessEvent::MessageCompleted {}));
                }
                Some("tool_use") => {
                    let Some(name) = part.get("name").and_then(Value::as_str) else { continue };
                    let empty = Map::new();
                    let input = part.get("input").and_then(as_record).unwrap_or(&empty);
                    if name == "UpdateCurrentStep" {
                        continue;
                    }
                    self.next_call += 1;
                    out.push(self.event(HarnessEvent::ToolStarted {
                        call_id: format!("cursor-{}", self.next_call),
                        name: name.to_string(),
                        title: label(name, input),
                        detail: detail(name, input),
                    }));
                }
                _ => {}
            }
        }
        out
    }

    fn turn_ended(&mut self, rec: &Map<String, Value>) -> Vec<Decoded> {
        let ended = Decoded::TurnEnded { at_ms: self.turn_at };
        let out = match rec.get("status").and_then(Value::as_str) {
            Some("aborted") => vec![self.event(HarnessEvent::SessionError { message: "Interrupted".into() }), ended],
            Some("error") => vec![self.event(HarnessEvent::SessionError { message: "Turn failed".into() }), ended],
            _ => vec![self.event(HarnessEvent::TurnCompleted { usage: None }), ended],
        };
        self.turn_at = None;
        out
    }
}

/// The transcript names its tools as the model calls them (`StrReplace`,
/// `CallMcpTool`, `glob_pattern`), not as ACP does; what the two share goes
/// through the same helpers once the call is put in ACP's terms.
fn label(name: &str, input: &Map<String, Value>) -> String {
    match name {
        "StrReplace" | "Delete" => match string_field(Some(input), "path") {
            Some(path) => format!("{} {}", if name == "Delete" { "Delete" } else { "Edit" }, leaf(&path)),
            None => name.to_string(),
        },
        "TodoWrite" => "Todos".into(),
        "Glob" => match string_field(Some(input), "glob_pattern") {
            Some(pattern) => format!("Glob {}", clip(&pattern, 40)),
            None => "Glob".into(),
        },
        "WebSearch" => match string_field(Some(input), "search_term") {
            Some(term) => format!("Search {}", clip(&term, 60)),
            None => "Search".into(),
        },
        "Task" | "Subagent" => string_field(Some(input), "description")
            .map(|description| clip(&description, 72))
            .unwrap_or_else(|| "Subagent".into()),
        "AskQuestion" => string_field(Some(input), "title").map(|title| clip(&title, 72)).unwrap_or_else(|| "Question".into()),
        _ => tool_label(&acp(name, input)),
    }
}

/// The call as an ACP `tool_call` would have told it: a kind, and an MCP
/// call's server, tool and arguments where ACP keeps them.
fn acp(name: &str, input: &Map<String, Value>) -> AcpTool {
    let (kind, title) = match name {
        "Shell" => ("execute", name),
        "Read" | "ReadFile" => ("read", name),
        "StrReplace" | "Write" | "ApplyPatch" => ("edit", name),
        "Delete" => ("delete", name),
        "Grep" | "rg" => ("search", "grep"),
        "Glob" => ("search", "glob"),
        "SemanticSearch" => ("search", name),
        "WebFetch" => ("fetch", name),
        _ => ("other", name),
    };
    let mut tool = AcpTool { kind: kind.into(), title: title.into(), input: input.clone(), ..AcpTool::default() };
    if matches!(name, "CallMcpTool" | "CallDynamicTool") {
        let server = string_field(Some(input), "server").or_else(|| string_field(Some(input), "namespace"));
        if let (Some(server), Some(tool_name)) = (server, string_field(Some(input), "toolName")) {
            let args = input.get("arguments").cloned().unwrap_or_else(|| Value::Object(Map::new()));
            tool.input = Map::from_iter([
                ("providerIdentifier".to_string(), Value::String(server)),
                ("toolName".to_string(), Value::String(tool_name)),
                ("args".to_string(), args),
            ]);
        } else {
            tool.input = Map::new();
        }
    }
    tool
}

fn detail(name: &str, input: &Map<String, Value>) -> Option<ToolDetail> {
    match name {
        "StrReplace" => Some(ToolDetail::Edit {
            path: string_field(Some(input), "path")?,
            added: None,
            removed: None,
            hunks: Some(vec![EditHunk {
                before: text(input, "old_string").unwrap_or_default(),
                after: text(input, "new_string").unwrap_or_default(),
            }]),
        }),
        "Write" => {
            let contents = text(input, "contents");
            Some(ToolDetail::Edit {
                path: string_field(Some(input), "path")?,
                added: contents.as_deref().map(|text| text.lines().count() as u32),
                removed: None,
                hunks: contents.map(|after| vec![EditHunk { before: String::new(), after }]),
            })
        }
        "Glob" => Some(ToolDetail::Search {
            query: string_field(Some(input), "glob_pattern")?,
            matches: None,
            output: None,
        }),
        "TodoWrite" => Some(ToolDetail::Todo { items: todo_items(input.get("todos"))? }),
        _ => tool_detail(&acp(name, input), None, None),
    }
}

/// Text as written: `string_field` trims, and an edit's indentation is its shape.
fn text(input: &Map<String, Value>, key: &str) -> Option<String> {
    input.get(key).and_then(Value::as_str).map(str::to_string)
}

/// A message's words: the string, or its text parts joined.
fn texts(content: Option<&Value>) -> String {
    match content {
        Some(Value::String(text)) => text.clone(),
        Some(Value::Array(parts)) => parts
            .iter()
            .filter_map(as_record)
            .filter(|part| part.get("type").and_then(Value::as_str) == Some("text"))
            .filter_map(|part| part.get("text").and_then(Value::as_str))
            .collect::<Vec<_>>()
            .join("\n"),
        _ => String::new(),
    }
}

/// The inside of the first `<name>…</name>` in `text`.
fn tag<'a>(text: &'a str, name: &str) -> Option<&'a str> {
    let open = format!("<{name}>");
    let close = format!("</{name}>");
    let start = text.find(&open)? + open.len();
    let end = text[start..].find(&close)? + start;
    Some(&text[start..end])
}

/// `Monday, Aug 24, 2026, 1:05 PM (UTC-4)`, the only date the file keeps.
static STAMP: LazyLock<regex::Regex> = LazyLock::new(|| {
    regex::Regex::new(r"^\w+, (\w{3}) (\d{1,2}), (\d{4}), (\d{1,2}):(\d{2}) ([AP]M) \(UTC(?:([+-])(\d{1,2})(?::(\d{2}))?)?\)$")
        .unwrap()
});

fn parse_timestamp(text: &str) -> Option<i64> {
    let caps = STAMP.captures(text.trim())?;
    let num = |i: usize| caps.get(i).map_or(Some(0), |m| m.as_str().parse::<i64>().ok());
    const MONTHS: [&str; 12] = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
    let month = MONTHS.iter().position(|m| *m == &caps[1])? as i64 + 1;
    let (day, year, hour12, minute) = (num(2)?, num(3)?, num(4)?, num(5)?);
    let hour = hour12 % 12 + if &caps[6] == "PM" { 12 } else { 0 };
    let sign = if caps.get(7).is_some_and(|m| m.as_str() == "-") { -1 } else { 1 };
    let offset_minutes = sign * (num(8)? * 60 + num(9)?);
    let seconds = days_from_civil(year, month, day) * 86_400 + hour * 3_600 + minute * 60 - offset_minutes * 60;
    Some(seconds * 1_000)
}

#[cfg(test)]
mod tests {
    use crew_protocol::{Block, BlockRole, ToolStatus};

    use super::super::History;
    use super::*;

    fn decode(body: &str) -> Vec<Block> {
        let dir = std::env::temp_dir().join(format!("crew-cursor-history-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).expect("temp dir");
        let path = dir.join("chat.jsonl");
        std::fs::write(&path, body).expect("write");
        let history = History::open(&path, CursorDecoder::default(), 300).expect("open");
        let _ = std::fs::remove_dir_all(&dir);
        history.blocks().to_vec()
    }

    fn fixture() -> Vec<Block> {
        decode(include_str!("../../tests/fixtures/cursor/cursor-transcript.jsonl"))
    }

    #[test]
    fn a_turn_reads_as_the_prompt_the_replies_and_the_calls() {
        let blocks = fixture();
        let rows: Vec<(BlockRole, &str)> = blocks.iter().map(|block| (block.role.clone(), block.text.as_str())).collect();
        assert_eq!(
            rows,
            vec![
                (BlockRole::User, "Fix the add helper"),
                (BlockRole::Assistant, "Looking at the helper first."),
                (BlockRole::Tool, "Read math.js"),
                (BlockRole::Tool, "Grep add\\("),
                (BlockRole::Tool, "Edit math.js"),
                (BlockRole::Tool, "npm test"),
                (BlockRole::Assistant, "Fixed: `add` subtracted."),
                (BlockRole::User, "Now look it up in the docs"),
                (BlockRole::Tool, "context7 · resolve library id"),
                (BlockRole::System, "Interrupted"),
            ]
        );
    }

    #[test]
    fn calls_settle_with_their_turn() {
        let blocks = fixture();
        let status = |text: &str| blocks.iter().find(|b| b.text == text).and_then(|b| b.tool.clone()).map(|t| t.status);
        assert_eq!(status("npm test"), Some(ToolStatus::Completed));
        assert_eq!(status("context7 · resolve library id"), Some(ToolStatus::Interrupted));
    }

    #[test]
    fn a_new_prompt_settles_a_turn_the_cli_never_closed() {
        let blocks = decode(concat!(
            r#"{"role":"user","message":{"content":[{"type":"text","text":"<user_query>\nList the files\n</user_query>"}]}}"#,
            "\n",
            r#"{"role":"assistant","message":{"content":[{"type":"tool_use","name":"Shell","input":{"command":"ls"}}]}}"#,
            "\n",
            r#"{"role":"user","message":{"content":[{"type":"text","text":"<user_query>\nThanks\n</user_query>"}]}}"#,
            "\n",
        ));
        assert_eq!(blocks[1].tool.as_ref().map(|tool| tool.status.clone()), Some(ToolStatus::Completed));
    }

    #[test]
    fn an_edit_carries_the_replacement() {
        let blocks = fixture();
        let edit = blocks.iter().find(|b| b.text == "Edit math.js").and_then(|b| b.tool.clone()).and_then(|t| t.detail);
        let Some(ToolDetail::Edit { path, hunks: Some(hunks), .. }) = edit else { panic!("edit detail: {edit:?}") };
        assert_eq!(path, "/repo/src/math.js");
        assert_eq!(hunks[0].before, "  return a - b;");
        assert_eq!(hunks[0].after, "  return a + b;");
    }

    #[test]
    fn what_the_cli_tells_the_model_is_not_shown() {
        let blocks = decode(concat!(
            r#"{"role":"user","message":{"content":[{"type":"text","text":"<mcp_meta_tools>\nYou have access to MCP tools.\n</mcp_meta_tools>"}]}}"#,
            "\n",
            r#"{"role":"user","message":{"content":[{"type":"text","text":"[Image]\n<image_files>\n1. /tmp/a.png\n</image_files>\n<timestamp>Monday, Aug 24, 2026, 1:05 PM (UTC-4)</timestamp>\n<user_query>\nWhat is this?\n</user_query>"}]}}"#,
            "\n",
        ));
        assert_eq!(blocks.len(), 1);
        assert_eq!(blocks[0].text, "What is this?");
    }

    #[test]
    fn a_turn_is_dated_by_its_prompt() {
        let blocks = fixture();
        // Monday, Aug 24, 2026, 1:05 PM at UTC-4 is 17:05 UTC.
        let prompt = Some(1_787_591_100_000);
        assert_eq!(blocks[0].at, prompt);
        assert!(blocks[..7].iter().all(|block| block.at == prompt));
    }

    #[test]
    fn timestamps_parse_with_and_without_an_offset() {
        assert_eq!(parse_timestamp("Monday, Aug 24, 2026, 1:05 PM (UTC-4)"), Some(1_787_591_100_000));
        assert_eq!(parse_timestamp("Monday, Aug 24, 2026, 5:05 PM (UTC)"), Some(1_787_591_100_000));
        assert_eq!(parse_timestamp("Monday, Aug 24, 2026, 10:35 PM (UTC+5:30)"), Some(1_787_591_100_000));
        assert_eq!(parse_timestamp("Monday, Aug 24, 2026, 12:05 AM (UTC)"), Some(1_787_529_900_000));
        assert_eq!(parse_timestamp("yesterday"), None);
    }
}
