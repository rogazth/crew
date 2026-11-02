//! What a child session did that its parent waits for: a turn ended, it
//! stopped to ask, it failed, it exited.
//!
//! Each event is written at the transcript position it happened at, and every
//! event appends at least one block — the turn's `Turn ended`, the approval
//! card, the error, the `Stopped` — so no two events share a position. That is
//! what makes the position a cursor: a wait compares positions, so a turn that
//! started and ended between two calls is still there to be found, whatever
//! the status says by the time anyone looks.

use std::sync::{Arc, Condvar, Mutex};
use std::time::{Duration, Instant};

use crew_protocol::{Block, BlockRole};
use rusqlite::{params, OptionalExtension};
use serde::Serialize;
use serde_json::Value;

use crate::store::{now_millis, Store};

pub const MIGRATION: &str = "
CREATE TABLE IF NOT EXISTS session_events (
  session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  cursor     INTEGER NOT NULL,
  -- turn | needs-input | error | exited
  kind       TEXT NOT NULL,
  -- completed | stopped for a turn; the error for an error; why, for an exit
  outcome    TEXT NOT NULL DEFAULT '',
  -- The turn's last assistant message: its report.
  report     TEXT NOT NULL DEFAULT '',
  -- What a session that needs input is asking, as JSON.
  request    TEXT,
  at         INTEGER NOT NULL,
  PRIMARY KEY (session_id, cursor)
);
";

#[derive(Serialize, Clone, Debug, PartialEq)]
pub struct Event {
    pub session_id: String,
    pub cursor: i64,
    pub kind: String,
    pub outcome: String,
    pub report: String,
    pub request: Option<Value>,
    pub at: i64,
}

/// Write an event at `cursor`, and move the session's own cursor there. A
/// second event at a position already taken replaces nothing: the first one is
/// what happened there.
pub fn record(
    store: &Store,
    session_id: &str,
    cursor: i64,
    kind: &str,
    outcome: &str,
    report: &str,
    request: Option<&Value>,
) -> Result<(), String> {
    record_reporting(store, session_id, cursor, kind, outcome, report, request, None)
}

/// [`record`], and the letter that reports it to a bot parent, in one
/// transaction: a daemon that dies between the two must not leave an event
/// nobody is told about, nor a report of an event that was never written.
#[allow(clippy::too_many_arguments)]
pub fn record_reporting(
    store: &Store,
    session_id: &str,
    cursor: i64,
    kind: &str,
    outcome: &str,
    report: &str,
    request: Option<&Value>,
    letter: Option<&crate::mailbox::Letter>,
) -> Result<(), String> {
    store.with(|conn| {
        let tx = conn.unchecked_transaction()?;
        tx.execute(
            "INSERT OR IGNORE INTO session_events (session_id, cursor, kind, outcome, report, request, at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
            params![session_id, cursor, kind, outcome, report, request.map(|value| value.to_string()), now_millis()],
        )?;
        tx.execute("UPDATE sessions SET cursor = MAX(cursor, ?2) WHERE id = ?1", params![session_id, cursor])?;
        if let Some(letter) = letter {
            crate::mailbox::insert(&tx, letter)?;
        }
        tx.commit()
    })?;
    trace_event(session_id, cursor, kind, outcome, request, letter.is_some());
    store.session_changed(session_id);
    if let Some(letter) = letter {
        store.mailbox_changed(&letter.to_session);
    }
    Ok(())
}

/// One line for each event a session records, which is where its turns end, it needs
/// the user, fails or exits. The outcome is a class, never the report or the request:
/// an error's text is cut to a line, and who stopped an exit is not said.
fn trace_event(session_id: &str, cursor: i64, kind: &str, outcome: &str, request: Option<&Value>, letter: bool) {
    match kind {
        "error" => {
            tracing::warn!(session_id, cursor, kind, outcome = "failed", error = %crate::trace::error_text(outcome), letter, "session.event")
        }
        "exited" => {
            let class = if outcome.starts_with("idle for") {
                "idle_timeout"
            } else if outcome.starts_with("stopped by") {
                "stopped"
            } else {
                "exited"
            };
            tracing::info!(session_id, cursor, kind, outcome = class, letter, "session.event")
        }
        "needs-input" => {
            let asked = request.and_then(|request| request.get("kind")).and_then(Value::as_str).unwrap_or("input");
            let asked = if matches!(asked, "question" | "approval") { asked } else { "input" };
            tracing::info!(session_id, cursor, kind, outcome = asked, letter, "session.event")
        }
        _ => {
            let class = if matches!(outcome, "completed" | "stopped") { outcome } else { "other" };
            tracing::info!(session_id, cursor, kind, outcome = class, letter, "session.event")
        }
    }
}

fn row_to_event(row: &rusqlite::Row) -> rusqlite::Result<Event> {
    let request: Option<String> = row.get(5)?;
    Ok(Event {
        session_id: row.get(0)?,
        cursor: row.get(1)?,
        kind: row.get(2)?,
        outcome: row.get(3)?,
        report: row.get(4)?,
        request: request.and_then(|raw| serde_json::from_str(&raw).ok()),
        at: row.get(6)?,
    })
}

const SELECT: &str = "SELECT session_id, cursor, kind, outcome, report, request, at FROM session_events";

/// Every event after `since`, oldest first.
pub fn after(store: &Store, session_id: &str, since: i64) -> Result<Vec<Event>, String> {
    store.with(|conn| {
        conn.prepare_cached(&format!("{SELECT} WHERE session_id = ?1 AND cursor > ?2 ORDER BY cursor ASC"))?
            .query_map(params![session_id, since], row_to_event)?
            .collect()
    })
}

/// The newest event, whenever it was.
pub fn latest(store: &Store, session_id: &str) -> Result<Option<Event>, String> {
    store.with(|conn| {
        conn.prepare_cached(&format!("{SELECT} WHERE session_id = ?1 ORDER BY cursor DESC LIMIT 1"))?
            .query_row(params![session_id], row_to_event)
            .optional()
    })
}

/// How many turns the session has finished, for naming the next one.
pub fn turns(store: &Store, session_id: &str) -> Result<i64, String> {
    store.with(|conn| {
        conn.prepare_cached("SELECT COUNT(*) FROM session_events WHERE session_id = ?1 AND kind IN ('turn', 'error')")?
            .query_row(params![session_id], |row| row.get(0))
    })
}

/// What the session's owner has seen of it, as a cursor.
pub fn seen(store: &Store, session_id: &str) -> Result<i64, String> {
    store.with(|conn| {
        conn.prepare_cached("SELECT seen FROM sessions WHERE id = ?1")?
            .query_row(params![session_id], |row| row.get::<_, i64>(0))
            .optional()
            .map(|seen| seen.unwrap_or(0))
    })
}

/// The owner has seen the session up to `cursor`. Never moves back: a wait
/// that passes an old cursor reads again what it already saw, and that is its
/// business, not a reason to show it everything twice next time.
pub fn mark_seen(store: &Store, session_id: &str, cursor: i64) -> Result<(), String> {
    store.with(|conn| {
        conn.prepare_cached("UPDATE sessions SET seen = MAX(seen, ?2) WHERE id = ?1")?.execute(params![session_id, cursor])
    })?;
    Ok(())
}

/// The final message of the turn that ends the transcript: the last assistant
/// text after the last thing somebody said to it. Empty when the turn said
/// nothing.
pub fn report(blocks: &[Block]) -> String {
    for block in blocks.iter().rev() {
        match block.role {
            BlockRole::User => break,
            BlockRole::Assistant if !block.text.trim().is_empty() => return block.text.trim().to_string(),
            _ => {}
        }
    }
    String::new()
}

/// Wakes whoever waits on a session when anything happens to one. One for the
/// whole daemon: a waiter re-reads its own sessions on every wake, and events
/// are a few a minute, not a few a millisecond.
#[derive(Clone, Default)]
pub struct Signal {
    inner: Arc<(Mutex<u64>, Condvar)>,
}

impl Signal {
    /// Something happened. Every waiter wakes and looks.
    pub fn notify(&self) {
        let (count, wake) = &*self.inner;
        *count.lock().unwrap_or_else(|e| e.into_inner()) += 1;
        wake.notify_all();
    }

    /// The count now, to wait past. Read it before looking, so an event that
    /// lands between the look and the wait is not slept through.
    pub fn mark(&self) -> u64 {
        *self.inner.0.lock().unwrap_or_else(|e| e.into_inner())
    }

    /// Sleep until the count moves past `mark` or `until` passes. True when
    /// something happened.
    pub fn wait(&self, mark: u64, until: Instant) -> bool {
        let (count, wake) = &*self.inner;
        let mut guard = count.lock().unwrap_or_else(|e| e.into_inner());
        while *guard == mark {
            let now = Instant::now();
            if now >= until {
                return false;
            }
            let (next, _) =
                wake.wait_timeout(guard, (until - now).min(Duration::from_secs(5))).unwrap_or_else(|e| e.into_inner());
            guard = next;
        }
        true
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn block(role: BlockRole, text: &str) -> Block {
        Block {
            id: uuid::Uuid::new_v4().to_string(),
            role,
            text: text.into(),
            at: None,
            hidden: None,
            streaming: None,
            files: None,
            tool: None,
            approval: None,
            question: None,
            usage: None,
            from_bot: None,
            letter_id: None,
            letter_kind: None,
        }
    }

    #[test]
    fn the_report_is_the_last_thing_the_turn_said() {
        let blocks = vec![
            block(BlockRole::User, "do it"),
            block(BlockRole::Assistant, "on it"),
            block(BlockRole::System, "tool"),
            block(BlockRole::Assistant, "done: 3 files"),
            block(BlockRole::System, "Turn ended"),
        ];
        assert_eq!(report(&blocks), "done: 3 files");
    }

    #[test]
    fn a_turn_that_said_nothing_reports_nothing_from_the_turn_before() {
        let blocks =
            vec![block(BlockRole::User, "one"), block(BlockRole::Assistant, "first answer"), block(BlockRole::User, "two")];
        assert_eq!(report(&blocks), "");
    }

    /// The event and the report that tells a bot parent of it are one write:
    /// a report that cannot be written takes the event with it, so there is
    /// never one without the other.
    #[test]
    fn an_event_and_its_report_are_written_together_or_not_at_all() {
        let dir = std::env::temp_dir().join(format!("crew-events-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).expect("dir");
        let store = Store::open(dir.join("crew.sqlite3")).expect("store");
        let ws = crate::workspace::create(&store, "w".into(), dir.to_string_lossy().into()).expect("ws");
        let parent = crate::session::create(
            &store,
            ws.id.clone(),
            "bot".into(),
            "Planner".into(),
            "claude".into(),
            "m".into(),
            "".into(),
            "full".into(),
        )
        .expect("parent");
        let child = crate::session::create_child(
            &store,
            ws.id,
            "codex: fix".into(),
            "codex".into(),
            "m".into(),
            "full".into(),
            None,
            Some(parent.id.clone()),
        )
        .expect("child");
        let from = crew_protocol::BotRef { id: child.id.clone(), name: child.name.clone(), kind: Some("session".into()) };

        let good = crate::mailbox::Letter::new(&parent.id, &from, "done", crate::mailbox::REPORT, Some(2));
        record_reporting(&store, &child.id, 2, "turn", "completed", "done", None, Some(&good)).expect("both");
        assert_eq!(after(&store, &child.id, 0).expect("events").len(), 1);
        assert_eq!(crate::mailbox::waiting(&store, &parent.id).expect("box"), vec![good]);

        // To a box that does not exist: the foreign key refuses the letter.
        let lost = crate::mailbox::Letter::new("nobody", &from, "done again", crate::mailbox::REPORT, Some(5));
        assert!(record_reporting(&store, &child.id, 5, "turn", "completed", "done again", None, Some(&lost)).is_err());
        assert_eq!(after(&store, &child.id, 2).expect("events"), vec![], "the event outlived its report");
        let cursor = crate::session::get(&store, child.id.clone()).expect("get").expect("child").cursor;
        assert_eq!(cursor, 2);
    }

    /// One line per event, holding the kind and a class of outcome and never the
    /// report, the request or who stopped it.
    #[test]
    fn each_event_is_traced_by_kind_and_outcome_class_without_its_report() {
        use crate::trace::capture;
        capture::install();
        let dir = std::env::temp_dir().join(format!("crew-events-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).expect("dir");
        let store = Store::open(dir.join("crew.sqlite3")).expect("store");
        let ws = crate::workspace::create(&store, "w".into(), dir.to_string_lossy().into()).expect("ws");
        let child = crate::session::create_child(
            &store,
            ws.id,
            "codex: fix".into(),
            "codex".into(),
            "m".into(),
            "full".into(),
            None,
            None,
        )
        .expect("child");
        let id = child.id.as_str();
        let secret = "SECRET-REPORT-3f9a";
        let request = serde_json::json!({ "kind": "approval", "command": secret });
        record_reporting(&store, id, 1, "turn", "completed", secret, None, None).expect("turn");
        record_reporting(&store, id, 2, "needs-input", "", secret, Some(&request), None).expect("asks");
        let failure = format!("boom {}\nsecond line {secret}", "x".repeat(600));
        record_reporting(&store, id, 3, "error", &failure, secret, None, None).expect("error");
        record_reporting(&store, id, 4, "exited", "stopped by Planner-Bot", secret, None, None).expect("exit");

        let ours: Vec<_> = capture::find("session.event", "session_id", id);
        let seen: Vec<(String, String, String)> = ours
            .iter()
            .map(|e| (e.get("kind").unwrap().into(), e.get("cursor").unwrap().into(), e.get("outcome").unwrap().into()))
            .collect();
        let want = |kind: &str, cursor: &str, outcome: &str| (kind.to_string(), cursor.to_string(), outcome.to_string());
        assert_eq!(
            seen,
            [want("turn", "1", "completed"), want("needs-input", "2", "approval"), want("error", "3", "failed"), want("exited", "4", "stopped")]
        );
        assert_eq!(ours[2].level, tracing::Level::WARN);
        let error = ours[2].get("error").unwrap();
        assert!(error.starts_with("boom ") && !error.contains("second line") && error.chars().count() <= 301, "{error}");
        for event in &ours {
            assert!(event.fields.values().all(|v| !v.contains(secret) && !v.contains("Planner-Bot")), "{event:?}");
        }
    }

    #[test]
    fn a_wait_wakes_on_a_notify_and_not_before() {
        let signal = Signal::default();
        let mark = signal.mark();
        assert!(!signal.wait(mark, Instant::now() + Duration::from_millis(30)), "nothing happened");
        let other = signal.clone();
        let poke = std::thread::spawn(move || {
            std::thread::sleep(Duration::from_millis(30));
            other.notify();
        });
        assert!(signal.wait(mark, Instant::now() + Duration::from_secs(5)));
        poke.join().unwrap();
        // A notify between the mark and the wait is not slept through.
        let mark = signal.mark();
        signal.notify();
        assert!(signal.wait(mark, Instant::now() + Duration::from_millis(10)));
    }

    /// The row says what a chip shows without guessing: its parent's name,
    /// its last event by kind, and how far the user has read it. Each change
    /// is heard, so the window can redraw the row.
    #[test]
    fn a_row_carries_its_last_event_and_what_the_user_has_seen() {
        let dir = std::env::temp_dir().join(format!("crew-events-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).expect("dir");
        let store = Store::open(dir.join("crew.sqlite3")).expect("store");
        let heard = Arc::new(Mutex::new(Vec::<String>::new()));
        let log = heard.clone();
        store.set_listener(Arc::new(move |what| {
            if let crate::store::Changed::Session(id) = what {
                log.lock().unwrap().push(id.to_string());
            }
        }));
        let ws = crate::workspace::create(&store, "w".into(), dir.to_string_lossy().into()).expect("ws");
        let parent = crate::session::create(
            &store,
            ws.id.clone(),
            "bot".into(),
            "Planner".into(),
            "claude".into(),
            "m".into(),
            "".into(),
            "full".into(),
        )
        .expect("parent");
        let child = crate::session::create_child(
            &store,
            ws.id,
            "codex: fix".into(),
            "codex".into(),
            "m".into(),
            "full".into(),
            None,
            Some(parent.id.clone()),
        )
        .expect("child");
        assert_eq!((child.parent_name.as_deref(), child.last_event.as_ref()), (Some("Planner"), None));
        let kind = |cursor, kind: &str, outcome: &str, request: Option<Value>| {
            record(&store, &child.id, cursor, kind, outcome, "", request.as_ref()).expect("event");
            let row = crate::session::get(&store, child.id.clone()).expect("get").expect("row");
            let last = row.last_event.expect("an event");
            assert_eq!(last.cursor, cursor);
            last.kind
        };
        assert_eq!(kind(2, "turn", "completed", None), "report");
        assert_eq!(kind(4, "needs-input", "", Some(serde_json::json!({ "kind": "question", "questions": [] }))), "question");
        assert_eq!(kind(6, "needs-input", "", Some(serde_json::json!({ "kind": "approval" }))), "approval");
        assert_eq!(kind(8, "turn", "stopped", None), "stopped");
        assert_eq!(kind(10, "error", "boom", None), "failed");
        assert_eq!(kind(12, "exited", "idle", None), "exited");
        assert_eq!(heard.lock().unwrap().len(), 6);

        let seen = crate::session::mark_user_seen(&store, child.id.clone(), Some(4)).expect("seen").expect("row");
        assert_eq!(seen.user_seen, 4);
        let all = crate::session::mark_user_seen(&store, child.id.clone(), None).expect("seen").expect("row");
        assert_eq!(all.user_seen, 12);
        // Never back, and nothing heard when nothing moved.
        let back = crate::session::mark_user_seen(&store, child.id.clone(), Some(1)).expect("seen").expect("row");
        assert_eq!(back.user_seen, 12);
        assert_eq!(heard.lock().unwrap().len(), 8);
    }
}
