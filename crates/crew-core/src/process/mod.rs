//! Processes a workspace keeps running: dev servers, watchers,
//! workers. Each runs in a supervised PTY, so it has colours and takes keys
//! like a terminal, but never waits on anyone to read it: everything it prints
//! goes to a log on disk, and a viewer that falls behind is resynced.
//!
//! Every call is scoped to a workspace, and a process is named by its id or
//! by its name there. A process is a definition of the workspace; it runs in
//! one of its worktrees, at most once in each. The MCP tools and the window's
//! RPCs are thin wrappers.

mod log;
pub mod text;

use std::collections::{BTreeMap, HashMap, VecDeque};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Condvar, Mutex, MutexGuard, Weak};
use std::thread;
use std::time::{Duration, Instant};

use crew_protocol::{LogChunk, LogGrep, LogMatch, LogWait, Process, ProcessRun, ProcessSpec, ProcessState};
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};

use crate::pty::{PtyHost, PtySink, SpawnOptions};
use crate::store::{has_column, now_millis, set_order, Store};

pub use log::LogStore;

pub const MIGRATION_PROCESSES: &str = r#"
CREATE TABLE IF NOT EXISTS processes (
  id            TEXT PRIMARY KEY,
  workspace_id  TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  name          TEXT NOT NULL,
  command       TEXT NOT NULL,
  cwd           TEXT NOT NULL DEFAULT '',
  env_json      TEXT NOT NULL DEFAULT '{}',
  auto_start    INTEGER NOT NULL DEFAULT 0,
  auto_restart  INTEGER NOT NULL DEFAULT 0,
  created_by    TEXT,
  sort_order    INTEGER NOT NULL DEFAULT 0,
  approved      INTEGER NOT NULL DEFAULT 1,
  proposed_json TEXT,
  requested_by  TEXT,
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS processes_workspace_idx ON processes (workspace_id, sort_order);
"#;

/// A name is how agents and the CLI reach a process, so two by one name in a
/// workspace would leave one unreachable. Rows from before the index are
/// renamed first, the oldest keeping its name: `web`, `web (2)`. `revision`
/// counts changes, for an approval to name the one the user read.
pub fn migrate_unique_names(conn: &Connection) -> rusqlite::Result<()> {
    if !has_column(conn, "processes", "revision")? {
        conn.execute_batch("ALTER TABLE processes ADD COLUMN revision INTEGER NOT NULL DEFAULT 0;")?;
    }
    let rows: Vec<(String, String, String)> = conn
        .prepare("SELECT id, workspace_id, name FROM processes ORDER BY created_at ASC, sort_order ASC, id ASC")?
        .query_map([], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)))?
        .collect::<rusqlite::Result<_>>()?;
    let mut taken: HashMap<&str, std::collections::HashSet<String>> = HashMap::new();
    for (_, workspace, name) in &rows {
        taken.entry(workspace.as_str()).or_default().insert(name.clone());
    }
    let mut kept: std::collections::HashSet<(&str, &str)> = std::collections::HashSet::new();
    for (id, workspace, name) in &rows {
        if kept.insert((workspace.as_str(), name.as_str())) {
            continue;
        }
        let names = taken.entry(workspace.as_str()).or_default();
        let fresh = (2..)
            .map(|n| format!("{name} ({n})"))
            .find(|candidate| !names.contains(candidate))
            .expect("some number is free");
        names.insert(fresh.clone());
        conn.execute(
            "UPDATE processes SET name = ?2, revision = revision + 1 WHERE id = ?1",
            params![id, fresh],
        )?;
    }
    conn.execute_batch("CREATE UNIQUE INDEX IF NOT EXISTS processes_name_idx ON processes (workspace_id, name);")
}

/// A server's first paint is a screen or two; a whole log would bury a model.
const READ_DEFAULT: u32 = 16 * 1024;
const READ_MAX: u32 = 256 * 1024;
const TAIL_DEFAULT: u32 = 200;
const TAIL_MAX: u32 = 5000;
const MATCHES_DEFAULT: u32 = 20;
const MATCHES_MAX: u32 = 200;
const CONTEXT_MAX: u32 = 10;
/// The MCP shim gives `wait_for_log` its timeout plus ten seconds; past a
/// minute a caller is better off polling with the cursor.
pub const WAIT_MAX_S: u32 = 60;
/// Grid a process starts with; the first viewer resizes it to its pane.
const COLS: u16 = 120;
const ROWS: u16 = 32;
/// After SIGKILL the child still has to be reaped and its output drained.
const KILL_SETTLE: Duration = Duration::from_secs(3);

#[derive(Clone, Debug)]
pub struct ProcessConfig {
    /// Between SIGTERM and SIGKILL on stop. A terminal gets one second; a
    /// server flushing a database gets more.
    pub stop_grace: Duration,
    pub backoff_min: Duration,
    pub backoff_max: Duration,
    /// Up this long, a run counts as healthy and the backoff starts over.
    pub stable_after: Duration,
    /// This many crashes inside `crash_window` and the process stays down.
    pub crash_limit: usize,
    pub crash_window: Duration,
    pub rotate_at: u64,
}

impl Default for ProcessConfig {
    fn default() -> Self {
        Self {
            stop_grace: Duration::from_secs(5),
            backoff_min: Duration::from_secs(1),
            backoff_max: Duration::from_secs(30),
            stable_after: Duration::from_secs(60),
            crash_limit: 5,
            crash_window: Duration::from_secs(120),
            rotate_at: log::ROTATE_AT,
        }
    }
}

/// Fields to change on `update`; the ones left `None` stay. A proposal is
/// stored as one too, so approving it lays only what the agent asked for over
/// the definition as it is by then, and an edit made meanwhile stays.
///
/// Stored the way a `ProcessSpec` serializes, so a proposal written as a
/// whole spec before reads back as a patch of every field.
#[derive(Default, Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProcessPatch {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub command: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cwd: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub env: Option<BTreeMap<String, String>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub auto_restart: Option<bool>,
}

impl ProcessPatch {
    fn apply(&self, spec: &ProcessSpec) -> ProcessSpec {
        ProcessSpec {
            name: self.name.clone().unwrap_or_else(|| spec.name.clone()),
            command: self.command.clone().unwrap_or_else(|| spec.command.clone()),
            cwd: self.cwd.clone().unwrap_or_else(|| spec.cwd.clone()),
            env: self.env.clone().unwrap_or_else(|| spec.env.clone()),
            auto_restart: self.auto_restart.unwrap_or(spec.auto_restart),
        }
    }

    /// The fields where `to` differs from `from`.
    fn diff(from: &ProcessSpec, to: &ProcessSpec) -> Self {
        fn changed<T: PartialEq + Clone>(a: &T, b: &T) -> Option<T> {
            (a != b).then(|| b.clone())
        }
        Self {
            name: changed(&from.name, &to.name),
            command: changed(&from.command, &to.command),
            cwd: changed(&from.cwd, &to.cwd),
            env: changed(&from.env, &to.env),
            auto_restart: changed(&from.auto_restart, &to.auto_restart),
        }
    }

    /// `later` on top of this: where both set a field, `later` wins.
    fn then(&self, later: &Self) -> Self {
        Self {
            name: later.name.clone().or_else(|| self.name.clone()),
            command: later.command.clone().or_else(|| self.command.clone()),
            cwd: later.cwd.clone().or_else(|| self.cwd.clone()),
            env: later.env.clone().or_else(|| self.env.clone()),
            auto_restart: later.auto_restart.or(self.auto_restart),
        }
    }

    /// This without the fields `other` sets.
    fn without(&self, other: &Self) -> Self {
        fn keep<T: Clone>(mine: &Option<T>, theirs: &Option<T>) -> Option<T> {
            if theirs.is_some() {
                None
            } else {
                mine.clone()
            }
        }
        Self {
            name: keep(&self.name, &other.name),
            command: keep(&self.command, &other.command),
            cwd: keep(&self.cwd, &other.cwd),
            env: keep(&self.env, &other.env),
            auto_restart: keep(&self.auto_restart, &other.auto_restart),
        }
    }

    fn is_empty(&self) -> bool {
        *self == Self::default()
    }
}

pub trait ProcessEvents: Send + Sync {
    fn changed(&self, process: &Process);
    fn removed(&self, workspace_id: &str, id: &str);
}

/// The PTY a run lives in. A viewer attaches to it with `pty_attach`.
pub fn pty_id(process_id: &str, worktree: Option<&str>) -> String {
    format!("process:{process_id}:{}", run_slug(worktree))
}

/// A run's name on disk and in its PTY's id: `main` for the main checkout,
/// a hash of the path for a worktree. FNV-1a, so it holds across builds and
/// a log is found again after an update.
fn run_slug(worktree: Option<&str>) -> String {
    let Some(path) = worktree else {
        return "main".into();
    };
    let hash = path.bytes().fold(0xcbf2_9ce4_8422_2325_u64, |hash, byte| {
        (hash ^ u64::from(byte)).wrapping_mul(0x0000_0100_0000_01b3)
    });
    format!("wt-{hash:016x}")
}

/// A run: the process, and the worktree it runs in (`None`, the main checkout).
type Key = (String, Option<String>);

/// What a start asks for beyond the process itself.
#[derive(Clone, Debug, Default)]
pub struct RunRequest {
    /// `None` is the main checkout.
    pub worktree: Option<String>,
    /// Laid over the definition's for this run. `None` on a restart keeps
    /// the last run's; on a start it is none.
    pub env: Option<BTreeMap<String, String>>,
    /// The session starting it; `None` is the user.
    pub started_by: Option<String>,
}

#[derive(Clone)]
struct Def {
    id: String,
    workspace_id: String,
    spec: ProcessSpec,
    created_by: Option<String>,
    approved: bool,
    proposed: Option<ProcessPatch>,
    requested_by: Option<String>,
    revision: u64,
}

impl Def {
    /// What approving would change, measured against the definition as it is
    /// now: a field the agent asked for that already holds that value is no
    /// change, and a proposal of nothing but those is none.
    fn pending(&self) -> Option<ProcessPatch> {
        let proposed = self.proposed.as_ref()?;
        Some(ProcessPatch::diff(&self.spec, &proposed.apply(&self.spec))).filter(|patch| !patch.is_empty())
    }
}

/// What the daemon knows of a run beyond the definition. Gone with the
/// daemon: after a restart nothing runs until something starts it.
struct Run {
    state: ProcessState,
    /// Bumped by every spawn and every cancelled restart: an exit or a timer
    /// from an older run finds a different number and leaves this one alone.
    generation: u64,
    pid: Option<u32>,
    stream_id: Option<u32>,
    started_at: Option<i64>,
    started: Option<Instant>,
    exit_code: Option<i32>,
    restarts: u32,
    crashes: VecDeque<Instant>,
    backoff: Duration,
    /// The exit that comes is one the user asked for.
    stopping: bool,
    run_cursor: u64,
    env: BTreeMap<String, String>,
    started_by: Option<String>,
}

impl Default for Run {
    fn default() -> Self {
        Self {
            state: ProcessState::Stopped,
            generation: 0,
            pid: None,
            stream_id: None,
            started_at: None,
            started: None,
            exit_code: None,
            restarts: 0,
            crashes: VecDeque::new(),
            backoff: Duration::ZERO,
            stopping: false,
            run_cursor: 0,
            env: BTreeMap::new(),
            started_by: None,
        }
    }
}

fn live(state: ProcessState) -> bool {
    matches!(state, ProcessState::Running | ProcessState::Paused)
}

struct Inner {
    store: Store,
    pty: PtyHost,
    logs_dir: PathBuf,
    config: ProcessConfig,
    runs: Mutex<HashMap<Key, Run>>,
    /// Held across a definition's read and its write, so a change that lands
    /// in between (an agent's proposal while the user approves) is not lost
    /// or approved unseen.
    edits: Mutex<()>,
    /// Signalled whenever a run's state moves, for `stop` to wait on.
    moved: Condvar,
    logs: Mutex<HashMap<Key, Arc<LogStore>>>,
    events: Mutex<Option<Arc<dyn ProcessEvents>>>,
    /// The daemon is going down: nothing restarts.
    closing: AtomicBool,
}

#[derive(Clone)]
pub struct ProcessHost {
    inner: Arc<Inner>,
}

struct RunSink {
    host: Weak<Inner>,
    key: Key,
    generation: u64,
    log: Arc<LogStore>,
}

impl PtySink for RunSink {
    fn output(&self, bytes: &[u8]) {
        self.log.append(bytes);
    }

    fn exit(&self, code: Option<i32>) {
        if let Some(inner) = self.host.upgrade() {
            ProcessHost { inner }.on_exit(&self.key, self.generation, code);
        }
    }
}

impl ProcessHost {
    pub fn new(store: Store, pty: PtyHost, data_dir: &Path) -> Self {
        Self::with_config(store, pty, data_dir, ProcessConfig::default())
    }

    pub fn with_config(store: Store, pty: PtyHost, data_dir: &Path, config: ProcessConfig) -> Self {
        let logs_dir = data_dir.join("logs");
        log::move_to_main(&logs_dir);
        Self {
            inner: Arc::new(Inner {
                store,
                pty,
                logs_dir,
                config,
                runs: Mutex::new(HashMap::new()),
                edits: Mutex::new(()),
                moved: Condvar::new(),
                logs: Mutex::new(HashMap::new()),
                events: Mutex::new(None),
                closing: AtomicBool::new(false),
            }),
        }
    }

    pub fn set_events(&self, events: Arc<dyn ProcessEvents>) {
        *self.inner.events.lock().unwrap_or_else(|e| e.into_inner()) = Some(events);
    }

    fn runs(&self) -> MutexGuard<'_, HashMap<Key, Run>> {
        self.inner.runs.lock().unwrap_or_else(|e| e.into_inner())
    }

    fn events(&self) -> Option<Arc<dyn ProcessEvents>> {
        self.inner.events.lock().unwrap_or_else(|e| e.into_inner()).clone()
    }

    fn edits(&self) -> MutexGuard<'_, ()> {
        self.inner.edits.lock().unwrap_or_else(|e| e.into_inner())
    }

    /// Every change of state comes through here. It wakes whoever waits on
    /// the log too: a halt from `Starting` or a restart that fails writes
    /// nothing, and a `wait_for_log` must hear it ended rather than sleep out
    /// its timeout.
    fn emit(&self, id: &str) {
        self.wake_waiters(id);
        let Some(events) = self.events() else {
            return;
        };
        if let Ok(Some(def)) = self.def_by_id(id) {
            events.changed(&self.snapshot(def));
        }
    }

    /// Every run's, without opening a log: nobody waits on one that is not open.
    fn wake_waiters(&self, id: &str) {
        let logs: Vec<Arc<LogStore>> = self
            .inner
            .logs
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .iter()
            .filter(|((process, _), _)| process == id)
            .map(|(_, log)| log.clone())
            .collect();
        for log in logs {
            log.notify();
        }
    }

    // ---- definitions ----------------------------------------------------

    pub fn list(&self, workspace_id: &str) -> Result<Vec<Process>, String> {
        Ok(self.defs(workspace_id)?.into_iter().map(|def| self.snapshot(def)).collect())
    }

    fn defs(&self, workspace_id: &str) -> Result<Vec<Def>, String> {
        self.inner.store.with(|conn| {
            let mut stmt = conn.prepare_cached(&format!(
                "{SELECT} WHERE workspace_id = ?1 ORDER BY sort_order ASC, created_at ASC"
            ))?;
            let rows = stmt.query_map(params![workspace_id], row_to_def)?;
            rows.collect::<rusqlite::Result<Vec<_>>>()
        })
    }

    pub fn get(&self, workspace_id: &str, process: &str) -> Result<Process, String> {
        Ok(self.snapshot(self.resolve(workspace_id, process)?))
    }

    /// `ask_approval` leaves it `pending-approval`: a caller the user has not
    /// trusted to run things unattended cannot run a command by writing one.
    pub fn create(
        &self,
        workspace_id: &str,
        spec: ProcessSpec,
        created_by: Option<String>,
        ask_approval: bool,
    ) -> Result<Process, String> {
        crate::workspace::get(&self.inner.store, workspace_id.to_string())?
            .ok_or("Workspace not found")?;
        let spec = tidy(spec)?;
        relative_cwd(&spec.cwd)?;
        let edits = self.edits();
        self.ensure_free_name(workspace_id, &spec.name, None)?;
        let id = uuid::Uuid::new_v4().to_string();
        let now = now_millis();
        let env = serde_json::to_string(&spec.env).map_err(|e| e.to_string())?;
        let requested_by = if ask_approval { created_by.clone() } else { None };
        self.inner.store.with(|conn| {
            let order: i64 = conn.query_row(
                "SELECT COALESCE(MAX(sort_order), -1) + 1 FROM processes WHERE workspace_id = ?1",
                params![workspace_id],
                |row| row.get(0),
            )?;
            conn.execute(
                "INSERT INTO processes (id, workspace_id, name, command, cwd, env_json,
                   auto_restart, created_by, sort_order, approved, requested_by, created_at, updated_at)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?12)",
                params![
                    id,
                    workspace_id,
                    spec.name,
                    spec.command,
                    spec.cwd,
                    env,
                    spec.auto_restart,
                    created_by,
                    order,
                    !ask_approval,
                    requested_by,
                    now
                ],
            )
        })
        .map_err(|error| name_taken(error, &spec.name))?;
        drop(edits);
        self.emit(&id);
        self.get(workspace_id, &id)
    }

    /// A change that needs approval waits beside the accepted definition,
    /// which keeps running until the user takes the new one.
    pub fn update(
        &self,
        workspace_id: &str,
        process: &str,
        patch: ProcessPatch,
        updated_by: Option<String>,
        ask_approval: bool,
    ) -> Result<Process, String> {
        if let Some(cwd) = &patch.cwd {
            relative_cwd(cwd)?;
        }
        let edits = self.edits();
        let def = self.resolve(workspace_id, process)?;
        if ask_approval && def.approved {
            // On top of what is already proposed: two asks in a row are one
            // change. Only what differs from the definition is kept, so a
            // field the agent left alone never overwrites it on approval.
            let asked = def.proposed.clone().unwrap_or_default().then(&patch);
            let next = tidy(asked.apply(&def.spec))?;
            self.ensure_free_name(workspace_id, &next.name, Some(&def.id))?;
            let proposal = ProcessPatch::diff(&def.spec, &next);
            if proposal.is_empty() {
                self.clear_proposal(&def.id)?;
            } else {
                let proposed = serde_json::to_string(&proposal).map_err(|e| e.to_string())?;
                self.inner.store.with(|conn| {
                    conn.execute(
                        "UPDATE processes SET proposed_json = ?2, requested_by = ?3, updated_at = ?4,
                           revision = revision + 1 WHERE id = ?1",
                        params![def.id, proposed, updated_by, now_millis()],
                    )
                })?;
            }
        } else {
            let next = tidy(patch.apply(&def.spec))?;
            self.ensure_free_name(workspace_id, &next.name, Some(&def.id))?;
            // A field set here outranks what an agent proposed for it before:
            // approving that proposal later must not undo this edit. The rest
            // of the proposal still waits.
            let proposal = def
                .proposed
                .as_ref()
                .map(|proposed| proposed.without(&ProcessPatch::diff(&def.spec, &next)))
                .filter(|proposal| !proposal.is_empty());
            // An unapproved process stays a request, now from whoever changed
            // it last. An approved one is asked for by the proposer, if any.
            let requested_by = match (def.approved, &proposal) {
                (false, _) => updated_by.or(def.requested_by),
                (true, Some(_)) => def.requested_by,
                (true, None) => None,
            };
            self.write_spec(&def.id, &next, def.approved, proposal.as_ref(), requested_by)?;
        }
        drop(edits);
        self.emit(&def.id);
        self.get(workspace_id, &def.id)
    }

    /// The whole row but its runtime, and a new revision.
    fn write_spec(
        &self,
        id: &str,
        spec: &ProcessSpec,
        approved: bool,
        proposal: Option<&ProcessPatch>,
        requested_by: Option<String>,
    ) -> Result<(), String> {
        let env = serde_json::to_string(&spec.env).map_err(|e| e.to_string())?;
        let proposal = proposal
            .map(|proposal| serde_json::to_string(proposal).map_err(|e| e.to_string()))
            .transpose()?;
        self.inner
            .store
            .with(|conn| {
                conn.execute(
                    "UPDATE processes SET name = ?2, command = ?3, cwd = ?4, env_json = ?5,
                       auto_restart = ?6, approved = ?7, proposed_json = ?8, requested_by = ?9, updated_at = ?10,
                       revision = revision + 1 WHERE id = ?1",
                    params![
                        id,
                        spec.name,
                        spec.command,
                        spec.cwd,
                        env,
                        spec.auto_restart,
                        approved,
                        proposal,
                        requested_by,
                        now_millis()
                    ],
                )
            })
            .map_err(|error| name_taken(error, &spec.name))?;
        Ok(())
    }

    /// Stops every run first; the logs of all of them go with it.
    pub fn delete(&self, workspace_id: &str, process: &str) -> Result<(), String> {
        let def = self.resolve(workspace_id, process)?;
        let keys = self.keys_of(&def.id);
        for key in &keys {
            self.halt(key);
        }
        self.runs().retain(|(id, _), _| *id != def.id);
        self.wake_waiters(&def.id);
        self.inner
            .store
            .with(|conn| conn.execute("DELETE FROM processes WHERE id = ?1", params![def.id]))?;
        self.inner
            .logs
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .retain(|(id, _), _| *id != def.id);
        let _ = std::fs::remove_dir_all(self.inner.logs_dir.join(&def.id));
        if let Some(events) = self.events() {
            events.removed(workspace_id, &def.id);
        }
        Ok(())
    }

    /// The user accepts what an agent wrote, as it stood at `revision`: the
    /// one they read. Anything since (an agent swapping the command while
    /// the card was open) is refused, for them to read again. A proposal is
    /// laid over the definition as it is now, so an edit made meanwhile
    /// stays. Nothing starts: that is for whoever asked for it, or the user.
    pub fn approve(&self, workspace_id: &str, process: &str, revision: u64) -> Result<Process, String> {
        let edits = self.edits();
        let def = self.resolve(workspace_id, process)?;
        if def.revision != revision {
            return Err(format!("\"{}\" changed while you were reading it; review it again", def.spec.name));
        }
        let first = !def.approved;
        let next = match def.pending() {
            Some(patch) => tidy(patch.apply(&def.spec))?,
            None if first => def.spec.clone(),
            None if def.proposed.is_some() => {
                // Nothing left to change: the definition already says it.
                self.clear_proposal(&def.id)?;
                drop(edits);
                self.emit(&def.id);
                return self.get(workspace_id, &def.id);
            }
            None => return self.get(workspace_id, &def.id),
        };
        // A rename proposed a while ago may have been taken since.
        self.ensure_free_name(workspace_id, &next.name, Some(&def.id))?;
        self.write_spec(&def.id, &next, true, None, None)?;
        drop(edits);
        self.emit(&def.id);
        self.get(workspace_id, &def.id)
    }

    /// A process nobody accepted is deleted; a proposed change is dropped.
    pub fn reject(&self, workspace_id: &str, process: &str) -> Result<Option<Process>, String> {
        let edits = self.edits();
        let def = self.resolve(workspace_id, process)?;
        if !def.approved {
            drop(edits);
            self.delete(workspace_id, &def.id)?;
            return Ok(None);
        }
        self.clear_proposal(&def.id)?;
        drop(edits);
        self.emit(&def.id);
        self.get(workspace_id, &def.id).map(Some)
    }

    fn clear_proposal(&self, id: &str) -> Result<(), String> {
        self.inner.store.with(|conn| {
            conn.execute(
                "UPDATE processes SET proposed_json = NULL, requested_by = NULL, revision = revision + 1 WHERE id = ?1",
                params![id],
            )
        })?;
        Ok(())
    }

    pub fn reorder(&self, workspace_id: &str, ids: &[String]) -> Result<(), String> {
        let mine: Vec<String> = self
            .list(workspace_id)?
            .into_iter()
            .map(|process| process.id)
            .filter(|id| ids.contains(id))
            .collect();
        let ordered: Vec<String> = ids.iter().filter(|id| mine.contains(id)).cloned().collect();
        self.inner.store.with(|conn| set_order(conn, "processes", &ordered))
    }

    // ---- running --------------------------------------------------------

    /// Starts it in `request.worktree` unless it already runs there. Fails on
    /// a process still waiting for approval, or a worktree the workspace does
    /// not have.
    pub fn start(&self, workspace_id: &str, process: &str, request: RunRequest) -> Result<Process, String> {
        let def = self.resolve(workspace_id, process)?;
        if !def.approved {
            return Err(format!(
                "\"{}\" is waiting for the user to approve it in Crew; it cannot start until then",
                def.spec.name
            ));
        }
        let worktree = self.place(&def, request.worktree.as_deref(), true)?;
        let key = (def.id.clone(), worktree);
        let cwd = self.cwd_of(&def, key.1.as_deref())?;
        {
            let mut runs = self.runs();
            let run = runs.entry(key.clone()).or_default();
            if live(run.state) {
                drop(runs);
                return self.get(workspace_id, &def.id);
            }
            // A start by hand is a fresh count: the user saw it crash.
            run.restarts = 0;
            run.crashes.clear();
            run.backoff = Duration::ZERO;
            run.env = request.env.unwrap_or_default();
            run.started_by = request.started_by;
            let spawned = self.spawn_run(run, &def, &key, cwd);
            drop(runs);
            self.inner.moved.notify_all();
            self.emit(&def.id);
            spawned?;
        }
        self.get(workspace_id, &def.id)
    }

    fn spawn_run(&self, run: &mut Run, def: &Def, key: &Key, cwd: String) -> Result<(), String> {
        run.generation += 1;
        run.stopping = false;
        run.exit_code = None;
        let log = self.log(key)?;
        run.run_cursor = log.total();
        let own: Vec<String> = run.env.iter().map(|(k, v)| format!("{k}={v}")).collect();
        log.note(&format!("$ {}", [own.join(" "), def.spec.command.clone()].join(" ").trim_start()));
        let sink = Arc::new(RunSink {
            host: Arc::downgrade(&self.inner),
            key: key.clone(),
            generation: run.generation,
            log: log.clone(),
        });
        let shell = std::env::var("SHELL")
            .ok()
            .filter(|shell| !shell.is_empty())
            .unwrap_or_else(|| "/bin/zsh".into());
        let mut env = def.spec.env.clone();
        env.extend(run.env.clone());
        let options = SpawnOptions {
            env: env.into_iter().collect(),
            supervised: Some(sink),
            ..SpawnOptions::default()
        };
        let id = pty_id(&key.0, key.1.as_deref());
        // The user's shell reads the command, so pipes, `&&` and globs work
        // as typed; PATH is the login shell's, which the PTY sets.
        let argv = vec![shell, "-c".into(), def.spec.command.clone()];
        match self.inner.pty.spawn_with(id.clone(), cwd, argv, COLS, ROWS, options) {
            Ok(stream_id) => {
                run.state = ProcessState::Running;
                run.stream_id = Some(stream_id);
                run.pid = self.inner.pty.pid(&id);
                run.started_at = Some(now_millis());
                run.started = Some(Instant::now());
                Ok(())
            }
            Err(error) => {
                log.note(&error);
                run.state = ProcessState::Exited;
                run.pid = None;
                run.stream_id = None;
                Err(error)
            }
        }
    }

    fn on_exit(&self, key: &Key, generation: u64, code: Option<i32>) {
        let def = self.def_by_id(&key.0).ok().flatten();
        let mut runs = self.runs();
        let Some(run) = runs.get_mut(key) else {
            return;
        };
        if run.generation != generation {
            return;
        }
        let uptime = run.started.map(|at| at.elapsed()).unwrap_or_default();
        run.pid = None;
        run.stream_id = None;
        run.exit_code = code;
        let log = self.log(key).ok();
        if let Some(log) = &log {
            let how = code.map_or("killed by a signal".to_string(), |code| format!("exited with code {code}"));
            log.note(&how);
        }
        let restart = def.as_ref().is_some_and(|def| def.approved && def.spec.auto_restart);
        if run.stopping || self.inner.closing.load(Ordering::Acquire) || def.is_none() {
            run.state = ProcessState::Stopped;
            run.stopping = false;
        } else if !restart {
            run.state = ProcessState::Exited;
        } else {
            match plan_restart(&mut run.crashes, &mut run.backoff, Instant::now(), uptime, &self.inner.config) {
                Some(delay) => {
                    run.state = ProcessState::Starting;
                    run.restarts += 1;
                    if let Some(log) = &log {
                        let secs = delay.as_secs_f32();
                        log.note(&format!("restarting in {secs:.1}s"));
                    }
                    let host = self.clone();
                    let key = key.clone();
                    thread::spawn(move || {
                        thread::sleep(delay);
                        host.restart_due(&key, generation);
                    });
                }
                None => {
                    run.state = ProcessState::Crashed;
                    if let Some(log) = &log {
                        let limit = self.inner.config.crash_limit;
                        let window = self.inner.config.crash_window.as_secs();
                        log.note(&format!("crashed {limit} times in {window}s; left stopped"));
                    }
                }
            }
        }
        drop(runs);
        self.inner.moved.notify_all();
        self.emit(&key.0);
    }

    /// A backoff ran out. Anything that happened meanwhile (a stop, a start
    /// by hand) moved the generation on, and the timer is stale.
    fn restart_due(&self, key: &Key, generation: u64) {
        if self.inner.closing.load(Ordering::Acquire) {
            return;
        }
        let Ok(Some(def)) = self.def_by_id(&key.0) else {
            return;
        };
        let cwd = self.cwd_of(&def, key.1.as_deref());
        let mut runs = self.runs();
        let Some(run) = runs.get_mut(key) else {
            return;
        };
        if run.generation != generation || run.state != ProcessState::Starting {
            return;
        }
        let result = match cwd {
            Ok(cwd) => self.spawn_run(run, &def, key, cwd),
            Err(error) => {
                run.state = ProcessState::Exited;
                Err(error)
            }
        };
        drop(runs);
        if let Err(error) = result {
            eprintln!("[process] {}: restart failed: {error}", key.0);
        }
        self.inner.moved.notify_all();
        self.emit(&key.0);
    }

    /// SIGTERM to the whole group, SIGKILL once the grace runs out. Returns
    /// once it has exited. A worktree that is gone can still be stopped in.
    pub fn stop(&self, workspace_id: &str, process: &str, worktree: Option<&str>) -> Result<Process, String> {
        let def = self.resolve(workspace_id, process)?;
        let worktree = self.place(&def, worktree, false)?;
        self.halt(&(def.id.clone(), worktree));
        self.get(workspace_id, &def.id)
    }

    fn halt(&self, key: &Key) {
        let mut runs = self.runs();
        let Some(run) = runs.get_mut(key) else {
            return;
        };
        if run.state == ProcessState::Starting {
            // Waiting out a backoff: the timer finds a new generation and gives up.
            run.generation += 1;
            run.state = ProcessState::Stopped;
            drop(runs);
            self.emit(&key.0);
            return;
        }
        if !live(run.state) {
            return;
        }
        let paused = run.state == ProcessState::Paused;
        run.stopping = true;
        let generation = run.generation;
        drop(runs);

        let pty = pty_id(&key.0, key.1.as_deref());
        let _ = self.inner.pty.signal_group(&pty, libc::SIGTERM);
        if paused {
            // A stopped group holds the TERM until it runs again.
            let _ = self.inner.pty.signal_group(&pty, libc::SIGCONT);
        }
        if !self.wait_ended(key, generation, self.inner.config.stop_grace) {
            let _ = self.inner.pty.signal_group(&pty, libc::SIGKILL);
            self.wait_ended(key, generation, KILL_SETTLE);
        }
    }

    fn wait_ended(&self, key: &Key, generation: u64, limit: Duration) -> bool {
        let deadline = Instant::now() + limit;
        let mut runs = self.runs();
        loop {
            let ended = runs
                .get(key)
                .is_none_or(|run| run.generation != generation || !live(run.state));
            if ended {
                return true;
            }
            let left = deadline.saturating_duration_since(Instant::now());
            if left.is_zero() {
                return false;
            }
            runs = self
                .inner
                .moved
                .wait_timeout(runs, left)
                .unwrap_or_else(|e| e.into_inner())
                .0;
        }
    }

    /// Stops the run and starts it again. Without an `env` of its own the
    /// request keeps the one the last run had.
    pub fn restart(&self, workspace_id: &str, process: &str, mut request: RunRequest) -> Result<Process, String> {
        let def = self.resolve(workspace_id, process)?;
        let worktree = self.place(&def, request.worktree.as_deref(), true)?;
        let key = (def.id.clone(), worktree.clone());
        self.halt(&key);
        if request.env.is_none() {
            request.env = self.runs().get(&key).map(|run| run.env.clone());
        }
        request.worktree = worktree;
        self.start(workspace_id, &def.id, request)
    }

    /// SIGSTOP to the group: it keeps its memory and ports, and runs nothing.
    pub fn pause(&self, workspace_id: &str, process: &str, worktree: Option<&str>) -> Result<Process, String> {
        self.signal_state(workspace_id, process, worktree, ProcessState::Running, libc::SIGSTOP, ProcessState::Paused)
    }

    pub fn resume(&self, workspace_id: &str, process: &str, worktree: Option<&str>) -> Result<Process, String> {
        self.signal_state(workspace_id, process, worktree, ProcessState::Paused, libc::SIGCONT, ProcessState::Running)
    }

    fn signal_state(
        &self,
        workspace_id: &str,
        process: &str,
        worktree: Option<&str>,
        from: ProcessState,
        signal: i32,
        to: ProcessState,
    ) -> Result<Process, String> {
        let def = self.resolve(workspace_id, process)?;
        let key = (def.id.clone(), self.place(&def, worktree, false)?);
        {
            let mut runs = self.runs();
            let Some(run) = runs.get_mut(&key).filter(|run| run.state == from || run.state == to) else {
                return Err(format!("\"{}\" is not {} there", def.spec.name, state_word(from)));
            };
            if run.state == to {
                drop(runs);
                return self.get(workspace_id, &def.id);
            }
            self.inner.pty.signal_group(&pty_id(&key.0, key.1.as_deref()), signal)?;
            run.state = to;
        }
        self.inner.moved.notify_all();
        self.emit(&def.id);
        self.get(workspace_id, &def.id)
    }

    /// Typed into the run's terminal, as if at its keyboard.
    pub fn send_input(&self, workspace_id: &str, process: &str, worktree: Option<&str>, text: &str) -> Result<(), String> {
        let def = self.resolve(workspace_id, process)?;
        let key = (def.id.clone(), self.place(&def, worktree, false)?);
        let running = self.runs().get(&key).is_some_and(|run| live(run.state));
        if !running {
            return Err(format!("\"{}\" is not running {}", def.spec.name, where_(key.1.as_deref())));
        }
        self.inner.pty.write(&pty_id(&key.0, key.1.as_deref()), text.as_bytes())
    }

    /// Before the workspace's rows go: its processes must not outlive it.
    pub fn forget_workspace(&self, workspace_id: &str) {
        for process in self.list(workspace_id).unwrap_or_default() {
            let _ = self.delete(workspace_id, &process.id);
        }
    }

    /// Before a worktree goes: what runs there stops, and its runs and their
    /// logs go. `path` is the worktree's, as git lists it. Every workspace's
    /// processes are looked at: a path is one worktree, whoever lists it.
    pub fn forget_worktree(&self, path: &str) {
        let path = path.trim_end_matches('/');
        let keys: Vec<Key> = self.runs().keys().filter(|(_, tree)| tree.as_deref() == Some(path)).cloned().collect();
        for key in &keys {
            self.halt(key);
            self.runs().remove(key);
            self.inner.logs.lock().unwrap_or_else(|e| e.into_inner()).remove(key);
            self.wake_waiters(&key.0);
            self.emit(&key.0);
        }
        // Logs outlive the daemon; runs do not. Whatever this worktree left
        // on disk goes too, run this time or not.
        let slug = run_slug(Some(path));
        if let Ok(processes) = std::fs::read_dir(&self.inner.logs_dir) {
            for process in processes.flatten() {
                let _ = std::fs::remove_dir_all(process.path().join(&slug));
            }
        }
    }

    /// The daemon is exiting: nothing restarts, and every group gets its
    /// SIGTERM now. All of them share one stop grace to exit, so a server
    /// flushing a database gets its five seconds and ten servers do not take
    /// fifty. The PTY host kills what is left after that.
    pub fn shutdown(&self) {
        self.inner.closing.store(true, Ordering::Release);
        let running: Vec<(Key, u64)> = self
            .runs()
            .iter_mut()
            .filter(|(_, run)| live(run.state))
            .map(|(key, run)| {
                run.stopping = true;
                (key.clone(), run.generation)
            })
            .collect();
        for (key, _) in &running {
            let pty = pty_id(&key.0, key.1.as_deref());
            let _ = self.inner.pty.signal_group(&pty, libc::SIGTERM);
            let _ = self.inner.pty.signal_group(&pty, libc::SIGCONT);
        }
        let deadline = Instant::now() + self.inner.config.stop_grace;
        for (key, generation) in &running {
            self.wait_ended(key, *generation, deadline.saturating_duration_since(Instant::now()));
        }
    }

    // ---- logs -----------------------------------------------------------

    /// Plain text for an agent. With `since`, up to `max_bytes` from that
    /// cursor on; without it, the last `tail` lines. `cursor` continues.
    pub fn read_logs(
        &self,
        workspace_id: &str,
        process: &str,
        worktree: Option<&str>,
        tail: Option<u32>,
        since: Option<u64>,
        max_bytes: Option<u32>,
    ) -> Result<LogChunk, String> {
        let def = self.resolve(workspace_id, process)?;
        let log = self.log(&(def.id.clone(), self.place(&def, worktree, false)?))?;
        let max = u64::from(max_bytes.unwrap_or(READ_DEFAULT).clamp(1, READ_MAX));
        let total = log.total();
        if let Some(since) = since {
            let from = since.min(total);
            let (at, bytes) = log.read(from, from.saturating_add(max));
            // Short of the end, stop at a line break: half a line, or half an
            // escape, would read wrong and be read again.
            let used = if at + (bytes.len() as u64) < total {
                bytes.iter().rposition(|&b| b == b'\n').map_or(bytes.len(), |nl| nl + 1)
            } else {
                bytes.len()
            };
            return Ok(LogChunk {
                text: text::clean(&bytes[..used]),
                start: at,
                cursor: at + used as u64,
                skipped: at - from,
            });
        }
        let (at, bytes) = log.read(total.saturating_sub(max), total);
        let lines = tail.unwrap_or(TAIL_DEFAULT).clamp(1, TAIL_MAX) as usize;
        let mut begin = tail_start(&bytes, lines);
        // Cut by the byte budget, the first line is likely a stub.
        if begin == 0 && at > log.first() {
            begin = bytes.iter().position(|&b| b == b'\n').map_or(0, |nl| nl + 1);
        }
        Ok(LogChunk {
            text: text::clean(&bytes[begin..]),
            start: at + begin as u64,
            cursor: total,
            skipped: 0,
        })
    }

    /// The raw end of the log, escapes kept, for a terminal to repaint a
    /// process that is not running.
    pub fn log_tail_raw(
        &self,
        workspace_id: &str,
        process: &str,
        worktree: Option<&str>,
        max_bytes: Option<u32>,
    ) -> Result<LogChunk, String> {
        let def = self.resolve(workspace_id, process)?;
        let log = self.log(&(def.id.clone(), self.place(&def, worktree, false)?))?;
        let total = log.total();
        let max = u64::from(max_bytes.unwrap_or(READ_MAX).clamp(1, READ_MAX));
        let (at, bytes) = log.read(total.saturating_sub(max), total);
        // Start on a line: an escape cut in half paints garbage.
        let begin = if at > log.first() {
            bytes.iter().position(|&b| b == b'\n').map_or(0, |nl| nl + 1)
        } else {
            0
        };
        Ok(LogChunk {
            text: String::from_utf8_lossy(&bytes[begin..]).into_owned(),
            start: at + begin as u64,
            cursor: total,
            skipped: 0,
        })
    }

    /// The latest `max_matches` lines matching `pattern` (a regex), each with
    /// `context` lines either side, over everything still on disk.
    pub fn grep_logs(
        &self,
        workspace_id: &str,
        process: &str,
        worktree: Option<&str>,
        pattern: &str,
        context: Option<u32>,
        max_matches: Option<u32>,
    ) -> Result<LogGrep, String> {
        let def = self.resolve(workspace_id, process)?;
        let regex = compile(pattern)?;
        let log = self.log(&(def.id.clone(), self.place(&def, worktree, false)?))?;
        let context = context.unwrap_or(0).min(CONTEXT_MAX) as usize;
        let keep = max_matches.unwrap_or(MATCHES_DEFAULT).clamp(1, MATCHES_MAX) as usize;
        let total_bytes = log.total();
        let mut before: VecDeque<String> = VecDeque::with_capacity(context + 1);
        let mut matches: VecDeque<LogMatch> = VecDeque::with_capacity(keep + 1);
        let mut total = 0_u32;
        log.scan_lines(0, total_bytes, |offset, line, _| {
            let line = text::clean(line);
            // Older matches fill up first, so the newest still short of
            // context are all at the back.
            for pending in matches.iter_mut().rev() {
                if pending.after.len() >= context {
                    break;
                }
                pending.after.push(line.clone());
            }
            if !is_note(&line) && regex.is_match(&line) {
                total = total.saturating_add(1);
                matches.push_back(LogMatch {
                    offset,
                    line: line.clone(),
                    before: before.iter().cloned().collect(),
                    after: Vec::new(),
                });
                if matches.len() > keep {
                    matches.pop_front();
                }
            }
            if context > 0 {
                before.push_back(line);
                if before.len() > context {
                    before.pop_front();
                }
            }
            true
        });
        Ok(LogGrep {
            matches: matches.into(),
            total,
            cursor: total_bytes,
        })
    }

    /// Blocks until a line from `since` on matches, the process ends, or
    /// `timeout_s` (at most a minute) passes. `since` defaults to where the
    /// live run began, so a start followed by a wait sees the whole boot.
    ///
    /// A process that is not up answers `Ended` before anything is matched:
    /// what its log holds is an old run's, and a ready line from before a
    /// crash says nothing about now. One waiting out a restart's backoff is
    /// waited for, and read from where its next run starts.
    pub fn wait_for_log(
        &self,
        workspace_id: &str,
        process: &str,
        worktree: Option<&str>,
        pattern: &str,
        since: Option<u64>,
        timeout_s: u32,
    ) -> Result<LogWait, String> {
        let def = self.resolve(workspace_id, process)?;
        let regex = compile(pattern)?;
        let key = (def.id.clone(), self.place(&def, worktree, false)?);
        let log = self.log(&key)?;
        let deadline = Instant::now() + Duration::from_secs(u64::from(timeout_s.clamp(1, WAIT_MAX_S)));
        let mut pos = loop {
            let seen = log.seq();
            let (state, exit_code, run_cursor) = self
                .runs()
                .get(&key)
                .map_or((ProcessState::Stopped, None, 0), |run| (run.state, run.exit_code, run.run_cursor));
            if live(state) {
                break since.unwrap_or(run_cursor);
            }
            if state != ProcessState::Starting {
                return Ok(LogWait::Ended { state, exit_code, cursor: log.total() });
            }
            // Between runs a cursor the caller holds still reads on; without
            // one there is no run to read yet.
            if let Some(since) = since {
                break since;
            }
            if Instant::now() >= deadline {
                return Ok(LogWait::TimedOut { cursor: log.total() });
            }
            log.wait_change(seen, deadline);
        };
        loop {
            let seen = log.seq();
            let total = log.total();
            let mut found: Option<(u64, String, bool)> = None;
            let end = log.scan_lines(pos, total, |offset, line, complete| {
                let line = text::clean(line);
                if !is_note(&line) && regex.is_match(&line) {
                    found = Some((offset, line, complete));
                    return false;
                }
                true
            });
            if let Some((offset, line, complete)) = found {
                let cursor = if complete { end } else { total };
                return Ok(LogWait::Matched { offset, line, cursor });
            }
            // Only whole lines are behind us; an unfinished one is read again.
            pos = end.max(pos);
            let (state, exit_code) = self
                .runs()
                .get(&key)
                .map_or((ProcessState::Stopped, None), |run| (run.state, run.exit_code));
            let waiting = live(state) || state == ProcessState::Starting;
            if !waiting && log.seq() == seen {
                return Ok(LogWait::Ended { state, exit_code, cursor: pos });
            }
            if Instant::now() >= deadline {
                return Ok(LogWait::TimedOut { cursor: pos });
            }
            if waiting {
                log.wait_change(seen, deadline);
            }
        }
    }

    // ---- internals --------------------------------------------------------

    fn log_dir(&self, key: &Key) -> PathBuf {
        self.inner.logs_dir.join(&key.0).join(run_slug(key.1.as_deref()))
    }

    fn log(&self, key: &Key) -> Result<Arc<LogStore>, String> {
        let mut logs = self.inner.logs.lock().unwrap_or_else(|e| e.into_inner());
        if let Some(log) = logs.get(key) {
            return Ok(log.clone());
        }
        let log = Arc::new(LogStore::open(self.log_dir(key), self.inner.config.rotate_at)?);
        logs.insert(key.clone(), log.clone());
        Ok(log)
    }

    /// Without creating anything: a listing must not leave empty folders behind.
    fn log_total(&self, key: &Key) -> u64 {
        if let Some(log) = self.inner.logs.lock().unwrap_or_else(|e| e.into_inner()).get(key) {
            return log.total();
        }
        if self.log_dir(key).is_dir() {
            return self.log(key).map(|log| log.total()).unwrap_or(0);
        }
        0
    }

    /// The process's runs, the main checkout first and then by path.
    fn keys_of(&self, id: &str) -> Vec<Key> {
        let mut keys: Vec<Key> = self.runs().keys().filter(|(process, _)| process == id).cloned().collect();
        keys.sort_by(|a, b| a.1.cmp(&b.1));
        keys
    }

    fn snapshot(&self, def: Def) -> Process {
        let proposed = def.pending().map(|patch| patch.apply(&def.spec));
        let keys = self.keys_of(&def.id);
        let cursors: Vec<u64> = keys.iter().map(|key| self.log_total(key)).collect();
        let runs = self.runs();
        let runs = keys
            .iter()
            .zip(cursors)
            .filter_map(|(key, log_cursor)| {
                let run = runs.get(key)?;
                Some(ProcessRun {
                    worktree: key.1.clone(),
                    state: run.state,
                    pid: run.pid,
                    stream_id: run.stream_id,
                    started_at: run.started_at,
                    exit_code: run.exit_code,
                    restarts: run.restarts,
                    pty_id: pty_id(&key.0, key.1.as_deref()),
                    log_cursor,
                    run_cursor: run.run_cursor,
                    started_by: run.started_by.clone(),
                    env: run.env.clone(),
                })
            })
            .collect();
        Process {
            id: def.id,
            workspace_id: def.workspace_id,
            spec: def.spec,
            created_by: def.created_by,
            approved: def.approved,
            proposed,
            requested_by: def.requested_by,
            runs,
            revision: def.revision,
        }
    }

    fn def_by_id(&self, id: &str) -> Result<Option<Def>, String> {
        self.inner.store.with(|conn| {
            conn.prepare_cached(&format!("{SELECT} WHERE id = ?1"))?
                .query_row(params![id], row_to_def)
                .optional()
        })
    }

    /// By id, then by name, and only inside the workspace: a caller never
    /// reaches another workspace's processes, not even to learn they exist.
    fn resolve(&self, workspace_id: &str, process: &str) -> Result<Def, String> {
        let found = self.inner.store.with(|conn| {
            let by_id = conn
                .prepare_cached(&format!("{SELECT} WHERE workspace_id = ?1 AND id = ?2"))?
                .query_row(params![workspace_id, process], row_to_def)
                .optional()?;
            if by_id.is_some() {
                return Ok(by_id);
            }
            conn.prepare_cached(&format!("{SELECT} WHERE workspace_id = ?1 AND name = ?2"))?
                .query_row(params![workspace_id, process], row_to_def)
                .optional()
        })?;
        found.ok_or_else(|| format!("No process \"{process}\" in this workspace"))
    }

    fn ensure_free_name(&self, workspace_id: &str, name: &str, except: Option<&str>) -> Result<(), String> {
        let taken: Option<String> = self.inner.store.with(|conn| {
            conn.query_row(
                "SELECT id FROM processes WHERE workspace_id = ?1 AND name = ?2",
                params![workspace_id, name],
                |row| row.get(0),
            )
            .optional()
        })?;
        match taken {
            Some(id) if Some(id.as_str()) != except => Err(format!("A process named \"{name}\" already exists")),
            _ => Ok(()),
        }
    }

    /// The run's worktree as a key holds it: `None` for the main checkout,
    /// however it was named. `check` refuses a path that is not one of the
    /// workspace's worktrees; stopping or reading one that was removed
    /// meanwhile does not check.
    fn place(&self, def: &Def, worktree: Option<&str>, check: bool) -> Result<Option<String>, String> {
        let Some(path) = worktree.map(|path| path.trim_end_matches('/')).filter(|path| !path.is_empty()) else {
            return Ok(None);
        };
        let workspace = crate::workspace::get(&self.inner.store, def.workspace_id.clone())?
            .ok_or("Workspace not found")?;
        if path == workspace.path.trim_end_matches('/') {
            return Ok(None);
        }
        if !check {
            return Ok(Some(path.to_string()));
        }
        // Kept as git lists it, which is how sessions and the window have it,
        // whatever spelling of it was asked for.
        let real = |path: &str| std::fs::canonicalize(path).ok();
        crate::worktree::paths(&workspace.path)
            .into_iter()
            .skip(1)
            .find(|tree| tree == path || real(tree).is_some_and(|tree| Some(tree) == real(path)))
            .map(Some)
            .ok_or_else(|| format!("{path} is not a worktree of this workspace"))
    }

    /// The folder a run starts in: the definition's `cwd` inside its worktree.
    fn cwd_of(&self, def: &Def, worktree: Option<&str>) -> Result<String, String> {
        let root = match worktree {
            Some(path) => path.to_string(),
            None => {
                crate::workspace::get(&self.inner.store, def.workspace_id.clone())?
                    .ok_or("Workspace not found")?
                    .path
            }
        };
        let path = resolve_cwd(&root, &def.spec.cwd);
        // The PTY falls back to $HOME for a missing folder, which suits a
        // shell; a server started in the wrong place is worse than an error.
        if !path.is_dir() {
            return Err(format!("{}: not a folder", path.display()));
        }
        Ok(path.to_string_lossy().into_owned())
    }
}

/// `auto_start` stays in the table unread: nothing starts on its own anymore.
const SELECT: &str = "SELECT id, workspace_id, name, command, cwd, env_json, auto_restart,
  created_by, approved, proposed_json, requested_by, revision FROM processes";

fn row_to_def(row: &rusqlite::Row) -> rusqlite::Result<Def> {
    let env: String = row.get(5)?;
    let proposed: Option<String> = row.get(9)?;
    Ok(Def {
        id: row.get(0)?,
        workspace_id: row.get(1)?,
        spec: ProcessSpec {
            name: row.get(2)?,
            command: row.get(3)?,
            cwd: row.get(4)?,
            env: serde_json::from_str(&env).unwrap_or_default(),
            auto_restart: row.get(6)?,
        },
        created_by: row.get(7)?,
        approved: row.get(8)?,
        proposed: proposed.and_then(|json| serde_json::from_str(&json).ok()),
        requested_by: row.get(10)?,
        revision: row.get::<_, i64>(11)?.max(0) as u64,
    })
}

/// The unique index speaks SQL; whoever named the process reads this.
fn name_taken(error: String, name: &str) -> String {
    if error.contains("UNIQUE constraint failed") {
        format!("A process named \"{name}\" already exists")
    } else {
        error
    }
}

fn tidy(mut spec: ProcessSpec) -> Result<ProcessSpec, String> {
    spec.name = spec.name.trim().to_string();
    spec.command = spec.command.trim().to_string();
    spec.cwd = spec.cwd.trim().to_string();
    if spec.name.is_empty() {
        return Err("A process needs a name".into());
    }
    if spec.command.is_empty() {
        return Err("A process needs a command".into());
    }
    if spec.env.keys().any(|key| key.is_empty() || key.contains('=') || key.contains('\0')) {
        return Err("Environment variable names cannot be empty or contain '='".into());
    }
    Ok(spec)
}

/// A new or changed `cwd` is inside the worktree: an absolute one would run
/// in the same place from every worktree.
fn relative_cwd(cwd: &str) -> Result<(), String> {
    if Path::new(cwd.trim()).is_absolute() {
        return Err("The folder has to be relative to the worktree, e.g. \"server\"; leave it empty for its root".into());
    }
    Ok(())
}

fn resolve_cwd(root: &str, cwd: &str) -> PathBuf {
    let cwd = cwd.trim();
    if cwd.is_empty() {
        return PathBuf::from(root);
    }
    let path = Path::new(cwd);
    if path.is_absolute() {
        path.to_path_buf()
    } else {
        Path::new(root).join(path)
    }
}

/// The lines Crew writes into a log between runs. They are there to be read,
/// not matched: the start line repeats the command, which would satisfy any
/// wait for a word in it before the process printed a thing.
fn is_note(line: &str) -> bool {
    line.starts_with("[crew] ")
}

fn compile(pattern: &str) -> Result<regex::Regex, String> {
    regex::RegexBuilder::new(pattern)
        .size_limit(1 << 20)
        .build()
        .map_err(|e| format!("Bad pattern: {e}"))
}

/// Where the last `lines` lines of `bytes` start. A trailing newline ends a
/// line rather than starting an empty one.
fn tail_start(bytes: &[u8], lines: usize) -> usize {
    let body = bytes.strip_suffix(b"\n").unwrap_or(bytes);
    let mut seen = 0;
    for (at, &byte) in body.iter().enumerate().rev() {
        if byte == b'\n' {
            seen += 1;
            if seen == lines {
                return at + 1;
            }
        }
    }
    0
}

/// "in <worktree>", or "in the main checkout", for an error to say where.
fn where_(worktree: Option<&str>) -> String {
    worktree.map_or("in the main checkout".to_string(), |path| format!("in {path}"))
}

fn state_word(state: ProcessState) -> &'static str {
    match state {
        ProcessState::Running => "running",
        ProcessState::Paused => "paused",
        _ => "in that state",
    }
}

/// After a crash: how long until the next try, or `None` to give up. A run
/// that stayed up `stable_after` starts the backoff over; each crash in a row
/// doubles it up to the cap; `crash_limit` crashes inside the window give up.
fn plan_restart(
    crashes: &mut VecDeque<Instant>,
    backoff: &mut Duration,
    now: Instant,
    uptime: Duration,
    config: &ProcessConfig,
) -> Option<Duration> {
    if uptime >= config.stable_after {
        *backoff = Duration::ZERO;
    }
    crashes.push_back(now);
    while crashes
        .front()
        .is_some_and(|at| now.duration_since(*at) > config.crash_window)
    {
        crashes.pop_front();
    }
    if crashes.len() >= config.crash_limit {
        return None;
    }
    let next = if backoff.is_zero() {
        config.backoff_min
    } else {
        (*backoff * 2).min(config.backoff_max)
    };
    *backoff = next;
    Some(next)
}

#[cfg(test)]
mod tests;
