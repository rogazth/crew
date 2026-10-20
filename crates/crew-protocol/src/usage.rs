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

/// The most an account's longest window stood at on a day (UTC, `YYYY-MM-DD`).
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../../src/lib/protocol.ts", rename_all = "camelCase")]
pub struct UsageDay {
    pub provider: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub account: Option<String>,
    pub day: String,
    pub percent: f64,
}

/// Every reading this machine holds, and seven days of history.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../../src/lib/protocol.ts", rename_all = "camelCase")]
pub struct UsageSnapshot {
    pub readings: Vec<PlanUsage>,
    pub history: Vec<UsageDay>,
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
