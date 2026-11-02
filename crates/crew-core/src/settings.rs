//! Settings: what the user chose, kept apart from `app_state`, the window's
//! memory. Each row has a scope:
//!
//! - `global`: every daemon holds a copy, and the window reconciles the copies
//!   (`src/lib/settingsEngine`). Daemons do not talk to each other.
//! - `env`: this machine's alone.
//! - `device`: the window's machine's alone.
//!
//! A row carries a revision, so copies agree without a coordinator: the greater
//! `(revision, origin)` wins, a merge can be repeated or arrive out of order,
//! and a NULL value is a choice like any other, so going back to the default
//! reaches the other copies instead of leaving them on the old value.
//!
//! The daemon knows no setting by name here: a new one needs no new daemon
//! unless the daemon itself reads it.

use crew_protocol::SettingRow;
use rusqlite::{params, Connection, OptionalExtension};

use crate::store::{now_millis, read_state, write_state, Store};

pub const GLOBAL: &str = "global";

/// How long a daemon may act on a copy nobody has confirmed: see `confirmed_within`.
pub const CONFIRM_FOR_MS: i64 = 24 * 60 * 60 * 1000;

const ORIGIN_KEY: &str = "settings:origin";
const CONFIRMED_KEY: &str = "settings:confirmed-at";

/// The settings that lived in `app_state` come along at revision 0: older than
/// any choice made from here on, so the first reconciliation decides the global
/// ones. A remote never held most of these: its window kept them on the Mac.
pub const MIGRATION_V44: &str = "
CREATE TABLE IF NOT EXISTS settings (
  key      TEXT PRIMARY KEY,
  value    TEXT,
  scope    TEXT NOT NULL,
  revision INTEGER NOT NULL,
  origin   TEXT NOT NULL
);
INSERT OR IGNORE INTO settings (key, value, scope, revision, origin)
  SELECT key, value,
         CASE WHEN key IN ('startup:reopen', 'remote:wake', 'remote:warn-relay', 'remote:auto-update',
                           'updates:auto-download', 'keybindings:overrides', 'notifications:prefs',
                           'browser:site-permissions')
              THEN 'device' ELSE 'global' END,
         0, ''
    FROM app_state
   WHERE key IN ('sessions:retention', 'sessions:bypass-permissions', 'providers:default', 'providers:last',
                 'app:accent', 'app:chat-text', 'bot:avatar', 'terminal:prefs', 'browser:prefs', 'usage:alerts',
                 'usage:rings', 'startup:reopen', 'remote:wake', 'remote:warn-relay', 'remote:auto-update',
                 'updates:auto-download', 'keybindings:overrides', 'notifications:prefs', 'browser:site-permissions');
DELETE FROM app_state
 WHERE key IN ('sessions:retention', 'sessions:bypass-permissions', 'providers:default', 'providers:last',
               'app:accent', 'app:chat-text', 'bot:avatar', 'terminal:prefs', 'browser:prefs', 'usage:alerts',
               'usage:rings', 'startup:reopen', 'remote:wake', 'remote:warn-relay', 'remote:auto-update',
               'updates:auto-download', 'keybindings:overrides', 'notifications:prefs', 'browser:site-permissions');
";

fn row_of(row: &rusqlite::Row) -> rusqlite::Result<SettingRow> {
    Ok(SettingRow { key: row.get(0)?, value: row.get(1)?, scope: row.get(2)?, revision: row.get(3)?, origin: row.get(4)? })
}

fn read(conn: &Connection, key: &str) -> rusqlite::Result<Option<SettingRow>> {
    conn.prepare_cached("SELECT key, value, scope, revision, origin FROM settings WHERE key = ?1")?
        .query_row(params![key], row_of)
        .optional()
}

fn write(conn: &Connection, row: &SettingRow) -> rusqlite::Result<()> {
    conn.prepare_cached(
        "INSERT INTO settings (key, value, scope, revision, origin) VALUES (?1, ?2, ?3, ?4, ?5)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value, scope = excluded.scope,
           revision = excluded.revision, origin = excluded.origin",
    )?
    .execute(params![row.key, row.value, row.scope, row.revision, row.origin])
    .map(|_| ())
}

/// This daemon's name in a tie, made the first time it is needed.
fn origin(conn: &Connection) -> rusqlite::Result<String> {
    if let Some(origin) = read_state(conn, ORIGIN_KEY)? {
        return Ok(origin);
    }
    let origin = uuid::Uuid::new_v4().to_string();
    write_state(conn, ORIGIN_KEY, Some(&origin))?;
    Ok(origin)
}

/// The value of `key`, `None` when it was never set or went back to its default.
pub fn get(store: &Store, key: &str) -> Result<Option<String>, String> {
    store.with(|conn| Ok(read(conn, key)?.and_then(|row| row.value)))
}

pub fn list(store: &Store) -> Result<Vec<SettingRow>, String> {
    store.with(|conn| {
        conn.prepare_cached("SELECT key, value, scope, revision, origin FROM settings ORDER BY key")?
            .query_map([], row_of)?
            .collect::<rusqlite::Result<Vec<_>>>()
    })
}

/// A choice made here. Its revision follows the clock, and is past every revision
/// this daemon has seen, so a choice made after seeing another beats it even
/// when this machine's clock runs behind.
pub fn set(store: &Store, key: &str, value: Option<&str>, scope: &str) -> Result<SettingRow, String> {
    store.with(|conn| {
        let tx = conn.unchecked_transaction()?;
        let seen: i64 = tx.query_row("SELECT COALESCE(MAX(revision), 0) FROM settings", [], |row| row.get(0))?;
        let row = SettingRow {
            key: key.to_string(),
            value: value.map(str::to_string),
            scope: scope.to_string(),
            revision: now_millis().max(seen + 1),
            origin: origin(&tx)?,
        };
        write(&tx, &row)?;
        tx.commit()?;
        Ok(row)
    })
}

/// Takes the rows newer than what is here and answers those. Only `global` rows
/// travel. Asking is itself the confirmation that a client has seen this
/// daemon's copies, so it counts even with nothing to take.
pub fn merge(store: &Store, rows: &[SettingRow]) -> Result<Vec<SettingRow>, String> {
    store.with(|conn| {
        let tx = conn.unchecked_transaction()?;
        let mut taken = Vec::new();
        for row in rows.iter().filter(|row| row.scope == GLOBAL) {
            let newer = read(&tx, &row.key)?.is_none_or(|here| (row.revision, &row.origin) > (here.revision, &here.origin));
            if newer {
                write(&tx, row)?;
                taken.push(row.clone());
            }
        }
        write_state(&tx, CONFIRMED_KEY, Some(&now_millis().to_string()))?;
        tx.commit()?;
        Ok(taken)
    })
}

/// Whether a client reconciled with this daemon in the last `window` ms. What a
/// daemon does on its own with a copy it cannot undo waits on this: a choice
/// made while it was down reaches it only through a client, and waiting costs
/// nothing where acting on an old copy costs what it deleted.
pub fn confirmed_within(store: &Store, now: i64, window: i64) -> Result<bool, String> {
    let at = store.with(|conn| read_state(conn, CONFIRMED_KEY))?;
    Ok(at.and_then(|at| at.parse::<i64>().ok()).is_some_and(|at| now - at <= window))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn store() -> Store {
        let dir = std::env::temp_dir().join(format!("crew-settings-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).expect("dir");
        Store::open(dir.join("crew.sqlite3")).expect("store")
    }

    fn row(key: &str, value: Option<&str>, revision: i64, origin: &str) -> SettingRow {
        SettingRow { key: key.into(), value: value.map(str::to_string), scope: GLOBAL.into(), revision, origin: origin.into() }
    }

    #[test]
    fn a_newer_row_wins_and_an_older_one_is_ignored_whatever_order_they_arrive() {
        let store = store();
        assert_eq!(merge(&store, &[row("k", Some("new"), 5, "a")]).unwrap().len(), 1);
        assert!(merge(&store, &[row("k", Some("old"), 4, "a")]).unwrap().is_empty());
        assert_eq!(get(&store, "k").unwrap().as_deref(), Some("new"));
    }

    #[test]
    fn merging_the_same_row_twice_changes_nothing() {
        let store = store();
        merge(&store, &[row("k", Some("v"), 5, "a")]).unwrap();
        assert!(merge(&store, &[row("k", Some("v"), 5, "a")]).unwrap().is_empty());
    }

    #[test]
    fn a_tie_is_decided_by_origin_on_every_copy() {
        let (one, two) = (store(), store());
        let (a, b) = (row("k", Some("a"), 5, "a"), row("k", Some("b"), 5, "b"));
        merge(&one, &[a.clone()]).unwrap();
        merge(&one, &[b.clone()]).unwrap();
        merge(&two, &[b]).unwrap();
        merge(&two, &[a]).unwrap();
        assert_eq!(get(&one, "k").unwrap(), get(&two, "k").unwrap());
        assert_eq!(get(&one, "k").unwrap().as_deref(), Some("b"));
    }

    #[test]
    fn going_back_to_the_default_replaces_the_value_on_another_copy() {
        let store = store();
        merge(&store, &[row("k", Some("90"), 5, "a")]).unwrap();
        merge(&store, &[row("k", None, 6, "a")]).unwrap();
        assert_eq!(get(&store, "k").unwrap(), None);
        assert_eq!(list(&store).unwrap()[0].revision, 6, "the choice is kept, not just the value dropped");
    }

    #[test]
    fn a_choice_after_seeing_another_beats_it_even_with_a_clock_behind() {
        let store = store();
        let ahead = now_millis() + 3_600_000;
        merge(&store, &[row("other", Some("v"), ahead, "a")]).unwrap();
        assert!(set(&store, "k", Some("v"), GLOBAL).unwrap().revision > ahead);
    }

    #[test]
    fn only_global_rows_travel() {
        let store = store();
        let mut local = row("k", Some("v"), 5, "a");
        local.scope = "env".into();
        assert!(merge(&store, &[local]).unwrap().is_empty());
        assert_eq!(get(&store, "k").unwrap(), None);
    }

    #[test]
    fn a_daemon_counts_as_confirmed_only_for_a_while_after_a_merge() {
        let store = store();
        assert!(!confirmed_within(&store, now_millis(), CONFIRM_FOR_MS).unwrap(), "nobody has confirmed yet");
        merge(&store, &[]).unwrap();
        let now = now_millis();
        assert!(confirmed_within(&store, now, CONFIRM_FOR_MS).unwrap());
        assert!(!confirmed_within(&store, now + CONFIRM_FOR_MS + 1_000, CONFIRM_FOR_MS).unwrap());
    }

    #[test]
    fn the_settings_in_app_state_move_at_revision_zero() {
        let dir = std::env::temp_dir().join(format!("crew-settings-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).expect("dir");
        let path = dir.join("crew.sqlite3");
        {
            let store = Store::open(path.clone()).expect("store");
            store
                .with(|conn| {
                    conn.execute_batch(
                        "DROP TABLE settings;
                         DELETE FROM schema_migrations WHERE version >= 44;
                         INSERT INTO app_state (key, value) VALUES ('sessions:retention', '90'), ('startup:reopen', 'off'), ('tabs:w', '{}');",
                    )
                })
                .expect("downgrade");
        }
        let store = Store::open(path).expect("reopen");
        let rows = list(&store).unwrap();
        let moved: Vec<_> =
            rows.iter().map(|row| (row.key.as_str(), row.value.as_deref(), row.scope.as_str(), row.revision)).collect();
        assert_eq!(moved, [("sessions:retention", Some("90"), "global", 0), ("startup:reopen", Some("off"), "device", 0)]);
        assert_eq!(crate::store::get(&store, "sessions:retention".into()).unwrap(), None);
        assert!(crate::store::get(&store, "tabs:w".into()).unwrap().is_some(), "the window's memory stays");
    }
}
