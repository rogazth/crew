use rusqlite::{params, OptionalExtension};
use serde::{Deserialize, Serialize};

use crate::store::{now_millis, read_state, set_order, write_state, Store};

const ACTIVE_WORKSPACE_KEY: &str = "active_workspace_id";

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Workspace {
    pub id: String,
    pub name: String,
    pub path: String,
    pub created_at: i64,
}

pub fn list(store: &Store) -> Result<Vec<Workspace>, String> {
    store.with(|conn| {
        let mut stmt = conn.prepare_cached(
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

fn row_to_workspace(row: &rusqlite::Row) -> rusqlite::Result<Workspace> {
    Ok(Workspace {
        id: row.get(0)?,
        name: row.get(1)?,
        path: row.get(2)?,
        created_at: row.get(3)?,
    })
}

pub fn get(store: &Store, id: String) -> Result<Option<Workspace>, String> {
    store.with(|conn| {
        conn.prepare_cached("SELECT id, name, path, created_at FROM workspaces WHERE id = ?1")?
            .query_row(params![id], row_to_workspace)
            .optional()
    })
}

pub fn create(store: &Store, name: String, path: String) -> Result<Workspace, String> {
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
        .optional()
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

pub fn rename(store: &Store, id: String, name: String) -> Result<(), String> {
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

pub fn delete(store: &Store, id: String) -> Result<(), String> {
    store.with(|conn| conn.execute("DELETE FROM workspaces WHERE id = ?1", params![id]))?;
    Ok(())
}

pub fn reorder(store: &Store, ids: Vec<String>) -> Result<(), String> {
    store.with(|conn| set_order(conn, "workspaces", &ids))
}

pub fn active_get(store: &Store) -> Result<Option<String>, String> {
    store.with(|conn| read_state(conn, ACTIVE_WORKSPACE_KEY))
}

pub fn active_set(store: &Store, id: Option<String>) -> Result<(), String> {
    store.with(|conn| write_state(conn, ACTIVE_WORKSPACE_KEY, id.as_deref()))
}
