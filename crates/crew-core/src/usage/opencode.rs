//! opencode: tokens and cost of the last seven days, and those tokens by day,
//! from `opencode stats`.
//! It has no plan windows.

use std::time::Duration;

use crew_protocol::PlanUsage;
use serde_json::Value;

use super::run;

/// Today and the six before it.
const DAYS: u32 = 7;

pub fn read(bin: &str) -> Option<PlanUsage> {
    let json =
        run(bin, &["stats", "--days", "7", "--json", "--cost"], Duration::from_secs(30)).and_then(|text| parse_json(&text));
    let (tokens, cost) = match json {
        Some(found) => found,
        None => parse_text(&run(bin, &["stats", "--days", "7"], Duration::from_secs(30))?)?,
    };
    Some(PlanUsage {
        provider: "opencode".into(),
        account: None,
        plan: None,
        windows: Vec::new(),
        tokens: Some(tokens),
        daily_tokens: daily(bin),
        cost,
        updated_at: crate::store::now_millis(),
        source: "cli".into(),
        status: None,
        overage_status: None,
    })
}

/// `stats` totals a span, not a day: `--days 3` is today and the two before it, so
/// each day is what its span adds to the one after it. Each run takes milliseconds.
fn daily(bin: &str) -> Option<Vec<u64>> {
    let totals = (1..=DAYS)
        .map(|days| {
            let text = run(bin, &["stats", "--days", &days.to_string(), "--json"], Duration::from_secs(10))?;
            parse_json(&text).map(|(tokens, _)| tokens)
        })
        .collect::<Option<Vec<u64>>>()?;
    Some(days_from_totals(&totals))
}

/// Totals of the last 1, 2, ... days into each day's own, oldest first.
pub fn days_from_totals(totals: &[u64]) -> Vec<u64> {
    (0..totals.len()).rev().map(|at| totals[at].saturating_sub(if at == 0 { 0 } else { totals[at - 1] })).collect()
}

/// Tokens (input, output, reasoning and cache, as the CLI totals them) and cost of `stats --json`.
pub fn parse_json(text: &str) -> Option<(u64, Option<f64>)> {
    let json: Value = serde_json::from_str(text.trim()).ok()?;
    let tokens = json.get("tokens")?;
    let count = |value: Option<&Value>| value.and_then(Value::as_u64).unwrap_or(0);
    let total = count(tokens.get("input"))
        + count(tokens.get("output"))
        + count(tokens.get("reasoning"))
        + count(tokens.get("cache").and_then(|c| c.get("read")))
        + count(tokens.get("cache").and_then(|c| c.get("write")));
    Some((total, json.get("cost").and_then(Value::as_f64)))
}

/// The summary line of the plain `stats`: "... 20.4m tokens". The cost is not in it.
pub fn parse_text(text: &str) -> Option<(u64, Option<f64>)> {
    let before = text.lines().find_map(|line| line.split_once(" tokens").map(|(before, _)| before))?;
    let word = before.split_whitespace().last()?.to_lowercase();
    let (digits, scale) = match word.chars().last()? {
        'k' => (&word[..word.len() - 1], 1e3),
        'm' => (&word[..word.len() - 1], 1e6),
        'b' => (&word[..word.len() - 1], 1e9),
        _ => (word.as_str(), 1.0),
    };
    let tokens = (digits.replace(',', "").parse::<f64>().ok()? * scale).round() as u64;
    Some((tokens, None))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn json_stats_total_every_kind_of_token() {
        let text = r#"{"range":{"from":1,"to":2},"sessions":17,"tokens":{"input":1503611,"output":46538,"reasoning":75077,
            "cache":{"read":18745129,"write":0}},"cost":1.25,"tools":{}}"#;
        assert_eq!(parse_json(text), Some((20_370_355, Some(1.25))));
        assert_eq!(parse_json("not json"), None);
    }

    #[test]
    fn spans_become_days_oldest_first() {
        assert_eq!(days_from_totals(&[0, 0, 0, 9, 9, 15, 20]), [5, 6, 0, 9, 0, 0, 0]);
    }

    #[test]
    fn the_plain_summary_line_gives_the_tokens() {
        let text = "17 sessions · 6 subagents\n46 prompts · 246 steps · 20.4m tokens\n97.1% tool success";
        assert_eq!(parse_text(text), Some((20_400_000, None)));
        assert_eq!(parse_text("3 prompts · 1,234 tokens"), Some((1234, None)));
        assert_eq!(parse_text("nothing here"), None);
    }
}
