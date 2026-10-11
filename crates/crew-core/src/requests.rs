//! What a starting tool made, kept under the caller's `request_id`, so a retry
//! of the same call (an MCP call that timed out, a model that tried again)
//! gets the first answer back instead of starting everything twice.
//!
//! Stored per caller: two callers may use the same id. Rows older than
//! [`KEEP_MS`] are dropped as new ones are written.

use rusqlite::{params, OptionalExtension};
use serde_json::Value;

use crate::store::{now_millis, Store};

pub const MIGRATION_V35: &str = "CREATE TABLE IF NOT EXISTS start_requests (
   caller     TEXT NOT NULL,
   request_id TEXT NOT NULL,
   tool       TEXT NOT NULL,
   result     TEXT NOT NULL,
   created_at INTEGER NOT NULL,
   PRIMARY KEY (caller, request_id)
 );";

/// How long a request id is remembered.
pub const KEEP_MS: i64 = 7 * 24 * 60 * 60 * 1000;

/// What the first call with this id made, and which tool made it.
pub fn get(store: &Store, caller: &str, request_id: &str) -> Result<Option<(String, Value)>, String> {
    let found: Option<(String, String)> = store.with(|conn| {
        conn.prepare_cached("SELECT tool, result FROM start_requests WHERE caller = ?1 AND request_id = ?2")?
            .query_row(params![caller, request_id], |row| Ok((row.get(0)?, row.get(1)?)))
            .optional()
    })?;
    Ok(found.and_then(|(tool, result)| Some((tool, serde_json::from_str(&result).ok()?))))
}

/// Remember what `tool` made. The first write wins.
pub fn put(store: &Store, caller: &str, request_id: &str, tool: &str, result: &Value) -> Result<(), String> {
    let now = now_millis();
    store.with(|conn| {
        conn.execute("DELETE FROM start_requests WHERE created_at < ?1", params![now - KEEP_MS])?;
        conn.execute(
            "INSERT OR IGNORE INTO start_requests (caller, request_id, tool, result, created_at)
             VALUES (?1, ?2, ?3, ?4, ?5)",
            params![caller, request_id, tool, result.to_string(), now],
        )
    })?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn a_request_is_remembered_per_caller_and_the_first_write_wins() {
        let dir = std::env::temp_dir().join(format!("crew-requests-{}", uuid::Uuid::new_v4()));
        let store = Store::open(dir.join("crew.sqlite3")).expect("store");
        assert!(get(&store, "a", "r1").unwrap().is_none());
        put(&store, "a", "r1", "delegate", &json!({ "id": "one" })).unwrap();
        put(&store, "a", "r1", "delegate", &json!({ "id": "two" })).unwrap();
        assert_eq!(get(&store, "a", "r1").unwrap(), Some(("delegate".into(), json!({ "id": "one" }))));
        assert!(get(&store, "b", "r1").unwrap().is_none(), "another caller's id is its own");
    }
}
