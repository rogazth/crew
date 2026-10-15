//! The daemon's line to the browser. Pages live in Electron main, which owns
//! their `webContents`; crewd only knows who may drive which tab. Main opens
//! its own connection to crewd and registers as a browser host, and each
//! tool call travels to it as a `browser-call` event and comes back as a
//! `browser_result` request.
//!
//! Every Mac with Crew open is a host of every machine it knows, so a remote
//! crewd may have several at once. A Mac reports the pages it shows for that
//! machine's workspaces; a call on a tab goes to the host that reported it.
//!
//! `call` blocks, because tools run on the bridge's threads, one per call.

use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::mpsc;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use crew_protocol::{BrowserCall, BrowserPageRef};
use serde_json::Value;

use crate::browser::OpenPage;

/// Hands an event to one connected client. False when that client is gone.
pub type EventSink = Arc<dyn Fn(u64, &str, Value) -> bool + Send + Sync>;

pub const NO_HOST: &str = "Open Crew to use the browser.";

/// Said on a remote machine, where the browser is a Mac's.
pub const NO_HOST_REMOTE: &str = "No Mac with Crew open is connected to this machine. The browser runs in Crew on a Mac that has this machine added; once Crew is open there, try again.";

/// A host that acks its calls has this long to say it got one.
const ACK_TIMEOUT: Duration = Duration::from_secs(8);
/// How long a tab whose Mac went away is remembered as such.
const GONE_MS: i64 = 10 * 60_000;

type Outcome = Result<Value, String>;

enum Reply {
    /// The host has the call; its answer may take the whole budget.
    Ack,
    Done(Outcome),
}

struct Pending {
    host: u64,
    reply: mpsc::Sender<Reply>,
}

/// What a host says about itself when it registers.
#[derive(Clone, Debug, Default)]
pub struct Hello {
    /// The Mac's name, shown when a machine has more than one host.
    pub name: String,
    /// It acks each call on arrival, so one that never acks is not there.
    pub acks: bool,
}

struct Host {
    client: u64,
    hello: Hello,
    /// When it registered and was last focused, in the relay's own count.
    registered: u64,
    focused: u64,
    pages: Vec<OpenPage>,
}

/// A page some host reported, and which one.
#[derive(Clone, Debug)]
pub struct HostedPage {
    pub page: OpenPage,
    pub host: u64,
}

#[derive(Default)]
struct Inner {
    hosts: Mutex<Vec<Host>>,
    pending: Mutex<HashMap<u64, Pending>>,
    /// Tabs of a host that went away: the Mac's name, and when.
    gone: Mutex<HashMap<String, (String, i64)>>,
    next: AtomicU64,
    order: AtomicU64,
    send: Mutex<Option<EventSink>>,
    remote: std::sync::atomic::AtomicBool,
    ack_timeout: Mutex<Option<Duration>>,
}

#[derive(Clone, Default)]
pub struct BrowserRelay {
    inner: Arc<Inner>,
}

impl BrowserRelay {
    pub fn new() -> Self {
        Self::default()
    }

    /// How events reach a client: crewd's hub, or a test's channel.
    pub fn set_sender(&self, send: EventSink) {
        *self.inner.send.lock().unwrap_or_else(|e| e.into_inner()) = Some(send);
    }

    /// A `crewd serve`: its browser is on whichever Macs connect to it.
    pub fn set_remote(&self, remote: bool) {
        self.inner.remote.store(remote, Ordering::Relaxed);
    }

    /// What a call with no host to go to says.
    pub fn no_host(&self) -> &'static str {
        if self.inner.remote.load(Ordering::Relaxed) {
            NO_HOST_REMOTE
        } else {
            NO_HOST
        }
    }

    pub fn is_remote(&self) -> bool {
        self.inner.remote.load(Ordering::Relaxed)
    }

    #[doc(hidden)]
    pub fn set_ack_timeout(&self, timeout: Duration) {
        *self.inner.ack_timeout.lock().unwrap_or_else(|e| e.into_inner()) = Some(timeout);
    }

    /// A client becomes a host, alongside any there are. Registering again
    /// (a main that reconnected) keeps its pages and counts as the newest.
    pub fn register_host(&self, client: u64, hello: Hello) {
        let order = self.tick();
        let mut hosts = self.hosts();
        match hosts.iter_mut().find(|host| host.client == client) {
            Some(host) => {
                host.hello = hello;
                host.registered = order;
            }
            None => hosts.push(Host {
                client,
                hello,
                registered: order,
                focused: 0,
                pages: Vec::new(),
            }),
        }
    }

    /// The pages `client` shows for this machine's workspaces, all of them.
    pub fn set_pages(&self, client: u64, pages: Vec<OpenPage>) -> Result<(), String> {
        let mut hosts = self.hosts();
        let host = hosts
            .iter_mut()
            .find(|host| host.client == client)
            .ok_or("Register as the browser host first")?;
        let mut gone = self.gone();
        for page in &pages {
            gone.remove(&page.page_id);
        }
        host.pages = pages;
        Ok(())
    }

    /// The user is at this host: a new tab opens there.
    pub fn focus(&self, client: u64) {
        let order = self.tick();
        if let Some(host) = self.hosts().iter_mut().find(|host| host.client == client) {
            host.focused = order;
        }
    }

    /// A client disconnected. If it was a host, its calls fail now rather
    /// than at their timeouts, and its tabs are remembered as gone with it.
    pub fn client_gone(&self, client: u64) {
        let removed = {
            let mut hosts = self.hosts();
            let at = hosts.iter().position(|host| host.client == client);
            at.map(|at| hosts.remove(at))
        };
        let Some(host) = removed else {
            return;
        };
        let now = crate::store::now_millis();
        let name = self.label(&host.hello);
        {
            let mut gone = self.gone();
            gone.retain(|_, (_, at)| now - *at < GONE_MS);
            for page in &host.pages {
                gone.insert(page.page_id.clone(), (name.clone(), now));
            }
        }
        self.fail_calls_on(client, &format!("{name} went away mid-call (Crew closed, or the Mac asleep or offline)."));
    }

    pub fn has_host(&self) -> bool {
        !self.hosts().is_empty()
    }

    pub fn host_count(&self) -> usize {
        self.hosts().len()
    }

    /// Where a new tab goes: the host focused last, else the one registered last.
    pub fn default_host(&self) -> Option<u64> {
        self.hosts().iter().max_by_key(|host| (host.focused, host.registered)).map(|host| host.client)
    }

    pub fn is_host(&self, client: u64) -> bool {
        self.hosts().iter().any(|host| host.client == client)
    }

    /// A host's name, as a tab list shows it.
    pub fn host_name(&self, client: u64) -> Option<String> {
        self.hosts().iter().find(|host| host.client == client).map(|host| self.label(&host.hello))
    }

    /// Every page the hosts reported, with the host of each.
    pub fn hosted_pages(&self) -> Vec<HostedPage> {
        self.hosts()
            .iter()
            .flat_map(|host| host.pages.iter().map(|page| HostedPage { page: page.clone(), host: host.client }))
            .collect()
    }

    /// The Mac a tab was on, when that Mac went away recently.
    pub fn gone_with(&self, tab: &str) -> Option<String> {
        let now = crate::store::now_millis();
        self.gone()
            .get(tab)
            .filter(|(_, at)| now - *at < GONE_MS)
            .map(|(name, _)| name.clone())
    }

    /// Runs `tool` on `tab` in `host` (the default host when `None`) and
    /// waits for its content blocks.
    pub fn call(
        &self,
        host: Option<u64>,
        tab: &str,
        tool: &str,
        args: Value,
        page: Option<BrowserPageRef>,
        timeout: Duration,
    ) -> Result<Value, String> {
        let (host, hello) = {
            let hosts = self.hosts();
            let found = match host {
                Some(client) => hosts.iter().find(|candidate| candidate.client == client),
                None => hosts.iter().max_by_key(|candidate| (candidate.focused, candidate.registered)),
            };
            match found {
                Some(found) => (found.client, found.hello.clone()),
                None if host.is_some() => {
                    return Err(match self.gone_with(tab) {
                        Some(name) => gone_message(tab, &name),
                        None => format!("The Mac showing {tab} is no longer connected. list_tabs shows the tabs there are now."),
                    });
                }
                None => return Err(self.no_host().into()),
            }
        };
        let send = self.inner.send.lock().unwrap_or_else(|e| e.into_inner()).clone();
        let Some(send) = send else {
            return Err(self.no_host().into());
        };
        let call_id = self.inner.next.fetch_add(1, Ordering::Relaxed) + 1;
        let (reply, answer) = mpsc::channel();
        self.pending().insert(call_id, Pending { host, reply });
        let payload = serde_json::to_value(BrowserCall {
            call_id,
            tab: tab.to_string(),
            tool: tool.to_string(),
            args,
            page,
            deadline: crate::store::now_millis() + timeout.as_millis() as i64,
            timeout_ms: Some(timeout.as_millis() as u64),
        })
        .map_err(|e| e.to_string())?;
        if !send(host, "browser-call", payload) {
            self.pending().remove(&call_id);
            self.client_gone(host);
            return Err(self.no_host().into());
        }
        let deadline = Instant::now() + timeout;
        let ack_timeout = self.inner.ack_timeout.lock().unwrap_or_else(|e| e.into_inner()).unwrap_or(ACK_TIMEOUT);
        let mut acked = !hello.acks;
        let outcome = loop {
            let left = deadline.saturating_duration_since(Instant::now());
            let wait = if acked { left } else { left.min(ack_timeout) };
            match answer.recv_timeout(wait) {
                Ok(Reply::Ack) => acked = true,
                Ok(Reply::Done(outcome)) => break outcome,
                Err(mpsc::RecvTimeoutError::Timeout) if !acked && Instant::now() < deadline => {
                    break Err(format!(
                        "{} did not answer (asleep or offline?). Try again once it is back.",
                        self.label(&hello)
                    ));
                }
                Err(mpsc::RecvTimeoutError::Timeout) => {
                    break Err(format!("The browser did not answer {tool} within {} s.", timeout.as_secs()));
                }
                Err(mpsc::RecvTimeoutError::Disconnected) => break Err(self.no_host().into()),
            }
        };
        self.pending().remove(&call_id);
        outcome
    }

    /// The host has the call, and is working on it.
    pub fn ack(&self, client: u64, call_id: u64) {
        if let Some(call) = self.pending().get(&call_id).filter(|call| call.host == client) {
            let _ = call.reply.send(Reply::Ack);
        }
    }

    /// The host's answer. Only the client a call was sent to may answer it,
    /// so the window's own connection cannot forge a page's contents.
    pub fn resolve(&self, client: u64, call_id: u64, outcome: Outcome) -> Result<(), String> {
        let mut pending = self.pending();
        match pending.get(&call_id) {
            Some(call) if call.host == client => {}
            Some(_) => return Err("That call was not sent to this client".into()),
            // Timed out already; the answer has nobody left to read it.
            None => return Ok(()),
        }
        if let Some(call) = pending.remove(&call_id) {
            let _ = call.reply.send(Reply::Done(outcome));
        }
        Ok(())
    }

    fn label(&self, hello: &Hello) -> String {
        if hello.name.is_empty() {
            "The Mac".into()
        } else {
            hello.name.clone()
        }
    }

    fn tick(&self) -> u64 {
        self.inner.order.fetch_add(1, Ordering::Relaxed) + 1
    }

    fn fail_calls_on(&self, client: u64, why: &str) {
        let mut pending = self.pending();
        let ids: Vec<u64> = pending.iter().filter(|(_, call)| call.host == client).map(|(id, _)| *id).collect();
        for id in ids {
            if let Some(call) = pending.remove(&id) {
                let _ = call.reply.send(Reply::Done(Err(why.to_string())));
            }
        }
    }

    fn hosts(&self) -> std::sync::MutexGuard<'_, Vec<Host>> {
        self.inner.hosts.lock().unwrap_or_else(|e| e.into_inner())
    }

    fn gone(&self) -> std::sync::MutexGuard<'_, HashMap<String, (String, i64)>> {
        self.inner.gone.lock().unwrap_or_else(|e| e.into_inner())
    }

    fn pending(&self) -> std::sync::MutexGuard<'_, HashMap<u64, Pending>> {
        self.inner.pending.lock().unwrap_or_else(|e| e.into_inner())
    }
}

/// A tab whose Mac went away, told so.
pub fn gone_message(tab: &str, name: &str) -> String {
    format!("{tab} was on {name}, which is no longer connected (Crew closed, or the Mac asleep or offline). list_tabs shows the tabs there are now.")
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use std::thread;

    /// A relay whose events land in a channel, the way the hub would send them.
    fn relay() -> (BrowserRelay, mpsc::Receiver<(u64, String, Value)>) {
        let relay = BrowserRelay::new();
        let (tx, rx) = mpsc::channel();
        let tx = Mutex::new(tx);
        relay.set_sender(Arc::new(move |client, event, payload| {
            tx.lock().unwrap().send((client, event.to_string(), payload)).is_ok()
        }));
        (relay, rx)
    }

    #[test]
    fn without_a_host_the_call_says_to_open_crew() {
        let (relay, _) = relay();
        let error = relay.call(None, "browser:1", "browser_snapshot", json!({}), None, Duration::from_secs(1));
        assert_eq!(error, Err(NO_HOST.to_string()));
    }

    #[test]
    fn a_call_goes_to_the_host_and_its_answer_comes_back() {
        let (relay, events) = relay();
        relay.register_host(7, Hello::default());
        let host = relay.clone();
        let answering = thread::spawn(move || {
            let (client, event, payload) = events.recv().unwrap();
            assert_eq!((client, event.as_str()), (7, "browser-call"));
            assert_eq!(payload["tab"], "browser:1");
            // When the caller stops waiting, so the host can skip it rather than run it late.
            let left = payload["deadline"].as_i64().unwrap() - crate::store::now_millis();
            assert!((4_000..=5_000).contains(&left), "{left}");
            let call_id = payload["callId"].as_u64().unwrap();
            // Another client cannot answer for the host.
            assert!(host.resolve(3, call_id, Ok(json!("forged"))).is_err());
            host.resolve(7, call_id, Ok(json!([{ "type": "text", "text": "ok" }]))).unwrap();
        });
        let out = relay
            .call(None, "browser:1", "browser_snapshot", json!({}), None, Duration::from_secs(5))
            .expect("answered");
        assert_eq!(out[0]["text"], "ok");
        answering.join().unwrap();
    }

    #[test]
    fn a_host_that_never_answers_times_out() {
        let (relay, _events) = relay();
        relay.register_host(7, Hello::default());
        let error = relay
            .call(None, "browser:1", "browser_click", json!({}), None, Duration::from_millis(50))
            .expect_err("no answer");
        assert!(error.contains("did not answer browser_click"), "{error}");
        // A late answer is dropped quietly.
        assert!(relay.resolve(7, 1, Ok(json!(null))).is_ok());
    }

    #[test]
    fn a_host_that_disconnects_fails_its_calls_at_once() {
        let (relay, events) = relay();
        relay.register_host(7, Hello::default());
        let host = relay.clone();
        let dropping = thread::spawn(move || {
            events.recv().unwrap();
            host.client_gone(7);
        });
        let started = std::time::Instant::now();
        let error = relay
            .call(None, "browser:1", "browser_snapshot", json!({}), None, Duration::from_secs(10))
            .expect_err("gone");
        assert!(started.elapsed() < Duration::from_secs(5));
        assert!(error.contains("went away"), "{error}");
        dropping.join().unwrap();
        assert!(!relay.has_host());
    }

    fn page(id: &str, workspace: &str) -> OpenPage {
        OpenPage {
            page_id: id.into(),
            context: workspace.into(),
            workspace_id: workspace.into(),
            url: "http://localhost:3000/".into(),
            title: String::new(),
        }
    }

    /// Answers every call `client` gets with its own number.
    fn answer_as(relay: &BrowserRelay, events: mpsc::Receiver<(u64, String, Value)>) -> thread::JoinHandle<()> {
        let host = relay.clone();
        thread::spawn(move || {
            while let Ok((client, _, payload)) = events.recv() {
                let call_id = payload["callId"].as_u64().unwrap();
                host.ack(client, call_id);
                host.resolve(client, call_id, Ok(json!(client))).unwrap();
            }
        })
    }

    #[test]
    fn every_mac_is_a_host_and_a_tab_goes_to_the_one_that_shows_it() {
        let (relay, events) = relay();
        relay.register_host(7, Hello { name: "Ada's Mac".into(), acks: true });
        relay.register_host(9, Hello { name: "Studio".into(), acks: true });
        relay.set_pages(7, vec![page("browser:a", "w")]).unwrap();
        relay.set_pages(9, vec![page("browser:b", "w")]).unwrap();
        let _answering = answer_as(&relay, events);
        let on = |host| relay.call(Some(host), "browser:x", "browser_snapshot", json!({}), None, Duration::from_secs(5));
        assert_eq!(on(7), Ok(json!(7)));
        assert_eq!(on(9), Ok(json!(9)));
        let hosted: Vec<(String, u64)> = relay.hosted_pages().into_iter().map(|hosted| (hosted.page.page_id, hosted.host)).collect();
        assert_eq!(hosted, [("browser:a".to_string(), 7), ("browser:b".to_string(), 9)]);
        // A new tab opens where the user was last, else on the newest host.
        assert_eq!(relay.default_host(), Some(9));
        relay.focus(7);
        assert_eq!(relay.default_host(), Some(7));
        // One Mac leaving keeps the other.
        relay.client_gone(7);
        assert_eq!(relay.default_host(), Some(9));
        assert_eq!(relay.gone_with("browser:a").as_deref(), Some("Ada's Mac"));
        let error = relay.call(Some(7), "browser:a", "browser_snapshot", json!({}), None, Duration::from_secs(1)).unwrap_err();
        assert!(error.contains("browser:a was on Ada's Mac, which is no longer connected"), "{error}");
        // Back again, its tabs are not gone any more.
        relay.register_host(11, Hello { name: "Ada's Mac".into(), acks: true });
        relay.set_pages(11, vec![page("browser:a", "w")]).unwrap();
        assert_eq!(relay.gone_with("browser:a"), None);
    }

    #[test]
    fn a_host_that_acks_and_goes_quiet_fails_fast() {
        let (relay, _events) = relay();
        relay.set_ack_timeout(Duration::from_millis(100));
        relay.register_host(7, Hello { name: "Ada's Mac".into(), acks: true });
        let started = Instant::now();
        let error = relay
            .call(None, "browser:1", "browser_snapshot", json!({}), None, Duration::from_secs(10))
            .expect_err("asleep");
        assert!(started.elapsed() < Duration::from_secs(2));
        assert!(error.contains("Ada's Mac did not answer (asleep or offline?)"), "{error}");
    }

    #[test]
    fn an_acked_call_waits_its_whole_budget() {
        let (relay, events) = relay();
        relay.set_ack_timeout(Duration::from_millis(50));
        relay.register_host(7, Hello { name: String::new(), acks: true });
        let host = relay.clone();
        let slow = thread::spawn(move || {
            let (client, _, payload) = events.recv().unwrap();
            let call_id = payload["callId"].as_u64().unwrap();
            host.ack(client, call_id);
            thread::sleep(Duration::from_millis(300));
            host.resolve(client, call_id, Ok(json!("late but fine"))).unwrap();
        });
        let out = relay.call(None, "browser:1", "browser_wait_for", json!({}), None, Duration::from_secs(5));
        assert_eq!(out, Ok(json!("late but fine")));
        slow.join().unwrap();
    }

    #[test]
    fn a_remote_without_a_host_says_no_mac_is_connected() {
        let (relay, _) = relay();
        relay.set_remote(true);
        let error = relay.call(None, "browser:1", "browser_snapshot", json!({}), None, Duration::from_secs(1));
        assert_eq!(error, Err(NO_HOST_REMOTE.to_string()));
        assert!(relay.set_pages(3, vec![]).is_err(), "only a host reports pages");
    }
}
