//! Codex: `account/rateLimits/read` and `account/read` of a short-lived
//! `codex app-server`, and the `account/rateLimits/updated` notification a
//! session's own app-server sends.

use std::io::{BufRead, BufReader, Write};
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::mpsc;
use std::time::{Duration, Instant};

use crew_protocol::{PlanUsage, UsageWindow};
use serde_json::{json, Value};

use super::window_label;

const PROBE_TIMEOUT: Duration = Duration::from_secs(20);
const ACCOUNT_TIMEOUT: Duration = Duration::from_secs(10);

/// The windows of a rate-limit snapshot (`primary`, `secondary`) and the plan.
pub fn parse_rate_limits(limits: &Value) -> (Vec<UsageWindow>, Option<String>) {
    let windows = ["primary", "secondary"]
        .into_iter()
        .filter_map(|id| {
            let window = limits.get(id).filter(|w| w.is_object())?;
            let used = window.get("usedPercent").and_then(Value::as_f64)?;
            let minutes = window.get("windowDurationMins").and_then(Value::as_i64);
            Some(UsageWindow {
                id: id.into(),
                label: minutes.map(window_label).unwrap_or_else(|| id.into()),
                used_percent: used.clamp(0.0, 100.0),
                window_minutes: minutes,
                resets_at: window.get("resetsAt").and_then(Value::as_i64).map(|s| s * 1000),
            })
        })
        .collect();
    let plan = limits.get("planType").and_then(Value::as_str).map(str::to_string);
    (windows, plan)
}

/// The email and plan of an `account/read` result.
pub fn parse_account(result: &Value) -> (Option<String>, Option<String>) {
    let account = result.get("account");
    let text = |key: &str| account.and_then(|a| a.get(key)).and_then(Value::as_str).map(str::to_string);
    (text("email"), text("planType"))
}

/// A running `codex app-server`: the JSON-lines it prints arrive on `rx`, and
/// the process ends with the value. Usage and account probes live a moment;
/// a device-code sign-in lives until the account answers.
pub struct AppServer {
    child: Child,
    stdin: ChildStdin,
    pub rx: mpsc::Receiver<Value>,
    next_id: u64,
}

impl AppServer {
    /// Starts the server and says hello. `bin` is the resolved `codex`.
    pub fn start(bin: &str) -> Option<Self> {
        let mut child = Command::new(bin)
            .arg("app-server")
            .env("PATH", crate::shell_path::joined())
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .spawn()
            .ok()?;
        let (Some(stdin), Some(stdout)) = (child.stdin.take(), child.stdout.take()) else {
            let _ = child.kill();
            let _ = child.wait();
            return None;
        };
        let (tx, rx) = mpsc::channel::<Value>();
        std::thread::spawn(move || {
            for line in BufReader::new(stdout).lines().map_while(Result::ok) {
                if let Ok(message) = serde_json::from_str::<Value>(&line) {
                    if tx.send(message).is_err() {
                        break;
                    }
                }
            }
        });
        let mut server = Self { child, stdin, rx, next_id: 0 };
        let hello = json!({ "id": 0, "method": "initialize", "params": { "clientInfo": { "name": "crew", "title": "Crew", "version": "0" } } });
        let sent = writeln!(server.stdin, "{hello}").and_then(|_| writeln!(server.stdin, "{}", json!({ "method": "initialized", "params": {} })));
        sent.ok()?;
        Some(server)
    }

    /// Sends a request; the id its answer will carry.
    pub fn send(&mut self, method: &str, params: Option<Value>) -> Option<u64> {
        self.next_id += 1;
        let mut request = json!({ "id": self.next_id, "method": method });
        if let Some(params) = params {
            request["params"] = params;
        }
        writeln!(self.stdin, "{request}").ok()?;
        Some(self.next_id)
    }

    /// The answers to `ids` (their `result`, or `Null` for an error), as far as they come before `timeout`.
    pub fn collect(&self, ids: &[u64], timeout: Duration) -> std::collections::HashMap<u64, Value> {
        let deadline = Instant::now() + timeout;
        let mut answers = std::collections::HashMap::new();
        while ids.iter().any(|id| !answers.contains_key(id)) {
            let Some(wait) = deadline.checked_duration_since(Instant::now()) else { break };
            let Ok(message) = self.rx.recv_timeout(wait) else { break };
            if let Some(id) = message.get("id").and_then(Value::as_u64) {
                answers.insert(id, message.get("result").cloned().unwrap_or(Value::Null));
            }
        }
        answers
    }

    /// One request and its answer; None when the server fails it or is silent.
    pub fn call(&mut self, method: &str, params: Option<Value>, timeout: Duration) -> Option<Value> {
        let id = self.send(method, params)?;
        let deadline = Instant::now() + timeout;
        loop {
            let message = self.rx.recv_timeout(deadline.checked_duration_since(Instant::now())?).ok()?;
            if message.get("id").and_then(Value::as_u64) == Some(id) {
                return message.get("result").cloned();
            }
        }
    }
}

impl Drop for AppServer {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

/// The signed-in account of a short-lived app-server: `account/read`, whose
/// result is `{ account: { type, email, planType } | null, requiresOpenaiAuth }`.
pub fn read_account(bin: &str) -> Option<Value> {
    let mut server = AppServer::start(bin)?;
    server.call("account/read", Some(json!({ "refreshToken": false })), ACCOUNT_TIMEOUT)
}

/// Starts an app-server, asks it, and stops it: usage is readable with no
/// session running.
pub fn probe(bin: &str) -> Option<PlanUsage> {
    let mut server = AppServer::start(bin)?;
    let limits = server.send("account/rateLimits/read", None)?;
    let account = server.send("account/read", Some(json!({ "refreshToken": false })))?;
    let mut answers = server.collect(&[limits, account], PROBE_TIMEOUT);
    reading(&answers.remove(&limits)?, answers.get(&account), crate::store::now_millis())
}

/// A reading out of the two results; none when Codex has no rate limits to show.
pub fn reading(limits: &Value, account: Option<&Value>, now: i64) -> Option<PlanUsage> {
    let snapshot = limits.get("rateLimits")?;
    let (windows, plan) = parse_rate_limits(snapshot);
    let (email, account_plan) = account.map(parse_account).unwrap_or((None, None));
    let account_id = limits.get("accountId").and_then(Value::as_str).map(str::to_string);
    Some(PlanUsage {
        provider: "codex".into(),
        account: email.or(account_id),
        plan: plan.or(account_plan),
        windows,
        tokens: None,
        cost: None,
        updated_at: now,
        source: "app-server".into(),
        status: None,
        overage_status: None,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    // As Codex 0.160 answers `account/rateLimits/read` and `account/read`.
    const LIMITS: &str = r#"{"ordinaryUsageAllowed":true,"rateLimits":{"limitId":"codex","limitName":null,
        "primary":{"usedPercent":42,"windowDurationMins":300,"resetsAt":1794878346},
        "secondary":{"usedPercent":7,"windowDurationMins":10080,"resetsAt":1795400000},
        "credits":{"hasCredits":false,"unlimited":false,"balance":null},"planType":"plus"},
        "accountId":"8bedcad8"}"#;
    const ACCOUNT: &str = r#"{"account":{"type":"chatgpt","email":"a@b.dev","planType":"plus"},"requiresOpenaiAuth":true}"#;

    #[test]
    fn rate_limits_give_a_window_per_snapshot() {
        let limits: Value = serde_json::from_str(LIMITS).unwrap();
        let (windows, plan) = parse_rate_limits(&limits["rateLimits"]);
        assert_eq!(plan.as_deref(), Some("plus"));
        assert_eq!(windows.len(), 2);
        assert_eq!((windows[0].id.as_str(), windows[0].label.as_str(), windows[0].used_percent), ("primary", "5 hours", 42.0));
        assert_eq!(windows[0].resets_at, Some(1_794_878_346_000));
        assert_eq!((windows[1].label.as_str(), windows[1].window_minutes), ("Weekly", Some(10080)));
    }

    #[test]
    fn a_free_plan_has_one_window_and_a_null_secondary() {
        let limits = json!({ "primary": { "usedPercent": 1, "windowDurationMins": 43200, "resetsAt": 1794878346 }, "secondary": null, "planType": "free" });
        let (windows, plan) = parse_rate_limits(&limits);
        assert_eq!((windows.len(), plan.as_deref(), windows[0].label.as_str()), (1, Some("free"), "Monthly"));
    }

    #[test]
    fn a_reading_names_the_account_by_email_then_by_id() {
        let limits: Value = serde_json::from_str(LIMITS).unwrap();
        let account: Value = serde_json::from_str(ACCOUNT).unwrap();
        let read = reading(&limits, Some(&account), 5).unwrap();
        assert_eq!(
            (read.account.as_deref(), read.plan.as_deref(), read.source.as_str()),
            (Some("a@b.dev"), Some("plus"), "app-server")
        );
        assert_eq!(reading(&limits, None, 5).unwrap().account.as_deref(), Some("8bedcad8"));
        assert!(reading(&json!({}), None, 5).is_none());
    }
}
