//! MCP status for the sessions Crew drives (plan decision 20): which servers
//! each has and how they stand, from the provider's own words; and the two
//! things the user does about one, sign in and reconnect.
//!
//! - Claude lists its servers in `system/init`, and answers `mcp_status`
//!   (asked once the CLI is up, after a reload and after a login, and again
//!   while a server is still `pending`). Reconnecting is its `mcp_reconnect`;
//!   signing in is `claude mcp login`, which opens the browser and may
//!   prompt, so the window runs it in a terminal tab and asks for the
//!   reconnect when it exits.
//! - Codex is in `turns/codex.rs`: its list, its startup notices, its login.
//! - opencode lists its servers per folder (`GET /api/mcp`), and says a change
//!   as `mcp.status.changed`; a sign-in is its OAuth attempt, whose page opens
//!   in the browser, and a reconnect is `experimental/mcp/{name}/connect`. See
//!   `turns/opencode.rs`.
//! - Cursor does not say what its servers are: it is not `reported`.

use std::thread;
use std::time::Duration;

use crew_protocol::{McpSignIn, McpState, McpStatus};
use serde_json::Value;

use super::{Live, TurnHost};
use crate::providers::claude::{mcp_login_command, mcp_reconnect_request, mcp_servers, mcp_status_request};
use crate::session;

/// How many times Claude is asked while a server is still connecting, and how
/// long it is given between asks: a server takes a few seconds to come up, and
/// there is no line to say when it has.
const PENDING_READS: usize = 10;
const PENDING_WAIT: Duration = if cfg!(test) { Duration::from_millis(50) } else { Duration::from_secs(2) };

impl TurnHost {
    /// Every session's MCP servers: crewd lists them, and hears when they change.
    pub fn mcp_status(&self) -> &crate::mcp_status::McpHost {
        &self.mcp_status
    }

    /// A session's servers as its provider last said them.
    pub fn mcp_list(&self, session_id: &str) -> Result<McpStatus, String> {
        let session = session::get(&self.store, session_id.to_string())?.ok_or("No such session")?;
        if session.provider == "cursor" {
            return Ok(McpStatus { servers: Vec::new(), reported: false });
        }
        Ok(self.mcp_status.list(session_id))
    }

    /// What the user does to sign in to one of the session's servers. The
    /// tokens stay with the provider, which does the login.
    pub fn mcp_login(&self, session_id: &str, name: &str) -> Result<McpSignIn, String> {
        let session = session::get(&self.store, session_id.to_string())?.ok_or("No such session")?;
        match session.provider.as_str() {
            "claude" => {
                self.mcp_known(session_id, name)?;
                Ok(McpSignIn::Terminal { command: mcp_login_command(name) })
            }
            "codex" => {
                self.mcp_known(session_id, name)?;
                self.codex_mcp_login(session_id, name).map(|url| McpSignIn::Url { url })
            }
            "opencode" => {
                self.mcp_known(session_id, name)?;
                let cwd = session::cwd(&self.store, &session)?;
                self.opencode_mcp_login(&cwd, name).map(|url| McpSignIn::Url { url })
            }
            "cursor" => Err("Cursor does not report its servers, so Crew cannot sign in to them.".into()),
            other => Err(format!("Crew does not sign in to {other}'s servers yet.")),
        }
    }

    /// Has the provider connect one server again, and answers the list as it
    /// stands after.
    pub fn mcp_reconnect(&self, session_id: &str, name: &str) -> Result<McpStatus, String> {
        let session = session::get(&self.store, session_id.to_string())?.ok_or("No such session")?;
        match session.provider.as_str() {
            "claude" => {
                self.mcp_known(session_id, name)?;
                let asked = self.claude_control(session_id, mcp_reconnect_request(name));
                // Whatever it answered, the list is read again: a refusal
                // ("needs-auth") is the state it is in.
                let _ = self.read_claude_mcp(session_id, None);
                asked.map(|_| ())?;
            }
            "codex" => {
                self.mcp_known(session_id, name)?;
                self.codex_mcp_reconnect(session_id)?;
            }
            "opencode" => {
                self.mcp_known(session_id, name)?;
                let cwd = session::cwd(&self.store, &session)?;
                self.opencode_mcp_reconnect(&cwd, name)?;
                self.opencode_read_mcp(&cwd, session_id)?;
            }
            "cursor" => return Err("Cursor does not report its servers, so Crew cannot reconnect them.".into()),
            other => return Err(format!("Crew does not reconnect {other}'s servers yet.")),
        }
        Ok(self.mcp_status.list(session_id))
    }

    fn mcp_known(&self, session_id: &str, name: &str) -> Result<(), String> {
        if self.mcp_status.list(session_id).servers.iter().any(|server| server.name == name) {
            Ok(())
        } else {
            Err(format!("No MCP server named {name}."))
        }
    }

    /// What a turn's `system/init` names: the servers and how they stood as it
    /// began. A server still connecting is read again until it has settled.
    pub(super) fn mcp_init(&self, session_id: &str, list: &Value) {
        let servers = mcp_servers(list);
        let connecting = servers.iter().any(|server| server.state == McpState::Pending);
        self.mcp_status.learn_names(session_id, servers);
        if connecting {
            self.ask_claude_mcp(session_id, false);
        }
    }

    /// Reads Claude's servers on a thread of its own, since this is called
    /// where the CLI's lines are read, which an answer comes in on. Asked again
    /// while one is `pending`, so the list settles without a line to say so.
    /// `again` has a read that is already under way go round once more.
    pub(super) fn ask_claude_mcp(&self, session_id: &str, again: bool) {
        if !self.mcp_status.claim(session_id, again) {
            return;
        }
        let epoch = match self.lock().get(session_id) {
            Some(Live::Claude(live)) => live.epoch,
            _ => {
                self.mcp_status.release(session_id);
                return;
            }
        };
        let host = self.clone();
        let id = session_id.to_string();
        thread::spawn(move || loop {
            for read in 0..PENDING_READS {
                match host.read_claude_mcp(&id, Some(epoch)) {
                    Ok(true) if read + 1 < PENDING_READS => thread::sleep(PENDING_WAIT),
                    _ => break,
                }
            }
            if !host.mcp_status.release(&id) {
                break;
            }
        });
    }

    /// One `mcp_status`, kept. Says whether a server is still connecting.
    fn read_claude_mcp(&self, session_id: &str, epoch: Option<u64>) -> Result<bool, String> {
        let answer = self.claude_control_on(session_id, epoch, mcp_status_request())?;
        let servers = mcp_servers(answer.get("mcpServers").unwrap_or(&Value::Null));
        let connecting = servers.iter().any(|server| server.state == McpState::Pending);
        self.mcp_status.learn(session_id, servers);
        Ok(connecting)
    }
}
