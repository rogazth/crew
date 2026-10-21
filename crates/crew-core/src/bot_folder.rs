//! A bot's folder: a place of its own, outside any checkout, for anything it
//! wants to keep. `<work dir>/workspaces/<workspace>/bots/<bot>/`.
//!
//! The path is stored on the bot (`bots.folder`), set the first time a turn
//! needs it from the names the workspace and the bot have then. Stored, not
//! derived: a rename would otherwise move a bot away from what it kept, and
//! two bots whose names make the same folder (the same name in two workspaces
//! of the same name) would share it; the second gets `-2`. Crew says nothing
//! about what goes in it.

use std::path::{Path, PathBuf};

use rusqlite::{params, OptionalExtension};

use crate::store::Store;

/// The variable a bot's CLI finds its folder in.
pub const ENV: &str = "CREW_SCRATCH_SELF";

/// The column v42 adds to `bots`.
pub const MIGRATION_V42: &str = "ALTER TABLE bots ADD COLUMN folder TEXT;";

/// The bot's folder, made if it is not there. `None` for a session that is no
/// bot, or a folder that could not be made (the turn goes on without one).
pub fn ensure(store: &Store, bot_id: &str) -> Option<PathBuf> {
    let folder = assign(store, bot_id, &crate::paths::layout().work).ok()??;
    match std::fs::create_dir_all(&folder) {
        Ok(()) => Some(folder),
        Err(error) => {
            eprintln!("[bot folder] {}: {error}", folder.display());
            None
        }
    }
}

/// The bot's folder under `work`: the stored one, or a new one stored now.
fn assign(store: &Store, bot_id: &str, work: &Path) -> Result<Option<PathBuf>, String> {
    store.with(|conn| {
        let tx = conn.unchecked_transaction()?;
        let row: Option<(Option<String>, String, String)> = tx
            .query_row(
                "SELECT b.folder, b.name, w.name FROM bots b JOIN workspaces w ON w.id = b.workspace_id WHERE b.id = ?1",
                params![bot_id],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )
            .optional()?;
        let Some((stored, bot, workspace)) = row else {
            return Ok(None);
        };
        if let Some(stored) = stored.filter(|path| !path.is_empty()) {
            return Ok(Some(PathBuf::from(stored)));
        }
        let base = work.join("workspaces").join(slug(&workspace, "workspace")).join("bots").join(slug(&bot, "bot"));
        let taken = |path: &Path| -> rusqlite::Result<bool> {
            tx.prepare_cached("SELECT 1 FROM bots WHERE folder = ?1")?.exists(params![path.to_string_lossy()])
        };
        let mut folder = base.clone();
        let mut n = 2;
        while taken(&folder)? {
            folder = base.with_file_name(format!("{}-{n}", slug(&bot, "bot")));
            n += 1;
        }
        tx.execute("UPDATE bots SET folder = ?2 WHERE id = ?1", params![bot_id, folder.to_string_lossy()])?;
        tx.commit()?;
        Ok(Some(folder))
    })
}

/// The bot's folder as stored, without making one.
pub fn get(store: &Store, bot_id: &str) -> Result<Option<PathBuf>, String> {
    store.with(|conn| {
        conn.query_row("SELECT folder FROM bots WHERE id = ?1", params![bot_id], |row| row.get::<_, Option<String>>(0))
            .optional()
            .map(|folder| folder.flatten().filter(|path| !path.is_empty()).map(PathBuf::from))
    })
}

/// The folders of a workspace's bots, read before the workspace goes.
pub fn of_workspace(store: &Store, workspace_id: &str) -> Result<Vec<PathBuf>, String> {
    store.with(|conn| {
        conn.prepare_cached("SELECT folder FROM bots WHERE workspace_id = ?1 AND COALESCE(folder, '') <> ''")?
            .query_map(params![workspace_id], |row| row.get::<_, String>(0))?
            .map(|folder| folder.map(PathBuf::from))
            .collect()
    })
}

/// Deletes a folder that was a bot's, with what it held. Only one under the
/// work dir's `workspaces/`: a path that is not where Crew puts bots' folders
/// (a stored value gone wrong) is left alone.
pub fn remove(folder: &Path) {
    remove_under(folder, &crate::paths::layout().work);
}

fn remove_under(folder: &Path, work: &Path) {
    let root = work.join("workspaces");
    let ours = folder.starts_with(&root)
        && folder != root
        && !folder.components().any(|part| matches!(part, std::path::Component::ParentDir));
    if !ours {
        eprintln!("[bot folder] not removing {}: not under {}", folder.display(), root.display());
        return;
    }
    if let Err(error) = std::fs::remove_dir_all(folder) {
        if error.kind() != std::io::ErrorKind::NotFound {
            eprintln!("[bot folder] {}: {error}", folder.display());
        }
    }
}

/// A name as one folder name: lowercase letters and digits, the rest a dash.
fn slug(name: &str, otherwise: &str) -> String {
    let mut out = String::new();
    for c in name.trim().chars() {
        if c.is_ascii_alphanumeric() {
            out.push(c.to_ascii_lowercase());
        } else if !out.ends_with('-') {
            out.push('-');
        }
    }
    let out = out.trim_matches('-');
    if out.is_empty() {
        otherwise.to_string()
    } else {
        out.chars().take(60).collect()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("crew-{tag}-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).expect("dir");
        dir
    }

    fn bot(store: &Store, workspace: &str, name: &str) -> String {
        crate::session::create(
            store,
            workspace.into(),
            "bot".into(),
            name.into(),
            "claude".into(),
            "claude-opus-5-5".into(),
            String::new(),
            "ask".into(),
        )
        .expect("bot")
        .id
    }

    #[test]
    fn a_name_is_one_folder_name() {
        assert_eq!(slug("Brisa", "bot"), "brisa");
        assert_eq!(slug("  Tienda Demo / v2 ", "bot"), "tienda-demo-v2");
        assert_eq!(slug("¿?", "bot"), "bot");
    }

    /// The folder is set once, from the names then: a rename keeps it, and a
    /// second bot whose names make the same folder gets one of its own.
    #[test]
    fn a_bots_folder_is_set_once_and_is_its_own() {
        let dir = temp("bot-folder");
        let work = dir.join("work");
        let store = Store::open(dir.join("crew.sqlite3")).expect("store");
        for folder in ["a", "b"] {
            std::fs::create_dir_all(dir.join(folder)).unwrap();
        }
        let one = crate::workspace::create(&store, "Tienda".into(), dir.join("a").to_string_lossy().into()).unwrap().id;
        let two = crate::workspace::create(&store, "tienda".into(), dir.join("b").to_string_lossy().into()).unwrap().id;
        let brisa = bot(&store, &one, "Brisa");
        let other = bot(&store, &two, "brisa");

        let folder = assign(&store, &brisa, &work).unwrap().unwrap();
        assert_eq!(folder, work.join("workspaces/tienda/bots/brisa"));
        crate::session::rename(&store, brisa.clone(), "Alba".into()).unwrap();
        assert_eq!(assign(&store, &brisa, &work).unwrap(), Some(folder.clone()));
        assert_eq!(assign(&store, &other, &work).unwrap(), Some(work.join("workspaces/tienda/bots/brisa-2")));
        assert_eq!(get(&store, &brisa).unwrap(), Some(folder));

        let shell = crate::session::create(
            &store,
            one,
            "terminal".into(),
            "shell".into(),
            "claude".into(),
            String::new(),
            String::new(),
            "ask".into(),
        )
        .unwrap();
        assert_eq!(assign(&store, &shell.id, &work).unwrap(), None, "a session is no bot");
    }

    /// Deleting a bot, or its workspace, deletes its folder with what it held.
    #[test]
    fn a_bots_folder_goes_with_it() {
        let dir = temp("bot-folder-gone");
        let store = Store::open(dir.join("crew.sqlite3")).expect("store");
        let mut made = Vec::new();
        for name in ["Uno", "Dos"] {
            std::fs::create_dir_all(dir.join(name)).unwrap();
            let workspace = crate::workspace::create(&store, name.into(), dir.join(name).to_string_lossy().into()).unwrap().id;
            let id = bot(&store, &workspace, "Brisa");
            let folder = ensure(&store, &id).expect("a folder");
            assert!(folder.starts_with(crate::paths::layout().work.join("workspaces")), "{}", folder.display());
            std::fs::write(folder.join("report.md"), "x").unwrap();
            made.push((workspace, id, folder));
        }
        crate::session::delete(&store, made[0].1.clone()).unwrap();
        assert!(!made[0].2.exists());
        crate::workspace::delete(&store, made[1].0.clone()).unwrap();
        assert!(!made[1].2.exists());
    }

    /// A folder goes only from where Crew puts them.
    #[test]
    fn only_a_folder_under_the_work_dir_is_removed() {
        let dir = temp("bot-folder-rm");
        let work = dir.join("work");
        let ours = work.join("workspaces/w/bots/brisa");
        let theirs = dir.join("elsewhere");
        for folder in [&ours, &theirs] {
            std::fs::create_dir_all(folder).unwrap();
            std::fs::write(folder.join("notes.md"), "x").unwrap();
        }
        remove_under(&theirs, &work);
        remove_under(&work.join("workspaces"), &work);
        remove_under(&work.join("workspaces/w/bots/../../.."), &work);
        assert!(theirs.join("notes.md").exists() && work.join("workspaces").exists());
        remove_under(&ours, &work);
        assert!(!ours.exists());
    }
}
