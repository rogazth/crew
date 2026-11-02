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

/// Counts one more of something that can repeat without end and says whether this one is
/// worth a line: the first few, then one in thirty (the window's `loud`). The count rides along.
pub fn throttled(counter: &std::sync::atomic::AtomicU64) -> Option<u64> {
    let count = counter.fetch_add(1, std::sync::atomic::Ordering::Relaxed) + 1;
    (count <= 5 || count % 30 == 0).then_some(count)
}

/// A stream frame that was not JSON, where there is no line to look at. Counted like [`unparsed`].
pub fn unparsed_frame(provider: &str) {
    static COUNT: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
    let count = COUNT.fetch_add(1, std::sync::atomic::Ordering::Relaxed) + 1;
    if count <= 3 || count % 100 == 0 {
        tracing::warn!(provider, unparsed = count, "provider.unparsed");
    }
}

/// A provider's app server or CLI that did not come up: which step failed, and why in a line.
pub fn connect_failed(provider: &str, session_id: &str, stage: &str, error: &str) {
    tracing::warn!(provider, session_id, stage, error = %error_text(error), "provider.connect_failed");
}

/// A provider's connection is up: how long the handshake took and whether it picked up an earlier conversation.
pub fn connected(provider: &str, session_id: &str, resumed: bool, started: std::time::Instant) {
    tracing::info!(provider, session_id, resumed, took_ms = ms(started.elapsed()), "provider.connected");
}

/// A line a provider's process wrote that is not JSON. A CLI may print such a line
/// each time it likes, so the first few are traced and then one in a hundred, with the
/// running count for the session; the line itself is never recorded, only how it failed and its size.
pub fn unparsed(provider: &str, session_id: &str, line: &str) {
    static COUNTS: std::sync::Mutex<Option<std::collections::HashMap<String, u64>>> = std::sync::Mutex::new(None);
    let category = match serde_json::from_str::<serde_json::Value>(line) {
        // JSON that is not what the caller wanted is not this.
        Ok(_) => return,
        Err(error) => match error.classify() {
            serde_json::error::Category::Io => "io",
            serde_json::error::Category::Syntax => "syntax",
            serde_json::error::Category::Data => "data",
            serde_json::error::Category::Eof => "eof",
        },
    };
    let count = {
        let mut counts = COUNTS.lock().unwrap_or_else(|e| e.into_inner());
        let counts = counts.get_or_insert_with(Default::default);
        // Sessions come and go: what is counted for the ones gone is not worth keeping.
        if counts.len() > 512 {
            counts.clear();
        }
        let count = counts.entry(session_id.to_string()).or_insert(0);
        *count += 1;
        *count
    };
    if count > 3 && count % 100 != 0 {
        return;
    }
    tracing::warn!(provider, session_id, category, bytes = line.len(), unparsed = count, "provider.unparsed");
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
    let first_line = redact_urls(error.lines().next().unwrap_or(""));
    let first_line = first_line.as_str();
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

/// An address is not recorded: `scheme://rest` up to a space or a closing bracket or quote
/// becomes `<url>`, and what the error says around it stays ("<url> answered 503").
fn redact_urls(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut rest = text;
    while let Some(at) = rest.find("://") {
        let head = &rest[..at];
        let scheme_start = head.rfind(|c: char| !(c.is_ascii_alphanumeric() || matches!(c, '+' | '.' | '-'))).map_or(0, |i| i + 1);
        let scheme = &head[scheme_start..];
        let after = &rest[at + 3..];
        if !scheme.chars().next().is_some_and(|c| c.is_ascii_alphabetic()) || after.is_empty() {
            out.push_str(&rest[..at + 3]);
            rest = after;
            continue;
        }
        out.push_str(&head[..scheme_start]);
        out.push_str("<url>");
        let end = after.find(|c: char| c.is_whitespace() || matches!(c, ')' | '"' | '\'' | '<' | '>' | ']')).unwrap_or(after.len());
        rest = &after[end..];
    }
    out.push_str(rest);
    out
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
    use super::capture;
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
    fn an_unparseable_line_leaves_its_kind_and_size_and_never_the_line() {
        capture::install();
        let session = format!("unparsed-{}", uuid::Uuid::new_v4());
        // Not JSON, cut off, and valid JSON (which is not this).
        unparsed("codex", &session, "warning: SECRET-LINE is not json");
        unparsed("codex", &session, "{\"a\": \"SECRET-LINE");
        unparsed("codex", &session, "{\"a\": 1}");
        let seen = capture::find("provider.unparsed", "session_id", &session);
        let kinds: Vec<_> = seen.iter().map(|e| e.get("category").unwrap().to_string()).collect();
        assert_eq!(kinds, ["syntax", "eof"], "{seen:?}");
        assert_eq!(seen[0].get("bytes"), Some("32"));
        assert!(seen.iter().all(|e| e.level == tracing::Level::WARN && e.fields.values().all(|v| !v.contains("SECRET"))));
    }

    #[test]
    fn a_failed_connection_names_its_step_and_one_line_of_why() {
        capture::install();
        let session = format!("connect-{}", uuid::Uuid::new_v4());
        connect_failed("cursor", &session, "authenticate", "login needed\nsecond line SECRET");
        let line = capture::expect("provider.connect_failed", "session_id", &session);
        assert_eq!(
            (line.get("stage"), line.get("error"), line.level),
            (Some("authenticate"), Some("login needed"), tracing::Level::WARN)
        );
        connected("cursor", &session, true, std::time::Instant::now());
        let up = capture::expect("provider.connected", "session_id", &session);
        assert_eq!(up.get("resumed"), Some("true"));
    }

    #[test]
    fn an_address_in_an_error_is_not_recorded_and_the_words_around_it_are() {
        assert_eq!(error_text("https://example.com/releases/latest.json answered 503"), "<url> answered 503");
        assert_eq!(
            error_text("error sending request for url (https://cursor.com/api/x?token=SECRET): timed out"),
            "error sending request for url (<url>): timed out"
        );
        assert_eq!(error_text("tried ws://127.0.0.1:1 and wss://host/p then gave up"), "tried <url> and <url> then gave up");
        assert_eq!(error_text("a :// alone and 9p://x"), "a :// alone and 9p://x");
        assert_eq!(error_text("trailing :// "), "trailing :// ");
    }

    #[test]
    fn other_errors_stay_and_long_or_multiline_ones_are_cut() {
        assert_eq!(error_text("Session abc not found"), "Session abc not found");
        assert_eq!(error_text("first\nsecond"), "first");
        assert!(error_text(&"x".repeat(1000)).chars().count() <= ERROR_CAP + 1);
    }
}
