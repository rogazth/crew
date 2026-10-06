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
    /// stopped. Once it is gone they stay, ended, until the next turn.
    pub live: bool,
    /// The turn has answered, and only its background commands keep it open:
    /// the CLI takes it up again when they finish.
    pub waiting: bool,
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
