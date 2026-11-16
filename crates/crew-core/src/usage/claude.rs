//! Claude: the plan's windows from its `get_usage` control request (Claude
//! Code 2.1.322), who is signed in from `claude auth status`.

use std::collections::HashSet;
use std::io::{BufRead, BufReader, Write};
use std::os::unix::process::CommandExt;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::mpsc;
use std::time::{Duration, Instant};

use crew_protocol::UsageWindow;
use serde::Deserialize;
use serde_json::Value;

use super::tokens::{jsonl_files, lines_with, Since, Spent, Tally};
use super::{local_day_of, parse_iso_ms, window_label};

/// How long a `get_usage` may take: the CLI starts, then asks claude.ai.
const PROBE_TIMEOUT: Duration = Duration::from_secs(20);

/// Every window of the plan, without a turn: a short-lived `claude -p` in
/// stream-json answers `get_usage` and exits. It writes no transcript and
/// spends nothing. None when the CLI fails, is signed out of claude.ai, or
/// says no rate limits are available.
pub fn probe(bin: &str) -> Option<(Vec<UsageWindow>, Option<String>)> {
    let mut child = Command::new(bin)
        .args(["-p", "--input-format", "stream-json", "--output-format", "stream-json", "--verbose"])
        .args(["--no-session-persistence", "--strict-mcp-config"])
        .env("PATH", crate::shell_path::joined())
        .current_dir(std::env::temp_dir())
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .process_group(0)
        .spawn()
        .ok()?;
    let (Some(mut stdin), Some(stdout)) = (child.stdin.take(), child.stdout.take()) else {
        // SAFETY: the group is the child's own, spawned above.
        unsafe { libc::kill(-(child.id() as i32), libc::SIGKILL) };
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
    let request = serde_json::json!({
        "type": "control_request", "request_id": "crew-usage",
        "request": { "subtype": "get_usage", "skip_behaviors": true },
    });
    let answer = writeln!(stdin, "{request}").ok().and_then(|_| {
        let deadline = Instant::now() + PROBE_TIMEOUT;
        loop {
            let message = rx.recv_timeout(deadline.checked_duration_since(Instant::now())?).ok()?;
            let response = message.get("response");
            if message.get("type").and_then(Value::as_str) == Some("control_response")
                && response.and_then(|r| r.get("request_id")).and_then(Value::as_str) == Some("crew-usage")
            {
                break response.cloned();
            }
        }
    });
    drop(stdin);
    // SAFETY: the group is the child's own, spawned above.
    unsafe { libc::kill(-(child.id() as i32), libc::SIGKILL) };
    let _ = child.wait();
    let answer = answer?;
    if answer.get("subtype").and_then(Value::as_str) != Some("success") {
        return None;
    }
    parse_usage(answer.get("response")?)
}

/// `get_usage`'s answer. `rate_limits` keys the plan's windows by the ids the
/// stream uses, `utilization` 0 to 100 and `resets_at` in ISO 8601; its
/// `limits` rows add the weekly windows scoped to one model (`weekly_scoped`,
/// `percent`), as does `model_scoped` when the answer is fresh. The scoped
/// window of a model whose use past it is billed as overage (Fable) is the one
/// the stream calls `seven_day_overage_included`.
pub fn parse_usage(usage: &Value) -> Option<(Vec<UsageWindow>, Option<String>)> {
    if usage.get("rate_limits_available").and_then(Value::as_bool) == Some(false) {
        return None;
    }
    let plan = usage.get("subscription_type").and_then(Value::as_str).filter(|s| !s.is_empty()).map(str::to_string);
    let week = window_label(10080);
    let mut out: Vec<UsageWindow> = Vec::new();
    let mut add = |id: String, label: String, minutes: i64, used: Option<f64>, resets_at: Option<&Value>| {
        let Some(used) = used else { return };
        if out.iter().any(|w| w.id == id) {
            return;
        }
        out.push(UsageWindow {
            id,
            label,
            used_percent: used.clamp(0.0, 100.0),
            window_minutes: Some(minutes),
            resets_at: resets_at.and_then(Value::as_str).and_then(parse_iso_ms),
        });
    };
    let rate_limits = usage.get("rate_limits");
    for (id, limit) in rate_limits.and_then(Value::as_object).into_iter().flatten() {
        let (minutes, label) = match id.as_str() {
            "five_hour" => (300, window_label(300)),
            "seven_day" => (10080, week.clone()),
            "seven_day_opus" | "seven_day_sonnet" => (10080, format!("{week} {}", capitalized(&id["seven_day_".len()..]))),
            // The rest are named for experiments, not for windows.
            _ => continue,
        };
        add(id.clone(), label, minutes, limit.get("utilization").and_then(Value::as_f64), limit.get("resets_at"));
    }
    let scoped_id = |name: &str| match name.to_lowercase().as_str() {
        model @ ("opus" | "sonnet") => format!("seven_day_{model}"),
        _ => "seven_day_overage_included".to_string(),
    };
    let rows = rate_limits.and_then(|r| r.get("limits")).and_then(Value::as_array).into_iter().flatten();
    for row in rows.filter(|row| row.get("kind").and_then(Value::as_str) == Some("weekly_scoped")) {
        let name = row.pointer("/scope/model/display_name").and_then(Value::as_str).filter(|s| !s.is_empty());
        if let Some(name) = name {
            add(
                scoped_id(name),
                format!("{week} {name}"),
                10080,
                row.get("percent").and_then(Value::as_f64),
                row.get("resets_at"),
            );
        }
    }
    for scoped in usage.get("model_scoped").and_then(Value::as_array).into_iter().flatten() {
        if let Some(name) = scoped.get("display_name").and_then(Value::as_str).filter(|s| !s.is_empty()) {
            add(
                scoped_id(name),
                format!("{week} {name}"),
                10080,
                scoped.get("utilization").and_then(Value::as_f64),
                scoped.get("resets_at"),
            );
        }
    }
    out.sort_by_key(|w| (w.window_minutes.unwrap_or(i64::MAX), w.id.clone()));
    (!out.is_empty()).then_some((out, plan))
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

/// Where Claude Code keeps its transcripts.
fn projects() -> Option<PathBuf> {
    let root = match std::env::var("CLAUDE_CONFIG_DIR") {
        Ok(dir) if !dir.is_empty() => PathBuf::from(dir),
        _ => PathBuf::from(std::env::var_os("HOME")?).join(".claude"),
    };
    Some(root.join("projects"))
}

pub fn tokens(since: &Since) -> Option<Tally> {
    Some(read_tokens(&projects()?, since))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct LogLine {
    timestamp: Option<String>,
    request_id: Option<String>,
    message: Option<LogMessage>,
}

#[derive(Deserialize)]
struct LogMessage {
    id: Option<String>,
    model: Option<String>,
    usage: Option<LogUsage>,
}

#[derive(Deserialize)]
struct LogUsage {
    input_tokens: Option<u64>,
    output_tokens: Option<u64>,
    cache_creation_input_tokens: Option<u64>,
    cache_read_input_tokens: Option<u64>,
}

/// One reply takes a log line per block, each repeating the whole reply's
/// usage, and a resumed session copies its history: a reply counts once.
fn read_tokens(projects: &Path, since: &Since) -> Tally {
    let mut tally = Tally::default();
    let mut seen = HashSet::new();
    for path in jsonl_files(projects, since.from_ms) {
        lines_with(&path, "\"usage\"", |line| {
            let Ok(LogLine { timestamp: Some(at), request_id, message: Some(message) }) = serde_json::from_str(line) else {
                return;
            };
            let LogMessage { id, model: Some(model), usage: Some(usage) } = message else {
                return;
            };
            if model == "<synthetic>" || !seen.insert((id, request_id)) {
                return;
            }
            let Some(at) = parse_iso_ms(&at) else {
                return;
            };
            let spent = Spent {
                input: usage.input_tokens.unwrap_or(0),
                output: usage.output_tokens.unwrap_or(0),
                cache_write: usage.cache_creation_input_tokens.unwrap_or(0),
                cache_read: usage.cache_read_input_tokens.unwrap_or(0),
            };
            tally.add(since, local_day_of(at), &model, spent);
        });
    }
    tally
}

#[cfg(test)]
mod tests {
    use super::super::tokens::test_support::{folder, since_ever};
    use super::*;
    use serde_json::json;

    #[test]
    fn a_reply_counts_once_however_many_lines_and_files_repeat_it() {
        let dir = folder();
        std::fs::create_dir_all(dir.join("project/subagents")).unwrap();
        let line = |id: &str, model: &str| {
            format!(
                r#"{{"timestamp":"2026-11-02T12:00:00.000Z","requestId":"r{id}","message":{{"id":"{id}","model":"{model}","usage":{{"input_tokens":1,"output_tokens":2,"cache_creation_input_tokens":3,"cache_read_input_tokens":4}}}}}}"#
            )
        };
        let session =
            [line("a", "claude-opus-5-5"), line("a", "claude-opus-5-5"), line("b", "<synthetic>"), "not json \"usage\"".into()];
        std::fs::write(dir.join("project/one.jsonl"), session.join("\n")).unwrap();
        std::fs::write(
            dir.join("project/subagents/two.jsonl"),
            line("a", "claude-opus-5-5") + "\n" + &line("c", "claude-haiku-5-5"),
        )
        .unwrap();
        let tally = read_tokens(&dir, &since_ever());
        let day = local_day_of(parse_iso_ms("2026-11-02T12:00:00.000Z").unwrap());
        let one = Spent { input: 1, output: 2, cache_write: 3, cache_read: 4 };
        assert_eq!(tally.0.len(), 2);
        assert_eq!(tally.0[&(day.clone(), "claude-opus-5-5".to_string())], one);
        assert_eq!(tally.0[&(day, "claude-haiku-5-5".to_string())], one);
    }

    #[test]
    fn get_usage_gives_the_plan_windows_and_the_ones_scoped_to_a_model() {
        let usage = json!({
            "subscription_type": "max", "rate_limits_available": true,
            "rate_limits": {
                "five_hour": { "utilization": 41, "resets_at": "2026-11-16T17:10:00.897098+00:00" },
                "seven_day": { "utilization": 8, "resets_at": "2026-11-20T10:00:00.897119+00:00" },
                "seven_day_opus": null, "tangelo": { "utilization": 5 }, "extra_usage": { "is_enabled": false },
                "limits": [
                    { "kind": "session", "percent": 41, "resets_at": "2026-11-16T17:10:00.897098+00:00", "scope": null },
                    { "kind": "weekly_scoped", "percent": 0, "resets_at": "2026-11-20T10:00:00.897287+00:00",
                      "scope": { "model": { "id": null, "display_name": "Fable" }, "surface": null } }
                ]
            }
        });
        let (windows, plan) = parse_usage(&usage).expect("windows");
        assert_eq!(plan.as_deref(), Some("max"));
        let got: Vec<_> = windows.iter().map(|w| (w.id.as_str(), w.label.as_str(), w.used_percent, w.window_minutes)).collect();
        assert_eq!(
            got,
            [
                ("five_hour", "5 hours", 41.0, Some(300)),
                ("seven_day", "Weekly", 8.0, Some(10080)),
                ("seven_day_overage_included", "Weekly Fable", 0.0, Some(10080)),
            ]
        );
        assert_eq!(windows[1].resets_at, parse_iso_ms("2026-11-20T10:00:00.897Z"));
        // A fresh answer names the same window again in `model_scoped`; it counts once.
        let mut fresh = usage.clone();
        fresh["model_scoped"] = json!([{ "display_name": "Fable", "utilization": 0, "resets_at": "2026-11-20T10:00:00Z" }]);
        assert_eq!(parse_usage(&fresh).expect("windows").0.len(), 3);
        let unavailable = json!({ "rate_limits_available": false, "rate_limits": null });
        assert!(parse_usage(&unavailable).is_none());
    }

    #[test]
    fn auth_status_gives_the_email_and_plan() {
        let text = r#"{"loggedIn":true,"authMethod":"claude.ai","email":"a@b.dev","orgName":"x","subscriptionType":"max"}"#;
        assert_eq!(parse_auth_status(text), Some(("a@b.dev".into(), Some("max".into()))));
        assert_eq!(parse_auth_status(r#"{"loggedIn":false}"#), None);
        assert_eq!(parse_auth_status("not json"), None);
    }
}
