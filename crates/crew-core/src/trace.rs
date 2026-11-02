//! Helpers for what is written to the daemon's trace (`crewd::trace`).
//!
//! The rule for every `tracing` event in this workspace: ids, kinds,
//! durations, sizes, counts, status names and error text, and nothing a user
//! typed or a model said (prompts, responses, tool arguments or results,
//! terminal input or output, file contents, tokens, cookies, env values).

use std::time::Duration;

/// Longest error text a trace line carries.
const ERROR_CAP: usize = 300;

pub fn ms(duration: Duration) -> u64 {
    u64::try_from(duration.as_millis()).unwrap_or(u64::MAX)
}

/// An error as a trace line may hold it. `serde` quotes the value it choked on
/// ("invalid type: string \"...\", expected u32"), and that value is the
/// caller's data, so what sits in quotes or backticks of such a message goes.
/// Long text is cut.
pub fn error_text(error: &str) -> String {
    const PARSE_ERRORS: [&str; 8] = [
        "invalid type",
        "invalid value",
        "invalid length",
        "unknown variant",
        "unknown field",
        "missing field",
        "expected ",
        "trailing",
    ];
    let first_line = error.lines().next().unwrap_or("");
    let text = if PARSE_ERRORS
        .iter()
        .any(|start| first_line.starts_with(start) || first_line.contains(": invalid ") || first_line.contains(", expected "))
    {
        redact_quoted(first_line)
    } else {
        first_line.to_string()
    };
    match text.char_indices().nth(ERROR_CAP) {
        Some((at, _)) => format!("{}…", &text[..at]),
        None => text,
    }
}

fn redact_quoted(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut closing: Option<char> = None;
    for c in text.chars() {
        match closing {
            Some(end) if c == end => {
                out.push('…');
                out.push(c);
                closing = None;
            }
            Some(_) => {}
            None => {
                out.push(c);
                if c == '"' || c == '`' {
                    closing = Some(c);
                }
            }
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_errors_lose_the_value_they_quote() {
        assert_eq!(error_text("invalid type: string \"hunter2\", expected u32"), "invalid type: string \"…\", expected u32");
        assert_eq!(
            error_text("unknown variant `sekret`, expected one of `a`, `b`"),
            "unknown variant `…`, expected one of `…`, `…`"
        );
        assert_eq!(error_text("missing field `id`"), "missing field `…`");
    }

    #[test]
    fn other_errors_stay_and_long_or_multiline_ones_are_cut() {
        assert_eq!(error_text("Session abc not found"), "Session abc not found");
        assert_eq!(error_text("first\nsecond"), "first");
        assert!(error_text(&"x".repeat(1000)).chars().count() <= ERROR_CAP + 1);
    }
}
