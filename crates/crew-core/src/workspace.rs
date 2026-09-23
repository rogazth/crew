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

#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_support::temp_store;

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

    /// A workspace per folder, each folder inside the store's own directory.
    fn open(store: &Store, dir: &tempfile::TempDir, names: &[&str]) -> Vec<String> {
        names
            .iter()
            .map(|name| {
                let folder = dir.path().join(name);
                std::fs::create_dir(&folder).expect("folder");
                create(store, name.to_string(), folder.to_string_lossy().into())
                    .expect("workspace")
                    .id
            })
            .collect()
    }

    fn listed(store: &Store) -> Vec<String> {
        list(store).expect("list").into_iter().map(|w| w.name).collect()
    }

    #[test]
    fn every_workspace_lists_with_what_it_was_made_with() {
        let (dir, store) = temp_store();
        assert!(list(&store).expect("empty").is_empty());
        let made = create(&store, "crew".into(), dir.path().to_string_lossy().into()).expect("made");

        let all = list(&store).expect("list");

        assert_eq!(all.len(), 1);
        let got = &all[0];
        assert_eq!(
            (&got.id, &got.name, &got.path, got.created_at),
            (&made.id, &made.name, &made.path, made.created_at)
        );
        assert_eq!(get(&store, made.id).expect("get").expect("row").name, "crew");
        assert!(get(&store, "nobody".into()).expect("get").is_none());
    }

    #[test]
    fn reorder_lists_workspaces_in_the_order_given() {
        let (dir, store) = temp_store();
        let ids = open(&store, &dir, &["a", "b", "c"]);

        reorder(&store, vec![ids[2].clone(), ids[0].clone(), ids[1].clone()]).expect("reorder");
        assert_eq!(listed(&store), ["c", "a", "b"]);

        reorder(&store, vec![ids[1].clone(), ids[2].clone(), ids[0].clone()]).expect("reorder");
        assert_eq!(listed(&store), ["b", "c", "a"]);
    }

    /// A drag can race a delete in another window: the id that is gone is
    /// passed over and the rest still take their places.
    #[test]
    fn reorder_passes_over_ids_it_does_not_know() {
        let (dir, store) = temp_store();
        let ids = open(&store, &dir, &["a", "b"]);

        reorder(&store, vec!["gone".into(), ids[1].clone(), ids[0].clone()]).expect("reorder");

        assert_eq!(listed(&store), ["b", "a"]);
    }

    #[test]
    fn a_rename_is_trimmed_and_an_empty_one_changes_nothing() {
        let (dir, store) = temp_store();
        let id = open(&store, &dir, &["crew"]).remove(0);

        rename(&store, id.clone(), "  harness  ".into()).expect("rename");
        assert_eq!(get(&store, id.clone()).unwrap().unwrap().name, "harness");

        let empty = rename(&store, id.clone(), "   ".into());
        assert!(empty.is_err_and(|e| e.contains("Workspace name is required")));
        assert_eq!(get(&store, id).unwrap().unwrap().name, "harness");

        rename(&store, "nobody".into(), "ghost".into()).expect("renaming nothing is not an error");
        assert_eq!(listed(&store), ["harness"]);
    }

    #[test]
    fn deleting_a_workspace_leaves_the_others_and_frees_its_folder() {
        let (dir, store) = temp_store();
        let ids = open(&store, &dir, &["a", "b"]);

        delete(&store, ids[0].clone()).expect("delete");

        assert_eq!(listed(&store), ["b"]);
        let folder = dir.path().join("a").to_string_lossy().into_owned();
        create(&store, "a again".into(), folder).expect("the folder opens again");
    }

    #[test]
    fn the_active_workspace_is_remembered_replaced_and_cleared() {
        let (dir, store) = temp_store();
        let ids = open(&store, &dir, &["a", "b"]);
        assert_eq!(active_get(&store).expect("get"), None);

        active_set(&store, Some(ids[0].clone())).expect("set");
        active_set(&store, Some(ids[1].clone())).expect("replace");
        assert_eq!(active_get(&store).expect("get"), Some(ids[1].clone()));

        active_set(&store, None).expect("clear");
        assert_eq!(active_get(&store).expect("get"), None);
    }

    /// A sidebar that cannot be read is an error, not a sidebar with nothing
    /// in it.
    #[test]
    fn workspaces_that_cannot_be_read_are_an_error_not_an_empty_list() {
        let (dir, store) = temp_store();
        let id = open(&store, &dir, &["a"]).remove(0);
        store
            .with(|conn| conn.execute_batch("ALTER TABLE workspaces RENAME TO elsewhere;"))
            .expect("break the schema");

        assert!(list(&store).is_err());
        assert!(get(&store, id).is_err());
    }

    #[test]
    fn the_active_workspace_survives_a_restart() {
        let (dir, store) = temp_store();
        let id = open(&store, &dir, &["a"]).remove(0);
        active_set(&store, Some(id.clone())).expect("set");
        drop(store);

        let store = Store::open(dir.path().join("crew.sqlite3")).expect("reopen");

        assert_eq!(active_get(&store).expect("get"), Some(id));
    }
}
