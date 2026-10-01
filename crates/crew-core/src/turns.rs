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
/// How long a child's Claude turn may wait, after a `result`, for the
/// background commands it left running: Claude picks the conversation up by
/// itself when they finish, with another `result`. Past this, the turn ends on
/// the result it had, so a server left running in the background cannot hold
/// it forever.
const BACKGROUND_GRACE: Duration = Duration::from_secs(600);
/// A self-addressed letter is how an agent keeps working. This many laps in a
/// row without anyone else speaking is a runaway, not a plan.
const MAX_SELF_TURNS: u32 = 25;
const STDERR_TAIL: usize = 12;
/// The four an agent reaches for on most turns: named here with their
/// arguments, so a turn that needs one does not first spend a `find_tool` on it.
const EVERYDAY: [&str; 4] = ["list_agents", "message_agent", "continue_after_turn", "search_messages"];

/// The Crew tools an agent is handed, spelled the way its own harness will
/// accept them.
///
/// The names matter more than they look. An agent told about `message_agent`
/// goes looking for `message_agent`, and what it finds is whatever else it has
/// of that shape — with Claude Code that is its own cross-session SendMessage,
/// which writes to another machine entirely. Measured, not guessed: it happened
/// in `scripts/drive.mjs` and the letter left the building.
///
/// For a provider with MCP: nothing is in `tools/list` but the gateway, so
/// every tool is spelled as a `call_tool` of it. Never the bare name on its
/// own, which is the one the agent cannot call.
fn tools_hint(spell: &dyn Fn(&str) -> String, hidden: &[&str]) -> String {
    let find = spell("find_tool");
    let call = spell("call_tool");
    let via = |name: &str, arguments: &str| format!("{call} with `{{\"name\": \"{name}\", \"arguments\": {arguments}}}`");
    let rest: Vec<&str> = hidden.iter().copied().filter(|name| !EVERYDAY.contains(name)).collect();
    format!(
        "Crew gives you tools through its crew MCP server. Only two are in your tool list: {find} \
         searches the rest by what you want to do and returns each with its arguments, and {call} \
         runs one by name. The ones most turns need:\n\
         - {} — the other agents here, each with the id it is addressed by.\n\
         - {} — write to one of them, by id. It arrives as a turn with your name and id on \
         it, and it is read in its own time. You are not waiting here, and anything it sends \
         back reaches you as a message of its own.\n\
         - {} — leave yourself the next step. It arrives as a new turn the moment this one \
         ends, with the tail of this conversation, so it is how you carry on past work that \
         does not fit in one turn.\n\
         - {} — look up what was already said in this conversation. It does not reach anybody \
         else's; what another agent knows, you ask it for.\n\
         - And, through {find} first: {}. One of your own tools whose name sounds like one of \
         these is not Crew's and does not reach this workspace.\n\n\
         A turn that opens with `## Message` was written by another agent, not by the user. \
         What you write in the chat is read by the user and does not reach that agent; \
         messaging the id on that line through {call} is what does.",
        via("list_agents", "{}"),
        via("message_agent", "{\"to\": \"<id>\", \"text\": \"…\"}"),
        via("continue_after_turn", "{\"text\": \"…\"}"),
        via("search_messages", "{\"query\": \"…\"}"),
        rest.join(", "),
    )
}

/// Claude and Codex namespace an MCP server's tools under its name.
fn mcp_tools_hint(hidden: &[&str]) -> String {
    tools_hint(&|tool| format!("`mcp__crew__{tool}`"), hidden)
}

/// opencode flattens them onto the server name instead.
fn opencode_tools_hint(hidden: &[&str]) -> String {
    tools_hint(&|tool| format!("`crew_{tool}`"), hidden)
}

/// Cursor has no MCP, so it reaches the same bridge through the `crew`
/// command, whose `--help` is the gateway: nothing to spell as JSON.
fn shell_tools_hint(crew: &str) -> String {
    format!(
        "Crew's tools are not in your tool list; they are commands of `{crew}`, run in the shell. \
         `{crew} --help` lists its groups (agents, sessions, messages, routines, processes, tabs) and \
         `{crew} <group> --help` what each does. The ones most turns need:\n\
         - `{crew} agents list` — the other agents here, each with the id it is addressed by.\n\
         - `{crew} agents send <id> <text>` — write to one of them, by id. It arrives as a turn \
         with your name and id on it, and it is read in its own time. You are not waiting here, \
         and anything it sends back reaches you as a message of its own.\n\
         - `{crew} agents continue <text>` — leave yourself the next step. It arrives as a new \
         turn the moment this one ends, with the tail of this conversation, so it is how you \
         carry on past work that does not fit in one turn.\n\
         - `{crew} messages search <query>` — look up what was already said in this \
         conversation. It does not reach anybody else's; what another agent knows, you ask it for.\n\
         A command that sounds like one of these but is not `{crew}` does not reach this workspace.\n\n\
         A turn that opens with `## Message` was written by another agent, not by the user. \
         What you write in the chat is read by the user and does not reach that agent; \
         `{crew} agents send` to the id on that line is what does."
    )
}

/// The provider conversation a child carries on, once its first turn bound
/// one. An agent never resumes: its memory is the tail Crew hands it.
fn child_resume(session: &crate::session::Session) -> Option<String> {
    (session.kind == "child")
        .then(|| session.provider_session_id.clone())
        .flatten()
        .filter(|id| !id.is_empty())
}

/// A message a child is handed from whoever started it: who it is from, then
/// the text. The persona already said what a report is.
fn child_envelope(from: &crew_protocol::AgentRef, text: &str) -> String {
    let who = match from.kind.as_deref() {
        Some("user") => "the user".to_string(),
        Some(kind) => format!("{} ({kind} {})", from.name, from.id),
        None => format!("{} (agent {})", from.name, from.id),
    };
    format!("## From {who}\n\n{text}")
}

/// What a child is told about Crew's tools: where they are, and that starting
/// sessions of its own is not among them.
fn child_tools_hint(spell: &dyn Fn(&str) -> String) -> String {
    format!(
        "Crew's tools reach you through its crew MCP server: {} searches them by what you want to do \
         (run or watch the workspace's dev servers, drive a browser tab, write to one of its agents) \
         and {} runs one. Starting sessions of your own is not among them: if the job needs more \
         hands, say so in your report.",
        spell("find_tool"),
        spell("call_tool")
    )
}

/// The same for Cursor, which reaches Crew through the `crew` command.
fn child_shell_hint(crew: &str) -> String {
    format!(
        "Crew's tools are commands of `{crew}` in your shell: `{crew} --help` lists them (processes, \
         tabs, agents). Starting sessions of your own is not among them: if the job needs more hands, \
         say so in your report."
    )
}

/// The `crew` beside `crewd`: the app ships the two together, and so does a
/// cargo build.
fn crew_beside(crewd: &str) -> String {
    std::path::Path::new(crewd).with_file_name("crew").to_string_lossy().into_owned()
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

/// A message written into a running Claude turn, not yet read by it.
struct Steer {
    /// Exactly what was written, to know its echo.
    sent: String,
    /// What the transcript shows, and who it is from.
    text: String,
    from: crew_protocol::AgentRef,
}

struct ClaudeLive {
    claude_session_id: String,
    /// Steers written and not yet echoed, oldest first.
    steers: Vec<Steer>,
    /// Background commands Claude started and has not heard the end of, by
    /// task id. While any is open, a child's `result` is not the end of its
    /// turn: the CLI carries on when they finish.
    background: HashSet<String>,
    /// Whether a `result` waits for those: a child's turn does, since its
    /// report is the last thing it says. An agent's ends on its first.
    waits_for_background: bool,
    /// Results that ended nothing yet, so the grace timer can tell its own
    /// wait from a later one.
    held_results: u64,
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
    /// The tool families beside Crew's own, so the sheet in an agent's prompt
    /// names theirs too.
    toolbox: crate::tools::Toolbox,
    /// Wakes whoever waits on a child session when one of its events lands.
    signal: crate::session_events::Signal,
    /// Child sessions being stopped for good, and who stopped them: the end of
    /// their turn is an exit, not a pause.
    exiting: Arc<Mutex<HashMap<String, String>>>,
    /// Sessions with a turn from `start` until its outcome is in, claimed in
    /// one step. The live CLI is installed later, on the turn's own thread, so
    /// a check on it alone let a message that arrived in between start a
    /// second turn on the same session.
    running: Arc<Mutex<HashSet<String>>>,
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
            toolbox: crate::tools::Toolbox::default(),
            signal: crate::session_events::Signal::default(),
            exiting: Arc::new(Mutex::new(HashMap::new())),
            running: Arc::new(Mutex::new(HashSet::new())),
        }
    }

    /// What a waiter on a child session sleeps on.
    pub fn waiters(&self) -> crate::session_events::Signal {
        self.signal.clone()
    }

    pub fn store(&self) -> &Store {
        &self.store
    }

    pub fn transcripts(&self) -> &TranscriptHub {
        &self.transcripts
    }

    /// The toolbox this host names tools from. Register a family here and the
    /// dispatcher that shares it runs it.
    pub fn toolbox(&self) -> crate::tools::Toolbox {
        self.toolbox.clone()
    }

    fn hidden_tools(&self) -> Vec<&'static str> {
        self.toolbox.hidden_names(crate::caller::CallerKind::Agent)
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

    /// The runtime, out of its lock. Matching on the lock's guard would keep
    /// it held for the whole arm — for `block_on`, the whole turn — and every
    /// other session's timers and turns would wait on it: one agent stopped on
    /// an approval froze every other agent's finish.
    fn handle(&self) -> Option<tokio::runtime::Handle> {
        self.runtime.lock().unwrap_or_else(|e| e.into_inner()).clone()
    }

    fn after(&self, dur: Duration, f: impl FnOnce() + Send + 'static) {
        if let Some(handle) = self.handle() {
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
        if let Some(handle) = self.handle() {
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
        let child = session.kind == "child";
        if session.kind != "agent" && !child {
            return Err("Not an agent session".into());
        }
        if child && session.status == "exited" {
            return Err("This session has exited. Start another one.".into());
        }
        {
            let mut running = self.running.lock().unwrap_or_else(|e| e.into_inner());
            let live = self.lock().get(&params.session_id).is_some_and(|live| match live {
                Live::Claude(row) => row.active,
                Live::Codex(row) | Live::Cursor(row) | Live::Opencode(row) => row.active,
            });
            if live || !running.insert(params.session_id.clone()) {
                return Err("Turn already running".into());
            }
        }
        self.clear_stop(&params.session_id);
        // A turn nobody else asked for is you: that clears the lap budget, so
        // the message the transcript tells you to send actually frees the loop.
        if params.from_agent.is_none() {
            self.loops
                .lock()
                .unwrap_or_else(|error| error.into_inner())
                .remove(&params.session_id);
        }
        // Read before the new message is appended: the tail is what the agent
        // is reminded of, and this turn is not history yet. A child carries on
        // its provider's own conversation instead, so it is handed none.
        let history = if child {
            None
        } else {
            working_set::history(
                &self
                    .transcripts
                    .window(&params.session_id, Some(working_set::TAIL_BLOCKS), None)
                    .blocks,
            )
        };
        let hidden = params.hidden.unwrap_or(false);
        match params.from_agent.clone() {
            Some(from) => {
                // The transcript keeps the letter as it was written: the
                // envelope is for the model, and the sender's name is already
                // on the block for the reader.
                self.transcripts
                    .append_from_agent(&params.session_id, &params.text, from.clone());
                params.text = if child {
                    child_envelope(&from, &params.text)
                } else {
                    mailbox::envelope(
                        &from,
                        &params.text,
                        params.sent_at.unwrap_or_else(crate::store::now_millis),
                        from.id == params.session_id,
                    )
                };
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
        let row = session.clone();
        let outcome = match session.provider.as_str() {
            "claude" => self.run_claude(session, params, history),
            "codex" => self.run_codex(session, params, history),
            "cursor" => self.run_cursor(session, params, history),
            "opencode" => self.run_opencode(session, params, history),
            other => TurnOutcome::Failed(format!(
                "{other} agents are not wired up yet. Pick Claude for now."
            )),
        };
        // The turn is over: the next one may start, and the drain below is
        // what starts it.
        self.running.lock().unwrap_or_else(|e| e.into_inner()).remove(&session_id);
        if row.kind == "child" {
            self.settle_child(&row, outcome);
            return;
        }
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
        self.drain_mailbox(&session_id);
    }

    /// Hand over the next letter waiting for an agent that has just gone quiet.
    /// This is also how an agent loops: it writes to itself, the letter cannot
    /// be delivered while it is working, and it arrives the moment it stops.
    ///
    /// The one place a letter is claimed, so two callers racing cannot lose one
    /// between them: the loser finds an empty box, which is the truth.
    pub fn drain_mailbox(&self, session_id: &str) -> bool {
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
        let cwd = crate::session::get(&self.store, session_id.to_string())
            .ok()
            .flatten()
            .and_then(|session| crate::session::cwd(&self.store, &session).ok())
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
        self.drain_mailbox(&target.id)
    }

    /// Letters left waiting for an idle agent — a delivery that raced a turn
    /// ending, or a daemon that stopped between the two — are invisible: only
    /// the end of a turn looks in a box. This is the sweep at startup.
    pub fn deliver_waiting(&self) {
        let Ok(sessions) = crate::session::list_all(&self.store) else {
            return;
        };
        for session in sessions {
            let idle = !matches!(session.status.as_str(), "working" | "needs-input" | "starting" | "exited");
            if !(session.kind == "agent" || session.kind == "child") || !idle {
                continue;
            }
            if mailbox::waiting_count(&self.store, &session.id).unwrap_or(0) > 0 {
                self.deliver_to(&session);
            }
        }
    }

    /// The end of a child session's turn, in the order a waiter depends on:
    /// the block that marks it, the status, the event at that block's
    /// position, the letter to an agent parent, and only then the wake-up.
    /// A message queued behind the turn goes over last, so the event it
    /// follows is already written.
    fn settle_child(&self, session: &crate::session::Session, outcome: TurnOutcome) {
        let id = session.id.as_str();
        let exit_by = self.exiting.lock().unwrap_or_else(|e| e.into_inner()).remove(id);
        let (kind, detail, status) = match (outcome, exit_by) {
            (_, Some(by)) => {
                self.transcripts.apply(id, HarnessEvent::SessionEnded { code: None });
                self.transcripts.append_system(id, &format!("Stopped by {by}. The session has exited; its transcript stays here."));
                ("exited", format!("stopped by {by}"), "exited")
            }
            (TurnOutcome::Completed, None) => {
                self.transcripts.append_system(id, "Turn ended");
                ("turn", "completed".to_string(), "idle")
            }
            (TurnOutcome::Failed(message), None) => {
                self.transcripts.apply(id, HarnessEvent::SessionError { message: message.clone() });
                ("error", message, "error")
            }
            (TurnOutcome::Stopped, None) => {
                self.transcripts.apply(id, HarnessEvent::SessionEnded { code: None });
                self.transcripts.append_system(id, "Stopped");
                ("turn", "stopped".to_string(), "idle")
            }
        };
        self.transcripts.set_status(id, status, None);
        self.transcripts.flush(id);
        self.child_event(session, kind, &detail, None);
        if status == "exited" {
            let _ = mailbox::drop_waiting(&self.store, id);
            return;
        }
        // Stopped from the window is the user saying enough: what is queued
        // waits for them, as it does for an agent.
        if detail != "stopped" {
            self.drain_mailbox(id);
        }
    }

    /// Write a child's event at the end of its transcript, tell an agent
    /// parent, and wake whoever waits.
    fn child_event(&self, session: &crate::session::Session, kind: &str, outcome: &str, request: Option<&Value>) {
        let id = session.id.as_str();
        let cursor = self.transcripts.len(id) as i64;
        let (_, report) = self.transcripts.since(id, cursor as usize);
        let report = if kind == "needs-input" { String::new() } else { report };
        if let Err(error) = crate::session_events::record(&self.store, id, cursor, kind, outcome, &report, request) {
            eprintln!("[crewd] session {id}: the event was not written: {error}");
        }
        self.report_to_parent(session, kind, outcome, &report, request);
        self.signal.notify();
    }

    /// A child stopped to ask. Only a child has anyone to tell.
    fn child_asks(&self, session_id: &str, request: Value) {
        let Ok(Some(session)) = session::get(&self.store, session_id.to_string()) else {
            return;
        };
        if session.kind == "child" {
            self.child_event(&session, "needs-input", "", Some(&request));
        }
    }

    /// An agent that started a session hears how each turn ended in its own
    /// box, so it does not have to sit in a wait to find out. A terminal or
    /// the user has no turns to hand it to: they wait, or read.
    fn report_to_parent(
        &self,
        session: &crate::session::Session,
        kind: &str,
        outcome: &str,
        report: &str,
        request: Option<&Value>,
    ) {
        let Some(parent) = session
            .parent_id
            .as_deref()
            .and_then(|id| session::get(&self.store, id.to_string()).ok().flatten())
        else {
            return;
        };
        if parent.kind != "agent" {
            return;
        }
        let what = match (kind, outcome) {
            ("turn", "completed") => "Its turn ended. Its report:".to_string(),
            ("turn", _) => "Its turn was stopped. What it said last:".to_string(),
            ("error", message) => format!("Its turn failed: {message}\nWhat it said last:"),
            ("exited", why) => format!("It exited ({why})."),
            _ => {
                let asked = request.map(|request| request.to_string()).unwrap_or_default();
                format!(
                    "It is waiting for an answer before it can go on. respond_to_session answers it, \
                     or the user does in Crew.\n{asked}"
                )
            }
        };
        let body = if report.trim().is_empty() { what } else { format!("{what}\n\n{}", report.trim()) };
        let from = crew_protocol::AgentRef {
            id: session.id.clone(),
            name: session.name.clone(),
            kind: Some("session".into()),
        };
        if mailbox::enqueue(&self.store, &parent.id, &from, &body).is_ok() {
            self.deliver_to(&parent);
        }
    }

    /// Stop a child for good: its turn ends as an exit. An idle child has no
    /// turn to end, so the caller settles it with [`TurnHost::exit_idle_child`].
    /// Returns whether a turn was running.
    pub fn exit_child(&self, session_id: &str, by: &str) -> bool {
        if !self.is_running(session_id) {
            return false;
        }
        self.exiting
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .insert(session_id.to_string(), by.to_string());
        self.cancel(session_id, true);
        true
    }

    /// An idle child that exits: there is no turn to end, so the block and the
    /// event are written here.
    pub fn exit_idle_child(&self, session: &crate::session::Session, why: &str, note: &str) {
        self.transcripts.append_system(&session.id, note);
        self.transcripts.set_status(&session.id, "exited", None);
        self.transcripts.flush(&session.id);
        let _ = mailbox::drop_waiting(&self.store, &session.id);
        self.child_event(session, "exited", why, None);
    }

    /// Children a restart of the daemon caught mid-turn: `settle_open_turns`
    /// left them `starting`. Each carries on in its own conversation, told
    /// why its turn broke off, so whoever waits on it still gets a report. One
    /// whose first turn never bound a conversation starts that turn again.
    pub fn resume_interrupted(&self) {
        let Ok(rows) = session::list_all(&self.store) else {
            return;
        };
        for row in rows.into_iter().filter(|row| row.kind == "child" && row.status == "starting") {
            if self.is_running(&row.id) {
                continue;
            }
            let cwd = session::cwd(&self.store, &row).unwrap_or_default();
            let (text, from, hidden) = if row.provider_session_id.is_some() {
                (
                    "Crew restarted while you were working, which broke off your last turn. Carry on where you \
                     left off; your final message is still your report."
                        .to_string(),
                    None,
                    Some(true),
                )
            } else {
                let (blocks, _) = self.transcripts.since(&row.id, 0);
                match blocks.into_iter().find(|block| block.role == crew_protocol::BlockRole::User) {
                    Some(first) => (first.text, first.from_agent, None),
                    None => {
                        self.transcripts.set_status(&row.id, "error", None);
                        self.child_event(&row, "error", "Crew restarted before its first turn began", None);
                        continue;
                    }
                }
            };
            self.transcripts.append_system(&row.id, "Crew restarted mid-turn; the turn carries on.");
            let started = self.start(TurnStart {
                session_id: row.id.clone(),
                cwd,
                text,
                files: None,
                mentions: None,
                hidden,
                from_agent: from,
                sent_at: None,
                nonce: None,
            });
            if let Err(error) = started {
                self.transcripts.apply(&row.id, HarnessEvent::SessionError { message: error.clone() });
                self.transcripts.set_status(&row.id, "error", None);
                self.child_event(&row, "error", &error, None);
            }
        }
    }

    /// Whether a session has a turn: from `start` until its outcome is in.
    pub fn is_running(&self, session_id: &str) -> bool {
        self.running.lock().unwrap_or_else(|e| e.into_inner()).contains(session_id)
    }

    /// Who started a child, the way it is told: "Planner (agent <id>)", or
    /// the user.
    fn parent_label(&self, session: &crate::session::Session) -> String {
        match session.parent_id.as_deref().and_then(|id| session::get(&self.store, id.to_string()).ok().flatten()) {
            Some(parent) => crate::caller::Caller::from_session(parent).label(),
            None => "the user".to_string(),
        }
    }

    /// The prompt of a child's turn for a CLI that takes it as one document:
    /// the envelope and the job on the first turn, the text alone once its
    /// conversation is being carried on.
    fn child_prompt(
        &self,
        session: &crate::session::Session,
        resumed: bool,
        tools: Option<&str>,
        params: &TurnStart,
    ) -> String {
        let text = crate::providers::with_files(params.text.trim(), &path_list(params, &HashSet::new()));
        if resumed {
            return text;
        }
        crate::providers::assemble(
            crate::providers::child_persona(&self.parent_label(session), tools),
            None,
            &text,
        )
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
            return TurnOutcome::Failed(error);
        }
        let outcome = self
            .block_on(turn_rx)
            .unwrap_or(TurnOutcome::Failed("Turn channel closed".into()));
        // A steer the turn ended before reading is not lost: it waits in the
        // box, and the end of this turn hands it over as the next one.
        let unread = match self.lock().get_mut(&session_id) {
            Some(Live::Claude(live)) => std::mem::take(&mut live.steers),
            _ => Vec::new(),
        };
        for steer in unread {
            let _ = mailbox::enqueue(&self.store, &session_id, &steer.from, &steer.text);
        }
        // The agent is disposable: the turn is over, so the CLI goes. What it
        // knew is in the transcript, and the next turn is handed the tail.
        self.agents.kill(&session_id);
        self.detach(&session_id);
        outcome
    }

    /// Write a message into a Claude child's running turn. Claude reads it at
    /// its next step and takes it into the turn it is in; its echo puts the
    /// message in the transcript. Refused when no Claude turn is live to take
    /// it, so the caller can queue it instead.
    pub fn steer(&self, session_id: &str, text: &str, from: crew_protocol::AgentRef) -> Result<(), String> {
        let sent = child_envelope(&from, text);
        let message = {
            let mut map = self.lock();
            let Some(Live::Claude(live)) = map.get_mut(session_id) else {
                return Err("No Claude turn is running to take it.".into());
            };
            if !live.active || live.cancelled || !live.initialized {
                return Err("No Claude turn is running to take it.".into());
            }
            live.steers.push(Steer { sent: sent.clone(), text: text.to_string(), from });
            build_claude_user_message(&live.claude_session_id, None, &sent, &[], &[])
        };
        if let Err(error) = self.agents.write(session_id, &serde_json::to_string(&message).unwrap_or_default()) {
            if let Some(Live::Claude(live)) = self.lock().get_mut(session_id) {
                live.steers.retain(|steer| steer.sent != sent);
            }
            return Err(error);
        }
        Ok(())
    }

    /// How much a turn may do alone: the session's own autonomy, unless
    /// Settings bypasses permissions for every session.
    fn autonomy(&self, session: &crate::session::Session) -> Autonomy {
        if session.autonomy == "full" || crate::session::bypass_permissions(&self.store) {
            Autonomy::Full
        } else {
            Autonomy::Ask
        }
    }

    /// A turn gets its own Claude session, every time. What the agent remembers
    /// is the tail Crew hands it, not whatever the CLI kept.
    fn ensure_claude(&self, session: &crate::session::Session, params: &TurnStart) -> Result<(), String> {
        let session_id = session.id.clone();
        let autonomy = self.autonomy(session);
        if self.lock().contains_key(&session_id) {
            self.agents.kill(&session_id);
            self.detach(&session_id);
        }
        // A child carries on its own conversation; an agent starts a clean one.
        let resume = child_resume(session);
        let claude_session_id = resume.clone().unwrap_or_else(|| uuid::Uuid::new_v4().to_string());

        let live = ClaudeLive {
            claude_session_id: claude_session_id.clone(),
            steers: Vec::new(),
            background: HashSet::new(),
            waits_for_background: session.kind == "child",
            held_results: 0,
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
        let persona = if session.kind == "child" {
            let hint = mcp.as_ref().map(|_| child_tools_hint(&|tool| format!("`mcp__crew__{tool}`")));
            crate::providers::child_persona(&self.parent_label(session), hint.as_deref())
        } else {
            let hint = mcp.as_ref().map(|_| mcp_tools_hint(&self.hidden_tools()));
            claude_persona(&session.name, &session.description, hint.as_deref())
        };
        let spawn = ClaudeSpawn {
            model: Some(session.model.clone()).filter(|m| !m.is_empty()),
            session_id: Some(claude_session_id.clone()),
            resume,
            replay_user_messages: session.kind == "child",
            system_prompt: Some(persona),
            autonomy,
            mcp_config: mcp.map(|(command, args)| crate::providers::claude::claude_mcp_config(&command, &args)),
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
        // A stop that came before the CLI was there to take it.
        if self.stop_requested(&session_id) {
            self.detach(&session_id);
            return TurnOutcome::Stopped;
        }
        let path = match self.resolve_bin("codex") {
            Ok(path) => path,
            Err(error) => return TurnOutcome::Failed(error),
        };
        let mcp = self.mcp();
        let hint = mcp.as_ref().map(|_| mcp_tools_hint(&self.hidden_tools()));
        // Minted once and used twice: the agent's own shell gets it, and so
        // does the MCP server codex starts for it. A second mint would retire
        // the first.
        let env = self.agent_env(&session_id);
        let resume = child_resume(&session);
        let prompt = if session.kind == "child" {
            let hint = mcp.as_ref().map(|_| child_tools_hint(&|tool| format!("`mcp__crew__{tool}`")));
            self.child_prompt(&session, resume.is_some(), hint.as_deref(), &params)
        } else {
            build_codex_prompt(
                &session.name,
                &session.description,
                history.as_deref(),
                &params.text,
                &path_list(&params, &HashSet::new()),
                hint.as_deref(),
            )
        };
        if let Err(error) = self.agents.spawn(
            session_id.clone(),
            path,
            build_codex_spawn_args(&CodexSpawn {
                prompt,
                resume,
                model: Some(session.model.clone()).filter(|m| !m.is_empty()),
                cwd: Some(params.cwd.clone()),
                autonomy: self.autonomy(&session),
                mcp,
                mcp_env: env.clone().into_iter().collect(),
            }),
            params.cwd,
            Some(env),
        ) {
            return TurnOutcome::Failed(error);
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
        // A stop that came before the CLI was there to take it.
        if self.stop_requested(&session_id) {
            self.detach(&session_id);
            return TurnOutcome::Stopped;
        }
        let path = match self.resolve_bin("cursor-agent") {
            Ok(path) => path,
            Err(error) => return TurnOutcome::Failed(error),
        };
        let mcp = self.mcp();
        // Cursor takes no MCP config, so the bridge is a command it runs.
        let resume = child_resume(&session);
        let prompt = if session.kind == "child" {
            let hint = mcp.as_ref().map(|(exe, _)| child_shell_hint(&crew_beside(exe)));
            self.child_prompt(&session, resume.is_some(), hint.as_deref(), &params)
        } else {
            let hint = mcp.as_ref().map(|(exe, _)| shell_tools_hint(&crew_beside(exe)));
            build_cursor_prompt(
                &session.name,
                &session.description,
                history.as_deref(),
                &params.text,
                &path_list(&params, &HashSet::new()),
                hint.as_deref(),
            )
        };
        if let Err(error) = self.agents.spawn(
            session_id.clone(),
            path,
            build_cursor_spawn_args(&CursorSpawn {
                prompt,
                model: Some(session.model.clone()).filter(|m| !m.is_empty()),
                autonomy: self.autonomy(&session),
                resume,
            }),
            params.cwd,
            Some(self.agent_env(&session_id)),
        ) {
            return TurnOutcome::Failed(error);
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
        // A stop that came before the CLI was there to take it.
        if self.stop_requested(&session_id) {
            self.detach(&session_id);
            return TurnOutcome::Stopped;
        }
        let path = match self.resolve_bin("opencode") {
            Ok(path) => path,
            Err(error) => return TurnOutcome::Failed(error),
        };
        let resume = child_resume(&session);
        let prompt = if session.kind == "child" {
            let hint = mcp.as_ref().map(|_| child_tools_hint(&|tool| format!("`crew_{tool}`")));
            self.child_prompt(&session, resume.is_some(), hint.as_deref(), &params)
        } else {
            let hint = mcp.as_ref().map(|_| opencode_tools_hint(&self.hidden_tools()));
            build_opencode_prompt(
                &session.name,
                &session.description,
                history.as_deref(),
                &params.text,
                &path_list(&params, &HashSet::new()),
                hint.as_deref(),
            )
        };
        // opencode has no approval channel: without --auto it falls back to the
        // user's own permission config, which Crew cannot answer for. Saying so
        // once beats an "ask" that silently never asks.
        let first = if session.kind == "child" { resume.is_none() } else { history.is_none() };
        if first && self.autonomy(&session) != Autonomy::Full {
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
                autonomy: self.autonomy(&session),
                resume,
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
        let mut hold: Option<u64> = None;
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
            if type_name.as_deref() == Some("system") {
                match subtype.as_deref() {
                    Some("task_started") if rec.get("is_backgrounded").and_then(Value::as_bool) == Some(true) => {
                        if let Some(task) = string_field(Some(&rec), "task_id") {
                            live.background.insert(task);
                        }
                    }
                    Some("task_notification") => {
                        if let Some(task) = string_field(Some(&rec), "task_id") {
                            live.background.remove(&task);
                        }
                    }
                    Some("task_updated") => {
                        let done = rec
                            .get("patch")
                            .and_then(|patch| patch.get("status"))
                            .and_then(Value::as_str)
                            .is_some_and(|status| matches!(status, "completed" | "failed" | "killed" | "stopped"));
                        if let (true, Some(task)) = (done, string_field(Some(&rec), "task_id")) {
                            live.background.remove(&task);
                        }
                    }
                    _ => {}
                }
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
                // A steer Claude has just taken in: it goes in the transcript
                // here, where the model read it.
                if let Some(echo) = crate::providers::claude::replayed_text(&rec) {
                    if let Some(at) = live.steers.iter().position(|steer| steer.sent.trim() == echo) {
                        let steer = live.steers.remove(at);
                        events.push(HarnessEvent::UserMessage {
                            text: steer.text,
                            hidden: None,
                            files: None,
                            from_agent: Some(steer.from),
                        });
                    }
                }
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
                if live.waits_for_background && !live.background.is_empty() && failed.is_none() && !live.cancelled {
                    // Not over: Claude carries on by itself once its
                    // background commands finish, and that is the report.
                    live.held_results += 1;
                    hold = Some(live.held_results);
                } else {
                    live.active = false;
                    if let Some(tx) = live.turn_tx.take() {
                        let _ = tx.send(match failed {
                            Some(message) => TurnOutcome::Failed(message),
                            None => TurnOutcome::Completed,
                        });
                    }
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
        if let Some(held) = hold {
            let host = self.clone();
            let id = session_id.to_string();
            self.after(BACKGROUND_GRACE, move || {
                let still = matches!(
                    host.lock().get(&id),
                    Some(Live::Claude(live)) if live.active && live.held_results == held
                );
                if still {
                    host.signal(&id, TurnOutcome::Completed);
                }
            });
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
            let asked = json!({ "request_id": ui_id, "kind": "question", "questions": questions });
            self.transcripts.apply(
                &session_id,
                HarnessEvent::QuestionRequested {
                    request_id: ui_id,
                    questions,
                },
            );
            self.child_asks(&session_id, asked);
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
        let asked = json!({
            "request_id": ui_id,
            "kind": "approval",
            "tool": tool_name,
            "title": title,
            "input": Value::Object(control.input.clone()),
        });
        self.transcripts.apply(
            &session_id,
            HarnessEvent::ApprovalRequested {
                request_id: ui_id,
                name: tool_name.clone(),
                title,
                input: Some(Value::Object(control.input.clone())),
            },
        );
        self.child_asks(&session_id, asked);
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
                steers: Vec::new(),
                background: HashSet::new(),
                waits_for_background: false,
                held_results: 0,
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
mod mailbox_tests {
    /// Measured: an agent stopped on an approval held the runtime's lock for
    /// as long as it waited, and a second agent's turn could not even arm its
    /// silence timer, so it never finished. One session waiting must not stop
    /// another.
    #[test]
    fn a_turn_waiting_forever_does_not_hold_up_another_sessions_timers() {
        let runtime = tokio::runtime::Builder::new_multi_thread()
            .worker_threads(2)
            .enable_all()
            .build()
            .unwrap();
        let host = TurnHost::test_new();
        host.set_runtime(runtime.handle().clone());
        let (_hold, never) = tokio::sync::oneshot::channel::<()>();
        let waiting = host.clone();
        std::thread::spawn(move || {
            let _ = waiting.block_on(never);
        });
        std::thread::sleep(Duration::from_millis(100));
        let (tx, rx) = std::sync::mpsc::channel();
        let armed = host.clone();
        std::thread::spawn(move || armed.after(Duration::from_millis(1), move || {
            let _ = tx.send(());
        }));
        assert!(
            rx.recv_timeout(Duration::from_secs(3)).is_ok(),
            "a timer armed while another session waits never fired"
        );
    }

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
            &AgentRef::agent(coder.id.clone(), "Coder"),
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

    /// The setting overrides an agent that asks: its next turn is spawned the
    /// way a "full" one is, and turning it off gives the agent its own back.
    #[test]
    fn bypass_permissions_runs_an_asking_agent_without_asking() {
        let world = world();
        let argv = world.dir.join("argv.txt");
        let fake = world.dir.join("fake-opencode-argv");
        std::fs::write(
            &fake,
            format!(
                r#"#!/usr/bin/env python3
import json, sys
open({argv:?}, "w").write(json.dumps(sys.argv[1:]))
sys.stdin.read()
sid = "ses_test"
print(json.dumps({{"type":"text","sessionID":sid,"part":{{"id":"p1","type":"text","text":"ok"}}}}), flush=True)
print(json.dumps({{"type":"step_finish","sessionID":sid,"part":{{"id":"s1","type":"step-finish","reason":"stop","tokens":{{"input":1,"output":1,"reasoning":0,"cache":{{"read":0,"write":0}}}},"cost":0}}}}), flush=True)
"#,
                argv = argv.to_string_lossy()
            ),
        )
        .expect("write fake");
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&fake, std::fs::Permissions::from_mode(0o755)).expect("chmod");
        world.host.override_binary("opencode", fake.to_string_lossy().into_owned());
        let ws = workspace(&world);
        let asker = crate::session::create(
            world.host.test_store(),
            ws,
            "agent".into(),
            "Asker".into(),
            "opencode".into(),
            "m".into(),
            "".into(),
            "ask".into(),
        )
        .expect("agent");
        let ran_auto = || {
            let raw = std::fs::read_to_string(&argv).expect("the provider was never spawned");
            serde_json::from_str::<Vec<String>>(&raw).expect("argv").iter().any(|arg| arg == "--auto")
        };

        turn(&world, &asker, "one");
        assert!(!ran_auto(), "an asking agent asks by default");

        crate::store::set(world.host.test_store(), crate::session::BYPASS_KEY.into(), "on".into()).expect("set");
        turn(&world, &asker, "two");
        assert!(ran_auto(), "bypass runs it without asking");

        crate::store::delete(world.host.test_store(), crate::session::BYPASS_KEY.into()).expect("delete");
        turn(&world, &asker, "three");
        assert!(!ran_auto(), "off again, it asks again");
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
            &AgentRef::agent(coder.id.clone(), "Coder"),
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
            &AgentRef::agent(coder.id.clone(), "Coder"),
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
            &AgentRef::agent(coder.id.clone(), "Coder"),
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
        let me = AgentRef::agent(coder.id.clone(), "Coder");
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
            &AgentRef::agent(coder.id.clone(), "Coder"),
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
        let me = AgentRef::agent(coder.id.clone(), "Coder");
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
        let me = AgentRef::agent(coder.id.clone(), "Coder");
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
        let mcp = mcp_tools_hint(&crate::tools::hidden_names());
        assert!(
            mcp.contains(r#"`mcp__crew__call_tool` with `{"name": "message_agent", "arguments": {"to": "<id>", "text": "…"}}`"#),
            "{mcp}"
        );
        assert!(mcp.contains("`mcp__crew__find_tool`"), "{mcp}");
        let opencode = opencode_tools_hint(&crate::tools::hidden_names());
        assert!(opencode.contains(r#"`crew_call_tool` with `{"name": "message_agent""#), "{opencode}");
        let shell = shell_tools_hint("/usr/local/bin/crew");
        assert!(shell.contains("`/usr/local/bin/crew agents send <id> <text>`"), "{shell}");

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

    /// Nothing but the gateway is in `tools/list`, and the sheet names it.
    #[test]
    fn a_tool_sheet_covers_the_whole_standing_set() {
        let standing: Vec<&str> = crate::tools::standing(crate::caller::CallerKind::Agent).iter().map(|tool| tool.name).collect();
        assert_eq!(standing, ["find_tool", "call_tool"]);
        for sheet in [mcp_tools_hint(&crate::tools::hidden_names()), opencode_tools_hint(&crate::tools::hidden_names())] {
            for name in standing.iter() {
                assert!(sheet.contains(name), "{name} is not on the sheet: {sheet}");
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
        for sheet in [mcp_tools_hint(&crate::tools::hidden_names()), opencode_tools_hint(&crate::tools::hidden_names())] {
            for name in crate::tools::hidden_names() {
                assert!(sheet.contains(name), "{name} is not on the sheet: {sheet}");
            }
        }
        // For Cursor the gateway is `crew --help`, and the sheet names its groups.
        let shell = shell_tools_hint("crew");
        for group in ["agents", "messages", "routines", "processes", "tabs"] {
            assert!(shell.contains(group), "{group} is not on the sheet: {shell}");
        }
    }

    #[test]
    fn crew_is_found_beside_crewd() {
        assert_eq!(crew_beside("/Applications/Crew.app/Contents/Resources/crewd"), "/Applications/Crew.app/Contents/Resources/crew");
    }
}
