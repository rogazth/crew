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

/// The longest report a wait hands back. The rest is a `read_session` away.
pub const REPORT_LIMIT: usize = 4000;

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
    store.with(|conn| {
        let tx = conn.unchecked_transaction()?;
        tx.execute(
            "INSERT OR IGNORE INTO session_events (session_id, cursor, kind, outcome, report, request, at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
            params![
                session_id,
                cursor,
                kind,
                outcome,
                report,
                request.map(|value| value.to_string()),
                now_millis()
            ],
        )?;
        tx.execute(
            "UPDATE sessions SET cursor = MAX(cursor, ?2) WHERE id = ?1",
            params![session_id, cursor],
        )?;
        tx.commit()
    })
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
        conn.prepare_cached("UPDATE sessions SET seen = MAX(seen, ?2) WHERE id = ?1")?
            .execute(params![session_id, cursor])
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

/// A report cut to what a wait hands back.
pub fn clip_report(report: &str) -> (String, bool) {
    if report.len() <= REPORT_LIMIT {
        return (report.to_string(), false);
    }
    let mut end = REPORT_LIMIT;
    while !report.is_char_boundary(end) {
        end -= 1;
    }
    (report[..end].to_string(), true)
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
            let (next, _) = wake
                .wait_timeout(guard, (until - now).min(Duration::from_secs(5)))
                .unwrap_or_else(|e| e.into_inner());
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
        let blocks = vec![
            block(BlockRole::User, "one"),
            block(BlockRole::Assistant, "first answer"),
            block(BlockRole::User, "two"),
        ];
        assert_eq!(report(&blocks), "");
    }

    #[test]
    fn a_long_report_is_cut_on_a_character() {
        let long = "é".repeat(REPORT_LIMIT);
        let (cut, clipped) = clip_report(&long);
        assert!(clipped);
        assert!(cut.len() <= REPORT_LIMIT);
        assert!(long.starts_with(&cut));
        assert_eq!(clip_report("short"), ("short".to_string(), false));
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
}
