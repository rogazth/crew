//! What each session Crew drives left running in the background (plan
//! §7e.10): a shell started with `run_in_background`, a Monitor, a subagent
//! sent off, a Codex terminal that outlived its call. One [`Board`] per
//! session, kept from the CLI's own events; the window lists it as the tray
//! above the composer.
//!
//! A board lives as long as its session (plan decision 36): a turn, a new
//! process and a restart of Crew leave its entries where they are. While the
//! session's CLI is up (`live`) a command's output can be read and it can be
//! stopped; once the CLI is gone, whatever still ran went with it, and the
//! rows stay, stopped and saying why, until the user clears them or the
//! session is deleted. They are kept in the `background_entries` table,
//! written as they change and read back when the daemon starts.

use std::collections::HashMap;
use std::sync::{Arc, Mutex};

use crew_protocol::{BackgroundCommand, BackgroundKind, BackgroundList, BackgroundOutput, BackgroundState};
use rusqlite::{params, Connection};
use serde_json::{Map, Value};

use crate::providers::{clip, unwrap_shell};
use crate::store::Store;

/// How much of a command's output is kept: Claude's `get_task_output` reads
/// the same last 8 KiB.
pub const OUTPUT_TAIL: usize = 8 * 1024;

/// Why a stopped entry stopped, when its CLI went away under it: the work ran
/// in that process, so it ended with it.
pub const CLI_EXITED: &str = "its CLI exited";

/// Why a subagent the turn waited on is stopped, when the turn ended before
/// the CLI said how it did.
pub const TURN_ENDED: &str = "its turn ended";

/// Why an entry the last daemon left running is stopped: nobody can say what
/// became of it while Crew was not there to watch.
pub const CREW_RESTARTED: &str = "Crew restarted";

/// How many keys of cleared children and process runs a session keeps. They
/// are only ever added to, one per run, so the oldest go first; a run that old
/// is long off the panel.
pub const HIDDEN_LIMIT: usize = 200;

/// How much of a step's title is kept as an entry's activity: it shares a row
/// with the entry's name and its tokens.
const ACTIVITY_LIMIT: usize = 120;

pub type Listener = Arc<dyn Fn(BackgroundList) + Send + Sync>;

/// Every session's board, and who hears when one changes.
#[derive(Clone, Default)]
pub struct BackgroundHost {
    inner: Arc<Mutex<HashMap<String, Board>>>,
    listener: Arc<Mutex<Option<Listener>>>,
    /// Where the boards are kept between runs; none for a host that only
    /// lives in memory.
    store: Option<Store>,
}

impl BackgroundHost {
    /// A host whose boards are kept in `store`: it starts with what the last
    /// daemon left there, and writes every change through. What that daemon
    /// left running is stopped ([`CREW_RESTARTED`]), since nothing of it is
    /// there to be read or stopped any more.
    pub fn persisted(store: Store) -> Self {
        let host = Self { store: Some(store.clone()), ..Self::default() };
        let saved = match store.with(load) {
            Ok(saved) => saved,
            Err(error) => {
                eprintln!("[crewd] the background entries were not read: {error}");
                return host;
            }
        };
        let mut hidden = match store.with(load_hidden) {
            Ok(hidden) => hidden,
            Err(error) => {
                eprintln!("[crewd] the cleared panel entries were not read: {error}");
                HashMap::new()
            }
        };
        let now = crate::store::now_millis();
        // The seeded design profile keeps its running rows as seeded, as the
        // store keeps its working sessions (`CREW_KEEP_STATUS`).
        let keep = std::env::var_os("CREW_KEEP_STATUS").is_some();
        {
            let mut map = host.inner.lock().unwrap_or_else(|e| e.into_inner());
            for (session_id, rows) in saved {
                let mut board = Board::restored(rows, hidden.remove(&session_id).unwrap_or_default());
                if !keep && board.end(now, CREW_RESTARTED) {
                    host.persist(&session_id, &mut board);
                }
                map.insert(session_id, board);
            }
            // A session that cleared its panel and has no entries left.
            for (session_id, keys) in hidden {
                map.insert(session_id, Board::restored(Vec::new(), keys));
            }
        }
        host
    }

    pub fn set_listener(&self, listener: Listener) {
        *self.listener.lock().unwrap_or_else(|e| e.into_inner()) = Some(listener);
    }

    pub fn list(&self, session_id: &str) -> BackgroundList {
        let map = self.inner.lock().unwrap_or_else(|e| e.into_inner());
        match map.get(session_id) {
            Some(board) => board.list(session_id),
            None => Board::default().list(session_id),
        }
    }

    /// Change a session's board; the window hears of it when `change` says
    /// something moved. The listener runs out of the lock.
    pub(crate) fn update<T>(&self, session_id: &str, change: impl FnOnce(&mut Board) -> (bool, T)) -> T {
        let (changed, value, list) = {
            let mut map = self.inner.lock().unwrap_or_else(|e| e.into_inner());
            let board = map.entry(session_id.to_string()).or_default();
            let (changed, value) = change(board);
            if changed {
                // Written under the lock, so two changes reach the table in
                // the order they were made.
                self.persist(session_id, board);
            }
            (changed, value, changed.then(|| board.list(session_id)))
        };
        if let (true, Some(list)) = (changed, list) {
            let listener = self.listener.lock().unwrap_or_else(|e| e.into_inner()).clone();
            if let Some(listener) = listener {
                listener(list);
            }
        }
        value
    }

    /// Write a board's entries through to the table when they differ from what
    /// is there. A session that is gone has no row to hang them on; that and
    /// any other failure is told and left, since the board in memory is right.
    fn persist(&self, session_id: &str, board: &mut Board) {
        let Some(store) = &self.store else {
            return;
        };
        if board.commands == board.saved && board.hidden == board.saved_hidden {
            return;
        }
        match store.with(|conn| save(conn, session_id, &board.commands, &board.outputs, &board.hidden)) {
            Ok(()) => {
                board.saved = board.commands.clone();
                board.saved_hidden = board.hidden.clone();
            }
            Err(error) => eprintln!("[crewd] session {session_id}: the background entries were not written: {error}"),
        }
    }

    /// Drop a deleted session's board. Its rows went with the session.
    pub fn forget(&self, session_id: &str) {
        self.inner.lock().unwrap_or_else(|e| e.into_inner()).remove(session_id);
    }

    /// The user clears a session's finished entries: the ones named in `ids`,
    /// or all of them when none are named. The keys in `hide` are the ended
    /// children and process runs the panel is to keep off its list: they are
    /// not entries of the board, so the board only remembers them.
    pub fn clear(&self, session_id: &str, ids: Option<&[String]>, hide: &[String]) {
        self.touch(session_id, |board| {
            let cleared = board.clear(ids);
            board.hide(hide) | cleared
        });
    }

    /// Change a board for its side effects alone.
    pub(crate) fn touch(&self, session_id: &str, change: impl FnOnce(&mut Board) -> bool) {
        self.update(session_id, |board| (change(board), ()));
    }

    pub(crate) fn read<T>(&self, session_id: &str, read: impl FnOnce(&Board) -> T) -> Option<T> {
        let map = self.inner.lock().unwrap_or_else(|e| e.into_inner());
        map.get(session_id).map(read)
    }
}

/// A Codex command item still running, before the app server lists it as a
/// background terminal.
#[derive(Debug, Clone)]
struct CodexItem {
    command: String,
    process_id: Option<String>,
    started_at: i64,
    /// Its call returned while it ran: the model went on to something else.
    /// The app server lists every live process as a terminal, the one the
    /// model is waiting on too; only these are in the background.
    yielded: bool,
}

#[derive(Default, Debug)]
pub struct Board {
    commands: Vec<BackgroundCommand>,
    /// The last output read of each command, kept for when its CLI is gone.
    outputs: HashMap<String, BackgroundOutput>,
    /// The commands as last written to the table, so a change that moves
    /// nothing of them writes nothing.
    saved: Vec<BackgroundCommand>,
    /// Keys of the ended children and process runs the user cleared from the
    /// panel, oldest first. Not entries of the board: the panel merges those
    /// from other lists and asks the board which of them to leave out.
    hidden: Vec<String>,
    /// `hidden` as last written to the table.
    saved_hidden: Vec<String>,
    live: bool,
    waiting: bool,
    /// Claude tasks started in the foreground: one moved to the background
    /// later becomes a row, with what it was started as.
    foreground: HashMap<String, BackgroundCommand>,
    /// Codex command items that started and have not ended, by item id.
    codex_items: HashMap<String, CodexItem>,
    /// Codex's process id for each of its rows: what `terminate` names.
    process_ids: HashMap<String, String>,
    /// The context window of each model Claude has reported one for, in a
    /// turn's `modelUsage`: a subagent's model is only named as its frames
    /// come, and its window is what its tokens are shown against.
    windows: HashMap<String, u64>,
}

impl Board {
    pub fn list(&self, session_id: &str) -> BackgroundList {
        BackgroundList {
            session_id: session_id.to_string(),
            commands: self.commands.clone(),
            live: self.live,
            waiting: self.waiting,
            hidden: self.hidden.clone(),
        }
    }

    pub fn command(&self, id: &str) -> Option<&BackgroundCommand> {
        self.commands.iter().find(|row| row.id == id)
    }

    pub fn is_live(&self) -> bool {
        self.live
    }

    /// The ids of what still runs, for a stop of the whole turn.
    pub fn running(&self) -> Vec<String> {
        self.commands
            .iter()
            .filter(|row| row.state == BackgroundState::Running)
            .map(|row| row.id.clone())
            .collect()
    }

    /// The entries of a board read back from the table: not live, as nothing
    /// of the process that ran them is left.
    fn restored(rows: Saved, hidden: Vec<String>) -> Self {
        let mut board = Board { saved_hidden: hidden.clone(), hidden, ..Board::default() };
        for (command, output) in rows {
            if let Some(output) = output {
                board.outputs.insert(command.id.clone(), output);
            }
            board.commands.push(command);
        }
        board.saved = board.commands.clone();
        board
    }

    /// A CLI comes up for the session. The entries stay: the ones the process
    /// before it still ran are stopped ([`CLI_EXITED`]), for a process killed
    /// to be replaced does not pass through [`Board::end`], and what is tied
    /// to a process (tasks started in the foreground, Codex items, process
    /// ids) starts over.
    pub fn launch(&mut self, now: i64) -> bool {
        let mut changed = self.stop_running(now, CLI_EXITED);
        changed |= !self.live || self.waiting;
        self.forget_process();
        self.live = true;
        self.waiting = false;
        changed
    }

    /// The session's CLI is gone, and what it still ran with it: those entries
    /// are stopped, with `reason` to say why. None of the work this board
    /// tracks outlives its CLI; work that did would be left running here.
    pub fn end(&mut self, now: i64, reason: &str) -> bool {
        let mut changed = self.live || self.waiting;
        self.live = false;
        self.waiting = false;
        changed |= self.stop_running(now, reason);
        self.forget_process();
        changed
    }

    fn stop_running(&mut self, now: i64, reason: &str) -> bool {
        let mut changed = false;
        for row in &mut self.commands {
            if row.state == BackgroundState::Running {
                row.state = BackgroundState::Stopped;
                row.ended_at = Some(now);
                row.stop_note = Some(reason.to_string());
                changed = true;
            }
        }
        changed
    }

    fn forget_process(&mut self) {
        self.foreground.clear();
        self.codex_items.clear();
        self.process_ids.clear();
    }

    /// The user clears finished entries from the list: the ones named in
    /// `ids`, or all of them when none are. A running one stays whatever is
    /// asked, since it would vanish from the list while its work goes on.
    pub fn clear(&mut self, ids: Option<&[String]>) -> bool {
        let before = self.commands.len();
        let gone = |row: &BackgroundCommand| {
            row.state != BackgroundState::Running && ids.is_none_or(|ids| ids.contains(&row.id))
        };
        let cleared: Vec<String> = self.commands.iter().filter(|row| gone(row)).map(|row| row.id.clone()).collect();
        self.commands.retain(|row| !gone(row));
        for id in &cleared {
            self.outputs.remove(id);
        }
        self.commands.len() != before
    }

    /// The user clears ended children and process runs from the panel: their
    /// keys are kept, past [`HIDDEN_LIMIT`] the oldest go. A key already kept
    /// moves nothing.
    pub fn hide(&mut self, keys: &[String]) -> bool {
        let mut changed = false;
        for key in keys {
            if !self.hidden.contains(key) {
                self.hidden.push(key.clone());
                changed = true;
            }
        }
        let over = self.hidden.len().saturating_sub(HIDDEN_LIMIT);
        self.hidden.drain(..over);
        changed
    }

    pub fn set_waiting(&mut self, waiting: bool) -> bool {
        let changed = self.waiting != waiting;
        self.waiting = waiting;
        changed
    }

    /// A command ended as `state`. Only a running one changes, unless a later
    /// word refines how it ended (completed, then stopped).
    pub fn settle(&mut self, id: &str, state: BackgroundState, exit_code: Option<i32>, now: i64) -> bool {
        let Some(row) = self.commands.iter_mut().find(|row| row.id == id) else {
            return false;
        };
        let before = row.clone();
        if row.state == BackgroundState::Running {
            row.ended_at = Some(now);
            row.activity = None;
        }
        // Stopped is how it ended, whatever its exit says after.
        if row.state != BackgroundState::Stopped {
            row.state = state;
        }
        if exit_code.is_some() {
            row.exit_code = exit_code;
        }
        *row != before
    }

    pub fn output(&self, id: &str) -> Option<BackgroundOutput> {
        self.outputs.get(id).cloned()
    }

    pub fn keep_output(&mut self, id: &str, output: BackgroundOutput) {
        self.outputs.insert(id.to_string(), output);
    }

    pub fn process_id(&self, id: &str) -> Option<String> {
        self.process_ids.get(id).cloned()
    }

    fn add(&mut self, row: BackgroundCommand) -> bool {
        if let Some(known) = self.commands.iter_mut().find(|known| known.id == row.id) {
            // Heard of first from the full set, which says less.
            let before = known.clone();
            if known.tool_call_id.is_none() {
                known.tool_call_id = row.tool_call_id;
            }
            // Started again once it ended: a subagent a `SendMessage` resumed.
            // It is the same entry, running anew.
            if known.state != BackgroundState::Running && row.state == BackgroundState::Running {
                known.state = BackgroundState::Running;
                known.started_at = row.started_at;
                known.ended_at = None;
                known.exit_code = None;
                known.stop_note = None;
                known.activity = None;
                known.foreground = row.foreground;
            }
            if known.description.is_none() && row.description.is_some() && row.command != known.command {
                known.command = row.command;
                known.description = row.description;
            }
            return *known != before;
        }
        self.commands.push(row);
        true
    }

    /// One line of Claude's stream-json. `tool` finds a tool call by its id:
    /// the call that started a task says what it runs.
    pub fn claude(
        &mut self,
        rec: &Value,
        tool: impl Fn(&str) -> Option<(String, Map<String, Value>)>,
        now: i64,
    ) -> bool {
        match rec.get("type").and_then(Value::as_str) {
            Some("system") => {}
            Some("result") => {
                let mut changed = self.claude_windows(rec);
                // The turn is over, and a subagent it waited on with it: an
                // interrupt may not have said how that one ended.
                for row in &mut self.commands {
                    if row.state == BackgroundState::Running && row.foreground == Some(true) {
                        row.state = BackgroundState::Stopped;
                        row.ended_at = Some(now);
                        row.activity = None;
                        row.stop_note = Some(TURN_ENDED.to_string());
                        changed = true;
                    }
                }
                return changed;
            }
            Some("user") => return self.claude_agent_result(rec),
            _ => return false,
        }
        let task_id = rec.get("task_id").and_then(Value::as_str).map(str::to_string);
        match rec.get("subtype").and_then(Value::as_str) {
            Some("task_started") => {
                let Some(task_id) = task_id else {
                    return false;
                };
                if flag(rec, "ambient") || flag(rec, "skip_transcript") {
                    return false;
                }
                let tool_use_id = rec.get("tool_use_id").and_then(Value::as_str);
                let call = tool_use_id.and_then(&tool);
                let Some(kind) = claude_kind(
                    rec.get("task_type").and_then(Value::as_str),
                    call.as_ref().map(|(name, _)| name.as_str()),
                ) else {
                    return false;
                };
                let description = rec.get("description").and_then(Value::as_str).unwrap_or_default();
                let command = call
                    .as_ref()
                    .and_then(|(_, input)| input.get("command").and_then(Value::as_str))
                    .filter(|command| !command.trim().is_empty())
                    .unwrap_or(description);
                let row = BackgroundCommand {
                    id: task_id.clone(),
                    command: if command.is_empty() { "Background task".into() } else { command.to_string() },
                    description: Some(description.to_string()).filter(|text| !text.is_empty() && text != command),
                    kind,
                    started_at: now,
                    state: BackgroundState::Running,
                    exit_code: None,
                    ended_at: None,
                    tool_call_id: tool_use_id.map(str::to_string),
                    tokens: None,
                    window: None,
                    // `stop_task` takes any task Claude reports, a subagent the
                    // turn waits on too (measured on 2.1.295).
                    stoppable: Some(true),
                    stop_note: None,
                    activity: None,
                    model: None,
                    effort: None,
                    foreground: None,
                    thread_id: None,
                };
                if flag(rec, "is_backgrounded") {
                    self.add(row)
                } else if kind == BackgroundKind::Subagent {
                    // A subagent the turn waits on is listed as it works; the
                    // other things run in the foreground only until they end.
                    self.add(BackgroundCommand { foreground: Some(true), ..row })
                } else {
                    self.foreground.insert(task_id, row);
                    false
                }
            }
            Some("task_progress") => {
                let Some(task_id) = task_id else {
                    return false;
                };
                let tokens = rec.get("usage").and_then(|usage| usage.get("total_tokens")).and_then(Value::as_u64);
                // The CLI's own title for the step it is on ("Reading
                // README.md"), or failing that the tool's name.
                let activity = ["description", "last_tool_name"]
                    .iter()
                    .filter_map(|key| rec.get(*key).and_then(Value::as_str))
                    .find(|text| !text.trim().is_empty())
                    .map(|text| clip(text.trim(), ACTIVITY_LIMIT));
                let Some(row) = self.commands.iter_mut().find(|row| row.id == task_id) else {
                    return false;
                };
                let before = row.clone();
                if row.state == BackgroundState::Running {
                    row.tokens = tokens.or(row.tokens);
                    row.activity = activity.or(row.activity.take());
                }
                *row != before
            }
            Some("task_updated") => {
                let Some(task_id) = task_id else {
                    return false;
                };
                let patch = rec.get("patch").cloned().unwrap_or(Value::Null);
                let mut changed = false;
                if flag(&patch, "is_backgrounded") {
                    if let Some(row) = self.foreground.remove(&task_id) {
                        changed |= self.add(row);
                    } else if let Some(row) = self.commands.iter_mut().find(|row| row.id == task_id) {
                        // Sent to the background, the turn no longer waits on it.
                        changed |= row.foreground.take().is_some();
                    }
                }
                let state = match patch.get("status").and_then(Value::as_str) {
                    Some("completed") => Some(BackgroundState::Completed),
                    Some("failed") => Some(BackgroundState::Failed),
                    Some("killed" | "stopped") => Some(BackgroundState::Stopped),
                    _ => None,
                };
                if let Some(state) = state {
                    self.foreground.remove(&task_id);
                    changed |= self.settle(&task_id, state, None, now);
                }
                changed
            }
            Some("task_notification") => {
                let Some(task_id) = task_id else {
                    return false;
                };
                self.foreground.remove(&task_id);
                let summary = rec.get("summary").and_then(Value::as_str).unwrap_or_default();
                let state = match rec.get("status").and_then(Value::as_str) {
                    Some("completed") => BackgroundState::Completed,
                    Some("failed") => BackgroundState::Failed,
                    Some("stopped") => BackgroundState::Stopped,
                    _ => return false,
                };
                // What it used in all, which the CLI counts exactly once it is over.
                let tokens = rec.get("usage").and_then(|usage| usage.get("total_tokens")).and_then(Value::as_u64);
                let mut changed = tokens.is_some_and(|tokens| self.set_tokens(&task_id, tokens));
                changed |= self.settle(&task_id, state, exit_code(summary), now);
                changed
            }
            Some("background_tasks_changed") => {
                let Some(tasks) = rec.get("tasks").and_then(Value::as_array) else {
                    return false;
                };
                let mut changed = false;
                let mut live = Vec::new();
                for task in tasks {
                    let Some(id) = task.get("task_id").and_then(Value::as_str) else {
                        continue;
                    };
                    live.push(id.to_string());
                    if flag(task, "ambient") || self.command(id).is_some() {
                        continue;
                    }
                    let row = match self.foreground.remove(id) {
                        Some(row) => row,
                        None => {
                            let Some(kind) = claude_kind(task.get("task_type").and_then(Value::as_str), None) else {
                                continue;
                            };
                            let description = task.get("description").and_then(Value::as_str).unwrap_or("Background task");
                            BackgroundCommand {
                                id: id.to_string(),
                                command: description.to_string(),
                                description: None,
                                kind,
                                started_at: now,
                                state: BackgroundState::Running,
                                exit_code: None,
                                ended_at: None,
                                tool_call_id: None,
                                tokens: None,
                                window: None,
                                stoppable: Some(true),
                                stop_note: None,
                                activity: None,
                                model: None,
                                effort: None,
                                foreground: None,
                                thread_id: None,
                            }
                        }
                    };
                    changed |= self.add(row);
                }
                // Replace semantics: one missing from the set runs no more.
                // Its notification, when it comes, says how it ended.
                let gone: Vec<String> = self
                    .commands
                    .iter()
                    // The set lists what runs in the background: a subagent
                    // the turn waits on is not in it, and has not ended.
                    .filter(|row| {
                        row.state == BackgroundState::Running && row.foreground != Some(true) && !live.contains(&row.id)
                    })
                    .map(|row| row.id.clone())
                    .collect();
                for id in gone {
                    changed |= self.settle(&id, BackgroundState::Completed, None, now);
                }
                changed
            }
            _ => false,
        }
    }

    /// What a task used in all.
    fn set_tokens(&mut self, id: &str, tokens: u64) -> bool {
        let Some(row) = self.commands.iter_mut().find(|row| row.id == id) else {
            return false;
        };
        let before = row.tokens.replace(tokens);
        before != Some(tokens)
    }

    /// The model a Claude subagent runs on, from the frames it sends, named
    /// by the call that started it. Its window is filled in when a turn's
    /// result has said what the model's is.
    pub fn claude_subagent_model(&mut self, call: &str, model: &str) -> bool {
        // A frame the CLI wrote itself, not the model's, names a placeholder.
        if model.is_empty() || model.starts_with('<') {
            return false;
        }
        let window = self.windows.get(model).copied();
        let Some(row) = self.commands.iter_mut().find(|row| row.tool_call_id.as_deref() == Some(call)) else {
            return false;
        };
        let before = row.clone();
        row.model = Some(model.to_string());
        row.window = window.or(row.window);
        *row != before
    }

    /// A turn's `result`: the window of every model it used, so that the
    /// subagents running on one can show their tokens against it.
    fn claude_windows(&mut self, rec: &Value) -> bool {
        let Some(usage) = rec.get("modelUsage").and_then(Value::as_object) else {
            return false;
        };
        for (model, used) in usage {
            if let Some(window) = used.get("contextWindow").and_then(Value::as_u64).filter(|window| *window > 0) {
                self.windows.insert(model.clone(), window);
            }
        }
        let mut changed = false;
        for row in &mut self.commands {
            if let (None, Some(window)) = (row.window, row.model.as_ref().and_then(|model| self.windows.get(model))) {
                row.window = Some(*window);
                changed = true;
            }
        }
        changed
    }

    /// The user message that answers an Agent call carries what the subagent
    /// did in all: the tokens it used and the model it ran on, exact, where
    /// the live figures run a little high.
    fn claude_agent_result(&mut self, rec: &Value) -> bool {
        let Some(result) = rec.get("tool_use_result").filter(|result| result.is_object()) else {
            return false;
        };
        let Some(agent) = result.get("agentId").and_then(Value::as_str) else {
            return false;
        };
        let model = result.get("resolvedModel").and_then(Value::as_str).filter(|model| !model.is_empty());
        let window = model.and_then(|model| self.windows.get(model).copied());
        let tokens = result.get("totalTokens").and_then(Value::as_u64);
        let Some(row) = self.commands.iter_mut().find(|row| row.id == agent) else {
            return false;
        };
        let before = row.clone();
        row.tokens = tokens.or(row.tokens);
        if let Some(model) = model {
            row.model = Some(model.to_string());
            row.window = window.or(row.window);
        }
        *row != before
    }

    /// A Codex item started or ended. A command is not a row yet: it becomes
    /// one when the app server lists it as a background terminal and the
    /// model has moved on from it (another item started while it ran).
    pub fn codex_item(&mut self, item: &Map<String, Value>, completed: bool, now: i64) -> bool {
        let kind = item.get("type").and_then(Value::as_str);
        let Some(id) = item.get("id").and_then(Value::as_str) else {
            return false;
        };
        // A message written into the turn is no sign the model went on.
        if !completed && kind != Some("userMessage") {
            for (other, running) in self.codex_items.iter_mut() {
                if other != id {
                    running.yielded = true;
                }
            }
        }
        if kind != Some("commandExecution") {
            return false;
        }
        if !completed {
            let command = item.get("command").and_then(Value::as_str).map(unwrap_shell).unwrap_or_default();
            let process_id = item.get("processId").and_then(Value::as_str).map(str::to_string);
            self.codex_items
                .entry(id.to_string())
                .or_insert(CodexItem { command, process_id, started_at: now, yielded: false });
            return false;
        }
        self.codex_items.remove(id);
        if let Some(output) = item.get("aggregatedOutput").and_then(Value::as_str) {
            if self.command(id).is_some() {
                self.outputs.insert(id.to_string(), tail(output));
            }
        }
        let exit = item.get("exitCode").and_then(Value::as_i64).map(|code| code as i32);
        let state = match item.get("status").and_then(Value::as_str) {
            Some("failed") => BackgroundState::Failed,
            Some("declined") => BackgroundState::Stopped,
            _ if exit.is_some_and(|code| code != 0) => BackgroundState::Failed,
            _ => BackgroundState::Completed,
        };
        self.settle(id, state, exit, now)
    }

    /// An entry as a test wants it, whatever the CLIs would have said.
    #[cfg(test)]
    pub(crate) fn test_entry(&mut self, row: BackgroundCommand) -> bool {
        self.add(row)
    }

    /// Whether a Codex command item is still running: what makes a listing
    /// of the background terminals worth asking for.
    pub fn codex_running(&self) -> bool {
        !self.codex_items.is_empty()
            || self.commands.iter().any(|row| row.state == BackgroundState::Running && row.thread_id.is_none())
    }

    /// An agent thread the model spawned, in the entry of its own. The entry
    /// is the thread's id, so a call that names it again fills in what the
    /// first left out and adds no second row. It runs from the start: its
    /// turn begins moments after the call, and the entry says so before that.
    pub fn agent_child(
        &mut self,
        thread: &str,
        call: &str,
        label: &str,
        nickname: Option<&str>,
        model: Option<&str>,
        effort: Option<&str>,
        now: i64,
    ) -> bool {
        if let Some(known) = self.commands.iter_mut().find(|row| row.thread_id.as_deref() == Some(thread)) {
            let before = known.clone();
            if known.description.is_none() {
                known.description = nickname.map(str::to_string);
            }
            if known.model.is_none() {
                known.model = model.map(str::to_string);
            }
            if known.effort.is_none() {
                known.effort = effort.map(str::to_string);
            }
            return *known != before;
        }
        self.add(BackgroundCommand {
            id: thread.to_string(),
            command: label.to_string(),
            description: nickname.map(str::to_string),
            kind: BackgroundKind::Subagent,
            started_at: now,
            state: BackgroundState::Running,
            exit_code: None,
            ended_at: None,
            tool_call_id: Some(call.to_string()),
            tokens: None,
            window: None,
            // Its turn is interrupted on its thread.
            stoppable: Some(true),
            stop_note: None,
            activity: None,
            model: model.map(str::to_string),
            effort: effort.map(str::to_string),
            foreground: None,
            thread_id: Some(thread.to_string()),
        })
    }

    /// An agent thread began a turn, or ended the one it ran. A thread that
    /// ended goes on after a message to it: the entry runs again, as new.
    pub fn agent_child_state(&mut self, thread: &str, state: BackgroundState, now: i64) -> bool {
        let Some(at) = self.commands.iter().position(|row| row.thread_id.as_deref() == Some(thread)) else {
            return false;
        };
        let before = self.commands[at].clone();
        if state == BackgroundState::Running {
            let row = &mut self.commands[at];
            row.state = state;
            row.ended_at = None;
            row.exit_code = None;
            row.stop_note = None;
        } else {
            self.commands[at].activity = None;
            self.settle(&before.id, state, None, now);
        }
        self.commands[at] != before
    }

    /// An agent thread's token reading: what its newest response held, over
    /// its model's window. A reading that names no window keeps the last one.
    pub fn agent_child_usage(&mut self, thread: &str, tokens: u64, window: Option<u64>) -> bool {
        let Some(row) = self.commands.iter_mut().find(|row| row.thread_id.as_deref() == Some(thread)) else {
            return false;
        };
        let before = row.clone();
        row.tokens = Some(tokens);
        row.window = window.or(row.window);
        *row != before
    }

    /// What an agent thread is on now: the call it last started.
    pub fn agent_child_activity(&mut self, thread: &str, activity: &str) -> bool {
        let Some(row) = self.commands.iter_mut().find(|row| row.thread_id.as_deref() == Some(thread)) else {
            return false;
        };
        if row.state != BackgroundState::Running || row.activity.as_deref() == Some(activity) {
            return false;
        }
        row.activity = Some(activity.to_string());
        true
    }

    /// Output a Codex command wrote, as it streams.
    pub fn codex_output(&mut self, item_id: &str, delta: &str) {
        if !self.codex_items.contains_key(item_id) && self.command(item_id).is_none() {
            return;
        }
        let kept = self.outputs.entry(item_id.to_string()).or_insert(BackgroundOutput {
            output: String::new(),
            truncated: false,
        });
        kept.output.push_str(delta);
        if kept.output.len() > OUTPUT_TAIL {
            let cut = kept.output.len() - OUTPUT_TAIL;
            let cut = (cut..kept.output.len()).find(|at| kept.output.is_char_boundary(*at)).unwrap_or(cut);
            kept.output.drain(..cut);
            kept.truncated = true;
        }
    }

    /// `thread/backgroundTerminals/list`'s `data`: what runs on after its
    /// call returned. One no longer listed has ended.
    pub fn codex_listed(&mut self, terminals: &[Value], now: i64) -> bool {
        let mut changed = false;
        let mut listed = Vec::new();
        for terminal in terminals {
            let Some(id) = terminal.get("itemId").and_then(Value::as_str) else {
                continue;
            };
            listed.push(id.to_string());
            if let Some(process) = terminal.get("processId").and_then(Value::as_str) {
                self.process_ids.insert(id.to_string(), process.to_string());
            }
            if self.command(id).is_some() {
                continue;
            }
            let item = self.codex_items.get(id).cloned();
            // The command the model is still waiting on is not in the background.
            if item.as_ref().is_some_and(|item| !item.yielded) {
                continue;
            }
            let command = item
                .as_ref()
                .map(|item| item.command.clone())
                .filter(|command| !command.is_empty())
                .or_else(|| terminal.get("command").and_then(Value::as_str).map(unwrap_shell))
                .unwrap_or_else(|| "Command".into());
            if let Some(process) = item.as_ref().and_then(|item| item.process_id.clone()) {
                self.process_ids.entry(id.to_string()).or_insert(process);
            }
            changed |= self.add(BackgroundCommand {
                id: id.to_string(),
                command,
                description: None,
                kind: BackgroundKind::Shell,
                started_at: item.map(|item| item.started_at).unwrap_or(now),
                state: BackgroundState::Running,
                exit_code: None,
                ended_at: None,
                tool_call_id: Some(id.to_string()),
                tokens: None,
                window: None,
                // By its process (`thread/backgroundTerminals/terminate`).
                stoppable: Some(true),
                stop_note: None,
                activity: None,
                model: None,
                effort: None,
                foreground: None,
                thread_id: None,
            });
        }
        let gone: Vec<String> = self
            .commands
            .iter()
            // An agent thread is no terminal: its own turns say when it ends.
            .filter(|row| row.state == BackgroundState::Running && row.thread_id.is_none() && !listed.contains(&row.id))
            .map(|row| row.id.clone())
            .collect();
        for id in gone {
            changed |= self.settle(&id, BackgroundState::Completed, None, now);
        }
        changed
    }
}

fn flag(value: &Value, key: &str) -> bool {
    value.get(key).and_then(Value::as_bool) == Some(true)
}

/// What a Claude task is, from its type and the tool that started it. Tasks
/// of other kinds (cron runs, MCP tasks, dreams) are not commands.
fn claude_kind(task_type: Option<&str>, tool: Option<&str>) -> Option<BackgroundKind> {
    if tool == Some("Monitor") {
        return Some(BackgroundKind::Monitor);
    }
    match task_type {
        Some("local_bash") => Some(BackgroundKind::Shell),
        Some("monitor_mcp" | "monitor_ws") => Some(BackgroundKind::Monitor),
        Some("local_agent" | "local_workflow" | "remote_agent") => Some(BackgroundKind::Subagent),
        Some(_) => None,
        None => match tool {
            Some("Bash") => Some(BackgroundKind::Shell),
            Some("Agent" | "Task") => Some(BackgroundKind::Subagent),
            _ => None,
        },
    }
}

/// "… completed (exit code 0)", "… failed with exit code 2".
fn exit_code(summary: &str) -> Option<i32> {
    let at = summary.find("exit code")?;
    let rest = summary[at + "exit code".len()..].trim_start();
    let end = rest
        .char_indices()
        .find(|(i, c)| !(c.is_ascii_digit() || (*i == 0 && *c == '-')))
        .map(|(i, _)| i)
        .unwrap_or(rest.len());
    rest[..end].parse().ok()
}

/// The last [`OUTPUT_TAIL`] bytes of an output, on a character boundary.
pub fn tail(output: &str) -> BackgroundOutput {
    if output.len() <= OUTPUT_TAIL {
        return BackgroundOutput { output: output.to_string(), truncated: false };
    }
    let mut cut = output.len() - OUTPUT_TAIL;
    while !output.is_char_boundary(cut) {
        cut += 1;
    }
    BackgroundOutput { output: output[cut..].to_string(), truncated: true }
}

/// A session's entries, one row each, in the order the board lists them. The
/// entry is its JSON, so a field the protocol grows needs no column; the
/// output is the tail the board last read of it. They go with their session.
pub const MIGRATION_V31: &str = "
CREATE TABLE IF NOT EXISTS background_entries (
  session_id       TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  position         INTEGER NOT NULL,
  id               TEXT NOT NULL,
  entry_json       TEXT NOT NULL,
  output           TEXT,
  output_truncated INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (session_id, id)
);
";

/// The keys of the ended children and process runs a session's panel was
/// cleared of, as one JSON list per session. They go with the session.
pub const MIGRATION_V33: &str = "
CREATE TABLE IF NOT EXISTS background_hidden (
  session_id TEXT PRIMARY KEY REFERENCES sessions(id) ON DELETE CASCADE,
  keys_json  TEXT NOT NULL
);
";

/// Replace a session's saved entries with `commands`, and the output kept for
/// each, and its cleared keys with `hidden`.
pub(crate) fn save(
    conn: &Connection,
    session_id: &str,
    commands: &[BackgroundCommand],
    outputs: &HashMap<String, BackgroundOutput>,
    hidden: &[String],
) -> rusqlite::Result<()> {
    let tx = conn.unchecked_transaction()?;
    if hidden.is_empty() {
        tx.execute("DELETE FROM background_hidden WHERE session_id = ?1", params![session_id])?;
    } else {
        let keys = serde_json::to_string(hidden).map_err(|e| rusqlite::Error::ToSqlConversionFailure(Box::new(e)))?;
        tx.execute(
            "INSERT INTO background_hidden (session_id, keys_json) VALUES (?1, ?2)
             ON CONFLICT(session_id) DO UPDATE SET keys_json = excluded.keys_json",
            params![session_id, keys],
        )?;
    }
    tx.execute("DELETE FROM background_entries WHERE session_id = ?1", params![session_id])?;
    for (position, command) in commands.iter().enumerate() {
        let entry = serde_json::to_string(command).map_err(|e| rusqlite::Error::ToSqlConversionFailure(Box::new(e)))?;
        let output = outputs.get(&command.id);
        tx.execute(
            "INSERT INTO background_entries (session_id, position, id, entry_json, output, output_truncated)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
            params![
                session_id,
                position as i64,
                command.id,
                entry,
                output.map(|output| output.output.as_str()),
                output.is_some_and(|output| output.truncated),
            ],
        )?;
    }
    tx.commit()
}

/// A session's saved entries, each with the output kept for it.
type Saved = Vec<(BackgroundCommand, Option<BackgroundOutput>)>;

/// Every session's saved entries, in the order they were listed. A row whose
/// entry does not read (written by a build that knew a shape this one does
/// not) is left out rather than failing the rest.
pub(crate) fn load(conn: &Connection) -> rusqlite::Result<Vec<(String, Saved)>> {
    let mut statement = conn.prepare(
        "SELECT session_id, entry_json, output, output_truncated FROM background_entries ORDER BY session_id, position",
    )?;
    let rows = statement.query_map([], |row| {
        Ok((
            row.get::<_, String>(0)?,
            row.get::<_, String>(1)?,
            row.get::<_, Option<String>>(2)?,
            row.get::<_, bool>(3)?,
        ))
    })?;
    let mut out: Vec<(String, Saved)> = Vec::new();
    for row in rows {
        let (session_id, entry, output, truncated) = row?;
        let Ok(command) = serde_json::from_str::<BackgroundCommand>(&entry) else {
            continue;
        };
        let output = output.map(|output| BackgroundOutput { output, truncated });
        match out.last_mut() {
            Some((last, rows)) if *last == session_id => rows.push((command, output)),
            _ => out.push((session_id, vec![(command, output)])),
        }
    }
    Ok(out)
}

/// Every session's cleared keys. A row that does not read is left out rather
/// than failing the rest.
pub(crate) fn load_hidden(conn: &Connection) -> rusqlite::Result<HashMap<String, Vec<String>>> {
    let mut statement = conn.prepare("SELECT session_id, keys_json FROM background_hidden")?;
    let rows = statement.query_map([], |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?)))?;
    let mut out = HashMap::new();
    for row in rows {
        let (session_id, keys) = row?;
        if let Ok(keys) = serde_json::from_str::<Vec<String>>(&keys) {
            out.insert(session_id, keys);
        }
    }
    Ok(out)
}

/// What `get_task_output` answers, as the window shows it.
pub fn claude_output(response: &Value) -> BackgroundOutput {
    BackgroundOutput {
        output: response.get("output").and_then(Value::as_str).unwrap_or_default().to_string(),
        truncated: response.get("truncated").and_then(Value::as_bool).unwrap_or(false),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn bash(command: &str) -> impl Fn(&str) -> Option<(String, Map<String, Value>)> + '_ {
        move |id| {
            (id == "toolu_bg").then(|| {
                let input = json!({ "command": command, "run_in_background": true, "description": "Sleep two minutes" });
                ("Bash".to_string(), input.as_object().unwrap().clone())
            })
        }
    }

    fn none(_: &str) -> Option<(String, Map<String, Value>)> {
        None
    }

    // Shapes as Claude Code 2.1.290 writes them in stream-json.
    fn started(id: &str, backgrounded: bool) -> Value {
        json!({ "type": "system", "subtype": "task_started", "task_id": id, "tool_use_id": "toolu_bg",
            "description": "Sleep two minutes", "task_type": "local_bash", "is_backgrounded": backgrounded,
            "uuid": "u1", "session_id": "s1" })
    }

    fn changed(ids: &[&str]) -> Value {
        let tasks: Vec<Value> = ids
            .iter()
            .map(|id| json!({ "task_id": id, "task_type": "local_bash", "description": "Sleep two minutes" }))
            .collect();
        json!({ "type": "system", "subtype": "background_tasks_changed", "tasks": tasks, "uuid": "u2", "session_id": "s1" })
    }

    fn notified(id: &str, status: &str, summary: &str) -> Value {
        json!({ "type": "system", "subtype": "task_notification", "task_id": id, "status": status,
            "output_file": "/tmp/out", "summary": summary, "uuid": "u3", "session_id": "s1" })
    }

    #[test]
    fn a_shell_sent_to_the_background_runs_until_its_notification() {
        let mut board = Board::default();
        assert!(board.launch(0));
        assert!(board.claude(&started("b1", true), bash("sleep 120"), 10));
        assert!(!board.claude(&changed(&["b1"]), none, 11), "the full set says nothing new");
        let row = board.command("b1").unwrap();
        assert_eq!(row.command, "sleep 120");
        assert_eq!(row.description.as_deref(), Some("Sleep two minutes"));
        assert_eq!((row.kind, row.state, row.started_at), (BackgroundKind::Shell, BackgroundState::Running, 10));
        assert_eq!(row.tool_call_id.as_deref(), Some("toolu_bg"));
        assert_eq!(board.running(), ["b1"]);
        // The set empties first; the notification then says how it ended.
        assert!(board.claude(&changed(&[]), none, 20));
        assert_eq!(board.command("b1").unwrap().state, BackgroundState::Completed);
        assert!(board.claude(&notified("b1", "failed", "Background command \"Sleep\" failed with exit code 2"), none, 21));
        let row = board.command("b1").unwrap();
        assert_eq!((row.state, row.exit_code, row.ended_at), (BackgroundState::Failed, Some(2), Some(20)));
    }

    #[test]
    fn a_completed_shell_keeps_its_exit_code() {
        let mut board = Board::default();
        board.claude(&started("b1", true), bash("make"), 1);
        assert!(board.claude(&notified("b1", "completed", "Background command \"make\" completed (exit code 0)"), none, 2));
        let row = board.command("b1").unwrap();
        assert_eq!((row.state, row.exit_code), (BackgroundState::Completed, Some(0)));
        assert!(board.running().is_empty());
    }

    #[test]
    fn a_foreground_task_counts_once_it_is_moved_to_the_background() {
        let mut board = Board::default();
        assert!(!board.claude(&started("b1", false), bash("npm run dev"), 1), "a foreground call is no row");
        assert!(board.command("b1").is_none());
        let moved = json!({ "type": "system", "subtype": "task_updated", "task_id": "b1", "patch": { "is_backgrounded": true } });
        assert!(board.claude(&moved, none, 5));
        let row = board.command("b1").unwrap();
        assert_eq!((row.command.as_str(), row.started_at), ("npm run dev", 1));
        let killed = json!({ "type": "system", "subtype": "task_updated", "task_id": "b1", "patch": { "status": "killed" } });
        assert!(board.claude(&killed, none, 6));
        assert_eq!(board.command("b1").unwrap().state, BackgroundState::Stopped);
    }

    #[test]
    fn the_full_set_alone_is_enough_to_list_a_task() {
        let mut board = Board::default();
        let set = json!({ "type": "system", "subtype": "background_tasks_changed", "tasks": [
            { "task_id": "a1", "task_type": "local_agent", "description": "Review the diff" },
            { "task_id": "w1", "task_type": "monitor_mcp", "description": "Watch artifact", "ambient": true },
            { "task_id": "d1", "task_type": "dream", "description": "Housekeeping" },
        ] });
        assert!(board.claude(&set, none, 3));
        assert_eq!(board.list("s").commands.len(), 1, "ambient and non-command tasks are left out");
        let row = board.command("a1").unwrap();
        assert_eq!((row.kind, row.command.as_str()), (BackgroundKind::Subagent, "Review the diff"));
        // Its task_started, heard after, fills in the call it came from.
        let late = json!({ "type": "system", "subtype": "task_started", "task_id": "a1", "tool_use_id": "toolu_a",
            "description": "Review the diff", "task_type": "local_agent", "is_backgrounded": true });
        assert!(board.claude(&late, none, 4));
        assert_eq!(board.command("a1").unwrap().tool_call_id.as_deref(), Some("toolu_a"));
    }

    #[test]
    fn a_monitor_reads_as_one() {
        let mut board = Board::default();
        let monitor = |id: &str| {
            (id == "toolu_m").then(|| ("Monitor".to_string(), json!({ "command": "tail -f log" }).as_object().unwrap().clone()))
        };
        let rec = json!({ "type": "system", "subtype": "task_started", "task_id": "m1", "tool_use_id": "toolu_m",
            "description": "Follow the log", "task_type": "local_bash", "is_backgrounded": true });
        assert!(board.claude(&rec, monitor, 1));
        assert_eq!(board.command("m1").unwrap().kind, BackgroundKind::Monitor);
    }

    // Shapes as Claude Code 2.1.295 writes a subagent's lines in stream-json
    // (`Agent` calls, `subagent_type: Explore`), as captured from a real turn.
    fn agent_started(task: &str, backgrounded: bool) -> Value {
        json!({ "type": "system", "subtype": "task_started", "task_id": task, "run_id": "0mv1cp8is-74a2443a",
            "tool_use_id": "toolu_agent", "description": "List markdown files", "subagent_type": "Explore",
            "is_backgrounded": backgrounded, "spawn_depth": 1, "task_type": "local_agent",
            "prompt": "Use Glob to list *.md files in the current directory, then say done.", "session_id": "s1" })
    }

    fn agent_progress(task: &str, tokens: u64, description: &str, tool: &str) -> Value {
        json!({ "type": "system", "subtype": "task_progress", "task_id": task, "run_id": "0mv1cp8is-74a2443a",
            "tool_use_id": "toolu_agent", "description": description, "subagent_type": "Explore",
            "usage": { "total_tokens": tokens, "tool_uses": 1, "duration_ms": 1345 }, "last_tool_name": tool,
            "session_id": "s1" })
    }

    fn agent_notified(task: &str, status: &str, tokens: Option<u64>) -> Value {
        let mut rec = json!({ "type": "system", "subtype": "task_notification", "task_id": task,
            "run_id": "0mv1cp8is-74a2443a", "tool_use_id": "toolu_agent", "status": status,
            "output_file": "/tmp/out", "summary": "Glob is not available here, so I used find instead.", "session_id": "s1" });
        if let Some(tokens) = tokens {
            rec["usage"] = json!({ "total_tokens": tokens, "tool_uses": 2, "duration_ms": 4187 });
        }
        rec
    }

    /// The user message that answers a foreground Agent call.
    fn agent_answered(task: &str) -> Value {
        json!({ "type": "user", "parent_tool_use_id": null, "session_id": "s1",
            "message": { "role": "user", "content": [{ "tool_use_id": "toolu_agent", "type": "tool_result",
                "content": [{ "type": "text", "text": "[Subagent hand-back] ... Done." }] }] },
            "tool_use_result": { "status": "completed", "agentId": task, "agentType": "Explore",
                "resolvedModel": "claude-haiku-5-5", "totalDurationMs": 4188, "totalTokens": 9561, "totalToolUseCount": 2 } })
    }

    fn turn_result(model: &str, window: u64) -> Value {
        json!({ "type": "result", "subtype": "success", "is_error": false, "session_id": "s1",
            "modelUsage": { model: { "inputTokens": 6, "outputTokens": 478, "contextWindow": window, "maxOutputTokens": 128000 } } })
    }

    #[test]
    fn a_subagent_the_turn_waits_on_is_listed_as_it_works_with_what_it_used() {
        let mut board = Board::default();
        board.launch(0);
        assert!(board.claude(&agent_started("a1", false), none, 10));
        let row = board.command("a1").unwrap();
        assert_eq!((row.kind, row.state, row.foreground), (BackgroundKind::Subagent, BackgroundState::Running, Some(true)));
        assert_eq!((row.command.as_str(), row.tool_call_id.as_deref()), ("List markdown files", Some("toolu_agent")));
        assert_eq!((row.stoppable, row.tokens, row.activity.as_deref()), (Some(true), None, None));

        assert!(board.claude(&agent_progress("a1", 8988, "Finding *.md", "Glob"), none, 11));
        let row = board.command("a1").unwrap();
        assert_eq!((row.tokens, row.activity.as_deref()), (Some(8988), Some("Finding *.md")));
        assert!(!board.claude(&agent_progress("a1", 8988, "Finding *.md", "Glob"), none, 12), "the same step says nothing new");
        assert!(board.claude(&agent_progress("a1", 9391, "", "Bash"), none, 13));
        let row = board.command("a1").unwrap();
        assert_eq!((row.tokens, row.activity.as_deref()), (Some(9391), Some("Bash")), "without a title, the tool it used");

        // The set of what runs in the background does not list it, and it has not ended.
        assert!(!board.claude(&changed(&[]), none, 14));
        assert_eq!(board.command("a1").unwrap().state, BackgroundState::Running);

        // The live figure runs a little high: the notification's is what it used.
        assert!(board.claude(&agent_notified("a1", "completed", Some(9561)), none, 20));
        let row = board.command("a1").unwrap();
        assert_eq!((row.state, row.tokens, row.activity.as_deref(), row.ended_at), (BackgroundState::Completed, Some(9561), None, Some(20)));
        assert!(board.running().is_empty());
    }

    #[test]
    fn a_stopped_subagent_keeps_the_tokens_it_had_used() {
        let mut board = Board::default();
        board.claude(&agent_started("a1", false), none, 1);
        board.claude(&agent_progress("a1", 9012, "Running Sleep for 40 seconds", "Bash"), none, 2);
        // A stop says no usage: the last live figure stays.
        assert!(board.claude(&agent_notified("a1", "stopped", None), none, 3));
        let row = board.command("a1").unwrap();
        assert_eq!((row.state, row.tokens, row.activity.as_deref()), (BackgroundState::Stopped, Some(9012), None));
        assert!(!board.claude(&agent_progress("a1", 9500, "Late", "Bash"), none, 4), "an ended one counts no more");
        assert_eq!(board.command("a1").unwrap().tokens, Some(9012));
    }

    #[test]
    fn a_subagent_sent_to_the_background_is_not_waited_on_any_more() {
        let mut board = Board::default();
        board.claude(&agent_started("a1", false), none, 1);
        let moved = json!({ "type": "system", "subtype": "task_updated", "task_id": "a1", "patch": { "is_backgrounded": true } });
        assert!(board.claude(&moved, none, 2));
        assert_eq!(board.command("a1").unwrap().foreground, None);
        // Now the set lists it, and it ends with it.
        let set = json!({ "type": "system", "subtype": "background_tasks_changed", "tasks": [
            { "task_id": "a1", "task_type": "local_agent", "description": "List markdown files" }] });
        assert!(!board.claude(&set, none, 3));
        assert!(board.claude(&changed(&[]), none, 4));
        assert_eq!(board.command("a1").unwrap().state, BackgroundState::Completed);
    }

    #[test]
    fn a_background_subagent_listed_by_the_set_alone_can_be_stopped() {
        let mut board = Board::default();
        let set = json!({ "type": "system", "subtype": "background_tasks_changed", "tasks": [
            { "task_id": "a1", "run_id": "0mv1coivi-50ac145e", "task_type": "local_agent", "subagent_type": "Explore",
              "description": "Read README and say done" }] });
        assert!(board.claude(&set, none, 1));
        let row = board.command("a1").unwrap();
        assert_eq!((row.kind, row.stoppable, row.foreground), (BackgroundKind::Subagent, Some(true), None));
    }

    #[test]
    fn the_agent_result_and_the_turn_result_give_a_subagent_its_model_and_window() {
        let mut board = Board::default();
        board.claude(&agent_started("a1", false), none, 1);
        // A frame the subagent sent names its model while it works; its window
        // is not known until a result lists the models of the turn.
        assert!(board.claude_subagent_model("toolu_agent", "claude-haiku-5-5"));
        assert!(!board.claude_subagent_model("toolu_agent", "claude-haiku-5-5"));
        assert!(!board.claude_subagent_model("toolu_agent", "<synthetic>"), "a placeholder is no model");
        assert!(!board.claude_subagent_model("toolu_elsewhere", "claude-haiku-5-5"), "another call's subagent is not this one");
        let row = board.command("a1").unwrap();
        assert_eq!((row.model.as_deref(), row.window), (Some("claude-haiku-5-5"), None));

        assert!(board.claude(&turn_result("claude-haiku-5-5", 1_000_000), none, 2));
        assert_eq!(board.command("a1").unwrap().window, Some(1_000_000));

        // Exact at the end, and the model the CLI resolved.
        assert!(board.claude(&agent_answered("a1"), none, 3));
        let row = board.command("a1").unwrap();
        assert_eq!((row.tokens, row.model.as_deref(), row.window), (Some(9561), Some("claude-haiku-5-5"), Some(1_000_000)));
        assert!(!board.claude(&agent_answered("a1"), none, 4));

        // Another subagent, on a model the result already knew.
        board.claude(&json!({ "type": "system", "subtype": "task_started", "task_id": "a2", "tool_use_id": "toolu_a2",
            "description": "Second", "task_type": "local_agent", "is_backgrounded": true }), none, 5);
        assert!(board.claude_subagent_model("toolu_a2", "claude-haiku-5-5"));
        assert_eq!(board.command("a2").unwrap().window, Some(1_000_000));
    }

    #[test]
    fn an_agent_result_for_a_task_not_listed_changes_nothing() {
        let mut board = Board::default();
        assert!(!board.claude(&agent_answered("a1"), none, 1));
        // A user message that answers any other call has no agent in it.
        let plain = json!({ "type": "user", "message": { "role": "user", "content": [] }, "tool_use_result": "Error: nope" });
        assert!(!board.claude(&plain, none, 2));
        assert!(board.list("s").commands.is_empty());
    }

    #[test]
    fn a_result_ends_the_subagent_the_turn_waited_on_and_leaves_the_ones_in_the_background() {
        let mut board = Board::default();
        board.claude(&agent_started("fg", false), none, 1);
        board.claude(&json!({ "type": "system", "subtype": "task_started", "task_id": "bg", "tool_use_id": "toolu_bg_agent",
            "description": "Sent off", "task_type": "local_agent", "is_backgrounded": true }), none, 2);
        board.claude(&agent_progress("fg", 9012, "Running Sleep", "Bash"), none, 3);
        assert!(board.claude(&turn_result("claude-haiku-5-5", 1_000_000), none, 4));
        let row = board.command("fg").unwrap();
        assert_eq!((row.state, row.ended_at, row.stop_note.as_deref(), row.activity.as_deref()), (BackgroundState::Stopped, Some(4), Some(TURN_ENDED), None));
        assert_eq!(board.command("bg").unwrap().state, BackgroundState::Running);
        assert!(!board.claude(&turn_result("claude-haiku-5-5", 1_000_000), none, 5), "nothing more to end");
    }

    /// A board with a shell still running (`b1`) and one that finished (`b2`),
    /// on a CLI that is up.
    fn board_with_one_running() -> Board {
        let mut board = Board::default();
        board.launch(0);
        board.claude(&started("b1", true), bash("sleep 120"), 1);
        board.claude(&json!({ "type": "system", "subtype": "task_started", "task_id": "b2", "tool_use_id": "x",
            "description": "echo hi", "task_type": "local_bash", "is_backgrounded": true }), none, 1);
        board.claude(&notified("b2", "completed", "done (exit code 0)"), none, 2);
        board
    }

    #[test]
    fn the_end_of_the_cli_stops_what_still_ran_and_says_why() {
        let mut board = board_with_one_running();
        assert!(board.set_waiting(true));
        assert!(board.list("s").waiting);
        assert!(board.end(9, CLI_EXITED));
        let list = board.list("s");
        assert!(!list.live && !list.waiting);
        let stopped = board.command("b1").unwrap();
        assert_eq!((stopped.state, stopped.ended_at), (BackgroundState::Stopped, Some(9)));
        assert_eq!(stopped.stop_note.as_deref(), Some("its CLI exited"));
        let done = board.command("b2").unwrap();
        assert_eq!(done.state, BackgroundState::Completed, "an ended one keeps how it ended");
        assert_eq!(done.stop_note, None, "and has nothing to explain");
        assert!(!board.end(10, CLI_EXITED), "a second end moves nothing");
    }

    /// What the entries keep through is the point of the board: a CLI that
    /// comes up again (the next turn on the same process needs no `launch`
    /// at all) finds them where the last left them.
    #[test]
    fn a_new_cli_keeps_the_entries_and_stops_only_what_the_old_one_still_ran() {
        let mut board = board_with_one_running();
        // The old process was killed to be replaced, without its end heard.
        assert!(board.launch(20));
        assert!(board.is_live());
        assert_eq!(board.list("s").commands.len(), 2);
        let stopped = board.command("b1").unwrap();
        assert_eq!((stopped.state, stopped.stop_note.as_deref()), (BackgroundState::Stopped, Some("its CLI exited")));
        assert_eq!(board.command("b2").unwrap().state, BackgroundState::Completed);
        assert!(board.running().is_empty());
        // A task heard of on the new process is listed beside them.
        board.claude(&started("b3", true), bash("npm run dev"), 21);
        assert_eq!(board.running(), ["b3"]);
        assert_eq!(board.list("s").commands.len(), 3);
    }

    #[test]
    fn clearing_removes_the_finished_entries_and_never_a_running_one() {
        let mut board = board_with_one_running();
        board.claude(&started("b3", true), bash("npm run dev"), 3);
        board.keep_output("b2", BackgroundOutput { output: "hi\n".into(), truncated: false });
        // Naming a running one clears nothing of it.
        assert!(!board.clear(Some(&["b1".to_string()])));
        assert_eq!(board.list("s").commands.len(), 3);
        // Naming one finished clears that one, and its output with it.
        assert!(board.clear(Some(&["b2".to_string(), "missing".to_string()])));
        assert!(board.command("b2").is_none() && board.output("b2").is_none());
        board.end(9, CLI_EXITED);
        // No ids: every finished one, the two the CLI's end stopped included.
        assert!(board.clear(None));
        assert!(board.list("s").commands.is_empty());
        assert!(!board.clear(None), "nothing left to clear");

        let mut board = board_with_one_running();
        assert!(board.clear(None));
        assert_eq!(board.running(), ["b1"], "a bare clear leaves what still runs");
    }

    // Shapes as `codex app-server` 0.160 sends them.
    fn exec(status: &str, output: Value, exit: Value) -> Map<String, Value> {
        json!({ "type": "commandExecution", "id": "exec-1", "command": "/bin/zsh -lc 'sleep 120'", "cwd": "/w",
            "processId": "87302", "source": "unifiedExecStartup", "status": status, "commandActions": [],
            "aggregatedOutput": output, "exitCode": exit, "durationMs": null })
        .as_object()
        .unwrap()
        .clone()
    }

    #[test]
    fn a_codex_command_is_a_row_once_it_is_a_background_terminal() {
        let mut board = Board::default();
        assert!(!board.codex_item(&exec("inProgress", Value::Null, Value::Null), false, 5));
        assert!(board.codex_running());
        board.codex_output("exec-1", "tick\n");
        let listed = [json!({ "itemId": "exec-1", "processId": "87302", "command": "/bin/zsh -lc 'sleep 120'", "cwd": "/w",
            "osPid": 4242, "cpuPercent": null, "rssKb": null })];
        // Listed while the model still waits on it: a command in its call, no row.
        assert!(!board.codex_listed(&listed, 6));
        assert!(board.list("s").commands.is_empty());
        // The model moves on while it runs: now it is in the background.
        let next = json!({ "type": "reasoning", "id": "rs_1", "summary": [], "content": [] });
        assert!(!board.codex_item(next.as_object().unwrap(), false, 7));
        assert!(board.codex_listed(&listed, 8));
        assert!(!board.codex_listed(&listed, 9), "listed again, nothing moved");
        let row = board.command("exec-1").unwrap();
        assert_eq!((row.command.as_str(), row.started_at, row.state), ("sleep 120", 5, BackgroundState::Running));
        assert_eq!(row.tool_call_id.as_deref(), Some("exec-1"));
        assert_eq!(row.stoppable, Some(true), "a terminal is stopped through its process");
        assert_eq!(board.process_id("exec-1").as_deref(), Some("87302"));
        board.codex_output("exec-1", "tock\n");
        assert_eq!(board.output("exec-1").unwrap().output, "tick\ntock\n");
        // It ends: the item says how.
        assert!(board.codex_item(&exec("failed", json!("tick\ntock\nboom\n"), json!(1)), true, 12));
        let row = board.command("exec-1").unwrap();
        assert_eq!((row.state, row.exit_code, row.ended_at), (BackgroundState::Failed, Some(1), Some(12)));
        assert_eq!(board.output("exec-1").unwrap().output, "tick\ntock\nboom\n");
    }

    #[test]
    fn a_codex_terminal_no_longer_listed_has_ended() {
        let mut board = Board::default();
        board.codex_item(&exec("inProgress", Value::Null, Value::Null), false, 1);
        board.codex_item(json!({ "type": "agentMessage", "id": "m1", "text": "" }).as_object().unwrap(), false, 1);
        assert!(board.codex_listed(&[json!({ "itemId": "exec-1", "processId": "87302", "command": "sleep 120" })], 2));
        assert!(board.codex_listed(&[], 3));
        assert_eq!(board.command("exec-1").unwrap().state, BackgroundState::Completed);
    }

    /// An agent the model spawned is a row of its own: running from its call,
    /// ended and run again by its turns, with the tokens of its thread; and
    /// the terminals' listing, which knows no thread, never ends it.
    #[test]
    fn a_codex_agent_thread_is_a_row_its_turns_start_and_end_and_no_terminal_listing_settles() {
        let mut board = Board::default();
        assert!(board.agent_child("t2", "call-1", "Check the tests", Some("Ampere"), Some("gpt-5.6-luna"), Some("low"), 5));
        assert!(!board.agent_child("t2", "call-1", "Check the tests", Some("Ampere"), Some("gpt-5.6-luna"), Some("low"), 6), "named twice");
        let row = board.command("t2").unwrap();
        assert_eq!((row.kind, row.state, row.started_at), (BackgroundKind::Subagent, BackgroundState::Running, 5));
        assert_eq!((row.thread_id.as_deref(), row.tool_call_id.as_deref(), row.stoppable), (Some("t2"), Some("call-1"), Some(true)));
        assert!(!board.codex_running(), "an agent is not a command the app server lists");
        assert!(!board.codex_listed(&[], 7));
        assert_eq!(board.command("t2").unwrap().state, BackgroundState::Running);

        assert!(board.agent_child_usage("t2", 4000, Some(100_000)));
        assert!(board.agent_child_usage("t2", 6000, None));
        let row = board.command("t2").unwrap();
        assert_eq!((row.tokens, row.window), (Some(6000), Some(100_000)), "a reading with no window keeps the last");
        assert!(board.agent_child_activity("t2", "echo one"));

        assert!(board.agent_child_state("t2", BackgroundState::Completed, 9));
        let row = board.command("t2").unwrap();
        assert_eq!((row.state, row.ended_at, row.activity.as_deref()), (BackgroundState::Completed, Some(9), None));
        // A message to the agent starts another turn: it runs again, as new.
        assert!(board.agent_child_state("t2", BackgroundState::Running, 10));
        let row = board.command("t2").unwrap();
        assert_eq!((row.state, row.ended_at), (BackgroundState::Running, None));
        assert!(board.agent_child_state("t2", BackgroundState::Stopped, 12));
        assert!(!board.agent_child_state("t2", BackgroundState::Completed, 13), "a stop is how it ended");
        assert_eq!(board.command("t2").unwrap().state, BackgroundState::Stopped);
        assert!(!board.agent_child_state("t3", BackgroundState::Running, 14), "no such agent");
    }

    #[test]
    fn output_keeps_only_its_tail() {
        let mut board = Board::default();
        board.codex_item(&exec("inProgress", Value::Null, Value::Null), false, 1);
        board.codex_output("exec-1", &"é".repeat(OUTPUT_TAIL));
        let kept = board.output("exec-1").unwrap();
        assert!(kept.truncated && kept.output.len() <= OUTPUT_TAIL && kept.output.chars().all(|c| c == 'é'));
        let cut = tail(&format!("{}end", "x".repeat(OUTPUT_TAIL)));
        assert!(cut.truncated && cut.output.ends_with("end") && cut.output.len() == OUTPUT_TAIL);
    }

    #[test]
    fn exit_codes_read_from_a_summary() {
        assert_eq!(exit_code("Background command \"x\" completed (exit code 0)"), Some(0));
        assert_eq!(exit_code("failed with exit code 127"), Some(127));
        assert_eq!(exit_code("exit code -1"), Some(-1));
        assert_eq!(exit_code("Agent \"x\" finished"), None);
    }

    #[test]
    fn the_host_tells_its_listener_only_what_changed() {
        let host = BackgroundHost::default();
        let heard = Arc::new(Mutex::new(Vec::new()));
        let into = heard.clone();
        host.set_listener(Arc::new(move |list| into.lock().unwrap().push(list)));
        host.touch("s1", |board| board.launch(0));
        host.touch("s1", |board| board.claude(&started("b1", true), bash("sleep 120"), 1));
        host.touch("s1", |board| board.claude(&changed(&["b1"]), none, 2));
        let heard = heard.lock().unwrap();
        assert_eq!(heard.len(), 2);
        assert_eq!(heard[1].commands[0].id, "b1");
        assert!(heard[1].live);
        assert_eq!(host.list("s1").commands.len(), 1);
        assert!(host.list("other").commands.is_empty());
    }

    #[test]
    fn clearing_through_the_host_tells_the_listener_like_any_change() {
        let host = BackgroundHost::default();
        let heard = Arc::new(Mutex::new(Vec::new()));
        let into = heard.clone();
        host.set_listener(Arc::new(move |list| into.lock().unwrap().push(list)));
        host.touch("s1", |board| board.claude(&started("b1", true), bash("make"), 1));
        host.touch("s1", |board| board.claude(&notified("b1", "completed", "done (exit code 0)"), none, 2));
        host.clear("s1", Some(&["nope".to_string()]), &[]);
        host.clear("s1", None, &[]);
        host.clear("s1", None, &[]);
        let heard = heard.lock().unwrap();
        assert_eq!(heard.len(), 3, "the empty clears said nothing");
        assert!(heard[2].commands.is_empty());
    }

    fn temp_store() -> (Store, String) {
        let dir = std::env::temp_dir().join(format!("crew-bg-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).expect("dir");
        let store = Store::open(dir.join("crew.sqlite3")).expect("open");
        let ws = crate::workspace::create(&store, "w".into(), dir.to_string_lossy().into()).expect("workspace");
        let session = crate::session::create(
            &store, ws.id, "terminal".into(), "x".into(), "claude".into(), "m".into(), "".into(), "full".into(),
        )
        .expect("session");
        (store, session.id)
    }

    /// Entries written as they change come back in the order they were
    /// listed, with the output kept for them, and one cleared stays gone.
    #[test]
    fn the_entries_of_a_session_round_trip_through_the_store() {
        let (store, id) = temp_store();
        let host = BackgroundHost::persisted(store.clone());
        host.touch(&id, |board| board.launch(0));
        host.touch(&id, |board| board.claude(&started("b1", true), bash("sleep 120"), 1));
        host.touch(&id, |board| board.claude(&notified("b1", "failed", "failed with exit code 2"), none, 2));
        host.touch(&id, |board| {
            board.keep_output("b1", BackgroundOutput { output: "boom\n".into(), truncated: true });
            board.claude(&started("b2", true), bash("npm run dev"), 3)
        });
        let saved = store.with(load).expect("load");
        assert_eq!(saved.len(), 1);
        let (session_id, rows) = &saved[0];
        assert_eq!(session_id, &id);
        let ids: Vec<&str> = rows.iter().map(|(row, _)| row.id.as_str()).collect();
        assert_eq!(ids, ["b1", "b2"]);
        assert_eq!(rows[0].0, host.list(&id).commands[0]);
        assert_eq!(rows[0].1, Some(BackgroundOutput { output: "boom\n".into(), truncated: true }));
        assert_eq!(rows[1].1, None);

        host.clear(&id, Some(&["b1".to_string()]), &[]);
        let saved = store.with(load).expect("load");
        assert_eq!(saved[0].1.len(), 1, "the finished one was cleared: {saved:?}");
        assert_eq!(saved[0].1[0].0.id, "b2", "the running one stays");
    }

    /// Starting the daemon again: what the last one left running is stopped,
    /// saying Crew restarted; what had ended keeps how it ended; and the
    /// stop is written, so a third start finds nothing to change.
    #[test]
    fn a_restart_stops_the_entries_the_last_daemon_left_running() {
        let (store, id) = temp_store();
        {
            let host = BackgroundHost::persisted(store.clone());
            host.touch(&id, |board| board.launch(0));
            host.touch(&id, |board| board.claude(&started("b1", true), bash("sleep 120"), 1));
            host.touch(&id, |board| board.claude(&started("b2", true), bash("make"), 2));
            host.touch(&id, |board| board.claude(&notified("b2", "completed", "done (exit code 0)"), none, 3));
            assert_eq!(host.list(&id).commands[0].state, BackgroundState::Running);
        }
        let host = BackgroundHost::persisted(store.clone());
        let list = host.list(&id);
        assert!(!list.live && !list.waiting, "no CLI of the old daemon is left");
        let [first, second] = &list.commands[..] else {
            panic!("{list:?}");
        };
        assert_eq!((first.state, first.stop_note.as_deref()), (BackgroundState::Stopped, Some("Crew restarted")));
        assert!(first.ended_at.is_some());
        assert_eq!((second.state, second.exit_code, second.stop_note.clone()), (BackgroundState::Completed, Some(0), None));
        let saved = store.with(load).expect("load");
        assert_eq!(saved[0].1[0].0.state, BackgroundState::Stopped, "the sweep is written");
        let again = BackgroundHost::persisted(store);
        assert_eq!(again.list(&id).commands, list.commands);
    }

    /// A deleted session's rows go with it, and its board with `forget`.
    #[test]
    fn the_entries_of_a_deleted_session_go_with_it() {
        let (store, id) = temp_store();
        let host = BackgroundHost::persisted(store.clone());
        host.touch(&id, |board| board.claude(&started("b1", true), bash("make"), 1));
        assert_eq!(store.with(load).expect("load").len(), 1);
        crate::session::delete(&store, id.clone()).expect("delete");
        assert!(store.with(load).expect("load").is_empty());
        host.forget(&id);
        assert!(host.list(&id).commands.is_empty());
    }

    /// The keys a clear hides are told to every window, kept once however
    /// often they are sent, kept to the newest [`HIDDEN_LIMIT`], and survive a
    /// restart of the daemon even with no entry left on the board.
    #[test]
    fn the_cleared_keys_of_a_session_are_told_kept_bounded_and_survive_a_restart() {
        let (store, id) = temp_store();
        let host = BackgroundHost::persisted(store.clone());
        let heard = Arc::new(Mutex::new(Vec::new()));
        let into = heard.clone();
        host.set_listener(Arc::new(move |list| into.lock().unwrap().push(list)));

        let keys = |names: &[&str]| names.iter().map(|name| name.to_string()).collect::<Vec<_>>();
        host.clear(&id, None, &keys(&["session:c1@5", "process:p1:@3"]));
        host.clear(&id, None, &keys(&["session:c1@5"]));
        assert_eq!(heard.lock().unwrap().len(), 1, "a key already kept said nothing");
        assert_eq!(heard.lock().unwrap()[0].hidden, keys(&["session:c1@5", "process:p1:@3"]));

        let again = BackgroundHost::persisted(store.clone());
        assert_eq!(again.list(&id).hidden, keys(&["session:c1@5", "process:p1:@3"]), "it outlives a daemon");

        let many: Vec<String> = (0..HIDDEN_LIMIT + 5).map(|n| format!("session:c{n}@1")).collect();
        host.clear(&id, None, &many);
        let hidden = host.list(&id).hidden;
        assert_eq!(hidden.len(), HIDDEN_LIMIT);
        assert_eq!(hidden.last(), many.last(), "the newest are kept");
        assert!(!hidden.contains(&"session:c1@5".to_string()), "the oldest went");

        crate::session::delete(&store, id.clone()).expect("delete");
        assert!(store.with(load_hidden).expect("load").is_empty(), "the session took its keys with it");
    }
}
