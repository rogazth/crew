//! Grok: `_x.ai/billing` of a short-lived `grok agent stdio`, the ACP
//! extension that answers with the plan's credit window (weekly or monthly)
//! and tier. The CLI signs the request itself and refreshes its own login.
//! The email is the one `grok login` kept in `~/.grok/auth.json`; nothing
//! else of that file is read.

use std::io::{BufRead, BufReader, Write};
use std::os::unix::process::CommandExt;
use std::process::{Command, Stdio};
use std::sync::mpsc;
use std::time::{Duration, Instant};

use crew_protocol::{PlanUsage, UsageWindow};
use serde_json::{json, Value};

use super::{parse_iso_ms, window_label};

const PROBE_TIMEOUT: Duration = Duration::from_secs(20);
/// How long the CLI is given to leave on its own once its stdin closes.
const EXIT_GRACE: Duration = Duration::from_secs(2);

pub fn read(bin: &str) -> Option<PlanUsage> {
    let (plan, windows) = parse_billing(&billing(bin)?)?;
    Some(PlanUsage {
        provider: "grok".into(),
        account: login_email(),
        plan,
        windows,
        tokens: None,
        cost: None,
        updated_at: crate::store::now_millis(),
        source: "cli".into(),
        status: None,
        overage_status: None,
    })
}

/// The `result` of `_x.ai/billing`, asked right after `initialize`.
fn billing(bin: &str) -> Option<Value> {
    let mut child = Command::new(bin)
        .args(["agent", "stdio"])
        .env("PATH", crate::shell_path::joined())
        .current_dir(std::env::temp_dir())
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .process_group(0)
        .spawn()
        .ok()?;
    let (Some(mut stdin), Some(stdout)) = (child.stdin.take(), child.stdout.take()) else {
        unsafe { libc::kill(-(child.id() as i32), libc::SIGKILL) };
        let _ = child.wait();
        return None;
    };
    let (tx, rx) = mpsc::channel::<Value>();
    std::thread::spawn(move || {
        for line in BufReader::new(stdout).lines().map_while(Result::ok) {
            let Ok(message) = serde_json::from_str::<Value>(&line) else { continue };
            if message.get("id").and_then(Value::as_u64) == Some(2) {
                let _ = tx.send(message);
                break;
            }
        }
    });
    let hello = json!({ "jsonrpc": "2.0", "id": 1, "method": "initialize", "params": { "protocolVersion": 1, "clientCapabilities": {} } });
    let ask = json!({ "jsonrpc": "2.0", "id": 2, "method": "_x.ai/billing", "params": {} });
    let answer = writeln!(stdin, "{hello}\n{ask}").ok().and_then(|_| rx.recv_timeout(PROBE_TIMEOUT).ok());
    // Closing stdin asks it to leave; one that lingers (or is mid-refresh) is
    // given a moment before its whole group is killed.
    drop(stdin);
    let deadline = Instant::now() + EXIT_GRACE;
    while matches!(child.try_wait(), Ok(None)) && Instant::now() < deadline {
        std::thread::sleep(Duration::from_millis(25));
    }
    if matches!(child.try_wait(), Ok(None)) {
        unsafe { libc::kill(-(child.id() as i32), libc::SIGKILL) };
    }
    let _ = child.wait();
    answer?.get("result").cloned()
}

/// The tier and credit window of a billing result. The share used is
/// `creditUsagePercent`, or on-demand spend over its cap; a plan that says
/// neither has no window rather than an empty one.
pub fn parse_billing(result: &Value) -> Option<(Option<String>, Vec<UsageWindow>)> {
    let config = result.get("config")?;
    let plan = result.get("subscription_tier").and_then(Value::as_str).filter(|t| !t.is_empty()).map(str::to_string);
    let time = |pointer: &str| config.pointer(pointer).and_then(Value::as_str).and_then(parse_iso_ms);
    let (start, end) = match time("/currentPeriod/end") {
        Some(end) => (time("/currentPeriod/start"), Some(end)),
        None => (time("/billingPeriodStart"), time("/billingPeriodEnd")),
    };
    let used = config.get("creditUsagePercent").and_then(Value::as_f64).or_else(|| {
        let used = config.pointer("/onDemandUsed/val").and_then(Value::as_f64)?;
        let cap = config.pointer("/onDemandCap/val").and_then(Value::as_f64).filter(|cap| *cap > 0.0)?;
        Some(used / cap * 100.0)
    });
    let kind = config.pointer("/currentPeriod/type").and_then(Value::as_str).unwrap_or_default();
    let minutes = start.zip(end).filter(|(start, end)| start < end).map(|(start, end)| (end - start) / 60_000).or(match kind {
        "USAGE_PERIOD_TYPE_WEEKLY" => Some(10080),
        "USAGE_PERIOD_TYPE_MONTHLY" => Some(43200),
        _ => None,
    });
    let windows = used
        .map(|used| UsageWindow {
            id: "credits".into(),
            label: minutes.map(window_label).unwrap_or_else(|| "Credits".into()),
            used_percent: used.clamp(0.0, 100.0),
            window_minutes: minutes,
            resets_at: end,
        })
        .into_iter()
        .collect();
    Some((plan, windows))
}

/// The email `grok login` kept (`$GROK_HOME` or `~/.grok`).
fn login_email() -> Option<String> {
    let home = match std::env::var_os("GROK_HOME") {
        Some(home) => std::path::PathBuf::from(home),
        None => std::path::Path::new(&std::env::var_os("HOME")?).join(".grok"),
    };
    let json: Value = serde_json::from_str(&std::fs::read_to_string(home.join("auth.json")).ok()?).ok()?;
    parse_login_email(&json)
}

/// Its entries are keyed by issuer; SuperGrok's (`https://auth.x.ai::…`) comes first.
pub fn parse_login_email(json: &Value) -> Option<String> {
    let entries = json.as_object()?;
    let email = |entry: &Value| entry.get("email").and_then(Value::as_str).filter(|e| !e.is_empty()).map(str::to_string);
    let supergrok = entries.iter().filter(|(issuer, _)| issuer.starts_with("https://auth.x.ai"));
    supergrok.chain(entries.iter()).find_map(|(_, entry)| email(entry))
}

#[cfg(test)]
mod tests {
    use super::*;

    // As grok 1.0.70 answers `_x.ai/billing` for SuperGrok on unified billing.
    const BILLING: &str = r#"{"config":{"creditUsagePercent":3.0,"currentPeriod":{"type":"USAGE_PERIOD_TYPE_WEEKLY",
        "start":"2026-10-28T03:38:09.637+00:00","end":"2026-11-04T03:38:09.637+00:00"},"prepaidBalance":{"val":0},
        "isUnifiedBillingUser":true,"billingPeriodStart":"2026-10-28T03:38:09.637+00:00",
        "billingPeriodEnd":"2026-11-04T03:38:09.637+00:00"},"subscription_tier":"SuperGrok"}"#;

    #[test]
    fn billing_gives_the_tier_and_the_weekly_window() {
        let (plan, windows) = parse_billing(&serde_json::from_str(BILLING).unwrap()).unwrap();
        assert_eq!(plan.as_deref(), Some("SuperGrok"));
        assert_eq!(windows.len(), 1);
        assert_eq!((windows[0].label.as_str(), windows[0].used_percent, windows[0].window_minutes), ("Weekly", 3.0, Some(10080)));
        assert_eq!(windows[0].resets_at, parse_iso_ms("2026-11-04T03:38:09.637Z"));
    }

    #[test]
    fn on_demand_spend_stands_in_for_a_missing_percentage() {
        let result = json!({ "config": { "onDemandUsed": { "val": 5 }, "onDemandCap": { "val": 20 },
            "billingPeriodStart": "2026-10-01T00:00:00Z", "billingPeriodEnd": "2026-10-31T00:00:00Z" } });
        let (plan, windows) = parse_billing(&result).unwrap();
        assert_eq!((plan, windows[0].used_percent, windows[0].label.as_str()), (None, 25.0, "Monthly"));
    }

    #[test]
    fn a_plan_that_says_no_share_has_no_window() {
        let result = json!({ "config": { "currentPeriod": { "type": "USAGE_PERIOD_TYPE_WEEKLY" } }, "subscription_tier": "SuperGrok Heavy" });
        let (plan, windows) = parse_billing(&result).unwrap();
        assert_eq!((plan.as_deref(), windows.len()), (Some("SuperGrok Heavy"), 0));
        assert!(parse_billing(&json!({})).is_none());
    }

    #[test]
    fn the_supergrok_login_names_the_account() {
        let auth = json!({
            "https://accounts.x.ai/sign-in": { "email": "old@x.dev", "key": "k1" },
            "https://auth.x.ai::client": { "email": "a@x.dev", "key": "k2" },
        });
        assert_eq!(parse_login_email(&auth).as_deref(), Some("a@x.dev"));
        assert_eq!(
            parse_login_email(&json!({ "https://accounts.x.ai/sign-in": { "email": "old@x.dev" } })).as_deref(),
            Some("old@x.dev")
        );
        assert_eq!(parse_login_email(&json!({})), None);
    }
}
