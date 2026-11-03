//! The MCP servers each provider CLI already has on a machine (plan
//! `2026-10-23-integrations.md`, phase 1). The CLI owns them: Crew lists
//! them, signs in to them through the CLI, and leaves them out of its own
//! spawns when the user turns them off in Crew.

use serde::{Deserialize, Serialize};
use ts_rs::TS;

use crate::McpState;

/// One server in one provider's config on this machine.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../../src/lib/protocol.ts", rename_all = "camelCase")]
pub struct ProviderServer {
    pub provider: String,
    /// As the CLI names it: `context7`, `claude.ai Notion`, `plugin:figma:figma`.
    pub name: String,
    /// "stdio" | "http" | "sse" | "claude.ai"
    pub transport: String,
    /// The URL, or the command line without its environment. Never a header
    /// or an environment value: those can be secrets.
    pub target: String,
    /// "user" | "project" | "local" | "plugin" | "claude.ai", when the CLI says.
    pub scope: Option<String>,
    pub state: McpState,
    pub error: Option<String>,
    /// How many tools it has, when the CLI says.
    pub tools: Option<u32>,
    /// Left out of Crew's sessions of this provider on this machine. For
    /// cursor and grok, which have no per-spawn way, it is the CLI's own
    /// disable, so it is off outside Crew too.
    pub off_in_crew: bool,
    /// Crew can start its sign-in from here.
    pub can_sign_in: bool,
    /// Crew can remove it from the CLI's config: not a claude.ai connector,
    /// a plugin's or an app's own (bundled), nor one in a file Crew cannot
    /// edit without losing what else is in it.
    pub can_remove: bool,
}

/// One provider's servers on this machine.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../../src/lib/protocol.ts", rename_all = "camelCase")]
pub struct ProviderInventory {
    pub provider: String,
    /// The CLI is on this machine.
    pub installed: bool,
    pub servers: Vec<ProviderServer>,
    /// Why the list could not be read, when it could not.
    pub error: Option<String>,
    /// When the list was last read, unix ms; `None` before the first read.
    #[ts(type = "number | null")]
    pub checked_at: Option<i64>,
    /// A read is under way.
    pub checking: bool,
}

/* ── RPCs (to the machine whose CLIs they are) ───────────────────────── */

/// `provider_servers_list`: the cached lists at once; `refresh` reads them
/// again, and the new lists arrive as `provider-servers` events.
#[derive(Serialize, Deserialize, Clone, Debug, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../../src/lib/protocol.ts", rename_all = "camelCase")]
pub struct ProviderServersList {
    pub refresh: bool,
}

#[derive(Serialize, Deserialize, Clone, Debug, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../../src/lib/protocol.ts", rename_all = "camelCase")]
pub struct ProviderServerRef {
    pub provider: String,
    pub name: String,
}

/// `provider_server_off`: leave a server out of Crew's sessions, or put it back.
#[derive(Serialize, Deserialize, Clone, Debug, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../../src/lib/protocol.ts", rename_all = "camelCase")]
pub struct ProviderServerOff {
    pub provider: String,
    pub name: String,
    pub off: bool,
}

/// What `provider_server_sign_in` answers: a page for Crew's sign-in window,
/// whose redirect the window catches and hands to `provider_server_callback`;
/// or, for a CLI that only signs in on its own, a command for a terminal tab.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq, TS)]
#[serde(tag = "kind", rename_all = "snake_case")]
#[ts(export, export_to = "../../../src/lib/protocol.ts", tag = "kind", rename_all = "snake_case")]
pub enum ProviderSignIn {
    Browser {
        /// The OAuth `state` in `authUrl`, which the caught redirect carries.
        state: String,
        #[serde(rename = "authUrl")]
        #[ts(rename = "authUrl")]
        auth_url: String,
        /// Where the page sends the code: Crew's own redirect, or the CLI's
        /// loopback listener on that machine, which the daemon calls itself.
        #[serde(rename = "redirectUri")]
        #[ts(rename = "redirectUri")]
        redirect_uri: String,
    },
    Terminal {
        command: Vec<String>,
    },
}

#[derive(Serialize, Deserialize, Clone, Debug, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../../src/lib/protocol.ts", rename_all = "camelCase")]
pub struct ProviderServerCallback {
    pub state: String,
    pub url: String,
}

/// `mcp_toggle`: switch one of a live session's servers on or off, now.
#[derive(Serialize, Deserialize, Clone, Debug, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../../src/lib/protocol.ts", rename_all = "camelCase")]
pub struct McpToggle {
    pub session_id: String,
    pub name: String,
    pub enabled: bool,
}
