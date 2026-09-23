use crew_protocol::{ToolDetail, TurnUsage};
use serde_json::{Map, Value};

use super::runtime::Autonomy;
use super::{as_record, as_record_owned, clip, finite_number, leaf, string_field, try_parse_json_record};

pub use super::parse_json_line;

pub struct CodexSpawn {
    pub prompt: String,
    pub model: Option<String>,
    pub cwd: Option<String>,
    pub autonomy: Autonomy,
    pub mcp: Option<(String, Vec<String>)>,
    /// What `crew --mcp` needs in its own environment to reach the bridge.
    ///
    /// Codex does not hand an MCP server the environment it was started with —
    /// its own servers declare `env` in config.toml for the same reason — and
    /// `crew --mcp` exits at once without CREW_SOCKET. Measured, not guessed:
    /// the agent had CREW_TOKEN in its shell, no Crew tools at all, and sent a
    /// message by piping the bridge's own JSON into `nc`.
    pub mcp_env: Vec<(String, String)>,
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
        if !input.mcp_env.is_empty() {
            let pairs = input
                .mcp_env
                .iter()
                .map(|(key, value)| {
                    format!("{key}={}", serde_json::to_string(value).unwrap_or_else(|_| "\"\"".into()))
                })
                .collect::<Vec<_>>()
                .join(",");
            args.push("-c".into());
            args.push(format!("mcp_servers.crew.env={{{pairs}}}"));
        }
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

/// `codex exec` takes the whole prompt as one argument, so the turn is one
/// document: persona, the tail of the conversation, then what is being asked.
pub fn build_codex_prompt(
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
        &with_attached_paths(text.trim(), files),
    )
}

pub use super::persona_prompt;

#[cfg(test)]
mod crew_row_tests {
    use super::*;
    use serde_json::json;

    fn item(value: Value) -> Map<String, Value> {
        value.as_object().expect("object").clone()
    }

    /// Measured, not guessed: a codex agent messaged another one through the
    /// MCP and its own chat showed a dump of the delivery receipt where the
    /// reader wanted "wrote to Cuddles: the branch is green".
    #[test]
    fn a_message_a_codex_agent_sent_reads_as_a_message() {
        let detail = tool_detail(&item(json!({
            "type": "mcp_tool_call",
            "server": "crew",
            "tool": "message_agent",
            "arguments": { "to": "6e854800-504b", "text": "the branch is green" },
            "result": { "content": [{ "type": "text", "text": "{\"delivered\": true}" }] }
        })));
        assert_eq!(
            detail,
            Some(ToolDetail::Message {
                to: "6e854800-504b".into(),
                text: "the branch is green".into()
            })
        );
    }

    /// Any other Crew tool keeps its result: the message row is the only one
    /// whose arguments say more than its answer does.
    #[test]
    fn another_crew_tool_still_shows_what_it_answered() {
        let detail = tool_detail(&item(json!({
            "type": "mcp_tool_call",
            "server": "crew",
            "tool": "list_agents",
            "arguments": {},
            "result": { "content": [{ "type": "text", "text": "[]" }] }
        })));
        assert_eq!(detail, Some(ToolDetail::Output { text: "[]".into() }));
    }

    /// And a server that is not Crew is left alone. `cua_repl`'s `js` tool
    /// takes `code` and a `title`, neither of which is a message.
    #[test]
    fn somebody_elses_mcp_tool_is_not_read_as_crews() {
        let detail = tool_detail(&item(json!({
            "type": "mcp_tool_call",
            "server": "cua_repl",
            "tool": "js",
            "arguments": { "code": "await cua.getState()", "title": "Inspect" },
            "result": { "content": [{ "type": "text", "text": "Window: Crew" }] }
        })));
        assert_eq!(detail, Some(ToolDetail::Output { text: "Window: Crew".into() }));
    }
}

#[cfg(test)]
mod spawn_tests {
    use super::*;

    /// The server codex starts does not inherit the agent's environment, so the
    /// address of the bridge has to travel in the config with it.
    #[test]
    fn the_mcp_server_is_told_how_to_reach_the_bridge() {
        let args = build_codex_spawn_args(&CodexSpawn {
            prompt: "hi".into(),
            model: None,
            cwd: None,
            autonomy: Autonomy::Ask,
            mcp: Some(("/bin/crewd".into(), vec!["--mcp".into()])),
            mcp_env: vec![
                ("CREW_SOCKET".into(), "/tmp/crew.sock".into()),
                ("CREW_TOKEN".into(), "t-1".into()),
            ],
        });
        let env = args
            .iter()
            .find(|arg| arg.starts_with("mcp_servers.crew.env="))
            .expect("the server was started without the bridge in its environment");
        assert_eq!(
            env,
            "mcp_servers.crew.env={CREW_SOCKET=\"/tmp/crew.sock\",CREW_TOKEN=\"t-1\"}"
        );
    }

    #[test]
    fn no_mcp_means_no_env_for_it() {
        let args = build_codex_spawn_args(&CodexSpawn {
            prompt: "hi".into(),
            model: None,
            cwd: None,
            autonomy: Autonomy::Ask,
            mcp: None,
            mcp_env: vec![("CREW_SOCKET".into(), "/tmp/crew.sock".into())],
        });
        assert!(!args.iter().any(|arg| arg.contains("mcp_servers")), "{args:?}");
    }

    fn spawn(
        autonomy: Autonomy,
        model: Option<&str>,
        cwd: Option<&str>,
        mcp: bool,
        env: &[(&str, &str)],
    ) -> CodexSpawn {
        CodexSpawn {
            prompt: "hi there".into(),
            model: model.map(str::to_string),
            cwd: cwd.map(str::to_string),
            autonomy,
            mcp: mcp.then(|| ("/opt/Crew App/crewd".to_string(), vec!["--mcp".to_string()])),
            mcp_env: env.iter().map(|(k, v)| (k.to_string(), v.to_string())).collect(),
        }
    }

    #[test]
    fn spawn_args_spell_out_each_combination() {
        let cases: Vec<(&str, CodexSpawn, Vec<&str>)> = vec![
            (
                "ask, nothing else",
                spawn(Autonomy::Ask, None, None, false, &[]),
                vec!["exec", "--json", "--skip-git-repo-check", "--sandbox", "workspace-write", "hi there"],
            ),
            (
                "empty model and cwd are no flags",
                spawn(Autonomy::Ask, Some(""), Some(""), false, &[]),
                vec!["exec", "--json", "--skip-git-repo-check", "--sandbox", "workspace-write", "hi there"],
            ),
            (
                "full, with a model and a cwd",
                spawn(Autonomy::Full, Some("gpt-5-codex"), Some("/w"), false, &[]),
                vec![
                    "exec",
                    "--json",
                    "--skip-git-repo-check",
                    "-m",
                    "gpt-5-codex",
                    "--dangerously-bypass-approvals-and-sandbox",
                    "-C",
                    "/w",
                    "hi there",
                ],
            ),
            (
                "an mcp server with no environment",
                spawn(Autonomy::Ask, None, None, true, &[]),
                vec![
                    "exec",
                    "-c",
                    "mcp_servers.crew.command=\"/opt/Crew App/crewd\"",
                    "-c",
                    "mcp_servers.crew.args=[\"--mcp\"]",
                    "--json",
                    "--skip-git-repo-check",
                    "--sandbox",
                    "workspace-write",
                    "hi there",
                ],
            ),
            (
                "an environment value is quoted as TOML would",
                spawn(Autonomy::Full, None, Some("/w"), true, &[("CREW_TOKEN", "a\"b\\c")]),
                vec![
                    "exec",
                    "-c",
                    "mcp_servers.crew.command=\"/opt/Crew App/crewd\"",
                    "-c",
                    "mcp_servers.crew.args=[\"--mcp\"]",
                    "-c",
                    "mcp_servers.crew.env={CREW_TOKEN=\"a\\\"b\\\\c\"}",
                    "--json",
                    "--skip-git-repo-check",
                    "--dangerously-bypass-approvals-and-sandbox",
                    "-C",
                    "/w",
                    "hi there",
                ],
            ),
        ];
        for (name, input, expected) in cases {
            assert_eq!(build_codex_spawn_args(&input), expected, "{name}");
        }
    }

    #[test]
    fn every_combination_keeps_the_prompt_last_and_sets_only_what_was_asked() {
        let values = [None, Some(""), Some("value")];
        let bridges: [(bool, &[(&str, &str)]); 3] = [(false, &[]), (true, &[]), (true, &[("CREW_SOCKET", "/s")])];
        let mut combos = Vec::new();
        for autonomy in [Autonomy::Ask, Autonomy::Full] {
            for model in values {
                for cwd in values {
                    for (mcp, env) in bridges {
                        combos.push((autonomy.clone(), model, cwd, mcp, env));
                    }
                }
            }
        }
        for (autonomy, model, cwd, mcp, env) in combos {
            let full = autonomy == Autonomy::Full;
            let case = format!("{autonomy:?} model={model:?} cwd={cwd:?} mcp={mcp} env={env:?}");
            let args = build_codex_spawn_args(&spawn(autonomy, model, cwd, mcp, env));
            let after = |flag: &str| args.windows(2).find(|pair| pair[0] == flag).map(|pair| pair[1].clone());
            assert_eq!(args.first().map(String::as_str), Some("exec"), "{case}");
            assert_eq!(args.last().map(String::as_str), Some("hi there"), "{case}");
            assert_eq!(after("-m").as_deref(), model.filter(|m| !m.is_empty()), "{case}");
            assert_eq!(after("-C").as_deref(), cwd.filter(|c| !c.is_empty()), "{case}");
            let bypass = args.iter().any(|arg| arg == "--dangerously-bypass-approvals-and-sandbox");
            assert_eq!(bypass, full, "{case}");
            assert_eq!(after("--sandbox").as_deref(), (!full).then_some("workspace-write"), "{case}");
            let configs = args.iter().filter(|arg| arg.starts_with("mcp_servers.crew.")).count();
            assert_eq!(configs, if !mcp { 0 } else if env.is_empty() { 2 } else { 3 }, "{case}");
        }
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
        Some("mcp_tool_call") => {
            // codex splits the server from the tool instead of prefixing it, so
            // a Crew call arrives as server "crew" and tool "message_agent".
            // Without this every one of them rendered as its result JSON, and
            // the row that says who a message went to said nothing.
            if string_field(Some(item), "server").as_deref() == Some("crew") {
                let named = string_field(Some(item), "tool").map(|tool| format!("crew.{tool}"));
                let arguments = item.get("arguments").and_then(as_record);
                if let (Some(named), Some(arguments)) = (named, arguments) {
                    if let Some(detail) = super::crew_tool_detail(&named, arguments) {
                        return Some(detail);
                    }
                }
            }
            Some(ToolDetail::Output {
                text: output_text(item.get("result").and_then(as_record)?.get("content"))?,
            })
        }
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

    /// Both captures come from `crates/crew-core/tests/fixtures/protocols/codex.jsonl`: an MCP call says
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

    fn obj(value: Value) -> Map<String, Value> {
        value.as_object().cloned().unwrap_or_default()
    }

    #[test]
    fn attached_files_are_listed_under_the_prompt() {
        let cases: Vec<(&str, Vec<String>, &str)> = vec![
            ("mira", vec![], "mira"),
            ("", vec![], ""),
            ("mira", vec!["/w/a.rs".into(), "/w/b c.png".into()], "mira\n\nAttached files:\n- /w/a.rs\n- /w/b c.png"),
            ("", vec!["/w/a.rs".into()], "Attached files:\n- /w/a.rs"),
        ];
        for (text, files, expected) in cases {
            assert_eq!(with_attached_paths(text, &files), expected, "{text:?} {files:?}");
        }
        let prompt = build_codex_prompt("Planner", "", None, "  mira  ", &["/w/a.rs".into()], None);
        assert!(prompt.ends_with("mira\n\nAttached files:\n- /w/a.rs"), "{prompt}");
    }

    #[test]
    fn only_item_events_carry_an_item() {
        let cases = vec![
            (json!({ "item": { "type": "agent_message" } }), None),
            (json!({ "type": "turn.started", "item": { "type": "agent_message" } }), None),
            (json!({ "type": "item.started", "item": { "type": "reasoning" } }), Some(json!({ "type": "reasoning" }))),
            (json!({ "type": "item.updated", "item": { "id": "i1" } }), Some(json!({ "id": "i1" }))),
            (json!({ "type": "item.completed", "item": { "id": "i2" } }), Some(json!({ "id": "i2" }))),
            (json!({ "type": "item.completed", "item": "not an object" }), None),
            (json!({ "type": "item.completed" }), None),
        ];
        for (rec, expected) in cases {
            assert_eq!(item_from_event(&obj(rec.clone())), expected.map(obj), "{rec}");
        }
    }

    #[test]
    fn a_message_or_an_error_is_read_only_off_its_own_item_type() {
        let cases = vec![
            (json!({ "type": "agent_message", "text": " hola " }), Some(" hola "), None),
            (json!({ "type": "agent_message" }), None, None),
            (json!({ "type": "reasoning", "text": "hm" }), None, None),
            (json!({ "type": "error", "message": "stream disconnected" }), None, Some("stream disconnected")),
            (
                json!({ "type": "error", "message": "{\"error\":{\"message\":\"Rate limit reached\"}}" }),
                None,
                Some("Rate limit reached"),
            ),
            (json!({ "type": "error" }), None, None),
        ];
        for (item, text, error) in cases {
            let item_rec = obj(item.clone());
            assert_eq!(agent_message_text(&item_rec).as_deref(), text, "text of {item}");
            assert_eq!(item_error_message(&item_rec).as_deref(), error, "error of {item}");
        }
    }

    /// Codex nests the API's own JSON error inside its message; the reader
    /// wants the sentence, not the envelope.
    #[test]
    fn a_stream_error_is_unwrapped_to_its_sentence() {
        let cases = vec![
            ("no type", json!({ "message": "boom" }), None),
            ("another event", json!({ "type": "turn.completed", "message": "boom" }), None),
            ("a plain error", json!({ "type": "error", "message": "boom" }), Some("boom")),
            ("an error with no message", json!({ "type": "error" }), None),
            (
                "a wrapped error",
                json!({ "type": "error", "message": "{\"error\":{\"message\":\"The model is overloaded\"}}" }),
                Some("The model is overloaded"),
            ),
            (
                "a wrapped message",
                json!({ "type": "error", "message": "{\"message\":\"Unauthorized\"}" }),
                Some("Unauthorized"),
            ),
            (
                "json that says nothing stays as it came",
                json!({ "type": "error", "message": "{\"status\":500}" }),
                Some("{\"status\":500}"),
            ),
            ("a failed turn", json!({ "type": "turn.failed", "error": { "message": "quota" } }), Some("quota")),
            ("a failed turn with a flat message", json!({ "type": "turn.failed", "message": "flat" }), Some("flat")),
            ("a failed turn that says nothing", json!({ "type": "turn.failed", "error": {} }), None),
        ];
        for (name, rec, expected) in cases {
            assert_eq!(stream_error_message(&obj(rec)).as_deref(), expected, "{name}");
        }
    }

    #[test]
    fn usage_needs_at_least_one_count() {
        let usage = |input, output| TurnUsage {
            input_tokens: input,
            output_tokens: output,
            cost_usd: None,
            duration_ms: None,
        };
        let cases = vec![
            (json!({ "type": "turn.completed" }), None),
            (json!({ "usage": "lots" }), None),
            (json!({ "usage": { "cached_input_tokens": 5 } }), None),
            (json!({ "usage": { "input_tokens": 3 } }), Some(usage(Some(3), None))),
            (json!({ "usage": { "output_tokens": 4 } }), Some(usage(None, Some(4)))),
            (json!({ "usage": { "input_tokens": 3, "output_tokens": "4" } }), Some(usage(Some(3), None))),
        ];
        for (rec, expected) in cases {
            assert_eq!(turn_usage(&obj(rec.clone())), expected, "{rec}");
        }
    }

    /// One row per item: whether it is a tool, the name it runs under, and the
    /// title the chat shows for it.
    #[test]
    fn every_item_type_is_named_and_titled() {
        let long = format!("echo {}", "é".repeat(100));
        let cases: Vec<(Value, bool, &str, String)> = vec![
            (json!({ "type": "command_execution", "command": "ls -la" }), true, "bash", "ls -la".into()),
            (
                json!({ "type": "command_execution", "command": long }),
                true,
                "bash",
                format!("echo {}…", "é".repeat(66)),
            ),
            (json!({ "type": "command_execution" }), true, "bash", "Command".into()),
            (
                json!({ "type": "file_change", "changes": [{ "path": "/w/foo.ts", "kind": "add" }] }),
                true,
                "edit",
                "Write foo.ts".into(),
            ),
            (
                json!({ "type": "file_change", "changes": [{ "path": "/w/foo.ts", "kind": "delete" }] }),
                true,
                "edit",
                "Delete foo.ts".into(),
            ),
            (
                json!({ "type": "file_change", "changes": [{ "path": "/w/foo.ts", "kind": "update" }] }),
                true,
                "edit",
                "Edit foo.ts".into(),
            ),
            (
                json!({
                    "type": "file_change",
                    "changes": [{ "path": "/w/a.ts", "kind": "add" }, { "path": "/w/b.ts" }]
                }),
                true,
                "edit",
                "Write 2 files".into(),
            ),
            (json!({ "type": "file_change", "changes": [{ "kind": "delete" }] }), true, "edit", "Delete".into()),
            (json!({ "type": "file_change" }), true, "edit", "Edit".into()),
            (
                json!({
                    "type": "mcp_tool_call",
                    "server": "cua",
                    "tool": "js",
                    "arguments": { "title": "Open terminal" }
                }),
                true,
                "js",
                "Open terminal".into(),
            ),
            (json!({ "type": "mcp_tool_call", "server": "cua", "tool": "js" }), true, "js", "cua.js".into()),
            (json!({ "type": "mcp_tool_call", "tool": "js", "arguments": "x" }), true, "js", "js".into()),
            (json!({ "type": "mcp_tool_call", "server": "cua" }), true, "mcp", "cua".into()),
            (json!({ "type": "mcp_tool_call" }), true, "mcp", "MCP".into()),
            (json!({ "type": "web_search", "query": "ts-rs" }), true, "websearch", "Search ts-rs".into()),
            (json!({ "type": "web_search" }), true, "websearch", "Search".into()),
            (json!({ "type": "collab_tool_call", "tool": "spawn" }), true, "spawn", "spawn".into()),
            (json!({ "type": "collab_tool_call" }), true, "collab", "Collab".into()),
            (json!({ "type": "reasoning" }), false, "reasoning", "reasoning".into()),
            (json!({ "type": "agent_message", "text": "hi" }), false, "agent_message", "agent_message".into()),
            (json!({ "id": "i1" }), false, "tool", "tool".into()),
        ];
        for (item, is_tool, name, title) in cases {
            let rec = obj(item.clone());
            assert_eq!(is_tool_item(&rec), is_tool, "is_tool_item {item}");
            assert_eq!(tool_name(&rec), name, "tool_name {item}");
            assert_eq!(tool_label(&rec), title, "tool_label {item}");
        }
        assert_eq!(tool_call_id(&obj(json!({ "id": " c1 " }))).as_deref(), Some("c1"));
        assert_eq!(tool_call_id(&obj(json!({}))), None);
        assert_eq!(thread_id_from_event(&obj(json!({ "thread_id": "thr_1" }))).as_deref(), Some("thr_1"));
    }

    #[test]
    fn every_item_type_has_the_detail_it_can_back_up() {
        let cases: Vec<(&str, Value, Option<ToolDetail>)> = vec![
            (
                "a command still running",
                json!({ "type": "command_execution", "command": "ls" }),
                Some(ToolDetail::Command { command: "ls".into(), exit_code: None, output: None }),
            ),
            (
                "a command that finished with output",
                json!({ "type": "command_execution", "command": "ls", "exit_code": 2, "aggregated_output": "nope\n" }),
                Some(ToolDetail::Command { command: "ls".into(), exit_code: Some(2), output: Some("nope\n".into()) }),
            ),
            (
                "an empty output is no output",
                json!({ "type": "command_execution", "command": "true", "exit_code": 0, "aggregated_output": "" }),
                Some(ToolDetail::Command { command: "true".into(), exit_code: Some(0), output: None }),
            ),
            (
                "an output that is neither text nor blocks",
                json!({ "type": "command_execution", "command": "ls", "aggregated_output": 5 }),
                Some(ToolDetail::Command { command: "ls".into(), exit_code: None, output: None }),
            ),
            ("a command with no command", json!({ "type": "command_execution", "exit_code": 0 }), None),
            (
                "a change to one file",
                json!({ "type": "file_change", "changes": [{ "path": "/w/a.rs", "kind": "update" }] }),
                Some(ToolDetail::Edit { path: "/w/a.rs".into(), added: None, removed: None }),
            ),
            ("a change with no path", json!({ "type": "file_change", "changes": [{ "kind": "add" }] }), None),
            ("a change with no changes", json!({ "type": "file_change", "changes": [] }), None),
            ("a change with no list", json!({ "type": "file_change" }), None),
            (
                "a crew message",
                json!({
                    "type": "mcp_tool_call",
                    "server": "crew",
                    "tool": "message_agent",
                    "arguments": { "to": "Ada", "text": "hi" }
                }),
                Some(ToolDetail::Message { to: "Ada".into(), text: "hi".into() }),
            ),
            (
                "a crew message with no recipient shows its answer",
                json!({
                    "type": "mcp_tool_call",
                    "server": "crew",
                    "tool": "message_agent",
                    "arguments": { "text": "hi" },
                    "result": { "content": [{ "type": "text", "text": "missing `to`" }] }
                }),
                Some(ToolDetail::Output { text: "missing `to`".into() }),
            ),
            (
                "a crew call with no arguments",
                json!({
                    "type": "mcp_tool_call",
                    "server": "crew",
                    "tool": "message_agent",
                    "result": { "content": "sent" }
                }),
                Some(ToolDetail::Output { text: "sent".into() }),
            ),
            (
                "a result in several blocks",
                json!({
                    "type": "mcp_tool_call",
                    "server": "cua",
                    "tool": "js",
                    "result": {
                        "content": [{ "type": "text", "text": "one" }, { "type": "image" }, "x", { "text": "two" }]
                    }
                }),
                Some(ToolDetail::Output { text: "one\ntwo".into() }),
            ),
            (
                "a result with no text in it",
                json!({ "type": "mcp_tool_call", "tool": "js", "result": { "content": [{ "type": "image" }] } }),
                None,
            ),
            (
                "a result whose content is a number",
                json!({ "type": "mcp_tool_call", "tool": "js", "result": { "content": 3 } }),
                None,
            ),
            ("a call with no result yet", json!({ "type": "mcp_tool_call", "tool": "js", "result": null }), None),
            (
                "a web search",
                json!({ "type": "web_search", "query": "rust" }),
                Some(ToolDetail::Search { query: "rust".into(), matches: None }),
            ),
            ("a web search with no query", json!({ "type": "web_search" }), None),
            ("a collab call", json!({ "type": "collab_tool_call", "tool": "spawn" }), None),
            ("not a tool", json!({ "type": "agent_message", "text": "hi" }), None),
        ];
        for (name, item, expected) in cases {
            assert_eq!(tool_detail(&obj(item)), expected, "{name}");
        }
    }

    #[test]
    fn a_finished_item_failed_when_it_says_so_or_its_exit_code_does() {
        let cases = vec![
            (json!({ "status": "failed" }), ToolStatus::Failed),
            (json!({ "status": "declined", "exit_code": 0 }), ToolStatus::Failed),
            (json!({ "status": "completed", "exit_code": 1 }), ToolStatus::Completed),
            (json!({ "status": "in_progress", "exit_code": 127 }), ToolStatus::Failed),
            (json!({ "exit_code": 0 }), ToolStatus::Completed),
            (json!({ "exit_code": "1" }), ToolStatus::Completed),
            (json!({}), ToolStatus::Completed),
        ];
        for (item, expected) in cases {
            assert_eq!(completed_tool_status(&obj(item.clone())), expected, "{item}");
        }
    }
}
