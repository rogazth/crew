use std::collections::HashMap;

use serde::{Deserialize, Serialize};
use ts_rs::TS;

use crate::{BotRef, ApprovalDecision, AttachedFile, HarnessEvent, Session};

#[derive(Serialize, Deserialize, Clone, Debug, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../../src/lib/protocol.ts", rename_all = "camelCase")]
pub struct TurnStart {
    pub session_id: String,
    pub cwd: String,
    pub text: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub files: Option<Vec<AttachedFile>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub mentions: Option<Vec<String>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub hidden: Option<bool>,
    /// Set when this turn is another bot's message, not yours.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub from_bot: Option<BotRef>,
    /// When the letter was written, which is not when it was handed over: one
    /// that waited in a busy bot's box still says when it was written.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional, type = "number")]
    pub sent_at: Option<i64>,
    /// One id per Enter, replayed unchanged by a retry. The daemon accepts it
    /// once; a second arrival is answered without starting a second turn.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub nonce: Option<String>,
    /// The letter this turn hands over, already in the mailbox and claimed:
    /// the transcript's block carries its id, and the turn's end marks it
    /// delivered. The daemon's own; a window's is ignored.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub letter_id: Option<String>,
    /// What a message sent while a turn runs becomes: `steer` (into the
    /// running turn), `queue` (the turn after it), or `auto` (the daemon
    /// decides). Absent is `auto`, and a message sent to an idle session
    /// starts a turn whatever it says.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional, type = "\"auto\" | \"steer\" | \"queue\"")]
    pub mode: Option<String>,
}

#[derive(Serialize, Deserialize, Clone, Debug, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../../src/lib/protocol.ts", rename_all = "camelCase")]
pub struct TurnStarted {
    pub working: bool,
    /// How the message was handed over: `started` (a turn of its own),
    /// `steered` (into the running turn) or `queued` (after it).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional, type = "\"started\" | \"steered\" | \"queued\"")]
    pub delivery: Option<String>,
    /// The letter the message became, when it was sent as one.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub letter_id: Option<String>,
}

/// Sends a queued letter now: it goes to the head of the queue, a running
/// turn is stopped, and a turn begins with it.
#[derive(Serialize, Deserialize, Clone, Debug, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../../src/lib/protocol.ts", rename_all = "camelCase")]
pub struct TurnSendNow {
    pub session_id: String,
    pub letter_id: String,
}

#[derive(Serialize, Deserialize, Clone, Debug, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../../src/lib/protocol.ts", rename_all = "camelCase")]
pub struct TurnRespond {
    pub session_id: String,
    #[ts(type = "number")]
    pub request_id: u64,
    pub decision: ApprovalDecision,
}

#[derive(Serialize, Deserialize, Clone, Debug, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../../src/lib/protocol.ts", rename_all = "camelCase")]
pub struct TurnAnswer {
    pub session_id: String,
    #[ts(type = "number")]
    pub request_id: u64,
    pub answers: Option<HashMap<String, String>>,
}

#[derive(Serialize, Deserialize, Clone, Debug, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../../src/lib/protocol.ts", rename_all = "camelCase")]
pub struct TranscriptApply {
    pub session_id: String,
    #[ts(type = "number")]
    pub seq: u64,
    pub event: HarnessEvent,
}

#[derive(Serialize, Deserialize, Clone, Debug, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../../src/lib/protocol.ts", rename_all = "camelCase")]
pub struct SessionStatusEvent {
    pub session_id: String,
    pub status: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub provider_session_id: Option<String>,
    #[ts(type = "number")]
    pub updated_at: i64,
}

#[derive(Serialize, Deserialize, Clone, Debug, TS)]
#[ts(export, export_to = "../../../src/lib/protocol.ts")]
pub struct SessionCreated {
    pub session: Session,
    /// The window opens its tab behind the one on screen, so its CLI starts
    /// on the task it was handed.
    #[serde(default)]
    pub open: bool,
}

/// A session's row changed outside the window's hands: a terminal Claude
/// moved to another conversation, renamed for it.
#[derive(Serialize, Deserialize, Clone, Debug, TS)]
#[ts(export, export_to = "../../../src/lib/protocol.ts")]
pub struct SessionUpdated {
    pub session: Session,
}

/// Sessions the daemon deleted on its own: untouched longer than Settings keeps them.
#[derive(Serialize, Deserialize, Clone, Debug, TS)]
#[ts(export, export_to = "../../../src/lib/protocol.ts")]
pub struct SessionsDeleted {
    pub ids: Vec<String>,
}

/// How many days untouched a session outlives, for `sessions_stale` and `sessions_expire`.
#[derive(Serialize, Deserialize, Clone, Debug, TS)]
#[ts(export, export_to = "../../../src/lib/protocol.ts")]
pub struct SessionsRetention {
    pub days: u32,
}

#[cfg(test)]
mod tests {
    use super::*;

    /// How a message was handed over goes on the wire under camel-case names,
    /// and only when there is one to say.
    #[test]
    fn a_turn_started_names_its_delivery_and_letter_in_camel_case() {
        let steered = TurnStarted { working: true, delivery: Some("steered".into()), letter_id: Some("l1".into()) };
        assert_eq!(
            serde_json::to_value(&steered).expect("json"),
            serde_json::json!({ "working": true, "delivery": "steered", "letterId": "l1" })
        );
        let plain = TurnStarted { working: false, delivery: None, letter_id: None };
        assert_eq!(serde_json::to_value(&plain).expect("json"), serde_json::json!({ "working": false }));
    }
}
