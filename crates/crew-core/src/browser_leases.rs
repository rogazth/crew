//! Who is driving which browser tab. In memory only: a lease is worth nothing
//! once the daemon restarts, because the calls it protected are gone with it.
//!
//! A tab has one holder at a time, so two agents never type into the same
//! form. Every call renews the lease; one left alone runs out after
//! [`TTL_MS`], and nothing else ends an agent's lease: a turn ending is not a
//! reason, since the next turn usually picks the page back up.

use std::collections::HashMap;
use std::sync::{Arc, Mutex};

use crew_protocol::{BrowserLease, BrowserLeases};

/// How long a tab stays taken after its holder's last call.
pub const TTL_MS: i64 = 120_000;

/// Whoever asks for a tab: a session (agent or terminal) or the user.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Holder {
    /// What leases are compared by: the session id, or "user".
    pub key: String,
    /// What a conflict and the tab's face call it.
    pub label: String,
    pub session_id: Option<String>,
}

impl Holder {
    pub fn session(id: &str, name: &str) -> Self {
        Self {
            key: id.to_string(),
            label: name.to_string(),
            session_id: Some(id.to_string()),
        }
    }

    pub fn user() -> Self {
        Self {
            key: "user".into(),
            label: "you".into(),
            session_id: None,
        }
    }
}

#[derive(Debug, Clone)]
struct Held {
    workspace_id: String,
    holder: Holder,
    until: i64,
}

#[derive(Default)]
struct State {
    tabs: HashMap<String, Held>,
    /// The tab each holder last took, which is what a call without `tab` means.
    /// It outlives the lease: an agent back after a coffee break still means
    /// the same page, and takes it again if nobody else has.
    last: HashMap<String, String>,
}

type OnChange = Arc<dyn Fn(BrowserLeases) + Send + Sync>;

#[derive(Clone, Default)]
pub struct Leases {
    state: Arc<Mutex<State>>,
    on_change: Arc<Mutex<Option<OnChange>>>,
}

impl Leases {
    pub fn new() -> Self {
        Self::default()
    }

    /// Told every time the set of leases changes (not on a plain renewal), so
    /// the window can pin the tab and show who holds it.
    pub fn set_on_change(&self, f: impl Fn(BrowserLeases) + Send + Sync + 'static) {
        *self.on_change.lock().unwrap_or_else(|e| e.into_inner()) = Some(Arc::new(f));
    }

    /// Takes the tab for `holder`, or renews it when it is already theirs.
    pub fn claim(&self, tab: &str, workspace_id: &str, holder: &Holder, now: i64) -> Result<(), String> {
        let changed = {
            let mut state = self.lock();
            let expired = drop_expired(&mut state, now);
            if let Some(held) = state.tabs.get_mut(tab) {
                if held.holder.key != holder.key {
                    let secs = ((held.until - now).max(0) + 999) / 1000;
                    return Err(format!(
                        "Tab {tab} is in use by {}, free in ~{secs} s; use another tab or wait",
                        held.holder.label
                    ));
                }
                held.until = now + TTL_MS;
                state.last.insert(holder.key.clone(), tab.to_string());
                expired
            } else {
                state.tabs.insert(
                    tab.to_string(),
                    Held {
                        workspace_id: workspace_id.to_string(),
                        holder: holder.clone(),
                        until: now + TTL_MS,
                    },
                );
                state.last.insert(holder.key.clone(), tab.to_string());
                true
            }
        };
        if changed {
            self.announce(now);
        }
        Ok(())
    }

    /// Lets the tab go, if `holder` has it. Whether anything was released.
    pub fn release(&self, tab: &str, holder: &Holder, now: i64) -> bool {
        let released = {
            let mut state = self.lock();
            let theirs = state.tabs.get(tab).is_some_and(|held| held.holder.key == holder.key);
            if theirs {
                state.tabs.remove(tab);
            }
            theirs
        };
        if released {
            self.announce(now);
        }
        released
    }

    /// The user takes a tab back from whoever holds it.
    pub fn force_release(&self, tab: &str, now: i64) -> bool {
        let released = self.lock().tabs.remove(tab).is_some();
        if released {
            self.announce(now);
        }
        released
    }

    /// Every tab `key` holds, for a session that was deleted or a terminal
    /// whose process exited. How many went.
    pub fn release_all(&self, key: &str, now: i64) -> usize {
        let count = {
            let mut state = self.lock();
            let before = state.tabs.len();
            state.tabs.retain(|_, held| held.holder.key != key);
            state.last.remove(key);
            before - state.tabs.len()
        };
        if count > 0 {
            self.announce(now);
        }
        count
    }

    /// A closed tab takes its lease and anyone's memory of it along.
    pub fn forget_tab(&self, tab: &str, now: i64) {
        let held = {
            let mut state = self.lock();
            state.last.retain(|_, last| last != tab);
            state.tabs.remove(tab).is_some()
        };
        if held {
            self.announce(now);
        }
    }

    /// Drops leases that ran out. Whether any did; the change is announced.
    pub fn sweep(&self, now: i64) -> bool {
        let expired = drop_expired(&mut self.lock(), now);
        if expired {
            self.announce(now);
        }
        expired
    }

    pub fn holder_of(&self, tab: &str, now: i64) -> Option<BrowserLease> {
        let state = self.lock();
        state
            .tabs
            .get(tab)
            .filter(|held| held.until > now)
            .map(|held| describe(tab, held))
    }

    /// The tab a call without one is about.
    pub fn last_tab(&self, key: &str) -> Option<String> {
        self.lock().last.get(key).cloned()
    }

    pub fn list(&self, now: i64) -> BrowserLeases {
        let state = self.lock();
        let mut leases: Vec<BrowserLease> = state
            .tabs
            .iter()
            .filter(|(_, held)| held.until > now)
            .map(|(tab, held)| describe(tab, held))
            .collect();
        leases.sort_by(|a, b| a.tab.cmp(&b.tab));
        BrowserLeases { leases }
    }

    fn announce(&self, now: i64) {
        let hook = self.on_change.lock().unwrap_or_else(|e| e.into_inner()).clone();
        if let Some(hook) = hook {
            hook(self.list(now));
        }
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, State> {
        self.state.lock().unwrap_or_else(|e| e.into_inner())
    }
}

fn drop_expired(state: &mut State, now: i64) -> bool {
    let before = state.tabs.len();
    state.tabs.retain(|_, held| held.until > now);
    before != state.tabs.len()
}

fn describe(tab: &str, held: &Held) -> BrowserLease {
    BrowserLease {
        tab: tab.to_string(),
        workspace_id: held.workspace_id.clone(),
        holder: held.holder.label.clone(),
        session_id: held.holder.session_id.clone(),
        until: held.until,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const NOW: i64 = 1_800_000_000_000;

    fn ada() -> Holder {
        Holder::session("s-ada", "Ada")
    }

    fn bob() -> Holder {
        Holder::session("s-bob", "Bob")
    }

    #[test]
    fn a_taken_tab_refuses_anyone_else_and_says_for_how_long() {
        let leases = Leases::new();
        leases.claim("browser:1", "w", &ada(), NOW).expect("free");
        let error = leases.claim("browser:1", "w", &bob(), NOW + 30_000).expect_err("taken");
        assert_eq!(error, "Tab browser:1 is in use by Ada, free in ~90 s; use another tab or wait");
        // Another tab is fine.
        leases.claim("browser:2", "w", &bob(), NOW + 30_000).expect("free");
    }

    #[test]
    fn every_call_renews_the_lease() {
        let leases = Leases::new();
        leases.claim("browser:1", "w", &ada(), NOW).expect("free");
        leases.claim("browser:1", "w", &ada(), NOW + 100_000).expect("renew");
        // Past the first TTL, still Ada's: the renewal moved it.
        assert!(leases.claim("browser:1", "w", &bob(), NOW + TTL_MS + 1).is_err());
        assert_eq!(leases.holder_of("browser:1", NOW + TTL_MS + 1).map(|l| l.holder), Some("Ada".into()));
    }

    #[test]
    fn a_lease_nobody_uses_runs_out() {
        let leases = Leases::new();
        leases.claim("browser:1", "w", &ada(), NOW).expect("free");
        assert!(leases.holder_of("browser:1", NOW + TTL_MS).is_none());
        leases.claim("browser:1", "w", &bob(), NOW + TTL_MS).expect("expired, so free");
        assert_eq!(leases.list(NOW + TTL_MS).leases.len(), 1);
    }

    #[test]
    fn only_the_holder_releases_and_the_user_can_force_it() {
        let leases = Leases::new();
        leases.claim("browser:1", "w", &ada(), NOW).expect("free");
        assert!(!leases.release("browser:1", &bob(), NOW));
        assert!(leases.release("browser:1", &ada(), NOW));
        leases.claim("browser:1", "w", &bob(), NOW).expect("free again");
        assert!(leases.force_release("browser:1", NOW));
        assert!(leases.holder_of("browser:1", NOW).is_none());
    }

    #[test]
    fn a_session_that_goes_lets_go_of_everything_it_held() {
        let leases = Leases::new();
        leases.claim("browser:1", "w", &ada(), NOW).expect("free");
        leases.claim("browser:2", "w", &ada(), NOW).expect("free");
        leases.claim("browser:3", "w", &bob(), NOW).expect("free");
        assert_eq!(leases.release_all("s-ada", NOW), 2);
        assert_eq!(leases.last_tab("s-ada"), None);
        let left: Vec<String> = leases.list(NOW).leases.into_iter().map(|l| l.tab).collect();
        assert_eq!(left, ["browser:3"]);
    }

    #[test]
    fn the_last_tab_taken_is_the_default_and_outlives_the_lease() {
        let leases = Leases::new();
        leases.claim("browser:1", "w", &ada(), NOW).expect("free");
        leases.claim("browser:2", "w", &ada(), NOW).expect("free");
        assert_eq!(leases.last_tab("s-ada").as_deref(), Some("browser:2"));
        leases.sweep(NOW + TTL_MS);
        assert_eq!(leases.last_tab("s-ada").as_deref(), Some("browser:2"));
        leases.forget_tab("browser:2", NOW + TTL_MS);
        assert_eq!(leases.last_tab("s-ada"), None);
    }

    #[test]
    fn changes_are_announced_but_renewals_are_not() {
        let leases = Leases::new();
        let seen = Arc::new(Mutex::new(Vec::new()));
        let sink = seen.clone();
        leases.set_on_change(move |all| sink.lock().unwrap().push(all.leases.len()));
        leases.claim("browser:1", "w", &ada(), NOW).expect("free");
        leases.claim("browser:1", "w", &ada(), NOW + 1).expect("renew");
        leases.claim("browser:2", "w", &bob(), NOW + 2).expect("free");
        leases.sweep(NOW + 3);
        leases.sweep(NOW + TTL_MS + 3);
        assert_eq!(*seen.lock().unwrap(), [1, 2, 0]);
    }
}
