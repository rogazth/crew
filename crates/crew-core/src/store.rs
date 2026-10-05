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
        // Letters a turn was carrying when the daemon stopped: that turn is
        // gone, so they are handed over again (`TurnHost::deliver_waiting`).
        crate::mailbox::release_unfinished(&conn).map_err(|e| e.to_string())?;
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

pub(crate) fn has_column(conn: &Connection, table: &str, column: &str) -> rusqlite::Result<bool> {
    conn.prepare("SELECT 1 FROM pragma_table_info(?1) WHERE name = ?2")?
        .exists(params![table, column])
}

const MIGRATION_REMOTES: &str = "CREATE TABLE IF NOT EXISTS remotes (
   id         TEXT PRIMARY KEY,
   name       TEXT NOT NULL,
   host       TEXT NOT NULL,
   port       INTEGER NOT NULL,
   user       TEXT NOT NULL,
   created_at INTEGER NOT NULL
 );
 CREATE UNIQUE INDEX IF NOT EXISTS remotes_endpoint ON remotes (host, port);";

/// How `ssh` reaches a machine: a Host from ~/.ssh/config, or an address.
/// Empty for a machine added before, which is reached at `host`.
fn migrate_remotes_ssh(conn: &Connection) -> rusqlite::Result<()> {
    if !has_column(conn, "remotes", "ssh")? {
        conn.execute_batch("ALTER TABLE remotes ADD COLUMN ssh TEXT NOT NULL DEFAULT '';")?;
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
        // Several routines per bot, each with a name and a run history. SQLite
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
    if current < 18 {
        // Machines the window connects to. Tokens stay in the keychain, not here.
        let tx = conn.unchecked_transaction()?;
        tx.execute_batch(MIGRATION_REMOTES)?;
        tx.execute(
            "INSERT INTO schema_migrations (version, applied_at) VALUES (18, ?1)",
            params![now_millis()],
        )?;
        tx.commit()?;
    }
    if current < 19 {
        let tx = conn.unchecked_transaction()?;
        migrate_remotes_ssh(&tx)?;
        tx.execute(
            "INSERT INTO schema_migrations (version, applied_at) VALUES (19, ?1)",
            params![now_millis()],
        )?;
        tx.commit()?;
    }
    if current < 20 {
        // A dev database from before the processes branch met master numbered
        // its own migrations 18 to 20 and never got `remotes`; both are
        // idempotent, so running them again is harmless.
        let tx = conn.unchecked_transaction()?;
        tx.execute_batch(MIGRATION_REMOTES)?;
        migrate_remotes_ssh(&tx)?;
        if !has_column(&tx, "mailbox", "from_kind")? {
            tx.execute_batch(crate::mailbox::MIGRATION_FROM_KIND)?;
        }
        tx.execute(
            "INSERT INTO schema_migrations (version, applied_at) VALUES (20, ?1)",
            params![now_millis()],
        )?;
        tx.commit()?;
    }
    if current < 21 {
        let tx = conn.unchecked_transaction()?;
        tx.execute_batch(crate::process::MIGRATION_PROCESSES)?;
        tx.execute(
            "INSERT INTO schema_migrations (version, applied_at) VALUES (21, ?1)",
            params![now_millis()],
        )?;
        tx.commit()?;
    }
    if current < 22 {
        let tx = conn.unchecked_transaction()?;
        crate::process::migrate_unique_names(&tx)?;
        tx.execute(
            "INSERT INTO schema_migrations (version, applied_at) VALUES (22, ?1)",
            params![now_millis()],
        )?;
        tx.commit()?;
    }
    if current < 23 {
        let tx = conn.unchecked_transaction()?;
        split_agents_from_sessions(&tx)?;
        tx.execute(
            "INSERT INTO schema_migrations (version, applied_at) VALUES (23, ?1)",
            params![now_millis()],
        )?;
        tx.commit()?;
    }
    if current < 24 {
        let tx = conn.unchecked_transaction()?;
        // How hard its model thinks, beside the model; '' is the CLI's own setting.
        if !has_column(&tx, "sessions", "effort")? {
            tx.execute_batch("ALTER TABLE sessions ADD COLUMN effort TEXT NOT NULL DEFAULT '';")?;
        }
        tx.execute(
            "INSERT INTO schema_migrations (version, applied_at) VALUES (24, ?1)",
            params![now_millis()],
        )?;
        tx.commit()?;
    }
    if current < 25 {
        let tx = conn.unchecked_transaction()?;
        rename_agents_to_bots(&tx)?;
        tx.execute(
            "INSERT INTO schema_migrations (version, applied_at) VALUES (25, ?1)",
            params![now_millis()],
        )?;
        tx.commit()?;
    }
    if current < 26 {
        let tx = conn.unchecked_transaction()?;
        // Letter kinds and their lifecycle (see `mailbox`).
        crate::mailbox::migrate_lifecycle(&tx)?;
        // Who handed a session over to whom, and how far the user has read
        // it: kept for the phases that use them.
        if !has_column(&tx, "sessions", "handed_off_by")? {
            tx.execute_batch(
                "ALTER TABLE sessions ADD COLUMN handed_off_by TEXT REFERENCES sessions(id) ON DELETE SET NULL;",
            )?;
        }
        if !has_column(&tx, "sessions", "user_seen")? {
            tx.execute_batch("ALTER TABLE sessions ADD COLUMN user_seen INTEGER NOT NULL DEFAULT 0;")?;
        }
        tx.execute(
            "INSERT INTO schema_migrations (version, applied_at) VALUES (26, ?1)",
            params![now_millis()],
        )?;
        tx.commit()?;
    }
    Ok(())
}

pub(crate) fn has_table(conn: &Connection, table: &str) -> rusqlite::Result<bool> {
    conn.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?1")?
        .exists(params![table])
}

/// What Crew called an agent — a persistent identity: a name, a description,
/// a mailbox, a history, routines — is a bot. An agent is a model in a harness,
/// which in Crew is a session. Everything stored under the old word moves:
/// the table and its index, the session's column and kind, the sender on a
/// message, and the window's keys in `app_state`.
///
/// Renaming the table rewrites the foreign keys that point at it (SQLite does
/// since 3.26, unless `legacy_alter_table` is on). Each step checks before it
/// acts, so a database wound back to an earlier version gets here again intact.
pub(crate) fn rename_agents_to_bots(conn: &Connection) -> rusqlite::Result<()> {
    if has_table(conn, "agents")? && !has_table(conn, "bots")? {
        conn.execute_batch("ALTER TABLE agents RENAME TO bots;")?;
    }
    conn.execute_batch(
        "DROP INDEX IF EXISTS agents_workspace_idx;
         CREATE INDEX IF NOT EXISTS bots_workspace_idx ON bots (workspace_id);",
    )?;
    if has_column(conn, "sessions", "agent_id")? && !has_column(conn, "sessions", "bot_id")? {
        conn.execute_batch("ALTER TABLE sessions RENAME COLUMN agent_id TO bot_id;")?;
    }
    conn.execute_batch(
        "UPDATE sessions SET kind = 'bot' WHERE kind = 'agent';
         UPDATE messages
            SET extra_json = json_remove(json_set(extra_json, '$.from_bot', json_extract(extra_json, '$.from_agent')), '$.from_agent')
          WHERE json_valid(extra_json) AND json_type(extra_json, '$.from_agent') IS NOT NULL;
         INSERT OR IGNORE INTO app_state (key, value) SELECT 'bot:faces', value FROM app_state WHERE key = 'agent:faces';
         DELETE FROM app_state WHERE key = 'agent:faces';
         INSERT OR IGNORE INTO app_state (key, value) SELECT 'bot:avatar', value FROM app_state WHERE key = 'agent:avatar';
         DELETE FROM app_state WHERE key = 'agent:avatar';",
    )?;
    // The sidebar's kind filter names kinds by their stored spelling.
    if let Some(raw) = read_state(conn, "sidebar:prefs")? {
        if let Ok(mut prefs) = serde_json::from_str::<serde_json::Value>(&raw) {
            let mut changed = false;
            if let Some(kinds) = prefs.get_mut("hiddenKinds").and_then(|kinds| kinds.as_array_mut()) {
                for kind in kinds.iter_mut().filter(|kind| kind.as_str() == Some("agent")) {
                    *kind = serde_json::Value::String("bot".into());
                    changed = true;
                }
            }
            if changed {
                write_state(conn, "sidebar:prefs", Some(&prefs.to_string()))?;
            }
        }
    }
    Ok(())
}

/// Two words that shared one table. An agent is an identity Crew keeps — a
/// name, a description, an autonomy, its mailbox and its history; a session is
/// one provider CLI, and can be thrown away. `agents` takes the identity;
/// `sessions` keeps the CLIs, now with who started each one and how far its
/// transcript had got at its last event.
///
/// An agent keeps the session its turns already ran in, under the agent's own
/// id, so its transcript, its mailbox and its routines keep their keys and no
/// row that points at them moves. Each step checks before it acts: a database
/// wound back to an earlier version keeps whatever this left.
///
/// The names are the ones of its time: v25 renames them to bots. A database
/// wound back from there already keeps its identities in `bots`, so this
/// leaves them where they are and does only the rest.
pub(crate) fn split_agents_from_sessions(conn: &Connection) -> rusqlite::Result<()> {
    let renamed = has_table(conn, "bots")?;
    if !renamed {
        conn.execute_batch(
            "CREATE TABLE IF NOT EXISTS agents (
               id            TEXT PRIMARY KEY,
               workspace_id  TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
               name          TEXT NOT NULL,
               description   TEXT NOT NULL DEFAULT '',
               notifications INTEGER NOT NULL DEFAULT 1,
               autonomy      TEXT NOT NULL DEFAULT 'ask',
               created_at    INTEGER NOT NULL,
               updated_at    INTEGER NOT NULL
             );
             CREATE INDEX IF NOT EXISTS agents_workspace_idx ON agents (workspace_id);
             INSERT OR IGNORE INTO agents
               (id, workspace_id, name, description, notifications, autonomy, created_at, updated_at)
             SELECT id, workspace_id, name, description, notifications, autonomy, created_at, updated_at
             FROM sessions WHERE kind = 'agent';",
        )?;
        // NULL defaults, so SQLite takes a column with a foreign key on it.
        if !has_column(conn, "sessions", "agent_id")? {
            conn.execute_batch("ALTER TABLE sessions ADD COLUMN agent_id TEXT REFERENCES agents(id) ON DELETE CASCADE;")?;
        }
        conn.execute_batch("UPDATE sessions SET agent_id = id WHERE kind = 'agent' AND agent_id IS NULL;")?;
    }
    if !has_column(conn, "sessions", "parent_id")? {
        conn.execute_batch("ALTER TABLE sessions ADD COLUMN parent_id TEXT REFERENCES sessions(id) ON DELETE SET NULL;")?;
    }
    if !has_column(conn, "sessions", "cursor")? {
        conn.execute_batch("ALTER TABLE sessions ADD COLUMN cursor INTEGER NOT NULL DEFAULT 0;")?;
    }
    if !has_column(conn, "sessions", "seen")? {
        conn.execute_batch("ALTER TABLE sessions ADD COLUMN seen INTEGER NOT NULL DEFAULT 0;")?;
    }
    conn.execute_batch(
        "CREATE INDEX IF NOT EXISTS sessions_parent_idx ON sessions (parent_id) WHERE parent_id IS NOT NULL;",
    )?;
    conn.execute_batch(crate::session_events::MIGRATION)
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
///
/// A bot's turn is over: it goes back to idle. A child's is not given up:
/// it goes back to `starting`, and the daemon resumes it once it is up
/// (`TurnHost::resume_interrupted`), so whoever waits on it still gets a report.
fn settle_open_turns(conn: &Connection) -> rusqlite::Result<()> {
    let mut stmt = conn.prepare(
        "SELECT id, kind FROM sessions
         WHERE status IN ('working', 'needs-input') OR (kind = 'child' AND status = 'starting')",
    )?;
    let rows = stmt
        .query_map([], |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?)))?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    drop(stmt);
    for (id, kind) in rows {
        let settled = crate::blocks::settle_turn(
            crate::messages::all(conn, &id)?,
            crew_protocol::ToolStatus::Interrupted,
        );
        let mut prior = crate::messages::fingerprints(conn, &id)?;
        crate::messages::sync(conn, &id, &settled, &mut prior)?;
        let status = if kind == "child" { "starting" } else { "idle" };
        conn.execute(
            "UPDATE sessions SET status = ?3, updated_at = ?2 WHERE id = ?1",
            params![id, now_millis(), status],
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
                "bot".into(),
                "Planner".into(),
                "claude".into(),
                "m".into(),
                "".into(),
                "ask".into(),
            )
            .expect("session");
            // Back to a v16 database: no column, no version row for it or anything after.
            store
                .with(|conn| {
                    conn.execute_batch(
                        "ALTER TABLE sessions DROP COLUMN worktree;
                         DELETE FROM schema_migrations WHERE version >= 17;",
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
mod split_tests {
    use super::*;

    fn fresh() -> (std::path::PathBuf, std::path::PathBuf) {
        let dir = std::env::temp_dir().join(format!("crew-v23-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).expect("dir");
        (dir.join("crew.sqlite3"), dir)
    }

    /// A v22 database — agents and terminals in one table, the agent's
    /// identity on its session's row — comes out of migration 23 with the
    /// identity in `agents`, under the same id, and out of 25 with it in
    /// `bots`, nothing lost on the way: the transcript, the mailbox and the
    /// routine keep their keys.
    #[test]
    fn a_v22_database_keeps_every_bot_terminal_and_transcript() {
        let (path, dir) = fresh();
        let (bot, terminal) = {
            let store = Store::open(path.clone()).expect("open");
            let ws = crate::workspace::create(&store, "w".into(), dir.to_string_lossy().into()).expect("ws");
            let bot = crate::session::create(
                &store, ws.id.clone(), "bot".into(), "Planner".into(), "claude".into(), "m".into(),
                "You keep the roadmap.".into(), "full".into(),
            )
            .expect("bot");
            let terminal = crate::session::create(
                &store, ws.id.clone(), "terminal".into(), "Refactor".into(), "codex".into(), "".into(),
                "".into(), "ask".into(),
            )
            .expect("terminal");
            let blocks = vec![crate::blocks::new_block(crew_protocol::BlockRole::User, "what did we decide?")];
            store
                .with(|conn| crate::messages::sync(conn, &bot.id, &blocks, &mut Vec::new()))
                .expect("transcript");
            let from = crew_protocol::BotRef::bot(terminal.id.clone(), terminal.name.clone());
            crate::mailbox::enqueue(&store, &bot.id, &from, "a letter").expect("letter");
            // Back to v22: the identity on the session row, under the old
            // kind, and nothing else.
            store
                .with(|conn| {
                    conn.execute_batch(
                        "DROP TABLE session_events;
                         DROP INDEX sessions_parent_idx;
                         ALTER TABLE sessions DROP COLUMN bot_id;
                         ALTER TABLE sessions DROP COLUMN parent_id;
                         ALTER TABLE sessions DROP COLUMN cursor;
                         ALTER TABLE sessions DROP COLUMN seen;
                         DROP TABLE bots;
                         UPDATE sessions SET kind = 'agent' WHERE kind = 'bot';
                         DELETE FROM schema_migrations WHERE version >= 23;",
                    )
                })
                .expect("downgrade");
            (bot.id, terminal.id)
        };

        let store = Store::open(path).expect("reopen");

        let row = crate::session::get(&store, bot.clone()).unwrap().expect("the bot survived");
        assert_eq!(
            (row.kind.as_str(), row.bot_id.as_deref(), row.name.as_str(), row.description.as_str(), row.autonomy.as_str()),
            ("bot", Some(bot.as_str()), "Planner", "You keep the roadmap.", "full")
        );
        let shell = crate::session::get(&store, terminal.clone()).unwrap().expect("the terminal survived");
        assert_eq!((shell.kind.as_str(), shell.bot_id), ("terminal", None));
        let named: Vec<(String, String)> = store
            .with(|conn| {
                conn.prepare("SELECT id, name FROM bots")?
                    .query_map([], |row| Ok((row.get(0)?, row.get(1)?)))?
                    .collect()
            })
            .unwrap();
        assert_eq!(named, vec![(bot.clone(), "Planner".to_string())], "a terminal became a bot, or the bot was lost");
        let transcript = store.with(|conn| crate::messages::all(conn, &bot)).unwrap();
        assert_eq!(transcript.len(), 1);
        assert_eq!(crate::mailbox::waiting_count(&store, &bot).unwrap(), 1);

        // Opening again changes nothing: every step looks before it acts.
        drop(store);
        let store = Store::open(dir.join("crew.sqlite3")).expect("third open");
        assert_eq!(crate::session::get(&store, bot).unwrap().unwrap().name, "Planner");
    }

    /// Identity is written where it lives: the bot's, to `bots`; a
    /// terminal's, to its own row. Deleting either id takes both rows.
    #[test]
    fn a_bots_identity_is_written_to_bots_and_goes_with_its_session() {
        let (path, dir) = fresh();
        let store = Store::open(path).expect("open");
        let ws = crate::workspace::create(&store, "w".into(), dir.to_string_lossy().into()).expect("ws");
        let bot = crate::session::create(
            &store, ws.id.clone(), "bot".into(), "Planner".into(), "claude".into(), "m".into(), "".into(), "ask".into(),
        )
        .expect("bot");
        crate::session::update(
            &store, bot.id.clone(), "Architect".into(), "codex".into(), "gpt".into(), "Design it.".into(), false, "full".into(),
        )
        .expect("update");
        crate::session::rename(&store, bot.id.clone(), "Lead".into()).expect("rename");
        let (name, description, autonomy, notifications): (String, String, String, bool) = store
            .with(|conn| {
                conn.query_row(
                    "SELECT name, description, autonomy, notifications FROM bots WHERE id = ?1",
                    params![bot.id],
                    |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
                )
            })
            .unwrap();
        assert_eq!((name.as_str(), description.as_str(), autonomy.as_str(), notifications), ("Lead", "Design it.", "full", false));
        let row = crate::session::get(&store, bot.id.clone()).unwrap().unwrap();
        assert_eq!((row.name.as_str(), row.provider.as_str(), row.autonomy.as_str()), ("Lead", "codex", "full"));

        crate::session::delete(&store, bot.id.clone()).expect("delete");
        assert!(crate::session::get(&store, bot.id.clone()).unwrap().is_none());
        let left: i64 = store.with(|conn| conn.query_row("SELECT COUNT(*) FROM bots", [], |row| row.get(0))).unwrap();
        assert_eq!(left, 0, "the bot outlived its session's deletion");
    }

    /// A child names who started it; deleting the parent leaves the child, the
    /// user's now, with its transcript.
    #[test]
    fn a_child_outlives_its_parent_as_the_users() {
        let (path, dir) = fresh();
        let store = Store::open(path).expect("open");
        let ws = crate::workspace::create(&store, "w".into(), dir.to_string_lossy().into()).expect("ws");
        let parent = crate::session::create(
            &store, ws.id.clone(), "terminal".into(), "Shell".into(), "claude".into(), "".into(), "".into(), "full".into(),
        )
        .expect("terminal");
        let child = crate::session::create_child(
            &store, ws.id.clone(), "codex: fix".into(), "codex".into(), "m".into(), "full".into(), None, Some(parent.id.clone()),
        )
        .expect("child");
        assert_eq!((child.kind.as_str(), child.status.as_str()), ("child", "starting"));
        assert_eq!(crate::session::get(&store, child.id.clone()).unwrap().unwrap().parent_id, Some(parent.id.clone()));
        crate::session::delete(&store, parent.id).expect("delete");
        let orphan = crate::session::get(&store, child.id).unwrap().expect("the child went with its parent");
        assert_eq!(orphan.parent_id, None);
    }
}

#[cfg(test)]
mod rename_tests {
    use super::*;

    /// A v24 database — identities in `agents`, sessions pointing at them by
    /// `agent_id`, the old kind, the old sender key on a message and the
    /// window's old keys — comes out of migration 25 speaking of bots
    /// everywhere, with the foreign keys following the table.
    #[test]
    fn a_v24_database_comes_out_of_25_with_bots() {
        let dir = std::env::temp_dir().join(format!("crew-v25-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).expect("dir");
        let path = dir.join("crew.sqlite3");
        let (bot, child, terminal) = {
            let store = Store::open(path.clone()).expect("open");
            let ws = crate::workspace::create(&store, "w".into(), dir.to_string_lossy().into()).expect("ws");
            let bot = crate::session::create(
                &store, ws.id.clone(), "bot".into(), "Planner".into(), "claude".into(), "m".into(),
                "You keep the roadmap.".into(), "full".into(),
            )
            .expect("bot");
            let terminal = crate::session::create(
                &store, ws.id.clone(), "terminal".into(), "Shell".into(), "claude".into(), "".into(), "".into(), "ask".into(),
            )
            .expect("terminal");
            let child = crate::session::create_child(
                &store, ws.id.clone(), "codex: fix".into(), "codex".into(), "m".into(), "full".into(), None, Some(bot.id.clone()),
            )
            .expect("child");
            let mut letter = crate::blocks::new_block(crew_protocol::BlockRole::User, "the branch is green");
            letter.from_bot = Some(crew_protocol::BotRef::bot(bot.id.clone(), "Planner"));
            store
                .with(|conn| {
                    // A child that runs for the bot, so the column carries a value across.
                    conn.execute("UPDATE sessions SET bot_id = ?2 WHERE id = ?1", params![child.id, bot.id])?;
                    crate::messages::sync(conn, &child.id, &[letter], &mut Vec::new())?;
                    write_state(conn, "bot:faces", Some(r#"{"x":{"seed":"y"}}"#))?;
                    write_state(conn, "bot:avatar", Some("robot"))?;
                    write_state(conn, "sidebar:prefs", Some(r#"{"hiddenKinds":["bot","terminal"],"hiddenProviders":["codex"]}"#))
                })
                .expect("seed");
            // Back to v24: every name as it was before the rename.
            store
                .with(|conn| {
                    conn.execute_batch(
                        r#"ALTER TABLE bots RENAME TO agents;
                         DROP INDEX bots_workspace_idx;
                         CREATE INDEX agents_workspace_idx ON agents (workspace_id);
                         ALTER TABLE sessions RENAME COLUMN bot_id TO agent_id;
                         UPDATE sessions SET kind = 'agent' WHERE kind = 'bot';
                         UPDATE messages
                            SET extra_json = json_remove(json_set(extra_json, '$.from_agent', json_extract(extra_json, '$.from_bot')), '$.from_bot')
                          WHERE json_type(extra_json, '$.from_bot') IS NOT NULL;
                         UPDATE app_state SET key = 'agent:faces' WHERE key = 'bot:faces';
                         UPDATE app_state SET key = 'agent:avatar' WHERE key = 'bot:avatar';
                         UPDATE app_state SET value = '{"hiddenKinds":["agent","terminal"],"hiddenProviders":["codex"]}'
                          WHERE key = 'sidebar:prefs';
                         DELETE FROM schema_migrations WHERE version >= 25;"#,
                    )
                })
                .expect("downgrade");
            let old = store
                .with(|conn| {
                    Ok((
                        has_column(conn, "sessions", "agent_id")?,
                        conn.query_row("SELECT extra_json FROM messages WHERE session_id = ?1", params![child.id], |row| {
                            row.get::<_, String>(0)
                        })?,
                    ))
                })
                .expect("v24");
            assert!(old.0 && old.1.contains("from_agent"), "the downgrade did not reach v24: {old:?}");
            (bot.id, child.id, terminal.id)
        };

        let store = Store::open(path.clone()).expect("reopen");

        let (tables, columns, references, version): (Vec<String>, Vec<String>, Vec<String>, i64) = store
            .with(|conn| {
                let names = |sql: &str| -> rusqlite::Result<Vec<String>> {
                    conn.prepare(sql)?.query_map([], |row| row.get(0))?.collect()
                };
                Ok((
                    names("SELECT name FROM sqlite_master WHERE name IN ('agents', 'bots', 'agents_workspace_idx', 'bots_workspace_idx') ORDER BY name")?,
                    names("SELECT name FROM pragma_table_info('sessions') WHERE name IN ('agent_id', 'bot_id')")?,
                    names("SELECT DISTINCT \"table\" FROM pragma_foreign_key_list('sessions') ORDER BY 1")?,
                    conn.query_row("SELECT MAX(version) FROM schema_migrations", [], |row| row.get(0))?,
                ))
            })
            .unwrap();
        assert_eq!(tables, ["bots", "bots_workspace_idx"]);
        assert_eq!(columns, ["bot_id"]);
        assert_eq!(references, ["bots", "sessions", "workspaces"], "a foreign key still points at the old table");
        assert!(version >= 25, "{version}");

        let row = crate::session::get(&store, bot.clone()).unwrap().expect("the bot survived");
        assert_eq!(
            (row.kind.as_str(), row.bot_id.as_deref(), row.name.as_str(), row.description.as_str()),
            ("bot", Some(bot.as_str()), "Planner", "You keep the roadmap.")
        );
        let ran = crate::session::get(&store, child.clone()).unwrap().expect("the child survived");
        assert_eq!((ran.kind.as_str(), ran.bot_id.as_deref(), ran.parent_id.as_deref()), ("child", Some(bot.as_str()), Some(bot.as_str())));
        assert_eq!(crate::session::get(&store, terminal).unwrap().expect("terminal").kind, "terminal");

        let transcript = store.with(|conn| crate::messages::all(conn, &child)).unwrap();
        assert_eq!(transcript[0].from_bot.as_ref().map(|from| (from.id.as_str(), from.name.as_str())), Some((bot.as_str(), "Planner")));
        let extra: String = store
            .with(|conn| conn.query_row("SELECT extra_json FROM messages WHERE session_id = ?1", params![child], |row| row.get(0)))
            .unwrap();
        assert!(!extra.contains("from_agent"), "{extra}");

        assert_eq!(get(&store, "bot:faces".into()).unwrap().as_deref(), Some(r#"{"x":{"seed":"y"}}"#));
        assert_eq!(get(&store, "bot:avatar".into()).unwrap().as_deref(), Some("robot"));
        assert_eq!(get(&store, "agent:faces".into()).unwrap(), None);
        assert_eq!(get(&store, "agent:avatar".into()).unwrap(), None);
        let prefs: serde_json::Value = serde_json::from_str(&get(&store, "sidebar:prefs".into()).unwrap().unwrap()).unwrap();
        assert_eq!(prefs, serde_json::json!({ "hiddenKinds": ["bot", "terminal"], "hiddenProviders": ["codex"] }));

        // The foreign key follows the table: a bot deleted takes the sessions
        // that run for it.
        store.with(|conn| conn.execute("DELETE FROM bots WHERE id = ?1", params![bot])).unwrap();
        assert!(crate::session::get(&store, child.clone()).unwrap().is_none(), "the child outlived its bot");

        // Opening again changes nothing: every step looks before it acts.
        drop(store);
        let store = Store::open(path).expect("third open");
        let prefs = get(&store, "sidebar:prefs".into()).unwrap().unwrap();
        assert!(prefs.contains(r#""bot""#), "{prefs}");
    }
}

#[cfg(test)]
mod lifecycle_tests {
    use super::*;

    /// A v25 database: letters with no kind and no lifecycle, delivered ones
    /// marked by `delivered_at` alone. Migration 26 gives each a kind (a
    /// letter a child left its parent is a report, of the child's last event
    /// before it), counts the delivered as claimed and delivered, and leaves
    /// the waiting ones pending.
    #[test]
    fn a_v25_database_comes_out_of_26_with_kinds_and_states() {
        let dir = std::env::temp_dir().join(format!("crew-v26-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).expect("dir");
        let path = dir.join("crew.sqlite3");
        let (bot, child, shell) = {
            let store = Store::open(path.clone()).expect("open");
            let ws = crate::workspace::create(&store, "w".into(), dir.to_string_lossy().into()).expect("ws");
            let bot = crate::session::create(
                &store, ws.id.clone(), "bot".into(), "Planner".into(), "claude".into(), "m".into(), "".into(), "full".into(),
            )
            .expect("bot");
            let shell = crate::session::create(
                &store, ws.id.clone(), "terminal".into(), "Shell".into(), "claude".into(), "".into(), "".into(), "ask".into(),
            )
            .expect("terminal");
            let child = crate::session::create_child(
                &store, ws.id.clone(), "codex: fix".into(), "codex".into(), "m".into(), "full".into(), None, Some(bot.id.clone()),
            )
            .expect("child");
            crate::session_events::record(&store, &child.id, 4, "turn", "completed", "done", None).expect("event");
            // Back to v25, and the letters written the way v25 wrote them.
            store
                .with(|conn| {
                    conn.execute_batch(
                        "DROP INDEX mailbox_pending_idx;
                         CREATE INDEX mailbox_waiting_idx ON mailbox (to_session, at) WHERE delivered_at IS NULL;
                         ALTER TABLE mailbox DROP COLUMN kind;
                         ALTER TABLE mailbox DROP COLUMN event_cursor;
                         ALTER TABLE mailbox DROP COLUMN claimed_at;
                         ALTER TABLE mailbox DROP COLUMN disposed_at;
                         ALTER TABLE sessions DROP COLUMN handed_off_by;
                         ALTER TABLE sessions DROP COLUMN user_seen;
                         DELETE FROM schema_migrations WHERE version >= 26;",
                    )?;
                    let at = now_millis();
                    let letter = conn.prepare(
                        "INSERT INTO mailbox (id, to_session, from_session, from_name, text, at, from_kind, delivered_at)
                         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
                    )?;
                    let mut letter = letter;
                    letter.execute(params!["report", bot.id, child.id, "codex: fix", "Its turn ended.", at, "session", None::<i64>])?;
                    letter.execute(params!["read", bot.id, shell.id, "Shell", "old news", at - 10, "terminal", Some(at - 5)])?;
                    letter.execute(params!["waiting", bot.id, shell.id, "Shell", "tests pass", at + 1, "terminal", None::<i64>])?;
                    Ok(())
                })
                .expect("downgrade");
            (bot.id, child.id, shell.id)
        };

        let store = Store::open(path).expect("reopen");
        let version: i64 = store
            .with(|conn| conn.query_row("SELECT MAX(version) FROM schema_migrations", [], |row| row.get(0)))
            .unwrap();
        assert!(version >= 26, "{version}");
        let rows: Vec<(String, String, Option<i64>, bool, bool, bool)> = store
            .with(|conn| {
                conn.prepare(
                    "SELECT id, kind, event_cursor, claimed_at IS NOT NULL, delivered_at IS NOT NULL, disposed_at IS NOT NULL
                       FROM mailbox ORDER BY id",
                )?
                .query_map([], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?, row.get(4)?, row.get(5)?)))?
                .collect()
            })
            .unwrap();
        assert_eq!(
            rows,
            [
                ("read".to_string(), "message".to_string(), None, true, true, false),
                ("report".to_string(), "report".to_string(), Some(4), false, false, false),
                ("waiting".to_string(), "message".to_string(), None, false, false, false),
            ]
        );
        let waiting: Vec<String> = crate::mailbox::waiting(&store, &bot).unwrap().into_iter().map(|letter| letter.id).collect();
        assert_eq!(waiting, ["report", "waiting"]);
        let (columns, index): (Vec<String>, Vec<String>) = store
            .with(|conn| {
                let names = |sql: &str| -> rusqlite::Result<Vec<String>> {
                    conn.prepare(sql)?.query_map([], |row| row.get(0))?.collect()
                };
                Ok((
                    names("SELECT name FROM pragma_table_info('sessions') WHERE name IN ('handed_off_by', 'user_seen') ORDER BY name")?,
                    names("SELECT name FROM sqlite_master WHERE type = 'index' AND name LIKE 'mailbox_%' ORDER BY name")?,
                ))
            })
            .unwrap();
        assert_eq!(columns, ["handed_off_by", "user_seen"]);
        assert_eq!(index, ["mailbox_pending_idx"]);
        // The new reference holds: whoever handed a session over can go.
        store
            .with(|conn| conn.execute("UPDATE sessions SET handed_off_by = ?2 WHERE id = ?1", params![shell, child]))
            .unwrap();
        crate::session::delete(&store, child).unwrap();
        let handed: Option<String> = store
            .with(|conn| conn.query_row("SELECT handed_off_by FROM sessions WHERE id = ?1", params![shell], |row| row.get(0)))
            .unwrap();
        assert_eq!(handed, None);

        // Opening again changes nothing.
        drop(store);
        let store = Store::open(dir.join("crew.sqlite3")).expect("third open");
        assert_eq!(crate::mailbox::waiting_count(&store, &bot).unwrap(), 2);
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
