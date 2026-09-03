use rusqlite::params;
use serde::{Deserialize, Serialize};
use tauri::State;

use crate::store::{now_millis, Store};

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
    /// "idle" | "working" | "needs-input" | "error". Set by the runtime, never by the UI.
    pub status: String,
    pub created_at: i64,
    pub updated_at: i64,
}

const SELECT: &str = "SELECT id, workspace_id, kind, name, provider, model,
                             provider_session_id, description, notifications,
                             status, created_at, updated_at
                      FROM sessions";

fn row_to_session(row: &rusqlite::Row) -> rusqlite::Result<Session> {
    Ok(Session {
        id: row.get(0)?,
        workspace_id: row.get(1)?,
        kind: row.get(2)?,
        name: row.get(3)?,
        provider: row.get(4)?,
        model: row.get(5)?,
        provider_session_id: row.get(6)?,
        description: row.get(7)?,
        notifications: row.get::<_, i64>(8)? != 0,
        status: row.get(9)?,
        created_at: row.get(10)?,
        updated_at: row.get(11)?,
    })
}

#[tauri::command]
pub fn session_list(store: State<Store>, workspace_id: String) -> Result<Vec<Session>, String> {
    store.with(|conn| {
        let sql = format!("{SELECT} WHERE workspace_id = ?1 ORDER BY sort_order ASC, created_at ASC");
        let mut stmt = conn.prepare(&sql)?;
        let rows = stmt.query_map(params![workspace_id], row_to_session)?;
        rows.collect()
    })
}

#[tauri::command]
pub fn session_create(
    store: State<Store>,
    workspace_id: String,
    kind: String,
    name: String,
    provider: String,
    model: String,
    description: String,
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
        status: "idle".into(),
        created_at: now,
        updated_at: now,
    };

    store.with(|conn| {
        conn.execute(
            "INSERT INTO sessions
               (id, workspace_id, kind, name, provider, model, description,
                notifications, created_at, updated_at, sort_order)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)",
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
                session.created_at
            ],
        )
    })?;

    Ok(session)
}

#[tauri::command]
pub fn session_update(
    store: State<Store>,
    id: String,
    name: String,
    provider: String,
    model: String,
    description: String,
    notifications: bool,
) -> Result<(), String> {
    let name = name.trim().to_string();
    if name.is_empty() {
        return Err("Name is required".into());
    }
    store.with(|conn| {
        conn.execute(
            "UPDATE sessions
             SET name = ?2, provider = ?3, model = ?4, description = ?5,
                 notifications = ?6, updated_at = ?7
             WHERE id = ?1",
            params![id, name, provider, model, description, notifications, now_millis()],
        )
    })?;
    Ok(())
}

#[tauri::command]
pub fn session_rename(store: State<Store>, id: String, name: String) -> Result<(), String> {
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

#[tauri::command]
pub fn session_delete(store: State<Store>, id: String) -> Result<(), String> {
    store.with(|conn| conn.execute("DELETE FROM sessions WHERE id = ?1", params![id]))?;
    Ok(())
}

/// The runtime owns this; the UI only renders whatever the last writer left.
#[tauri::command]
pub fn session_set_status(store: State<Store>, id: String, status: String) -> Result<(), String> {
    const KNOWN: [&str; 5] = ["idle", "working", "needs-input", "done", "error"];
    if !KNOWN.contains(&status.as_str()) {
        return Err(format!("Unknown session status: {status}"));
    }
    store.with(|conn| {
        conn.execute(
            "UPDATE sessions SET status = ?2 WHERE id = ?1",
            params![id, status],
        )
    })?;
    Ok(())
}

#[tauri::command]
pub fn session_reorder(store: State<Store>, ids: Vec<String>) -> Result<(), String> {
    store.with(|conn| {
        for (index, id) in ids.iter().enumerate() {
            conn.execute(
                "UPDATE sessions SET sort_order = ?2 WHERE id = ?1",
                params![id, index as i64],
            )?;
        }
        Ok(())
    })
}
