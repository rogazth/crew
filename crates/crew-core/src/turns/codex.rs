//! The Codex driver: one `codex app-server` per session, spoken to in
//! JSON-RPC over its stdio. A child keeps it between turns, each one a
//! `turn/start` on the thread it opened, so a second message does not restart
//! the CLI and the MCP servers it starts with; a bot, or a turn that failed or
//! was stopped, gets a fresh process, killed when its turn ends (a child
//! carries on its thread with `thread/resume`, a bot starts a clean one with
//! the tail Crew hands it). While a turn runs, Crew can steer it, interrupt it,
//! and answer the approvals and questions it sends, through the same events
//! and cards as Claude's.
//!
//! The agents the model spawns (`spawnAgent`) are threads of the same app
//! server, and speak on the same connection. What names a thread other than
//! the one Crew opened is its `threadId`: the parent's notifications go on as
//! they do, a child's become the steps, state and tokens of the call that
//! spawned it, and never a word of the parent's message.
//!
//! The protocol itself (params, items, request shapes) is in
//! `providers/codex.rs`.

use std::collections::{HashMap, HashSet};
use std::sync::atomic::Ordering;
use std::sync::mpsc::{self, RecvTimeoutError};
use std::thread;
use std::time::Duration;

use crew_protocol::{
    ApprovalDecision, ApprovalResolution, BackgroundState, CommandEntry, ContextReading, HarnessEvent, McpState, SubagentState,
};
use serde_json::{json, Map, Value};
use tokio::sync::oneshot;

use super::{
    carries_conversation, conversation_to_resume, driven, offers_fast, path_list, typed_by_user, Harness, Launch,
    QuestionReply, Steer, TurnHost, TurnOutcome, INIT_TIMEOUT, NEXT_EPOCH,
};
use crate::command_sources::{codex_commands, codex_skills};
use crate::mailbox;
use crate::session;
use crate::providers::codex::{
    mcp_list_params, mcp_login_params, mcp_login_url, mcp_servers, mcp_startup,
    approval_response, classify_request, completed_tool_status, exec_item, initialize_params, interrupt_params,
    is_tool_item, item_files, plan_detail, questions_response, rpc_error_message, skills_list_params, skills_reload_params, steer_params,
    skills_input, spawned_threads, text_input, thread_id, thread_request, tool_call_id, tool_detail, tool_label,
    tool_name, turn_end, turn_id, turn_start_input, unsupported_error, user_message_text, with_attached_paths,
    ApprovalKind, CodexAsk, CodexCommand, CodexThread, TurnEnd,
};
use crate::providers::string_field;

use super::Live;

/// How long opening a thread and starting a turn may take. A resume reads the
/// whole rollout, and the user's own MCP servers start alongside.
const OPEN_TIMEOUT: Duration = Duration::from_secs(90);
/// How long `turn/steer` may take to be accepted or refused.
const STEER_TIMEOUT: Duration = Duration::from_secs(15);
/// After `turn/interrupt`, how long the turn may take to say it ended before
/// its process is killed under it.
pub(super) const INTERRUPT_GRACE: Duration = Duration::from_secs(if cfg!(test) { 2 } else { 3 });

/// How often the background terminals are listed while a command runs.
const TERMINAL_POLL: Duration = Duration::from_secs(2);

/// How long `skills/list` may take. It scans the skill folders on disk, and
/// nothing waits on its answer, so this only bounds the thread that asks.
const CATALOG_TIMEOUT: Duration = Duration::from_secs(30);

/// How long `mcpServer/oauth/login` may take to answer with the page to open:
/// it starts the redirect listener first.
const LOGIN_TIMEOUT: Duration = Duration::from_secs(30);

/// How a turn begins on an open thread.
enum Start {
    /// `turn/start`, with this input.
    Turn(Value),
    /// A command Crew maps to a method of Codex's own.
    Command(CodexCommand),
}

/// A request the app server is waiting on Crew for, by the id the UI knows.
pub(super) struct Pending<T> {
    rpc_id: Value,
    tx: mpsc::Sender<T>,
}

/// How many notifications a thread may have said before the call that spawned
/// it names it, before the oldest are let go. The call completes moments after
/// the thread starts, so a thread that waits longer is one nothing will name.
const HELD_LIMIT: usize = 256;

/// What the driver follows of one thread's items: the ones a request may
/// name, the calls shown, and the message being written.
#[derive(Default)]
struct Follow {
    /// Items the turn started, by id: a file-change approval names only its
    /// item, and the item has the files.
    items: HashMap<String, Map<String, Value>>,
    seen_tools: HashSet<String>,
    /// The agent message being written, and what of it is in the transcript.
    message: Option<(String, String)>,
}

/// A thread other than the one Crew opened: an agent the model spawned. It
/// speaks on the parent's connection, and nothing says whose it is until the
/// `spawnAgent` call that started it completes and names it, which comes after
/// the thread's first notifications. They wait here until it does.
#[derive(Default)]
struct Child {
    /// The call in the transcript that spawned it, once that call named it.
    /// An agent's own agents are steps of the call that started the first.
    call: Option<String>,
    /// Who it is, when `thread/started` said.
    nickname: Option<String>,
    /// The turn it runs. A stop is addressed to it.
    turn: Option<String>,
    follow: Follow,
    /// The last thing it wrote: its report, when its turn ends.
    report: Option<String>,
    /// What it said before `call` was known, in order.
    held: Vec<(String, Value)>,
}

impl Child {
    /// How its asks are labelled: the card says whose it is.
    fn who(&self) -> String {
        self.nickname.clone().unwrap_or_else(|| "Subagent".into())
    }
}

/// What a child's notifications come to, applied once the lock is let go.
#[derive(Default)]
struct ChildWork {
    events: Vec<HarnessEvent>,
    board: Vec<ChildBoard>,
}

/// A change to a child's entry in the background board.
enum ChildBoard {
    Spawned { thread: String, call: String, label: String, nickname: Option<String>, model: Option<String> },
    State(String, BackgroundState),
    Usage { thread: String, tokens: u64, window: Option<u64> },
    Activity(String, String),
}

/// One app server and its thread. What lives as long as the process is the
/// thread, the request counters and the stderr tail; the rest belongs to the
/// turn that is running and starts over in [`CodexLive::begin_turn`].
pub(super) struct CodexLive {
    epoch: u64,
    /// What it was launched with.
    applied: Launch,
    thread_id: Option<String>,
    /// The folder the thread was opened in. Its skills are read for it.
    cwd: String,
    /// The turn that is running. `turn/start` on a busy thread would steer
    /// it without a word, so this is what says whether one is.
    turn_id: Option<String>,
    /// The turn that ended last. What Codex still says of it, once the next
    /// one has begun, is not the next one's.
    last_turn: Option<String>,
    next_id: u64,
    /// Requests Crew sent, waiting for their answer.
    calls: HashMap<u64, mpsc::Sender<Result<Value, String>>>,
    pub(super) approvals: HashMap<u64, Pending<ApprovalResolution>>,
    pub(super) questions: HashMap<u64, Pending<QuestionReply>>,
    next_ui: u64,
    /// What the turn follows of the thread's items.
    follow: Follow,
    /// Steers Codex accepted and has not echoed yet, oldest first.
    steers: Vec<Steer>,
    /// The agents the model spawned, by thread. They outlive a turn, and so
    /// does what is known of them.
    children: HashMap<String, Child>,
    pub(super) active: bool,
    pub(super) cancelled: bool,
    pub(super) settled: bool,
    pub(super) turn_tx: Option<oneshot::Sender<TurnOutcome>>,
    pub(super) stderr: Vec<String>,
    pub(super) saw_output: bool,
}

impl CodexLive {
    pub(super) fn new(turn_tx: Option<oneshot::Sender<TurnOutcome>>, applied: Launch) -> Self {
        Self {
            epoch: NEXT_EPOCH.fetch_add(1, Ordering::Relaxed),
            applied,
            thread_id: None,
            cwd: String::new(),
            turn_id: None,
            last_turn: None,
            next_id: 1,
            calls: HashMap::new(),
            approvals: HashMap::new(),
            questions: HashMap::new(),
            next_ui: 1,
            follow: Follow::default(),
            steers: Vec::new(),
            children: HashMap::new(),
            active: true,
            cancelled: false,
            settled: false,
            turn_tx,
            stderr: Vec::new(),
            saw_output: false,
        }
    }

    /// A turn starts on the process the last one left: what that turn knew of
    /// itself goes, what belongs to the process stays.
    fn begin_turn(&mut self, turn_tx: oneshot::Sender<TurnOutcome>) {
        self.turn_id = None;
        self.follow = Follow::default();
        self.steers.clear();
        self.active = true;
        self.cancelled = false;
        self.settled = false;
        self.turn_tx = Some(turn_tx);
        self.saw_output = false;
    }

    /// Everything waiting on the process, let go: it is gone, or about to be.
    pub(super) fn release(&mut self) {
        self.calls.clear();
        for (_, pending) in self.approvals.drain() {
            let _ = pending.tx.send(ApprovalResolution::Cancelled);
        }
        for (_, pending) in self.questions.drain() {
            let _ = pending.tx.send(QuestionReply::Cancelled);
        }
    }

    /// The thread and the turn an interrupt or a steer is addressed to.
    fn running_turn(&self) -> Option<(String, String)> {
        if !self.active || self.cancelled || self.settled {
            return None;
        }
        Some((self.thread_id.clone()?, self.turn_id.clone()?))
    }
}

impl TurnHost {
    /// Keeps a folder's skills, with Codex's own commands, in the catalog, as
    /// the Claude path keeps its menu. A bot's process keeps nothing: its
    /// persona must not see the user's skills.
    fn codex_catalog(&self, session_id: &str, cwd: &str, entries: Vec<CommandEntry>) {
        let bot = session::get(&self.store, session_id.to_string())
            .ok()
            .flatten()
            .is_some_and(|session| session.kind == "bot");
        if bot {
            return;
        }
        let skills = entries.iter().map(|entry| entry.name.clone()).collect();
        let menu = entries.into_iter().chain(codex_commands()).collect();
        let actions = crate::commands::crew_actions(offers_fast("codex"));
        self.commands().learn_for_session(session_id, "codex", cwd, Some(menu), Some(skills), actions);
    }

    pub(super) fn run_codex(
        &self,
        session: crate::session::Session,
        params: crew_protocol::TurnStart,
        history: Option<String>,
    ) -> TurnOutcome {
        let session_id = session.id.clone();
        let (tx, turn_rx) = oneshot::channel();
        let since = self.codex_arm(&session, &params.cwd, tx);
        let kept = since.is_some();
        self.watch_for_silence(&session_id);
        let carries = carries_conversation(&session);
        // Every turn: Codex keeps no system prompt Crew can set, and newer
        // catalogs override developer instructions.
        let instructions = self.persona(&session, Harness::Mcp, self.mcp().is_some(), &params.cwd);
        let files = path_list(&params, &HashSet::new());
        let text = if carries {
            crate::providers::with_files(params.text.trim(), &files)
        } else {
            crate::providers::assemble(
                String::new(),
                history.as_deref(),
                &with_attached_paths(params.text.trim(), &files),
            )
        };
        // A fresh process was given the settings on its thread; a kept one is
        // told only what moved since, so what the user's own config says of
        // the sandbox (its network access) is not reset by a turn that did not
        // change it.
        let overrides = match &since {
            Some(since) => self.applied(&session, &params.cwd).turn_overrides_since(since),
            None => Map::new(),
        };
        // A command is the whole message: its files, skills and history do not
        // go. The rest is a turn, with the skills it invokes loaded ahead.
        let start = match CodexCommand::read(&params.text, params.command.as_deref()) {
            Some(command) => Start::Command(command),
            None => {
                let skills = self.codex_skills_named(&params);
                Start::Turn(if skills.is_empty() { text_input(&text) } else { skills_input(&text, &skills) })
            }
        };
        let outcome = match self.ensure_codex(&session, &params, kept) {
            Ok(thread) => match self.codex_turn(&session_id, &thread, start, instructions.as_deref(), overrides) {
                Ok(settings_sent) => {
                    // `turn/start` carries the settings a kept process is
                    // told of; another method does not, so the next turn
                    // must still find them changed.
                    if let (Some(since), false) = (since, settings_sent) {
                        if let Some(Live::Codex(live)) = self.lock().get_mut(&session_id) {
                            live.applied = since;
                        }
                    }
                    self.block_on(turn_rx).unwrap_or(TurnOutcome::Failed("Turn channel closed".into()))
                }
                Err(_) if self.stop_requested(&session_id) => TurnOutcome::Stopped,
                Err(error) => TurnOutcome::Failed(error),
            },
            Err(outcome) => outcome,
        };
        // A steer the turn ended before reading is not lost: it waits in the
        // box, and the end of this turn hands it over as the next one.
        // A stopped turn that Codex closed itself (`turn/completed`) leaves
        // the thread idle; one it never answered is left in a state nobody
        // vouches for.
        let (unread, closed) = match self.lock().get_mut(&session_id) {
            Some(Live::Codex(live)) => {
                live.release();
                (std::mem::take(&mut live.steers), !live.cancelled)
            }
            _ => (Vec::new(), false),
        };
        for steer in unread {
            steer.put_back(&self.store, &session_id);
        }
        // Background terminals end with the process: a child that keeps it
        // keeps them too, and its next turn finds them in the tray. An
        // interrupt does not end them (the TUI has `/stop` for that), so a
        // stopped turn keeps the process too, and Esc stops only the turn.
        let clean = match outcome {
            TurnOutcome::Completed => true,
            TurnOutcome::Stopped => closed,
            TurnOutcome::Failed(_) => false,
        };
        self.park(&session, clean);
        outcome
    }

    /// Gives the turn its state on the process the last one left, when there
    /// is one alive, and otherwise on an entry of its own for the process
    /// [`TurnHost::ensure_codex`] spawns. A kept process takes the session's
    /// new settings on its `turn/start` (see [`Launch::turn_overrides`]); it
    /// is let go only when a setting was cleared, which an override cannot
    /// say. Returns what the kept process ran with, or `None` when a new one
    /// is spawned.
    fn codex_arm(&self, session: &crate::session::Session, cwd: &str, tx: oneshot::Sender<TurnOutcome>) -> Option<Launch> {
        let session_id = session.id.as_str();
        let applied = self.applied(session, cwd);
        // Asked before the lock: a process that died while idle without its
        // exit being heard (it was killed under us) is not one to write to.
        let alive = self.agents.running().iter().any(|id| id == session_id);
        let tx = {
            let mut map = self.lock();
            match map.get_mut(session_id) {
                Some(Live::Codex(live))
                    if alive
                        && live.thread_id.is_some()
                        && live.settled
                        && !live.cancelled
                        && !applied.clears_a_setting_of(&live.applied) =>
                {
                    live.begin_turn(tx);
                    let since = std::mem::replace(&mut live.applied, applied);
                    drop(map);
                    self.idle.lock().unwrap_or_else(|e| e.into_inner()).remove(session_id);
                    return Some(since);
                }
                _ => tx,
            }
        };
        self.agents.kill(session_id);
        self.lock()
            .insert(session_id.to_string(), Live::Codex(Box::new(CodexLive::new(Some(tx), applied))));
        self.idle.lock().unwrap_or_else(|e| e.into_inner()).remove(session_id);
        self.background.touch(session_id, |board| board.launch(crate::store::now_millis()));
        None
    }

    /// The process the turn runs on, with its thread open: the one a child
    /// kept, or a new `app-server` that is initialized and given its thread
    /// (`thread/start`, or `thread/resume` on the conversation a child
    /// carries on). Returns the thread's id; a failure is the turn's outcome.
    fn ensure_codex(
        &self,
        session: &crate::session::Session,
        params: &crew_protocol::TurnStart,
        kept: bool,
    ) -> Result<String, TurnOutcome> {
        let session_id = session.id.as_str();
        if kept {
            let thread = match self.lock().get(session_id) {
                Some(Live::Codex(live)) => live.thread_id.clone(),
                _ => None,
            };
            return thread.ok_or_else(|| TurnOutcome::Failed("Codex has no thread open.".into()));
        }
        // A stop that came before the CLI was there to take it.
        if self.stop_requested(session_id) {
            return Err(TurnOutcome::Stopped);
        }
        let path = self.resolve_bin("codex").map_err(TurnOutcome::Failed)?;
        let mcp = self.mcp();
        // Minted once and used twice: the agent's own shell gets it, and so
        // does the MCP server codex starts for it. A second mint would retire
        // the first, and this process lives across turns, so nothing mints
        // again until it is replaced.
        let env = self.agent_env(session_id);
        let thread = CodexThread {
            cwd: params.cwd.clone(),
            resume: conversation_to_resume(session),
            model: Some(session.model.clone()).filter(|m| !m.is_empty()),
            effort: Some(session.effort.clone()).filter(|e| !e.is_empty()),
            service_tier: Some(session.service_tier.clone()).filter(|tier| !tier.is_empty()),
            autonomy: self.autonomy(session),
            mcp,
            mcp_env: env.clone().into_iter().collect(),
        };
        self.agents
            .spawn(session_id.to_string(), path, vec!["app-server".into()], params.cwd.clone(), Some(env))
            .map_err(TurnOutcome::Failed)?;
        match self.codex_open(session_id, &thread) {
            Ok(thread_id) => {
                self.watch_terminals(session_id);
                Ok(thread_id)
            }
            Err(_) if self.stop_requested(session_id) => Err(TurnOutcome::Stopped),
            Err(error) => Err(TurnOutcome::Failed(error)),
        }
    }

    /// The handshake and the thread. Returns the thread's id.
    fn codex_open(&self, session_id: &str, thread: &CodexThread) -> Result<String, String> {
        self.codex_call(session_id, "initialize", initialize_params(), INIT_TIMEOUT)
            .map_err(|error| self.codex_failure(session_id, "Codex did not start", &error))?;
        self.codex_notify(session_id, "initialized", json!({}))?;
        let (method, params) = thread_request(thread);
        let opened = self
            .codex_call(session_id, method, params, OPEN_TIMEOUT)
            .map_err(|error| self.codex_failure(session_id, "Codex could not open its thread", &error))?;
        let thread_id = thread_id(&opened).ok_or_else(|| "Codex opened no thread.".to_string())?;
        if let Some(Live::Codex(live)) = self.lock().get_mut(session_id) {
            live.thread_id = Some(thread_id.clone());
            live.cwd = thread.cwd.clone();
        }
        self.codex_read_skills(session_id, &thread.cwd);
        self.codex_read_mcp(session_id);
        Ok(thread_id)
    }

    /// Asks the app server for the skills of `cwd` and hands them to the
    /// catalog. It runs on a thread of its own: the turn that is starting does
    /// not wait for it, and an answer that comes after the process is gone is
    /// dropped by the call itself.
    fn codex_read_skills(&self, session_id: &str, cwd: &str) {
        let host = self.clone();
        let session_id = session_id.to_string();
        let cwd = cwd.to_string();
        thread::spawn(move || {
            match host.codex_call(&session_id, "skills/list", skills_list_params(&cwd), CATALOG_TIMEOUT) {
                Ok(listed) => host.codex_catalog(&session_id, &cwd, codex_skills(&listed)),
                // Its commands are Crew's own and need no answer from Codex:
                // a folder whose skills cannot be read still lists them. What
                // an earlier read found stands, rather than being emptied.
                Err(_) if !host.commands().holds("codex", &cwd) => host.codex_catalog(&session_id, &cwd, Vec::new()),
                Err(_) => {}
            }
        });
    }

    /// Reads the folder's skills past Codex's cache and has it start its MCP
    /// servers again, for what changed on disk since its thread opened. The
    /// answer to `skills/list` is the catalog's; the servers' answer is only
    /// that they were asked.
    pub(super) fn codex_reload(&self, session_id: &str) -> Result<(), String> {
        let cwd = match self.lock().get(session_id) {
            Some(Live::Codex(live)) if !live.cwd.is_empty() => live.cwd.clone(),
            _ => return Err("Codex is not running.".into()),
        };
        let listed = self.codex_call(session_id, "skills/list", skills_reload_params(&cwd), CATALOG_TIMEOUT)?;
        self.codex_catalog(session_id, &cwd, codex_skills(&listed));
        self.codex_call(session_id, "config/mcpServer/reload", Value::Null, CATALOG_TIMEOUT)?;
        Ok(())
    }

    /// Reads the thread's MCP servers on a thread of its own and keeps them.
    /// Called when the thread opens and on each startup notice that settles a
    /// server; a burst of those is a few reads, not one each.
    fn codex_read_mcp(&self, session_id: &str) {
        if !self.mcp_status.claim(session_id, true) {
            return;
        }
        let host = self.clone();
        let session_id = session_id.to_string();
        thread::spawn(move || loop {
            let thread_id = match host.lock().get(&session_id) {
                Some(Live::Codex(live)) => live.thread_id.clone(),
                _ => None,
            };
            if let Some(thread_id) = thread_id {
                if let Ok(answer) = host.codex_call(&session_id, "mcpServerStatus/list", mcp_list_params(&thread_id), CATALOG_TIMEOUT) {
                    host.mcp_status.learn(&session_id, mcp_servers(&answer));
                }
            }
            if !host.mcp_status.release(&session_id) {
                break;
            }
        });
    }

    /// Has Codex start a server's login, and answers the page the user signs
    /// in on. Codex waits for the redirect itself and keeps the token; it says
    /// when that is over in `mcpServer/oauthLogin/completed`.
    pub(super) fn codex_mcp_login(&self, session_id: &str, name: &str) -> Result<String, String> {
        let thread_id = match self.lock().get(session_id) {
            Some(Live::Codex(live)) => live.thread_id.clone(),
            _ => None,
        }
        .ok_or("Codex is not running. Send a message first, then sign in.")?;
        let started = self.codex_call(session_id, "mcpServer/oauth/login", mcp_login_params(name, Some(&thread_id)), LOGIN_TIMEOUT)?;
        mcp_login_url(&started).ok_or_else(|| "Codex gave no page to sign in on.".to_string())
    }

    /// Has Codex start its MCP servers again, and reads how they stand.
    pub(super) fn codex_mcp_reconnect(&self, session_id: &str) -> Result<(), String> {
        self.codex_call(session_id, "config/mcpServer/reload", Value::Null, CATALOG_TIMEOUT)?;
        self.codex_read_mcp(session_id);
        Ok(())
    }

    /// The server's startup, or its login, as a notification says it. Both are
    /// the process's, not a turn's. A login that went through has Codex start
    /// the servers again, to connect with the token; that is asked from a
    /// thread of its own, since this runs where the answers are read.
    fn codex_mcp_notice(&self, session_id: &str, method: &str, params: &Value) {
        if method == "mcpServer/startupStatus/updated" {
            let Some((name, state, error)) = mcp_startup(params) else {
                return;
            };
            self.mcp_status.set_state(session_id, &name, state, error);
            if state != McpState::Pending {
                self.codex_read_mcp(session_id);
            }
            return;
        }
        let Some(name) = params.get("name").and_then(Value::as_str) else {
            return;
        };
        if params.get("success").and_then(Value::as_bool) != Some(true) {
            let error = params.get("error").and_then(Value::as_str).unwrap_or("The sign-in did not finish.");
            self.mcp_status.set_state(session_id, name, McpState::NeedsAuth, Some(error.to_string()));
            return;
        }
        let host = self.clone();
        let session_id = session_id.to_string();
        thread::spawn(move || {
            let _ = host.codex_mcp_reconnect(&session_id);
        });
    }

    /// The turn itself, on an open thread. Returns once the turn runs; its end
    /// arrives as `turn/completed`. A command that Codex answers at once
    /// (`/goal`, `/mcp`) is a turn that ends here, with its answer as a note.
    /// Says whether the call was a `turn/start`, which carries `overrides`.
    fn codex_turn(
        &self,
        session_id: &str,
        thread_id: &str,
        start: Start,
        instructions: Option<&str>,
        overrides: Map<String, Value>,
    ) -> Result<bool, String> {
        self.transcripts.apply(
            session_id,
            HarnessEvent::SessionProviderBound {
                provider_session_id: thread_id.to_string(),
            },
        );
        self.transcripts.apply(session_id, HarnessEvent::SessionStarted {});
        if self.stop_requested(session_id) {
            return Err("cancelled".into());
        }
        let (method, params, command) = match start {
            Start::Turn(input) => {
                let mut params = turn_start_input(thread_id, input, instructions);
                if let Value::Object(params) = &mut params {
                    params.extend(overrides);
                }
                ("turn/start", params, None)
            }
            Start::Command(command) => {
                let (method, params) = command.request(thread_id);
                (method, params, Some(command))
            }
        };
        let started = self
            .codex_call(session_id, method, params, OPEN_TIMEOUT)
            .map_err(|error| self.codex_failure(session_id, &format!("Codex did not run {method}"), &error))?;
        if let Some(command) = command.as_ref().filter(|command| !command.runs_as_turn()) {
            self.transcripts.apply(session_id, HarnessEvent::SessionNote { message: command.note(&started) });
            self.transcripts.apply(session_id, HarnessEvent::TurnCompleted { usage: None });
            self.signal(session_id, TurnOutcome::Completed);
            return Ok(false);
        }
        // A compaction answers with nothing: its turn is named by the
        // `turn/started` that follows, and ended by its `turn/completed`.
        if let Some(turn) = turn_id(&started) {
            let mut map = self.lock();
            if let Some(Live::Codex(live)) = map.get_mut(session_id) {
                // `turn/completed` may already have come and gone.
                if live.active && !live.settled && live.turn_id.is_none() {
                    live.turn_id = Some(turn);
                }
            }
        } else if command.is_none() {
            return Err("Codex started no turn.".into());
        }
        Ok(command.is_none())
    }

    /// The skills a message invokes, each with the file the catalog knows it
    /// by. Codex loads a skill from its file, so one the catalog has not read
    /// (yet) goes by its name in the text alone.
    fn codex_skills_named(&self, params: &crew_protocol::TurnStart) -> Vec<(String, Option<String>)> {
        let names = params.skills.as_deref().unwrap_or_default();
        if names.is_empty() {
            return Vec::new();
        }
        let known = self.commands.catalog("codex", &params.cwd, Vec::new(), crate::store::now_millis());
        names
            .iter()
            .map(|name| {
                let path = known.entries.iter().find(|entry| &entry.name == name).and_then(|entry| entry.path.clone());
                (name.clone(), path)
            })
            .collect()
    }

    /// While the process lives, list the thread's background terminals
    /// whenever a command is running: a command that outlives its call is
    /// one, and the tray lists it. A child's process outlives its turns, and
    /// so do its terminals, so this goes on between them. Nothing is asked
    /// while no command runs.
    fn watch_terminals(&self, session_id: &str) {
        let host = self.clone();
        let session_id = session_id.to_string();
        let epoch = match self.lock().get(&session_id) {
            Some(Live::Codex(live)) => live.epoch,
            _ => return,
        };
        thread::spawn(move || loop {
            thread::sleep(TERMINAL_POLL);
            // Its own process only: a later one for the same session has a
            // watcher of its own.
            let thread_id = match host.lock().get(&session_id) {
                Some(Live::Codex(live)) if live.epoch == epoch && !live.cancelled => live.thread_id.clone(),
                _ => return,
            };
            let Some(thread_id) = thread_id else {
                continue;
            };
            if !host.background.read(&session_id, |board| board.codex_running()).unwrap_or(false) {
                continue;
            }
            let Ok(listed) = host.codex_call(
                &session_id,
                "thread/backgroundTerminals/list",
                json!({ "threadId": thread_id }),
                STEER_TIMEOUT,
            ) else {
                continue;
            };
            let terminals = listed.get("data").and_then(Value::as_array).cloned().unwrap_or_default();
            let now = crate::store::now_millis();
            host.background.touch(&session_id, |board| board.codex_listed(&terminals, now));
        });
    }

    /// Stop one background terminal of the running thread.
    pub(super) fn codex_terminate(&self, session_id: &str, process_id: &str) -> Result<(), String> {
        let thread_id = match self.lock().get(session_id) {
            Some(Live::Codex(live)) => live.thread_id.clone(),
            _ => None,
        }
        .ok_or_else(|| "Codex is not running.".to_string())?;
        let answer = self.codex_call(
            session_id,
            "thread/backgroundTerminals/terminate",
            json!({ "threadId": thread_id, "processId": process_id }),
            STEER_TIMEOUT,
        )?;
        if answer.get("terminated").and_then(Value::as_bool) == Some(true) {
            Ok(())
        } else {
            Err("Codex says it is not running.".into())
        }
    }

    /// An error from the handshake, with what Codex said on stderr.
    fn codex_failure(&self, session_id: &str, head: &str, error: &str) -> String {
        let stderr = match self.lock().get(session_id) {
            Some(Live::Codex(live)) => live.stderr.join("\n"),
            _ => String::new(),
        };
        let mut message = format!("{head}: {error}");
        if !stderr.trim().is_empty() {
            message.push('\n');
            message.push_str(stderr.trim());
        }
        message
    }

    /// Send a request and wait for its answer. Safe from any thread: the
    /// answer arrives on the agent's reader, which never waits on this.
    fn codex_call(&self, session_id: &str, method: &str, params: Value, timeout: Duration) -> Result<Value, String> {
        let (tx, rx) = mpsc::channel();
        let id = {
            let mut map = self.lock();
            let Some(Live::Codex(live)) = map.get_mut(session_id) else {
                return Err("Codex is not running.".into());
            };
            let id = live.next_id;
            live.next_id += 1;
            live.calls.insert(id, tx);
            id
        };
        let forget = || {
            if let Some(Live::Codex(live)) = self.lock().get_mut(session_id) {
                live.calls.remove(&id);
            }
        };
        let line = json!({ "id": id, "method": method, "params": params }).to_string();
        if let Err(error) = self.agents.write(session_id, &line) {
            forget();
            return Err(error);
        }
        match rx.recv_timeout(timeout) {
            Ok(result) => result,
            Err(RecvTimeoutError::Timeout) => {
                forget();
                Err(format!("no answer to {method} in {}s", timeout.as_secs()))
            }
            Err(RecvTimeoutError::Disconnected) => Err(format!("it stopped before answering {method}")),
        }
    }

    /// A request whose answer nobody waits for.
    fn codex_send(&self, session_id: &str, method: &str, params: Value) -> Result<(), String> {
        let id = {
            let mut map = self.lock();
            let Some(Live::Codex(live)) = map.get_mut(session_id) else {
                return Err("Codex is not running.".into());
            };
            let id = live.next_id;
            live.next_id += 1;
            id
        };
        self.agents
            .write(session_id, &json!({ "id": id, "method": method, "params": params }).to_string())
    }

    fn codex_notify(&self, session_id: &str, method: &str, params: Value) -> Result<(), String> {
        self.agents
            .write(session_id, &json!({ "method": method, "params": params }).to_string())
    }

    fn codex_reply(&self, session_id: &str, rpc_id: &Value, result: Value) {
        let _ = self
            .agents
            .write(session_id, &json!({ "id": rpc_id, "result": result }).to_string());
    }

    fn codex_reply_error(&self, session_id: &str, rpc_id: &Value, error: Value) {
        let _ = self
            .agents
            .write(session_id, &json!({ "id": rpc_id, "error": error }).to_string());
    }

    /// Stop a Codex turn: `turn/interrupt`, and the turn ends when Codex says
    /// it did, or after [`INTERRUPT_GRACE`] whatever it says. The turn's end
    /// kills the process either way. Returns false when there was no turn to
    /// interrupt, and the caller settles it at once.
    pub(super) fn codex_interrupt(&self, session_id: &str) -> bool {
        let (target, epoch) = {
            let mut map = self.lock();
            let Some(Live::Codex(live)) = map.get_mut(session_id) else {
                return false;
            };
            let target = live.running_turn();
            live.cancelled = true;
            // Codex resolves what it asked once the turn is interrupted; the
            // cards close now.
            for (_, pending) in live.approvals.drain() {
                let _ = pending.tx.send(ApprovalResolution::Cancelled);
            }
            for (_, pending) in live.questions.drain() {
                let _ = pending.tx.send(QuestionReply::Cancelled);
            }
            (target, live.epoch)
        };
        let Some((thread, turn)) = target else {
            return false;
        };
        if self.codex_send(session_id, "turn/interrupt", interrupt_params(&thread, &turn)).is_err() {
            return false;
        }
        let host = self.clone();
        let id = session_id.to_string();
        self.after(INTERRUPT_GRACE, move || {
            // Only the turn it was armed for: the process it was armed on may
            // be gone by now, and a later turn on the session is not its to end.
            let open = matches!(
                host.lock().get(&id),
                Some(Live::Codex(live)) if live.epoch == epoch && !live.settled && live.turn_id.as_deref() == Some(turn.as_str())
            );
            if open {
                host.signal(&id, TurnOutcome::Stopped);
            }
        });
        true
    }

    /// Stop one agent the model spawned: `turn/interrupt` on its thread and
    /// the turn it runs. Its thread stays, and its parent's turn goes on.
    pub(super) fn codex_interrupt_child(&self, session_id: &str, thread_id: &str) -> Result<(), String> {
        let turn = match self.lock().get(session_id) {
            Some(Live::Codex(live)) => live.children.get(thread_id).and_then(|child| child.turn.clone()),
            _ => return Err("Codex is not running.".into()),
        }
        .ok_or_else(|| "That agent is not running a turn.".to_string())?;
        self.codex_call(session_id, "turn/interrupt", interrupt_params(thread_id, &turn), STEER_TIMEOUT)?;
        Ok(())
    }

    /// Write a message into a Codex turn that is running, with `turn/steer`.
    /// Refused when there is none to take it — not started, over, or Codex
    /// says so — so the caller can queue it instead.
    pub(super) fn codex_steer(
        &self,
        session_id: &str,
        text: &str,
        from: crew_protocol::BotRef,
        letter: Option<String>,
        files: Vec<crew_protocol::AttachedFile>,
        rest: Vec<super::Extra>,
    ) -> Result<(), String> {
        let typed = session::get(&self.store, session_id.to_string())
            .ok()
            .flatten()
            .as_ref()
            .and_then(driven)
            .is_some_and(|drive| typed_by_user(drive, &from));
        // Files go in the text, as a turn's do.
        let paths: Vec<String> = files.iter().map(|file| file.path.clone()).collect();
        let sent = crate::providers::with_files(self.steer_text_all(session_id, &from, text, &rest).trim(), &paths);
        let (thread, turn) = {
            let mut map = self.lock();
            let Some(Live::Codex(live)) = map.get_mut(session_id) else {
                return Err("No Codex turn is running to take it.".into());
            };
            let Some(target) = live.running_turn() else {
                return Err("No Codex turn is running to take it.".into());
            };
            // In before the request: its echo can beat the answer.
            live.steers.push(Steer { sent: sent.clone(), text: text.to_string(), from, letter, files, typed, rest });
            target
        };
        match self.codex_call(session_id, "turn/steer", steer_params(&thread, &turn, &sent), STEER_TIMEOUT) {
            Ok(_) => Ok(()),
            Err(error) => {
                if let Some(Live::Codex(live)) = self.lock().get_mut(session_id) {
                    live.steers.retain(|steer| steer.sent != sent);
                }
                Err(error)
            }
        }
    }

    pub(super) fn codex_respond(&self, session_id: &str, request_id: u64, decision: ApprovalDecision) -> Option<()> {
        let mut map = self.lock();
        let Some(Live::Codex(live)) = map.get_mut(session_id) else {
            return None;
        };
        let pending = live.approvals.remove(&request_id)?;
        let _ = pending.tx.send(match decision {
            ApprovalDecision::Allow => ApprovalResolution::Allow,
            ApprovalDecision::Always => ApprovalResolution::Always,
            ApprovalDecision::Deny => ApprovalResolution::Deny,
        });
        Some(())
    }

    pub(super) fn codex_answer(&self, session_id: &str, request_id: u64, answers: Option<super::Answers>) -> Option<()> {
        let mut map = self.lock();
        let Some(Live::Codex(live)) = map.get_mut(session_id) else {
            return None;
        };
        let pending = live.questions.remove(&request_id)?;
        let _ = pending.tx.send(match answers {
            Some(answers) => QuestionReply::Answers(answers),
            None => QuestionReply::Dismiss,
        });
        Some(())
    }

    pub(crate) fn handle_codex_line(&self, session_id: &str, line: &str) {
        let Ok(message) = serde_json::from_str::<Value>(line) else {
            return;
        };
        let method = message.get("method").and_then(Value::as_str);
        let id = message.get("id").filter(|id| !id.is_null());
        let params = message.get("params").cloned().unwrap_or(Value::Null);
        match (method, id) {
            (None, Some(id)) => self.codex_response(session_id, id, &message),
            (Some(method), Some(id)) => self.codex_request(session_id, id.clone(), method, params),
            (Some(method), None) => self.codex_notification(session_id, method, &params),
            _ => {}
        }
    }

    fn codex_response(&self, session_id: &str, id: &Value, message: &Value) {
        let Some(id) = id.as_u64() else {
            return;
        };
        let waiter = match self.lock().get_mut(session_id) {
            Some(Live::Codex(live)) => live.calls.remove(&id),
            _ => None,
        };
        let Some(waiter) = waiter else {
            return;
        };
        let _ = waiter.send(match message.get("error") {
            Some(error) if !error.is_null() => Err(rpc_error_message(error)),
            _ => Ok(message.get("result").cloned().unwrap_or(Value::Null)),
        });
    }

    fn codex_request(&self, session_id: &str, rpc_id: Value, method: &str, params: Value) {
        let (ask, cancelled, who) = {
            let map = self.lock();
            let Some(Live::Codex(live)) = map.get(session_id) else {
                return;
            };
            // An agent the model spawned asks on the parent's connection, and
            // it is the agent's item the request names. The answer goes back
            // under the request's own id, whoever asked.
            let thread = params.get("threadId").and_then(Value::as_str);
            let child = thread
                .filter(|thread| live.thread_id.as_deref().is_some_and(|mine| mine != *thread))
                .map(|thread| live.children.get(thread));
            let items = match child {
                Some(Some(child)) => &child.follow.items,
                _ => &live.follow.items,
            };
            let who = child.map(|child| child.map_or_else(|| "Subagent".to_string(), Child::who));
            (classify_request(method, &params, items), live.cancelled || live.settled, who)
        };
        let ask = match (ask, &who) {
            (CodexAsk::Approval { kind, name, title, input }, Some(who)) => {
                CodexAsk::Approval { kind, name, title: format!("{who}: {title}"), input }
            }
            (ask, _) => ask,
        };
        match ask {
            CodexAsk::Reply(result) => self.codex_reply(session_id, &rpc_id, result),
            CodexAsk::Unsupported => self.codex_reply_error(session_id, &rpc_id, unsupported_error(method)),
            CodexAsk::Approval { kind, .. } if cancelled => {
                self.codex_reply(session_id, &rpc_id, approval_response(kind, ApprovalDecision::Deny, &params))
            }
            CodexAsk::Questions(questions) if cancelled || questions.is_empty() => {
                self.codex_reply(session_id, &rpc_id, questions_response(&questions, None))
            }
            CodexAsk::Approval { kind, name, title, input } => {
                let host = self.clone();
                let session_id = session_id.to_string();
                thread::spawn(move || host.codex_approval_wait(&session_id, rpc_id, kind, name, title, input, params));
            }
            CodexAsk::Questions(questions) => {
                let host = self.clone();
                let session_id = session_id.to_string();
                thread::spawn(move || host.codex_question_wait(&session_id, rpc_id, questions, who));
            }
        }
    }

    #[allow(clippy::too_many_arguments)]
    fn codex_approval_wait(
        &self,
        session_id: &str,
        rpc_id: Value,
        kind: ApprovalKind,
        name: String,
        title: String,
        input: Value,
        params: Value,
    ) {
        let (tx, rx) = mpsc::channel();
        let ui_id = {
            let mut map = self.lock();
            let Some(Live::Codex(live)) = map.get_mut(session_id) else {
                return;
            };
            let ui_id = live.next_ui;
            live.next_ui += 1;
            live.approvals.insert(ui_id, Pending { rpc_id: rpc_id.clone(), tx });
            ui_id
        };
        self.transcripts.set_status(session_id, "needs-input", None);
        let asked = json!({
            "request_id": ui_id,
            "kind": "approval",
            "tool": name,
            "title": title,
            "input": input,
        });
        self.transcripts.apply(
            session_id,
            HarnessEvent::ApprovalRequested {
                request_id: ui_id,
                name,
                title,
                input: Some(input),
            },
        );
        self.child_asks(session_id, asked);
        let decision = rx.recv().unwrap_or(ApprovalResolution::Cancelled);
        self.transcripts.apply(
            session_id,
            HarnessEvent::ApprovalResolved {
                request_id: ui_id,
                decision: decision.clone(),
            },
        );
        let decided = match decision {
            ApprovalResolution::Cancelled => return,
            ApprovalResolution::Allow => ApprovalDecision::Allow,
            ApprovalResolution::Always => ApprovalDecision::Always,
            ApprovalResolution::Deny => ApprovalDecision::Deny,
        };
        self.transcripts.set_status(session_id, "working", None);
        self.codex_reply(session_id, &rpc_id, approval_response(kind, decided, &params));
    }

    /// `who` is the agent that asks, when it is not the one Crew opened: its
    /// name leads each question's header, and the answer is keyed as ever.
    fn codex_question_wait(
        &self,
        session_id: &str,
        rpc_id: Value,
        questions: Vec<(String, crew_protocol::Question)>,
        who: Option<String>,
    ) {
        let (tx, rx) = mpsc::channel();
        let ui_id = {
            let mut map = self.lock();
            let Some(Live::Codex(live)) = map.get_mut(session_id) else {
                return;
            };
            let ui_id = live.next_ui;
            live.next_ui += 1;
            live.questions.insert(ui_id, Pending { rpc_id: rpc_id.clone(), tx });
            ui_id
        };
        let shown: Vec<crew_protocol::Question> = questions
            .iter()
            .map(|(_, question)| {
                let mut question = question.clone();
                if let Some(who) = &who {
                    question.header = format!("{who}: {}", question.header);
                }
                question
            })
            .collect();
        self.transcripts.set_status(session_id, "needs-input", None);
        let asked = json!({ "request_id": ui_id, "kind": "question", "questions": shown });
        self.transcripts.apply(
            session_id,
            HarnessEvent::QuestionRequested {
                request_id: ui_id,
                questions: shown,
            },
        );
        self.child_asks(session_id, asked);
        let reply = rx.recv().unwrap_or(QuestionReply::Cancelled);
        let answers = match reply {
            QuestionReply::Cancelled => {
                self.transcripts.apply(
                    session_id,
                    HarnessEvent::QuestionResolved {
                        request_id: ui_id,
                        answers: None,
                    },
                );
                return;
            }
            QuestionReply::Dismiss => None,
            QuestionReply::Answers(answers) => Some(answers),
        };
        self.transcripts.apply(
            session_id,
            HarnessEvent::QuestionResolved {
                request_id: ui_id,
                answers: answers.clone(),
            },
        );
        self.transcripts.set_status(session_id, "working", None);
        self.codex_reply(session_id, &rpc_id, questions_response(&questions, answers.as_ref()));
    }

    /// How full the thread is: what its newest model response held (`last`,
    /// never `total`, which adds up every response of the thread) over the
    /// model's window. Codex does not say where it compacts by itself.
    fn codex_context(&self, session_id: &str, params: &Value) {
        let Some((used, window)) = token_reading(params) else {
            return;
        };
        self.publish_context(session_id, |_| Some(ContextReading { used, window, auto_compact_at: None, stale: None }));
    }

    /// Applies what a child's notifications came to: its entry on the board,
    /// and its call's steps and state in the transcript.
    fn codex_children_apply(&self, session_id: &str, work: ChildWork) {
        if !work.board.is_empty() {
            let now = crate::store::now_millis();
            self.background.touch(session_id, |board| {
                let mut changed = false;
                for change in &work.board {
                    changed |= match change {
                        ChildBoard::Spawned { thread, call, label, nickname, model } => {
                            board.codex_child(thread, call, label, nickname.as_deref(), model.as_deref(), now)
                        }
                        ChildBoard::State(thread, state) => board.codex_child_state(thread, *state, now),
                        ChildBoard::Usage { thread, tokens, window } => board.codex_child_usage(thread, *tokens, *window),
                        ChildBoard::Activity(thread, activity) => board.codex_child_activity(thread, activity),
                    };
                }
                changed
            });
        }
        for event in work.events {
            self.transcripts.apply(session_id, event);
        }
    }

    fn codex_notification(&self, session_id: &str, method: &str, params: &Value) {
        // The skills are the process's, not the turn's: Codex says they moved
        // whatever the turn is doing, so they are read again here, before the
        // turn's own checks can drop it.
        if method == "skills/changed" {
            let cwd = match self.lock().get(session_id) {
                Some(Live::Codex(live)) => live.cwd.clone(),
                _ => return,
            };
            if !cwd.is_empty() {
                self.codex_read_skills(session_id, &cwd);
            }
            return;
        }
        if matches!(method, "mcpServer/startupStatus/updated" | "mcpServer/oauthLogin/completed") {
            self.codex_mcp_notice(session_id, method, params);
            return;
        }
        let mut events = Vec::new();
        let mut outcome = None;
        // A command item for the tray, read out of the lock.
        let mut command: Option<(Map<String, Value>, bool)> = None;
        let mut work = ChildWork::default();
        {
            let mut map = self.lock();
            let Some(Live::Codex(live)) = map.get_mut(session_id) else {
                return;
            };
            // One process drives the thread Crew opened, and one turn at a
            // time on it. Another thread is an agent the model spawned: what
            // it says is its call's, never this turn's. Codex settling a
            // request is the exception, since it names the request, whoever
            // asked.
            let thread = params.get("threadId").and_then(Value::as_str);
            let other = thread.zip(live.thread_id.as_deref()).filter(|(said, mine)| said != mine).map(|(said, _)| said);
            if method == "thread/started" {
                child_started(live, params);
                return;
            }
            if let Some(other) = other.filter(|_| method != "serverRequest/resolved") {
                // Stopped, the process is about to go: nothing more is shown.
                if !live.cancelled {
                    child_note(live, other, method, params, &mut work);
                }
                drop(map);
                self.codex_children_apply(session_id, work);
                return;
            }
            // The thread's, not the turn's: it names the turn it was read in,
            // which may be over, and it may come with none running.
            if method == "thread/tokenUsage/updated" {
                drop(map);
                self.codex_context(session_id, params);
                return;
            }
            let turn = params.get("turnId").or_else(|| params.pointer("/turn/id")).and_then(Value::as_str);
            if let Some(turn) = turn {
                // Until the current turn's id is known, only the turn that
                // just ended is known not to be it.
                let stale = live.last_turn.as_deref() == Some(turn)
                    || live.turn_id.as_deref().is_some_and(|running| running != turn);
                if stale {
                    return;
                }
            }
            match method {
                "turn/completed" => {
                    let (turn, end) = turn_end(params);
                    if let (Some(turn), Some(running)) = (turn.as_deref(), live.turn_id.as_deref()) {
                        if turn != running {
                            return;
                        }
                    }
                    if live.settled {
                        return;
                    }
                    live.last_turn = live.turn_id.take().or(turn);
                    if live.cancelled {
                        // Closed by Codex: the stop is over, and the thread is
                        // the next turn's to run on.
                        live.cancelled = false;
                        outcome = Some(TurnOutcome::Stopped);
                    } else {
                        live.follow.message = None;
                        events.push(HarnessEvent::MessageCompleted {});
                        events.push(HarnessEvent::TurnCompleted { usage: None });
                        outcome = Some(match end {
                            TurnEnd::Completed => TurnOutcome::Completed,
                            TurnEnd::Interrupted => TurnOutcome::Stopped,
                            TurnEnd::Failed(message) => TurnOutcome::Failed(message),
                        });
                    }
                }
                "serverRequest/resolved" => {
                    // Codex settled it itself (an interrupt, a timeout): the
                    // card closes, and nobody answers it any more.
                    let Some(rpc_id) = params.get("requestId") else {
                        return;
                    };
                    let approval = live.approvals.iter().find(|(_, p)| &p.rpc_id == rpc_id).map(|(id, _)| *id);
                    if let Some(pending) = approval.and_then(|id| live.approvals.remove(&id)) {
                        let _ = pending.tx.send(ApprovalResolution::Cancelled);
                    }
                    let question = live.questions.iter().find(|(_, p)| &p.rpc_id == rpc_id).map(|(id, _)| *id);
                    if let Some(pending) = question.and_then(|id| live.questions.remove(&id)) {
                        let _ = pending.tx.send(QuestionReply::Cancelled);
                    }
                }
                _ if live.cancelled || live.settled => return,
                "turn/started" => {
                    if live.active && live.turn_id.is_none() {
                        live.turn_id = params.pointer("/turn/id").and_then(Value::as_str).map(str::to_string);
                        self.confirm_carried(session_id);
                    }
                }
                "item/agentMessage/delta" => {
                    let (Some(item), Some(delta)) = (
                        params.get("itemId").and_then(Value::as_str),
                        params.get("delta").and_then(Value::as_str),
                    ) else {
                        return;
                    };
                    message_delta(&mut live.follow, item, delta, &mut events);
                }
                "item/started" | "item/completed" => {
                    let Some(item) = params.get("item").and_then(Value::as_object) else {
                        return;
                    };
                    let completed = method == "item/completed";
                    codex_item(&mut live.follow, Some(&mut live.steers), item, completed, &mut events);
                    // A spawn that completed names the threads it started: what
                    // they said so far is its steps from here on.
                    if completed {
                        let mine = live.thread_id.clone().unwrap_or_default();
                        spawn_named(live, item, &mine, &mut work);
                    }
                    // Every item: one starting says the model went on from a
                    // command still running, which puts that one in the background.
                    command = Some((item.clone(), method == "item/completed"));
                }
                "item/commandExecution/outputDelta" => {
                    if let (Some(item), Some(delta)) = (
                        params.get("itemId").and_then(Value::as_str),
                        params.get("delta").and_then(Value::as_str),
                    ) {
                        self.background.touch(session_id, |board| {
                            board.codex_output(item, delta);
                            false
                        });
                    }
                }
                "turn/plan/updated" => {
                    let Some(detail) = plan_detail(params) else {
                        return;
                    };
                    let turn = params.get("turnId").and_then(Value::as_str).unwrap_or_default();
                    let call_id = format!("plan-{turn}");
                    if live.follow.seen_tools.insert(call_id.clone()) {
                        events.push(HarnessEvent::ToolStarted {
                            call_id,
                            name: "todo".into(),
                            title: "Todos".into(),
                            detail: Some(detail),
                        });
                    } else {
                        events.push(HarnessEvent::ToolUpdated {
                            call_id,
                            title: None,
                            status: None,
                            detail: Some(detail),
                        });
                    }
                }
                "error" => {
                    // A retry says so; a final one ends the turn with its own
                    // `turn/completed`.
                    if params.get("willRetry").and_then(Value::as_bool) == Some(true) {
                        if let Some(message) = params.pointer("/error/message").and_then(Value::as_str) {
                            events.push(HarnessEvent::SessionNote { message: message.to_string() });
                        }
                    }
                }
                _ => {}
            }
        }
        if let Some((item, completed)) = command {
            let now = crate::store::now_millis();
            self.background.touch(session_id, |board| board.codex_item(&item, completed, now));
        }
        for event in events {
            // A steer the turn has read: its letter is delivered.
            if let HarnessEvent::UserMessage { letter_id: Some(id), .. } = &event {
                let _ = mailbox::delivered(&self.store, std::slice::from_ref(id));
            }
            self.transcripts.apply(session_id, event);
        }
        // After the parent's own: the call a child's steps nest under is
        // among them.
        self.codex_children_apply(session_id, work);
        if let Some(outcome) = outcome {
            self.signal(session_id, outcome);
        }
    }
}

/// The next piece of the agent message being written. A piece of another
/// message closes the one before.
fn message_delta(follow: &mut Follow, item: &str, delta: &str, events: &mut Vec<HarnessEvent>) {
    if follow.message.as_ref().is_some_and(|(open, _)| open != item) {
        events.push(HarnessEvent::MessageCompleted {});
        follow.message = None;
    }
    let (_, written) = follow.message.get_or_insert_with(|| (item.to_string(), String::new()));
    written.push_str(delta);
    if !delta.is_empty() {
        events.push(HarnessEvent::MessageDelta { text: delta.to_string() });
    }
}

/// How full a thread is, from `thread/tokenUsage/updated`: what its newest
/// response held, and the window of its model when the reading names one.
fn token_reading(params: &Value) -> Option<(u64, Option<u64>)> {
    let usage = params.get("tokenUsage")?;
    let used = usage.pointer("/last/totalTokens").and_then(Value::as_u64)?;
    let window = usage.get("modelContextWindow").and_then(Value::as_u64).filter(|window| *window > 0);
    Some((used, window))
}

/// An item starting or ending: text, a steer's echo, or a tool row. `steers`
/// are the ones Codex has not echoed yet; an agent's thread takes none.
fn codex_item(
    follow: &mut Follow,
    steers: Option<&mut Vec<Steer>>,
    item: &Map<String, Value>,
    completed: bool,
    events: &mut Vec<HarnessEvent>,
) {
    let kind = string_field(Some(item), "type").unwrap_or_default();
    let id = string_field(Some(item), "id").unwrap_or_default();
    match kind.as_str() {
        "agentMessage" => {
            if follow.message.as_ref().is_some_and(|(open, _)| *open != id) {
                events.push(HarnessEvent::MessageCompleted {});
                follow.message = None;
            }
            if !completed {
                return;
            }
            // The deltas usually said it all; what they missed goes in now.
            let text = item.get("text").and_then(Value::as_str).unwrap_or_default();
            let written = follow.message.take().map(|(_, written)| written).unwrap_or_default();
            let extra = match text.strip_prefix(written.as_str()) {
                Some(rest) => rest,
                None if written.is_empty() => text,
                None => "",
            };
            if !extra.is_empty() {
                events.push(HarnessEvent::MessageDelta { text: extra.to_string() });
            }
            events.push(HarnessEvent::MessageCompleted {});
        }
        "userMessage" => {
            // A steer Codex has just taken in: it goes in the transcript here,
            // where the model read it.
            let (Some(steers), Some(echo)) = (steers, user_message_text(item)) else {
                return;
            };
            if let Some(at) = steers.iter().position(|steer| steer.sent.trim() == echo.trim()) {
                let steer = steers.remove(at);
                events.extend(steer.read());
            }
        }
        // Codex does not stream a review's words: the finished review is in
        // the item that says it left review mode.
        "exitedReviewMode" if completed => {
            let review = item.get("review").and_then(Value::as_str).unwrap_or_default().trim();
            if !review.is_empty() {
                events.push(HarnessEvent::MessageDelta { text: review.to_string() });
                events.push(HarnessEvent::MessageCompleted {});
            }
        }
        "contextCompaction" if completed => {
            events.push(HarnessEvent::SessionNote {
                message: "Context compacted".into(),
            });
        }
        _ => {
            let Some(row) = exec_item(item).filter(is_tool_item) else {
                return;
            };
            let Some(call_id) = tool_call_id(&row) else {
                return;
            };
            follow.items.insert(call_id.clone(), item.clone());
            let title = tool_label(&row);
            if follow.seen_tools.insert(call_id.clone()) {
                events.push(HarnessEvent::ToolStarted {
                    call_id: call_id.clone(),
                    name: tool_name(&row),
                    title,
                    detail: tool_detail(&row),
                });
            } else {
                events.push(HarnessEvent::ToolUpdated {
                    call_id: call_id.clone(),
                    title: Some(title),
                    status: None,
                    detail: tool_detail(&row),
                });
            }
            if completed {
                follow.items.remove(&call_id);
                events.push(HarnessEvent::ToolUpdated {
                    call_id: call_id.clone(),
                    title: None,
                    status: Some(completed_tool_status(&row)),
                    detail: None,
                });
                let files = item_files(&row);
                if !files.is_empty() {
                    events.push(HarnessEvent::ToolFiles { call_id, files });
                }
            }
        }
    }
}

/// `thread/started` of a thread other than the one Crew opened: who it is,
/// for the cards it asks with. Codex 0.160 sends none for the agents a model
/// spawns, and the schema gives the thread a nickname when it does. The
/// thread Crew opened has no parent, and so is not one.
fn child_started(live: &mut CodexLive, params: &Value) {
    let Some(thread) = params.get("thread").and_then(Value::as_object) else {
        return;
    };
    let (Some(id), Some(_)) = (string_field(Some(thread), "id"), string_field(Some(thread), "parentThreadId")) else {
        return;
    };
    if live.thread_id.as_deref() == Some(id.as_str()) {
        return;
    }
    let nickname = string_field(Some(thread), "agentNickname");
    let child = live.children.entry(id).or_default();
    if nickname.is_some() {
        child.nickname = nickname;
    }
}

/// A `spawnAgent` call that completed, issued from thread `from`: gives each
/// thread it started its call, an entry on the board, and what the thread
/// said before the call named it. An agent's own agents are steps of the call
/// that started the first, since the transcript has no row for the agent.
fn spawn_named(live: &mut CodexLive, item: &Map<String, Value>, from: &str, work: &mut ChildWork) {
    let threads = spawned_threads(item);
    if threads.is_empty() {
        return;
    }
    let call = if live.thread_id.as_deref() == Some(from) {
        string_field(Some(item), "id")
    } else {
        live.children.get(from).and_then(|child| child.call.clone())
    };
    let Some(call) = call else {
        return;
    };
    let label = exec_item(item).map(|row| tool_label(&row)).unwrap_or_else(|| "Subagent".into());
    let model = string_field(Some(item), "model").filter(|model| !model.is_empty());
    for thread in threads {
        if live.thread_id.as_deref() == Some(thread.as_str()) {
            continue;
        }
        let child = live.children.entry(thread.clone()).or_default();
        if child.call.is_some() {
            continue;
        }
        child.call = Some(call.clone());
        let nickname = child.nickname.clone();
        let held = std::mem::take(&mut child.held);
        work.board.push(ChildBoard::Spawned {
            thread: thread.clone(),
            call: call.clone(),
            label: label.clone(),
            nickname,
            model: model.clone(),
        });
        for (method, params) in held {
            child_note(live, &thread, &method, &params, work);
        }
    }
}

/// What a child's notification adds to its call: steps, its state, its
/// tokens. Until a spawn names the thread there is no call to add it to, and
/// the notification is kept for then.
fn child_note(live: &mut CodexLive, thread: &str, method: &str, params: &Value, work: &mut ChildWork) {
    // What is shown or counted; the rest (its status, its hooks, its servers
    // starting) is neither.
    if !matches!(
        method,
        "turn/started" | "turn/completed" | "item/started" | "item/completed" | "item/agentMessage/delta" | "thread/tokenUsage/updated"
    ) {
        return;
    }
    let child = live.children.entry(thread.to_string()).or_default();
    let Some(call) = child.call.clone() else {
        if child.held.len() >= HELD_LIMIT {
            child.held.remove(0);
        }
        child.held.push((method.to_string(), params.clone()));
        return;
    };
    let mut steps = Vec::new();
    let mut after = Vec::new();
    let mut spawned = None;
    match method {
        "turn/started" => {
            child.turn = params.pointer("/turn/id").and_then(Value::as_str).map(str::to_string);
            work.board.push(ChildBoard::State(thread.to_string(), BackgroundState::Running));
            after.push(subagent_updated(&call, Some(SubagentState::Running), None, None));
        }
        "turn/completed" => {
            let (turn, end) = turn_end(params);
            if child.turn.is_some() && turn.is_some() && child.turn != turn {
                return;
            }
            child.turn = None;
            if child.follow.message.take().is_some() {
                steps.push(HarnessEvent::MessageCompleted {});
            }
            let report = child.report.take();
            let (shown, state, report) = match end {
                TurnEnd::Completed => (SubagentState::Done, BackgroundState::Completed, report),
                TurnEnd::Interrupted => (SubagentState::Stopped, BackgroundState::Stopped, report),
                TurnEnd::Failed(message) => (SubagentState::Failed, BackgroundState::Failed, report.or(Some(message))),
            };
            work.board.push(ChildBoard::State(thread.to_string(), state));
            after.push(subagent_updated(&call, Some(shown), None, report));
        }
        "item/agentMessage/delta" => {
            if let (Some(item), Some(delta)) =
                (params.get("itemId").and_then(Value::as_str), params.get("delta").and_then(Value::as_str))
            {
                message_delta(&mut child.follow, item, delta, &mut steps);
            }
        }
        "item/started" | "item/completed" => {
            let Some(item) = params.get("item").and_then(Value::as_object) else {
                return;
            };
            let completed = method == "item/completed";
            codex_item(&mut child.follow, None, item, completed, &mut steps);
            if completed && string_field(Some(item), "type").as_deref() == Some("agentMessage") {
                child.report = string_field(Some(item), "text").filter(|text| !text.trim().is_empty()).or(child.report.take());
            }
            for step in &steps {
                if let HarnessEvent::ToolStarted { title, .. } = step {
                    work.board.push(ChildBoard::Activity(thread.to_string(), title.clone()));
                    after.push(subagent_updated(&call, None, Some(title.clone()), None));
                }
            }
            spawned = completed.then(|| item.clone());
        }
        "thread/tokenUsage/updated" => {
            if let Some((tokens, window)) = token_reading(params) {
                work.board.push(ChildBoard::Usage { thread: thread.to_string(), tokens, window });
            }
        }
        _ => {}
    }
    for step in steps {
        if matches!(
            step,
            HarnessEvent::MessageDelta { .. }
                | HarnessEvent::MessageCompleted { .. }
                | HarnessEvent::ToolStarted { .. }
                | HarnessEvent::ToolUpdated { .. }
        ) {
            work.events.push(HarnessEvent::SubagentEvent { call_id: call.clone(), event: Box::new(step) });
        }
    }
    work.events.extend(after);
    if let Some(item) = spawned {
        spawn_named(live, &item, thread, work);
    }
}

/// Where a subagent is and what it is on, as its call's row shows it.
fn subagent_updated(call: &str, state: Option<SubagentState>, activity: Option<String>, output: Option<String>) -> HarnessEvent {
    HarnessEvent::SubagentUpdated { call_id: call.to_string(), state, activity, output, background: None }
}

/// A stand-in for `codex app-server` 0.160 that speaks the part of the
/// protocol Crew uses: the handshake, `thread/start` and `thread/resume`,
/// `turn/start`, `turn/steer`, `turn/interrupt`, `skills/list` (one enabled
/// skill and one disabled; a file named like the log plus `.no-skills` makes
/// it fail), `config/mcpServer/reload`, the commands Crew maps to methods
/// (`thread/compact/start` and `review/start`, which run as turns of their
/// own; `thread/goal/set|get|clear` and `mcpServerStatus/list`, which answer
/// at once), and the server's own approval and question requests. Every request it gets is appended to the log as `{method,
/// params}`, after a first line with its argv, pid and env: one such line per
/// launch.
///
/// What a turn does is spelled in its text: `SLEEP <s>` runs a command that
/// long (steers land after it), `ASK` asks to run one, `QUESTION` asks which
/// color, `MCP` calls Crew's `list_peers`, `FAIL` fails the turn,
/// `STUBBORN` ignores an interrupt, `TOKENS` reports the thread's token usage
/// twice, the second time with no window, `STALE` has the turn begin with a delta
/// and a failed end that name the turn before it, `SPAWN` has the model start
/// an agent on another thread of the same connection (`child-thread-1`, turn
/// `child-turn-1`) whose notifications come before the call names it and
/// between the turn's own words; `SPAWNHOLD` keeps that agent's turn open until
/// it is interrupted, and `SPAWNREQUEST` has it ask to run a command. It
/// answers `report: <last line>`, with ` + <steer>` for each steer it took.
#[cfg(test)]
pub(crate) fn fake_codex(dir: &std::path::Path) -> (String, std::path::PathBuf) {
    // The log is the script's own path and `.log`, which it works out for itself.
    let name = format!("fake-codex-{}", uuid::Uuid::new_v4().simple());
    let log = dir.join(format!("{name}.log"));
    let script = r#"#!/usr/bin/env python3
import json, os, re, sys, threading, time, uuid
LOG = os.path.abspath(sys.argv[0]) + ".log"
lock = threading.Lock()
def out(m):
    with lock:
        sys.stdout.write(json.dumps(m) + "\n"); sys.stdout.flush()
def log(m):
    with open(LOG, "a") as f: f.write(json.dumps(m) + "\n")
log({"argv": sys.argv[1:], "pid": os.getpid(), "env": {k: os.environ.get(k) for k in ["CREW_SOCKET", "CREW_TOKEN"]}})
state = {"thread": None, "turn": None, "next": 0, "goal": None, "signed": False}
answers = {}
terminals = {}
def ask(method, params):
    with lock:
        rid = state["next"]; state["next"] += 1
        answers[rid] = threading.Event()
    out({"id": rid, "method": method, "params": params})
    turn = state["turn"]
    while not answers[rid].is_set():
        if turn["interrupted"].is_set() and not turn["stubborn"]:
            out({"method": "serverRequest/resolved", "params": {"threadId": state["thread"], "requestId": rid}})
            return None
        time.sleep(0.02)
    return answers[rid].result
def item(phase, it):
    out({"method": "item/" + phase, "params": {"threadId": state["thread"], "turnId": state["turn"]["id"], "item": it}})
def text_of(inp):
    return "\n".join(p.get("text", "") for p in inp)
def usage_of(n):
    return {"totalTokens": n, "inputTokens": n - 10, "cachedInputTokens": 0, "outputTokens": 10, "reasoningOutputTokens": 0}
# The agent a SPAWN turn starts: another thread on this same connection.
CHILD, CHILD_TURN = "child-thread-1", "child-turn-1"
child_stop = threading.Event()
def child_out(method, params):
    out({"method": method, "params": dict(params, threadId=CHILD)})
def child_item(phase, it):
    child_out("item/" + phase, {"turnId": CHILD_TURN, "item": it})
def run(turn, text):
    tid = turn["id"]
    heard = [text.strip().splitlines()[-1] if text.strip() else ""]
    item("started", {"type": "userMessage", "id": str(uuid.uuid4()), "clientId": None, "content": [{"type": "text", "text": text, "text_elements": []}]})
    m = re.search(r"SLEEP ([0-9.]+)", text)
    if m:
        cid = "exec-" + uuid.uuid4().hex[:8]
        cmd = {"type": "commandExecution", "id": cid, "command": "/bin/zsh -lc 'sleep %s'" % m.group(1), "cwd": os.getcwd(), "status": "inProgress", "aggregatedOutput": None, "exitCode": None}
        item("started", cmd)
        end = time.time() + float(m.group(1))
        while time.time() < end and not (turn["interrupted"].is_set() and not turn["stubborn"]):
            time.sleep(0.02)
        item("completed", dict(cmd, status="completed", exitCode=0, aggregatedOutput=""))
    t = re.search(r"BGTERM ([0-9.]+)", text)
    if t:
        cid = "exec-bg"
        cmd = {"type": "commandExecution", "id": cid, "command": "/bin/zsh -lc 'sleep %s'" % t.group(1), "cwd": os.getcwd(), "processId": "4242", "source": "unifiedExecStartup", "status": "inProgress", "aggregatedOutput": None, "exitCode": None}
        item("started", cmd)
        out({"method": "item/commandExecution/outputDelta", "params": {"threadId": state["thread"], "turnId": tid, "itemId": cid, "delta": "tick\n"}})
        item("started", {"type": "reasoning", "id": "rs-bg", "summary": [], "content": []})
        ended = threading.Event()
        terminals[cid] = {"itemId": cid, "processId": "4242", "command": cmd["command"], "cwd": os.getcwd(), "osPid": 1, "cpuPercent": None, "rssKb": None, "ended": ended}
        ended.wait(float(t.group(1)))
        terminals.pop(cid, None)
        stopped = ended.is_set()
        item("completed", dict(cmd, status="failed" if stopped else "completed", exitCode=143 if stopped else 0, aggregatedOutput="tick\n"))
        heard.append("terminal %s" % ("terminated" if stopped else "finished"))
    # BGKEEP n: the turn ends while its terminal runs on for n seconds.
    k = re.search(r"BGKEEP ([0-9.]+)", text)
    if k:
        cid = "exec-keep"
        cmd = {"type": "commandExecution", "id": cid, "command": "/bin/zsh -lc 'sleep %s'" % k.group(1), "cwd": os.getcwd(), "processId": "4343", "source": "unifiedExecStartup", "status": "inProgress", "aggregatedOutput": None, "exitCode": None}
        item("started", cmd)
        out({"method": "item/commandExecution/outputDelta", "params": {"threadId": state["thread"], "turnId": tid, "itemId": cid, "delta": "tick\n"}})
        item("started", {"type": "reasoning", "id": "rs-keep", "summary": [], "content": []})
        ended = threading.Event()
        terminals[cid] = {"itemId": cid, "processId": "4343", "command": cmd["command"], "cwd": os.getcwd(), "osPid": 1, "cpuPercent": None, "rssKb": None, "ended": ended}
        def finish():
            ended.wait(float(k.group(1)))
            terminals.pop(cid, None)
        threading.Thread(target=finish, daemon=True).start()
    if "ASK" in text:
        cid = "exec-" + uuid.uuid4().hex[:8]
        cmd = {"type": "commandExecution", "id": cid, "command": "/bin/zsh -lc 'touch asked.txt'", "cwd": os.getcwd(), "status": "inProgress", "aggregatedOutput": None, "exitCode": None}
        item("started", cmd)
        got = ask("item/commandExecution/requestApproval", {"threadId": state["thread"], "turnId": tid, "itemId": cid, "startedAtMs": 0, "command": cmd["command"], "cwd": os.getcwd(), "reason": "outside the workspace"})
        decision = (got or {}).get("decision")
        item("completed", dict(cmd, status="completed" if decision in ("accept", "acceptForSession") else "declined", exitCode=0 if decision else None))
        heard.append("decision: %s" % decision)
    if "QUESTION" in text:
        got = ask("item/tool/requestUserInput", {"threadId": state["thread"], "turnId": tid, "itemId": "call_q", "isBlocking": False, "questions": [{"id": "color", "header": "Color", "question": "Which color?", "isOther": True, "isSecret": False, "options": [{"label": "Red", "description": "Choose red."}, {"label": "Blue", "description": "Choose blue."}]}]})
        heard.append("answers: %s" % json.dumps((got or {}).get("answers"), sort_keys=True))
    if "MCP" in text:
        mid = "exec-" + uuid.uuid4().hex[:8]
        call = {"type": "mcpToolCall", "id": mid, "server": "crew", "tool": "list_peers", "status": "inProgress", "arguments": {}, "result": None, "error": None}
        item("started", call)
        item("completed", dict(call, status="completed", result={"content": [{"type": "text", "text": "[]"}]}))
    # SPAWN: the model starts an agent. The agent speaks before the call that
    # started it says it exists, and again between the parent's own words.
    # SPAWNHOLD keeps its turn open until it is interrupted, SPAWNREQUEST has it
    # ask to run a command.
    between = []
    if "SPAWN" in text:
        spawn = {"type": "collabAgentToolCall", "id": "spawn-1", "tool": "spawnAgent", "status": "inProgress", "senderThreadId": state["thread"], "receiverThreadIds": [], "prompt": "Reply with just the word one.", "model": "", "reasoningEffort": None, "agentsStates": {}}
        item("started", spawn)
        out({"method": "thread/started", "params": {"thread": {"id": CHILD, "parentThreadId": state["thread"], "agentNickname": "Ampere", "agentRole": None}}})
        child_out("turn/started", {"turn": {"id": CHILD_TURN, "status": "inProgress"}})
        echo = {"type": "commandExecution", "id": "child-exec", "command": "/bin/zsh -lc 'echo one'", "cwd": os.getcwd(), "status": "inProgress", "aggregatedOutput": None, "exitCode": None}
        child_item("started", echo)
        item("completed", dict(spawn, status="completed", model="gpt-5.6-luna", receiverThreadIds=[CHILD], agentsStates={CHILD: {"status": "pendingInit", "message": None}}))
        def child_work():
            said = "msg_child"
            child_item("started", {"type": "agentMessage", "id": said, "text": "", "phase": "final_answer"})
            child_out("item/agentMessage/delta", {"turnId": CHILD_TURN, "itemId": said, "delta": "on"})
            child_out("thread/tokenUsage/updated", {"turnId": CHILD_TURN, "tokenUsage": {"last": usage_of(4000), "total": usage_of(9000), "modelContextWindow": 100000}})
            if "SPAWNREQUEST" in text:
                got = ask("item/commandExecution/requestApproval", {"threadId": CHILD, "turnId": CHILD_TURN, "itemId": "child-exec", "startedAtMs": 0, "command": "/bin/zsh -lc 'touch child.txt'", "cwd": os.getcwd(), "reason": "outside the workspace"})
                heard.append("child decision: %s" % (got or {}).get("decision"))
            if "SPAWNHOLD" in text:
                child_stop.wait(30)
            if child_stop.is_set():
                child_out("turn/completed", {"turn": {"id": CHILD_TURN, "status": "interrupted", "error": None}})
                return
            child_out("item/agentMessage/delta", {"turnId": CHILD_TURN, "itemId": said, "delta": "e"})
            child_item("completed", dict(echo, status="completed", exitCode=0, aggregatedOutput="one\n"))
            child_item("completed", {"type": "agentMessage", "id": said, "text": "one", "phase": "final_answer"})
            child_out("turn/completed", {"turn": {"id": CHILD_TURN, "status": "completed", "error": None}})
            # The parent's turn is not over because the agent's is.
            time.sleep(0.5)
        between.append(child_work)
    while turn["inbox"]:
        more = turn["inbox"].pop(0)
        item("started", {"type": "userMessage", "id": str(uuid.uuid4()), "clientId": None, "content": [{"type": "text", "text": more, "text_elements": []}]})
        heard.append(more.strip().splitlines()[-1])
    if turn["interrupted"].is_set() and not turn["stubborn"]:
        state["turn"] = None
        out({"method": "turn/completed", "params": {"threadId": state["thread"], "turn": {"id": tid, "status": "interrupted", "error": None}}})
        return
    if turn["interrupted"].is_set():
        time.sleep(30)
    if "FAIL" in text:
        state["turn"] = None
        out({"method": "turn/completed", "params": {"threadId": state["thread"], "turn": {"id": tid, "status": "failed", "error": {"message": "boom"}}}})
        return
    if "TOKENS" in text:
        # `total` adds up the whole thread; `last` is what the newest response held.
        # The second reading names no window.
        for last, total, window in ((5000, 90000, 258400), (6000, 96000, None)):
            usage = lambda n: {"totalTokens": n, "inputTokens": n - 10, "cachedInputTokens": 0, "outputTokens": 10, "reasoningOutputTokens": 0}
            out({"method": "thread/tokenUsage/updated", "params": {"threadId": state["thread"], "turnId": tid, "tokenUsage": {"last": usage(last), "total": usage(total), "modelContextWindow": window}}})
    mid = "msg_" + uuid.uuid4().hex[:8]
    item("started", {"type": "agentMessage", "id": mid, "text": "", "phase": "final_answer"})
    if between:
        # The parent speaks, the agent works, and the parent goes on.
        out({"method": "item/agentMessage/delta", "params": {"threadId": state["thread"], "turnId": tid, "itemId": mid, "delta": "report: "}})
        for work in between: work()
        reply = "report: " + " + ".join(heard)
        pieces = (reply[len("report: "):],)
    else:
        reply = "report: " + " + ".join(heard)
        half = len(reply) // 2
        pieces = (reply[:half], reply[half:])
    for piece in pieces:
        out({"method": "item/agentMessage/delta", "params": {"threadId": state["thread"], "turnId": tid, "itemId": mid, "delta": piece}})
    with lock:
        state["turn"] = None
    item_done = {"type": "agentMessage", "id": mid, "text": reply, "phase": "final_answer"}
    out({"method": "item/completed", "params": {"threadId": state["thread"], "turnId": tid, "item": item_done}})
    out({"method": "turn/completed", "params": {"threadId": state["thread"], "turn": {"id": tid, "status": "completed", "error": None}}})
def run_side(turn, items):
    # A turn Codex runs for a command: it begins, streams its items, and ends.
    tid = turn["id"]
    out({"method": "turn/started", "params": {"threadId": state["thread"], "turn": {"id": tid, "status": "inProgress"}}})
    for phase, it in items:
        item(phase, it)
        time.sleep(0.02)
    with lock:
        state["turn"] = None
    out({"method": "turn/completed", "params": {"threadId": state["thread"], "turn": {"id": tid, "status": "completed", "error": None}}})
def side_turn():
    turn = {"id": str(uuid.uuid4()), "inbox": [], "interrupted": threading.Event(), "stubborn": False}
    state["turn"] = turn
    return turn
for line in sys.stdin:
    try: m = json.loads(line)
    except Exception: continue
    method, rid, params = m.get("method"), m.get("id"), m.get("params") or {}
    if method is None and rid is not None:
        ev = answers.get(rid)
        if ev is not None:
            ev.result = m.get("result"); ev.set()
        continue
    log({"method": method, "params": params})
    if rid is None:
        continue
    if method == "initialize":
        out({"id": rid, "result": {"userAgent": "fake-codex/0.160.0"}})
    elif method in ("thread/start", "thread/resume"):
        state["thread"] = params.get("threadId") or str(uuid.uuid4())
        out({"id": rid, "result": {"thread": {"id": state["thread"]}, "model": params.get("model")}})
        # `sentry` is a remote server whose login has run out.
        out({"method": "mcpServer/startupStatus/updated", "params": {"name": "sentry", "status": "failed", "error": "token expired", "failureReason": "reauthenticationRequired", "threadId": state["thread"]}})
    elif method == "turn/start":
        with lock:
            busy = state["turn"]
        if busy:
            busy["inbox"].append(text_of(params.get("input", [])))
            out({"id": rid, "result": {"turn": {"id": busy["id"], "status": "inProgress"}}})
            continue
        text = text_of(params.get("input", []))
        turn = {"id": str(uuid.uuid4()), "inbox": [], "interrupted": threading.Event(), "stubborn": "STUBBORN" in text}
        state["turn"] = turn
        if "STALE" in text and state.get("last"):
            late = state["last"]
            out({"method": "item/agentMessage/delta", "params": {"threadId": state["thread"], "turnId": late, "itemId": "late", "delta": "from the last turn"}})
            out({"method": "turn/completed", "params": {"threadId": state["thread"], "turn": {"id": late, "status": "failed", "error": {"message": "from the last turn"}}}})
        state["last"] = turn["id"]
        out({"id": rid, "result": {"turn": {"id": turn["id"], "status": "inProgress"}}})
        out({"method": "turn/started", "params": {"threadId": state["thread"], "turn": {"id": turn["id"], "status": "inProgress"}}})
        threading.Thread(target=run, args=(turn, text), daemon=True).start()
    elif method == "thread/compact/start":
        # Answers with nothing; the turn is named by the notifications after it.
        turn = side_turn()
        out({"id": rid, "result": {}})
        cid = "compact-" + uuid.uuid4().hex[:6]
        threading.Thread(target=run_side, args=(turn, [("started", {"type": "contextCompaction", "id": cid}), ("completed", {"type": "contextCompaction", "id": cid})]), daemon=True).start()
    elif method == "review/start":
        turn = side_turn()
        out({"id": rid, "result": {"reviewThreadId": state["thread"], "turn": {"id": turn["id"], "status": "inProgress"}}})
        target = params.get("target") or {}
        said = "Review of %s: no issues found." % (target.get("instructions") or target.get("type"))
        entered = {"type": "enteredReviewMode", "id": "rv-in", "review": "current changes"}
        exited = {"type": "exitedReviewMode", "id": "rv-out", "review": said}
        threading.Thread(target=run_side, args=(turn, [("started", entered), ("completed", entered), ("started", exited), ("completed", exited)]), daemon=True).start()
    elif method == "thread/goal/set":
        state["goal"] = {"threadId": state["thread"], "objective": params.get("objective"), "status": "active", "createdAt": 1, "updatedAt": 1, "timeUsedSeconds": 0, "tokensUsed": 0, "tokenBudget": None}
        out({"id": rid, "result": {"goal": state["goal"]}})
    elif method == "thread/goal/get":
        out({"id": rid, "result": {"goal": state["goal"]}})
    elif method == "thread/goal/clear":
        had = state["goal"] is not None
        state["goal"] = None
        out({"id": rid, "result": {"cleared": had}})
    elif method == "mcpServerStatus/list":
        sentry = {"name": "sentry", "runtimeStatus": "connected" if state["signed"] else "authenticationRequired", "authStatus": "oAuth" if state["signed"] else "notLoggedIn", "tools": {}, "resources": [], "resourceTemplates": []}
        out({"id": rid, "result": {"data": [{"name": "crew", "runtimeStatus": "connected", "authStatus": "unsupported", "tools": {"list_peers": {"name": "list_peers"}}, "resources": [], "resourceTemplates": []}, sentry], "nextCursor": None}})
    elif method == "mcpServer/oauth/login":
        out({"id": rid, "result": {"authorizationUrl": "https://auth.example/oauth?server=" + params.get("name", "")}})
        # The user finished in the browser a moment later.
        def finished(name):
            time.sleep(0.05)
            state["signed"] = True
            out({"method": "mcpServer/oauthLogin/completed", "params": {"name": name, "success": True}})
        threading.Thread(target=finished, args=(params.get("name"),), daemon=True).start()
    elif method == "turn/steer":
        with lock:
            turn = state["turn"]
        if turn and params.get("expectedTurnId") == turn["id"]:
            turn["inbox"].append(text_of(params.get("input", [])))
            out({"id": rid, "result": {"turnId": turn["id"]}})
        else:
            out({"id": rid, "error": {"code": -32600, "message": "no active turn to steer"}})
    elif method == "thread/backgroundTerminals/list":
        out({"id": rid, "result": {"data": [{k: v for k, v in row.items() if k != "ended"} for row in list(terminals.values())], "nextCursor": None}})
    elif method == "thread/backgroundTerminals/terminate":
        hit = [row for row in list(terminals.values()) if row["processId"] == params.get("processId")]
        for row in hit: row["ended"].set()
        out({"id": rid, "result": {"terminated": bool(hit)}})
    elif method == "turn/interrupt":
        if params.get("threadId") == CHILD:
            child_stop.set()
        else:
            turn = state["turn"]
            if turn: turn["interrupted"].set()
        out({"id": rid, "result": {}})
    elif method == "config/mcpServer/reload":
        out({"id": rid, "result": {}})
        if state["signed"]:
            out({"method": "mcpServer/startupStatus/updated", "params": {"name": "sentry", "status": "starting"}})
            out({"method": "mcpServer/startupStatus/updated", "params": {"name": "sentry", "status": "ready"}})
    elif method == "skills/list" and os.path.exists(LOG + ".no-skills"):
        out({"id": rid, "error": {"code": -32603, "message": "the skill folders cannot be read"}})
    elif method == "skills/list":
        # One enabled skill and one the user turned off, as the schema shapes them.
        cwd = (params.get("cwds") or [os.getcwd()])[0]
        skill = {"name": "review-pr", "description": "Reviews a pull request in depth.", "shortDescription": None, "enabled": True, "interface": {"shortDescription": "Review a pull request"}, "path": cwd + "/.agents/skills/review-pr/SKILL.md", "scope": "repo", "pluginId": None, "dependencies": None}
        off = dict(skill, name="old-notes", enabled=False, path=cwd + "/.agents/skills/old-notes/SKILL.md")
        out({"id": rid, "result": {"data": [{"cwd": cwd, "errors": [], "skills": [skill, off]}]}})
    else:
        out({"id": rid, "error": {"code": -32601, "message": "unknown " + str(method)}})
"#;
    let path = crate::fakes::install(dir, &name, script);
    (path.to_string_lossy().into_owned(), log)
}

#[cfg(test)]
mod context_tests {
    use super::*;
    use crew_protocol::ContextReading;

    fn usage(thread: &str, turn: &str, last: u64, total: u64) -> Value {
        json!({
            "threadId": thread,
            "turnId": turn,
            "tokenUsage": {
                "last": { "totalTokens": last },
                "total": { "totalTokens": total },
                "modelContextWindow": 258_400,
            },
        })
    }

    /// The reading is the thread's: it is taken with no turn running, and
    /// naming a turn that is over, but not from another thread.
    #[test]
    fn a_token_reading_is_taken_between_turns_but_not_from_another_thread() {
        let host = TurnHost::test_new();
        host.test_install_codex("s");
        if let Some(Live::Codex(live)) = host.lock().get_mut("s") {
            live.thread_id = Some("t1".into());
            live.last_turn = Some("old".into());
        }
        host.codex_notification("s", "thread/tokenUsage/updated", &usage("t2", "x", 1, 2));
        assert_eq!(host.context("s"), None);
        host.codex_notification("s", "thread/tokenUsage/updated", &usage("t1", "old", 7000, 70_000));
        assert_eq!(
            host.context("s"),
            Some(ContextReading { used: 7000, window: Some(258_400), auto_compact_at: None, stale: None })
        );
    }
}

#[cfg(test)]
mod catalog_tests {
    use super::*;
    use crate::agent::AgentEvents;
    use crew_protocol::TurnStart;
    use std::sync::Arc;

    /// Hands the fake's lines to the driver, as the agent's reader does.
    struct Lines(TurnHost);

    impl AgentEvents for Lines {
        fn lines(&self, event: &str, session_id: &str, lines: Vec<String>) {
            self.0.on_agent_lines(event, session_id, lines);
        }
        fn exit(&self, session_id: &str, code: Option<i32>, _pid: u32) {
            self.0.on_agent_exit(session_id, code);
        }
    }

    pub(super) fn sent(log: &std::path::Path, method: &str) -> Vec<Value> {
        std::fs::read_to_string(log)
            .unwrap_or_default()
            .lines()
            .filter_map(|line| serde_json::from_str::<Value>(line).ok())
            .filter(|line| line["method"] == method)
            .map(|line| line["params"].clone())
            .collect()
    }

    pub(super) fn wait_for(mut done: impl FnMut() -> bool) {
        for _ in 0..400 {
            if done() {
                return;
            }
            std::thread::sleep(Duration::from_millis(25));
        }
        panic!("the wait ran out");
    }

    /// A Codex session of `kind` in a new folder, not started. Returns its id
    /// and the folder.
    pub(super) fn codex_session(host: &TurnHost, kind: &str) -> (String, String) {
        let dir = std::env::temp_dir().join(format!("crew-codex-catalog-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).expect("dir");
        let workspace = crate::workspace::create(host.test_store(), "w".into(), dir.to_string_lossy().into())
            .expect("workspace")
            .id;
        let session = crate::session::create(
            host.test_store(),
            workspace,
            kind.into(),
            "shell".into(),
            "codex".into(),
            "gpt-5.6-luna".into(),
            String::new(),
            "full".into(),
        )
        .expect("session")
        .id;
        (session, dir.to_string_lossy().into_owned())
    }

    /// A Codex session of `kind` on the fake app server, started with `text`,
    /// which may open with a command or invoke skills, with `known` already in
    /// the catalog for the folder. Returns the host, the session's id, the
    /// fake's log and the folder.
    fn started_full(
        kind: &str,
        text: &str,
        command: Option<&str>,
        skills: Option<Vec<String>>,
        known: Vec<CommandEntry>,
    ) -> (TurnHost, String, std::path::PathBuf, String) {
        started_prepared(kind, text, command, skills, known, |_| {})
    }

    /// The same, after `prepare` has had the fake's log path to set up what
    /// the fake reads when it starts (a file beside the log).
    fn started_prepared(
        kind: &str,
        text: &str,
        command: Option<&str>,
        skills: Option<Vec<String>>,
        known: Vec<CommandEntry>,
        prepare: impl FnOnce(&std::path::Path),
    ) -> (TurnHost, String, std::path::PathBuf, String) {
        let host = TurnHost::test_new();
        host.test_agents().set_events(Arc::new(Lines(host.clone())));
        let (session, cwd) = codex_session(&host, kind);
        let (fake, log) = crate::turns::fake_codex(std::path::Path::new(&cwd));
        prepare(&log);
        host.override_binary("codex", fake);
        if !known.is_empty() {
            host.commands.learn("codex", &cwd, Some(known), None, crate::store::now_millis());
        }
        host.start(TurnStart {
            session_id: session.clone(),
            cwd: cwd.clone(),
            text: text.into(),
            files: None,
            mentions: None,
            hidden: None,
            from_bot: None,
            sent_at: None,
            nonce: None,
            letter_id: None,
            mode: None,
            command: command.map(str::to_string),
            skills,
        })
        .expect("start");
        (host, session, log, cwd)
    }

    fn started_as(kind: &str, text: &str) -> (TurnHost, String, std::path::PathBuf, String) {
        started_full(kind, text, None, None, Vec::new())
    }

    pub(super) fn started(text: &str) -> (TurnHost, String, std::path::PathBuf, String) {
        started_as("terminal", text)
    }

    /// The same, for a message that opens with a command or invokes skills.
    fn started_with(
        text: &str,
        command: Option<&str>,
        skills: Option<Vec<String>>,
        known: Vec<CommandEntry>,
    ) -> (TurnHost, String, std::path::PathBuf, String) {
        started_full("terminal", text, command, skills, known)
    }

    fn skill_entry(name: &str, path: &str) -> CommandEntry {
        CommandEntry {
            name: name.into(),
            description: String::new(),
            argument_hint: None,
            aliases: None,
            kind: "skill".into(),
            path: Some(path.into()),
        }
    }

    /// What the transcript of a session says, as plain text.
    fn said(host: &TurnHost, session: &str) -> String {
        host.transcripts().since(session, 0).0.into_iter().map(|block| block.text).collect::<Vec<_>>().join("\n")
    }

    /// Opening the thread asks for the folder's skills, and the menu then
    /// lists them as skills with the commands Codex has, after Crew's actions.
    #[test]
    fn a_codex_thread_hands_its_skills_and_commands_to_the_catalog_when_it_opens() {
        let (host, session, log, cwd) = started("hello");
        wait_for(|| host.commands().holds("codex", &cwd));
        let entries = host.commands_list(&session).expect("menu").entries;
        let get = |name: &str| entries.iter().find(|entry| entry.name == name).expect(name).clone();
        let skill = get("review-pr");
        assert_eq!(skill.kind, "skill");
        assert_eq!(skill.description, "Review a pull request");
        assert_eq!(skill.path.as_deref(), Some(format!("{cwd}/.agents/skills/review-pr/SKILL.md").as_str()));
        assert_eq!(get("compact").kind, "command");
        assert_eq!(get("model").kind, "crew");
        assert!(!entries.iter().any(|entry| entry.name == "old-notes"), "a skill the user turned off");
        assert_eq!(sent(&log, "skills/list"), vec![json!({ "cwds": [cwd] })]);
        wait_for(|| !host.is_running(&session));
    }

    /// A skill the user invoked goes to Codex as `$name` in the text and as an
    /// item that names its file, which the catalog supplies.
    #[test]
    fn a_skill_goes_to_codex_as_a_dollar_name_and_an_item_with_its_file() {
        let known = vec![skill_entry("lint", "/repo/.agents/skills/lint/SKILL.md")];
        let (host, session, log, _) = started_with("run /lint on src", None, Some(vec!["lint".into()]), known);
        wait_for(|| !host.is_running(&session));
        let turns = sent(&log, "turn/start");
        assert_eq!(
            turns[0]["input"],
            json!([
                { "type": "text", "text": "run $lint on src", "text_elements": [] },
                { "type": "skill", "name": "lint", "path": "/repo/.agents/skills/lint/SKILL.md" },
            ])
        );
    }

    /// A skill the catalog has not read yet is still named, as `$name`.
    #[test]
    fn a_skill_the_catalog_does_not_know_goes_as_a_dollar_name_alone() {
        let (host, session, log, _) = started_with("run /lint on src", None, Some(vec!["lint".into()]), Vec::new());
        wait_for(|| !host.is_running(&session));
        assert_eq!(sent(&log, "turn/start")[0]["input"], json!([{ "type": "text", "text": "run $lint on src", "text_elements": [] }]));
    }

    /// `/compact` is not a turn/start: Codex compacts the thread, streams it as
    /// a turn of its own, and the turn ends with it.
    #[test]
    fn compact_runs_the_threads_compaction_and_ends_with_its_turn() {
        let (host, session, log, _) = started_with("/compact", Some("compact"), None, Vec::new());
        wait_for(|| !host.is_running(&session));
        assert_eq!(sent(&log, "thread/compact/start").len(), 1);
        assert!(sent(&log, "turn/start").is_empty(), "the command was also sent as a message");
        assert!(said(&host, &session).contains("Context compacted"), "{}", said(&host, &session));
        let row = crate::session::get(host.test_store(), session.clone()).expect("read").expect("session");
        assert_eq!(row.status, "done");
    }

    /// `/review` reviews the working tree, and what the review concludes is
    /// shown as the answer: Codex streams none of it.
    #[test]
    fn review_reviews_the_uncommitted_changes_and_shows_its_conclusion() {
        let (host, session, log, _) = started_with("/review", Some("review"), None, Vec::new());
        wait_for(|| !host.is_running(&session));
        let asked = sent(&log, "review/start");
        assert_eq!(asked.len(), 1);
        assert_eq!(asked[0]["target"], json!({ "type": "uncommittedChanges" }));
        assert!(sent(&log, "turn/start").is_empty());
        assert!(said(&host, &session).contains("Review of uncommittedChanges: no issues found."), "{}", said(&host, &session));
    }

    /// `/goal` with an objective sets it; a note says so, and the turn ends
    /// without the model being asked anything.
    #[test]
    fn goal_sets_the_objective_and_answers_with_a_note_not_a_turn() {
        let (host, session, log, _) = started_with("/goal ship the importer", Some("goal"), None, Vec::new());
        wait_for(|| !host.is_running(&session));
        let set = sent(&log, "thread/goal/set");
        assert_eq!(set.len(), 1);
        assert_eq!(set[0]["objective"], "ship the importer");
        assert!(sent(&log, "turn/start").is_empty());
        assert!(said(&host, &session).contains("Goal (active): ship the importer"), "{}", said(&host, &session));
    }

    /// `/goal` alone asks what the goal is.
    #[test]
    fn goal_alone_asks_for_the_goal() {
        let (host, session, log, _) = started_with("/goal", Some("goal"), None, Vec::new());
        wait_for(|| !host.is_running(&session));
        assert_eq!(sent(&log, "thread/goal/get").len(), 1);
        assert!(sent(&log, "thread/goal/set").is_empty());
        assert!(said(&host, &session).contains("No goal is set."), "{}", said(&host, &session));
    }

    /// `/mcp` lists the servers as a note.
    #[test]
    fn mcp_lists_the_servers_as_a_note_not_a_turn() {
        let (host, session, log, _) = started_with("/mcp", Some("mcp"), None, Vec::new());
        wait_for(|| !host.is_running(&session));
        // The thread's own read when it opened may add another.
        assert!(!sent(&log, "mcpServerStatus/list").is_empty());
        assert!(sent(&log, "turn/start").is_empty());
        assert!(said(&host, &session).contains("- crew: connected, 1 tool"), "{}", said(&host, &session));
    }

    fn mcp_state_of(host: &TurnHost, session: &str, name: &str) -> Option<crew_protocol::McpState> {
        host.mcp_list(session).expect("list").servers.into_iter().find(|server| server.name == name).map(|server| server.state)
    }

    /// The thread's servers are read when it opens and moved by the startup
    /// notices: one whose login ran out needs one, the rest are connected.
    #[test]
    fn the_servers_of_a_thread_are_read_when_it_opens_and_a_login_that_ran_out_is_told() {
        use crew_protocol::McpState::{Connected, NeedsAuth};
        let (host, session, log, _) = started("hello");
        wait_for(|| mcp_state_of(&host, &session, "sentry") == Some(NeedsAuth) && mcp_state_of(&host, &session, "crew") == Some(Connected));
        wait_for(|| !host.is_running(&session));
        let asked = sent(&log, "mcpServerStatus/list");
        assert_eq!(asked[0]["detail"], "toolsAndAuthOnly");
        assert!(asked[0]["threadId"].as_str().is_some_and(|id| !id.is_empty()), "{asked:?}");
        assert!(host.mcp_list(&session).expect("list").reported);
    }

    /// A login asks Codex for the page and hands it to the window as a URL;
    /// when Codex says it went through, the servers start again, and the
    /// server is connected.
    #[test]
    fn a_login_gives_the_page_and_the_servers_start_again_when_it_goes_through() {
        use crew_protocol::McpState::{Connected, NeedsAuth};
        let (host, session, log, _) = started("hello");
        wait_for(|| mcp_state_of(&host, &session, "sentry") == Some(NeedsAuth));
        wait_for(|| !host.is_running(&session));
        assert!(host.mcp_login(&session, "nothing").is_err());
        let sign_in = host.mcp_login(&session, "sentry").expect("login");
        assert_eq!(sign_in, crew_protocol::McpSignIn::Url { url: "https://auth.example/oauth?server=sentry".into() });
        let login = sent(&log, "mcpServer/oauth/login");
        assert_eq!(login.len(), 1);
        assert_eq!(login[0]["name"], "sentry");
        wait_for(|| sent(&log, "config/mcpServer/reload").len() == 1);
        wait_for(|| mcp_state_of(&host, &session, "sentry") == Some(Connected));
    }

    /// A login that did not go through leaves the server asking for one, with why.
    #[test]
    fn a_login_that_failed_leaves_the_server_needing_one_and_says_why() {
        use crew_protocol::McpState::NeedsAuth;
        let (host, session, log, _) = started("hello");
        wait_for(|| mcp_state_of(&host, &session, "sentry") == Some(NeedsAuth));
        // The reads the thread's opening asked for are over, or they would replace the error.
        wait_for(|| !host.is_running(&session) && !sent(&log, "mcpServerStatus/list").is_empty());
        host.codex_mcp_notice(&session, "mcpServer/oauthLogin/completed", &json!({ "name": "sentry", "success": false, "error": "the browser closed" }));
        let sentry = host.mcp_list(&session).expect("list").servers.into_iter().find(|server| server.name == "sentry").expect("sentry");
        assert_eq!((sentry.state, sentry.error.as_deref()), (NeedsAuth, Some("the browser closed")));
    }

    /// A command Crew has no method for is a turn like any other.
    #[test]
    fn a_command_with_no_method_goes_as_the_text_of_a_turn() {
        let (host, session, log, _) = started_with("/init now", Some("init"), None, Vec::new());
        wait_for(|| !host.is_running(&session));
        assert_eq!(sent(&log, "turn/start")[0]["input"][0]["text"], "/init now");
    }

    /// Codex says a skill file moved: the skills are read again while the
    /// turn runs, which the turn's own end-of-turn checks do not stop.
    #[test]
    fn a_skills_change_reads_the_skills_again_while_a_turn_runs() {
        let (host, session, log, cwd) = started("SLEEP 1");
        wait_for(|| host.commands().holds("codex", &cwd));
        host.handle_codex_line(&session, r#"{"method":"skills/changed","params":{}}"#);
        wait_for(|| sent(&log, "skills/list").len() == 2);
        std::thread::sleep(Duration::from_millis(100));
        let entries = host.commands_list(&session).expect("menu").entries;
        assert!(entries.iter().any(|entry| entry.name == "review-pr" && entry.kind == "skill"));
        wait_for(|| !host.is_running(&session));
    }

    /// A bot's Codex process keeps nothing: its menu is Crew's actions alone,
    /// whatever skills its folder has.
    #[test]
    fn a_bots_codex_process_keeps_nothing_in_the_catalog() {
        let (host, session, log, cwd) = started_as("bot", "hello");
        wait_for(|| sent(&log, "skills/list").len() == 1);
        wait_for(|| !host.is_running(&session));
        // The answer is read on the thread that asked, after the turn may have ended.
        std::thread::sleep(Duration::from_millis(100));
        assert!(!host.commands().holds("codex", &cwd));
        let entries = host.commands_list(&session).expect("menu").entries;
        assert!(entries.iter().all(|entry| entry.kind == "crew"), "{entries:?}");
    }

    /// With no catalog for its folder, a Codex session's menu is Crew's
    /// actions alone: nothing is asked for, as Codex has no probe yet.
    #[test]
    fn a_codex_session_with_no_catalog_lists_crew_actions_alone() {
        let host = TurnHost::test_new();
        let (session, cwd) = codex_session(&host, "terminal");
        let entries = host.commands_list(&session).expect("menu").entries;
        assert!(!entries.is_empty() && entries.iter().all(|entry| entry.kind == "crew"), "{entries:?}");
        assert!(!host.commands().holds("codex", &cwd));
    }

    /// Codex's commands are Crew's own and need no answer from it: a folder
    /// whose skills cannot be read still lists them, and no skills.
    #[test]
    fn a_folder_whose_skills_codex_cannot_read_still_lists_its_commands() {
        let (host, session, log, cwd) = started_prepared("terminal", "hello", None, None, Vec::new(), |log| {
            std::fs::write(format!("{}.no-skills", log.display()), "").expect("flag");
        });
        wait_for(|| host.commands().holds("codex", &cwd));
        wait_for(|| !host.is_running(&session));
        assert_eq!(sent(&log, "skills/list").len(), 1);
        let entries = host.commands_list(&session).expect("menu").entries;
        for name in ["compact", "goal", "review", "mcp"] {
            assert!(entries.iter().any(|entry| entry.name == name && entry.kind == "command"), "{name}: {entries:?}");
        }
        assert!(!entries.iter().any(|entry| entry.kind == "skill"), "{entries:?}");
    }

    /// A reload asks for the skills past Codex's cache and has its MCP servers
    /// start again, then says what the catalog holds.
    #[test]
    fn a_reload_asks_codex_for_its_skills_past_the_cache_and_for_its_servers_again() {
        let (host, session, log, cwd) = started("hello");
        wait_for(|| host.commands().holds("codex", &cwd));
        wait_for(|| !host.is_running(&session));
        let menu = host.commands_reload(&session).expect("reload");
        assert_eq!(sent(&log, "skills/list").last(), Some(&json!({ "cwds": [cwd], "forceReload": true })));
        assert_eq!(sent(&log, "config/mcpServer/reload").len(), 1);
        assert!(menu.entries.iter().any(|entry| entry.name == "review-pr" && entry.kind == "skill"), "{menu:?}");
        assert!(said(&host, &session).contains("Reloaded skills and MCP servers: 4 commands, 1 skill."), "{}", said(&host, &session));
    }

    /// With no app server up, its thread reads the skills as it opens: a
    /// reload has nothing to ask and says so.
    #[test]
    fn a_reload_with_no_codex_process_leaves_it_to_the_next_message() {
        let host = TurnHost::test_new();
        let (session, _) = codex_session(&host, "terminal");
        host.commands_reload(&session).expect("reload");
        assert!(said(&host, &session).contains("Codex reads its skills and servers when its thread opens"), "{}", said(&host, &session));
    }
}

#[cfg(test)]
mod child_tests {
    use super::catalog_tests::{codex_session, sent, started, wait_for};
    use super::*;
    use crew_protocol::{Block, BlockRole, ToolDetail, ToolStatus};

    const CHILD: &str = "child-thread-1";

    fn blocks(host: &TurnHost, session: &str) -> Vec<Block> {
        host.transcripts().since(session, 0).0
    }

    /// What the parent wrote: every assistant block of its message.
    fn written(host: &TurnHost, session: &str) -> Vec<String> {
        blocks(host, session).into_iter().filter(|block| block.role == BlockRole::Assistant).map(|block| block.text).collect()
    }

    /// The detail of the spawn call's row.
    fn spawn_call(host: &TurnHost, session: &str) -> ToolDetail {
        blocks(host, session)
            .into_iter()
            .find_map(|block| block.tool.filter(|tool| tool.call_id == "spawn-1"))
            .and_then(|tool| tool.detail)
            .expect("the spawn call")
    }

    fn entry(host: &TurnHost, session: &str) -> Option<crew_protocol::BackgroundCommand> {
        host.background_list(session).commands.into_iter().find(|row| row.id == CHILD)
    }

    /// The agent's words and calls are the steps of the call that spawned it,
    /// even those it said before the call named it; the parent's message is
    /// what the parent wrote, and the call's row says how it ended.
    #[test]
    fn a_spawned_agents_work_is_the_steps_of_its_call_and_none_of_the_parents_message() {
        let (host, session, _log, _) = started("SPAWN");
        wait_for(|| !host.is_running(&session));
        assert_eq!(written(&host, &session), ["report: SPAWN"]);
        let ToolDetail::Agent { description, prompt, background, state, output, activity, steps, .. } =
            spawn_call(&host, &session)
        else {
            panic!("the spawn call is not an agent row");
        };
        assert_eq!(description, "Reply with just the word one.");
        assert_eq!((prompt.as_deref(), background), (Some("Reply with just the word one."), Some(true)));
        assert_eq!((state, output.as_deref(), activity), (Some(SubagentState::Done), Some("one"), None));
        let steps = steps.expect("steps");
        let rows: Vec<(BlockRole, String)> = steps.iter().map(|step| (step.role.clone(), step.text.clone())).collect();
        assert_eq!(rows, [(BlockRole::Tool, "echo one".to_string()), (BlockRole::Assistant, "one".to_string())]);
        let call = steps[0].tool.as_ref().expect("its command");
        assert_eq!(call.status, ToolStatus::Completed);
    }

    /// The agent has an entry of its own, running from its spawn to its own
    /// turn's end, with the tokens its thread reported; and its turn ending
    /// does not end the parent's.
    #[test]
    fn a_spawned_agent_has_an_entry_that_ends_with_its_turn_and_leaves_the_parents_running() {
        let (host, session, _log, _) = started("SPAWN");
        wait_for(|| entry(&host, &session).is_some_and(|row| row.state == BackgroundState::Completed));
        assert!(host.is_running(&session), "the agent's turn ended, and the parent's with it");
        wait_for(|| !host.is_running(&session));
        let row = entry(&host, &session).expect("entry");
        assert_eq!((row.kind, row.state), (crew_protocol::BackgroundKind::Subagent, BackgroundState::Completed));
        assert_eq!((row.command.as_str(), row.description.as_deref()), ("Reply with just the word one.", Some("Ampere")));
        assert_eq!((row.tokens, row.window), (Some(4000), Some(100_000)));
        assert_eq!((row.thread_id.as_deref(), row.tool_call_id.as_deref()), (Some(CHILD), Some("spawn-1")));
        assert_eq!((row.model.as_deref(), row.stoppable, row.activity), (Some("gpt-5.6-luna"), Some(true), None));
        assert!(row.ended_at.is_some());
        assert_eq!(host.background_list(&session).commands.len(), 1, "the agent is no terminal");
    }

    /// Stopping the agent interrupts its turn on its own thread, not the
    /// parent's; the parent's turn goes on and ends when it says so.
    #[test]
    fn stopping_a_spawned_agent_interrupts_its_thread_and_not_the_parent() {
        let (host, session, log, _) = started("SPAWNHOLD");
        wait_for(|| entry(&host, &session).is_some_and(|row| row.tokens == Some(4000)));
        let row = entry(&host, &session).expect("entry");
        assert_eq!((row.state, row.window, row.activity.as_deref()), (BackgroundState::Running, Some(100_000), Some("echo one")));
        assert!(host.is_running(&session));
        let ToolDetail::Agent { state, steps, .. } = spawn_call(&host, &session) else {
            panic!("the spawn call is not an agent row");
        };
        assert_eq!(state, Some(SubagentState::Running));
        assert!(steps.is_some_and(|steps| steps.iter().any(|step| step.text == "on")));

        host.background_stop(&session, CHILD).expect("stop");
        assert_eq!(sent(&log, "turn/interrupt"), vec![json!({ "threadId": CHILD, "turnId": "child-turn-1" })]);
        wait_for(|| !host.is_running(&session));
        assert_eq!(entry(&host, &session).expect("entry").state, BackgroundState::Stopped);
        let ToolDetail::Agent { state, .. } = spawn_call(&host, &session) else {
            panic!("the spawn call is not an agent row");
        };
        assert_eq!(state, Some(SubagentState::Stopped));
        assert_eq!(written(&host, &session), ["report: SPAWNHOLD"]);
        assert_eq!(sent(&log, "turn/interrupt").len(), 1, "the parent was interrupted too");
    }

    /// An agent's approval is labelled as the agent's, and answered under the
    /// request it came with.
    #[test]
    fn an_agents_approval_says_whose_it_is_and_is_answered_on_its_own_request() {
        let (host, session, _log, _) = started("SPAWNREQUEST");
        wait_for(|| blocks(&host, &session).iter().any(|block| block.approval.as_ref().is_some_and(|ask| ask.decided.is_none())));
        let card = blocks(&host, &session).into_iter().find(|block| block.approval.is_some()).expect("card");
        assert_eq!(card.text, "Ampere: touch child.txt");
        let request = card.approval.expect("approval").request_id;
        host.codex_respond(&session, request, ApprovalDecision::Allow).expect("pending");
        wait_for(|| !host.is_running(&session));
        // The card sits between the parent's two pieces of one message.
        assert_eq!(written(&host, &session).concat(), "report: SPAWNREQUEST + child decision: accept");
    }

    /// A thread nothing has named is not shown: what it says waits for the
    /// call that spawns it, and then is the call's steps.
    #[test]
    fn what_a_thread_nobody_named_says_waits_for_its_call_and_is_never_the_parents() {
        let host = TurnHost::test_new();
        let (session, _) = codex_session(&host, "terminal");
        host.test_install_codex(&session);
        if let Some(Live::Codex(live)) = host.lock().get_mut(&session) {
            live.thread_id = Some("t1".into());
        }
        let said = json!({ "threadId": "t2", "turnId": "x", "itemId": "m", "delta": "hello" });
        host.codex_notification(&session, "item/agentMessage/delta", &said);
        assert!(blocks(&host, &session).is_empty());

        let call = json!({ "type": "collabAgentToolCall", "id": "c1", "tool": "spawnAgent", "status": "completed",
            "senderThreadId": "t1", "receiverThreadIds": ["t2"], "prompt": "do it", "model": "m", "agentsStates": {} });
        host.codex_notification(&session, "item/completed", &json!({ "threadId": "t1", "turnId": "x", "item": call }));
        let rows = blocks(&host, &session);
        assert_eq!(rows.len(), 1, "{rows:?}");
        let Some(ToolDetail::Agent { steps: Some(steps), .. }) = rows[0].tool.as_ref().and_then(|tool| tool.detail.clone()) else {
            panic!("{rows:?}");
        };
        assert_eq!(steps.iter().map(|step| step.text.as_str()).collect::<Vec<_>>(), ["hello"]);
        assert_eq!(host.background_list(&session).commands[0].id, "t2");
    }

    /// Codex settling a request itself closes its card whichever thread asked.
    #[test]
    fn codex_settling_an_agents_request_closes_its_card() {
        let host = TurnHost::test_new();
        let (session, _) = codex_session(&host, "terminal");
        host.test_install_codex(&session);
        let (tx, rx) = mpsc::channel();
        if let Some(Live::Codex(live)) = host.lock().get_mut(&session) {
            live.thread_id = Some("t1".into());
            live.approvals.insert(1, Pending { rpc_id: json!(7), tx });
        }
        host.codex_notification(&session, "serverRequest/resolved", &json!({ "threadId": "t2", "requestId": 7 }));
        assert!(matches!(rx.try_recv(), Ok(ApprovalResolution::Cancelled)));
    }
}
