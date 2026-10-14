use std::collections::{HashMap, HashSet};
use std::future::Future;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::mpsc::{self, Sender};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant};

use tokio::sync::oneshot;

use crew_protocol::{
    ApprovalDecision, ApprovalResolution, AttachedFile, AttachedFileKind, ContextReading, HarnessEvent, ToolStatus,
    TurnStart, TurnStarted,
};
use serde_json::{json, Map, Value};

use crate::agent::AgentHost;
use crate::bridge::Bridge;
use crate::providers::claude::{
    assistant_context, assistant_text_blocks, assistant_tool_uses, build_claude_dispatch_message, build_claude_spawn_args,
    build_claude_user_message, build_control_request, build_control_response, get_context_usage_request, get_task_output_request,
    input_json_delta_from_event, is_compact_boundary, is_message_start, is_subagent_message,
    parse_context_usage, permission_mode, parse_control_cancel_id, parse_control_request, parse_control_response, parse_questions,
    reload_plugins_request, reload_skills_request, result_context_window, stop_task_request,
    session_id_from_message, stream_text_delta, to_permission_result,
    to_question_result, tool_detail as claude_tool_detail, tool_label as claude_tool_label,
    tool_result_detail as claude_tool_result_detail, tool_result_files as claude_tool_result_files,
    tool_results_from_user_message, tool_start_from_event,
    try_parse_json_record, turn_failed as claude_turn_failed, turn_usage as claude_turn_usage, ClaudeControlRequest,
    ClaudeSpawn, Subagents,
};
use crate::providers::parse_json_line;
use crate::providers::{string_field, Autonomy};
use crate::mailbox;
pub(crate) use crate::prompts::Harness;
use crate::session;
use crate::working_set;
use crate::store::Store;
use crate::transcript::TranscriptHub;

mod codex;
mod cursor;
mod mcp;
mod opencode;
mod opencode_server;
use codex::CodexLive;
use cursor::CursorLive;
use opencode::OpencodeLive;
#[cfg(test)]
pub(crate) use opencode::fake_opencode_server;
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
/// An `mcp_reconnect` is not answered until the server has been dialed again,
/// which for one over the network takes a few seconds.
#[cfg(not(test))]
const MCP_RECONNECT_TIMEOUT: Duration = Duration::from_secs(20);
#[cfg(test)]
const MCP_RECONNECT_TIMEOUT: Duration = Duration::from_secs(10);
/// A `set_model` is not answered until the CLI has checked the model with the
/// server, which it gives up on after 5 s of its own (measured on 2.1.295:
/// answers at 0.9 to 2 s, and in about 1 run in 8 at 5.0 to 5.6 s, for a full
/// model id the CLI does not already know). The wait has to outlast that
/// deadline, or the process is launched again for nothing.
#[cfg(not(test))]
const SET_MODEL_TIMEOUT: Duration = Duration::from_secs(20);
#[cfg(test)]
const SET_MODEL_TIMEOUT: Duration = Duration::from_secs(10);
/// A `generate_session_title` is a model call of its own (Haiku), answered
/// in a second or two.
const TITLE_TIMEOUT: Duration = Duration::from_secs(30);

/// What a control request that waited out its timeout fails with.
const NO_ANSWER: &str = "Claude Code did not answer in time.";

/// Whether the `/` menu lists `/fast` for this provider. Claude's depends on
/// the account, as the reading last taken of it says: this does not ask again,
/// which would start a CLI for a menu.
fn offers_fast(provider: &str) -> bool {
    use crew_protocol::FastModeAvailability::{Available, Cooldown};
    match provider {
        "claude" => crate::provider_session::claude_fast_mode_cached()
            .is_some_and(|mode| matches!(mode.availability, Available | Cooldown)),
        "codex" | "cursor" => true,
        _ => false,
    }
}

/// How long the answer to this control request is waited for.
fn control_timeout(request: &Value) -> Duration {
    match request.get("subtype").and_then(Value::as_str) {
        Some("set_model") => SET_MODEL_TIMEOUT,
        Some("mcp_reconnect") => MCP_RECONNECT_TIMEOUT,
        Some("generate_session_title") => TITLE_TIMEOUT,
        _ => CONTROL_TIMEOUT,
    }
}
/// How long a child's Claude turn may wait, after a `result`, for the
/// background commands it left running: Claude picks the conversation up by
/// itself when they finish, with another `result`. Past this, the turn ends on
/// the result it had, so a server left running in the background cannot hold
/// it forever; the process stays up with the work, and the turn the CLI
/// starts when it reports is the child's next.
/// How long a letter waits for the next one before a turn starts on it, and
/// the most any letter waits from the first of its batch (plan decision 17):
/// reports from several subagents become one turn, not one interruption each.
/// A question or an approval waits for nothing: someone is blocked on it.
/// Tests that are not about batching run with no window, so a letter goes the
/// moment it lands; the ones about it set one (`set_batch_window`).
const BATCH_WAIT: Duration = Duration::from_millis(if cfg!(test) { 0 } else { 2_000 });
const BATCH_MAX: Duration = Duration::from_millis(if cfg!(test) { 0 } else { 10_000 });

/// How many milliseconds are left before a batch of letters goes: it goes
/// `wait` after the newest, but never later than `max` after the oldest. At
/// zero or less, now.
pub(crate) fn batch_remaining(oldest: i64, newest: i64, now: i64, wait: i64, max: i64) -> i64 {
    (newest + wait).min(oldest + max) - now
}

const BACKGROUND_GRACE: Duration = Duration::from_secs(if cfg!(test) { 2 } else { 600 });
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
    /// A top-level session of the user's: their own CLI, run by Crew
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

/// How Crew drives `session`, if it does. The one place that says which sessions are driven; the checks that mean
/// "carries the provider's conversation" or "is the user's own" ask it.
fn driven(session: &crate::session::Session) -> Option<Driven> {
    match session.kind.as_str() {
        "bot" => Some(Driven::Bot),
        "child" => Some(Driven::Child),
        "terminal" => Some(Driven::User),
        _ => None,
    }
}

/// Whether `letter` is the user's own message to a session that is theirs: it
/// reaches the model as they typed it, with no envelope.
fn is_own(drive: Driven, letter: &mailbox::Letter) -> bool {
    drive == Driven::User && letter.from.kind.as_deref() == Some("user")
}

/// Whether `from` is the user typing to a session Crew drives for them: the
/// transcript shows the message as theirs, not as a letter from "You".
fn typed_by_user(drive: Driven, from: &crew_protocol::BotRef) -> bool {
    drive != Driven::Bot && from.kind.as_deref() == Some("user")
}

/// The CLIs that take a message into a turn that is running; a message to any
/// other waits for the turn to end.
pub(crate) const STEERABLE: [&str; 3] = ["claude", "codex", "opencode"];

/// What the user asked a message sent while a turn runs to become.
#[derive(Clone, Copy, PartialEq, Eq)]
enum SendMode {
    /// Steer where the provider takes a steer, else queue.
    Auto,
    Steer,
    Queue,
}

/// The files that go with a message the user sent: the ones attached, and the
/// ones mentioned in the text (`@path`), which the turn is told of the same
/// way, as paths to read.
fn attached(params: &TurnStart) -> Vec<AttachedFile> {
    let mut files = params.files.clone().unwrap_or_default();
    for path in params.mentions.iter().flatten() {
        if !files.iter().any(|file| &file.path == path) {
            files.push(AttachedFile { kind: Some(AttachedFileKind::File), ..mailbox::file_at(path) });
        }
    }
    files
}

/// The command and skills a message asks for, as the letter that carries it
/// keeps them.
fn dispatch_of(params: &TurnStart) -> Option<mailbox::Dispatch> {
    mailbox::Dispatch::of(params.command.as_deref(), params.skills.as_deref())
}

/// What `begin` answers when the session has a turn already.
const ALREADY_RUNNING: &str = "Turn already running";

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
    /// What kind of letter it is, for the block that shows it.
    kind: Option<crew_protocol::LetterKind>,
    /// What was attached to it; its paths are in `sent`.
    files: Vec<AttachedFile>,
    /// Whether the transcript shows it as the user's own message rather than
    /// as a letter from somebody (see [`typed_by_user`]).
    typed: bool,
    /// The other letters of a batch written in the same message (plan
    /// decision 17): each is claimed, and each reads and is delivered with it.
    rest: Vec<Extra>,
}

/// A letter that rides in the same steer as another.
#[derive(Clone)]
pub(crate) struct Extra {
    letter: String,
    text: String,
    from: crew_protocol::BotRef,
    kind: Option<crew_protocol::LetterKind>,
}

impl Steer {
    /// The turn ended before reading it: it goes back in the box, under the
    /// id it was written with, and the end of the turn hands it over as the
    /// next one.
    fn put_back(self, store: &crate::store::Store, session_id: &str) {
        for extra in &self.rest {
            let _ = mailbox::release(store, &extra.letter);
        }
        match self.letter {
            Some(id) => {
                let _ = mailbox::release(store, &id);
            }
            None => {
                let _ = mailbox::enqueue_with_files(store, session_id, &self.from, &self.text, self.files, None);
            }
        }
    }

    /// The message as the transcript shows it once the turn has read it: one
    /// block per letter it carried.
    fn read(self) -> Vec<HarnessEvent> {
        let typed = self.typed;
        let mut events = vec![HarnessEvent::UserMessage {
            text: self.text,
            hidden: None,
            files: Some(self.files).filter(|files| !files.is_empty()),
            from_bot: (!typed).then_some(self.from),
            letter_id: self.letter,
            letter_kind: self.kind.filter(|_| !typed),
        }];
        for extra in self.rest {
            events.push(HarnessEvent::UserMessage {
                text: extra.text,
                hidden: None,
                files: None,
                from_bot: Some(extra.from),
                letter_id: Some(extra.letter),
                letter_kind: extra.kind,
            });
        }
        events
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
/// calls in flight, the stderr tail, the launch settings, and what it runs in
/// the background (the work, its subagents, the steers it still holds); the
/// rest belongs to the turn that is running and starts over in
/// [`ClaudeLive::begin_turn`].
struct ClaudeLive {
    epoch: u64,
    /// Turns begun on this process, so a timer armed in one cannot act on a
    /// later one.
    turn: u64,
    /// What it was launched with.
    applied: Launch,
    claude_session_id: String,
    /// Whether a result waits for the background commands: a child's turn
    /// does, since its report is the last thing it says. The user's and a
    /// bot's end on their result: the user's process stays up with the work,
    /// and the turn the CLI starts by itself when it reports is taken as one
    /// nobody sent ([`TurnHost::adopt_claude_turn`]).
    waits_for_background: bool,
    /// Results that ended nothing yet, so the grace timer can tell its own
    /// wait from a later one. Counts on for the life of the process: it is
    /// never started over, so a timer of an earlier turn cannot find it equal.
    held_results: u64,
    /// The running turn's result came and is held on background work: the
    /// CLI is idle until that work reports, so there is no turn in it to
    /// interrupt.
    held: bool,
    /// Background work finished in a way that wakes the model (it completed or
    /// failed; a task stopped wakes nobody), and the model has not spoken
    /// since: the CLI is about to start a turn on it.
    wakes: bool,
    /// The running turn is one the CLI started by itself. With no sender for
    /// its outcome (`turn_tx` empty) it is waiting for the turn of Crew's that
    /// was being started when it began: that turn takes it over.
    self_started: bool,
    /// Control requests Crew sent and waits on, by request id.
    calls: HashMap<String, Sender<Result<Value, String>>>,
    next_ui: u64,
    next_control: u64,
    /// Whether the CLI has said it is up. It says it again at the start of
    /// every turn, which tells nothing new.
    initialized: bool,
    /// Only while the process is being launched: what waits for its first word.
    init_tx: Option<oneshot::Sender<bool>>,
    /// Only while the process is being launched: the id `initialize` was sent
    /// under, so its answer, which lists the commands, is told from the rest.
    init_id: Option<String>,
    /// The folder whose `/` menu this process keeps current, when it is the
    /// user's own menu: a bot's CLI reads fewer settings, so what it lists
    /// must not stand for the folder.
    menu_cwd: Option<String>,
    /// Whether the user has been told this process runs fast turns at
    /// standard speed, which is said once.
    fast_refused: bool,
    /// Whether this process has been asked to name its conversation.
    title_asked: bool,
    stderr: Vec<String>,
    /// Steers written and not yet echoed, oldest first. A turn that ends
    /// before reading one leaves it here: the CLI starts a turn of its own on
    /// it, and its echo there is where the transcript gets it.
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
    /// The subagents it started: their frames go to their calls' rows. A
    /// background one outlives the turn that sent it.
    subagents: Subagents,
    /// The turn was stopped and the CLI has not said it is over yet.
    cancelled: bool,
    /// Deaf until the interrupt's `result`: what Claude says to the interrupt
    /// is not the outcome of the turn, which ended when it was stopped, nor of
    /// the next one. Its background work is still heard.
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
            held: false,
            wakes: false,
            self_started: false,
            calls: HashMap::new(),
            next_ui: 1,
            next_control: 1,
            initialized: false,
            init_tx: None,
            init_id: None,
            menu_cwd: None,
            fast_refused: false,
            title_asked: false,
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
    /// itself goes, what belongs to the process stays. The background work
    /// and its subagents are the process's: they run on between turns. So are
    /// the steers a turn left unread, which the CLI still holds, and what
    /// woke the model, which is said once it speaks. `turn_tx` is `None` for
    /// a turn the CLI started by itself while a turn of Crew's was on its way
    /// in: that one takes it over.
    fn begin_turn(&mut self, turn_tx: Option<oneshot::Sender<TurnOutcome>>, self_started: bool) {
        self.turn += 1;
        drop_pending(self);
        self.tools_by_index.clear();
        self.tools_by_id.clear();
        self.cancelled = false;
        self.mute = false;
        self.held = false;
        self.self_started = self_started;
        self.active = true;
        self.turn_tx = turn_tx;
        self.emitted_assistant.clear();
    }

    /// A turn the CLI started by itself, that a turn of Crew's is to take over.
    fn unclaimed(&self) -> bool {
        self.active && self.self_started && self.turn_tx.is_none()
    }

    /// The running turn is over: it ends with nothing held.
    fn end_turn(&mut self, outcome: TurnOutcome) {
        self.active = false;
        self.held = false;
        if let Some(tx) = self.turn_tx.take() {
            let _ = tx.send(outcome);
        }
    }
}

enum Live {
    Claude(Box<ClaudeLive>),
    Codex(Box<CodexLive>),
    Cursor(Box<CursorLive>),
    Opencode(Box<OpencodeLive>),
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
    /// Where Cursor keeps its ACP sessions' stores (`~/.cursor/acp-sessions`),
    /// when not under `$HOME`.
    cursor_acp_sessions: Arc<Mutex<Option<std::path::PathBuf>>>,
    /// Where Cursor keeps its installed plugins (`~/.cursor/plugins/cache`),
    /// when not under `$HOME`. Its skills are read from there.
    cursor_plugins: Arc<Mutex<Option<std::path::PathBuf>>>,
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
    /// Subagents whose latest turn only the user started, by writing in their
    /// tab: its report is the user's alone, and does not go to the parent.
    user_started: Arc<Mutex<HashSet<String>>>,
    /// The letters each session's running turn was handed, until the provider
    /// confirms it read them (plan decision 18): a daemon that stops before
    /// that hands them over again.
    carrying: Arc<Mutex<HashMap<String, Vec<String>>>>,
    /// Sessions with a timer running to hand over a batch of letters.
    batching: Arc<Mutex<HashSet<String>>>,
    /// Sessions whose last turn failed before reading its letters: they wait
    /// for the user, a new letter or a restart rather than start the same
    /// failing turn again.
    held: Arc<Mutex<HashSet<String>>>,
    /// How long a letter waits for the next, and the most it waits from the
    /// first (see [`BATCH_WAIT`]).
    batch_window: Arc<Mutex<(Duration, Duration)>>,
    /// Sessions with a turn from `start` until its outcome is in, claimed in
    /// one step. The live CLI is installed later, on the turn's own thread, so
    /// a check on it alone let a message that arrived in between start a
    /// second turn on the same session.
    running: Arc<Mutex<HashSet<String>>>,
    /// What each session has running in the background, kept for the life of
    /// the session rather than of a turn or a process.
    background: crate::background::BackgroundHost,
    /// The `/` menu each provider offers in each folder.
    commands: crate::commands::CommandsHost,
    /// The MCP servers of each session, and how they stand.
    mcp_status: crate::mcp_status::McpHost,
    /// The one `opencode serve` every opencode session runs on.
    opencode: opencode_server::OpencodeServer,
    /// The newest context reading of each session, merged as they come.
    contexts: Arc<Mutex<HashMap<String, ContextReading>>>,
    /// Sessions whose process is up with no turn on it, since when. Apart from
    /// the process entries so the drivers' match arms do not all change.
    idle: Arc<Mutex<HashMap<String, Instant>>>,
    /// Sessions whose running turn is being stopped to send the user's letter
    /// at the head of the queue: the end of that stop hands the queue over
    /// instead of holding it.
    sending_now: Arc<Mutex<HashSet<String>>>,
    /// Child turns out of `running` that have not yet written how they ended:
    /// a waiter must not take that gap for a session with nothing to report.
    settling: Arc<Mutex<HashSet<String>>>,
    /// Sessions asked for a name since the daemon started (see
    /// [`TurnHost::name_untitled`]): one ask each, whatever it comes to.
    naming: Arc<Mutex<HashSet<String>>>,
    /// One name asked at a time: a sweep finds every unnamed session at once.
    naming_gate: Arc<Mutex<()>>,
    /// Run once by the next Claude turn just before its message goes in: a
    /// test puts the CLI's own turn there, the race that is otherwise a
    /// matter of milliseconds.
    #[cfg(test)]
    before_message: Arc<Mutex<Option<Hook>>>,
}

/// What a test runs at a point of a turn's own choosing.
#[cfg(test)]
type Hook = Box<dyn FnOnce() + Send>;

impl TurnHost {
    pub fn new(agents: AgentHost, store: Store, transcripts: TranscriptHub, bridge: Bridge) -> Self {
        // What the last daemon left on the boards comes back here, its running
        // entries stopped: no process of theirs is left to read or stop.
        let background = crate::background::BackgroundHost::persisted(store.clone());
        Self {
            agents,
            store,
            transcripts,
            bridge,
            inner: Arc::new(Mutex::new(HashMap::new())),
            binaries: Arc::new(Mutex::new(HashMap::new())),
            claude_home: Arc::new(Mutex::new(None)),
            cursor_acp_sessions: Arc::new(Mutex::new(None)),
            cursor_plugins: Arc::new(Mutex::new(None)),
            runtime: Arc::new(Mutex::new(None)),
            cancelled: Arc::new(Mutex::new(HashSet::new())),
            answered: Arc::new(Mutex::new(HashSet::new())),
            toolbox: crate::tools::Toolbox::default(),
            signal: crate::session_events::Signal::default(),
            exiting: Arc::new(Mutex::new(HashMap::new())),
            user_started: Arc::new(Mutex::new(HashSet::new())),
            carrying: Arc::new(Mutex::new(HashMap::new())),
            batching: Arc::new(Mutex::new(HashSet::new())),
            held: Arc::new(Mutex::new(HashSet::new())),
            batch_window: Arc::new(Mutex::new((BATCH_WAIT, BATCH_MAX))),
            running: Arc::new(Mutex::new(HashSet::new())),
            background,
            commands: crate::commands::CommandsHost::default(),
            mcp_status: crate::mcp_status::McpHost::default(),
            opencode: opencode_server::OpencodeServer::default(),
            contexts: Arc::new(Mutex::new(HashMap::new())),
            idle: Arc::new(Mutex::new(HashMap::new())),
            sending_now: Arc::new(Mutex::new(HashSet::new())),
            settling: Arc::new(Mutex::new(HashSet::new())),
            naming: Arc::new(Mutex::new(HashSet::new())),
            naming_gate: Arc::new(Mutex::new(())),
            #[cfg(test)]
            before_message: Arc::new(Mutex::new(None)),
        }
    }

    /// Every session's background commands: crewd lists them, and hears
    /// when they change.
    pub fn background(&self) -> &crate::background::BackgroundHost {
        &self.background
    }

    /// Every folder's `/` menu: crewd hears when one changes.
    pub fn commands(&self) -> &crate::commands::CommandsHost {
        &self.commands
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
            // Claude's AskUserQuestion, Codex's user-input requests and
            // opencode's question forms reach the parent; Cursor offers none.
            question_tool: matches!(session.provider.as_str(), "claude" | "codex" | "opencode"),
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

    /// Look for Cursor's ACP session stores in `dir` instead of
    /// `~/.cursor/acp-sessions`.
    pub fn override_cursor_acp_sessions(&self, dir: impl Into<std::path::PathBuf>) {
        *self.cursor_acp_sessions.lock().unwrap_or_else(|e| e.into_inner()) = Some(dir.into());
    }

    /// Look for Cursor's installed plugins in `dir` instead of
    /// `~/.cursor/plugins/cache`.
    pub fn override_cursor_plugins(&self, dir: impl Into<std::path::PathBuf>) {
        *self.cursor_plugins.lock().unwrap_or_else(|e| e.into_inner()) = Some(dir.into());
    }

    /// Look for Claude's conversations under `home` instead of `$HOME`.
    pub fn override_claude_home(&self, home: impl Into<std::path::PathBuf>) {
        *self.claude_home.lock().unwrap_or_else(|e| e.into_inner()) = Some(home.into());
    }

    /// Whether Claude already holds conversation `id` for a run in `cwd`: its
    /// file is under the project folder it files `cwd` in, whether `cwd` is
    /// written as given or as the path it resolves to (what the CLI sees).
    /// The folder Claude keeps `.claude` under.
    fn claude_home_dir(&self) -> Option<std::path::PathBuf> {
        self.claude_home
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .clone()
            .or_else(|| std::env::var_os("HOME").filter(|home| !home.is_empty()).map(std::path::PathBuf::from))
    }

    fn claude_holds(&self, cwd: &str, id: &str) -> bool {
        let Some(home) = self.claude_home_dir() else {
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

    /// A message the user sent from the window.
    ///
    /// To a child or to the user's own session it is a letter from the user
    /// (so the pair "You ⇄ child" has its thread, and a child's parent sees a
    /// line where the user wrote to it), and what becomes of it depends on
    /// the session (plan decisions 30–32):
    /// - Idle, nothing held: a turn of its own, whatever `mode` says.
    /// - A turn running, and the provider takes a message into one (Claude,
    ///   Codex) and `mode` is not `queue`: steered into it. Its echo marks the
    ///   letter delivered. A turn that ends before reading it gives it back to
    ///   the queue, unless the CLI still holds it to start a turn of its own
    ///   on (Claude, after a result), where its echo is read.
    /// - Otherwise it waits in the queue, to go with whatever else waits as
    ///   one turn when the running one ends. `steer` where the provider cannot
    ///   take one falls back to this. A message with a command or skills
    ///   always waits (see [`TurnHost::hand_in`]), and one with a command goes
    ///   as a turn of its own.
    /// - Idle, but with letters held (a stop leaves the queue to the user):
    ///   this message is the user saying go on. It joins the queue, and all of
    ///   it goes as one turn, in order.
    ///
    /// A bot, and a message that is hidden or another bot's, only ever start
    /// a turn.
    pub fn start_by_user(&self, mut params: TurnStart) -> Result<TurnStarted, String> {
        params.letter_id = None;
        let session = session::get(&self.store, params.session_id.clone())?
            .ok_or_else(|| "Session not found".to_string())?;
        let drive = driven(&session);
        if !matches!(drive, Some(Driven::Child | Driven::User)) || params.hidden == Some(true) || params.from_bot.is_some() {
            // A bot the user writes to is theirs again too: its count starts
            // over (plan decision 27).
            if drive == Some(Driven::Bot) && params.hidden != Some(true) && params.from_bot.is_none() {
                self.user_wrote(&session.id);
            }
            return self.start(params);
        }
        if drive == Some(Driven::Child) && session.status == "exited" {
            return Err("This session has exited. Start another one.".into());
        }
        self.user_wrote(&session.id);
        let mode = match params.mode.as_deref() {
            None | Some("auto") => SendMode::Auto,
            Some("steer") => SendMode::Steer,
            Some("queue") => SendMode::Queue,
            Some(other) => return Err(format!("mode is auto, steer or queue, not \"{other}\"")),
        };
        if !self.is_running(&session.id) && mailbox::waiting_count(&self.store, &session.id)? == 0 {
            match self.start_with_letter(&session, params.clone()) {
                // A turn began between the look and the start: this message is
                // for the one that is running.
                Err(error) if error == ALREADY_RUNNING => {}
                started => return started,
            }
        }
        self.hand_in(&session, params, mode)
    }

    /// The turn a message starts on an idle session, with the message as the
    /// letter it carries.
    fn start_with_letter(&self, session: &crate::session::Session, mut params: TurnStart) -> Result<TurnStarted, String> {
        let files = params.files.clone().unwrap_or_default();
        let letter = mailbox::record_claimed_with_files(
            &self.store,
            &session.id,
            &mailbox::user(),
            &params.text,
            files,
            dispatch_of(&params),
        )?;
        params.letter_id = Some(letter.id.clone());
        match self.start(params) {
            Ok(started) => {
                self.tell_parent(session, &letter.id);
                Ok(TurnStarted { delivery: Some("started".into()), letter_id: Some(letter.id), ..started })
            }
            Err(error) => {
                let _ = mailbox::dispose(&self.store, &letter.id);
                Err(error)
            }
        }
    }

    /// A message for a session that has a turn, or letters held: steered into
    /// the turn where the provider takes that, else in the queue. Whatever the
    /// queue holds goes over at once if nothing runs. A message with a command
    /// is a turn of its own and one with skills needs them loaded ahead (a
    /// steer is not known to expand them), so neither is ever steered.
    fn hand_in(&self, session: &crate::session::Session, params: TurnStart, mode: SendMode) -> Result<TurnStarted, String> {
        let id = session.id.as_str();
        let files = attached(&params);
        let dispatch = dispatch_of(&params);
        let mut written = None;
        if mode != SendMode::Queue
            && dispatch.is_none()
            && STEERABLE.contains(&session.provider.as_str())
            && self.is_running(id)
        {
            // Claimed by the turn it is written into: read, it is delivered;
            // not taken, it is released and waits like any other.
            let letter = mailbox::record_claimed_with_files(
                &self.store,
                id,
                &mailbox::user(),
                &params.text,
                files.clone(),
                None,
            )?;
            match self.steer_files(id, &params.text, mailbox::user(), Some(letter.id.clone()), files.clone(), Vec::new()) {
                Ok(()) => {
                    self.tell_parent(session, &letter.id);
                    return Ok(TurnStarted {
                        working: true,
                        delivery: Some("steered".into()),
                        letter_id: Some(letter.id),
                    });
                }
                Err(_) => {
                    mailbox::release(&self.store, &letter.id)?;
                    written = Some(letter);
                }
            }
        }
        let letter = match written {
            Some(letter) => letter,
            None => mailbox::enqueue_with_files(&self.store, id, &mailbox::user(), &params.text, files, dispatch)?,
        };
        self.tell_parent(session, &letter.id);
        // Behind a turn that ended meanwhile, or onto a queue a stop held.
        let started = self.drain_mailbox(id);
        Ok(TurnStarted {
            working: true,
            delivery: Some(if started { "started" } else { "queued" }.into()),
            letter_id: Some(letter.id),
        })
    }

    /// The line a child's parent sees where the user wrote to its child.
    fn tell_parent(&self, session: &crate::session::Session, letter_id: &str) {
        if session.kind != "child" {
            return;
        }
        let parent = session.parent_id.as_deref().and_then(|id| session::get(&self.store, id.to_string()).ok().flatten());
        if let Some(parent) = parent.filter(|parent| parent.kind == "bot" || parent.kind == "child") {
            self.transcripts.append_system_letter(&parent.id, &format!("You wrote to {}", session.name), letter_id);
        }
    }

    /// "Send now" on a letter the user has waiting: it goes to the head of the
    /// queue, the turn that is running is stopped, and the queue goes over as
    /// one turn headed by it. The rest of the queue goes with it, rather than
    /// waiting for a second turn straight after: that turn would begin the
    /// moment this one ended, with the same messages the user had queued
    /// behind it, only later.
    pub fn send_now(&self, session_id: &str, letter_id: &str) -> Result<TurnStarted, String> {
        let session = session::get(&self.store, session_id.to_string())?.ok_or_else(|| "Session not found".to_string())?;
        if !matches!(driven(&session), Some(Driven::Child | Driven::User)) {
            return Err(format!("{} has no queue of the user's to send from.", session.name));
        }
        mailbox::send_first(&self.store, session_id, letter_id)?;
        Ok(self.stop_and_hand_over(session_id, letter_id))
    }

    /// `interrupt_session` with a message: the letter (anyone's) goes to the
    /// head of the box, the running turn stops, and the queue goes over as
    /// one turn headed by it, as for Send now.
    pub fn interrupt_with(&self, session_id: &str, letter_id: &str) -> Result<TurnStarted, String> {
        let session = session::get(&self.store, session_id.to_string())?.ok_or_else(|| "Session not found".to_string())?;
        if driven(&session).is_none() {
            return Err(format!("{} is not a session Crew drives.", session.name));
        }
        mailbox::reorder(&self.store, session_id, &[letter_id.to_string()])?;
        Ok(self.stop_and_hand_over(session_id, letter_id))
    }

    fn stop_and_hand_over(&self, session_id: &str, letter_id: &str) -> TurnStarted {
        if self.is_running(session_id) {
            self.sending_now.lock().unwrap_or_else(|e| e.into_inner()).insert(session_id.to_string());
            self.cancel(session_id, true);
        }
        // The stop's own end hands the queue over; with no turn left to wait
        // for (none was running, or it ended meanwhile) it goes now.
        let started = !self.is_running(session_id) && {
            self.sending_now.lock().unwrap_or_else(|e| e.into_inner()).remove(session_id);
            self.drain_mailbox(session_id)
        };
        TurnStarted {
            working: true,
            delivery: Some(if started { "started" } else { "queued" }.into()),
            letter_id: Some(letter_id.to_string()),
        }
    }

    /// Who started a subagent's turn decides where its report goes (plan
    /// decision 3): a turn the user alone started, by writing in its tab, is
    /// reported only to the user. Any other (the parent's prompt or message,
    /// another session's, or Crew carrying a broken turn on) goes to the
    /// parent as before. Read when the turn ends; an adopted turn nobody sent
    /// keeps what the last one said.
    fn note_starter(&self, params: &TurnStart, letters: &[mailbox::Letter]) {
        let from_user = |from: &crew_protocol::BotRef| from.kind.as_deref() == Some("user");
        let user_only = if letters.is_empty() {
            params.hidden != Some(true) && params.from_bot.as_ref().map_or(true, from_user)
        } else {
            letters.iter().all(|letter| from_user(&letter.from))
        };
        let mut started = self.user_started.lock().unwrap_or_else(|e| e.into_inner());
        if user_only {
            started.insert(params.session_id.clone());
        } else {
            started.remove(&params.session_id);
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
            return Err(format!("{} is not a session Crew drives.", session.name));
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
                return Err(ALREADY_RUNNING.into());
            }
        }
        self.clear_stop(&params.session_id);
        if drive == Driven::Child {
            self.note_starter(&params, &letters);
        }
        if drive == Driven::Bot {
            // A bot's persona must not see the user's commands or skills.
            params.command = None;
            params.skills = None;
        }
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
            // the user typed is their message, not mail, and keeps its files.
            for letter in &letters {
                if typed_by_user(drive, &letter.from) {
                    self.transcripts.append_user(
                        &params.session_id,
                        &letter.text,
                        false,
                        Some(letter.files.clone()),
                        Some(letter.id.clone()),
                    );
                } else {
                    self.transcripts.append_from_bot(
                        &params.session_id,
                        &letter.text,
                        letter.from.clone(),
                        Some(letter.id.clone()),
                        mailbox::letter_kind(&self.store, &letter.id),
                    );
                }
            }
            // A command is the whole message, so its letter goes as typed even
            // to a child, whose other letters from the user are enveloped.
            let as_typed = |letter: &mailbox::Letter| {
                is_own(drive, letter)
                    || (letter.dispatch.as_ref().is_some_and(|dispatch| dispatch.command.is_some())
                        && typed_by_user(drive, &letter.from))
            };
            params.text = letters
                .iter()
                .map(|letter| {
                    if as_typed(letter) {
                        letter.text.clone()
                    } else {
                        mailbox::render(letter, session.parent_id.as_deref())
                    }
                })
                .collect::<Vec<_>>()
                .join("\n\n");
            // What the batch asks of the provider: a command letter is a batch
            // of its own (see `mailbox::claim_batch`), so it is the one letter
            // and its command; otherwise the skills of every letter.
            let asks = |letter: &mailbox::Letter| letter.dispatch.clone().unwrap_or_default();
            params.command = letters.iter().find_map(|letter| asks(letter).command);
            let mut skills: Vec<String> = Vec::new();
            for skill in letters.iter().flat_map(|letter| asks(letter).skills) {
                if !skills.contains(&skill) {
                    skills.push(skill);
                }
            }
            params.skills = Some(skills).filter(|skills| !skills.is_empty());
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
                        params
                            .letter_id
                            .as_deref()
                            .and_then(|id| mailbox::letter_kind(&self.store, id)),
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
        let letters_from_others: Vec<String> = letters
            .iter()
            .filter(|letter| letter.from.kind.as_deref() != Some("user"))
            .map(|letter| letter.id.clone())
            .collect();
        let carried: Vec<String> =
            letters.into_iter().map(|letter| letter.id).chain(params.letter_id.clone()).collect();
        // Only the letters of other sessions are held back until the provider
        // confirms them: what the user typed is on their screen already.
        let held_back: Vec<String> = letters_from_others;
        if !held_back.is_empty() {
            self.carrying.lock().unwrap_or_else(|e| e.into_inner()).insert(params.session_id.clone(), held_back);
        }
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

    /// The `/` menu a session offers: its provider's commands and skills in its
    /// folder, after Crew's own actions. A live Claude keeps its folder's
    /// catalog current, so once one is held it is answered as it stands. With
    /// no process up, a catalog older than [`crate::commands::MAX_AGE_MS`] (or
    /// none) is read again by starting the CLI with no turn, which takes a
    /// moment, so this is for a thread that may wait. A CLI that cannot be
    /// asked leaves the menu to Crew's actions. A bot gets those alone: its
    /// persona must not see the user's skills.
    pub fn commands_list(&self, session_id: &str) -> Result<crew_protocol::CommandCatalog, String> {
        let session = session::get(&self.store, session_id.to_string())?.ok_or("No such session")?;
        if session.kind == "bot" {
            return Ok(self.menu_of(&session, ""));
        }
        let cwd = session::cwd(&self.store, &session)?;
        if session.provider == "claude" {
            let now = crate::store::now_millis();
            let live = matches!(self.lock().get(session_id), Some(Live::Claude(live)) if live.menu_cwd.as_deref() == Some(cwd.as_str()));
            let held = if live { self.commands.holds("claude", &cwd) } else { self.commands.is_fresh("claude", &cwd, now) };
            if !held {
                if let Err(error) = self.probe_claude_commands(session_id, &cwd, false) {
                    eprintln!("[commands] {error}");
                }
            }
        }
        // opencode's server answers for any folder; it is read when nothing
        // fresh is held, and again whenever it says the folder's changed.
        if session.provider == "opencode" && !self.commands.is_fresh("opencode", &cwd, crate::store::now_millis()) {
            if let Err(error) = self.opencode_menu(Some(session_id), &cwd) {
                eprintln!("[commands] {error}");
            }
        }
        Ok(self.menu_of(&session, &cwd))
    }

    /// The catalog as the session's window shows it now, without reading
    /// anything: a bot's is Crew's actions alone.
    fn menu_of(&self, session: &session::Session, cwd: &str) -> crew_protocol::CommandCatalog {
        if session.kind == "bot" {
            return crew_protocol::CommandCatalog {
                entries: crate::commands::crew_actions(offers_fast(&session.provider)),
                at: crate::store::now_millis(),
            };
        }
        self.commands_catalog(&session.provider, cwd)
    }

    /// Reads a session's commands, skills and servers again, for what changed
    /// on disk since its CLI started (`/reload`), and says what it did in the
    /// transcript. The catalog is the one the windows now hold, which a
    /// change also reaches as a push.
    /// - Claude with a process: `reload_plugins`, then `reload_skills`.
    /// - Claude with none: a CLI is started with no turn, as the first list
    ///   does, past the age that list trusts.
    /// - Codex with a process: `skills/list` past its cache, then
    ///   `config/mcpServer/reload`. Without one its thread reads them as it opens.
    /// - opencode: its server reads every folder again (`location/reload`),
    ///   unless another session has an ask open that it would cancel.
    /// - Cursor lists nothing a running CLI could be asked to read again: it
    ///   does when the session restarts.
    pub fn commands_reload(&self, session_id: &str) -> Result<crew_protocol::CommandCatalog, String> {
        let session = session::get(&self.store, session_id.to_string())?.ok_or("No such session")?;
        let cwd = if session.kind == "bot" { String::new() } else { session::cwd(&self.store, &session)? };
        let note = match session.provider.as_str() {
            "claude" => self.reload_claude(&session, &cwd)?,
            "codex" => self.reload_codex(&session, &cwd)?,
            "opencode" => self.reload_opencode(&session, &cwd)?,
            other => {
                let name = if other == "cursor" { "Cursor" } else { other };
                format!("{name} reads its commands and skills again when the session restarts. Use /restart.")
            }
        };
        self.transcripts.append_system(session_id, &note);
        Ok(self.menu_of(&session, &cwd))
    }

    fn reload_claude(&self, session: &session::Session, cwd: &str) -> Result<String, String> {
        let up = match self.lock().get(&session.id) {
            Some(Live::Claude(live)) => Some(live.menu_cwd.clone()),
            _ => None,
        };
        let Some(menu_cwd) = up else {
            if session.kind == "bot" {
                return Ok("A bot reads its commands and skills afresh with each turn.".into());
            }
            self.probe_claude_commands(&session.id, cwd, true)?;
            return Ok(self.reloaded("Read the commands and skills again", "claude", cwd));
        };
        // Plugins first: they bring commands and skills of their own, and the
        // skill list is read after them. A CLI too old for `reload_skills`
        // leaves the skills as they were.
        let plugins = self.claude_control(&session.id, reload_plugins_request())?;
        let skills = self.claude_control(&session.id, reload_skills_request()).ok();
        // Plugins bring servers of their own, and the CLI connects them now.
        self.ask_claude_mcp(&session.id, true);
        let Some(menu_cwd) = menu_cwd else {
            return Ok("Reloaded plugins and skills.".into());
        };
        self.learn_commands(
            &session.id,
            &menu_cwd,
            plugins.get("commands").map(crate::commands::claude_entries),
            skills.map(|answer| crate::commands::claude_skill_names(answer.get("skills").unwrap_or(&Value::Null))),
        );
        Ok(self.reloaded("Reloaded plugins and skills", "claude", &menu_cwd))
    }

    fn reload_codex(&self, session: &session::Session, cwd: &str) -> Result<String, String> {
        if !matches!(self.lock().get(&session.id), Some(Live::Codex(_))) {
            return Ok("Codex reads its skills and servers when its thread opens, with the next message.".into());
        }
        self.codex_reload(&session.id)?;
        Ok(self.reloaded("Reloaded skills and MCP servers", "codex", cwd))
    }

    /// `head`, with how many commands and skills the folder's catalog holds
    /// now, as the transcript's line for a reload.
    fn reloaded(&self, head: &str, provider: &str, cwd: &str) -> String {
        let catalog = self.commands_catalog(provider, cwd);
        let count = |kind: &str, noun: &str| {
            let n = catalog.entries.iter().filter(|entry| entry.kind == kind).count();
            format!("{n} {noun}{}", if n == 1 { "" } else { "s" })
        };
        format!("{head}: {}, {}.", count("command", "command"), count("skill", "skill"))
    }

    /// Ends a session's CLI so its next message starts it again on the same
    /// conversation (`/restart`): the new process reads the skills, plugins
    /// and servers afresh. Only between turns, and what the board shows
    /// running in the background goes with the process, so that needs `force`;
    /// the refusal names it.
    ///
    /// opencode's sessions share one server, so restarting it is not one
    /// session's to do: theirs reads its folder again (decision of
    /// 2026-10-09), and the binding is let go, taken up again by the next
    /// message. The server itself restarts only from Settings.
    pub fn session_restart(&self, session_id: &str, force: bool) -> Result<(), String> {
        let session = session::get(&self.store, session_id.to_string())?.ok_or("No such session")?;
        let running: Vec<String> = self
            .background
            .list(session_id)
            .commands
            .into_iter()
            .filter(|command| command.state == crew_protocol::BackgroundState::Running)
            .map(|command| command.description.filter(|text| !text.trim().is_empty()).unwrap_or(command.command))
            .collect();
        if !force && !running.is_empty() {
            return Err(format!("Still running in the background: {}. Restarting stops it.", running.join(", ")));
        }
        // Claimed like a turn, so none starts under the release.
        {
            let mut turns = self.running.lock().unwrap_or_else(|e| e.into_inner());
            let active = self.lock().get(session_id).is_some_and(|live| match live {
                Live::Claude(row) => row.active,
                Live::Codex(row) => row.active,
                Live::Cursor(row) => row.active,
                Live::Opencode(row) => row.active,
            });
            if active || !turns.insert(session_id.to_string()) {
                return Err("Stop the turn first.".into());
            }
        }
        let had = self.lock().contains_key(session_id);
        if had {
            self.release(session_id);
        }
        self.running.lock().unwrap_or_else(|e| e.into_inner()).remove(session_id);
        if session.provider == "opencode" {
            let cwd = if session.kind == "bot" { String::new() } else { session::cwd(&self.store, &session)? };
            let note = self.reload_opencode(&session, &cwd)?;
            self.transcripts.append_system(session_id, &note);
            return Ok(());
        }
        let note = if had {
            "Restarted. The CLI starts again with the next message."
        } else {
            "Nothing was running; the CLI starts with the next message."
        };
        self.transcripts.append_system(session_id, note);
        Ok(())
    }

    /// Reads a folder's Claude menu with a CLI of its own. One at a time: a
    /// list that arrives while another probes waits, and finds the answer
    /// unless it is `force`d (a reload) past what is held.
    fn probe_claude_commands(&self, session_id: &str, cwd: &str, force: bool) -> Result<(), String> {
        let _probing = self.commands.probe_lock();
        if !force && self.commands.is_fresh("claude", cwd, crate::store::now_millis()) {
            return Ok(());
        }
        let binary = self.resolve_bin("claude")?;
        let menu = crate::provider_session::probe_claude_commands(std::path::Path::new(&binary), std::path::Path::new(cwd))?;
        self.learn_commands(session_id, cwd, Some(menu.commands), Some(menu.skills));
        Ok(())
    }

    /// Keeps what Claude said of a folder's menu, and tells the windows of the
    /// session when it changed.
    fn learn_commands(
        &self,
        session_id: &str,
        cwd: &str,
        entries: Option<Vec<crew_protocol::CommandEntry>>,
        skills: Option<HashSet<String>>,
    ) {
        self.commands.learn_for_session(
            session_id,
            "claude",
            cwd,
            entries,
            skills,
            crate::commands::crew_actions(offers_fast("claude")),
        );
    }

    fn commands_catalog(&self, provider: &str, cwd: &str) -> crew_protocol::CommandCatalog {
        self.commands.catalog(provider, cwd, crate::commands::crew_actions(offers_fast(provider)), crate::store::now_millis())
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
                stale: merged.stale,
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
                        stale: None,
                    })
                }),
                // Only the window: what compacts it by itself is not told.
                (None, Some(window)) => host.publish_context(&id, |last| {
                    last.filter(|last| last.window.is_none())
                        .map(|last| ContextReading { used: last.used, window: Some(window), auto_compact_at: None, stale: None })
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

    /// Stop one entry of the board, through the provider that runs it: Claude's
    /// `stop_task` (a shell, a monitor, a subagent, the one the turn waits on
    /// too), Codex's `turn/interrupt` on an agent thread, Codex's
    /// `thread/backgroundTerminals/terminate` on a terminal, opencode's
    /// interrupt on a child session. Only while its
    /// CLI is up, and not an entry that says it cannot be stopped alone.
    pub fn background_stop(&self, session_id: &str, id: &str) -> Result<(), String> {
        let known = self.background.read(session_id, |board| {
            (
                board.command(id).map(|row| (row.state, row.stoppable, row.stop_note.clone())),
                board.is_live(),
                board.process_id(id),
                board.command(id).and_then(|row| row.thread_id.clone()),
            )
        });
        let Some((Some((state, stoppable, note)), live, process, thread)) = known else {
            return Err("No such background command.".into());
        };
        if state != crew_protocol::BackgroundState::Running {
            return Ok(());
        }
        if !live {
            return Err("Its session's CLI is gone, and it went with it.".into());
        }
        if stoppable == Some(false) {
            return Err(match note {
                Some(note) => format!("It cannot be stopped on its own: it {note}."),
                None => "It cannot be stopped on its own.".into(),
            });
        }
        let kind = match self.lock().get(session_id) {
            Some(Live::Claude(_)) => "claude",
            Some(Live::Codex(_)) => "codex",
            Some(Live::Opencode(_)) => "opencode",
            _ => "",
        };
        match kind {
            "claude" => {
                self.claude_control(session_id, stop_task_request(id))?;
            }
            // An agent thread is stopped by its turn; a terminal by its process.
            "codex" => match thread {
                Some(thread) => self.codex_interrupt_child(session_id, &thread)?,
                None => {
                    let process = process.ok_or_else(|| "Codex named no process for it.".to_string())?;
                    self.codex_terminate(session_id, &process)?;
                }
            },
            // A child session is interrupted on its own: the parent's turn goes on.
            "opencode" => self.opencode_interrupt_child(id)?,
            _ => return Err("Its session's CLI is gone, and it went with it.".into()),
        }
        let now = crate::store::now_millis();
        self.background.touch(session_id, |board| board.settle(id, crew_protocol::BackgroundState::Stopped, None, now));
        Ok(())
    }

    /// Clear a session's finished entries from its list: the named ones, or
    /// every one when `ids` is absent. A running entry is never cleared. The
    /// keys in `hide` are the ended children and process runs the panel is to
    /// leave off. The window hears of it as any other change of the list.
    pub fn background_clear(&self, session_id: &str, ids: Option<&[String]>, hide: &[String]) {
        self.background.clear(session_id, ids, hide);
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
            || self.opencode_respond(session_id, request_id, decision.clone()).is_some()
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
        self.wake(&parent.id);
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
            || self.opencode_answer(session_id, request_id, answers.clone()).is_some()
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
        if session_id == opencode_server::SERVER_KEY {
            self.on_opencode_server_lines(lines);
            return;
        }
        if event == "agent-stderr" {
            let mut map = self.lock();
            if let Some(live) = map.get_mut(session_id) {
                let stderr = match live {
                    Live::Claude(row) => &mut row.stderr,
                    Live::Codex(row) => &mut row.stderr,
                    Live::Cursor(row) => &mut row.stderr,
                    // A binding on the server has no process of its own.
                    Live::Opencode(_) => return,
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
        if session_id == opencode_server::SERVER_KEY {
            self.on_opencode_server_exit(code);
            return;
        }
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
                } else if !mid && row.initialized {
                    // No turn is running: a kept process died while idle (or
                    // while it answered a stop). Its entry goes, so the next
                    // message launches one and resumes the conversation; what
                    // it ran in the background went with it, and the steers
                    // it still held go back in the box. One that never came
                    // up is the launch's to report.
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
                // No turn is running: a process a child kept died while idle.
                // Its entry goes, so the next message spawns one and loads the
                // session.
                if !row.active {
                    drop(map);
                    self.detach(session_id);
                    return;
                }
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
            // Its server's exit is the server's (`on_opencode_server_exit`).
            Live::Opencode(_) => {}
        }
    }

    fn signal(&self, session_id: &str, outcome: TurnOutcome) {
        let mut map = self.lock();
        if let Some(live) = map.get_mut(session_id) {
            match live {
                Live::Claude(row) => row.end_turn(outcome),
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

    /// Stop the session's turn. Only the turn (plan decision Q1, as Claude
    /// Code does): what it left running in the background goes on, and is
    /// stopped from the panel one by one. With `kill`, a CLI that does not
    /// answer the stop is let go after [`INTERRUPT_GRACE`].
    fn cancel(&self, session_id: &str, kill: bool) {
        self.mark_stop(session_id);
        // Codex and Cursor are asked to stop their turn, and its end ends
        // this one. Without a turn to interrupt, it settles here.
        if self.codex_interrupt(session_id) || self.cursor_interrupt(session_id) || self.opencode_interrupt(session_id) {
            return;
        }
        // Claude is interrupted, never told to stop its tasks: `initialize`
        // declared a stop per task, so the interrupt spares them (measured on
        // 2.1.295). `cancel_queued` takes back what the turn had not read yet,
        // which the turn's end puts back in the box for the user, rather than
        // leaving it for the CLI to start a turn on. A turn whose result is
        // held on background work has nothing running in the CLI to
        // interrupt; it just ends.
        let interrupt = {
            let mut map = self.lock();
            match map.get_mut(session_id) {
                Some(Live::Claude(row)) if row.active && !row.held => {
                    // Deaf from here until the interrupt's result: that is
                    // not the turn's outcome, nor the next one's.
                    row.cancelled = true;
                    row.mute = true;
                    let id = format!("ctrl-{}", row.next_control);
                    row.next_control += 1;
                    Some((id, row.epoch, row.turn))
                }
                _ => None,
            }
        };
        if let Some((id, _, _)) = &interrupt {
            let _ = self.agents.write(
                session_id,
                &serde_json::to_string(&build_control_request(id, json!({ "subtype": "interrupt", "cancel_queued": true })))
                    .unwrap_or_default(),
            );
        }
        let mut claude = false;
        {
            let mut map = self.lock();
            if let Some(live) = map.get_mut(session_id) {
                match live {
                    Live::Claude(row) => {
                        claude = true;
                        if row.active {
                            drop_pending(row);
                            row.end_turn(TurnOutcome::Stopped);
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
                        row.release_asks();
                        if let Some(tx) = row.turn_tx.take() {
                            let _ = tx.send(TurnOutcome::Stopped);
                        }
                    }
                }
            }
        }
        if let Some((_, epoch, turn)) = interrupt {
            if kill {
                let host = self.clone();
                let session_id = session_id.to_string();
                self.after(INTERRUPT_GRACE, move || {
                    // A CLI that has not answered the interrupt by now is in a
                    // state nobody vouches for: it goes, and what it ran in
                    // the background with it. Only the stop it was armed for:
                    // a process launched since, or a later stop on this one,
                    // is not its to judge.
                    let hung = matches!(
                        host.lock().get(&session_id),
                        Some(Live::Claude(row)) if row.epoch == epoch && row.turn == turn && row.mute
                    );
                    if hung {
                        host.release(&session_id);
                    }
                });
            }
            return;
        }
        // A Claude process stays: with no turn running there was nothing to
        // stop, and what it runs in the background is not the stop's. The
        // other CLIs go with the stop.
        if kill && !claude {
            self.release(session_id);
        }
    }

    /// Forget a session's process. The steers a Claude process still held,
    /// which no turn will read now, go back in the box under the ids they were
    /// written with.
    fn detach(&self, session_id: &str) {
        let gone = self.lock().remove(session_id);
        self.idle.lock().unwrap_or_else(|e| e.into_inner()).remove(session_id);
        match gone {
            Some(Live::Claude(mut live)) => {
                for steer in std::mem::take(&mut live.steers) {
                    steer.put_back(&self.store, session_id);
                }
            }
            Some(Live::Opencode(live)) => self.opencode_forget(*live, session_id),
            _ => {}
        }
    }

    /// Since when a session's process has been up with no turn on it. `None`
    /// while a turn runs or when there is no process.
    pub fn idle_since(&self, session_id: &str) -> Option<Instant> {
        self.idle.lock().unwrap_or_else(|e| e.into_inner()).get(session_id).copied()
    }

    /// The end of a turn on a driver that can keep its process: it stays for
    /// the next turn when the session keeps its process and the driver
    /// vouches for the state the turn left it in (`clean`), and goes
    /// otherwise. A turn that failed leaves it in a state nobody vouches for;
    /// a stopped one is clean once the CLI has closed it (Claude: the
    /// interrupt's own result, which the next turn waits for; Codex: its
    /// `turn/completed`). A session that is exiting has no next turn.
    fn park(&self, session: &crate::session::Session, clean: bool) {
        let exiting = self.exiting.lock().unwrap_or_else(|e| e.into_inner()).contains_key(&session.id);
        let kept = keeps_process(session) && clean && !exiting && self.lock().contains_key(&session.id);
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
    /// it: the tray keeps the rows, stopped and saying so, until the user
    /// clears them.
    fn close_tray(&self, session_id: &str) {
        let now = crate::store::now_millis();
        self.background.touch(session_id, |board| board.end(now, crate::background::CLI_EXITED));
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
        self.finish_turn(row, outcome, carried);
    }

    /// What every turn's end does, whoever started it: the tray, the letters
    /// it carried, the status the user sees, and the queue, which goes over
    /// as the next turn. A turn the CLI started by itself, that took the place
    /// of the one ending, starts its own watch here.
    fn finish_turn(&self, row: crate::session::Session, outcome: TurnOutcome, carried: Vec<String>) {
        let session_id = row.id.clone();
        // The CLI is gone, unless the session kept it for its next turn: then
        // what it left running in the background still runs.
        if self.idle_since(&session_id).is_none() {
            self.close_tray(&session_id);
        }
        // The letters it carried are delivered now that it has ended, however
        // it ended. A daemon that dies first leaves them claimed, and the next
        // start hands them over again.
        // Ones the provider never confirmed it read (its process failed before
        // they were taken) go back in the box, and the session waits for the
        // user or a new letter instead of starting the same turn again.
        let unread = self.carrying.lock().unwrap_or_else(|e| e.into_inner()).remove(&session_id);
        let mut released: Vec<String> = Vec::new();
        if let (TurnOutcome::Failed(_), Some(unread)) = (&outcome, unread) {
            for id in unread {
                let _ = mailbox::release(&self.store, &id);
                released.push(id);
            }
            self.held.lock().unwrap_or_else(|e| e.into_inner()).insert(session_id.clone());
        }
        let delivered: Vec<String> = carried.into_iter().filter(|id| !released.contains(id)).collect();
        let _ = mailbox::delivered(&self.store, &delivered);
        // The turn is over: the next one may start, and the drain below is
        // what starts it. A turn the CLI began by itself while this one was
        // ending found the session still running, and waits for no turn of
        // Crew's now: it is watched as one nobody sent.
        let adopted = {
            let mut running = self.running.lock().unwrap_or_else(|e| e.into_inner());
            // Marked before it leaves `running`, so a waiter that sees it gone
            // from there sees this.
            if driven(&row) == Some(Driven::Child) {
                self.settling.lock().unwrap_or_else(|e| e.into_inner()).insert(session_id.clone());
            }
            running.remove(&session_id);
            self.claim_unclaimed(&mut running, &session_id)
        };
        // Taken after the turn is out of `running`, so a Send now that comes
        // either side of it finds it ended or finds the flag.
        let sent_now = self.sending_now.lock().unwrap_or_else(|e| e.into_inner()).remove(&session_id);
        // This turn settles first, so the status the adopted one sets is the
        // last; the queue waits for that one's end.
        self.settle_turn(&row, outcome, sent_now);
        if self.settling.lock().unwrap_or_else(|e| e.into_inner()).remove(&session_id) {
            self.signal.notify();
        }
        if let Some(rx) = adopted {
            self.watch_adopted(&row, rx);
        }
    }

    /// How a turn's end shows, and whether the queue goes over now.
    fn settle_turn(&self, row: &crate::session::Session, outcome: TurnOutcome, sent_now: bool) {
        let session_id = row.id.clone();
        if driven(row) == Some(Driven::Child) {
            self.settle_child(row, outcome, sent_now);
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
                // for them, it does not restart the session. Unless they
                // stopped it to send a message now.
                if !sent_now {
                    return;
                }
            }
        }
        self.drain_mailbox(&session_id);
    }

    /// Hand over what is waiting for a session that has just gone quiet: every
    /// letter in its box, in the order the user put the queue in (else oldest
    /// first), in one turn (up to [`mailbox::BATCH_CHARS`] of text; the rest
    /// waits for the next turn). The files the user attached to them go with
    /// the turn.
    /// A session with a turn running is left alone: that turn's end drains it.
    ///
    /// The one place a turn's letters are claimed, so two callers racing cannot
    /// lose one between them: the loser finds an empty box, which is the truth.
    /// Always queued, never steered into a running turn. A letter with a
    /// command is a batch of its own, and `begin` takes the command and the
    /// skills the batch's letters carry.
    pub fn drain_mailbox(&self, session_id: &str) -> bool {
        // Before claiming, so a letter for a busy session stays pending: a
        // wait that reads the same report can then take it back. The turn
        // leaves `running` before its end drains, so one of the two sees it.
        if self.is_running(session_id) {
            return false;
        }
        let user_wrote = |letters: &[mailbox::Letter]| letters.iter().any(|letter| letter.from.kind.as_deref() == Some("user"));
        // A paused session, or one whose last turn failed before reading its
        // letters, is started by the user alone.
        let stalled = session::paused(&self.store, session_id)
            || self.held.lock().unwrap_or_else(|e| e.into_inner()).contains(session_id);
        if stalled && !mailbox::waiting(&self.store, session_id).is_ok_and(|waiting| user_wrote(&waiting)) {
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
        // What the user attached to the letters goes to the turn as its files.
        let files: Vec<AttachedFile> = letters.iter().flat_map(|letter| letter.files.clone()).collect();
        let started = self.begin(
            TurnStart {
                session_id: session_id.to_string(),
                cwd,
                text: String::new(),
                files: Some(files).filter(|files| !files.is_empty()),
                mentions: None,
                hidden: None,
                from_bot: Some(first.from.clone()),
                sent_at: Some(first.at),
                nonce: None,
                letter_id: None,
                mode: None,
                command: None,
                skills: None,
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
        // A turn the user's letter started is the user writing: the count
        // starts over. One that only sessions' letters started is one more in
        // a row (plan decision 27).
        let count = if user_wrote(&letters) { 0 } else { session::auto_turns(&self.store, session_id) + 1 };
        session::set_auto_turns(&self.store, session_id, count);
        true
    }

    /// The user writes to a session: it is theirs again, however many turns
    /// letters had started in it.
    fn user_wrote(&self, session_id: &str) {
        self.held.lock().unwrap_or_else(|e| e.into_inner()).remove(session_id);
        if session::auto_turns(&self.store, session_id) > 0 {
            session::set_auto_turns(&self.store, session_id, 0);
        }
    }

    /// The provider read the letters its turn was handed (Claude replayed the
    /// message, Codex started the turn, opencode and Cursor took the prompt):
    /// they are delivered now, not when the turn ends (plan decision 18).
    pub(crate) fn confirm_carried(&self, session_id: &str) {
        let read = self.carrying.lock().unwrap_or_else(|e| e.into_inner()).remove(session_id);
        if let Some(read) = read {
            let _ = mailbox::delivered(&self.store, &read);
        }
    }

    /// Hand over what a letter that has just been dropped in left waiting.
    /// A subagent, a session and a bot take it as a turn;
    /// see [`TurnHost::wake`].
    pub fn deliver_to(&self, target: &crate::session::Session) -> bool {
        self.wake(&target.id)
    }

    /// A letter has landed in `session_id`'s box: start the turn it asks for,
    /// or steer it into the one that runs. A session that has had [`session::PAUSE_AFTER`] automatic turns in a row
    /// is not woken (27). Letters from sessions wait for the next to come
    /// close behind them (17); a question, an approval and anything the user
    /// wrote do not. Returns whether a turn started.
    pub fn wake(&self, session_id: &str) -> bool {
        self.held.lock().unwrap_or_else(|e| e.into_inner()).remove(session_id);
        let Ok(Some(session)) = session::get(&self.store, session_id.to_string()) else {
            return false;
        };
        let Some(drive) = driven(&session) else {
            return false;
        };
        if drive == Driven::Bot {
            return self.drain_mailbox(session_id);
        }
        let Ok(pending) = mailbox::waiting(&self.store, session_id) else {
            return false;
        };
        let from_user = |letter: &mailbox::Letter| letter.from.kind.as_deref() == Some("user");
        let (Some(oldest), Some(newest)) =
            (pending.iter().map(|letter| letter.at).min(), pending.iter().map(|letter| letter.at).max())
        else {
            return false;
        };
        if !pending.iter().any(from_user) && session::paused(&self.store, session_id) {
            return false;
        }
        let urgent = pending.iter().any(|letter| {
            from_user(letter) || letter.kind == mailbox::QUESTION || letter.kind == mailbox::APPROVAL || letter.dispatch.is_some()
        });
        if !urgent {
            let (wait, max) = *self.batch_window.lock().unwrap_or_else(|e| e.into_inner());
            let left = batch_remaining(oldest, newest, crate::store::now_millis(), wait.as_millis() as i64, max.as_millis() as i64);
            if left > 0 {
                self.wake_later(session_id, Duration::from_millis(left as u64));
                return false;
            }
        }
        if self.is_running(session_id) {
            return self.steer_waiting(&session, &pending);
        }
        self.drain_mailbox(session_id)
    }

    #[cfg(test)]
    pub(crate) fn carrying_for_test(&self, session_id: &str, letters: Vec<String>) {
        self.carrying.lock().unwrap_or_else(|e| e.into_inner()).insert(session_id.to_string(), letters);
    }

    #[cfg(test)]
    pub(crate) fn set_batch_window(&self, wait: Duration, max: Duration) {
        *self.batch_window.lock().unwrap_or_else(|e| e.into_inner()) = (wait, max);
    }

    /// Look at the box again once the batch window has passed. One timer per
    /// session: a letter that comes meanwhile is seen when it fires.
    fn wake_later(&self, session_id: &str, after: Duration) {
        if !self.batching.lock().unwrap_or_else(|e| e.into_inner()).insert(session_id.to_string()) {
            return;
        }
        let host = self.clone();
        let id = session_id.to_string();
        thread::spawn(move || {
            thread::sleep(after);
            host.batching.lock().unwrap_or_else(|e| e.into_inner()).remove(&id);
            host.wake(&id);
        });
    }

    /// What its subagents report, ask and need decided goes into a running
    /// turn as one steer, where its provider takes a steer without
    /// interrupting a tool. A message waits for the turn's end unless its
    /// sender asked for a steer (`send_message` with `steer`), so do the
    /// user's own (they chose to queue), one with a command, and anything for
    /// Cursor, which would cancel the turn: they wait for its end, which
    /// hands them over as one turn.
    fn steer_waiting(&self, session: &crate::session::Session, pending: &[mailbox::Letter]) -> bool {
        if !STEERABLE.contains(&session.provider.as_str())
            || pending.iter().any(|letter| {
                letter.dispatch.is_some() || letter.from.kind.as_deref() == Some("user") || letter.kind == mailbox::MESSAGE
            })
        {
            return false;
        }
        let letters = match mailbox::claim_batch(&self.store, &session.id, mailbox::BATCH_CHARS) {
            Ok(letters) if !letters.is_empty() => letters,
            _ => return false,
        };
        let first = &letters[0];
        let rest: Vec<Extra> = letters[1..]
            .iter()
            .map(|letter| Extra {
                letter: letter.id.clone(),
                text: letter.text.clone(),
                from: letter.from.clone(),
                kind: mailbox::letter_kind(&self.store, &letter.id),
            })
            .collect();
        let tried = self.steer_files(&session.id, &first.text, first.from.clone(), Some(first.id.clone()), Vec::new(), rest);
        match tried {
            Ok(()) => {
                self.mark_reports_seen(&letters);
                true
            }
            Err(_) => {
                for letter in &letters {
                    let _ = mailbox::release(&self.store, &letter.id);
                }
                false
            }
        }
    }

    /// What each report or question shows of its child is seen once it is
    /// handed over: a read or a wait after this does not hand it out again.
    fn mark_reports_seen(&self, letters: &[mailbox::Letter]) {
        for letter in letters {
            let reported = letter.is_report() || letter.kind == mailbox::QUESTION || letter.kind == mailbox::APPROVAL;
            if let (true, false, Some(cursor)) = (reported, letter.from.id.is_empty(), letter.event_cursor) {
                let _ = crate::session_events::mark_seen(&self.store, &letter.from.id, cursor);
            }
        }
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
    fn settle_child(&self, session: &crate::session::Session, outcome: TurnOutcome, sent_now: bool) {
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
        // waits for them, as it does for a bot, unless they stopped it to send
        // a message now.
        if detail != "stopped" || sent_now {
            self.drain_mailbox(id);
        }
    }

    /// Write a child's event at the end of its transcript, with the report
    /// to a bot parent in the same transaction; then wake whoever waits, and
    /// only then try to hand the report over.
    fn child_event(&self, session: &crate::session::Session, kind: &str, outcome: &str, request: Option<&Value>) {
        self.record_child_event(session, kind, outcome, request, true);
    }

    /// [`TurnHost::child_event`], with a letter to a bot parent only when
    /// `tell` says so.
    fn record_child_event(
        &self,
        session: &crate::session::Session,
        kind: &str,
        outcome: &str,
        request: Option<&Value>,
        tell: bool,
    ) {
        let id = session.id.as_str();
        let cursor = self.transcripts.len(id) as i64;
        let (_, report) = self.transcripts.since(id, cursor as usize);
        let report = if kind == "needs-input" { String::new() } else { report };
        let letter = if tell { self.report_letter(session, kind, outcome, &report, request, cursor) } else { None };
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
            self.wake(&letter.to_session);
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
        // A bot or a session has turns a report can wake.
        if driven(&parent).is_none() {
            return None;
        }
        // What the user started in the subagent's tab is theirs: how the turn
        // ended is not the parent's to hear. Questions, approvals and an exit
        // mid-turn still are.
        if matches!(kind, "turn" | "error") && self.user_started.lock().unwrap_or_else(|e| e.into_inner()).contains(&session.id) {
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
    /// event are written here. Its parent already had the report of its last
    /// turn, so no letter goes: waking a parent only to say a finished child
    /// is gone would cost it a whole turn over its context. A wait or
    /// `read_session` still shows the exit.
    pub fn exit_idle_child(&self, session: &crate::session::Session, why: &str, note: &str) {
        // A child that kept its process for the next turn has no next turn.
        self.release(&session.id);
        self.transcripts.append_system(&session.id, note);
        self.transcripts.set_status(&session.id, "exited", None);
        self.transcripts.flush(&session.id);
        let _ = mailbox::drop_waiting(&self.store, &session.id);
        self.record_child_event(session, "exited", why, None, false);
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
                command: None,
                skills: None,
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

    /// Whether a child's turn has ended but its event is not written yet.
    pub fn is_settling(&self, session_id: &str) -> bool {
        self.settling.lock().unwrap_or_else(|e| e.into_inner()).contains(session_id)
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
        let outcome = self.claude_turn(&session, &params, history);
        self.claude_turn_ended(&session, &outcome);
        outcome
    }

    /// What a Claude turn's end leaves of its process, for a turn Crew sent
    /// and one the CLI started alike. The session keeps it for its next turn
    /// (see [`TurnHost::park`]) when the turn completed, or was stopped: the
    /// next turn waits for the interrupt's own result before it runs on it.
    /// What it runs in the background stays with it, and pins it.
    ///
    /// A steer the turn ended before reading is not lost. After a result the
    /// CLI still holds it, and starts a turn of its own on it, whose echo puts
    /// it in the transcript: it stays the process's. A stop took it back from
    /// the CLI (`cancel_queued`) and a failure leaves nobody to start that
    /// turn: then it waits in the box, and the end of this turn hands it over
    /// as the next one, or leaves it to the user after a stop.
    fn claude_turn_ended(&self, session: &crate::session::Session, outcome: &TurnOutcome) {
        let session_id = session.id.as_str();
        let unread = match self.lock().get_mut(session_id) {
            Some(Live::Claude(live)) => {
                drop_pending(live);
                if matches!(outcome, TurnOutcome::Completed) {
                    Vec::new()
                } else {
                    std::mem::take(&mut live.steers)
                }
            }
            _ => Vec::new(),
        };
        for steer in unread {
            steer.put_back(&self.store, session_id);
        }
        self.park(session, matches!(outcome, TurnOutcome::Completed | TurnOutcome::Stopped));
    }

    /// Take a turn the CLI started by itself as one nobody sent: the session
    /// is working, its events land in the transcript as a turn with no
    /// message of the user's, and it settles at its `result` like any other
    /// (plan decision Q2). What is sent meanwhile steers or queues as into
    /// any running turn. Called by the reader as the CLI says `system/init`
    /// with no turn of Crew's running on the process of `epoch`.
    ///
    /// The race with a turn of Crew's being started that same moment is
    /// settled at that boundary: a turn whose user message is not written yet
    /// (the session is claimed but the process idle) takes this one over, and
    /// its message goes in as a steer of it would; one whose message is
    /// written already is running, and the CLI's turn is read as its own.
    fn adopt_claude_turn(&self, session_id: &str, epoch: u64) {
        // A bot's process goes with its turn: what it would start after its
        // result is nobody's.
        let Ok(Some(row)) = session::get(&self.store, session_id.to_string()) else {
            return;
        };
        if !keeps_process(&row) {
            return;
        }
        let rx = {
            let mut running = self.running.lock().unwrap_or_else(|e| e.into_inner());
            let mut map = self.lock();
            let Some(Live::Claude(live)) = map.get_mut(session_id) else {
                return;
            };
            if live.epoch != epoch || live.active || live.mute || !live.initialized {
                return;
            }
            if running.contains(session_id) {
                live.begin_turn(None, true);
                None
            } else {
                let (tx, rx) = oneshot::channel();
                live.begin_turn(Some(tx), true);
                running.insert(session_id.to_string());
                Some(rx)
            }
        };
        self.idle.lock().unwrap_or_else(|e| e.into_inner()).remove(session_id);
        if let Some(rx) = rx {
            self.watch_adopted(&row, rx);
        }
    }

    /// A turn the CLI started by itself that no turn of Crew's took over, now
    /// claimed as the session's running turn; under `running`, which the
    /// caller holds. Its outcome comes on the receiver.
    fn claim_unclaimed(
        &self,
        running: &mut HashSet<String>,
        session_id: &str,
    ) -> Option<oneshot::Receiver<TurnOutcome>> {
        let mut map = self.lock();
        let slot = match map.get_mut(session_id) {
            Some(Live::Claude(live)) if live.unclaimed() => &mut live.turn_tx,
            Some(Live::Opencode(live)) if live.unclaimed() => &mut live.turn_tx,
            _ => return None,
        };
        if running.contains(session_id) {
            return None;
        }
        let (tx, rx) = oneshot::channel();
        *slot = Some(tx);
        running.insert(session_id.to_string());
        Some(rx)
    }

    /// The session works on a turn the CLI started by itself, until it ends.
    fn watch_adopted(&self, row: &crate::session::Session, rx: oneshot::Receiver<TurnOutcome>) {
        self.idle.lock().unwrap_or_else(|e| e.into_inner()).remove(&row.id);
        self.transcripts.set_working(&row.id, true);
        self.transcripts.set_status(&row.id, "working", row.provider_session_id.as_deref());
        self.transcripts.apply(&row.id, HarnessEvent::SessionStarted {});
        let host = self.clone();
        let row = row.clone();
        thread::spawn(move || {
            let outcome = host.block_on(rx).unwrap_or(TurnOutcome::Failed("Turn channel closed".into()));
            if row.provider == "opencode" {
                host.opencode_turn_ended(&row, &outcome);
            } else {
                host.claude_turn_ended(&row, &outcome);
            }
            host.finish_turn(row, outcome, Vec::new());
        });
    }

    /// Until the stop of the turn before has been answered by its own
    /// `result`, which must not end the next one; at most [`INTERRUPT_GRACE`],
    /// after which the stop's own timer lets go of a CLI that never answered.
    fn await_interrupt(&self, session_id: &str) {
        let until = Instant::now() + INTERRUPT_GRACE;
        while Instant::now() < until {
            if !matches!(self.lock().get(session_id), Some(Live::Claude(live)) if live.mute) {
                return;
            }
            thread::sleep(Duration::from_millis(20));
        }
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
        #[cfg(test)]
        if let Some(hook) = self.before_message.lock().unwrap_or_else(|e| e.into_inner()).take() {
            hook();
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
            // The CLI started a turn by itself before this message went in:
            // the message joins it, read at its next step or by the turn the
            // CLI starts on it next, and that turn's end is this one's.
            if live.unclaimed() {
                live.turn_tx = Some(tx);
            } else {
                live.begin_turn(Some(tx), false);
            }
            (rx, live.claude_session_id.clone())
        };
        let images = crate::files::load_inline_images(params.files.as_deref().unwrap_or(&[]));
        let inline: HashSet<String> = images.iter().map(|image| image.path.clone()).collect();
        let files = path_list(params, &inline);
        let message = build_claude_dispatch_message(
            &claude_session_id,
            history.as_deref(),
            params.text.trim(),
            &files,
            &images,
            params.command.as_deref(),
            params.skills.as_deref().unwrap_or_default(),
        );
        if let Err(error) = self
            .agents
            .write(&session_id, &serde_json::to_string(&message).unwrap_or_default())
        {
            return TurnOutcome::Failed(error);
        }
        self.ask_claude_title(session, params);
        self.block_on(turn_rx)
            .unwrap_or(TurnOutcome::Failed("Turn channel closed".into()))
    }

    /// In stream-json the CLI names a conversation only when asked, as its
    /// terminal does on the first message. With `persist` the name goes into
    /// its transcript as an `ai-title`, where the window's sweep adopts it
    /// (`session::sync_title`). Asked once per process, of a user's session
    /// the provider has not named yet.
    fn ask_claude_title(&self, session: &crate::session::Session, params: &TurnStart) {
        let text = params.text.trim();
        if session.kind != "terminal" || params.command.is_some() || text.is_empty() {
            return;
        }
        if session::provider_title_of(&self.store, &session.id).ok().flatten().is_some() {
            return;
        }
        let epoch = match self.lock().get_mut(&session.id) {
            Some(Live::Claude(live)) if !live.title_asked => {
                live.title_asked = true;
                live.epoch
            }
            _ => return,
        };
        let host = self.clone();
        let id = session.id.clone();
        let description = text.to_string();
        thread::spawn(move || {
            let _ = host.claude_control_on(
                &id,
                Some(epoch),
                crate::titles::claude_request(&description),
            );
        });
    }

    /// Names a user's session its provider has not named, once per daemon:
    /// what a window's sweep asks for when `session::sync_title` finds no
    /// name. Claude is asked on its live process if it has one, and otherwise
    /// on one resumed only to be asked; Codex's cheapest model is asked in a
    /// run of its own. Neither conversation gains a message. A session with
    /// nothing said in it yet is left for a later sweep.
    pub fn name_untitled(&self, session_id: &str) {
        let Ok(Some(session)) = session::get(&self.store, session_id.to_string()) else {
            return;
        };
        if session.kind != "terminal"
            || !matches!(session.provider.as_str(), "claude" | "codex")
            || !session::is_placeholder_name(&session.name, &session.provider)
            || session::provider_title_of(&self.store, session_id).ok().flatten().is_some()
            || self.naming.lock().unwrap_or_else(|e| e.into_inner()).contains(session_id)
        {
            return;
        }
        let host = self.clone();
        thread::spawn(move || {
            let _one = host.naming_gate.lock().unwrap_or_else(|e| e.into_inner());
            if let Err(error) = host.name_now(&session) {
                eprintln!("[titles] {}: {error}", session.id);
            }
        });
    }

    fn name_now(&self, session: &crate::session::Session) -> Result<(), String> {
        use crate::session_history::{claude::ClaudeDecoder, codex::CodexDecoder};
        use crate::titles;
        let cwd = session::cwd(&self.store, session)?;
        let claim = || self.naming.lock().unwrap_or_else(|e| e.into_inner()).insert(session.id.clone());
        match session.provider.as_str() {
            "claude" => {
                let id = session.provider_session_id.clone().unwrap_or_else(|| session.id.clone());
                let home = self.claude_home_dir().ok_or("no home folder")?;
                let transcript = crate::provider_session::claude_transcript(&home, &cwd, &id);
                let Some(first) = titles::first_message::<ClaudeDecoder>(&transcript) else {
                    return Ok(());
                };
                if !claim() {
                    return Ok(());
                }
                // Asked already, by the turn that wrote the first message.
                let live = match self.lock().get_mut(&session.id) {
                    Some(Live::Claude(live)) if live.initialized => Some(std::mem::replace(&mut live.title_asked, true)),
                    _ => None,
                };
                match live {
                    Some(true) => Ok(()),
                    Some(false) => self.claude_control(&session.id, titles::claude_request(&first)).map(drop),
                    None => titles::name_claude(std::path::Path::new(&self.resolve_bin("claude")?), std::path::Path::new(&cwd), &id, &first).map(drop),
                }
            }
            "codex" => {
                let Some(thread) = session.provider_session_id.as_deref() else {
                    return Ok(());
                };
                let home = crate::provider_session::codex_home().ok_or("no Codex home")?;
                let rollout = crate::session_history::codex::rollout_path(&home, thread);
                let Some(first) = rollout.and_then(|path| titles::first_message::<CodexDecoder>(&path)) else {
                    return Ok(());
                };
                if !claim() {
                    return Ok(());
                }
                let name = titles::codex_name(std::path::Path::new(&self.resolve_bin("codex")?), &first)?;
                titles::name_codex(&home.join("session_index.jsonl"), thread, &name)
            }
            _ => Ok(()),
        }
    }

    /// Write a message into a Claude child's running turn. Claude reads it at
    /// its next step and takes it into the turn it is in; its echo puts the
    /// message in the transcript. Refused when no Claude turn is live to take
    /// it, so the caller can queue it instead.
    /// `letter` is the letter it is, already claimed: read, it is delivered;
    /// unread when the turn ends, it waits for the turn the CLI starts on it,
    /// or goes back in the box (see [`TurnHost::claude_turn_ended`]).
    pub fn steer(
        &self,
        session_id: &str,
        text: &str,
        from: crew_protocol::BotRef,
        letter: Option<String>,
    ) -> Result<(), String> {
        self.steer_files(session_id, text, from, letter, Vec::new(), Vec::new())
    }

    /// [`TurnHost::steer`] for a message with files attached. They go in as
    /// the turn's own message would carry them: Claude takes an image as an
    /// image and the other files as paths to read, Codex takes every one as a
    /// path in the text.
    pub(crate) fn steer_files(
        &self,
        session_id: &str,
        text: &str,
        from: crew_protocol::BotRef,
        letter: Option<String>,
        files: Vec<AttachedFile>,
        rest: Vec<Extra>,
    ) -> Result<(), String> {
        // The kind first, out of the lock: `codex_steer` takes it again.
        let (codex, cursor, opencode) = match self.lock().get(session_id) {
            Some(Live::Codex(_)) => (true, false, false),
            Some(Live::Cursor(_)) => (false, true, false),
            Some(Live::Opencode(_)) => (false, false, true),
            _ => (false, false, false),
        };
        if codex {
            return self.codex_steer(session_id, text, from, letter, files, rest);
        }
        if opencode {
            return self.opencode_steer(session_id, text, from, letter, files, rest);
        }
        if cursor {
            // No `session/steer`, and a second prompt cancels the first.
            return Err("Cursor cannot take a message in the middle of a turn".into());
        }
        let typed = session::get(&self.store, session_id.to_string())
            .ok()
            .flatten()
            .as_ref()
            .and_then(driven)
            .is_some_and(|drive| typed_by_user(drive, &from));
        let steered = self.steer_text_all(session_id, &from, text, &rest);
        let images = crate::files::load_inline_images(&files);
        let inline: HashSet<String> = images.iter().map(|image| image.path.clone()).collect();
        let paths: Vec<String> = files.iter().filter(|file| !inline.contains(&file.path)).map(|file| file.path.clone()).collect();
        // What Claude echoes back is the text of the message it was given, so
        // that is what the echo is known by. A message of images alone has none.
        let sent = crate::providers::with_files(steered.trim(), &paths);
        if sent.trim().is_empty() {
            return Err("A message of only images has no text to know its echo by.".into());
        }
        let message = {
            let mut map = self.lock();
            let Some(Live::Claude(live)) = map.get_mut(session_id) else {
                return Err("No Claude turn is running to take it.".into());
            };
            if !live.active || live.cancelled || !live.initialized {
                return Err("No Claude turn is running to take it.".into());
            }
            live.steers.push(Steer {
                sent: sent.clone(),
                text: text.to_string(),
                from,
                kind: letter.as_deref().and_then(|id| mailbox::letter_kind(&self.store, id)),
                letter,
                files,
                typed,
                rest,
            });
            build_claude_user_message(&live.claude_session_id, None, steered.trim(), &paths, &images)
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

    /// A batch of letters written into a running turn as one message: each
    /// under its own envelope, one after the other, as a turn would be handed
    /// them.
    fn steer_text_all(
        &self,
        session_id: &str,
        from: &crew_protocol::BotRef,
        text: &str,
        rest: &[Extra],
    ) -> String {
        let mut all = self.steer_text(session_id, from, text);
        for extra in rest {
            all.push_str("\n\n");
            all.push_str(&self.steer_text(session_id, &extra.from, &extra.text));
        }
        all
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
        // A stop of the turn before is answered first: its late `result`
        // would otherwise end this turn.
        self.await_interrupt(session_id);
        // Asked before the lock: a process that died while idle without its
        // exit being heard (it was killed under us) is not one to write to.
        let alive = self.agents.running().iter().any(|id| id == session_id);
        let fast_allowed =
            crate::provider_session::claude_fast_mode().availability != crew_protocol::FastModeAvailability::Hidden;
        let plan = match self.lock().get(session_id) {
            // A turn the CLI started by itself, that this one takes over: the
            // settings wait for the next turn, as nothing changes mid-turn.
            Some(Live::Claude(live)) if alive && live.unclaimed() => Some(Plan::Changes(Vec::new())),
            Some(Live::Claude(live)) if alive && live.initialized && !live.active && !live.cancelled => {
                Some(claude_plan(&live.applied, &applied, fast_allowed))
            }
            _ => None,
        };
        if let Some(Plan::Changes(changes)) = plan {
            self.idle.lock().unwrap_or_else(|e| e.into_inner()).remove(session_id);
            // The board is not touched: the process is the one that ran what
            // it lists, so the entries stay and go on updating from its events.
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
        // moves on from it.
        let claude_session_id = match driven(session) {
            Some(Driven::User) => conversation_to_resume(session).unwrap_or_else(|| session.id.clone()),
            _ => conversation_to_resume(session).unwrap_or_else(|| uuid::Uuid::new_v4().to_string()),
        };
        let waits_for_background = driven(session) == Some(Driven::Child);
        self.lock().insert(
            session_id.to_string(),
            Live::Claude(Box::new(ClaudeLive::new(claude_session_id, waits_for_background, applied))),
        );
        // The entries stay; what the process before this one still ran is
        // stopped, since it was killed above without its end being heard.
        let now = crate::store::now_millis();
        self.background.touch(session_id, |board| board.launch(now));
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
            mcp_config: mcp.map(|(command, args)| crate::providers::claude::claude_mcp_config(&command, &args)),
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
            // `CLAUDE_CODE_ARTIFACT`: in stream-json the CLI withholds its
            // Artifact tools unless asked for them ("sdk_default_off"), and a
            // terminal session has them.
            Some({
                let mut env = self.agent_env(&session_id);
                env.insert("CLAUDE_CODE_ARTIFACT".into(), "1".into());
                env
            }),
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
            // Not a call waited on: its answer is what tells the CLI is up,
            // and it is also the first to list the commands.
            live.init_id = Some(id.clone());
            live.menu_cwd = spawn.user_settings.then(|| params.cwd.clone());
            id
        };
        // `perTaskStopAffordance`: Crew stops background work one task at a
        // time (`stop_task`), so the CLI's interrupt is to stop the turn only
        // and spare that work. Without it the interrupt kills it all.
        // `forwardSubagentText`: a subagent's steps carry what it said as well
        // as the tools it called, for its entry in the panel to be read.
        self.agents.write(
            &session_id,
            &serde_json::to_string(&build_control_request(
                &ctrl,
                json!({ "subtype": "initialize", "perTaskStopAffordance": true, "forwardSubagentText": true }),
            ))
            .unwrap_or_default(),
        )?;
        let init = self.block_on(async { tokio::time::timeout(INIT_TIMEOUT, init_rx).await });
        // Waited for once: the CLI says it is up at the start of every turn,
        // and that is nobody's to take.
        if let Some(Live::Claude(live)) = self.lock().get_mut(&session_id) {
            live.init_tx = None;
            live.init_id = None;
        }
        match init {
            // Up: how large its window is, for a meter before the first answer.
            Ok(Ok(true)) => {
                self.ask_claude_context(&session_id, false, None);
                self.ask_claude_mcp(&session_id, true);
            }
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
                _ => {}
            }
        }
        let kind = {
            let map = self.lock();
            match map.get(session_id) {
                Some(Live::Claude(_)) => "claude",
                Some(Live::Codex(_)) => "codex",
                Some(Live::Cursor(_)) => "cursor",
                Some(Live::Opencode(_)) | None => return,
            }
        };
        match kind {
            "claude" => self.handle_claude_line(session_id, line),
            "codex" => self.handle_codex_line(session_id, line),
            "cursor" => self.handle_cursor_line(session_id, line),
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

        // A turn's `init` and `result` say what became of fast mode: a turn
        // asked to be fast that the account cannot run fast goes at standard
        // speed without an error, and this is how the Fast toggle learns.
        let fast_state = string_field(Some(&rec), "fast_mode_state");
        let fast_reason = string_field(Some(&rec), "fast_mode_disabled_reason");
        if fast_state.is_some() || fast_reason.is_some() {
            crate::provider_session::note_claude_fast_mode(fast_state.as_deref(), fast_reason.as_deref());
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
        // The background work's end, which no turn has to be running to hear.
        let mut unheld = false;
        // The call that started a task the work list already has: a subagent
        // this process did not see start, which a `SendMessage` resumes.
        let mut origin = (rec.get("subtype").and_then(Value::as_str) == Some("task_started"))
            .then(|| string_field(Some(&rec), "task_id"))
            .flatten()
            .and_then(|task| {
                let call = self.background.read(session_id, |board| board.command(&task).and_then(|row| row.tool_call_id.clone()));
                call.flatten().map(|call| (task, call))
            });
        // A finished shell the transcript already draws: its row is marked
        // "Sent to the background" and says how it ended, so what woke the
        // model needs no line of its own.
        let drawn = (rec.get("subtype").and_then(Value::as_str) == Some("task_notification"))
            .then(|| string_field(Some(&rec), "task_id"))
            .flatten()
            .and_then(|task| {
                self.background.read(session_id, |board| {
                    board.command(&task).is_some_and(|row| row.kind == crew_protocol::BackgroundKind::Shell && row.tool_call_id.is_some())
                })
            })
            .unwrap_or(false);
        {
            let mut map = self.lock();
            let Some(Live::Claude(live)) = map.get_mut(session_id) else {
                return;
            };
            let type_name = string_field(Some(&rec), "type");
            let subtype = string_field(Some(&rec), "subtype");
            let tasks = type_name.as_deref() == Some("system")
                && matches!(
                    subtype.as_deref(),
                    Some(
                        "task_started" | "task_progress" | "task_updated" | "task_notification" | "background_tasks_changed"
                    )
                );
            if live.mute {
                // The interrupt's result closes the stopped turn: the process
                // is the next turn's to run on. Till then only the background
                // work, which the interrupt spared, is heard.
                if type_name.as_deref() == Some("result") {
                    live.mute = false;
                    live.cancelled = false;
                }
                if !tasks {
                    return;
                }
            }
            if let Some(from_line) = session_id_from_message(&rec) {
                if from_line != live.claude_session_id {
                    live.claude_session_id = from_line.clone();
                    bind = Some(from_line);
                }
            }
            // The menu: the CLI sends the whole list again when it finds
            // skills as the agent works in a folder, and a turn's `init` names
            // the skills among the commands.
            if type_name.as_deref() == Some("system") && subtype.as_deref() == Some("commands_changed") {
                let menu = live.menu_cwd.clone().zip(rec.get("commands").map(crate::commands::claude_entries));
                drop(map);
                if let Some((cwd, entries)) = menu {
                    self.learn_commands(session_id, &cwd, Some(entries), None);
                }
                return;
            }
            if type_name.as_deref() == Some("control_response")
                || (type_name.as_deref() == Some("system")
                    && matches!(subtype.as_deref(), Some("init" | "initialized")))
            {
                // What the line teaches of the menu: the answer to
                // `initialize` lists the commands, and `init` the skills.
                let answer = parse_control_response(&rec)
                    .filter(|(id, _)| live.init_id.as_deref() == Some(id.as_str()))
                    .and_then(|(_, result)| result.ok());
                if answer.is_some() {
                    live.init_id = None;
                }
                let skills = (subtype.as_deref() == Some("init")).then(|| rec.get("skills")).flatten();
                let servers = (subtype.as_deref() == Some("init")).then(|| rec.get("mcp_servers").cloned()).flatten();
                let menu = live.menu_cwd.clone().map(|cwd| {
                    (
                        cwd,
                        answer.as_ref().and_then(|answer| answer.get("commands")).map(crate::commands::claude_entries),
                        skills.map(crate::commands::claude_skill_names),
                    )
                });
                // A turn starting with none of Crew's running is one the CLI
                // started by itself: background work reported, or a steer a
                // turn left unread. Within a turn held on background work, it
                // is that turn carrying on.
                let turn_starts = subtype.as_deref() == Some("init") && live.initialized;
                let adopt = (turn_starts && !live.active).then_some(live.epoch);
                if turn_starts && live.active {
                    live.held = false;
                }
                if !live.initialized {
                    live.initialized = true;
                    if let Some(tx) = live.init_tx.take() {
                        let _ = tx.send(true);
                    }
                }
                drop(map);
                if let Some((cwd, entries, skills)) = menu.filter(|(_, entries, skills)| entries.is_some() || skills.is_some())
                {
                    self.learn_commands(session_id, &cwd, entries, skills);
                }
                if let Some(servers) = servers {
                    self.mcp_init(session_id, &servers);
                }
                if let Some(epoch) = adopt {
                    self.adopt_claude_turn(session_id, epoch);
                }
                return;
            }
            // A subagent's own frame: a step on its call's row, and nothing
            // the agent itself said or did.
            if let Some(steps) = live.subagents.frame(&rec) {
                drop(map);
                // The model it runs on is named by the frames it sends.
                let model = string_field(Some(&rec), "parent_tool_use_id").zip(
                    rec.get("message").and_then(|message| message.get("model")).and_then(Value::as_str).map(str::to_string),
                );
                if let Some((call, model)) = model {
                    self.background.touch(session_id, |board| board.claude_subagent_model(&call, &model));
                }
                if let Some(id) = bind {
                    self.transcripts.apply(session_id, HarnessEvent::SessionProviderBound { provider_session_id: id });
                }
                for event in steps {
                    self.transcripts.apply(session_id, event);
                }
                return;
            }
            if let Some((task, call)) = origin.take() {
                live.subagents.remember(&task, &call);
            }
            let tools = &live.tools_by_id;
            events.extend(live.subagents.task(&rec, |id| tools.get(id).map(|tool| (tool.name.clone(), tool.input.clone()))));
            let notice = live.subagents.notice(&rec);
            // What the board reads beside the task lines: a turn's result names
            // the windows of its models, and the answer to an Agent call what
            // the subagent used in all.
            let agent_result = type_name.as_deref() == Some("user")
                && rec.get("tool_use_result").is_some_and(|result| result.get("agentId").is_some());
            if tasks || agent_result || type_name.as_deref() == Some("result") {
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
                        // Only what wakes the model is what woke it.
                        if wakes_the_model(string_field(Some(&rec), "status").as_deref()) {
                            live.wakes = true;
                            let summary = notice.or_else(|| string_field(Some(&rec), "summary")).filter(|_| !drawn);
                            if let Some(summary) = summary.filter(|s| !s.trim().is_empty()) {
                                let summary = summary.trim().to_string();
                                if !live.woken_by.contains(&summary) {
                                    live.woken_by.push(summary);
                                }
                            }
                        }
                    }
                    Some("task_updated") => {
                        let status =
                            rec.get("patch").and_then(|patch| patch.get("status")).and_then(Value::as_str);
                        let done = status.is_some_and(|status| matches!(status, "completed" | "failed" | "killed" | "stopped"));
                        if let (true, Some(task)) = (done, string_field(Some(&rec), "task_id")) {
                            live.background.remove(&task);
                            // Said before its notification: a held turn must
                            // not end in between on work that is to wake it.
                            live.wakes |= wakes_the_model(status);
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
            } else if type_name.as_deref() == Some("system") && subtype.as_deref() == Some("local_command_output") {
                // What a command the CLI ran itself printed. The 2.1.295 CLI
                // says it as a synthetic assistant message instead, which
                // draws as any reply; this is the SDK's own line for it.
                let output = string_field(Some(&rec), "content")
                    .and_then(|content| crate::command_output::local_command_output(&content));
                if let Some(message) = output {
                    events.push(HarnessEvent::SessionNote { message });
                }
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
                // here, where the model read it, whether in the turn it was
                // written into or in the one the CLI starts by itself on a
                // steer a turn left unread.
                if let Some(echo) = crate::providers::claude::replayed_text(&rec).filter(|_| live.active) {
                    if let Some(at) = live.steers.iter().position(|steer| steer.sent.trim() == echo) {
                        let steer = live.steers.remove(at);
                        let read = steer.read();
                        for event in &read {
                            if let HarnessEvent::UserMessage { letter_id: Some(id), .. } = event {
                                let _ = mailbox::delivered(&self.store, std::slice::from_ref(id));
                            }
                        }
                        events.extend(read);
                    } else {
                        // Not a steer's: the message the turn was started
                        // with, read.
                        self.confirm_carried(session_id);
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
                if live.applied.service_tier.as_deref() == Some("fast") && !live.fast_refused {
                    if let Some(message) = fast_reason.as_deref().and_then(crate::provider_session::claude_fast_refusal) {
                        live.fast_refused = true;
                        events.push(HarnessEvent::SessionNote { message });
                    }
                }
                if live.waits_for_background && !live.background.is_empty() && failed.is_none() && !live.cancelled {
                    // Not over: Claude carries on by itself once its
                    // background commands finish, and that is the report.
                    live.held_results += 1;
                    live.held = true;
                    hold = Some((live.held_results, live.epoch, live.turn));
                } else {
                    if !live.cancelled {
                        ask = Some((false, result_context_window(&rec)));
                    }
                    live.end_turn(match failed {
                        Some(message) => TurnOutcome::Failed(message),
                        None => TurnOutcome::Completed,
                    });
                }
            }
            // The model speaking is what woke it, at work again.
            if spoke && !is_subagent_message(&rec) {
                live.wakes = false;
                live.held = false;
            }
            // What a held turn waited on was stopped, which wakes nobody: the
            // CLI starts no turn on it, so the result it had is the end.
            if live.active && live.held && live.background.is_empty() && !live.wakes {
                live.end_turn(TurnOutcome::Completed);
                unheld = true;
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
        } else if spoke || unheld {
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
            self.publish_context(session_id, |_| Some(ContextReading { used, window: None, auto_compact_at: None, stale: None }));
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
                    Some(Live::Claude(live))
                        if live.active && live.held && live.epoch == epoch && live.turn == turn && live.held_results == held
                );
                if still {
                    host.signal(&id, TurnOutcome::Completed);
                    // The work runs on, but no turn waits on it now.
                    host.background.touch(&id, |board| board.set_waiting(false));
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

}

/// The reading a new one makes after the last: one without a window keeps the
/// last window and auto-compact point. Whether it is stale is the new
/// reading's own word: a count taken after a compaction is current again.
fn merge_context(last: Option<&ContextReading>, reading: ContextReading) -> ContextReading {
    match (last, reading.window) {
        (Some(last), None) => ContextReading {
            used: reading.used,
            window: last.window,
            auto_compact_at: last.auto_compact_at,
            stale: reading.stale,
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

/// Whether background work that ended with `status` wakes the model: the CLI
/// starts a turn on a task that completed or failed, and on none the user
/// stopped (measured on 2.1.295: `stop_task` on an idle CLI says
/// `task_notification` with `stopped`, and nothing follows).
fn wakes_the_model(status: Option<&str>) -> bool {
    !matches!(status, Some("stopped" | "killed"))
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

    /// Runs `hook` once, as the next Claude turn is about to write its message.
    pub(crate) fn test_before_message(&self, hook: impl FnOnce() + Send + 'static) {
        *self.before_message.lock().unwrap_or_else(|e| e.into_inner()) = Some(Box::new(hook));
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

    /// opencode's server (`fake_opencode_server`): a turn answers at once,
    /// which ends it, the moment the box is drained.
    fn fake_opencode(dir: &std::path::Path) -> String {
        fake_opencode_server(dir).0
    }

    /// What each turn handed the server: its message, the session's persona
    /// and settings, as the fake logs them beside itself.
    fn launches(world: &World) -> Vec<Value> {
        std::fs::read_to_string(world.dir.join("launches.jsonl"))
            .unwrap_or_default()
            .lines()
            .filter_map(|line| serde_json::from_str(line).ok())
            .collect()
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
                command: None,
                skills: None,
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
        world
            .host
            .start(TurnStart {
                session_id: coder.id.clone(),
                cwd: world.dir.to_string_lossy().into_owned(),
                text: "SILENT".into(),
                files: None,
                mentions: None,
                hidden: None,
                from_bot: None,
                sent_at: None,
                nonce: None,
                letter_id: None,
                mode: None,
                command: None,
                skills: None,
            })
            .expect("start");
        // The watchdog's own timeout is two minutes; this asserts it is armed,
        // not that the test waits for it.
        for _ in 0..200 {
            if !launches(&world).is_empty() {
                break;
            }
            std::thread::sleep(std::time::Duration::from_millis(25));
        }
        // Polled: under load the turn can take longer than any fixed pause to
        // come up.
        let watched = || {
            let map = world.host.lock();
            matches!(map.get(&coder.id), Some(Live::Opencode(live)) if live.active && !live.saw_output)
        };
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(30);
        while !watched() && std::time::Instant::now() < deadline {
            std::thread::sleep(std::time::Duration::from_millis(20));
        }
        let silent_and_watched = watched();
        world.host.stop(&coder.id).expect("stop");
        settle(&world, &coder.id);
        assert!(silent_and_watched, "a provider with no output was not being watched");
    }

    /// The run's host token speaks for whichever session names itself, so it
    /// lives in the MCP server's own environment and nowhere a shell the
    /// server runs could read it off: not in the server's environment, not on
    /// its argv.
    #[test]
    fn the_server_process_does_not_hold_the_runs_host_token() {
        let world = world();
        let ws = workspace(&world);
        let coder = bot(&world, &ws, "Coder");
        turn(&world, &coder, "hello");
        let launch = std::fs::read_dir(&world.dir)
            .expect("dir")
            .filter_map(Result::ok)
            .map(|entry| entry.path())
            .find(|path| path.extension().is_some_and(|ext| ext == "launch"))
            .expect("the server was launched");
        let launched: Value = serde_json::from_str(std::fs::read_to_string(launch).expect("log").lines().next().expect("a launch")).expect("json");
        let token = launched
            .pointer("/config/mcp/servers/crew/environment/CREW_TOKEN")
            .and_then(Value::as_str)
            .expect("the MCP server's own environment holds the token");
        assert!(!token.is_empty());
        let values = launched["env_values"].as_array().expect("env values");
        assert!(!values.is_empty());
        assert!(values.iter().all(|value| !value.as_str().unwrap_or_default().contains(token)), "the server's environment: {values:?}");
        assert!(!launched["env"].as_array().unwrap().iter().any(|key| key == "CREW_TOKEN"), "{}", launched["env"]);
        assert!(!launched["argv"].to_string().contains(token), "{}", launched["argv"]);
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
    /// nothing a bot knows survives except what Crew hands it back. Its
    /// session goes when its turn ends; Crew keeps the transcript.
    #[test]
    fn a_second_turn_is_handed_the_first_one() {
        let world = world();
        let ws = workspace(&world);
        let coder = bot(&world, &ws, "Coder");

        turn(&world, &coder, "el parser se cae con tabs");
        let first = launches(&world)[0].clone();
        assert!(!first["prompt"].as_str().unwrap().contains("## The conversation so far"), "{first}");

        turn(&world, &coder, "y ahora?");
        let second = launches(&world)[1].clone();
        assert_ne!(first["session"], second["session"], "a bot's turn carried on its last session");
        let log = world.dir.read_dir().unwrap().flatten().map(|entry| entry.path()).find(|path| {
            path.extension().is_some_and(|ext| ext == "log") && path.to_string_lossy().contains("fake-opencode-")
        });
        let requests = std::fs::read_to_string(log.expect("the request log")).unwrap();
        let deleted = format!("\"method\": \"DELETE\", \"path\": \"/api/session/{}\"", first["session"].as_str().unwrap());
        assert!(requests.contains(&deleted), "the first turn's session outlived it: {requests}");
        // The persona is the session's instruction entry, on every turn.
        let system = second["system"].as_str().unwrap();
        assert!(system.starts_with("## Crew bot\n\nYou are Coder,"), "the persona is on every turn: {system}");
        let prompt = second["prompt"].as_str().unwrap();
        assert!(system.contains("`crew_search_messages`") && !prompt.contains("You are Coder,"), "{prompt}");
        assert!(prompt.contains("· user] el parser se cae con tabs"), "{prompt}");
        assert!(prompt.contains("· you] report: el parser se cae con tabs"), "the reply is in the tail too: {prompt}");
        assert!(prompt.trim_end().ends_with("y ahora?"), "{prompt}");
        assert!(prompt.find("· user] el parser").unwrap() < prompt.find("## This turn").unwrap(), "{prompt}");
        // A bot has nobody to put a question to, and Crew's tools never ask.
        let rules = second["permissions"].as_array().unwrap();
        assert!(rules.contains(&json!({ "action": "question", "resource": "*", "effect": "deny" })), "{rules:?}");
        assert_eq!(rules.last(), Some(&json!({ "action": "crew_*", "resource": "*", "effect": "allow" })));
    }

    /// The setting overrides a bot that asks: its next session is made the
    /// way a "full" one is, and turning it off gives the bot its own back.
    #[test]
    fn bypass_permissions_runs_an_asking_bot_without_asking() {
        let world = world();
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
        )
        .expect("bot");
        let allowed_all = || {
            let last = launches(&world).last().cloned().expect("the provider was never asked");
            last["permissions"].as_array().unwrap().contains(&json!({ "action": "*", "resource": "*", "effect": "allow" }))
        };

        turn(&world, &asker, "one");
        assert!(!allowed_all(), "an asking bot asks by default");

        crate::store::set(world.host.test_store(), crate::session::BYPASS_KEY.into(), "on".into()).expect("set");
        turn(&world, &asker, "two");
        assert!(allowed_all(), "bypass runs it without asking");

        crate::store::delete(world.host.test_store(), crate::session::BYPASS_KEY.into()).expect("delete");
        turn(&world, &asker, "three");
        assert!(!allowed_all(), "off again, it asks again");
    }

    /// Without this the model gets a turn shaped exactly like something the
    /// user typed, and answers in its own chat where the sender never reads it.
    #[test]
    fn a_letter_reaches_the_model_with_the_sender_on_it() {
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

        world.host.deliver_to(&cuddles);
        settle(&world, &cuddles.id);

        let prompt = launches(&world)[0]["prompt"].as_str().expect("the provider was never asked").to_string();
        // The id, so the reader has an address and not only a label, and the
        // time it was written rather than the time it was handed over.
        assert!(prompt.contains(&format!("## Message\nFrom: Coder (bot {}), a model\nAt: ", coder.id)), "{prompt}");
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
            .start(TurnStart {
                session_id: cuddles.id.clone(),
                cwd: world.dir.to_string_lossy().into_owned(),
                text: "SLEEP 5".into(),
                files: None,
                mentions: None,
                hidden: None,
                from_bot: None,
                sent_at: None,
                nonce: None,
                letter_id: None,
                mode: None,
                command: None,
                skills: None,
            })
            .expect("start");
        for _ in 0..200 {
            if !launches(&world).is_empty() {
                break;
            }
            std::thread::sleep(std::time::Duration::from_millis(25));
        }
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
        let bot = crate::session::create(store, ws.clone(), "bot".into(), "B".into(), "claude".into(), "".into(), "".into(), "ask".into())
            .expect("bot");
        let child = crate::session::create_child(store, ws, "C".into(), "claude".into(), "".into(), "ask".into(), None, Some(bot.id.clone()))
            .expect("child");
        let cwd = dir.to_string_lossy().into_owned();
        let told = host.persona(&bot, Harness::Mcp, true, &cwd).expect("bot persona");
        assert!(told.starts_with("## Crew bot") && told.contains("`mcp__crew__delegate`") && told.contains("## Message"), "{told}");
        assert!(told.contains(&format!("Your id is {}.", bot.id)) && told.contains(&format!("You work in {cwd}.")), "{told}");
        let child_told = host.persona(&child, Harness::Mcp, true, &cwd).expect("child persona");
        assert!(child_told.starts_with("## Crew session"), "{child_told}");
        assert!(child_told.contains(&format!("B, a bot (id {}), started you", bot.id)) && child_told.contains("you cannot delegate or start sessions"), "{child_told}");
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

    fn until(mut ready: impl FnMut() -> bool) {
        for _ in 0..400 {
            if ready() {
                return;
            }
            std::thread::sleep(std::time::Duration::from_millis(25));
        }
        panic!("it never came to pass");
    }

    fn child_row(world: &World, session: &str) -> Option<crew_protocol::BackgroundCommand> {
        world.host.background_list(session).commands.into_iter().next()
    }

    fn subagent_call(world: &World, session: &str) -> (String, crew_protocol::ToolDetail) {
        blocks(world, session)
            .into_iter()
            .find_map(|block| block.tool.filter(|tool| tool.name == "subagent"))
            .map(|tool| (tool.call_id, tool.detail.expect("detail")))
            .expect("the subagent call")
    }

    /// A child session a task call started has an entry of its own, linked to
    /// the call, with its model, tokens and state; its steps and answer are
    /// the call's, and the parent's message is what the parent wrote.
    #[test]
    fn an_opencode_child_session_is_an_entry_and_the_steps_of_its_call() {
        use crew_protocol::{BackgroundKind, BackgroundState, BlockRole, SubagentState, ToolDetail};
        let world = world();
        let ws = workspace(&world);
        let coder = bot(&world, &ws, "Coder");
        turn(&world, &coder, "SUBAGENT");
        let (call, detail) = subagent_call(&world, &coder.id);
        let row = child_row(&world, &coder.id).expect("an entry");
        assert_eq!((row.kind, row.state), (BackgroundKind::Subagent, BackgroundState::Completed));
        assert_eq!(row.tool_call_id.as_deref(), Some(call.as_str()));
        assert_eq!(row.thread_id.as_deref(), Some(row.id.as_str()));
        assert_eq!(row.model.as_deref(), Some("opencode/nemotron-3.5-lightning-free"));
        assert_eq!(row.effort, None, "opencode's default variant is no effort");
        assert_eq!(row.description.as_deref(), Some("Reply with pong"));
        assert_eq!(row.tokens, Some(3000 + 10 + 2 + 1000));
        assert_eq!((row.stoppable, row.activity), (Some(true), None));
        assert_eq!(world.host.background_list(&coder.id).commands.len(), 1);
        let ToolDetail::Agent { state, output, steps, .. } = detail else {
            panic!("not an agent row");
        };
        assert_eq!((state, output.as_deref()), (Some(SubagentState::Done), Some("pong")));
        let steps = steps.expect("steps");
        let rows: Vec<(BlockRole, String)> = steps.iter().map(|step| (step.role.clone(), step.text.clone())).collect();
        assert_eq!(rows, [(BlockRole::Tool, "echo child".to_string()), (BlockRole::Assistant, "pong".to_string())]);
        let said: Vec<String> = blocks(&world, &coder.id)
            .into_iter()
            .filter(|block| block.role == BlockRole::Assistant)
            .map(|block| block.text)
            .collect();
        assert_eq!(said, ["report: SUBAGENT"], "the child's words are not the parent's answer");
    }

    /// A second call that names the child a call already started continues
    /// it: one entry, and each call keeps its own steps, report and state.
    #[test]
    fn a_second_opencode_call_continues_the_same_child_and_keeps_its_own_steps() {
        use crew_protocol::{BackgroundState, BlockRole, SubagentState, ToolDetail};
        let world = world();
        let ws = workspace(&world);
        let coder = bot(&world, &ws, "Coder");
        turn(&world, &coder, "SUBAGENT RESUME");
        let calls: Vec<(String, ToolDetail)> = blocks(&world, &coder.id)
            .into_iter()
            .filter_map(|block| block.tool.filter(|tool| tool.name == "subagent"))
            .map(|tool| (tool.call_id, tool.detail.expect("detail")))
            .collect();
        assert_eq!(calls.len(), 2, "one row per call");
        let list = world.host.background_list(&coder.id);
        assert_eq!(list.commands.len(), 1, "one entry for the one child");
        let row = &list.commands[0];
        assert_eq!(row.state, BackgroundState::Completed);
        assert_eq!(row.tool_call_id.as_deref(), Some(calls[0].0.as_str()));
        let mut threads = Vec::new();
        let mut seen = Vec::new();
        for (_, detail) in &calls {
            let ToolDetail::Agent { state, output, steps, thread, .. } = detail else {
                panic!("not an agent row");
            };
            threads.push(thread.clone());
            let steps = steps.clone().expect("steps");
            let rows: Vec<(BlockRole, String)> = steps.iter().map(|step| (step.role.clone(), step.text.clone())).collect();
            seen.push((state.clone(), output.clone(), rows));
        }
        assert_eq!(threads, [Some(row.id.clone()), Some(row.id.clone())], "both name the child");
        assert_eq!(
            seen,
            [
                (
                    Some(SubagentState::Done),
                    Some("pong".to_string()),
                    vec![(BlockRole::Tool, "echo child".to_string()), (BlockRole::Assistant, "pong".to_string())]
                ),
                (
                    Some(SubagentState::Done),
                    Some("pong again".to_string()),
                    vec![(BlockRole::Tool, "echo child".to_string()), (BlockRole::Assistant, "pong again".to_string())]
                ),
            ]
        );
    }

    /// Stop on the entry interrupts the child's own session; the parent's turn
    /// is not interrupted and ends when it says so.
    #[test]
    fn stopping_an_opencode_child_interrupts_its_session_and_not_the_parent() {
        use crew_protocol::{BackgroundState, SubagentState, ToolDetail};
        let world = world();
        let ws = workspace(&world);
        let coder = bot(&world, &ws, "Coder");
        world
            .host
            .start(TurnStart {
                session_id: coder.id.clone(),
                cwd: world.dir.to_string_lossy().into_owned(),
                text: "SUBAGENT SLOW".into(),
                files: None,
                mentions: None,
                hidden: None,
                from_bot: None,
                sent_at: None,
                nonce: None,
                letter_id: None,
                mode: None,
                command: None,
                skills: None,
            })
            .expect("start");
        until(|| child_row(&world, &coder.id).is_some_and(|row| row.tokens.is_some()));
        let row = child_row(&world, &coder.id).expect("entry");
        assert_eq!(row.state, BackgroundState::Running);
        assert!(world.host.is_running(&coder.id));
        world.host.background_stop(&coder.id, &row.id).expect("stop");
        settle(&world, &coder.id);
        let row = child_row(&world, &coder.id).expect("entry");
        assert_eq!(row.state, BackgroundState::Stopped);
        let (_, detail) = subagent_call(&world, &coder.id);
        let ToolDetail::Agent { state, .. } = detail else {
            panic!("not an agent row");
        };
        assert_eq!(state, Some(SubagentState::Stopped));
        let log = std::fs::read_to_string(world.dir.join(std::fs::read_dir(&world.dir).unwrap().filter_map(|e| e.ok()).map(|e| e.file_name().to_string_lossy().into_owned()).find(|n| n.ends_with(".log") && n.starts_with("fake-opencode")).expect("log"))).expect("read log");
        let interrupts: Vec<&str> = log.lines().filter(|line| line.contains("/interrupt")).collect();
        assert_eq!(interrupts.len(), 1, "only the child was interrupted: {interrupts:?}");
        assert!(interrupts[0].contains(&row.id));
    }
}

#[cfg(test)]
mod context_tests {
    use super::*;

    fn reading(used: u64, window: Option<u64>, auto_compact_at: Option<u64>) -> ContextReading {
        ContextReading { used, window, auto_compact_at, stale: None }
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

#[cfg(test)]
mod background_stop_tests {
    use super::*;
    use crew_protocol::{BackgroundCommand, BackgroundKind, BackgroundState};

    fn entry(id: &str, kind: BackgroundKind, stoppable: Option<bool>, note: Option<&str>) -> BackgroundCommand {
        BackgroundCommand {
            id: id.into(),
            command: "Review the diff".into(),
            description: None,
            kind,
            started_at: 1,
            state: BackgroundState::Running,
            exit_code: None,
            ended_at: None,
            tool_call_id: None,
            tokens: None,
            window: None,
            stoppable,
            stop_note: note.map(str::to_string),
            activity: None,
            model: None,
            effort: None,
            foreground: None,
            thread_id: None,
        }
    }

    fn host_with(install: impl Fn(&TurnHost, &str), rows: Vec<BackgroundCommand>) -> TurnHost {
        let host = TurnHost::test_new();
        install(&host, "s1");
        host.background.touch("s1", |board| board.launch(0));
        for row in rows {
            host.background.touch("s1", |board| board.test_entry(row));
        }
        host
    }

    /// An entry that says it cannot be stopped alone is not handed to the
    /// provider, which would stop what the row does not name (a subagent that
    /// stops only with its turn) or fail with a message of its own.
    #[test]
    fn an_entry_that_cannot_be_stopped_alone_says_why_and_asks_no_provider() {
        let rows = vec![
            entry("a1", BackgroundKind::Subagent, Some(false), Some("stops with the turn")),
            entry("a2", BackgroundKind::Subagent, Some(false), None),
        ];
        for install in [TurnHost::test_install_claude, TurnHost::test_install_codex] {
            let host = host_with(install, rows.clone());
            assert_eq!(host.background_stop("s1", "a1"), Err("It cannot be stopped on its own: it stops with the turn.".into()));
            assert_eq!(host.background_stop("s1", "a2"), Err("It cannot be stopped on its own.".into()));
            assert_eq!(host.background_stop("s1", "nope"), Err("No such background command.".into()));
            let list = host.background_list("s1");
            assert!(list.commands.iter().all(|row| row.state == BackgroundState::Running), "{list:?}");
        }
    }

    /// A terminal Codex named no process for cannot be terminated, and says so
    /// before it asks the app server.
    #[test]
    fn a_codex_terminal_without_a_process_errors_clearly() {
        let host = host_with(TurnHost::test_install_codex, vec![entry("t1", BackgroundKind::Shell, Some(true), None)]);
        assert_eq!(host.background_stop("s1", "t1"), Err("Codex named no process for it.".into()));
    }

    /// Whatever has ended needs no stop, and what ran in a CLI that is gone
    /// went with it.
    #[test]
    fn an_ended_entry_needs_no_stop_and_one_without_its_cli_cannot_have_one() {
        let host = host_with(TurnHost::test_install_claude, vec![entry("a1", BackgroundKind::Subagent, Some(true), None)]);
        host.background.touch("s1", |board| board.settle("a1", BackgroundState::Completed, None, 5));
        assert_eq!(host.background_stop("s1", "a1"), Ok(()));
        host.background.touch("s1", |board| board.test_entry(entry("a2", BackgroundKind::Subagent, Some(true), None)));
        host.background.touch("s1", |board| board.end(9, "its CLI exited"));
        assert_eq!(host.background_stop("s1", "a2"), Ok(()), "ended with its CLI, so there is nothing to stop");
    }
}
