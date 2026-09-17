use rusqlite::{params, OptionalExtension};
use serde::{Deserialize, Serialize};

use crate::store::{now_millis, set_order, Store};

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Session {
    pub id: String,
    pub workspace_id: String,
    pub kind: String,
    pub name: String,
    pub provider: String,
    pub model: String,
    pub provider_session_id: Option<String>,
    pub description: String,
    pub notifications: bool,
    /// "ask" prompts for every tool; "full" lets the provider run unattended.
    pub autonomy: String,
    /// "idle" | "working" | "needs-input" | "error". Set by the runtime, never by the UI.
    pub status: String,
    pub created_at: i64,
    pub updated_at: i64,
}

/// 13 columns, aliased on `s`, so a join can read a session at an offset.
pub const SESSION_COLUMNS: &str = "s.id, s.workspace_id, s.kind, s.name, s.provider, s.model,
                                   s.provider_session_id, s.description, s.notifications,
                                   s.status, s.created_at, s.updated_at, s.autonomy";

const SELECT_BY_WORKSPACE: &str = "SELECT id, workspace_id, kind, name, provider, model,
                                          provider_session_id, description, notifications,
                                          status, created_at, updated_at, autonomy
                                   FROM sessions
                                   WHERE workspace_id = ?1
                                   ORDER BY sort_order ASC, created_at ASC";

pub fn row_to_session(row: &rusqlite::Row, at: usize) -> rusqlite::Result<Session> {
    Ok(Session {
        id: row.get(at)?,
        workspace_id: row.get(at + 1)?,
        kind: row.get(at + 2)?,
        name: row.get(at + 3)?,
        provider: row.get(at + 4)?,
        model: row.get(at + 5)?,
        provider_session_id: row.get(at + 6)?,
        description: row.get(at + 7)?,
        notifications: row.get::<_, i64>(at + 8)? != 0,
        autonomy: row.get(at + 12)?,
        status: row.get(at + 9)?,
        created_at: row.get(at + 10)?,
        updated_at: row.get(at + 11)?,
    })
}

pub fn list(store: &Store, workspace_id: String) -> Result<Vec<Session>, String> {
    store.with(|conn| {
        let mut stmt = conn.prepare_cached(SELECT_BY_WORKSPACE)?;
        let rows = stmt.query_map(params![workspace_id], |row| row_to_session(row, 0))?;
        rows.collect()
    })
}

/// Every session in every workspace. The startup sweep needs it; screens do not.
pub fn list_all(store: &Store) -> Result<Vec<Session>, String> {
    store.with(|conn| {
        let mut stmt = conn.prepare_cached(&format!(
            "SELECT {SESSION_COLUMNS} FROM sessions s ORDER BY s.created_at ASC"
        ))?;
        let rows = stmt.query_map([], |row| row_to_session(row, 0))?;
        rows.collect()
    })
}

pub fn list_busy(store: &Store) -> Result<Vec<Session>, String> {
    store.with(|conn| {
        let mut stmt = conn.prepare_cached(
            "SELECT id, workspace_id, kind, name, provider, model,
                    provider_session_id, description, notifications,
                    status, created_at, updated_at, autonomy
             FROM sessions
             WHERE status IN ('working', 'needs-input')
             ORDER BY updated_at ASC",
        )?;
        let rows = stmt.query_map([], |row| row_to_session(row, 0))?;
        rows.collect()
    })
}

pub fn get(store: &Store, id: String) -> Result<Option<Session>, String> {
    store.with(|conn| {
        conn.prepare_cached(&format!("SELECT {SESSION_COLUMNS} FROM sessions s WHERE s.id = ?1"))?
            .query_row(params![id], |row| row_to_session(row, 0))
            .optional()
    })
}

#[allow(clippy::too_many_arguments)]
pub fn create(
    store: &Store,
    workspace_id: String,
    kind: String,
    name: String,
    provider: String,
    model: String,
    description: String,
    autonomy: String,
) -> Result<Session, String> {
    let name = name.trim().to_string();
    if name.is_empty() {
        return Err("Name is required".into());
    }
    if kind != "agent" && kind != "terminal" {
        return Err(format!("Unknown session kind: {kind}"));
    }

    let now = now_millis();
    let session = Session {
        id: uuid::Uuid::new_v4().to_string(),
        workspace_id,
        kind,
        name,
        provider,
        model,
        provider_session_id: None,
        description,
        notifications: true,
        autonomy: autonomy_or_default(autonomy),
        status: "idle".into(),
        created_at: now,
        updated_at: now,
    };

    store.with(|conn| {
        conn.execute(
            "INSERT INTO sessions
               (id, workspace_id, kind, name, provider, model, description,
                notifications, created_at, updated_at, sort_order, autonomy)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12)",
            params![
                session.id,
                session.workspace_id,
                session.kind,
                session.name,
                session.provider,
                session.model,
                session.description,
                session.notifications,
                session.created_at,
                session.updated_at,
                session.created_at,
                session.autonomy
            ],
        )
    })?;

    Ok(session)
}

#[allow(clippy::too_many_arguments)]
pub fn update(
    store: &Store,
    id: String,
    name: String,
    provider: String,
    model: String,
    description: String,
    notifications: bool,
    autonomy: String,
) -> Result<(), String> {
    let name = name.trim().to_string();
    if name.is_empty() {
        return Err("Name is required".into());
    }
    let autonomy = autonomy_or_default(autonomy);
    store.with(|conn| {
        conn.execute(
            "UPDATE sessions
             SET name = ?2, provider = ?3, model = ?4, description = ?5,
                 notifications = ?6, updated_at = ?7, autonomy = ?8
             WHERE id = ?1",
            params![id, name, provider, model, description, notifications, now_millis(), autonomy],
        )
    })?;
    Ok(())
}

fn autonomy_or_default(value: String) -> String {
    if value == "full" {
        value
    } else {
        "ask".into()
    }
}

pub fn rename(store: &Store, id: String, name: String) -> Result<(), String> {
    let name = name.trim().to_string();
    if name.is_empty() {
        return Err("Name is required".into());
    }
    store.with(|conn| {
        conn.execute(
            "UPDATE sessions SET name = ?2, updated_at = ?3 WHERE id = ?1",
            params![id, name, now_millis()],
        )
    })?;
    Ok(())
}

pub fn delete(store: &Store, id: String) -> Result<(), String> {
    store.with(|conn| conn.execute("DELETE FROM sessions WHERE id = ?1", params![id]))?;
    Ok(())
}

pub fn get_blocks(store: &Store, id: String) -> Result<String, String> {
    store.with(|conn| {
        conn.prepare_cached("SELECT blocks_json FROM sessions WHERE id = ?1")?
            .query_row(params![id], |row| row.get::<_, String>(0))
    })
}

pub fn set_blocks(store: &Store, id: String, blocks_json: String) -> Result<(), String> {
    store.with(|conn| {
        conn.prepare_cached(
            "UPDATE sessions SET blocks_json = ?2, updated_at = ?3 WHERE id = ?1",
        )?
        .execute(params![id, blocks_json, now_millis()])
    })?;
    Ok(())
}

pub fn set_provider_session(
    store: &Store,
    id: String,
    provider_session_id: String,
) -> Result<(), String> {
    store.with(|conn| {
        conn.prepare_cached(
            "UPDATE sessions SET provider_session_id = ?2, updated_at = ?3 WHERE id = ?1",
        )?
        .execute(params![id, provider_session_id, now_millis()])
    })?;
    Ok(())
}

/// The runtime owns this; the UI only renders whatever the last writer left.
pub fn set_status(store: &Store, id: String, status: String) -> Result<(), String> {
    const KNOWN: [&str; 5] = ["idle", "working", "needs-input", "done", "error"];
    if !KNOWN.contains(&status.as_str()) {
        return Err(format!("Unknown session status: {status}"));
    }
    store.with(|conn| {
        conn.prepare_cached("UPDATE sessions SET status = ?2 WHERE id = ?1")?
            .execute(params![id, status])
    })?;
    Ok(())
}

pub fn reorder(store: &Store, ids: Vec<String>) -> Result<(), String> {
    store.with(|conn| set_order(conn, "sessions", &ids))
}
