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
    assistant_delta_text, build_cursor_prompt, build_cursor_spawn_args, parse_tool_call,
    session_id_from_event, tool_status as cursor_tool_status, turn_failed as cursor_turn_failed,
    turn_usage as cursor_turn_usage, CursorSpawn, ToolPhase,
};
use crate::providers::opencode::{
    opencode_config, step_failure as opencode_step_failure,
    add_step_usage, build_opencode_prompt, build_opencode_spawn_args,
    parse_tool_call as parse_opencode_tool_call, session_id_from_event as opencode_session_id,
    stream_error_message as opencode_error_message, text_part, turn_ended, OpencodeSpawn, OpencodeText,
};
use crate::providers::{string_field, Autonomy};
use crate::mailbox;
use crate::session;
use crate::working_set;
use crate::store::Store;
use crate::transcript::TranscriptHub;

const INIT_TIMEOUT: Duration = Duration::from_secs(15);
/// How long a provider may stay silent before its first line.
const FIRST_OUTPUT_TIMEOUT: Duration = Duration::from_secs(120);
const INTERRUPT_GRACE: Duration = Duration::from_millis(1500);
/// A self-addressed letter is how an agent keeps working. This many laps in a
/// row without anyone else speaking is a runaway, not a plan.
const MAX_SELF_TURNS: u32 = 25;
const STDERR_TAIL: usize = 12;
/// The Crew tools an agent is handed, spelled the way its own harness will
/// accept them.
///
/// The names matter more than they look. An agent told about `message_agent`
/// goes looking for `message_agent`, and what it finds is whatever else it has
/// of that shape — with Claude Code that is its own cross-session SendMessage,
/// which writes to another machine entirely. Measured, not guessed: it happened
/// in `scripts/drive.mjs` and the letter left the building.
fn tools_hint(lead: &str, spell: &dyn Fn(&str) -> String) -> String {
    format!(
        "{lead}\n\
         - {} — the other agents here, each with the id it is addressed by.\n\
         - {} — write to one of them, by id. It arrives as a turn with your name and id on \
         it, and it is read in its own time. You are not waiting here, and anything it sends \
         back reaches you as a message of its own.\n\
         - {} — leave yourself the next step. It arrives as a new turn the moment this one \
         ends, with the tail of this conversation, so it is how you carry on past work that \
         does not fit in one turn.\n\
         - {} — look up what was already said in this conversation. It does not reach anybody \
         else's; what another agent knows, you ask it for.\n\
         - {} and {} — the rest of what Crew offers, searched and then called: {}. One of your \
         own tools whose name sounds like one of those is not Crew's and does not reach this \
         workspace.\n\n\
         A turn that opens with `## Message` was written by another agent, not by the user. \
         What you write in the chat is read by the user and does not reach that agent; {} to \
         the id on that line is what does.",
        spell("list_agents"),
        spell("message_agent"),
        spell("continue_after_turn"),
        spell("search_messages"),
        spell("find_tool"),
        spell("call_tool"),
        crate::tools::hidden_names().join(", "),
        spell("message_agent"),
    )
}

/// Claude and Codex namespace an MCP server's tools under its name.
fn mcp_tools_hint() -> String {
    tools_hint("Crew gives you tools through its crew MCP server, under these names.", &|tool| {
        format!("`mcp__crew__{tool}`")
    })
}

/// opencode flattens them onto the server name instead.
fn opencode_tools_hint() -> String {
    tools_hint("Crew gives you tools through its crew MCP server, under these names.", &|tool| {
        format!("`crew_{tool}`")
    })
}

/// Cursor has no MCP, so it reaches the same bridge through the shell.
fn shell_tools_hint(exe: &str) -> String {
    tools_hint(
        "Crew's tools are not in your tool list; you reach them by running them in the shell, \
         and `<json>` is the arguments object.",
        &|tool| format!("`{exe} call {tool} '<json>'`"),
    )
}

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
}

struct StreamLive {
    cancelled: bool,
    active: bool,
    turn_tx: Option<oneshot::Sender<TurnOutcome>>,
    emitted_assistant: String,
    seen_tools: HashSet<String>,
    stderr: Vec<String>,
    saw_text: bool,
    /// Any line at all, of any shape. A provider that answers nothing is hung.
    saw_output: bool,
    settled: bool,
    /// opencode's text parts are snapshots, each carrying its whole text. One
    /// slot per part, because two that grow in turn would otherwise forget each
    /// other and re-emit what the transcript already has.
    text_parts: HashMap<String, String>,
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

    pub fn start(&self, mut params: TurnStart) -> Result<TurnStarted, String> {
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
        // A turn nobody else asked for is you: that clears the lap budget, so
        // the message the transcript tells you to send actually frees the loop.
        if params.from_agent.is_none() {
            self.loops
                .lock()
                .unwrap_or_else(|error| error.into_inner())
                .remove(&params.session_id);
        }
        // Read before the new message is appended: the tail is what the agent
        // is reminded of, and this turn is not history yet.
        let history = working_set::history(
            &self
                .transcripts
                .window(&params.session_id, Some(working_set::TAIL_BLOCKS), None)
                .blocks,
        );
        let hidden = params.hidden.unwrap_or(false);
        match params.from_agent.clone() {
            Some(from) => {
                // The transcript keeps the letter as it was written: the
                // envelope is for the model, and the sender's name is already
                // on the block for the reader.
                self.transcripts
                    .append_from_agent(&params.session_id, &params.text, from.clone());
                params.text = mailbox::envelope(
                    &from,
                    &params.text,
                    params.sent_at.unwrap_or_else(crate::store::now_millis),
                    from.id == params.session_id,
                );
            }
            None => self
                .transcripts
                .append_user(&params.session_id, &params.text, hidden, params.files.clone()),
        }
        self.transcripts.set_working(&params.session_id, true);
        self.transcripts.set_status(&params.session_id, "working", session.provider_session_id.as_deref());
        let host = self.clone();
        thread::spawn(move || {
            host.run_turn(session, params, history);
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
                    // A turn started since is not this stop's to kill.
                    if host.stop_requested(&session_id) {
                        host.agents.kill(&session_id);
                        host.detach(&session_id);
                    }
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

    /// A turn that fails before its CLI is done leaves nothing behind: no
    /// process, and no live turn for the next one to be refused by.
    fn abandon(&self, session_id: &str, error: String) -> TurnOutcome {
        self.agents.kill(session_id);
        self.detach(session_id);
        TurnOutcome::Failed(error)
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
            // Minted for this session, here, every turn. It is what says who is
            // calling: the id no longer travels on the wire, so a shell that
            // inherited this cannot speak as another agent.
            ("CREW_TOKEN".into(), self.bridge.mint(session_id)),
        ])
    }

    fn mcp(&self) -> Option<(String, Vec<String>)> {
        let info = self.bridge.info().ok()?;
        Some((info.exe, vec!["--mcp".into()]))
    }

    fn run_turn(&self, session: crate::session::Session, params: TurnStart, history: Option<String>) {
        let session_id = session.id.clone();
        let workspace_id = session.workspace_id.clone();
        let outcome = match session.provider.as_str() {
            "claude" => self.run_claude(session, params, history),
            "codex" => self.run_codex(session, params, history),
            "cursor" => self.run_cursor(session, params, history),
            "opencode" => self.run_opencode(session, params, history),
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
    ///
    /// The one place a letter is claimed, so two callers racing cannot lose one
    /// between them: the loser finds an empty box, which is the truth.
    pub fn drain_mailbox(&self, session_id: &str, workspace_id: &str) -> bool {
        let Ok(Some(letter)) = mailbox::claim(&self.store, session_id) else {
            return false;
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
            // The note stays in the box: it is what the agent told itself to do
            // next, and the cap is a pause, not a decision to drop the work.
            let _ = mailbox::release(&self.store, &letter.id);
            self.transcripts.append_system(
                session_id,
                &format!("Stopped after {MAX_SELF_TURNS} turns writing to itself. Send it a message to continue."),
            );
            self.transcripts.flush(session_id);
            return false;
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
            from_agent: Some(letter.from.clone()),
            sent_at: Some(letter.at),
            nonce: None,
        });
        if started.is_err() {
            // Something else took the agent between the turn ending and this
            // line. The letter goes back at the head of the queue, and that
            // turn's own ending will come back for it.
            let _ = mailbox::release(&self.store, &letter.id);
            return false;
        }
        true
    }

    /// Drain an agent's box by id, for a caller that has only that. Used when a
    /// letter has just been dropped in.
    pub fn deliver_to(&self, target: &crate::session::Session) -> bool {
        self.drain_mailbox(&target.id, &target.workspace_id)
    }

    /// Letters left waiting for an idle agent — a delivery that raced a turn
    /// ending, or a daemon that stopped between the two — are invisible: only
    /// the end of a turn looks in a box. This is the sweep at startup.
    pub fn deliver_waiting(&self) {
        let Ok(sessions) = crate::session::list_all(&self.store) else {
            return;
        };
        for session in sessions {
            if session.kind != "agent" || session.status == "working" || session.status == "needs-input" {
                continue;
            }
            if mailbox::waiting_count(&self.store, &session.id).unwrap_or(0) > 0 {
                self.deliver_to(&session);
            }
        }
    }

    fn run_claude(
        &self,
        session: crate::session::Session,
        params: TurnStart,
        history: Option<String>,
    ) -> TurnOutcome {
        let session_id = session.id.clone();
        if self.stop_requested(&session_id) {
            return TurnOutcome::Stopped;
        }
        if let Err(error) = self.ensure_claude(&session, &params) {
            // A CLI that never came up, or never answered, is not left running.
            let failed = self.abandon(&session_id, error);
            return if self.stop_requested(&session_id) {
                TurnOutcome::Stopped
            } else {
                failed
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
            let (tx, rx) = oneshot::channel();
            live.turn_tx = Some(tx);
            (rx, live.claude_session_id.clone())
        };
        let images = crate::files::load_inline_images(params.files.as_deref().unwrap_or(&[]));
        let inline: HashSet<String> = images.iter().map(|image| image.path.clone()).collect();
        let files = path_list(&params, &inline);
        let message = build_claude_user_message(
            &claude_session_id,
            history.as_deref(),
            params.text.trim(),
            &files,
            &images,
        );
        if let Err(error) = self
            .agents
            .write(&session_id, &serde_json::to_string(&message).unwrap_or_default())
        {
            return self.abandon(&session_id, error);
        }
        let outcome = self
            .block_on(turn_rx)
            .unwrap_or(TurnOutcome::Failed("Turn channel closed".into()));
        // The agent is disposable: the turn is over, so the CLI goes. What it
        // knew is in the transcript, and the next turn is handed the tail.
        self.agents.kill(&session_id);
        self.detach(&session_id);
        outcome
    }

    /// A turn gets its own Claude session, every time. What the agent remembers
    /// is the tail Crew hands it, not whatever the CLI kept.
    fn ensure_claude(&self, session: &crate::session::Session, params: &TurnStart) -> Result<(), String> {
        let session_id = session.id.clone();
        let autonomy = if session.autonomy == "full" {
            Autonomy::Full
        } else {
            Autonomy::Ask
        };
        if self.lock().contains_key(&session_id) {
            self.agents.kill(&session_id);
            self.detach(&session_id);
        }
        let claude_session_id = uuid::Uuid::new_v4().to_string();

        let live = ClaudeLive {
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
        };
        self.lock().insert(session_id.clone(), Live::Claude(Box::new(live)));
        if self.stop_requested(&session_id) {
            self.agents.kill(&session_id);
            return Err("cancelled".into());
        }

        let path = self.resolve_bin("claude").or_else(|_| self.resolve_bin("claude"))?;
        let mcp = self.mcp();
        let hint = mcp.as_ref().map(|_| mcp_tools_hint());
        let persona = claude_persona(&session.name, &session.description, hint.as_deref());
        let spawn = ClaudeSpawn {
            model: Some(session.model.clone()).filter(|m| !m.is_empty()),
            session_id: Some(claude_session_id.clone()),
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

    fn run_codex(
        &self,
        session: crate::session::Session,
        params: TurnStart,
        history: Option<String>,
    ) -> TurnOutcome {
        let session_id = session.id.clone();
        self.agents.kill(&session_id);
        let (turn_rx, _) = match self.install_stream(&session_id, params.cwd.clone(), Live::Codex) {
            Ok(pair) => pair,
            Err(error) => return TurnOutcome::Failed(error),
        };
        // A stop that came before there was a turn to cancel only left its mark.
        if self.stop_requested(&session_id) {
            self.detach(&session_id);
            return TurnOutcome::Stopped;
        }
        let path = match self.resolve_bin("codex") {
            Ok(path) => path,
            Err(error) => return self.abandon(&session_id, error),
        };
        let mcp = self.mcp();
        let hint = mcp.as_ref().map(|_| mcp_tools_hint());
        // Minted once and used twice: the agent's own shell gets it, and so
        // does the MCP server codex starts for it. A second mint would retire
        // the first.
        let env = self.agent_env(&session_id);
        let prompt = build_codex_prompt(
            &session.name,
            &session.description,
            history.as_deref(),
            &params.text,
            &path_list(&params, &HashSet::new()),
            hint.as_deref(),
        );
        if let Err(error) = self.agents.spawn(
            session_id.clone(),
            path,
            build_codex_spawn_args(&CodexSpawn {
                prompt,
                model: Some(session.model.clone()).filter(|m| !m.is_empty()),
                cwd: Some(params.cwd.clone()),
                autonomy: if session.autonomy == "full" {
                    Autonomy::Full
                } else {
                    Autonomy::Ask
                },
                mcp,
                mcp_env: env.clone().into_iter().collect(),
            }),
            params.cwd,
            Some(env),
        ) {
            return self.abandon(&session_id, error);
        }
        self.agents.close_stdin(&session_id);
        self.transcripts
            .apply(&session_id, HarnessEvent::SessionStarted {});
        let outcome = self
            .block_on(turn_rx)
            .unwrap_or(TurnOutcome::Failed("Turn channel closed".into()));
        self.agents.kill(&session_id);
        self.detach(&session_id);
        outcome
    }

    fn run_cursor(
        &self,
        session: crate::session::Session,
        params: TurnStart,
        history: Option<String>,
    ) -> TurnOutcome {
        let session_id = session.id.clone();
        let (turn_rx, _) = match self.install_stream(&session_id, params.cwd.clone(), Live::Cursor) {
            Ok(pair) => pair,
            Err(error) => return TurnOutcome::Failed(error),
        };
        // A stop that came before there was a turn to cancel only left its mark.
        if self.stop_requested(&session_id) {
            self.detach(&session_id);
            return TurnOutcome::Stopped;
        }
        let path = match self.resolve_bin("cursor-agent") {
            Ok(path) => path,
            Err(error) => return self.abandon(&session_id, error),
        };
        let mcp = self.mcp();
        // Cursor takes no MCP config, so the bridge is a command it runs.
        let hint = mcp.as_ref().map(|(exe, _)| shell_tools_hint(exe));
        let prompt = build_cursor_prompt(
            &session.name,
            &session.description,
            history.as_deref(),
            &params.text,
            &path_list(&params, &HashSet::new()),
            hint.as_deref(),
        );
        if let Err(error) = self.agents.spawn(
            session_id.clone(),
            path,
            build_cursor_spawn_args(&CursorSpawn {
                prompt,
                model: Some(session.model.clone()).filter(|m| !m.is_empty()),
                autonomy: if session.autonomy == "full" {
                    Autonomy::Full
                } else {
                    Autonomy::Ask
                },
            }),
            params.cwd,
            Some(self.agent_env(&session_id)),
        ) {
            return self.abandon(&session_id, error);
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

    fn run_opencode(
        &self,
        session: crate::session::Session,
        params: TurnStart,
        history: Option<String>,
    ) -> TurnOutcome {
        let session_id = session.id.clone();
        let mcp = self.mcp();
        let (turn_rx, _) = match self.install_stream(&session_id, params.cwd.clone(), Live::Opencode) {
            Ok(pair) => pair,
            Err(error) => return TurnOutcome::Failed(error),
        };
        // A stop that came before there was a turn to cancel only left its mark.
        if self.stop_requested(&session_id) {
            self.detach(&session_id);
            return TurnOutcome::Stopped;
        }
        let path = match self.resolve_bin("opencode") {
            Ok(path) => path,
            Err(error) => return self.abandon(&session_id, error),
        };
        let hint = mcp.as_ref().map(|_| opencode_tools_hint());
        let prompt = build_opencode_prompt(
            &session.name,
            &session.description,
            history.as_deref(),
            &params.text,
            &path_list(&params, &HashSet::new()),
            hint.as_deref(),
        );
        // opencode has no approval channel: without --auto it falls back to the
        // user's own permission config, which Crew cannot answer for. Saying so
        // once beats an "ask" that silently never asks.
        if history.is_none() && session.autonomy != "full" {
            self.transcripts.append_system(
                &session_id,
                "opencode decides its own permissions: it has no way to ask Crew, so it runs under your opencode config.",
            );
        }
        let mut env = self.agent_env(&session_id);
        if let Some(config) = opencode_config(mcp.as_ref()) {
            env.insert("OPENCODE_CONFIG_CONTENT".into(), config);
        }
        if let Err(error) = self.agents.spawn(
            session_id.clone(),
            path,
            build_opencode_spawn_args(&OpencodeSpawn {
                model: Some(session.model.clone()).filter(|m| !m.is_empty()),
                autonomy: if session.autonomy == "full" {
                    Autonomy::Full
                } else {
                    Autonomy::Ask
                },
            }),
            params.cwd,
            Some(env),
        ) {
            return self.abandon(&session_id, error);
        }
        if let Err(error) = self.agents.write(&session_id, &prompt) {
            return self.abandon(&session_id, error);
        }
        self.agents.close_stdin(&session_id);
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
            saw_output: false,
            settled: false,
            text_parts: HashMap::new(),
            usage: None,
        };
        self.lock().insert(session_id.to_string(), wrap(live));
        self.watch_for_silence(session_id);
        Ok((rx, ()))
    }

    /// A provider that has not said one word is not working, it is stuck: no
    /// output and no exit. Once anything arrives the turn is its own business —
    /// a long tool call is silent too, and killing that would be worse than
    /// waiting.
    fn watch_for_silence(&self, session_id: &str) {
        let host = self.clone();
        let id = session_id.to_string();
        self.after(FIRST_OUTPUT_TIMEOUT, move || {
            let silent = {
                let map = host.lock();
                match map.get(&id) {
                    Some(Live::Codex(live)) | Some(Live::Cursor(live)) | Some(Live::Opencode(live)) => {
                        live.active && !live.saw_output && !live.cancelled
                    }
                    _ => false,
                }
            };
            if silent {
                host.signal(
                    &id,
                    TurnOutcome::Failed(format!(
                        "No answer in {}s. The CLI started and said nothing.",
                        FIRST_OUTPUT_TIMEOUT.as_secs()
                    )),
                );
            }
        });
    }

    fn handle_line(&self, session_id: &str, line: &str) {
        {
            let mut map = self.lock();
            if let Some(
                Live::Codex(live) | Live::Cursor(live) | Live::Opencode(live),
            ) = map.get_mut(session_id)
            {
                live.saw_output = true;
            }
        }
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

    /// Whether the Claude turn behind a control request is over: stopped, or
    /// gone altogether.
    fn claude_stopped(&self, session_id: &str) -> bool {
        match self.lock().get(session_id) {
            Some(Live::Claude(live)) => live.cancelled || live.mute,
            _ => true,
        }
    }

    /// The agent is working again once the user has answered, unless the turn
    /// ended while they were being asked: a stop refuses what was pending, and
    /// that refusal must not undo the stop.
    fn claude_resumed(&self, session_id: &str) {
        if !self.claude_stopped(session_id) {
            self.transcripts.set_status(session_id, "working", None);
        }
    }

    fn claude_control_wait(&self, session_id: String, control: ClaudeControlRequest) {
        let questions = parse_questions(&control.input);
        let tool_name = control.tool_name.clone().unwrap_or_else(|| "tool".into());
        if self.claude_stopped(&session_id) {
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
                    self.claude_resumed(&session_id);
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
                    self.claude_resumed(&session_id);
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
        self.claude_resumed(&session_id);
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
            // The steps before it were paid for; a failure is not a reason to
            // forget what the turn cost.
            let usage = {
                let map = self.lock();
                match map.get(session_id) {
                    Some(Live::Opencode(live)) => live.usage.clone(),
                    _ => None,
                }
            };
            if usage.is_some() {
                self.transcripts
                    .apply(session_id, HarnessEvent::TurnCompleted { usage });
            }
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
        // A step can stop for a reason that is not success — out of room, cut
        // off by the provider — and a turn that died mid-answer must not paint
        // green just because nothing else follows it.
        if let Some(reason) = opencode_step_failure(&rec) {
            self.signal(session_id, TurnOutcome::Failed(reason));
            return;
        }
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
            let emitted = live.text_parts.entry(part.id.clone()).or_default();
            let extra = part
                .text
                .strip_prefix(emitted.as_str())
                .unwrap_or(&part.text)
                .to_string();
            *emitted = part.text.clone();
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
mod tests {
    use super::*;
    use crate::test_support::{eventually, fake_cli, temp_dir, WITHIN};
    use crew_protocol::{AgentRef, AttachedFile, AttachedFileKind, Block, BlockRole, ToolDetail};
    use std::path::{Path, PathBuf};

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

    /// Same fake, but it keeps what the provider was handed: the prompt is the
    /// only place the envelope shows up, since the transcript holds the letter
    /// as it was written.
    fn fake_opencode_recording(dir: &std::path::Path, seen: &std::path::Path) -> String {
        let path = dir.join(format!("fake-opencode-rec-{}", uuid::Uuid::new_v4().simple()));
        std::fs::write(
            &path,
            format!(
                r#"#!/usr/bin/env python3
import json, sys
open({seen:?}, "w").write(sys.stdin.read())
sid = "ses_test"
print(json.dumps({{"type":"text","sessionID":sid,"part":{{"id":"p1","type":"text","text":"ok"}}}}), flush=True)
print(json.dumps({{"type":"step_finish","sessionID":sid,"part":{{"id":"s1","type":"step-finish","reason":"stop","tokens":{{"input":1,"output":1,"reasoning":0,"cache":{{"read":0,"write":0}}}},"cost":0}}}}), flush=True)
"#,
                seen = seen.to_string_lossy()
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
                from_agent: None,
                sent_at: None,
                nonce: None,
            })
            .expect("start");
        settle(world, &session.id);
    }

    fn blocks(world: &World, session_id: &str) -> Vec<crew_protocol::Block> {
        world.host.transcripts().window(session_id, Some(500), None).blocks
    }

    /// A provider that starts and says nothing must not leave the agent
    /// "working" forever.
    #[test]
    fn a_provider_that_says_nothing_does_not_hang_the_agent() {
        let world = world();
        let ws = workspace(&world);
        let coder = agent(&world, &ws, "Coder");
        let path = world.dir.join("mute-opencode");
        std::fs::write(&path, "#!/usr/bin/env python3\nimport sys, time\nsys.stdin.read()\ntime.sleep(600)\n")
            .expect("write");
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o755)).expect("chmod");
        world
            .host
            .override_binary("opencode", path.to_string_lossy().into_owned());

        world
            .host
            .start(TurnStart {
                session_id: coder.id.clone(),
                cwd: world.dir.to_string_lossy().into_owned(),
                text: "hello".into(),
                files: None,
                mentions: None,
                hidden: None,
                from_agent: None,
                sent_at: None,
                nonce: None,
            })
            .expect("start");
        // The watchdog's own timeout is two minutes; this asserts it is armed,
        // not that the test waits for it.
        std::thread::sleep(std::time::Duration::from_millis(200));
        let silent_and_watched = {
            let map = world.host.lock();
            matches!(map.get(&coder.id), Some(Live::Opencode(live)) if live.active && !live.saw_output)
        };
        world.host.stop(&coder.id).expect("stop");
        settle(&world, &coder.id);
        assert!(silent_and_watched, "a provider with no output was not being watched");
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

    /// The turn is the whole prompt: every turn is a new provider session, so
    /// nothing an agent knows survives except what Crew hands it back.
    #[test]
    fn a_second_turn_is_handed_the_first_one() {
        let world = world();
        let seen = world.dir.join("prompt.txt");
        world
            .host
            .override_binary("opencode", fake_opencode_recording(&world.dir, &seen));
        let ws = workspace(&world);
        let coder = agent(&world, &ws, "Coder");

        turn(&world, &coder, "el parser se cae con tabs");
        let first = std::fs::read_to_string(&seen).expect("the provider was never spawned");
        assert!(!first.contains("## The conversation so far"), "{first}");

        turn(&world, &coder, "y ahora?");
        let second = std::fs::read_to_string(&seen).expect("the provider was never spawned");
        assert!(second.starts_with("You are Coder."), "the persona is on every turn: {second}");
        assert!(second.contains("· user] el parser se cae con tabs"), "{second}");
        assert!(second.contains("· you] ok"), "the reply is in the tail too: {second}");
        assert!(second.trim_end().ends_with("y ahora?"), "{second}");
        assert!(
            second.find("· user] el parser").unwrap() < second.find("## This turn").unwrap(),
            "{second}"
        );
    }

    /// Without this the model gets a turn shaped exactly like something the
    /// user typed, and answers in its own chat where the sender never reads it.
    #[test]
    fn a_letter_reaches_the_model_with_the_sender_on_it() {
        let world = world();
        let seen = world.dir.join("prompt.txt");
        world
            .host
            .override_binary("opencode", fake_opencode_recording(&world.dir, &seen));
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

        world.host.deliver_to(&cuddles);
        settle(&world, &cuddles.id);

        let prompt = std::fs::read_to_string(&seen).expect("the provider was never spawned");
        // The id, so the reader has an address and not only a label, and the
        // time it was written rather than the time it was handed over.
        assert!(
            prompt.contains(&format!(
                "## Message\nFrom: Coder (agent {})\nAt: ",
                coder.id
            )),
            "{prompt}"
        );
        assert!(prompt.contains("\n\nthe branch is green"), "{prompt}");
        // And the reader sees the letter, not the envelope.
        let rows = blocks(&world, &cuddles.id);
        assert!(
            rows.iter().any(|block| block.role == BlockRole::User
                && block.text == "the branch is green"
                && block.from_agent.is_some()),
            "the transcript should hold the letter as written: {rows:?}"
        );
    }

    #[test]
    fn a_note_an_agent_left_itself_is_not_the_user_either() {
        let world = world();
        let seen = world.dir.join("prompt.txt");
        world
            .host
            .override_binary("opencode", fake_opencode_recording(&world.dir, &seen));
        let ws = workspace(&world);
        let coder = agent(&world, &ws, "Coder");
        mailbox::enqueue(
            world.host.test_store(),
            &coder.id,
            &AgentRef { id: coder.id.clone(), name: "Coder".into() },
            "next: run the tests",
        )
        .expect("enqueue");

        world.host.deliver_to(&coder);
        settle(&world, &coder.id);

        let prompt = std::fs::read_to_string(&seen).expect("the provider was never spawned");
        assert!(prompt.contains("From: yourself, to continue"), "{prompt}");
        assert!(prompt.contains("\n\nnext: run the tests"), "{prompt}");
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
    fn a_letter_from_another_agent_gives_the_loop_a_fresh_budget() {
        let world = world();
        let ws = workspace(&world);
        let coder = agent(&world, &ws, "Coder");
        let me = AgentRef { id: coder.id.clone(), name: "Coder".into() };
        let lead = AgentRef { id: agent(&world, &ws, "Lead").id, name: "Lead".into() };
        for _ in 0..5 {
            mailbox::enqueue(world.host.test_store(), &coder.id, &me, "before").expect("enqueue");
        }
        mailbox::enqueue(world.host.test_store(), &coder.id, &lead, "keep going").expect("enqueue");
        for _ in 0..MAX_SELF_TURNS {
            mailbox::enqueue(world.host.test_store(), &coder.id, &me, "after").expect("enqueue");
        }

        turn(&world, &coder, "start");
        settle(&world, &coder.id);

        let rows = blocks(&world, &coder.id);
        let laps = rows.iter().filter(|block| block.text == "after").count() as u32;
        assert_eq!(laps, MAX_SELF_TURNS, "the loop ran {laps} times after the letter");
        assert!(
            !rows.iter().any(|block| block.text.starts_with("Stopped after")),
            "the letter from Lead did not reset the budget"
        );
        assert_eq!(mailbox::waiting_count(world.host.test_store(), &coder.id).expect("count"), 0);
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
                from_agent: None,
                sent_at: None,
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

    /// Every provider spells a Crew tool differently, and an agent that cannot
    /// spell it goes looking for something else of that shape. Claude Code has
    /// its own cross-session SendMessage, and in `scripts/drive.mjs` an agent
    /// told about "message_agent" found that one and wrote to another machine.
    #[test]
    fn a_tool_sheet_names_the_tools_the_way_the_provider_takes_them() {
        let mcp = mcp_tools_hint();
        assert!(mcp.contains("`mcp__crew__message_agent`"), "{mcp}");
        let opencode = opencode_tools_hint();
        assert!(opencode.contains("`crew_message_agent`"), "{opencode}");
        let shell = shell_tools_hint("/usr/local/bin/crew");
        assert!(shell.contains("`/usr/local/bin/crew call message_agent '<json>'`"), "{shell}");

        // The bare name never appears on its own: that is the one an agent
        // cannot call, and the one it will go looking for elsewhere.
        for sheet in [&mcp, &opencode, &shell] {
            for tool in [
                "list_agents",
                "message_agent",
                "continue_after_turn",
                "search_messages",
                "find_tool",
                "call_tool",
            ] {
                assert!(
                    !sheet.contains(&format!("`{tool}`")),
                    "the sheet offers a bare {tool}: {sheet}"
                );
            }
        }
    }

    /// Whatever the spelling, every tool `tools/list` answers with is on it.
    #[test]
    fn a_tool_sheet_covers_the_whole_standing_set() {
        for sheet in [mcp_tools_hint(), opencode_tools_hint(), shell_tools_hint("crew")] {
            for tool in crate::tools::standing() {
                assert!(sheet.contains(tool.name), "{} is not on the sheet: {sheet}", tool.name);
            }
        }
    }

    /// And the ones behind the gateway are named too, by name alone.
    ///
    /// Measured, not guessed: asked to create an agent, a codex agent did not
    /// find `create_agent` in `tools/list` — it is behind `find_tool` — saw its
    /// own `spawn_agent`, which sounds exactly like the job, and used that. Then
    /// it drove the app's window. "Everything else Crew offers" gave it no
    /// reason to look.
    #[test]
    fn a_tool_sheet_names_what_is_behind_the_gateway() {
        for sheet in [mcp_tools_hint(), opencode_tools_hint(), shell_tools_hint("crew")] {
            for name in crate::tools::hidden_names() {
                assert!(sheet.contains(name), "{name} is not on the sheet: {sheet}");
            }
        }
    }

    // The turn runner end to end: every provider driven by a scripted CLI, the
    // Claude control channel, stops, the silence watchdog, and the line
    // handlers fed straight from the recorded protocols.

    const CLAUDE_FIXTURE: &str =
        include_str!(concat!(env!("CARGO_MANIFEST_DIR"), "/tests/fixtures/protocols/claude-permissions.jsonl"));
    const CODEX_FIXTURE: &str =
        include_str!(concat!(env!("CARGO_MANIFEST_DIR"), "/tests/fixtures/protocols/codex.jsonl"));
    const CURSOR_FIXTURE: &str =
        include_str!(concat!(env!("CARGO_MANIFEST_DIR"), "/tests/fixtures/protocols/cursor.jsonl"));
    const OPENCODE_FIXTURE: &str =
        include_str!(concat!(env!("CARGO_MANIFEST_DIR"), "/tests/fixtures/protocols/opencode.jsonl"));
    const OPENCODE_STREAMING_FIXTURE: &str =
        include_str!(concat!(env!("CARGO_MANIFEST_DIR"), "/tests/fixtures/protocols/opencode-streaming.jsonl"));

    /// The id Claude's permission request carries in capture 1 of the recording.
    const RECORDED_QUESTION: &str = "c90920ba-8515-4a29-b2a2-68dd76240810";

    /// Lines `from..=to` of a recording, numbered as an editor shows them,
    /// without the `>>> ` a capture marks the CLI's own output with.
    fn recorded(fixture: &str, from: usize, to: usize) -> Vec<String> {
        fixture
            .lines()
            .skip(from - 1)
            .take(to + 1 - from)
            .map(|line| line.strip_prefix(">>> ").unwrap_or(line).to_string())
            .collect()
    }

    /// Events as short labels, so a test states their order without restating
    /// every payload.
    fn labels(events: &[HarnessEvent]) -> Vec<String> {
        events
            .iter()
            .map(|event| match event {
                HarnessEvent::SessionStarted {} => "started".to_string(),
                HarnessEvent::SessionEnded { code } => format!("ended {code:?}"),
                HarnessEvent::SessionError { message } => format!("error: {message}"),
                HarnessEvent::SessionNote { message } => format!("note: {message}"),
                HarnessEvent::UserMessage { text, .. } => format!("user: {text}"),
                HarnessEvent::SystemMessage { text } => format!("system: {text}"),
                HarnessEvent::SessionProviderBound { provider_session_id } => format!("bound {provider_session_id}"),
                HarnessEvent::MessageDelta { text } => format!("delta: {text}"),
                HarnessEvent::MessageCompleted {} => "message done".to_string(),
                HarnessEvent::ReasoningDelta { text } => format!("thinking: {text}"),
                HarnessEvent::TurnCompleted { usage } => format!(
                    "turn done {:?}",
                    usage.as_ref().map(|usage| (usage.input_tokens, usage.output_tokens))
                ),
                HarnessEvent::ToolStarted { call_id, name, title, .. } => format!("tool {call_id} {name}: {title}"),
                HarnessEvent::ToolUpdated { call_id, title, status, .. } => match status {
                    Some(status) => format!("tool {call_id} {status:?}"),
                    None => format!("tool {call_id} = {}", title.as_deref().unwrap_or("")),
                },
                HarnessEvent::ApprovalRequested { request_id, name, .. } => format!("approval {request_id} {name}"),
                HarnessEvent::ApprovalResolved { request_id, decision } => {
                    format!("approved {request_id} {decision:?}")
                }
                HarnessEvent::QuestionRequested { request_id, questions } => {
                    format!("question {request_id} x{}", questions.len())
                }
                HarnessEvent::QuestionResolved { request_id, answers } => {
                    format!("answered {request_id} {}", answers.is_some())
                }
            })
            .collect()
    }

    /// What the provider said, in order: the labels without the session
    /// binds a line may repeat, and without the start, which a CLI that talks
    /// at once can race.
    fn said(events: &[HarnessEvent]) -> Vec<String> {
        labels(events)
            .into_iter()
            .filter(|label| !label.starts_with("bound ") && label != "started")
            .collect()
    }

    fn statuses(events: &[HarnessEvent]) -> Vec<ToolStatus> {
        events
            .iter()
            .filter_map(|event| match event {
                HarnessEvent::ToolUpdated { status: Some(status), .. } => Some(status.clone()),
                _ => None,
            })
            .collect()
    }

    fn texts(blocks: &[Block]) -> Vec<(BlockRole, &str)> {
        blocks.iter().map(|block| (block.role.clone(), block.text.as_str())).collect()
    }

    fn claude_live<T>(host: &TurnHost, id: &str, f: impl FnOnce(&mut ClaudeLive) -> T) -> T {
        match host.lock().get_mut(id) {
            Some(Live::Claude(live)) => f(live),
            _ => panic!("{id} has no Claude turn"),
        }
    }

    fn stream_live<T>(host: &TurnHost, id: &str, f: impl FnOnce(&mut StreamLive) -> T) -> T {
        match host.lock().get_mut(id) {
            Some(Live::Codex(live) | Live::Cursor(live) | Live::Opencode(live)) => f(live),
            _ => panic!("{id} has no streamed turn"),
        }
    }

    /// A turn in flight for `provider`, and the channel its runner waits on.
    fn arm(host: &TurnHost, id: &str, provider: &str) -> oneshot::Receiver<TurnOutcome> {
        let wrap: fn(StreamLive) -> Live = match provider {
            "claude" => {
                host.test_install_claude(id);
                let (tx, rx) = oneshot::channel();
                claude_live(host, id, |live| live.turn_tx = Some(tx));
                return rx;
            }
            "codex" => Live::Codex,
            "cursor" => Live::Cursor,
            "opencode" => Live::Opencode,
            other => panic!("no provider {other}"),
        };
        host.install_stream(id, String::new(), wrap).expect("install").0
    }

    fn feed(host: &TurnHost, id: &str, lines: &[String]) {
        host.on_agent_lines("agent-stdout", id, lines.to_vec());
    }

    fn outcome(rx: &mut oneshot::Receiver<TurnOutcome>) -> Option<TurnOutcome> {
        rx.try_recv().ok()
    }

    fn failed_with(outcome: Option<TurnOutcome>, want: &str) -> bool {
        matches!(outcome, Some(TurnOutcome::Failed(message)) if message == want)
    }

    /// A host wired the way the daemon wires it, agent output fed back into
    /// the turn and transcript events recorded, over a workspace of its own.
    struct Rig {
        host: TurnHost,
        seen: Arc<Applied>,
        dir: tempfile::TempDir,
        workspace: String,
    }

    fn rig() -> Rig {
        let host = TurnHost::test_new();
        host.test_agents().set_events(Arc::new(Fanout(host.clone())));
        let seen = host.test_capture();
        let dir = temp_dir();
        let workspace =
            crate::workspace::create(host.test_store(), "w".into(), dir.path().to_string_lossy().into_owned())
                .expect("workspace")
                .id;
        Rig { host, seen, dir, workspace }
    }

    impl Rig {
        fn cwd(&self) -> String {
            self.dir.path().to_string_lossy().into_owned()
        }

        fn path(&self, name: &str) -> PathBuf {
            self.dir.path().join(name)
        }

        fn agent(&self, provider: &str, autonomy: &str) -> crate::session::Session {
            crate::session::create(
                self.host.test_store(),
                self.workspace.clone(),
                "agent".into(),
                "Coder".into(),
                provider.into(),
                String::new(),
                String::new(),
                autonomy.into(),
            )
            .expect("agent")
        }

        /// Stands a script in for a provider's CLI.
        fn cli(&self, binary: &str, body: &str) {
            let path = fake_cli(self.dir.path(), &format!("fake-{binary}"), body);
            self.host.override_binary(binary, path.to_string_lossy().into_owned());
        }

        fn turn(&self, session: &crate::session::Session, text: &str) -> TurnStart {
            TurnStart {
                session_id: session.id.clone(),
                cwd: self.cwd(),
                text: text.into(),
                files: None,
                mentions: None,
                hidden: None,
                from_agent: None,
                sent_at: None,
                nonce: None,
            }
        }

        fn start(&self, session: &crate::session::Session, text: &str) {
            self.host.start(self.turn(session, text)).expect("start");
        }

        fn session(&self, id: &str) -> crate::session::Session {
            crate::session::get(self.host.test_store(), id.to_string())
                .expect("read")
                .expect("session")
        }

        fn status(&self, id: &str) -> String {
            self.session(id).status
        }

        /// Waits for the turn to end and returns the status it left.
        fn settle(&self, id: &str) -> String {
            let mut status = String::new();
            eventually("the turn to end", || {
                status = self.status(id);
                status != "working" && status != "needs-input"
            });
            status
        }

        fn events(&self) -> Vec<HarnessEvent> {
            self.seen.0.lock().unwrap_or_else(|e| e.into_inner()).clone()
        }

        fn saw(&self, label: &str) -> bool {
            labels(&self.events()).iter().any(|seen| seen == label)
        }

        fn wait_label(&self, label: &str) {
            eventually(label, || self.saw(label));
        }

        fn wait_for(&self, what: &str, check: impl Fn(&HarnessEvent) -> bool) -> HarnessEvent {
            let mut found = None;
            eventually(what, || {
                found = self.events().into_iter().find(|event| check(event));
                found.is_some()
            });
            found.expect("found")
        }

        fn persisted(&self, id: &str) -> Vec<Block> {
            self.host
                .test_store()
                .with(|conn| crate::messages::all(conn, id))
                .expect("blocks")
        }
    }

    /// Prints `lines` as they are.
    fn say<S: AsRef<str>>(lines: &[S]) -> String {
        let mut body = String::from("cat <<'CREW_EOF'\n");
        for line in lines {
            body.push_str(line.as_ref());
            body.push('\n');
        }
        body.push_str("CREW_EOF\n");
        body
    }

    /// Reads one line of stdin into `name`.
    fn hear(dir: &Path, name: &str) -> String {
        format!("read -r line; printf '%s\\n' \"$line\" > '{}'\n", dir.join(name).display())
    }

    fn pid_to(dir: &Path, name: &str) -> String {
        format!("echo $$ > '{}'\n", dir.join(name).display())
    }

    /// Holds the script until the test writes `go` to its stdin.
    const GATE: &str = "while read -r line; do [ \"$line\" = go ] && break; done\n";

    fn claude_ready() -> String {
        json!({"type": "control_response", "response": {"subtype": "success", "request_id": "ctrl-1", "response": {}}})
            .to_string()
    }

    /// How every scripted Claude opens: it takes the initialize request, says
    /// it is ready, then takes the turn's message.
    fn claude_opening(dir: &Path) -> String {
        format!("{}{}{}", hear(dir, "init.json"), say(&[claude_ready()]), hear(dir, "user.json"))
    }

    fn claude_text(text: &str) -> String {
        json!({"type": "stream_event", "event": {"type": "content_block_delta", "index": 0,
            "delta": {"type": "text_delta", "text": text}}})
        .to_string()
    }

    fn claude_result() -> String {
        json!({"type": "result", "subtype": "success", "is_error": false, "result": "done", "duration_ms": 12,
            "total_cost_usd": 0.5, "usage": {"input_tokens": 3, "cache_read_input_tokens": 4,
            "cache_creation_input_tokens": 0, "output_tokens": 5}})
        .to_string()
    }

    fn permission(request_id: &str, tool: &str, input: Value) -> String {
        json!({"type": "control_request", "request_id": request_id,
            "request": {"subtype": "can_use_tool", "tool_name": tool, "input": input}})
        .to_string()
    }

    /// Capture 1's question, under another request id.
    fn recorded_question(request_id: &str) -> String {
        recorded(CLAUDE_FIXTURE, 6, 6).remove(0).replace(RECORDED_QUESTION, request_id)
    }

    fn cursor_text(text: &str) -> String {
        json!({"type": "assistant", "message": {"role": "assistant", "content": [{"type": "text", "text": text}]},
            "timestamp_ms": 1})
        .to_string()
    }

    fn read_json(path: &Path) -> Value {
        let text = std::fs::read_to_string(path).unwrap_or_else(|e| panic!("{}: {e}", path.display()));
        serde_json::from_str(text.trim()).unwrap_or_else(|e| panic!("{}: {e}: {text}", path.display()))
    }

    /// The argv a script was started with, as it wrote it out NUL-separated.
    fn argv(path: &Path) -> Vec<String> {
        std::fs::read_to_string(path)
            .expect("args")
            .split('\0')
            .filter(|arg| !arg.is_empty())
            .map(str::to_string)
            .collect()
    }

    fn pid_in(path: &Path) -> i32 {
        let mut pid = 0;
        eventually("the script to write its pid", || {
            pid = std::fs::read_to_string(path)
                .ok()
                .and_then(|text| text.trim().parse().ok())
                .unwrap_or(0);
            pid > 0
        });
        pid
    }

    fn alive(pid: i32) -> bool {
        unsafe { libc::kill(pid, 0) == 0 }
    }

    fn gone(pid: i32) {
        eventually("the CLI to be killed", || !alive(pid));
    }

    /// A CLI that only keeps what it is sent, for driving the control channel
    /// a line at a time. Returns where it writes, and its pid.
    fn recorder(rig: &Rig, id: &str) -> (PathBuf, i32) {
        let log = rig.path("stdin.log");
        let path = fake_cli(rig.dir.path(), "recorder", &format!("exec cat > '{}'", log.display()));
        let pid = rig
            .host
            .test_agents()
            .spawn(id.to_string(), path.to_string_lossy().into_owned(), Vec::new(), rig.cwd(), None)
            .expect("spawn recorder");
        (log, pid as i32)
    }

    /// What the recorder has been sent so far, a JSON value per line.
    fn sent(log: &Path) -> Vec<Value> {
        std::fs::read_to_string(log)
            .unwrap_or_default()
            .lines()
            .filter_map(|line| serde_json::from_str(line).ok())
            .collect()
    }

    fn wait_sent(log: &Path, what: &str, check: impl Fn(&Value) -> bool) -> Value {
        let mut found = None;
        eventually(what, || {
            found = sent(log).into_iter().find(|value| check(value));
            found.is_some()
        });
        found.expect("found")
    }

    fn reply_to(value: &Value, request_id: &str) -> bool {
        value["type"] == "control_response" && value["response"]["request_id"] == request_id
    }

    #[test]
    fn an_exit_message_names_the_provider_the_code_and_its_last_words() {
        let cases: [(Option<i32>, &[&str], &str); 4] = [
            (Some(3), &[], "Codex exited with code 3."),
            (None, &[], "Codex stopped."),
            (Some(1), &["", "  auth expired  ", ""], "Codex exited with code 1.\nauth expired"),
            (None, &["panic: x", "at y"], "Codex stopped.\npanic: x\nat y"),
        ];
        for (code, stderr, want) in cases {
            let stderr: Vec<String> = stderr.iter().map(|line| line.to_string()).collect();
            assert_eq!(exit_message("Codex", code, &stderr), want);
        }
    }

    #[test]
    fn the_paths_a_turn_names_are_its_mentions_then_its_files_less_the_inlined() {
        let file = |path: &str| AttachedFile {
            name: path.rsplit('/').next().unwrap_or(path).into(),
            path: path.into(),
            kind: None,
            size: None,
        };
        let mut params = TurnStart {
            session_id: "s".into(),
            cwd: String::new(),
            text: String::new(),
            files: None,
            mentions: None,
            hidden: None,
            from_agent: None,
            sent_at: None,
            nonce: None,
        };
        assert!(path_list(&params, &HashSet::new()).is_empty());
        params.mentions = Some(vec!["src/lib.rs".into()]);
        params.files = Some(vec![file("/tmp/a.png"), file("/tmp/notes.txt")]);
        assert_eq!(path_list(&params, &HashSet::new()), ["src/lib.rs", "/tmp/a.png", "/tmp/notes.txt"]);
        let inlined = HashSet::from(["/tmp/a.png".to_string()]);
        assert_eq!(path_list(&params, &inlined), ["src/lib.rs", "/tmp/notes.txt"]);
    }

    #[test]
    fn a_cli_that_exits_mid_turn_fails_it_with_the_tail_of_its_stderr() {
        let host = TurnHost::test_new();
        let seen = host.test_capture();
        let stderr: Vec<String> = (1..=STDERR_TAIL + 3).map(|n| format!("warn {n}")).collect();
        let tail = stderr[3..].join("\n");
        for (provider, name) in
            [("claude", "Claude Code"), ("codex", "Codex"), ("cursor", "Cursor Agent"), ("opencode", "opencode")]
        {
            let id = format!("exit-{provider}");
            let mut rx = arm(&host, &id, provider);
            host.on_agent_lines("agent-stderr", &id, stderr.clone());
            host.on_agent_exit(&id, Some(2));
            let want = format!("{name} exited with code 2.\n{tail}");
            assert!(failed_with(outcome(&mut rx), &want), "{provider}");
            assert_eq!(seen.take(), [HarnessEvent::SessionEnded { code: Some(2) }], "{provider}");
        }
    }

    #[test]
    fn an_exit_that_is_not_mid_turn_fails_nothing() {
        let host = TurnHost::test_new();
        let seen = host.test_capture();

        // Nothing is running under that id.
        host.on_agent_lines("agent-stderr", "nobody", vec!["boom".into()]);
        host.on_agent_lines("agent-stdout", "nobody", vec![claude_text("hi")]);
        host.on_agent_exit("nobody", Some(1));

        // A CLI that exits once its turn has settled.
        let mut codex = arm(&host, "codex", "codex");
        feed(&host, "codex", &[json!({"type": "turn.completed"}).to_string()]);
        host.on_agent_exit("codex", Some(0));
        assert!(matches!(outcome(&mut codex), Some(TurnOutcome::Completed)));
        let mut claude = arm(&host, "claude", "claude");
        feed(&host, "claude", &[claude_result()]);
        host.on_agent_exit("claude", Some(0));
        assert!(matches!(outcome(&mut claude), Some(TurnOutcome::Completed)));

        // One already stopped is not failed again by the exit its stop caused.
        let mut stopped = arm(&host, "stopped", "claude");
        claude_live(&host, "stopped", |live| live.cancelled = true);
        host.on_agent_exit("stopped", Some(143));
        assert!(outcome(&mut stopped).is_none());
        let mut cancelled = arm(&host, "cancelled", "cursor");
        stream_live(&host, "cancelled", |live| live.cancelled = true);
        host.on_agent_exit("cancelled", Some(143));
        assert!(outcome(&mut cancelled).is_none());

        let events = labels(&seen.take());
        assert!(!events.iter().any(|label| label.starts_with("ended")), "{events:?}");
    }

    #[test]
    fn a_claude_that_exits_before_it_is_ready_lets_the_start_give_up() {
        let host = TurnHost::test_new();
        host.test_install_claude("s");
        let (tx, mut rx) = oneshot::channel();
        claude_live(&host, "s", |live| {
            live.initialized = false;
            live.active = false;
            live.init_tx = Some(tx);
        });
        host.on_agent_exit("s", Some(1));
        assert_eq!(rx.try_recv(), Ok(false));
    }

    #[test]
    fn the_first_ready_line_releases_the_start_and_only_once() {
        let host = TurnHost::test_new();
        let seen = host.test_capture();
        for (id, ready) in [
            ("by-response", claude_ready()),
            ("by-init", json!({"type": "system", "subtype": "init"}).to_string()),
        ] {
            host.test_install_claude(id);
            let (tx, mut rx) = oneshot::channel();
            claude_live(&host, id, |live| {
                live.initialized = false;
                live.init_tx = Some(tx);
            });
            feed(&host, id, &[ready.clone(), ready]);
            assert_eq!(rx.try_recv(), Ok(true), "{id}");
            assert!(claude_live(&host, id, |live| live.initialized), "{id}");
        }
        assert!(seen.take().is_empty());
    }

    #[test]
    fn an_answer_reaches_only_the_request_waiting_for_it() {
        let host = TurnHost::test_new();
        assert_eq!(host.respond("s", 1, ApprovalDecision::Allow), Err("No approval is waiting".to_string()));
        assert_eq!(host.answer("s", 1, None), Err("No question is waiting".to_string()));
        arm(&host, "codex", "codex");
        assert!(host.respond("codex", 1, ApprovalDecision::Allow).is_err());
        assert!(host.answer("codex", 1, None).is_err());

        host.test_install_claude("s");
        let (approvals, approved) = mpsc::channel();
        let (questions, answered) = mpsc::channel();
        claude_live(&host, "s", |live| {
            for (ui, request) in [(1, "a1"), (2, "a2"), (3, "a3")] {
                live.approvals.insert(ui, PendingApproval { request_id: request.into(), tx: approvals.clone() });
            }
            for (ui, request) in [(4, "q1"), (5, "q2")] {
                live.questions.insert(ui, PendingQuestion { request_id: request.into(), tx: questions.clone() });
            }
        });
        host.respond("s", 1, ApprovalDecision::Allow).expect("allow");
        host.respond("s", 2, ApprovalDecision::Always).expect("always");
        host.respond("s", 3, ApprovalDecision::Deny).expect("deny");
        assert_eq!(
            approved.try_iter().collect::<Vec<_>>(),
            [ApprovalResolution::Allow, ApprovalResolution::Always, ApprovalResolution::Deny]
        );
        assert!(host.respond("s", 1, ApprovalDecision::Allow).is_err(), "an approval is answered once");
        assert!(host.respond("s", 4, ApprovalDecision::Allow).is_err(), "a question is not an approval");

        let answers = Answers::from([("Pick a color".to_string(), "Red".to_string())]);
        host.answer("s", 4, Some(answers.clone())).expect("answer");
        host.answer("s", 5, None).expect("dismiss");
        let replies: Vec<QuestionReply> = answered.try_iter().collect();
        assert!(matches!(&replies[..], [QuestionReply::Answers(got), QuestionReply::Dismiss] if *got == answers));
        assert!(host.answer("s", 4, None).is_err(), "a question is answered once");
    }

    #[test]
    fn a_stop_settles_the_turn_as_stopped_and_lets_it_go() {
        let host = TurnHost::test_new();
        for provider in ["codex", "cursor", "opencode", "claude"] {
            let id = format!("stop-{provider}");
            let mut rx = arm(&host, &id, provider);
            if provider == "claude" {
                // Still starting: there is nothing to interrupt yet.
                claude_live(&host, &id, |live| live.active = false);
            }
            host.stop(&id).expect("stop");
            assert!(matches!(outcome(&mut rx), Some(TurnOutcome::Stopped)), "{provider}");
            assert!(host.lock().get(&id).is_none(), "{provider} was not let go");
            assert!(host.stop_requested(&id), "{provider}");
        }
        host.stop("nobody").expect("a stop with nothing running is fine");
    }

    #[test]
    fn a_stop_refuses_whatever_the_user_was_still_being_asked() {
        let host = TurnHost::test_new();
        host.test_install_claude("s");
        let (approvals, approved) = mpsc::channel();
        let (questions, answered) = mpsc::channel();
        claude_live(&host, "s", |live| {
            live.active = false;
            live.approvals.insert(1, PendingApproval { request_id: "a".into(), tx: approvals });
            live.questions.insert(2, PendingQuestion { request_id: "q".into(), tx: questions });
        });
        host.stop("s").expect("stop");
        assert_eq!(approved.try_recv(), Ok(ApprovalResolution::Deny));
        assert!(matches!(answered.try_recv(), Ok(QuestionReply::Dismiss)));
    }

    #[tokio::test(start_paused = true)]
    async fn a_cli_silent_for_two_minutes_fails_the_turn() {
        let host = TurnHost::test_new();
        host.set_runtime(tokio::runtime::Handle::current());
        let rx = arm(&host, "s", "codex");
        let began = tokio::time::Instant::now();
        let outcome = tokio::time::timeout(FIRST_OUTPUT_TIMEOUT * 2, rx)
            .await
            .expect("the watchdog did not fire")
            .expect("an outcome");
        assert!(began.elapsed() >= FIRST_OUTPUT_TIMEOUT);
        assert!(failed_with(Some(outcome), "No answer in 120s. The CLI started and said nothing."));
    }

    #[tokio::test(start_paused = true)]
    async fn a_cli_that_said_anything_is_left_to_its_work() {
        let host = TurnHost::test_new();
        host.set_runtime(tokio::runtime::Handle::current());
        let mut talking = arm(&host, "talking", "opencode");
        // Not even a line it understands: any output at all is a live CLI.
        feed(&host, "talking", &["warming up".into()]);
        let mut stopped = arm(&host, "stopped", "cursor");
        stream_live(&host, "stopped", |live| live.cancelled = true);
        let mut gone = arm(&host, "gone", "codex");
        host.detach("gone");

        tokio::time::sleep(FIRST_OUTPUT_TIMEOUT * 2).await;
        assert!(outcome(&mut talking).is_none());
        assert!(stream_live(&host, "talking", |live| live.active));
        assert!(outcome(&mut stopped).is_none());
        assert!(matches!(gone.try_recv(), Err(oneshot::error::TryRecvError::Closed)));
    }

    #[test]
    fn a_turn_starts_only_for_an_idle_agent_that_exists() {
        let rig = rig();
        let codex = rig.agent("codex", "full");
        let missing = TurnStart { session_id: "nobody".into(), ..rig.turn(&codex, "hi") };
        assert_eq!(rig.host.start(missing).err().as_deref(), Some("Session not found"));
        let terminal = crate::session::create(
            rig.host.test_store(),
            rig.workspace.clone(),
            "terminal".into(),
            "Shell".into(),
            String::new(),
            String::new(),
            String::new(),
            "ask".into(),
        )
        .expect("terminal");
        assert_eq!(rig.host.start(rig.turn(&terminal, "ls")).err().as_deref(), Some("Not an agent session"));
        for provider in ["codex", "claude"] {
            let busy = rig.agent(provider, "full");
            arm(&rig.host, &busy.id, provider);
            assert_eq!(
                rig.host.start(rig.turn(&busy, "again")).err().as_deref(),
                Some("Turn already running"),
                "{provider}"
            );
        }
        assert!(rig.events().is_empty(), "a refused turn writes nothing");
    }

    #[test]
    fn a_provider_crew_cannot_run_fails_the_turn_saying_so() {
        let rig = rig();
        let agent = rig.agent("gemini", "ask");
        rig.start(&agent, "hello");
        assert_eq!(rig.settle(&agent.id), "error");
        let why = "gemini agents are not wired up yet. Pick Claude for now.";
        assert_eq!(texts(&rig.persisted(&agent.id)), [(BlockRole::User, "hello"), (BlockRole::System, why)]);
    }

    #[test]
    fn a_binary_is_its_override_when_there_is_one() {
        let host = TurnHost::test_new();
        host.override_binary("codex", "/opt/fake/codex");
        assert_eq!(host.resolve_bin("codex"), Ok("/opt/fake/codex".to_string()));
        // Otherwise it is looked up by name, and a path is not a name.
        assert_eq!(host.resolve_bin("bin/codex"), Err("Not a binary name: bin/codex".to_string()));
    }

    #[test]
    fn an_empty_box_starts_nothing() {
        let rig = rig();
        let agent = rig.agent("opencode", "full");
        assert!(!rig.host.deliver_to(&agent));
        assert_eq!(rig.status(&agent.id), "idle");
        assert!(rig.events().is_empty());
    }

    fn bash_start(id: &str, index: Option<i64>) -> String {
        let mut event = json!({"type": "content_block_start",
            "content_block": {"type": "tool_use", "id": id, "name": "Bash", "input": {}}});
        if let Some(index) = index {
            event["index"] = json!(index);
        }
        json!({"type": "stream_event", "event": event}).to_string()
    }

    fn input_delta(index: i64, partial: &str) -> String {
        json!({"type": "stream_event", "event": {"type": "content_block_delta", "index": index,
            "delta": {"type": "input_json_delta", "partial_json": partial}}})
        .to_string()
    }

    fn assistant(content: Value) -> String {
        json!({"type": "assistant", "message": {"role": "assistant", "content": content}, "parent_tool_use_id": null})
            .to_string()
    }

    fn tool_use(id: &str, name: &str, input: Value) -> Value {
        json!({"type": "tool_use", "id": id, "name": name, "input": input})
    }

    fn tool_result(id: &str, content: Value, is_error: bool) -> String {
        json!({"type": "user", "message": {"role": "user",
            "content": [{"type": "tool_result", "tool_use_id": id, "content": content, "is_error": is_error}]}})
        .to_string()
    }

    fn message_start() -> String {
        json!({"type": "stream_event", "event": {"type": "message_start", "message": {}}}).to_string()
    }

    #[test]
    fn claude_lines_become_transcript_events() {
        let host = TurnHost::test_new();
        let seen = host.test_capture();
        let status = |session: &str| json!({"type": "system", "subtype": "status", "session_id": session}).to_string();
        let text = |text: &str| json!([{"type": "text", "text": text}]);
        let cases: Vec<(&str, Vec<String>, Vec<&str>)> = vec![
            (
                "noise",
                vec![
                    "not json".into(),
                    String::new(),
                    "[1]".into(),
                    json!({"type": "keep_alive"}).to_string(),
                    json!({"type": "system", "subtype": "status"}).to_string(),
                    json!({"type": "stream_event", "event": {"type": "content_block_stop", "index": 0}}).to_string(),
                    json!({"type": "mystery"}).to_string(),
                ],
                vec![],
            ),
            (
                "binding",
                vec![
                    status("cs-1"),
                    status("cs-1"),
                    json!({"type": "system", "subtype": "hook_started", "session_id": "hook-9"}).to_string(),
                    status("cs-2"),
                ],
                vec!["bound cs-1", "bound cs-2"],
            ),
            (
                "compaction",
                vec![json!({"type": "system", "subtype": "compact_boundary"}).to_string()],
                vec!["note: Context compacted"],
            ),
            (
                "streamed text",
                vec![
                    message_start(),
                    claude_text("Hel"),
                    claude_text("lo"),
                    assistant(text("Hello")),
                    assistant(text("Hello there")),
                ],
                vec!["delta: Hel", "delta: lo", "delta:  there"],
            ),
            (
                "a new message",
                vec![
                    claude_text("Draft"),
                    assistant(text("Final")),
                    message_start(),
                    assistant(text("Next")),
                    assistant(json!([])),
                ],
                vec!["delta: Draft", "message done", "delta: Final", "delta: Next"],
            ),
            (
                "streamed tool input",
                vec![
                    bash_start("t1", Some(1)),
                    input_delta(1, "{\"command\":"),
                    input_delta(1, "\"ls\"}"),
                    input_delta(7, "{}"),
                    input_delta(1, ""),
                ],
                vec!["tool t1 Bash: Bash", "tool t1 = ls"],
            ),
            (
                "input from the assistant frame",
                vec![
                    bash_start("t2", None),
                    assistant(json!([tool_use("t2", "Bash", json!({"command": "pwd"}))])),
                    assistant(json!([tool_use("t2", "Bash", json!({"command": "pwd"}))])),
                    assistant(json!([tool_use("t3", "Read", json!({"file_path": "/a/b.rs"}))])),
                ],
                vec!["tool t2 Bash: Bash", "tool t2 = pwd", "tool t3 Read: Read b.rs"],
            ),
            (
                "tool results",
                vec![
                    assistant(json!([tool_use("t4", "Bash", json!({"command": "ls"}))])),
                    tool_result("t4", json!("a.txt"), false),
                    tool_result("t9", json!([{"type": "text", "text": "x"}]), true),
                ],
                vec!["tool t4 Bash: ls", "tool t4 Completed", "tool t9 Failed"],
            ),
            (
                "subagents",
                vec![
                    json!({"type": "stream_event", "parent_tool_use_id": "toolu_x",
                        "event": {"type": "content_block_delta", "index": 0,
                        "delta": {"type": "text_delta", "text": "inner"}}})
                    .to_string(),
                    json!({"type": "assistant", "parent_tool_use_id": "toolu_x",
                        "message": {"role": "assistant", "content": [{"type": "text", "text": "inner"}]}})
                    .to_string(),
                ],
                vec![],
            ),
            ("result", vec![claude_result()], vec!["turn done Some((Some(7), Some(5)))"]),
        ];
        for (case, lines, want) in cases {
            host.test_install_claude(case);
            feed(&host, case, &lines);
            assert_eq!(labels(&seen.take()), want, "{case}");
        }

        // A stopped turn is muted, and a line for no turn at all is dropped.
        host.test_install_claude("muted");
        claude_live(&host, "muted", |live| live.mute = true);
        feed(&host, "muted", &[claude_text("x"), claude_result()]);
        host.handle_claude_line("nobody", &claude_text("x"));
        host.handle_claude_line("nobody", &json!({"type": "control_cancel_request", "request_id": "r"}).to_string());
        assert!(seen.take().is_empty());
    }

    #[test]
    fn a_streamed_tool_call_keeps_its_input_for_the_result() {
        let host = TurnHost::test_new();
        let seen = host.test_capture();
        host.test_install_claude("s");
        feed(
            &host,
            "s",
            &[
                bash_start("t1", Some(1)),
                input_delta(1, "{\"command\":"),
                input_delta(1, "\"ls\"}"),
                tool_result("t1", json!("a.txt"), false),
            ],
        );
        assert_eq!(
            seen.take().last(),
            Some(&HarnessEvent::ToolUpdated {
                call_id: "t1".into(),
                title: None,
                status: Some(ToolStatus::Completed),
                detail: Some(ToolDetail::Command {
                    command: "ls".into(),
                    exit_code: None,
                    output: Some("a.txt".into())
                }),
            })
        );
    }

    #[test]
    fn a_claude_result_ends_the_turn_the_way_it_says() {
        let host = TurnHost::test_new();
        let mut ok = arm(&host, "ok", "claude");
        feed(&host, "ok", &[claude_result()]);
        assert!(matches!(outcome(&mut ok), Some(TurnOutcome::Completed)));
        assert!(!claude_live(&host, "ok", |live| live.active));

        let mut failed = arm(&host, "failed", "claude");
        let refused = json!({"type": "result", "subtype": "error_during_execution", "is_error": true,
            "errors": ["[ede_diagnostic] noise", "Credit balance is too low"]});
        feed(&host, "failed", &[refused.to_string()]);
        assert!(failed_with(outcome(&mut failed), "Credit balance is too low"));
    }

    #[test]
    fn the_recorded_claude_turns_replay_into_the_transcript() {
        let host = TurnHost::test_new();
        let seen = host.test_capture();
        // Capture 1 without its control request, which the control channel
        // tests below answer.
        let mut question = recorded(CLAUDE_FIXTURE, 4, 5);
        question.extend(recorded(CLAUDE_FIXTURE, 8, 11));
        let mut rx = arm(&host, "question", "claude");
        feed(&host, "question", &question);
        assert_eq!(
            labels(&seen.take()),
            [
                "bound 5eb66302-0bff-43eb-81bc-7e3f47f86b5a",
                "tool toolu_01Ev966tw8wL8iJ1As37mnLB AskUserQuestion: AskUserQuestion",
                "tool toolu_01Ev966tw8wL8iJ1As37mnLB Completed",
                "delta: Color: Red. Toppings: Cheese, Olives.",
                "turn done Some((Some(82795), Some(226)))",
            ]
        );
        assert!(matches!(outcome(&mut rx), Some(TurnOutcome::Completed)));

        // Capture 2, the Bash approval, the same way.
        let mut bash = recorded(CLAUDE_FIXTURE, 14, 14);
        bash.extend(recorded(CLAUDE_FIXTURE, 17, 19));
        arm(&host, "bash", "claude");
        feed(&host, "bash", &bash);
        let events = seen.take();
        assert_eq!(
            labels(&events),
            [
                "bound 9cf6b7f7-b8ab-4de7-86da-b03fb297fcd7",
                "tool toolu_01NXryc1w4bSyP5MGzDE8Hbe Bash: curl -s -o /dev/null -w '%{http_code}' https://example.com",
                "tool toolu_01NXryc1w4bSyP5MGzDE8Hbe Completed",
                "tool toolu_013rQ15PmtamphhcJbSN79S4 Bash: curl -s -o /dev/null -w '%{http_code}' https://example.org",
                "tool toolu_013rQ15PmtamphhcJbSN79S4 Completed",
            ]
        );
        assert!(matches!(
            &events[2],
            HarnessEvent::ToolUpdated { detail: Some(ToolDetail::Command { output: Some(output), .. }), .. }
                if output == "200"
        ));
    }

    #[test]
    fn codex_lines_become_transcript_events() {
        let host = TurnHost::test_new();
        let seen = host.test_capture();

        let mut pong = arm(&host, "pong", "codex");
        feed(&host, "pong", &recorded(CODEX_FIXTURE, 1, 4));
        assert_eq!(
            labels(&seen.take()),
            [
                "bound 01a068b3-442b-7101-acbd-df58756a43f6",
                "delta: pong",
                "message done",
                "message done",
                "turn done Some((Some(19094), Some(5)))",
            ]
        );
        assert!(matches!(outcome(&mut pong), Some(TurnOutcome::Completed)));

        let mut refused = arm(&host, "refused", "codex");
        feed(&host, "refused", &recorded(CODEX_FIXTURE, 9, 13));
        assert_eq!(
            labels(&seen.take()),
            [
                "bound 01a068b7-f2b6-7cd0-8add-372f765cb52b",
                "note: Model metadata for `gpt-5.6` not found. Defaulting to fallback metadata; this can degrade performance and cause issues.",
                "message done",
                "turn done None",
            ]
        );
        let unsupported = "The 'gpt-5.6' model is not supported when using Codex with a ChatGPT account.";
        assert!(failed_with(outcome(&mut refused), unsupported));

        arm(&host, "tools", "codex");
        feed(&host, "tools", &recorded(CODEX_FIXTURE, 14, 17));
        assert_eq!(
            labels(&seen.take()),
            [
                "note: Code Mode is unavailable because code-mode host is disabled. Code mode will fail closed; enable `features.code_mode_host` and install `codex-code-mode-host`.",
                "tool item_1 js: Inspect available terminal surfaces",
                "tool item_2 js: Open terminal",
                "tool item_2 = Open terminal",
                "tool item_2 Failed",
            ]
        );

        let item = |kind: &str, item: Value| json!({"type": kind, "item": item}).to_string();
        let message = |kind: &str, id: &str, text: &str| {
            item(kind, json!({"id": id, "type": "agent_message", "text": text}))
        };
        let mut edge = arm(&host, "edge", "codex");
        feed(
            &host,
            "edge",
            &[
                "garbage".into(),
                json!({"type": "error"}).to_string(),
                item("item.started", json!({"id": "r1", "type": "reasoning", "text": "hmm"})),
                item("item.started", json!({"type": "command_execution", "command": "ls"})),
                item("item.started", json!({"id": "c1", "type": "command_execution", "command": "ls"})),
                item("item.updated", json!({"id": "c1", "type": "command_execution", "command": "ls"})),
                item(
                    "item.completed",
                    json!({"id": "c1", "type": "command_execution", "command": "ls", "exit_code": 1,
                        "status": "failed"}),
                ),
                message("item.updated", "m1", "Hel"),
                message("item.updated", "m1", "Hello"),
                message("item.updated", "m1", "Hello"),
                message("item.completed", "m1", "Hello"),
                message("item.updated", "m2", ""),
                message("item.updated", "m2", "Second"),
                message("item.updated", "m3", "Other"),
            ],
        );
        assert_eq!(
            labels(&seen.take()),
            [
                "tool c1 bash: ls",
                "tool c1 = ls",
                "tool c1 = ls",
                "tool c1 Failed",
                "delta: Hel",
                "delta: lo",
                "message done",
                "delta: Second",
                "message done",
                "delta: Other",
            ]
        );
        assert!(outcome(&mut edge).is_none(), "an error that says nothing is not fatal");

        let mut fatal = arm(&host, "fatal", "codex");
        feed(&host, "fatal", &[json!({"type": "error", "message": "stream disconnected"}).to_string()]);
        assert!(failed_with(outcome(&mut fatal), "stream disconnected"));
        let mut vague = arm(&host, "vague", "codex");
        feed(&host, "vague", &[json!({"type": "turn.failed"}).to_string()]);
        assert!(failed_with(outcome(&mut vague), "Codex turn failed."));
        assert_eq!(labels(&seen.take()), ["message done", "turn done None"]);

        // A stopped turn, and one that is not there, take no more lines.
        arm(&host, "stopped", "codex");
        stream_live(&host, "stopped", |live| live.cancelled = true);
        feed(&host, "stopped", &[message("item.completed", "m", "late")]);
        host.handle_codex_line("nobody", &item("item.started", json!({"id": "c", "type": "command_execution"})));
        host.handle_codex_line("nobody", &message("item.completed", "m", "late"));
        host.handle_codex_line("nobody", &json!({"type": "error", "message": "stream disconnected"}).to_string());
        assert!(seen.take().is_empty());
    }

    #[test]
    fn cursor_lines_become_transcript_events() {
        let host = TurnHost::test_new();
        let seen = host.test_capture();

        let mut pong = arm(&host, "pong", "cursor");
        feed(&host, "pong", &recorded(CURSOR_FIXTURE, 1, 8));
        let events = seen.take();
        assert!(labels(&events).contains(&"bound 71536dc2-3115-416c-98f4-af6ea6d5be32".to_string()));
        assert_eq!(
            said(&events),
            [
                "thinking: The user requested a",
                "thinking:  single-word reply: ",
                "thinking: \"pong\".",
                "delta: pong",
                "message done",
                "turn done Some((Some(20026), Some(34)))",
            ]
        );
        assert!(matches!(outcome(&mut pong), Some(TurnOutcome::Completed)));
        // Settled: whatever follows is not this turn's.
        feed(&host, "pong", &recorded(CURSOR_FIXTURE, 9, 16));
        assert!(said(&seen.take()).is_empty());

        let mut tools = arm(&host, "tools", "cursor");
        feed(&host, "tools", &recorded(CURSOR_FIXTURE, 9, 38));
        let events = seen.take();
        assert_eq!(events.iter().filter(|event| matches!(event, HarnessEvent::ToolStarted { .. })).count(), 4);
        assert_eq!(
            statuses(&events),
            [ToolStatus::Failed, ToolStatus::Failed, ToolStatus::Completed, ToolStatus::Completed]
        );
        let text: String = events
            .iter()
            .filter_map(|event| match event {
                HarnessEvent::MessageDelta { text } => Some(text.as_str()),
                _ => None,
            })
            .collect();
        assert_eq!(
            text,
            "I'll read the first three lines of `package.json` and run the echo command.\
             The first attempt failed, so I'm retrying both.`{`\nhello-from-cursor"
        );
        assert!(matches!(outcome(&mut tools), Some(TurnOutcome::Completed)));

        // A result with no text before it is the text.
        let mut fallback = arm(&host, "fallback", "cursor");
        feed(&host, "fallback", &[json!({"type": "result", "subtype": "success", "result": "only here"}).to_string()]);
        assert_eq!(said(&seen.take()), ["delta: only here", "message done", "turn done Some((None, None))"]);
        assert!(matches!(outcome(&mut fallback), Some(TurnOutcome::Completed)));

        let mut failed = arm(&host, "failed", "cursor");
        let limited = json!({"type": "result", "subtype": "error", "is_error": true, "result": "Rate limited"});
        feed(&host, "failed", &[limited.to_string()]);
        assert_eq!(said(&seen.take()), ["message done", "turn done Some((None, None))"]);
        assert!(failed_with(outcome(&mut failed), "Rate limited"));

        let finished = json!({"type": "tool_call", "subtype": "completed", "call_id": "k1",
            "tool_call": {"shellToolCall": {"args": {"command": "ls"}, "result": {"success": {"exitCode": 0}}}}})
        .to_string();
        let mut noise = arm(&host, "noise", "cursor");
        feed(
            &host,
            "noise",
            &[
                "nope".into(),
                json!({"type": "thinking", "subtype": "delta", "text": ""}).to_string(),
                json!({"type": "thinking", "subtype": "completed"}).to_string(),
                json!({"type": "assistant", "message": {"role": "assistant",
                    "content": [{"type": "text", "text": "final copy"}]}})
                .to_string(),
                json!({"type": "tool_call", "subtype": "progress", "call_id": "x"}).to_string(),
                json!({"type": "system", "subtype": "init", "model": "auto"}).to_string(),
                finished.clone(),
            ],
        );
        assert_eq!(said(&seen.take()), ["tool k1 Shell: ls", "tool k1 Completed"]);
        assert!(outcome(&mut noise).is_none());
        host.handle_cursor_line("nobody", &finished);
        assert!(seen.take().is_empty());
    }

    #[test]
    fn opencode_lines_become_transcript_events() {
        let host = TurnHost::test_new();
        let seen = host.test_capture();

        let mut turn = arm(&host, "turn", "opencode");
        feed(&host, "turn", &recorded(OPENCODE_FIXTURE, 1, 7));
        let events = seen.take();
        assert!(labels(&events).contains(&"bound ses_f52488128ffep0Jr7oGXPVw1Yt".to_string()));
        assert_eq!(
            said(&events),
            [
                "tool call_632d6744456c4148abfcedee read: Read sample.txt",
                "tool call_632d6744456c4148abfcedee Completed",
                "tool call_2fde65bdd4f8460b987afa11 bash: echo done",
                "tool call_2fde65bdd4f8460b987afa11 Completed",
                "delta: The first line of `sample.txt` was **`hello from crew`**.",
                "message done",
                "message done",
                "turn done Some((Some(20637), Some(163)))",
            ]
        );
        assert!(matches!(outcome(&mut turn), Some(TurnOutcome::Completed)));

        // Five steps of one turn, each counted apart and added up.
        let mut steps = arm(&host, "steps", "opencode");
        feed(&host, "steps", &recorded(OPENCODE_STREAMING_FIXTURE, 10, 29));
        let events = seen.take();
        assert_eq!(
            statuses(&events),
            [
                ToolStatus::Failed,
                ToolStatus::Completed,
                ToolStatus::Failed,
                ToolStatus::Completed,
                ToolStatus::Completed,
            ]
        );
        assert_eq!(events.iter().filter(|event| matches!(event, HarnessEvent::MessageDelta { .. })).count(), 5);
        assert_eq!(said(&events).last().map(String::as_str), Some("turn done Some((Some(54180), Some(921)))"));
        assert!(matches!(outcome(&mut steps), Some(TurnOutcome::Completed)));

        let text = |id: &str, text: &str| {
            json!({"type": "text", "sessionID": "ses", "part": {"id": id, "type": "text", "text": text}}).to_string()
        };
        let step = |reason: &str| {
            json!({"type": "step_finish", "sessionID": "ses", "part": {"type": "step-finish", "reason": reason,
                "tokens": {"input": 10, "output": 2, "reasoning": 1, "cache": {"read": 5, "write": 0}}, "cost": 0.25}})
            .to_string()
        };
        let mut snapshots = arm(&host, "snapshots", "opencode");
        feed(
            &host,
            "snapshots",
            &[
                text("p1", "Hel"),
                text("p1", "Hello"),
                text("p1", "Hello"),
                text("p2", "Other"),
                text("p1", "Rewritten"),
                text("p3", ""),
                json!({"type": "text"}).to_string(),
                json!({"type": "tool_use", "part": {"type": "tool", "tool": "bash"}}).to_string(),
                json!({"type": "step_start"}).to_string(),
                "{not json".into(),
            ],
        );
        assert_eq!(
            said(&seen.take()),
            [
                "delta: Hel",
                "message done",
                "delta: lo",
                "message done",
                "delta: Other",
                "message done",
                "delta: Rewritten",
                "message done",
            ]
        );
        assert!(outcome(&mut snapshots).is_none());

        // What the steps before an error cost is still counted.
        let mut late = arm(&host, "late", "opencode");
        let overloaded = json!({"type": "error", "error": {"name": "APIError", "data": {"message": "Overloaded"}}});
        feed(&host, "late", &[step("tool-calls"), overloaded.to_string()]);
        assert_eq!(said(&seen.take()), ["turn done Some((Some(15), Some(3)))"]);
        assert!(failed_with(outcome(&mut late), "Overloaded"));
        let mut early = arm(&host, "early", "opencode");
        feed(&host, "early", &[json!({"type": "error", "error": {"name": "ProviderAuthError"}}).to_string()]);
        assert!(said(&seen.take()).is_empty());
        assert!(failed_with(outcome(&mut early), "ProviderAuthError"));

        // A step cut short fails the turn, and nothing after it counts.
        let mut cut = arm(&host, "cut", "opencode");
        feed(&host, "cut", &[text("p1", "Half an ans"), step("length"), text("p1", "Half an answer")]);
        assert_eq!(said(&seen.take()), ["delta: Half an ans", "message done", "message done"]);
        assert!(failed_with(outcome(&mut cut), "The model ran out of room mid-answer."));

        host.handle_opencode_line("nobody", &step("stop"));
        host.handle_opencode_line("nobody", &recorded(OPENCODE_FIXTURE, 3, 3).remove(0));
        host.opencode_text("nobody", &OpencodeText { id: "p".into(), text: "x".into() });
        host.handle_opencode_line("nobody", &overloaded.to_string());
        assert!(said(&seen.take()).is_empty());
    }

    #[test]
    fn an_approval_is_answered_the_way_the_user_decided() {
        let rig = rig();
        let agent = rig.agent("claude", "ask");
        rig.host.test_install_claude(&agent.id);
        let (log, _) = recorder(&rig, &agent.id);
        let input = json!({"command": "rm -rf build", "description": "Clean the build"});
        let rule = json!({"type": "addRules", "rules": [{"toolName": "Bash", "ruleContent": "rm:*"}],
            "behavior": "allow", "destination": "session"});
        let cases = [
            (1, ApprovalDecision::Allow, json!({"behavior": "allow", "updatedInput": input})),
            (
                2,
                ApprovalDecision::Always,
                json!({"behavior": "allow", "updatedInput": input, "updatedPermissions": [rule]}),
            ),
            (3, ApprovalDecision::Deny, json!({"behavior": "deny", "message": "User declined tool execution."})),
        ];
        for (ui, decision, want) in cases {
            let request = format!("perm-{ui}");
            rig.host.handle_claude_line(&agent.id, &permission(&request, "Bash", input.clone()));
            let asked = rig.wait_for("the approval to be asked", |event| {
                matches!(event, HarnessEvent::ApprovalRequested { request_id, .. } if *request_id == ui)
            });
            assert_eq!(
                asked,
                HarnessEvent::ApprovalRequested {
                    request_id: ui,
                    name: "Bash".into(),
                    title: "rm -rf build".into(),
                    input: Some(input.clone()),
                }
            );
            assert_eq!(rig.status(&agent.id), "needs-input");

            rig.host.respond(&agent.id, ui, decision.clone()).expect("respond");
            let reply = wait_sent(&log, "the reply", |value| reply_to(value, &request));
            assert_eq!(reply["response"]["response"], want, "{decision:?}");
            assert!(rig.saw(&format!("approved {ui} {decision:?}")));
            assert_eq!(rig.status(&agent.id), "working");
        }
    }

    #[test]
    fn a_question_is_answered_the_way_the_recording_shows_or_dismissed() {
        let rig = rig();
        let agent = rig.agent("claude", "ask");
        rig.host.test_install_claude(&agent.id);
        let (log, _) = recorder(&rig, &agent.id);
        let recorded_reply: Value = serde_json::from_str(
            CLAUDE_FIXTURE.lines().nth(6).and_then(|line| line.strip_prefix("<<< ")).expect("the recorded reply"),
        )
        .expect("json");

        rig.host.handle_claude_line(&agent.id, &recorded_question(RECORDED_QUESTION));
        let HarnessEvent::QuestionRequested { request_id, questions } =
            rig.wait_for("the question", |event| matches!(event, HarnessEvent::QuestionRequested { .. }))
        else {
            unreachable!()
        };
        assert_eq!(request_id, 1);
        assert_eq!(
            questions.iter().map(|q| (q.header.as_str(), q.multi_select, q.options.len())).collect::<Vec<_>>(),
            [("Color", false, 2), ("Toppings", true, 3)]
        );
        assert_eq!(rig.status(&agent.id), "needs-input");

        let answers = Answers::from([
            ("Pick a color".to_string(), "Red".to_string()),
            ("Pick toppings".to_string(), "Cheese, Olives".to_string()),
        ]);
        rig.host.answer(&agent.id, 1, Some(answers)).expect("answer");
        let reply = wait_sent(&log, "the answer", |value| reply_to(value, RECORDED_QUESTION));
        assert_eq!(reply, recorded_reply, "the reply is the one the real CLI took");
        assert!(rig.saw("answered 1 true"));
        assert_eq!(rig.status(&agent.id), "working");

        rig.host.handle_claude_line(&agent.id, &recorded_question("q-2"));
        rig.wait_label("question 2 x2");
        rig.host.answer(&agent.id, 2, None).expect("dismiss");
        let reply = wait_sent(&log, "the dismissal", |value| reply_to(value, "q-2"));
        assert_eq!(
            reply["response"]["response"],
            json!({"behavior": "deny", "message": "User dismissed the question."})
        );
        assert!(rig.saw("answered 2 false"));
        assert_eq!(rig.status(&agent.id), "working");
    }

    #[test]
    fn a_request_claude_withdraws_is_closed_without_an_answer() {
        let rig = rig();
        let agent = rig.agent("claude", "ask");
        rig.host.test_install_claude(&agent.id);
        let (log, _) = recorder(&rig, &agent.id);
        rig.host.handle_claude_line(&agent.id, &permission("perm-1", "Bash", json!({"command": "make"})));
        rig.wait_label("approval 1 Bash");
        rig.host.handle_claude_line(&agent.id, &recorded_question("q-1"));
        rig.wait_label("question 2 x2");

        let withdraw =
            |request_id: &str| json!({"type": "control_cancel_request", "request_id": request_id}).to_string();
        rig.host.handle_claude_line(&agent.id, &withdraw("someone-else"));
        rig.host.handle_claude_line(&agent.id, &withdraw("perm-1"));
        rig.host.handle_claude_line(
            &agent.id,
            &json!({"type": "control_cancel_request", "request": {"request_id": "q-1"}}).to_string(),
        );
        rig.wait_label("approved 1 Cancelled");
        rig.wait_label("answered 2 false");
        assert!(rig.host.respond(&agent.id, 1, ApprovalDecision::Allow).is_err());
        assert!(rig.host.answer(&agent.id, 2, None).is_err());

        // Anything else Claude asks is acknowledged on the spot.
        let hook = json!({"type": "control_request", "request_id": "hook-1",
            "request": {"subtype": "hook_callback", "callback_id": "c"}});
        rig.host.handle_claude_line(&agent.id, &hook.to_string());
        let ack = wait_sent(&log, "the acknowledgement", |value| reply_to(value, "hook-1"));
        assert_eq!(ack["response"]["response"], json!({}));
        assert_eq!(sent(&log).len(), 1, "a withdrawn request was answered anyway: {:?}", sent(&log));
    }

    #[tokio::test(start_paused = true)]
    async fn stopping_while_the_user_is_asked_does_not_put_the_agent_back_to_work() {
        let rig = rig();
        // Paused, so the stop's grace never runs out under this test.
        rig.host.set_runtime(tokio::runtime::Handle::current());
        let agent = rig.agent("claude", "ask");
        rig.host.test_install_claude(&agent.id);
        let (log, _) = recorder(&rig, &agent.id);
        rig.host.handle_claude_line(&agent.id, &permission("perm-1", "Bash", json!({"command": "make"})));
        rig.wait_label("approval 1 Bash");
        rig.host.handle_claude_line(&agent.id, &recorded_question("q-1"));
        rig.wait_label("question 2 x2");

        rig.host.stop(&agent.id).expect("stop");
        // Claude is still owed an answer to each, and is refused.
        let denied = wait_sent(&log, "the approval refused", |value| reply_to(value, "perm-1"));
        assert_eq!(denied["response"]["response"]["behavior"], "deny");
        let dismissed = wait_sent(&log, "the question dismissed", |value| reply_to(value, "q-1"));
        assert_eq!(dismissed["response"]["response"]["behavior"], "deny");
        assert!(rig.saw("approved 1 Deny"));
        assert!(rig.saw("answered 2 false"));
        assert_ne!(rig.status(&agent.id), "working", "the refusal undid the stop");
    }

    #[test]
    fn a_request_from_a_cli_crew_has_no_turn_for_is_refused_without_asking() {
        let rig = rig();
        let agent = rig.agent("claude", "ask");
        let (log, _) = recorder(&rig, &agent.id);
        rig.host.handle_claude_line(&agent.id, &permission("stray", "Bash", json!({"command": "make"})));
        let refused = wait_sent(&log, "the refusal", |value| reply_to(value, "stray"));
        assert_eq!(refused["response"]["response"]["behavior"], "deny");
        assert!(rig.events().is_empty());
        assert_eq!(rig.status(&agent.id), "idle");
    }

    #[tokio::test(start_paused = true)]
    async fn a_stopped_claude_is_interrupted_then_killed_after_a_grace() {
        let rig = rig();
        rig.host.set_runtime(tokio::runtime::Handle::current());
        let agent = rig.agent("claude", "ask");
        rig.host.test_install_claude(&agent.id);
        let (log, pid) = recorder(&rig, &agent.id);

        rig.host.stop(&agent.id).expect("stop");
        let interrupt = wait_sent(&log, "the interrupt", |value| value["type"] == "control_request");
        assert_eq!(interrupt["request_id"], "ctrl-1");
        assert_eq!(interrupt["request"], json!({"subtype": "interrupt"}));
        tokio::task::yield_now().await;

        // Until the grace is up it may still ask, and is refused without the
        // user being asked.
        rig.host.handle_claude_line(&agent.id, &permission("late", "Bash", json!({"command": "make"})));
        let refused = wait_sent(&log, "the refusal", |value| reply_to(value, "late"));
        assert_eq!(refused["response"]["response"]["behavior"], "deny");
        assert!(!rig.events().iter().any(|event| matches!(event, HarnessEvent::ApprovalRequested { .. })));
        assert!(alive(pid), "killed before its grace was up");

        tokio::time::advance(INTERRUPT_GRACE).await;
        tokio::time::sleep(Duration::from_millis(1)).await;
        gone(pid);
        assert!(rig.host.lock().get(&agent.id).is_none());
    }

    #[test]
    fn a_claude_turn_runs_through_the_cli_and_is_kept() {
        let rig = rig();
        let d = rig.dir.path();
        let agent = rig.agent("claude", "ask");
        // Capture 2 of the recording: the call, its permission request, and
        // after the answer the rest of the turn.
        let mut rest = recorded(CLAUDE_FIXTURE, 17, 19);
        rest.extend([
            claude_text("Both answered 200."),
            assistant(json!([{"type": "text", "text": "Both answered 200."}])),
            claude_result(),
        ]);
        rig.cli(
            "claude",
            &format!(
                "{}printf '%s\\0' \"$@\" > '{}'\nenv > '{}'\n{}{}{}{}{GATE}",
                pid_to(d, "pid"),
                d.join("args").display(),
                d.join("env").display(),
                claude_opening(d),
                say(&recorded(CLAUDE_FIXTURE, 14, 15)),
                hear(d, "reply.json"),
                say(&rest),
            ),
        );
        let shot = rig.path("shot.png");
        std::fs::write(&shot, [0x89, 0x50, 0x4e, 0x47]).expect("write image");
        let notes = rig.path("notes.txt");
        std::fs::write(&notes, "todo").expect("write notes");
        let attach = |path: &Path, kind| AttachedFile {
            name: path.file_name().expect("name").to_string_lossy().into_owned(),
            path: path.to_string_lossy().into_owned(),
            kind: Some(kind),
            size: None,
        };
        rig.host
            .start(TurnStart {
                files: Some(vec![attach(&shot, AttachedFileKind::Image), attach(&notes, AttachedFileKind::File)]),
                mentions: Some(vec!["src/lib.rs".into()]),
                ..rig.turn(&agent, "check both sites")
            })
            .expect("start");

        rig.wait_label("approval 1 Bash");
        assert_eq!(rig.status(&agent.id), "needs-input");
        rig.host.respond(&agent.id, 1, ApprovalDecision::Always).expect("respond");
        assert_eq!(rig.settle(&agent.id), "done");
        gone(pid_in(&rig.path("pid")));

        // What Crew told the CLI.
        let args = argv(&rig.path("args"));
        let flag = |name: &str| args.iter().position(|arg| arg == name).map(|at| args[at + 1].clone());
        let claude_session = flag("--session-id").expect("a session id");
        assert_eq!(flag("--permission-prompt-tool").as_deref(), Some("stdio"));
        assert!(flag("--append-system-prompt").expect("a persona").starts_with("You are Coder."));
        let mcp: Value = serde_json::from_str(&flag("--mcp-config").expect("the bridge")).expect("json");
        assert_eq!(mcp["mcpServers"]["crew"]["args"], json!(["--mcp"]));
        let env = std::fs::read_to_string(rig.path("env")).expect("env");
        assert!(env.lines().any(|line| line.starts_with("CREW_SOCKET=") && line.ends_with("crew.sock")), "{env}");
        assert!(env.lines().any(|line| line.len() > "CREW_TOKEN=".len() && line.starts_with("CREW_TOKEN=")));
        assert_eq!(read_json(&rig.path("init.json"))["request"], json!({"subtype": "initialize"}));

        let user = read_json(&rig.path("user.json"));
        assert_eq!(user["session_id"], claude_session.as_str());
        let content = user["message"]["content"].as_array().expect("content");
        assert_eq!(content[0]["source"]["media_type"], "image/png");
        let text = content[1]["text"].as_str().expect("text");
        assert!(text.starts_with("check both sites"), "{text}");
        assert!(text.contains("- src/lib.rs") && text.contains(&format!("- {}", notes.display())), "{text}");
        assert!(!text.contains("shot.png"), "an inlined image is listed as a path too: {text}");

        let reply = read_json(&rig.path("reply.json"));
        assert_eq!(reply["response"]["request_id"], "f0c27bde-7620-438a-841e-8248d88c5f2b");
        assert_eq!(
            reply["response"]["response"]["updatedPermissions"][0]["rules"],
            json!([{"toolName": "Bash", "ruleContent": "curl:*"}])
        );

        // What it said back, and what was kept of it.
        let events = rig.events();
        assert_eq!(
            said(&events),
            [
                "user: check both sites",
                "tool toolu_01NXryc1w4bSyP5MGzDE8Hbe Bash: curl -s -o /dev/null -w '%{http_code}' https://example.com",
                "approval 1 Bash",
                "approved 1 Always",
                "tool toolu_01NXryc1w4bSyP5MGzDE8Hbe Completed",
                "tool toolu_013rQ15PmtamphhcJbSN79S4 Bash: curl -s -o /dev/null -w '%{http_code}' https://example.org",
                "tool toolu_013rQ15PmtamphhcJbSN79S4 Completed",
                "delta: Both answered 200.",
                "turn done Some((Some(7), Some(5)))",
            ]
        );
        let binds: Vec<String> = labels(&events).into_iter().filter(|label| label.starts_with("bound ")).collect();
        assert_eq!(binds, [format!("bound {claude_session}"), "bound 9cf6b7f7-b8ab-4de7-86da-b03fb297fcd7".into()]);
        assert!(rig.saw("started"));
        assert_eq!(
            rig.session(&agent.id).provider_session_id.as_deref(),
            Some("9cf6b7f7-b8ab-4de7-86da-b03fb297fcd7")
        );

        let blocks = rig.persisted(&agent.id);
        assert_eq!(blocks[0].text, "check both sites");
        assert_eq!(blocks[0].files.as_ref().map(Vec::len), Some(2));
        let first = blocks
            .iter()
            .find_map(|block| block.tool.as_ref().filter(|tool| tool.call_id == "toolu_01NXryc1w4bSyP5MGzDE8Hbe"))
            .expect("the first call is kept");
        assert_eq!(first.status, ToolStatus::Completed);
        assert!(matches!(&first.detail, Some(ToolDetail::Command { output: Some(output), .. }) if output == "200"));
        assert!(blocks
            .iter()
            .any(|block| block.approval.as_ref().is_some_and(|a| a.decided == Some(ApprovalDecision::Always))));
        let last = blocks.last().expect("blocks");
        assert_eq!((last.role.clone(), last.text.as_str()), (BlockRole::Assistant, "Both answered 200."));
        assert!(last.usage.is_some());
    }

    #[test]
    fn a_claude_that_dies_mid_turn_fails_it_with_its_last_words() {
        let rig = rig();
        let d = rig.dir.path();
        let agent = rig.agent("claude", "full");
        let stderr: String = (1..=STDERR_TAIL + 2).map(|n| format!("echo 'trace {n}' >&2\n")).collect();
        rig.cli("claude", &format!("{}{}{stderr}exit 3\n", claude_opening(d), say(&[claude_text("Working")])));
        rig.start(&agent, "go");
        assert_eq!(rig.settle(&agent.id), "error");
        let tail: Vec<String> = (3..=STDERR_TAIL + 2).map(|n| format!("trace {n}")).collect();
        assert!(rig.saw("ended Some(3)"));
        assert!(
            rig.saw(&format!("error: Claude Code exited with code 3.\n{}", tail.join("\n"))),
            "{:?}",
            labels(&rig.events())
        );
    }

    #[test]
    fn a_claude_that_never_starts_says_why() {
        for (stderr, want) in [
            ("echo 'Invalid API key' >&2\n", "Claude Code did not start.\nInvalid API key"),
            ("", "Claude Code did not start."),
        ] {
            let rig = rig();
            let agent = rig.agent("claude", "ask");
            rig.cli("claude", &format!("read -r line\n{stderr}exit 1\n"));
            rig.start(&agent, "hello");
            assert_eq!(rig.settle(&agent.id), "error");
            assert!(rig.saw(&format!("error: {want}")), "{:?}", labels(&rig.events()));
            assert!(!rig.saw("started"));
        }
    }

    #[tokio::test(start_paused = true)]
    async fn a_claude_that_never_answers_is_given_up_on_and_stopped() {
        let rig = rig();
        rig.host.set_runtime(tokio::runtime::Handle::current());
        let d = rig.dir.path();
        let agent = rig.agent("claude", "ask");
        rig.cli("claude", &format!("{}{}{GATE}", pid_to(d, "pid"), hear(d, "init.json")));
        let began = tokio::time::Instant::now();
        rig.start(&agent, "hello");
        let pid = pid_in(&rig.path("pid"));
        eventually("the initialize request", || rig.path("init.json").exists());

        // Virtual time, a second at a time, until the start gives up.
        let deadline = std::time::Instant::now() + WITHIN;
        while rig.status(&agent.id) == "working" {
            assert!(std::time::Instant::now() < deadline, "the start never gave up");
            tokio::time::advance(Duration::from_secs(1)).await;
            std::thread::sleep(Duration::from_millis(2));
        }
        assert!(began.elapsed() >= INIT_TIMEOUT);
        assert_eq!(rig.status(&agent.id), "error");
        assert!(rig.saw("error: Claude Code did not answer in time."));
        gone(pid);
    }

    #[test]
    fn stopping_a_claude_turn_refuses_what_it_asked_and_kills_the_cli() {
        let rig = rig();
        let d = rig.dir.path();
        let agent = rig.agent("claude", "ask");
        let asks = [claude_text("Cleaning up"), permission("perm-1", "Bash", json!({"command": "rm -rf build"}))];
        rig.cli("claude", &format!("{}{}{}{GATE}", pid_to(d, "pid"), claude_opening(d), say(&asks)));
        rig.start(&agent, "clean");
        rig.wait_label("approval 1 Bash");

        rig.host.stop(&agent.id).expect("stop");
        assert_eq!(rig.settle(&agent.id), "idle");
        rig.wait_label("approved 1 Deny");
        gone(pid_in(&rig.path("pid")));
        assert!(rig.saw("ended None"));
        assert!(!labels(&rig.events()).iter().any(|label| label.starts_with("error")));
        assert_eq!(rig.persisted(&agent.id).last().map(|block| block.text.clone()).as_deref(), Some("Stopped"));
        assert_eq!(rig.status(&agent.id), "idle");
    }

    #[test]
    fn a_stop_while_claude_is_starting_ends_the_turn_quietly() {
        let rig = rig();
        let d = rig.dir.path();
        let agent = rig.agent("claude", "ask");
        rig.cli("claude", &format!("{}{}{GATE}", pid_to(d, "pid"), hear(d, "init.json")));
        rig.start(&agent, "hello");
        eventually("the initialize request", || rig.path("init.json").exists());

        rig.host.stop(&agent.id).expect("stop");
        assert_eq!(rig.settle(&agent.id), "idle");
        gone(pid_in(&rig.path("pid")));
        assert!(rig.saw("system: Stopped"));
        assert!(!labels(&rig.events()).iter().any(|label| label.starts_with("error")));
    }

    #[test]
    fn every_claude_turn_gets_a_fresh_cli_and_session() {
        let rig = rig();
        let d = rig.dir.path();
        let agent = rig.agent("claude", "ask");
        let pids = rig.path("pids");
        rig.cli(
            "claude",
            &format!("echo $$ >> '{}'\n{}{}{GATE}", pids.display(), claude_opening(d), say(&[claude_result()])),
        );
        // Whatever an earlier turn left behind is replaced, not reused.
        rig.host.test_install_claude(&agent.id);
        claude_live(&rig.host, &agent.id, |live| live.active = false);

        rig.start(&agent, "one");
        assert_eq!(rig.settle(&agent.id), "done");
        rig.start(&agent, "two");
        assert_eq!(rig.settle(&agent.id), "done");

        let binds: Vec<String> =
            labels(&rig.events()).into_iter().filter(|label| label.starts_with("bound ")).collect();
        assert_eq!(binds.len(), 2, "{binds:?}");
        assert_ne!(binds[0], binds[1]);
        let pids: Vec<i32> = std::fs::read_to_string(&pids)
            .expect("pids")
            .lines()
            .map(|line| line.parse().expect("pid"))
            .collect();
        assert_eq!(pids.len(), 2);
        assert_ne!(pids[0], pids[1]);
        for pid in pids {
            gone(pid);
        }
    }

    #[test]
    fn a_claude_turn_whose_message_cannot_be_sent_leaves_the_agent_free() {
        let rig = rig();
        let d = rig.dir.path();
        let agent = rig.agent("claude", "ask");
        // Ready, then deaf: it stops reading before the message comes.
        rig.cli(
            "claude",
            &format!(
                "{}{}exec 0<&-\n{}exec sleep 20\n",
                pid_to(d, "pid"),
                hear(d, "init.json"),
                say(&[claude_ready()])
            ),
        );
        rig.start(&agent, "hello");
        assert_eq!(rig.settle(&agent.id), "error");
        let pid = pid_in(&rig.path("pid"));
        assert!(
            rig.events().iter().any(|event| matches!(
                event,
                HarnessEvent::SessionError { message } if message.starts_with("Failed to write to agent")
            )),
            "{:?}",
            labels(&rig.events())
        );
        gone(pid);
        rig.host.start(rig.turn(&agent, "again")).expect("the next turn is refused");
        assert_eq!(rig.settle(&agent.id), "error");
    }

    #[tokio::test(start_paused = true)]
    async fn a_stop_does_not_kill_the_turn_that_follows_it() {
        let rig = rig();
        rig.host.set_runtime(tokio::runtime::Handle::current());
        let d = rig.dir.path();
        let agent = rig.agent("claude", "ask");
        rig.cli(
            "claude",
            &format!("{}{}{GATE}{}", claude_opening(d), say(&[claude_text("on it")]), say(&[claude_result()])),
        );
        rig.start(&agent, "first");
        rig.wait_label("delta: on it");
        rig.host.stop(&agent.id).expect("stop");
        // The stop's grace starts counting now.
        tokio::task::yield_now().await;
        assert_eq!(rig.settle(&agent.id), "idle");

        rig.start(&agent, "second");
        eventually("the second turn to be under way", || {
            labels(&rig.events()).iter().filter(|label| *label == "delta: on it").count() == 2
        });
        // The first turn's grace runs out while the second is working.
        tokio::time::advance(INTERRUPT_GRACE).await;
        tokio::time::sleep(Duration::from_millis(1)).await;
        rig.host
            .test_agents()
            .write(&agent.id, "go")
            .expect("the second turn's CLI was killed by the first one's stop");
        assert_eq!(rig.settle(&agent.id), "done");
    }

    /// A stream CLI that keeps its argv, env and pid, then prints `lines`.
    fn stream_cli(rig: &Rig, binary: &str, head: &str, lines: &[String]) {
        let d = rig.dir.path();
        rig.cli(
            binary,
            &format!(
                "{}printf '%s\\0' \"$@\" > '{}'\nenv > '{}'\n{head}{}",
                pid_to(d, "pid"),
                d.join("args").display(),
                d.join("env").display(),
                say(lines),
            ),
        );
    }

    #[test]
    fn a_codex_turn_replays_the_recording() {
        let rig = rig();
        let agent = rig.agent("codex", "ask");
        stream_cli(&rig, "codex", "", &recorded(CODEX_FIXTURE, 1, 4));
        rig.start(&agent, "ping?");
        assert_eq!(rig.settle(&agent.id), "done");

        let args = argv(&rig.path("args"));
        assert_eq!(args[0], "exec");
        assert!(args.windows(2).any(|pair| pair == ["--sandbox", "workspace-write"]), "{args:?}");
        assert!(args.iter().any(|arg| arg.starts_with("mcp_servers.crew.env=") && arg.contains("CREW_TOKEN")));
        let prompt = args.last().expect("prompt");
        assert!(prompt.starts_with("You are Coder.") && prompt.trim_end().ends_with("ping?"), "{prompt}");
        assert!(prompt.contains("`mcp__crew__message_agent`"), "{prompt}");

        assert_eq!(
            said(&rig.events()),
            ["user: ping?", "delta: pong", "message done", "message done", "turn done Some((Some(19094), Some(5)))"]
        );
        assert!(rig.saw("started"));
        assert_eq!(
            rig.session(&agent.id).provider_session_id.as_deref(),
            Some("01a068b3-442b-7101-acbd-df58756a43f6")
        );
        let blocks = rig.persisted(&agent.id);
        assert_eq!(texts(&blocks), [(BlockRole::User, "ping?"), (BlockRole::Assistant, "pong")]);
        assert!(blocks[1].usage.is_some());
    }

    #[test]
    fn a_codex_turn_the_provider_refuses_fails_with_its_reason() {
        let rig = rig();
        let agent = rig.agent("codex", "full");
        stream_cli(&rig, "codex", "", &recorded(CODEX_FIXTURE, 9, 13));
        rig.start(&agent, "hello");
        assert_eq!(rig.settle(&agent.id), "error");
        assert!(argv(&rig.path("args")).contains(&"--dangerously-bypass-approvals-and-sandbox".to_string()));
        assert!(rig.saw("error: The 'gpt-5.6' model is not supported when using Codex with a ChatGPT account."));
        assert!(said(&rig.events()).iter().any(|label| label.starts_with("note: Model metadata")));
    }

    #[test]
    fn a_cursor_turn_replays_the_recording() {
        let rig = rig();
        let agent = rig.agent("cursor", "full");
        stream_cli(&rig, "cursor-agent", "", &recorded(CURSOR_FIXTURE, 1, 8));
        rig.start(&agent, "Reply with the single word pong");
        assert_eq!(rig.settle(&agent.id), "done");

        let args = argv(&rig.path("args"));
        assert_eq!(&args[..5], ["-p", "--output-format", "stream-json", "--stream-partial-output", "--trust"]);
        assert!(args.contains(&"-f".to_string()));
        let prompt = args.last().expect("prompt");
        assert!(prompt.contains(" call message_agent '<json>'`"), "Cursor reaches Crew through its shell: {prompt}");
        assert!(std::fs::read_to_string(rig.path("env")).expect("env").contains("CREW_TOKEN="));

        assert_eq!(
            said(&rig.events()),
            [
                "user: Reply with the single word pong",
                "thinking: The user requested a",
                "thinking:  single-word reply: ",
                "thinking: \"pong\".",
                "delta: pong",
                "message done",
                "turn done Some((Some(20026), Some(34)))",
            ]
        );
        let blocks = rig.persisted(&agent.id);
        assert_eq!(
            blocks.last().map(|block| (block.role.clone(), block.text.as_str())),
            Some((BlockRole::Assistant, "pong"))
        );
    }

    #[test]
    fn an_opencode_turn_replays_the_recording() {
        let rig = rig();
        let d = rig.dir.path();
        let agent = rig.agent("opencode", "ask");
        let head = format!(
            "cat > '{}'\nprintf '%s' \"$OPENCODE_CONFIG_CONTENT\" > '{}'\n",
            d.join("prompt.txt").display(),
            d.join("config.json").display()
        );
        stream_cli(&rig, "opencode", &head, &recorded(OPENCODE_FIXTURE, 1, 7));
        rig.start(&agent, "What is the first line of sample.txt?");
        assert_eq!(rig.settle(&agent.id), "done");

        assert_eq!(argv(&rig.path("args")), ["run", "--format", "json"]);
        let prompt = std::fs::read_to_string(rig.path("prompt.txt")).expect("prompt");
        assert!(prompt.starts_with("You are Coder."), "{prompt}");
        assert!(prompt.contains("`crew_message_agent`"), "{prompt}");
        assert!(prompt.trim_end().ends_with("What is the first line of sample.txt?"), "{prompt}");
        assert_eq!(read_json(&rig.path("config.json"))["mcp"]["crew"]["command"][1], "--mcp");

        assert_eq!(
            said(&rig.events()),
            [
                "user: What is the first line of sample.txt?",
                "system: opencode decides its own permissions: it has no way to ask Crew, so it runs under your opencode config.",
                "tool call_632d6744456c4148abfcedee read: Read sample.txt",
                "tool call_632d6744456c4148abfcedee Completed",
                "tool call_2fde65bdd4f8460b987afa11 bash: echo done",
                "tool call_2fde65bdd4f8460b987afa11 Completed",
                "delta: The first line of `sample.txt` was **`hello from crew`**.",
                "message done",
                "message done",
                "turn done Some((Some(20637), Some(163)))",
            ]
        );
        assert_eq!(rig.session(&agent.id).provider_session_id.as_deref(), Some("ses_f52488128ffep0Jr7oGXPVw1Yt"));
    }

    #[test]
    fn a_stream_cli_that_dies_mid_turn_fails_it_with_its_last_words() {
        for (provider, binary, name, head) in [
            ("codex", "codex", "Codex", ""),
            ("cursor", "cursor-agent", "Cursor Agent", ""),
            ("opencode", "opencode", "opencode", "cat > /dev/null\n"),
        ] {
            let rig = rig();
            let agent = rig.agent(provider, "full");
            rig.cli(binary, &format!("{head}echo '{binary}: out of credits' >&2\nexit 7\n"));
            rig.start(&agent, "hello");
            assert_eq!(rig.settle(&agent.id), "error", "{provider}");
            assert!(rig.saw("ended Some(7)"), "{provider}");
            let want = format!("error: {name} exited with code 7.\n{binary}: out of credits");
            assert!(rig.saw(&want), "{provider}: {:?}", labels(&rig.events()));
        }
        // Killed outright, it has no code to report.
        let rig = rig();
        let agent = rig.agent("codex", "full");
        rig.cli("codex", "kill -9 $$\n");
        rig.start(&agent, "hello");
        assert_eq!(rig.settle(&agent.id), "error");
        assert!(rig.saw("ended None"));
        assert!(rig.saw("error: Codex stopped."), "{:?}", labels(&rig.events()));
    }

    #[test]
    fn stopping_a_streamed_turn_kills_the_cli_and_settles_it() {
        let rig = rig();
        let d = rig.dir.path();
        let agent = rig.agent("cursor", "ask");
        rig.cli("cursor-agent", &format!("{}{}{GATE}", pid_to(d, "pid"), say(&[cursor_text("on it")])));
        rig.start(&agent, "hello");
        rig.wait_label("delta: on it");

        rig.host.stop(&agent.id).expect("stop");
        assert_eq!(rig.settle(&agent.id), "idle");
        gone(pid_in(&rig.path("pid")));
        let events = said(&rig.events());
        assert_eq!(&events[events.len() - 2..], ["ended None", "system: Stopped"], "{events:?}");
        assert!(!events.iter().any(|label| label.starts_with("error")), "{events:?}");
    }

    #[test]
    fn a_cli_that_cannot_start_leaves_the_agent_free_for_the_next_turn() {
        for (provider, binary) in
            [("claude", "claude"), ("codex", "codex"), ("cursor", "cursor-agent"), ("opencode", "opencode")]
        {
            let rig = rig();
            let agent = rig.agent(provider, "full");
            rig.cli(binary, "exit 0\n");
            let nowhere = rig.path("gone").to_string_lossy().into_owned();
            let turn = || TurnStart { cwd: nowhere.clone(), ..rig.turn(&agent, "hello") };
            rig.host.start(turn()).expect("start");
            assert_eq!(rig.settle(&agent.id), "error", "{provider}");
            let want = format!("error: Working directory does not exist: {nowhere}");
            assert!(rig.saw(&want), "{provider}: {:?}", labels(&rig.events()));
            rig.host
                .start(turn())
                .unwrap_or_else(|error| panic!("{provider}: the next turn was refused: {error}"));
            assert_eq!(rig.settle(&agent.id), "error", "{provider}");
        }
    }

    #[test]
    fn a_letter_for_a_busy_agent_waits_for_its_turn_to_end() {
        let rig = rig();
        let d = rig.dir.path();
        let agent = rig.agent("cursor", "full");
        let reviewer = rig.agent("cursor", "full");
        let once = d.join("once");
        let result = json!({"type": "result", "subtype": "success", "result": "read it"}).to_string();
        rig.cli(
            "cursor-agent",
            &format!(
                "if [ ! -e '{once}' ]; then\ntouch '{once}'\n{}{GATE}fi\n{}",
                say(&[cursor_text("busy")]),
                say(&[result]),
                once = once.display(),
            ),
        );
        rig.start(&agent, "first");
        rig.wait_label("delta: busy");

        let store = rig.host.test_store();
        let from = AgentRef { id: reviewer.id.clone(), name: "Reviewer".into() };
        mailbox::enqueue(store, &agent.id, &from, "the branch is green").expect("enqueue");
        assert!(!rig.host.deliver_to(&agent), "a busy agent took a letter mid-turn");
        assert_eq!(mailbox::waiting_count(store, &agent.id), Ok(1));

        rig.host.test_agents().write(&agent.id, "go").expect("go");
        eventually("the letter to be read", || {
            rig.events().iter().filter(|event| matches!(event, HarnessEvent::TurnCompleted { .. })).count() == 2
                && rig.status(&agent.id) == "done"
        });
        assert_eq!(mailbox::waiting_count(store, &agent.id), Ok(0));
        let blocks = rig.persisted(&agent.id);
        let letter = blocks
            .iter()
            .find(|block| block.text == "the branch is green")
            .expect("the letter is in the transcript");
        assert_eq!(letter.from_agent.as_ref().map(|from| from.name.as_str()), Some("Reviewer"));
    }

    #[test]
    fn the_startup_sweep_hands_letters_to_idle_agents_only() {
        let rig = rig();
        let finished = [
            json!({"type": "text", "part": {"id": "p1", "type": "text", "text": "on it"}}).to_string(),
            json!({"type": "step_finish", "part": {"type": "step-finish", "reason": "stop"}}).to_string(),
        ];
        rig.cli("opencode", &format!("cat > /dev/null\n{}", say(&finished)));
        let store = rig.host.test_store();
        let idle = rig.agent("opencode", "full");
        let busy = rig.agent("opencode", "full");
        let asking = rig.agent("opencode", "full");
        let quiet = rig.agent("opencode", "full");
        let terminal = crate::session::create(
            store,
            rig.workspace.clone(),
            "terminal".into(),
            "Shell".into(),
            String::new(),
            String::new(),
            String::new(),
            "ask".into(),
        )
        .expect("terminal");
        let from = AgentRef { id: quiet.id.clone(), name: "Lead".into() };
        for session in [&idle, &busy, &asking, &terminal] {
            mailbox::enqueue(store, &session.id, &from, "status?").expect("enqueue");
        }
        crate::session::set_status(store, busy.id.clone(), "working".into()).expect("status");
        crate::session::set_status(store, asking.id.clone(), "needs-input".into()).expect("status");

        rig.host.deliver_waiting();
        eventually("the idle agent to read its letter", || {
            mailbox::waiting_count(store, &idle.id) == Ok(0) && rig.status(&idle.id) == "done"
        });
        for session in [&busy, &asking, &terminal] {
            assert_eq!(mailbox::waiting_count(store, &session.id), Ok(1), "{}", session.name);
        }
        assert_eq!(rig.status(&quiet.id), "idle");
        assert!(rig.persisted(&idle.id).iter().any(|block| block.text == "status?"));
    }

    #[test]
    fn an_opencode_turn_whose_prompt_cannot_be_sent_leaves_the_agent_free() {
        let rig = rig();
        let d = rig.dir.path();
        let agent = rig.agent("opencode", "full");
        // It never reads, and a prompt bigger than a pipe holds cannot be
        // handed to a CLI that does not.
        rig.cli("opencode", &format!("{}exec 0<&-\nexec sleep 20\n", pid_to(d, "pid")));
        let prompt = "x".repeat(256 * 1024);
        rig.start(&agent, &prompt);
        assert_eq!(rig.settle(&agent.id), "error");
        assert!(
            rig.events().iter().any(|event| matches!(
                event,
                HarnessEvent::SessionError { message } if message.starts_with("Failed to write to agent")
            )),
            "{:?}",
            said(&rig.events()).iter().map(|label| &label[..label.len().min(80)]).collect::<Vec<_>>()
        );
        gone(pid_in(&rig.path("pid")));
        rig.host.start(rig.turn(&agent, &prompt)).expect("the next turn is refused");
        assert_eq!(rig.settle(&agent.id), "error");
    }

    #[test]
    fn a_stop_that_lands_before_the_runner_starts_is_not_lost() {
        for (provider, binary) in
            [("claude", "claude"), ("codex", "codex"), ("cursor", "cursor-agent"), ("opencode", "opencode")]
        {
            let rig = rig();
            let agent = rig.agent(provider, "full");
            rig.cli(binary, &format!("{}exit 0\n", pid_to(rig.dir.path(), "pid")));
            // The turn was accepted; the stop arrives before its runner has
            // anything to cancel.
            rig.host.stop(&agent.id).expect("stop");
            rig.host.run_turn(agent.clone(), rig.turn(&agent, "hello"), None);
            assert_eq!(rig.status(&agent.id), "idle", "{provider}");
            assert!(rig.saw("system: Stopped"), "{provider}: {:?}", labels(&rig.events()));
            assert!(!rig.path("pid").exists(), "{provider}: the CLI was started anyway");
            assert!(rig.host.lock().get(&agent.id).is_none(), "{provider}");
        }
    }
}
