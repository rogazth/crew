use std::collections::{HashMap, HashSet};
use std::future::Future;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::mpsc::{self, Sender};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant};

use tokio::sync::oneshot;

use crew_protocol::{
    ApprovalDecision, ApprovalResolution, ContextReading, HarnessEvent, ToolStatus, TurnStart, TurnStarted, TurnUsage,
};
use serde_json::{json, Map, Value};

use crate::agent::AgentHost;
use crate::bridge::Bridge;
use crate::providers::claude::{
    assistant_context, assistant_text_blocks, assistant_tool_uses, build_claude_spawn_args, build_claude_user_message,
    build_control_request, build_control_response, get_context_usage_request, get_task_output_request,
    input_json_delta_from_event, is_compact_boundary, is_message_start, is_subagent_message,
    parse_context_usage, permission_mode, parse_control_cancel_id, parse_control_request, parse_control_response, parse_questions,
    result_context_window, stop_task_request,
    session_id_from_message, stream_text_delta, to_permission_result,
    to_question_result, tool_detail as claude_tool_detail, tool_label as claude_tool_label,
    tool_result_detail as claude_tool_result_detail, tool_result_files as claude_tool_result_files,
    tool_results_from_user_message, tool_start_from_event,
    try_parse_json_record, turn_failed as claude_turn_failed, turn_usage as claude_turn_usage, ClaudeControlRequest,
    ClaudeSpawn, Subagents,
};
use crate::providers::parse_json_line;
use crate::providers::opencode::{
    opencode_turn_config, step_failure as opencode_step_failure, build_opencode_message,
    add_step_usage, build_opencode_prompt, build_opencode_spawn_args,
    parse_tool_call as parse_opencode_tool_call, session_id_from_event as opencode_session_id,
    stream_error_message as opencode_error_message, text_part, turn_ended, OpencodeSpawn, OpencodeText,
};
use crate::providers::{string_field, Autonomy};
use crate::mailbox;
pub(crate) use crate::prompts::Harness;
use crate::session;
use crate::working_set;
use crate::store::Store;
use crate::transcript::TranscriptHub;

mod codex;
mod cursor;
use codex::CodexLive;
use cursor::CursorLive;
#[cfg(test)]
pub(crate) use codex::fake_codex;
#[cfg(test)]
pub(crate) use cursor::{fake_cursor, ACP_NOTE as CURSOR_ACP_NOTE};

const INIT_TIMEOUT: Duration = Duration::from_secs(15);
/// How long a provider may stay silent before its first line.
const FIRST_OUTPUT_TIMEOUT: Duration = Duration::from_secs(120);
const INTERRUPT_GRACE: Duration = Duration::from_millis(1500);
/// How long Claude may take to answer a control request of Crew's own.
#[cfg(not(test))]
const CONTROL_TIMEOUT: Duration = Duration::from_secs(5);
#[cfg(test)]
const CONTROL_TIMEOUT: Duration = Duration::from_secs(2);
/// A `set_model` is not answered until the CLI has checked the model with the
/// server, which it gives up on after 5 s of its own (measured on 2.1.295:
/// answers at 0.9 to 2 s, and in about 1 run in 8 at 5.0 to 5.6 s, for a full
/// model id the CLI does not already know). The wait has to outlast that
/// deadline, or the process is launched again for nothing.
#[cfg(not(test))]
const SET_MODEL_TIMEOUT: Duration = Duration::from_secs(20);
#[cfg(test)]
const SET_MODEL_TIMEOUT: Duration = Duration::from_secs(10);

/// What a control request that waited out its timeout fails with.
const NO_ANSWER: &str = "Claude Code did not answer in time.";

/// How long the answer to this control request is waited for.
fn control_timeout(request: &Value) -> Duration {
    match request.get("subtype").and_then(Value::as_str) {
        Some("set_model") => SET_MODEL_TIMEOUT,
        _ => CONTROL_TIMEOUT,
    }
}
/// How long a child's Claude turn may wait, after a `result`, for the
/// background commands it left running: Claude picks the conversation up by
/// itself when they finish, with another `result`. Past this, the turn ends on
/// the result it had, so a server left running in the background cannot hold
/// it forever.
const BACKGROUND_GRACE: Duration = Duration::from_secs(if cfg!(test) { 4 } else { 600 });
/// How long a session's process stays up with no turn on it before it is let
/// go. A process holds its CLI and its MCP servers in memory; the next message
/// resumes the conversation by its provider id, so letting go costs only the
/// warm start.
pub const RELEASE_AFTER: Duration = Duration::from_secs(30 * 60);
/// How long a process that background work pins stays up past
/// [`RELEASE_AFTER`]. t3code keeps such a process up to four hours, then lets
/// it go whatever still runs in it.
pub const PIN_CAP: Duration = Duration::from_secs(4 * 60 * 60);
const STDERR_TAIL: usize = 12;
/// Whether a session running with `autonomy` would do what `request` asks
/// without asking anyone: what a parent may decide for its child. Full does
/// anything; edits (and auto, whose reviewer Crew cannot speak for) only
/// file edits; ask nothing. A process runs a command, so it takes full.
pub(crate) fn may_decide(autonomy: &Autonomy, request: &Value) -> bool {
    match autonomy {
        Autonomy::Full => true,
        Autonomy::Ask => false,
        Autonomy::Edits | Autonomy::Auto => {
            request.get("kind").and_then(Value::as_str) == Some("approval")
                && request
                    .get("tool")
                    .and_then(Value::as_str)
                    .is_some_and(|tool| EDIT_TOOLS.contains(&tool.to_ascii_lowercase().as_str()))
        }
    }
}

/// The tools an approval names when all it does is change a file.
const EDIT_TOOLS: [&str; 6] = ["edit", "write", "multiedit", "notebookedit", "filechange", "apply_patch"];

/// Who a session's turns are for, and so how Crew drives it.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Driven {
    /// A bot: every turn is a clean provider session with the tail Crew hands
    /// it, under a persona.
    Bot,
    /// A subagent: it carries on the provider's own conversation, under a
    /// persona that says who started it.
    Child,
    /// A top-level session in the chat view: the user's own CLI, run by Crew
    /// over the provider's protocol. It carries on the provider's own
    /// conversation and is told nothing their CLI would not be.
    User,
}

impl Driven {
    /// Whether the provider's own store carries the conversation from turn to
    /// turn: the next one resumes it by its provider id and is handed no tail.
    fn carries_conversation(self) -> bool {
        self != Driven::Bot
    }
}

/// How Crew drives `session`, if it does. A terminal in the terminal view is
/// the user at the keyboard of its CLI, and no turn of ours may run beside it.
/// The one place that says which sessions are driven; the checks that mean
/// "carries the provider's conversation" or "is the user's own" ask it.
fn driven(session: &crate::session::Session) -> Option<Driven> {
    match (session.kind.as_str(), session.view.as_str()) {
        ("bot", _) => Some(Driven::Bot),
        ("child", _) => Some(Driven::Child),
        ("terminal", "chat") => Some(Driven::User),
        _ => None,
    }
}

/// Whether `letter` is the user's own message to a session that is theirs: it
/// reaches the model as they typed it, with no envelope.
fn is_own(drive: Driven, letter: &mailbox::Letter) -> bool {
    drive == Driven::User && letter.from.kind.as_deref() == Some("user")
}

/// Whether `session` carries on the provider's own conversation.
fn carries_conversation(session: &crate::session::Session) -> bool {
    driven(session).is_some_and(Driven::carries_conversation)
}

/// The provider conversation a session carries on, once its first turn bound
/// one. A bot never resumes: its memory is the tail Crew hands it.
fn conversation_to_resume(session: &crate::session::Session) -> Option<String> {
    carries_conversation(session)
        .then(|| session.provider_session_id.clone())
        .flatten()
        .filter(|id| !id.is_empty())
}

/// Whether the process a turn ran on stays up for the session's next one.
/// Only a session that carries the provider's conversation keeps it: a bot
/// starts a clean provider session every turn, with the tail Crew hands it,
/// so a process kept for it would carry nothing it may use. This is the one
/// place that says so.
fn keeps_process(session: &crate::session::Session) -> bool {
    carries_conversation(session)
}

/// Names one CLI process, so a timer or a watcher armed for it can tell when
/// its own is gone and a later one has taken the session's place.
static NEXT_EPOCH: AtomicU64 = AtomicU64::new(1);

/// What a process was launched with, to tell on the next turn whether the
/// session still asks for it. A kept process runs on these however the
/// session's row changed since; a turn that finds them different tells the
/// process (Claude: [`claude_plan`], Codex: overrides on `turn/start`) or,
/// where it cannot be told, lets it go and launches another on the same
/// conversation.
#[derive(Clone, Debug, PartialEq, Eq)]
struct Launch {
    model: Option<String>,
    effort: Option<String>,
    service_tier: Option<String>,
    autonomy: Autonomy,
    cwd: String,
}

impl Launch {
    /// Whether these settings clear one that `old` had set: a model, effort
    /// or tier back to the CLI's own. Neither CLI has a way to take an
    /// override back, so a process that has it must go.
    fn clears_a_setting_of(&self, old: &Launch) -> bool {
        let cleared = |new: &Option<String>, old: &Option<String>| new.is_none() && old.is_some();
        cleared(&self.model, &old.model)
            || cleared(&self.effort, &old.effort)
            || cleared(&self.service_tier, &old.service_tier)
    }

    /// What a kept Codex process is told on its next `turn/start`: the
    /// settings that moved since `since`, what it ran with. Access goes as its
    /// three fields together, or not at all.
    fn turn_overrides_since(&self, since: &Launch) -> Map<String, Value> {
        let mut params = crate::providers::codex::turn_overrides(
            self.model.as_deref(),
            self.effort.as_deref(),
            self.service_tier.as_deref(),
            &self.autonomy,
            &self.cwd,
        );
        let same = [
            ("model", self.model == since.model),
            ("effort", self.effort == since.effort),
            ("serviceTier", self.service_tier == since.service_tier),
            ("cwd", self.cwd == since.cwd),
            ("approvalPolicy", self.autonomy == since.autonomy),
            ("approvalsReviewer", self.autonomy == since.autonomy),
            ("sandboxPolicy", self.autonomy == since.autonomy),
        ];
        for (key, unchanged) in same {
            if unchanged {
                params.remove(key);
            }
        }
        params
    }
}

/// One setting of a kept Claude process that the CLI takes while it idles.
#[derive(Clone, Debug, PartialEq, Eq)]
enum Change {
    Model(String),
    Effort(String),
    /// Between Ask, Edits and Auto. Full is a launch flag.
    Permission(Autonomy),
    /// The service tier moved. `fast` is what the `fastMode` setting becomes,
    /// when it has to be said: asked for only where the account may use it,
    /// as at launch, and otherwise only to turn it off.
    Tier { tier: Option<String>, fast: Option<bool> },
}

impl Change {
    /// The control request that makes it so; none when only Crew's record moves.
    fn request(&self) -> Option<Value> {
        match self {
            Change::Model(model) => Some(json!({ "subtype": "set_model", "model": model })),
            Change::Effort(effort) => {
                Some(json!({ "subtype": "apply_flag_settings", "settings": { "effortLevel": effort } }))
            }
            Change::Permission(autonomy) => {
                Some(json!({ "subtype": "set_permission_mode", "mode": permission_mode(autonomy) }))
            }
            Change::Tier { fast, .. } => {
                fast.map(|on| json!({ "subtype": "apply_flag_settings", "settings": { "fastMode": on } }))
            }
        }
    }

    /// Once the process has taken it, what it is running on.
    fn record(self, applied: &mut Launch) {
        match self {
            Change::Model(model) => applied.model = Some(model),
            Change::Effort(effort) => applied.effort = Some(effort),
            Change::Permission(autonomy) => applied.autonomy = autonomy,
            Change::Tier { tier, .. } => applied.service_tier = tier,
        }
    }
}

/// What a kept Claude process needs to run on new settings.
#[derive(Debug, PartialEq, Eq)]
enum Plan {
    /// The CLI takes these as they are, one control request each.
    Changes(Vec<Change>),
    /// Something it cannot change while it runs: it is launched again on the
    /// same conversation. The cwd, Full autonomy (`--dangerously-skip-permissions`
    /// is a launch flag), and a model or effort back to the CLI's own (there
    /// is no request that takes one back). The question tool follows the
    /// session's kind, which never changes, so it is not compared.
    Relaunch,
}

/// The one place that says which differences a kept Claude process takes in
/// place. `fast_allowed` is whether the account may use fast mode.
fn claude_plan(old: &Launch, new: &Launch, fast_allowed: bool) -> Plan {
    if old.cwd != new.cwd {
        return Plan::Relaunch;
    }
    let mut changes = Vec::new();
    if old.model != new.model {
        match &new.model {
            Some(model) => changes.push(Change::Model(model.clone())),
            None => return Plan::Relaunch,
        }
    }
    if old.effort != new.effort {
        match &new.effort {
            Some(effort) => changes.push(Change::Effort(effort.clone())),
            None => return Plan::Relaunch,
        }
    }
    if old.autonomy != new.autonomy {
        if old.autonomy == Autonomy::Full || new.autonomy == Autonomy::Full {
            return Plan::Relaunch;
        }
        changes.push(Change::Permission(new.autonomy.clone()));
    }
    if old.service_tier != new.service_tier {
        let fast = |tier: &Option<String>| tier.as_deref() == Some("fast");
        let want = fast(&new.service_tier) && fast_allowed;
        changes.push(Change::Tier {
            tier: new.service_tier.clone(),
            fast: (want || fast(&old.service_tier)).then_some(want),
        });
    }
    Plan::Changes(changes)
}

#[cfg(test)]
impl Launch {
    /// Settings no session has, for a process a test installs by hand.
    fn none() -> Self {
        Self { model: None, effort: None, service_tier: None, autonomy: Autonomy::Ask, cwd: String::new() }
    }
}

/// An opencode turn's persona, on disk for as long as the turn runs:
/// `instructions` in its config names files, never text.
struct InstructionsFile(std::path::PathBuf);

impl Drop for InstructionsFile {
    fn drop(&mut self) {
        let _ = std::fs::remove_file(&self.0);
    }
}

/// Written readable by the user alone, since a persona is the user's text.
fn write_opencode_instructions(session_id: &str, persona: &str) -> Option<InstructionsFile> {
    use std::io::Write as _;
    use std::os::unix::fs::OpenOptionsExt as _;
    let dir = std::env::temp_dir().join("crew-opencode");
    std::fs::create_dir_all(&dir).ok()?;
    let path = dir.join(format!("{session_id}.md"));
    let mut file = std::fs::OpenOptions::new().write(true).create(true).truncate(true).mode(0o600).open(&path).ok()?;
    file.write_all(persona.as_bytes()).ok()?;
    Some(InstructionsFile(path))
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
    from: crew_protocol::BotRef,
    /// The letter it is, claimed while the turn has not read it yet.
    letter: Option<String>,
}

impl Steer {
    /// The turn ended before reading it: it goes back in the box, under the
    /// id it was written with, and the end of the turn hands it over as the
    /// next one.
    fn put_back(self, store: &crate::store::Store, session_id: &str) {
        match self.letter {
            Some(id) => {
                let _ = mailbox::release(store, &id);
            }
            None => {
                let _ = mailbox::enqueue(store, session_id, &self.from, &self.text);
            }
        }
    }
}

/// The note that says what woke the model, once it speaks: every summary held
/// since it last did, as one line.
fn woken(live: &mut ClaudeLive, events: &mut Vec<HarnessEvent>) {
    if live.woken_by.is_empty() {
        return;
    }
    events.push(HarnessEvent::SessionNote {
        message: std::mem::take(&mut live.woken_by).join(" · "),
    });
}

/// One Claude Code process and the conversation it carries. What lives as long
/// as the process is the conversation's id, the request counters, the control
/// calls in flight, the stderr tail and the launch settings; the rest belongs
/// to the turn that is running and starts over in [`ClaudeLive::begin_turn`].
struct ClaudeLive {
    epoch: u64,
    /// Turns begun on this process, so a timer armed in one cannot act on a
    /// later one.
    turn: u64,
    /// What it was launched with.
    applied: Launch,
    claude_session_id: String,
    /// Whether a result waits for the background commands: a child's turn
    /// does, since its report is the last thing it says, and so does the
    /// user's, whose answer is what the commands made of the work (ending it
    /// on the first result would let go of the process, and of them). A bot's
    /// ends on its first.
    waits_for_background: bool,
    /// Results that ended nothing yet, so the grace timer can tell its own
    /// wait from a later one. Counts on for the life of the process: it is
    /// never started over, so a timer of an earlier turn cannot find it equal.
    held_results: u64,
    /// Control requests Crew sent and waits on, by request id.
    calls: HashMap<String, Sender<Result<Value, String>>>,
    next_ui: u64,
    next_control: u64,
    /// Whether the CLI has said it is up. It says it again at the start of
    /// every turn, which tells nothing new.
    initialized: bool,
    /// Only while the process is being launched: what waits for its first word.
    init_tx: Option<oneshot::Sender<bool>>,
    stderr: Vec<String>,
    /// Steers written and not yet echoed, oldest first.
    steers: Vec<Steer>,
    /// Background commands Claude started and has not heard the end of, by
    /// task id. While any is open, a child's `result` is not the end of its
    /// turn: the CLI carries on when they finish.
    background: HashSet<String>,
    /// What the background work that finished says of itself, held until the
    /// model speaks again: then it goes in as one note, the marker of what
    /// woke it, as the history decoder writes it from the CLI's own file.
    woken_by: Vec<String>,
    approvals: HashMap<u64, PendingApproval>,
    questions: HashMap<u64, PendingQuestion>,
    tools_by_index: HashMap<i64, InFlightTool>,
    tools_by_id: HashMap<String, InFlightTool>,
    /// The subagents it started: their frames go to their calls' rows.
    subagents: Subagents,
    cancelled: bool,
    mute: bool,
    active: bool,
    turn_tx: Option<oneshot::Sender<TurnOutcome>>,
    emitted_assistant: String,
    /// The id of the assistant message whose usage was last read: the CLI
    /// says one message once for each block it holds, with the same usage.
    /// Lives as long as the process, since ids do not repeat.
    context_message: String,
}

impl ClaudeLive {
    /// A process just launched, with no turn on it yet.
    fn new(claude_session_id: String, waits_for_background: bool, applied: Launch) -> Self {
        Self {
            epoch: NEXT_EPOCH.fetch_add(1, Ordering::Relaxed),
            turn: 0,
            applied,
            claude_session_id,
            waits_for_background,
            held_results: 0,
            calls: HashMap::new(),
            next_ui: 1,
            next_control: 1,
            initialized: false,
            init_tx: None,
            stderr: Vec::new(),
            steers: Vec::new(),
            background: HashSet::new(),
            woken_by: Vec::new(),
            approvals: HashMap::new(),
            questions: HashMap::new(),
            tools_by_index: HashMap::new(),
            tools_by_id: HashMap::new(),
            subagents: Subagents::default(),
            cancelled: false,
            mute: false,
            active: false,
            turn_tx: None,
            emitted_assistant: String::new(),
            context_message: String::new(),
        }
    }

    /// A turn starts on the process the last one left: what that turn knew of
    /// itself goes, what belongs to the process stays.
    fn begin_turn(&mut self, turn_tx: oneshot::Sender<TurnOutcome>) {
        self.turn += 1;
        drop_pending(self);
        self.steers.clear();
        self.background.clear();
        self.woken_by.clear();
        self.tools_by_index.clear();
        self.tools_by_id.clear();
        self.subagents = Subagents::default();
        self.cancelled = false;
        self.mute = false;
        self.active = true;
        self.turn_tx = Some(turn_tx);
        self.emitted_assistant.clear();
    }
}

struct StreamLive {
    cancelled: bool,
    active: bool,
    turn_tx: Option<oneshot::Sender<TurnOutcome>>,
    seen_tools: HashSet<String>,
    stderr: Vec<String>,
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
    Codex(Box<CodexLive>),
    Cursor(Box<CursorLive>),
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
    /// Where Claude keeps its conversations, when not under `$HOME`.
    claude_home: Arc<Mutex<Option<std::path::PathBuf>>>,
    runtime: Arc<Mutex<Option<tokio::runtime::Handle>>>,
    cancelled: Arc<Mutex<HashSet<String>>>,
    /// Questions answered, by session and request: the second answer to one,
    /// from the window or from `send_message`, is told it came too late.
    answered: Arc<Mutex<HashSet<(String, u64)>>>,
    /// The tool families beside Crew's own, so the sheet in a bot's prompt
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
    /// What each session's turn left running in the background.
    background: crate::background::BackgroundHost,
    /// The newest context reading of each session, merged as they come.
    contexts: Arc<Mutex<HashMap<String, ContextReading>>>,
    /// Sessions whose process is up with no turn on it, since when. Apart from
    /// the process entries so the drivers' match arms do not all change.
    idle: Arc<Mutex<HashMap<String, Instant>>>,
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
            claude_home: Arc::new(Mutex::new(None)),
            runtime: Arc::new(Mutex::new(None)),
            cancelled: Arc::new(Mutex::new(HashSet::new())),
            answered: Arc::new(Mutex::new(HashSet::new())),
            toolbox: crate::tools::Toolbox::default(),
            signal: crate::session_events::Signal::default(),
            exiting: Arc::new(Mutex::new(HashMap::new())),
            running: Arc::new(Mutex::new(HashSet::new())),
            background: crate::background::BackgroundHost::default(),
            contexts: Arc::new(Mutex::new(HashMap::new())),
            idle: Arc::new(Mutex::new(HashMap::new())),
        }
    }

    /// Every session's background commands: crewd lists them, and hears
    /// when they change.
    pub fn background(&self) -> &crate::background::BackgroundHost {
        &self.background
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

    /// What a session is told before its turn (plan §6, §7): a bot, every
    /// turn; a child, on its first. The tools are the ones `tools/list`
    /// answers it with, by its kind, as its harness spells them; none when
    /// Crew's server is not there. None for the user's own session: it runs
    /// as their CLI, which is told nothing beyond what the CLI itself says.
    pub(crate) fn persona(
        &self,
        session: &crate::session::Session,
        harness: Harness,
        mcp: bool,
        cwd: &str,
    ) -> Option<String> {
        if driven(session) == Some(Driven::User) {
            return None;
        }
        let kind = crate::caller::Caller::from_session(session.clone()).kind();
        let tools = if mcp { self.toolbox.visible_names(kind) } else { Vec::new() };
        let date = crate::providers::today();
        let branch = crate::worktree::current_branch(cwd);
        let place = crate::prompts::Place { date: &date, cwd, branch: branch.as_deref() };
        if session.kind != "child" {
            return Some(crate::prompts::bot(&crate::prompts::Bot {
                name: &session.name,
                id: &session.id,
                description: &session.description,
                place,
                harness,
                tools: &tools,
            }));
        }
        let parent = session.parent_id.as_deref().and_then(|id| session::get(&self.store, id.to_string()).ok().flatten());
        let parent = match &parent {
            Some(row) if row.kind == "terminal" => crate::prompts::Parent::Terminal { name: &row.name, id: &row.id },
            Some(row) => crate::prompts::Parent::Bot { name: &row.name, id: &row.id },
            None => crate::prompts::Parent::User,
        };
        Some(crate::prompts::session(&crate::prompts::Session {
            parent,
            place,
            harness,
            tools: &tools,
            // Claude's AskUserQuestion and Codex's user-input requests reach
            // the parent; Cursor offers none, and opencode run has no channel.
            question_tool: matches!(session.provider.as_str(), "claude" | "codex"),
        }))
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

    /// Look for Claude's conversations under `home` instead of `$HOME`.
    pub fn override_claude_home(&self, home: impl Into<std::path::PathBuf>) {
        *self.claude_home.lock().unwrap_or_else(|e| e.into_inner()) = Some(home.into());
    }

    /// Whether Claude already holds conversation `id` for a run in `cwd`: its
    /// file is under the project folder it files `cwd` in, whether `cwd` is
    /// written as given or as the path it resolves to (what the CLI sees).
    fn claude_holds(&self, cwd: &str, id: &str) -> bool {
        let home = self
            .claude_home
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .clone()
            .or_else(|| std::env::var_os("HOME").filter(|home| !home.is_empty()).map(std::path::PathBuf::from));
        let Some(home) = home else {
            return false;
        };
        let resolved = std::fs::canonicalize(cwd).ok().map(|path| path.to_string_lossy().into_owned());
        [Some(cwd.to_string()), resolved]
            .into_iter()
            .flatten()
            .any(|cwd| crate::provider_session::claude_transcript(&home, &cwd, id).is_file())
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

    pub fn start(&self, params: TurnStart) -> Result<TurnStarted, String> {
        self.begin(params, Vec::new())
    }

    /// A turn the user started from the window. To a child it is a letter
    /// like any other, so the pair "You ⇄ child" has its thread, and the
    /// child's parent sees a line where the user wrote to it.
    pub fn start_by_user(&self, mut params: TurnStart) -> Result<TurnStarted, String> {
        params.letter_id = None;
        let session = session::get(&self.store, params.session_id.clone())?
            .ok_or_else(|| "Session not found".to_string())?;
        if session.kind != "child" || params.hidden == Some(true) || params.from_bot.is_some() {
            return self.start(params);
        }
        let letter = mailbox::record_claimed(&self.store, &session.id, &mailbox::user(), &params.text)?;
        params.letter_id = Some(letter.id.clone());
        match self.start(params) {
            Ok(started) => {
                let parent = session.parent_id.as_deref().and_then(|id| session::get(&self.store, id.to_string()).ok().flatten());
                if let Some(parent) = parent.filter(|parent| parent.kind == "bot" || parent.kind == "child") {
                    self.transcripts.append_system_letter(&parent.id, &format!("You wrote to {}", session.name), &letter.id);
                }
                Ok(started)
            }
            Err(error) => {
                let _ = mailbox::dispose(&self.store, &letter.id);
                Err(error)
            }
        }
    }

    /// Start a turn. With `letters`, the turn carries them: each goes in the
    /// transcript as its own message, with its own sender, and the model is
    /// handed their envelopes one after the other. They count as delivered
    /// when this turn ends.
    fn begin(&self, mut params: TurnStart, letters: Vec<mailbox::Letter>) -> Result<TurnStarted, String> {
        let session = session::get(&self.store, params.session_id.clone())?
            .ok_or_else(|| "Session not found".to_string())?;
        let Some(drive) = driven(&session) else {
            return Err(format!(
                "{} runs its CLI in the terminal view. Crew drives only a session in the chat view.",
                session.name
            ));
        };
        let carries = drive.carries_conversation();
        if drive == Driven::Child && session.status == "exited" {
            return Err("This session has exited. Start another one.".into());
        }
        {
            let mut running = self.running.lock().unwrap_or_else(|e| e.into_inner());
            let live = self.lock().get(&params.session_id).is_some_and(|live| match live {
                Live::Claude(row) => row.active,
                Live::Codex(row) => row.active,
                Live::Cursor(row) => row.active,
                Live::Opencode(row) => row.active,
            });
            if live || !running.insert(params.session_id.clone()) {
                return Err("Turn already running".into());
            }
        }
        self.clear_stop(&params.session_id);
        // Read before the new message is appended: the tail is what the bot
        // is reminded of, and this turn is not history yet. A session that
        // carries on its provider's own conversation is handed none.
        let history = if carries {
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
        if !letters.is_empty() {
            // The transcript keeps each letter as it was written, under the
            // name of whoever wrote it; the envelopes are for the model. What
            // the user wrote to their own session is theirs, not mail.
            for letter in &letters {
                if is_own(drive, letter) {
                    self.transcripts.append_user(&params.session_id, &letter.text, false, None, Some(letter.id.clone()));
                } else {
                    self.transcripts.append_from_bot(
                        &params.session_id,
                        &letter.text,
                        letter.from.clone(),
                        Some(letter.id.clone()),
                    );
                }
            }
            params.text = letters
                .iter()
                .map(|letter| {
                    if is_own(drive, letter) {
                        letter.text.clone()
                    } else {
                        mailbox::render(letter, session.parent_id.as_deref())
                    }
                })
                .collect::<Vec<_>>()
                .join("\n\n");
        } else {
            match params.from_bot.clone() {
                Some(from) => {
                    // The transcript keeps the letter as it was written: the
                    // envelope is for the model, and the sender's name is already
                    // on the block for the reader.
                    self.transcripts.append_from_bot(
                        &params.session_id,
                        &params.text,
                        from.clone(),
                        params.letter_id.clone(),
                    );
                    params.text = mailbox::envelope(
                        &from,
                        &params.text,
                        (!carries).then(|| params.sent_at.unwrap_or_else(crate::store::now_millis)),
                        session.parent_id.as_deref(),
                    );
                }
                None => self.transcripts.append_user(
                    &params.session_id,
                    &params.text,
                    hidden,
                    params.files.clone(),
                    params.letter_id.clone(),
                ),
            }
        }
        self.transcripts.set_working(&params.session_id, true);
        self.transcripts.set_status(&params.session_id, "working", session.provider_session_id.as_deref());
        let host = self.clone();
        // A letter handed over with the turn rather than through the box (a
        // first prompt, the user writing to a child) is delivered with it too.
        if let Some(id) = params.letter_id.as_deref() {
            let _ = mailbox::claim_id(&self.store, id);
        }
        let carried: Vec<String> =
            letters.into_iter().map(|letter| letter.id).chain(params.letter_id.clone()).collect();
        thread::spawn(move || {
            host.run_turn(session, params, history, carried);
        });
        Ok(TurnStarted { working: true, delivery: None, letter_id: None })
    }

    pub fn stop(&self, session_id: &str) -> Result<(), String> {
        self.cancel(session_id, true);
        Ok(())
    }

    /// What a session's turn left running in the background.
    pub fn background_list(&self, session_id: &str) -> crew_protocol::BackgroundList {
        self.background.list(session_id)
    }

    /// The session's newest context reading, if one came.
    pub fn context(&self, session_id: &str) -> Option<ContextReading> {
        self.contexts.lock().unwrap_or_else(|e| e.into_inner()).get(session_id).cloned()
    }

    /// Keeps a reading as the session's newest and returns the merged one: a
    /// reading without a window keeps the last window and auto-compact point.
    pub fn record_context(&self, session_id: &str, reading: ContextReading) -> ContextReading {
        let mut contexts = self.contexts.lock().unwrap_or_else(|e| e.into_inner());
        let merged = merge_context(contexts.get(session_id), reading);
        contexts.insert(session_id.to_string(), merged.clone());
        merged
    }

    /// Records a reading, built from the last one if there is one, and tells
    /// the windows the merged reading when it is not the one they have. All
    /// under the one lock, so two readers of the CLI cannot cross: the
    /// reader thread's `used` and a spawned thread's window each build on
    /// the other's.
    fn publish_context(&self, session_id: &str, next: impl FnOnce(Option<&ContextReading>) -> Option<ContextReading>) {
        let mut contexts = self.contexts.lock().unwrap_or_else(|e| e.into_inner());
        let last = contexts.get(session_id);
        let Some(reading) = next(last) else {
            return;
        };
        let merged = merge_context(last, reading);
        if last == Some(&merged) {
            return;
        }
        contexts.insert(session_id.to_string(), merged.clone());
        // A reading of the moment, not history: it does not go in the transcript.
        self.transcripts.emit_live(
            session_id,
            HarnessEvent::ContextUpdated {
                used: merged.used,
                window: merged.window,
                auto_compact_at: merged.auto_compact_at,
            },
        );
    }

    /// Asks Claude how large its window is, on a thread of its own: the
    /// answer comes in on the reader thread, which is the one calling this, so
    /// waiting for it there would never end. `compacted` says the last
    /// message's usage is from before a compaction, and the CLI's own count
    /// is the better `used`; `fallback` is the window the turn's `result`
    /// named, for a CLI that does not answer.
    fn ask_claude_context(&self, session_id: &str, compacted: bool, fallback: Option<u64>) {
        let epoch = match self.lock().get(session_id) {
            Some(Live::Claude(live)) => live.epoch,
            _ => return,
        };
        let host = self.clone();
        let id = session_id.to_string();
        thread::spawn(move || {
            let usage = host
                .claude_control_on(&id, Some(epoch), get_context_usage_request())
                .ok()
                .and_then(|response| parse_context_usage(&response));
            match (usage, fallback) {
                (Some(usage), _) => host.publish_context(&id, |last| {
                    let used = if compacted {
                        usage.total.or(last.map(|last| last.used))
                    } else {
                        last.map(|last| last.used).or(usage.total)
                    };
                    used.map(|used| ContextReading {
                        used,
                        window: Some(usage.window),
                        auto_compact_at: usage.auto_compact_at,
                    })
                }),
                // Only the window: what compacts it by itself is not told.
                (None, Some(window)) => host.publish_context(&id, |last| {
                    last.filter(|last| last.window.is_none())
                        .map(|last| ContextReading { used: last.used, window: Some(window), auto_compact_at: None })
                }),
                (None, None) => {}
            }
        });
    }

    /// The end of a background command's output: asked of the CLI while it
    /// is up, and otherwise the last that was read of it.
    pub fn background_output(&self, session_id: &str, id: &str) -> Result<crew_protocol::BackgroundOutput, String> {
        let known = self
            .background
            .read(session_id, |board| (board.command(id).cloned(), board.is_live(), board.output(id)));
        let Some((Some(row), live, kept)) = known else {
            return Err("No such background command.".into());
        };
        let claude = matches!(self.lock().get(session_id), Some(Live::Claude(_)));
        // Claude reads a shell's or a Monitor's output; a subagent's is its
        // report, which lands in the transcript.
        if live && claude && row.kind != crew_protocol::BackgroundKind::Subagent {
            match self.claude_control(session_id, get_task_output_request(id)) {
                Ok(response) => {
                    let output = crate::background::claude_output(&response);
                    let keep = output.clone();
                    self.background.touch(session_id, |board| {
                        board.keep_output(id, keep);
                        false
                    });
                    return Ok(output);
                }
                Err(error) if kept.is_none() => return Err(error),
                Err(_) => {}
            }
        }
        Ok(kept.unwrap_or(crew_protocol::BackgroundOutput { output: String::new(), truncated: false }))
    }

    /// Stop one background command: Claude's `stop_task`, Codex's
    /// `thread/backgroundTerminals/terminate`. Only while its CLI is up.
    pub fn background_stop(&self, session_id: &str, id: &str) -> Result<(), String> {
        let known = self.background.read(session_id, |board| {
            (board.command(id).map(|row| row.state), board.is_live(), board.process_id(id))
        });
        let Some((Some(state), live, process)) = known else {
            return Err("No such background command.".into());
        };
        if state != crew_protocol::BackgroundState::Running {
            return Ok(());
        }
        if !live {
            return Err("Its session's CLI is gone, and it went with it.".into());
        }
        let kind = match self.lock().get(session_id) {
            Some(Live::Claude(_)) => "claude",
            Some(Live::Codex(_)) => "codex",
            _ => "",
        };
        match kind {
            "claude" => {
                self.claude_control(session_id, stop_task_request(id))?;
            }
            "codex" => {
                let process = process.ok_or_else(|| "Codex named no process for it.".to_string())?;
                self.codex_terminate(session_id, &process)?;
            }
            _ => return Err("Its session's CLI is gone, and it went with it.".into()),
        }
        let now = crate::store::now_millis();
        self.background.touch(session_id, |board| board.settle(id, crew_protocol::BackgroundState::Stopped, None, now));
        Ok(())
    }

    /// Send Claude a control request and wait for its answer.
    fn claude_control(&self, session_id: &str, request: Value) -> Result<Value, String> {
        self.claude_control_on(session_id, None, request)
    }

    /// [`TurnHost::claude_control`], for the process `epoch` names only: an
    /// ask that outlived its process must not reach the next one, whose
    /// control ids start over and whose `initialize` would take its answer.
    fn claude_control_on(&self, session_id: &str, epoch: Option<u64>, request: Value) -> Result<Value, String> {
        let timeout = control_timeout(&request);
        let (tx, rx) = mpsc::channel();
        let id = {
            let mut map = self.lock();
            let Some(Live::Claude(live)) = map.get_mut(session_id) else {
                return Err("Claude Code is not running.".into());
            };
            if epoch.is_some_and(|epoch| epoch != live.epoch || !live.initialized) {
                return Err("Claude Code is not running.".into());
            }
            let id = format!("ctrl-{}", live.next_control);
            live.next_control += 1;
            live.calls.insert(id.clone(), tx);
            id
        };
        let forget = || {
            if let Some(Live::Claude(live)) = self.lock().get_mut(session_id) {
                live.calls.remove(&id);
            }
        };
        if let Err(error) =
            self.agents.write(session_id, &serde_json::to_string(&build_control_request(&id, request)).unwrap_or_default())
        {
            forget();
            return Err(error);
        }
        match rx.recv_timeout(timeout) {
            Ok(result) => result,
            Err(mpsc::RecvTimeoutError::Timeout) => {
                forget();
                Err(NO_ANSWER.into())
            }
            Err(mpsc::RecvTimeoutError::Disconnected) => Err("Claude Code is not running.".into()),
        }
    }

    /// Decide an approval a session is waiting on. The one place an
    /// approval is decided, from the window's card and from a parent's
    /// `send_message` alike: the first decision wins, and the other is told it
    /// was already answered.
    pub fn respond(&self, session_id: &str, request_id: u64, decision: ApprovalDecision) -> Result<(), String> {
        let key = (session_id.to_string(), request_id);
        let taken = self.codex_respond(session_id, request_id, decision.clone()).is_some()
            || self.cursor_respond(session_id, request_id, decision.clone()).is_some()
            || {
                let mut map = self.lock();
                match map.get_mut(session_id) {
                    Some(Live::Claude(live)) => match live.approvals.remove(&request_id) {
                        Some(pending) => {
                            let _ = pending.tx.send(match decision {
                                ApprovalDecision::Allow => ApprovalResolution::Allow,
                                ApprovalDecision::Always => ApprovalResolution::Always,
                                ApprovalDecision::Deny => ApprovalResolution::Deny,
                            });
                            true
                        }
                        None => false,
                    },
                    _ => false,
                }
            };
        if !taken {
            if self.answered.lock().unwrap_or_else(|e| e.into_inner()).contains(&key) {
                return Err("That approval was already answered.".into());
            }
            return Err("No approval is waiting".into());
        }
        self.answered.lock().unwrap_or_else(|e| e.into_inner()).insert(key);
        // Decided: an approval letter still waiting to wake the parent has
        // nothing left to ask.
        if let Ok(Some(row)) = session::get(&self.store, session_id.to_string()) {
            if let Some(parent) = row.parent_id.as_deref() {
                let _ = mailbox::dispose_approvals(&self.store, parent, session_id);
            }
        }
        Ok(())
    }

    /// A child under ask autonomy defined a process, or proposed a change to
    /// one: like any other approval, it wakes a bot parent that could do the
    /// same itself. Returns whether a letter went.
    pub fn process_proposed(&self, child: &crate::session::Session, process: &crew_protocol::Process) -> bool {
        if child.kind != "child" || (process.approved && process.proposed.is_none()) {
            return false;
        }
        let Some(parent) = self.deciding_parent(child, &json!({ "kind": "process" })) else {
            return false;
        };
        let from = crew_protocol::BotRef { id: child.id.clone(), name: child.name.clone(), kind: Some("session".into()) };
        let letter = mailbox::Letter::new(&parent.id, &from, &mailbox::process_approval_text(process), mailbox::APPROVAL, None);
        if mailbox::put(&self.store, letter).is_err() {
            return false;
        }
        self.drain_mailbox(&parent.id);
        true
    }

    /// The bot that started `child`, when it may decide `request` for it:
    /// only what it could do itself without asking anyone.
    pub fn deciding_parent(&self, child: &crate::session::Session, request: &Value) -> Option<crate::session::Session> {
        let parent = child
            .parent_id
            .as_deref()
            .and_then(|id| session::get(&self.store, id.to_string()).ok().flatten())?;
        (parent.kind == "bot" && may_decide(&self.autonomy(&parent), request)).then_some(parent)
    }

    /// The autonomy a session effectively runs with, for a tool deciding
    /// what a caller may approve.
    pub fn effective_autonomy(&self, session: &crate::session::Session) -> Autonomy {
        self.autonomy(session)
    }

    /// Answer a question a session is waiting on. The one place a question is
    /// answered, from the window's card and from `send_message` alike: the
    /// first answer wins, and the other is told it was already answered.
    pub fn answer(&self, session_id: &str, request_id: u64, answers: Option<Answers>) -> Result<(), String> {
        let key = (session_id.to_string(), request_id);
        let taken = self.codex_answer(session_id, request_id, answers.clone()).is_some()
            || self.cursor_answer(session_id, request_id, answers.clone()).is_some()
            || {
                let mut map = self.lock();
                match map.get_mut(session_id) {
                    Some(Live::Claude(live)) => match live.questions.remove(&request_id) {
                        Some(pending) => {
                            let _ = pending.tx.send(match answers {
                                Some(answers) => QuestionReply::Answers(answers),
                                None => QuestionReply::Dismiss,
                            });
                            true
                        }
                        None => false,
                    },
                    _ => false,
                }
            };
        if !taken {
            if self.answered.lock().unwrap_or_else(|e| e.into_inner()).contains(&key) {
                return Err("That question was already answered.".into());
            }
            return Err("No question is waiting".into());
        }
        self.answered.lock().unwrap_or_else(|e| e.into_inner()).insert(key);
        // Answered: a question letter still waiting to wake the parent has
        // nothing left to ask.
        if let Ok(Some(row)) = session::get(&self.store, session_id.to_string()) {
            if let Some(parent) = row.parent_id.as_deref() {
                let _ = mailbox::dispose_questions(&self.store, parent, session_id);
            }
        }
        Ok(())
    }

    pub fn on_agent_lines(&self, event: &str, session_id: &str, lines: Vec<String>) {
        if event == "agent-stderr" {
            let mut map = self.lock();
            if let Some(live) = map.get_mut(session_id) {
                let stderr = match live {
                    Live::Claude(row) => &mut row.stderr,
                    Live::Codex(row) => &mut row.stderr,
                    Live::Cursor(row) => &mut row.stderr,
                    Live::Opencode(row) => &mut row.stderr,
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
                row.calls.clear();
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
                } else if !mid && !cancelled && row.initialized && row.steers.is_empty() {
                    // No turn is running: a process a child kept died while
                    // idle. Its entry goes, so the next message launches one
                    // and resumes the conversation, and what it ran in the
                    // background went with it. One that never came up is the
                    // launch's to report, and a turn that ended with a steer
                    // unread has that steer to hand back first.
                    drop(map);
                    self.detach(session_id);
                    self.close_tray(session_id);
                }
            }
            Live::Codex(row) => {
                // Whatever waited on an answer gets none.
                row.release();
                // No turn is running: a process a child kept died while idle.
                // Its entry goes, so the next message spawns one and resumes
                // the thread, and what it ran in the background went with it.
                if !row.active {
                    drop(map);
                    self.detach(session_id);
                    self.close_tray(session_id);
                    return;
                }
                if row.cancelled || row.settled {
                    return;
                }
                let stderr = row.stderr.clone();
                drop(map);
                self.transcripts.apply(session_id, HarnessEvent::SessionEnded { code });
                self.signal(session_id, TurnOutcome::Failed(exit_message(provider, code, &stderr)));
            }
            Live::Cursor(row) => {
                row.release();
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
            Live::Opencode(row) => {
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
                Live::Codex(row) => {
                    row.active = false;
                    row.settled = true;
                    if let Some(tx) = row.turn_tx.take() {
                        let _ = tx.send(outcome);
                    }
                }
                Live::Cursor(row) => {
                    row.active = false;
                    row.settled = true;
                    if let Some(tx) = row.turn_tx.take() {
                        let _ = tx.send(outcome);
                    }
                }
                Live::Opencode(row) => {
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
        // Codex and Cursor are asked to stop their turn, and its end ends
        // this one; the process goes with it. Without a turn to interrupt, it
        // settles here.
        if self.codex_interrupt(session_id) || self.cursor_interrupt(session_id) {
            return;
        }
        // What Claude left running in the background is stopped first, then
        // the turn: a task stopped after the interrupt would finish later and
        // wake Claude again (monocode's order).
        let running = self
            .background
            .read(session_id, |board| if board.is_live() { board.running() } else { Vec::new() })
            .unwrap_or_default();
        let (interrupt, stops) = {
            let mut map = self.lock();
            if let Some(Live::Claude(row)) = map.get_mut(session_id) {
                if row.active {
                    // Deaf from here: what Claude says to the interrupt is
                    // not the turn's outcome. The turn ends below, once the
                    // requests are written, before its CLI is let go.
                    row.cancelled = true;
                    row.mute = true;
                    let mut next = || {
                        let id = format!("ctrl-{}", row.next_control);
                        row.next_control += 1;
                        id
                    };
                    let stops: Vec<(String, String)> = running.iter().map(|task| (next(), task.clone())).collect();
                    (Some(next()), stops)
                } else {
                    (None, Vec::new())
                }
            } else {
                (None, Vec::new())
            }
        };
        for (id, task) in &stops {
            let _ = self.agents.write(
                session_id,
                &serde_json::to_string(&build_control_request(id, stop_task_request(task))).unwrap_or_default(),
            );
        }
        if let Some(id) = &interrupt {
            let _ = self.agents.write(
                session_id,
                &serde_json::to_string(&build_control_request(id, json!({ "subtype": "interrupt" })))
                    .unwrap_or_default(),
            );
        }
        let mut armed = None;
        {
            let mut map = self.lock();
            if let Some(live) = map.get_mut(session_id) {
                match live {
                    Live::Claude(row) => {
                        armed = Some(row.epoch);
                        row.cancelled = true;
                        row.mute = true;
                        row.active = false;
                        drop_pending(row);
                        if let Some(tx) = row.turn_tx.take() {
                            let _ = tx.send(TurnOutcome::Stopped);
                        }
                    }
                    Live::Codex(row) => {
                        row.cancelled = true;
                        row.active = false;
                        row.settled = true;
                        row.release();
                        if let Some(tx) = row.turn_tx.take() {
                            let _ = tx.send(TurnOutcome::Stopped);
                        }
                    }
                    Live::Cursor(row) => {
                        row.cancelled = true;
                        row.active = false;
                        row.settled = true;
                        row.release();
                        if let Some(tx) = row.turn_tx.take() {
                            let _ = tx.send(TurnOutcome::Stopped);
                        }
                    }
                    Live::Opencode(row) => {
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
        if interrupt.is_some() {
            if kill {
                let host = self.clone();
                let session_id = session_id.to_string();
                self.after(INTERRUPT_GRACE, move || {
                    // Only the process it was armed for: the turn's end lets
                    // it go, and a launch for the next message in the grace
                    // is not this stop's to kill.
                    let replaced = matches!(
                        host.lock().get(&session_id),
                        Some(Live::Claude(row)) if Some(row.epoch) != armed
                    );
                    if !replaced {
                        host.release(&session_id);
                    }
                });
                return;
            }
        }
        // The process goes with the stop, and so does the tray it kept open.
        if kill {
            self.release(session_id);
        }
    }

    fn detach(&self, session_id: &str) {
        self.lock().remove(session_id);
        self.idle.lock().unwrap_or_else(|e| e.into_inner()).remove(session_id);
    }

    /// Since when a session's process has been up with no turn on it. `None`
    /// while a turn runs or when there is no process.
    pub fn idle_since(&self, session_id: &str) -> Option<Instant> {
        self.idle.lock().unwrap_or_else(|e| e.into_inner()).get(session_id).copied()
    }

    /// The end of a turn on a driver that can keep its process: it stays for
    /// the next turn when the session keeps its process and this one went
    /// well, and goes otherwise. A turn that failed or was stopped leaves the
    /// process in a state nobody vouches for (an interrupt's late answer
    /// would end the next turn), and a session that is exiting has no next
    /// turn.
    fn park(&self, session: &crate::session::Session, outcome: &TurnOutcome) {
        let exiting = self.exiting.lock().unwrap_or_else(|e| e.into_inner()).contains_key(&session.id);
        let kept = keeps_process(session)
            && matches!(outcome, TurnOutcome::Completed)
            && !exiting
            && self.lock().contains_key(&session.id);
        if kept {
            self.idle.lock().unwrap_or_else(|e| e.into_inner()).insert(session.id.clone(), Instant::now());
        } else {
            self.release(&session.id);
        }
    }

    /// Let go of a session's process: kill it, drop its entry, and close the
    /// tray, since what it ran in the background went with it.
    pub fn release(&self, session_id: &str) {
        self.agents.kill(session_id);
        self.detach(session_id);
        self.close_tray(session_id);
    }

    /// Whether a session's process stays up past [`RELEASE_AFTER`]: its
    /// background board has commands running, or a child it started has not
    /// exited. A store that cannot say counts as pinned, so nothing is let go
    /// on a guess; [`PIN_CAP`] still ends it.
    pub fn is_pinned(&self, session_id: &str) -> bool {
        let running = self
            .background
            .read(session_id, |board| !board.running().is_empty())
            .unwrap_or(false);
        running || session::has_live_children(&self.store, session_id).unwrap_or(true)
    }

    /// Lets go of the processes that have been idle too long: past `limit`
    /// when nothing pins them, and past `pin_cap` whatever pins them. Returns
    /// the ids released.
    pub fn release_idle(&self, limit: Duration, pin_cap: Duration) -> Vec<String> {
        let idle: Vec<(String, Instant)> = self
            .idle
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .iter()
            .map(|(id, since)| (id.clone(), *since))
            .collect();
        let mut released = Vec::new();
        for (id, since) in idle {
            let age = since.elapsed();
            let due = age >= pin_cap || (age >= limit && !self.is_pinned(&id));
            // A turn claimed since the snapshot is not idle any more.
            if !due || self.is_running(&id) || self.idle_since(&id) != Some(since) {
                continue;
            }
            self.release(&id);
            released.push(id);
        }
        released
    }

    /// The CLI is gone, and what it left running in the background went with
    /// it: the tray keeps the rows, ended, until the next process.
    fn close_tray(&self, session_id: &str) {
        let now = crate::store::now_millis();
        self.background.touch(session_id, |board| board.end(now));
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
            // Minted for this session, here, once per process: a driver that
            // keeps its process across turns calls this once, since a later
            // mint would retire the token the live CLI's MCP server holds. It
            // is what says who is calling: the id no longer travels on the
            // wire, so a shell that inherited this cannot speak as another
            // agent.
            ("CREW_TOKEN".into(), self.bridge.mint(session_id)),
        ])
    }

    fn mcp(&self) -> Option<(String, Vec<String>)> {
        let info = self.bridge.info().ok()?;
        Some((info.exe, vec!["--mcp".into()]))
    }

    fn run_turn(&self, session: crate::session::Session, params: TurnStart, history: Option<String>, carried: Vec<String>) {
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
        // The CLI is gone, unless the session kept it for its next turn: then
        // what it left running in the background still runs.
        if self.idle_since(&session_id).is_none() {
            self.close_tray(&session_id);
        }
        // The letters it carried are delivered now that it has ended, however
        // it ended. A daemon that dies first leaves them claimed, and the next
        // start hands them over again.
        let _ = mailbox::delivered(&self.store, &carried);
        // The turn is over: the next one may start, and the drain below is
        // what starts it.
        self.running.lock().unwrap_or_else(|e| e.into_inner()).remove(&session_id);
        if driven(&row) == Some(Driven::Child) {
            self.settle_child(&row, outcome);
            return;
        }
        // A bot and the user's own session settle alike: nobody waits on their
        // turn, so it leaves no event or report, only the status the user sees
        // (`done` is a finished turn they have not read yet).
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
                // for them, it does not restart the session.
                return;
            }
        }
        self.drain_mailbox(&session_id);
    }

    /// Hand over what is waiting for a session that has just gone quiet: every
    /// letter in its box, oldest first, in one turn (up to
    /// [`mailbox::BATCH_CHARS`] of text; the rest waits for the next turn).
    /// A session with a turn running is left alone: that turn's end drains it.
    ///
    /// The one place a turn's letters are claimed, so two callers racing cannot
    /// lose one between them: the loser finds an empty box, which is the truth.
    /// Always queued, never steered into a running turn.
    pub fn drain_mailbox(&self, session_id: &str) -> bool {
        // Before claiming, so a letter for a busy session stays pending: a
        // wait that reads the same report can then take it back. The turn
        // leaves `running` before its end drains, so one of the two sees it.
        if self.is_running(session_id) {
            return false;
        }
        let letters = match mailbox::claim_batch(&self.store, session_id, mailbox::BATCH_CHARS) {
            Ok(letters) if !letters.is_empty() => letters,
            _ => return false,
        };
        let put_back = |letters: &[mailbox::Letter]| {
            for letter in letters {
                let _ = mailbox::release(&self.store, &letter.id);
            }
        };
        let cwd = crate::session::get(&self.store, session_id.to_string())
            .ok()
            .flatten()
            .and_then(|session| crate::session::cwd(&self.store, &session).ok())
            .unwrap_or_default();
        // What each report or question shows of its child, to mark seen once
        // it is handed over: a read or a wait after this does not hand it out
        // again.
        let reported: Vec<(String, i64)> = letters
            .iter()
            .filter(|letter| {
                (letter.is_report() || letter.kind == mailbox::QUESTION || letter.kind == mailbox::APPROVAL)
                    && !letter.from.id.is_empty()
            })
            .filter_map(|letter| letter.event_cursor.map(|cursor| (letter.from.id.clone(), cursor)))
            .collect();
        let first = letters[0].clone();
        let started = self.begin(
            TurnStart {
                session_id: session_id.to_string(),
                cwd,
                text: String::new(),
                files: None,
                mentions: None,
                hidden: None,
                from_bot: Some(first.from.clone()),
                sent_at: Some(first.at),
                nonce: None,
                letter_id: None,
                mode: None,
            },
            letters.clone(),
        );
        if started.is_err() {
            // Something else took the bot between the turn ending and this
            // line. The letters go back at the head of the queue, and that
            // turn's own ending will come back for them.
            put_back(&letters);
            return false;
        }
        for (child, cursor) in reported {
            let _ = crate::session_events::mark_seen(&self.store, &child, cursor);
        }
        true
    }

    /// Drain a bot's box by id, for a caller that has only that. Used when a
    /// letter has just been dropped in.
    pub fn deliver_to(&self, target: &crate::session::Session) -> bool {
        self.drain_mailbox(&target.id)
    }

    /// Letters left waiting for an idle bot — a delivery that raced a turn
    /// ending, or a daemon that stopped between the two — are invisible: only
    /// the end of a turn looks in a box. This is the sweep at startup.
    pub fn deliver_waiting(&self) {
        let Ok(sessions) = crate::session::list_all(&self.store) else {
            return;
        };
        for session in sessions {
            let idle = !matches!(session.status.as_str(), "working" | "needs-input" | "starting" | "exited");
            if driven(&session).is_none() || !idle {
                continue;
            }
            if mailbox::waiting_count(&self.store, &session.id).unwrap_or(0) > 0 {
                self.deliver_to(&session);
            }
        }
    }

    /// The end of a child session's turn, in the order a waiter depends on:
    /// the block that marks it, the status, the event at that block's
    /// position, the letter to a bot parent, and only then the wake-up.
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
        // waits for them, as it does for a bot.
        if detail != "stopped" {
            self.drain_mailbox(id);
        }
    }

    /// Write a child's event at the end of its transcript, with the report
    /// to a bot parent in the same transaction; then wake whoever waits, and
    /// only then try to hand the report over.
    fn child_event(&self, session: &crate::session::Session, kind: &str, outcome: &str, request: Option<&Value>) {
        let id = session.id.as_str();
        let cursor = self.transcripts.len(id) as i64;
        let (_, report) = self.transcripts.since(id, cursor as usize);
        let report = if kind == "needs-input" { String::new() } else { report };
        let letter = self.report_letter(session, kind, outcome, &report, request, cursor);
        let written = crate::session_events::record_reporting(
            &self.store,
            id,
            cursor,
            kind,
            outcome,
            &report,
            request,
            letter.as_ref(),
        );
        if let Err(error) = &written {
            eprintln!("[crewd] session {id}: the event was not written: {error}");
        }
        self.signal.notify();
        if let (Ok(()), Some(letter)) = (written, letter) {
            self.drain_mailbox(&letter.to_session);
        }
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

    /// A bot that started a session hears how each turn ended in its own
    /// box, as a `report` letter that wakes it, so it never sits in a wait to
    /// find out; what it asks, as a `question` letter it answers with
    /// `send_message`; and an approval it could give itself, as an
    /// `approval` letter it decides with `send_message`. The user's card
    /// stays either way. A terminal or the user has no turns to hand it to:
    /// they wait, or read.
    /// `None` when there is no bot parent to tell.
    fn report_letter(
        &self,
        session: &crate::session::Session,
        kind: &str,
        outcome: &str,
        report: &str,
        request: Option<&Value>,
        cursor: i64,
    ) -> Option<mailbox::Letter> {
        let parent = session
            .parent_id
            .as_deref()
            .and_then(|id| session::get(&self.store, id.to_string()).ok().flatten())?;
        if parent.kind != "bot" {
            return None;
        }
        let from = crew_protocol::BotRef {
            id: session.id.clone(),
            name: session.name.clone(),
            kind: Some("session".into()),
        };
        if kind == "needs-input" {
            let request = request?;
            return match request.get("kind").and_then(Value::as_str) {
                Some("question") => {
                    let body = mailbox::questions_text(request);
                    Some(mailbox::Letter::new(&parent.id, &from, &body, mailbox::QUESTION, Some(cursor)))
                }
                // Only to a parent that could do it itself; otherwise the
                // user's card is all there is.
                Some("approval") if may_decide(&self.autonomy(&parent), request) => {
                    let body = mailbox::approval_text(request);
                    Some(mailbox::Letter::new(&parent.id, &from, &body, mailbox::APPROVAL, Some(cursor)))
                }
                _ => None,
            };
        }
        let what = match (kind, outcome) {
            ("turn", "completed") => None,
            ("turn", _) => Some("Its turn was stopped. What it said last:".to_string()),
            ("error", message) => Some(format!("Its turn failed: {message}\nWhat it said last:")),
            ("exited", why) => Some(format!("It exited ({why}).")),
            _ => None,
        };
        let report = report.trim();
        let body = match (what, report.is_empty()) {
            (None, true) => "It ended its turn without a final message.".to_string(),
            (None, false) => report.to_string(),
            (Some(what), true) => what,
            (Some(what), false) => format!("{what}\n\n{report}"),
        };
        Some(mailbox::Letter::new(&parent.id, &from, &body, mailbox::REPORT, Some(cursor)))
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
        // A child that kept its process for the next turn has no next turn.
        self.release(&session.id);
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
            let (text, from, hidden, letter) = if row.provider_session_id.is_some() {
                (
                    "Crew restarted while you were working, which broke off your last turn. Carry on where you \
                     left off; your final message is still your report."
                        .to_string(),
                    None,
                    Some(true),
                    None,
                )
            } else {
                let (blocks, _) = self.transcripts.since(&row.id, 0);
                match blocks.into_iter().find(|block| block.role == crew_protocol::BlockRole::User) {
                    Some(first) => (first.text, first.from_bot, None, first.letter_id),
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
                from_bot: from,
                sent_at: None,
                nonce: None,
                letter_id: letter,
                mode: None,
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

    /// The prompt of a turn that carries on the provider's conversation, for a
    /// CLI that takes it as one document: the persona and the job on the first
    /// turn, the text alone once its conversation is being carried on, or
    /// when there is no persona (the user's own session).
    fn child_prompt(&self, persona: Option<&str>, resumed: bool, params: &TurnStart) -> String {
        let text = crate::providers::with_files(params.text.trim(), &path_list(params, &HashSet::new()));
        match persona {
            Some(persona) if !resumed => crate::providers::assemble(persona.to_string(), None, &text),
            _ => text,
        }
    }

    fn run_claude(
        &self,
        session: crate::session::Session,
        params: TurnStart,
        history: Option<String>,
    ) -> TurnOutcome {
        let session_id = session.id.clone();
        let outcome = self.claude_turn(&session, &params, history);
        // A steer the turn ended before reading is not lost: it waits in the
        // box, and the end of this turn hands it over as the next one.
        let (unread, background) = match self.lock().get_mut(&session_id) {
            Some(Live::Claude(live)) => {
                drop_pending(live);
                (std::mem::take(&mut live.steers), !live.background.is_empty())
            }
            _ => (Vec::new(), false),
        };
        let unread_any = !unread.is_empty();
        for steer in unread {
            steer.put_back(&self.store, &session_id);
        }
        // A child keeps the CLI for its next turn, unless this one leaves it
        // somewhere that turn cannot start from. A steer it never read is
        // still queued inside the CLI, which would start a turn of its own on
        // it, and the box hands the same message over again; and background
        // commands still open (the grace ran out) wake Claude by itself later.
        // Those, a stop, a failure and a bot's turn let it go.
        if unread_any || background {
            self.release(&session_id);
        } else {
            self.park(&session, &outcome);
        }
        outcome
    }

    /// The turn itself, on a process armed and launched for it: the user
    /// message goes in, and the outcome is what the process says of it.
    fn claude_turn(&self, session: &crate::session::Session, params: &TurnStart, history: Option<String>) -> TurnOutcome {
        let session_id = session.id.clone();
        if self.stop_requested(&session_id) {
            return TurnOutcome::Stopped;
        }
        let (mut kept, changes) = self.claude_arm(session, &params.cwd);
        if kept && !self.apply_claude_changes(&session_id, changes) {
            if self.stop_requested(&session_id) {
                return TurnOutcome::Stopped;
            }
            // Refused, or not answered: the same conversation on a new process.
            self.claude_fresh(session, self.applied(session, &params.cwd));
            kept = false;
        }
        if let Err(error) = self.ensure_claude(session, params, kept) {
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
            let (tx, rx) = oneshot::channel();
            live.begin_turn(tx);
            (rx, live.claude_session_id.clone())
        };
        let images = crate::files::load_inline_images(params.files.as_deref().unwrap_or(&[]));
        let inline: HashSet<String> = images.iter().map(|image| image.path.clone()).collect();
        let files = path_list(params, &inline);
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
        self.block_on(turn_rx)
            .unwrap_or(TurnOutcome::Failed("Turn channel closed".into()))
    }

    /// Write a message into a Claude child's running turn. Claude reads it at
    /// its next step and takes it into the turn it is in; its echo puts the
    /// message in the transcript. Refused when no Claude turn is live to take
    /// it, so the caller can queue it instead.
    /// `letter` is the letter it is, already claimed: read, it is delivered;
    /// unread when the turn ends, it goes back in the box.
    pub fn steer(
        &self,
        session_id: &str,
        text: &str,
        from: crew_protocol::BotRef,
        letter: Option<String>,
    ) -> Result<(), String> {
        // The kind first, out of the lock: `codex_steer` takes it again.
        let (codex, cursor) = match self.lock().get(session_id) {
            Some(Live::Codex(_)) => (true, false),
            Some(Live::Cursor(_)) => (false, true),
            _ => (false, false),
        };
        if codex {
            return self.codex_steer(session_id, text, from, letter);
        }
        if cursor {
            // No `session/steer`, and a second prompt cancels the first.
            return Err("Cursor cannot take a message in the middle of a turn".into());
        }
        let sent = self.steer_text(session_id, &from, text);
        let message = {
            let mut map = self.lock();
            let Some(Live::Claude(live)) = map.get_mut(session_id) else {
                return Err("No Claude turn is running to take it.".into());
            };
            if !live.active || live.cancelled || !live.initialized {
                return Err("No Claude turn is running to take it.".into());
            }
            live.steers.push(Steer { sent: sent.clone(), text: text.to_string(), from, letter });
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

    /// A message written into a running turn, under the envelope a queued one
    /// would have; the user's own to their own session goes as they typed it.
    pub(crate) fn steer_text(&self, session_id: &str, from: &crew_protocol::BotRef, text: &str) -> String {
        let row = session::get(&self.store, session_id.to_string()).ok().flatten();
        if row.as_ref().and_then(driven) == Some(Driven::User) && from.kind.as_deref() == Some("user") {
            return text.to_string();
        }
        let parent = row.and_then(|row| row.parent_id);
        mailbox::envelope(from, text, None, parent.as_deref())
    }

    /// How much a turn may do alone: the session's own autonomy, unless
    /// Settings bypasses permissions for every session.
    fn autonomy(&self, session: &crate::session::Session) -> Autonomy {
        if crate::session::bypass_permissions(&self.store) {
            return Autonomy::Full;
        }
        match session.autonomy.as_str() {
            "full" => Autonomy::Full,
            "auto" => Autonomy::Auto,
            "edits" => Autonomy::Edits,
            _ => Autonomy::Ask,
        }
    }

    /// What a process launched for this session now would be given, to
    /// compare with what a kept one was.
    fn applied(&self, session: &crate::session::Session, cwd: &str) -> Launch {
        Launch {
            model: Some(session.model.clone()).filter(|m| !m.is_empty()),
            effort: Some(session.effort.clone()).filter(|e| !e.is_empty()),
            service_tier: Some(session.service_tier.clone()).filter(|tier| !tier.is_empty()),
            autonomy: self.autonomy(session),
            cwd: cwd.to_string(),
        }
    }

    /// Gives the turn its state on the process the last one left, when there
    /// is one alive that can run on the settings the session asks for, and
    /// otherwise on an entry of its own for the process
    /// [`TurnHost::ensure_claude`] launches. Returns whether the process was
    /// kept, and the changes it still has to be told of (see [`claude_plan`]):
    /// [`TurnHost::apply_claude_changes`] sends them, which cannot be done here.
    fn claude_arm(&self, session: &crate::session::Session, cwd: &str) -> (bool, Vec<Change>) {
        let session_id = session.id.as_str();
        let applied = self.applied(session, cwd);
        // Asked before the lock: a process that died while idle without its
        // exit being heard (it was killed under us) is not one to write to.
        let alive = self.agents.running().iter().any(|id| id == session_id);
        let fast_allowed =
            crate::provider_session::claude_fast_mode().availability != crew_protocol::FastModeAvailability::Hidden;
        let plan = match self.lock().get(session_id) {
            Some(Live::Claude(live)) if alive && live.initialized && !live.active && !live.cancelled => {
                Some(claude_plan(&live.applied, &applied, fast_allowed))
            }
            _ => None,
        };
        if let Some(Plan::Changes(changes)) = plan {
            self.idle.lock().unwrap_or_else(|e| e.into_inner()).remove(session_id);
            // Nothing runs in the background of a process that was kept, so
            // the tray starts empty, as it does after a launch.
            self.background.touch(session_id, crate::background::Board::begin);
            return (true, changes);
        }
        // A setting only a launch sets, a stop, or a process that is gone:
        // another is launched, on the conversation the child carries on.
        self.claude_fresh(session, applied);
        (false, Vec::new())
    }

    /// An entry for a process about to be launched, in place of whatever the
    /// session had.
    fn claude_fresh(&self, session: &crate::session::Session, applied: Launch) {
        let session_id = session.id.as_str();
        self.agents.kill(session_id);
        self.detach(session_id);
        // A session that carries on its own conversation does; a bot starts a
        // clean one. The user's session names it by Crew's id until the CLI
        // moves on from it: the terminal view did too, so the history the CLI
        // wrote there and the driver share one conversation.
        let claude_session_id = match driven(session) {
            Some(Driven::User) => conversation_to_resume(session).unwrap_or_else(|| session.id.clone()),
            _ => conversation_to_resume(session).unwrap_or_else(|| uuid::Uuid::new_v4().to_string()),
        };
        let waits_for_background = carries_conversation(session);
        self.lock().insert(
            session_id.to_string(),
            Live::Claude(Box::new(ClaudeLive::new(claude_session_id, waits_for_background, applied))),
        );
        self.background.touch(session_id, crate::background::Board::begin);
    }

    /// Tell a kept process its new settings, before the user message goes in.
    /// Each is recorded as the CLI takes it, so a process that refuses one
    /// still says what it runs on. Returns whether all were taken; on a
    /// refusal or a silence the caller launches the process again. Called
    /// from the turn's thread with no lock held: it waits for the answers,
    /// which the reader thread delivers.
    fn apply_claude_changes(&self, session_id: &str, changes: Vec<Change>) -> bool {
        let epoch = match self.lock().get(session_id) {
            Some(Live::Claude(live)) => live.epoch,
            _ => return false,
        };
        for change in changes {
            if let Some(request) = change.request() {
                let mut taken = self.claude_control_on(session_id, Some(epoch), request.clone());
                // The CLI checks a model with the server within 5 s, and
                // refuses ("Couldn't confirm model ... Try again") when that
                // check did not finish: once more, as it says, before the
                // process is given up on. Not after a silence, which already
                // waited out the longest of waits.
                if matches!(&taken, Err(error) if matches!(change, Change::Model(_)) && error != NO_ANSWER) {
                    taken = self.claude_control_on(session_id, Some(epoch), request);
                }
                if let Err(error) = taken {
                    eprintln!("[crewd] session {session_id}: Claude Code did not take a setting ({error}); it is launched again");
                    return false;
                }
            }
            match self.lock().get_mut(session_id) {
                Some(Live::Claude(live)) if live.epoch == epoch => change.record(&mut live.applied),
                _ => return false,
            }
        }
        true
    }

    /// The process the turn runs on, up and answering: the one a child kept,
    /// or a new one that is launched and initialized here. A bot's is a
    /// clean Claude session every time; what it remembers is the tail Crew
    /// hands it, not whatever the CLI kept.
    fn ensure_claude(&self, session: &crate::session::Session, params: &TurnStart, kept: bool) -> Result<(), String> {
        let session_id = session.id.clone();
        let claude_session_id = match self.lock().get(&session_id) {
            Some(Live::Claude(live)) => live.claude_session_id.clone(),
            _ => return Err("Claude session is gone".into()),
        };
        if !kept {
            self.launch_claude(session, params, &claude_session_id)?;
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

    /// Spawns the CLI and waits for it to answer `initialize`.
    fn launch_claude(
        &self,
        session: &crate::session::Session,
        params: &TurnStart,
        claude_session_id: &str,
    ) -> Result<(), String> {
        let session_id = session.id.clone();
        let autonomy = self.autonomy(session);
        // A session that carries on its own conversation resumes it; a bot
        // starts a clean one. Claude refuses a new session under an id it
        // already holds, so the user's session, which names its conversation
        // before the CLI has written it, resumes only once its file is there.
        let resume = match driven(session) {
            Some(Driven::User) => self
                .claude_holds(&params.cwd, claude_session_id)
                .then(|| claude_session_id.to_string()),
            _ => conversation_to_resume(session),
        };
        if self.stop_requested(&session_id) {
            self.agents.kill(&session_id);
            return Err("cancelled".into());
        }

        let path = self.resolve_bin("claude").or_else(|_| self.resolve_bin("claude"))?;
        let mcp = self.mcp();
        let persona = self.persona(session, Harness::Mcp, mcp.is_some(), &params.cwd);
        let spawn = ClaudeSpawn {
            model: Some(session.model.clone()).filter(|m| !m.is_empty()),
            effort: Some(session.effort.clone()).filter(|e| !e.is_empty()),
            session_id: Some(claude_session_id.to_string()),
            resume,
            // A steer is matched by its echo, for a bot as for a child.
            replay_user_messages: true,
            asks_questions: carries_conversation(session),
            system_prompt: persona,
            autonomy,
            mcp_config: mcp.map(|(command, args)| crate::providers::claude::claude_mcp_config(&command, &args, true)),
            user_settings: session.kind != "bot",
            // A tier carried over from another provider must not ask an
            // account that cannot use fast mode for it.
            fast: session.service_tier == "fast"
                && crate::provider_session::claude_fast_mode().availability != crew_protocol::FastModeAvailability::Hidden,
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
            // Minted once, with the process: the token is in its environment
            // and its MCP server's, and a later mint would cut both off.
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
        let init = self.block_on(async { tokio::time::timeout(INIT_TIMEOUT, init_rx).await });
        // Waited for once: the CLI says it is up at the start of every turn,
        // and that is nobody's to take.
        if let Some(Live::Claude(live)) = self.lock().get_mut(&session_id) {
            live.init_tx = None;
        }
        match init {
            // Up: how large its window is, for a meter before the first answer.
            Ok(Ok(true)) => self.ask_claude_context(&session_id, false, None),
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
                return Err(NO_ANSWER.into());
            }
        }
        Ok(())
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
        let resume = conversation_to_resume(&session);
        let carries = carries_conversation(&session);
        let files = path_list(&params, &HashSet::new());
        // The persona goes in the system prompt, through a file the config
        // names, every turn; only if that file cannot be written does it ride
        // in the message, as it used to.
        let persona = self.persona(&session, Harness::Opencode, mcp.is_some(), &params.cwd);
        let instructions = persona.as_deref().and_then(|persona| write_opencode_instructions(&session_id, persona));
        let prompt = match (&instructions, carries) {
            (Some(_), true) => crate::providers::with_files(params.text.trim(), &files),
            (Some(_), false) => build_opencode_message(history.as_deref(), &params.text, &files),
            (None, true) => self.child_prompt(persona.as_deref(), resume.is_some(), &params),
            (None, false) => {
                build_opencode_prompt(persona.as_deref().unwrap_or_default(), history.as_deref(), &params.text, &files)
            }
        };
        // opencode has no approval channel: without --auto it falls back to the
        // user's own permission config, which Crew cannot answer for. Saying so
        // once beats an "ask" that silently never asks.
        let first = if carries { resume.is_none() } else { history.is_none() };
        if first && self.autonomy(&session) != Autonomy::Full {
            self.transcripts.append_system(
                &session_id,
                "opencode decides its own permissions: it has no way to ask Crew, so it runs under your opencode config.",
            );
        }
        let mut env = self.agent_env(&session_id);
        let instructions_path = instructions.as_ref().map(|file| file.0.to_string_lossy().into_owned());
        if let Some(config) = opencode_turn_config(mcp.as_ref(), instructions_path.as_deref()) {
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
            seen_tools: HashSet::new(),
            stderr: Vec::new(),
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
                    Some(Live::Codex(live)) => live.active && !live.saw_output && !live.cancelled,
                    Some(Live::Cursor(live)) => live.active && !live.saw_output && !live.cancelled,
                    Some(Live::Opencode(live)) => {
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
            match map.get_mut(session_id) {
                Some(Live::Codex(live)) => live.saw_output = true,
                Some(Live::Cursor(live)) => live.saw_output = true,
                Some(Live::Opencode(live)) => live.saw_output = true,
                _ => {}
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
        // The answer to a request Crew is waiting on; the first one, to
        // `initialize`, nobody waits on and it reads as the CLI being up.
        // The CLI also says `system/init` at the start of every turn, with
        // the user's message that follows it: once it is up, that line
        // starts nothing and the turn's own lines go on.
        if let Some((id, result)) = parse_control_response(&rec) {
            let waiter = match self.lock().get_mut(session_id) {
                Some(Live::Claude(live)) => live.calls.remove(&id),
                _ => None,
            };
            if let Some(waiter) = waiter {
                let _ = waiter.send(result);
                return;
            }
        }
        if let Some(control) = parse_control_request(&rec) {
            self.handle_claude_control(session_id, control);
            return;
        }

        let mut events = Vec::new();
        let mut bind: Option<String> = None;
        // A result held on background work: its count, and the process and
        // turn it was held on.
        let mut hold: Option<(u64, u64, u64)> = None;
        // A task line for the tray, with the call that started its task.
        let mut task: Option<(Value, Option<(String, String, Map<String, Value>)>)> = None;
        let mut spoke = false;
        // What the model's newest request filled of its window; and whether to
        // ask the CLI for the window again: after a compaction, or at the end
        // of a turn with the window its `result` names.
        let mut used: Option<u64> = None;
        let mut ask: Option<(bool, Option<u64>)> = None;
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
            // A subagent's own frame: a step on its call's row, and nothing
            // the agent itself said or did.
            if let Some(steps) = live.subagents.frame(&rec) {
                drop(map);
                if let Some(id) = bind {
                    self.transcripts.apply(session_id, HarnessEvent::SessionProviderBound { provider_session_id: id });
                }
                for event in steps {
                    self.transcripts.apply(session_id, event);
                }
                return;
            }
            let tools = &live.tools_by_id;
            if let Some(update) = live
                .subagents
                .task(&rec, |id| tools.get(id).map(|tool| (tool.name.clone(), tool.input.clone())))
            {
                events.push(update);
            }
            let notice = live.subagents.notice(&rec);
            if type_name.as_deref() == Some("system")
                && matches!(
                    subtype.as_deref(),
                    Some("task_started" | "task_updated" | "task_notification" | "background_tasks_changed")
                )
            {
                let call = string_field(Some(&rec), "tool_use_id").and_then(|id| {
                    live.tools_by_id.get(&id).map(|tool| (id, tool.name.clone(), tool.input.clone()))
                });
                task = Some((Value::Object(rec.clone()), call));
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
                        let summary = notice.or_else(|| string_field(Some(&rec), "summary"));
                        if let Some(summary) = summary.filter(|s| !s.trim().is_empty()) {
                            let summary = summary.trim().to_string();
                            if !live.woken_by.contains(&summary) {
                                live.woken_by.push(summary);
                            }
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
                ask = Some((true, None));
            } else if type_name.as_deref() == Some("stream_event") {
                woken(live, &mut events);
                spoke = true;
                claude_stream(live, &rec, &mut events);
            } else if type_name.as_deref() == Some("assistant") {
                woken(live, &mut events);
                spoke = true;
                claude_assistant(live, &rec, &mut events);
                // One reading per model request, from the first frame of its
                // message; a subagent's request fills its own window.
                if !is_subagent_message(&rec) {
                    if let Some((id, tokens)) = assistant_context(&rec).filter(|(id, _)| *id != live.context_message) {
                        live.context_message = id;
                        used = Some(tokens);
                    }
                }
            } else if type_name.as_deref() == Some("user") {
                // A steer Claude has just taken in: it goes in the transcript
                // here, where the model read it. Only while the turn runs: an
                // echo after its result is the CLI starting a turn of its own
                // on a steer the turn never read, which stays unread, so the
                // process is let go and the box hands the steer over once.
                if let Some(echo) = crate::providers::claude::replayed_text(&rec).filter(|_| live.active) {
                    if let Some(at) = live.steers.iter().position(|steer| steer.sent.trim() == echo) {
                        let steer = live.steers.remove(at);
                        if let Some(id) = steer.letter.as_ref() {
                            let _ = mailbox::delivered(&self.store, std::slice::from_ref(id));
                        }
                        events.push(HarnessEvent::UserMessage {
                            text: steer.text,
                            hidden: None,
                            files: None,
                            from_bot: Some(steer.from),
                            letter_id: steer.letter,
                        });
                    }
                }
                for result in tool_results_from_user_message(&rec) {
                    // The result names only the call, so the input the row was
                    // opened with is what turns it back into a detail.
                    let tool = live.tools_by_id.get(&result.tool_use_id);
                    let detail = tool.and_then(|tool| {
                        claude_tool_result_detail(&tool.name, &tool.input, &result.content, result.is_error)
                    });
                    let files = tool
                        .map(|tool| claude_tool_result_files(&tool.name, &tool.input, &result))
                        .unwrap_or_default();
                    events.push(HarnessEvent::ToolUpdated {
                        call_id: result.tool_use_id.clone(),
                        title: None,
                        status: Some(if result.is_error {
                            ToolStatus::Failed
                        } else {
                            ToolStatus::Completed
                        }),
                        detail,
                    });
                    if !files.is_empty() {
                        events.push(HarnessEvent::ToolFiles { call_id: result.tool_use_id, files });
                    }
                }
            } else if type_name.as_deref() == Some("result") && live.active {
                // Only a turn that is running has a result: one that comes
                // with none (a late answer from a turn already settled, on a
                // process kept between turns) is nobody's to end.
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
                    hold = Some((live.held_results, live.epoch, live.turn));
                } else {
                    live.active = false;
                    if !live.cancelled {
                        ask = Some((false, result_context_window(&rec)));
                    }
                    if let Some(tx) = live.turn_tx.take() {
                        let _ = tx.send(match failed {
                            Some(message) => TurnOutcome::Failed(message),
                            None => TurnOutcome::Completed,
                        });
                    }
                }
            }
        }
        if let Some((rec, call)) = task {
            let now = crate::store::now_millis();
            self.background.touch(session_id, |board| {
                board.claude(
                    &rec,
                    |id| call.as_ref().filter(|(call, _, _)| call == id).map(|(_, name, input)| (name.clone(), input.clone())),
                    now,
                )
            });
        }
        // Held on its background commands, the turn is waiting; the model
        // speaking again is the end of that.
        if hold.is_some() {
            self.background.touch(session_id, |board| board.set_waiting(true));
        } else if spoke {
            self.background.touch(session_id, |board| board.set_waiting(false));
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
        if let Some(used) = used {
            self.publish_context(session_id, |_| Some(ContextReading { used, window: None, auto_compact_at: None }));
        }
        if let Some((compacted, fallback)) = ask {
            self.ask_claude_context(session_id, compacted, fallback);
        }
        if let Some((held, epoch, turn)) = hold {
            let host = self.clone();
            let id = session_id.to_string();
            self.after(BACKGROUND_GRACE, move || {
                // Its own turn, on its own process: a later turn that holds
                // none is not the one this wait was for.
                let still = matches!(
                    host.lock().get(&id),
                    Some(Live::Claude(live)) if live.active && live.epoch == epoch && live.turn == turn && live.held_results == held
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
        // Crew's own tools are pre-approved (plan §7e.5): `--settings` allows
        // them, and should the CLI ask anyway they are allowed here, never
        // turned into an approval card.
        if tool_name.starts_with("mcp__crew__") {
            let _ = self.agents.write(
                &session_id,
                &serde_json::to_string(&build_control_response(
                    &control.request_id,
                    to_permission_result(ApprovalDecision::Allow, &control.input, &tool_name),
                ))
                .unwrap_or_default(),
            );
            return;
        }
        // A child under full autonomy is handed a prompt tool only so that it
        // keeps its question tool: anything else the CLI asks about it was
        // already allowed to do.
        let full = questions.is_empty()
            && session::get(&self.store, session_id.clone())
                .ok()
                .flatten()
                .is_some_and(|row| self.autonomy(&row) == Autonomy::Full);
        if full {
            let _ = self.agents.write(
                &session_id,
                &serde_json::to_string(&build_control_response(
                    &control.request_id,
                    to_permission_result(ApprovalDecision::Allow, &control.input, &tool_name),
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

/// The reading a new one makes after the last: one without a window keeps the
/// last window and auto-compact point.
fn merge_context(last: Option<&ContextReading>, reading: ContextReading) -> ContextReading {
    match (last, reading.window) {
        (Some(last), None) => ContextReading {
            used: reading.used,
            window: last.window,
            auto_compact_at: last.auto_compact_at,
        },
        _ => reading,
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

    pub(crate) fn test_bridge(&self) -> &Bridge {
        &self.bridge
    }

    pub(crate) fn test_capture(&self) -> Arc<Applied> {
        let applied = Arc::new(Applied::default());
        self.transcripts.set_events(applied.clone());
        applied
    }

    pub(crate) fn test_install_claude(&self, id: &str) {
        self.lock().insert(
            id.to_string(),
            Live::Claude(Box::new({
                let mut live = ClaudeLive::new(String::new(), false, Launch::none());
                live.active = true;
                live.initialized = true;
                live
            })),
        );
    }

    pub(crate) fn test_install_codex(&self, id: &str) {
        self.lock().insert(id.to_string(), Live::Codex(Box::new(CodexLive::new(None, Launch::none()))));
    }

    pub(crate) fn test_install_cursor(&self, id: &str) {
        self.lock().insert(id.to_string(), Live::Cursor(Box::new(CursorLive::new(None, Autonomy::Ask))));
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
    use crew_protocol::{BotRef, BlockRole};

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
import json, os, sys
open({seen:?}, "w").write(sys.stdin.read())
config = json.loads(os.environ.get("OPENCODE_CONFIG_CONTENT", "{{}}"))
open({seen:?} + ".config", "w").write(json.dumps(config))
open({seen:?} + ".system", "w").write("".join(open(path).read() for path in config.get("instructions", [])))
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

    fn bot(world: &World, workspace_id: &str, name: &str) -> crate::session::Session {
        crate::session::create(
            world.host.test_store(),
            workspace_id.to_string(),
            "bot".into(),
            name.into(),
            "opencode".into(),
            "m".into(),
            "".into(),
            "full".into(),
            None,
        )
        .expect("bot")
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

    /// Turns run on their own thread; wait for the bot to go quiet.
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
                from_bot: None,
                sent_at: None,
                nonce: None,
                letter_id: None,
                mode: None,
            })
            .expect("start");
        settle(world, &session.id);
    }

    fn blocks(world: &World, session_id: &str) -> Vec<crew_protocol::Block> {
        world.host.transcripts().window(session_id, Some(500), None).blocks
    }

    /// A provider that starts and says nothing must not leave the bot
    /// "working" forever.
    #[test]
    fn a_provider_that_says_nothing_does_not_hang_the_bot() {
        let world = world();
        let ws = workspace(&world);
        let coder = bot(&world, &ws, "Coder");
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
                from_bot: None,
                sent_at: None,
                nonce: None,
                letter_id: None,
                mode: None,
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
        let coder = bot(&world, &ws, "Coder");
        let cuddles = bot(&world, &ws, "Cuddles");
        mailbox::enqueue(
            world.host.test_store(),
            &cuddles.id,
            &BotRef::bot(coder.id.clone(), "Coder"),
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
        assert_eq!(delivered.from_bot.as_ref().map(|from| from.name.as_str()), Some("Coder"));
        assert_eq!(
            mailbox::waiting_count(world.host.test_store(), &cuddles.id).expect("count"),
            0
        );
    }

    /// The turn is the whole prompt: every turn is a new provider session, so
    /// nothing a bot knows survives except what Crew hands it back.
    #[test]
    fn a_second_turn_is_handed_the_first_one() {
        let world = world();
        let seen = world.dir.join("prompt.txt");
        world
            .host
            .override_binary("opencode", fake_opencode_recording(&world.dir, &seen));
        let ws = workspace(&world);
        let coder = bot(&world, &ws, "Coder");

        turn(&world, &coder, "el parser se cae con tabs");
        let first = std::fs::read_to_string(&seen).expect("the provider was never spawned");
        assert!(!first.contains("## The conversation so far"), "{first}");

        turn(&world, &coder, "y ahora?");
        let second = std::fs::read_to_string(&seen).expect("the provider was never spawned");
        // The persona is in the system prompt, through the file the config
        // names, and gone once the turn is over.
        let system = std::fs::read_to_string(world.dir.join("prompt.txt.system")).expect("system");
        assert!(system.starts_with("## Crew bot\n\nYou are Coder,"), "the persona is on every turn: {system}");
        assert!(system.contains("`crew_search_messages`") && !second.contains("You are Coder,"), "{second}");
        let config: Value = serde_json::from_str(&std::fs::read_to_string(world.dir.join("prompt.txt.config")).expect("config")).expect("json");
        assert_eq!(config["permission"]["crew_*"], "allow", "{config}");
        assert_eq!(config["mcp"]["crew"]["timeout"], 3_900_000, "{config}");
        assert!(!std::path::Path::new(config["instructions"][0].as_str().unwrap()).exists(), "the persona file outlived the turn");
        assert!(second.contains("· user] el parser se cae con tabs"), "{second}");
        assert!(second.contains("· you] ok"), "the reply is in the tail too: {second}");
        assert!(second.trim_end().ends_with("y ahora?"), "{second}");
        assert!(
            second.find("· user] el parser").unwrap() < second.find("## This turn").unwrap(),
            "{second}"
        );
    }

    /// The setting overrides a bot that asks: its next turn is spawned the
    /// way a "full" one is, and turning it off gives the bot its own back.
    #[test]
    fn bypass_permissions_runs_an_asking_bot_without_asking() {
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
            "bot".into(),
            "Asker".into(),
            "opencode".into(),
            "m".into(),
            "".into(),
            "ask".into(),
            None,
        )
        .expect("bot");
        let ran_auto = || {
            let raw = std::fs::read_to_string(&argv).expect("the provider was never spawned");
            serde_json::from_str::<Vec<String>>(&raw).expect("argv").iter().any(|arg| arg == "--auto")
        };

        turn(&world, &asker, "one");
        assert!(!ran_auto(), "an asking bot asks by default");

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
        let coder = bot(&world, &ws, "Coder");
        let cuddles = bot(&world, &ws, "Cuddles");
        mailbox::enqueue(
            world.host.test_store(),
            &cuddles.id,
            &BotRef::bot(coder.id.clone(), "Coder"),
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
                "## Message\nFrom: Coder (bot {})\nAt: ",
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
                && block.from_bot.is_some()),
            "the transcript should hold the letter as written: {rows:?}"
        );
    }

    #[test]
    fn a_stopped_turn_leaves_the_box_alone() {
        let world = world();
        let ws = workspace(&world);
        let coder = bot(&world, &ws, "Coder");
        let cuddles = bot(&world, &ws, "Cuddles");
        mailbox::enqueue(
            world.host.test_store(),
            &cuddles.id,
            &BotRef::bot(coder.id.clone(), "Coder"),
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
                from_bot: None,
                sent_at: None,
                nonce: None,
                letter_id: None,
                mode: None,
            })
            .expect("start");
        std::thread::sleep(std::time::Duration::from_millis(300));
        world.host.stop(&cuddles.id).expect("stop");
        settle(&world, &cuddles.id);

        assert_eq!(
            mailbox::waiting_count(world.host.test_store(), &cuddles.id).expect("count"),
            1,
            "a stop should not hand the bot its next letter"
        );
    }

    /// The host builds the persona from the session's own kind, families
    /// and all, and from who started it.
    #[test]
    fn the_host_builds_the_persona_for_the_sessions_kind() {
        let host = TurnHost::test_new();
        host.toolbox().register(Arc::new(crate::tools::CatalogOnly(crate::session_tools::catalog)));
        let store = host.test_store();
        let dir = std::env::temp_dir().join(format!("sheet-{}", uuid::Uuid::new_v4().simple()));
        std::fs::create_dir_all(&dir).expect("dir");
        let ws = crate::workspace::create(store, "sheet".into(), dir.to_string_lossy().into_owned()).expect("workspace").id;
        let bot = crate::session::create(store, ws.clone(), "bot".into(), "B".into(), "claude".into(), "".into(), "".into(), "ask".into(), None)
            .expect("bot");
        let child = crate::session::create_child(store, ws, "C".into(), "claude".into(), "".into(), "ask".into(), None, Some(bot.id.clone()))
            .expect("child");
        let cwd = dir.to_string_lossy().into_owned();
        let told = host.persona(&bot, Harness::Mcp, true, &cwd).expect("bot persona");
        assert!(told.starts_with("## Crew bot") && told.contains("`mcp__crew__start_session`") && told.contains("## Message"), "{told}");
        assert!(told.contains(&format!("Your id is {}.", bot.id)) && told.contains(&format!("You work in {cwd}.")), "{told}");
        let child_told = host.persona(&child, Harness::Mcp, true, &cwd).expect("child persona");
        assert!(child_told.starts_with("## Crew session"), "{child_told}");
        assert!(child_told.contains(&format!("B, a bot (id {}), started you", bot.id)) && !child_told.contains("start_session"), "{child_told}");
        assert!(child_told.contains("your question tool reaches B"), "{child_told}");
        for gone in crate::tools::REMOVED_TOOLS {
            assert!(!told.contains(gone) && !child_told.contains(gone), "{gone}: {told}\n{child_told}");
        }
        let bare = host.persona(&bot, Harness::Mcp, false, &cwd).expect("bot persona");
        assert!(!bare.contains("### Crew tools"), "{bare}");
    }

    /// Crew's own tools never become an approval card, even if the CLI asks.
    #[test]
    fn a_crew_tool_the_cli_asks_about_is_allowed_without_a_card() {
        let host = TurnHost::test_new();
        let cap = host.test_capture();
        host.test_install_claude("s");
        let ask = |id: &str, tool: &str| {
            json!({ "type": "control_request", "request_id": id, "request": {
                "subtype": "can_use_tool", "tool_name": tool, "input": { "command": "ls" }, "tool_use_id": id } })
        };
        host.handle_claude_line("s", &ask("c1", "mcp__crew__list_peers").to_string());
        host.handle_claude_line("s", &ask("c2", "Bash").to_string());
        let deadline = std::time::Instant::now() + Duration::from_secs(5);
        let mut asked = Vec::new();
        while asked.is_empty() && std::time::Instant::now() < deadline {
            std::thread::sleep(Duration::from_millis(20));
            asked.extend(cap.take().into_iter().filter_map(|event| match event {
                HarnessEvent::ApprovalRequested { name, .. } => Some(name),
                _ => None,
            }));
        }
        // The Bash card arrives after the crew call was answered: both were
        // read in order, and only one became a card.
        std::thread::sleep(Duration::from_millis(100));
        asked.extend(cap.take().into_iter().filter_map(|event| match event {
            HarnessEvent::ApprovalRequested { name, .. } => Some(name),
            _ => None,
        }));
        assert_eq!(asked, vec!["Bash".to_string()]);
    }
}

#[cfg(test)]
mod context_tests {
    use super::*;

    fn reading(used: u64, window: Option<u64>, auto_compact_at: Option<u64>) -> ContextReading {
        ContextReading { used, window, auto_compact_at }
    }

    #[test]
    fn a_session_without_a_reading_has_no_context() {
        assert_eq!(TurnHost::test_new().context("s1"), None);
    }

    #[test]
    fn a_reading_without_a_window_keeps_the_last_window_and_compact_point() {
        let host = TurnHost::test_new();
        host.record_context("s1", reading(10, Some(200_000), Some(180_000)));
        let merged = host.record_context("s1", reading(40, None, None));
        assert_eq!(merged, reading(40, Some(200_000), Some(180_000)));
        assert_eq!(host.context("s1"), Some(merged));
    }

    #[test]
    fn a_reading_with_a_window_replaces_the_last_one() {
        let host = TurnHost::test_new();
        host.record_context("s1", reading(10, Some(200_000), Some(180_000)));
        let merged = host.record_context("s1", reading(40, Some(1_000_000), None));
        assert_eq!(merged, reading(40, Some(1_000_000), None));
    }

    fn assistant(id: &str, parent: Option<&str>, input: u64, output: u64) -> String {
        json!({
            "type": "assistant",
            "parent_tool_use_id": parent,
            "message": {
                "id": id,
                "role": "assistant",
                "usage": { "input_tokens": input, "cache_read_input_tokens": 1000, "cache_creation_input_tokens": 10, "output_tokens": output },
                "content": [{ "type": "text", "text": "hi" }],
            },
        })
        .to_string()
    }

    /// One reading per model request of the main agent: a frame of a subagent,
    /// the same message said again, and one with no tokens move nothing; and
    /// the readings keep the window that was asked for.
    #[test]
    fn claude_readings_come_once_per_request_from_the_main_agent() {
        let host = TurnHost::test_new();
        let applied = host.test_capture();
        host.test_install_claude("s");
        host.record_context("s", reading(1, Some(200_000), Some(160_000)));
        let used = || {
            applied
                .take()
                .into_iter()
                .filter_map(|event| match event {
                    HarnessEvent::ContextUpdated { used, window, .. } => Some((used, window)),
                    _ => None,
                })
                .collect::<Vec<_>>()
        };
        host.handle_claude_line("s", &assistant("m1", None, 100, 5));
        host.handle_claude_line("s", &assistant("m1", None, 5000, 50));
        host.handle_claude_line("s", &assistant("sub", Some("toolu_1"), 90_000, 5));
        // The CLI's own notice, which counts no tokens.
        host.handle_claude_line(
            "s",
            &json!({
                "type": "assistant",
                "message": {
                    "id": "none",
                    "usage": { "input_tokens": 0, "cache_read_input_tokens": 0, "output_tokens": 0 },
                    "content": [{ "type": "text", "text": "No response requested." }],
                },
            })
            .to_string(),
        );
        assert_eq!(used(), vec![(1115, Some(200_000))]);
        host.handle_claude_line("s", &assistant("m2", None, 200, 7));
        assert_eq!(used(), vec![(1217, Some(200_000))]);
        assert_eq!(host.context("s"), Some(reading(1217, Some(200_000), Some(160_000))));
    }

    /// A CLI that does not answer `get_context_usage` still has a window: the
    /// one its `result` names for the model, unless one is known already.
    #[test]
    fn the_window_a_result_names_stands_in_when_the_cli_does_not_answer() {
        let host = TurnHost::test_new();
        host.test_install_claude("s");
        host.handle_claude_line("s", &assistant("m1", None, 100, 5));
        assert_eq!(host.context("s"), Some(reading(1115, None, None)));
        host.handle_claude_line(
            "s",
            &json!({
                "type": "result",
                "subtype": "success",
                "is_error": false,
                "result": "ok",
                "modelUsage": { "claude-opus": { "contextWindow": 1_000_000 }, "claude-haiku": { "contextWindow": 200_000 } },
            })
            .to_string(),
        );
        for _ in 0..200 {
            if host.context("s").is_some_and(|last| last.window.is_some()) {
                break;
            }
            thread::sleep(Duration::from_millis(25));
        }
        assert_eq!(host.context("s"), Some(reading(1115, Some(1_000_000), None)));
    }

    #[test]
    fn each_session_keeps_its_own_reading() {
        let host = TurnHost::test_new();
        host.record_context("s1", reading(10, Some(200_000), None));
        host.record_context("s2", reading(20, None, None));
        assert_eq!(host.context("s1"), Some(reading(10, Some(200_000), None)));
        assert_eq!(host.context("s2"), Some(reading(20, None, None)));
    }
}

#[cfg(test)]
mod plan_tests {
    use super::*;

    fn launch() -> Launch {
        Launch {
            model: Some("sonnet".into()),
            effort: Some("medium".into()),
            service_tier: None,
            autonomy: Autonomy::Ask,
            cwd: "/w".into(),
        }
    }

    /// A kept Codex process is told only what moved: nothing when nothing
    /// did, and access as its three fields together, so a turn that kept the
    /// autonomy never resets what the user's config says of the sandbox.
    #[test]
    fn a_kept_codex_process_is_told_only_what_moved() {
        assert!(launch().turn_overrides_since(&launch()).is_empty());
        let moved = Launch { model: Some("opus".into()), autonomy: Autonomy::Full, ..launch() };
        let mut keys: Vec<String> = moved.turn_overrides_since(&launch()).keys().cloned().collect();
        keys.sort();
        assert_eq!(keys, ["approvalPolicy", "approvalsReviewer", "model", "sandboxPolicy"]);
    }

    fn plan(change: impl FnOnce(&mut Launch), fast_allowed: bool) -> Plan {
        let mut new = launch();
        change(&mut new);
        claude_plan(&launch(), &new, fast_allowed)
    }

    #[test]
    fn settings_that_did_not_move_need_nothing() {
        assert_eq!(plan(|_| {}, true), Plan::Changes(vec![]));
    }

    #[test]
    fn a_model_an_effort_and_a_mode_change_in_place_in_that_order() {
        let plan = plan(
            |new| {
                new.model = Some("opus".into());
                new.effort = Some("max".into());
                new.autonomy = Autonomy::Auto;
            },
            true,
        );
        assert_eq!(
            plan,
            Plan::Changes(vec![
                Change::Model("opus".into()),
                Change::Effort("max".into()),
                Change::Permission(Autonomy::Auto),
            ])
        );
        let Plan::Changes(changes) = plan else { unreachable!() };
        let requests: Vec<Value> = changes.iter().filter_map(Change::request).collect();
        assert_eq!(
            requests,
            [
                json!({ "subtype": "set_model", "model": "opus" }),
                json!({ "subtype": "apply_flag_settings", "settings": { "effortLevel": "max" } }),
                json!({ "subtype": "set_permission_mode", "mode": "auto" }),
            ]
        );
    }

    #[test]
    fn a_first_model_or_effort_is_set_in_place() {
        let mut old = launch();
        old.model = None;
        old.effort = None;
        assert_eq!(
            claude_plan(&old, &launch(), true),
            Plan::Changes(vec![Change::Model("sonnet".into()), Change::Effort("medium".into())])
        );
    }

    #[test]
    fn what_only_a_launch_sets_is_a_relaunch() {
        assert_eq!(plan(|new| new.cwd = "/other".into(), true), Plan::Relaunch);
        assert_eq!(plan(|new| new.model = None, true), Plan::Relaunch);
        assert_eq!(plan(|new| new.effort = None, true), Plan::Relaunch);
        assert_eq!(plan(|new| new.autonomy = Autonomy::Full, true), Plan::Relaunch);
        let mut old = launch();
        old.autonomy = Autonomy::Full;
        assert_eq!(claude_plan(&old, &launch(), true), Plan::Relaunch);
        // Even with the rest changing in place.
        assert_eq!(
            plan(
                |new| {
                    new.model = Some("opus".into());
                    new.cwd = "/other".into();
                },
                true
            ),
            Plan::Relaunch
        );
    }

    #[test]
    fn fast_is_asked_for_only_where_the_account_may_use_it() {
        let fast = |new: &mut Launch| new.service_tier = Some("fast".into());
        let on = Change::Tier { tier: Some("fast".into()), fast: Some(true) };
        assert_eq!(plan(fast, true), Plan::Changes(vec![on.clone()]));
        assert_eq!(
            on.request(),
            Some(json!({ "subtype": "apply_flag_settings", "settings": { "fastMode": true } }))
        );
        // Hidden: a tier carried over from another provider says nothing, as at launch.
        let hidden = Change::Tier { tier: Some("fast".into()), fast: None };
        assert_eq!(plan(fast, false), Plan::Changes(vec![hidden.clone()]));
        assert_eq!(hidden.request(), None);
    }

    #[test]
    fn fast_is_turned_off_when_the_tier_leaves_it() {
        let mut old = launch();
        old.service_tier = Some("fast".into());
        for allowed in [true, false] {
            let Plan::Changes(changes) = claude_plan(&old, &launch(), allowed) else { panic!("relaunch") };
            assert_eq!(
                changes[0].request(),
                Some(json!({ "subtype": "apply_flag_settings", "settings": { "fastMode": false } })),
                "{allowed}"
            );
        }
    }

    #[test]
    fn a_change_is_recorded_as_what_the_process_runs_on() {
        let mut applied = launch();
        Change::Model("opus".into()).record(&mut applied);
        Change::Effort("high".into()).record(&mut applied);
        Change::Permission(Autonomy::Edits).record(&mut applied);
        Change::Tier { tier: Some("fast".into()), fast: Some(true) }.record(&mut applied);
        assert_eq!(
            applied,
            Launch {
                model: Some("opus".into()),
                effort: Some("high".into()),
                service_tier: Some("fast".into()),
                autonomy: Autonomy::Edits,
                cwd: "/w".into(),
            }
        );
    }

    #[test]
    fn codex_lets_a_process_go_only_for_a_setting_taken_back() {
        let mut new = launch();
        new.model = Some("other".into());
        new.autonomy = Autonomy::Full;
        new.cwd = "/other".into();
        assert!(!new.clears_a_setting_of(&launch()));
        let mut cleared = launch();
        cleared.effort = None;
        assert!(cleared.clears_a_setting_of(&launch()));
        // A setting that was never set is not taken back.
        assert!(!launch().clears_a_setting_of(&cleared));
    }
}
