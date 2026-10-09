//! Which MCP servers each session has, and whether they work (plan decision
//! 20): connected, failed, or waiting for a login, as the session's provider
//! says it. Kept per session from the CLI's own words, pushed to the windows
//! when it changes, and not written to disk: a CLI that starts again says it
//! again.

use std::collections::HashMap;
use std::sync::{Arc, Mutex};

use crew_protocol::{McpChanged, McpServer, McpState, McpStatus};

pub type Listener = Arc<dyn Fn(McpChanged) + Send + Sync>;

/// How much of a server's error is kept: it shares a row with the server's name.
pub const ERROR_LIMIT: usize = 240;

#[derive(Default)]
struct Held {
    status: Option<McpStatus>,
    /// A read of the provider is under way; see [`McpHost::claim`].
    reading: bool,
    /// Something asked for another read while one ran.
    again: bool,
}

/// Every session's servers, and who hears when one changes.
#[derive(Clone, Default)]
pub struct McpHost {
    inner: Arc<Mutex<HashMap<String, Held>>>,
    listener: Arc<Mutex<Option<Listener>>>,
}

impl McpHost {
    pub fn set_listener(&self, listener: Listener) {
        *self.listener.lock().unwrap_or_else(|e| e.into_inner()) = Some(listener);
    }

    /// Tells the windows a session's servers changed. The listener runs out of
    /// every lock here.
    fn notify(&self, change: McpChanged) {
        let listener = self.listener.lock().unwrap_or_else(|e| e.into_inner()).clone();
        if let Some(listener) = listener {
            listener(change);
        }
    }

    /// What the provider last said of a session's servers. A provider that has
    /// not said anything (or never does, as Cursor) is not `reported`.
    pub fn list(&self, session_id: &str) -> McpStatus {
        let map = self.inner.lock().unwrap_or_else(|e| e.into_inner());
        map.get(session_id)
            .and_then(|held| held.status.clone())
            .unwrap_or(McpStatus { servers: Vec::new(), reported: false })
    }

    /// Keeps the whole list the provider just gave, and tells the windows if it
    /// is not the one they have.
    pub fn learn(&self, session_id: &str, servers: Vec<McpServer>) {
        self.replace(session_id, |_| servers);
    }

    /// Keeps the list a turn's `init` names. It says a state and nothing more,
    /// so a server it finds in the state it already had keeps what was learned
    /// of it: the error, and the way to sign in.
    pub fn learn_names(&self, session_id: &str, servers: Vec<McpServer>) {
        self.replace(session_id, |last| {
            servers
                .into_iter()
                .map(|server| match last.iter().find(|old| old.name == server.name && old.state == server.state) {
                    Some(old) => old.clone(),
                    None => server,
                })
                .collect()
        });
    }

    /// Changes one server's state, as a provider's startup notice does; a
    /// server not listed yet is added.
    pub fn set_state(&self, session_id: &str, name: &str, state: McpState, error: Option<String>) {
        self.replace(session_id, |last| {
            let mut servers = last.to_vec();
            let error = error.map(|error| clip(&error));
            match servers.iter_mut().find(|server| server.name == name) {
                Some(server) => {
                    server.state = state;
                    server.error = error;
                    if state != McpState::NeedsAuth {
                        server.sign_in = None;
                    }
                }
                None => servers.push(McpServer { name: name.to_string(), state, error, sign_in: None }),
            }
            servers
        });
    }

    fn replace(&self, session_id: &str, next: impl FnOnce(&[McpServer]) -> Vec<McpServer>) {
        let status = {
            let mut map = self.inner.lock().unwrap_or_else(|e| e.into_inner());
            let held = map.entry(session_id.to_string()).or_default();
            let last = held.status.as_ref().map(|status| status.servers.as_slice()).unwrap_or_default();
            let status = McpStatus { servers: next(last), reported: true };
            if held.status.as_ref() == Some(&status) {
                return;
            }
            held.status = Some(status.clone());
            status
        };
        self.notify(McpChanged { session_id: session_id.to_string(), status });
    }

    /// Claims the right to read the provider for a session: false when a read
    /// already runs. With `again`, that read then runs once more when it ends,
    /// so a change that came meanwhile is not missed and a burst of notices is
    /// a few reads; without it, the read that runs is enough.
    pub fn claim(&self, session_id: &str, again: bool) -> bool {
        let mut map = self.inner.lock().unwrap_or_else(|e| e.into_inner());
        let held = map.entry(session_id.to_string()).or_default();
        if held.reading {
            held.again |= again;
            return false;
        }
        held.reading = true;
        true
    }

    /// The claimed read is over. True when another was asked for meanwhile,
    /// and the claim stays with the caller for it.
    pub fn release(&self, session_id: &str) -> bool {
        let mut map = self.inner.lock().unwrap_or_else(|e| e.into_inner());
        let Some(held) = map.get_mut(session_id) else {
            return false;
        };
        if std::mem::take(&mut held.again) {
            return true;
        }
        held.reading = false;
        false
    }

    /// The session is gone.
    pub fn forget(&self, session_id: &str) {
        self.inner.lock().unwrap_or_else(|e| e.into_inner()).remove(session_id);
    }
}

/// An error as the row keeps it: one line, short.
pub fn clip(error: &str) -> String {
    crate::providers::clip(error.trim(), ERROR_LIMIT)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crew_protocol::McpSignIn;
    use std::sync::Mutex as StdMutex;

    fn server(name: &str, state: McpState) -> McpServer {
        McpServer { name: name.into(), state, error: None, sign_in: None }
    }

    fn heard(host: &McpHost) -> Arc<StdMutex<Vec<McpChanged>>> {
        let log = Arc::new(StdMutex::new(Vec::new()));
        let sink = log.clone();
        host.set_listener(Arc::new(move |change| sink.lock().unwrap().push(change)));
        log
    }

    /// Nothing said is not the same as no servers: the list is not reported.
    #[test]
    fn a_session_nothing_was_said_of_is_not_reported() {
        let host = McpHost::default();
        assert_eq!(host.list("s"), McpStatus { servers: Vec::new(), reported: false });
        host.learn("s", Vec::new());
        assert_eq!(host.list("s"), McpStatus { servers: Vec::new(), reported: true });
    }

    /// The windows hear a list once, and again only when it differs.
    #[test]
    fn the_windows_hear_a_list_only_when_it_changes() {
        let host = McpHost::default();
        let log = heard(&host);
        host.learn("s", vec![server("a", McpState::Pending)]);
        host.learn("s", vec![server("a", McpState::Pending)]);
        host.learn("s", vec![server("a", McpState::Connected)]);
        let log = log.lock().unwrap();
        assert_eq!(log.len(), 2);
        assert_eq!(log[1].status.servers[0].state, McpState::Connected);
    }

    /// A turn's `init` names a state only: what was learned of a server in
    /// that state stays, and one in another state starts afresh.
    #[test]
    fn an_init_keeps_what_a_server_in_the_same_state_told() {
        let host = McpHost::default();
        let failed = McpServer { error: Some("ENOENT".into()), ..server("a", McpState::Failed) };
        let login = McpServer {
            sign_in: Some(McpSignIn::Terminal { command: vec!["claude".into()] }),
            ..server("b", McpState::NeedsAuth)
        };
        host.learn("s", vec![failed.clone(), login]);
        host.learn_names("s", vec![server("a", McpState::Failed), server("b", McpState::Connected)]);
        let list = host.list("s").servers;
        assert_eq!(list[0], failed);
        assert_eq!(list[1], server("b", McpState::Connected));
    }

    /// A startup notice moves one server, adds one it did not know, and drops
    /// the sign-in of a server that no longer needs it.
    #[test]
    fn a_startup_notice_moves_one_server() {
        let host = McpHost::default();
        let login = McpServer {
            sign_in: Some(McpSignIn::Terminal { command: vec!["claude".into()] }),
            ..server("b", McpState::NeedsAuth)
        };
        host.learn("s", vec![server("a", McpState::Pending), login]);
        host.set_state("s", "a", McpState::Failed, Some("boom\nmore".into()));
        host.set_state("s", "b", McpState::Connected, None);
        host.set_state("s", "c", McpState::Pending, None);
        let list = host.list("s").servers;
        assert_eq!(list[0].error.as_deref(), Some("boom"));
        assert_eq!(list[1], server("b", McpState::Connected));
        assert_eq!(list[2], server("c", McpState::Pending));
    }

    /// A read asked for while one runs makes the running one go round again,
    /// unless the ask says the running one is enough.
    #[test]
    fn a_read_asked_for_during_a_read_runs_once_more() {
        let host = McpHost::default();
        assert!(host.claim("s", true));
        assert!(!host.claim("s", true));
        assert!(!host.claim("s", true));
        assert!(host.release("s"), "the ask that came meanwhile is read for");
        assert!(!host.release("s"));
        assert!(host.claim("s", true), "free again once nothing was asked");
        assert!(!host.claim("s", false));
        assert!(!host.release("s"), "an ask that wants no second read leaves none");
    }

    #[test]
    fn a_session_that_is_gone_is_forgotten() {
        let host = McpHost::default();
        host.learn("s", vec![server("a", McpState::Connected)]);
        host.forget("s");
        assert!(!host.list("s").reported);
    }
}
