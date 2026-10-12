//! The Cursor driver: one `cursor-agent acp` for a child's or the user's own
//! session, spoken to in the Agent Client Protocol over its stdio. The process
//! and its ACP session stay up between turns, as Claude's and Codex's do (see
//! `keeps_process`): a stop (`session/cancel`) leaves them, and the idle
//! release lets them go. A bot starts a clean process and session every turn,
//! with the tail Crew hands it. Cursor takes its model and its autonomy on
//! argv, so a change of either (or of the folder) launches another process,
//! which carries on the same ACP session with `session/load`. While the turn
//! runs, Crew can stop it and answer the permissions and questions it sends,
//! through the same events and cards as the other providers. Cursor takes
//! nothing into a running turn (no `session/steer`; a second prompt cancels
//! the first), so a message to it always waits for the turn to end.
//!
//! The protocol itself (params, updates, request shapes) is in
//! `providers/cursor.rs`.

use std::collections::{HashMap, HashSet};
use std::sync::atomic::Ordering;
use std::sync::mpsc::{self, RecvTimeoutError};
use std::thread;
use std::time::Duration;

use crew_protocol::{
    ApprovalDecision, ApprovalResolution, CommandEntry, ContextReading, HarnessEvent, ToolDetail, ToolStatus,
};
use serde_json::{json, Map, Value};
use tokio::sync::oneshot;

use super::{
    carries_conversation, conversation_to_resume, offers_fast, path_list, Harness, Launch, Live, QuestionReply,
    TurnHost, TurnOutcome, INIT_TIMEOUT, NEXT_EPOCH,
};
use crate::command_sources::{cursor_commands, cursor_plugin_skills, cursor_skill_bodies, with_skill_bodies};
use crate::providers::cursor::{
    authenticate_params, build_cursor_prompt, build_cursor_spawn_args, cancel_params, classify_request,
    initialize_params, mcp_servers, new_session_id, permission_answer, permission_response, plan_accepted,
    plan_detail, prompt_params, questions_cancelled, questions_response, rpc_error_message, session_request,
    read_store_context, tool_detail, tool_end, tool_label, tool_name, turn_end, unsupported_error, usage_update,
    AcpQuestion, AcpTool, CursorAsk, CursorSpawn, TurnEnd,
};
use crate::providers::{as_record, string_field, Autonomy};

/// How long logging in, and opening or loading a session, may take. A load
/// replays the whole conversation, and the user's own MCP servers start
/// alongside Crew's.
const OPEN_TIMEOUT: Duration = Duration::from_secs(90);
/// After `session/cancel`, how long the prompt may take to say it was
/// cancelled before its process is killed under it.
const INTERRUPT_GRACE: Duration = Duration::from_secs(if cfg!(test) { 2 } else { 3 });

/// How often the context meter is read from Cursor's store while a turn runs.
const CONTEXT_EVERY: Duration = Duration::from_secs(if cfg!(test) { 1 } else { 5 });

/// What a child whose `-p` chat could not come along is told, once, on the
/// turn that starts its new conversation (migration 27).
pub(crate) const ACP_NOTE: &str = "Cursor now runs over ACP: this session starts a new conversation.";

/// A request the agent is waiting on Crew for, by the id the UI knows.
struct Pending<T> {
    tx: mpsc::Sender<T>,
}

pub(super) struct CursorLive {
    /// Names the turn that is running, so the timer armed for it can tell
    /// when it is over.
    turn_epoch: u64,
    /// What the process was launched with, to tell on the next turn whether
    /// the session still asks for it. `None` where a test installed it.
    applied: Option<Launch>,
    /// The ACP session the process holds. It outlives the turn.
    acp_session: Option<String>,
    /// Cursor has said how full the context is (`usage_update`): its word is
    /// kept over what the store holds.
    usage_seen: bool,
    /// The folder the session was opened in, which its commands are for.
    cwd: String,
    autonomy: Autonomy,
    next_id: u64,
    /// Requests Crew sent, waiting for their answer.
    calls: HashMap<u64, mpsc::Sender<Result<Value, String>>>,
    /// The `session/prompt` in flight: its answer is the end of the turn.
    prompt_id: Option<u64>,
    /// The `session/load` in flight. The conversation it loads is replayed as
    /// updates before its answer; they are history, not this turn, and are
    /// not shown again.
    load_id: Option<u64>,
    approvals: HashMap<u64, Pending<ApprovalResolution>>,
    questions: HashMap<u64, Pending<QuestionReply>>,
    next_ui: u64,
    /// Every call the turn has seen, as its updates told it.
    tools: HashMap<String, AcpTool>,
    /// Calls with a row in the transcript.
    started: HashSet<String>,
    /// Calls with a row that has not ended. Cursor sends a cancelled call no
    /// last update, so a stop closes these itself.
    open: Vec<String>,
    /// The turn's checklist row, once it has one.
    plan_row: Option<String>,
    pub(super) active: bool,
    pub(super) cancelled: bool,
    pub(super) settled: bool,
    pub(super) turn_tx: Option<oneshot::Sender<TurnOutcome>>,
    pub(super) stderr: Vec<String>,
    pub(super) saw_output: bool,
}

impl CursorLive {
    pub(super) fn new(turn_tx: Option<oneshot::Sender<TurnOutcome>>, autonomy: Autonomy) -> Self {
        Self {
            turn_epoch: NEXT_EPOCH.fetch_add(1, Ordering::Relaxed),
            applied: None,
            acp_session: None,
            usage_seen: false,
            cwd: String::new(),
            autonomy,
            next_id: 1,
            calls: HashMap::new(),
            prompt_id: None,
            load_id: None,
            approvals: HashMap::new(),
            questions: HashMap::new(),
            next_ui: 1,
            tools: HashMap::new(),
            started: HashSet::new(),
            open: Vec::new(),
            plan_row: None,
            active: true,
            cancelled: false,
            settled: false,
            turn_tx,
            stderr: Vec::new(),
            saw_output: false,
        }
    }

    /// A turn starts on the process the last one left: what that turn knew of
    /// itself goes, what belongs to the process (its session, its folder, its
    /// request counters, the stderr tail) stays.
    fn begin_turn(&mut self, turn_tx: oneshot::Sender<TurnOutcome>) {
        self.turn_epoch = NEXT_EPOCH.fetch_add(1, Ordering::Relaxed);
        self.prompt_id = None;
        self.load_id = None;
        self.tools.clear();
        self.started.clear();
        self.open.clear();
        self.plan_row = None;
        self.active = true;
        self.cancelled = false;
        self.settled = false;
        self.turn_tx = Some(turn_tx);
        self.saw_output = false;
    }

    /// Whether the process runs as a launch now would run it: Cursor takes
    /// the model and the autonomy on argv, and the folder is the process's.
    fn runs_as(&self, now: &Launch) -> bool {
        self.applied
            .as_ref()
            .is_some_and(|had| had.model == now.model && had.autonomy == now.autonomy && had.cwd == now.cwd)
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

    /// The calls still open, closed as interrupted.
    fn close_open(&mut self) -> Vec<HarnessEvent> {
        std::mem::take(&mut self.open)
            .into_iter()
            .map(|call_id| HarnessEvent::ToolUpdated {
                call_id,
                title: None,
                status: Some(ToolStatus::Interrupted),
                detail: None,
            })
            .collect()
    }

    #[cfg(test)]
    pub(super) fn test_running(&mut self, acp_session: &str, prompt_id: u64, load_id: Option<u64>) {
        self.acp_session = Some(acp_session.to_string());
        self.prompt_id = Some(prompt_id);
        self.load_id = load_id;
        self.next_id = prompt_id.max(load_id.unwrap_or(0)) + 1;
    }
}

/// The process a turn runs on.
enum Process {
    /// The one the last turn left, with the ACP session it holds.
    Kept(String),
    /// One just started, and the MCP servers its session is opened with.
    Launched(Value),
}

/// The two texts a child's turn may open with: the job alone, to carry on a
/// conversation, or with the persona, to start one.
struct Texts {
    fresh: String,
    resumed: String,
}

impl TurnHost {
    /// Keeps a folder's Cursor commands in the catalog, as the Claude path
    /// keeps its menu. A bot's process keeps nothing: its persona must not see
    /// the user's commands.
    fn cursor_catalog(&self, session_id: &str, cwd: &str, entries: Vec<CommandEntry>) {
        let bot = crate::session::get(&self.store, session_id.to_string())
            .ok()
            .flatten()
            .is_some_and(|session| session.kind == "bot");
        if bot {
            return;
        }
        // `cursor-agent acp` loads no plugin skill, so the ones Crew reads from
        // the plugin cache are listed beside its commands. A command of the same
        // name is Cursor's own and wins.
        let plugins: Vec<crew_protocol::CommandEntry> = self
            .cursor_plugin_dir()
            .map(|dir| cursor_plugin_skills(&dir))
            .unwrap_or_default()
            .into_iter()
            .filter(|skill| !entries.iter().any(|entry| entry.name == skill.name))
            .collect();
        let skills: HashSet<String> = plugins.iter().map(|skill| skill.name.clone()).collect();
        let entries: Vec<crew_protocol::CommandEntry> = entries.into_iter().chain(plugins).collect();
        let actions = crate::commands::crew_actions(offers_fast("cursor"));
        self.commands().learn_for_session(session_id, "cursor", cwd, Some(entries), Some(skills), actions);
    }

    /// Where Cursor keeps its installed plugins: the folder a test put them in,
    /// or `~/.cursor/plugins/cache`.
    fn cursor_plugin_dir(&self) -> Option<std::path::PathBuf> {
        self.cursor_plugins.lock().unwrap_or_else(|e| e.into_inner()).clone().or_else(|| {
            std::env::var_os("HOME")
                .filter(|home| !home.is_empty())
                .map(|home| std::path::Path::new(&home).join(".cursor").join("plugins").join("cache"))
        })
    }

    /// The text a Cursor turn sends for a message: the instructions of the
    /// plugin skills it names go ahead of it, since Cursor's ACP loads none. A
    /// command is the whole message, as it is for Codex, so it gets none.
    fn cursor_skill_text(&self, text: &str, command: Option<&str>, names: &[String]) -> String {
        match self.cursor_plugin_dir() {
            Some(dir) if command.is_none() => with_skill_bodies(text, &cursor_skill_bodies(&dir, names)),
            _ => text.to_string(),
        }
    }

    pub(super) fn run_cursor(
        &self,
        session: crate::session::Session,
        mut params: crew_protocol::TurnStart,
        history: Option<String>,
    ) -> TurnOutcome {
        let session_id = session.id.clone();
        let (tx, turn_rx) = oneshot::channel();
        let autonomy = self.autonomy(&session);
        let kept = self.cursor_arm(&session, &params.cwd, tx);
        self.watch_for_silence(&session_id);
        // A stop that came before the CLI was there to take it.
        if self.stop_requested(&session_id) {
            self.signal(&session_id, TurnOutcome::Stopped);
            self.park(&session, kept.is_some());
            return TurnOutcome::Stopped;
        }
        let mcp = self.mcp();
        let carries = carries_conversation(&session);
        let resume = conversation_to_resume(&session);
        // No system channel: the persona and the tool sheet are the first
        // user message of a conversation, a bot's every turn.
        let persona = self.persona(&session, Harness::Cursor, mcp.is_some(), &params.cwd);
        params.text = self.cursor_skill_text(&params.text, params.command.as_deref(), params.skills.as_deref().unwrap_or_default());
        let texts = if carries {
            Texts {
                fresh: self.child_prompt(persona.as_deref(), false, &params),
                resumed: self.child_prompt(persona.as_deref(), true, &params),
            }
        } else {
            let text = build_cursor_prompt(persona.as_deref().unwrap_or_default(), history.as_deref(), &params.text, &path_list(&params, &HashSet::new()));
            Texts { fresh: text.clone(), resumed: text }
        };
        let process = match kept {
            // The process the last turn left has the session open.
            Some(acp_session) => Ok(Process::Kept(acp_session)),
            None => self.cursor_launch(&session, &params.cwd, autonomy, mcp.as_ref()).map(Process::Launched),
        };
        let migrated = carries && resume.is_none() && self.acp_note_pending(&session_id);
        let outcome = match process
            .and_then(|process| self.cursor_open(&session_id, &params.cwd, resume.as_deref(), process, &texts, migrated))
        {
            Ok(()) => {
                self.cursor_context_timer(&session_id);
                self.block_on(turn_rx).unwrap_or(TurnOutcome::Failed("Turn channel closed".into()))
            }
            Err(_) if self.stop_requested(&session_id) => TurnOutcome::Stopped,
            Err(error) => TurnOutcome::Failed(error),
        };
        // What the turn spent, now that Cursor has written it down.
        self.cursor_context(&session_id);
        // The process is clean when the prompt was answered, which a
        // `cancelled` is too: Cursor has closed the turn it was asked to stop.
        // One that never answered (the grace ran out, or it was not asked) is
        // left in a state nobody vouches for.
        let closed = match self.lock().get_mut(&session_id) {
            Some(Live::Cursor(live)) => {
                live.release();
                live.prompt_id.is_none() && live.acp_session.is_some()
            }
            _ => false,
        };
        let clean = closed && !matches!(outcome, TurnOutcome::Failed(_));
        self.park(&session, clean);
        outcome
    }

    /// Gives the turn its state on the process the last one left, when there
    /// is one alive, idle and launched as the session asks now, and otherwise
    /// on an entry of its own for the process [`TurnHost::cursor_launch`]
    /// starts. Returns the ACP session the kept process holds.
    fn cursor_arm(&self, session: &crate::session::Session, cwd: &str, tx: oneshot::Sender<TurnOutcome>) -> Option<String> {
        let session_id = session.id.as_str();
        let applied = self.applied(session, cwd);
        // Asked before the lock: a process that died while idle without its
        // exit being heard (it was killed under us) is not one to write to.
        let alive = self.agents.running().iter().any(|id| id == session_id);
        let tx = {
            let mut map = self.lock();
            match map.get_mut(session_id) {
                // The session Crew carries on is the one the process holds:
                // a row whose conversation was cleared or changed since asks
                // for another.
                Some(Live::Cursor(live))
                    if alive
                        && live.settled
                        && live.prompt_id.is_none()
                        && live.acp_session.is_some()
                        && live.acp_session == conversation_to_resume(session)
                        && live.runs_as(&applied) =>
                {
                    live.begin_turn(tx);
                    let acp_session = live.acp_session.clone();
                    drop(map);
                    self.idle.lock().unwrap_or_else(|e| e.into_inner()).remove(session_id);
                    return acp_session;
                }
                _ => tx,
            }
        };
        // Another launch on the same ACP session: its `session/load` follows.
        self.agents.kill(session_id);
        let mut live = CursorLive::new(Some(tx), self.autonomy(session));
        live.applied = Some(applied);
        self.lock().insert(session_id.to_string(), Live::Cursor(Box::new(live)));
        self.idle.lock().unwrap_or_else(|e| e.into_inner()).remove(session_id);
        None
    }

    /// Starts `cursor-agent acp` for the turn. Returns the MCP servers the
    /// session is opened with; the handshake is [`TurnHost::cursor_open`]'s.
    fn cursor_launch(
        &self,
        session: &crate::session::Session,
        cwd: &str,
        autonomy: Autonomy,
        mcp: Option<&(String, Vec<String>)>,
    ) -> Result<Value, String> {
        let session_id = session.id.as_str();
        let path = self.resolve_bin("cursor-agent")?;
        // Minted once and used twice: the agent's own shell gets it, and so
        // does the MCP server cursor starts for it. A second mint would
        // retire the first, and this process lives across turns, so nothing
        // mints again until it is replaced.
        let env = self.agent_env(session_id);
        let mut mcp_env: Vec<(String, String)> = env.clone().into_iter().collect();
        mcp_env.sort();
        let args = build_cursor_spawn_args(&CursorSpawn {
            model: Some(session.model.clone()).filter(|m| !m.is_empty()),
            autonomy,
        });
        self.agents.spawn(session_id.to_string(), path, args, cwd.to_string(), Some(env))?;
        Ok(mcp_servers(mcp, &mcp_env))
    }

    fn acp_note_pending(&self, session_id: &str) -> bool {
        crate::store::get(&self.store, format!("{}{session_id}", crate::store::CURSOR_ACP_NOTE))
            .ok()
            .flatten()
            .is_some()
    }

    /// The handshake, the session, and the prompt. Returns once the prompt is
    /// sent; its answer is the end of the turn. A kept process has done the
    /// first two: its session carries on, and takes the prompt as it is.
    fn cursor_open(
        &self,
        session_id: &str,
        cwd: &str,
        resume: Option<&str>,
        process: Process,
        texts: &Texts,
        migrated: bool,
    ) -> Result<(), String> {
        let servers = match process {
            Process::Kept(acp_session) => return self.cursor_prompt(session_id, &acp_session, &texts.resumed, false, false),
            Process::Launched(servers) => servers,
        };
        let servers = &servers;
        // Set before the session exists: its commands can come as soon as it does.
        if let Some(Live::Cursor(live)) = self.lock().get_mut(session_id) {
            live.cwd = cwd.to_string();
        }
        self.cursor_call(session_id, "initialize", initialize_params(), INIT_TIMEOUT, false)
            .map_err(|error| self.cursor_failure(session_id, "Cursor Agent did not start", &error))?;
        self.cursor_call(session_id, "authenticate", authenticate_params(), OPEN_TIMEOUT, false)
            .map_err(|error| {
                self.cursor_failure(
                    session_id,
                    "Cursor Agent could not log in (run `cursor-agent login` in a terminal)",
                    &error,
                )
            })?;
        let mut text = &texts.resumed;
        let mut acp_session = None;
        if let Some(id) = resume {
            let (method, params) = session_request(cwd, Some(id), servers);
            match self.cursor_call(session_id, method, params, OPEN_TIMEOUT, true) {
                Ok(_) => acp_session = Some(id.to_string()),
                Err(_) if self.stop_requested(session_id) => return Err("cancelled".into()),
                // A conversation cursor no longer has is not the end of the
                // session: it starts another, and says so.
                Err(error) => {
                    let message = format!("Cursor could not load this session's conversation ({error}): it starts a new one.");
                    self.transcripts.apply(session_id, HarnessEvent::SessionNote { message });
                }
            }
        }
        let opened = acp_session.is_some();
        let acp_session = match acp_session {
            Some(id) => id,
            None => {
                text = &texts.fresh;
                let (method, params) = session_request(cwd, None, servers);
                let created = self
                    .cursor_call(session_id, method, params, OPEN_TIMEOUT, false)
                    .map_err(|error| self.cursor_failure(session_id, "Cursor Agent could not open a session", &error))?;
                new_session_id(&created).ok_or_else(|| "Cursor Agent opened no session.".to_string())?
            }
        };
        if let Some(Live::Cursor(live)) = self.lock().get_mut(session_id) {
            live.acp_session = Some(acp_session.clone());
        }
        self.cursor_prompt(session_id, &acp_session, text, migrated, opened)
    }

    /// The session is open: it is bound to Crew's, and the prompt goes in.
    fn cursor_prompt(&self, session_id: &str, acp_session: &str, text: &str, migrated: bool, opened: bool) -> Result<(), String> {
        self.transcripts.apply(
            session_id,
            HarnessEvent::SessionProviderBound {
                provider_session_id: acp_session.to_string(),
            },
        );
        self.transcripts.apply(session_id, HarnessEvent::SessionStarted {});
        if migrated && !opened {
            self.transcripts.apply(session_id, HarnessEvent::SessionNote { message: ACP_NOTE.into() });
            let _ = crate::store::delete(&self.store, format!("{}{session_id}", crate::store::CURSOR_ACP_NOTE));
        }
        if self.stop_requested(session_id) {
            return Err("cancelled".into());
        }
        let id = {
            let mut map = self.lock();
            let Some(Live::Cursor(live)) = map.get_mut(session_id) else {
                return Err("Cursor Agent is not running.".into());
            };
            let id = live.next_id;
            live.next_id += 1;
            live.prompt_id = Some(id);
            id
        };
        let line = json!({ "jsonrpc": "2.0", "id": id, "method": "session/prompt", "params": prompt_params(acp_session, text) });
        self.agents.write(session_id, &line.to_string())?;
        // The prompt is in Cursor's hands: its letters are read.
        self.confirm_carried(session_id);
        Ok(())
    }

    /// Reads how full the session's context is from Cursor's store and tells
    /// the meter, unless Cursor has said so itself (`usage_update`).
    fn cursor_context(&self, session_id: &str) {
        let acp_session = match self.lock().get(session_id) {
            Some(Live::Cursor(live)) if !live.usage_seen => live.acp_session.clone(),
            _ => return,
        };
        let Some(acp_session) = acp_session else {
            return;
        };
        let dir = self
            .cursor_acp_sessions
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .clone()
            .or_else(|| {
                std::env::var_os("HOME")
                    .filter(|home| !home.is_empty())
                    .map(|home| std::path::Path::new(&home).join(".cursor").join("acp-sessions"))
            });
        let Some((used, window)) = dir.and_then(|dir| read_store_context(&dir, &acp_session)) else {
            return;
        };
        self.publish_context(session_id, |_| Some(ContextReading { used, window, auto_compact_at: None, stale: None }));
    }

    /// The meter while the turn runs: the store is read again every
    /// [`CONTEXT_EVERY`] until the turn is over.
    fn cursor_context_timer(&self, session_id: &str) {
        let epoch = match self.lock().get(session_id) {
            Some(Live::Cursor(live)) => live.turn_epoch,
            _ => return,
        };
        self.cursor_context_tick(session_id, epoch);
    }

    fn cursor_context_tick(&self, session_id: &str, epoch: u64) {
        let host = self.clone();
        let id = session_id.to_string();
        self.after(CONTEXT_EVERY, move || {
            let running = matches!(
                host.lock().get(&id),
                Some(Live::Cursor(live)) if live.turn_epoch == epoch && live.active && !live.settled
            );
            if running {
                host.cursor_context(&id);
                host.cursor_context_tick(&id, epoch);
            }
        });
    }

    /// An error from the handshake, with what Cursor said on stderr.
    fn cursor_failure(&self, session_id: &str, head: &str, error: &str) -> String {
        let stderr = match self.lock().get(session_id) {
            Some(Live::Cursor(live)) => live.stderr.join("\n"),
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
    /// answer arrives on the agent's reader, which never waits on this. A
    /// `load` mutes the updates until its answer: they replay history.
    fn cursor_call(&self, session_id: &str, method: &str, params: Value, timeout: Duration, load: bool) -> Result<Value, String> {
        let (tx, rx) = mpsc::channel();
        let id = {
            let mut map = self.lock();
            let Some(Live::Cursor(live)) = map.get_mut(session_id) else {
                return Err("Cursor Agent is not running.".into());
            };
            let id = live.next_id;
            live.next_id += 1;
            live.calls.insert(id, tx);
            if load {
                live.load_id = Some(id);
            }
            id
        };
        let forget = || {
            if let Some(Live::Cursor(live)) = self.lock().get_mut(session_id) {
                live.calls.remove(&id);
                if live.load_id == Some(id) {
                    live.load_id = None;
                }
            }
        };
        let line = json!({ "jsonrpc": "2.0", "id": id, "method": method, "params": params }).to_string();
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

    fn cursor_reply(&self, session_id: &str, rpc_id: &Value, result: Value) {
        let _ = self
            .agents
            .write(session_id, &json!({ "jsonrpc": "2.0", "id": rpc_id, "result": result }).to_string());
    }

    fn cursor_reply_error(&self, session_id: &str, rpc_id: &Value, error: Value) {
        let _ = self
            .agents
            .write(session_id, &json!({ "jsonrpc": "2.0", "id": rpc_id, "error": error }).to_string());
    }

    /// Stop a Cursor turn: `session/cancel`, and the turn ends when the
    /// prompt answers `cancelled`, or after [`INTERRUPT_GRACE`] whatever it
    /// says. The process stays when the prompt did answer (the turn's end
    /// parks it, as Codex's), and goes when it did not. Returns false when
    /// there was no prompt to cancel, and the caller settles it at once.
    pub(super) fn cursor_interrupt(&self, session_id: &str) -> bool {
        let (target, closed, epoch) = {
            let mut map = self.lock();
            let Some(Live::Cursor(live)) = map.get_mut(session_id) else {
                return false;
            };
            let running = live.active && !live.cancelled && !live.settled && live.prompt_id.is_some();
            let target = running.then(|| live.acp_session.clone()).flatten();
            live.cancelled = true;
            // What it asked is answered `cancelled` by the threads waiting on
            // it; the cards close now.
            for (_, pending) in live.approvals.drain() {
                let _ = pending.tx.send(ApprovalResolution::Cancelled);
            }
            for (_, pending) in live.questions.drain() {
                let _ = pending.tx.send(QuestionReply::Cancelled);
            }
            // The call in flight gets no last update from Cursor.
            (target, live.close_open(), live.turn_epoch)
        };
        for event in closed {
            self.transcripts.apply(session_id, event);
        }
        let Some(acp_session) = target else {
            return false;
        };
        let line = json!({ "jsonrpc": "2.0", "method": "session/cancel", "params": cancel_params(&acp_session) });
        if self.agents.write(session_id, &line.to_string()).is_err() {
            return false;
        }
        let host = self.clone();
        let id = session_id.to_string();
        self.after(INTERRUPT_GRACE, move || {
            // Only the turn it was armed for: the process goes on to others.
            let open = matches!(host.lock().get(&id), Some(Live::Cursor(live)) if live.turn_epoch == epoch && !live.settled);
            if open {
                host.signal(&id, TurnOutcome::Stopped);
            }
        });
        true
    }

    pub(super) fn cursor_respond(&self, session_id: &str, request_id: u64, decision: ApprovalDecision) -> Option<()> {
        let mut map = self.lock();
        let Some(Live::Cursor(live)) = map.get_mut(session_id) else {
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

    pub(super) fn cursor_answer(&self, session_id: &str, request_id: u64, answers: Option<super::Answers>) -> Option<()> {
        let mut map = self.lock();
        let Some(Live::Cursor(live)) = map.get_mut(session_id) else {
            return None;
        };
        let pending = live.questions.remove(&request_id)?;
        let _ = pending.tx.send(match answers {
            Some(answers) => QuestionReply::Answers(answers),
            None => QuestionReply::Dismiss,
        });
        Some(())
    }

    pub(crate) fn handle_cursor_line(&self, session_id: &str, line: &str) {
        let Ok(message) = serde_json::from_str::<Value>(line) else {
            return;
        };
        let method = message.get("method").and_then(Value::as_str);
        // Cursor numbers its own requests from 0: an id of 0 is an id.
        let id = message.get("id").filter(|id| !id.is_null());
        let params = message.get("params").cloned().unwrap_or(Value::Null);
        match (method, id) {
            (None, Some(id)) => self.cursor_response(session_id, id, &message),
            (Some(method), Some(id)) => self.cursor_request(session_id, id.clone(), method, params),
            (Some(method), None) => self.cursor_notification(session_id, method, &params),
            _ => {}
        }
    }

    fn cursor_response(&self, session_id: &str, id: &Value, message: &Value) {
        let Some(id) = id.as_u64() else {
            return;
        };
        let answer = match message.get("error") {
            Some(error) if !error.is_null() => Err(rpc_error_message(error)),
            _ => Ok(message.get("result").cloned().unwrap_or(Value::Null)),
        };
        let mut events = Vec::new();
        let mut outcome = None;
        let waiter = {
            let mut map = self.lock();
            let Some(Live::Cursor(live)) = map.get_mut(session_id) else {
                return;
            };
            if live.load_id == Some(id) {
                live.load_id = None;
            }
            if live.prompt_id == Some(id) {
                live.prompt_id = None;
                if !live.settled {
                    outcome = Some(match &answer {
                        Err(error) => TurnOutcome::Failed(error.clone()),
                        Ok(_) if live.cancelled => {
                            events.extend(live.close_open());
                            TurnOutcome::Stopped
                        }
                        Ok(result) => match turn_end(result) {
                            TurnEnd::Cancelled => {
                                events.extend(live.close_open());
                                TurnOutcome::Stopped
                            }
                            TurnEnd::Failed(message) => TurnOutcome::Failed(message),
                            TurnEnd::Completed(note) => {
                                events.push(HarnessEvent::MessageCompleted {});
                                if let Some(message) = note {
                                    events.push(HarnessEvent::SessionNote { message });
                                }
                                events.push(HarnessEvent::TurnCompleted { usage: None });
                                TurnOutcome::Completed
                            }
                        },
                    });
                }
                None
            } else {
                live.calls.remove(&id)
            }
        };
        for event in events {
            self.transcripts.apply(session_id, event);
        }
        if let Some(outcome) = outcome {
            self.signal(session_id, outcome);
        }
        if let Some(waiter) = waiter {
            let _ = waiter.send(answer);
        }
    }

    fn cursor_request(&self, session_id: &str, rpc_id: Value, method: &str, params: Value) {
        let (ask, cancelled) = {
            let map = self.lock();
            let Some(Live::Cursor(live)) = map.get(session_id) else {
                return;
            };
            (
                classify_request(method, &params, &live.tools, &live.autonomy),
                live.cancelled || live.settled,
            )
        };
        match ask {
            CursorAsk::Unsupported => self.cursor_reply_error(session_id, &rpc_id, unsupported_error(method)),
            CursorAsk::Allow(option) => self.cursor_reply(session_id, &rpc_id, permission_response(Some(&option))),
            CursorAsk::Plan { call_id, title, text } => {
                self.cursor_reply(session_id, &rpc_id, plan_accepted());
                if !text.trim().is_empty() {
                    self.cursor_plan(session_id, call_id, title, text);
                }
            }
            CursorAsk::Approval { .. } if cancelled => {
                self.cursor_reply(session_id, &rpc_id, permission_response(None))
            }
            CursorAsk::Questions(_) if cancelled => self.cursor_reply(session_id, &rpc_id, questions_cancelled()),
            CursorAsk::Questions(questions) if questions.is_empty() => {
                self.cursor_reply(session_id, &rpc_id, questions_response(&questions, None))
            }
            CursorAsk::Approval { name, title, input, allow, reject } => {
                let host = self.clone();
                let session_id = session_id.to_string();
                thread::spawn(move || {
                    host.cursor_approval_wait(&session_id, rpc_id, name, title, input, allow, reject)
                });
            }
            CursorAsk::Questions(questions) => {
                let host = self.clone();
                let session_id = session_id.to_string();
                thread::spawn(move || host.cursor_question_wait(&session_id, rpc_id, questions));
            }
        }
    }

    /// A plan Cursor wrote (plan mode): on the row of the call that made it.
    fn cursor_plan(&self, session_id: &str, call_id: Option<String>, title: String, text: String) {
        let detail = Some(ToolDetail::Plan { text });
        let event = {
            let mut map = self.lock();
            let Some(Live::Cursor(live)) = map.get_mut(session_id) else {
                return;
            };
            let call_id = call_id.unwrap_or_else(|| format!("plan-{}", live.next_ui));
            if live.started.insert(call_id.clone()) {
                HarnessEvent::ToolStarted { call_id, name: "plan".into(), title, detail }
            } else {
                HarnessEvent::ToolUpdated { call_id, title: Some(title), status: None, detail }
            }
        };
        self.transcripts.apply(session_id, event);
    }

    #[allow(clippy::too_many_arguments)]
    fn cursor_approval_wait(
        &self,
        session_id: &str,
        rpc_id: Value,
        name: String,
        title: String,
        input: Value,
        allow: Option<String>,
        reject: Option<String>,
    ) {
        let (tx, rx) = mpsc::channel();
        let ui_id = {
            let mut map = self.lock();
            let Some(Live::Cursor(live)) = map.get_mut(session_id) else {
                return;
            };
            let ui_id = live.next_ui;
            live.next_ui += 1;
            live.approvals.insert(ui_id, Pending { tx });
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
            ApprovalResolution::Cancelled => {
                self.cursor_reply(session_id, &rpc_id, permission_response(None));
                return;
            }
            ApprovalResolution::Allow => ApprovalDecision::Allow,
            ApprovalResolution::Always => ApprovalDecision::Always,
            ApprovalResolution::Deny => ApprovalDecision::Deny,
        };
        self.transcripts.set_status(session_id, "working", None);
        self.cursor_reply(session_id, &rpc_id, permission_answer(&decided, allow.as_deref(), reject.as_deref()));
    }

    fn cursor_question_wait(&self, session_id: &str, rpc_id: Value, questions: Vec<AcpQuestion>) {
        let (tx, rx) = mpsc::channel();
        let ui_id = {
            let mut map = self.lock();
            let Some(Live::Cursor(live)) = map.get_mut(session_id) else {
                return;
            };
            let ui_id = live.next_ui;
            live.next_ui += 1;
            live.questions.insert(ui_id, Pending { tx });
            ui_id
        };
        let shown: Vec<crew_protocol::Question> = questions.iter().map(|asked| asked.question.clone()).collect();
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
        let answers = match rx.recv().unwrap_or(QuestionReply::Cancelled) {
            QuestionReply::Cancelled => {
                self.transcripts.apply(
                    session_id,
                    HarnessEvent::QuestionResolved {
                        request_id: ui_id,
                        answers: None,
                    },
                );
                self.cursor_reply(session_id, &rpc_id, questions_cancelled());
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
        self.cursor_reply(session_id, &rpc_id, questions_response(&questions, answers.as_ref()));
    }

    fn cursor_notification(&self, session_id: &str, method: &str, params: &Value) {
        if method != "session/update" {
            return;
        }
        let Some(update) = params.get("update").and_then(as_record) else {
            return;
        };
        // The menu belongs to the session, not the turn: a load's replay and a
        // turn already over may both bring it, and it is kept either way.
        if string_field(Some(update), "sessionUpdate").as_deref() == Some("available_commands_update") {
            let cwd = match self.lock().get(session_id) {
                Some(Live::Cursor(live)) => live.cwd.clone(),
                _ => return,
            };
            self.cursor_catalog(session_id, &cwd, cursor_commands(params.get("update").unwrap_or(&Value::Null)));
            return;
        }
        // How full the context is: Cursor's own word, when it gives it, is
        // kept over the store's.
        if string_field(Some(update), "sessionUpdate").as_deref() == Some("usage_update") {
            if let Some((used, window)) = usage_update(update) {
                if let Some(Live::Cursor(live)) = self.lock().get_mut(session_id) {
                    live.usage_seen = true;
                }
                self.publish_context(session_id, |_| Some(ContextReading { used, window, auto_compact_at: None, stale: None }));
            }
            return;
        }
        let mut events = Vec::new();
        {
            let mut map = self.lock();
            let Some(Live::Cursor(live)) = map.get_mut(session_id) else {
                return;
            };
            // History a load replays, or a turn already over.
            if live.load_id.is_some() || live.cancelled || live.settled {
                return;
            }
            cursor_update(live, update, &mut events);
        }
        for event in events {
            self.transcripts.apply(session_id, event);
        }
    }
}

/// One `session/update` of the turn: text, thought, a call, a checklist.
fn cursor_update(live: &mut CursorLive, update: &Map<String, Value>, events: &mut Vec<HarnessEvent>) {
    let text = || {
        update
            .get("content")
            .and_then(as_record)
            .filter(|content| string_field(Some(content), "type").as_deref() == Some("text"))
            .and_then(|content| content.get("text"))
            .and_then(Value::as_str)
            .filter(|text| !text.is_empty())
            .map(str::to_string)
    };
    match string_field(Some(update), "sessionUpdate").as_deref() {
        Some("agent_message_chunk") => {
            if let Some(text) = text() {
                events.push(HarnessEvent::MessageDelta { text });
            }
        }
        Some("agent_thought_chunk") => {
            if let Some(text) = text() {
                events.push(HarnessEvent::ReasoningDelta { text });
            }
        }
        Some(kind @ ("tool_call" | "tool_call_update")) => {
            let Some(id) = string_field(Some(update), "toolCallId") else {
                return;
            };
            let tool = live.tools.entry(id.clone()).or_insert_with(|| AcpTool::new(&id));
            let renamed = update.contains_key("title") || update.contains_key("rawInput");
            tool.merge(update);
            let tool = tool.clone();
            let status = string_field(Some(update), "status").unwrap_or_default();
            let output = update.get("rawOutput").and_then(as_record);
            let content = update.get("content");
            // A call that opens as a placeholder (`MCP: tool`, `Edit File`)
            // gets its row once it says what it is, or once it runs.
            let ready = tool.named() || matches!(status.as_str(), "in_progress" | "completed" | "failed");
            if !live.started.contains(&id) {
                if !ready {
                    return;
                }
                live.started.insert(id.clone());
                live.open.push(id.clone());
                events.push(HarnessEvent::ToolStarted {
                    call_id: id.clone(),
                    name: tool_name(&tool),
                    title: tool_label(&tool),
                    detail: tool_detail(&tool, output, content),
                });
            } else if renamed && kind == "tool_call_update" {
                events.push(HarnessEvent::ToolUpdated {
                    call_id: id.clone(),
                    title: Some(tool_label(&tool)),
                    status: None,
                    detail: tool_detail(&tool, output, content),
                });
            }
            if let Some(end) = tool_end(&status, output) {
                live.open.retain(|open| *open != id);
                events.push(HarnessEvent::ToolUpdated {
                    call_id: id,
                    title: None,
                    status: Some(end),
                    detail: tool_detail(&tool, output, content),
                });
            }
        }
        Some("plan") => {
            let Some(detail) = plan_detail(update) else {
                return;
            };
            match &live.plan_row {
                Some(call_id) => events.push(HarnessEvent::ToolUpdated {
                    call_id: call_id.clone(),
                    title: None,
                    status: None,
                    detail: Some(detail),
                }),
                None => {
                    let call_id = format!("todos-{}", uuid::Uuid::new_v4().simple());
                    live.plan_row = Some(call_id.clone());
                    events.push(HarnessEvent::ToolStarted {
                        call_id,
                        name: "todo".into(),
                        title: "Todos".into(),
                        detail: Some(detail),
                    });
                }
            }
        }
        // `user_message_chunk` only comes in a load's replay; titles, modes
        // and commands are the CLI's business.
        _ => {}
    }
}

/// A stand-in for `cursor-agent acp` 2026.10.01 that speaks the part of the
/// protocol Crew uses: the handshake, `session/new` and `session/load` (which
/// replays the conversation first, as Cursor's does), `session/prompt`,
/// `session/cancel`, and the agent's own permission, question and plan
/// requests, numbered from 0. Every message it gets is appended to the log as
/// `{method, params}` (an answer as `{answer, result}`), after a first line
/// with its argv and env. Conversations persist beside the log, so a later
/// process can load them.
///
/// A new session sends its `available_commands_update` (`create_plan`,
/// `clear`) after its answer. What a turn does is spelled in its last line:
/// `SLEEP <s>` runs a command that long, `ASK` asks to run one, `MCP` calls
/// Crew's `list_peers`, `QUESTION` asks which color, `PLAN` writes a plan,
/// `FAIL` fails the prompt, `STUBBORN` ignores a cancel, `USAGE` sends a
/// `usage_update`, `COMMANDS` announces another command. It answers `report:
/// <last line>`, with ` + <what it heard>` for each request answered.
///
/// It keeps a `store.db` per session, as Cursor does, in
/// `fake-cursor-<tag>-acp/<session>/` beside the log, of a window of 256,000:
/// a turn that is the n-th of its session reads 2000 (n - 1) + 1000 tokens
/// when it starts and 2000 n when it ends.
#[cfg(test)]
pub(crate) fn fake_cursor(dir: &std::path::Path) -> (String, std::path::PathBuf) {
    // The script finds its log and session store from the name it was started
    // by: `fake-cursor-agent-<tag>` keeps `fake-cursor-<tag>.log` and
    // `fake-cursor-<tag>-sessions` beside it.
    let tag = uuid::Uuid::new_v4().simple().to_string();
    let log = dir.join(format!("fake-cursor-{tag}.log"));
    let script = r##"#!/usr/bin/env python3
import hashlib, json, os, re, sqlite3, sys, threading, time, uuid
HERE = os.path.dirname(os.path.abspath(sys.argv[0]))
TAG = os.path.basename(sys.argv[0])[len("fake-cursor-agent-"):]
LOG = os.path.join(HERE, "fake-cursor-" + TAG + ".log")
STORE = os.path.join(HERE, "fake-cursor-" + TAG + "-sessions")
ACP = os.path.join(HERE, "fake-cursor-" + TAG + "-acp")
os.makedirs(STORE, exist_ok=True)
lock = threading.Lock()
def out(m):
    m["jsonrpc"] = "2.0"
    with lock:
        sys.stdout.write(json.dumps(m) + "\n"); sys.stdout.flush()
def log(m):
    with open(LOG, "a") as f: f.write(json.dumps(m) + "\n")
log({"argv": sys.argv[1:], "env": {k: os.environ.get(k) for k in ["CREW_SOCKET", "CREW_TOKEN"]}})
state = {"next": 0, "turn": None}
answers = {}
def update(sid, u):
    out({"method": "session/update", "params": {"sessionId": sid, "update": u}})
def ask(method, params):
    with lock:
        rid = state["next"]; state["next"] += 1
        answers[rid] = threading.Event()
    out({"id": rid, "method": method, "params": params})
    turn = state["turn"]
    while not answers[rid].is_set():
        time.sleep(0.02)
    return answers[rid].result
def varint(n):
    out = b""
    while True:
        b, n = n & 0x7f, n >> 7
        out += bytes([b | (0x80 if n else 0)])
        if not n: return out
def store(sid, used):
    # What cursor keeps of a session: the meta row '0' in hex, naming a root blob whose field 5 is {1: used, 2: window}.
    usage = b"\x08" + varint(used) + b"\x10" + varint(256000)
    root = b"\x0a\x20" + b"\x07" * 32 + b"\x2a" + varint(len(usage)) + usage
    d = os.path.join(ACP, sid); os.makedirs(d, exist_ok=True)
    c = sqlite3.connect(os.path.join(d, "store.db"))
    c.execute("create table if not exists blobs (id text primary key, data blob)")
    c.execute("create table if not exists meta (key text primary key, value text)")
    rid = hashlib.sha256(root).hexdigest()
    c.execute("insert or replace into blobs values (?, ?)", (rid, root))
    c.execute("insert or replace into meta values ('0', ?)", (json.dumps({"latestRootBlobId": rid}).encode().hex(),))
    c.commit(); c.close()
def saved(sid):
    p = os.path.join(STORE, sid + ".json")
    return json.load(open(p)) if os.path.exists(p) else None
def save(sid, convo):
    json.dump(convo, open(os.path.join(STORE, sid + ".json"), "w"))
def run(rid, sid, text, turn):
    heard = [text.strip().splitlines()[-1] if text.strip() else ""]
    # What it is asked to do is the last line: the persona above it names MCP too.
    text = heard[0]
    # The context grows by 2000 a turn: 1000 when it starts, 2000 more when it ends.
    base = 2000 * len(saved(sid) or [])
    store(sid, base + 1000)
    stubborn = "STUBBORN" in text
    if "USAGE" in text:
        update(sid, {"sessionUpdate": "usage_update", "used": 7000, "size": 100000})
    if "COMMANDS" in text:
        update(sid, {"sessionUpdate": "available_commands_update", "availableCommands": [{"name": "later", "description": "Came on a later turn", "input": None}]})
    m = re.search(r"SLEEP ([0-9.]+)", text)
    if m:
        cid = "tool_" + uuid.uuid4().hex[:8]
        update(sid, {"sessionUpdate": "tool_call", "toolCallId": cid, "title": "`sleep %s`" % m.group(1), "kind": "execute", "status": "pending", "rawInput": {"command": "sleep %s" % m.group(1)}})
        update(sid, {"sessionUpdate": "tool_call_update", "toolCallId": cid, "status": "in_progress"})
        end = time.time() + float(m.group(1))
        while time.time() < end and not (turn["cancelled"].is_set() and not stubborn):
            time.sleep(0.02)
        if not turn["cancelled"].is_set():
            update(sid, {"sessionUpdate": "tool_call_update", "toolCallId": cid, "status": "completed", "rawOutput": {"exitCode": 0, "stdout": ""}})
    if "ASK" in text:
        cid = "tool_" + uuid.uuid4().hex[:8]
        update(sid, {"sessionUpdate": "tool_call", "toolCallId": cid, "title": "`touch asked.txt`", "kind": "execute", "status": "pending", "rawInput": {"command": "touch asked.txt"}})
        got = ask("session/request_permission", {"sessionId": sid, "toolCall": {"toolCallId": cid, "title": "`touch asked.txt`", "kind": "execute", "status": "pending", "content": [{"type": "content", "content": {"type": "text", "text": "Shell allowlist is empty"}}]}, "options": [{"optionId": "allow-once", "name": "Allow once", "kind": "allow_once"}, {"optionId": "allow-always", "name": "Allow always", "kind": "allow_always"}, {"optionId": "reject-once", "name": "Reject", "kind": "reject_once"}]})
        outcome = (got or {}).get("outcome", {})
        heard.append("decision: %s" % (outcome.get("optionId") or outcome.get("outcome")))
        update(sid, {"sessionUpdate": "tool_call_update", "toolCallId": cid, "status": "completed"})
    if "MCP" in text:
        cid = "tool_" + uuid.uuid4().hex[:8]
        update(sid, {"sessionUpdate": "tool_call", "toolCallId": cid, "title": "MCP: tool", "kind": "other", "status": "pending", "rawInput": {}})
        update(sid, {"sessionUpdate": "tool_call_update", "toolCallId": cid, "title": "crew: list_peers", "rawInput": {"providerIdentifier": "crew", "toolName": "list_peers", "args": {}}})
        update(sid, {"sessionUpdate": "tool_call_update", "toolCallId": cid, "status": "in_progress"})
        got = ask("session/request_permission", {"sessionId": sid, "toolCall": {"toolCallId": cid, "title": "crew-crew: list_peers", "kind": "other", "status": "pending"}, "options": [{"optionId": "allow-once", "name": "Allow once", "kind": "allow_once"}, {"optionId": "allow-always", "name": "Allow always", "kind": "allow_always"}, {"optionId": "reject-once", "name": "Reject", "kind": "reject_once"}]})
        heard.append("crew: %s" % ((got or {}).get("outcome", {}).get("optionId")))
        update(sid, {"sessionUpdate": "tool_call_update", "toolCallId": cid, "status": "completed", "rawOutput": {"success": True}})
    if "QUESTION" in text:
        got = ask("cursor/ask_question", {"toolCallId": "tool_q", "title": "Color", "questions": [{"id": "color", "prompt": "Which color?", "allowMultiple": False, "options": [{"id": "r", "label": "Red"}, {"id": "b", "label": "Blue"}]}]})
        heard.append("answers: %s" % json.dumps((got or {}).get("outcome"), sort_keys=True))
    if "PLAN" in text:
        update(sid, {"sessionUpdate": "tool_call", "toolCallId": "tool_p", "title": "Create Plan", "kind": "other", "status": "pending", "rawInput": {}})
        got = ask("cursor/create_plan", {"toolCallId": "tool_p", "name": "Hello", "overview": "One file.", "plan": "# Hello\n\nAdd hello.txt", "todos": [], "isProject": False, "phases": []})
        heard.append("plan: %s" % (got or {}).get("outcome", {}).get("outcome"))
        update(sid, {"sessionUpdate": "plan", "entries": [{"content": "Add hello.txt", "priority": "medium", "status": "pending"}]})
        update(sid, {"sessionUpdate": "tool_call_update", "toolCallId": "tool_p", "status": "completed"})
    if turn["cancelled"].is_set() and not stubborn:
        state["turn"] = None
        out({"id": rid, "result": {"stopReason": "cancelled"}})
        return
    if turn["cancelled"].is_set():
        time.sleep(30)
    if "FAIL" in text:
        state["turn"] = None
        out({"id": rid, "error": {"code": -32603, "message": "boom"}})
        return
    reply = "report: " + " + ".join(heard)
    half = len(reply) // 2
    for piece in (reply[:half], reply[half:]):
        update(sid, {"sessionUpdate": "agent_message_chunk", "content": {"type": "text", "text": piece}})
    convo = saved(sid) or []
    convo.append({"user": text, "agent": reply})
    save(sid, convo)
    store(sid, base + 2000)
    state["turn"] = None
    out({"id": rid, "result": {"stopReason": "end_turn"}})
for line in sys.stdin:
    try: m = json.loads(line)
    except Exception: continue
    method, rid, params = m.get("method"), m.get("id"), m.get("params") or {}
    if method is None and rid is not None:
        log({"answer": rid, "result": m.get("result"), "error": m.get("error")})
        ev = answers.get(rid)
        if ev is not None:
            ev.result = m.get("result"); ev.set()
        continue
    log({"method": method, "params": params})
    if method == "session/cancel":
        turn = state["turn"]
        if turn: turn["cancelled"].set()
        continue
    if rid is None:
        continue
    if method == "initialize":
        out({"id": rid, "result": {"protocolVersion": 1, "agentCapabilities": {"loadSession": True}, "authMethods": [{"id": "cursor_login", "name": "Cursor Login"}]}})
    elif method == "authenticate":
        out({"id": rid, "result": {}})
    elif method == "session/new":
        sid = str(uuid.uuid4())
        save(sid, [])
        out({"id": rid, "result": {"sessionId": sid, "modes": {"currentModeId": "agent", "availableModes": []}}})
        update(sid, {"sessionUpdate": "available_commands_update", "availableCommands": [{"name": "create_plan", "description": "Create a plan", "input": {"hint": "the goal"}}, {"name": "clear", "description": "Start over", "input": None}]})
    elif method == "session/load":
        sid = params.get("sessionId")
        convo = saved(sid)
        if convo is None:
            out({"id": rid, "error": {"code": -32602, "message": "Invalid params", "data": {"message": "Session \"%s\" not found" % sid}}})
            continue
        for turn in convo:
            update(sid, {"sessionUpdate": "user_message_chunk", "content": {"type": "text", "text": turn["user"]}})
            update(sid, {"sessionUpdate": "tool_call", "toolCallId": "replay-" + uuid.uuid4().hex[:6], "title": "`echo old`", "kind": "execute", "status": "pending", "rawInput": {"command": "echo old"}})
            update(sid, {"sessionUpdate": "agent_message_chunk", "content": {"type": "text", "text": turn["agent"]}})
        out({"id": rid, "result": {"modes": {"currentModeId": "agent", "availableModes": []}}})
    elif method == "session/prompt":
        if state["turn"]:
            out({"id": rid, "error": {"code": -32600, "message": "a prompt is already running"}})
            continue
        sid = params.get("sessionId")
        text = "\n".join(p.get("text", "") for p in params.get("prompt", []))
        turn = {"cancelled": threading.Event()}
        state["turn"] = turn
        threading.Thread(target=run, args=(rid, sid, text, turn), daemon=True).start()
    else:
        out({"id": rid, "error": {"code": -32601, "message": "Method not found: " + str(method)}})
"##;
    let path = crate::fakes::install(dir, &format!("fake-cursor-agent-{tag}"), script);
    (path.to_string_lossy().into_owned(), log)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::turns::TurnHost;

    /// A host whose Cursor plugin folder is one that does not exist, so no test
    /// reads the plugins installed in the real home.
    fn host_without_plugins() -> TurnHost {
        let host = TurnHost::test_new();
        host.override_cursor_plugins(std::env::temp_dir().join(format!("crew-no-plugins-{}", uuid::Uuid::new_v4())));
        host
    }

    /// A plugin cache with one enabled plugin, whose finished install has one
    /// skill, `search`.
    fn plugin_cache() -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!("crew-cursor-plugins-{}", uuid::Uuid::new_v4()));
        let skill = dir.join("cursor-public/101/aaa/skills/search/SKILL.md");
        std::fs::create_dir_all(skill.parent().expect("parent")).expect("dir");
        std::fs::write(&skill, "---\nname: search\ndescription: Search Notion.\n---\n\nFind things.\n").expect("skill");
        std::fs::write(dir.join("cursor-public/101/aaa.installed"), "").expect("marker");
        std::fs::write(
            dir.join(".cloud-plugin-manifest.json"),
            r#"{"plugins":[{"name":"notion","pluginId":"101","enabledCapabilities":["static"]}]}"#,
        )
        .expect("manifest");
        dir
    }

    fn host(id: &str) -> (TurnHost, std::sync::Arc<crate::turns::Applied>) {
        let host = host_without_plugins();
        let cap = host.test_capture();
        host.test_install_cursor(id);
        (host, cap)
    }

    fn update(update: Value) -> String {
        json!({ "jsonrpc": "2.0", "method": "session/update", "params": { "sessionId": "acp", "update": update } }).to_string()
    }

    fn running(host: &TurnHost, id: &str, load: Option<u64>) {
        if let Some(Live::Cursor(live)) = host.lock().get_mut(id) {
            live.test_running("acp", 7, load);
        }
    }

    /// Cursor numbers its requests from 0, and the first one is still a
    /// request: here, the card it asks for.
    #[test]
    fn a_request_with_id_0_is_a_request() {
        let (host, cap) = host("s");
        running(&host, "s", None);
        let asked = json!({ "jsonrpc": "2.0", "id": 0, "method": "session/request_permission", "params": {
            "sessionId": "acp",
            "toolCall": { "toolCallId": "t", "title": "`rm -rf build`", "kind": "execute", "rawInput": { "command": "rm -rf build" } },
            "options": [{ "optionId": "allow-once", "kind": "allow_once" }, { "optionId": "reject-once", "kind": "reject_once" }]
        } });
        host.handle_cursor_line("s", &asked.to_string());
        let mut seen = Vec::new();
        for _ in 0..100 {
            seen.extend(cap.take());
            if seen.iter().any(|event| matches!(event, HarnessEvent::ApprovalRequested { .. })) {
                break;
            }
            std::thread::sleep(Duration::from_millis(10));
        }
        assert!(
            seen.iter().any(|event| matches!(event, HarnessEvent::ApprovalRequested { title, .. } if title == "rm -rf build")),
            "{seen:?}"
        );
        assert!(host.cursor_respond("s", 1, ApprovalDecision::Deny).is_some());
    }

    /// A load replays the conversation before it answers: none of it is this
    /// turn. Once it has answered, updates are the turn's.
    #[test]
    fn a_loads_replay_is_muted_until_its_answer() {
        let (host, cap) = host("s");
        running(&host, "s", Some(3));
        host.handle_cursor_line("s", &update(json!({ "sessionUpdate": "user_message_chunk", "content": { "type": "text", "text": "old ask" } })));
        host.handle_cursor_line("s", &update(json!({ "sessionUpdate": "agent_message_chunk", "content": { "type": "text", "text": "old answer" } })));
        host.handle_cursor_line("s", &update(json!({ "sessionUpdate": "tool_call", "toolCallId": "replay-0-1", "title": "`ls`", "kind": "execute", "rawInput": { "command": "ls" } })));
        assert_eq!(cap.take(), vec![]);
        host.handle_cursor_line("s", &json!({ "jsonrpc": "2.0", "id": 3, "result": {} }).to_string());
        host.handle_cursor_line("s", &update(json!({ "sessionUpdate": "agent_message_chunk", "content": { "type": "text", "text": "new" } })));
        assert_eq!(cap.take(), vec![HarnessEvent::MessageDelta { text: "new".into() }]);
    }

    /// An MCP call opens as a placeholder; its row waits for the update that
    /// says which tool it is, and reads as Crew's.
    #[test]
    fn a_crew_call_gets_its_row_once_it_says_what_it_is() {
        let (host, cap) = host("s");
        running(&host, "s", None);
        host.handle_cursor_line("s", &update(json!({ "sessionUpdate": "tool_call", "toolCallId": "m", "title": "MCP: tool", "kind": "other", "status": "pending", "rawInput": {} })));
        assert_eq!(cap.take(), vec![]);
        host.handle_cursor_line("s", &update(json!({ "sessionUpdate": "tool_call_update", "toolCallId": "m", "title": "crew: message_agent", "rawInput": {
            "providerIdentifier": "crew", "toolName": "message_agent", "args": { "to": "abc", "text": "green" } } })));
        host.handle_cursor_line("s", &update(json!({ "sessionUpdate": "tool_call_update", "toolCallId": "m", "status": "completed", "rawOutput": { "success": true } })));
        let events = cap.take();
        let HarnessEvent::ToolStarted { name, title, .. } = &events[0] else { panic!("{events:?}") };
        assert_eq!((name.as_str(), title.as_str()), ("mcp__crew__message_agent", "Crew message agent abc"));
        assert!(matches!(events.last(), Some(HarnessEvent::ToolUpdated { status: Some(ToolStatus::Completed), .. })), "{events:?}");
    }

    /// A stop cancels the prompt; the call in flight gets no last update from
    /// Cursor, so Crew closes it, and the prompt's `cancelled` ends the turn
    /// as stopped.
    #[test]
    fn a_cancel_closes_the_calls_left_open() {
        let (host, cap) = host("s");
        running(&host, "s", None);
        host.handle_cursor_line("s", &update(json!({ "sessionUpdate": "tool_call", "toolCallId": "t", "title": "`sleep 30`", "kind": "execute", "status": "pending", "rawInput": { "command": "sleep 30" } })));
        host.handle_cursor_line("s", &update(json!({ "sessionUpdate": "tool_call_update", "toolCallId": "t", "status": "in_progress" })));
        cap.take();
        // No process to write to: the caller would settle it; the call is closed either way.
        host.cursor_interrupt("s");
        assert_eq!(
            cap.take(),
            vec![HarnessEvent::ToolUpdated { call_id: "t".into(), title: None, status: Some(ToolStatus::Interrupted), detail: None }]
        );
        // What it says after the stop is not the turn's.
        host.handle_cursor_line("s", &update(json!({ "sessionUpdate": "agent_message_chunk", "content": { "type": "text", "text": "late" } })));
        assert_eq!(cap.take(), vec![]);
    }

    #[test]
    fn the_prompts_answer_ends_the_turn() {
        let (host, cap) = host("s");
        running(&host, "s", None);
        host.handle_cursor_line("s", &update(json!({ "sessionUpdate": "agent_thought_chunk", "content": { "type": "text", "text": "hmm" } })));
        host.handle_cursor_line("s", &update(json!({ "sessionUpdate": "agent_message_chunk", "content": { "type": "text", "text": "done" } })));
        host.handle_cursor_line("s", &json!({ "jsonrpc": "2.0", "id": 7, "result": { "stopReason": "end_turn" } }).to_string());
        assert_eq!(
            cap.take(),
            vec![
                HarnessEvent::ReasoningDelta { text: "hmm".into() },
                HarnessEvent::MessageDelta { text: "done".into() },
                HarnessEvent::MessageCompleted {},
                HarnessEvent::TurnCompleted { usage: None },
            ]
        );
        assert!(matches!(host.lock().get("s"), Some(Live::Cursor(live)) if live.settled));
    }

    /// Cursor's commands come during a load's replay, which is muted for the
    /// turn; the menu takes them anyway, with the folder the session opened in.
    #[test]
    fn a_commands_update_during_a_load_still_reaches_the_catalog() {
        let (host, _cap) = host("commands-load");
        running(&host, "commands-load", Some(3));
        if let Some(Live::Cursor(live)) = host.lock().get_mut("commands-load") {
            live.cwd = "/work/crew".into();
        }
        let listed = json!({
            "sessionUpdate": "available_commands_update",
            "availableCommands": [{ "name": "create_plan", "description": "Create a plan", "input": { "hint": "the goal" } }]
        });
        host.handle_cursor_line("commands-load", &update(listed));
        assert_eq!(
            host.commands().catalog("cursor", "/work/crew", Vec::new(), 0).entries,
            vec![CommandEntry {
                name: "create_plan".into(),
                description: "Create a plan".into(),
                argument_hint: Some("the goal".into()),
                aliases: None,
                kind: "command".into(),
                path: None,
            }]
        );
    }

    /// A Cursor session of `kind` in a new folder, not started. Returns its id
    /// and the folder.
    fn cursor_session(host: &TurnHost, kind: &str) -> (String, String) {
        let dir = std::env::temp_dir().join(format!("crew-cursor-catalog-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).expect("dir");
        let workspace = crate::workspace::create(host.test_store(), "w".into(), dir.to_string_lossy().into())
            .expect("workspace")
            .id;
        let session = crate::session::create(
            host.test_store(),
            workspace,
            kind.into(),
            "shell".into(),
            "cursor".into(),
            "composer-2.5".into(),
            String::new(),
            "full".into(),
        )
        .expect("session")
        .id;
        (session, dir.to_string_lossy().into_owned())
    }

    /// A session of `kind` on the fake `cursor-agent acp`, started with `text`.
    /// Returns the host, the session's id and the folder.
    fn started_as(kind: &str, text: &str) -> (TurnHost, String, String) {
        let host = host_without_plugins();
        host.test_agents().set_events(std::sync::Arc::new(Lines(host.clone())));
        let (session, cwd) = cursor_session(&host, kind);
        let (fake, _log) = crate::turns::fake_cursor(std::path::Path::new(&cwd));
        host.override_binary("cursor-agent", fake);
        host.start(crew_protocol::TurnStart {
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
            command: None,
            skills: None,
        })
        .expect("start");
        (host, session, cwd)
    }

    fn started(text: &str) -> (TurnHost, String, String) {
        started_as("terminal", text)
    }

    fn acp_command(name: &str) -> crew_protocol::CommandEntry {
        crew_protocol::CommandEntry {
            name: name.into(),
            description: "Cursor's own".into(),
            argument_hint: None,
            aliases: None,
            kind: "command".into(),
            path: None,
        }
    }

    /// Cursor's menu lists the plugin skills beside its own commands, and a
    /// plugin skill that shares a name with one of them is left out.
    #[test]
    fn a_cursor_plugin_skill_is_listed_beside_its_commands() {
        let host = host_without_plugins();
        host.override_cursor_plugins(plugin_cache());
        host.cursor_catalog("s1", "/work/x", vec![acp_command("clear")]);
        let entries = host.commands().catalog("cursor", "/work/x", Vec::new(), 1).entries;
        let search = entries.iter().find(|entry| entry.name == "search").expect("search");
        assert_eq!(search.kind, "skill");
        assert!(search.path.as_deref().is_some_and(|path| path.ends_with("aaa/skills/search/SKILL.md")));
        assert_eq!(entries.iter().find(|entry| entry.name == "clear").expect("clear").kind, "command");

        host.cursor_catalog("s1", "/work/x", vec![acp_command("clear"), acp_command("search")]);
        let entries = host.commands().catalog("cursor", "/work/x", Vec::new(), 2).entries;
        assert_eq!(entries.iter().filter(|entry| entry.name == "search").count(), 1);
        assert_eq!(entries.iter().find(|entry| entry.name == "search").expect("search").kind, "command");
    }

    /// A message that names a plugin skill sends its instructions ahead of
    /// its text; a command, or a name that is no plugin skill, sends the text
    /// as it was.
    #[test]
    fn a_named_plugin_skill_goes_into_the_prompt_ahead_of_the_message() {
        let host = host_without_plugins();
        host.override_cursor_plugins(plugin_cache());
        let names = ["search".to_string()];
        let sent = host.cursor_skill_text("look up crew", None, &names);
        assert!(sent.contains("Find things.") && sent.ends_with("look up crew"), "{sent}");
        assert_eq!(host.cursor_skill_text("look up crew", Some("create_plan"), &names), "look up crew");
        assert_eq!(host.cursor_skill_text("look up crew", None, &["nope".to_string()]), "look up crew");
    }

    struct Lines(TurnHost);

    impl crate::agent::AgentEvents for Lines {
        fn lines(&self, event: &str, session_id: &str, lines: Vec<String>) {
            self.0.on_agent_lines(event, session_id, lines);
        }
        fn exit(&self, session_id: &str, code: Option<i32>, _pid: u32) {
            self.0.on_agent_exit(session_id, code);
        }
    }

    /// A new Cursor session announces its commands once it opens, and the
    /// fake's announcement reaches the catalog with the folder it opened in.
    #[test]
    fn a_new_cursor_session_hands_its_announced_commands_to_the_catalog() {
        let (host, session, cwd) = started("hello");
        for _ in 0..400 {
            if host.commands().holds("cursor", &cwd) {
                break;
            }
            std::thread::sleep(Duration::from_millis(25));
        }
        let entries = host.commands_list(&session).expect("menu").entries;
        let commands: Vec<(&str, &str, Option<&str>)> = entries
            .iter()
            .filter(|entry| entry.kind == "command")
            .map(|entry| (entry.name.as_str(), entry.kind.as_str(), entry.argument_hint.as_deref()))
            .collect();
        assert_eq!(commands, [("create_plan", "command", Some("the goal")), ("clear", "command", None)]);
        assert!(entries.iter().any(|entry| entry.name == "model" && entry.kind == "crew"));
        for _ in 0..400 {
            if !host.is_running(&session) {
                break;
            }
            std::thread::sleep(Duration::from_millis(25));
        }
    }

    /// A bot's Cursor process keeps nothing: its menu is Crew's actions alone,
    /// whatever commands Cursor announced.
    #[test]
    fn a_bots_cursor_process_keeps_nothing_in_the_catalog() {
        let (host, session, cwd) = started_as("bot", "hello");
        for _ in 0..400 {
            if !host.is_running(&session) {
                break;
            }
            std::thread::sleep(Duration::from_millis(25));
        }
        assert!(!host.commands().holds("cursor", &cwd));
        let entries = host.commands_list(&session).expect("menu").entries;
        assert!(entries.iter().all(|entry| entry.kind == "crew"), "{entries:?}");
    }

    /// With no catalog for its folder, a Cursor session's menu is Crew's
    /// actions alone: nothing is asked for, as Cursor has no probe yet.
    #[test]
    fn a_cursor_session_with_no_catalog_lists_crew_actions_alone() {
        let host = TurnHost::test_new();
        let (session, cwd) = cursor_session(&host, "terminal");
        let entries = host.commands_list(&session).expect("menu").entries;
        assert!(!entries.is_empty() && entries.iter().all(|entry| entry.kind == "crew"), "{entries:?}");
        assert!(!host.commands().holds("cursor", &cwd));
    }

    /// A session on the fake `cursor-agent acp` that is sent turn after turn,
    /// with the fake's log to count its launches and the requests it got.
    struct Kept {
        host: TurnHost,
        session: String,
        cwd: String,
        log: std::path::PathBuf,
    }

    impl Kept {
        fn new(kind: &str) -> Self {
            let host = TurnHost::test_new();
            host.test_agents().set_events(std::sync::Arc::new(Lines(host.clone())));
            let (session, cwd) = cursor_session(&host, kind);
            let (fake, log) = fake_cursor(std::path::Path::new(&cwd));
            host.override_binary("cursor-agent", fake);
            let name = log.file_name().unwrap().to_string_lossy().into_owned();
            let tag = name.trim_start_matches("fake-cursor-").trim_end_matches(".log");
            host.override_cursor_acp_sessions(log.with_file_name(format!("fake-cursor-{tag}-acp")));
            Self { host, session, cwd, log }
        }

        fn child() -> Self {
            Self::new("terminal")
        }

        /// Sends `text` and waits for the turn to end.
        fn say(&self, text: &str) {
            self.send(text);
            self.settle();
        }

        fn send(&self, text: &str) {
            self.host
                .start(crew_protocol::TurnStart {
                    session_id: self.session.clone(),
                    cwd: self.cwd.clone(),
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
        }

        fn settle(&self) {
            for _ in 0..800 {
                if !self.host.is_running(&self.session) {
                    return;
                }
                std::thread::sleep(Duration::from_millis(25));
            }
            panic!("the turn never ended");
        }

        fn until(&self, what: &str, done: impl Fn() -> bool) {
            for _ in 0..800 {
                if done() {
                    return;
                }
                std::thread::sleep(Duration::from_millis(25));
            }
            panic!("never {what}");
        }

        fn log(&self) -> Vec<Value> {
            std::fs::read_to_string(&self.log)
                .unwrap_or_default()
                .lines()
                .filter_map(|line| serde_json::from_str(line).ok())
                .collect()
        }

        /// The processes launched so far, each by its argv.
        fn launches(&self) -> Vec<Vec<String>> {
            self.log()
                .iter()
                .filter_map(|line| line.get("argv"))
                .map(|argv| argv.as_array().unwrap().iter().map(|arg| arg.as_str().unwrap().to_string()).collect())
                .collect()
        }

        fn count(&self, method: &str) -> usize {
            self.log().iter().filter(|line| line["method"] == method).count()
        }

        fn row(&self) -> crate::session::Session {
            crate::session::get(self.host.test_store(), self.session.clone()).unwrap().unwrap()
        }

        fn reading(&self) -> Option<ContextReading> {
            self.host.context(&self.session)
        }
    }

    impl Drop for Kept {
        fn drop(&mut self) {
            self.host.test_agents().kill(&self.session);
        }
    }

    /// One process and one ACP session across turns: the handshake, the
    /// session and the MCP servers are paid once, and the second prompt goes
    /// to the session the first opened.
    #[test]
    fn two_turns_make_one_launch_and_one_acp_session() {
        let k = Kept::child();
        k.say("one");
        k.say("two");
        assert_eq!(k.launches().len(), 1, "{:?}", k.log());
        assert_eq!((k.count("initialize"), k.count("session/new"), k.count("session/load")), (1, 1, 0));
        let prompted: Vec<Value> = k
            .log()
            .iter()
            .filter(|line| line["method"] == "session/prompt")
            .map(|line| line["params"]["sessionId"].clone())
            .collect();
        assert_eq!(prompted.len(), 2);
        assert_eq!(prompted[0], prompted[1]);
        assert!(k.host.idle_since(&k.session).is_some(), "the process is parked for the next turn");
        // The second turn runs: its answer is its own.
        let blocks = k.host.transcripts().since(&k.session, 0).0;
        assert!(blocks.iter().any(|block| block.text == "report: two"), "{blocks:?}");
    }

    /// The model is on argv: another one means another process, which carries
    /// on the same ACP session and does not start a new one.
    #[test]
    fn a_model_change_relaunches_on_the_same_acp_session() {
        let k = Kept::child();
        k.say("one");
        let row = k.row();
        crate::session::set_options(
            k.host.test_store(),
            k.session.clone(),
            "gpt-5.6-sol-high".into(),
            row.effort,
            row.service_tier,
            row.autonomy,
        )
        .expect("options");
        k.say("two");
        let launches = k.launches();
        assert_eq!(launches.len(), 2, "{:?}", k.log());
        assert!(
            launches[0].contains(&"composer-2.5".to_string()) && launches[1].contains(&"gpt-5.6-sol-high".to_string()),
            "{launches:?}"
        );
        assert_eq!((k.count("session/new"), k.count("session/load")), (1, 1));
        let loaded = k.log().into_iter().find(|line| line["method"] == "session/load").unwrap();
        let opened = k.row().provider_session_id.unwrap();
        assert_eq!(loaded["params"]["sessionId"], opened.as_str());
        // A third turn on the new process stays on it.
        k.say("three");
        assert_eq!(k.launches().len(), 2);
    }

    /// Autonomy is a flag of the launch too.
    #[test]
    fn an_autonomy_change_relaunches_on_the_same_acp_session() {
        let k = Kept::child();
        k.say("one");
        let row = k.row();
        crate::session::set_options(k.host.test_store(), k.session.clone(), row.model, row.effort, row.service_tier, "ask".into())
            .expect("options");
        k.say("two");
        let launches = k.launches();
        assert_eq!(launches.len(), 2, "{:?}", k.log());
        assert!(launches[0].contains(&"--force".to_string()) && !launches[1].contains(&"--force".to_string()), "{launches:?}");
        assert_eq!((k.count("session/new"), k.count("session/load")), (1, 1));
    }

    /// Esc stops the turn, and the process that closed it with `cancelled` is
    /// the next turn's.
    #[test]
    fn a_stop_keeps_the_process_for_the_next_turn() {
        let k = Kept::child();
        k.send("SLEEP 30");
        k.until("the prompt reached cursor", || k.count("session/prompt") == 1);
        std::thread::sleep(Duration::from_millis(200));
        k.host.stop(&k.session).expect("stop");
        k.settle();
        assert_eq!(k.count("session/cancel"), 1);
        assert!(k.host.idle_since(&k.session).is_some(), "the stop let the process go");
        k.say("again");
        assert_eq!(k.launches().len(), 1, "{:?}", k.log());
        assert_eq!((k.count("session/new"), k.count("session/load"), k.count("session/prompt")), (1, 0, 2));
        let blocks = k.host.transcripts().since(&k.session, 0).0;
        assert!(blocks.iter().any(|block| block.text == "report: again"), "{blocks:?}");
    }

    /// A cancel that cursor never answered leaves the process in a state
    /// nobody vouches for: it goes, and the next turn loads the session.
    #[test]
    fn a_stop_that_cursor_ignores_lets_the_process_go() {
        let k = Kept::child();
        k.say("one");
        k.send("SLEEP 30 STUBBORN");
        k.until("the second prompt reached cursor", || k.count("session/prompt") == 2);
        std::thread::sleep(Duration::from_millis(200));
        k.host.stop(&k.session).expect("stop");
        k.settle();
        assert!(k.host.idle_since(&k.session).is_none());
        assert!(!k.host.test_agents().running().contains(&k.session));
        k.say("three");
        assert_eq!(k.launches().len(), 2, "{:?}", k.log());
        assert_eq!((k.count("session/new"), k.count("session/load")), (1, 1));
    }

    /// A turn that failed leaves the process in a state nobody vouches for.
    #[test]
    fn a_failed_turn_lets_the_process_go() {
        let k = Kept::child();
        k.say("FAIL");
        assert!(k.host.idle_since(&k.session).is_none());
        k.say("two");
        assert_eq!(k.launches().len(), 2, "{:?}", k.log());
    }

    /// After half an hour with nothing to do the process is let go, and the
    /// next message launches another that loads the session.
    #[test]
    fn an_idle_process_is_released_and_the_next_turn_loads_the_session() {
        let k = Kept::child();
        k.say("one");
        assert!(k.host.release_idle(Duration::from_secs(3600), Duration::from_secs(7200)).is_empty());
        assert_eq!(k.host.release_idle(Duration::from_millis(1), Duration::from_secs(3600)), vec![k.session.clone()]);
        assert!(!k.host.test_agents().running().contains(&k.session));
        k.say("two");
        assert_eq!(k.launches().len(), 2);
        assert_eq!((k.count("session/new"), k.count("session/load")), (1, 1));
    }

    /// A process that died while idle (killed under Crew) is gone from the
    /// session's entry, and the next turn launches another.
    #[test]
    fn a_process_that_died_while_idle_is_replaced_on_the_next_turn() {
        let k = Kept::child();
        k.say("one");
        let pid = k.host.test_agents().pid_of(&k.session).expect("process up");
        unsafe { libc::kill(pid as i32, libc::SIGKILL) };
        k.until("the entry went", || k.host.lock().get(&k.session).is_none());
        k.say("two");
        assert_eq!(k.launches().len(), 2);
        assert_eq!(k.count("session/load"), 1);
    }

    /// A bot's turn is on a clean process and session of its own, as before.
    #[test]
    fn a_bots_turns_each_launch_a_process() {
        let k = Kept::new("bot");
        k.say("one");
        assert!(k.host.idle_since(&k.session).is_none());
        assert!(!k.host.test_agents().running().contains(&k.session));
        k.say("two");
        assert_eq!(k.launches().len(), 2, "{:?}", k.log());
        assert_eq!((k.count("session/new"), k.count("session/load")), (2, 0));
    }

    /// The menu belongs to the session: a command Cursor announces on a later
    /// turn of the same process reaches the catalog too.
    #[test]
    fn a_command_announced_on_a_later_turn_reaches_the_catalog() {
        let k = Kept::child();
        k.say("one");
        k.say("COMMANDS");
        k.until("the catalog took it", || {
            k.host.commands().catalog("cursor", &k.cwd, Vec::new(), 0).entries.iter().any(|entry| entry.name == "later")
        });
        assert_eq!(k.launches().len(), 1);
    }

    /// The meter reads the store after the prompt, and again while a long
    /// turn runs.
    #[test]
    fn the_meter_reads_the_store_after_each_prompt_and_while_a_turn_runs() {
        let k = Kept::child();
        k.say("one");
        assert_eq!(k.reading(), Some(ContextReading { used: 2000, window: Some(256_000), auto_compact_at: None, stale: None }));
        k.send("SLEEP 3");
        // The turn started with 3000 in the store, which the timer picks up
        // before the turn ends.
        k.until("the timer read the store", || k.reading().is_some_and(|reading| reading.used == 3000));
        assert!(k.host.is_running(&k.session));
        k.settle();
        assert_eq!(k.reading().map(|reading| reading.used), Some(4000));
    }

    /// Cursor's own word on how full the context is wins over the store.
    #[test]
    fn a_usage_update_is_preferred_to_the_store() {
        let k = Kept::child();
        k.say("USAGE");
        assert_eq!(k.reading(), Some(ContextReading { used: 7000, window: Some(100_000), auto_compact_at: None, stale: None }));
        k.say("two");
        assert_eq!(k.reading().map(|reading| reading.used), Some(7000));
    }
}
