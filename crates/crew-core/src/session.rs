use rusqlite::{params, OptionalExtension};
use serde::{Deserialize, Serialize};

use crate::claude_title;
use crate::provider_session;
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
                 notifications = ?6, updated_at = ?7, autonomy = ?8,
                 provider_session_id = CASE WHEN provider = ?3 THEN provider_session_id END,
                 provider_title = CASE WHEN provider = ?3 THEN provider_title END
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

/// Adopts the name the provider gave the session each time it changes: its
/// first title, a `/rename`, a fresh one after `/clear`. A name typed in Crew
/// stands until the provider comes up with another. Returns the adopted name.
pub fn sync_title(store: &Store, id: String) -> Result<Option<String>, String> {
    sync_title_in(store, id, claude_title::transcript_path)
}

/// `sync_title` with the place Claude keeps a transcript passed in: it is
/// under HOME, which a test must not read.
fn sync_title_in(
    store: &Store,
    id: String,
    claude_transcript: impl FnOnce(&str, &str) -> Option<String>,
) -> Result<Option<String>, String> {
    let row = get(store, id)?.ok_or("Session not found")?;
    if row.kind != "terminal" {
        return Ok(None);
    }
    let Some(workspace) = crate::workspace::get(store, row.workspace_id.clone())? else {
        return Ok(None);
    };
    match provider_title(&row, &workspace.path, claude_transcript) {
        Some(title) => adopt_title(store, &row, title),
        None => Ok(None),
    }
}

fn provider_title(
    row: &Session,
    cwd: &str,
    claude_transcript: impl FnOnce(&str, &str) -> Option<String>,
) -> Option<String> {
    let bound = row.provider_session_id.as_deref();
    match row.provider.as_str() {
        "claude" => claude_title::read(&claude_transcript(cwd, bound.unwrap_or(&row.id))?),
        other => provider_session::title(other, bound?),
    }
}

fn adopt_title(store: &Store, row: &Session, title: String) -> Result<Option<String>, String> {
    let last: Option<String> = store.with(|conn| {
        conn.prepare_cached("SELECT provider_title FROM sessions WHERE id = ?1")?
            .query_row(params![row.id], |r| r.get(0))
    })?;
    if last.as_deref() == Some(title.as_str()) {
        return Ok(None);
    }
    // With nothing seen yet, a name other than the placeholder may predate the
    // tracking and be one the user typed.
    let adopt = (last.is_some() || is_placeholder_name(&row.name, &row.provider)) && row.name != title;
    store.with(|conn| {
        if adopt {
            conn.execute(
                "UPDATE sessions SET provider_title = ?2, name = ?2, updated_at = ?3 WHERE id = ?1",
                params![row.id, title, now_millis()],
            )
        } else {
            conn.execute("UPDATE sessions SET provider_title = ?2 WHERE id = ?1", params![row.id, title])
        }
    })?;
    Ok(adopt.then_some(title))
}

/// `claude`, `claude 2`, …: what Crew names a session before its provider does.
fn is_placeholder_name(name: &str, provider: &str) -> bool {
    match name.strip_prefix(provider) {
        Some("") => true,
        Some(rest) => rest
            .strip_prefix(' ')
            .is_some_and(|n| !n.is_empty() && n.bytes().all(|b| b.is_ascii_digit())),
        None => false,
    }
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

/// Provider sessions some Crew session other than `except` is bound to.
pub fn claimed_provider_sessions(store: &Store, except: &str) -> Result<Vec<String>, String> {
    store.with(|conn| {
        conn.prepare_cached(
            "SELECT provider_session_id FROM sessions
             WHERE provider_session_id IS NOT NULL AND id != ?1",
        )?
        .query_map(params![except], |row| row.get(0))?
        .collect()
    })
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

/// A terminal nobody named and nothing was said in: dropping it loses nothing.
pub fn is_disposable(store: &Store, id: String) -> Result<bool, String> {
    let Some(session) = get(store, id)? else { return Ok(false) };
    let Some(workspace) = crate::workspace::get(store, session.workspace_id.clone())? else {
        return Ok(false);
    };
    Ok(disposable(&session, &workspace.path))
}

/// Deletes the disposable terminals no tab holds: the ones closed before the
/// window checked, or left behind by a crash. A tab restored on launch still
/// needs its row, so those wait for the tab to close.
pub fn sweep_disposable(store: &Store) -> Result<usize, String> {
    let (terminals, tabs) = store.with(|conn| {
        let terminals = conn
            .prepare(&format!(
                "SELECT {SESSION_COLUMNS}, w.path FROM sessions s
                 JOIN workspaces w ON w.id = s.workspace_id
                 WHERE s.kind = 'terminal'"
            ))?
            .query_map([], |row| Ok((row_to_session(row, 0)?, row.get::<_, String>(13)?)))?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        let tabs = conn
            .prepare("SELECT value FROM app_state WHERE key LIKE 'tabs:%'")?
            .query_map([], |row| row.get::<_, String>(0))?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        Ok((terminals, tabs))
    })?;
    let open: Vec<String> = tabs.iter().flat_map(|raw| tab_sessions(raw)).collect();
    let mut swept = 0;
    for (session, cwd) in terminals {
        if !open.contains(&session.id) && disposable(&session, &cwd) {
            delete(store, session.id)?;
            swept += 1;
        }
    }
    Ok(swept)
}

fn disposable(session: &Session, cwd: &str) -> bool {
    session.kind == "terminal"
        && is_derived_name(&session.name, &session.provider)
        && !provider_session::has_conversation(
            &session.provider,
            &session.id,
            session.provider_session_id.as_deref(),
            cwd,
        )
}

/// Mirrors `isDerivedSessionName` in the window: claude, claude 2, …
fn is_derived_name(name: &str, base: &str) -> bool {
    match name.strip_prefix(base) {
        Some("") => true,
        Some(rest) => rest
            .strip_prefix(' ')
            .is_some_and(|n| !n.is_empty() && n.bytes().all(|b| b.is_ascii_digit())),
        None => false,
    }
}

/// The session ids in a `tabs:<workspace>` entry the window saved. One it can
/// no longer parse holds nothing, same as the window reads it.
fn tab_sessions(raw: &str) -> Vec<String> {
    let Ok(state) = serde_json::from_str::<serde_json::Value>(raw) else { return Vec::new() };
    state
        .get("tabs")
        .and_then(|tabs| tabs.as_array())
        .into_iter()
        .flatten()
        .filter_map(|tab| tab.get("sessionId")?.as_str().map(str::to_string))
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_support::{temp_dir, temp_store};

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

    fn adopt(store: &Store, id: &str, title: &str) -> Option<String> {
        let row = get(store, id.into()).expect("get").expect("row");
        adopt_title(store, &row, title.into()).expect("adopt")
    }

    fn name_of(store: &Store, id: &str) -> String {
        get(store, id.into()).expect("get").expect("row").name
    }

    #[test]
    fn each_new_provider_title_is_adopted() {
        let (store, workspace) = world();
        let s = terminal(&store, &workspace, "claude 3", "claude");
        assert_eq!(adopt(&store, &s.id, "Generated").as_deref(), Some("Generated"));
        assert_eq!(adopt(&store, &s.id, "Generated"), None);
        rename(&store, s.id.clone(), "Mine".into()).expect("rename");
        assert_eq!(adopt(&store, &s.id, "Generated"), None);
        assert_eq!(name_of(&store, &s.id), "Mine");
        assert_eq!(adopt(&store, &s.id, "Renamed in claude").as_deref(), Some("Renamed in claude"));
    }

    #[test]
    fn a_name_from_before_tracking_stands_until_the_title_changes() {
        let (store, workspace) = world();
        let s = terminal(&store, &workspace, "Typed by hand", "claude");
        assert_eq!(adopt(&store, &s.id, "Generated"), None);
        assert_eq!(name_of(&store, &s.id), "Typed by hand");
        assert_eq!(adopt(&store, &s.id, "After /clear").as_deref(), Some("After /clear"));
    }

    #[test]
    fn placeholder_names_are_the_provider_and_a_number() {
        assert!(is_placeholder_name("claude", "claude"));
        assert!(is_placeholder_name("claude 13", "claude"));
        assert!(!is_placeholder_name("claude 1a", "claude"));
        assert!(!is_placeholder_name("claude 2 notes", "claude"));
        assert!(!is_placeholder_name("claude ", "claude"));
        assert!(!is_placeholder_name("claudette", "claude"));
        assert!(!is_placeholder_name("codex 2", "claude"));
    }

    #[test]
    fn switching_provider_drops_the_old_providers_session() {
        let (store, workspace) = world();
        let a = agent(&store, &workspace, "a", "ask").expect("a");
        let b = agent(&store, &workspace, "b", "ask").expect("b");
        set_provider_session(&store, a.id.clone(), "claude-1".into()).expect("bind");
        set_provider_session(&store, b.id.clone(), "claude-2".into()).expect("bind");
        assert_eq!(claimed_provider_sessions(&store, &a.id).expect("claimed"), vec!["claude-2"]);

        let edit = |provider: &str| {
            update(&store, a.id.clone(), "a".into(), provider.into(), "".into(), "".into(), true, "ask".into())
                .expect("update");
            get(&store, a.id.clone()).expect("get").expect("row").provider_session_id
        };
        assert_eq!(edit("claude").as_deref(), Some("claude-1"));
        assert_eq!(edit("codex"), None);
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

    fn terminal(store: &Store, workspace: &str, name: &str, provider: &str) -> Session {
        create(
            store,
            workspace.to_string(),
            "terminal".into(),
            name.into(),
            provider.into(),
            "m".into(),
            "".into(),
            "ask".into(),
        )
        .expect("terminal")
    }

    #[test]
    fn only_derived_names_read_as_unnamed() {
        assert!(is_derived_name("codex", "codex"));
        assert!(is_derived_name("codex 12", "codex"));
        assert!(!is_derived_name("codex 2b", "codex"));
        assert!(!is_derived_name("codex ", "codex"));
        assert!(!is_derived_name("codexer", "codex"));
        assert!(!is_derived_name("Refactor", "codex"));
    }

    #[test]
    fn the_sweep_keeps_what_was_named_spoken_in_or_open() {
        let (store, workspace) = world();
        let empty = terminal(&store, &workspace, "codex", "codex");
        let named = terminal(&store, &workspace, "Refactor", "codex");
        let spoken = terminal(&store, &workspace, "codex 2", "codex");
        set_provider_session(&store, spoken.id.clone(), "rollout".into()).expect("bind");
        let open = terminal(&store, &workspace, "codex 3", "codex");
        let unread = terminal(&store, &workspace, "grok", "grok");
        let planner = agent(&store, &workspace, "codex", "ask").expect("agent");
        crate::store::set(
            &store,
            format!("tabs:{workspace}"),
            format!(r#"{{"tabs":[{{"kind":"session","sessionId":"{}"}}],"activeId":null}}"#, open.id),
        )
        .expect("tabs");

        assert!(is_disposable(&store, empty.id.clone()).unwrap());
        assert_eq!(sweep_disposable(&store).unwrap(), 1);
        assert!(get(&store, empty.id).unwrap().is_none());
        for kept in [named.id, spoken.id, open.id, unread.id, planner.id] {
            assert!(get(&store, kept).unwrap().is_some());
        }
    }

    /// A store in its own directory, with one workspace on a folder inside it.
    fn temp_world() -> (tempfile::TempDir, Store, crate::workspace::Workspace) {
        let (dir, store) = temp_store();
        let folder = dir.path().join("project");
        std::fs::create_dir(&folder).expect("folder");
        let workspace =
            crate::workspace::create(&store, "w".into(), folder.to_string_lossy().into())
                .expect("workspace");
        (dir, store, workspace)
    }

    /// Deletes a workspace row and leaves its sessions behind, which only
    /// happens to a database written with foreign keys off.
    fn orphan(store: &Store, workspace: &str) {
        store
            .with(|conn| {
                conn.execute_batch("PRAGMA foreign_keys = OFF;")?;
                conn.execute("DELETE FROM workspaces WHERE id = ?1", params![workspace])?;
                conn.execute_batch("PRAGMA foreign_keys = ON;")
            })
            .expect("orphan");
    }

    fn names(sessions: Vec<Session>) -> Vec<String> {
        sessions.into_iter().map(|s| s.name).collect()
    }

    fn provider_title_of(store: &Store, id: &str) -> Option<String> {
        store
            .with(|conn| {
                conn.query_row("SELECT provider_title FROM sessions WHERE id = ?1", params![id], |r| {
                    r.get(0)
                })
            })
            .expect("provider_title")
    }

    #[test]
    fn the_busy_list_is_the_sessions_mid_turn_longest_waiting_first() {
        let (_dir, store, workspace) = temp_world();
        for (status, updated_at) in
            [("idle", 1), ("working", 20), ("needs-input", 10), ("done", 2), ("error", 3)]
        {
            let made = agent(&store, &workspace.id, status, "ask").expect("agent");
            set_status(&store, made.id.clone(), status.into()).expect("status");
            store
                .with(|conn| {
                    conn.execute(
                        "UPDATE sessions SET updated_at = ?2 WHERE id = ?1",
                        params![made.id, updated_at],
                    )
                })
                .expect("updated_at");
        }

        assert_eq!(names(list_busy(&store).expect("busy")), ["needs-input", "working"]);
    }

    #[test]
    fn an_update_rewrites_the_settings_and_keeps_what_the_same_provider_bound() {
        let (_dir, store, workspace) = temp_world();
        let made = agent(&store, &workspace.id, "Planner", "full").expect("agent");
        set_provider_session(&store, made.id.clone(), "p1".into()).expect("bind");
        store
            .with(|conn| {
                conn.execute(
                    "UPDATE sessions SET provider_title = 'Seen', updated_at = 0 WHERE id = ?1",
                    params![made.id],
                )
            })
            .expect("seed");

        update(
            &store,
            made.id.clone(),
            "  Architect  ".into(),
            "claude".into(),
            "opus".into(),
            "plans things".into(),
            false,
            "full".into(),
        )
        .expect("update");

        let row = get(&store, made.id.clone()).unwrap().unwrap();
        assert_eq!(
            (row.name.as_str(), row.model.as_str(), row.description.as_str(), row.autonomy.as_str()),
            ("Architect", "opus", "plans things", "full")
        );
        assert!(!row.notifications);
        assert!(row.updated_at > 0);
        assert_eq!(row.provider_session_id.as_deref(), Some("p1"));
        assert_eq!(provider_title_of(&store, &made.id).as_deref(), Some("Seen"));

        update(
            &store,
            made.id.clone(),
            "Architect".into(),
            "codex".into(),
            "gpt".into(),
            "".into(),
            true,
            "unattended".into(),
        )
        .expect("switch provider");

        let row = get(&store, made.id.clone()).unwrap().unwrap();
        assert_eq!((row.provider.as_str(), row.autonomy.as_str()), ("codex", "ask"));
        assert_eq!(row.provider_session_id, None);
        assert_eq!(provider_title_of(&store, &made.id), None);
    }

    #[test]
    fn an_update_without_a_name_changes_nothing() {
        let (_dir, store, workspace) = temp_world();
        let made = agent(&store, &workspace.id, "Planner", "ask").expect("agent");

        let empty = update(
            &store,
            made.id.clone(),
            "   ".into(),
            "codex".into(),
            "gpt".into(),
            "".into(),
            false,
            "full".into(),
        );

        assert!(empty.is_err_and(|e| e.contains("Name is required")));
        let row = get(&store, made.id).unwrap().unwrap();
        assert_eq!((row.name.as_str(), row.provider.as_str()), ("Planner", "claude"));
    }

    #[test]
    fn a_rename_is_trimmed_and_an_empty_one_changes_nothing() {
        let (_dir, store, workspace) = temp_world();
        let made = agent(&store, &workspace.id, "Planner", "ask").expect("agent");

        rename(&store, made.id.clone(), "  Coder  ".into()).expect("rename");
        assert_eq!(name_of(&store, &made.id), "Coder");

        let empty = rename(&store, made.id.clone(), "   ".into());
        assert!(empty.is_err_and(|e| e.contains("Name is required")));
        assert_eq!(name_of(&store, &made.id), "Coder");

        rename(&store, "nobody".into(), "Ghost".into()).expect("renaming nothing is not an error");
        assert_eq!(names(list(&store, workspace.id).unwrap()), ["Coder"]);
    }

    #[test]
    fn reorder_lists_sessions_in_the_order_given_and_passes_over_unknown_ids() {
        let (_dir, store, workspace) = temp_world();
        let ids: Vec<String> = ["a", "b", "c"]
            .iter()
            .map(|name| agent(&store, &workspace.id, name, "ask").expect("agent").id)
            .collect();

        reorder(&store, vec![ids[2].clone(), "gone".into(), ids[0].clone(), ids[1].clone()])
            .expect("reorder");

        assert_eq!(names(list(&store, workspace.id).unwrap()), ["c", "a", "b"]);
    }

    /// What keeps a provider session to one Crew session: discovery skips every
    /// id another session holds, so each holder has to be listed, and a
    /// session's own binding is never held against it.
    #[test]
    fn every_provider_session_another_crew_session_holds_is_claimed() {
        let (_dir, store, workspace) = temp_world();
        let a = agent(&store, &workspace.id, "a", "ask").expect("a").id;
        let b = agent(&store, &workspace.id, "b", "ask").expect("b").id;
        let c = agent(&store, &workspace.id, "c", "ask").expect("c").id;
        let claimed = |except: &str| {
            let mut ids = claimed_provider_sessions(&store, except).expect("claimed");
            ids.sort();
            ids
        };
        assert!(claimed(&c).is_empty());

        set_provider_session(&store, a.clone(), "p1".into()).expect("bind a");
        set_provider_session(&store, b.clone(), "p2".into()).expect("bind b");
        assert_eq!(claimed(&a), ["p2"]);
        assert_eq!(claimed(&c), ["p1", "p2"]);

        set_provider_session(&store, a.clone(), "p3".into()).expect("rebind a");
        assert_eq!(claimed(&b), ["p3"], "the session a let go of is still held");

        delete(&store, b).expect("delete b");
        set_provider_session(&store, "nobody".into(), "p9".into()).expect("binding nothing");
        assert!(claimed(&a).is_empty());
    }

    /// An error must not read as an empty answer: nothing claimed would let
    /// discovery hand one provider session to two Crew sessions, and nothing
    /// busy would leave a turn spinning after a crash.
    #[test]
    fn a_read_that_fails_is_an_error_never_an_empty_list() {
        let (_dir, store, workspace) = temp_world();
        let made = agent(&store, &workspace.id, "a", "ask").expect("agent");
        store
            .with(|conn| conn.execute_batch("ALTER TABLE sessions DROP COLUMN provider_session_id;"))
            .expect("break the schema");

        assert!(claimed_provider_sessions(&store, "other").is_err());
        assert!(list_busy(&store).is_err());
        assert!(set_provider_session(&store, made.id, "p1".into()).is_err());
    }

    #[test]
    fn syncing_the_title_of_a_session_that_is_gone_is_an_error() {
        let (_dir, store, _workspace) = temp_world();

        let gone = sync_title(&store, "nobody".into());

        assert!(gone.is_err_and(|e| e.contains("Session not found")));
    }

    #[test]
    fn a_session_with_no_readable_provider_title_keeps_its_name() {
        let (_dir, store, workspace) = temp_world();
        let planner = agent(&store, &workspace.id, "claude", "ask").expect("agent");
        let unbound = terminal(&store, &workspace.id, "codex", "codex");
        let unknown = terminal(&store, &workspace.id, "grok", "grok");
        set_provider_session(&store, unknown.id.clone(), "g1".into()).expect("bind");
        let homeless = {
            let other = temp_dir();
            let folder = other.path().to_string_lossy().into_owned();
            let elsewhere = crate::workspace::create(&store, "gone".into(), folder).expect("ws");
            let made = terminal(&store, &elsewhere.id, "claude", "claude");
            orphan(&store, &elsewhere.id);
            made
        };

        for session in [&planner, &unbound, &unknown, &homeless] {
            assert_eq!(sync_title(&store, session.id.clone()).expect("sync"), None, "{}", session.name);
            assert_eq!(name_of(&store, &session.id), session.name);
        }
    }

    /// Claude keeps a conversation under the id it was bound to, or under the
    /// Crew id before anything is bound, and the title in it becomes the name.
    #[test]
    fn a_claude_terminal_takes_the_title_from_the_transcript_it_is_bound_to() {
        let (dir, store, workspace) = temp_world();
        let made = terminal(&store, &workspace.id, "claude", "claude");
        let transcripts = dir.path().join("transcripts");
        std::fs::create_dir(&transcripts).expect("transcripts");
        let transcript = |id: &str, record: &str| {
            std::fs::write(transcripts.join(format!("{id}.jsonl")), format!("{record}\n"))
                .expect("transcript")
        };
        transcript(&made.id, r#"{"type":"ai-title","aiTitle":"Fix the build"}"#);
        transcript("after-clear", r#"{"type":"custom-title","customTitle":"Ship it"}"#);
        let located = |cwd: &str, id: &str| {
            assert_eq!(cwd, workspace.path, "looked for the transcript of another folder");
            Some(transcripts.join(format!("{id}.jsonl")).to_string_lossy().into_owned())
        };

        let first = sync_title_in(&store, made.id.clone(), located).expect("sync");
        assert_eq!(first.as_deref(), Some("Fix the build"));
        assert_eq!(name_of(&store, &made.id), "Fix the build");
        assert_eq!(sync_title_in(&store, made.id.clone(), located).expect("again"), None);

        set_provider_session(&store, made.id.clone(), "after-clear".into()).expect("bind");
        let bound = sync_title_in(&store, made.id.clone(), located).expect("sync");
        assert_eq!(bound.as_deref(), Some("Ship it"));

        set_provider_session(&store, made.id.clone(), "no-transcript".into()).expect("bind");
        assert_eq!(sync_title_in(&store, made.id.clone(), located).expect("sync"), None);
        assert_eq!(sync_title_in(&store, made.id.clone(), |_: &str, _: &str| None).expect("sync"), None);
        assert_eq!(name_of(&store, &made.id), "Ship it");
    }

    #[test]
    fn only_an_unnamed_terminal_nothing_was_said_in_is_disposable() {
        let (_dir, store, workspace) = temp_world();
        let empty = terminal(&store, &workspace.id, "codex", "codex");
        let planner = agent(&store, &workspace.id, "codex", "ask").expect("agent");
        let homeless = {
            let other = temp_dir();
            let folder = other.path().to_string_lossy().into_owned();
            let elsewhere = crate::workspace::create(&store, "gone".into(), folder).expect("ws");
            let made = terminal(&store, &elsewhere.id, "codex", "codex");
            orphan(&store, &elsewhere.id);
            made
        };

        assert!(is_disposable(&store, empty.id).expect("empty"));
        assert!(!is_disposable(&store, planner.id).expect("agent"));
        assert!(!is_disposable(&store, homeless.id).expect("no workspace"));
        assert!(!is_disposable(&store, "nobody".into()).expect("unknown"));
    }

    #[test]
    fn deleting_a_workspace_takes_its_sessions_with_it() {
        let (store, workspace) = world();
        let made = agent(&store, &workspace, "Planner", "ask").expect("agent");

        crate::workspace::delete(&store, workspace).expect("delete");

        assert!(get(&store, made.id).unwrap().is_none(), "an orphaned session survived");
    }
}
