//! Sessions' CLIs seen from crewd: the hooks they report through, and their
//! own histories read back as the chat's blocks.
//!
//! One thread watches the bind folder the hooks drop their records in, and the
//! folders of the histories a chat holds open. A change is read after 40 ms of
//! quiet, or at most 250 ms after the first one; every second everything is
//! looked at again, in case the watch missed it.

use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::{mpsc, Arc, Mutex, MutexGuard};
use std::thread;
use std::time::{Duration, Instant};

use crew_core::provider_session::CLAUDE_BIND_ENV;
use crew_core::session_history::claude::ClaudeDecoder;
use crew_core::session_history::History;
use crew_core::session_live::{hook_owner, LiveBoard};
use crew_core::store::{self as app_state, Store};
use crew_core::{claude_title, session};
use crew_protocol::{HistoryState, SessionHistoryAppended, SessionHistoryWindow, SessionLive};
use notify::{RecommendedWatcher, RecursiveMode, Watcher};

use crate::Hub;

/// The messages a chat opens on; earlier ones load as the reader scrolls up.
const OPEN_MESSAGES: usize = 300;
/// Blocks per window handed to a chat.
const WINDOW_BLOCKS: usize = 300;
const QUIET: Duration = Duration::from_millis(40);
const CEILING: Duration = Duration::from_millis(250);
const BACKSTOP: Duration = Duration::from_secs(1);

#[derive(Clone)]
pub(crate) struct SessionWatch {
    inner: Arc<Mutex<Inner>>,
    /// Keeps the thread's channel open where the platform gives no watcher:
    /// it then runs on the backstop alone.
    _wake: mpsc::Sender<Wake>,
}

struct Inner {
    board: LiveBoard,
    readers: HashMap<String, Reader>,
    /// Watches the bind folder and every open history's folder; None where the platform has none.
    watcher: Option<RecommendedWatcher>,
    /// History folders watched, with how many readers are in each.
    watched: HashMap<PathBuf, usize>,
}

/// One session's history, while some chat holds it open.
struct Reader {
    cwd: String,
    history: History<ClaudeDecoder>,
    clients: HashSet<u64>,
}

enum Wake {
    /// Something changed under this path.
    Path(PathBuf),
}

impl SessionWatch {
    pub(crate) fn start(store: Store, hub: Arc<Hub>) -> Self {
        let (wake, rx) = mpsc::channel();
        let notify_tx = wake.clone();
        let watcher = notify::recommended_watcher(move |event: notify::Result<notify::Event>| {
            let Ok(event) = event else { return };
            for path in event.paths {
                let _ = notify_tx.send(Wake::Path(path));
            }
        })
        .ok();
        let binds = std::env::var_os(CLAUDE_BIND_ENV).map(PathBuf::from);
        let mut inner = Inner { board: LiveBoard::default(), readers: HashMap::new(), watcher, watched: HashMap::new() };
        if let (Some(watcher), Some(binds)) = (inner.watcher.as_mut(), binds.as_ref()) {
            let _ = watcher.watch(binds, RecursiveMode::NonRecursive);
        }
        let watch = Self { inner: Arc::new(Mutex::new(inner)), _wake: wake };
        let worker = watch.clone();
        let _ = thread::Builder::new()
            .name("crewd-sessions".into())
            .spawn(move || worker.run(rx, binds, store, hub));
        watch
    }

    fn lock(&self) -> MutexGuard<'_, Inner> {
        self.inner.lock().unwrap_or_else(|e| e.into_inner())
    }

    pub(crate) fn live(&self, id: &str) -> Option<SessionLive> {
        self.lock().board.get(id)
    }

    /// The chat stopped `id`'s turn with Esc, which Claude answers with no
    /// hook, and, when nothing was said yet, with nothing in its history either.
    pub(crate) fn stopped(&self, hub: &Hub, id: &str) {
        let changed = self.lock().board.turn_ended(id, app_state::now_millis());
        if let Some(live) = changed {
            hub.emit("session-live", live);
        }
    }

    /// The terminal session `id`'s CLI ran in ended.
    pub(crate) fn exited(&self, hub: &Hub, id: &str) {
        let changed = self.lock().board.exited(id, app_state::now_millis());
        if let Some(live) = changed {
            hub.emit("session-live", live);
        }
    }

    pub(crate) fn answered(&self, hub: &Hub, id: &str, ask_id: u64) {
        let changed = self.lock().board.answered(id, ask_id, app_state::now_millis());
        if let Some(live) = changed {
            hub.emit("session-live", live);
        }
    }

    /// A window of `id`'s history for `client`, which holds it open until it
    /// closes it or goes away.
    pub(crate) fn window(
        &self,
        store: &Store,
        client: u64,
        id: &str,
        cwd: &str,
        before: Option<i64>,
    ) -> Result<SessionHistoryWindow, String> {
        let mut inner = self.lock();
        if !inner.readers.contains_key(id) {
            let path = transcript(&inner.board, store, id, cwd)?;
            let history = History::open(&path, ClaudeDecoder::default(), OPEN_MESSAGES).map_err(|e| e.to_string())?;
            inner.watch_folder(&path);
            inner.readers.insert(id.to_string(), Reader { cwd: cwd.to_string(), history, clients: HashSet::new() });
        }
        let reader = inner.readers.get_mut(id).ok_or("History closed")?;
        reader.clients.insert(client);
        if let Some(before) = before {
            // Enough of the file read back to fill the page asked for.
            while before - reader.history.base() < WINDOW_BLOCKS as i64 && reader.history.has_earlier() {
                if reader.history.load_earlier(OPEN_MESSAGES).map_err(|e| e.to_string())? == 0 {
                    break;
                }
            }
        }
        let window = reader.history.window(before, WINDOW_BLOCKS);
        let (state, error) = state_of(&reader.history);
        Ok(SessionHistoryWindow { blocks: window.blocks, start: window.start, more: window.more, state, error })
    }

    pub(crate) fn close(&self, client: u64, id: &str) {
        let mut inner = self.lock();
        let Some(reader) = inner.readers.get_mut(id) else { return };
        reader.clients.remove(&client);
        if reader.clients.is_empty() {
            inner.drop_reader(id);
        }
    }

    /// A window went away: nothing it held open is read for it any more.
    pub(crate) fn drop_client(&self, client: u64) {
        let mut inner = self.lock();
        let gone: Vec<String> = inner
            .readers
            .iter_mut()
            .filter_map(|(id, reader)| {
                reader.clients.remove(&client);
                reader.clients.is_empty().then(|| id.clone())
            })
            .collect();
        for id in gone {
            inner.drop_reader(&id);
        }
    }

    fn run(&self, rx: mpsc::Receiver<Wake>, binds: Option<PathBuf>, store: Store, hub: Arc<Hub>) {
        let mut first_change: Option<Instant> = None;
        let mut last_change = Instant::now();
        let mut binds_dirty = true;
        let mut dirty: HashSet<PathBuf> = HashSet::new();
        let mut backstop = Instant::now() + BACKSTOP;
        loop {
            let now = Instant::now();
            let due = match first_change {
                Some(first) => (last_change + QUIET).min(first + CEILING),
                None => backstop,
            };
            match rx.recv_timeout(due.saturating_duration_since(now)) {
                Ok(Wake::Path(path)) => {
                    if binds.as_deref().is_some_and(|dir| path.starts_with(dir)) {
                        binds_dirty = true;
                    } else if let Some(folder) = path.parent() {
                        dirty.insert(folder.to_path_buf());
                    }
                    last_change = Instant::now();
                    first_change.get_or_insert(last_change);
                    continue;
                }
                Err(mpsc::RecvTimeoutError::Disconnected) => return,
                Err(mpsc::RecvTimeoutError::Timeout) => {}
            }
            let everything = Instant::now() >= backstop;
            if everything {
                backstop = Instant::now() + BACKSTOP;
            }
            if binds_dirty || everything {
                if let Some(dir) = binds.as_deref() {
                    self.read_binds(dir, &store, &hub);
                }
            }
            self.poll_histories(&hub, if everything { None } else { Some(&dirty) });
            binds_dirty = false;
            dirty.clear();
            first_change = None;
        }
    }

    /// The hooks' records, oldest first; each is read once and removed.
    fn read_binds(&self, dir: &Path, store: &Store, hub: &Hub) {
        let mut records: Vec<(std::time::SystemTime, String, PathBuf)> = std::fs::read_dir(dir)
            .into_iter()
            .flatten()
            .flatten()
            .filter_map(|entry| {
                let name = entry.file_name().into_string().ok()?;
                hook_owner(&name)?;
                let at = entry.metadata().ok()?.modified().ok()?;
                Some((at, name, entry.path()))
            })
            .collect();
        records.sort();
        let mut started = HashSet::new();
        for (_, name, path) in records {
            let Ok(record) = std::fs::read_to_string(&path) else { continue };
            let _ = std::fs::remove_file(&path);
            let Some(owner) = hook_owner(&name) else { continue };
            let changed = self.lock().board.hook(owner, &record, app_state::now_millis());
            let Some(live) = changed else { continue };
            if record.contains("\"SessionStart\"") {
                started.insert(owner.to_string());
            }
            hub.emit("session-live", live);
        }
        // A start may be a `/clear`: the session follows the CLI to its new
        // conversation, and a chat reading the old one moves with it.
        for id in started {
            if let Err(error) = crate::rebind_claude_session(store, hub, id.clone()) {
                eprintln!("[crewd] following {id}: {error}");
            }
            self.repoint(&id, store, hub);
        }
    }

    /// The chat reading `id` follows the CLI to the file it writes now.
    fn repoint(&self, id: &str, store: &Store, hub: &Hub) {
        let mut inner = self.lock();
        let Some(cwd) = inner.readers.get(id).map(|reader| reader.cwd.clone()) else { return };
        let Ok(path) = transcript(&inner.board, store, id, &cwd) else { return };
        if inner.readers.get(id).is_some_and(|reader| reader.history.path() == path) {
            return;
        }
        let Ok(history) = History::open(&path, ClaudeDecoder::default(), OPEN_MESSAGES) else { return };
        let old = inner.readers.get(id).map(|reader| reader.history.path().to_path_buf());
        inner.watch_folder(&path);
        if let Some(old) = old {
            inner.unwatch_folder(&old);
        }
        let (state, _) = state_of(&history);
        if let Some(reader) = inner.readers.get_mut(id) {
            reader.history = history;
        }
        drop(inner);
        hub.emit(
            "session-history-appended",
            SessionHistoryAppended { session_id: id.to_string(), from: 0, blocks: Vec::new(), reset: true, state },
        );
    }

    fn poll_histories(&self, hub: &Hub, only: Option<&HashSet<PathBuf>>) {
        let mut inner = self.lock();
        let now = app_state::now_millis();
        let mut out = Vec::new();
        let mut ended = Vec::new();
        for (id, reader) in inner.readers.iter_mut() {
            let folder = reader.history.path().parent().map(Path::to_path_buf);
            if only.is_some_and(|dirty| !folder.as_ref().is_some_and(|folder| dirty.contains(folder))) {
                continue;
            }
            let Ok(Some(change)) = reader.history.poll() else { continue };
            if change.turn_ended {
                ended.push(id.clone());
            }
            let (state, _) = state_of(&reader.history);
            out.push(SessionHistoryAppended {
                session_id: id.clone(),
                from: change.from,
                blocks: change.blocks,
                reset: change.reset,
                state,
            });
        }
        let lives: Vec<SessionLive> = ended.iter().filter_map(|id| inner.board.turn_ended(id, now)).collect();
        drop(inner);
        for appended in out {
            hub.emit("session-history-appended", appended);
        }
        for live in lives {
            hub.emit("session-live", live);
        }
    }
}

impl Inner {
    fn watch_folder(&mut self, file: &Path) {
        let Some(folder) = file.parent() else { return };
        let count = self.watched.entry(folder.to_path_buf()).or_insert(0);
        *count += 1;
        if *count == 1 {
            if let Some(watcher) = self.watcher.as_mut() {
                // A folder that is not there yet is found by the backstop.
                let _ = watcher.watch(folder, RecursiveMode::NonRecursive);
            }
        }
    }

    fn unwatch_folder(&mut self, file: &Path) {
        let Some(folder) = file.parent() else { return };
        let Some(count) = self.watched.get_mut(folder) else { return };
        *count -= 1;
        if *count == 0 {
            self.watched.remove(folder);
            if let Some(watcher) = self.watcher.as_mut() {
                let _ = watcher.unwatch(folder);
            }
        }
    }

    fn drop_reader(&mut self, id: &str) {
        if let Some(reader) = self.readers.remove(id) {
            let path = reader.history.path().to_path_buf();
            self.unwatch_folder(&path);
        }
    }
}

/// Where the CLI writes session `id`'s conversation: the path its hook
/// reported, else where Claude files it under `cwd` by the id it runs as.
fn transcript(board: &LiveBoard, store: &Store, id: &str, cwd: &str) -> Result<PathBuf, String> {
    if let Some(path) = board.transcript_path(id) {
        return Ok(PathBuf::from(path));
    }
    let row = session::get(store, id.to_string())?.ok_or("Session not found")?;
    if row.provider != "claude" {
        return Err(format!("Crew can't read {}'s history yet", row.provider));
    }
    let claude_id = row.provider_session_id.unwrap_or_else(|| id.to_string());
    claude_title::transcript_path(cwd, &claude_id)
        .map(PathBuf::from)
        .ok_or_else(|| "No home folder to find Claude's history in".to_string())
}

fn state_of(history: &History<ClaudeDecoder>) -> (HistoryState, Option<String>) {
    if history.is_empty_decode() {
        return (
            HistoryState::Error,
            Some(format!("{} has messages, and none of them could be read.", history.path().display())),
        );
    }
    if history.blocks().is_empty() && !history.path().exists() {
        return (HistoryState::Pending, None);
    }
    (HistoryState::Ready, None)
}
