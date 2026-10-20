//! Cursor, best effort and apart from the rest: the tier and email come from
//! `cursor-agent about --format json`; the share used from
//! `cursor.com/api/usage-summary`, with the access token `cursor-agent login`
//! stored (the macOS keychain's `cursor-access-token`, or `auth.json` under
//! `~/.config/cursor`). A browser's cookies are never read. Without a token
//! the reading has the plan and account and no window.

use std::io::Write;
use std::process::{Command, Stdio};
use std::time::Duration;

use base64::Engine;
use crew_protocol::{PlanUsage, UsageWindow};
use serde_json::Value;

use super::{parse_iso_ms, run};

const SUMMARY_URL: &str = "https://cursor.com/api/usage-summary";

pub fn read(bin: &str) -> Option<PlanUsage> {
    let about = run(bin, &["about", "--format", "json"], Duration::from_secs(15)).and_then(|text| parse_about(&text));
    let summary = access_token().and_then(|token| fetch_summary(&token)).and_then(|text| parse_summary(&text));
    if about.is_none() && summary.is_none() {
        return None;
    }
    let (email, tier) = about.unwrap_or((None, None));
    let (plan, windows) = summary.unwrap_or((None, Vec::new()));
    Some(PlanUsage {
        provider: "cursor".into(),
        account: email,
        plan: tier.or(plan),
        source: if windows.is_empty() { "cli" } else { "api" }.into(),
        windows,
        tokens: None,
        cost: None,
        updated_at: crate::store::now_millis(),
    })
}

/// The email and subscription tier of `cursor-agent about --format json`.
pub fn parse_about(text: &str) -> Option<(Option<String>, Option<String>)> {
    let json: Value = serde_json::from_str(text.trim()).ok()?;
    let text = |key: &str| json.get(key).and_then(Value::as_str).filter(|s| !s.is_empty()).map(str::to_string);
    let (email, tier) = (text("userEmail"), text("subscriptionTier").map(|t| t.to_lowercase()));
    (email.is_some() || tier.is_some()).then_some((email, tier))
}

/// The membership and the billing cycle's window of a `usage-summary` body.
pub fn parse_summary(text: &str) -> Option<(Option<String>, Vec<UsageWindow>)> {
    let json: Value = serde_json::from_str(text.trim()).ok()?;
    let plan = json.get("membershipType").and_then(Value::as_str).map(str::to_string);
    let used = json.pointer("/individualUsage/plan/totalPercentUsed").and_then(Value::as_f64);
    let start = json.get("billingCycleStart").and_then(Value::as_str).and_then(parse_iso_ms);
    let end = json.get("billingCycleEnd").and_then(Value::as_str).and_then(parse_iso_ms);
    let windows = used
        .map(|used| UsageWindow {
            id: "cycle".into(),
            label: "Billing cycle".into(),
            used_percent: used.clamp(0.0, 100.0),
            window_minutes: start.zip(end).map(|(start, end)| (end - start) / 60_000),
            resets_at: end,
        })
        .into_iter()
        .collect();
    (plan.is_some() || json.get("individualUsage").is_some()).then_some((plan, windows))
}

/// The token `cursor-agent login` stored, if it can be found cheaply.
fn access_token() -> Option<String> {
    keychain_token().or_else(file_token)
}

#[cfg(target_os = "macos")]
fn keychain_token() -> Option<String> {
    let found = run("/usr/bin/security", &["find-generic-password", "-s", "cursor-access-token", "-a", "cursor-user", "-w"], Duration::from_secs(10))?;
    Some(found.trim().to_string()).filter(|token| !token.is_empty())
}

#[cfg(not(target_os = "macos"))]
fn keychain_token() -> Option<String> {
    None
}

fn file_token() -> Option<String> {
    let home = std::env::var_os("HOME")?;
    let text = std::fs::read_to_string(std::path::Path::new(&home).join(".config/cursor/auth.json")).ok()?;
    let json: Value = serde_json::from_str(&text).ok()?;
    json.get("accessToken").and_then(Value::as_str).map(str::to_string)
}

/// The session value the web API wants, made from the token's own claims:
/// `<user id>::<token>`, the user id being the `sub` after the provider's bar.
fn session_value(token: &str) -> Option<String> {
    let payload = token.split('.').nth(1)?;
    let bytes = base64::engine::general_purpose::URL_SAFE_NO_PAD.decode(payload.trim_end_matches('=')).ok()?;
    let claims: Value = serde_json::from_slice(&bytes).ok()?;
    let sub = claims.get("sub").and_then(Value::as_str)?;
    Some(format!("{}%3A%3A{token}", sub.rsplit('|').next()?))
}

/// `curl` is given its request on stdin, so the token is not on a command line.
fn fetch_summary(token: &str) -> Option<String> {
    let cookie = session_value(token)?;
    let mut child = Command::new("curl")
        .args(["-s", "-f", "-m", "15", "--config", "-"])
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .ok()?;
    let config = format!("url = \"{SUMMARY_URL}\"\nheader = \"Cookie: WorkosCursorSessionToken={cookie}\"\n");
    child.stdin.take()?.write_all(config.as_bytes()).ok()?;
    let out = child.wait_with_output().ok()?;
    out.status.success().then(|| String::from_utf8_lossy(&out.stdout).into_owned())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn about_gives_the_email_and_tier() {
        let text = r#"{"cliVersion":"2026.10.01","model":"Auto","subscriptionTier":"Free","userEmail":"a@b.dev"}"#;
        assert_eq!(parse_about(text), Some((Some("a@b.dev".into()), Some("free".into()))));
        assert_eq!(parse_about("{}"), None);
    }

    #[test]
    fn the_summary_gives_the_billing_cycle() {
        let text = r#"{"billingCycleStart":"2026-10-07T02:51:47.912Z","billingCycleEnd":"2026-11-07T02:51:47.912Z",
            "membershipType":"pro","individualUsage":{"plan":{"used":0,"limit":0,"autoPercentUsed":100,"apiPercentUsed":0,"totalPercentUsed":50}}}"#;
        let (plan, windows) = parse_summary(text).unwrap();
        assert_eq!(plan.as_deref(), Some("pro"));
        assert_eq!(windows.len(), 1);
        assert_eq!((windows[0].used_percent, windows[0].window_minutes), (50.0, Some(31 * 1440)));
        assert_eq!(windows[0].resets_at, Some(1_794_019_907_912));
    }

    #[test]
    fn a_summary_without_a_percentage_has_no_window() {
        let (_, windows) = parse_summary(r#"{"membershipType":"free","individualUsage":{}}"#).unwrap();
        assert!(windows.is_empty());
        assert!(parse_summary(r#"{"error":"not_authenticated"}"#).is_none());
    }

    #[test]
    fn the_session_value_comes_from_the_tokens_subject() {
        // header.payload.signature, the payload being {"sub":"github|user_01ABC"}.
        let payload = base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(r#"{"sub":"github|user_01ABC"}"#);
        let token = format!("h.{payload}.s");
        assert_eq!(session_value(&token), Some(format!("user_01ABC%3A%3A{token}")));
        assert_eq!(session_value("not-a-jwt"), None);
    }
}
