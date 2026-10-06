//! A session's CLI seen from outside: what its hooks say it is doing, and its
//! own history read back as the chat's blocks.

use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use ts_rs::TS;

use crate::{Block, Question};

/// What a session's CLI is doing, as its hooks told crewd. Pushed as
/// `session-live` whenever it changes.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../../src/lib/protocol.ts", rename_all = "camelCase")]
pub struct SessionLive {
    pub session_id: String,
    /// The CLI's SessionStart hook ran: it is up and reads keys.
    pub started: bool,
    /// A turn is running: from the prompt being submitted until it stops.
    pub working: bool,
    /// The last turn stopped with work it started still running in the
    /// background (a shell, a subagent): the CLI takes it up again on its own
    /// when that work reports back, so the session is not done. Missing from
    /// a crewd that predates it.
    #[serde(default)]
    pub background: bool,
    /// What the last turn left running, as its Stop hook named it: read-only,
    /// since only the CLI in the terminal can stop it.
    #[serde(default)]
    pub background_tasks: Vec<crate::BackgroundCommand>,
    /// Something the CLI stopped to ask; answered by keys in its terminal.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub ask: Option<SessionAsk>,
    /// The conversation the CLI is in now, and the file it writes it to.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub provider_session_id: Option<String>,
    #[ts(type = "number")]
    pub updated_at: i64,
}

/// A permission prompt or a question form on the CLI's screen.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../../src/lib/protocol.ts", rename_all = "camelCase")]
pub struct SessionAsk {
    /// New for every ask, so an answer is never taken for the next one's.
    #[ts(type = "number")]
    pub id: u64,
    pub tool: String,
    #[ts(type = "Record<string, unknown>")]
    pub input: Map<String, Value>,
    /// The form's questions; empty for a permission.
    pub questions: Vec<Question>,
    /// The prompt offers "don't ask again" as its second option.
    pub always: bool,
}

/// The chat answered ask `ask_id` with keys.
#[derive(Serialize, Deserialize, Clone, Debug, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../../src/lib/protocol.ts", rename_all = "camelCase")]
pub struct SessionLiveAnswered {
    pub id: String,
    #[ts(type = "number")]
    pub ask_id: u64,
}

#[derive(Serialize, Deserialize, Clone, Debug, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../../src/lib/protocol.ts", rename_all = "camelCase")]
pub struct SessionHistoryRequest {
    pub id: String,
    /// Where the session runs; the CLI files its history under it.
    pub cwd: String,
    /// A page of the blocks before this index; the newest page when absent.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional, type = "number")]
    pub before: Option<i64>,
}

/// How far crewd got reading a session's history.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../../src/lib/protocol.ts", rename_all = "camelCase")]
pub enum HistoryState {
    /// The CLI has not written its file yet.
    Pending,
    Ready,
    /// The file is there with messages in it, and none could be read.
    Error,
}

#[derive(Serialize, Deserialize, Clone, Debug, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../../src/lib/protocol.ts", rename_all = "camelCase")]
pub struct SessionHistoryWindow {
    pub blocks: Vec<Block>,
    /// The index of `blocks[0]`; indices go below zero as earlier pages load.
    #[ts(type = "number")]
    pub start: i64,
    /// Older blocks exist before `start`.
    pub more: bool,
    pub state: HistoryState,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub error: Option<String>,
}

/// New or changed blocks at the end of a session's history, while a chat reads it.
#[derive(Serialize, Deserialize, Clone, Debug, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../../src/lib/protocol.ts", rename_all = "camelCase")]
pub struct SessionHistoryAppended {
    pub session_id: String,
    /// Every block from this index on is replaced by `blocks`.
    #[ts(type = "number")]
    pub from: i64,
    pub blocks: Vec<Block>,
    /// The history was read again from scratch (another file, or it shrank): reload the window.
    pub reset: bool,
    pub state: HistoryState,
}
