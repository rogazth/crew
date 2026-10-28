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
    /// One Crew builds in (`google.gmail`), served by `crewd` itself; `None`
    /// for a remote MCP server.
    pub builtin: Option<String>,
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
    /// What the user calls it: who signed in, else "Account 2", until renamed.
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

/// A connector Crew builds in, for a service with no MCP server of its own,
/// as Browse lists it before it is installed.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../../src/lib/protocol.ts", rename_all = "camelCase")]
pub struct BuiltinConnector {
    /// `google.gmail`.
    pub id: String,
    pub name: String,
    pub description: String,
    /// The API it calls, shown as its server: `gmail.googleapis.com`.
    pub server: String,
    pub icon_url: Option<String>,
    /// The sign-in it shares with its siblings (`google`): one account
    /// signed in to one of them is offered to the others.
    pub family: String,
    /// Why it can't be installed in this build (no OAuth client set up yet).
    pub unavailable: Option<String>,
    /// What each tool does, before anything is installed.
    pub tools: Vec<ConnectorTool>,
}

/// A machine leasing from this vault, by the token the vault minted for it.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../../src/lib/protocol.ts", rename_all = "camelCase")]
pub struct VaultMachine {
    pub id: String,
    pub name: String,
    #[ts(type = "number")]
    pub created_at: i64,
    /// When it last leased a token.
    #[ts(type = "number | null")]
    pub last_lease: Option<i64>,
}

/// Where this daemon's connectors' grants are: here, or on another machine
/// it leases from.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../../src/lib/protocol.ts", rename_all = "camelCase")]
pub struct VaultStatus {
    /// This daemon holds the grants (it is the vault); otherwise it leases.
    pub holds: bool,
    /// The vault's machine, as the window named it, when this one leases.
    pub vault_name: Option<String>,
    /// The vault's address, when this one leases.
    pub vault_address: Option<String>,
    /// Whether the vault answers, when this one leases.
    pub online: bool,
    #[ts(type = "number | null")]
    pub offline_since: Option<i64>,
    /// Where this vault takes leases besides its own socket (this Mac's tailnet address).
    pub listening: Option<String>,
    /// The machines leasing from this one, when it is the vault.
    pub machines: Vec<VaultMachine>,
    /// How many grants this daemon keeps.
    pub grants: u32,
}

/// A machine's lease token, minted by the vault, shown once.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../../src/lib/protocol.ts", rename_all = "camelCase")]
pub struct VaultMinted {
    pub machine: VaultMachine,
    pub token: String,
}

/// Lease from the vault at `address` with `token` from now on.
#[derive(Serialize, Deserialize, Clone, Debug, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../../src/lib/protocol.ts", rename_all = "camelCase")]
pub struct VaultJoin {
    pub address: String,
    pub token: String,
    pub vault_name: String,
}

/// A vault move's step that carries the receiving vault's public key.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../../src/lib/protocol.ts", rename_all = "camelCase")]
pub struct VaultKey {
    pub public_key: String,
}

/// The new vault pulls the grants from the old one, at `address`, with the
/// handoff token the old one gave the window.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../../src/lib/protocol.ts", rename_all = "camelCase")]
pub struct VaultPull {
    pub address: String,
    pub token: String,
}

/* ── RPCs ─────────────────────────────────────────────────────────────── */

/// Install a connector: a registry server by name, or a URL.
#[derive(Serialize, Deserialize, Clone, Debug, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../../src/lib/protocol.ts", rename_all = "camelCase")]
pub struct ConnectorAdd {
    pub registry_name: Option<String>,
    /// One Crew builds in, by its id (`google.gmail`).
    pub builtin: Option<String>,
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
    /// Who to sign in as, when the service offers it (Google's "Continue as"):
    /// the identity of an account already signed in.
    pub login_hint: Option<String>,
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
