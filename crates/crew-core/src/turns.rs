use std::collections::{HashMap, HashSet};
use std::future::Future;
use std::sync::mpsc::{self, Sender};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::Duration;

use tokio::sync::oneshot;

use crew_protocol::{
    ApprovalDecision, ApprovalResolution, HarnessEvent, ToolStatus, TurnStart, TurnStarted, TurnUsage,
};
use serde_json::{json, Map, Value};

use crate::agent::AgentHost;
use crate::bridge::Bridge;
use crate::providers::claude::{
    assistant_text_blocks, assistant_tool_uses, build_claude_spawn_args, build_claude_user_message,
    build_control_request, build_control_response, input_json_delta_from_event, is_compact_boundary,
    is_message_start, is_subagent_message, parse_control_cancel_id, parse_control_request, parse_questions,
    persona_prompt as claude_persona, session_id_from_message, stream_text_delta, to_permission_result,
    to_question_result, tool_detail as claude_tool_detail, tool_label as claude_tool_label,
    tool_result_detail as claude_tool_result_detail, tool_results_from_user_message, tool_start_from_event,
    try_parse_json_record, turn_failed as claude_turn_failed, turn_usage as claude_turn_usage, ClaudeControlRequest,
    ClaudeSpawn,
};
use crate::providers::codex::{
    agent_message_text, build_codex_prompt, build_codex_spawn_args, completed_tool_status, item_error_message,
    item_from_event, is_tool_item, parse_json_line, stream_error_message, thread_id_from_event,
    tool_call_id, tool_detail as codex_tool_detail, tool_label as codex_tool_label,
    tool_name as codex_tool_name, turn_usage as codex_turn_usage,
    CodexSpawn,
};
use crate::providers::cursor::{
    assistant_delta_text, build_cursor_spawn_args, parse_tool_call, persona_prompt as cursor_persona,
    session_id_from_event, tool_status as cursor_tool_status, turn_failed as cursor_turn_failed,
    turn_usage as cursor_turn_usage, with_attached_files, with_persona, CursorSpawn, ToolPhase,
};
use crate::providers::opencode::{
    opencode_config,
    add_step_usage, build_opencode_prompt, build_opencode_spawn_args,
    parse_tool_call as parse_opencode_tool_call, session_id_from_event as opencode_session_id,
    stream_error_message as opencode_error_message, text_part, turn_ended, OpencodeSpawn, OpencodeText,
};
use crate::providers::{string_field, Autonomy};
use crate::mailbox;
use crate::session;
use crate::store::Store;
use crate::transcript::TranscriptHub;

const INIT_TIMEOUT: Duration = Duration::from_secs(15);
const INTERRUPT_GRACE: Duration = Duration::from_millis(1500);
/// An agent is disposable: it wakes on a message, works, and lets its CLI go.
/// The window is only wide enough that an agent which writes itself back does
/// not pay a cold start on every lap of its loop.
const IDLE_KILL: Duration = Duration::from_secs(5);
/// A self-addressed letter is how an agent keeps working. This many laps in a
/// row without anyone else speaking is a runaway, not a plan.
const MAX_SELF_TURNS: u32 = 25;
const STDERR_TAIL: usize = 12;
const TOOLS_HINT: &str = "Crew gives you tools through its crew MCP server. list_agents says who else is in this workspace. message_agent writes to one of them, and writing to yourself is how you carry on after this turn ends: leave yourself the next step and it arrives as a new turn. search_messages looks up what was already said. find_tool searches everything else Crew offers and answers with arguments you can call through call_tool; reach for it before deciding something is not possible here.";

type Answers = HashMap<String, String>;

#[derive(Debug, Clone)]
enum TurnOutcome {
    Completed,
    Failed(String),
    Stopped,
}

enum QuestionReply {
    Answers(Answers),
    Dismiss,
    Cancelled,
}

struct PendingApproval {
    request_id: String,
    tx: Sender<ApprovalResolution>,
}

struct PendingQuestion {
    request_id: String,
    tx: Sender<QuestionReply>,
}

struct InFlightTool {
    id: String,
    name: String,
    input: Map<String, Value>,
    partial_json: String,
}

struct ClaudeLive {
    cwd: String,
    autonomy: Autonomy,
    model: String,
    claude_session_id: String,
    approvals: HashMap<u64, PendingApproval>,
    questions: HashMap<u64, PendingQuestion>,
    next_ui: u64,
    next_control: u64,
    tools_by_index: HashMap<i64, InFlightTool>,
    tools_by_id: HashMap<String, InFlightTool>,
    cancelled: bool,
    mute: bool,
    active: bool,
    initialized: bool,
    init_tx: Option<oneshot::Sender<bool>>,
    turn_tx: Option<oneshot::Sender<TurnOutcome>>,
    emitted_assistant: String,
    stderr: Vec<String>,
    idle_gen: u64,
}

struct StreamLive {
    cancelled: bool,
    active: bool,
    turn_tx: Option<oneshot::Sender<TurnOutcome>>,
    emitted_assistant: String,
    seen_tools: HashSet<String>,
    stderr: Vec<String>,
    saw_text: bool,
    settled: bool,
    /// opencode's text parts are snapshots: the id says which one is growing.
    text_part: String,
    /// opencode counts every step apart, so the turn's usage adds up here.
    usage: Option<TurnUsage>,
}

enum Live {
    Claude(Box<ClaudeLive>),
    Codex(StreamLive),
    Cursor(StreamLive),
    Opencode(StreamLive),
}

#[derive(Clone)]
pub struct TurnHost {
    agents: AgentHost,
    store: Store,
    transcripts: TranscriptHub,
    bridge: Bridge,
    inner: Arc<Mutex<HashMap<String, Live>>>,
    binaries: Arc<Mutex<HashMap<String, String>>>,
    runtime: Arc<Mutex<Option<tokio::runtime::Handle>>>,
    cancelled: Arc<Mutex<HashSet<String>>>,
    /// Consecutive turns an agent has started by writing to itself.
    loops: Arc<Mutex<HashMap<String, u32>>>,
}

impl TurnHost {
    pub fn new(agents: AgentHost, store: Store, transcripts: TranscriptHub, bridge: Bridge) -> Self {
        Self {
            agents,
            store,
            transcripts,
            bridge,
            inner: Arc::new(Mutex::new(HashMap::new())),
            binaries: Arc::new(Mutex::new(HashMap::new())),
            runtime: Arc::new(Mutex::new(None)),
            cancelled: Arc::new(Mutex::new(HashSet::new())),
            loops: Arc::new(Mutex::new(HashMap::new())),
        }
    }

    pub fn transcripts(&self) -> &TranscriptHub {
        &self.transcripts
    }

    pub fn set_runtime(&self, handle: tokio::runtime::Handle) {
        *self.runtime.lock().unwrap_or_else(|e| e.into_inner()) = Some(handle);
    }

    pub fn override_binary(&self, name: &str, path: impl Into<String>) {
        self.binaries
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .insert(name.to_string(), path.into());
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, HashMap<String, Live>> {
        self.inner.lock().unwrap_or_else(|e| e.into_inner())
    }

    fn after(&self, dur: Duration, f: impl FnOnce() + Send + 'static) {
        if let Some(handle) = self.runtime.lock().unwrap_or_else(|e| e.into_inner()).clone() {
            handle.spawn(async move {
                tokio::time::sleep(dur).await;
                f();
            });
        } else {
            thread::spawn(move || {
                thread::sleep(dur);
                f();
            });
        }
    }

    fn block_on<T>(&self, fut: impl Future<Output = T> + Send) -> T {
        if let Some(handle) = self.runtime.lock().unwrap_or_else(|e| e.into_inner()).clone() {
            handle.block_on(fut)
        } else {
            tokio::runtime::Builder::new_current_thread()
                .enable_all()
                .build()
                .expect("runtime")
                .block_on(fut)
        }
    }

    fn stop_requested(&self, session_id: &str) -> bool {
        self.cancelled
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .contains(session_id)
    }

    fn mark_stop(&self, session_id: &str) {
        self.cancelled
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .insert(session_id.to_string());
    }

    fn clear_stop(&self, session_id: &str) {
        self.cancelled
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .remove(session_id);
    }

    pub fn start(&self, params: TurnStart) -> Result<TurnStarted, String> {
        let session = session::get(&self.store, params.session_id.clone())?
            .ok_or_else(|| "Session not found".to_string())?;
        if session.kind != "agent" {
            return Err("Not an agent session".into());
        }
        self.clear_stop(&params.session_id);
        {
            let map = self.lock();
            if map.get(&params.session_id).is_some_and(|live| match live {
                Live::Claude(row) => row.active,
                Live::Codex(row) | Live::Cursor(row) | Live::Opencode(row) => row.active,
            }) {
                return Err("Turn already running".into());
            }
        }
        let hidden = params.hidden.unwrap_or(false);
        match params.from_agent.clone() {
            Some(from) => self
                .transcripts
                .append_from_agent(&params.session_id, &params.text, from),
            None => self
                .transcripts
                .append_user(&params.session_id, &params.text, hidden, params.files.clone()),
        }
        self.transcripts.set_working(&params.session_id, true);
        self.transcripts.set_status(&params.session_id, "working", session.provider_session_id.as_deref());
        let host = self.clone();
        thread::spawn(move || {
            host.run_turn(session, params);
        });
        Ok(TurnStarted { working: true })
    }

    pub fn stop(&self, session_id: &str) -> Result<(), String> {
        self.cancel(session_id, true);
        Ok(())
    }

    pub fn respond(&self, session_id: &str, request_id: u64, decision: ApprovalDecision) -> Result<(), String> {
        let mut map = self.lock();
        if let Some(Live::Claude(live)) = map.get_mut(session_id) {
            if let Some(pending) = live.approvals.remove(&request_id) {
                let _ = pending.tx.send(match decision {
                    ApprovalDecision::Allow => ApprovalResolution::Allow,
                    ApprovalDecision::Always => ApprovalResolution::Always,
                    ApprovalDecision::Deny => ApprovalResolution::Deny,
                });
                return Ok(());
            }
        }
        Err("No approval is waiting".into())
    }

    pub fn answer(&self, session_id: &str, request_id: u64, answers: Option<Answers>) -> Result<(), String> {
        let mut map = self.lock();
        if let Some(Live::Claude(live)) = map.get_mut(session_id) {
            if let Some(pending) = live.questions.remove(&request_id) {
                let _ = pending.tx.send(match answers {
                    Some(answers) => QuestionReply::Answers(answers),
                    None => QuestionReply::Dismiss,
                });
                return Ok(());
            }
        }
        Err("No question is waiting".into())
    }

    pub fn on_agent_lines(&self, event: &str, session_id: &str, lines: Vec<String>) {
        if event == "agent-stderr" {
            let mut map = self.lock();
            if let Some(live) = map.get_mut(session_id) {
                let stderr = match live {
                    Live::Claude(row) => &mut row.stderr,
                    Live::Codex(row) | Live::Cursor(row) | Live::Opencode(row) => &mut row.stderr,
                };
                for line in lines {
                    stderr.push(line);
                    if stderr.len() > STDERR_TAIL {
                        stderr.remove(0);
                    }
                }
            }
            return;
        }
        for line in lines {
            self.handle_line(session_id, &line);
        }
    }

    pub fn on_agent_exit(&self, session_id: &str, code: Option<i32>) {
        let mut map = self.lock();
        let Some(live) = map.get_mut(session_id) else {
            return;
        };
        let provider = match live {
            Live::Claude(_) => "Claude Code",
            Live::Codex(_) => "Codex",
            Live::Cursor(_) => "Cursor Agent",
            Live::Opencode(_) => "opencode",
        };
        match live {
            Live::Claude(row) => {
                let mid = row.active;
                let cancelled = row.cancelled;
                let stderr = row.stderr.clone();
                if let Some(tx) = row.init_tx.take() {
                    let _ = tx.send(false);
                }
                if mid && !cancelled {
                    drop(map);
                    self.transcripts.apply(
                        session_id,
                        HarnessEvent::SessionEnded { code },
                    );
                    self.signal(session_id, TurnOutcome::Failed(exit_message(provider, code, &stderr)));
                }
            }
            Live::Codex(row) | Live::Cursor(row) | Live::Opencode(row) => {
                if row.cancelled || row.settled {
                    return;
                }
                let mid = row.active;
                let stderr = row.stderr.clone();
                if mid {
                    drop(map);
                    self.transcripts.apply(session_id, HarnessEvent::SessionEnded { code });
                    self.signal(session_id, TurnOutcome::Failed(exit_message(provider, code, &stderr)));
                }
            }
        }
    }

    fn signal(&self, session_id: &str, outcome: TurnOutcome) {
        let mut map = self.lock();
        if let Some(live) = map.get_mut(session_id) {
            match live {
                Live::Claude(row) => {
                    row.active = false;
                    if let Some(tx) = row.turn_tx.take() {
                        let _ = tx.send(outcome);
                    }
                }
                Live::Codex(row) | Live::Cursor(row) | Live::Opencode(row) => {
                    row.active = false;
                    row.settled = true;
                    if let Some(tx) = row.turn_tx.take() {
                        let _ = tx.send(outcome);
                    }
                }
            }
        }
    }

    fn cancel(&self, session_id: &str, kill: bool) {
        self.mark_stop(session_id);
        let interrupt = {
            let mut map = self.lock();
            if let Some(Live::Claude(row)) = map.get_mut(session_id) {
                if row.active {
                    let id = format!("ctrl-{}", row.next_control);
                    row.next_control += 1;
                    Some(id)
                } else {
                    None
                }
            } else {
                None
            }
        };
        {
            let mut map = self.lock();
            if let Some(live) = map.get_mut(session_id) {
                match live {
                    Live::Claude(row) => {
                        row.cancelled = true;
                        row.mute = true;
                        row.active = false;
                        drop_pending(row);
                        if let Some(tx) = row.turn_tx.take() {
                            let _ = tx.send(TurnOutcome::Stopped);
                        }
                    }
                    Live::Codex(row) | Live::Cursor(row) | Live::Opencode(row) => {
                        row.cancelled = true;
                        row.active = false;
                        row.settled = true;
                        if let Some(tx) = row.turn_tx.take() {
                            let _ = tx.send(TurnOutcome::Stopped);
                        }
                    }
                }
            }
        }
        if let Some(id) = interrupt {
            let _ = self.agents.write(
                session_id,
                &serde_json::to_string(&build_control_request(&id, json!({ "subtype": "interrupt" })))
                    .unwrap_or_default(),
            );
            if kill {
                let host = self.clone();
                let session_id = session_id.to_string();
                self.after(INTERRUPT_GRACE, move || {
                    host.agents.kill(&session_id);
                    host.detach(&session_id);
                });
                return;
            }
        }
        if kill {
            self.agents.kill(session_id);
            self.detach(session_id);
        }
    }

    fn detach(&self, session_id: &str) {
        self.lock().remove(session_id);
    }

    fn resolve_bin(&self, name: &str) -> Result<String, String> {
        if let Some(path) = self
            .binaries
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .get(name)
            .cloned()
        {
            return Ok(path);
        }
        AgentHost::resolve(name).map(|bin| bin.path)
    }

    fn agent_env(&self, session_id: &str) -> HashMap<String, String> {
        let Ok(info) = self.bridge.info() else {
            return HashMap::new();
        };
        HashMap::from([
            ("CREW_SOCKET".into(), info.socket_path),
            ("CREW_TOKEN".into(), info.token),
            ("CREW_SESSION_ID".into(), session_id.into()),
        ])
    }

    fn mcp(&self) -> Option<(String, Vec<String>)> {
        let info = self.bridge.info().ok()?;
        Some((info.exe, vec!["--mcp".into()]))
    }

    fn run_turn(&self, session: crate::session::Session, params: TurnStart) {
        let session_id = session.id.clone();
        let workspace_id = session.workspace_id.clone();
        let outcome = match session.provider.as_str() {
            "claude" => self.run_claude(session, params),
            "codex" => self.run_codex(session, params),
            "cursor" => self.run_cursor(session, params),
            "opencode" => self.run_opencode(session, params),
            other => TurnOutcome::Failed(format!(
                "{other} agents are not wired up yet. Pick Claude for now."
            )),
        };
        match outcome {
            TurnOutcome::Completed => {
                self.transcripts.set_status(&session_id, "done", None);
                self.transcripts.flush(&session_id);
            }
            TurnOutcome::Failed(message) => {
                self.transcripts.apply(
                    &session_id,
                    HarnessEvent::SessionError { message },
                );
                self.transcripts.set_status(&session_id, "error", None);
                self.transcripts.flush(&session_id);
            }
            TurnOutcome::Stopped => {
                self.transcripts
                    .apply(&session_id, HarnessEvent::SessionEnded { code: None });
                self.transcripts.append_system(&session_id, "Stopped");
                self.transcripts.set_status(&session_id, "idle", None);
                self.transcripts.flush(&session_id);
                // A stop is the user saying enough; whatever is queued waits
                // for them, it does not restart the agent.
                return;
            }
        }
        self.drain_mailbox(&session_id, &workspace_id);
    }

    /// Hand over the next letter waiting for an agent that has just gone quiet.
    /// This is also how an agent loops: it writes to itself, the letter cannot
    /// be delivered while it is working, and it arrives the moment it stops.
    fn drain_mailbox(&self, session_id: &str, workspace_id: &str) {
        let Ok(Some(letter)) = mailbox::claim(&self.store, session_id) else {
            return;
        };
        let to_self = letter.from.id == session_id;
        let laps = {
            let mut laps = self.loops.lock().unwrap_or_else(|error| error.into_inner());
            if to_self {
                let count = laps.entry(session_id.to_string()).or_insert(0);
                *count += 1;
                *count
            } else {
                laps.remove(session_id);
                0
            }
        };
        if laps > MAX_SELF_TURNS {
            self.transcripts.append_system(
                session_id,
                &format!("Stopped after {MAX_SELF_TURNS} turns writing to itself. Send it a message to continue."),
            );
            self.transcripts.flush(session_id);
            return;
        }
        let cwd = crate::workspace::get(&self.store, workspace_id.to_string())
            .ok()
            .flatten()
            .map(|row| row.path)
            .unwrap_or_default();
        let started = self.start(TurnStart {
            session_id: session_id.to_string(),
            cwd,
            text: letter.text.clone(),
            files: None,
            mentions: None,
            hidden: None,
            fresh: None,
            from_agent: Some(letter.from.clone()),
            nonce: None,
        });
        if started.is_err() {
            // Something else took the agent between the turn ending and this
            // line. The letter goes back at the head of the queue.
            let _ = mailbox::release(&self.store, &letter.id);
        }
    }

    fn run_claude(&self, session: crate::session::Session, params: TurnStart) -> TurnOutcome {
        let session_id = session.id.clone();
        if self.stop_requested(&session_id) {
            return TurnOutcome::Stopped;
        }
        if let Err(error) = self.ensure_claude(&session, &params) {
            return if self.stop_requested(&session_id) {
                TurnOutcome::Stopped
            } else {
                TurnOutcome::Failed(error)
            };
        }
        if self.stop_requested(&session_id) {
            return TurnOutcome::Stopped;
        }
        let (turn_rx, claude_session_id) = {
            let mut map = self.lock();
            let Some(Live::Claude(live)) = map.get_mut(&session_id) else {
                return if self.stop_requested(&session_id) {
                    TurnOutcome::Stopped
                } else {
                    TurnOutcome::Failed("Claude session is gone".into())
                };
            };
            if self.stop_requested(&session_id) {
                return TurnOutcome::Stopped;
            }
            live.cancelled = false;
            live.mute = false;
            live.active = true;
            live.emitted_assistant.clear();
            live.tools_by_index.clear();
            live.tools_by_id.clear();
            live.idle_gen += 1;
            let (tx, rx) = oneshot::channel();
            live.turn_tx = Some(tx);
            (rx, live.claude_session_id.clone())
        };
        let images = crate::files::load_inline_images(params.files.as_deref().unwrap_or(&[]));
        let inline: HashSet<String> = images.iter().map(|image| image.path.clone()).collect();
        let files = path_list(&params, &inline);
        let message = build_claude_user_message(&claude_session_id, params.text.trim(), &files, &images);
        if let Err(error) = self
            .agents
            .write(&session_id, &serde_json::to_string(&message).unwrap_or_default())
        {
            return TurnOutcome::Failed(error);
        }
        let outcome = self
            .block_on(turn_rx)
            .unwrap_or(TurnOutcome::Failed("Turn channel closed".into()));
        self.schedule_claude_idle(&session_id);
        outcome
    }

    fn ensure_claude(&self, session: &crate::session::Session, params: &TurnStart) -> Result<(), String> {
        let session_id = session.id.clone();
        let autonomy = if session.autonomy == "full" {
            Autonomy::Full
        } else {
            Autonomy::Ask
        };
        let moved = {
            let map = self.lock();
            match map.get(&session_id) {
                Some(Live::Claude(live)) => {
                    if !params.fresh.unwrap_or(false)
                        && live.cwd == params.cwd
                        && live.autonomy == autonomy
                        && live.model == session.model
                    {
                        return Ok(());
                    }
                    live.cwd != params.cwd
                        || live.autonomy != autonomy
                        || live.model != session.model
                }
                _ => false,
            }
        };
        if params.fresh.unwrap_or(false) || self.lock().contains_key(&session_id) {
            self.agents.kill(&session_id);
            self.detach(&session_id);
        }
        if moved {
            let _ = session::set_provider_session(&self.store, session_id.clone(), String::new());
        }

        let stored = session.provider_session_id.clone().filter(|id| !id.is_empty());
        let resume = if moved || params.fresh.unwrap_or(false) {
            None
        } else {
            stored
        };
        let claude_session_id = resume
            .clone()
            .unwrap_or_else(|| uuid::Uuid::new_v4().to_string());

        let live = ClaudeLive {
            cwd: params.cwd.clone(),
            autonomy: autonomy.clone(),
            model: session.model.clone(),
            claude_session_id: claude_session_id.clone(),
            approvals: HashMap::new(),
            questions: HashMap::new(),
            next_ui: 1,
            next_control: 1,
            tools_by_index: HashMap::new(),
            tools_by_id: HashMap::new(),
            cancelled: false,
            mute: false,
            active: false,
            initialized: false,
            init_tx: None,
            turn_tx: None,
            emitted_assistant: String::new(),
            stderr: Vec::new(),
            idle_gen: 0,
        };
        self.lock().insert(session_id.clone(), Live::Claude(Box::new(live)));
        if self.stop_requested(&session_id) {
            self.agents.kill(&session_id);
            return Err("cancelled".into());
        }

        let path = self.resolve_bin("claude").or_else(|_| self.resolve_bin("claude"))?;
        let mcp = self.mcp();
        let persona = claude_persona(
            &session.name,
            &session.description,
            mcp.as_ref().map(|_| TOOLS_HINT),
        );
        let spawn = ClaudeSpawn {
            model: Some(session.model.clone()).filter(|m| !m.is_empty()),
            resume: resume.clone(),
            session_id: if resume.is_none() {
                Some(claude_session_id.clone())
            } else {
                None
            },
            system_prompt: Some(persona),
            autonomy,
            mcp_config: mcp.map(|(command, args)| {
                json!({ "mcpServers": { "crew": { "command": command, "args": args } } }).to_string()
            }),
        };
        if self.stop_requested(&session_id) {
            self.agents.kill(&session_id);
            return Err("cancelled".into());
        }
        self.agents.spawn(
            session_id.clone(),
            path,
            build_claude_spawn_args(&spawn),
            params.cwd.clone(),
            Some(self.agent_env(&session_id)),
        )?;
        if self.stop_requested(&session_id) {
            self.agents.kill(&session_id);
            return Err("cancelled".into());
        }

        let (init_tx, init_rx) = oneshot::channel();
        {
            let mut map = self.lock();
            if let Some(Live::Claude(live)) = map.get_mut(&session_id) {
                live.init_tx = Some(init_tx);
            }
        }
        let ctrl = {
            let mut map = self.lock();
            let Some(Live::Claude(live)) = map.get_mut(&session_id) else {
                return Err("Claude session is gone".into());
            };
            let id = format!("ctrl-{}", live.next_control);
            live.next_control += 1;
            id
        };
        self.agents.write(
            &session_id,
            &serde_json::to_string(&build_control_request(&ctrl, json!({ "subtype": "initialize" })))
                .unwrap_or_default(),
        )?;
        match self.block_on(async { tokio::time::timeout(INIT_TIMEOUT, init_rx).await }) {
            Ok(Ok(true)) => {}
            Ok(Ok(false)) | Ok(Err(_)) => {
                let stderr = self
                    .lock()
                    .get(&session_id)
                    .and_then(|live| match live {
                        Live::Claude(row) => Some(row.stderr.join("\n")),
                        _ => None,
                    })
                    .unwrap_or_default();
                return Err(if stderr.trim().is_empty() {
                    "Claude Code did not start.".into()
                } else {
                    format!("Claude Code did not start.\n{}", stderr.trim())
                });
            }
            Err(_) => {
                return Err("Claude Code did not answer in time.".into());
            }
        }
        self.transcripts.apply(
            &session_id,
            HarnessEvent::SessionProviderBound {
                provider_session_id: claude_session_id,
            },
        );
        self.transcripts
            .apply(&session_id, HarnessEvent::SessionStarted {});
        Ok(())
    }

    fn schedule_claude_idle(&self, session_id: &str) {
        let gen = {
            let map = self.lock();
            match map.get(session_id) {
                Some(Live::Claude(live)) => live.idle_gen,
                _ => return,
            }
        };
        let host = self.clone();
        let id = session_id.to_string();
        self.after(IDLE_KILL, move || {
            let mut map = host.lock();
            let Some(Live::Claude(live)) = map.get_mut(&id) else {
                return;
            };
            if live.active || live.idle_gen != gen {
                return;
            }
            drop(map);
            host.agents.kill(&id);
            host.detach(&id);
        });
    }

    fn run_codex(&self, session: crate::session::Session, params: TurnStart) -> TurnOutcome {
        let session_id = session.id.clone();
        self.agents.kill(&session_id);
        let resume = if params.fresh.unwrap_or(false) {
            None
        } else {
            session.provider_session_id.clone().filter(|id| !id.is_empty())
        };
        let (turn_rx, _) = match self.install_stream(&session_id, params.cwd.clone(), Live::Codex) {
            Ok(pair) => pair,
            Err(error) => return TurnOutcome::Failed(error),
        };
        let path = match self.resolve_bin("codex") {
            Ok(path) => path,
            Err(error) => return TurnOutcome::Failed(error),
        };
        let mcp = self.mcp();
        let prompt = build_codex_prompt(
            if resume.is_some() { "" } else { &session.name },
            if resume.is_some() { "" } else { &session.description },
            &params.text,
            &path_list(&params, &HashSet::new()),
            resume.is_none(),
            mcp.as_ref().map(|_| TOOLS_HINT),
        );
        if let Err(error) = self.agents.spawn(
            session_id.clone(),
            path,
            build_codex_spawn_args(&CodexSpawn {
                prompt,
                model: Some(session.model.clone()).filter(|m| !m.is_empty()),
                resume: resume.clone(),
                cwd: Some(params.cwd.clone()),
                autonomy: if session.autonomy == "full" {
                    Autonomy::Full
                } else {
                    Autonomy::Ask
                },
                mcp,
            }),
            params.cwd,
            Some(self.agent_env(&session_id)),
        ) {
            return TurnOutcome::Failed(error);
        }
        self.agents.close_stdin(&session_id);
        if let Some(resume) = resume {
            self.transcripts.apply(
                &session_id,
                HarnessEvent::SessionProviderBound {
                    provider_session_id: resume,
                },
            );
        }
        self.transcripts
            .apply(&session_id, HarnessEvent::SessionStarted {});
        let outcome = self
            .block_on(turn_rx)
            .unwrap_or(TurnOutcome::Failed("Turn channel closed".into()));
        self.agents.kill(&session_id);
        self.detach(&session_id);
        outcome
    }

    fn run_cursor(&self, session: crate::session::Session, params: TurnStart) -> TurnOutcome {
        let session_id = session.id.clone();
        let resume = if params.fresh.unwrap_or(false) {
            None
        } else {
            session.provider_session_id.clone().filter(|id| !id.is_empty())
        };
        let (turn_rx, _) = match self.install_stream(&session_id, params.cwd.clone(), Live::Cursor) {
            Ok(pair) => pair,
            Err(error) => return TurnOutcome::Failed(error),
        };
        let path = match self.resolve_bin("cursor-agent") {
            Ok(path) => path,
            Err(error) => return TurnOutcome::Failed(error),
        };
        let mcp = self.mcp();
        let body = with_attached_files(params.text.trim(), &path_list(&params, &HashSet::new()));
        let persona = if resume.is_some() {
            None
        } else {
            Some(cursor_persona(
                &session.name,
                &session.description,
                mcp.as_ref().map(|_| TOOLS_HINT),
            ))
        };
        let prompt = with_persona(&body, persona.as_deref());
        if let Err(error) = self.agents.spawn(
            session_id.clone(),
            path,
            build_cursor_spawn_args(&CursorSpawn {
                prompt,
                model: Some(session.model.clone()).filter(|m| !m.is_empty()),
                resume: resume.clone(),
                autonomy: if session.autonomy == "full" {
                    Autonomy::Full
                } else {
                    Autonomy::Ask
                },
            }),
            params.cwd,
            Some(self.agent_env(&session_id)),
        ) {
            return TurnOutcome::Failed(error);
        }
        if let Some(resume) = resume {
            self.transcripts.apply(
                &session_id,
                HarnessEvent::SessionProviderBound {
                    provider_session_id: resume,
                },
            );
        }
        self.transcripts
            .apply(&session_id, HarnessEvent::SessionStarted {});
        let outcome = self
            .block_on(turn_rx)
            .unwrap_or(TurnOutcome::Failed("Turn channel closed".into()));
        self.agents.kill(&session_id);
        self.detach(&session_id);
        outcome
    }

    fn run_opencode(&self, session: crate::session::Session, params: TurnStart) -> TurnOutcome {
        let session_id = session.id.clone();
        let mcp = self.mcp();
        let resume = if params.fresh.unwrap_or(false) {
            None
        } else {
            session.provider_session_id.clone().filter(|id| !id.is_empty())
        };
        let (turn_rx, _) = match self.install_stream(&session_id, params.cwd.clone(), Live::Opencode) {
            Ok(pair) => pair,
            Err(error) => return TurnOutcome::Failed(error),
        };
        let path = match self.resolve_bin("opencode") {
            Ok(path) => path,
            Err(error) => return TurnOutcome::Failed(error),
        };
        let prompt = build_opencode_prompt(
            if resume.is_some() { "" } else { &session.name },
            if resume.is_some() { "" } else { &session.description },
            &params.text,
            &path_list(&params, &HashSet::new()),
            resume.is_none(),
            mcp.as_ref().map(|_| TOOLS_HINT),
        );
        let mut env = self.agent_env(&session_id);
        if let Some(config) = opencode_config(mcp.as_ref()) {
            env.insert("OPENCODE_CONFIG_CONTENT".into(), config);
        }
        if let Err(error) = self.agents.spawn(
            session_id.clone(),
            path,
            build_opencode_spawn_args(&OpencodeSpawn {
                model: Some(session.model.clone()).filter(|m| !m.is_empty()),
                resume: resume.clone(),
                autonomy: if session.autonomy == "full" {
                    Autonomy::Full
                } else {
                    Autonomy::Ask
                },
            }),
            params.cwd,
            Some(env),
        ) {
            return TurnOutcome::Failed(error);
        }
        if let Err(error) = self.agents.write(&session_id, &prompt) {
            return TurnOutcome::Failed(error);
        }
        self.agents.close_stdin(&session_id);
        if let Some(resume) = resume {
            self.transcripts.apply(
                &session_id,
                HarnessEvent::SessionProviderBound {
                    provider_session_id: resume,
                },
            );
        }
        self.transcripts
            .apply(&session_id, HarnessEvent::SessionStarted {});
        let outcome = self
            .block_on(turn_rx)
            .unwrap_or(TurnOutcome::Failed("Turn channel closed".into()));
        self.agents.kill(&session_id);
        self.detach(&session_id);
        outcome
    }

    fn install_stream(
        &self,
        session_id: &str,
        _cwd: String,
        wrap: fn(StreamLive) -> Live,
    ) -> Result<(oneshot::Receiver<TurnOutcome>, ()), String> {
        let (tx, rx) = oneshot::channel();
        let live = StreamLive {
            cancelled: false,
            active: true,
            turn_tx: Some(tx),
            emitted_assistant: String::new(),
            seen_tools: HashSet::new(),
            stderr: Vec::new(),
            saw_text: false,
            settled: false,
            text_part: String::new(),
            usage: None,
        };
        self.lock().insert(session_id.to_string(), wrap(live));
        Ok((rx, ()))
    }

    fn handle_line(&self, session_id: &str, line: &str) {
        let kind = {
            let map = self.lock();
            match map.get(session_id) {
                Some(Live::Claude(_)) => "claude",
                Some(Live::Codex(_)) => "codex",
                Some(Live::Cursor(_)) => "cursor",
                Some(Live::Opencode(_)) => "opencode",
                None => return,
            }
        };
        match kind {
            "claude" => self.handle_claude_line(session_id, line),
            "codex" => self.handle_codex_line(session_id, line),
            "cursor" => self.handle_cursor_line(session_id, line),
            "opencode" => self.handle_opencode_line(session_id, line),
            _ => {}
        }
    }

    pub(crate) fn handle_claude_line(&self, session_id: &str, line: &str) {
        let Some(rec) = parse_json_line(line) else {
            return;
        };
        if string_field(Some(&rec), "type").as_deref() == Some("keep_alive") {
            return;
        }
        if let Some(cancel_id) = parse_control_cancel_id(&rec) {
            let mut map = self.lock();
            if let Some(Live::Claude(live)) = map.get_mut(session_id) {
                live.approvals.retain(|_, pending| {
                    if pending.request_id == cancel_id {
                        let _ = pending.tx.send(ApprovalResolution::Cancelled);
                        false
                    } else {
                        true
                    }
                });
                live.questions.retain(|_, pending| {
                    if pending.request_id == cancel_id {
                        let _ = pending.tx.send(QuestionReply::Cancelled);
                        false
                    } else {
                        true
                    }
                });
            }
            return;
        }
        if let Some(control) = parse_control_request(&rec) {
            self.handle_claude_control(session_id, control);
            return;
        }

        let mut events = Vec::new();
        let mut bind: Option<String> = None;
        {
            let mut map = self.lock();
            let Some(Live::Claude(live)) = map.get_mut(session_id) else {
                return;
            };
            if live.mute {
                return;
            }
            if let Some(from_line) = session_id_from_message(&rec) {
                if from_line != live.claude_session_id {
                    live.claude_session_id = from_line.clone();
                    bind = Some(from_line);
                }
            }
            let type_name = string_field(Some(&rec), "type");
            let subtype = string_field(Some(&rec), "subtype");
            if type_name.as_deref() == Some("control_response")
                || (type_name.as_deref() == Some("system")
                    && matches!(subtype.as_deref(), Some("init" | "initialized")))
            {
                if !live.initialized {
                    live.initialized = true;
                    if let Some(tx) = live.init_tx.take() {
                        let _ = tx.send(true);
                    }
                }
                return;
            }
            if is_compact_boundary(&rec) {
                events.push(HarnessEvent::SessionNote {
                    message: "Context compacted".into(),
                });
            } else if type_name.as_deref() == Some("stream_event") {
                claude_stream(live, &rec, &mut events);
            } else if type_name.as_deref() == Some("assistant") {
                claude_assistant(live, &rec, &mut events);
            } else if type_name.as_deref() == Some("user") {
                for result in tool_results_from_user_message(&rec) {
                    // The result names only the call, so the input the row was
                    // opened with is what turns it back into a detail.
                    let detail = live.tools_by_id.get(&result.tool_use_id).and_then(|tool| {
                        claude_tool_result_detail(&tool.name, &tool.input, &result.content)
                    });
                    events.push(HarnessEvent::ToolUpdated {
                        call_id: result.tool_use_id,
                        title: None,
                        status: Some(if result.is_error {
                            ToolStatus::Failed
                        } else {
                            ToolStatus::Completed
                        }),
                        detail,
                    });
                }
            } else if type_name.as_deref() == Some("result") {
                let failed = if live.cancelled {
                    None
                } else {
                    claude_turn_failed(&rec)
                };
                events.push(HarnessEvent::TurnCompleted {
                    usage: Some(claude_turn_usage(&rec)),
                });
                live.active = false;
                if let Some(tx) = live.turn_tx.take() {
                    let _ = tx.send(match failed {
                        Some(message) => TurnOutcome::Failed(message),
                        None => TurnOutcome::Completed,
                    });
                }
            }
        }
        if let Some(id) = bind {
            self.transcripts.apply(
                session_id,
                HarnessEvent::SessionProviderBound {
                    provider_session_id: id,
                },
            );
        }
        for event in events {
            self.transcripts.apply(session_id, event);
        }
    }

    fn handle_claude_control(&self, session_id: &str, control: ClaudeControlRequest) {
        if control.subtype != "can_use_tool" && control.subtype != "permission" {
            let _ = self.agents.write(
                session_id,
                &serde_json::to_string(&build_control_response(&control.request_id, json!({})))
                    .unwrap_or_default(),
            );
            return;
        }
        let host = self.clone();
        let session_id = session_id.to_string();
        thread::spawn(move || host.claude_control_wait(session_id, control));
    }

    fn claude_control_wait(&self, session_id: String, control: ClaudeControlRequest) {
        let questions = parse_questions(&control.input);
        let tool_name = control.tool_name.clone().unwrap_or_else(|| "tool".into());
        let cancelled = {
            let map = self.lock();
            match map.get(&session_id) {
                Some(Live::Claude(live)) => live.cancelled || live.mute,
                _ => true,
            }
        };
        if cancelled {
            let _ = self.agents.write(
                &session_id,
                &serde_json::to_string(&build_control_response(
                    &control.request_id,
                    to_permission_result(ApprovalDecision::Deny, &control.input, ""),
                ))
                .unwrap_or_default(),
            );
            return;
        }
        if !questions.is_empty() {
            let (tx, rx) = mpsc::channel();
            let ui_id = {
                let mut map = self.lock();
                let Some(Live::Claude(live)) = map.get_mut(&session_id) else {
                    return;
                };
                let ui_id = live.next_ui;
                live.next_ui += 1;
                live.questions.insert(
                    ui_id,
                    PendingQuestion {
                        request_id: control.request_id.clone(),
                        tx,
                    },
                );
                ui_id
            };
            self.transcripts.set_status(&session_id, "needs-input", None);
            self.transcripts.apply(
                &session_id,
                HarnessEvent::QuestionRequested {
                    request_id: ui_id,
                    questions,
                },
            );
            let reply = rx.recv().unwrap_or(QuestionReply::Dismiss);
            match reply {
                QuestionReply::Cancelled => {
                    self.transcripts.apply(
                        &session_id,
                        HarnessEvent::QuestionResolved {
                            request_id: ui_id,
                            answers: None,
                        },
                    );
                }
                QuestionReply::Dismiss => {
                    self.transcripts.apply(
                        &session_id,
                        HarnessEvent::QuestionResolved {
                            request_id: ui_id,
                            answers: None,
                        },
                    );
                    self.transcripts.set_status(&session_id, "working", None);
                    let _ = self.agents.write(
                        &session_id,
                        &serde_json::to_string(&build_control_response(
                            &control.request_id,
                            to_question_result(&control.input, None),
                        ))
                        .unwrap_or_default(),
                    );
                }
                QuestionReply::Answers(answers) => {
                    self.transcripts.apply(
                        &session_id,
                        HarnessEvent::QuestionResolved {
                            request_id: ui_id,
                            answers: Some(answers.clone()),
                        },
                    );
                    self.transcripts.set_status(&session_id, "working", None);
                    let _ = self.agents.write(
                        &session_id,
                        &serde_json::to_string(&build_control_response(
                            &control.request_id,
                            to_question_result(&control.input, Some(&answers)),
                        ))
                        .unwrap_or_default(),
                    );
                }
            }
            return;
        }
        let (tx, rx) = mpsc::channel();
        let ui_id = {
            let mut map = self.lock();
            let Some(Live::Claude(live)) = map.get_mut(&session_id) else {
                return;
            };
            let ui_id = live.next_ui;
            live.next_ui += 1;
                live.approvals.insert(
                    ui_id,
                    PendingApproval {
                        request_id: control.request_id.clone(),
                        tx,
                    },
                );
            ui_id
        };
        let title = claude_tool_label(&tool_name, &control.input);
        self.transcripts.set_status(&session_id, "needs-input", None);
        self.transcripts.apply(
            &session_id,
            HarnessEvent::ApprovalRequested {
                request_id: ui_id,
                name: tool_name.clone(),
                title,
                input: Some(Value::Object(control.input.clone())),
            },
        );
        let decision = rx.recv().unwrap_or(ApprovalResolution::Deny);
        self.transcripts.apply(
            &session_id,
            HarnessEvent::ApprovalResolved {
                request_id: ui_id,
                decision: decision.clone(),
            },
        );
        if decision == ApprovalResolution::Cancelled {
            return;
        }
        self.transcripts.set_status(&session_id, "working", None);
        let decided = match decision {
            ApprovalResolution::Allow => ApprovalDecision::Allow,
            ApprovalResolution::Always => ApprovalDecision::Always,
            _ => ApprovalDecision::Deny,
        };
        let _ = self.agents.write(
            &session_id,
            &serde_json::to_string(&build_control_response(
                &control.request_id,
                to_permission_result(decided, &control.input, &tool_name),
            ))
            .unwrap_or_default(),
        );
    }

    pub(crate) fn handle_codex_line(&self, session_id: &str, line: &str) {
        let Some(rec) = parse_json_line(line) else {
            return;
        };
        if let Some(thread_id) = thread_id_from_event(&rec) {
            self.transcripts.apply(
                session_id,
                HarnessEvent::SessionProviderBound {
                    provider_session_id: thread_id,
                },
            );
        }
        let type_name = string_field(Some(&rec), "type");
        if type_name.as_deref() == Some("error") {
            if let Some(fatal) = stream_error_message(&rec) {
                self.signal(session_id, TurnOutcome::Failed(fatal));
            }
            return;
        }
        if type_name.as_deref() == Some("turn.completed") {
            self.transcripts
                .apply(session_id, HarnessEvent::MessageCompleted {});
            self.transcripts.apply(
                session_id,
                HarnessEvent::TurnCompleted {
                    usage: codex_turn_usage(&rec),
                },
            );
            self.signal(session_id, TurnOutcome::Completed);
            return;
        }
        if type_name.as_deref() == Some("turn.failed") {
            let message = stream_error_message(&rec).unwrap_or_else(|| "Codex turn failed.".into());
            self.transcripts
                .apply(session_id, HarnessEvent::MessageCompleted {});
            self.transcripts
                .apply(session_id, HarnessEvent::TurnCompleted { usage: None });
            self.signal(session_id, TurnOutcome::Failed(message));
            return;
        }
        let Some(item) = item_from_event(&rec) else {
            return;
        };
        let cancelled = {
            let map = self.lock();
            matches!(map.get(session_id), Some(Live::Codex(row)) if row.cancelled)
        };
        if cancelled {
            return;
        }
        if let Some(error) = item_error_message(&item) {
            self.transcripts
                .apply(session_id, HarnessEvent::SessionNote { message: error });
            return;
        }
        if let Some(text) = agent_message_text(&item) {
            self.codex_text(session_id, &text, type_name.as_deref() == Some("item.completed"));
            return;
        }
        if !is_tool_item(&item) {
            return;
        }
        let Some(call_id) = tool_call_id(&item) else {
            return;
        };
        let title = codex_tool_label(&item);
        let first = {
            let mut map = self.lock();
            let Some(Live::Codex(live)) = map.get_mut(session_id) else {
                return;
            };
            live.seen_tools.insert(call_id.clone())
        };
        if first {
            self.transcripts.apply(
                session_id,
                HarnessEvent::ToolStarted {
                    call_id: call_id.clone(),
                    name: codex_tool_name(&item),
                    title: title.clone(),
                    detail: codex_tool_detail(&item),
                },
            );
        } else {
            self.transcripts.apply(
                session_id,
                HarnessEvent::ToolUpdated {
                    call_id: call_id.clone(),
                    title: Some(title),
                    status: None,
                    detail: codex_tool_detail(&item),
                },
            );
        }
        if type_name.as_deref() == Some("item.completed") {
            self.transcripts.apply(
                session_id,
                HarnessEvent::ToolUpdated {
                    call_id,
                    title: None,
                    status: Some(completed_tool_status(&item)),
                    detail: None,
                },
            );
        }
    }

    fn codex_text(&self, session_id: &str, text: &str, completed: bool) {
        let extra = {
            let mut map = self.lock();
            let Some(Live::Codex(live)) = map.get_mut(session_id) else {
                return;
            };
            if !live.emitted_assistant.is_empty()
                && text != live.emitted_assistant
                && !text.starts_with(&live.emitted_assistant)
            {
                self.transcripts
                    .apply(session_id, HarnessEvent::MessageCompleted {});
                live.emitted_assistant.clear();
            }
            if text.starts_with(&live.emitted_assistant) {
                let extra = text[live.emitted_assistant.len()..].to_string();
                if !extra.is_empty() {
                    live.emitted_assistant = text.to_string();
                    Some(extra)
                } else {
                    None
                }
            } else if !text.is_empty() {
                live.emitted_assistant = text.to_string();
                Some(text.to_string())
            } else {
                None
            }
        };
        if let Some(extra) = extra {
            self.transcripts.apply(
                session_id,
                HarnessEvent::MessageDelta { text: extra },
            );
        }
        if completed {
            self.transcripts
                .apply(session_id, HarnessEvent::MessageCompleted {});
            if let Some(Live::Codex(live)) = self.lock().get_mut(session_id) {
                live.emitted_assistant.clear();
            }
        }
    }

    pub(crate) fn handle_cursor_line(&self, session_id: &str, line: &str) {
        let Some(rec) = parse_json_line(line) else {
            return;
        };
        if let Some(chat_id) = session_id_from_event(&rec) {
            self.transcripts.apply(
                session_id,
                HarnessEvent::SessionProviderBound {
                    provider_session_id: chat_id,
                },
            );
        }
        let blocked = {
            let map = self.lock();
            matches!(
                map.get(session_id),
                Some(Live::Cursor(row)) if row.settled || row.cancelled
            )
        };
        if blocked {
            return;
        }
        let type_name = string_field(Some(&rec), "type");
        if type_name.as_deref() == Some("assistant") {
            if let Some(text) = assistant_delta_text(&rec) {
                if let Some(Live::Cursor(live)) = self.lock().get_mut(session_id) {
                    live.saw_text = true;
                }
                self.transcripts
                    .apply(session_id, HarnessEvent::MessageDelta { text });
            }
            return;
        }
        if type_name.as_deref() == Some("thinking") {
            if string_field(Some(&rec), "subtype").as_deref() == Some("delta") {
                if let Some(text) = rec.get("text").and_then(Value::as_str).filter(|t| !t.is_empty()) {
                    self.transcripts.apply(
                        session_id,
                        HarnessEvent::ReasoningDelta {
                            text: text.to_string(),
                        },
                    );
                }
            }
            return;
        }
        if type_name.as_deref() == Some("tool_call") {
            let Some(call) = parse_tool_call(&rec) else {
                return;
            };
            let first = {
                let mut map = self.lock();
                let Some(Live::Cursor(live)) = map.get_mut(session_id) else {
                    return;
                };
                live.seen_tools.insert(call.call_id.clone())
            };
            if first {
                self.transcripts.apply(
                    session_id,
                    HarnessEvent::ToolStarted {
                        call_id: call.call_id.clone(),
                        name: call.name,
                        title: call.title,
                        detail: call.detail.clone(),
                    },
                );
            }
            if call.phase == ToolPhase::Completed {
                self.transcripts.apply(
                    session_id,
                    HarnessEvent::ToolUpdated {
                        call_id: call.call_id,
                        title: None,
                        status: Some(cursor_tool_status(call.failed)),
                        detail: call.detail,
                    },
                );
            }
            return;
        }
        if type_name.as_deref() != Some("result") {
            return;
        }
        let failed = cursor_turn_failed(&rec);
        let fallback = string_field(Some(&rec), "result");
        let saw = {
            let map = self.lock();
            matches!(map.get(session_id), Some(Live::Cursor(row)) if row.saw_text)
        };
        if !saw {
            if let Some(fallback) = fallback {
                if failed.is_none() {
                    if let Some(Live::Cursor(live)) = self.lock().get_mut(session_id) {
                        live.saw_text = true;
                    }
                    self.transcripts.apply(
                        session_id,
                        HarnessEvent::MessageDelta { text: fallback },
                    );
                }
            }
        }
        self.transcripts
            .apply(session_id, HarnessEvent::MessageCompleted {});
        self.transcripts.apply(
            session_id,
            HarnessEvent::TurnCompleted {
                usage: Some(cursor_turn_usage(&rec)),
            },
        );
        if let Some(error) = failed {
            self.signal(session_id, TurnOutcome::Failed(error));
        } else {
            self.signal(session_id, TurnOutcome::Completed);
        }
    }

    pub(crate) fn handle_opencode_line(&self, session_id: &str, line: &str) {
        let Some(rec) = parse_json_line(line) else {
            return;
        };
        if let Some(provider_session_id) = opencode_session_id(&rec) {
            self.transcripts.apply(
                session_id,
                HarnessEvent::SessionProviderBound { provider_session_id },
            );
        }
        let blocked = {
            let map = self.lock();
            matches!(
                map.get(session_id),
                Some(Live::Opencode(row)) if row.settled || row.cancelled
            )
        };
        if blocked {
            return;
        }
        let type_name = string_field(Some(&rec), "type");
        if type_name.as_deref() == Some("text") {
            if let Some(part) = text_part(&rec) {
                self.opencode_text(session_id, &part);
            }
            return;
        }
        if type_name.as_deref() == Some("tool_use") {
            let Some(call) = parse_opencode_tool_call(&rec) else {
                return;
            };
            let first = {
                let mut map = self.lock();
                let Some(Live::Opencode(live)) = map.get_mut(session_id) else {
                    return;
                };
                live.seen_tools.insert(call.call_id.clone())
            };
            if first {
                self.transcripts.apply(
                    session_id,
                    HarnessEvent::ToolStarted {
                        call_id: call.call_id.clone(),
                        name: call.name,
                        title: call.title,
                        detail: call.detail.clone(),
                    },
                );
            }
            self.transcripts.apply(
                session_id,
                HarnessEvent::ToolUpdated {
                    call_id: call.call_id,
                    title: None,
                    status: Some(call.status),
                    detail: call.detail,
                },
            );
            return;
        }
        if type_name.as_deref() == Some("error") {
            self.signal(session_id, TurnOutcome::Failed(opencode_error_message(&rec)));
            return;
        }
        if type_name.as_deref() != Some("step_finish") {
            return;
        }
        let usage = {
            let mut map = self.lock();
            let Some(Live::Opencode(live)) = map.get_mut(session_id) else {
                return;
            };
            live.usage = Some(add_step_usage(live.usage.as_ref(), &rec));
            live.usage.clone()
        };
        // Nothing is printed when the session goes idle, so the step that stops
        // calling tools is the only word that the turn is over.
        if !turn_ended(&rec) {
            return;
        }
        self.transcripts
            .apply(session_id, HarnessEvent::MessageCompleted {});
        self.transcripts
            .apply(session_id, HarnessEvent::TurnCompleted { usage });
        self.signal(session_id, TurnOutcome::Completed);
    }

    fn opencode_text(&self, session_id: &str, part: &OpencodeText) {
        let extra = {
            let mut map = self.lock();
            let Some(Live::Opencode(live)) = map.get_mut(session_id) else {
                return;
            };
            if live.text_part != part.id {
                live.text_part = part.id.clone();
                live.emitted_assistant.clear();
            }
            let extra = part
                .text
                .strip_prefix(live.emitted_assistant.as_str())
                .unwrap_or(&part.text)
                .to_string();
            live.emitted_assistant = part.text.clone();
            extra
        };
        if extra.is_empty() {
            return;
        }
        self.transcripts
            .apply(session_id, HarnessEvent::MessageDelta { text: extra });
        self.transcripts
            .apply(session_id, HarnessEvent::MessageCompleted {});
    }
}

fn claude_stream(live: &mut ClaudeLive, rec: &Map<String, Value>, events: &mut Vec<HarnessEvent>) {
    if is_subagent_message(rec) {
        return;
    }
    if is_message_start(rec) {
        live.emitted_assistant.clear();
        return;
    }
    if let Some(text) = stream_text_delta(rec) {
        live.emitted_assistant.push_str(&text);
        events.push(HarnessEvent::MessageDelta { text });
        return;
    }
    if let Some(started) = tool_start_from_event(rec) {
        let tool = InFlightTool {
            id: started.id.clone(),
            name: started.name.clone(),
            input: started.input.clone(),
            partial_json: String::new(),
        };
        if started.index >= 0 {
            live.tools_by_index.insert(started.index, InFlightTool {
                id: started.id.clone(),
                name: started.name.clone(),
                input: started.input.clone(),
                partial_json: String::new(),
            });
        }
        live.tools_by_id.insert(started.id.clone(), tool);
        events.push(HarnessEvent::ToolStarted {
            call_id: started.id,
            name: started.name.clone(),
            title: claude_tool_label(&started.name, &started.input),
            detail: claude_tool_detail(&started.name, &started.input),
        });
        return;
    }
    let Some((index, partial)) = input_json_delta_from_event(rec) else {
        return;
    };
    let Some(tool) = live.tools_by_index.get_mut(&index) else {
        return;
    };
    tool.partial_json.push_str(&partial);
    let Some(parsed) = try_parse_json_record(&tool.partial_json) else {
        return;
    };
    tool.input = parsed.clone();
    let id = tool.id.clone();
    let name = tool.name.clone();
    // The streamed input arrives by index; the result is looked up by id. Without
    // this the id side keeps the empty input it started with, and a finished row
    // loses its command to the raw text of its own output.
    if let Some(by_id) = live.tools_by_id.get_mut(&id) {
        by_id.input = parsed.clone();
    }
    events.push(HarnessEvent::ToolUpdated {
        call_id: id,
        title: Some(claude_tool_label(&name, &parsed)),
        status: None,
        detail: claude_tool_detail(&name, &parsed),
    });
}

fn claude_assistant(live: &mut ClaudeLive, rec: &Map<String, Value>, events: &mut Vec<HarnessEvent>) {
    if is_subagent_message(rec) {
        return;
    }
    let snapshot = assistant_text_blocks(rec);
    if snapshot.starts_with(&live.emitted_assistant) {
        if snapshot.len() > live.emitted_assistant.len() {
            let extra = snapshot[live.emitted_assistant.len()..].to_string();
            live.emitted_assistant = snapshot;
            events.push(HarnessEvent::MessageDelta { text: extra });
        }
    } else if !snapshot.is_empty() {
        events.push(HarnessEvent::MessageCompleted {});
        live.emitted_assistant = snapshot.clone();
        events.push(HarnessEvent::MessageDelta { text: snapshot });
    }
    for use_ in assistant_tool_uses(rec) {
        // This frame carries the whole input; a streamed call may have been
        // registered before its arguments finished arriving.
        if let Some(known) = live.tools_by_id.get_mut(&use_.id) {
            if known.input.is_empty() && !use_.input.is_empty() {
                known.input = use_.input.clone();
                events.push(HarnessEvent::ToolUpdated {
                    call_id: use_.id.clone(),
                    title: Some(claude_tool_label(&use_.name, &use_.input)),
                    status: None,
                    detail: claude_tool_detail(&use_.name, &use_.input),
                });
            }
            continue;
        }
        live.tools_by_id.insert(
            use_.id.clone(),
            InFlightTool {
                id: use_.id.clone(),
                name: use_.name.clone(),
                input: use_.input.clone(),
                partial_json: String::new(),
            },
        );
        events.push(HarnessEvent::ToolStarted {
            call_id: use_.id,
            name: use_.name.clone(),
            title: claude_tool_label(&use_.name, &use_.input),
            detail: claude_tool_detail(&use_.name, &use_.input),
        });
    }
}

fn drop_pending(live: &mut ClaudeLive) {
    for (_, pending) in live.approvals.drain() {
        let _ = pending.tx.send(ApprovalResolution::Deny);
    }
    for (_, pending) in live.questions.drain() {
        let _ = pending.tx.send(QuestionReply::Dismiss);
    }
}

fn path_list(params: &TurnStart, skip: &HashSet<String>) -> Vec<String> {
    let mut paths = params.mentions.clone().unwrap_or_default();
    if let Some(files) = &params.files {
        for file in files {
            if !skip.contains(&file.path) {
                paths.push(file.path.clone());
            }
        }
    }
    paths
}

fn exit_message(provider: &str, code: Option<i32>, stderr: &[String]) -> String {
    let tail = stderr.join("\n").trim().to_string();
    let head = match code {
        None => format!("{provider} stopped"),
        Some(code) => format!("{provider} exited with code {code}"),
    };
    if tail.is_empty() {
        format!("{head}.")
    } else {
        format!("{head}.\n{tail}")
    }
}

#[cfg(test)]
pub(crate) struct Applied(Mutex<Vec<HarnessEvent>>);

#[cfg(test)]
impl Default for Applied {
    fn default() -> Self {
        Self(Mutex::new(Vec::new()))
    }
}

#[cfg(test)]
impl Applied {
    pub(crate) fn take(&self) -> Vec<HarnessEvent> {
        std::mem::take(&mut *self.0.lock().unwrap_or_else(|e| e.into_inner()))
    }
}

#[cfg(test)]
impl crate::transcript::TranscriptEvents for Applied {
    fn apply(&self, _session_id: &str, _seq: u64, event: &HarnessEvent) {
        self.0.lock().unwrap_or_else(|e| e.into_inner()).push(event.clone());
    }

    fn status(
        &self,
        _session_id: &str,
        _status: &str,
        _provider_session_id: Option<&str>,
        _updated_at: i64,
    ) {
    }
}

#[cfg(test)]
impl TurnHost {
    pub(crate) fn test_new() -> Self {
        let dir = std::path::PathBuf::from(format!("/tmp/c{}", &uuid::Uuid::new_v4().simple().to_string()[..10]));
        let _ = std::fs::create_dir_all(&dir);
        let store = crate::store::Store::open(dir.join("crew.sqlite3")).expect("store");
        let transcripts = crate::transcript::TranscriptHub::new(store.clone());
        let bridge = crate::bridge::Bridge::start(dir).expect("bridge");
        Self::new(crate::agent::AgentHost::new(), store, transcripts, bridge)
    }

    pub(crate) fn test_agents(&self) -> &AgentHost {
        &self.agents
    }

    pub(crate) fn test_store(&self) -> &crate::store::Store {
        &self.store
    }

    pub(crate) fn test_capture(&self) -> Arc<Applied> {
        let applied = Arc::new(Applied::default());
        self.transcripts.set_events(applied.clone());
        applied
    }

    pub(crate) fn test_install_claude(&self, id: &str) {
        self.lock().insert(
            id.to_string(),
            Live::Claude(Box::new(ClaudeLive {
                cwd: String::new(),
                autonomy: Autonomy::Full,
                model: String::new(),
                claude_session_id: String::new(),
                approvals: HashMap::new(),
                questions: HashMap::new(),
                next_ui: 1,
                next_control: 1,
                tools_by_index: HashMap::new(),
                tools_by_id: HashMap::new(),
                cancelled: false,
                mute: false,
                active: true,
                initialized: true,
                init_tx: None,
                turn_tx: None,
                emitted_assistant: String::new(),
                stderr: Vec::new(),
                idle_gen: 0,
            })),
        );
    }

    pub(crate) fn test_install_codex(&self, id: &str) {
        let _ = self.install_stream(id, String::new(), Live::Codex);
    }

    pub(crate) fn test_install_cursor(&self, id: &str) {
        let _ = self.install_stream(id, String::new(), Live::Cursor);
    }

    pub(crate) fn test_install_opencode(&self, id: &str) {
        let _ = self.install_stream(id, String::new(), Live::Opencode);
    }
}


#[cfg(test)]
mod mailbox_tests {
    use super::*;
    use crew_protocol::{AgentRef, BlockRole};

    /// An opencode that answers once and stops. Enough to end a turn, which is
    /// the moment the box is drained. `pause` makes it slow enough to interrupt.
    fn fake_opencode(dir: &std::path::Path) -> String {
        fake_opencode_paused(dir, 0.0)
    }

    fn fake_opencode_paused(dir: &std::path::Path, pause: f32) -> String {
        let path = dir.join(format!("fake-opencode-{pause}"));
        std::fs::write(
            &path,
            format!(
                r#"#!/usr/bin/env python3
import json, sys, time
sys.stdin.read()
time.sleep({pause})
sid = "ses_test"
print(json.dumps({{"type":"text","sessionID":sid,"part":{{"id":"p1","type":"text","text":"ok"}}}}), flush=True)
print(json.dumps({{"type":"step_finish","sessionID":sid,"part":{{"id":"s1","type":"step-finish","reason":"stop","tokens":{{"input":1,"output":1,"reasoning":0,"cache":{{"read":0,"write":0}}}},"cost":0}}}}), flush=True)
"#
            ),
        )
        .expect("write fake");
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o755)).expect("chmod");
        path.to_string_lossy().into_owned()
    }

    struct World {
        host: TurnHost,
        dir: std::path::PathBuf,
    }

    /// The daemon wires the agent process's stdout back into the turn host; a
    /// test that spawns a real process has to do the same or nothing ever ends.
    struct Fanout(TurnHost);

    impl crate::agent::AgentEvents for Fanout {
        fn lines(&self, event: &str, session_id: &str, lines: Vec<String>) {
            self.0.on_agent_lines(event, session_id, lines);
        }
        fn exit(&self, session_id: &str, code: Option<i32>, _pid: u32) {
            self.0.on_agent_exit(session_id, code);
        }
    }

    fn world() -> World {
        let host = TurnHost::test_new();
        host.test_agents().set_events(Arc::new(Fanout(host.clone())));
        let dir = std::env::temp_dir().join(uuid::Uuid::new_v4().to_string());
        std::fs::create_dir_all(&dir).expect("dir");
        host.override_binary("opencode", fake_opencode(&dir));
        World { host, dir }
    }

    fn agent(world: &World, workspace_id: &str, name: &str) -> crate::session::Session {
        crate::session::create(
            world.host.test_store(),
            workspace_id.to_string(),
            "agent".into(),
            name.into(),
            "opencode".into(),
            "m".into(),
            "".into(),
            "full".into(),
        )
        .expect("agent")
    }

    fn workspace(world: &World) -> String {
        crate::workspace::create(
            world.host.test_store(),
            "w".into(),
            world.dir.to_string_lossy().into_owned(),
        )
        .expect("workspace")
        .id
    }

    /// Turns run on their own thread; wait for the agent to go quiet.
    fn settle(world: &World, session_id: &str) {
        for _ in 0..200 {
            let status = crate::session::get(world.host.test_store(), session_id.to_string())
                .ok()
                .flatten()
                .map(|row| row.status)
                .unwrap_or_default();
            if status != "working" && status != "needs-input" {
                std::thread::sleep(std::time::Duration::from_millis(30));
                let again = crate::session::get(world.host.test_store(), session_id.to_string())
                    .ok()
                    .flatten()
                    .map(|row| row.status)
                    .unwrap_or_default();
                if again != "working" && again != "needs-input" {
                    return;
                }
            }
            std::thread::sleep(std::time::Duration::from_millis(25));
        }
        panic!("{session_id} never settled");
    }

    fn turn(world: &World, session: &crate::session::Session, text: &str) {
        world
            .host
            .start(TurnStart {
                session_id: session.id.clone(),
                cwd: world.dir.to_string_lossy().into_owned(),
                text: text.into(),
                files: None,
                mentions: None,
                hidden: None,
                fresh: None,
                from_agent: None,
                nonce: None,
            })
            .expect("start");
        settle(world, &session.id);
    }

    fn blocks(world: &World, session_id: &str) -> Vec<crew_protocol::Block> {
        world.host.transcripts().get(session_id).blocks
    }

    #[test]
    fn a_letter_waiting_is_read_as_soon_as_the_turn_ends() {
        let world = world();
        let ws = workspace(&world);
        let coder = agent(&world, &ws, "Coder");
        let cuddles = agent(&world, &ws, "Cuddles");
        mailbox::enqueue(
            world.host.test_store(),
            &cuddles.id,
            &AgentRef { id: coder.id.clone(), name: "Coder".into() },
            "the branch is green",
        )
        .expect("enqueue");

        turn(&world, &cuddles, "hello");
        settle(&world, &cuddles.id);

        let rows = blocks(&world, &cuddles.id);
        let delivered = rows
            .iter()
            .find(|block| block.role == BlockRole::User && block.text == "the branch is green")
            .expect("the letter never arrived");
        assert_eq!(delivered.from_agent.as_ref().map(|from| from.name.as_str()), Some("Coder"));
        assert_eq!(
            mailbox::waiting_count(world.host.test_store(), &cuddles.id).expect("count"),
            0
        );
    }

    #[test]
    fn an_agent_carries_on_by_writing_to_itself() {
        let world = world();
        let ws = workspace(&world);
        let coder = agent(&world, &ws, "Coder");
        mailbox::enqueue(
            world.host.test_store(),
            &coder.id,
            &AgentRef { id: coder.id.clone(), name: "Coder".into() },
            "next: run the tests",
        )
        .expect("enqueue");

        turn(&world, &coder, "start");
        settle(&world, &coder.id);

        let rows = blocks(&world, &coder.id);
        assert!(
            rows.iter().any(|block| block.text == "next: run the tests"),
            "the agent did not pick its own note back up"
        );
    }

    #[test]
    fn a_runaway_loop_stops_itself() {
        let world = world();
        let ws = workspace(&world);
        let coder = agent(&world, &ws, "Coder");
        let me = AgentRef { id: coder.id.clone(), name: "Coder".into() };
        for _ in 0..(MAX_SELF_TURNS + 2) {
            mailbox::enqueue(world.host.test_store(), &coder.id, &me, "again").expect("enqueue");
        }

        turn(&world, &coder, "start");
        settle(&world, &coder.id);

        let rows = blocks(&world, &coder.id);
        let laps = rows.iter().filter(|block| block.text == "again").count() as u32;
        assert_eq!(laps, MAX_SELF_TURNS, "the loop ran {laps} times");
        assert!(
            rows.iter().any(|block| block.role == BlockRole::System
                && block.text.contains("writing to itself")),
            "the transcript does not say why it stopped"
        );
    }

    #[test]
    fn a_stopped_turn_leaves_the_box_alone() {
        let world = world();
        let ws = workspace(&world);
        let coder = agent(&world, &ws, "Coder");
        let cuddles = agent(&world, &ws, "Cuddles");
        mailbox::enqueue(
            world.host.test_store(),
            &cuddles.id,
            &AgentRef { id: coder.id.clone(), name: "Coder".into() },
            "later",
        )
        .expect("enqueue");

        // Slow enough that the stop lands mid-turn instead of after it.
        world
            .host
            .override_binary("opencode", fake_opencode_paused(&world.dir, 5.0));
        world
            .host
            .start(TurnStart {
                session_id: cuddles.id.clone(),
                cwd: world.dir.to_string_lossy().into_owned(),
                text: "hello".into(),
                files: None,
                mentions: None,
                hidden: None,
                fresh: None,
                from_agent: None,
                nonce: None,
            })
            .expect("start");
        std::thread::sleep(std::time::Duration::from_millis(300));
        world.host.stop(&cuddles.id).expect("stop");
        settle(&world, &cuddles.id);

        assert_eq!(
            mailbox::waiting_count(world.host.test_store(), &cuddles.id).expect("count"),
            1,
            "a stop should not hand the agent its next letter"
        );
    }

    /// The cap consumes the letter that trips it: it is claimed, refused, and
    /// never released. What the agent told itself to do next is gone.
    #[test]
    fn the_letter_the_cap_refuses_goes_back_in_the_box() {
        let world = world();
        let ws = workspace(&world);
        let coder = agent(&world, &ws, "Coder");
        let me = AgentRef { id: coder.id.clone(), name: "Coder".into() };
        for _ in 0..(MAX_SELF_TURNS + 1) {
            mailbox::enqueue(world.host.test_store(), &coder.id, &me, "again").expect("enqueue");
        }

        turn(&world, &coder, "start");
        settle(&world, &coder.id);

        assert_eq!(
            mailbox::waiting_count(world.host.test_store(), &coder.id).expect("count"),
            1,
            "the letter that tripped the cap was swallowed instead of left waiting"
        );
    }

    /// The transcript says "Send it a message to continue". Doing that does not
    /// reset the lap counter, because only a letter from someone *else* clears
    /// it, and a user turn is not a letter. The agent can never loop again.
    #[test]
    fn a_message_from_the_user_lets_the_agent_loop_again() {
        let world = world();
        let ws = workspace(&world);
        let coder = agent(&world, &ws, "Coder");
        let me = AgentRef { id: coder.id.clone(), name: "Coder".into() };
        for _ in 0..MAX_SELF_TURNS {
            mailbox::enqueue(world.host.test_store(), &coder.id, &me, "again").expect("enqueue");
        }
        turn(&world, &coder, "start");
        settle(&world, &coder.id);
        assert_eq!(
            blocks(&world, &coder.id).iter().filter(|b| b.text == "again").count() as u32,
            MAX_SELF_TURNS,
            "the loop did not run to the cap"
        );

        // The user does exactly what the app told them to do.
        mailbox::enqueue(world.host.test_store(), &coder.id, &me, "one more lap").expect("enqueue");
        turn(&world, &coder, "carry on");
        settle(&world, &coder.id);

        assert!(
            blocks(&world, &coder.id).iter().any(|b| b.text == "one more lap"),
            "after the user spoke the agent still cannot pick up its own note"
        );
    }
}
