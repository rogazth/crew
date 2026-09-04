use rusqlite::params;
use serde::{Deserialize, Serialize};
use tauri::State;

use crate::session::{row_to_session, Session, SESSION_COLUMNS};
use crate::store::{now_millis, Store};

/// A standing order for one agent. `schedule` and `runs_json` are JSON the UI
/// owns; Rust only stores the next due time and hands the rows back.
#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Routine {
    pub id: String,
    pub session_id: String,
    pub name: String,
    pub enabled: bool,
    pub prompt: String,
    pub schedule: String,
    pub last_run_at: Option<i64>,
    pub next_run_at: Option<i64>,
    pub runs_json: String,
    /// Session that set it up when it was an agent, not the user; the wake prompt names it.
    pub created_by: Option<String>,
}

/// What the scheduler needs to fire a run, and the routines screen to list one,
/// without another round trip.
#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct ScheduledRoutine {
    pub routine: Routine,
    pub session: Session,
    pub cwd: String,
}

const ROUTINE_COLUMNS: &str =
    "r.id, r.session_id, r.name, r.enabled, r.prompt, r.schedule, r.last_run_at, r.next_run_at, r.runs_json, r.created_by";
const ROUTINE_COLUMN_COUNT: usize = 10;

fn row_to_routine(row: &rusqlite::Row, offset: usize) -> rusqlite::Result<Routine> {
    Ok(Routine {
        id: row.get(offset)?,
        session_id: row.get(offset + 1)?,
        name: row.get(offset + 2)?,
        enabled: row.get::<_, i64>(offset + 3)? != 0,
        prompt: row.get(offset + 4)?,
        schedule: row.get(offset + 5)?,
        last_run_at: row.get(offset + 6)?,
        next_run_at: row.get(offset + 7)?,
        runs_json: row.get(offset + 8)?,
        created_by: row.get(offset + 9)?,
    })
}

pub fn list_for_session(store: &Store, session_id: String) -> Result<Vec<Routine>, String> {
    store.with(|conn| {
        let mut stmt = conn.prepare_cached(&format!(
            "SELECT {ROUTINE_COLUMNS} FROM routines r WHERE r.session_id = ?1 ORDER BY r.created_at"
        ))?;
        let rows = stmt.query_map(params![session_id], |row| row_to_routine(row, 0))?;
        rows.collect()
    })
}

pub fn list(store: &Store) -> Result<Vec<ScheduledRoutine>, String> {
    store.with(|conn| {
        let sql = format!(
            "SELECT {ROUTINE_COLUMNS}, {SESSION_COLUMNS}, w.path
             FROM routines r
             JOIN sessions s ON s.id = r.session_id
             JOIN workspaces w ON w.id = s.workspace_id
             ORDER BY r.created_at"
        );
        let mut stmt = conn.prepare_cached(&sql)?;
        let rows = stmt.query_map([], |row| {
            let routine = row_to_routine(row, 0)?;
            let session = row_to_session(row, ROUTINE_COLUMN_COUNT)?;
            let cwd: String = row.get(ROUTINE_COLUMN_COUNT + 13)?;
            Ok(ScheduledRoutine {
                routine,
                session,
                cwd,
            })
        })?;
        rows.collect()
    })
}

#[allow(clippy::too_many_arguments)]
pub fn upsert(
    store: &Store,
    id: Option<String>,
    session_id: String,
    name: String,
    enabled: bool,
    prompt: String,
    schedule: String,
    next_run_at: Option<i64>,
    created_by: Option<String>,
) -> Result<Routine, String> {
    let now = now_millis();
    let id = id.unwrap_or_else(|| uuid::Uuid::new_v4().to_string());
    store.with(|conn| {
        conn.execute(
            "INSERT INTO routines
               (id, session_id, name, enabled, prompt, schedule, next_run_at, created_by, created_at, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?9, ?8, ?8)
             ON CONFLICT(id) DO UPDATE SET
               name = excluded.name, enabled = excluded.enabled, prompt = excluded.prompt,
               schedule = excluded.schedule, next_run_at = excluded.next_run_at,
               created_by = COALESCE(routines.created_by, excluded.created_by),
               updated_at = excluded.updated_at",
            params![id, session_id, name, enabled, prompt, schedule, next_run_at, now, created_by],
        )?;
        conn.prepare_cached(&format!("SELECT {ROUTINE_COLUMNS} FROM routines r WHERE r.id = ?1"))?
            .query_row(params![id], |row| row_to_routine(row, 0))
    })
}

pub fn delete(store: &Store, id: String) -> Result<(), String> {
    store.with(|conn| conn.execute("DELETE FROM routines WHERE id = ?1", params![id]))?;
    Ok(())
}

pub fn mark_run(
    store: &Store,
    id: String,
    last_run_at: i64,
    next_run_at: Option<i64>,
    runs_json: String,
) -> Result<(), String> {
    store.with(|conn| {
        conn.execute(
            "UPDATE routines SET last_run_at = ?2, next_run_at = ?3, runs_json = ?4, updated_at = ?5
             WHERE id = ?1",
            params![id, last_run_at, next_run_at, runs_json, now_millis()],
        )
    })?;
    Ok(())
}

#[tauri::command(async)]
pub fn routine_list_for_session(
    store: State<Store>,
    session_id: String,
) -> Result<Vec<Routine>, String> {
    list_for_session(&store, session_id)
}

#[tauri::command(async)]
pub fn routine_list(store: State<Store>) -> Result<Vec<ScheduledRoutine>, String> {
    list(&store)
}

#[tauri::command(async)]
#[allow(clippy::too_many_arguments)]
pub fn routine_upsert(
    store: State<Store>,
    id: Option<String>,
    session_id: String,
    name: String,
    enabled: bool,
    prompt: String,
    schedule: String,
    next_run_at: Option<i64>,
    created_by: Option<String>,
) -> Result<Routine, String> {
    upsert(&store, id, session_id, name, enabled, prompt, schedule, next_run_at, created_by)
}

#[tauri::command(async)]
pub fn routine_delete(store: State<Store>, id: String) -> Result<(), String> {
    delete(&store, id)
}

#[tauri::command(async)]
pub fn routine_mark_run(
    store: State<Store>,
    id: String,
    last_run_at: i64,
    next_run_at: Option<i64>,
    runs_json: String,
) -> Result<(), String> {
    mark_run(&store, id, last_run_at, next_run_at, runs_json)
}
