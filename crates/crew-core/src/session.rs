use std::path::Path;

use rusqlite::{params, OptionalExtension};
use serde::{Deserialize, Serialize};

use crate::claude_title;
use crate::provider_session::{self, ClaudeBinds, ClaudeDirs};
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
    /// Absolute path of the git worktree it runs in; `None` is the workspace
    /// folder, the main checkout.
    pub worktree: Option<String>,
    pub created_at: i64,
    pub updated_at: i64,
}

/// Aliased on `s`, so a join can read a session at an offset and whatever it
/// joined at `SESSION_COLUMN_COUNT`.
pub const SESSION_COLUMNS: &str = "s.id, s.workspace_id, s.kind, s.name, s.provider, s.model,
                                   s.provider_session_id, s.description, s.notifications,
                                   s.status, s.created_at, s.updated_at, s.autonomy, s.worktree";
pub const SESSION_COLUMN_COUNT: usize = 14;

const SELECT_BY_WORKSPACE: &str = "SELECT id, workspace_id, kind, name, provider, model,
                                          provider_session_id, description, notifications,
                                          status, created_at, updated_at, autonomy, worktree
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
        worktree: row.get(at + 13)?,
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
                    status, created_at, updated_at, autonomy, worktree
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

/// The folder a session works in: its worktree while that folder exists, or
/// else its workspace's. A worktree removed outside Crew keeps its path on the
/// row: made again, it is the session's again.
pub fn cwd(store: &Store, session: &Session) -> Result<String, String> {
    if let Some(worktree) = session.worktree.as_deref().filter(|path| Path::new(path).is_dir()) {
        return Ok(worktree.to_string());
    }
    crate::workspace::get(store, session.workspace_id.clone())?
        .map(|workspace| workspace.path)
        .ok_or_else(|| "Workspace not found".to_string())
}

/// `cwd` for a row read along with its workspace's folder.
pub fn folder(worktree: Option<&str>, workspace: String) -> String {
    match worktree {
        Some(path) if Path::new(path).is_dir() => path.to_string(),
        _ => workspace,
    }
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
    create_in_worktree(store, workspace_id, kind, name, provider, model, description, autonomy, None)
}

#[allow(clippy::too_many_arguments)]
pub fn create_in_worktree(
    store: &Store,
    workspace_id: String,
    kind: String,
    name: String,
    provider: String,
    model: String,
    description: String,
    autonomy: String,
    worktree: Option<String>,
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
        worktree: worktree.filter(|path| !path.is_empty()),
        created_at: now,
        updated_at: now,
    };

    store.with(|conn| {
        conn.execute(
            "INSERT INTO sessions
               (id, workspace_id, kind, name, provider, model, description,
                notifications, created_at, updated_at, sort_order, autonomy, worktree)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13)",
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
                session.autonomy,
                session.worktree
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
    let row = get(store, id)?.ok_or("Session not found")?;
    if row.kind != "terminal" {
        return Ok(None);
    }
    let Ok(cwd) = cwd(store, &row) else {
        return Ok(None);
    };
    match provider_title(&row, &cwd) {
        Some(title) => adopt_title(store, &row, title),
        None => Ok(None),
    }
}

fn provider_title(row: &Session, cwd: &str) -> Option<String> {
    let bound = row.provider_session_id.as_deref();
    match row.provider.as_str() {
        "claude" => claude_title::read(&claude_title::transcript_path(cwd, bound.unwrap_or(&row.id))?),
        other => provider_session::title(other, bound?),
    }
}

fn adopt_title(store: &Store, row: &Session, title: String) -> Result<Option<String>, String> {
    let last = provider_title_of(store, &row.id)?;
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

/// The sessions that ran in a worktree about to stop existing: they would
/// otherwise start their next turn in a folder that is gone.
pub fn in_worktree(store: &Store, worktree: &str) -> Result<Vec<String>, String> {
    store.with(|conn| {
        conn.prepare_cached("SELECT id FROM sessions WHERE worktree = ?1")?
            .query_map(params![worktree], |row| row.get(0))?
            .collect()
    })
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
/// Callers follow Claude's `/clear`s first (`follow_claude`), so what is judged
/// is the conversation the CLI is in now.
pub fn is_disposable(store: &Store, id: String) -> Result<bool, String> {
    is_disposable_in(store, id, &ClaudeDirs::from_env())
}

fn is_disposable_in(store: &Store, id: String, dirs: &ClaudeDirs) -> Result<bool, String> {
    let Some(session) = get(store, id)? else { return Ok(false) };
    let Ok(cwd) = cwd(store, &session) else {
        return Ok(false);
    };
    let claimed = claimed_provider_sessions(store, &session.id)?;
    Ok(disposable(&session, &cwd, &claimed, dirs.home.as_deref()))
}

/// Deletes the disposable terminals no tab holds: the ones closed before the
/// window checked, or left behind by a crash. A tab restored on launch still
/// needs its row, so those wait for the tab to close. Every Claude terminal
/// first catches up with the `/clear`s its CLI made while nobody looked.
pub fn sweep_disposable(store: &Store) -> Result<usize, String> {
    sweep_disposable_in(store, &ClaudeDirs::from_env())
}

fn sweep_disposable_in(store: &Store, dirs: &ClaudeDirs) -> Result<usize, String> {
    let claude: Vec<String> = store.with(|conn| {
        conn.prepare("SELECT id FROM sessions WHERE kind = 'terminal' AND provider = 'claude'")?
            .query_map([], |row| row.get(0))?
            .collect()
    })?;
    for id in claude {
        follow_claude_in(store, id, dirs)?;
    }
    let (terminals, tabs) = store.with(|conn| {
        let terminals = conn
            .prepare(&format!(
                "SELECT {SESSION_COLUMNS}, w.path FROM sessions s
                 JOIN workspaces w ON w.id = s.workspace_id
                 WHERE s.kind = 'terminal'"
            ))?
            .query_map([], |row| {
                let session = row_to_session(row, 0)?;
                let cwd = folder(session.worktree.as_deref(), row.get(SESSION_COLUMN_COUNT)?);
                Ok((session, cwd))
            })?
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
        let claimed = claimed_provider_sessions(store, &session.id)?;
        if !open.contains(&session.id) && disposable(&session, &cwd, &claimed, dirs.home.as_deref()) {
            delete(store, session.id)?;
            swept += 1;
        }
    }
    Ok(swept)
}

/// What was said counts wherever it was kept: where the session works now, and
/// the worktree it worked in before that folder went away.
fn disposable(session: &Session, cwd: &str, claimed: &[String], home: Option<&Path>) -> bool {
    session.kind == "terminal"
        && is_derived_name(&session.name, &session.provider)
        && folders(session, cwd).into_iter().all(|folder| {
            !provider_session::has_conversation(
                home,
                &session.provider,
                &session.id,
                session.provider_session_id.as_deref(),
                orphaned(session, claimed),
                folder,
            )
        })
}

fn folders<'a>(session: &'a Session, cwd: &'a str) -> Vec<&'a str> {
    let gone = session.worktree.as_deref().filter(|path| *path != cwd);
    [Some(cwd), gone].into_iter().flatten().collect()
}

/// A `/clear` from before Crew split conversations off left the first one under
/// Crew's id, held by no session; it still belongs to this one.
fn orphaned<'a>(session: &'a Session, claimed: &[String]) -> Option<&'a str> {
    let moved = session.provider_session_id.as_deref().is_some_and(|bound| bound != session.id);
    (moved && !claimed.contains(&session.id)).then_some(session.id.as_str())
}

/// What following Claude changed: the session's row after it, and the
/// sessions that now hold the conversations it left.
#[derive(Debug)]
pub struct Followed {
    pub session: Session,
    pub split: Vec<Session>,
}

/// Catches a Claude terminal up with the conversations its CLI started since
/// the last look (`/clear`, mostly). Each one it left with something said in it
/// becomes a session of its own, named and faced as the terminal was, so it can
/// be opened and resumed; the terminal goes on in the newest one, named afresh
/// for the provider to title. `None` when the CLI is where the row says.
pub fn follow_claude(store: &Store, id: String) -> Result<Option<Followed>, String> {
    follow_claude_in(store, id, &ClaudeDirs::from_env())
}

fn follow_claude_in(store: &Store, id: String, dirs: &ClaudeDirs) -> Result<Option<Followed>, String> {
    let Some(binds) = dirs.binds.as_deref().map(|dir| ClaudeBinds::read(dir, &id)) else {
        return Ok(None);
    };
    let Some(row) = get(store, id)? else { return Ok(None) };
    if row.kind != "terminal" || row.provider != "claude" {
        return Ok(None);
    }
    let ids = binds.ids();
    let was = claude_session(&row).to_string();
    if ids.iter().all(|next| *next == was) {
        binds.consume();
        return Ok(None);
    }
    let cwd = cwd(store, &row)?;
    let spoke_at = |conversation: &str| {
        let home = dirs.home.as_deref()?;
        folders(&row, &cwd)
            .into_iter()
            .filter_map(|folder| provider_session::claude_spoke_at(home, folder, conversation))
            .max()
    };
    let mut taken: Vec<String> = list(store, row.workspace_id.clone())?
        .into_iter()
        .filter(|s| s.kind == "terminal" && s.id != row.id)
        .map(|s| s.name)
        .collect();
    let mut live = row.clone();
    let mut title = provider_title_of(store, &row.id)?;
    let mut split: Vec<(Session, Option<String>, i64)> = Vec::new();
    let mut current = was;
    let now = now_millis();
    for next in ids {
        if next == current {
            continue;
        }
        if let Some(at) = spoke_at(&current) {
            let made = split.len() as i64;
            split.push((
                Session {
                    id: uuid::Uuid::new_v4().to_string(),
                    provider_session_id: Some(current.clone()),
                    status: "idle".into(),
                    created_at: now + made,
                    updated_at: at,
                    ..live.clone()
                },
                title.take(),
                at,
            ));
            taken.push(live.name.clone());
            live.name = derived_name(&taken, &live.provider);
        }
        current = next;
    }
    live.provider_session_id = Some(current.clone());
    live.updated_at = now;
    // Unread goes with the turn that finished last, wherever that turn is now.
    if row.status == "done" {
        let latest = split.iter().enumerate().max_by_key(|(_, (_, _, at))| *at);
        if let Some((at, (_, _, when))) = latest {
            if spoke_at(&current).is_none_or(|live_at| live_at < *when) {
                split[at].0.status = "done".into();
                live.status = "idle".into();
            }
        }
    }
    store.with(|conn| {
        let tx = conn.unchecked_transaction()?;
        for (session, title, _) in &split {
            tx.execute(
                "INSERT INTO sessions
                   (id, workspace_id, kind, name, provider, model, provider_session_id, description,
                    notifications, status, created_at, updated_at, sort_order, autonomy, worktree,
                    provider_title)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16)",
                params![
                    session.id,
                    session.workspace_id,
                    session.kind,
                    session.name,
                    session.provider,
                    session.model,
                    session.provider_session_id,
                    session.description,
                    session.notifications,
                    session.status,
                    session.created_at,
                    session.updated_at,
                    session.created_at,
                    session.autonomy,
                    session.worktree,
                    title
                ],
            )?;
        }
        if split.is_empty() {
            tx.execute(
                "UPDATE sessions SET provider_session_id = ?2, updated_at = ?3 WHERE id = ?1",
                params![live.id, live.provider_session_id, live.updated_at],
            )?;
        } else {
            tx.execute(
                "UPDATE sessions
                 SET provider_session_id = ?2, name = ?3, provider_title = NULL, status = ?4, updated_at = ?5
                 WHERE id = ?1",
                params![live.id, live.provider_session_id, live.name, live.status, live.updated_at],
            )?;
            let faces = crate::store::read_state(&tx, FACES)?;
            let ids: Vec<&str> = split.iter().map(|(session, _, _)| session.id.as_str()).collect();
            if let Some(faces) = faces_for(faces.as_deref(), &live.id, &ids) {
                crate::store::write_state(&tx, FACES, Some(&faces))?;
            }
        }
        tx.commit()
    })?;
    binds.consume();
    Ok(Some(Followed {
        session: live,
        split: split.into_iter().map(|(session, _, _)| session).collect(),
    }))
}

/// Faces agents were given, by session id: `{ "<id>": { "style"?, "seed"? } }`.
const FACES: &str = "agent:faces";

/// The face each split-off session keeps: the one its terminal showed. With no
/// face of its own, a terminal draws from its id, so the seed is written down.
fn faces_for(raw: Option<&str>, from: &str, to: &[&str]) -> Option<String> {
    let mut faces = raw
        .and_then(|raw| serde_json::from_str::<serde_json::Value>(raw).ok())
        .filter(|faces| faces.is_object())
        .unwrap_or_else(|| serde_json::json!({}));
    let mut face = faces.get(from).filter(|face| face.is_object()).cloned().unwrap_or_else(|| serde_json::json!({}));
    if face.get("seed").and_then(|seed| seed.as_str()).is_none_or(str::is_empty) {
        face["seed"] = serde_json::Value::String(from.to_string());
    }
    let map = faces.as_object_mut()?;
    for id in to {
        map.insert(id.to_string(), face.clone());
    }
    serde_json::to_string(&faces).ok()
}

/// The conversation Claude keeps for a session: Crew's id until a `/clear`.
fn claude_session(session: &Session) -> &str {
    session.provider_session_id.as_deref().unwrap_or(&session.id)
}

fn provider_title_of(store: &Store, id: &str) -> Result<Option<String>, String> {
    store.with(|conn| {
        conn.prepare_cached("SELECT provider_title FROM sessions WHERE id = ?1")?
            .query_row(params![id], |row| row.get(0))
    })
}

/// Mirrors `nextSessionName` in the window: the first of claude, claude 2, …
/// no other terminal of the workspace is called.
fn derived_name(taken: &[String], base: &str) -> String {
    if !taken.iter().any(|name| name == base) {
        return base.to_string();
    }
    (2..)
        .map(|n| format!("{base} {n}"))
        .find(|name| !taken.contains(name))
        .unwrap_or_else(|| base.to_string())
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

    fn branched(store: &Store, workspace: &str, tree: &str) -> Session {
        create_in_worktree(
            store,
            workspace.to_string(),
            "agent".into(),
            "Branched".into(),
            "claude".into(),
            "m".into(),
            "".into(),
            "ask".into(),
            Some(tree.into()),
        )
        .expect("agent")
    }

    fn a_folder() -> String {
        let dir = std::env::temp_dir().join(uuid::Uuid::new_v4().to_string());
        std::fs::create_dir_all(&dir).expect("dir");
        dir.to_string_lossy().into_owned()
    }

    #[test]
    fn a_session_works_in_its_worktree_or_else_the_workspace_folder() {
        let (store, workspace) = world();
        let root = crate::workspace::get(&store, workspace.clone()).unwrap().unwrap().path;
        let main = agent(&store, &workspace, "Main", "ask").expect("agent");
        let tree = a_folder();
        let branched = branched(&store, &workspace, &tree);

        assert_eq!(main.worktree, None);
        assert_eq!(cwd(&store, &main).unwrap(), root);
        let read = get(&store, branched.id.clone()).unwrap().unwrap();
        assert_eq!(read.worktree.as_deref(), Some(tree.as_str()), "the worktree did not survive a read");
        assert_eq!(cwd(&store, &read).unwrap(), tree);
        let listed = list(&store, workspace).unwrap();
        assert_eq!(listed.iter().filter(|s| s.worktree.is_some()).count(), 1);
    }

    /// Removed outside Crew, a worktree leaves its sessions to the workspace
    /// folder, not to whatever folder a process would fall back to. The row
    /// keeps the path, so the worktree made again is theirs again.
    #[test]
    fn a_session_whose_worktree_is_gone_works_in_the_workspace_folder() {
        let (store, workspace) = world();
        let root = crate::workspace::get(&store, workspace.clone()).unwrap().unwrap().path;
        let tree = a_folder();
        let session = branched(&store, &workspace, &tree);

        std::fs::remove_dir(&tree).expect("remove");
        let read = get(&store, session.id.clone()).unwrap().unwrap();
        assert_eq!(cwd(&store, &read).unwrap(), root);
        assert_eq!(folder(read.worktree.as_deref(), root.clone()), root);
        assert_eq!(read.worktree.as_deref(), Some(tree.as_str()), "the row forgot its worktree");

        std::fs::create_dir_all(&tree).expect("again");
        assert_eq!(cwd(&store, &read).unwrap(), tree);
    }

    /// An empty path from the window is no path, not a folder named "".
    #[test]
    fn an_empty_worktree_is_the_workspace_folder() {
        let (store, workspace) = world();
        let made = create_in_worktree(
            &store,
            workspace,
            "terminal".into(),
            "claude".into(),
            "claude".into(),
            "m".into(),
            "".into(),
            "ask".into(),
            Some(String::new()),
        )
        .expect("terminal");
        assert_eq!(made.worktree, None);
    }

    #[test]
    fn only_the_sessions_in_a_worktree_are_found_in_it() {
        let (store, workspace) = world();
        let make = |name: &str, worktree: Option<&str>| {
            create_in_worktree(
                &store,
                workspace.clone(),
                "agent".into(),
                name.into(),
                "claude".into(),
                "m".into(),
                "".into(),
                "ask".into(),
                worktree.map(Into::into),
            )
            .expect("agent")
            .id
        };
        let a = make("A", Some("/wt/feat"));
        let b = make("B", Some("/wt/feat"));
        make("C", Some("/wt/other"));
        make("D", None);

        let mut found = in_worktree(&store, "/wt/feat").unwrap();
        found.sort();
        let mut wanted = vec![a, b];
        wanted.sort();
        assert_eq!(found, wanted);
    }

    /// A Claude terminal in `world()`'s workspace, with Claude's folders of its own.
    struct Claude {
        store: Store,
        workspace: String,
        cwd: String,
        dirs: ClaudeDirs,
        clock: std::cell::Cell<u64>,
    }

    impl Claude {
        fn new() -> Self {
            let (store, workspace) = world();
            let cwd = crate::workspace::get(&store, workspace.clone()).unwrap().unwrap().path;
            let dirs = ClaudeDirs { home: Some(a_folder().into()), binds: Some(a_folder().into()) };
            Self { store, workspace, cwd, dirs, clock: std::cell::Cell::new(1_000) }
        }

        /// Something said in conversation `id`.
        fn said(&self, id: &str) {
            let home = self.dirs.home.as_deref().unwrap();
            let slug = crate::claude_title::project_slug(&self.cwd);
            let folder = home.join(".claude/projects").join(slug);
            std::fs::create_dir_all(&folder).unwrap();
            std::fs::write(folder.join(format!("{id}.jsonl")), "{\"type\":\"user\",\"message\":{\"content\":\"hi\"}}\n").unwrap();
        }

        /// The SessionStart hook's record of `crew_id`'s CLI starting `conversation`,
        /// a second after the one before.
        fn started(&self, crew_id: &str, conversation: &str, file: Option<&str>) {
            let at = self.clock.get() + 1;
            self.clock.set(at);
            let name = file.map(str::to_string).unwrap_or_else(|| format!("{crew_id}.{at}-1.start"));
            let path = self.dirs.binds.as_deref().unwrap().join(name);
            std::fs::write(&path, format!(r#"{{"session_id":"{conversation}","source":"clear"}}"#)).unwrap();
            let when = std::time::UNIX_EPOCH + std::time::Duration::from_secs(at);
            std::fs::File::options().write(true).open(&path).unwrap().set_modified(when).unwrap();
        }

        fn follow(&self, id: &str) -> Option<Followed> {
            follow_claude_in(&self.store, id.into(), &self.dirs).expect("follow")
        }

        fn row(&self, id: &str) -> Session {
            get(&self.store, id.into()).unwrap().expect("row")
        }

        fn holding(&self, conversation: &str) -> Vec<Session> {
            list(&self.store, self.workspace.clone())
                .unwrap()
                .into_iter()
                .filter(|s| s.provider_session_id.as_deref() == Some(conversation))
                .collect()
        }
    }

    #[test]
    fn a_clear_after_a_turn_leaves_that_conversation_as_a_session_of_its_own() {
        let claude = Claude::new();
        let live = terminal(&claude.store, &claude.workspace, "claude", "claude");
        terminal(&claude.store, &claude.workspace, "claude 2", "claude");
        adopt(&claude.store, &live.id, "Fix the login");
        set_status(&claude.store, live.id.clone(), "done".into()).unwrap();
        crate::store::set(&claude.store, FACES.into(), format!(r#"{{"{}":{{"style":"bottts"}}}}"#, live.id)).unwrap();
        claude.said(&live.id);
        claude.started(&live.id, &live.id, None);
        assert!(claude.follow(&live.id).is_none(), "the CLI's first start moved nothing");
        claude.started(&live.id, "b", None);

        let followed = claude.follow(&live.id).expect("moved");
        let [split] = followed.split.as_slice() else { panic!("{:?}", followed.split) };
        let stored = claude.row(&split.id);
        assert_eq!(stored.provider_session_id.as_deref(), Some(live.id.as_str()));
        assert_eq!(
            (stored.name.as_str(), stored.kind.as_str(), stored.status.as_str()),
            ("Fix the login", "terminal", "done"),
            "the old conversation keeps the name and the unread of its last turn"
        );
        assert_eq!((stored.workspace_id, stored.worktree, stored.model), (live.workspace_id.clone(), live.worktree.clone(), live.model.clone()));
        assert_eq!(provider_title_of(&claude.store, &split.id).unwrap().as_deref(), Some("Fix the login"));

        let now = claude.row(&live.id);
        assert_eq!(now.provider_session_id.as_deref(), Some("b"));
        // "claude 2" is another terminal's; the title freed the first one.
        assert_eq!((now.name.as_str(), now.status.as_str()), ("claude", "idle"), "the terminal is named afresh");
        assert_eq!(provider_title_of(&claude.store, &live.id).unwrap(), None);
        assert_eq!(followed.session.name, "claude");

        let faces: serde_json::Value =
            serde_json::from_str(&crate::store::get(&claude.store, FACES.into()).unwrap().unwrap()).unwrap();
        assert_eq!(faces[&split.id], serde_json::json!({ "style": "bottts", "seed": live.id }));
        assert_eq!(faces[&live.id], serde_json::json!({ "style": "bottts" }));

        // Read again: nothing left to follow, and the new title is the terminal's to adopt.
        assert!(claude.follow(&live.id).is_none());
        assert_eq!(adopt(&claude.store, &live.id, "Next thing").as_deref(), Some("Next thing"));
    }

    #[test]
    fn a_clear_before_anything_was_said_moves_the_terminal_and_makes_nothing() {
        let claude = Claude::new();
        let live = terminal(&claude.store, &claude.workspace, "claude", "claude");
        claude.started(&live.id, &live.id, None);
        claude.started(&live.id, "b", None);

        let followed = claude.follow(&live.id).expect("moved");
        assert!(followed.split.is_empty());
        assert_eq!(list(&claude.store, claude.workspace.clone()).unwrap().len(), 1);
        let now = claude.row(&live.id);
        assert_eq!((now.provider_session_id.as_deref(), now.name.as_str()), (Some("b"), "claude"));
        assert!(get_faces(&claude.store).is_none(), "a face was handed out for nothing");
    }

    fn get_faces(store: &Store) -> Option<String> {
        crate::store::get(store, FACES.into()).unwrap()
    }

    #[test]
    fn quick_clears_leave_every_conversation_with_turns_behind() {
        let claude = Claude::new();
        let live = terminal(&claude.store, &claude.workspace, "claude", "claude");
        // A (Crew's id) and B got a turn, C nothing yet; crewd looks only now.
        claude.said(&live.id);
        claude.started(&live.id, "b", None);
        claude.said("b");
        claude.started(&live.id, "c", None);

        let followed = claude.follow(&live.id).expect("moved");
        let names: Vec<(&str, Option<&str>)> =
            followed.split.iter().map(|s| (s.name.as_str(), s.provider_session_id.as_deref())).collect();
        assert_eq!(names, [("claude", Some(live.id.as_str())), ("claude 2", Some("b"))]);
        for conversation in [live.id.as_str(), "b"] {
            assert_eq!(claude.holding(conversation).len(), 1, "{conversation} is not held once");
        }
        let now = claude.row(&live.id);
        assert_eq!((now.provider_session_id.as_deref(), now.name.as_str()), (Some("c"), "claude 3"));
    }

    #[test]
    fn a_record_from_a_cli_older_than_per_start_records_still_moves_the_terminal() {
        let claude = Claude::new();
        let live = terminal(&claude.store, &claude.workspace, "claude", "claude");
        claude.said(&live.id);
        claude.started(&live.id, "b", Some(&format!("{}.json", live.id)));

        let followed = claude.follow(&live.id).expect("moved");
        assert_eq!(followed.split.len(), 1);
        assert_eq!(claude.row(&live.id).provider_session_id.as_deref(), Some("b"));
        assert!(claude.follow(&live.id).is_none(), "the record kept behind moved it again");
    }

    #[test]
    fn closing_right_after_quick_clears_keeps_each_conversation_and_drops_the_empty_terminal() {
        let claude = Claude::new();
        let live = terminal(&claude.store, &claude.workspace, "claude", "claude");
        claude.said(&live.id);
        claude.started(&live.id, "b", None);
        claude.said("b");
        claude.started(&live.id, "c", None);

        // The close asks before crewd ever looked; following comes first.
        let followed = claude.follow(&live.id).expect("moved");
        assert!(is_disposable_in(&claude.store, live.id.clone(), &claude.dirs).unwrap());
        delete(&claude.store, live.id.clone()).unwrap();
        for split in &followed.split {
            assert!(!is_disposable_in(&claude.store, split.id.clone(), &claude.dirs).unwrap(), "{} would go", split.name);
        }
        // The startup sweep agrees, and follows first on its own.
        assert_eq!(sweep_disposable_in(&claude.store, &claude.dirs).unwrap(), 0);
        let kept: Vec<Option<String>> =
            list(&claude.store, claude.workspace.clone()).unwrap().into_iter().map(|s| s.provider_session_id).collect();
        assert_eq!(kept, [Some(live.id.clone()), Some("b".into())]);
    }

    #[test]
    fn the_startup_sweep_follows_a_clear_nobody_read_before_it_judges() {
        let claude = Claude::new();
        let live = terminal(&claude.store, &claude.workspace, "claude", "claude");
        claude.said(&live.id);
        claude.started(&live.id, "b", None);

        assert_eq!(sweep_disposable_in(&claude.store, &claude.dirs).unwrap(), 1, "the empty terminal stays");
        let left = list(&claude.store, claude.workspace.clone()).unwrap();
        let [kept] = left.as_slice() else { panic!("{left:?}") };
        assert_eq!(kept.provider_session_id.as_deref(), Some(live.id.as_str()));
    }

    /// A `/clear` from before Crew split conversations off moved the row and
    /// left the first conversation under Crew's id with nobody holding it.
    #[test]
    fn a_conversation_left_before_splitting_existed_still_keeps_its_terminal() {
        let claude = Claude::new();
        let live = terminal(&claude.store, &claude.workspace, "claude", "claude");
        claude.said(&live.id);
        set_provider_session(&claude.store, live.id.clone(), "b".into()).unwrap();
        assert!(!is_disposable_in(&claude.store, live.id, &claude.dirs).unwrap());
    }

    #[test]
    fn deleting_a_workspace_takes_its_sessions_with_it() {
        let (store, workspace) = world();
        let made = agent(&store, &workspace, "Planner", "ask").expect("agent");

        crate::workspace::delete(&store, workspace).expect("delete");

        assert!(get(&store, made.id).unwrap().is_none(), "an orphaned session survived");
    }
}
