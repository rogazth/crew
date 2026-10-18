//! Where an environment keeps its things. The data dir is the environment:
//! the installed app, `npm run app`, an e2e sandbox and a remote machine each
//! have their own, and nothing Crew writes for itself goes anywhere else.
//!
//! - **Data dir**: what only Crew reads. The database, the socket, logs,
//!   media, and `tmp/` for pastes, uploads and the files a run needs on disk.
//! - **Work dir**: what the user works in. Worktrees go under it, and the
//!   Home workspace's folder defaults to it.
//!
//! The launcher that made the data dir says where the work dir is, once, in
//! `layout.json` beside the database: the installed app keeps `~/.crew` and
//! `~/Crew`, a dev build `~/.crew-dev`. With no file the work dir is inside
//! the data dir, so an environment nobody described stays inside its own
//! folder. crewd reads it at startup; the CLI providers' own state (`~/.claude`,
//! `~/.codex`, …) is theirs, not Crew's, and stays where they keep it.

use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use std::sync::OnceLock;

pub const LAYOUT_FILE: &str = "layout.json";

/// What `layout.json` holds. Every field is optional; a missing one takes the
/// default under the data dir.
#[derive(Serialize, Deserialize, Default, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct LayoutFile {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub work_dir: Option<PathBuf>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub home_folder: Option<PathBuf>,
}

#[derive(Clone, Debug, PartialEq)]
pub struct Layout {
    pub data: PathBuf,
    pub work: PathBuf,
    pub home_folder: PathBuf,
}

impl Layout {
    /// The layout of the environment whose data dir is `data`, from its
    /// `layout.json` when it has one. A file that does not parse is an error:
    /// guessing would put the user's worktrees somewhere they did not choose.
    pub fn read(data: &Path) -> Result<Self, String> {
        let file = data.join(LAYOUT_FILE);
        let described = match std::fs::read_to_string(&file) {
            Ok(text) => serde_json::from_str(&text).map_err(|e| format!("{}: {e}", file.display()))?,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => LayoutFile::default(),
            Err(e) => return Err(format!("{}: {e}", file.display())),
        };
        Ok(Self::from_file(data, described))
    }

    fn from_file(data: &Path, file: LayoutFile) -> Self {
        let work = file.work_dir.unwrap_or_else(|| data.join("work"));
        let home_folder = file.home_folder.unwrap_or_else(|| work.join("home"));
        Self { data: data.to_path_buf(), work, home_folder }
    }
}

static LAYOUT: OnceLock<Layout> = OnceLock::new();

/// Set once, by crewd, before anything below is asked for.
pub fn init(layout: Layout) {
    let _ = LAYOUT.set(layout);
}

/// The environment's layout. A process that never set one (a unit test, the
/// CLI) gets a folder of its own under the system temp dir, so it can never
/// write into a real environment's.
pub fn layout() -> &'static Layout {
    LAYOUT.get_or_init(|| {
        let data = std::env::temp_dir().join(format!("crew-unset-{}", std::process::id()));
        Layout::from_file(&data, LayoutFile::default())
    })
}

/// Pastes, uploads, and the files a run needs on disk for a while. Its own
/// subfolder per use, so what one leaves behind is easy to tell apart.
pub fn tmp(name: &str) -> PathBuf {
    layout().data.join("tmp").join(name)
}

/// How long what `tmp/` holds is kept. A paste or an upload is read by the
/// turn it was sent with; a chat that shows it later finds it gone, as it did
/// when macOS cleared the system temp dir after three days.
pub const TMP_KEEP: std::time::Duration = std::time::Duration::from_secs(7 * 24 * 3600);

/// Deletes what `tmp/<use>/` holds that was last changed before `older_than`
/// ago, and returns how many entries went. Run once at startup.
pub fn sweep_tmp(older_than: std::time::Duration) -> usize {
    let Some(cutoff) = std::time::SystemTime::now().checked_sub(older_than) else { return 0 };
    let uses = std::fs::read_dir(layout().data.join("tmp")).into_iter().flatten().flatten();
    let mut gone = 0;
    for entry in uses.flat_map(|dir| std::fs::read_dir(dir.path()).into_iter().flatten().flatten()) {
        let old = entry.metadata().and_then(|meta| meta.modified()).is_ok_and(|changed| changed < cutoff);
        if !old {
            continue;
        }
        let path = entry.path();
        let removed = if path.is_dir() { std::fs::remove_dir_all(&path) } else { std::fs::remove_file(&path) };
        gone += usize::from(removed.is_ok());
    }
    gone
}

/// Where the worktrees Crew makes go: `<work>/worktrees/<repo>/<branch>`.
pub fn worktrees() -> PathBuf {
    layout().work.join("worktrees")
}

/// The Home workspace's folder.
pub fn home_folder() -> PathBuf {
    layout().home_folder.clone()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp() -> PathBuf {
        let dir = std::env::temp_dir().join(format!("crew-paths-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn an_environment_nobody_described_stays_inside_its_data_dir() {
        let data = temp();
        let layout = Layout::read(&data).expect("layout");
        assert_eq!(layout.work, data.join("work"));
        assert_eq!(layout.home_folder, data.join("work/home"));
    }

    #[test]
    fn the_launcher_names_the_work_dir_and_the_home_folder() {
        let data = temp();
        std::fs::write(data.join(LAYOUT_FILE), r#"{"workDir":"/u/.crew","homeFolder":"/u/Crew"}"#).unwrap();
        let layout = Layout::read(&data).expect("layout");
        assert_eq!((layout.work, layout.home_folder), (PathBuf::from("/u/.crew"), PathBuf::from("/u/Crew")));
    }

    #[test]
    fn the_home_folder_follows_a_named_work_dir() {
        let data = temp();
        std::fs::write(data.join(LAYOUT_FILE), r#"{"workDir":"/u/.crew-dev"}"#).unwrap();
        assert_eq!(Layout::read(&data).expect("layout").home_folder, PathBuf::from("/u/.crew-dev/home"));
    }

    #[test]
    fn a_layout_that_does_not_parse_stops_the_start() {
        let data = temp();
        std::fs::write(data.join(LAYOUT_FILE), "{ not json").unwrap();
        assert!(Layout::read(&data).is_err_and(|e| e.contains(LAYOUT_FILE)));
    }

    #[test]
    fn what_tmp_held_for_a_week_goes_and_the_rest_stays() {
        let old = tmp("files").join(format!("old-{}.png", uuid::Uuid::new_v4()));
        let fresh = tmp("files").join(format!("fresh-{}.png", uuid::Uuid::new_v4()));
        let old_run = tmp("opencode").join(format!("old-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&old_run).unwrap();
        std::fs::create_dir_all(tmp("files")).unwrap();
        std::fs::write(old_run.join("config.json"), "{}").unwrap();
        std::fs::write(&old, "x").unwrap();
        std::fs::write(&fresh, "x").unwrap();
        let week_ago = std::time::SystemTime::now() - TMP_KEEP - std::time::Duration::from_secs(60);
        for path in [&old, &old_run] {
            std::fs::File::open(path).unwrap().set_modified(week_ago).unwrap();
        }

        assert!(sweep_tmp(TMP_KEEP) >= 2);

        assert!(!old.exists() && !old_run.exists());
        assert!(fresh.exists());
    }

    #[test]
    fn a_process_without_a_layout_writes_under_its_own_temp_folder() {
        assert!(layout().data.starts_with(std::env::temp_dir()));
        assert!(tmp("uploads").starts_with(&layout().data));
        assert!(worktrees().starts_with(&layout().data));
    }
}
