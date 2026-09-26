use std::path::PathBuf;
use std::sync::{Arc, Mutex};

use rusqlite::{params, Connection, OptionalExtension};

const MIGRATION_V1: &str = r#"
CREATE TABLE IF NOT EXISTS workspaces (
  id         TEXT PRIMARY KEY,
  name       TEXT NOT NULL,
  path       TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
  id                  TEXT PRIMARY KEY,
  workspace_id        TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  kind                TEXT NOT NULL,
  name                TEXT NOT NULL,
  provider            TEXT NOT NULL,
  model               TEXT NOT NULL DEFAULT '',
  provider_session_id TEXT,
  blocks_json         TEXT NOT NULL DEFAULT '[]',
  created_at          INTEGER NOT NULL,
  updated_at          INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS sessions_workspace_updated_idx
  ON sessions (workspace_id, updated_at DESC);

CREATE TABLE IF NOT EXISTS app_state (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
"#;

#[derive(Clone)]
pub struct Store {
    conn: Arc<Mutex<Connection>>,
}

impl Store {
    pub fn open(path: PathBuf) -> Result<Self, String> {
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
        }
        let conn = Connection::open(path).map_err(|e| e.to_string())?;
        // WAL keeps reads from blocking the write that persists a turn.
        conn.pragma_update(None, "journal_mode", "WAL")
            .map_err(|e| e.to_string())?;
        // With WAL a NORMAL sync only loses the last transactions on power loss, never
        // integrity; FULL would fsync on every tab switch and status change.
        conn.pragma_update(None, "synchronous", "NORMAL")
            .map_err(|e| e.to_string())?;
        conn.pragma_update(None, "foreign_keys", "ON")
            .map_err(|e| e.to_string())?;
        // 8 MiB instead of 2: browser history at its cap is just over the default,
        // and every suggestion scan re-read it from the OS.
        conn.pragma_update(None, "cache_size", -8192)
            .map_err(|e| e.to_string())?;
        migrate(&conn).map_err(|e| e.to_string())?;
        // The seeded design profile keeps its working and waiting rows as seeded,
        // so every status can be looked at without a live turn behind it.
        if std::env::var_os("CREW_KEEP_STATUS").is_none() {
            settle_open_turns(&conn).map_err(|e| e.to_string())?;
        }
        Ok(Self {
            conn: Arc::new(Mutex::new(conn)),
        })
    }

    pub fn with<T>(&self, f: impl FnOnce(&Connection) -> rusqlite::Result<T>) -> Result<T, String> {
        let conn = self.conn.lock().map_err(|e| e.to_string())?;
        f(&conn).map_err(|e| e.to_string())
    }
}

fn has_column(conn: &Connection, table: &str, column: &str) -> rusqlite::Result<bool> {
    conn.prepare("SELECT 1 FROM pragma_table_info(?1) WHERE name = ?2")?
        .exists(params![table, column])
}

fn migrate(conn: &Connection) -> rusqlite::Result<()> {
    conn.execute(
        "CREATE TABLE IF NOT EXISTS schema_migrations (
           version    INTEGER PRIMARY KEY,
           applied_at INTEGER NOT NULL
         )",
        [],
    )?;
    let current: i64 = conn.query_row(
        "SELECT COALESCE(MAX(version), 0) FROM schema_migrations",
        [],
        |row| row.get(0),
    )?;
    if current < 1 {
        conn.execute_batch(MIGRATION_V1)?;
        conn.execute(
            "INSERT INTO schema_migrations (version, applied_at) VALUES (1, ?1)",
            params![now_millis()],
        )?;
    }
    if current < 2 {
        conn.execute_batch(
            "CREATE UNIQUE INDEX IF NOT EXISTS workspaces_path_idx ON workspaces (path);",
        )?;
        conn.execute(
            "INSERT INTO schema_migrations (version, applied_at) VALUES (2, ?1)",
            params![now_millis()],
        )?;
    }
    if current < 3 {
        conn.execute_batch(
            "ALTER TABLE sessions ADD COLUMN description TEXT NOT NULL DEFAULT '';
             ALTER TABLE sessions ADD COLUMN notifications INTEGER NOT NULL DEFAULT 1;",
        )?;
        conn.execute(
            "INSERT INTO schema_migrations (version, applied_at) VALUES (3, ?1)",
            params![now_millis()],
        )?;
    }
    if current < 4 {
        conn.execute_batch(
            "ALTER TABLE sessions ADD COLUMN sort_order INTEGER NOT NULL DEFAULT 0;
             UPDATE sessions SET sort_order = created_at;
             ALTER TABLE workspaces ADD COLUMN sort_order INTEGER NOT NULL DEFAULT 0;
             UPDATE workspaces SET sort_order = created_at;",
        )?;
        conn.execute(
            "INSERT INTO schema_migrations (version, applied_at) VALUES (4, ?1)",
            params![now_millis()],
        )?;
    }
    if current < 5 {
        conn.execute_batch(
            "ALTER TABLE sessions ADD COLUMN status TEXT NOT NULL DEFAULT 'idle';",
        )?;
        conn.execute(
            "INSERT INTO schema_migrations (version, applied_at) VALUES (5, ?1)",
            params![now_millis()],
        )?;
    }
    if current < 6 {
        conn.execute_batch(
            "ALTER TABLE sessions ADD COLUMN autonomy TEXT NOT NULL DEFAULT 'ask';",
        )?;
        conn.execute(
            "INSERT INTO schema_migrations (version, applied_at) VALUES (6, ?1)",
            params![now_millis()],
        )?;
    }
    if current < 7 {
        conn.execute_batch(
            "CREATE TABLE IF NOT EXISTS routines (
               id          TEXT PRIMARY KEY,
               session_id  TEXT NOT NULL UNIQUE REFERENCES sessions(id) ON DELETE CASCADE,
               enabled     INTEGER NOT NULL DEFAULT 1,
               prompt      TEXT NOT NULL,
               schedule    TEXT NOT NULL,
               last_run_at INTEGER,
               next_run_at INTEGER,
               created_at  INTEGER NOT NULL,
               updated_at  INTEGER NOT NULL
             );",
        )?;
        conn.execute(
            "INSERT INTO schema_migrations (version, applied_at) VALUES (7, ?1)",
            params![now_millis()],
        )?;
    }
    if current < 8 {
        // Several routines per agent, each with a name and a run history. SQLite
        // cannot drop the UNIQUE on session_id, so the table is rebuilt.
        conn.execute_batch(
            "CREATE TABLE routines_v8 (
               id          TEXT PRIMARY KEY,
               session_id  TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
               name        TEXT NOT NULL DEFAULT '',
               enabled     INTEGER NOT NULL DEFAULT 1,
               prompt      TEXT NOT NULL,
               schedule    TEXT NOT NULL,
               last_run_at INTEGER,
               next_run_at INTEGER,
               runs_json   TEXT NOT NULL DEFAULT '[]',
               created_at  INTEGER NOT NULL,
               updated_at  INTEGER NOT NULL
             );
             INSERT INTO routines_v8
               (id, session_id, name, enabled, prompt, schedule, last_run_at, next_run_at, created_at, updated_at)
             SELECT id, session_id, 'Routine', enabled, prompt, schedule, last_run_at, next_run_at, created_at, updated_at
             FROM routines;
             DROP TABLE routines;
             ALTER TABLE routines_v8 RENAME TO routines;
             CREATE INDEX IF NOT EXISTS routines_session_idx ON routines (session_id);",
        )?;
        conn.execute(
            "INSERT INTO schema_migrations (version, applied_at) VALUES (8, ?1)",
            params![now_millis()],
        )?;
    }
    if current < 9 {
        conn.execute("ALTER TABLE routines ADD COLUMN created_by TEXT", [])?;
        conn.execute(
            "INSERT INTO schema_migrations (version, applied_at) VALUES (9, ?1)",
            params![now_millis()],
        )?;
    }
    if current < 10 {
        conn.execute_batch(crate::messages::MIGRATION_V10)?;
        // The transcripts that already exist are the ones worth searching.
        crate::messages::backfill(conn)?;
        conn.execute(
            "INSERT INTO schema_migrations (version, applied_at) VALUES (10, ?1)",
            params![now_millis()],
        )?;
    }
    if current < 11 {
        conn.execute_batch(crate::mailbox::MIGRATION_V11)?;
        conn.execute(
            "INSERT INTO schema_migrations (version, applied_at) VALUES (11, ?1)",
            params![now_millis()],
        )?;
    }
    if current < 12 {
        // No query ever used it: search is driven by the FTS match and every
        // other read goes by primary key. It was write amplification only.
        conn.execute_batch("DROP INDEX IF EXISTS messages_at_idx;")?;
        conn.execute(
            "INSERT INTO schema_migrations (version, applied_at) VALUES (12, ?1)",
            params![now_millis()],
        )?;
    }
    if current < 13 {
        // The first destructive migration, so it is also the first that has to
        // be all or nothing: dying between the DROP and the version row would
        // leave a database that can never be opened again, because the retry
        // starts by reading the column that is gone.
        conn.execute_batch("BEGIN")?;
        let applied = (|| -> rusqlite::Result<()> {
            // Belt and braces: a database half-migrated by an older build has
            // no column left, and reading it again would lock the user out.
            if has_column(conn, "sessions", "blocks_json")? {
                // The rows become the only copy, so repair any that fell behind.
                crate::messages::backfill_missing(conn)?;
                conn.execute_batch("ALTER TABLE sessions DROP COLUMN blocks_json;")?;
            }
            conn.execute(
                "INSERT INTO schema_migrations (version, applied_at) VALUES (13, ?1)",
                params![now_millis()],
            )?;
            Ok(())
        })();
        match applied {
            Ok(()) => conn.execute_batch("COMMIT")?,
            Err(error) => {
                let _ = conn.execute_batch("ROLLBACK");
                return Err(error);
            }
        }
    }
    if current < 14 {
        conn.execute_batch("ALTER TABLE sessions ADD COLUMN provider_title TEXT;")?;
        conn.execute(
            "INSERT INTO schema_migrations (version, applied_at) VALUES (14, ?1)",
            params![now_millis()],
        )?;
    }
    // From here on each step is all or nothing, like 13: dying between the
    // DDL and its version row must not leave a step applied but unrecorded.
    // The transaction rolls back when dropped on an error.
    if current < 15 {
        let tx = conn.unchecked_transaction()?;
        tx.execute_batch(crate::browser::MIGRATION_V15)?;
        tx.execute(
            "INSERT INTO schema_migrations (version, applied_at) VALUES (15, ?1)",
            params![now_millis()],
        )?;
        tx.commit()?;
    }
    if current < 16 {
        let tx = conn.unchecked_transaction()?;
        tx.execute_batch(crate::browser::MIGRATION_V16)?;
        tx.execute(
            "INSERT INTO schema_migrations (version, applied_at) VALUES (16, ?1)",
            params![now_millis()],
        )?;
        tx.commit()?;
    }
    if current < 17 {
        // NULL is the workspace folder, which is where every session so far ran.
        // A database wound back to an earlier version still has the column.
        let tx = conn.unchecked_transaction()?;
        if !has_column(&tx, "sessions", "worktree")? {
            tx.execute_batch("ALTER TABLE sessions ADD COLUMN worktree TEXT;")?;
        }
        tx.execute(
            "INSERT INTO schema_migrations (version, applied_at) VALUES (17, ?1)",
            params![now_millis()],
        )?;
        tx.commit()?;
    }
    Ok(())
}

/// Small durable key/value for chrome that has to survive a restart: the active
/// workspace, the open tabs of each one.
pub fn get(store: &Store, key: String) -> Result<Option<String>, String> {
    store.with(|conn| read_state(conn, &key))
}

pub fn set(store: &Store, key: String, value: String) -> Result<(), String> {
    store.with(|conn| write_state(conn, &key, Some(&value)))
}

pub fn delete(store: &Store, key: String) -> Result<(), String> {
    store.with(|conn| write_state(conn, &key, None))
}

pub fn read_state(conn: &Connection, key: &str) -> rusqlite::Result<Option<String>> {
    conn.prepare_cached("SELECT value FROM app_state WHERE key = ?1")?
        .query_row(params![key], |row| row.get::<_, String>(0))
        .optional()
}

pub fn write_state(conn: &Connection, key: &str, value: Option<&str>) -> rusqlite::Result<()> {
    match value {
        Some(value) => conn
            .prepare_cached(
                "INSERT INTO app_state (key, value) VALUES (?1, ?2)
                 ON CONFLICT(key) DO UPDATE SET value = excluded.value",
            )?
            .execute(params![key, value]),
        None => conn
            .prepare_cached("DELETE FROM app_state WHERE key = ?1")?
            .execute(params![key]),
    }
    .map(|_| ())
}

/// One transaction, one fsync: row by row, a drag over twenty rows would sync twenty times.
pub fn set_order(conn: &Connection, table: &str, ids: &[String]) -> rusqlite::Result<()> {
    let sql = format!("UPDATE {table} SET sort_order = ?2 WHERE id = ?1");
    conn.execute_batch("BEGIN")?;
    let result = (|| {
        let mut stmt = conn.prepare_cached(&sql)?;
        for (index, id) in ids.iter().enumerate() {
            stmt.execute(params![id, index as i64])?;
        }
        Ok(())
    })();
    match result {
        Ok(()) => conn.execute_batch("COMMIT"),
        Err(err) => {
            let _ = conn.execute_batch("ROLLBACK");
            Err(err)
        }
    }
}

/// A turn that was running when the daemon stopped left tool rows spinning.
fn settle_open_turns(conn: &Connection) -> rusqlite::Result<()> {
    let mut stmt =
        conn.prepare("SELECT id FROM sessions WHERE status IN ('working', 'needs-input')")?;
    let ids = stmt
        .query_map([], |row| row.get::<_, String>(0))?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    drop(stmt);
    for id in ids {
        let settled = crate::blocks::settle_turn(
            crate::messages::all(conn, &id)?,
            crew_protocol::ToolStatus::Interrupted,
        );
        let mut prior = crate::messages::fingerprints(conn, &id)?;
        crate::messages::sync(conn, &id, &settled, &mut prior)?;
        conn.execute(
            "UPDATE sessions SET status = 'idle', updated_at = ?2 WHERE id = ?1",
            params![id, now_millis()],
        )?;
    }
    Ok(())
}

pub fn now_millis() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

/// A moment, written the way a model can do arithmetic on it: local time, and
/// the date as well as the clock. Without the date "yesterday" has nothing to
/// resolve against, and a turn is a fresh session that knows only what today is.
pub fn stamp(ms: i64) -> String {
    let secs = (ms / 1000) as libc::time_t;
    let mut tm: libc::tm = unsafe { std::mem::zeroed() };
    unsafe {
        libc::localtime_r(&secs, &mut tm);
    }
    format!(
        "{:04}-{:02}-{:02} {:02}:{:02}",
        tm.tm_year + 1900,
        tm.tm_mon + 1,
        tm.tm_mday,
        tm.tm_hour,
        tm.tm_min
    )
}

#[cfg(test)]
mod migration_tests {
    use super::*;

    /// A database from before worktrees keeps every session, each one back in
    /// the workspace folder it always ran in.
    #[test]
    fn sessions_from_before_worktrees_stay_in_the_workspace_folder() {
        let dir = std::env::temp_dir().join(format!("crew-v17-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).expect("dir");
        let path = dir.join("crew.sqlite3");
        let id = {
            let store = Store::open(path.clone()).expect("first open");
            let workspace = crate::workspace::create(&store, "w".into(), dir.to_string_lossy().into())
                .expect("workspace");
            let session = crate::session::create(
                &store,
                workspace.id,
                "agent".into(),
                "Planner".into(),
                "claude".into(),
                "m".into(),
                "".into(),
                "ask".into(),
            )
            .expect("session");
            // Back to a v16 database: no column, no version row.
            store
                .with(|conn| {
                    conn.execute_batch(
                        "ALTER TABLE sessions DROP COLUMN worktree;
                         DELETE FROM schema_migrations WHERE version = 17;",
                    )
                })
                .expect("downgrade");
            session.id
        };

        let store = Store::open(path).expect("reopen");

        let session = crate::session::get(&store, id).unwrap().expect("the session survived");
        assert_eq!(session.worktree, None);
        assert_eq!(crate::session::cwd(&store, &session).unwrap(), dir.to_string_lossy());
    }
}

#[cfg(test)]
mod stamp_tests {
    #[test]
    fn a_stamp_carries_the_date_and_the_clock() {
        let out = super::stamp(super::now_millis());
        assert_eq!(out.len(), 16, "{out}");
        assert_eq!(&out[4..5], "-");
        assert_eq!(&out[10..11], " ");
        assert_eq!(&out[13..14], ":");
    }
}
