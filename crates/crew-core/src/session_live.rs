//! What each session's CLI is doing, from the hooks Crew passes it. Claude runs
//! them on its own schedule and each one drops its stdin in the bind folder;
//! crewd reads them in order and keeps one [`SessionLive`] per Crew session.

use std::collections::HashMap;

use crew_protocol::{SessionAsk, SessionLive};
use serde_json::{Map, Value};

use crate::providers::claude::parse_questions;

/// Hook records on their way in: crewd names them `<crew id>.<stamp>.hook`.
pub const HOOK_EXT: &str = "hook";

#[derive(Default)]
pub struct LiveBoard {
    sessions: HashMap<String, Entry>,
    next_ask: u64,
}

#[derive(Default)]
struct Entry {
    started: bool,
    working: bool,
    background: bool,
    ask: Option<SessionAsk>,
    provider_session_id: Option<String>,
    transcript_path: Option<String>,
    updated_at: i64,
}

impl LiveBoard {
    /// A hook's record for Crew session `crew_id`; the new state when it changed anything.
    pub fn hook(&mut self, crew_id: &str, record: &str, now: i64) -> Option<SessionLive> {
        let value: Value = serde_json::from_str(record).ok()?;
        let hook = value.as_object()?;
        let event = hook.get("hook_event_name")?.as_str()?;
        let next_ask = &mut self.next_ask;
        let entry = self.sessions.entry(crew_id.to_string()).or_default();
        let before = entry.snapshot(crew_id);
        match event {
            "SessionStart" => {
                entry.started = true;
                entry.working = false;
                entry.background = false;
                entry.ask = None;
                if let Some(id) = hook.get("session_id").and_then(Value::as_str) {
                    entry.provider_session_id = Some(id.to_string());
                }
                if let Some(path) = hook.get("transcript_path").and_then(Value::as_str) {
                    entry.transcript_path = Some(path.to_string());
                }
            }
            "UserPromptSubmit" => {
                entry.working = true;
                entry.ask = None;
            }
            "PermissionRequest" => {
                let tool = hook.get("tool_name").and_then(Value::as_str).unwrap_or("tool").to_string();
                let input = hook.get("tool_input").and_then(Value::as_object).cloned().unwrap_or_default();
                let questions = if crate::blocks::is_question_tool(&tool) { parse_questions(&input) } else { Vec::new() };
                // Claude offers "don't ask again" when it has a rule to suggest.
                let always = questions.is_empty() && has_suggestions(hook);
                *next_ask += 1;
                entry.working = true;
                entry.ask = Some(SessionAsk { id: *next_ask, tool, input, questions, always });
            }
            "PostToolUse" | "PostToolUseFailure" | "PermissionDenied" => {
                entry.ask = None;
            }
            "Stop" | "StopFailure" => {
                entry.working = false;
                entry.background = runs_in_background(hook);
                entry.ask = None;
            }
            // A `/clear` ends one conversation before the next starts; quitting ends the last.
            "SessionEnd" => {
                entry.started = false;
                entry.working = false;
                entry.background = false;
                entry.ask = None;
            }
            _ => return None,
        }
        entry.changed(crew_id, before, now)
    }

    /// The history shows the turn over: Esc stops a turn, or denies a
    /// permission, without a Stop hook, so the spinner would never end.
    pub fn turn_ended(&mut self, crew_id: &str, now: i64) -> Option<SessionLive> {
        let entry = self.sessions.get_mut(crew_id)?;
        let before = entry.snapshot(crew_id);
        entry.working = false;
        entry.ask = None;
        entry.changed(crew_id, before, now)
    }

    /// The chat answered ask `ask_id` with keys; it is gone from the screen before any hook says so.
    pub fn answered(&mut self, crew_id: &str, ask_id: u64, now: i64) -> Option<SessionLive> {
        let entry = self.sessions.get_mut(crew_id)?;
        if entry.ask.as_ref().map(|ask| ask.id) != Some(ask_id) {
            return None;
        }
        let before = entry.snapshot(crew_id);
        entry.ask = None;
        entry.changed(crew_id, before, now)
    }

    /// The CLI's process ended: nothing runs or asks until it starts again.
    pub fn exited(&mut self, crew_id: &str, now: i64) -> Option<SessionLive> {
        let entry = self.sessions.get_mut(crew_id)?;
        let before = entry.snapshot(crew_id);
        entry.started = false;
        entry.working = false;
        entry.background = false;
        entry.ask = None;
        entry.changed(crew_id, before, now)
    }

    pub fn get(&self, crew_id: &str) -> Option<SessionLive> {
        self.sessions.get(crew_id).map(|entry| entry.snapshot(crew_id))
    }

    /// Where the CLI said it writes the conversation it is in now.
    pub fn transcript_path(&self, crew_id: &str) -> Option<String> {
        self.sessions.get(crew_id)?.transcript_path.clone()
    }

    pub fn forget(&mut self, crew_id: &str) {
        self.sessions.remove(crew_id);
    }
}

impl Entry {
    fn snapshot(&self, crew_id: &str) -> SessionLive {
        SessionLive {
            session_id: crew_id.to_string(),
            started: self.started,
            working: self.working,
            background: self.background,
            ask: self.ask.clone(),
            provider_session_id: self.provider_session_id.clone(),
            updated_at: self.updated_at,
        }
    }

    fn changed(&mut self, crew_id: &str, before: SessionLive, now: i64) -> Option<SessionLive> {
        let mut after = self.snapshot(crew_id);
        after.updated_at = before.updated_at;
        if after == before {
            return None;
        }
        self.updated_at = now;
        after.updated_at = now;
        Some(after)
    }
}

/// The background work that reports back to Claude when it ends, and so starts
/// the next turn. A monitor is not among them: an Artifact's watch or a log
/// being followed runs for as long as the session does, and would leave it
/// Working for good.
const WAKES: [&str; 4] = ["shell", "subagent", "workflow", "cloud session"];

/// Claude's Stop names the background tasks the turn leaves behind; one still
/// running reports back when it ends, and that starts the next turn.
fn runs_in_background(hook: &Map<String, Value>) -> bool {
    hook.get("background_tasks").and_then(Value::as_array).is_some_and(|tasks| {
        tasks.iter().any(|task| {
            task.get("status").and_then(Value::as_str) == Some("running")
                && task.get("type").and_then(Value::as_str).is_some_and(|kind| WAKES.contains(&kind))
        })
    })
}

fn has_suggestions(hook: &Map<String, Value>) -> bool {
    hook.get("permission_suggestions")
        .and_then(Value::as_array)
        .is_some_and(|rules| !rules.is_empty())
}

/// The Crew session a hook record's file belongs to: `<crew id>.<stamp>.hook`.
pub fn hook_owner(file_name: &str) -> Option<&str> {
    let stem = file_name.strip_suffix(&format!(".{HOOK_EXT}"))?;
    let (owner, _) = stem.split_once('.')?;
    (!owner.is_empty()).then_some(owner)
}

#[cfg(test)]
mod tests {
    use super::*;

    // Payloads as Claude Code 2.1.283 hands them to a hook.
    const START: &str = r#"{"session_id":"ac29cbcc-0dd3-40a1-ba05-17db5434c495","transcript_path":"/home/u/.claude/projects/-w/ac29cbcc-0dd3-40a1-ba05-17db5434c495.jsonl","cwd":"/w","hook_event_name":"SessionStart","source":"startup","model":"claude-haiku-4-5-20251001"}"#;
    const PROMPT: &str = r#"{"session_id":"ac29cbcc","hook_event_name":"UserPromptSubmit","prompt":"Run the shell command: touch made-by-claude.txt"}"#;
    const PERMISSION: &str = r#"{"session_id":"ac29cbcc","hook_event_name":"PermissionRequest","tool_name":"Bash","tool_input":{"command":"touch made-by-claude.txt","description":"Create a file named made-by-claude.txt"},"permission_suggestions":[{"type":"addDirectories","directories":["/w"],"destination":"session"},{"type":"setMode","mode":"acceptEdits","destination":"session"}]}"#;
    const QUESTION: &str = r#"{"session_id":"ac29cbcc","hook_event_name":"PermissionRequest","tool_name":"AskUserQuestion","tool_input":{"questions":[{"question":"What is your favorite color?","header":"Color","options":[{"label":"Red","description":"A warm, vibrant color"},{"label":"Blue","description":"A cool, calming color"}],"multiSelect":false}]}}"#;
    const POST: &str = r#"{"session_id":"ac29cbcc","hook_event_name":"PostToolUse","tool_name":"Bash","tool_use_id":"toolu_01"}"#;
    const STOP: &str = r#"{"session_id":"ac29cbcc","hook_event_name":"Stop"}"#;
    const NOTIFICATION: &str = r#"{"session_id":"ac29cbcc","hook_event_name":"Notification","message":"Claude needs your permission","notification_type":"permission_prompt"}"#;

    #[test]
    fn a_turn_runs_from_the_prompt_to_its_stop() {
        let mut board = LiveBoard::default();
        let started = board.hook("crew-1", START, 1).unwrap();
        assert!(started.started && !started.working);
        assert_eq!(started.provider_session_id.as_deref(), Some("ac29cbcc-0dd3-40a1-ba05-17db5434c495"));
        assert!(board.transcript_path("crew-1").unwrap().ends_with("ac29cbcc-0dd3-40a1-ba05-17db5434c495.jsonl"));
        assert!(board.hook("crew-1", PROMPT, 2).unwrap().working);
        let stopped = board.hook("crew-1", STOP, 3).unwrap();
        assert!(!stopped.working);
        assert_eq!(stopped.updated_at, 3);
    }

    // Claude Code 2.1.286: a turn that ends on a shell it left running, and the
    // one that shell's notification starts once it is done.
    const STOP_BACKGROUND: &str = r#"{"session_id":"ac29cbcc","hook_event_name":"Stop","last_assistant_message":"started","background_tasks":[{"id":"bf9zorro8","type":"shell","status":"running","description":"Sleep 15 seconds then print finished","command":"sleep 15; echo finished"}],"session_crons":[]}"#;
    const NOTIFIED: &str = r#"{"session_id":"ac29cbcc","hook_event_name":"UserPromptSubmit","prompt":"<task-notification>\n<task-id>bf9zorro8</task-id>\n<status>completed</status>\n</task-notification>"}"#;
    const STOP_CLEAR: &str = r#"{"session_id":"ac29cbcc","hook_event_name":"Stop","last_assistant_message":"DONE","background_tasks":[],"session_crons":[]}"#;

    #[test]
    fn a_turn_that_leaves_work_in_the_background_is_not_over() {
        let mut board = LiveBoard::default();
        board.hook("crew-1", START, 1);
        board.hook("crew-1", PROMPT, 2);
        let left = board.hook("crew-1", STOP_BACKGROUND, 3).unwrap();
        assert!(!left.working && left.background);
        let woken = board.hook("crew-1", NOTIFIED, 4).unwrap();
        assert!(woken.working);
        let done = board.hook("crew-1", STOP_CLEAR, 5).unwrap();
        assert!(!done.working && !done.background);
        // A plain Stop, from a Claude that names no tasks, leaves nothing behind.
        board.hook("crew-1", PROMPT, 6);
        board.hook("crew-1", STOP_BACKGROUND, 7);
        assert!(board.exited("crew-1", 8).is_some_and(|gone| !gone.background));
        board.hook("crew-1", PROMPT, 9);
        assert!(!board.hook("crew-1", STOP, 10).unwrap().background);
    }

    // Claude Code 2.1.287: publishing an Artifact leaves a watch on it running
    // for the rest of the session. It wakes nobody when a turn ends.
    const STOP_WATCHING: &str = r#"{"session_id":"ac29cbcc","hook_event_name":"Stop","last_assistant_message":"Published","background_tasks":[{"id":"m1x2","type":"monitor","status":"running","description":"Watch artifact DGGobvZrmHFW4uSogiU5nx"}],"session_crons":[]}"#;

    #[test]
    fn a_watch_left_running_does_not_keep_the_turn_open() {
        let mut board = LiveBoard::default();
        board.hook("crew-1", START, 1);
        board.hook("crew-1", PROMPT, 2);
        let stopped = board.hook("crew-1", STOP_WATCHING, 3).unwrap();
        assert!(!stopped.working && !stopped.background);
    }

    #[test]
    fn a_permission_is_asked_until_the_tool_runs() {
        let mut board = LiveBoard::default();
        board.hook("crew-1", START, 1);
        board.hook("crew-1", PROMPT, 2);
        let asked = board.hook("crew-1", PERMISSION, 3).unwrap().ask.unwrap();
        assert_eq!(asked.tool, "Bash");
        assert_eq!(asked.input["command"], "touch made-by-claude.txt");
        assert!(asked.always, "Claude suggested rules, so it offers not asking again");
        assert!(asked.questions.is_empty());
        // The notification that follows says nothing new.
        assert!(board.hook("crew-1", NOTIFICATION, 4).is_none());
        let ran = board.hook("crew-1", POST, 5).unwrap();
        assert!(ran.ask.is_none() && ran.working);
    }

    #[test]
    fn a_question_form_carries_its_questions() {
        let mut board = LiveBoard::default();
        let ask = board.hook("crew-1", QUESTION, 1).unwrap().ask.unwrap();
        assert_eq!(ask.questions.len(), 1);
        assert_eq!(ask.questions[0].options[1].label, "Blue");
        assert!(!ask.always);
    }

    #[test]
    fn every_ask_gets_its_own_id_and_an_answer_clears_only_its_own() {
        let mut board = LiveBoard::default();
        let first = board.hook("crew-1", PERMISSION, 1).unwrap().ask.unwrap().id;
        board.hook("crew-1", POST, 2);
        let second = board.hook("crew-1", PERMISSION, 3).unwrap().ask.unwrap().id;
        assert_ne!(first, second);
        assert!(board.answered("crew-1", first, 4).is_none(), "a stale answer leaves the new ask");
        assert!(board.answered("crew-1", second, 5).unwrap().ask.is_none());
    }

    #[test]
    fn the_history_ends_a_turn_no_hook_ended() {
        let mut board = LiveBoard::default();
        board.hook("crew-1", PROMPT, 1);
        board.hook("crew-1", PERMISSION, 2);
        let ended = board.turn_ended("crew-1", 3).unwrap();
        assert!(!ended.working && ended.ask.is_none());
        assert!(board.turn_ended("crew-1", 4).is_none(), "nothing changed the second time");
    }

    #[test]
    fn sessions_are_kept_apart() {
        let mut board = LiveBoard::default();
        board.hook("crew-1", PROMPT, 1);
        assert!(board.get("crew-2").is_none());
        assert!(board.get("crew-1").unwrap().working);
    }

    #[test]
    fn a_record_that_is_not_a_hook_changes_nothing() {
        let mut board = LiveBoard::default();
        assert!(board.hook("crew-1", "{\"half", 1).is_none());
        assert!(board.hook("crew-1", r#"{"hook_event_name":"SubagentStop"}"#, 1).is_none());
    }

    #[test]
    fn a_record_names_its_session() {
        assert_eq!(hook_owner("0b7e.1790617947-123.hook"), Some("0b7e"));
        assert_eq!(hook_owner("0b7e.1790617947-123.start"), None);
        assert_eq!(hook_owner(".x.hook"), None);
    }
}
