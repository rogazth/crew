//! The daemon's line to the browser. Pages live in Electron main, which owns
//! their `webContents`; crewd only knows who may drive which tab. Main opens
//! its own connection to crewd and registers as the browser host, and each
//! tool call travels to it as a `browser-call` event and comes back as a
//! `browser_result` request.
//!
//! `call` blocks, because tools run on the bridge's threads, one per call.

use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::mpsc;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use crew_protocol::{BrowserCall, BrowserPageRef};
use serde_json::Value;

/// Hands an event to one connected client. False when that client is gone.
pub type EventSink = Arc<dyn Fn(u64, &str, Value) -> bool + Send + Sync>;

pub const NO_HOST: &str = "Open Crew to use the browser.";

type Outcome = Result<Value, String>;

struct Pending {
    host: u64,
    reply: mpsc::Sender<Outcome>,
}

#[derive(Default)]
struct Inner {
    host: Mutex<Option<u64>>,
    pending: Mutex<HashMap<u64, Pending>>,
    next: AtomicU64,
    send: Mutex<Option<EventSink>>,
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

    /// The newest registration wins: a main that reconnected after a daemon
    /// restart, or a window reopened, replaces the one before.
    pub fn register_host(&self, client: u64) {
        let previous = self.inner.host.lock().unwrap_or_else(|e| e.into_inner()).replace(client);
        if let Some(previous) = previous.filter(|previous| *previous != client) {
            self.fail_calls_on(previous, "The browser host was replaced; try again.");
        }
    }

    /// A client disconnected. If it was the host, its calls fail now rather
    /// than at their timeouts.
    pub fn client_gone(&self, client: u64) {
        let was_host = {
            let mut host = self.inner.host.lock().unwrap_or_else(|e| e.into_inner());
            let was = *host == Some(client);
            if was {
                *host = None;
            }
            was
        };
        if was_host {
            self.fail_calls_on(client, "Crew's window went away mid-call.");
        }
    }

    pub fn has_host(&self) -> bool {
        self.inner.host.lock().unwrap_or_else(|e| e.into_inner()).is_some()
    }

    /// Runs `tool` on `tab` in the host and waits for its content blocks.
    pub fn call(
        &self,
        tab: &str,
        tool: &str,
        args: Value,
        page: Option<BrowserPageRef>,
        timeout: Duration,
    ) -> Result<Value, String> {
        let Some(host) = *self.inner.host.lock().unwrap_or_else(|e| e.into_inner()) else {
            return Err(NO_HOST.into());
        };
        let send = self.inner.send.lock().unwrap_or_else(|e| e.into_inner()).clone();
        let Some(send) = send else {
            return Err(NO_HOST.into());
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
        })
        .map_err(|e| e.to_string())?;
        if !send(host, "browser-call", payload) {
            self.pending().remove(&call_id);
            self.client_gone(host);
            return Err(NO_HOST.into());
        }
        let outcome = answer.recv_timeout(timeout);
        self.pending().remove(&call_id);
        match outcome {
            Ok(outcome) => outcome,
            Err(mpsc::RecvTimeoutError::Timeout) => Err(format!(
                "The browser did not answer {tool} within {} s.",
                timeout.as_secs()
            )),
            Err(mpsc::RecvTimeoutError::Disconnected) => Err(NO_HOST.into()),
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
            let _ = call.reply.send(outcome);
        }
        Ok(())
    }

    fn fail_calls_on(&self, client: u64, why: &str) {
        let mut pending = self.pending();
        let ids: Vec<u64> = pending.iter().filter(|(_, call)| call.host == client).map(|(id, _)| *id).collect();
        for id in ids {
            if let Some(call) = pending.remove(&id) {
                let _ = call.reply.send(Err(why.to_string()));
            }
        }
    }

    fn pending(&self) -> std::sync::MutexGuard<'_, HashMap<u64, Pending>> {
        self.inner.pending.lock().unwrap_or_else(|e| e.into_inner())
    }
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
        let error = relay.call("browser:1", "browser_snapshot", json!({}), None, Duration::from_secs(1));
        assert_eq!(error, Err(NO_HOST.to_string()));
    }

    #[test]
    fn a_call_goes_to_the_host_and_its_answer_comes_back() {
        let (relay, events) = relay();
        relay.register_host(7);
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
            .call("browser:1", "browser_snapshot", json!({}), None, Duration::from_secs(5))
            .expect("answered");
        assert_eq!(out[0]["text"], "ok");
        answering.join().unwrap();
    }

    #[test]
    fn a_host_that_never_answers_times_out() {
        let (relay, _events) = relay();
        relay.register_host(7);
        let error = relay
            .call("browser:1", "browser_click", json!({}), None, Duration::from_millis(50))
            .expect_err("no answer");
        assert!(error.contains("did not answer browser_click"), "{error}");
        // A late answer is dropped quietly.
        assert!(relay.resolve(7, 1, Ok(json!(null))).is_ok());
    }

    #[test]
    fn a_host_that_disconnects_fails_its_calls_at_once() {
        let (relay, events) = relay();
        relay.register_host(7);
        let host = relay.clone();
        let dropping = thread::spawn(move || {
            events.recv().unwrap();
            host.client_gone(7);
        });
        let started = std::time::Instant::now();
        let error = relay
            .call("browser:1", "browser_snapshot", json!({}), None, Duration::from_secs(10))
            .expect_err("gone");
        assert!(started.elapsed() < Duration::from_secs(5));
        assert!(error.contains("went away"), "{error}");
        dropping.join().unwrap();
        assert!(!relay.has_host());
    }
}
