use crew_protocol::{ToolDetail, TurnUsage};
use serde_json::{Map, Value};

use super::runtime::Autonomy;
use super::{as_record, as_record_owned, clip, finite_number, leaf, string_field, try_parse_json_record};

pub use super::parse_json_line;

pub struct CodexSpawn {
    pub prompt: String,
    pub model: Option<String>,
    pub resume: Option<String>,
    pub cwd: Option<String>,
    pub autonomy: Autonomy,
    pub mcp: Option<(String, Vec<String>)>,
}

pub fn build_codex_spawn_args(input: &CodexSpawn) -> Vec<String> {
    let mut args = vec!["exec".into()];
    if let Some((command, mcp_args)) = &input.mcp {
        args.push("-c".into());
        args.push(format!(
            "mcp_servers.crew.command={}",
            serde_json::to_string(command).unwrap_or_else(|_| "\"\"".into())
        ));
        args.push("-c".into());
        args.push(format!(
            "mcp_servers.crew.args={}",
            serde_json::to_string(mcp_args).unwrap_or_else(|_| "[]".into())
        ));
    }
    if let Some(resume) = input.resume.as_deref().filter(|r| !r.is_empty()) {
        args.push("resume".into());
        args.push("--json".into());
        args.push("--skip-git-repo-check".into());
        if input.autonomy == Autonomy::Full {
            args.push("--dangerously-bypass-approvals-and-sandbox".into());
        }
        if let Some(model) = input.model.as_deref().filter(|m| !m.is_empty()) {
            args.push("-m".into());
            args.push(model.into());
        }
        args.push(resume.into());
        args.push(input.prompt.clone());
        return args;
    }
    args.push("--json".into());
    args.push("--skip-git-repo-check".into());
    if let Some(model) = input.model.as_deref().filter(|m| !m.is_empty()) {
        args.push("-m".into());
        args.push(model.into());
    }
    if input.autonomy == Autonomy::Full {
        args.push("--dangerously-bypass-approvals-and-sandbox".into());
    } else {
        args.push("--sandbox".into());
        args.push("workspace-write".into());
    }
    if let Some(cwd) = input.cwd.as_deref().filter(|c| !c.is_empty()) {
        args.push("-C".into());
        args.push(cwd.into());
    }
    args.push(input.prompt.clone());
    args
}

pub fn build_codex_prompt(
    name: &str,
    description: &str,
    text: &str,
    files: &[String],
    with_persona: bool,
    tools: Option<&str>,
) -> String {
    let body = with_attached_paths(text.trim(), files);
    if !with_persona {
        return body;
    }
    let persona = persona_prompt(name, description, tools);
    if body.is_empty() {
        persona
    } else {
        format!("{persona}\n\n{body}")
    }
}

pub fn persona_prompt(name: &str, description: &str, tools: Option<&str>) -> String {
    let who = {
        let trimmed = name.trim();
        if trimmed.is_empty() {
            "the user's agent"
        } else {
            trimmed
        }
    };
    let job = description.trim();
    let rules = "You are chatting inside Crew, a desktop app. Do the work with your tools, then reply like a colleague in chat: short, direct, no headers or preamble unless asked.";
    let persona = if job.is_empty() {
        format!("You are {who}. {rules}")
    } else {
        format!("You are {who}. {job}\n\n{rules}")
    };
    match tools {
        Some(tools) if !tools.is_empty() => format!("{persona}\n\n{tools}"),
        _ => persona,
    }
}

fn with_attached_paths(text: &str, files: &[String]) -> String {
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

pub fn thread_id_from_event(rec: &Map<String, Value>) -> Option<String> {
    string_field(Some(rec), "thread_id")
}

pub fn item_from_event(rec: &Map<String, Value>) -> Option<Map<String, Value>> {
    let type_name = string_field(Some(rec), "type")?;
    if type_name != "item.started" && type_name != "item.updated" && type_name != "item.completed" {
        return None;
    }
    rec.get("item").and_then(as_record_owned)
}

pub fn agent_message_text(item: &Map<String, Value>) -> Option<String> {
    if string_field(Some(item), "type").as_deref() != Some("agent_message") {
        return None;
    }
    item.get("text").and_then(Value::as_str).map(str::to_string)
}

pub fn item_error_message(item: &Map<String, Value>) -> Option<String> {
    if string_field(Some(item), "type").as_deref() != Some("error") {
        return None;
    }
    unwrap_error(string_field(Some(item), "message"))
}

pub fn stream_error_message(rec: &Map<String, Value>) -> Option<String> {
    let type_name = string_field(Some(rec), "type")?;
    if type_name == "error" {
        return unwrap_error(string_field(Some(rec), "message"));
    }
    if type_name != "turn.failed" {
        return None;
    }
    unwrap_error(
        string_field(rec.get("error").and_then(as_record), "message")
            .or_else(|| string_field(Some(rec), "message")),
    )
}

fn unwrap_error(message: Option<String>) -> Option<String> {
    let message = message?;
    let Some(rec) = try_parse_json_record(&message) else {
        return Some(message);
    };
    Some(
        string_field(rec.get("error").and_then(as_record), "message")
            .or_else(|| string_field(Some(&rec), "message"))
            .unwrap_or(message),
    )
}

pub fn turn_usage(rec: &Map<String, Value>) -> Option<TurnUsage> {
    let usage = rec.get("usage").and_then(as_record)?;
    let input = finite_number(usage.get("input_tokens"));
    let output = finite_number(usage.get("output_tokens"));
    if input.is_none() && output.is_none() {
        return None;
    }
    Some(TurnUsage {
        input_tokens: input.map(|n| n as u64),
        output_tokens: output.map(|n| n as u64),
        cost_usd: None,
        duration_ms: None,
    })
}

pub fn is_tool_item(item: &Map<String, Value>) -> bool {
    matches!(
        string_field(Some(item), "type").as_deref(),
        Some("command_execution" | "file_change" | "mcp_tool_call" | "web_search" | "collab_tool_call")
    )
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
        Some(other) => other.into(),
        None => "tool".into(),
    }
}

pub fn tool_label(item: &Map<String, Value>) -> String {
    match string_field(Some(item), "type").as_deref() {
        Some("command_execution") => string_field(Some(item), "command")
            .map(|command| clip(&command, 72))
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
            match (tool, server) {
                (Some(tool), Some(server)) => format!("{server}.{tool}"),
                (Some(tool), None) => tool,
                (None, Some(server)) => server,
                _ => "MCP".into(),
            }
        }
        Some("web_search") => string_field(Some(item), "query")
            .map(|query| format!("Search {}", clip(&query, 40)))
            .unwrap_or_else(|| "Search".into()),
        Some("collab_tool_call") => string_field(Some(item), "tool").unwrap_or_else(|| "Collab".into()),
        Some(other) => other.into(),
        None => "tool".into(),
    }
}

/// Codex sends the whole item on every phase, so the completed item already
/// carries the exit code and the output the started one could not.
pub fn tool_detail(item: &Map<String, Value>) -> Option<ToolDetail> {
    match string_field(Some(item), "type").as_deref() {
        Some("command_execution") => Some(ToolDetail::Command {
            command: string_field(Some(item), "command")?,
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
            })
        }
        Some("mcp_tool_call") => Some(ToolDetail::Output {
            text: output_text(item.get("result").and_then(as_record)?.get("content"))?,
        }),
        Some("web_search") => Some(ToolDetail::Search {
            query: string_field(Some(item), "query")?,
            matches: None,
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
mod tests {
    use super::*;
    use crate::turns::TurnHost;
    use crew_protocol::{HarnessEvent, ToolDetail, ToolStatus};
    use serde_json::json;

    fn events(line: &Value) -> Vec<HarnessEvent> {
        let host = TurnHost::test_new();
        let cap = host.test_capture();
        host.test_install_codex("s");
        host.handle_codex_line("s", &line.to_string());
        cap.take()
    }

    fn detail(line: &Value) -> Option<ToolDetail> {
        events(line).into_iter().find_map(|event| match event {
            HarnessEvent::ToolStarted { detail, .. } => detail,
            _ => None,
        })
    }

    #[test]
    fn item_started_command_emits_tool_started() {
        let got = events(&json!({
            "type": "item.started",
            "item": { "type": "command_execution", "id": "c1", "command": "ls -la" }
        }));
        assert_eq!(
            got,
            vec![HarnessEvent::ToolStarted {
                call_id: "c1".into(),
                name: "bash".into(),
                title: "ls -la".into(),
                detail: Some(ToolDetail::Command {
                    command: "ls -la".into(),
                    exit_code: None,
                    output: None,
                }),
            }]
        );
    }

    #[test]
    fn item_completed_command_marks_the_tool_done() {
        let got = events(&json!({
            "type": "item.completed",
            "item": { "type": "command_execution", "id": "c1", "command": "ls", "exit_code": 0 }
        }));
        assert_eq!(
            got,
            vec![
                HarnessEvent::ToolStarted {
                    call_id: "c1".into(),
                    name: "bash".into(),
                    title: "ls".into(),
                    detail: Some(ToolDetail::Command {
                        command: "ls".into(),
                        exit_code: Some(0),
                        output: None,
                    }),
                },
                HarnessEvent::ToolUpdated {
                    call_id: "c1".into(),
                    title: None,
                    status: Some(ToolStatus::Completed),
                    detail: None,
                },
            ]
        );
    }

    #[test]
    fn item_started_file_change_names_the_file() {
        let got = events(&json!({
            "type": "item.started",
            "item": {
                "type": "file_change",
                "id": "e1",
                "changes": [{ "path": "/tmp/app/foo.ts", "kind": "add" }]
            }
        }));
        assert_eq!(
            got,
            vec![HarnessEvent::ToolStarted {
                call_id: "e1".into(),
                name: "edit".into(),
                title: "Write foo.ts".into(),
                detail: Some(ToolDetail::Edit {
                    path: "/tmp/app/foo.ts".into(),
                    added: None,
            removed: None,
                }),
            }]
        );
    }

    #[test]
    fn agent_message_emits_delta_then_completed() {
        let got = events(&json!({
            "type": "item.completed",
            "item": { "type": "agent_message", "text": "hello" }
        }));
        assert_eq!(
            got,
            vec![
                HarnessEvent::MessageDelta { text: "hello".into() },
                HarnessEvent::MessageCompleted {},
            ]
        );
    }

    #[test]
    fn turn_completed_carries_usage() {
        let got = events(&json!({
            "type": "turn.completed",
            "usage": { "input_tokens": 3, "output_tokens": 5 }
        }));
        assert_eq!(
            got,
            vec![
                HarnessEvent::MessageCompleted {},
                HarnessEvent::TurnCompleted {
                    usage: Some(TurnUsage {
                        input_tokens: Some(3),
                        output_tokens: Some(5),
                        cost_usd: None,
                        duration_ms: None,
                    }),
                },
            ]
        );
    }

    #[test]
    fn stream_error_settles_without_a_row() {
        let got = events(&json!({
            "type": "error",
            "message": "boom"
        }));
        assert!(got.is_empty());
    }

    #[test]
    fn turn_failed_settles_the_turn() {
        let got = events(&json!({
            "type": "turn.failed",
            "error": { "message": "boom" }
        }));
        assert_eq!(
            got,
            vec![
                HarnessEvent::MessageCompleted {},
                HarnessEvent::TurnCompleted { usage: None },
            ]
        );
    }

    #[test]
    fn a_failed_command_carries_its_exit_code_and_output() {
        let got = events(&json!({
            "type": "item.completed",
            "item": {
                "type": "command_execution",
                "id": "c1",
                "command": "cargo test",
                "exit_code": 101,
                "aggregated_output": "error: 1 test failed\n",
                "status": "failed"
            }
        }));
        assert_eq!(
            got,
            vec![
                HarnessEvent::ToolStarted {
                    call_id: "c1".into(),
                    name: "bash".into(),
                    title: "cargo test".into(),
                    detail: Some(ToolDetail::Command {
                        command: "cargo test".into(),
                        exit_code: Some(101),
                        output: Some("error: 1 test failed\n".into()),
                    }),
                },
                HarnessEvent::ToolUpdated {
                    call_id: "c1".into(),
                    title: None,
                    status: Some(ToolStatus::Failed),
                    detail: None,
                },
            ]
        );
    }

    #[test]
    fn a_change_across_files_names_no_single_path() {
        assert_eq!(
            detail(&json!({
                "type": "item.started",
                "item": {
                    "type": "file_change",
                    "id": "e2",
                    "changes": [
                        { "path": "/tmp/app/foo.ts", "kind": "add" },
                        { "path": "/tmp/app/bar.ts", "kind": "update" }
                    ]
                }
            })),
            None
        );
    }

    /// Both captures come from `notes/codex-protocol.jsonl`: an MCP call says
    /// nothing until it answers.
    #[test]
    fn an_mcp_call_says_nothing_until_it_answers() {
        assert_eq!(
            detail(&json!({
                "type": "item.started",
                "item": {
                    "type": "mcp_tool_call",
                    "id": "item_1",
                    "server": "cua_repl",
                    "tool": "js",
                    "arguments": { "code": "await cua.getState()", "title": "Inspect available terminal surfaces" },
                    "result": null,
                    "error": null,
                    "status": "in_progress"
                }
            })),
            None
        );
    }

    #[test]
    fn an_mcp_result_becomes_output() {
        assert_eq!(
            detail(&json!({
                "type": "item.completed",
                "item": {
                    "type": "mcp_tool_call",
                    "id": "item_2",
                    "server": "cua_repl",
                    "tool": "js",
                    "arguments": { "code": "const app = await cua.getApp('Terminal')", "title": "Open terminal" },
                    "result": { "content": [{ "type": "text", "text": "cua.getApp is not a function" }] },
                    "error": null,
                    "status": "failed"
                }
            })),
            Some(ToolDetail::Output { text: "cua.getApp is not a function".into() })
        );
    }

    #[test]
    fn thread_id_binds_the_provider_session() {
        let got = events(&json!({
            "type": "item.started",
            "thread_id": "thr_1",
            "item": { "type": "agent_message", "text": "hi" }
        }));
        assert_eq!(
            got.first(),
            Some(&HarnessEvent::SessionProviderBound {
                provider_session_id: "thr_1".into(),
            })
        );
    }
}
