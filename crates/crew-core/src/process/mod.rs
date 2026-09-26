//! Processes a workspace keeps running, like Solo's: dev servers, watchers,
//! workers. Each runs in a supervised PTY, so it has colours and takes keys
//! like a terminal, but never waits on anyone to read it: everything it prints
//! goes to a log on disk, and a viewer that falls behind is resynced.
//!
//! Every call is scoped to a workspace, and a process is named by its id or
//! by its name there. The MCP tools and the window's RPCs are thin wrappers.

mod log;
pub mod solo;
pub mod text;

use std::collections::{BTreeMap, HashMap, VecDeque};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Condvar, Mutex, MutexGuard, Weak};
use std::thread;
use std::time::{Duration, Instant};

use crew_protocol::{
    LogChunk, LogGrep, LogMatch, LogWait, Process, ProcessSpec, ProcessState, SoloImported,
};
use rusqlite::{params, OptionalExtension};

use crate::pty::{PtyHost, PtySink, SpawnOptions};
use crate::store::{now_millis, set_order, Store};

pub use log::LogStore;

pub const MIGRATION_V19: &str = r#"
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

/// Fields to change on `update`; the ones left `None` stay.
#[derive(Default, Clone, Debug)]
pub struct ProcessPatch {
    pub name: Option<String>,
    pub command: Option<String>,
    pub cwd: Option<String>,
    pub env: Option<BTreeMap<String, String>>,
    pub auto_start: Option<bool>,
    pub auto_restart: Option<bool>,
}

impl ProcessPatch {
    fn apply(&self, spec: &ProcessSpec) -> ProcessSpec {
        ProcessSpec {
            name: self.name.clone().unwrap_or_else(|| spec.name.clone()),
            command: self.command.clone().unwrap_or_else(|| spec.command.clone()),
            cwd: self.cwd.clone().unwrap_or_else(|| spec.cwd.clone()),
            env: self.env.clone().unwrap_or_else(|| spec.env.clone()),
            auto_start: self.auto_start.unwrap_or(spec.auto_start),
            auto_restart: self.auto_restart.unwrap_or(spec.auto_restart),
        }
    }
}

pub trait ProcessEvents: Send + Sync {
    fn changed(&self, process: &Process);
    fn removed(&self, workspace_id: &str, id: &str);
}

/// The PTY a process runs in. A viewer attaches to it with `pty_attach`.
pub fn pty_id(process_id: &str) -> String {
    format!("process:{process_id}")
}

#[derive(Clone)]
struct Def {
    id: String,
    workspace_id: String,
    spec: ProcessSpec,
    created_by: Option<String>,
    approved: bool,
    proposed: Option<ProcessSpec>,
    requested_by: Option<String>,
}

/// What the daemon knows of a process beyond its row. Gone with the daemon:
/// after a restart every process is stopped until something starts it.
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
    runs: Mutex<HashMap<String, Run>>,
    /// Signalled whenever a run's state moves, for `stop` to wait on.
    moved: Condvar,
    logs: Mutex<HashMap<String, Arc<LogStore>>>,
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
    id: String,
    generation: u64,
    log: Arc<LogStore>,
}

impl PtySink for RunSink {
    fn output(&self, bytes: &[u8]) {
        self.log.append(bytes);
    }

    fn exit(&self, code: Option<i32>) {
        if let Some(inner) = self.host.upgrade() {
            ProcessHost { inner }.on_exit(&self.id, self.generation, code);
        }
    }
}

impl ProcessHost {
    pub fn new(store: Store, pty: PtyHost, data_dir: &Path) -> Self {
        Self::with_config(store, pty, data_dir, ProcessConfig::default())
    }

    pub fn with_config(store: Store, pty: PtyHost, data_dir: &Path, config: ProcessConfig) -> Self {
        Self {
            inner: Arc::new(Inner {
                store,
                pty,
                logs_dir: data_dir.join("logs"),
                config,
                runs: Mutex::new(HashMap::new()),
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

    fn runs(&self) -> MutexGuard<'_, HashMap<String, Run>> {
        self.inner.runs.lock().unwrap_or_else(|e| e.into_inner())
    }

    fn events(&self) -> Option<Arc<dyn ProcessEvents>> {
        self.inner.events.lock().unwrap_or_else(|e| e.into_inner()).clone()
    }

    fn emit(&self, id: &str) {
        let Some(events) = self.events() else {
            return;
        };
        if let Ok(Some(def)) = self.def_by_id(id) {
            events.changed(&self.snapshot(def));
        }
    }

    // ---- definitions ----------------------------------------------------

    pub fn list(&self, workspace_id: &str) -> Result<Vec<Process>, String> {
        let defs = self.inner.store.with(|conn| {
            let mut stmt = conn.prepare_cached(&format!(
                "{SELECT} WHERE workspace_id = ?1 ORDER BY sort_order ASC, created_at ASC"
            ))?;
            let rows = stmt.query_map(params![workspace_id], row_to_def)?;
            rows.collect::<rusqlite::Result<Vec<_>>>()
        })?;
        Ok(defs.into_iter().map(|def| self.snapshot(def)).collect())
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
                "INSERT INTO processes (id, workspace_id, name, command, cwd, env_json, auto_start,
                   auto_restart, created_by, sort_order, approved, requested_by, created_at, updated_at)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?13)",
                params![
                    id,
                    workspace_id,
                    spec.name,
                    spec.command,
                    spec.cwd,
                    env,
                    spec.auto_start,
                    spec.auto_restart,
                    created_by,
                    order,
                    !ask_approval,
                    requested_by,
                    now
                ],
            )
        })?;
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
        let def = self.resolve(workspace_id, process)?;
        if ask_approval && def.approved {
            // On top of what is already proposed: two asks in a row are one change.
            let next = tidy(patch.apply(def.proposed.as_ref().unwrap_or(&def.spec)))?;
            self.ensure_free_name(workspace_id, &next.name, Some(&def.id))?;
            let proposed = serde_json::to_string(&next).map_err(|e| e.to_string())?;
            self.inner.store.with(|conn| {
                conn.execute(
                    "UPDATE processes SET proposed_json = ?2, requested_by = ?3, updated_at = ?4 WHERE id = ?1",
                    params![def.id, proposed, updated_by, now_millis()],
                )
            })?;
        } else {
            let next = tidy(patch.apply(&def.spec))?;
            self.ensure_free_name(workspace_id, &next.name, Some(&def.id))?;
            // An unapproved process stays a request, now from whoever changed
            // it last. An approved one keeps any proposal still waiting.
            let requested_by = if def.approved { def.requested_by } else { updated_by.or(def.requested_by) };
            self.write_spec(&def.id, &next, def.approved, requested_by)?;
        }
        self.emit(&def.id);
        self.get(workspace_id, &def.id)
    }

    fn write_spec(&self, id: &str, spec: &ProcessSpec, approved: bool, requested_by: Option<String>) -> Result<(), String> {
        let env = serde_json::to_string(&spec.env).map_err(|e| e.to_string())?;
        self.inner.store.with(|conn| {
            conn.execute(
                "UPDATE processes SET name = ?2, command = ?3, cwd = ?4, env_json = ?5, auto_start = ?6,
                   auto_restart = ?7, approved = ?8, requested_by = ?9, updated_at = ?10 WHERE id = ?1",
                params![
                    id,
                    spec.name,
                    spec.command,
                    spec.cwd,
                    env,
                    spec.auto_start,
                    spec.auto_restart,
                    approved,
                    requested_by,
                    now_millis()
                ],
            )
        })?;
        Ok(())
    }

    /// Stops it first; its logs go with it.
    pub fn delete(&self, workspace_id: &str, process: &str) -> Result<(), String> {
        let def = self.resolve(workspace_id, process)?;
        self.halt(&def.id);
        self.runs().remove(&def.id);
        self.inner
            .store
            .with(|conn| conn.execute("DELETE FROM processes WHERE id = ?1", params![def.id]))?;
        let log = self.inner.logs.lock().unwrap_or_else(|e| e.into_inner()).remove(&def.id);
        match log.and_then(|log| Arc::try_unwrap(log).ok()) {
            Some(log) => log.remove(),
            None => {
                let _ = std::fs::remove_dir_all(self.inner.logs_dir.join(&def.id));
            }
        }
        if let Some(events) = self.events() {
            events.removed(workspace_id, &def.id);
        }
        Ok(())
    }

    /// The user accepts what an agent wrote. A new process that asks to
    /// start on its own starts now: that is what its author was waiting for.
    pub fn approve(&self, workspace_id: &str, process: &str) -> Result<Process, String> {
        let def = self.resolve(workspace_id, process)?;
        if let Some(proposed) = &def.proposed {
            self.write_spec(&def.id, proposed, true, None)?;
            self.clear_proposal(&def.id)?;
        } else if !def.approved {
            self.write_spec(&def.id, &def.spec, true, None)?;
        } else {
            return self.get(workspace_id, &def.id);
        }
        self.emit(&def.id);
        let now = self.resolve(workspace_id, &def.id)?;
        if !def.approved && now.spec.auto_start {
            return self.start(workspace_id, &def.id);
        }
        self.get(workspace_id, &def.id)
    }

    /// A process nobody accepted is deleted; a proposed change is dropped.
    pub fn reject(&self, workspace_id: &str, process: &str) -> Result<Option<Process>, String> {
        let def = self.resolve(workspace_id, process)?;
        if !def.approved {
            self.delete(workspace_id, &def.id)?;
            return Ok(None);
        }
        self.clear_proposal(&def.id)?;
        self.emit(&def.id);
        self.get(workspace_id, &def.id).map(Some)
    }

    fn clear_proposal(&self, id: &str) -> Result<(), String> {
        self.inner.store.with(|conn| {
            conn.execute(
                "UPDATE processes SET proposed_json = NULL, requested_by = NULL WHERE id = ?1",
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

    /// Creates or updates, by name, what `<workspace>/solo.yml` lists.
    pub fn import_solo_yml(
        &self,
        workspace_id: &str,
        created_by: Option<String>,
        ask_approval: bool,
    ) -> Result<SoloImported, String> {
        let workspace = crate::workspace::get(&self.inner.store, workspace_id.to_string())?
            .ok_or("Workspace not found")?;
        let root = Path::new(&workspace.path);
        let path = ["solo.yml", "solo.yaml"]
            .iter()
            .map(|name| root.join(name))
            .find(|path| path.is_file())
            .ok_or("This workspace has no solo.yml")?;
        let source = std::fs::read_to_string(&path).map_err(|e| format!("{}: {e}", path.display()))?;
        let mut imported = SoloImported { created: Vec::new(), updated: Vec::new() };
        for entry in solo::parse(&source)? {
            let cwd = entry.working_dir.trim_start_matches("./").trim_end_matches('/').to_string();
            let cwd = if cwd == "." { String::new() } else { cwd };
            match self.resolve(workspace_id, &entry.name) {
                Ok(existing) => {
                    let patch = ProcessPatch {
                        name: None,
                        command: Some(entry.command),
                        cwd: Some(cwd),
                        env: Some(entry.env),
                        auto_start: Some(entry.auto_start),
                        auto_restart: Some(entry.auto_restart),
                    };
                    self.update(workspace_id, &existing.id, patch, created_by.clone(), ask_approval)?;
                    imported.updated.push(entry.name);
                }
                Err(_) => {
                    let spec = ProcessSpec {
                        name: entry.name.clone(),
                        command: entry.command,
                        cwd,
                        env: entry.env,
                        auto_start: entry.auto_start,
                        auto_restart: entry.auto_restart,
                    };
                    self.create(workspace_id, spec, created_by.clone(), ask_approval)?;
                    imported.created.push(entry.name);
                }
            }
        }
        Ok(imported)
    }

    // ---- running --------------------------------------------------------

    /// Starts it unless it already runs. Fails on a process still waiting for approval.
    pub fn start(&self, workspace_id: &str, process: &str) -> Result<Process, String> {
        let def = self.resolve(workspace_id, process)?;
        if !def.approved {
            return Err(format!(
                "\"{}\" is waiting for the user to approve it in Crew; it cannot start until then",
                def.spec.name
            ));
        }
        let cwd = self.cwd_of(&def)?;
        {
            let mut runs = self.runs();
            let run = runs.entry(def.id.clone()).or_default();
            if live(run.state) {
                drop(runs);
                return self.get(workspace_id, &def.id);
            }
            // A start by hand is a fresh count: the user saw it crash.
            run.restarts = 0;
            run.crashes.clear();
            run.backoff = Duration::ZERO;
            let spawned = self.spawn_run(run, &def, cwd);
            drop(runs);
            self.inner.moved.notify_all();
            self.emit(&def.id);
            spawned?;
        }
        self.get(workspace_id, &def.id)
    }

    fn spawn_run(&self, run: &mut Run, def: &Def, cwd: String) -> Result<(), String> {
        run.generation += 1;
        run.stopping = false;
        run.exit_code = None;
        let log = self.log(&def.id)?;
        run.run_cursor = log.total();
        log.note(&format!("$ {}", def.spec.command));
        let sink = Arc::new(RunSink {
            host: Arc::downgrade(&self.inner),
            id: def.id.clone(),
            generation: run.generation,
            log: log.clone(),
        });
        let shell = std::env::var("SHELL")
            .ok()
            .filter(|shell| !shell.is_empty())
            .unwrap_or_else(|| "/bin/zsh".into());
        let options = SpawnOptions {
            env: def.spec.env.iter().map(|(k, v)| (k.clone(), v.clone())).collect(),
            supervised: Some(sink),
            ..SpawnOptions::default()
        };
        let id = pty_id(&def.id);
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

    fn on_exit(&self, id: &str, generation: u64, code: Option<i32>) {
        let def = self.def_by_id(id).ok().flatten();
        let mut runs = self.runs();
        let Some(run) = runs.get_mut(id) else {
            return;
        };
        if run.generation != generation {
            return;
        }
        let uptime = run.started.map(|at| at.elapsed()).unwrap_or_default();
        run.pid = None;
        run.stream_id = None;
        run.exit_code = code;
        let log = self.log(id).ok();
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
                    let id = id.to_string();
                    thread::spawn(move || {
                        thread::sleep(delay);
                        host.restart_due(&id, generation);
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
        if let Some(log) = log {
            log.notify();
        }
        self.emit(id);
    }

    /// A backoff ran out. Anything that happened meanwhile (a stop, a start
    /// by hand) moved the generation on, and the timer is stale.
    fn restart_due(&self, id: &str, generation: u64) {
        if self.inner.closing.load(Ordering::Acquire) {
            return;
        }
        let Ok(Some(def)) = self.def_by_id(id) else {
            return;
        };
        let cwd = self.cwd_of(&def);
        let mut runs = self.runs();
        let Some(run) = runs.get_mut(id) else {
            return;
        };
        if run.generation != generation || run.state != ProcessState::Starting {
            return;
        }
        let result = match cwd {
            Ok(cwd) => self.spawn_run(run, &def, cwd),
            Err(error) => {
                run.state = ProcessState::Exited;
                Err(error)
            }
        };
        drop(runs);
        if let Err(error) = result {
            eprintln!("[process] {id}: restart failed: {error}");
        }
        self.inner.moved.notify_all();
        self.emit(id);
    }

    /// SIGTERM to the whole group, SIGKILL once the grace runs out. Returns
    /// once it has exited.
    pub fn stop(&self, workspace_id: &str, process: &str) -> Result<Process, String> {
        let def = self.resolve(workspace_id, process)?;
        self.halt(&def.id);
        self.get(workspace_id, &def.id)
    }

    fn halt(&self, id: &str) {
        let mut runs = self.runs();
        let Some(run) = runs.get_mut(id) else {
            return;
        };
        if run.state == ProcessState::Starting {
            // Waiting out a backoff: the timer finds a new generation and gives up.
            run.generation += 1;
            run.state = ProcessState::Stopped;
            drop(runs);
            self.emit(id);
            return;
        }
        if !live(run.state) {
            return;
        }
        let paused = run.state == ProcessState::Paused;
        run.stopping = true;
        let generation = run.generation;
        drop(runs);

        let pty = pty_id(id);
        let _ = self.inner.pty.signal_group(&pty, libc::SIGTERM);
        if paused {
            // A stopped group holds the TERM until it runs again.
            let _ = self.inner.pty.signal_group(&pty, libc::SIGCONT);
        }
        if !self.wait_ended(id, generation, self.inner.config.stop_grace) {
            let _ = self.inner.pty.signal_group(&pty, libc::SIGKILL);
            self.wait_ended(id, generation, KILL_SETTLE);
        }
    }

    fn wait_ended(&self, id: &str, generation: u64, limit: Duration) -> bool {
        let deadline = Instant::now() + limit;
        let mut runs = self.runs();
        loop {
            let ended = runs
                .get(id)
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

    pub fn restart(&self, workspace_id: &str, process: &str) -> Result<Process, String> {
        let def = self.resolve(workspace_id, process)?;
        self.halt(&def.id);
        self.start(workspace_id, &def.id)
    }

    /// SIGSTOP to the group: it keeps its memory and ports, and runs nothing.
    pub fn pause(&self, workspace_id: &str, process: &str) -> Result<Process, String> {
        self.signal_state(workspace_id, process, ProcessState::Running, libc::SIGSTOP, ProcessState::Paused)
    }

    pub fn resume(&self, workspace_id: &str, process: &str) -> Result<Process, String> {
        self.signal_state(workspace_id, process, ProcessState::Paused, libc::SIGCONT, ProcessState::Running)
    }

    fn signal_state(
        &self,
        workspace_id: &str,
        process: &str,
        from: ProcessState,
        signal: i32,
        to: ProcessState,
    ) -> Result<Process, String> {
        let def = self.resolve(workspace_id, process)?;
        {
            let mut runs = self.runs();
            let run = runs.entry(def.id.clone()).or_default();
            if run.state == to {
                drop(runs);
                return self.get(workspace_id, &def.id);
            }
            if run.state != from {
                return Err(format!("\"{}\" is not {}", def.spec.name, state_word(from)));
            }
            self.inner.pty.signal_group(&pty_id(&def.id), signal)?;
            run.state = to;
        }
        self.inner.moved.notify_all();
        self.emit(&def.id);
        self.get(workspace_id, &def.id)
    }

    /// Typed into the process's terminal, as if at its keyboard.
    pub fn send_input(&self, workspace_id: &str, process: &str, text: &str) -> Result<(), String> {
        let def = self.resolve(workspace_id, process)?;
        let running = self.runs().get(&def.id).is_some_and(|run| live(run.state));
        if !running {
            return Err(format!("\"{}\" is not running", def.spec.name));
        }
        self.inner.pty.write(&pty_id(&def.id), text.as_bytes())
    }

    /// Every approved process marked `auto_start`, in every workspace.
    pub fn start_auto(&self) {
        let due = self.inner.store.with(|conn| {
            let mut stmt = conn.prepare(&format!(
                "{SELECT} WHERE auto_start = 1 AND approved = 1 ORDER BY sort_order ASC"
            ))?;
            let rows = stmt.query_map([], row_to_def)?;
            rows.collect::<rusqlite::Result<Vec<_>>>()
        });
        for def in due.unwrap_or_default() {
            if let Err(error) = self.start(&def.workspace_id, &def.id) {
                eprintln!("[process] {}: auto start failed: {error}", def.spec.name);
            }
        }
    }

    /// Before the workspace's rows go: its processes must not outlive it.
    pub fn forget_workspace(&self, workspace_id: &str) {
        for process in self.list(workspace_id).unwrap_or_default() {
            let _ = self.delete(workspace_id, &process.id);
        }
    }

    /// The daemon is exiting: nothing restarts, and every group gets its
    /// SIGTERM now. All of them share one stop grace to exit, so a server
    /// flushing a database gets its five seconds and ten servers do not take
    /// fifty. The PTY host kills what is left after that.
    pub fn shutdown(&self) {
        self.inner.closing.store(true, Ordering::Release);
        let running: Vec<(String, u64)> = self
            .runs()
            .iter_mut()
            .filter(|(_, run)| live(run.state))
            .map(|(id, run)| {
                run.stopping = true;
                (id.clone(), run.generation)
            })
            .collect();
        for (id, _) in &running {
            let _ = self.inner.pty.signal_group(&pty_id(id), libc::SIGTERM);
            let _ = self.inner.pty.signal_group(&pty_id(id), libc::SIGCONT);
        }
        let deadline = Instant::now() + self.inner.config.stop_grace;
        for (id, generation) in &running {
            self.wait_ended(id, *generation, deadline.saturating_duration_since(Instant::now()));
        }
    }

    // ---- logs -----------------------------------------------------------

    /// Plain text for an agent. With `since`, up to `max_bytes` from that
    /// cursor on; without it, the last `tail` lines. `cursor` continues.
    pub fn read_logs(
        &self,
        workspace_id: &str,
        process: &str,
        tail: Option<u32>,
        since: Option<u64>,
        max_bytes: Option<u32>,
    ) -> Result<LogChunk, String> {
        let def = self.resolve(workspace_id, process)?;
        let log = self.log(&def.id)?;
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
    pub fn log_tail_raw(&self, workspace_id: &str, process: &str, max_bytes: Option<u32>) -> Result<LogChunk, String> {
        let def = self.resolve(workspace_id, process)?;
        let log = self.log(&def.id)?;
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
        pattern: &str,
        context: Option<u32>,
        max_matches: Option<u32>,
    ) -> Result<LogGrep, String> {
        let def = self.resolve(workspace_id, process)?;
        let regex = compile(pattern)?;
        let log = self.log(&def.id)?;
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
    /// current run began, so a start followed by a wait sees the whole boot.
    pub fn wait_for_log(
        &self,
        workspace_id: &str,
        process: &str,
        pattern: &str,
        since: Option<u64>,
        timeout_s: u32,
    ) -> Result<LogWait, String> {
        let def = self.resolve(workspace_id, process)?;
        let regex = compile(pattern)?;
        let log = self.log(&def.id)?;
        let deadline = Instant::now() + Duration::from_secs(u64::from(timeout_s.clamp(1, WAIT_MAX_S)));
        let mut pos = since.unwrap_or_else(|| self.runs().get(&def.id).map_or(0, |run| run.run_cursor));
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
                .get(&def.id)
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

    fn log(&self, id: &str) -> Result<Arc<LogStore>, String> {
        let mut logs = self.inner.logs.lock().unwrap_or_else(|e| e.into_inner());
        if let Some(log) = logs.get(id) {
            return Ok(log.clone());
        }
        let log = Arc::new(LogStore::open(self.inner.logs_dir.join(id), self.inner.config.rotate_at)?);
        logs.insert(id.to_string(), log.clone());
        Ok(log)
    }

    /// Without creating anything: a listing must not leave empty folders behind.
    fn log_total(&self, id: &str) -> u64 {
        if let Some(log) = self.inner.logs.lock().unwrap_or_else(|e| e.into_inner()).get(id) {
            return log.total();
        }
        if self.inner.logs_dir.join(id).is_dir() {
            return self.log(id).map(|log| log.total()).unwrap_or(0);
        }
        0
    }

    fn snapshot(&self, def: Def) -> Process {
        let log_cursor = self.log_total(&def.id);
        let runs = self.runs();
        let run = runs.get(&def.id);
        let state = match run.map(|run| run.state) {
            Some(state) if live(state) || state == ProcessState::Starting => state,
            _ if !def.approved => ProcessState::PendingApproval,
            Some(state) => state,
            None => ProcessState::Stopped,
        };
        Process {
            pty_id: pty_id(&def.id),
            id: def.id,
            workspace_id: def.workspace_id,
            spec: def.spec,
            created_by: def.created_by,
            approved: def.approved,
            proposed: def.proposed,
            requested_by: def.requested_by,
            state,
            pid: run.and_then(|run| run.pid),
            stream_id: run.and_then(|run| run.stream_id),
            started_at: run.and_then(|run| run.started_at),
            exit_code: run.and_then(|run| run.exit_code),
            restarts: run.map_or(0, |run| run.restarts),
            log_cursor,
            run_cursor: run.map_or(0, |run| run.run_cursor),
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

    fn cwd_of(&self, def: &Def) -> Result<String, String> {
        let workspace = crate::workspace::get(&self.inner.store, def.workspace_id.clone())?
            .ok_or("Workspace not found")?;
        let path = resolve_cwd(&workspace.path, &def.spec.cwd);
        // The PTY falls back to $HOME for a missing folder, which suits a
        // shell; a server started in the wrong place is worse than an error.
        if !path.is_dir() {
            return Err(format!("{}: not a folder", path.display()));
        }
        Ok(path.to_string_lossy().into_owned())
    }
}

const SELECT: &str = "SELECT id, workspace_id, name, command, cwd, env_json, auto_start, auto_restart,
  created_by, approved, proposed_json, requested_by FROM processes";

fn row_to_def(row: &rusqlite::Row) -> rusqlite::Result<Def> {
    let env: String = row.get(5)?;
    let proposed: Option<String> = row.get(10)?;
    Ok(Def {
        id: row.get(0)?,
        workspace_id: row.get(1)?,
        spec: ProcessSpec {
            name: row.get(2)?,
            command: row.get(3)?,
            cwd: row.get(4)?,
            env: serde_json::from_str(&env).unwrap_or_default(),
            auto_start: row.get(6)?,
            auto_restart: row.get(7)?,
        },
        created_by: row.get(8)?,
        approved: row.get(9)?,
        proposed: proposed.and_then(|json| serde_json::from_str(&json).ok()),
        requested_by: row.get(11)?,
    })
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
