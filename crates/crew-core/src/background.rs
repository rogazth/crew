//! What each session Crew drives left running in the background (plan
//! §7e.10): a shell started with `run_in_background`, a Monitor, a subagent
//! sent off, a Codex terminal that outlived its call. One [`Board`] per
//! session, kept from the CLI's own events; the window lists it as the tray
//! above the composer.
//!
//! A board lives from the start of a turn to the start of the next. While the
//! turn's CLI is up (`live`) a command's output can be read and it can be
//! stopped; once the CLI is gone, whatever still ran went with it, and the
//! rows stay, ended, until the next turn clears them.

use std::collections::HashMap;
use std::sync::{Arc, Mutex};

use crew_protocol::{BackgroundCommand, BackgroundKind, BackgroundList, BackgroundOutput, BackgroundState};
use serde_json::{Map, Value};

use crate::providers::unwrap_shell;

/// How much of a command's output is kept: Claude's `get_task_output` reads
/// the same last 8 KiB.
pub const OUTPUT_TAIL: usize = 8 * 1024;

pub type Listener = Arc<dyn Fn(BackgroundList) + Send + Sync>;

/// Every session's board, and who hears when one changes.
#[derive(Clone, Default)]
pub struct BackgroundHost {
    inner: Arc<Mutex<HashMap<String, Board>>>,
    listener: Arc<Mutex<Option<Listener>>>,
}

impl BackgroundHost {
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
    live: bool,
    waiting: bool,
    /// Claude tasks started in the foreground: one moved to the background
    /// later becomes a row, with what it was started as.
    foreground: HashMap<String, BackgroundCommand>,
    /// Codex command items that started and have not ended, by item id.
    codex_items: HashMap<String, CodexItem>,
    /// Codex's process id for each of its rows: what `terminate` names.
    process_ids: HashMap<String, String>,
}

impl Board {
    pub fn list(&self, session_id: &str) -> BackgroundList {
        BackgroundList {
            session_id: session_id.to_string(),
            commands: self.commands.clone(),
            live: self.live,
            waiting: self.waiting,
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

    /// A turn starts with a CLI of its own: what the last one left is gone.
    pub fn begin(&mut self) -> bool {
        let changed = !self.commands.is_empty() || !self.live || self.waiting;
        *self = Board { live: true, ..Board::default() };
        changed
    }

    /// The turn's CLI is gone, and what it still ran with it.
    pub fn end(&mut self, now: i64) -> bool {
        let mut changed = self.live || self.waiting;
        self.live = false;
        self.waiting = false;
        for row in &mut self.commands {
            if row.state == BackgroundState::Running {
                row.state = BackgroundState::Stopped;
                row.ended_at = Some(now);
                changed = true;
            }
        }
        self.foreground.clear();
        self.codex_items.clear();
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
        if rec.get("type").and_then(Value::as_str) != Some("system") {
            return false;
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
                };
                if flag(rec, "is_backgrounded") {
                    self.add(row)
                } else {
                    self.foreground.insert(task_id, row);
                    false
                }
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
                self.settle(&task_id, state, exit_code(summary), now)
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
                    .filter(|row| row.state == BackgroundState::Running && !live.contains(&row.id))
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

    /// Whether a Codex command item is still running: what makes a listing
    /// of the background terminals worth asking for.
    pub fn codex_running(&self) -> bool {
        !self.codex_items.is_empty() || self.commands.iter().any(|row| row.state == BackgroundState::Running)
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
            });
        }
        let gone: Vec<String> = self
            .commands
            .iter()
            .filter(|row| row.state == BackgroundState::Running && !listed.contains(&row.id))
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
        assert!(board.begin());
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
        board.begin();
        board.claude(&started("b1", true), bash("make"), 1);
        assert!(board.claude(&notified("b1", "completed", "Background command \"make\" completed (exit code 0)"), none, 2));
        let row = board.command("b1").unwrap();
        assert_eq!((row.state, row.exit_code), (BackgroundState::Completed, Some(0)));
        assert!(board.running().is_empty());
    }

    #[test]
    fn a_foreground_task_counts_once_it_is_moved_to_the_background() {
        let mut board = Board::default();
        board.begin();
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
        board.begin();
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
        board.begin();
        let monitor = |id: &str| {
            (id == "toolu_m").then(|| ("Monitor".to_string(), json!({ "command": "tail -f log" }).as_object().unwrap().clone()))
        };
        let rec = json!({ "type": "system", "subtype": "task_started", "task_id": "m1", "tool_use_id": "toolu_m",
            "description": "Follow the log", "task_type": "local_bash", "is_backgrounded": true });
        assert!(board.claude(&rec, monitor, 1));
        assert_eq!(board.command("m1").unwrap().kind, BackgroundKind::Monitor);
    }

    #[test]
    fn the_end_of_the_cli_stops_what_still_ran_and_the_next_turn_clears_it() {
        let mut board = Board::default();
        board.begin();
        board.claude(&started("b1", true), bash("sleep 120"), 1);
        board.claude(&json!({ "type": "system", "subtype": "task_started", "task_id": "b2", "tool_use_id": "x",
            "description": "echo hi", "task_type": "local_bash", "is_backgrounded": true }), none, 1);
        board.claude(&notified("b2", "completed", "done (exit code 0)"), none, 2);
        assert!(board.set_waiting(true));
        assert!(board.list("s").waiting);
        assert!(board.end(9));
        let list = board.list("s");
        assert!(!list.live && !list.waiting);
        assert_eq!(board.command("b1").unwrap().state, BackgroundState::Stopped);
        assert_eq!(board.command("b1").unwrap().ended_at, Some(9));
        assert_eq!(board.command("b2").unwrap().state, BackgroundState::Completed, "an ended one keeps how it ended");
        assert!(board.begin());
        assert!(board.list("s").commands.is_empty() && board.is_live());
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
        board.begin();
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
        board.begin();
        board.codex_item(&exec("inProgress", Value::Null, Value::Null), false, 1);
        board.codex_item(json!({ "type": "agentMessage", "id": "m1", "text": "" }).as_object().unwrap(), false, 1);
        assert!(board.codex_listed(&[json!({ "itemId": "exec-1", "processId": "87302", "command": "sleep 120" })], 2));
        assert!(board.codex_listed(&[], 3));
        assert_eq!(board.command("exec-1").unwrap().state, BackgroundState::Completed);
    }

    #[test]
    fn output_keeps_only_its_tail() {
        let mut board = Board::default();
        board.begin();
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
        host.touch("s1", Board::begin);
        host.touch("s1", |board| board.claude(&started("b1", true), bash("sleep 120"), 1));
        host.touch("s1", |board| board.claude(&changed(&["b1"]), none, 2));
        let heard = heard.lock().unwrap();
        assert_eq!(heard.len(), 2);
        assert_eq!(heard[1].commands[0].id, "b1");
        assert!(heard[1].live);
        assert_eq!(host.list("s1").commands.len(), 1);
        assert!(host.list("other").commands.is_empty());
    }
}
