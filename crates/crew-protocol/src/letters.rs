//! Letters between sessions as the window reads them: the threads, one per
//! pair, and what waits in a box.
//!
//! The user is a party too (they write to a bot's child, and start sessions
//! from the `crew` command line): a [`BotRef`] with kind `user` and an empty
//! id. Where a request names a party by id, `""` or `"user"` is the user.

use serde::{Deserialize, Serialize};
use ts_rs::TS;

use crate::BotRef;

/// One letter: who wrote it to whom, and where it is in its life.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../../src/lib/protocol.ts", rename_all = "camelCase")]
pub struct ThreadLetter {
    /// The id a transcript block (`letterId`) and a tool row's message
    /// detail (`letterId`) carry.
    pub id: String,
    /// Kind absent: a bot; `session`, `terminal`, or `user`. The id is empty
    /// for the user, and for a sender deleted since.
    pub from: BotRef,
    pub to: BotRef,
    #[ts(type = "\"message\" | \"report\" | \"question\" | \"approval\"")]
    pub kind: String,
    pub text: String,
    #[ts(type = "number")]
    pub at: i64,
    /// `pending` (waiting in the box), `claimed` (a turn carries it, or it was
    /// written into a running turn and not read yet), `delivered`, or
    /// `disposed` (set aside unread: answered some other way, or its reader
    /// exited).
    #[ts(type = "\"pending\" | \"claimed\" | \"delivered\" | \"disposed\"")]
    pub state: String,
}

/// A pair a session's Conversations menu lists.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../../src/lib/protocol.ts", rename_all = "camelCase")]
pub struct ThreadPair {
    /// The other party, when the session asked about is one of the two.
    /// Otherwise one of the pair: the user, writing to the session's child.
    pub peer: BotRef,
    /// The second party, when the session asked about is not in the pair
    /// (the child the user wrote to); absent when it is.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub with: Option<BotRef>,
    /// The newest letter, its text cut to a preview.
    pub last: ThreadLetter,
    /// Letters in the thread, both ways.
    #[ts(type = "number")]
    pub count: i64,
}

/// A page of one pair's thread, oldest first.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../../src/lib/protocol.ts", rename_all = "camelCase")]
pub struct ThreadPage {
    pub letters: Vec<ThreadLetter>,
    /// Older letters exist before the first one.
    pub more: bool,
}

#[derive(Serialize, Deserialize, Clone, Debug, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../../src/lib/protocol.ts", rename_all = "camelCase")]
pub struct ThreadMessagesRequest {
    /// Either party, by session id; `""` or `"user"` is the user.
    pub a: String,
    pub b: String,
    /// A letter id: the page ends just before it.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub before: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub limit: Option<u32>,
    /// The chat asking: the window routes the call to the daemon that holds
    /// it, since `a` and `b` may both be the user. Unused by crewd.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub session_id: Option<String>,
}

/// A session's box changed: a letter arrived, was handed to a turn, went
/// back, was delivered or set aside. Pushed as `mailbox-changed`.
#[derive(Serialize, Deserialize, Clone, Debug, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../../src/lib/protocol.ts", rename_all = "camelCase")]
pub struct MailboxChanged {
    pub session_id: String,
}

/// The user has read a session up to `cursor`; absent, up to its last event.
#[derive(Serialize, Deserialize, Clone, Debug, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../../src/lib/protocol.ts", rename_all = "camelCase")]
pub struct SessionMarkSeen {
    pub id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional, type = "number")]
    pub cursor: Option<i64>,
}
