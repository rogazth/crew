//! opencode: tokens and cost of the last seven days, and tokens by day and model,
//! from `opencode stats`. It has no plan windows.

use std::collections::BTreeMap;
use std::time::Duration;

use crew_protocol::PlanUsage;
use serde_json::Value;

use super::tokens::{Since, Spent, Tally};
use super::{local_day_of, run, DAY_MS};

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
        cost,
        updated_at: crate::store::now_millis(),
        source: "cli".into(),
        status: None,
        overage_status: None,
    })
}

/// `stats` totals a span, not a day: `--days 3` is today and the two before it, so
/// each day is what its span adds to the one after it. A run takes about 0.2 s.
pub fn tokens(bin: &str, since: &Since) -> Option<Tally> {
    let spans = (1..=since.days)
        .map(|days| {
            let args = ["stats", "--days", &days.to_string(), "--json", "--models"].map(str::to_string);
            let args: Vec<&str> = args.iter().map(String::as_str).collect();
            parse_models(&run(bin, &args, Duration::from_secs(10))?)
        })
        .collect::<Option<Vec<_>>>()?;
    Some(tally_of_spans(&spans, crate::store::now_millis(), since))
}

/// What each model spent over a span of `stats --json --models`. Reasoning is
/// reported apart from the output it is part of.
pub fn parse_models(text: &str) -> Option<BTreeMap<String, Spent>> {
    let json: Value = serde_json::from_str(text.trim()).ok()?;
    let mut spent = BTreeMap::new();
    for row in json.get("models").and_then(Value::as_array).into_iter().flatten() {
        let Some(model) = row.pointer("/model/id").and_then(Value::as_str) else {
            continue;
        };
        let number = |pointer: &str| row.pointer(pointer).and_then(Value::as_u64).unwrap_or(0);
        spent.insert(
            model.to_string(),
            Spent {
                input: number("/tokens/input"),
                output: number("/tokens/output") + number("/tokens/reasoning"),
                cache_write: number("/tokens/cache/write"),
                cache_read: number("/tokens/cache/read"),
            },
        );
    }
    Some(spent)
}

/// Spans of 1, 2, ... days ending today into each day's own, model by model.
fn tally_of_spans(spans: &[BTreeMap<String, Spent>], now: i64, since: &Since) -> Tally {
    let empty = BTreeMap::new();
    let mut tally = Tally::default();
    for (back, span) in spans.iter().enumerate() {
        let shorter = if back == 0 { &empty } else { &spans[back - 1] };
        for (model, spent) in span {
            let before = shorter.get(model).copied().unwrap_or_default();
            tally.add(
                since,
                local_day_of(now - back as i64 * DAY_MS),
                model,
                Spent {
                    input: spent.input.saturating_sub(before.input),
                    output: spent.output.saturating_sub(before.output),
                    cache_write: spent.cache_write.saturating_sub(before.cache_write),
                    cache_read: spent.cache_read.saturating_sub(before.cache_read),
                },
            );
        }
    }
    tally
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
    fn spans_become_days_model_by_model() {
        let span = |models: &[(&str, u64)]| {
            models
                .iter()
                .map(|(model, input)| (model.to_string(), Spent { input: *input, ..Spent::default() }))
                .collect::<BTreeMap<_, _>>()
        };
        let now = crate::store::now_millis();
        let since = super::super::tokens::test_support::since_ever();
        let tally = tally_of_spans(&[span(&[("a", 5)]), span(&[("a", 5)]), span(&[("a", 9), ("b", 2)])], now, &since);
        let day = |back: i64| local_day_of(now - back * DAY_MS);
        let held: Vec<_> = tally.0.iter().map(|((d, m), spent)| (d.clone(), m.clone(), spent.input)).collect();
        let mut wanted = vec![(day(0), "a".to_string(), 5), (day(2), "a".to_string(), 4), (day(2), "b".to_string(), 2)];
        wanted.sort();
        assert_eq!(held, wanted);
    }

    #[test]
    fn a_model_span_counts_reasoning_as_output_and_keeps_the_cache_apart() {
        let text = r#"{"tokens":{"input":9},"models":[{"model":{"id":"deepseek"},"tokens":{"input":451997,"output":28426,"reasoning":33812,"cache":{"read":8976896,"write":7}},"cost":0}]}"#;
        assert_eq!(
            parse_models(text).unwrap()["deepseek"],
            Spent { input: 451_997, output: 62_238, cache_write: 7, cache_read: 8_976_896 }
        );
        assert!(parse_models(r#"{"tokens":{}}"#).unwrap().is_empty());
        assert_eq!(parse_models("not json"), None);
    }

    #[test]
    fn the_plain_summary_line_gives_the_tokens() {
        let text = "17 sessions · 6 subagents\n46 prompts · 246 steps · 20.4m tokens\n97.1% tool success";
        assert_eq!(parse_text(text), Some((20_400_000, None)));
        assert_eq!(parse_text("3 prompts · 1,234 tokens"), Some((1234, None)));
        assert_eq!(parse_text("nothing here"), None);
    }
}
