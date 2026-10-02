use rusqlite::{params, OptionalExtension};
use serde::{Deserialize, Serialize};

use crate::store::{now_millis, read_state, set_order, write_state, Store};

const ACTIVE_WORKSPACE_KEY: &str = "active_workspace_id";
/// The workspace with no project: where sessions go when there is no folder to give them.
const HOME_WORKSPACE_KEY: &str = "home_workspace_id";

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Workspace {
    pub id: String,
    pub name: String,
    pub path: String,
    pub created_at: i64,
    /// Home: the window's own workspace, not a project the user opened.
    #[serde(default)]
    pub home: bool,
}

pub fn list(store: &Store) -> Result<Vec<Workspace>, String> {
    store.with(|conn| {
        let home = read_state(conn, HOME_WORKSPACE_KEY)?;
        let mut stmt = conn.prepare_cached(
            "SELECT id, name, path, created_at FROM workspaces ORDER BY sort_order ASC, created_at ASC",
        )?;
        let rows = stmt.query_map([], |row| row_to_workspace(row, home.as_deref()))?;
        rows.collect()
    })
}

fn row_to_workspace(row: &rusqlite::Row, home: Option<&str>) -> rusqlite::Result<Workspace> {
    let id: String = row.get(0)?;
    Ok(Workspace {
        home: home == Some(id.as_str()),
        id,
        name: row.get(1)?,
        path: row.get(2)?,
        created_at: row.get(3)?,
    })
}

pub fn get(store: &Store, id: String) -> Result<Option<Workspace>, String> {
    store.with(|conn| {
        let home = read_state(conn, HOME_WORKSPACE_KEY)?;
        conn.prepare_cached("SELECT id, name, path, created_at FROM workspaces WHERE id = ?1")?
            .query_row(params![id], |row| row_to_workspace(row, home.as_deref()))
            .optional()
    })
}

/// Home, made the first time the window asks for it, in `folder`. A folder
/// already open as a workspace becomes home as it is, sessions and all. The
/// folder is made again if it was removed, so its sessions still have
/// somewhere to start.
pub fn home(store: &Store, folder: &std::path::Path) -> Result<Workspace, String> {
    let id: Option<String> = store.with(|conn| read_state(conn, HOME_WORKSPACE_KEY))?;
    if let Some(found) = id.map(|id| get(store, id)).transpose()?.flatten() {
        std::fs::create_dir_all(&found.path).map_err(|e| format!("{}: {e}", found.path))?;
        return Ok(found);
    }
    std::fs::create_dir_all(folder).map_err(|e| format!("{}: {e}", folder.display()))?;
    let path = folder.to_string_lossy().into_owned();
    let existing: Option<String> = store.with(|conn| {
        conn.query_row("SELECT id FROM workspaces WHERE path = ?1", params![path], |row| row.get(0))
            .optional()
    })?;
    let id = match existing {
        Some(id) => id,
        None => create(store, "Home".into(), path)?.id,
    };
    store.with(|conn| write_state(conn, HOME_WORKSPACE_KEY, Some(&id)))?;
    get(store, id)?.ok_or_else(|| "Home was not saved".into())
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
        home: false,
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

/// The chrome it kept goes with it: its tab strip, one per worktree, and the worktree it had on screen.
pub fn delete(store: &Store, id: String) -> Result<(), String> {
    if store.with(|conn| read_state(conn, HOME_WORKSPACE_KEY))?.as_deref() == Some(id.as_str()) {
        return Err("Home cannot be removed".into());
    }
    store.with(|conn| {
        conn.execute("DELETE FROM workspaces WHERE id = ?1", params![id])?;
        conn.execute(
            "DELETE FROM app_state WHERE key IN (?1, ?2) OR substr(key, 1, length(?3)) = ?3",
            params![format!("tabs:{id}"), format!("worktree:{id}"), format!("tabs:{id}@")],
        )
    })?;
    Ok(())
}

/// The workspace a caller outside Crew means: an id as it is, or a path
/// inside a workspace's folder or inside one of its sessions' worktrees. The
/// deepest folder wins, so a worktree kept inside the repo is its own answer
/// and not the repo's.
///
/// A worktree no session runs in is still the workspace's: git knows which
/// checkout it belongs to, and that checkout is a workspace folder.
pub fn resolve(store: &Store, id_or_path: &str) -> Result<Option<String>, String> {
    let needle = id_or_path.trim();
    if needle.is_empty() {
        return Ok(None);
    }
    if let Some(found) = get(store, needle.to_string())? {
        return Ok(Some(found.id));
    }
    let path = std::path::Path::new(needle);
    if !path.is_absolute() {
        return Ok(None);
    }
    let path = canonical(path);
    let mut roots: Vec<(std::path::PathBuf, String)> = list(store)?
        .into_iter()
        .map(|workspace| (canonical(std::path::Path::new(&workspace.path)), workspace.id))
        .collect();
    for session in crate::session::list_all(store)? {
        if let Some(worktree) = session.worktree {
            roots.push((canonical(std::path::Path::new(&worktree)), session.workspace_id));
        }
    }
    let deepest = |target: &std::path::Path| {
        roots
            .iter()
            .filter(|(root, _)| target.starts_with(root))
            .max_by_key(|(root, _)| root.components().count())
            .map(|(_, id)| id.clone())
    };
    if let Some(id) = deepest(&path) {
        return Ok(Some(id));
    }
    Ok(crate::worktree::main_checkout(&path.to_string_lossy())
        .ok()
        .and_then(|main| deepest(&canonical(std::path::Path::new(&main)))))
}

/// Symlinks resolved, so `/tmp` and `/private/tmp` are one folder. A path that
/// is gone is compared as it was written.
fn canonical(path: &std::path::Path) -> std::path::PathBuf {
    std::fs::canonicalize(path).unwrap_or_else(|_| path.to_path_buf())
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

#[cfg(test)]
mod tests {
    use super::*;

    fn store() -> Store {
        let dir = std::env::temp_dir().join(format!("crew-ws-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).expect("dir");
        Store::open(dir.join("crew.sqlite3")).expect("store")
    }

    fn a_folder() -> String {
        let dir = std::env::temp_dir().join(uuid::Uuid::new_v4().to_string());
        std::fs::create_dir_all(&dir).expect("dir");
        dir.to_string_lossy().into_owned()
    }

    #[test]
    fn a_workspace_is_a_directory_that_exists() {
        let store = store();
        let path = a_folder();
        assert!(create(&store, "crew".into(), path.clone()).is_ok());

        let missing = create(&store, "gone".into(), format!("{path}/nope"));
        assert!(missing.is_err_and(|e| e.contains("Not a directory")), "a missing folder was opened");
        let file = std::path::Path::new(&path).join("a-file");
        std::fs::write(&file, "x").expect("file");
        let as_file = create(&store, "file".into(), file.to_string_lossy().into_owned());
        assert!(as_file.is_err_and(|e| e.contains("Not a directory")), "a file was opened as a folder");
    }

    #[test]
    fn a_name_is_required_and_trimmed() {
        let store = store();
        assert!(create(&store, "   ".into(), a_folder()).is_err());
        let made = create(&store, "  crew  ".into(), a_folder()).expect("workspace");
        assert_eq!(made.name, "crew");
    }

    /// Two rows for one folder would be two transcripts for one project.
    #[test]
    fn the_same_folder_cannot_be_opened_twice() {
        let store = store();
        let path = a_folder();
        create(&store, "crew".into(), path.clone()).expect("first");

        let again = create(&store, "crew again".into(), path);

        assert!(again.is_err_and(|e| e.contains("Already open as \"crew\"")), "the folder opened twice");
    }

    #[test]
    fn home_is_made_once_with_its_folder() {
        let store = store();
        let folder = std::path::Path::new(&a_folder()).join("Crew");

        let first = home(&store, &folder).expect("home");
        let again = home(&store, &folder).expect("home again");

        assert!(folder.is_dir(), "home's folder was not made");
        assert!(first.home, "home was not marked as home");
        assert_eq!(first.id, again.id, "a second home was made");
        let all = list(&store).expect("list");
        assert_eq!(all.iter().filter(|w| w.home).count(), 1, "home is not listed once");
        assert!(delete(&store, first.id.clone()).is_err(), "home was removed");
        assert!(get(&store, first.id).expect("get").is_some_and(|w| w.home));
    }

    /// Its sessions start there, so a folder removed behind Crew's back comes back.
    #[test]
    fn home_makes_its_folder_again() {
        let store = store();
        let folder = std::path::Path::new(&a_folder()).join("Crew");
        home(&store, &folder).expect("home");
        std::fs::remove_dir(&folder).expect("remove");

        home(&store, &folder).expect("home again");

        assert!(folder.is_dir(), "home's folder stayed gone");
    }

    /// A folder already open as a project becomes home rather than clash on its path.
    #[test]
    fn a_folder_already_open_becomes_home() {
        let store = store();
        let path = a_folder();
        let opened = create(&store, "Crew".into(), path.clone()).expect("workspace");

        let made = home(&store, std::path::Path::new(&path)).expect("home");

        assert_eq!(made.id, opened.id);
        assert!(made.home);
        assert_eq!(list(&store).expect("list").len(), 1);
    }

    /// A strip left behind would come back as ghost tabs if a workspace ever got the same id.
    #[test]
    fn a_removed_workspace_takes_its_saved_chrome() {
        let store = store();
        let gone = create(&store, "gone".into(), a_folder()).expect("gone");
        let kept = create(&store, "kept".into(), a_folder()).expect("kept");
        let keys = |id: &str| [format!("tabs:{id}"), format!("tabs:{id}@/tmp/feat"), format!("worktree:{id}")];
        for key in keys(&gone.id).into_iter().chain(keys(&kept.id)).chain(["tabs:scope".to_string()]) {
            crate::store::set(&store, key, "x".into()).expect("set");
        }

        delete(&store, gone.id.clone()).expect("delete");

        for key in keys(&gone.id) {
            assert_eq!(crate::store::get(&store, key.clone()).expect("get"), None, "{key} outlived its workspace");
        }
        for key in keys(&kept.id).into_iter().chain(["tabs:scope".to_string()]) {
            assert!(crate::store::get(&store, key.clone()).expect("get").is_some(), "{key} went with another workspace");
        }
    }
}
