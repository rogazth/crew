use std::path::PathBuf;
use std::sync::Mutex;

use rusqlite::{params, Connection, OptionalExtension};
use tauri::State;

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

pub struct Store {
    conn: Mutex<Connection>,
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
        // Nothing is running yet, so a spinner left over from the last launch would never stop.
        conn.execute("UPDATE sessions SET status = 'idle' WHERE status = 'working'", [])
            .map_err(|e| e.to_string())?;
        Ok(Self {
            conn: Mutex::new(conn),
        })
    }

    pub fn with<T>(&self, f: impl FnOnce(&Connection) -> rusqlite::Result<T>) -> Result<T, String> {
        let conn = self.conn.lock().map_err(|e| e.to_string())?;
        f(&conn).map_err(|e| e.to_string())
    }
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
    Ok(())
}

/// Small durable key/value for chrome that has to survive a restart: the active
/// workspace, the open tabs of each one.
#[tauri::command(async)]
pub fn state_get(store: State<Store>, key: String) -> Result<Option<String>, String> {
    store.with(|conn| read_state(conn, &key))
}

#[tauri::command(async)]
pub fn state_set(store: State<Store>, key: String, value: String) -> Result<(), String> {
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

pub fn now_millis() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}
