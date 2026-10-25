//! Crew's connectors: remote MCP servers installed from Crew, each signed in
//! to once per account, with the grants in the vault and the accounts turned
//! on per scope (plan `2026-10-23-integrations.md`).

use serde::{Deserialize, Serialize};
use ts_rs::TS;

/// A remote MCP server installed from Crew, from the registry or a URL.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../../src/lib/protocol.ts", rename_all = "camelCase")]
pub struct Connector {
    pub id: String,
    pub name: String,
    /// Its reverse-DNS name in the registry; `None` for one added by URL.
    pub registry_name: Option<String>,
    pub url: String,
    pub icon_url: Option<String>,
    /// The registry's text about it; empty for one added by URL.
    pub description: String,
    /// The domain that publishes it, or the URL's host for one added by URL.
    pub publisher: String,
    /// Why Crew can't sign in to it (no client registration, or no public
    /// clients), once a sign-in found out. It is then used through a CLI.
    pub refused: Option<String>,
    pub accounts: Vec<ConnectorAccount>,
    #[ts(type = "number")]
    pub created_at: i64,
}

/// One sign-in to a connector.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../../src/lib/protocol.ts", rename_all = "camelCase")]
pub struct ConnectorAccount {
    pub id: String,
    pub connector_id: String,
    /// What the user calls it: "Work".
    pub label: String,
    /// Who the service says signed in (`email`, else `name`), when it says.
    pub identity: Option<String>,
    pub state: AccountState,
    /// Why it is not connected, in one line, when it is not.
    pub error: Option<String>,
    pub bindings: Vec<Binding>,
    /// The server's tools as last listed, switched off ones included.
    pub tools: Vec<ConnectorTool>,
    pub tools_off: Vec<String>,
    #[ts(type = "number")]
    pub created_at: i64,
}

#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq, TS)]
#[serde(rename_all = "kebab-case")]
#[ts(export, export_to = "../../../src/lib/protocol.ts", rename_all = "kebab-case")]
pub enum AccountState {
    /// Its first sign-in has not finished.
    Pending,
    Connected,
    /// The grant was revoked or ran out: it needs a sign-in again.
    Expired,
    /// The service asked for more scope than the grant has.
    NeedsScope,
    /// The server could not be reached or answered with an error.
    Failed,
}

/// Where a binding applies. The most specific one wins: a session, then its
/// bot, then its workspace, then everywhere.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq, Hash, TS)]
#[serde(tag = "kind", rename_all = "camelCase")]
#[ts(export, export_to = "../../../src/lib/protocol.ts")]
pub enum BindingScope {
    #[serde(rename = "everywhere")]
    Everywhere,
    #[serde(rename = "workspace")]
    Workspace { id: String },
    #[serde(rename = "bot")]
    Bot { id: String },
    #[serde(rename = "session")]
    Session { id: String },
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../../src/lib/protocol.ts", rename_all = "camelCase")]
pub struct Binding {
    pub scope: BindingScope,
    pub on: bool,
}

/// A tool as the server lists it, with what Crew shows beside it.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../../src/lib/protocol.ts", rename_all = "camelCase")]
pub struct ConnectorTool {
    pub name: String,
    pub title: Option<String>,
    pub description: String,
    /// The server's `readOnlyHint`.
    pub read_only: bool,
    /// The server's `destructiveHint`, read as MCP defines it: true unless the
    /// tool is read only or says otherwise.
    pub destructive: bool,
    /// About what its definition costs in context, in tokens.
    pub tokens: u32,
}

/* ── RPCs ─────────────────────────────────────────────────────────────── */

/// Install a connector: a registry server by name, or a URL.
#[derive(Serialize, Deserialize, Clone, Debug, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../../src/lib/protocol.ts", rename_all = "camelCase")]
pub struct ConnectorAdd {
    pub registry_name: Option<String>,
    pub url: Option<String>,
    /// The name to show for one added by URL; the host otherwise.
    pub name: Option<String>,
}

#[derive(Serialize, Deserialize, Clone, Debug, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../../src/lib/protocol.ts", rename_all = "camelCase")]
pub struct ConnectorRef {
    pub connector_id: String,
}

#[derive(Serialize, Deserialize, Clone, Debug, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../../src/lib/protocol.ts", rename_all = "camelCase")]
pub struct AccountRef {
    pub account_id: String,
}

/// Start a sign-in: a new account of a connector, or an existing one again.
#[derive(Serialize, Deserialize, Clone, Debug, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../../src/lib/protocol.ts", rename_all = "camelCase")]
pub struct ConnectorConnect {
    pub connector_id: String,
    /// Sign this account in again; `None` adds an account.
    pub account_id: Option<String>,
    /// The new account's label; filled in from the service otherwise.
    pub label: Option<String>,
}

/// What the window opens for a sign-in. The tab catches the navigation to
/// `redirect_uri`, closes itself and hands the URL to `vault_callback`.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../../src/lib/protocol.ts", rename_all = "camelCase")]
pub struct SignIn {
    pub state: String,
    pub auth_url: String,
    pub redirect_uri: String,
    pub account_id: String,
    /// Another account of a connector already signed in: open it where the
    /// signed-in one does not answer for it.
    pub incognito: bool,
}

#[derive(Serialize, Deserialize, Clone, Debug, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../../src/lib/protocol.ts", rename_all = "camelCase")]
pub struct VaultCallback {
    pub state: String,
    /// The redirect the tab caught, whole: `http://127.0.0.1:…/callback?code=…&state=…`.
    pub url: String,
}

/// The window gave up on a sign-in (the tab was closed).
#[derive(Serialize, Deserialize, Clone, Debug, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../../src/lib/protocol.ts", rename_all = "camelCase")]
pub struct SignInCancel {
    pub state: String,
}

#[derive(Serialize, Deserialize, Clone, Debug, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../../src/lib/protocol.ts", rename_all = "camelCase")]
pub struct AccountRename {
    pub account_id: String,
    pub label: String,
}

/// Turn an account on or off for a scope; `on: None` drops the binding, so
/// the scope follows the next less specific one.
#[derive(Serialize, Deserialize, Clone, Debug, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../../src/lib/protocol.ts", rename_all = "camelCase")]
pub struct BindingSet {
    pub account_id: String,
    pub scope: BindingScope,
    pub on: Option<bool>,
}

#[derive(Serialize, Deserialize, Clone, Debug, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../../src/lib/protocol.ts", rename_all = "camelCase")]
pub struct ToolSet {
    pub account_id: String,
    pub tool: String,
    pub on: bool,
}
