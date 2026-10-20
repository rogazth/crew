//! Codex: `account/rateLimits/read` and `account/read` of a short-lived
//! `codex app-server`, and the `account/rateLimits/updated` notification a
//! session's own app-server sends.

use std::io::{BufRead, BufReader, Write};
use std::process::{Command, Stdio};
use std::sync::mpsc;
use std::time::{Duration, Instant};

use crew_protocol::{PlanUsage, UsageWindow};
use serde_json::{json, Value};

use super::window_label;

const PROBE_TIMEOUT: Duration = Duration::from_secs(20);

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

/// Starts an app-server, asks it, and stops it: usage is readable with no
/// session running.
pub fn probe(bin: &str) -> Option<PlanUsage> {
    let mut child =
        Command::new(bin).arg("app-server").stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::null()).spawn().ok()?;
    let mut stdin = child.stdin.take()?;
    let stdout = child.stdout.take()?;
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
    let requests = [
        json!({ "id": 1, "method": "initialize", "params": { "clientInfo": { "name": "crew", "title": "Crew", "version": "0" } } }),
        json!({ "method": "initialized", "params": {} }),
        json!({ "id": 2, "method": "account/rateLimits/read" }),
        json!({ "id": 3, "method": "account/read", "params": { "refreshToken": false } }),
    ];
    let sent = requests.iter().try_for_each(|request| writeln!(stdin, "{request}"));
    let (mut limits, mut account) = (None, None);
    if sent.is_ok() {
        let deadline = Instant::now() + PROBE_TIMEOUT;
        while limits.is_none() || account.is_none() {
            let Some(wait) = deadline.checked_duration_since(Instant::now()) else {
                break;
            };
            let Ok(message) = rx.recv_timeout(wait) else {
                break;
            };
            match message.get("id").and_then(Value::as_u64) {
                Some(2) => limits = Some(message.get("result").cloned().unwrap_or(Value::Null)),
                Some(3) => account = Some(message.get("result").cloned().unwrap_or(Value::Null)),
                _ => {}
            }
        }
    }
    drop(stdin);
    let _ = child.kill();
    let _ = child.wait();
    reading(limits.as_ref()?, account.as_ref(), crate::store::now_millis())
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
        assert_eq!((read.account.as_deref(), read.plan.as_deref(), read.source.as_str()), (Some("a@b.dev"), Some("plus"), "app-server"));
        assert_eq!(reading(&limits, None, 5).unwrap().account.as_deref(), Some("8bedcad8"));
        assert!(reading(&json!({}), None, 5).is_none());
    }
}
