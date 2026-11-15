//! How full each session's context window last was, kept between runs: the
//! composer's meter shows it on a restart, before the CLI is up to say it
//! again. One row per session, the newest merged reading; it goes with its
//! session.

use crew_protocol::ContextReading;
use rusqlite::{params, Connection, OptionalExtension};

pub const MIGRATION_V54: &str = "
CREATE TABLE IF NOT EXISTS session_contexts (
  session_id      TEXT PRIMARY KEY REFERENCES sessions(id) ON DELETE CASCADE,
  used            INTEGER NOT NULL,
  context_window  INTEGER,
  auto_compact_at INTEGER,
  stale           INTEGER NOT NULL DEFAULT 0,
  updated_at      INTEGER NOT NULL
);
";

fn int(n: Option<u64>) -> Option<i64> {
    n.map(|n| n.min(i64::MAX as u64) as i64)
}

pub(crate) fn put(conn: &Connection, session_id: &str, reading: &ContextReading) -> rusqlite::Result<()> {
    conn.prepare_cached(
        "INSERT INTO session_contexts (session_id, used, context_window, auto_compact_at, stale, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6)
         ON CONFLICT(session_id) DO UPDATE SET
           used = excluded.used, context_window = excluded.context_window,
           auto_compact_at = excluded.auto_compact_at, stale = excluded.stale, updated_at = excluded.updated_at",
    )?
    .execute(params![
        session_id,
        int(Some(reading.used)),
        int(reading.window),
        int(reading.auto_compact_at),
        reading.stale == Some(true),
        crate::store::now_millis(),
    ])?;
    Ok(())
}

pub(crate) fn get(conn: &Connection, session_id: &str) -> rusqlite::Result<Option<ContextReading>> {
    let count = |n: Option<i64>| n.map(|n| n.max(0) as u64);
    conn.prepare_cached("SELECT used, context_window, auto_compact_at, stale FROM session_contexts WHERE session_id = ?1")?
        .query_row(params![session_id], |row| {
            Ok(ContextReading {
                used: count(row.get(0)?).unwrap_or(0),
                window: count(row.get(1)?),
                auto_compact_at: count(row.get(2)?),
                stale: row.get::<_, bool>(3)?.then_some(true),
            })
        })
        .optional()
}

pub(crate) fn clear(conn: &Connection, session_id: &str) -> rusqlite::Result<()> {
    conn.execute("DELETE FROM session_contexts WHERE session_id = ?1", params![session_id])?;
    Ok(())
}
