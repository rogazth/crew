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
        conn.prepare_cached("UPDATE sessions SET status = ?2, updated_at = ?3 WHERE id = ?1")?
            .execute(params![id, status, now_millis()])
    })?;
    Ok(())
}

/// A turn that already started must keep its status, so only a finished one is cleared.
pub fn mark_read(store: &Store, id: String) -> Result<(), String> {
    store.with(|conn| {
        conn.prepare_cached("UPDATE sessions SET status = 'idle' WHERE id = ?1 AND status = 'done'")?
            .execute(params![id])
    })?;
    Ok(())
}

pub fn reorder(store: &Store, ids: Vec<String>) -> Result<(), String> {
    store.with(|conn| set_order(conn, "sessions", &ids))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn world() -> (Store, String) {
        let dir = std::env::temp_dir().join(format!("crew-session-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).expect("dir");
        let store = Store::open(dir.join("crew.sqlite3")).expect("store");
        let root = std::env::temp_dir().join(uuid::Uuid::new_v4().to_string());
        std::fs::create_dir_all(&root).expect("root");
        let workspace = crate::workspace::create(&store, "w".into(), root.to_string_lossy().into())
            .expect("workspace");
        (store, workspace.id)
    }

    fn agent(store: &Store, workspace: &str, name: &str, autonomy: &str) -> Result<Session, String> {
        create(
            store,
            workspace.to_string(),
            "agent".into(),
            name.into(),
            "claude".into(),
            "m".into(),
            "".into(),
            autonomy.into(),
        )
    }

    #[test]
    fn an_agent_needs_a_name_and_a_kind_crew_knows() {
        let (store, workspace) = world();
        assert!(agent(&store, &workspace, "   ", "ask").is_err_and(|e| e.contains("Name is required")));
        let wrong_kind = create(
            &store,
            workspace.clone(),
            "robot".into(),
            "Planner".into(),
            "claude".into(),
            "m".into(),
            "".into(),
            "ask".into(),
        );
        assert!(wrong_kind.is_err_and(|e| e.contains("Unknown session kind")));
    }

    /// Anything but "full" is "ask": a typo in autonomy must not be the thing
    /// that lets an agent run commands unattended.
    #[test]
    fn autonomy_falls_back_to_asking() {
        let (store, workspace) = world();
        assert_eq!(agent(&store, &workspace, "A", "full").unwrap().autonomy, "full");
        assert_eq!(agent(&store, &workspace, "B", "ask").unwrap().autonomy, "ask");
        assert_eq!(agent(&store, &workspace, "C", "FULL").unwrap().autonomy, "ask");
        assert_eq!(agent(&store, &workspace, "D", "").unwrap().autonomy, "ask");
    }

    /// The runtime owns status. A value the UI invented would render as nothing
    /// and, worse, read as "not working" to everything that asks.
    #[test]
    fn reading_clears_only_a_finished_turn_and_keeps_its_place() {
        let (store, workspace) = world();
        let made = agent(&store, &workspace, "Planner", "ask").expect("agent");
        set_status(&store, made.id.clone(), "done".into()).expect("done");
        let finished = get(&store, made.id.clone()).unwrap().unwrap().updated_at;
        mark_read(&store, made.id.clone()).expect("read");
        let read = get(&store, made.id.clone()).unwrap().unwrap();
        assert_eq!((read.status.as_str(), read.updated_at), ("idle", finished));
        set_status(&store, made.id.clone(), "working".into()).expect("working");
        mark_read(&store, made.id.clone()).expect("read");
        assert_eq!(get(&store, made.id).unwrap().unwrap().status, "working");
    }

    #[test]
    fn only_the_statuses_the_runtime_writes_are_accepted() {
        let (store, workspace) = world();
        let made = agent(&store, &workspace, "Planner", "ask").expect("agent");
        for status in ["idle", "working", "needs-input", "done", "error"] {
            set_status(&store, made.id.clone(), status.into()).expect(status);
        }
        assert!(set_status(&store, made.id.clone(), "busy".into()).is_err());
        assert_eq!(get(&store, made.id).unwrap().unwrap().status, "error");
    }

    #[test]
    fn a_session_lists_only_in_its_own_workspace() {
        let (store, workspace) = world();
        let other = {
            let root = std::env::temp_dir().join(uuid::Uuid::new_v4().to_string());
            std::fs::create_dir_all(&root).expect("root");
            crate::workspace::create(&store, "other".into(), root.to_string_lossy().into())
                .expect("workspace")
                .id
        };
        agent(&store, &workspace, "Planner", "ask").expect("agent");
        agent(&store, &other, "Stranger", "ask").expect("agent");

        let names: Vec<String> = list(&store, workspace).unwrap().into_iter().map(|s| s.name).collect();
        assert_eq!(names, vec!["Planner"]);
        assert_eq!(list_all(&store).unwrap().len(), 2, "the sweep missed a workspace");
    }

    #[test]
    fn deleting_a_workspace_takes_its_sessions_with_it() {
        let (store, workspace) = world();
        let made = agent(&store, &workspace, "Planner", "ask").expect("agent");

        crate::workspace::delete(&store, workspace).expect("delete");

        assert!(get(&store, made.id).unwrap().is_none(), "an orphaned session survived");
    }
}
