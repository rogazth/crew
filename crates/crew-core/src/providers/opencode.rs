use crew_protocol::{ToolDetail, ToolStatus, TurnUsage};
use serde_json::{Map, Value};

use super::runtime::Autonomy;
use super::{as_record, as_record_owned, clip, crew_tool_detail, finite_number, leaf, string_field};

pub use super::parse_json_line;

pub struct OpencodeSpawn {
    pub model: Option<String>,
    pub autonomy: Autonomy,
}

/// The prompt is not in here: `opencode run` re-quotes every argument that holds
/// a space, so a persona passed on argv would reach the model wrapped in literal
/// quotes with its own escaped. It goes on stdin instead, which the CLI reads
/// whole.
pub fn build_opencode_spawn_args(input: &OpencodeSpawn) -> Vec<String> {
    let mut args = vec!["run".into(), "--format".into(), "json".into()];
    if let Some(model) = input.model.as_deref().filter(|m| !m.is_empty()) {
        args.push("-m".into());
        args.push(model.into());
    }
    if input.autonomy == Autonomy::Full {
        args.push("--auto".into());
    }
    args
}

/// opencode reads the whole prompt from stdin, so the turn is one document:
/// persona, the tail of the conversation, then what is being asked now.
pub fn build_opencode_prompt(
    name: &str,
    description: &str,
    history: Option<&str>,
    text: &str,
    files: &[String],
    tools: Option<&str>,
) -> String {
    let persona = match tools {
        Some(hint) => format!("{}\n\n{hint}", persona_prompt(name, description, None)),
        None => persona_prompt(name, description, None),
    };
    super::assemble(persona, history, &with_attached_paths(text.trim(), files))
}

/// opencode takes no MCP server on the command line, only through config. It
/// reads `OPENCODE_CONFIG_CONTENT` as inline JSON, so the bridge is handed over
/// on the environment instead of a file in the user's repo.
pub fn opencode_config(mcp: Option<&(String, Vec<String>)>) -> Option<String> {
    let (exe, args) = mcp?;
    let mut command = vec![exe.clone()];
    command.extend(args.iter().cloned());
    serde_json::to_string(&serde_json::json!({
        "$schema": "https://opencode.ai/config.json",
        "mcp": { "crew": { "type": "local", "command": command, "enabled": true } }
    }))
    .ok()
}

pub use super::persona_prompt;

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

pub fn session_id_from_event(rec: &Map<String, Value>) -> Option<String> {
    string_field(Some(rec), "sessionID")
}

fn event_part(rec: &Map<String, Value>) -> Option<&Map<String, Value>> {
    rec.get("part").and_then(as_record)
}

pub struct OpencodeText {
    pub id: String,
    pub text: String,
}

/// opencode prints a text part only once it has finished, and the part carries
/// the whole text rather than the piece that just arrived. It is still a
/// snapshot, so the same id can come back and the caller emits only what grew.
pub fn text_part(rec: &Map<String, Value>) -> Option<OpencodeText> {
    let part = event_part(rec)?;
    if string_field(Some(part), "type").as_deref() != Some("text") {
        return None;
    }
    let text = part.get("text").and_then(Value::as_str).filter(|text| !text.is_empty())?;
    Some(OpencodeText {
        id: string_field(Some(part), "id")?,
        text: text.to_string(),
    })
}

pub struct OpencodeToolCall {
    pub call_id: String,
    pub name: String,
    pub title: String,
    pub detail: Option<ToolDetail>,
    pub status: ToolStatus,
}

/// A tool is printed once, already settled: the JSON stream skips the pending
/// and running updates the TUI shows, so there is no phase to open the row with
/// before its result.
pub fn parse_tool_call(rec: &Map<String, Value>) -> Option<OpencodeToolCall> {
    let part = event_part(rec)?;
    if string_field(Some(part), "type").as_deref() != Some("tool") {
        return None;
    }
    let call_id = string_field(Some(part), "callID")?;
    let name = string_field(Some(part), "tool").unwrap_or_else(|| "tool".into());
    let state = part.get("state").and_then(as_record);
    let input = state
        .and_then(|row| row.get("input"))
        .and_then(as_record_owned)
        .unwrap_or_default();
    Some(OpencodeToolCall {
        title: tool_label(&name, &input),
        detail: tool_detail(&name, &input, state),
        status: tool_status(&name, state),
        call_id,
        name,
    })
}

/// A shell that answers with a non-zero exit failed as surely as a tool that
/// threw, and opencode calls both of those `completed`.
fn tool_status(name: &str, state: Option<&Map<String, Value>>) -> ToolStatus {
    // A call the model got wrong is reported as a completed tool named
    // `invalid`; nothing about it succeeded.
    let failed = name == "invalid"
        || string_field(state, "status").as_deref() == Some("error")
        || metadata(state)
            .and_then(|meta| meta.get("exit"))
            .and_then(Value::as_i64)
            .is_some_and(|code| code != 0);
    if failed {
        ToolStatus::Failed
    } else {
        ToolStatus::Completed
    }
}

fn metadata(state: Option<&Map<String, Value>>) -> Option<&Map<String, Value>> {
    state?.get("metadata").and_then(as_record)
}

/// A tool that threw names no output, only the error, so the row shows that
/// instead of the shape it would have had.
fn tool_detail(
    name: &str,
    input: &Map<String, Value>,
    state: Option<&Map<String, Value>>,
) -> Option<ToolDetail> {
    if let Some(detail) = crew_tool_detail(name, input) {
        return Some(detail);
    }
    if string_field(state, "status").as_deref() == Some("error") {
        return Some(ToolDetail::Output {
            text: string_field(state, "error")?,
        });
    }
    let meta = metadata(state);
    match name {
        "bash" => Some(ToolDetail::Command {
            command: string_field(Some(input), "command")?,
            exit_code: meta
                .and_then(|meta| meta.get("exit"))
                .and_then(Value::as_i64)
                .map(|code| code as i32),
            output: text_field(meta, "output").or_else(|| text_field(state, "output")),
        }),
        "read" => {
            let display = meta.and_then(|meta| meta.get("display")).and_then(as_record);
            Some(ToolDetail::File {
                path: string_field(display, "path")
                    .or_else(|| string_field(Some(input), "filePath"))?,
                line_start: line_number(display, "lineStart"),
                line_end: line_number(display, "lineEnd"),
                preview: text_field(meta, "preview").or_else(|| text_field(display, "text")),
            })
        }
        // opencode counts no lines on a write, so the counts stay unset.
        "write" | "edit" | "patch" => Some(ToolDetail::Edit {
            path: string_field(meta, "filepath").or_else(|| string_field(Some(input), "filePath"))?,
            added: None,
            removed: None,
        }),
        "grep" | "glob" => Some(ToolDetail::Search {
            query: string_field(Some(input), "pattern")?,
            matches: meta
                .and_then(|meta| meta.get("matches"))
                .and_then(Value::as_u64)
                .map(|count| count as u32),
        }),
        "webfetch" => Some(ToolDetail::Fetch {
            url: string_field(Some(input), "url")?,
            title: None,
        }),
        _ => Some(ToolDetail::Output {
            text: text_field(state, "output")?,
        }),
    }
}

fn tool_label(name: &str, input: &Map<String, Value>) -> String {
    if let Some(verb) = super::crew_tool(name) {
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
fn text_field(rec: Option<&Map<String, Value>>, key: &str) -> Option<String> {
    rec?.get(key)
        .and_then(Value::as_str)
        .filter(|text| !text.is_empty())
        .map(str::to_string)
}

fn line_number(rec: Option<&Map<String, Value>>, key: &str) -> Option<u32> {
    rec?.get(key).and_then(Value::as_u64).map(|line| line as u32)
}

/// `tool-calls` means the model is coming back for another step; every other
/// reason ends the turn.
/// Why a step stopped, when that is not "it called tools".
pub fn step_failure(rec: &Map<String, Value>) -> Option<String> {
    let part = event_part(rec)?;
    let reason = string_field(Some(part), "reason")?;
    match reason.as_str() {
        "stop" | "tool-calls" => None,
        "length" => Some("The model ran out of room mid-answer.".into()),
        "content-filter" => Some("The provider stopped the answer.".into()),
        other => Some(format!("The turn ended early: {other}.")),
    }
}

pub fn turn_ended(rec: &Map<String, Value>) -> bool {
    string_field(event_part(rec), "reason").as_deref() != Some("tool-calls")
}

/// A turn runs several steps and each `step_finish` counts only its own, so the
/// turn's usage is their sum. Reasoning is counted apart from the output, and
/// the cache apart from the input, so both are added back in.
pub fn add_step_usage(prev: Option<&TurnUsage>, rec: &Map<String, Value>) -> TurnUsage {
    let part = event_part(rec);
    let tokens = part.and_then(|part| part.get("tokens")).and_then(as_record);
    let cache = tokens.and_then(|tokens| tokens.get("cache")).and_then(as_record);
    let input = count(tokens, "input") + count(cache, "read") + count(cache, "write");
    let output = count(tokens, "output") + count(tokens, "reasoning");
    let cost = finite_number(part.and_then(|part| part.get("cost"))).unwrap_or(0.0);
    TurnUsage {
        input_tokens: Some(prev.and_then(|prev| prev.input_tokens).unwrap_or(0) + input),
        output_tokens: Some(prev.and_then(|prev| prev.output_tokens).unwrap_or(0) + output),
        cost_usd: Some(prev.and_then(|prev| prev.cost_usd).unwrap_or(0.0) + cost),
        duration_ms: None,
    }
}

fn count(rec: Option<&Map<String, Value>>, key: &str) -> u64 {
    finite_number(rec.and_then(|rec| rec.get(key)))
        .filter(|count| *count >= 0.0)
        .unwrap_or(0.0) as u64
}

pub fn stream_error_message(rec: &Map<String, Value>) -> String {
    let error = rec.get("error").and_then(as_record);
    string_field(error.and_then(|error| error.get("data")).and_then(as_record), "message")
        .or_else(|| string_field(error, "name"))
        .unwrap_or_else(|| "opencode turn failed.".into())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::turns::TurnHost;
    use crew_protocol::{HarnessEvent, ToolDetail, ToolStatus};
    use serde_json::json;

    fn events(lines: &[Value]) -> Vec<HarnessEvent> {
        let host = TurnHost::test_new();
        let cap = host.test_capture();
        host.test_install_opencode("s");
        for line in lines {
            host.handle_opencode_line("s", &line.to_string());
        }
        cap.take()
    }

    fn detail(line: &Value) -> Option<ToolDetail> {
        events(std::slice::from_ref(line)).into_iter().find_map(|event| match event {
            HarnessEvent::ToolUpdated { detail, .. } | HarnessEvent::ToolStarted { detail, .. } => detail,
            _ => None,
        })
    }

    fn text(text: &str) -> Value {
        json!({
            "type": "text",
            "part": { "type": "text", "id": "prt_1", "text": text, "time": { "start": 1, "end": 2 } }
        })
    }

    fn step_finish(reason: &str, input: u64, output: u64) -> Value {
        json!({
            "type": "step_finish",
            "part": {
                "type": "step-finish",
                "id": "prt_9",
                "reason": reason,
                "tokens": {
                    "total": 0,
                    "input": input,
                    "output": output,
                    "reasoning": 0,
                    "cache": { "write": 0, "read": 0 }
                },
                "cost": 0
            }
        })
    }

    #[test]
    fn a_text_part_is_one_whole_message() {
        assert_eq!(
            events(&[text("The sky appears blue because of Rayleigh scattering.")]),
            vec![
                HarnessEvent::MessageDelta {
                    text: "The sky appears blue because of Rayleigh scattering.".into()
                },
                HarnessEvent::MessageCompleted {},
            ]
        );
    }

    /// Parts are snapshots, so a part that comes back adds only what grew — and
    /// a part that comes back unchanged adds nothing at all.
    #[test]
    fn a_repeated_text_part_adds_only_what_grew() {
        let got = events(&[text("one"), text("one"), text("one two")]);
        assert_eq!(
            got,
            vec![
                HarnessEvent::MessageDelta { text: "one".into() },
                HarnessEvent::MessageCompleted {},
                HarnessEvent::MessageDelta { text: " two".into() },
                HarnessEvent::MessageCompleted {},
            ]
        );
    }

    /// The `sleep 3 && ls /definitely-not-here-xyz` call of
    /// `crates/crew-core/tests/fixtures/protocols/opencode-streaming.jsonl`: it reported once, three seconds in,
    /// `completed` with the exit code on the side.
    #[test]
    fn a_failed_shell_call_carries_its_exit_code_and_output() {
        let got = events(&[json!({
            "type": "tool_use",
            "part": {
                "type": "tool",
                "tool": "bash",
                "callID": "call_b7",
                "state": {
                    "status": "completed",
                    "input": { "command": "sleep 3 && ls /definitely-not-here-xyz" },
                    "output": "ls: cannot access '/definitely-not-here-xyz': No such file or directory\n",
                    "metadata": {
                        "output": "ls: cannot access '/definitely-not-here-xyz': No such file or directory\n",
                        "exit": 2,
                        "truncated": false
                    },
                    "title": "sleep 3 && ls /definitely-not-here-xyz"
                }
            }
        })]);
        let shell = Some(ToolDetail::Command {
            command: "sleep 3 && ls /definitely-not-here-xyz".into(),
            exit_code: Some(2),
            output: Some("ls: cannot access '/definitely-not-here-xyz': No such file or directory\n".into()),
        });
        assert_eq!(
            got,
            vec![
                HarnessEvent::ToolStarted {
                    call_id: "call_b7".into(),
                    name: "bash".into(),
                    title: "sleep 3 && ls /definitely-not-here-xyz".into(),
                    detail: shell.clone(),
                },
                HarnessEvent::ToolUpdated {
                    call_id: "call_b7".into(),
                    title: None,
                    status: Some(ToolStatus::Failed),
                    detail: shell,
                },
            ]
        );
    }

    /// The `have.txt` read of `crates/crew-core/tests/fixtures/protocols/opencode-streaming.jsonl`, with the path
    /// shortened.
    #[test]
    fn a_read_carries_the_window_it_returned() {
        assert_eq!(
            detail(&json!({
                "type": "tool_use",
                "part": {
                    "type": "tool",
                    "tool": "read",
                    "callID": "call_r1",
                    "state": {
                        "status": "completed",
                        "input": { "filePath": "have.txt" },
                        "output": "<path>/w/have.txt</path>\n<type>file</type>",
                        "metadata": {
                            "preview": "alpha\nTODO beta\ngamma",
                            "truncated": false,
                            "display": {
                                "type": "file",
                                "path": "/w/have.txt",
                                "text": "alpha\nTODO beta\ngamma",
                                "lineStart": 1,
                                "lineEnd": 3,
                                "totalLines": 3
                            }
                        }
                    }
                }
            })),
            Some(ToolDetail::File {
                path: "/w/have.txt".into(),
                line_start: Some(1),
                line_end: Some(3),
                preview: Some("alpha\nTODO beta\ngamma".into()),
            })
        );
    }

    #[test]
    fn a_write_names_the_file_it_wrote() {
        let got = events(&[json!({
            "type": "tool_use",
            "part": {
                "type": "tool",
                "tool": "write",
                "callID": "call_w1",
                "state": {
                    "status": "completed",
                    "input": { "filePath": "new.txt", "content": "hello" },
                    "output": "Wrote file successfully.",
                    "metadata": { "diagnostics": {}, "filepath": "/w/new.txt", "exists": false }
                }
            }
        })]);
        assert_eq!(
            got.first(),
            Some(&HarnessEvent::ToolStarted {
                call_id: "call_w1".into(),
                name: "write".into(),
                title: "Write new.txt".into(),
                detail: Some(ToolDetail::Edit {
                    path: "/w/new.txt".into(),
                    added: None,
                    removed: None,
                }),
            })
        );
    }

    #[test]
    fn a_grep_counts_its_matches() {
        assert_eq!(
            detail(&json!({
                "type": "tool_use",
                "part": {
                    "type": "tool",
                    "tool": "grep",
                    "callID": "call_g1",
                    "state": {
                        "status": "completed",
                        "input": { "path": "/w", "pattern": "TODO" },
                        "output": "Found 1 matches\n/w/have.txt:\n  Line 2: TODO beta\n",
                        "metadata": { "matches": 1, "truncated": false }
                    }
                }
            })),
            Some(ToolDetail::Search {
                query: "TODO".into(),
                matches: Some(1),
            })
        );
    }

    /// The missing-file read of `crates/crew-core/tests/fixtures/protocols/opencode-streaming.jsonl`: a tool that
    /// threw has no metadata and no output, only the message.
    #[test]
    fn a_tool_that_threw_shows_its_error() {
        let got = events(&[json!({
            "type": "tool_use",
            "part": {
                "type": "tool",
                "tool": "read",
                "callID": "call_r0",
                "state": {
                    "status": "error",
                    "input": { "filePath": "/nope/definitely-missing.txt" },
                    "error": "File not found: /nope/definitely-missing.txt"
                }
            }
        })]);
        assert_eq!(
            got.last(),
            Some(&HarnessEvent::ToolUpdated {
                call_id: "call_r0".into(),
                title: None,
                status: Some(ToolStatus::Failed),
                detail: Some(ToolDetail::Output {
                    text: "File not found: /nope/definitely-missing.txt".into(),
                }),
            })
        );
    }

    #[test]
    fn a_step_that_calls_tools_does_not_end_the_turn() {
        assert_eq!(events(&[step_finish("tool-calls", 41, 22)]), vec![]);
    }

    #[test]
    fn the_last_step_completes_the_turn_with_every_step_counted() {
        let got = events(&[step_finish("tool-calls", 41, 22), step_finish("stop", 121, 51)]);
        assert_eq!(
            got,
            vec![
                HarnessEvent::MessageCompleted {},
                HarnessEvent::TurnCompleted {
                    usage: Some(TurnUsage {
                        input_tokens: Some(162),
                        output_tokens: Some(73),
                        cost_usd: Some(0.0),
                        duration_ms: None,
                    }),
                },
            ]
        );
    }

    /// The cache is billed as input and reasoning as output, so both land in the
    /// turn's counts.
    #[test]
    fn usage_counts_the_cache_and_the_reasoning() {
        let got = events(&[json!({
            "type": "step_finish",
            "part": {
                "type": "step-finish",
                "id": "prt_9",
                "reason": "stop",
                "tokens": {
                    "total": 10317,
                    "input": 121,
                    "output": 51,
                    "reasoning": 33,
                    "cache": { "write": 0, "read": 10112 }
                },
                "cost": 0
            }
        })]);
        assert_eq!(
            got.last(),
            Some(&HarnessEvent::TurnCompleted {
                usage: Some(TurnUsage {
                    input_tokens: Some(10233),
                    output_tokens: Some(84),
                    cost_usd: Some(0.0),
                    duration_ms: None,
                }),
            })
        );
    }

    #[test]
    fn session_id_binds_the_provider_session() {
        let got = events(&[json!({
            "type": "step_start",
            "sessionID": "ses_f52488128ffep0Jr7oGXPVw1Yt",
            "part": { "type": "step-start", "id": "prt_0" }
        })]);
        assert_eq!(
            got,
            vec![HarnessEvent::SessionProviderBound {
                provider_session_id: "ses_f52488128ffep0Jr7oGXPVw1Yt".into(),
            }]
        );
    }

    #[test]
    fn an_error_settles_the_turn() {
        let got = events(&[json!({
            "type": "error",
            "error": { "name": "ProviderAuthError", "data": { "message": "no credentials" } }
        })]);
        assert_eq!(got, vec![]);
    }

    #[test]
    fn a_message_to_another_agent_reads_as_the_message() {
        let events = events(&[json!({
            "type": "tool_use",
            "sessionID": "ses_1",
            "part": {
                "type": "tool",
                "tool": "crew_message_agent",
                "callID": "call_1",
                "state": {
                    "status": "completed",
                    "input": { "to": "Cuddles", "text": "the branch is green" },
                    "output": "{\"delivered\": true}"
                }
            }
        })]);
        let detail = events.iter().find_map(|event| match event {
            HarnessEvent::ToolStarted { detail: Some(detail), .. } => Some(detail.clone()),
            _ => None,
        });
        let Some(ToolDetail::Message { to, text }) = detail else {
            panic!("expected a message detail, got {detail:?}");
        };
        assert_eq!(to, "Cuddles");
        assert_eq!(text, "the branch is green");
    }

    #[test]
    fn a_call_the_model_got_wrong_is_a_failed_row() {
        let events = events(&[json!({
            "type": "tool_use",
            "sessionID": "ses_1",
            "part": {
                "type": "tool",
                "tool": "invalid",
                "callID": "call_2",
                "state": {
                    "status": "completed",
                    "input": { "tool": "message_agent", "error": "unavailable tool" },
                    "output": "The arguments provided to the tool are invalid"
                }
            }
        })]);
        assert!(
            events.iter().any(|event| matches!(
                event,
                HarnessEvent::ToolUpdated { status: Some(ToolStatus::Failed), .. }
            )),
            "a rejected call should not read as a success: {events:?}"
        );
    }

    // ---------------------------------------------------------------
    // Adversarial review additions. Each one fails on current `master`.
    // ---------------------------------------------------------------

    /// `handle_opencode_line` only emits `TurnCompleted { usage }` on the
    /// success path. A turn that ran ten steps and then hit a provider error
    /// signals `Failed` and drops every token it had counted, so the run the
    /// user was billed for reports nothing.
    #[test]
    fn review_a_failed_turn_throws_away_every_token_it_counted() {
        let got = events(&[
            step_finish("tool-calls", 41, 22),
            step_finish("tool-calls", 121, 51),
            json!({
                "type": "error",
                "error": { "name": "ProviderError", "data": { "message": "upstream 500" } }
            }),
        ]);
        let usage = got.iter().find_map(|event| match event {
            HarnessEvent::TurnCompleted { usage } => usage.clone(),
            _ => None,
        });
        assert_eq!(
            usage.and_then(|u| u.input_tokens),
            Some(162),
            "162 input tokens were counted and then discarded: {got:?}"
        );
    }

    /// `opencode_text` remembers exactly one part id. Two parts that both grow
    /// make it forget the other every time it switches, and the text it already
    /// emitted is emitted again.
    #[test]
    fn review_two_text_parts_that_interleave_repeat_themselves() {
        fn part(id: &str, text: &str) -> Value {
            json!({
                "type": "text",
                "part": { "type": "text", "id": id, "text": text }
            })
        }
        let got = events(&[
            part("prt_a", "alpha"),
            part("prt_b", "beta"),
            part("prt_a", "alpha and more"),
        ]);
        let said: Vec<String> = got
            .iter()
            .filter_map(|event| match event {
                HarnessEvent::MessageDelta { text } => Some(text.clone()),
                _ => None,
            })
            .collect();
        assert_eq!(
            said,
            vec!["alpha".to_string(), "beta".into(), " and more".into()],
            "part prt_a was re-sent whole instead of only what grew"
        );
    }

    /// `an_error_settles_the_turn` asserts only that an error line emits no
    /// transcript events. So does a line the adapter does not know at all, so
    /// that assertion passes with the whole `type == "error"` branch deleted.
    #[test]
    fn review_the_error_test_would_pass_without_the_error_branch() {
        let unknown = json!({ "type": "not_a_real_event", "part": { "type": "whatever" } });
        assert_eq!(events(&[unknown]), vec![], "an unknown line is also silent");
    }

    /// `turn_ended` treats every reason but `tool-calls` as a clean stop, so a
    /// step that died mid-answer is reported to the user as a finished turn.
    #[test]
    fn review_a_step_that_failed_does_not_read_as_a_finished_turn() {
        for reason in ["error", "length"] {
            let got = events(&[step_finish(reason, 10, 10)]);
            assert!(
                !got.iter().any(|event| matches!(event, HarnessEvent::TurnCompleted { .. })),
                "reason {reason:?} was reported as a completed turn: {got:?}"
            );
        }
    }

    fn obj(value: Value) -> Map<String, Value> {
        value.as_object().cloned().unwrap_or_default()
    }

    #[test]
    fn spawn_args_carry_only_the_model_and_the_autonomy() {
        let cases: Vec<(Autonomy, Option<&str>, Vec<&str>)> = vec![
            (Autonomy::Ask, None, vec!["run", "--format", "json"]),
            (Autonomy::Ask, Some(""), vec!["run", "--format", "json"]),
            (
                Autonomy::Ask,
                Some("anthropic/claude-sonnet-4"),
                vec!["run", "--format", "json", "-m", "anthropic/claude-sonnet-4"],
            ),
            (Autonomy::Full, None, vec!["run", "--format", "json", "--auto"]),
            (Autonomy::Full, Some("openai/gpt-5"), vec!["run", "--format", "json", "-m", "openai/gpt-5", "--auto"]),
        ];
        for (autonomy, model, expected) in cases {
            let case = format!("{autonomy:?} {model:?}");
            let args = build_opencode_spawn_args(&OpencodeSpawn { model: model.map(str::to_string), autonomy });
            assert_eq!(args, expected, "{case}");
        }
    }

    #[test]
    fn the_bridge_rides_in_inline_config_only_when_there_is_one() {
        assert_eq!(opencode_config(None), None);
        let config = opencode_config(Some(&("/opt/Crew App/crewd".into(), vec!["--mcp".into()])))
            .expect("config for a bridge");
        assert_eq!(
            serde_json::from_str::<Value>(&config).expect("json"),
            json!({
                "$schema": "https://opencode.ai/config.json",
                "mcp": { "crew": { "type": "local", "command": ["/opt/Crew App/crewd", "--mcp"], "enabled": true } }
            })
        );
    }

    #[test]
    fn the_prompt_is_persona_tools_tail_then_turn() {
        let persona = persona_prompt("Planner", "You keep the roadmap.", None);
        /// Tail, tool sheet, text, files, and the prompt they make.
        type Case = (Option<&'static str>, Option<&'static str>, &'static str, Vec<String>, String);
        let cases: Vec<Case> = vec![
            (None, None, "hola", vec![], format!("{persona}\n\nhola")),
            (None, Some("You have: x."), "hola", vec![], format!("{persona}\n\nYou have: x.\n\nhola")),
            (None, None, "", vec![], persona.clone()),
            (
                Some("## tail"),
                None,
                " mira ",
                vec!["/w/a.rs".into(), "/w/b.png".into()],
                format!("{persona}\n\n## tail\n\n## This turn\n\nmira\n\nAttached files:\n- /w/a.rs\n- /w/b.png"),
            ),
            (None, None, "", vec!["/w/a.rs".into()], format!("{persona}\n\nAttached files:\n- /w/a.rs")),
        ];
        for (history, tools, text, files, expected) in cases {
            assert_eq!(
                build_opencode_prompt("Planner", "You keep the roadmap.", history, text, &files, tools),
                expected,
                "history={history:?} tools={tools:?} text={text:?} files={files:?}"
            );
        }
    }

    #[test]
    fn only_a_finished_text_part_with_an_id_is_text() {
        let cases = vec![
            ("no part", json!({ "type": "text" }), None),
            ("a part that is not an object", json!({ "part": "hola" }), None),
            ("a tool part", json!({ "part": { "type": "tool", "id": "p1", "text": "x" } }), None),
            ("an empty text", json!({ "part": { "type": "text", "id": "p1", "text": "" } }), None),
            ("no id", json!({ "part": { "type": "text", "text": "hola" } }), None),
            (
                "a text part",
                json!({ "part": { "type": "text", "id": "p1", "text": " hola\n" } }),
                Some(("p1", " hola\n")),
            ),
        ];
        for (name, rec, expected) in cases {
            let got = text_part(&obj(rec)).map(|part| (part.id, part.text));
            assert_eq!(got, expected.map(|(id, text)| (id.to_string(), text.to_string())), "{name}");
        }
    }

    fn tool_part(tool: Option<&str>, state: Option<Value>) -> Value {
        let mut part = json!({ "type": "tool", "callID": "call_1" });
        if let Some(tool) = tool {
            part["tool"] = json!(tool);
        }
        if let Some(state) = state {
            part["state"] = state;
        }
        json!({ "type": "tool_use", "part": part })
    }

    #[test]
    fn a_tool_part_becomes_one_settled_row() {
        type Row = (String, String, String, Option<ToolDetail>, ToolStatus);
        let row = |name: &str, title: &str, detail: Option<ToolDetail>, status: ToolStatus| -> Option<Row> {
            Some(("call_1".into(), name.into(), title.into(), detail, status))
        };
        let cases = vec![
            ("no part", json!({ "type": "tool_use" }), None),
            ("a text part", json!({ "part": { "type": "text", "callID": "call_1" } }), None),
            ("no call id", json!({ "part": { "type": "tool", "tool": "bash" } }), None),
            ("no tool name and no state", tool_part(None, None), row("tool", "Tool", None, ToolStatus::Completed)),
            (
                "no tool name, with output",
                tool_part(None, Some(json!({ "status": "completed", "output": "done" }))),
                row("tool", "Tool", Some(ToolDetail::Output { text: "done".into() }), ToolStatus::Completed),
            ),
            (
                "a shell call with no state yet",
                tool_part(Some("bash"), None),
                row("bash", "Bash", None, ToolStatus::Completed),
            ),
            (
                "a shell call that exited non-zero",
                tool_part(
                    Some("bash"),
                    Some(json!({ "status": "completed", "input": { "command": "false" }, "metadata": { "exit": 1 } })),
                ),
                row(
                    "bash",
                    "false",
                    Some(ToolDetail::Command { command: "false".into(), exit_code: Some(1), output: None }),
                    ToolStatus::Failed,
                ),
            ),
        ];
        for (name, rec, expected) in cases {
            let got =
                parse_tool_call(&obj(rec)).map(|call| (call.call_id, call.name, call.title, call.detail, call.status));
            assert_eq!(got, expected, "{name}");
        }
    }

    #[test]
    fn a_call_failed_when_it_threw_exited_non_zero_or_was_invalid() {
        let cases = vec![
            ("bash", None, ToolStatus::Completed),
            ("bash", Some(json!({ "status": "completed" })), ToolStatus::Completed),
            ("bash", Some(json!({ "status": "completed", "metadata": { "exit": 0 } })), ToolStatus::Completed),
            ("bash", Some(json!({ "status": "completed", "metadata": { "exit": 127 } })), ToolStatus::Failed),
            ("bash", Some(json!({ "status": "completed", "metadata": { "exit": "1" } })), ToolStatus::Completed),
            ("bash", Some(json!({ "status": "completed", "metadata": "exit 1" })), ToolStatus::Completed),
            ("read", Some(json!({ "status": "error", "error": "gone" })), ToolStatus::Failed),
            ("invalid", Some(json!({ "status": "completed" })), ToolStatus::Failed),
        ];
        for (name, state, expected) in cases {
            let state = state.map(obj);
            assert_eq!(tool_status(name, state.as_ref()), expected, "{name} {state:?}");
        }
    }

    #[test]
    fn a_row_detail_comes_from_the_input_and_the_metadata() {
        let file = |path: &str, start: Option<u32>, end: Option<u32>, preview: Option<&str>| ToolDetail::File {
            path: path.into(),
            line_start: start,
            line_end: end,
            preview: preview.map(str::to_string),
        };
        let edit = |path: &str| ToolDetail::Edit { path: path.into(), added: None, removed: None };
        let output = |text: &str| ToolDetail::Output { text: text.into() };
        let cases: Vec<(&str, Value, Option<Value>, Option<ToolDetail>)> = vec![
            (
                "crew_message_agent",
                json!({ "to": "Ada", "text": "hola" }),
                Some(json!({ "status": "error", "error": "no such agent" })),
                Some(ToolDetail::Message { to: "Ada".into(), text: "hola".into() }),
            ),
            (
                "read",
                json!({ "filePath": "/nope" }),
                Some(json!({ "status": "error", "error": "File not found" })),
                Some(output("File not found")),
            ),
            ("read", json!({ "filePath": "/nope" }), Some(json!({ "status": "error" })), None),
            (
                "bash",
                json!({ "command": "ls" }),
                Some(json!({ "output": "state out", "metadata": { "exit": 0, "output": "  meta out" } })),
                Some(ToolDetail::Command {
                    command: "ls".into(),
                    exit_code: Some(0),
                    output: Some("  meta out".into()),
                }),
            ),
            (
                "bash",
                json!({ "command": "ls" }),
                Some(json!({ "output": "state out", "metadata": { "output": "" } })),
                Some(ToolDetail::Command { command: "ls".into(), exit_code: None, output: Some("state out".into()) }),
            ),
            ("bash", json!({}), Some(json!({ "output": "x" })), None),
            (
                "read",
                json!({ "filePath": "have.txt" }),
                Some(json!({ "metadata": {
                    "preview": "meta preview",
                    "display": { "path": "/w/have.txt", "text": "display text", "lineStart": 4, "lineEnd": 6 }
                } })),
                Some(file("/w/have.txt", Some(4), Some(6), Some("meta preview"))),
            ),
            (
                "read",
                json!({ "filePath": "have.txt" }),
                Some(json!({ "metadata": { "display": { "text": "display text", "lineStart": -1 } } })),
                Some(file("have.txt", None, None, Some("display text"))),
            ),
            ("read", json!({ "filePath": "have.txt" }), None, Some(file("have.txt", None, None, None))),
            ("read", json!({}), Some(json!({ "metadata": { "display": {} } })), None),
            (
                "write",
                json!({ "filePath": "a.txt" }),
                Some(json!({ "metadata": { "filepath": "/w/a.txt" } })),
                Some(edit("/w/a.txt")),
            ),
            ("edit", json!({ "filePath": "/w/b.txt" }), None, Some(edit("/w/b.txt"))),
            ("patch", json!({ "filePath": "/w/c.txt" }), Some(json!({ "metadata": {} })), Some(edit("/w/c.txt"))),
            ("write", json!({ "content": "x" }), None, None),
            (
                "grep",
                json!({ "pattern": "TODO" }),
                Some(json!({ "metadata": { "matches": 3 } })),
                Some(ToolDetail::Search { query: "TODO".into(), matches: Some(3) }),
            ),
            (
                "glob",
                json!({ "pattern": "**/*.rs" }),
                Some(json!({ "metadata": { "matches": "many" } })),
                Some(ToolDetail::Search { query: "**/*.rs".into(), matches: None }),
            ),
            ("grep", json!({ "path": "/w" }), None, None),
            (
                "webfetch",
                json!({ "url": "https://example.com", "format": "markdown" }),
                Some(json!({ "output": "# Example" })),
                Some(ToolDetail::Fetch { url: "https://example.com".into(), title: None }),
            ),
            ("webfetch", json!({ "format": "markdown" }), None, None),
            ("todowrite", json!({}), Some(json!({ "output": "  2 todos" })), Some(output("  2 todos"))),
            ("todowrite", json!({}), Some(json!({ "output": "" })), None),
            ("task", json!({}), None, None),
        ];
        for (name, input, state, expected) in cases {
            let state = state.map(obj);
            assert_eq!(tool_detail(name, &obj(input.clone()), state.as_ref()), expected, "{name} {input} {state:?}");
        }
    }

    #[test]
    fn a_row_title_names_what_the_call_did() {
        let cases: Vec<(&str, Value, String)> = vec![
            ("crew_message_agent", json!({ "to": "Cuddles", "text": "hi" }), "Crew message agent Cuddles".into()),
            ("crew.spawn_agent", json!({ "name": "Planner" }), "Crew spawn agent Planner".into()),
            ("mcp__crew__search_messages", json!({ "query": "invoice" }), "Crew search messages invoice".into()),
            ("crew_list_agents", json!({}), "Crew list agents".into()),
            ("crew_message_agent", json!({ "to": "ö".repeat(45) }), format!("Crew message agent {}…", "ö".repeat(39))),
            ("bash", json!({ "command": "sleep 3 && ls\necho done" }), "sleep 3 && ls".into()),
            ("bash", json!({ "command": "y".repeat(90) }), format!("{}…", "y".repeat(71))),
            ("read", json!({ "filePath": "/w/have.txt", "pattern": "x" }), "Read have.txt".into()),
            ("list", json!({ "path": "/w/src/" }), "List /w/src/".into()),
            ("grep", json!({ "pattern": "TODO" }), "Grep TODO".into()),
            (
                "webfetch",
                json!({ "url": "https://example.com/a/very/long/path/that/goes/on" }),
                "Fetch https://example.com/a/very/long/path/th…".into(),
            ),
            ("task", json!({ "description": "explore the repo" }), "Task explore the repo".into()),
            ("todowrite", json!({ "todos": [] }), "Todo".into()),
            ("todoread", json!({}), "Todo".into()),
            ("", json!({}), "Tool".into()),
        ];
        for (name, input, expected) in cases {
            assert_eq!(tool_label(name, &obj(input.clone())), expected, "{name} {input}");
        }
    }

    #[test]
    fn a_tool_name_is_capitalized_unless_it_has_a_better_one() {
        let cases = [
            ("webfetch", "Fetch"),
            ("todowrite", "Todo"),
            ("todoread", "Todo"),
            ("bash", "Bash"),
            ("Read", "Read"),
            ("ñandú", "Ñandú"),
            ("ß", "SS"),
            ("", "Tool"),
        ];
        for (name, expected) in cases {
            assert_eq!(pretty_tool(name), expected, "pretty_tool({name:?})");
        }
    }

    #[test]
    fn only_a_step_that_called_tools_keeps_the_turn_going() {
        let step = |reason: Option<&str>| match reason {
            Some(reason) => json!({ "type": "step_finish", "part": { "type": "step-finish", "reason": reason } }),
            None => json!({ "type": "step_finish", "part": { "type": "step-finish" } }),
        };
        let cases = vec![
            (json!({ "type": "step_finish" }), None, true),
            (step(None), None, true),
            (step(Some("stop")), None, true),
            (step(Some("tool-calls")), None, false),
            (step(Some("length")), Some("The model ran out of room mid-answer."), true),
            (step(Some("content-filter")), Some("The provider stopped the answer."), true),
            (step(Some("error")), Some("The turn ended early: error."), true),
        ];
        for (rec, failure, ended) in cases {
            let rec_map = obj(rec.clone());
            assert_eq!(step_failure(&rec_map).as_deref(), failure, "step_failure {rec}");
            assert_eq!(turn_ended(&rec_map), ended, "turn_ended {rec}");
        }
    }

    #[test]
    fn step_usage_adds_up_and_ignores_what_is_not_a_count() {
        let usage = |input, output, cost: f64| TurnUsage {
            input_tokens: Some(input),
            output_tokens: Some(output),
            cost_usd: Some(cost),
            duration_ms: None,
        };
        let prev = usage(100, 10, 0.5);
        let cases = vec![
            ("no part, nothing before", None, json!({ "type": "step_finish" }), usage(0, 0, 0.0)),
            ("no part keeps what came before", Some(&prev), json!({}), usage(100, 10, 0.5)),
            (
                "a step on top of another",
                Some(&prev),
                json!({ "part": {
                    "tokens": { "input": 5, "output": 6, "reasoning": 7, "cache": { "read": 8, "write": 9 } },
                    "cost": 0.25
                } }),
                usage(122, 23, 0.75),
            ),
            (
                "negative and non-numeric counts are zero",
                None,
                json!({ "part": { "tokens": { "input": -5, "output": "6", "cache": "none" }, "cost": "free" } }),
                usage(0, 0, 0.0),
            ),
        ];
        for (name, prev, rec, expected) in cases {
            assert_eq!(add_step_usage(prev, &obj(rec)), expected, "{name}");
        }
    }

    #[test]
    fn a_stream_error_says_the_most_specific_thing_it_has() {
        let cases = vec![
            (
                json!({ "error": { "name": "ProviderAuthError", "data": { "message": "no credentials" } } }),
                "no credentials",
            ),
            (json!({ "error": { "name": "ProviderAuthError", "data": { "message": " " } } }), "ProviderAuthError"),
            (json!({ "error": { "name": "UnknownError", "data": "text" } }), "UnknownError"),
            (json!({ "error": {} }), "opencode turn failed."),
            (json!({ "error": "boom" }), "opencode turn failed."),
            (json!({ "type": "error" }), "opencode turn failed."),
        ];
        for (rec, expected) in cases {
            assert_eq!(stream_error_message(&obj(rec.clone())), expected, "{rec}");
        }
        assert_eq!(session_id_from_event(&obj(json!({ "sessionID": "ses_1" }))).as_deref(), Some("ses_1"));
        assert_eq!(session_id_from_event(&obj(json!({ "sessionId": "ses_1" }))), None);
    }
}
