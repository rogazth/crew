//! Codex CLI's session log, `~/.codex/sessions/YYYY/MM/DD/rollout-<time>-<id>.jsonl`.
//!
//! Each line is `{timestamp, type, payload}`, and two streams run through the
//! file side by side. `response_item`s are what the model was sent and said,
//! Codex's own instructions and context included; `event_msg`s are what its UI
//! was told. Codex rebuilds its transcript from the events, so the words come
//! from there: `item_completed` items in the paginated rollouts 0.154 writes,
//! `user_message` / `agent_message` events in legacy ones (older CLIs, and the
//! sessions they started). A file holds one kind or the other, never both,
//! which is what keeps a turn from showing twice. The model's copy of the same
//! text is left alone: it carries the harness's wrappers and the markup Codex
//! strips before showing a reply.
//!
//! Tool calls are the exception. The events only report a call once it ended
//! (and legacy files keep none), while the `function_call` response item is
//! written when the model makes the call, so the row starts there, ends at its
//! output, and a paginated `item_completed` refines it with the exit code.

use std::collections::HashMap;
use std::path::{Path, PathBuf};

use crew_protocol::{EditHunk, HarnessEvent, Question, QuestionOption, ToolDetail, ToolStatus, TurnUsage};
use serde::Deserialize;
use serde_json::{json, Map, Value};

use super::claude::parse_timestamp;
use super::{Decoded, Decoder};
use crate::providers::codex::{tool_detail, tool_label, tool_name};
use crate::providers::{as_record, leaf, string_field};

/// The tool 0.158's code mode runs scripts with.
const CODE_MODE_TOOL: &str = "exec";

/// How many day folders `rollout_path` looks through before giving up.
const MAX_DAYS: usize = 400;
/// Recent days are looked at before the day an id was made: a reverted
/// thread's live file is dated by the revert, not by the thread.
const RECENT_DAYS: usize = 7;

#[derive(Default)]
pub struct CodexDecoder {
    /// Calls seen, by id: an output names only its call.
    tools: HashMap<String, Call>,
    /// `request_user_input` calls, their card, and each question's id with its text.
    questions: HashMap<String, (u64, Vec<(String, String)>)>,
    next_request: u64,
    /// `exec_command` processes still running, by session id, and the call that started them.
    sessions: HashMap<String, String>,
    /// `write_stdin` calls, by id, and the session they wrote to.
    polls: HashMap<String, String>,
}

struct Call {
    kind: Kind,
    /// The call in the shape `codex exec --json` gives an item, so the agent
    /// chats' helpers title it and read its result the same way.
    item: Map<String, Value>,
    /// A paginated `item_completed` already said how it ended, better than
    /// its output text can.
    settled: bool,
}

#[derive(Clone, Copy, PartialEq)]
enum Kind {
    Command,
    Patch,
    Mcp,
    Plan,
    Other,
}

impl Decoder for CodexDecoder {
    fn decode(&mut self, line: &str) -> Vec<Decoded> {
        let Ok(rec) = serde_json::from_str::<Map<String, Value>>(line) else {
            return Vec::new();
        };
        let at_ms = rec.get("timestamp").and_then(Value::as_str).and_then(parse_timestamp);
        let mut out = Out { at_ms, items: Vec::new() };
        let payload = rec.get("payload").and_then(as_record);
        match (rec.get("type").and_then(Value::as_str), payload) {
            (Some("response_item"), Some(payload)) => self.response_item(payload, &mut out),
            (Some("event_msg"), Some(payload)) => self.event(payload, &mut out),
            // Written by every kind of compaction; the events that also mark
            // one differ between legacy and paginated files.
            (Some("compacted"), _) => out.note("Context compacted".into()),
            _ => {}
        }
        out.items
    }

    /// What the model was told the user and it said, harness context left
    /// out. Counting the model's copy rather than the events is deliberate:
    /// it is written first, so a tail starting on it still has the event, and
    /// a file whose events stop decoding shows up as an error, not as empty.
    fn is_message(&self, line: &[u8]) -> bool {
        if !contains(line, br#""type":"response_item""#) || !contains(line, br#""type":"message""#) {
            return false;
        }
        let Ok(probe) = serde_json::from_slice::<Probe>(line) else {
            return false;
        };
        if probe.kind != "response_item" || probe.payload.kind != "message" {
            return false;
        }
        match probe.payload.role.as_str() {
            "assistant" => true,
            "user" => {
                !probe.payload.content.is_empty()
                    && !probe
                        .payload
                        .content
                        .iter()
                        .any(|part| part.kind == "input_text" && is_injected(&part.text))
            }
            _ => false,
        }
    }
}

#[derive(Deserialize, Default)]
#[serde(default)]
struct Probe {
    #[serde(rename = "type")]
    kind: String,
    payload: ProbePayload,
}

#[derive(Deserialize, Default)]
#[serde(default)]
struct ProbePayload {
    #[serde(rename = "type")]
    kind: String,
    role: String,
    content: Vec<ProbePart>,
}

#[derive(Deserialize, Default)]
#[serde(default)]
struct ProbePart {
    #[serde(rename = "type")]
    kind: String,
    text: String,
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

    fn user(&mut self, text: String) {
        self.event(HarnessEvent::UserMessage {
            text,
            hidden: None,
            files: None,
            from_agent: None,
        });
    }

    fn assistant(&mut self, text: String) {
        if text.trim().is_empty() {
            return;
        }
        // Each reply is a bubble of its own, even two in a row.
        self.event(HarnessEvent::MessageDelta { text });
        self.event(HarnessEvent::MessageCompleted {});
    }

    fn reasoning(&mut self, text: String) {
        if text.trim().is_empty() {
            return;
        }
        self.event(HarnessEvent::ReasoningDelta { text });
        self.event(HarnessEvent::MessageCompleted {});
    }

    fn updated(&mut self, call_id: &str, status: Option<ToolStatus>, detail: Option<ToolDetail>) {
        self.event(HarnessEvent::ToolUpdated {
            call_id: call_id.to_string(),
            title: None,
            status,
            detail,
        });
    }
}

impl CodexDecoder {
    fn response_item(&mut self, payload: &Map<String, Value>, out: &mut Out) {
        let call_id = || string_field(Some(payload), "call_id");
        match payload.get("type").and_then(Value::as_str) {
            Some("function_call") => {
                let (Some(call_id), Some(name)) = (call_id(), string_field(Some(payload), "name")) else {
                    return;
                };
                // The arguments are a JSON document in a string.
                let args = payload
                    .get("arguments")
                    .and_then(Value::as_str)
                    .and_then(|text| serde_json::from_str::<Value>(text).ok())
                    .and_then(|value| value.as_object().cloned())
                    .unwrap_or_default();
                let namespace = string_field(Some(payload), "namespace");
                self.function_call(call_id, &name, namespace.as_deref(), &args, out);
            }
            Some("custom_tool_call") => {
                let (Some(call_id), Some(name)) = (call_id(), string_field(Some(payload), "name")) else {
                    return;
                };
                let input = payload.get("input").and_then(Value::as_str).unwrap_or_default();
                // 0.158's code mode: a script that calls the tools. The calls it
                // made are reported as items of their own, which Codex shows,
                // and one it had retried outside the sandbox is not.
                if name == CODE_MODE_TOOL {
                    return;
                }
                if name == "apply_patch" {
                    self.start(call_id, Kind::Patch, patch_item(input), patch_detail(input), out);
                } else {
                    self.start_other(call_id, name.clone(), name, None, out);
                }
            }
            Some("local_shell_call") => {
                let Some(call_id) = call_id().or_else(|| string_field(Some(payload), "id")) else {
                    return;
                };
                let action = payload.get("action").and_then(as_record);
                let command = argv_line(action.and_then(|action| action.get("command")));
                self.start_command(call_id, command, out);
            }
            Some("function_call_output" | "custom_tool_call_output") => {
                let Some(call_id) = call_id() else { return };
                let text = output_text(payload.get("output")).unwrap_or_default();
                self.output(&call_id, &text, out);
            }
            Some("web_search_call") => self.web_search(payload, out),
            _ => {}
        }
    }

    fn function_call(
        &mut self,
        call_id: String,
        name: &str,
        namespace: Option<&str>,
        args: &Map<String, Value>,
        out: &mut Out,
    ) {
        if let Some(server) = namespace.and_then(|ns| ns.strip_prefix("mcp__")) {
            let server = server.trim_end_matches('_');
            return self.start_mcp(call_id, server, name, args, out);
        }
        if let Some((server, tool)) = name.strip_prefix("mcp__").and_then(|rest| rest.split_once("__")) {
            return self.start_mcp(call_id, server, tool, args, out);
        }
        match name {
            "exec_command" => self.start_command(call_id, string_field(Some(args), "cmd"), out),
            "shell_command" => self.start_command(call_id, string_field(Some(args), "command"), out),
            "shell" | "container.exec" => self.start_command(call_id, argv_line(args.get("command")), out),
            // Polling or typing into a process an earlier call left running:
            // what it reports belongs on that call's row, not a row of its own.
            "write_stdin" => {
                if let Some(session) = args.get("session_id").and_then(id_text) {
                    self.polls.insert(call_id, session);
                }
            }
            "apply_patch" => {
                let input = args.get("input").and_then(Value::as_str).unwrap_or_default();
                self.start(call_id, Kind::Patch, patch_item(input), patch_detail(input), out);
            }
            "update_plan" => {
                let items: Vec<Value> = args
                    .get("plan")
                    .and_then(Value::as_array)
                    .map(|rows| {
                        rows.iter()
                            .filter_map(as_record)
                            .map(|row| json!({ "text": row.get("step"), "status": row.get("status") }))
                            .collect()
                    })
                    .unwrap_or_default();
                let item = json!({ "type": "todo_list", "id": call_id, "items": items });
                let detail = item.as_object().and_then(tool_detail);
                self.start(call_id, Kind::Plan, item, detail, out);
            }
            "view_image" => {
                let path = string_field(Some(args), "path");
                let title = path.as_deref().map_or_else(|| "View image".into(), |path| format!("View {}", leaf(path)));
                let detail = path.map(|path| ToolDetail::File {
                    path,
                    line_start: None,
                    line_end: None,
                    preview: None,
                });
                self.start_other(call_id, name.into(), title, detail, out);
            }
            "request_user_input" => self.question(call_id, args, out),
            _ => self.start_other(call_id, name.into(), name.into(), None, out),
        }
    }

    fn start_command(&mut self, call_id: String, command: Option<String>, out: &mut Out) {
        let item = json!({ "type": "command_execution", "id": call_id, "command": command.unwrap_or_default() });
        let detail = item.as_object().and_then(tool_detail);
        self.start(call_id, Kind::Command, item, detail, out);
    }

    /// A `FileChange` item: `changes` maps each path to `{type, unified_diff}`.
    fn start_file_change(&mut self, call_id: String, item: &Map<String, Value>, out: &mut Out) {
        let files: Vec<(String, String, String)> = item
            .get("changes")
            .and_then(as_record)
            .map(|changes| {
                changes
                    .iter()
                    .map(|(path, change)| {
                        let change = as_record(change);
                        let kind = string_field(change, "type").unwrap_or_else(|| "update".into());
                        let diff = string_field(change, "unified_diff").unwrap_or_default();
                        (path.clone(), kind, diff)
                    })
                    .collect()
            })
            .unwrap_or_default();
        let changes: Vec<Value> = files.iter().map(|(path, kind, _)| json!({ "path": path, "kind": kind })).collect();
        let detail = match files.as_slice() {
            [(path, _, diff)] => {
                let count = |mark: char| {
                    diff.lines()
                        .filter(|line| line.starts_with(mark) && !line.starts_with("+++") && !line.starts_with("---"))
                        .count() as u32
                };
                Some(ToolDetail::Edit { path: path.clone(), added: Some(count('+')), removed: Some(count('-')), hunks: None })
            }
            _ => None,
        };
        self.start(call_id, Kind::Patch, json!({ "type": "file_change", "changes": changes }), detail, out);
    }

    fn start_mcp(&mut self, call_id: String, server: &str, tool: &str, args: &Map<String, Value>, out: &mut Out) {
        let item = json!({
            "type": "mcp_tool_call", "id": call_id, "server": server, "tool": tool, "arguments": args,
        });
        let detail = item.as_object().and_then(tool_detail);
        self.start(call_id, Kind::Mcp, item, detail, out);
    }

    fn start(&mut self, call_id: String, kind: Kind, item: Value, detail: Option<ToolDetail>, out: &mut Out) {
        let Value::Object(item) = item else { return };
        out.event(HarnessEvent::ToolStarted {
            call_id: call_id.clone(),
            name: tool_name(&item),
            title: tool_label(&item),
            detail,
        });
        self.tools.insert(call_id, Call { kind, item, settled: false });
    }

    fn start_other(&mut self, call_id: String, name: String, title: String, detail: Option<ToolDetail>, out: &mut Out) {
        out.event(HarnessEvent::ToolStarted {
            call_id: call_id.clone(),
            name: name.clone(),
            title,
            detail,
        });
        let item = Map::from_iter([("type".to_string(), Value::String(name))]);
        self.tools.insert(call_id, Call { kind: Kind::Other, item, settled: false });
    }

    /// Codex's question tool. It becomes the card straight away: a tool row
    /// as well would be the same call twice.
    fn question(&mut self, call_id: String, args: &Map<String, Value>, out: &mut Out) {
        let rows: Vec<&Map<String, Value>> = args
            .get("questions")
            .and_then(Value::as_array)
            .map(|rows| rows.iter().filter_map(as_record).collect())
            .unwrap_or_default();
        let mut ids = Vec::new();
        let mut questions = Vec::new();
        for row in rows {
            let Some(text) = string_field(Some(row), "question") else { continue };
            let options = row
                .get("options")
                .and_then(Value::as_array)
                .map(|options| {
                    options
                        .iter()
                        .filter_map(as_record)
                        .filter_map(|option| {
                            let label = string_field(Some(option), "label")?;
                            let description = string_field(Some(option), "description").filter(|desc| *desc != label);
                            Some(QuestionOption { label, description })
                        })
                        .collect()
                })
                .unwrap_or_default();
            ids.push((string_field(Some(row), "id").unwrap_or_else(|| text.clone()), text.clone()));
            questions.push(Question {
                header: string_field(Some(row), "header").unwrap_or_else(|| text.clone()),
                question: text,
                multi_select: false,
                options,
            });
        }
        self.next_request += 1;
        self.questions.insert(call_id, (self.next_request, ids));
        out.event(HarnessEvent::QuestionRequested {
            request_id: self.next_request,
            questions,
        });
    }

    fn output(&mut self, call_id: &str, text: &str, out: &mut Out) {
        if let Some((request_id, ids)) = self.questions.remove(call_id) {
            out.event(HarnessEvent::QuestionResolved {
                request_id,
                answers: question_answers(text, &ids),
            });
            return;
        }
        if let Some(session) = self.polls.remove(call_id) {
            return self.poll(&session, text, out);
        }
        let Some(call) = self.tools.get_mut(call_id) else { return };
        if call.settled {
            return;
        }
        let (status, detail) = match call.kind {
            Kind::Command => {
                let ran = Ran::parse(text);
                if let Some(session) = ran.session.clone() {
                    self.sessions.insert(session, call_id.to_string());
                }
                ran.apply(&mut call.item, false);
                (ran.status(), tool_detail(&call.item))
            }
            Kind::Patch => {
                let ran = Ran::parse(text);
                let ok = ran.exit_code.map_or_else(|| text.contains("Success."), |code| code == 0);
                (Some(if ok { ToolStatus::Completed } else { ToolStatus::Failed }), None)
            }
            Kind::Mcp => {
                call.item.insert("result".into(), json!({ "content": [{ "type": "text", "text": text }] }));
                (Some(ToolStatus::Completed), tool_detail(&call.item))
            }
            Kind::Plan => (Some(ToolStatus::Completed), None),
            Kind::Other => {
                let detail = (!text.trim().is_empty()).then(|| ToolDetail::Output { text: text.to_string() });
                (Some(ToolStatus::Completed), detail)
            }
        };
        out.updated(call_id, status, detail);
    }

    /// What `write_stdin` got back from a process an `exec_command` started.
    fn poll(&mut self, session: &str, text: &str, out: &mut Out) {
        let Some(call_id) = self.sessions.get(session).cloned() else { return };
        let ran = Ran::parse(text);
        if ran.session.is_none() {
            self.sessions.remove(session);
        }
        let Some(call) = self.tools.get_mut(&call_id) else { return };
        if call.settled {
            return;
        }
        ran.apply(&mut call.item, true);
        out.updated(&call_id, ran.status(), tool_detail(&call.item));
    }

    fn web_search(&mut self, payload: &Map<String, Value>, out: &mut Out) {
        // The call carries no call id and no output record: it is written
        // once, already finished.
        let Some(id) = string_field(Some(payload), "id") else { return };
        let action = payload.get("action").and_then(as_record);
        let query = string_field(action, "query").or_else(|| {
            action
                .and_then(|action| action.get("queries"))
                .and_then(Value::as_array)
                .and_then(|queries| queries.first())
                .and_then(Value::as_str)
                .map(str::to_string)
        });
        match (string_field(action, "type").as_deref(), string_field(action, "url")) {
            (Some("open_page" | "find_in_page"), Some(url)) => {
                let detail = ToolDetail::Fetch {
                    url: url.clone(),
                    title: None,
                    output: None,
                };
                out.event(HarnessEvent::ToolStarted {
                    call_id: id.clone(),
                    name: "webfetch".into(),
                    title: format!("Open {url}"),
                    detail: Some(detail),
                });
            }
            _ => {
                let item = json!({ "type": "web_search", "id": id, "query": query });
                let Value::Object(item) = item else { return };
                out.event(HarnessEvent::ToolStarted {
                    call_id: id.clone(),
                    name: tool_name(&item),
                    title: tool_label(&item),
                    detail: tool_detail(&item),
                });
            }
        }
        let status = match string_field(Some(payload), "status").as_deref() {
            Some("failed" | "incomplete") => ToolStatus::Failed,
            _ => ToolStatus::Completed,
        };
        out.updated(&id, Some(status), None);
    }

    fn event(&mut self, payload: &Map<String, Value>, out: &mut Out) {
        match payload.get("type").and_then(Value::as_str) {
            Some("item_completed") => {
                if let Some(item) = payload.get("item").and_then(as_record) {
                    self.item_completed(item, out);
                }
            }
            // Legacy files: the same words, as the events a UI was sent.
            Some("user_message") => {
                let text = payload.get("message").and_then(Value::as_str).unwrap_or_default();
                if !text.trim().is_empty() && !is_injected(text) {
                    out.user(text.to_string());
                }
            }
            Some("agent_message") => out.assistant(string_field(Some(payload), "message").unwrap_or_default()),
            Some("agent_reasoning") => out.reasoning(string_field(Some(payload), "text").unwrap_or_default()),
            Some("task_complete" | "turn_complete") => {
                let error = payload.get("error").and_then(as_record);
                if let Some(message) = string_field(error, "message") {
                    out.event(HarnessEvent::SessionError { message });
                } else {
                    let duration_ms = payload.get("duration_ms").and_then(Value::as_u64);
                    out.event(HarnessEvent::TurnCompleted {
                        usage: duration_ms.map(|duration_ms| TurnUsage {
                            input_tokens: None,
                            output_tokens: None,
                            cost_usd: None,
                            duration_ms: Some(duration_ms),
                        }),
                    });
                }
                out.turn_ended();
            }
            Some("turn_aborted") => {
                // An error rather than a note, only so the calls left running
                // settle as interrupted: the block it adds is the same.
                out.event(HarnessEvent::SessionError {
                    message: "Interrupted".into(),
                });
                out.turn_ended();
            }
            // Legacy files keep the dropped turns and only record that they
            // were dropped; the chat cannot take them back out.
            Some("thread_rolled_back") => {
                let turns = payload.get("num_turns").and_then(Value::as_u64).unwrap_or(0);
                let noun = if turns == 1 { "turn" } else { "turns" };
                out.note(format!("Rolled back the last {turns} {noun}"));
            }
            _ => {}
        }
    }

    /// A paginated file's items, the canonical record of what Codex showed.
    fn item_completed(&mut self, item: &Map<String, Value>, out: &mut Out) {
        match item.get("type").and_then(Value::as_str) {
            Some("UserMessage") => {
                let parts: Vec<&Map<String, Value>> = item
                    .get("content")
                    .and_then(Value::as_array)
                    .map(|parts| parts.iter().filter_map(as_record).collect())
                    .unwrap_or_default();
                let text = parts
                    .iter()
                    .filter(|part| part.get("type").and_then(Value::as_str) == Some("text"))
                    .filter_map(|part| part.get("text").and_then(Value::as_str))
                    .collect::<Vec<_>>()
                    .join("\n");
                let images = parts.iter().any(|part| {
                    matches!(part.get("type").and_then(Value::as_str), Some("image" | "local_image"))
                });
                if !text.trim().is_empty() && !is_injected(&text) {
                    out.user(text);
                } else if text.trim().is_empty() && images {
                    out.user("[Image]".into());
                }
            }
            Some("AgentMessage") => {
                let text = item
                    .get("content")
                    .and_then(Value::as_array)
                    .map(|parts| {
                        parts
                            .iter()
                            .filter_map(|part| part.get("text").and_then(Value::as_str))
                            .collect::<String>()
                    })
                    .unwrap_or_default();
                out.assistant(text);
            }
            Some("Reasoning") => {
                let text = item
                    .get("summary_text")
                    .and_then(Value::as_array)
                    .map(|parts| {
                        parts
                            .iter()
                            .filter_map(Value::as_str)
                            .filter(|part| !part.trim().is_empty())
                            .collect::<Vec<_>>()
                            .join("\n\n")
                    })
                    .unwrap_or_default();
                out.reasoning(text);
            }
            Some("CommandExecution") => self.command_completed(item, out),
            Some(kind @ ("FileChange" | "McpToolCall")) => {
                let Some(id) = string_field(Some(item), "id") else { return };
                if !self.tools.contains_key(&id) {
                    // Made from a code-mode script: this item is its only record.
                    if kind == "FileChange" {
                        self.start_file_change(id.clone(), item, out);
                    } else {
                        let server = string_field(Some(item), "server").unwrap_or_default();
                        let tool = string_field(Some(item), "tool").unwrap_or_default();
                        let args = item.get("arguments").and_then(as_record).cloned().unwrap_or_default();
                        self.start_mcp(id.clone(), &server, &tool, &args, out);
                    }
                }
                let Some(call) = self.tools.get_mut(&id) else { return };
                let status = match string_field(Some(item), "status").as_deref() {
                    Some("completed") => ToolStatus::Completed,
                    Some("failed" | "declined") => ToolStatus::Failed,
                    _ => return,
                };
                call.settled = true;
                // The result rides on the item, in the shape `codex exec` gives it too.
                let detail = if kind == "McpToolCall" && call.kind == Kind::Mcp {
                    if let Some(result) = item.get("result").filter(|result| !result.is_null()) {
                        call.item.insert("result".into(), result.clone());
                    }
                    tool_detail(&call.item)
                } else {
                    None
                };
                out.updated(&id, Some(status), detail);
            }
            Some("Plan") => {
                let Some(text) = string_field(Some(item), "text") else { return };
                let id = string_field(Some(item), "id").unwrap_or_else(|| "plan".into());
                out.event(HarnessEvent::ToolStarted {
                    call_id: id.clone(),
                    name: "plan".into(),
                    title: "Plan".into(),
                    detail: Some(ToolDetail::Plan { text }),
                });
                out.updated(&id, Some(ToolStatus::Completed), None);
            }
            _ => {}
        }
    }

    /// A command's end: its exit code and whole output, for a call the model
    /// made, or the only record of one the user ran with `!`.
    fn command_completed(&mut self, item: &Map<String, Value>, out: &mut Out) {
        let Some(id) = string_field(Some(item), "id") else { return };
        // A command the user ran with `!`, or one a code-mode script ran: this
        // item is the only record of it.
        if !self.tools.contains_key(&id) {
            self.start_command(id.clone(), argv_line(item.get("command")), out);
        }
        let Some(call) = self.tools.get_mut(&id) else { return };
        call.settled = true;
        let exit_code = item.get("exit_code").and_then(Value::as_i64);
        if let Some(code) = exit_code {
            call.item.insert("exit_code".into(), code.into());
        }
        if let Some(output) = item.get("aggregated_output").and_then(Value::as_str) {
            call.item.insert("aggregated_output".into(), output.into());
        }
        let status = match string_field(Some(item), "status").as_deref() {
            Some("completed") if exit_code.is_some_and(|code| code != 0) => Some(ToolStatus::Failed),
            Some("completed") => Some(ToolStatus::Completed),
            Some("failed" | "declined") => Some(ToolStatus::Failed),
            _ => None,
        };
        out.updated(&id, status, tool_detail(&call.item));
    }
}

/// What an exec tool's output text says about the command.
#[derive(Default)]
struct Ran {
    exit_code: Option<i64>,
    /// The process is still running under this id, for `write_stdin`.
    session: Option<String>,
    output: Option<String>,
    aborted: bool,
    /// None of the header lines were there: the text is an error from Codex,
    /// not from the command.
    bare: bool,
}

impl Ran {
    /// `exec_command` answers `Chunk ID / Wall time / Process exited with code
    /// N / Original token count / Output:` then the output; the older `shell`
    /// tools `Exit code: N / Wall time / Output:`, or before that a JSON
    /// document with `output` and `metadata.exit_code`.
    fn parse(text: &str) -> Ran {
        if let Ok(Value::Object(doc)) = serde_json::from_str::<Value>(text) {
            if let Some(output) = doc.get("output").and_then(Value::as_str) {
                let metadata = doc.get("metadata").and_then(as_record);
                return Ran {
                    exit_code: metadata.and_then(|meta| meta.get("exit_code")).and_then(Value::as_i64),
                    output: Some(output.to_string()),
                    ..Ran::default()
                };
            }
        }
        let mut ran = Ran::default();
        let mut header = false;
        let mut rest = text;
        while !rest.is_empty() {
            let (line, next) = rest.split_once('\n').unwrap_or((rest, ""));
            if line.trim_end() == "Output:" {
                ran.output = Some(next.to_string());
                header = true;
                break;
            }
            let code = line
                .strip_prefix("Process exited with code ")
                .or_else(|| line.strip_prefix("Exit code: "));
            if let Some(code) = code {
                ran.exit_code = code.trim().parse().ok();
                header = true;
            } else if let Some(id) = line.strip_prefix("Process running with session ID ") {
                ran.session = Some(id.trim().to_string());
                header = true;
            } else if line.starts_with("Wall time") {
                header = true;
            } else if line.contains("aborted by user") {
                ran.aborted = true;
            }
            rest = next;
        }
        ran.bare = !header;
        if ran.bare && !ran.aborted {
            ran.output = Some(text.to_string());
        }
        ran
    }

    fn status(&self) -> Option<ToolStatus> {
        if self.aborted {
            return Some(ToolStatus::Interrupted);
        }
        match self.exit_code {
            Some(0) => Some(ToolStatus::Completed),
            Some(_) => Some(ToolStatus::Failed),
            None if self.session.is_some() => None,
            None if self.bare => Some(ToolStatus::Failed),
            None => Some(ToolStatus::Completed),
        }
    }

    /// Onto the call's item, where `tool_detail` reads it. A poll adds to what
    /// the process printed before rather than replacing it.
    fn apply(&self, item: &mut Map<String, Value>, append: bool) {
        if let Some(code) = self.exit_code {
            item.insert("exit_code".into(), code.into());
        }
        let Some(output) = self.output.as_deref().filter(|output| !output.is_empty()) else {
            return;
        };
        let before = item.get("aggregated_output").and_then(Value::as_str).filter(|_| append);
        let output = before.map_or_else(|| output.to_string(), |before| format!("{before}{output}"));
        item.insert("aggregated_output".into(), output.into());
    }
}

/// A command given as argv: the script of a `bash -lc <script>`, or the
/// words joined back up.
fn argv_line(value: Option<&Value>) -> Option<String> {
    let words: Vec<&str> = value?.as_array()?.iter().filter_map(Value::as_str).collect();
    if let [shell, flag, script] = words.as_slice() {
        let shell = leaf(shell);
        if matches!(shell.as_str(), "bash" | "zsh" | "sh") && matches!(*flag, "-lc" | "-c") {
            return Some(script.to_string());
        }
    }
    let line = words
        .iter()
        .map(|word| {
            if word.is_empty() || word.contains(|c: char| c.is_whitespace() || c == '\'' || c == '"') {
                format!("'{}'", word.replace('\'', "'\\''"))
            } else {
                word.to_string()
            }
        })
        .collect::<Vec<_>>()
        .join(" ");
    (!line.is_empty()).then_some(line)
}

/// A number or a string, as text: `write_stdin` names its session with a number.
fn id_text(value: &Value) -> Option<String> {
    match value {
        Value::String(text) => Some(text.clone()),
        Value::Number(number) => Some(number.to_string()),
        _ => None,
    }
}

/// An output's text: a plain string, or the text of its content items.
fn output_text(value: Option<&Value>) -> Option<String> {
    match value? {
        Value::String(text) => Some(text.clone()),
        Value::Array(parts) => Some(
            parts
                .iter()
                .filter_map(|part| as_record(part)?.get("text")?.as_str())
                .collect::<Vec<_>>()
                .join("\n"),
        ),
        _ => None,
    }
}

/// One file of an `apply_patch` envelope.
struct PatchFile {
    path: String,
    kind: &'static str,
    hunks: Vec<EditHunk>,
    added: u32,
    removed: u32,
}

/// The files an `apply_patch` envelope touches, read from its
/// `*** Add File:` / `*** Update File:` / `*** Delete File:` headers.
fn patch_files(patch: &str) -> Vec<PatchFile> {
    let mut files: Vec<PatchFile> = Vec::new();
    let mut hunk: Option<(Vec<&str>, Vec<&str>)> = None;
    let flush = |files: &mut Vec<PatchFile>, hunk: &mut Option<(Vec<&str>, Vec<&str>)>| {
        if let (Some(file), Some((before, after))) = (files.last_mut(), hunk.take()) {
            if !before.is_empty() || !after.is_empty() {
                file.hunks.push(EditHunk {
                    before: before.join("\n"),
                    after: after.join("\n"),
                });
            }
        }
    };
    for line in patch.lines() {
        let header = [("*** Add File: ", "add"), ("*** Update File: ", "update"), ("*** Delete File: ", "delete")]
            .iter()
            .find_map(|(prefix, kind)| line.strip_prefix(prefix).map(|path| (path.trim(), *kind)));
        if let Some((path, kind)) = header {
            flush(&mut files, &mut hunk);
            files.push(PatchFile {
                path: path.to_string(),
                kind,
                hunks: Vec::new(),
                added: 0,
                removed: 0,
            });
            hunk = Some((Vec::new(), Vec::new()));
            continue;
        }
        if line.starts_with("***") {
            continue;
        }
        if line.starts_with("@@") {
            flush(&mut files, &mut hunk);
            hunk = Some((Vec::new(), Vec::new()));
            continue;
        }
        let (Some(file), Some((before, after))) = (files.last_mut(), hunk.as_mut()) else {
            continue;
        };
        if let Some(text) = line.strip_prefix('+') {
            after.push(text);
            file.added += 1;
        } else if let Some(text) = line.strip_prefix('-') {
            before.push(text);
            file.removed += 1;
        } else {
            let text = line.strip_prefix(' ').unwrap_or(line);
            before.push(text);
            after.push(text);
        }
    }
    flush(&mut files, &mut hunk);
    files
}

fn patch_item(patch: &str) -> Value {
    let changes: Vec<Value> = patch_files(patch)
        .iter()
        .map(|file| json!({ "path": file.path, "kind": file.kind }))
        .collect();
    json!({ "type": "file_change", "changes": changes })
}

/// A one-file patch as the edit it makes. Several files have no single path
/// to name, as in the agent chats; the title counts them.
fn patch_detail(patch: &str) -> Option<ToolDetail> {
    let mut files = patch_files(patch);
    if files.len() != 1 {
        return None;
    }
    let file = files.pop()?;
    let keeps_hunks = file.kind != "delete" && !file.hunks.is_empty();
    Some(ToolDetail::Edit {
        path: file.path,
        added: Some(file.added),
        removed: Some(file.removed),
        hunks: keeps_hunks.then_some(file.hunks),
    })
}

/// `request_user_input` answers `{"answers": {"<question id>": {"answers": [...]}}}`;
/// the chat keys answers by the question's text. Anything else is the call
/// failing or being cancelled, which dismisses the card.
fn question_answers(text: &str, ids: &[(String, String)]) -> Option<HashMap<String, String>> {
    let doc = serde_json::from_str::<Value>(text).ok()?;
    let by_id = doc.get("answers")?.as_object()?;
    let answers: HashMap<String, String> = ids
        .iter()
        .filter_map(|(id, question)| {
            let picked: Vec<&str> = by_id
                .get(id)?
                .get("answers")?
                .as_array()?
                .iter()
                .filter_map(Value::as_str)
                // A typed answer is kept as a note on the pick.
                .map(|answer| answer.strip_prefix("user_note: ").unwrap_or(answer))
                .filter(|answer| !answer.trim().is_empty())
                .collect();
            (!picked.is_empty()).then(|| (question.clone(), picked.join(", ")))
        })
        .collect();
    (!answers.is_empty()).then_some(answers)
}

/// What Codex puts in a user-role message for the model and never shows as
/// the user's: its `CONTEXTUAL_USER_FRAGMENT_MATCHERS`, matched by their
/// opening marker, case aside, as Codex does.
const INJECTED: &[&str] = &[
    "<environment_context>",
    "<user_instructions>",
    "# AGENTS.md instructions",
    "<skill>",
    "<user_shell_command>",
    "<turn_aborted>",
    "<subagent_notification>",
    "<codex_internal_context",
    "<goal_context>",
    "<recommended_plugins>",
    "<external_",
    "<hook_prompt",
    "Warning: apply_patch was requested via ",
    "Warning: The maximum number of unified exec processes",
    "Warning: Your account was flagged",
];

fn is_injected(text: &str) -> bool {
    let trimmed = text.trim_start();
    INJECTED.iter().any(|marker| {
        trimmed
            .get(..marker.len())
            .is_some_and(|head| head.eq_ignore_ascii_case(marker))
    })
}

fn contains(haystack: &[u8], needle: &[u8]) -> bool {
    haystack.windows(needle.len()).any(|window| window == needle)
}

/// The rollout file of a Codex session, or None until Codex has written one.
///
/// Rollouts live at `sessions/YYYY/MM/DD/rollout-<local time>-<id>.jsonl`,
/// under the day the session began. A reverted thread gets a new file,
/// `…-<id>_<rollout id>.jsonl`, dated by the revert, and the newest one is the
/// live one; so recent days are looked at first, then the day a v7 id (all
/// Codex has made since 2025) was made on, then further back, newest first. A
/// cold file Codex compressed to `.jsonl.zst` is answered with its plain path:
/// Codex writes it back there before appending to it.
pub fn rollout_path(codex_home: &Path, session_id: &str) -> Option<PathBuf> {
    if session_id.is_empty() || session_id.contains(['/', '\\']) {
        return None;
    }
    let root = codex_home.join("sessions");
    let days = day_dirs(&root);
    let hinted = id_day(session_id)
        .map(|day| [day + 1, day, day - 1].iter().map(|day| day_path(&root, *day)).collect::<Vec<_>>())
        .unwrap_or_default();
    days.iter()
        .take(RECENT_DAYS)
        .chain(hinted.iter())
        .chain(days.iter().skip(RECENT_DAYS).take(MAX_DAYS))
        .find_map(|dir| rollout_in(dir, session_id))
}

/// The day folders under `sessions`, newest first.
fn day_dirs(root: &Path) -> Vec<PathBuf> {
    let mut days = Vec::new();
    for year in sorted_dirs(root) {
        for month in sorted_dirs(&year) {
            days.extend(sorted_dirs(&month));
        }
    }
    days.reverse();
    days
}

fn sorted_dirs(dir: &Path) -> Vec<PathBuf> {
    let mut dirs: Vec<PathBuf> = std::fs::read_dir(dir)
        .map(|entries| entries.flatten().map(|entry| entry.path()).filter(|path| path.is_dir()).collect())
        .unwrap_or_default();
    dirs.sort();
    dirs
}

fn rollout_in(dir: &Path, session_id: &str) -> Option<PathBuf> {
    let plain_end = format!("-{session_id}.jsonl");
    let reverted = format!("-{session_id}_");
    std::fs::read_dir(dir)
        .ok()?
        .flatten()
        .filter_map(|entry| {
            let name = entry.file_name().into_string().ok()?;
            let plain = name.strip_suffix(".zst").unwrap_or(&name);
            let stem = plain.strip_prefix("rollout-")?.strip_suffix(".jsonl")?;
            let ours = plain.ends_with(&plain_end) || stem.contains(&reverted);
            ours.then(|| plain.to_string())
        })
        // The names start with the time they were made, so the newest sorts last.
        .max()
        .map(|name| dir.join(name))
}

/// Days since the epoch of a UUID v7's timestamp.
fn id_day(id: &str) -> Option<i64> {
    let hex: String = id.chars().filter(|c| *c != '-').collect();
    if hex.len() != 32 || hex.as_bytes()[12] != b'7' {
        return None;
    }
    let ms = i64::from_str_radix(&hex[..12], 16).ok()?;
    Some(ms.div_euclid(86_400_000))
}

fn day_path(root: &Path, days: i64) -> PathBuf {
    let (year, month, day) = civil_from_days(days);
    root.join(format!("{year:04}")).join(format!("{month:02}")).join(format!("{day:02}"))
}

/// The date of a day since 1970-01-01 (Howard Hinnant's `civil_from_days`).
fn civil_from_days(days: i64) -> (i64, i64, i64) {
    let z = days + 719_468;
    let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1_460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let day = doy - (153 * mp + 2) / 5 + 1;
    let month = if mp < 10 { mp + 3 } else { mp - 9 };
    let year = yoe + era * 400 + i64::from(month <= 2);
    (year, month, day)
}

#[cfg(test)]
mod tests {
    use std::io::Write as _;

    use crew_protocol::{Block, BlockRole};

    use super::super::History;
    use super::*;

    fn temp_dir(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("crew-codex-{name}-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).expect("temp dir");
        dir
    }

    fn open(body: &str, messages: usize) -> Vec<Block> {
        let dir = temp_dir("history");
        let path = dir.join("rollout.jsonl");
        std::fs::write(&path, body).expect("write");
        let history = History::open(&path, CodexDecoder::default(), messages).expect("open");
        let _ = std::fs::remove_dir_all(&dir);
        history.blocks().to_vec()
    }

    const REVOKED: &str = include_str!("../../tests/fixtures/codex/codex-revoked.jsonl");
    const TOOLS: &str = include_str!("../../tests/fixtures/codex/codex-tools.jsonl");
    const INTERRUPT: &str = include_str!("../../tests/fixtures/codex/codex-interrupt-compact.jsonl");
    const LEGACY: &str = include_str!("../../tests/fixtures/codex/codex-legacy.jsonl");
    const APPROVAL_0158: &str = include_str!("../../tests/fixtures/codex/codex-0158-approval.jsonl");

    /// Codex 0.158, recorded here: a code-mode script tries the command in
    /// the sandbox, fails, and runs it again once the user allowed it.
    #[test]
    fn code_mode_shows_the_command_codex_showed() {
        use BlockRole::*;
        let blocks = open(APPROVAL_0158, 300);
        assert_eq!(roles(&blocks), [User, Assistant, Tool, Assistant]);
        assert_eq!(blocks[0].text, "Run the shell command: touch made-by-codex.txt");
        let (name, status, _) = tool(&blocks[2]);
        assert_eq!(name, "bash");
        assert_eq!(*status, ToolStatus::Completed);
        assert_eq!(blocks[2].text, "touch made-by-codex.txt");
        assert_eq!(blocks[3].text, "Created `made-by-codex.txt`.");
        clean(&blocks);
    }

    fn roles(blocks: &[Block]) -> Vec<BlockRole> {
        blocks.iter().map(|block| block.role.clone()).collect()
    }

    fn tool(block: &Block) -> (&str, &ToolStatus, Option<&ToolDetail>) {
        let tool = block.tool.as_ref().expect("a tool row");
        (tool.name.as_str(), &tool.status, tool.detail.as_ref())
    }

    /// Nothing Codex wrote for the model alone, and every user turn once.
    fn clean(blocks: &[Block]) {
        let markers = [
            "<environment_context>",
            "AGENTS.md",
            "<turn_aborted>",
            "<user_shell_command>",
            "permissions instructions",
            "<image",
        ];
        for marker in markers {
            assert!(blocks.iter().all(|block| !block.text.contains(marker)), "{marker} leaked");
        }
        let users: Vec<&str> = blocks.iter().filter(|b| b.role == BlockRole::User).map(|b| b.text.as_str()).collect();
        let mut unique = users.clone();
        unique.dedup();
        assert_eq!(users, unique, "a user turn shows twice");
        assert!(blocks.iter().all(|block| !crate::blocks::is_open(block) || block.role == BlockRole::Question));
        assert!(blocks.iter().all(|block| block.at.is_some_and(|at| at > 1_700_000_000_000)));
    }

    /// The real file: its only turn failed because the login was revoked.
    #[test]
    fn a_failed_turn_shows_its_error() {
        let blocks = open(REVOKED, 300);
        assert_eq!(roles(&blocks), [BlockRole::User, BlockRole::System]);
        assert_eq!(blocks[0].text, "Run the shell command: echo hi > codex-made.txt");
        assert!(blocks[1].text.starts_with("Your access token could not be refreshed"), "{}", blocks[1].text);
        clean(&blocks);
    }

    #[test]
    fn commands_a_patch_a_question_and_replies() {
        use BlockRole::*;
        let blocks = open(TOOLS, 300);
        assert_eq!(
            roles(&blocks),
            [
                User, Reasoning, Tool, Tool, Tool, Assistant, // edit and test
                User, Tool, Question, Assistant, // plan mode: MCP, then ask
            ]
        );
        assert_eq!(blocks[0].text, "Make notes.txt say hello planet, then run the tests.");
        assert!(blocks[1].text.starts_with("**Checking the file**"));

        assert_eq!(blocks[2].text, "cat notes.txt");
        let (name, status, detail) = tool(&blocks[2]);
        assert_eq!((name, status), ("bash", &ToolStatus::Completed));
        assert_eq!(
            detail,
            Some(&ToolDetail::Command {
                command: "cat notes.txt".into(),
                exit_code: Some(0),
                output: Some("hello world\n".into()),
            })
        );

        assert_eq!(blocks[3].text, "Edit notes.txt");
        let (name, status, detail) = tool(&blocks[3]);
        assert_eq!((name, status), ("edit", &ToolStatus::Completed));
        let Some(ToolDetail::Edit { path, added, removed, hunks }) = detail else {
            panic!("an edit row: {detail:?}");
        };
        assert_eq!((path.as_str(), *added, *removed), ("notes.txt", Some(1), Some(1)));
        assert_eq!(
            hunks.as_deref(),
            Some(&[EditHunk { before: "hello world".into(), after: "hello planet".into() }][..])
        );

        assert_eq!(blocks[4].text, "npm test");
        let (_, status, detail) = tool(&blocks[4]);
        assert_eq!(status, &ToolStatus::Failed);
        assert!(matches!(
            detail,
            Some(ToolDetail::Command { exit_code: Some(1), output: Some(out), .. }) if out.starts_with("FAIL")
        ));
        assert!(blocks[5].text.starts_with("notes.txt now says hello planet."));
        assert_eq!(blocks[5].usage.as_ref().and_then(|usage| usage.duration_ms), Some(8117));

        // The image is left out; its placeholder in the text stays.
        assert_eq!(blocks[6].text, "[Image #1] What page is this? Ask me before changing anything.");
        assert_eq!(blocks[7].text, "chrome devtools · take snapshot");
        let (_, status, detail) = tool(&blocks[7]);
        assert_eq!(status, &ToolStatus::Completed);
        assert!(matches!(detail, Some(ToolDetail::Mcp { output: Some(out), .. }) if out == "Page: Settings"));

        let question = blocks[8].question.as_ref().expect("a question");
        assert_eq!(blocks[8].text, "Scope");
        assert_eq!(question.questions[0].options.len(), 2);
        assert_eq!(
            question.answers,
            Some(HashMap::from([("Which part should I change?".to_string(), "Footer, and the links".to_string())]))
        );
        assert_eq!(blocks[9].usage.as_ref().and_then(|usage| usage.duration_ms), Some(32710));
        clean(&blocks);
    }

    #[test]
    fn an_interrupt_a_typed_command_and_compact() {
        use BlockRole::*;
        let blocks = open(INTERRUPT, 300);
        assert_eq!(roles(&blocks), [User, Tool, System, Tool, System, User, Assistant]);
        assert_eq!(blocks[1].text, "sleep 30");
        assert_eq!(tool(&blocks[1]).1, &ToolStatus::Interrupted);
        assert_eq!(blocks[2].text, "Interrupted");

        // `!ls` is the user's, and only its end is recorded.
        assert_eq!(blocks[3].text, "ls");
        let (_, status, detail) = tool(&blocks[3]);
        assert_eq!(status, &ToolStatus::Completed);
        assert!(matches!(
            detail,
            Some(ToolDetail::Command { output: Some(out), .. }) if out == "notes.txt\npackage.json\n"
        ));

        assert_eq!(blocks[4].text, "Context compacted");
        assert_eq!(blocks[5].text, "What did I ask you to run? One line.");
        // The encrypted reasoning has no summary: no empty row.
        assert_eq!(blocks[6].text, "`sleep 30`, which you interrupted.");
        clean(&blocks);
    }

    #[test]
    fn a_legacy_file_reads_its_events() {
        use BlockRole::*;
        let blocks = open(LEGACY, 300);
        assert_eq!(roles(&blocks), [User, Reasoning, Tool, Tool, Assistant, System, User, Assistant, System]);
        assert_eq!(blocks[0].text, "list the files, then show missing.txt");
        assert_eq!(blocks[2].text, "ls");
        assert!(matches!(
            tool(&blocks[2]).2,
            Some(ToolDetail::Command { exit_code: Some(0), output: Some(out), .. }) if out == "notes.txt\n"
        ));
        assert_eq!(blocks[3].text, "cat missing.txt");
        assert_eq!(tool(&blocks[3]).1, &ToolStatus::Failed);
        assert_eq!(blocks[5].text, "Rolled back the last 1 turn");
        // Compacted once, though two records say so.
        assert_eq!(blocks[8].text, "Context compacted");
        clean(&blocks);
    }

    /// The tail starts on the model's copy of a message, which comes before
    /// the event that shows it.
    #[test]
    fn opening_on_the_tail_counts_the_models_messages() {
        use BlockRole::*;
        assert_eq!(roles(&open(TOOLS, 1)), [Assistant]);
        assert_eq!(roles(&open(TOOLS, 2)), [User, Tool, Question, Assistant]);
        let decoder = CodexDecoder::default();
        let counted: Vec<&str> = REVOKED.lines().filter(|line| decoder.is_message(line.as_bytes())).collect();
        assert_eq!(counted.len(), 1);
        assert!(counted[0].contains("Run the shell command"));
    }

    #[test]
    fn the_end_of_a_turn_is_reported_as_it_is_appended() {
        let dir = temp_dir("poll");
        let path = dir.join("rollout.jsonl");
        let lines: Vec<&str> = REVOKED.lines().collect();
        let (head, tail) = lines.split_at(lines.len() - 1);
        std::fs::write(&path, head.join("\n") + "\n").expect("write");
        let mut history = History::open(&path, CodexDecoder::default(), 300).expect("open");
        assert_eq!(roles(history.blocks()), [BlockRole::User]);
        let mut file = std::fs::OpenOptions::new().append(true).open(&path).expect("append");
        writeln!(file, "{}", tail[0]).expect("append");
        let change = history.poll().expect("poll").expect("a change");
        assert!(change.turn_ended);
        assert_eq!(roles(&change.blocks), [BlockRole::System]);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_cancelled_question_is_dismissed() {
        let lines = [
            json!({ "timestamp": "2026-09-28T20:00:00Z", "type": "response_item", "payload": {
                "type": "function_call", "name": "request_user_input", "call_id": "q1",
                "arguments": json!({ "questions": [{ "id": "a", "header": "A", "question": "A?",
                    "options": [{ "label": "Yes", "description": "Yes." }] }] }).to_string(),
            } }),
            json!({ "timestamp": "2026-09-28T20:00:01Z", "type": "response_item", "payload": {
                "type": "function_call_output", "call_id": "q1",
                "output": "request_user_input was cancelled before receiving a response",
            } }),
        ];
        let mut decoder = CodexDecoder::default();
        let blocks = lines
            .iter()
            .flat_map(|line| decoder.decode(&line.to_string()))
            .filter_map(|decoded| match decoded {
                Decoded::Event { event, .. } => Some(event),
                Decoded::TurnEnded { .. } => None,
            })
            .fold(Vec::new(), crate::blocks::apply_event);
        assert_eq!(roles(&blocks), [BlockRole::Question]);
        assert_eq!(blocks[0].question.as_ref().and_then(|q| q.dismissed), Some(true));
    }

    #[test]
    fn exec_outputs() {
        let running =
            Ran::parse("Chunk ID: a\nWall time: 1.0 seconds\nProcess running with session ID 7\nOutput:\nhalf");
        assert_eq!((running.session.as_deref(), running.status()), (Some("7"), None));
        let failed = Ran::parse(
            "Warning: truncated output (original token count: 9)\nWall time: 0.1 seconds\n\
             Process exited with code 2\nOutput:\nno\n",
        );
        assert_eq!(
            (failed.exit_code, failed.output.as_deref(), failed.status()),
            (Some(2), Some("no\n"), Some(ToolStatus::Failed))
        );
        assert_eq!(Ran::parse("Wall time: 2.0 seconds\naborted by user").status(), Some(ToolStatus::Interrupted));
        assert_eq!(Ran::parse("exec_command failed: sandbox denied").status(), Some(ToolStatus::Failed));
        assert_eq!(argv_line(Some(&json!(["/bin/zsh", "-lc", "npm test"]))).as_deref(), Some("npm test"));
        assert_eq!(argv_line(Some(&json!(["git", "commit", "-m", "a b"]))).as_deref(), Some("git commit -m 'a b'"));
    }

    #[test]
    fn a_patch_across_files_names_none() {
        let patch = "*** Begin Patch\n*** Add File: a.txt\n+one\n*** Delete File: b.txt\n*** End Patch";
        assert_eq!(patch_detail(patch), None);
        assert_eq!(tool_label(patch_item(patch).as_object().expect("item")), "Write 2 files");
        let added = patch_detail("*** Begin Patch\n*** Add File: a.txt\n+one\n+two\n*** End Patch");
        assert_eq!(
            added,
            Some(ToolDetail::Edit {
                path: "a.txt".into(),
                added: Some(2),
                removed: Some(0),
                hunks: Some(vec![EditHunk { before: String::new(), after: "one\ntwo".into() }]),
            })
        );
    }

    fn touch(root: &Path, day: &str, name: &str) -> PathBuf {
        let dir = root.join("sessions").join(day);
        std::fs::create_dir_all(&dir).expect("day dir");
        let path = dir.join(name);
        std::fs::write(&path, "").expect("touch");
        path
    }

    #[test]
    fn a_rollout_is_found_by_its_id() {
        let root = temp_dir("rollouts");
        let id = "01a0e998-f839-7ee0-8cdd-584f02a8d4bd";
        assert_eq!(civil_from_days(id_day(id).expect("v7")), (2026, 9, 28));
        // Far older than the recent days looked at first: found by its id's day.
        let old = touch(&root, "2026/09/28", &format!("rollout-2026-09-28T16-58-31-{id}.jsonl"));
        for day in 1..=9 {
            touch(&root, &format!("2026/10/{day:02}"), "rollout-2026-10-01T00-00-00-other.jsonl");
        }
        touch(&root, "2026/09/28", "rollout-2026-09-28T17-01-50-01a0e99c-02b7-7b71-8289-0ba5cdf0c628.jsonl");
        assert_eq!(rollout_path(&root, id), Some(old));

        // A revert writes a new file, dated by when it happened; that one is live.
        let revert = "01a1b000-0000-7000-8000-000000000000";
        let reverted = touch(&root, "2026/10/09", &format!("rollout-2026-10-09T08-00-00-{id}_{revert}.jsonl"));
        assert_eq!(rollout_path(&root, id), Some(reverted));

        // Not a v7 id: looked for newest day first. A compressed file answers with its plain name.
        let v4 = "3f2b7c1e-8a4d-4c2b-9e1f-0a6b5d4c3e21";
        touch(&root, "2026/03/02", &format!("rollout-2026-03-02T10-00-00-{v4}.jsonl.zst"));
        assert_eq!(
            rollout_path(&root, v4),
            Some(root.join("sessions/2026/03/02").join(format!("rollout-2026-03-02T10-00-00-{v4}.jsonl")))
        );

        assert_eq!(rollout_path(&root, "01a0e998-0000-7000-8000-000000000000"), None);
        assert_eq!(rollout_path(&root, ""), None);
        assert_eq!(rollout_path(&root.join("missing"), id), None);
        let _ = std::fs::remove_dir_all(&root);
    }
}
