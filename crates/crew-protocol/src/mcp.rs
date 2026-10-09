//! MCP servers per session: whether each is connected, failed or waits for a
//! login, as the session's provider says it (plan decision 20).

use serde::{Deserialize, Serialize};
use ts_rs::TS;

#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq, TS)]
#[serde(rename_all = "snake_case")]
#[ts(export, export_to = "../../../src/lib/protocol.ts", rename_all = "snake_case")]
pub enum McpState {
    Connected,
    Pending,
    Failed,
    NeedsAuth,
    Disabled,
    /// A state the provider named that Crew does not know.
    Unknown,
}

/// What the user does to sign in to a server. The tokens stay where the
/// provider keeps them: Crew only opens the way in.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq, TS)]
#[serde(tag = "kind", rename_all = "snake_case")]
#[ts(export, export_to = "../../../src/lib/protocol.ts", tag = "kind", rename_all = "snake_case")]
pub enum McpSignIn {
    /// The provider's authorization page, for the browser.
    Url { url: String },
    /// The provider's own login, run in a Crew terminal tab as this argv.
    Terminal { command: Vec<String> },
}

/// One MCP server of a session.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../../src/lib/protocol.ts", rename_all = "camelCase")]
pub struct McpServer {
    pub name: String,
    pub state: McpState,
    /// Why it failed, in the provider's words.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub error: Option<String>,
    /// How to sign in, when the provider's way is known before the user asks
    /// (Claude's login is a command; Codex's URL is minted by `mcp_login`).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub sign_in: Option<McpSignIn>,
}

/// A session's MCP servers. `reported` is false when its provider does not
/// say (Cursor), which is not the same as having none.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../../src/lib/protocol.ts", rename_all = "camelCase")]
pub struct McpStatus {
    pub servers: Vec<McpServer>,
    pub reported: bool,
}

/// A session's MCP servers, pushed as `mcp-changed` whenever they change and
/// answered by `mcp_list`.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../../src/lib/protocol.ts", rename_all = "camelCase")]
pub struct McpChanged {
    pub session_id: String,
    pub status: McpStatus,
}

/// Names one server of a session: `mcp_login` and `mcp_reconnect`.
#[derive(Serialize, Deserialize, Clone, Debug, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../../src/lib/protocol.ts", rename_all = "camelCase")]
pub struct McpServerRequest {
    pub session_id: String,
    pub name: String,
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A state goes on the wire in snake case, the way the client reads it.
    #[test]
    fn a_state_is_written_in_snake_case() {
        assert_eq!(serde_json::to_value(McpState::NeedsAuth).expect("json"), serde_json::json!("needs_auth"));
        assert_eq!(serde_json::from_str::<McpState>("\"connected\"").expect("state"), McpState::Connected);
    }

    /// A server without an error or a sign-in writes neither.
    #[test]
    fn a_server_writes_only_what_it_has() {
        let server = McpServer { name: "docs".into(), state: McpState::Connected, error: None, sign_in: None };
        assert_eq!(serde_json::to_value(&server).expect("json"), serde_json::json!({ "name": "docs", "state": "connected" }));
        let raw = r#"{"name":"docs","state":"connected"}"#;
        assert_eq!(serde_json::from_str::<McpServer>(raw).expect("server"), server);
    }

    /// A sign-in names its kind, and carries a URL or the terminal's argv.
    #[test]
    fn a_sign_in_is_a_url_or_a_terminal_command() {
        let url = McpSignIn::Url { url: "https://auth.example/x".into() };
        assert_eq!(
            serde_json::to_value(&url).expect("json"),
            serde_json::json!({ "kind": "url", "url": "https://auth.example/x" })
        );
        let terminal = McpSignIn::Terminal { command: vec!["claude".into(), "mcp".into(), "login".into(), "sentry".into()] };
        let wire = serde_json::to_value(&terminal).expect("json");
        assert_eq!(wire, serde_json::json!({ "kind": "terminal", "command": ["claude", "mcp", "login", "sentry"] }));
        assert_eq!(serde_json::from_value::<McpSignIn>(wire).expect("sign-in"), terminal);
    }

    /// The push names its session and carries the whole status it replaces.
    #[test]
    fn an_mcp_changed_push_names_its_session_and_status() {
        let push = McpChanged {
            session_id: "s1".into(),
            status: McpStatus {
                servers: vec![McpServer {
                    name: "sentry".into(),
                    state: McpState::NeedsAuth,
                    error: None,
                    sign_in: Some(McpSignIn::Url { url: "https://x".into() }),
                }],
                reported: true,
            },
        };
        assert_eq!(
            serde_json::to_value(&push).expect("json"),
            serde_json::json!({
                "sessionId": "s1",
                "status": {
                    "servers": [{ "name": "sentry", "state": "needs_auth", "signIn": { "kind": "url", "url": "https://x" } }],
                    "reported": true
                }
            })
        );
    }
}
