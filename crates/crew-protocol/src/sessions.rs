//! Changes to a session that the window asks of the daemon.

use serde::{Deserialize, Serialize};
use ts_rs::TS;

/// A session nobody has talked to yet moves to another provider's CLI.
#[derive(Serialize, Deserialize, Clone, Debug, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../../src/lib/protocol.ts", rename_all = "camelCase")]
pub struct SessionSwitchProvider {
    pub id: String,
    pub provider: String,
    pub model: String,
    pub effort: String,
    /// Codex's service tier; empty is the CLI's own.
    #[serde(default)]
    pub service_tier: String,
    pub autonomy: String,
}
