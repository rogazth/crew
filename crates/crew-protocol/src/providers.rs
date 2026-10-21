//! Jobs a machine's daemon runs on its own agent CLIs (install, update,
//! sign out) and the sign-in flows it hosts.

use serde::{Deserialize, Serialize};
use ts_rs::TS;

#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq, TS)]
#[serde(rename_all = "lowercase")]
#[ts(export, export_to = "../../../src/lib/protocol.ts", rename_all = "lowercase")]
pub enum ProviderJobAction {
    Install,
    Update,
    Reinstall,
    Uninstall,
    /// Sign out. Not offered for opencode, whose logout asks which account.
    Logout,
}

/// How a CLI is put on, or taken off, a machine.
#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq, TS)]
#[serde(rename_all = "lowercase")]
#[ts(export, export_to = "../../../src/lib/protocol.ts", rename_all = "lowercase")]
pub enum ProviderJobMethod {
    Npm,
    Brew,
    /// The vendor's install script.
    Script,
    /// The CLI's own updater (`claude update`, `opencode upgrade`). Update only.
    Native,
}

#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq, TS)]
#[serde(rename_all = "lowercase")]
#[ts(export, export_to = "../../../src/lib/protocol.ts", rename_all = "lowercase")]
pub enum ProviderJobPhase {
    Running,
    Done,
    Failed,
    Cancelled,
}

/// `provider_job_start`. Without `method`, an update uses the CLI's own
/// updater and the rest follow how the installed CLI got there (a first
/// install uses the vendor's script, or npm for Codex).
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../../src/lib/protocol.ts", rename_all = "camelCase")]
pub struct ProviderJobStart {
    /// `claude`, `codex`, `cursor`, `opencode`, `grok`.
    pub provider: String,
    pub action: ProviderJobAction,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub method: Option<ProviderJobMethod>,
}

/// `provider_job_cancel`: kills the job's process group.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../../src/lib/protocol.ts", rename_all = "camelCase")]
pub struct ProviderJobCancel {
    pub id: String,
}

/// One job, as `provider_job_start` and `provider_job_list` answer and as the
/// `provider-job` event carries it on every change.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../../src/lib/protocol.ts", rename_all = "camelCase")]
pub struct ProviderJob {
    pub id: String,
    pub provider: String,
    pub action: ProviderJobAction,
    /// The method the job resolved to.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub method: Option<ProviderJobMethod>,
    pub phase: ProviderJobPhase,
    /// What it is doing: `Uninstalling`, `Installing`, `Updating`, ...
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub step: Option<String>,
    /// The shell command now running, or the one that failed.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub command: Option<String>,
    /// The tail of its output (stdout and stderr), oldest first.
    pub last_lines: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub error: Option<String>,
    #[ts(type = "number")]
    pub started_at: i64,
}

/// `provider_login` / `provider_login_start` / `provider_login_cancel`.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../../src/lib/protocol.ts", rename_all = "camelCase")]
pub struct ProviderRef {
    pub provider: String,
}

/// What to type in a terminal tab on the machine to sign in or out by hand.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../../src/lib/protocol.ts", rename_all = "camelCase")]
pub struct ProviderLoginCommand {
    pub provider: String,
    /// `claude auth login`.
    pub login: String,
    /// `claude auth logout`.
    pub logout: String,
}

/// A device-code sign-in the daemon is waiting on: show `user_code`, open
/// `verification_url`; the `provider-login` event says how it ended.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../../src/lib/protocol.ts", rename_all = "camelCase")]
pub struct ProviderLoginFlow {
    pub provider: String,
    pub login_id: String,
    pub user_code: String,
    pub verification_url: String,
}

#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq, TS)]
#[serde(rename_all = "lowercase")]
#[ts(export, export_to = "../../../src/lib/protocol.ts", rename_all = "lowercase")]
pub enum ProviderLoginPhase {
    Pending,
    Done,
    Failed,
    Cancelled,
}

/// The `provider-login` event: how a device-code sign-in ended.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../../src/lib/protocol.ts", rename_all = "camelCase")]
pub struct ProviderLoginEvent {
    pub provider: String,
    pub login_id: String,
    pub phase: ProviderLoginPhase,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub error: Option<String>,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../../src/lib/protocol.ts", rename_all = "camelCase")]
pub struct ProviderLoginCancel {
    pub login_id: String,
}
