use serde::{Deserialize, Serialize};
use ts_rs::TS;

/// One limit of a plan: a share of a rolling window, spent so far.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../../src/lib/protocol.ts", rename_all = "camelCase")]
pub struct UsageWindow {
    /// Stable within a provider: `five_hour`, `seven_day`, `primary`, `cycle`.
    pub id: String,
    /// What the window is called on screen: "5 hours", "Weekly", "Monthly".
    pub label: String,
    /// Share used, 0 to 100.
    pub used_percent: f64,
    /// The window's whole length, when the provider says.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional, type = "number")]
    pub window_minutes: Option<i64>,
    /// When it resets, in milliseconds since the epoch.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional, type = "number")]
    pub resets_at: Option<i64>,
}

/// What one provider account has spent of its plan, as last read.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../../src/lib/protocol.ts", rename_all = "camelCase")]
pub struct PlanUsage {
    pub provider: String,
    /// The account's email (or id), so a client can tell that two machines
    /// read the same account.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub account: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub plan: Option<String>,
    pub windows: Vec<UsageWindow>,
    /// Tokens spent over the last seven days, for a provider with no plan windows (opencode).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional, type = "number")]
    pub tokens: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub cost: Option<f64>,
    /// When it was read, in milliseconds since the epoch.
    #[ts(type = "number")]
    pub updated_at: i64,
    /// Where it came from: `stream`, `app-server`, `api` or `cli`.
    pub source: String,
    /// Claude's own verdict on the plan limit (`allowed`, `allowed_warning`, `rejected`).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub status: Option<String>,
    /// The same for the overage (extra usage) allowance.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub overage_status: Option<String>,
}

/// What one model of a provider spent on a day, on the calendar of the machine
/// that read it. `input` never includes what the cache served.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../../src/lib/protocol.ts", rename_all = "camelCase")]
pub struct UsageTokens {
    pub provider: String,
    pub day: String,
    pub model: String,
    #[ts(type = "number")]
    pub input: u64,
    #[ts(type = "number")]
    pub output: u64,
    #[ts(type = "number")]
    pub cache_write: u64,
    #[ts(type = "number")]
    pub cache_read: u64,
}

/// Every reading this machine holds, and the tokens of the days it keeps.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../../src/lib/protocol.ts", rename_all = "camelCase")]
pub struct UsageSnapshot {
    pub readings: Vec<PlanUsage>,
    #[serde(default)]
    pub tokens: Vec<UsageTokens>,
}

/// `usage_read`. With `refresh`, the CLIs are asked again first.
#[derive(Serialize, Deserialize, Clone, Debug, Default, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../../src/lib/protocol.ts", rename_all = "camelCase")]
pub struct UsageRead {
    #[serde(default)]
    #[ts(optional)]
    pub refresh: Option<bool>,
}
