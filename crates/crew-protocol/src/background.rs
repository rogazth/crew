//! Background commands: what a session's CLI left running while its turn
//! went on (a shell started with `run_in_background`, a Monitor, a subagent
//! sent to the background, a Codex terminal that outlived its call).

use serde::{Deserialize, Serialize};
use ts_rs::TS;

#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../../src/lib/protocol.ts", rename_all = "camelCase")]
pub enum BackgroundKind {
    Shell,
    Monitor,
    Subagent,
}

#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../../src/lib/protocol.ts", rename_all = "camelCase")]
pub enum BackgroundState {
    Running,
    Completed,
    Failed,
    Stopped,
}

/// One command left running in the background, running or ended.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../../src/lib/protocol.ts", rename_all = "camelCase")]
pub struct BackgroundCommand {
    /// The CLI's own id for it: Claude's task id, Codex's item id, the hook's id.
    pub id: String,
    /// What runs: the shell command, or a subagent's description.
    pub command: String,
    /// What the model said it is for, when that is not the command itself.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub description: Option<String>,
    pub kind: BackgroundKind,
    #[ts(type = "number")]
    pub started_at: i64,
    pub state: BackgroundState,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub exit_code: Option<i32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional, type = "number")]
    pub ended_at: Option<i64>,
    /// The tool call that started it: where the transcript marks it.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub tool_call_id: Option<String>,
    /// Tokens it has used so far, for a subagent. Absent when the CLI does not
    /// report them, so the panel shows nothing rather than a zero.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional, type = "number")]
    pub tokens: Option<u64>,
    /// The context window of its model, to show `tokens` as a share of it.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional, type = "number")]
    pub window: Option<u64>,
    /// Whether it can be stopped on its own. Absent is unknown, which is not
    /// the same as false: a row never offers a stop it cannot confirm.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub stoppable: Option<bool>,
    /// Why it cannot be stopped alone, shown where the stop would be, such as
    /// "stops with the turn". On a stopped entry, why it stopped when nobody
    /// asked it to: "its CLI exited", "Crew restarted".
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub stop_note: Option<String>,
    /// Its latest step, kept short: the tool it last used or the line it last
    /// wrote. A running row shows this so it is not silent while it works.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub activity: Option<String>,
    /// The model a subagent runs on.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub model: Option<String>,
    /// The reasoning effort a subagent runs at, as its CLI spells it, when
    /// the CLI says: Codex's `reasoningEffort`, opencode's model variant.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub effort: Option<String>,
    /// A subagent the turn is still waiting on, as opposed to one sent to the
    /// background. A foreground one ends with the turn that started it.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub foreground: Option<bool>,
    /// The Codex child thread a subagent runs in, so a stop or a read can
    /// address that thread rather than the parent's.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub thread_id: Option<String>,
}

/// Clears a session's ended background commands from its list. Absent `ids`
/// clears all of them; a running command is never cleared, since it would
/// vanish from the list while its process still runs. `hide` names the ended
/// Crew children and process runs the panel is to leave off as well: they are
/// not commands of the list, so it only keeps their keys.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../../src/lib/protocol.ts", rename_all = "camelCase")]
pub struct BackgroundClear {
    pub session_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub ids: Option<Vec<String>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub hide: Option<Vec<String>>,
}

/// A session's background commands. Pushed as `background-changed` whenever
/// it changes, and answered by `background_list`.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../../src/lib/protocol.ts", rename_all = "camelCase")]
pub struct BackgroundList {
    pub session_id: String,
    pub commands: Vec<BackgroundCommand>,
    /// The CLI that runs them is up: their output can be read and they can be
    /// stopped. Once it is gone they stay, ended, until they are cleared.
    pub live: bool,
    /// The turn has answered, and only its background commands keep it open:
    /// the CLI takes it up again when they finish.
    pub waiting: bool,
    /// The keys of the ended Crew children and process runs the user cleared
    /// from the panel, oldest first. Kept with the session, so every window
    /// leaves them off after a reload.
    #[serde(default)]
    pub hidden: Vec<String>,
}

/// One background command of a session, for `background_output` and
/// `background_stop`.
#[derive(Serialize, Deserialize, Clone, Debug, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../../src/lib/protocol.ts", rename_all = "camelCase")]
pub struct BackgroundRequest {
    pub session_id: String,
    pub id: String,
}

/// The end of a background command's output.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../../src/lib/protocol.ts", rename_all = "camelCase")]
pub struct BackgroundOutput {
    /// Plain text, escape sequences included; empty when it wrote nothing yet.
    pub output: String,
    /// Only the end of a longer output.
    pub truncated: bool,
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A command from a daemon that predates the panel reads its new fields as
    /// unknown, and writes none of them back.
    #[test]
    fn a_background_command_without_the_panel_fields_reads_them_as_unknown() {
        let raw = r#"{"id":"t1","command":"npm run dev","kind":"shell","startedAt":1,"state":"running"}"#;
        let row: BackgroundCommand = serde_json::from_str(raw).expect("command");
        assert_eq!(serde_json::to_string(&row).expect("json"), raw);
        assert_eq!(
            (row.tokens, row.window, row.stoppable, row.stop_note, row.activity),
            (None, None, None, None, None)
        );
        assert_eq!((row.model, row.foreground, row.thread_id), (None, None, None));
    }

    /// A subagent with every panel field set names them in camel case and
    /// reads back unchanged, a refused stop (`false`) included.
    #[test]
    fn a_background_subagent_round_trips_its_panel_fields() {
        let row = BackgroundCommand {
            id: "toolu_1".into(),
            command: "Explore the parser".into(),
            description: None,
            kind: BackgroundKind::Subagent,
            started_at: 1,
            state: BackgroundState::Running,
            exit_code: None,
            ended_at: None,
            tool_call_id: Some("toolu_1".into()),
            tokens: Some(12_000),
            window: Some(200_000),
            stoppable: Some(false),
            stop_note: Some("stops with the turn".into()),
            activity: Some("Grep".into()),
            model: Some("claude-haiku-5-5".into()),
            effort: None,
            foreground: Some(true),
            thread_id: Some("th_child".into()),
        };
        let wire = serde_json::to_value(&row).expect("json");
        assert_eq!(wire["tokens"], serde_json::json!(12_000));
        assert_eq!(wire["stopNote"], serde_json::json!("stops with the turn"));
        assert_eq!(wire["stoppable"], serde_json::json!(false));
        assert_eq!(wire["threadId"], serde_json::json!("th_child"));
        assert_eq!(serde_json::from_value::<BackgroundCommand>(wire).expect("command"), row);
    }

    /// Clearing without `ids` names no ids on the wire, and with them names
    /// the ones to clear.
    #[test]
    fn a_background_clear_names_its_ids_only_when_given() {
        let all: BackgroundClear = serde_json::from_str(r#"{"sessionId":"s1"}"#).expect("clear");
        assert_eq!(all.ids, None);
        assert_eq!(serde_json::to_string(&all).expect("json"), r#"{"sessionId":"s1"}"#);
        let some = BackgroundClear { session_id: "s1".into(), ids: Some(vec!["t1".into()]), hide: None };
        assert_eq!(
            serde_json::to_value(&some).expect("json"),
            serde_json::json!({ "sessionId": "s1", "ids": ["t1"] })
        );
        let hide = BackgroundClear { session_id: "s1".into(), ids: None, hide: Some(vec!["session:c1@5".into()]) };
        assert_eq!(
            serde_json::to_value(&hide).expect("json"),
            serde_json::json!({ "sessionId": "s1", "hide": ["session:c1@5"] })
        );
    }

    /// A list from a daemon that kept no cleared keys reads as having none.
    #[test]
    fn a_background_list_reads_without_hidden_keys() {
        let bare: BackgroundList =
            serde_json::from_str(r#"{"sessionId":"s1","commands":[],"live":false,"waiting":false}"#).expect("list");
        assert!(bare.hidden.is_empty());
        let some = BackgroundList { hidden: vec!["process:p1:@3".into()], ..bare };
        assert_eq!(serde_json::to_value(&some).expect("json")["hidden"], serde_json::json!(["process:p1:@3"]));
    }
}
