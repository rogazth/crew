//! Claude: windows from the `rate_limit_event` its stream-json emits (Claude
//! Code 2.1.299), who is signed in from `claude auth status`.

use crew_protocol::UsageWindow;
use serde_json::{Map, Value};

use super::window_label;

/// The windows a `rate_limit_event` names. It only comes with a turn:
/// `{"type":"rate_limit_event","rate_limit_info":{"unifiedWindows":
/// {"five_hour":{"utilization":0.53,"resetsAt":1792470000},"seven_day":{...}}}}`.
/// `utilization` is a share of 1; `resetsAt` is in seconds.
pub fn parse_rate_limit(rec: &Map<String, Value>, _now_ms: i64) -> Vec<UsageWindow> {
    if rec.get("type").and_then(Value::as_str) != Some("rate_limit_event") {
        return Vec::new();
    }
    let Some(windows) = rec.get("rate_limit_info").and_then(|info| info.get("unifiedWindows")).and_then(Value::as_object) else {
        return Vec::new();
    };
    let mut out: Vec<UsageWindow> = windows
        .iter()
        .filter_map(|(id, window)| {
            let used = window.get("utilization").and_then(Value::as_f64)?;
            let minutes = match id.as_str() {
                "five_hour" => Some(300),
                other if other.starts_with("seven_day") => Some(10080),
                _ => None,
            };
            let mut label = minutes.map(window_label).unwrap_or_else(|| id.replace('_', " "));
            if let Some(model) = id.strip_prefix("seven_day_") {
                label = format!("{label} {}", capitalized(model));
            }
            Some(UsageWindow {
                id: id.clone(),
                label,
                used_percent: (used * 100.0).clamp(0.0, 100.0),
                window_minutes: minutes,
                resets_at: window.get("resetsAt").and_then(Value::as_f64).map(|s| (s * 1000.0) as i64),
            })
        })
        .collect();
    out.sort_by_key(|w| (w.window_minutes.unwrap_or(i64::MAX), w.id.clone()));
    out
}

/// The plan limit's and the overage's verdicts of a `rate_limit_event`
/// (`rate_limit_info.status` and `.overageStatus`).
pub fn parse_status(rec: &Map<String, Value>) -> (Option<String>, Option<String>) {
    let info = rec.get("rate_limit_info");
    let get = |key: &str| info.and_then(|i| i.get(key)).and_then(Value::as_str).map(str::to_string);
    (get("status"), get("overageStatus"))
}

fn capitalized(text: &str) -> String {
    let mut chars = text.chars();
    chars.next().map(|c| c.to_uppercase().chain(chars).collect()).unwrap_or_default()
}

/// The email and plan of `claude auth status`, which prints JSON.
pub fn parse_auth_status(text: &str) -> Option<(String, Option<String>)> {
    let json: Value = serde_json::from_str(text.trim()).ok()?;
    if json.get("loggedIn").and_then(Value::as_bool) == Some(false) {
        return None;
    }
    let account = json.get("email").and_then(Value::as_str).filter(|s| !s.is_empty())?.to_string();
    let plan = json.get("subscriptionType").and_then(Value::as_str).filter(|s| !s.is_empty()).map(str::to_string);
    Some((account, plan))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn a_rate_limit_event_gives_its_unified_windows() {
        let rec = json!({
            "type": "rate_limit_event",
            "rate_limit_info": {
                "status": "allowed", "resetsAt": 1792470000, "rateLimitType": "five_hour", "overageStatus": "rejected",
                "unifiedWindows": {
                    "seven_day": { "utilization": 0.1, "resetsAt": 1792900000 },
                    "five_hour": { "utilization": 0.53, "resetsAt": 1792470000 },
                    "seven_day_opus": { "utilization": 2.0 }
                }
            }
        });
        let windows = parse_rate_limit(rec.as_object().unwrap(), 0);
        let got: Vec<_> =
            windows.iter().map(|w| (w.id.as_str(), w.label.as_str(), w.used_percent, w.window_minutes, w.resets_at)).collect();
        assert_eq!(got[0], ("five_hour", "5 hours", 53.0, Some(300), Some(1_792_470_000_000)));
        assert_eq!(got[1].0, "seven_day");
        assert_eq!(got[1].1, "Weekly");
        assert!((got[1].2 - 10.0).abs() < 1e-9);
        assert_eq!(got[2], ("seven_day_opus", "Weekly Opus", 100.0, Some(10080), None));
    }

    #[test]
    fn events_without_windows_or_of_another_kind_give_none() {
        let no_windows = json!({ "type": "rate_limit_event", "rate_limit_info": { "status": "allowed" } });
        assert!(parse_rate_limit(no_windows.as_object().unwrap(), 0).is_empty());
        let other = json!({ "type": "result", "rate_limit_info": { "unifiedWindows": { "five_hour": { "utilization": 0.5 } } } });
        assert!(parse_rate_limit(other.as_object().unwrap(), 0).is_empty());
    }

    #[test]
    fn auth_status_gives_the_email_and_plan() {
        let text = r#"{"loggedIn":true,"authMethod":"claude.ai","email":"a@b.dev","orgName":"x","subscriptionType":"max"}"#;
        assert_eq!(parse_auth_status(text), Some(("a@b.dev".into(), Some("max".into()))));
        assert_eq!(parse_auth_status(r#"{"loggedIn":false}"#), None);
        assert_eq!(parse_auth_status("not json"), None);
    }
}
