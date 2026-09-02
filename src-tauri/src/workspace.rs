use rusqlite::params;
use serde::{Deserialize, Serialize};
use tauri::State;

use crate::store::{now_millis, Store};

const ACTIVE_WORKSPACE_KEY: &str = "active_workspace_id";

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Workspace {
    pub id: String,
    pub name: String,
    pub path: String,
    pub created_at: i64,
}

#[tauri::command]
pub fn workspace_list(store: State<Store>) -> Result<Vec<Workspace>, String> {
    store.with(|conn| {
        let mut stmt = conn.prepare(
            "SELECT id, name, path, created_at FROM workspaces ORDER BY sort_order ASC, created_at ASC",
        )?;
        let rows = stmt.query_map([], |row| {
            Ok(Workspace {
                id: row.get(0)?,
                name: row.get(1)?,
                path: row.get(2)?,
                created_at: row.get(3)?,
            })
        })?;
        rows.collect()
    })
}

#[tauri::command]
pub fn workspace_create(
    store: State<Store>,
    name: String,
    path: String,
) -> Result<Workspace, String> {
    let name = name.trim().to_string();
    if name.is_empty() {
        return Err("Workspace name is required".into());
    }
    if !std::path::Path::new(&path).is_dir() {
        return Err(format!("{path}: Not a directory"));
    }

    let workspace = Workspace {
        id: uuid::Uuid::new_v4().to_string(),
        name,
        path,
        created_at: now_millis(),
    };

    let existing: Option<String> = store.with(|conn| {
        conn.query_row(
            "SELECT name FROM workspaces WHERE path = ?1",
            params![workspace.path],
            |row| row.get(0),
        )
        .map(Some)
        .or_else(|err| match err {
            rusqlite::Error::QueryReturnedNoRows => Ok(None),
            other => Err(other),
        })
    })?;
    if let Some(name) = existing {
        return Err(format!("Already open as \"{name}\""));
    }

    store.with(|conn| {
        conn.execute(
            "INSERT INTO workspaces (id, name, path, created_at, sort_order) VALUES (?1, ?2, ?3, ?4, ?5)",
            params![
                workspace.id,
                workspace.name,
                workspace.path,
                workspace.created_at,
                workspace.created_at
            ],
        )
    })?;

    Ok(workspace)
}

#[tauri::command]
pub fn workspace_rename(store: State<Store>, id: String, name: String) -> Result<(), String> {
    let name = name.trim().to_string();
    if name.is_empty() {
        return Err("Workspace name is required".into());
    }
    store.with(|conn| {
        conn.execute(
            "UPDATE workspaces SET name = ?2 WHERE id = ?1",
            params![id, name],
        )
    })?;
    Ok(())
}

#[tauri::command]
pub fn workspace_delete(store: State<Store>, id: String) -> Result<(), String> {
    store.with(|conn| conn.execute("DELETE FROM workspaces WHERE id = ?1", params![id]))?;
    Ok(())
}

#[tauri::command]
pub fn workspace_reorder(store: State<Store>, ids: Vec<String>) -> Result<(), String> {
    store.with(|conn| {
        for (index, id) in ids.iter().enumerate() {
            conn.execute(
                "UPDATE workspaces SET sort_order = ?2 WHERE id = ?1",
                params![id, index as i64],
            )?;
        }
        Ok(())
    })
}

#[tauri::command]
pub fn active_workspace_get(store: State<Store>) -> Result<Option<String>, String> {
    store.with(|conn| {
        conn.query_row(
            "SELECT value FROM app_state WHERE key = ?1",
            params![ACTIVE_WORKSPACE_KEY],
            |row| row.get::<_, String>(0),
        )
        .map(Some)
        .or_else(|err| match err {
            rusqlite::Error::QueryReturnedNoRows => Ok(None),
            other => Err(other),
        })
    })
}

#[tauri::command]
pub fn active_workspace_set(store: State<Store>, id: Option<String>) -> Result<(), String> {
    store.with(|conn| match &id {
        Some(value) => conn.execute(
            "INSERT INTO app_state (key, value) VALUES (?1, ?2)
             ON CONFLICT(key) DO UPDATE SET value = excluded.value",
            params![ACTIVE_WORKSPACE_KEY, value],
        ),
        None => conn.execute(
            "DELETE FROM app_state WHERE key = ?1",
            params![ACTIVE_WORKSPACE_KEY],
        ),
    })?;
    Ok(())
}
