//! grok's session log, `$GROK_HOME/sessions/<cwd>/<id>/updates.jsonl`
//! (`~/.grok/sessions` when `GROK_HOME` is unset).
//!
//! The session id is unique, so the cwd folder — percent-encoded, or a slug
//! plus a hash when that name is too long — is found by walking the groups.
//! Each line is an ACP `session/update` (or grok's `_x.ai/session/update`)
//! carrying one `sessionUpdate`. That is the log grok restores a session
//! from, and the same updates an ACP provider shows live.
//!
//! A replay of this file includes `user_message_chunk` rows. Those are the
//! user turns, read once from this file. `chat_history.jsonl` is not read, so
//! the same prompt is not shown again from the model's copy. Thoughts here
//! are plain text; a thought with no text is skipped. Bootstrap rows
//! (`<user_info>`, `<git_status>`, and any text that starts with `<` other
//! than a `<user_query>` wrapper) are not the user's prompt. A background
//! wake (`task-completed-*`) is not a user turn. An MCP call is a `use_tool`
//! whose native name is `_meta["x.ai/tool"].name`; the real tool is
//! `rawInput.tool_name` (`server__tool`).
//!
//! A subagent's turns live in their own session directory under `subagents/`.
//! This reader stays on the parent log.

use std::collections::{HashMap, HashSet};

use crew_protocol::{HarnessEvent, ToolDetail, TurnUsage};
use serde_json::{Map, Value};

use super::{Decoded, Decoder};
use crate::providers::grok::{content_text, tool_detail, tool_end, tool_label, tool_name, tool_ready, AcpTool};
use crate::providers::{as_record, string_field, todo_items};

/// `costUsdTicks` is 10^10 ticks per USD.
const TICKS_PER_USD: f64 = 10_000_000_000.0;

#[derive(Default)]
pub struct GrokDecoder {
    tools: HashMap<String, AcpTool>,
    started: HashSet<String>,
    /// A prompt was read and its turn not closed yet. The next prompt closes
    /// it when the log has no `turn_completed` between them.
    open: bool,
    plan: Option<String>,
    plans: u64,
}

impl Decoder for GrokDecoder {
    fn decode(&mut self, line: &str) -> Vec<Decoded> {
        let Ok(rec) = serde_json::from_str::<Map<String, Value>>(line) else {
            return Vec::new();
        };
        let at_ms = rec.get("timestamp").and_then(Value::as_i64).map(stamp_ms);
        let Some(params) = rec.get("params").and_then(as_record) else { return Vec::new() };
        let Some(update) = params.get("update").and_then(as_record) else { return Vec::new() };
        // A finished background command is its own turn, tagged
        // `task-completed-*`. That wake is not something the user sent.
        if is_task_wake(&rec, params, update) {
            return Vec::new();
        }
        let mut out = Vec::new();
        match string_field(Some(update), "sessionUpdate").as_deref() {
            Some("user_message_chunk") => self.user(update, at_ms, &mut out),
            Some("agent_message_chunk") => self.words(update, at_ms, false, &mut out),
            Some("agent_thought_chunk") => self.words(update, at_ms, true, &mut out),
            Some("tool_call") => self.tool("tool_call", update, at_ms, &mut out),
            Some("tool_call_update") => self.tool("tool_call_update", update, at_ms, &mut out),
            Some("plan") => self.plan(update, at_ms, &mut out),
            Some("turn_completed") => self.turn_completed(update, at_ms, &mut out),
            // Hooks, commands, and usage meters are the CLI's business.
            _ => {}
        }
        out
    }

    fn is_message(&self, line: &[u8]) -> bool {
        has_session_update(line, b"user_message_chunk")
            || has_session_update(line, b"agent_message_chunk")
            || has_session_update(line, b"agent_thought_chunk")
            || has_session_update(line, b"tool_call")
    }
}

impl GrokDecoder {
    fn user(&mut self, update: &Map<String, Value>, at_ms: Option<i64>, out: &mut Vec<Decoded>) {
        let Some(text) = user_prompt(update) else { return };
        if self.open {
            self.stopped();
            out.push(event(at_ms, HarnessEvent::TurnCompleted { usage: Some(bare_usage()) }));
            out.push(Decoded::TurnEnded { at_ms });
        }
        self.open = true;
        out.push(event(
            at_ms,
            HarnessEvent::UserMessage { text, hidden: None, files: None, from_bot: None, letter_id: None, letter_kind: None },
        ));
    }

    fn words(&mut self, update: &Map<String, Value>, at_ms: Option<i64>, thought: bool, out: &mut Vec<Decoded>) {
        // Same cut as the live driver. A message keeps a chunk that is only a
        // space or a blank line; a thought that is only whitespace is not words.
        let Some(text) = chunk_text(update).filter(|text| !thought || !text.trim().is_empty()) else { return };
        let said = if thought { HarnessEvent::ReasoningDelta { text } } else { HarnessEvent::MessageDelta { text } };
        out.push(event(at_ms, said));
    }

    /// One call, opened by `tool_call` and filled in by `tool_call_update`.
    /// The same helpers the live driver uses name the row.
    fn tool(&mut self, kind: &str, update: &Map<String, Value>, at_ms: Option<i64>, out: &mut Vec<Decoded>) {
        let Some(id) = string_field(Some(update), "toolCallId") else { return };
        let stored = self.tools.entry(id.clone()).or_insert_with(|| AcpTool::new(&id));
        let renamed = update.contains_key("title") || update.contains_key("rawInput");
        stored.merge(update);
        let tool = stored.clone();
        let status = string_field(Some(update), "status").unwrap_or_default();
        let output = update.get("rawOutput").and_then(as_record);
        let detail = tool_detail(&tool, update);
        if !self.started.contains(&id) {
            if !tool_ready(&tool, &status) {
                return;
            }
            self.started.insert(id.clone());
            out.push(event(
                at_ms,
                HarnessEvent::ToolStarted {
                    call_id: id.clone(),
                    name: tool_name(&tool),
                    title: tool_label(&tool),
                    detail: detail.clone(),
                },
            ));
        } else if renamed && kind == "tool_call_update" {
            out.push(event(
                at_ms,
                HarnessEvent::ToolUpdated {
                    call_id: id.clone(),
                    title: Some(tool_label(&tool)),
                    status: None,
                    detail: detail.clone(),
                },
            ));
        }
        if let Some(end) = tool_end(&status, output) {
            out.push(event(at_ms, HarnessEvent::ToolUpdated { call_id: id, title: None, status: Some(end), detail }));
        }
    }

    fn plan(&mut self, update: &Map<String, Value>, at_ms: Option<i64>, out: &mut Vec<Decoded>) {
        let Some(items) = todo_items(update.get("entries")) else { return };
        let detail = Some(ToolDetail::Todo { items });
        match self.plan.clone() {
            Some(call_id) => out.push(event(at_ms, HarnessEvent::ToolUpdated { call_id, title: None, status: None, detail })),
            None => {
                self.plans += 1;
                let call_id = format!("grok-plan-{}", self.plans);
                self.plan = Some(call_id.clone());
                out.push(event(at_ms, HarnessEvent::ToolStarted { call_id, name: "todo".into(), title: "Todos".into(), detail }));
            }
        }
    }

    fn turn_completed(&mut self, update: &Map<String, Value>, at_ms: Option<i64>, out: &mut Vec<Decoded>) {
        self.stopped();
        let stop = string_field(Some(update), "stop_reason").unwrap_or_default();
        let done = match stop.as_str() {
            "cancelled" | "canceled" | "aborted" | "interrupted" => HarnessEvent::SessionError { message: "Interrupted".into() },
            "error" | "failed" | "refusal" => HarnessEvent::SessionError { message: "Turn failed".into() },
            _ => HarnessEvent::TurnCompleted { usage: Some(usage_of(update)) },
        };
        out.push(event(at_ms, done));
        out.push(Decoded::TurnEnded { at_ms });
    }

    fn stopped(&mut self) {
        self.open = false;
        self.plan = None;
    }
}

fn event(at_ms: Option<i64>, event: HarnessEvent) -> Decoded {
    Decoded::Event { event, at_ms }
}

/// Unix seconds, as grok stamps a line. A value already in milliseconds (a
/// clock past 2286, or a file written that way) is left alone.
fn stamp_ms(stamp: i64) -> i64 {
    if stamp.abs() < 10_000_000_000 {
        stamp.saturating_mul(1_000)
    } else {
        stamp
    }
}

fn bare_usage() -> TurnUsage {
    TurnUsage { input_tokens: None, output_tokens: None, cost_usd: None, duration_ms: None }
}

fn usage_of(update: &Map<String, Value>) -> TurnUsage {
    let usage = update.get("usage").and_then(as_record);
    let number = |key: &str| usage.and_then(|row| row.get(key)).and_then(Value::as_u64);
    TurnUsage {
        input_tokens: number("inputTokens"),
        output_tokens: number("outputTokens"),
        cost_usd: number("costUsdTicks").map(|ticks| ticks as f64 / TICKS_PER_USD),
        duration_ms: update.get("elapsed_ms").and_then(Value::as_u64),
    }
}

/// A submitted prompt. `<user_query>` is the wrapper around it. Anything else
/// that starts with `<` (`<user_info>`, `<git_status>`, a reminder) was injected.
fn user_prompt(update: &Map<String, Value>) -> Option<String> {
    let text = chunk_text(update)?;
    let trimmed = text.trim();
    if trimmed.is_empty() {
        return None;
    }
    if let Some(body) = user_query_body(trimmed) {
        let body = body.trim();
        return (!body.is_empty()).then(|| body.to_string());
    }
    if trimmed.starts_with('<') {
        return None;
    }
    Some(trimmed.to_string())
}

fn user_query_body(text: &str) -> Option<&str> {
    const OPEN: &str = "<user_query>";
    const CLOSE: &str = "</user_query>";
    if !starts_with_ignore_ascii(text, OPEN) {
        return None;
    }
    let body = &text[OPEN.len()..];
    match find_ignore_ascii(body, CLOSE) {
        Some(end) => Some(&body[..end]),
        None => Some(body),
    }
}

fn starts_with_ignore_ascii(text: &str, prefix: &str) -> bool {
    text.len() >= prefix.len() && text.as_bytes()[..prefix.len()].eq_ignore_ascii_case(prefix.as_bytes())
}

fn find_ignore_ascii(haystack: &str, needle: &str) -> Option<usize> {
    haystack.as_bytes().windows(needle.len()).position(|window| window.eq_ignore_ascii_case(needle.as_bytes()))
}

/// `task-completed-*` is grok's prompt id for a background wake, on the
/// update or on `_meta` beside it.
fn is_task_wake(rec: &Map<String, Value>, params: &Map<String, Value>, update: &Map<String, Value>) -> bool {
    let id = |map: &Map<String, Value>| string_field(Some(map), "promptId").or_else(|| string_field(Some(map), "prompt_id"));
    let meta = |map: &Map<String, Value>| map.get("_meta").and_then(as_record).and_then(id);
    meta(rec)
        .or_else(|| meta(params))
        .or_else(|| id(update))
        .or_else(|| meta(update))
        .is_some_and(|prompt| prompt.starts_with("task-completed-"))
}

/// Whether this line is a prompt the user submitted. Hook rows, bootstrap
/// context, and background wakes are not.
pub(crate) fn line_has_user_prompt(line: &str) -> bool {
    let Ok(rec) = serde_json::from_str::<Map<String, Value>>(line) else { return false };
    let Some(params) = rec.get("params").and_then(as_record) else { return false };
    let Some(update) = params.get("update").and_then(as_record) else { return false };
    if string_field(Some(update), "sessionUpdate").as_deref() != Some("user_message_chunk") {
        return false;
    }
    !is_task_wake(&rec, params, update) && user_prompt(update).is_some()
}

fn chunk_text(update: &Map<String, Value>) -> Option<String> {
    let text = content_text(update.get("content"))?;
    (!text.is_empty()).then_some(text)
}

/// `"sessionUpdate":"<kind>"`. The closing quote keeps `tool_call` from
/// matching `tool_call_update`.
fn has_session_update(line: &[u8], kind: &[u8]) -> bool {
    const PREFIX: &[u8] = br#""sessionUpdate":""#;
    let width = PREFIX.len() + kind.len() + 1;
    line.windows(width).any(|window| {
        let kind_at = PREFIX.len() + kind.len();
        window.starts_with(PREFIX) && &window[PREFIX.len()..kind_at] == kind && window[kind_at] == b'"'
    })
}

#[cfg(test)]
mod tests {
    use crew_protocol::{Block, BlockRole, TodoStatus, ToolDetail, ToolStatus};

    use super::super::History;
    use super::*;

    fn decode(body: &str) -> Vec<Block> {
        let dir = std::env::temp_dir().join(format!("crew-grok-history-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).expect("temp dir");
        let path = dir.join("updates.jsonl");
        std::fs::write(&path, body).expect("write");
        let history = History::open(&path, GrokDecoder::default(), 300).expect("open");
        let _ = std::fs::remove_dir_all(&dir);
        history.blocks().to_vec()
    }

    fn fixture() -> Vec<Block> {
        decode(include_str!("../../tests/fixtures/grok/history-updates.jsonl"))
    }

    fn tool(blocks: &[Block], text: &str) -> crew_protocol::BlockTool {
        blocks.iter().find(|block| block.text == text).and_then(|block| block.tool.clone()).expect(text)
    }

    #[test]
    fn a_turn_reads_as_the_prompt_the_reply_the_thoughts_and_the_calls() {
        let blocks = fixture();
        let rows: Vec<(BlockRole, &str)> = blocks.iter().map(|block| (block.role.clone(), block.text.as_str())).collect();
        assert_eq!(
            rows,
            vec![
                (BlockRole::User, "Read hello.txt, then echo hi"),
                (BlockRole::Reasoning, "I'll read the file first."),
                (BlockRole::Assistant, "I'll read the file."),
                (BlockRole::Tool, "Read hello.txt"),
                (BlockRole::Tool, "echo hi-from-tool"),
                (BlockRole::Reasoning, "Now the MCP tool."),
                (BlockRole::Tool, "demo · echo"),
                (BlockRole::Assistant, "done one"),
                (BlockRole::User, "And the second turn"),
                (BlockRole::Assistant, "done two"),
            ]
        );
        assert!(blocks.iter().all(|block| block.streaming != Some(true)));
    }

    #[test]
    fn calls_carry_what_they_did_and_settle_with_the_turn() {
        let blocks = fixture();
        let read = tool(&blocks, "Read hello.txt");
        assert_eq!(read.name, "read");
        assert_eq!(read.status, ToolStatus::Completed);
        let Some(ToolDetail::File { path, preview, .. }) = read.detail else { panic!("read: {:?}", read.detail) };
        assert_eq!(path, "hello.txt");
        assert_eq!(preview.as_deref(), Some("alpha\n"));

        let ran = tool(&blocks, "echo hi-from-tool");
        assert_eq!(ran.name, "bash");
        assert_eq!(ran.status, ToolStatus::Completed);
        let Some(ToolDetail::Command { command, exit_code, output }) = ran.detail else { panic!("command: {:?}", ran.detail) };
        assert_eq!(command, "echo hi-from-tool");
        assert_eq!(exit_code, Some(0));
        assert_eq!(output.as_deref(), Some("hi-from-tool\n"));

        let mcp = tool(&blocks, "demo · echo");
        assert_eq!(mcp.name, "mcp__demo__echo");
        assert_eq!(mcp.status, ToolStatus::Failed);
        let Some(ToolDetail::Mcp { server, tool, input, output }) = mcp.detail else { panic!("mcp: {:?}", mcp.detail) };
        assert_eq!((server.as_str(), tool.as_str()), ("demo", "echo"));
        assert_eq!(output.as_deref(), Some("Tool not found: demo__echo"));
        assert!(input.as_deref().unwrap().contains("\"text\": \"ping\""));
    }

    #[test]
    fn a_turn_is_dated_by_its_records_and_the_footer_carries_the_cost() {
        let blocks = fixture();
        assert_eq!(blocks[0].at, Some(1_792_592_739_000));
        assert_eq!(blocks[1].at, Some(1_792_592_744_000));
        assert_eq!(blocks[3].at, Some(1_792_592_745_000));
        let done = blocks.iter().find(|block| block.text == "done one").unwrap();
        let usage = done.usage.clone().expect("usage");
        assert_eq!(usage.input_tokens, Some(100));
        assert_eq!(usage.output_tokens, Some(20));
        assert_eq!(usage.cost_usd, Some(0.25));
        assert_eq!(usage.duration_ms, Some(22_000));
        let second = blocks.iter().find(|block| block.text == "done two").unwrap();
        assert_eq!(second.usage.as_ref().and_then(|usage| usage.cost_usd), Some(0.1));
    }

    #[test]
    fn a_cancelled_turn_interrupts_the_call_it_left_running() {
        let blocks = decode(concat!(
            r#"{"timestamp":1700000000,"method":"session/update","params":{"update":{"sessionUpdate":"user_message_chunk","content":{"type":"text","text":"Run it"}}}}"#,
            "\n",
            r#"{"timestamp":1700000001,"method":"session/update","params":{"update":{"sessionUpdate":"tool_call","toolCallId":"c1","title":"run_terminal_command","rawInput":{"command":"sleep 5"},"_meta":{"x.ai/tool":{"kind":"execute"}}}}}"#,
            "\n",
            r#"{"timestamp":1700000002,"method":"_x.ai/session/update","params":{"update":{"sessionUpdate":"turn_completed","stop_reason":"cancelled"}}}"#,
            "\n",
        ));
        assert_eq!(blocks[1].tool.as_ref().map(|tool| tool.status.clone()), Some(ToolStatus::Interrupted));
        assert_eq!(blocks[2].role, BlockRole::System);
        assert_eq!(blocks[2].text, "Interrupted");
    }

    #[test]
    fn a_plan_is_a_todo_row() {
        let blocks = decode(concat!(
            r#"{"timestamp":1700000000,"method":"session/update","params":{"update":{"sessionUpdate":"plan","entries":[{"content":"Add hello.txt","status":"pending"}]}}}"#,
            "\n",
            r#"{"timestamp":1700000001,"method":"session/update","params":{"update":{"sessionUpdate":"plan","entries":[{"content":"Add hello.txt","status":"completed"}]}}}"#,
            "\n",
        ));
        assert_eq!(blocks.len(), 1);
        assert_eq!(blocks[0].text, "Todos");
        let Some(ToolDetail::Todo { items }) = blocks[0].tool.clone().and_then(|tool| tool.detail) else {
            panic!("{:?}", blocks[0].tool);
        };
        assert_eq!(items[0].text, "Add hello.txt");
        assert_eq!(items[0].status, TodoStatus::Completed);
    }

    #[test]
    fn the_next_prompt_closes_a_turn_the_log_left_open() {
        let blocks = decode(concat!(
            r#"{"timestamp":1700000000,"method":"session/update","params":{"update":{"sessionUpdate":"user_message_chunk","content":{"type":"text","text":"First"}}}}"#,
            "\n",
            r#"{"timestamp":1700000001,"method":"session/update","params":{"update":{"sessionUpdate":"agent_message_chunk","content":{"type":"text","text":"one"}}}}"#,
            "\n",
            r#"{"timestamp":1700000002,"method":"session/update","params":{"update":{"sessionUpdate":"user_message_chunk","content":{"type":"text","text":"Second"}}}}"#,
            "\n",
        ));
        assert!(blocks.iter().all(|block| block.streaming != Some(true)));
        assert!(blocks[1].usage.is_some(), "the open turn still ends");
        let rows: Vec<&str> = blocks.iter().map(|block| block.text.as_str()).collect();
        assert_eq!(rows, ["First", "one", "Second"]);
    }

    #[test]
    fn hooks_are_not_a_conversation_and_an_empty_prompt_is_not_a_block() {
        let quiet = decode(
            "{\"timestamp\":1,\"method\":\"_x.ai/session/update\",\"params\":{\"update\":{\"sessionUpdate\":\"hook_execution\"}}}\n",
        );
        assert!(quiet.is_empty());
        let dir = std::env::temp_dir().join(format!("crew-grok-empty-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("updates.jsonl");
        std::fs::write(
            &path,
            "{\"timestamp\":1,\"method\":\"session/update\",\"params\":{\"update\":{\"sessionUpdate\":\"user_message_chunk\",\"content\":{\"type\":\"text\",\"text\":\"  \"}}}}\n",
        )
        .unwrap();
        let history = History::open(&path, GrokDecoder::default(), 300).unwrap();
        assert!(history.is_empty_decode());
        let _ = std::fs::remove_dir_all(&dir);

        let decoder = GrokDecoder::default();
        assert!(decoder.is_message(br#"{"params":{"update":{"sessionUpdate":"tool_call","toolCallId":"c"}}}"#));
        assert!(!decoder.is_message(br#"{"params":{"update":{"sessionUpdate":"tool_call_update","toolCallId":"c"}}}"#));
        assert!(!decoder.is_message(br#"{"params":{"update":{"sessionUpdate":"hook_execution"}}}"#));
    }

    #[test]
    fn the_tail_starts_on_a_message_and_earlier_calls_stay_settled() {
        let dir = std::env::temp_dir().join(format!("crew-grok-tail-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("updates.jsonl");
        std::fs::write(&path, include_str!("../../tests/fixtures/grok/history-updates.jsonl")).unwrap();
        let mut history = History::open(&path, GrokDecoder::default(), 2).unwrap();
        assert_eq!(history.blocks().first().map(|block| block.text.as_str()), Some("And the second turn"));
        history.load_earlier(300).unwrap();
        let read = tool(history.blocks(), "Read hello.txt");
        assert_eq!(read.status, ToolStatus::Completed);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn timestamps_in_seconds_become_milliseconds() {
        assert_eq!(stamp_ms(1_792_592_739), 1_792_592_739_000);
        assert_eq!(stamp_ms(1_792_592_739_000), 1_792_592_739_000);
    }

    #[test]
    fn bootstrap_rows_and_a_background_wake_are_not_the_user() {
        let blocks = decode(concat!(
            r#"{"timestamp":1700000000,"method":"session/update","params":{"update":{"sessionUpdate":"user_message_chunk","content":{"type":"text","text":"<user_info>home</user_info>"}}}}"#,
            "\n",
            r#"{"timestamp":1700000001,"method":"session/update","params":{"update":{"sessionUpdate":"user_message_chunk","content":{"type":"text","text":"<git_status>clean</git_status>"}}}}"#,
            "\n",
            r#"{"timestamp":1700000002,"method":"session/update","params":{"update":{"sessionUpdate":"user_message_chunk","content":{"type":"text","text":"<user_query>Read hello</user_query>"}}}}"#,
            "\n",
            r#"{"timestamp":1700000003,"method":"session/update","params":{"update":{"sessionUpdate":"agent_thought_chunk","content":{"type":"text","text":"  "}}}}"#,
            "\n",
            r#"{"timestamp":1700000004,"method":"session/update","params":{"update":{"sessionUpdate":"agent_message_chunk","content":{"type":"text","text":"ok"}}}}"#,
            "\n",
            r#"{"timestamp":1700000004,"method":"_x.ai/session/update","params":{"update":{"sessionUpdate":"turn_completed","prompt_id":"prompt-1","stop_reason":"end_turn"}}}"#,
            "\n",
            r#"{"timestamp":1700000005,"method":"session/update","params":{"_meta":{"promptId":"task-completed-abc"},"update":{"sessionUpdate":"user_message_chunk","content":{"type":"text","text":"<system-reminder>done</system-reminder>"}}}}"#,
            "\n",
            r#"{"timestamp":1700000006,"method":"session/update","params":{"_meta":{"promptId":"task-completed-abc"},"update":{"sessionUpdate":"agent_thought_chunk","content":{"type":"text","text":"The background task completed."}}}}"#,
            "\n",
            r#"{"timestamp":1700000007,"method":"_x.ai/session/update","params":{"_meta":{"promptId":"task-completed-abc"},"update":{"sessionUpdate":"turn_completed","prompt_id":"task-completed-abc","stop_reason":"end_turn"}}}"#,
            "\n",
        ));
        let rows: Vec<&str> = blocks.iter().map(|block| block.text.as_str()).collect();
        assert_eq!(rows, ["Read hello", "ok"]);
        assert!(blocks.iter().all(|block| block.streaming != Some(true)));
    }

    #[test]
    fn a_blank_chunk_stays_in_the_reply_and_a_blank_thought_does_not() {
        let blocks = decode(concat!(
            r#"{"timestamp":1700000000,"method":"session/update","params":{"update":{"sessionUpdate":"user_message_chunk","content":{"type":"text","text":"Read hello"}}}}"#,
            "\n",
            r#"{"timestamp":1700000001,"method":"session/update","params":{"update":{"sessionUpdate":"agent_message_chunk","content":{"type":"text","text":"La puerta"}}}}"#,
            "\n",
            r#"{"timestamp":1700000002,"method":"session/update","params":{"update":{"sessionUpdate":"agent_message_chunk","content":{"type":"text","text":"\n\n"}}}}"#,
            "\n",
            r#"{"timestamp":1700000003,"method":"session/update","params":{"update":{"sessionUpdate":"agent_message_chunk","content":{"type":"text","text":"a las"}}}}"#,
            "\n",
            r#"{"timestamp":1700000004,"method":"session/update","params":{"update":{"sessionUpdate":"agent_message_chunk","content":{"type":"text","text":" "}}}}"#,
            "\n",
            r#"{"timestamp":1700000005,"method":"session/update","params":{"update":{"sessionUpdate":"agent_message_chunk","content":{"type":"text","text":"9"}}}}"#,
            "\n",
            r#"{"timestamp":1700000006,"method":"session/update","params":{"update":{"sessionUpdate":"agent_thought_chunk","content":{"type":"text","text":"  "}}}}"#,
            "\n",
        ));
        let rows: Vec<&str> = blocks.iter().map(|block| block.text.as_str()).collect();
        assert_eq!(rows, ["Read hello", "La puerta\n\na las 9"]);
    }

    #[test]
    fn a_shell_named_in_meta_is_not_unwrapped_as_mcp() {
        let blocks = decode(concat!(
            r#"{"timestamp":1700000000,"method":"session/update","params":{"update":{"sessionUpdate":"tool_call","toolCallId":"c1","title":"run_terminal_command","rawInput":{"command":"echo hi","tool_name":"demo__echo"},"_meta":{"x.ai/tool":{"name":"run_terminal_command","kind":"execute"}}}}}"#,
            "\n",
            r#"{"timestamp":1700000001,"method":"session/update","params":{"update":{"sessionUpdate":"tool_call_update","toolCallId":"c1","status":"completed","rawOutput":{"exit_code":0,"output_for_prompt":"exit: 0\nhi\n"}}}}"#,
            "\n",
        ));
        let ran = tool(&blocks, "echo hi");
        assert_eq!(ran.name, "bash");
    }
}
