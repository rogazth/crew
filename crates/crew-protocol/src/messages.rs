use serde::{Deserialize, Serialize};
use ts_rs::TS;

use crate::{Block, BlockRole};

/// A window of a transcript. `more` says whether older blocks exist before
/// `fromPos`, so the UI knows whether to keep a "load earlier" affordance.
#[derive(Serialize, Deserialize, Clone, Debug, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../../src/lib/protocol.ts", rename_all = "camelCase")]
pub struct MessagePage {
    pub blocks: Vec<Block>,
    #[ts(type = "number")]
    pub from_pos: i64,
    #[ts(type = "number")]
    pub to_pos: i64,
    pub more: bool,
}

#[derive(Serialize, Deserialize, Clone, Debug, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../../src/lib/protocol.ts", rename_all = "camelCase")]
pub struct SearchHit {
    pub session_id: String,
    pub session_name: String,
    #[ts(type = "number")]
    pub pos: i64,
    pub id: String,
    pub role: BlockRole,
    #[ts(type = "number")]
    pub at: i64,
    /// The matching line with the hit marked, from FTS5's own snippet().
    pub snippet: String,
}

#[derive(Serialize, Deserialize, Clone, Debug, Default, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../../src/lib/protocol.ts", rename_all = "camelCase")]
pub struct SearchQuery {
    pub query: String,
    /// Empty means every session.
    #[serde(default)]
    pub session_ids: Vec<String>,
    #[serde(default)]
    #[ts(optional, type = "number")]
    pub from: Option<i64>,
    #[serde(default)]
    #[ts(optional, type = "number")]
    pub to: Option<i64>,
    #[serde(default)]
    #[ts(optional, type = "number")]
    pub limit: Option<u32>,
    /// Skip this many hits. Paging a search is rare, so an offset beats a
    /// cursor that would have to encode a bm25 score.
    #[serde(default)]
    #[ts(optional, type = "number")]
    pub offset: Option<u32>,
}

#[derive(Serialize, Deserialize, Clone, Debug, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../../src/lib/protocol.ts", rename_all = "camelCase")]
pub struct TranscriptTail {
    pub session_id: String,
    #[serde(default)]
    #[ts(optional, type = "number")]
    pub limit: Option<u32>,
    /// Page backwards: the position the last page started at.
    #[serde(default)]
    #[ts(optional, type = "number")]
    pub before_pos: Option<i64>,
}

#[derive(Serialize, Deserialize, Clone, Debug, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../../src/lib/protocol.ts", rename_all = "camelCase")]
pub struct TranscriptSince {
    pub session_id: String,
    #[ts(type = "number")]
    pub pos: i64,
}
