//! Helpers for what is written to the daemon's trace (`crewd::trace`).
//!
//! The rule for every `tracing` event in this workspace: ids, kinds,
//! durations, sizes, counts, status names and error text, and nothing a user
//! typed or a model said (prompts, responses, tool arguments or results,
//! terminal input or output, file contents, tokens, cookies, env values).

use std::time::Duration;

/// Longest error text a trace line carries.
const ERROR_CAP: usize = 300;

/// A turn's id: made when it starts, to follow it through the trace. It is
/// not stored and not on the wire.
pub fn turn_id() -> String {
    uuid::Uuid::new_v4().simple().to_string()[..12].to_string()
}

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

/// The events a test made, held in memory: how a test proves a line is really
/// written. One global subscriber per test binary, so a test finds its own events
/// by an id it made up (a session id, a path) rather than by being alone.
#[cfg(feature = "capture")]
pub mod capture {
    use std::collections::BTreeMap;
    use std::fmt::Write as _;
    use std::sync::{Mutex, OnceLock};

    use tracing::field::{Field, Visit};
    use tracing::span::{Attributes, Id};
    use tracing::{Event, Subscriber};
    use tracing_subscriber::layer::{Context, SubscriberExt};
    use tracing_subscriber::registry::LookupSpan;
    use tracing_subscriber::util::SubscriberInitExt;
    use tracing_subscriber::Layer;

    /// One event: its message, level, target and fields, with the fields of the
    /// spans around it (an event's own field wins a clash).
    #[derive(Debug, Clone)]
    pub struct Captured {
        pub level: tracing::Level,
        pub target: String,
        pub message: String,
        pub fields: BTreeMap<String, String>,
    }

    impl Captured {
        pub fn get(&self, key: &str) -> Option<&str> {
            self.fields.get(key).map(String::as_str)
        }
    }

    static EVENTS: Mutex<Vec<Captured>> = Mutex::new(Vec::new());

    #[derive(Default)]
    struct Fields(BTreeMap<String, String>);

    impl Visit for Fields {
        fn record_str(&mut self, field: &Field, value: &str) {
            self.0.insert(field.name().to_string(), value.to_string());
        }
        fn record_debug(&mut self, field: &Field, value: &dyn std::fmt::Debug) {
            let mut text = String::new();
            let _ = write!(text, "{value:?}");
            self.0.insert(field.name().to_string(), text);
        }
    }

    /// The layer that records. [`install`] puts it alone in a registry; a test
    /// binary that installs its own subscriber adds this one to it.
    pub struct CaptureLayer;

    impl<S: Subscriber + for<'a> LookupSpan<'a>> Layer<S> for CaptureLayer {
        fn on_new_span(&self, attrs: &Attributes<'_>, id: &Id, ctx: Context<'_, S>) {
            let mut fields = Fields::default();
            attrs.record(&mut fields);
            if let Some(span) = ctx.span(id) {
                span.extensions_mut().insert(fields);
            }
        }

        fn on_event(&self, event: &Event<'_>, ctx: Context<'_, S>) {
            let mut own = Fields::default();
            event.record(&mut own);
            let mut fields = BTreeMap::new();
            if let Some(scope) = ctx.event_scope(event) {
                // Outermost first, so the innermost span's value wins.
                for span in scope.from_root() {
                    if let Some(held) = span.extensions().get::<Fields>() {
                        fields.extend(held.0.clone());
                    }
                }
            }
            fields.extend(own.0);
            let message = fields.remove("message").unwrap_or_default();
            let meta = event.metadata();
            let captured = Captured { level: *meta.level(), target: meta.target().to_string(), message, fields };
            EVENTS.lock().unwrap_or_else(|e| e.into_inner()).push(captured);
        }
    }

    /// Installs the capture as the process's subscriber, unless one is there
    /// already (a test binary that traces to files adds [`CaptureLayer`] itself).
    pub fn install() {
        static ONCE: OnceLock<()> = OnceLock::new();
        ONCE.get_or_init(|| {
            let _ = tracing_subscriber::registry().with(CaptureLayer).try_init();
        });
    }

    /// The captured events whose message is `message` and whose field `key` is `value`.
    pub fn find(message: &str, key: &str, value: &str) -> Vec<Captured> {
        EVENTS
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .iter()
            .filter(|event| event.message == message && event.get(key) == Some(value))
            .cloned()
            .collect()
    }

    /// Every captured event with this message, whoever made it.
    pub fn all(message: &str) -> Vec<Captured> {
        EVENTS.lock().unwrap_or_else(|e| e.into_inner()).iter().filter(|event| event.message == message).cloned().collect()
    }

    /// The first captured event with this message and a field `key` that is `value`,
    /// waiting up to ten seconds for it: for a line another thread writes a moment later.
    pub fn expect(message: &str, key: &str, value: &str) -> Captured {
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(10);
        loop {
            if let Some(found) = find(message, key, value).into_iter().next() {
                return found;
            }
            assert!(std::time::Instant::now() < deadline, "no {message} with {key}={value} was traced");
            std::thread::sleep(std::time::Duration::from_millis(20));
        }
    }
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
