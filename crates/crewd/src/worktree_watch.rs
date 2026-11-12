//! Tells every window when a repo's worktrees change on disk: one made or
//! removed with git, locked or unlocked, or its folder deleted by hand. The
//! window reads git again on it, so a worktree made in a terminal is listed
//! at once. A repo is watched from the first time a window lists it, and each
//! listing after that brings the watched folders up to date.
//!
//! Two kinds of place are watched, neither recursively: the repo's git dir and
//! its `worktrees/` folder, for git's own entries, and the folder each linked
//! worktree sits in, for the worktree's folder going. Nothing inside a
//! checkout is watched, so editing files there never wakes a listing.

use std::collections::{HashMap, HashSet};
use std::ffi::OsStr;
use std::path::{Path, PathBuf};
use std::sync::{mpsc, Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant};

use crew_core::worktree::{self, Worktree};
use notify::{Event, EventKind, RecommendedWatcher, RecursiveMode, Watcher};

/// What git writes for one worktree lands in a burst; the window hears it once.
const SETTLE: Duration = Duration::from_millis(150);

pub struct WorktreeWatch {
    repos: Mutex<HashMap<String, Repo>>,
    changed: mpsc::Sender<String>,
}

struct Repo {
    watcher: RecommendedWatcher,
    /// The repo's git dir, as the file system names it.
    common: PathBuf,
    /// Whether `common/worktrees` is watched: git makes it with the first
    /// linked worktree and prune deletes it with the last.
    entries: bool,
    /// The folders the linked worktrees sit in.
    parents: HashSet<PathBuf>,
    /// The linked worktrees' folders, which the watcher's callback reads.
    folders: Arc<Mutex<HashSet<PathBuf>>>,
}

impl WorktreeWatch {
    /// `emit` is handed the path a window listed, once a change settles.
    pub fn new(emit: impl Fn(&str) + Send + 'static) -> Self {
        let (changed, due) = mpsc::channel::<String>();
        let _ = thread::Builder::new().name("worktree-watch".into()).spawn(move || {
            while let Ok(first) = due.recv() {
                let mut repos = HashSet::from([first]);
                let until = Instant::now() + SETTLE;
                while let Some(left) = until.checked_duration_since(Instant::now()) {
                    match due.recv_timeout(left) {
                        Ok(repo) => {
                            repos.insert(repo);
                        }
                        Err(mpsc::RecvTimeoutError::Timeout) => break,
                        Err(mpsc::RecvTimeoutError::Disconnected) => return,
                    }
                }
                for repo in repos {
                    emit(&repo);
                }
            }
        });
        Self { repos: Mutex::new(HashMap::new()), changed }
    }

    /// After a listing of `repo`: starts watching it, or follows its worktrees.
    /// A folder outside git is not watched; the next listing asks again.
    pub fn follow(&self, repo: &str, listed: &[Worktree]) {
        let mut repos = self.repos.lock().unwrap_or_else(|e| e.into_inner());
        let new = !repos.contains_key(repo);
        if new {
            let Some(made) = self.start(repo) else { return };
            repos.insert(repo.to_string(), made);
        }
        let Some(watched) = repos.get_mut(repo) else { return };
        // The first worktree's entry: git made `worktrees/` and went on writing
        // in it before this listing had it watched, so what it wrote since is
        // read once more.
        if watched.update(listed) && !new {
            let _ = self.changed.send(repo.to_string());
        }
    }

    fn start(&self, repo: &str) -> Option<Repo> {
        let common = real(&worktree::common_dir(repo)?);
        let folders = Arc::new(Mutex::new(HashSet::new()));
        let (seen, entries_dir, key, changed) =
            (folders.clone(), common.join("worktrees"), repo.to_string(), self.changed.clone());
        let mut watcher = notify::recommended_watcher(move |event: notify::Result<Event>| {
            let Ok(event) = event else { return };
            let folders = seen.lock().unwrap_or_else(|e| e.into_inner());
            if touches(&event, &entries_dir, &folders) {
                let _ = changed.send(key.clone());
            }
        })
        .ok()?;
        watcher.watch(&common, RecursiveMode::NonRecursive).ok()?;
        Some(Repo { watcher, common, entries: false, parents: HashSet::new(), folders })
    }
}

impl Repo {
    /// True when it started watching `worktrees/`.
    fn update(&mut self, listed: &[Worktree]) -> bool {
        let entries = self.common.join("worktrees");
        let there = entries.is_dir();
        let mut started = false;
        if there && !self.entries {
            self.entries = self.watcher.watch(&entries, RecursiveMode::NonRecursive).is_ok();
            started = self.entries;
        } else if !there && self.entries {
            let _ = self.watcher.unwatch(&entries);
            self.entries = false;
        }

        let folders: HashSet<PathBuf> = listed.iter().filter(|tree| !tree.main).map(|tree| real(Path::new(&tree.path))).collect();
        let parents: HashSet<PathBuf> = folders.iter().filter_map(|folder| folder.parent().map(Path::to_path_buf)).collect();
        for gone in self.parents.difference(&parents) {
            let _ = self.watcher.unwatch(gone);
        }
        let mut kept = HashSet::new();
        for parent in parents {
            if self.parents.contains(&parent) || self.watcher.watch(&parent, RecursiveMode::NonRecursive).is_ok() {
                kept.insert(parent);
            }
        }
        self.parents = kept;
        *self.folders.lock().unwrap_or_else(|e| e.into_inner()) = folders;
        started
    }
}

/// Whether an event is about the worktrees: git's `worktrees/` folder, an
/// entry in it or a `locked` file in an entry, or a linked worktree's folder.
/// The rest of the git dir and of the folders the worktrees sit in is not.
fn touches(event: &Event, entries: &Path, folders: &HashSet<PathBuf>) -> bool {
    if matches!(event.kind, EventKind::Access(_)) {
        return false;
    }
    event.paths.iter().any(|path| {
        if folders.contains(path) {
            return true;
        }
        match path.strip_prefix(entries) {
            Ok(rest) => {
                let parts: Vec<&OsStr> = rest.iter().collect();
                parts.len() <= 1 || (parts.len() == 2 && parts[1] == "locked")
            }
            Err(_) => false,
        }
    })
}

/// The path as the file system reports it in events (`/private/var`, not
/// `/var`), even once the folder is gone, through its parent.
fn real(path: &Path) -> PathBuf {
    if let Ok(real) = path.canonicalize() {
        return real;
    }
    match (path.parent().and_then(|parent| parent.canonicalize().ok()), path.file_name()) {
        (Some(parent), Some(name)) => parent.join(name),
        _ => path.to_path_buf(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use notify::event::{CreateKind, RemoveKind};
    use std::process::Command;

    fn event(kind: EventKind, path: &str) -> Event {
        Event::new(kind).add_path(PathBuf::from(path))
    }

    #[test]
    fn only_worktree_entries_and_folders_count() {
        let entries = Path::new("/r/.git/worktrees");
        let folders = HashSet::from([PathBuf::from("/w/feat")]);
        let made = EventKind::Create(CreateKind::Any);
        let removed = EventKind::Remove(RemoveKind::Any);
        assert!(touches(&event(made, "/r/.git/worktrees"), entries, &folders));
        assert!(touches(&event(made, "/r/.git/worktrees/feat"), entries, &folders));
        assert!(touches(&event(made, "/r/.git/worktrees/feat/locked"), entries, &folders));
        assert!(touches(&event(removed, "/w/feat"), entries, &folders));
        // What a listing itself writes, and the rest of the repo, does not.
        assert!(!touches(&event(made, "/r/.git/worktrees/feat/index"), entries, &folders));
        assert!(!touches(&event(made, "/r/.git/index.lock"), entries, &folders));
        assert!(!touches(&event(made, "/w/other"), entries, &folders));
        assert!(!touches(&event(made, "/w/feat/src/main.rs"), entries, &folders));
    }

    fn git(dir: &Path, args: &[&str]) {
        let status = Command::new("git").arg("-C").arg(dir).args(args).output().expect("git");
        assert!(status.status.success(), "git {args:?}: {}", String::from_utf8_lossy(&status.stderr));
    }

    #[test]
    fn a_worktree_made_and_deleted_outside_is_heard() {
        let root = std::env::temp_dir().join(format!("crew-wt-watch-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        let repo = root.join("repo");
        std::fs::create_dir_all(&repo).unwrap();
        git(&repo, &["init", "-q", "-b", "main"]);
        git(&repo, &["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "--allow-empty", "-m", "first"]);
        let path = repo.to_string_lossy().to_string();

        let (heard, hear) = mpsc::channel();
        let watch = WorktreeWatch::new(move |repo| {
            let _ = heard.send(repo.to_string());
        });
        watch.follow(&path, &worktree::list(&path));
        let wait = || hear.recv_timeout(Duration::from_secs(5));

        let feat = root.join("feat");
        git(&repo, &["worktree", "add", "-q", "-b", "feat", feat.to_str().unwrap()]);
        assert_eq!(wait().as_deref(), Ok(path.as_str()), "git made one");
        watch.follow(&path, &worktree::list(&path));
        while hear.recv_timeout(SETTLE * 3).is_ok() {}

        std::fs::remove_dir_all(&feat).unwrap();
        assert_eq!(wait().as_deref(), Ok(path.as_str()), "its folder went by hand");
        let _ = std::fs::remove_dir_all(&root);
    }
}
