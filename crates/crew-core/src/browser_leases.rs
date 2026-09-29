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
    /// The holder's process when it last took or renewed the tab; see
    /// [`Leases::begin_process`].
    process: u64,
}

#[derive(Default)]
struct State {
    tabs: HashMap<String, Held>,
    /// The tab each holder last took, which is what a call without `tab` means.
    /// It outlives the lease: an agent back after a coffee break still means
    /// the same page, and takes it again if nobody else has.
    last: HashMap<String, String>,
    /// The process each holder runs now, for the sessions that run one.
    processes: HashMap<String, u64>,
    next_process: u64,
    /// Stamped on every list; see [`BrowserLeases::seq`].
    seq: u64,
}

type OnChange = Arc<dyn Fn(BrowserLeases) + Send + Sync>;

#[derive(Clone)]
pub struct Leases {
    state: Arc<Mutex<State>>,
    on_change: Arc<Mutex<Option<OnChange>>>,
}

impl Default for Leases {
    fn default() -> Self {
        Self::new()
    }
}

impl Leases {
    /// The sequence starts at the clock, in microseconds, so a restarted
    /// daemon's lists still come after the old one's: a client that keeps the
    /// newest it has seen never needs telling that the daemon changed.
    pub fn new() -> Self {
        let state = State {
            seq: crate::store::now_millis().max(0) as u64 * 1000,
            ..State::default()
        };
        Self {
            state: Arc::new(Mutex::new(state)),
            on_change: Arc::default(),
        }
    }

    /// Told every time the set of leases changes (not on a plain renewal), so
    /// the window can pin the tab and show who holds it.
    pub fn set_on_change(&self, f: impl Fn(BrowserLeases) + Send + Sync + 'static) {
        *self.on_change.lock().unwrap_or_else(|e| e.into_inner()) = Some(Arc::new(f));
    }

    /// Takes the tab for `holder`, or renews it when it is already theirs.
    pub fn claim(&self, tab: &str, workspace_id: &str, holder: &Holder, now: i64) -> Result<(), String> {
        let change = {
            let mut state = self.lock();
            let expired = drop_expired(&mut state, now);
            let process = state.processes.get(&holder.key).copied().unwrap_or(0);
            let changed = if let Some(held) = state.tabs.get_mut(tab) {
                if held.holder.key != holder.key {
                    let secs = ((held.until - now).max(0) + 999) / 1000;
                    return Err(format!(
                        "Tab {tab} is in use by {}, free in ~{secs} s; use another tab or wait",
                        held.holder.label
                    ));
                }
                held.until = now + TTL_MS;
                held.process = process;
                expired
            } else {
                state.tabs.insert(
                    tab.to_string(),
                    Held {
                        workspace_id: workspace_id.to_string(),
                        holder: holder.clone(),
                        until: now + TTL_MS,
                        process,
                    },
                );
                true
            };
            state.last.insert(holder.key.clone(), tab.to_string());
            changed.then(|| snapshot(&mut state, now))
        };
        self.announce(change);
        Ok(())
    }

    /// Lets the tab go, if `holder` has it. Whether anything was released.
    pub fn release(&self, tab: &str, holder: &Holder, now: i64) -> bool {
        let change = {
            let mut state = self.lock();
            let theirs = state.tabs.get(tab).is_some_and(|held| held.holder.key == holder.key);
            if theirs {
                state.tabs.remove(tab);
            }
            theirs.then(|| snapshot(&mut state, now))
        };
        self.announce_if(change)
    }

    /// The user takes a tab back from whoever holds it.
    pub fn force_release(&self, tab: &str, now: i64) -> bool {
        let change = {
            let mut state = self.lock();
            let released = state.tabs.remove(tab).is_some();
            released.then(|| snapshot(&mut state, now))
        };
        self.announce_if(change)
    }

    /// Every tab `key` holds, for a session that was deleted. How many went.
    pub fn release_all(&self, key: &str, now: i64) -> usize {
        let (count, change) = {
            let mut state = self.lock();
            let before = state.tabs.len();
            state.tabs.retain(|_, held| held.holder.key != key);
            state.last.remove(key);
            let count = before - state.tabs.len();
            (count, (count > 0).then(|| snapshot(&mut state, now)))
        };
        self.announce(change);
        count
    }

    /// A process starts for `key` (a terminal session's CLI), and the calls
    /// from now on are its. The number is what [`Leases::end_process`] takes
    /// when it exits.
    pub fn begin_process(&self, key: &str) -> u64 {
        let mut state = self.lock();
        state.next_process += 1;
        let process = state.next_process;
        state.processes.insert(key.to_string(), process);
        process
    }

    /// The process `begin_process` numbered exited: the tabs it drove go free
    /// with it, rather than at their TTL. A respawn starts the next process
    /// before this one's exit is seen, so tabs the next one has taken or
    /// renewed since stay its. How many went.
    pub fn end_process(&self, key: &str, process: u64, now: i64) -> usize {
        let (count, change) = {
            let mut state = self.lock();
            let current = state.processes.get(key) == Some(&process);
            if current {
                state.processes.remove(key);
            }
            let mut gone = Vec::new();
            state.tabs.retain(|tab, held| {
                let theirs = held.holder.key == key && held.process <= process;
                if theirs {
                    gone.push(tab.clone());
                }
                !theirs
            });
            // The default tab is the next process's too, unless it was one that just went.
            if current || state.last.get(key).is_some_and(|tab| gone.contains(tab)) {
                state.last.remove(key);
            }
            let count = gone.len();
            (count, (count > 0).then(|| snapshot(&mut state, now)))
        };
        self.announce(change);
        count
    }

    /// A closed tab takes its lease and anyone's memory of it along.
    pub fn forget_tab(&self, tab: &str, now: i64) {
        let change = {
            let mut state = self.lock();
            state.last.retain(|_, last| last != tab);
            let held = state.tabs.remove(tab).is_some();
            held.then(|| snapshot(&mut state, now))
        };
        self.announce(change);
    }

    /// Drops leases that ran out. Whether any did; the change is announced.
    pub fn sweep(&self, now: i64) -> bool {
        let change = {
            let mut state = self.lock();
            let expired = drop_expired(&mut state, now);
            expired.then(|| snapshot(&mut state, now))
        };
        self.announce_if(change)
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

    /// Every live lease, stamped with the sequence of the last change: the
    /// same state an announcement of that change carried.
    pub fn list(&self, now: i64) -> BrowserLeases {
        let state = self.lock();
        build(&state, now)
    }

    /// Hands a change to the hook. Each list was built and numbered under the
    /// state lock, but two can still reach the hook in either order once the
    /// lock is dropped; the clients keep the higher `seq`.
    fn announce(&self, change: Option<BrowserLeases>) {
        let Some(all) = change else { return };
        let hook = self.on_change.lock().unwrap_or_else(|e| e.into_inner()).clone();
        if let Some(hook) = hook {
            hook(all);
        }
    }

    fn announce_if(&self, change: Option<BrowserLeases>) -> bool {
        let changed = change.is_some();
        self.announce(change);
        changed
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

/// The list after a change, under a new number.
fn snapshot(state: &mut State, now: i64) -> BrowserLeases {
    state.seq += 1;
    build(state, now)
}

fn build(state: &State, now: i64) -> BrowserLeases {
    let mut leases: Vec<BrowserLease> = state
        .tabs
        .iter()
        .filter(|(_, held)| held.until > now)
        .map(|(tab, held)| describe(tab, held))
        .collect();
    leases.sort_by(|a, b| a.tab.cmp(&b.tab));
    BrowserLeases { seq: state.seq, leases }
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

    fn tabs(leases: &Leases, now: i64) -> Vec<String> {
        leases.list(now).leases.into_iter().map(|l| l.tab).collect()
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
        assert_eq!(tabs(&leases, NOW), ["browser:3"]);
    }

    #[test]
    fn a_process_that_exits_lets_go_of_its_tabs() {
        let leases = Leases::new();
        let first = leases.begin_process("s-ada");
        leases.claim("browser:1", "w", &ada(), NOW).expect("free");
        leases.claim("browser:2", "w", &bob(), NOW).expect("free");
        assert_eq!(leases.end_process("s-ada", first, NOW), 1);
        assert_eq!(leases.last_tab("s-ada"), None);
        assert_eq!(tabs(&leases, NOW), ["browser:2"]);
    }

    /// A terminal respawn starts the new process before the old one's exit
    /// is seen; that exit must not free what the new one already drives.
    #[test]
    fn a_respawned_terminal_keeps_the_tabs_its_new_process_took() {
        let leases = Leases::new();
        let old = leases.begin_process("s-ada");
        leases.claim("browser:old", "w", &ada(), NOW).expect("free");
        leases.claim("browser:both", "w", &ada(), NOW).expect("free");
        let new = leases.begin_process("s-ada");
        leases.claim("browser:new", "w", &ada(), NOW + 1).expect("free");
        leases.claim("browser:both", "w", &ada(), NOW + 1).expect("renewed by the new process");
        assert_eq!(leases.end_process("s-ada", old, NOW + 2), 1);
        assert_eq!(tabs(&leases, NOW + 2), ["browser:both", "browser:new"]);
        assert_eq!(leases.last_tab("s-ada").as_deref(), Some("browser:both"));
        // The new one exiting takes the rest.
        assert_eq!(leases.end_process("s-ada", new, NOW + 3), 2);
        assert!(tabs(&leases, NOW + 3).is_empty());
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

    /// Announcements race each other to the hook once the lock is dropped;
    /// the number each carries says which is newer, and a list read in
    /// between carries the number of the change it shows.
    #[test]
    fn every_change_is_numbered_in_the_order_it_happened() {
        let leases = Leases::new();
        let seen = Arc::new(Mutex::new(Vec::new()));
        let sink = seen.clone();
        leases.set_on_change(move |all| sink.lock().unwrap().push((all.seq, all.leases.len())));
        let start = leases.list(NOW).seq;
        leases.claim("browser:1", "w", &ada(), NOW).expect("free");
        assert_eq!(leases.list(NOW).seq, start + 1);
        leases.claim("browser:1", "w", &ada(), NOW + 1).expect("renew");
        leases.release("browser:1", &ada(), NOW + 2);
        assert_eq!(*seen.lock().unwrap(), [(start + 1, 1), (start + 2, 0)]);
        // Many threads at once: every change gets its own number, one apart.
        let threads: Vec<_> = (0..8)
            .map(|i| {
                let leases = leases.clone();
                std::thread::spawn(move || {
                    let who = Holder::session(&format!("s-{i}"), "S");
                    leases.claim(&format!("browser:t{i}"), "w", &who, NOW).expect("free");
                })
            })
            .collect();
        threads.into_iter().for_each(|t| t.join().unwrap());
        let mut numbers: Vec<u64> = seen.lock().unwrap().iter().map(|(seq, _)| *seq).collect();
        numbers.sort();
        assert_eq!(numbers, (start + 1..=start + 10).collect::<Vec<_>>());
        // The newest number carries the fullest list.
        let newest = seen.lock().unwrap().iter().max_by_key(|(seq, _)| *seq).copied();
        assert_eq!(newest, Some((start + 10, 8)));
    }

    #[test]
    fn a_restarted_daemon_numbers_after_the_one_before() {
        let before = Leases::new();
        before.claim("browser:1", "w", &ada(), NOW).expect("free");
        std::thread::sleep(std::time::Duration::from_millis(2));
        let after = Leases::new();
        assert!(after.list(NOW).seq > before.list(NOW).seq);
    }
}
