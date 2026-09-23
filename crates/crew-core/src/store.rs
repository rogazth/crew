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
        migrate(&conn).map_err(|e| e.to_string())?;
        settle_open_turns(&conn).map_err(|e| e.to_string())?;
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

/// Adds a column unless it is there already. A step that died after its ALTER
/// but before its version row runs again on the next open, and a second ADD
/// COLUMN would fail every open after it.
fn add_column(conn: &Connection, table: &str, column: &str, decl: &str) -> rusqlite::Result<()> {
    if !has_column(conn, table, column)? {
        conn.execute_batch(&format!("ALTER TABLE {table} ADD COLUMN {column} {decl};"))?;
    }
    Ok(())
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
        add_column(conn, "sessions", "description", "TEXT NOT NULL DEFAULT ''")?;
        add_column(conn, "sessions", "notifications", "INTEGER NOT NULL DEFAULT 1")?;
        conn.execute(
            "INSERT INTO schema_migrations (version, applied_at) VALUES (3, ?1)",
            params![now_millis()],
        )?;
    }
    if current < 4 {
        add_column(conn, "sessions", "sort_order", "INTEGER NOT NULL DEFAULT 0")?;
        add_column(conn, "workspaces", "sort_order", "INTEGER NOT NULL DEFAULT 0")?;
        conn.execute_batch(
            "UPDATE sessions SET sort_order = created_at;
             UPDATE workspaces SET sort_order = created_at;",
        )?;
        conn.execute(
            "INSERT INTO schema_migrations (version, applied_at) VALUES (4, ?1)",
            params![now_millis()],
        )?;
    }
    if current < 5 {
        add_column(conn, "sessions", "status", "TEXT NOT NULL DEFAULT 'idle'")?;
        conn.execute(
            "INSERT INTO schema_migrations (version, applied_at) VALUES (5, ?1)",
            params![now_millis()],
        )?;
    }
    if current < 6 {
        add_column(conn, "sessions", "autonomy", "TEXT NOT NULL DEFAULT 'ask'")?;
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
        add_column(conn, "routines", "created_by", "TEXT")?;
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
        add_column(conn, "sessions", "provider_title", "TEXT")?;
        conn.execute(
            "INSERT INTO schema_migrations (version, applied_at) VALUES (14, ?1)",
            params![now_millis()],
        )?;
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

#[cfg(test)]
mod tests {
    use std::path::Path;

    use crew_protocol::{
        Block, BlockApproval, BlockQuestion, BlockRole, BlockTool, SearchQuery, ToolStatus,
    };

    use super::*;
    use crate::blocks::new_block;
    use crate::test_support::{temp_dir, temp_store};

    /// What each shipped step did to the schema, as the build that ran it left
    /// it. Shipped history does not change, so these are copies on purpose: the
    /// test of step N starts from the schema step N - 1 left behind.
    const HISTORY: [&[&str]; 13] = [
        &[MIGRATION_V1],
        &["CREATE UNIQUE INDEX workspaces_path_idx ON workspaces (path);"],
        &["ALTER TABLE sessions ADD COLUMN description TEXT NOT NULL DEFAULT '';
           ALTER TABLE sessions ADD COLUMN notifications INTEGER NOT NULL DEFAULT 1;"],
        &["ALTER TABLE sessions ADD COLUMN sort_order INTEGER NOT NULL DEFAULT 0;
           ALTER TABLE workspaces ADD COLUMN sort_order INTEGER NOT NULL DEFAULT 0;"],
        &["ALTER TABLE sessions ADD COLUMN status TEXT NOT NULL DEFAULT 'idle';"],
        &["ALTER TABLE sessions ADD COLUMN autonomy TEXT NOT NULL DEFAULT 'ask';"],
        &["CREATE TABLE routines (
             id          TEXT PRIMARY KEY,
             session_id  TEXT NOT NULL UNIQUE REFERENCES sessions(id) ON DELETE CASCADE,
             enabled     INTEGER NOT NULL DEFAULT 1,
             prompt      TEXT NOT NULL,
             schedule    TEXT NOT NULL,
             last_run_at INTEGER,
             next_run_at INTEGER,
             created_at  INTEGER NOT NULL,
             updated_at  INTEGER NOT NULL
           );"],
        &["DROP TABLE routines;
           CREATE TABLE routines (
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
           CREATE INDEX routines_session_idx ON routines (session_id);"],
        &["ALTER TABLE routines ADD COLUMN created_by TEXT;"],
        // v10 shipped with an index on `at` that step 12 took out again.
        &[crate::messages::MIGRATION_V10, "CREATE INDEX messages_at_idx ON messages (at DESC);"],
        &[crate::mailbox::MIGRATION_V11],
        &["DROP INDEX messages_at_idx;"],
        &["ALTER TABLE sessions DROP COLUMN blocks_json;"],
    ];

    /// One workspace and one agent in it, in columns every version has.
    const ROWS: &str = "
        INSERT INTO workspaces (id, name, path, created_at) VALUES ('w1', 'crew', '/src/crew', 100);
        INSERT INTO sessions (id, workspace_id, kind, name, provider, created_at, updated_at)
          VALUES ('s1', 'w1', 'agent', 'Planner', 'claude', 100, 200);";

    fn raw(path: &Path) -> Connection {
        let conn = Connection::open(path).expect("raw connection");
        // A fixture need not survive a power cut, and its fsyncs would be most
        // of what these tests cost.
        conn.pragma_update(None, "synchronous", "OFF").expect("synchronous");
        conn
    }

    /// A database as the build at `version` left it: every step up to it,
    /// applied by hand, and the rows that record them. The caller seeds its
    /// rows and drops the connection before `Store::open`.
    fn at_version(path: &Path, version: usize) -> Connection {
        let conn = raw(path);
        conn.execute_batch(
            "BEGIN;
             CREATE TABLE schema_migrations (
               version    INTEGER PRIMARY KEY,
               applied_at INTEGER NOT NULL
             );",
        )
        .expect("versions");
        for (index, step) in HISTORY[..version].iter().enumerate() {
            for sql in step.iter() {
                conn.execute_batch(sql).expect("historical step");
            }
            conn.execute(
                "INSERT INTO schema_migrations (version, applied_at) VALUES (?1, 0)",
                params![index as i64 + 1],
            )
            .expect("version row");
        }
        conn.execute_batch("COMMIT;").expect("commit");
        conn
    }

    fn db_path(dir: &tempfile::TempDir) -> PathBuf {
        dir.path().join("crew.sqlite3")
    }

    fn version(conn: &Connection) -> i64 {
        conn.query_row("SELECT COALESCE(MAX(version), 0) FROM schema_migrations", [], |row| {
            row.get(0)
        })
        .expect("version")
    }

    fn exists(conn: &Connection, kind: &str, name: &str) -> bool {
        conn.prepare("SELECT 1 FROM sqlite_master WHERE type = ?1 AND name = ?2")
            .and_then(|mut stmt| stmt.exists(params![kind, name]))
            .expect("sqlite_master")
    }

    fn column(conn: &Connection, table: &str, name: &str) -> bool {
        has_column(conn, table, name).expect("table_info")
    }

    fn strings(conn: &Connection, sql: &str) -> Vec<String> {
        conn.prepare(sql)
            .and_then(|mut stmt| stmt.query_map([], |row| row.get(0))?.collect())
            .expect(sql)
    }

    fn count(conn: &Connection, table: &str) -> i64 {
        conn.query_row(&format!("SELECT COUNT(*) FROM {table}"), [], |row| row.get(0))
            .expect(table)
    }

    fn texts(conn: &Connection, session_id: &str) -> Vec<String> {
        crate::messages::all(conn, session_id)
            .expect("rows")
            .into_iter()
            .map(|block| block.text)
            .collect()
    }

    /// Rows for a session and, while it exists, the `blocks_json` copy of it.
    fn transcript(conn: &Connection, session_id: &str, rows: &[Block], column: &[Block]) {
        crate::messages::sync(conn, session_id, rows, &mut Vec::new()).expect("rows");
        conn.execute(
            "UPDATE sessions SET blocks_json = ?2 WHERE id = ?1",
            params![session_id, serde_json::to_string(column).expect("json")],
        )
        .expect("column");
    }

    fn session(store: &Store, id: &str) -> crate::session::Session {
        crate::session::get(store, id.into()).expect("get").expect("session")
    }

    #[test]
    fn a_new_file_gets_the_whole_schema_and_a_row_for_every_step() {
        let (dir, _store) = temp_store();
        let conn = raw(&db_path(&dir));
        for table in [
            "workspaces",
            "sessions",
            "app_state",
            "routines",
            "messages",
            "messages_fts",
            "send_nonces",
            "mailbox",
        ] {
            assert!(exists(&conn, "table", table), "no {table} table");
        }
        let versions: Vec<i64> = conn
            .prepare("SELECT version FROM schema_migrations ORDER BY version")
            .and_then(|mut stmt| stmt.query_map([], |row| row.get(0))?.collect())
            .expect("versions");
        assert!(versions.len() >= 14, "{versions:?}");
        assert_eq!(versions, (1..=versions.len() as i64).collect::<Vec<_>>());
    }

    #[test]
    fn reopening_an_up_to_date_store_changes_nothing() {
        let (dir, store) = temp_store();
        let folder = dir.path().join("project");
        std::fs::create_dir(&folder).expect("folder");
        let workspace =
            crate::workspace::create(&store, "crew".into(), folder.to_string_lossy().into())
                .expect("workspace");
        let agent = crate::session::create(
            &store,
            workspace.id,
            "agent".into(),
            "Planner".into(),
            "claude".into(),
            "m".into(),
            "".into(),
            "ask".into(),
        )
        .expect("agent");
        store
            .with(|conn| {
                crate::messages::sync(
                    conn,
                    &agent.id,
                    &[new_block(BlockRole::User, "hello")],
                    &mut Vec::new(),
                )
            })
            .expect("transcript");
        set(&store, "tabs:w".into(), "{}".into()).expect("state");
        drop(store);
        let snapshot = || {
            let conn = raw(&db_path(&dir));
            let schema = strings(
                &conn,
                "SELECT type || ' ' || name || ' ' || COALESCE(sql, '') FROM sqlite_master ORDER BY name",
            );
            let versions = strings(
                &conn,
                "SELECT version || '@' || applied_at FROM schema_migrations ORDER BY version",
            );
            let sessions = strings(
                &conn,
                "SELECT id || ' ' || status || ' ' || updated_at FROM sessions ORDER BY id",
            );
            let counts: Vec<i64> = ["workspaces", "sessions", "messages", "app_state"]
                .iter()
                .map(|table| count(&conn, table))
                .collect();
            (schema, versions, sessions, counts)
        };
        let before = snapshot();

        Store::open(db_path(&dir)).expect("reopen");

        assert_eq!(snapshot(), before);
    }

    #[test]
    fn step_2_lets_a_folder_be_open_only_once() {
        let dir = temp_dir();
        at_version(&db_path(&dir), 1).execute_batch(ROWS).expect("rows");

        let store = Store::open(db_path(&dir)).expect("open");

        let conn = raw(&db_path(&dir));
        assert!(exists(&conn, "index", "workspaces_path_idx"));
        assert_eq!(crate::workspace::get(&store, "w1".into()).unwrap().unwrap().path, "/src/crew");
        let twin = conn.execute(
            "INSERT INTO workspaces (id, name, path, created_at) VALUES ('w2', 'twin', '/src/crew', 1)",
            [],
        );
        assert!(twin.is_err(), "a second row for the same folder went in");
    }

    /// Two rows for one folder cannot take the unique index: the upgrade stops
    /// there and loses neither of them.
    #[test]
    fn a_folder_open_twice_before_step_2_stops_the_upgrade_and_keeps_both() {
        let dir = temp_dir();
        at_version(&db_path(&dir), 1)
            .execute_batch(
                "INSERT INTO workspaces (id, name, path, created_at)
                   VALUES ('w1', 'a', '/src/crew', 1), ('w2', 'b', '/src/crew', 2);",
            )
            .expect("rows");

        let opened = Store::open(db_path(&dir));

        assert!(opened.is_err_and(|e| e.contains("UNIQUE constraint failed")));
        let conn = raw(&db_path(&dir));
        assert_eq!(version(&conn), 1);
        assert_eq!(count(&conn, "workspaces"), 2);
    }

    #[test]
    fn step_3_gives_old_sessions_no_description_and_notifications_on() {
        let dir = temp_dir();
        at_version(&db_path(&dir), 2).execute_batch(ROWS).expect("rows");

        let store = Store::open(db_path(&dir)).expect("open");

        let conn = raw(&db_path(&dir));
        assert!(column(&conn, "sessions", "description"));
        assert!(column(&conn, "sessions", "notifications"));
        let planner = session(&store, "s1");
        assert_eq!((planner.name.as_str(), planner.description.as_str()), ("Planner", ""));
        assert!(planner.notifications);
    }

    #[test]
    fn step_4_orders_what_existed_by_when_it_was_made() {
        let dir = temp_dir();
        at_version(&db_path(&dir), 3)
            .execute_batch(
                "INSERT INTO workspaces (id, name, path, created_at)
                   VALUES ('w-new', 'new', '/src/new', 300), ('w-old', 'old', '/src/old', 100);
                 INSERT INTO sessions (id, workspace_id, kind, name, provider, created_at, updated_at)
                   VALUES ('s-new', 'w-old', 'agent', 'new', 'claude', 300, 300),
                          ('s-old', 'w-old', 'agent', 'old', 'claude', 100, 100);",
            )
            .expect("rows");

        let store = Store::open(db_path(&dir)).expect("open");

        let conn = raw(&db_path(&dir));
        assert_eq!(
            strings(&conn, "SELECT id || '=' || sort_order FROM sessions ORDER BY id"),
            ["s-new=300", "s-old=100"]
        );
        assert_eq!(
            strings(&conn, "SELECT id || '=' || sort_order FROM workspaces ORDER BY id"),
            ["w-new=300", "w-old=100"]
        );
        let workspaces: Vec<String> =
            crate::workspace::list(&store).unwrap().into_iter().map(|w| w.id).collect();
        assert_eq!(workspaces, ["w-old", "w-new"]);
        let sessions: Vec<String> = crate::session::list(&store, "w-old".into())
            .unwrap()
            .into_iter()
            .map(|s| s.id)
            .collect();
        assert_eq!(sessions, ["s-old", "s-new"]);
    }

    #[test]
    fn step_5_leaves_old_sessions_idle() {
        let dir = temp_dir();
        at_version(&db_path(&dir), 4).execute_batch(ROWS).expect("rows");

        let store = Store::open(db_path(&dir)).expect("open");

        assert!(column(&raw(&db_path(&dir)), "sessions", "status"));
        assert_eq!(session(&store, "s1").status, "idle");
    }

    #[test]
    fn step_6_makes_old_sessions_ask_before_acting() {
        let dir = temp_dir();
        at_version(&db_path(&dir), 5).execute_batch(ROWS).expect("rows");

        let store = Store::open(db_path(&dir)).expect("open");

        assert!(column(&raw(&db_path(&dir)), "sessions", "autonomy"));
        assert_eq!(session(&store, "s1").autonomy, "ask");
    }

    #[test]
    fn step_7_adds_routines_that_go_with_their_agent() {
        let dir = temp_dir();
        at_version(&db_path(&dir), 6).execute_batch(ROWS).expect("rows");

        let store = Store::open(db_path(&dir)).expect("open");

        let conn = raw(&db_path(&dir));
        for name in ["id", "session_id", "enabled", "prompt", "schedule", "last_run_at", "next_run_at"] {
            assert!(column(&conn, "routines", name), "routines has no {name}");
        }
        conn.execute(
            "INSERT INTO routines (id, session_id, prompt, schedule, created_at, updated_at)
             VALUES ('r1', 's1', 'check', '0 9 * * *', 1, 1)",
            [],
        )
        .expect("routine");
        crate::session::delete(&store, "s1".into()).expect("delete");
        assert_eq!(count(&conn, "routines"), 0, "a routine outlived its agent");
    }

    #[test]
    fn step_8_keeps_each_routine_and_lets_an_agent_have_several() {
        let dir = temp_dir();
        let conn = at_version(&db_path(&dir), 7);
        conn.execute_batch(ROWS).expect("rows");
        conn.execute(
            "INSERT INTO routines
               (id, session_id, enabled, prompt, schedule, last_run_at, next_run_at, created_at, updated_at)
             VALUES ('r1', 's1', 0, 'check the build', '0 9 * * *', 10, 20, 1, 2)",
            [],
        )
        .expect("routine");
        drop(conn);

        Store::open(db_path(&dir)).expect("open");

        let conn = raw(&db_path(&dir));
        assert!(exists(&conn, "index", "routines_session_idx"));
        let kept: (String, i64, String, String, i64, i64, String, i64, i64) = conn
            .query_row(
                "SELECT name, enabled, prompt, schedule, last_run_at, next_run_at, runs_json,
                        created_at, updated_at
                 FROM routines WHERE id = 'r1'",
                [],
                |r| {
                    Ok((
                        r.get(0)?,
                        r.get(1)?,
                        r.get(2)?,
                        r.get(3)?,
                        r.get(4)?,
                        r.get(5)?,
                        r.get(6)?,
                        r.get(7)?,
                        r.get(8)?,
                    ))
                },
            )
            .expect("routine");
        assert_eq!(
            kept,
            (
                "Routine".into(),
                0,
                "check the build".into(),
                "0 9 * * *".into(),
                10,
                20,
                "[]".into(),
                1,
                2
            )
        );
        conn.execute(
            "INSERT INTO routines (id, session_id, prompt, schedule, created_at, updated_at)
             VALUES ('r2', 's1', 'and again', '0 18 * * *', 3, 3)",
            [],
        )
        .expect("a second routine for the same agent");
    }

    #[test]
    fn step_9_leaves_old_routines_without_an_author() {
        let dir = temp_dir();
        let conn = at_version(&db_path(&dir), 8);
        conn.execute_batch(ROWS).expect("rows");
        conn.execute(
            "INSERT INTO routines (id, session_id, name, prompt, schedule, created_at, updated_at)
             VALUES ('r1', 's1', 'Nightly', 'check', '0 9 * * *', 1, 1)",
            [],
        )
        .expect("routine");
        drop(conn);

        Store::open(db_path(&dir)).expect("open");

        let conn = raw(&db_path(&dir));
        let author: Option<String> = conn
            .query_row("SELECT created_by FROM routines WHERE id = 'r1'", [], |r| r.get(0))
            .expect("routine");
        assert_eq!(author, None);
    }

    #[test]
    fn step_10_makes_the_history_that_existed_searchable() {
        let dir = temp_dir();
        let conn = at_version(&db_path(&dir), 9);
        conn.execute_batch(ROWS).expect("rows");
        let history = [
            new_block(BlockRole::User, "deploy the marketplace branch"),
            new_block(BlockRole::Assistant, "on it"),
        ];
        conn.execute(
            "UPDATE sessions SET blocks_json = ?1 WHERE id = 's1'",
            params![serde_json::to_string(&history).expect("json")],
        )
        .expect("history");
        conn.execute_batch(
            "INSERT INTO sessions (id, workspace_id, kind, name, provider, blocks_json, created_at, updated_at)
               VALUES ('s-empty', 'w1', 'agent', 'Empty', 'claude', '[]', 1, 1),
                      ('s-garbled', 'w1', 'agent', 'Garbled', 'claude', 'not json', 1, 1);",
        )
        .expect("quiet sessions");
        drop(conn);

        let store = Store::open(db_path(&dir)).expect("open");

        let conn = raw(&db_path(&dir));
        for table in ["messages", "messages_fts", "send_nonces"] {
            assert!(exists(&conn, "table", table), "no {table} table");
        }
        for trigger in ["messages_ai", "messages_ad", "messages_au"] {
            assert!(exists(&conn, "trigger", trigger), "no {trigger} trigger");
        }
        assert_eq!(texts(&conn, "s1"), ["deploy the marketplace branch", "on it"]);
        assert_eq!(count(&conn, "messages"), 2, "a session with no history got rows");
        let hits = crate::messages::search(
            &store,
            SearchQuery { query: "marketplace".into(), ..Default::default() },
        )
        .expect("search");
        assert_eq!(hits.iter().map(|h| (h.session_id.as_str(), h.pos)).collect::<Vec<_>>(), [("s1", 1)]);
    }

    #[test]
    fn step_11_adds_a_mailbox() {
        let dir = temp_dir();
        at_version(&db_path(&dir), 10).execute_batch(ROWS).expect("rows");

        let store = Store::open(db_path(&dir)).expect("open");

        let conn = raw(&db_path(&dir));
        assert!(exists(&conn, "table", "mailbox"));
        let index = strings(&conn, "SELECT sql FROM sqlite_master WHERE name = 'mailbox_waiting_idx'");
        assert!(index[0].contains("WHERE delivered_at IS NULL"), "{index:?}");
        let me = crew_protocol::AgentRef { id: "s1".into(), name: "Planner".into() };
        crate::mailbox::enqueue(&store, "s1", &me, "a note").expect("enqueue");
        let letter = crate::mailbox::claim(&store, "s1").expect("claim").expect("letter");
        assert_eq!(letter.text, "a note");
    }

    #[test]
    fn step_12_drops_the_index_no_query_used_and_keeps_the_rows() {
        let dir = temp_dir();
        let conn = at_version(&db_path(&dir), 11);
        conn.execute_batch(ROWS).expect("rows");
        let blocks = [new_block(BlockRole::User, "kept")];
        transcript(&conn, "s1", &blocks, &blocks);
        assert!(exists(&conn, "index", "messages_at_idx"), "sanity: v10 built it");
        drop(conn);

        Store::open(db_path(&dir)).expect("open");

        let conn = raw(&db_path(&dir));
        assert!(!exists(&conn, "index", "messages_at_idx"));
        assert_eq!(texts(&conn, "s1"), ["kept"]);
    }

    /// The column held the whole transcript and the rows could lag it: step 13
    /// brings the rows level before the column goes, in both directions.
    #[test]
    fn step_13_levels_the_rows_with_the_column_before_dropping_it() {
        let dir = temp_dir();
        let conn = at_version(&db_path(&dir), 12);
        conn.execute_batch(ROWS).expect("rows");
        conn.execute_batch(
            "INSERT INTO sessions (id, workspace_id, kind, name, provider, created_at, updated_at)
               VALUES ('s2', 'w1', 'agent', 'Coder', 'claude', 1, 1);",
        )
        .expect("second session");
        let mut behind = vec![
            new_block(BlockRole::User, "summarise the plan"),
            new_block(BlockRole::Assistant, "The plan is"),
        ];
        let rows = behind.clone();
        behind[1].text = "The plan is to ship A, then B.".into();
        transcript(&conn, "s1", &rows, &behind);
        let ahead = [new_block(BlockRole::User, "one"), new_block(BlockRole::Assistant, "two")];
        transcript(&conn, "s2", &ahead, &ahead[..1]);
        drop(conn);

        Store::open(db_path(&dir)).expect("open");

        let conn = raw(&db_path(&dir));
        assert!(!column(&conn, "sessions", "blocks_json"));
        assert_eq!(texts(&conn, "s1"), ["summarise the plan", "The plan is to ship A, then B."]);
        assert_eq!(texts(&conn, "s2"), ["one"]);
    }

    /// Step 13 drops the only other copy of every transcript, so it is all or
    /// nothing: a failure after the DROP puts the column back, and the next
    /// open runs the step again.
    #[test]
    fn step_13_is_all_or_nothing() {
        let dir = temp_dir();
        let conn = at_version(&db_path(&dir), 12);
        conn.execute_batch(ROWS).expect("rows");
        let rows = [new_block(BlockRole::Assistant, "The plan is")];
        let mut column_copy = rows.to_vec();
        column_copy[0].text = "The plan is to ship A.".into();
        transcript(&conn, "s1", &rows, &column_copy);
        conn.execute_batch(
            "CREATE TRIGGER no_13 BEFORE INSERT ON schema_migrations WHEN new.version = 13
             BEGIN SELECT RAISE(FAIL, 'the disk gave out'); END;",
        )
        .expect("trap");
        drop(conn);

        let failed = Store::open(db_path(&dir));

        assert!(failed.is_err_and(|e| e.contains("the disk gave out")));
        let conn = raw(&db_path(&dir));
        assert_eq!(version(&conn), 12);
        assert!(column(&conn, "sessions", "blocks_json"), "the column is gone and step 13 is not recorded");
        assert_eq!(texts(&conn, "s1"), ["The plan is"], "half of the step outlived its rollback");
        conn.execute_batch("DROP TRIGGER no_13;").expect("untrap");
        drop(conn);

        Store::open(db_path(&dir)).expect("the retry");

        let conn = raw(&db_path(&dir));
        assert!(version(&conn) >= 13);
        assert!(!column(&conn, "sessions", "blocks_json"));
        assert_eq!(texts(&conn, "s1"), ["The plan is to ship A."]);
    }

    /// A build from before step 13 ran in a transaction could die between the
    /// DROP and the version row, leaving no column to level the rows from.
    #[test]
    fn step_13_passes_over_a_column_that_is_already_gone() {
        let dir = temp_dir();
        let conn = at_version(&db_path(&dir), 12);
        conn.execute_batch(ROWS).expect("rows");
        crate::messages::sync(&conn, "s1", &[new_block(BlockRole::User, "kept")], &mut Vec::new())
            .expect("rows");
        conn.execute_batch("ALTER TABLE sessions DROP COLUMN blocks_json;").expect("half of step 13");
        drop(conn);

        Store::open(db_path(&dir)).expect("open");

        let conn = raw(&db_path(&dir));
        assert!(version(&conn) >= 13);
        assert_eq!(texts(&conn, "s1"), ["kept"]);
    }

    /// The steps that add a column: dying after the ALTER and before the
    /// version row must not lock the database, because the next open runs the
    /// step again over the column it already added.
    #[test]
    fn a_step_that_died_after_adding_its_column_runs_again() {
        for step in [3, 4, 5, 6, 9, 14] {
            let dir = temp_dir();
            let conn = at_version(&db_path(&dir), step - 1);
            conn.execute_batch(&format!(
                "CREATE TRIGGER trap BEFORE INSERT ON schema_migrations WHEN new.version = {step}
                 BEGIN SELECT RAISE(FAIL, 'died before the version row'); END;"
            ))
            .expect("trap");
            drop(conn);

            let died = Store::open(db_path(&dir));
            assert!(died.is_err(), "step {step} did not reach its version row");
            let conn = raw(&db_path(&dir));
            assert_eq!(version(&conn), step as i64 - 1, "step {step}");
            conn.execute_batch("DROP TRIGGER trap;").expect("untrap");
            drop(conn);

            Store::open(db_path(&dir)).unwrap_or_else(|e| panic!("step {step} locked the database: {e}"));
            assert!(version(&raw(&db_path(&dir))) >= step as i64, "step {step} was not recorded");
        }
    }

    #[test]
    fn step_14_starts_old_sessions_with_no_provider_title() {
        let dir = temp_dir();
        at_version(&db_path(&dir), 13).execute_batch(ROWS).expect("rows");

        let store = Store::open(db_path(&dir)).expect("open");

        let conn = raw(&db_path(&dir));
        let title: Option<String> = conn
            .query_row("SELECT provider_title FROM sessions WHERE id = 's1'", [], |r| r.get(0))
            .expect("session");
        assert_eq!(title, None);
        assert_eq!(session(&store, "s1").name, "Planner");
    }

    /// Whichever step fails, the upgrade stops at it, says why, and records
    /// only the steps before it.
    #[test]
    fn a_step_that_fails_stops_the_upgrade_there() {
        for step in 1..=14 {
            let dir = temp_dir();
            raw(&db_path(&dir))
                .execute_batch(&format!(
                    "CREATE TABLE schema_migrations (
                       version    INTEGER PRIMARY KEY,
                       applied_at INTEGER NOT NULL
                     );
                     CREATE TRIGGER fail_step BEFORE INSERT ON schema_migrations
                       WHEN new.version = {step}
                     BEGIN SELECT RAISE(FAIL, 'step {step} failed'); END;"
                ))
                .expect("trap");

            let opened = Store::open(db_path(&dir));

            let said = opened.err().unwrap_or_default();
            assert!(said.contains(&format!("step {step} failed")), "step {step}: {said:?}");
            assert_eq!(version(&raw(&db_path(&dir))), step - 1, "step {step}");
        }
    }

    /// Another tool's database that uses the name Crew versions itself with is
    /// not Crew's to upgrade: it is refused before anything is written into it.
    #[test]
    fn a_database_another_tool_uses_is_refused_untouched() {
        for foreign in [
            "CREATE TABLE schema_migrations (version TEXT PRIMARY KEY);
             INSERT INTO schema_migrations VALUES ('20240101000000');",
            "CREATE TABLE notes (body TEXT);
             CREATE INDEX schema_migrations ON notes (body);",
        ] {
            let dir = temp_dir();
            raw(&db_path(&dir)).execute_batch(foreign).expect("foreign file");
            let schema = strings(&raw(&db_path(&dir)), "SELECT name FROM sqlite_master ORDER BY name");

            assert!(Store::open(db_path(&dir)).is_err(), "{foreign}");

            let after = strings(&raw(&db_path(&dir)), "SELECT name FROM sqlite_master ORDER BY name");
            assert_eq!(after, schema, "{foreign}");
        }
    }

    #[test]
    fn a_path_that_cannot_hold_a_database_is_refused() {
        let dir = temp_dir();
        let words = dir.path().join("notes.txt");
        std::fs::write(&words, "not a database").expect("text file");

        for path in [PathBuf::from("/"), dir.path().to_path_buf(), words.clone()] {
            assert!(Store::open(path.clone()).is_err(), "{path:?} opened as a store");
        }
        assert_eq!(std::fs::read_to_string(&words).expect("text"), "not a database");
    }

    /// A daemon that died mid-turn left tools spinning and a question nobody
    /// can answer any more. The next open settles them and lets the session rest.
    #[test]
    fn a_turn_left_open_by_a_crash_is_settled_on_the_next_open() {
        let (dir, store) = temp_store();
        let folder = dir.path().join("project");
        std::fs::create_dir(&folder).expect("folder");
        let workspace =
            crate::workspace::create(&store, "crew".into(), folder.to_string_lossy().into())
                .expect("workspace");
        let agent = |name: &str| {
            crate::session::create(
                &store,
                workspace.id.clone(),
                "agent".into(),
                name.into(),
                "claude".into(),
                "m".into(),
                "".into(),
                "ask".into(),
            )
            .expect("agent")
            .id
        };
        let (working, asking, resting) = (agent("working"), agent("asking"), agent("resting"));
        let mut tool = new_block(BlockRole::Tool, "ls");
        tool.tool = Some(BlockTool {
            call_id: "c1".into(),
            name: "Bash".into(),
            title: "ls".into(),
            status: ToolStatus::Pending,
            detail: None,
        });
        let mut streaming = new_block(BlockRole::Assistant, "half an answer");
        streaming.streaming = Some(true);
        let mut approval = new_block(BlockRole::Approval, "run it?");
        approval.approval = Some(BlockApproval {
            request_id: 1,
            name: "Bash".into(),
            input: None,
            decided: None,
        });
        let mut question = new_block(BlockRole::Question, "which one?");
        question.question = Some(BlockQuestion {
            request_id: 2,
            questions: Vec::new(),
            answers: None,
            dismissed: None,
        });
        let open_turn = [tool.clone(), streaming, approval, question];
        store
            .with(|conn| {
                crate::messages::sync(conn, &working, &open_turn, &mut Vec::new())?;
                crate::messages::sync(conn, &asking, &open_turn, &mut Vec::new())?;
                crate::messages::sync(conn, &resting, &[tool.clone()], &mut Vec::new())
            })
            .expect("transcripts");
        crate::session::set_status(&store, working.clone(), "working".into()).expect("working");
        crate::session::set_status(&store, asking.clone(), "needs-input".into()).expect("asking");
        store
            .with(|conn| conn.execute("UPDATE sessions SET updated_at = 7 WHERE id = ?1", params![resting]))
            .expect("resting");
        drop(store);

        let store = Store::open(db_path(&dir)).expect("reopen");

        for id in [&working, &asking] {
            assert_eq!(session(&store, id).status, "idle");
            let blocks = store.with(|conn| crate::messages::all(conn, id)).expect("blocks");
            assert!(blocks.iter().all(|b| !crate::blocks::is_open(b)), "{blocks:?}");
            assert_eq!(blocks[0].tool.as_ref().unwrap().status, ToolStatus::Interrupted);
            assert_eq!(blocks[1].streaming, Some(false));
        }
        let untouched = session(&store, &resting);
        assert_eq!((untouched.status.as_str(), untouched.updated_at), ("idle", 7));
        let spinning = store.with(|conn| crate::messages::all(conn, &resting)).expect("blocks");
        assert_eq!(spinning[0].tool.as_ref().unwrap().status, ToolStatus::Pending);
    }

    /// A settle that cannot land fails the open and leaves the session marked
    /// busy, so the next open settles it rather than nobody ever doing it.
    #[test]
    fn a_settle_that_cannot_land_is_tried_again_on_the_next_open() {
        let (dir, store) = temp_store();
        store.with(|conn| conn.execute_batch(ROWS)).expect("rows");
        let mut tool = new_block(BlockRole::Tool, "ls");
        tool.tool = Some(BlockTool {
            call_id: "c1".into(),
            name: "Bash".into(),
            title: "ls".into(),
            status: ToolStatus::Pending,
            detail: None,
        });
        store
            .with(|conn| crate::messages::sync(conn, "s1", &[tool], &mut Vec::new()))
            .expect("transcript");
        crate::session::set_status(&store, "s1".into(), "working".into()).expect("working");
        store
            .with(|conn| {
                conn.execute_batch(
                    "CREATE TRIGGER no_rest BEFORE UPDATE OF status ON sessions
                     BEGIN SELECT RAISE(FAIL, 'no rest'); END;",
                )
            })
            .expect("trap");
        drop(store);

        let failed = Store::open(db_path(&dir));

        assert!(failed.is_err_and(|e| e.contains("no rest")));
        let conn = raw(&db_path(&dir));
        let status: String = conn
            .query_row("SELECT status FROM sessions WHERE id = 's1'", [], |r| r.get(0))
            .expect("status");
        assert_eq!(status, "working");
        conn.execute_batch("DROP TRIGGER no_rest;").expect("untrap");
        drop(conn);

        let store = Store::open(db_path(&dir)).expect("the retry");
        assert_eq!(session(&store, "s1").status, "idle");
        let blocks = store.with(|conn| crate::messages::all(conn, "s1")).expect("blocks");
        assert_eq!(blocks[0].tool.as_ref().unwrap().status, ToolStatus::Interrupted);
    }

    #[test]
    fn a_state_key_is_written_overwritten_cleared_and_kept_across_a_restart() {
        let (dir, store) = temp_store();
        assert_eq!(get(&store, "tabs:w1".into()).expect("get"), None);

        set(&store, "tabs:w1".into(), "one".into()).expect("set");
        set(&store, "tabs:w1".into(), "two".into()).expect("overwrite");
        set(&store, "tabs:w2".into(), "other".into()).expect("set");
        assert_eq!(get(&store, "tabs:w1".into()).expect("get").as_deref(), Some("two"));

        store.with(|conn| write_state(conn, "tabs:w1", None)).expect("clear");
        store.with(|conn| write_state(conn, "tabs:w1", None)).expect("clearing twice");
        assert_eq!(get(&store, "tabs:w1".into()).expect("get"), None);
        drop(store);

        let store = Store::open(db_path(&dir)).expect("reopen");
        assert_eq!(get(&store, "tabs:w2".into()).expect("get").as_deref(), Some("other"));
        assert_eq!(get(&store, "tabs:w1".into()).expect("get"), None);
    }

    /// Chrome state that cannot be kept says so, rather than coming back empty
    /// after the restart it was meant to survive.
    #[test]
    fn state_that_cannot_be_kept_is_an_error() {
        let (_dir, store) = temp_store();
        store.with(|conn| conn.execute_batch("DROP TABLE app_state;")).expect("break the schema");

        assert!(set(&store, "tabs:w1".into(), "{}".into()).is_err());
        assert!(get(&store, "tabs:w1".into()).is_err());
        assert!(store.with(|conn| write_state(conn, "tabs:w1", None)).is_err());
    }

    fn three_workspaces(store: &Store) {
        store
            .with(|conn| {
                conn.execute_batch(
                    "INSERT INTO workspaces (id, name, path, created_at, sort_order)
                       VALUES ('a', 'a', '/a', 10, 10), ('b', 'b', '/b', 20, 20), ('c', 'c', '/c', 30, 30);",
                )
            })
            .expect("workspaces");
    }

    fn places(store: &Store) -> Vec<String> {
        store
            .with(|conn| Ok(strings(conn, "SELECT id || '=' || sort_order FROM workspaces ORDER BY id")))
            .expect("places")
    }

    #[test]
    fn set_order_gives_each_id_its_place_and_passes_over_unknown_ones() {
        let (_dir, store) = temp_store();
        three_workspaces(&store);

        store
            .with(|conn| set_order(conn, "workspaces", &["c".into(), "ghost".into(), "a".into()]))
            .expect("order");

        assert_eq!(places(&store), ["a=2", "b=20", "c=0"]);
        assert_eq!(store.with(|conn| Ok(count(conn, "workspaces"))).unwrap(), 3);
    }

    /// One transaction: a reorder that fails half way leaves every row where
    /// it was.
    #[test]
    fn a_reorder_that_fails_half_way_moves_nothing() {
        let (_dir, store) = temp_store();
        three_workspaces(&store);
        store
            .with(|conn| {
                conn.execute_batch(
                    "CREATE TRIGGER stuck BEFORE UPDATE OF sort_order ON workspaces WHEN new.id = 'b'
                     BEGIN SELECT RAISE(FAIL, 'stuck'); END;",
                )
            })
            .expect("trap");

        let moved = store.with(|conn| set_order(conn, "workspaces", &["c".into(), "b".into(), "a".into()]));

        assert!(moved.is_err_and(|e| e.contains("stuck")));
        assert_eq!(places(&store), ["a=10", "b=20", "c=30"]);
        store
            .with(|conn| set_order(conn, "workspaces", &["c".into()]))
            .expect("the connection is usable after the rollback");
    }
}
