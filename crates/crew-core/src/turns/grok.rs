//! The Grok driver: one `grok agent stdio` for a child's or the user's own
//! session, spoken to in the Agent Client Protocol over its stdio. The process
//! and its ACP session stay up between turns, as Cursor's do (see
//! `keeps_process`). A stop cancels the prompt and kills the process group;
//! the next turn loads the session. A bot starts a clean process and session
//! every turn, with the tail Crew hands it.
//!
//! The model and the effort are `session/set_config_option` on every turn,
//! including one that keeps its process, so a change of either does not
//! relaunch. Autonomy and the folder do: they are the process
//! (`--permission-mode` before `agent`, `agent --always-approve` for full
//! access). A relaunch loads the same ACP session. A stop sends
//! `session/cancel` and kills the process group, because grok detaches the
//! groups its tools run in. Grok takes nothing into a running turn, so a
//! message to it waits for the turn to end.
//!
//! The protocol itself is in `providers/grok.rs`.

use std::collections::{HashMap, HashSet};
use std::sync::atomic::Ordering;
use std::sync::mpsc::{self, RecvTimeoutError};
use std::time::Duration;

use crew_protocol::{ApprovalDecision, ApprovalResolution, CommandEntry, HarnessEvent, ToolStatus};
use serde_json::{json, Map, Value};
use tokio::sync::oneshot;

use super::{
    carries_conversation, conversation_to_resume, offers_fast, path_list, Harness, Launch, Live, QuestionReply, TurnHost,
    TurnOutcome, INIT_TIMEOUT, NEXT_EPOCH,
};
use crate::command_sources::cursor_commands;
use crate::providers::grok::{
    build_grok_prompt, build_grok_spawn_args, cancel_params, classify_request, initialize_params, isolation_env, mcp_servers,
    new_session_id, permission_answer, permission_response, plan_response, prompt_params, questions_response, rpc_error_message,
    session_missing, session_request, set_config_params, task_done, tool_detail, tool_end, tool_label, tool_name, turn_end,
    unsupported_error, AcpTool, GrokAsk, GrokQuestion, PromptSignal, TurnEnd,
};
use crate::providers::{as_record, string_field};

/// How long opening or loading a session may take. A load replays the
/// conversation, and the user's own MCP servers start alongside Crew's.
const OPEN_TIMEOUT: Duration = Duration::from_secs(90);
/// Prompt ids already settled, so a late completion cannot close a newer turn.
const SETTLED_PROMPTS: usize = 128;

struct Pending<T> {
    tx: mpsc::Sender<T>,
}

pub(super) struct GrokLive {
    turn_epoch: u64,
    /// What the process was launched with. Model and effort are not part of
    /// whether it can be kept: those are set on the open session.
    applied: Option<Launch>,
    acp_session: Option<String>,
    cwd: String,
    autonomy: crate::providers::Autonomy,
    next_id: u64,
    calls: HashMap<u64, mpsc::Sender<Result<Value, String>>>,
    prompt_id: Option<u64>,
    /// The id Crew put on that prompt. A completion notice names it.
    prompt_wire: Option<String>,
    /// Notices already applied, newest last.
    settled_prompts: Vec<String>,
    load_id: Option<u64>,
    approvals: HashMap<u64, Pending<ApprovalResolution>>,
    questions: HashMap<u64, Pending<QuestionReply>>,
    /// A stop killed the process group. The next turn starts another.
    hard_stop: bool,
    next_ui: u64,
    tools: HashMap<String, AcpTool>,
    started: HashSet<String>,
    open: Vec<String>,
    pub(super) active: bool,
    pub(super) cancelled: bool,
    pub(super) settled: bool,
    pub(super) turn_tx: Option<oneshot::Sender<TurnOutcome>>,
    pub(super) stderr: Vec<String>,
    pub(super) saw_output: bool,
}

impl GrokLive {
    pub(super) fn new(turn_tx: Option<oneshot::Sender<TurnOutcome>>, autonomy: crate::providers::Autonomy) -> Self {
        Self {
            turn_epoch: NEXT_EPOCH.fetch_add(1, Ordering::Relaxed),
            applied: None,
            acp_session: None,
            cwd: String::new(),
            autonomy,
            next_id: 1,
            calls: HashMap::new(),
            prompt_id: None,
            prompt_wire: None,
            settled_prompts: Vec::new(),
            load_id: None,
            approvals: HashMap::new(),
            questions: HashMap::new(),
            hard_stop: false,
            next_ui: 1,
            tools: HashMap::new(),
            started: HashSet::new(),
            open: Vec::new(),
            active: true,
            cancelled: false,
            settled: false,
            turn_tx,
            stderr: Vec::new(),
            saw_output: false,
        }
    }

    fn begin_turn(&mut self, turn_tx: oneshot::Sender<TurnOutcome>) {
        self.turn_epoch = NEXT_EPOCH.fetch_add(1, Ordering::Relaxed);
        self.prompt_id = None;
        self.prompt_wire = None;
        self.load_id = None;
        self.hard_stop = false;
        self.tools.clear();
        self.started.clear();
        self.open.clear();
        self.active = true;
        self.cancelled = false;
        self.settled = false;
        self.turn_tx = Some(turn_tx);
        self.saw_output = false;
    }

    /// Autonomy is a flag of the launch, and the folder is the process's.
    /// The model and the effort are set on the session the process already holds.
    fn runs_as(&self, now: &Launch) -> bool {
        self.applied.as_ref().is_some_and(|had| had.autonomy == now.autonomy && had.cwd == now.cwd)
    }

    pub(super) fn release(&mut self) {
        self.calls.clear();
        for (_, pending) in self.approvals.drain() {
            let _ = pending.tx.send(ApprovalResolution::Cancelled);
        }
        for (_, pending) in self.questions.drain() {
            let _ = pending.tx.send(QuestionReply::Cancelled);
        }
    }

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
}

enum Process {
    Kept(String),
    Launched(Value),
}

struct Texts {
    fresh: String,
    resumed: String,
}

impl TurnHost {
    /// Grok's own commands, from `available_commands_update`. A bot's process
    /// keeps nothing: its persona must not see the user's commands.
    fn grok_catalog(&self, session_id: &str, cwd: &str, entries: Vec<CommandEntry>) {
        let bot =
            crate::session::get(&self.store, session_id.to_string()).ok().flatten().is_some_and(|session| session.kind == "bot");
        if bot {
            return;
        }
        let actions = crate::commands::crew_actions(offers_fast("grok"));
        self.commands().learn_for_session(session_id, "grok", cwd, Some(entries), None, actions);
    }

    pub(super) fn run_grok(
        &self,
        session: crate::session::Session,
        params: crew_protocol::TurnStart,
        history: Option<String>,
    ) -> TurnOutcome {
        let session_id = session.id.clone();
        let (tx, turn_rx) = oneshot::channel();
        let autonomy = self.autonomy(&session);
        let kept = self.grok_arm(&session, &params.cwd, tx);
        self.watch_for_silence(&session_id);
        if self.stop_requested(&session_id) {
            self.signal(&session_id, TurnOutcome::Stopped);
            self.park(&session, kept.is_some());
            return TurnOutcome::Stopped;
        }
        let mcp = self.mcp();
        let carries = carries_conversation(&session);
        let resume = conversation_to_resume(&session);
        let persona = self.persona(&session, Harness::Grok, mcp.is_some(), &params.cwd);
        let model = Some(session.model.as_str()).filter(|model| !model.is_empty()).map(str::to_string);
        let effort = Some(session.effort.as_str()).filter(|effort| !effort.is_empty()).map(str::to_string);
        let texts = if carries {
            Texts {
                fresh: self.child_prompt(persona.as_deref(), false, &params),
                resumed: self.child_prompt(persona.as_deref(), true, &params),
            }
        } else {
            let text = build_grok_prompt(
                persona.as_deref().unwrap_or_default(),
                history.as_deref(),
                &params.text,
                &path_list(&params, &HashSet::new()),
            );
            Texts { fresh: text.clone(), resumed: text }
        };
        let process = match kept {
            Some(acp_session) => Ok(Process::Kept(acp_session)),
            None => self.grok_launch(&session, &params.cwd, autonomy, mcp.as_ref()).map(Process::Launched),
        };
        let outcome = match process.and_then(|process| {
            self.grok_open(&session_id, &params.cwd, resume.as_deref(), process, &texts, (model.as_deref(), effort.as_deref()))
        }) {
            Ok(()) => self.block_on(turn_rx).unwrap_or(TurnOutcome::Failed("Turn channel closed".into())),
            Err(_) if self.stop_requested(&session_id) => TurnOutcome::Stopped,
            Err(error) => TurnOutcome::Failed(error),
        };
        let closed = match self.lock().get_mut(&session_id) {
            Some(Live::Grok(live)) => {
                live.release();
                !live.hard_stop && live.prompt_id.is_none() && live.acp_session.is_some()
            }
            _ => false,
        };
        let clean = closed && !matches!(outcome, TurnOutcome::Failed(_));
        self.park(&session, clean);
        outcome
    }

    fn grok_arm(&self, session: &crate::session::Session, cwd: &str, tx: oneshot::Sender<TurnOutcome>) -> Option<String> {
        let session_id = session.id.as_str();
        let applied = self.applied(session, cwd);
        let alive = self.agents.running().iter().any(|id| id == session_id);
        let tx = {
            let mut map = self.lock();
            match map.get_mut(session_id) {
                Some(Live::Grok(live))
                    if alive
                        && live.settled
                        && !live.hard_stop
                        && live.prompt_id.is_none()
                        && live.acp_session.is_some()
                        && live.acp_session == conversation_to_resume(session)
                        && live.runs_as(&applied) =>
                {
                    live.begin_turn(tx);
                    live.autonomy = applied.autonomy;
                    let acp_session = live.acp_session.clone();
                    drop(map);
                    self.idle.lock().unwrap_or_else(|e| e.into_inner()).remove(session_id);
                    return acp_session;
                }
                _ => tx,
            }
        };
        self.agents.kill(session_id);
        let mut live = GrokLive::new(Some(tx), self.autonomy(session));
        live.applied = Some(applied);
        self.lock().insert(session_id.to_string(), Live::Grok(Box::new(live)));
        self.idle.lock().unwrap_or_else(|e| e.into_inner()).remove(session_id);
        None
    }

    /// Starts `grok agent stdio`. Returns the MCP servers the session is
    /// opened with. The handshake is [`TurnHost::grok_open`]'s.
    fn grok_launch(
        &self,
        session: &crate::session::Session,
        cwd: &str,
        autonomy: crate::providers::Autonomy,
        mcp: Option<&(String, Vec<String>)>,
    ) -> Result<Value, String> {
        let session_id = session.id.as_str();
        let path = self.resolve_bin("grok")?;
        let mut env = self.agent_env(session_id);
        for (key, value) in isolation_env() {
            env.insert(key.to_string(), value.to_string());
        }
        let mut mcp_env: Vec<(String, String)> = env
            .iter()
            .filter(|(key, _)| key.as_str() == "CREW_SOCKET" || key.as_str() == "CREW_TOKEN")
            .map(|(k, v)| (k.clone(), v.clone()))
            .collect();
        mcp_env.sort();
        let args = build_grok_spawn_args(&autonomy);
        self.agents.spawn(session_id.to_string(), path, args, cwd.to_string(), Some(env))?;
        Ok(mcp_servers(mcp, &mcp_env))
    }

    fn grok_open(
        &self,
        session_id: &str,
        cwd: &str,
        resume: Option<&str>,
        process: Process,
        texts: &Texts,
        options: (Option<&str>, Option<&str>),
    ) -> Result<(), String> {
        let (model, effort) = options;
        let servers = match process {
            Process::Kept(acp_session) => {
                return self.grok_prompt(session_id, &acp_session, &texts.resumed, model, effort);
            }
            Process::Launched(servers) => servers,
        };
        if let Some(Live::Grok(live)) = self.lock().get_mut(session_id) {
            live.cwd = cwd.to_string();
        }
        self.grok_call(session_id, "initialize", initialize_params(), INIT_TIMEOUT, false)
            .map_err(|error| self.grok_failure(session_id, "Grok did not start", &error))?;
        let mut text = &texts.resumed;
        let mut acp_session = None;
        if let Some(id) = resume {
            let (method, params) = session_request(cwd, Some(id), &servers);
            match self.grok_call(session_id, method, params, OPEN_TIMEOUT, true) {
                Ok(_) => acp_session = Some(id.to_string()),
                Err(_) if self.stop_requested(session_id) => return Err("cancelled".into()),
                Err(error) if session_missing(&error) => {
                    let message = format!("Grok could not load this session's conversation ({error}): it starts a new one.");
                    self.transcripts.apply(session_id, HarnessEvent::SessionNote { message });
                }
                Err(error) => return Err(self.grok_failure(session_id, "Grok could not load this session", &error)),
            }
        }
        let acp_session = match acp_session {
            Some(id) => id,
            None => {
                text = &texts.fresh;
                let (method, params) = session_request(cwd, None, &servers);
                let created = self
                    .grok_call(session_id, method, params, OPEN_TIMEOUT, false)
                    .map_err(|error| self.grok_failure(session_id, "Grok could not open a session", &error))?;
                new_session_id(&created).ok_or_else(|| "Grok opened no session.".to_string())?
            }
        };
        if let Some(Live::Grok(live)) = self.lock().get_mut(session_id) {
            live.acp_session = Some(acp_session.clone());
        }
        self.grok_prompt(session_id, &acp_session, text, model, effort)
    }

    /// The session is open: the model and the effort are set, then the prompt
    /// goes in. Both are set on a process kept from the last turn too.
    fn grok_prompt(
        &self,
        session_id: &str,
        acp_session: &str,
        text: &str,
        model: Option<&str>,
        effort: Option<&str>,
    ) -> Result<(), String> {
        self.transcripts.apply(session_id, HarnessEvent::SessionProviderBound { provider_session_id: acp_session.to_string() });
        self.transcripts.apply(session_id, HarnessEvent::SessionStarted {});
        if let Some(model) = model {
            self.grok_call(
                session_id,
                "session/set_config_option",
                set_config_params(acp_session, "model", model),
                OPEN_TIMEOUT,
                false,
            )
            .map_err(|error| self.grok_failure(session_id, "Grok could not set the model", &error))?;
        }
        if let Some(effort) = effort {
            self.grok_call(
                session_id,
                "session/set_config_option",
                set_config_params(acp_session, "reasoning_effort", effort),
                OPEN_TIMEOUT,
                false,
            )
            .map_err(|error| self.grok_failure(session_id, "Grok could not set the effort", &error))?;
        }
        if self.stop_requested(session_id) {
            return Err("cancelled".into());
        }
        let (id, wire) = {
            let mut map = self.lock();
            let Some(Live::Grok(live)) = map.get_mut(session_id) else {
                return Err("Grok is not running.".into());
            };
            let id = live.next_id;
            live.next_id += 1;
            let wire = uuid::Uuid::new_v4().to_string();
            live.prompt_id = Some(id);
            live.prompt_wire = Some(wire.clone());
            // Handshake traffic is not the model answering.
            live.saw_output = false;
            (id, wire)
        };
        let line =
            json!({ "jsonrpc": "2.0", "id": id, "method": "session/prompt", "params": prompt_params(acp_session, text, &wire) });
        self.agents.write(session_id, &line.to_string())?;
        self.confirm_carried(session_id);
        Ok(())
    }

    fn grok_failure(&self, session_id: &str, head: &str, error: &str) -> String {
        let stderr = match self.lock().get(session_id) {
            Some(Live::Grok(live)) => live.stderr.join("\n"),
            _ => String::new(),
        };
        let mut message = format!("{head}: {error}");
        if !stderr.trim().is_empty() {
            message.push('\n');
            message.push_str(stderr.trim());
        }
        message
    }

    fn grok_call(&self, session_id: &str, method: &str, params: Value, timeout: Duration, load: bool) -> Result<Value, String> {
        let (tx, rx) = mpsc::channel();
        let id = {
            let mut map = self.lock();
            let Some(Live::Grok(live)) = map.get_mut(session_id) else {
                return Err("Grok is not running.".into());
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
            if let Some(Live::Grok(live)) = self.lock().get_mut(session_id) {
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

    fn grok_reply(&self, session_id: &str, rpc_id: &Value, result: Value) {
        let _ = self.agents.write(session_id, &json!({ "jsonrpc": "2.0", "id": rpc_id, "result": result }).to_string());
    }

    fn grok_reply_error(&self, session_id: &str, rpc_id: &Value, error: Value) {
        let _ = self.agents.write(session_id, &json!({ "jsonrpc": "2.0", "id": rpc_id, "error": error }).to_string());
    }

    /// Stop a Grok turn. `session/cancel` is sent, then the process group is
    /// killed: grok detaches the groups its tools run in, so a cancel alone
    /// leaves them. Returns false when there was no prompt to cancel.
    pub(super) fn grok_interrupt(&self, session_id: &str) -> bool {
        let (target, closed) = {
            let mut map = self.lock();
            let Some(Live::Grok(live)) = map.get_mut(session_id) else {
                return false;
            };
            let running = live.active && !live.cancelled && !live.settled && live.prompt_id.is_some();
            let target = running.then(|| live.acp_session.clone()).flatten();
            live.cancelled = true;
            live.hard_stop = true;
            for (_, pending) in live.approvals.drain() {
                let _ = pending.tx.send(ApprovalResolution::Cancelled);
            }
            for (_, pending) in live.questions.drain() {
                let _ = pending.tx.send(QuestionReply::Cancelled);
            }
            (target, live.close_open())
        };
        for event in closed {
            self.transcripts.apply(session_id, event);
        }
        let Some(acp_session) = target else {
            return false;
        };
        let line = json!({ "jsonrpc": "2.0", "method": "session/cancel", "params": cancel_params(&acp_session) });
        let _ = self.agents.write(session_id, &line.to_string());
        self.agents.kill(session_id);
        self.signal(session_id, TurnOutcome::Stopped);
        true
    }

    pub(super) fn grok_respond(&self, session_id: &str, request_id: u64, decision: ApprovalDecision) -> Option<()> {
        let mut map = self.lock();
        let Some(Live::Grok(live)) = map.get_mut(session_id) else {
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

    pub(crate) fn handle_grok_line(&self, session_id: &str, line: &str) {
        let Ok(message) = serde_json::from_str::<Value>(line) else {
            return;
        };
        let method = message.get("method").and_then(Value::as_str);
        let id = message.get("id").filter(|id| !id.is_null());
        let params = message.get("params").cloned().unwrap_or(Value::Null);
        match (method, id) {
            (None, Some(id)) => self.grok_response(session_id, id, &message),
            (Some(method), Some(id)) => self.grok_request(session_id, id.clone(), method, params),
            (Some(method), None) => self.grok_notification(session_id, method, &params),
            _ => {}
        }
    }

    fn grok_response(&self, session_id: &str, id: &Value, message: &Value) {
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
            let Some(Live::Grok(live)) = map.get_mut(session_id) else {
                return;
            };
            if live.load_id == Some(id) {
                live.load_id = None;
            }
            if live.prompt_id == Some(id) {
                live.prompt_id = None;
                if let Some(wire) = live.prompt_wire.take() {
                    remember_prompt(&mut live.settled_prompts, wire);
                }
                if !live.settled {
                    let (ev, end) = end_from(live, &answer);
                    events = ev;
                    outcome = Some(end);
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

    fn grok_request(&self, session_id: &str, rpc_id: Value, method: &str, params: Value) {
        let (ask, cancelled) = {
            let map = self.lock();
            let Some(Live::Grok(live)) = map.get(session_id) else {
                return;
            };
            (classify_request(method, &params, &live.tools, &live.autonomy), live.cancelled || live.settled)
        };
        match ask {
            GrokAsk::Unsupported => self.grok_reply_error(session_id, &rpc_id, unsupported_error(method)),
            GrokAsk::Allow(option) => self.grok_reply(session_id, &rpc_id, permission_response(Some(&option))),
            GrokAsk::Plan { text } => {
                if !text.is_empty() {
                    self.transcripts.apply(session_id, HarnessEvent::SessionNote { message: text });
                }
                self.grok_reply(session_id, &rpc_id, plan_response());
            }
            GrokAsk::Questions(questions) => {
                if cancelled || questions.is_empty() {
                    self.grok_reply(session_id, &rpc_id, questions_response(&questions, None));
                    return;
                }
                self.grok_question_wait(session_id, rpc_id, questions);
            }
            GrokAsk::Approval { name, title, input, allow, reject, session_edits } => {
                if cancelled {
                    self.grok_reply(session_id, &rpc_id, permission_response(None));
                    return;
                }
                self.grok_approval_wait(session_id, rpc_id, name, title, input, allow, reject, session_edits);
            }
        }
    }

    #[allow(clippy::too_many_arguments)]
    fn grok_approval_wait(
        &self,
        session_id: &str,
        rpc_id: Value,
        name: String,
        title: String,
        input: Value,
        allow: Option<String>,
        reject: Option<String>,
        session_edits: Option<String>,
    ) {
        let (tx, rx) = mpsc::channel();
        let ui_id = {
            let mut map = self.lock();
            let Some(Live::Grok(live)) = map.get_mut(session_id) else {
                return;
            };
            let ui_id = live.next_ui;
            live.next_ui += 1;
            live.approvals.insert(ui_id, Pending { tx });
            live.saw_output = true;
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
        self.transcripts
            .apply(session_id, HarnessEvent::ApprovalRequested { request_id: ui_id, name, title, input: Some(input.clone()) });
        self.child_asks(session_id, asked);
        let decision = rx.recv().unwrap_or(ApprovalResolution::Cancelled);
        self.transcripts.apply(session_id, HarnessEvent::ApprovalResolved { request_id: ui_id, decision: decision.clone() });
        let decided = match decision {
            ApprovalResolution::Cancelled => {
                self.grok_reply(session_id, &rpc_id, permission_response(None));
                return;
            }
            ApprovalResolution::Allow => ApprovalDecision::Allow,
            ApprovalResolution::Always => ApprovalDecision::Always,
            ApprovalResolution::Deny => ApprovalDecision::Deny,
        };
        self.transcripts.set_status(session_id, "working", None);
        self.grok_reply(
            session_id,
            &rpc_id,
            permission_answer(&decided, allow.as_deref(), reject.as_deref(), session_edits.as_deref()),
        );
    }

    fn grok_question_wait(&self, session_id: &str, rpc_id: Value, questions: Vec<GrokQuestion>) {
        let (tx, rx) = mpsc::channel();
        let ui_id = {
            let mut map = self.lock();
            let Some(Live::Grok(live)) = map.get_mut(session_id) else {
                return;
            };
            let ui_id = live.next_ui;
            live.next_ui += 1;
            live.questions.insert(ui_id, Pending { tx });
            live.saw_output = true;
            ui_id
        };
        let shown: Vec<crew_protocol::Question> = questions.iter().map(|asked| asked.question.clone()).collect();
        self.transcripts.set_status(session_id, "needs-input", None);
        let asked = json!({ "request_id": ui_id, "kind": "question", "questions": shown });
        self.transcripts.apply(session_id, HarnessEvent::QuestionRequested { request_id: ui_id, questions: shown });
        self.child_asks(session_id, asked);
        let answers = match rx.recv().unwrap_or(QuestionReply::Cancelled) {
            QuestionReply::Cancelled => {
                self.transcripts.apply(session_id, HarnessEvent::QuestionResolved { request_id: ui_id, answers: None });
                self.grok_reply(session_id, &rpc_id, questions_response(&questions, None));
                return;
            }
            QuestionReply::Dismiss => None,
            QuestionReply::Answers(answers) => Some(answers),
        };
        self.transcripts.apply(session_id, HarnessEvent::QuestionResolved { request_id: ui_id, answers: answers.clone() });
        self.transcripts.set_status(session_id, "working", None);
        self.grok_reply(session_id, &rpc_id, questions_response(&questions, answers.as_ref()));
    }

    pub(super) fn grok_answer(&self, session_id: &str, request_id: u64, answers: Option<super::Answers>) -> Option<()> {
        let mut map = self.lock();
        let Some(Live::Grok(live)) = map.get_mut(session_id) else {
            return None;
        };
        let pending = live.questions.remove(&request_id)?;
        let _ = pending.tx.send(match answers {
            Some(answers) => QuestionReply::Answers(answers),
            None => QuestionReply::Dismiss,
        });
        Some(())
    }

    fn grok_notification(&self, session_id: &str, method: &str, params: &Value) {
        // A prompt can finish on a notice while `session/prompt` stays open.
        // Both spellings, and a root `turn_completed` with the same id.
        if let Some(signal) = crate::providers::grok::prompt_signal(method, params) {
            self.grok_prompt_notice(session_id, &signal);
            return;
        }
        if let Some(done) = task_done(method, params) {
            self.grok_task_notice(session_id, &done);
            return;
        }
        // `_x.ai/session/update` repeats `session/update`. Reading both would
        // show every line twice. The notices above are the part that is not
        // a copy of a `session/update`.
        if method != "session/update" {
            return;
        }
        let Some(update) = params.get("update").and_then(as_record) else {
            return;
        };
        if string_field(Some(update), "sessionUpdate").as_deref() == Some("available_commands_update") {
            let cwd = match self.lock().get(session_id) {
                Some(Live::Grok(live)) => live.cwd.clone(),
                _ => return,
            };
            self.grok_catalog(session_id, &cwd, cursor_commands(params.get("update").unwrap_or(&Value::Null)));
            return;
        }
        let mut events = Vec::new();
        {
            let mut map = self.lock();
            let Some(Live::Grok(live)) = map.get_mut(session_id) else {
                return;
            };
            if live.load_id.is_some() || live.cancelled || live.settled {
                return;
            }
            grok_update(live, update, &mut events);
        }
        for event in events {
            self.transcripts.apply(session_id, event);
        }
    }

    fn grok_prompt_notice(&self, session_id: &str, signal: &PromptSignal) {
        let (events, outcome) = {
            let mut map = self.lock();
            let Some(Live::Grok(live)) = map.get_mut(session_id) else {
                return;
            };
            if live.settled_prompts.iter().any(|id| id == &signal.prompt_id) {
                return;
            }
            if live.prompt_wire.as_deref() != Some(signal.prompt_id.as_str()) || live.settled {
                return;
            }
            live.prompt_id = None;
            live.prompt_wire = None;
            remember_prompt(&mut live.settled_prompts, signal.prompt_id.clone());
            let answer = Ok(json!({ "stopReason": signal.stop_reason }));
            end_from(live, &answer)
        };
        for event in events {
            self.transcripts.apply(session_id, event);
        }
        self.signal(session_id, outcome);
    }

    fn grok_task_notice(&self, session_id: &str, done: &crate::providers::grok::TaskDone) {
        let mut events = Vec::new();
        {
            let mut map = self.lock();
            let Some(Live::Grok(live)) = map.get_mut(session_id) else {
                return;
            };
            if live.load_id.is_some() {
                return;
            }
            let id = done.tool_call_id.clone().or_else(|| {
                live.tools
                    .iter()
                    .find_map(|(id, tool)| (done.task_id.is_some() && tool.task_id == done.task_id).then(|| id.clone()))
            });
            let Some(id) = id else {
                return;
            };
            if !live.open.iter().any(|open| open == &id) {
                return;
            }
            live.open.retain(|open| open != &id);
            let failed = done.exit_code.is_some_and(|code| code != 0);
            events.push(HarnessEvent::ToolUpdated {
                call_id: id,
                title: None,
                status: Some(if failed { ToolStatus::Failed } else { ToolStatus::Completed }),
                detail: None,
            });
        }
        for event in events {
            self.transcripts.apply(session_id, event);
        }
    }
}

fn remember_prompt(seen: &mut Vec<String>, id: String) {
    if seen.iter().any(|had| had == &id) {
        return;
    }
    seen.push(id);
    if seen.len() > SETTLED_PROMPTS {
        let extra = seen.len() - SETTLED_PROMPTS;
        seen.drain(0..extra);
    }
}

fn end_from(live: &mut GrokLive, answer: &Result<Value, String>) -> (Vec<HarnessEvent>, TurnOutcome) {
    match answer {
        Err(error) => (Vec::new(), TurnOutcome::Failed(error.clone())),
        Ok(_) if live.cancelled => (live.close_open(), TurnOutcome::Stopped),
        Ok(result) => match turn_end(result) {
            TurnEnd::Cancelled => (live.close_open(), TurnOutcome::Stopped),
            TurnEnd::Failed(message) => (Vec::new(), TurnOutcome::Failed(message)),
            TurnEnd::Completed(note) => {
                let mut events = vec![HarnessEvent::MessageCompleted {}];
                if let Some(message) = note {
                    events.push(HarnessEvent::SessionNote { message });
                }
                events.push(HarnessEvent::TurnCompleted { usage: None });
                (events, TurnOutcome::Completed)
            }
        },
    }
}

fn grok_update(live: &mut GrokLive, update: &Map<String, Value>, events: &mut Vec<HarnessEvent>) {
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
        // The prompt's own text, replayed. Not a new message.
        Some("user_message_chunk") => {}
        Some("agent_message_chunk") => {
            if let Some(text) = text() {
                live.saw_output = true;
                events.push(HarnessEvent::MessageDelta { text });
            }
        }
        // Readable when grok sends it. An empty chunk is encrypted reasoning,
        // and it does not count as the model having spoken.
        Some("agent_thought_chunk") => {
            if let Some(text) = text() {
                live.saw_output = true;
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
            let ready = tool.named() || matches!(status.as_str(), "in_progress" | "completed" | "failed");
            if !live.started.contains(&id) {
                let unnamed =
                    tool.use_tool().is_none() && (tool.title == "use_tool" || tool.native.as_deref() == Some("use_tool"));
                if !ready || unnamed {
                    return;
                }
                live.started.insert(id.clone());
                live.open.push(id.clone());
                live.saw_output = true;
                events.push(HarnessEvent::ToolStarted {
                    call_id: id.clone(),
                    name: tool_name(&tool),
                    title: tool_label(&tool),
                    detail: tool_detail(&tool, output),
                });
            } else if renamed && kind == "tool_call_update" {
                live.saw_output = true;
                events.push(HarnessEvent::ToolUpdated {
                    call_id: id.clone(),
                    title: Some(tool_label(&tool)),
                    status: None,
                    detail: tool_detail(&tool, output),
                });
            }
            if let Some(end) = tool_end(&status, output) {
                live.open.retain(|open| *open != id);
                live.saw_output = true;
                events.push(HarnessEvent::ToolUpdated {
                    call_id: id,
                    title: None,
                    status: Some(end),
                    detail: tool_detail(&tool, output),
                });
            }
        }
        _ => {}
    }
}

/// A stand-in for `grok agent stdio` that speaks the part of the protocol Crew
/// uses. Every message it gets is appended to the log as `{method, params}`
/// (an answer as `{answer, result}`), after a first line with its argv and the
/// isolation env. What a turn does is spelled in its last line: `USE` calls
/// `crew__send_message` through `use_tool`, `ASK` asks to run a shell command,
/// `EDIT` asks to edit a file, `QUESTION` asks the user, `PLAN` exits plan
/// mode, `MONITOR` stays in progress until `task_completed`, `HANG` never
/// answers `session/prompt` and sends `prompt_complete` instead, `SLEEP <s>`
/// runs one that long, `FAIL` fails the prompt, `STUBBORN` ignores a cancel.
/// It answers `report: <last line>`.
#[cfg(test)]
pub(crate) fn fake_grok(dir: &std::path::Path) -> (String, std::path::PathBuf) {
    let tag = uuid::Uuid::new_v4().simple().to_string();
    let log = dir.join(format!("fake-grok-{tag}.log"));
    let script = r##"#!/usr/bin/env python3
import json, os, sys, threading, time, uuid
HERE = os.path.dirname(os.path.abspath(sys.argv[0]))
TAG = os.path.basename(sys.argv[0])[len("fake-grok-"):]
LOG = os.path.join(HERE, "fake-grok-" + TAG + ".log")
STORE = os.path.join(HERE, "fake-grok-" + TAG + "-sessions")
os.makedirs(STORE, exist_ok=True)
lock = threading.Lock()
def out(m):
    m["jsonrpc"] = "2.0"
    with lock:
        sys.stdout.write(json.dumps(m) + "\n"); sys.stdout.flush()
def log(m):
    with open(LOG, "a") as f: f.write(json.dumps(m) + "\n")
KEYS = ["CREW_SOCKET","CREW_TOKEN","GROK_CLAUDE_HOOKS_ENABLED","GROK_CLAUDE_MCPS_ENABLED","GROK_CURSOR_HOOKS_ENABLED","GROK_CURSOR_MCPS_ENABLED","GROK_DISABLE_AUTOUPDATER","_GROK_CLAUDE_MARKER_OVERRIDE"]
log({"argv": sys.argv[1:], "env": {k: os.environ.get(k) for k in KEYS}})
state = {"next": 0, "turn": None}
answers = {}
def update(sid, u):
    out({"method": "session/update", "params": {"sessionId": sid, "update": u}})
def ask(method, params):
    with lock:
        rid = state["next"]; state["next"] += 1
        answers[rid] = threading.Event()
    out({"id": rid, "method": method, "params": params})
    while not answers[rid].is_set():
        time.sleep(0.02)
    return answers[rid].result
def saved(sid):
    p = os.path.join(STORE, sid + ".json")
    return json.load(open(p)) if os.path.exists(p) else None
def save(sid, convo):
    json.dump(convo, open(os.path.join(STORE, sid + ".json"), "w"))
def run(rid, sid, text, turn):
    heard = [text.strip().splitlines()[-1] if text.strip() else ""]
    text = heard[0]
    update(sid, {"sessionUpdate": "agent_thought_chunk", "content": {"type": "text", "text": "thinking"}})
    if "HANG" in text:
        pid = turn.get("promptId") or ""
        update(sid, {"sessionUpdate": "agent_message_chunk", "content": {"type": "text", "text": "hung-done"}})
        out({"method": "x.ai/session/prompt_complete", "params": {"sessionId": sid, "promptId": "task-completed-" + pid, "stopReason": "cancelled"}})
        time.sleep(0.05)
        out({"method": "_x.ai/session/prompt_complete", "params": {"sessionId": sid, "promptId": pid, "stopReason": "end_turn"}})
        state["turn"] = None
        return
    if "QUESTION" in text:
        got = ask("x.ai/ask_user_question", {"sessionId": sid, "toolCallId": "q1", "mode": "default", "questions": [{"id": "scope", "question": "Which scope?", "options": [{"label": "Workspace", "description": "here"}, {"label": "Session"}]}]})
        heard.append("answer: %s" % json.dumps((got or {}).get("answers")))
    if "PLAN" in text:
        got = ask("_x.ai/exit_plan_mode", {"sessionId": sid, "toolCallId": "p1", "planContent": "Do the thing."})
        heard.append("plan: %s" % ((got or {}).get("outcome")))
    if "EDIT" in text:
        cid = "tool_" + uuid.uuid4().hex[:8]
        got = ask("session/request_permission", {"sessionId": sid, "toolCall": {"toolCallId": cid, "kind": "edit", "title": "edit file", "rawInput": {"path": "a.txt"}}, "options": [{"kind": "allow_always", "optionId": "allow-edits-session", "name": "edits"}, {"kind": "allow_always", "optionId": "always-allow", "name": "always"}, {"kind": "allow_once", "optionId": "allow-once", "name": "Yes"}, {"kind": "reject_once", "optionId": "reject-once", "name": "No"}]})
        outcome = (got or {}).get("outcome", {})
        heard.append("decision: %s" % (outcome.get("optionId") or outcome.get("outcome")))
    if "MONITOR" in text:
        cid = "mon_" + uuid.uuid4().hex[:8]
        update(sid, {"sessionUpdate": "tool_call", "toolCallId": cid, "title": "Tool", "kind": "execute", "status": "in_progress", "rawInput": {"variant": "Bash", "command": "tail -f log", "is_background": True}, "rawOutput": {"type": "Monitor", "taskId": "task-1", "exit_code": 0, "output": ""}})
        out({"method": "_x.ai/task_completed", "params": {"sessionId": sid, "update": {"sessionUpdate": "task_completed", "tool_call_id": cid, "task_id": "task-1", "task_snapshot": {"exit_code": 0, "kind": "monitor"}}}})
    if "USE" in text:
        cid = "tool_" + uuid.uuid4().hex[:8]
        update(sid, {"sessionUpdate": "tool_call", "toolCallId": cid, "title": "use_tool", "kind": "other", "status": "pending", "rawInput": {"tool_name": "crew__send_message", "tool_input": {"to": "lead", "text": "hi"}}})
        update(sid, {"sessionUpdate": "tool_call_update", "toolCallId": cid, "title": "crew__send_message", "kind": "other", "status": "completed", "rawInput": {"variant": "UseTool", "tool_name": "crew__send_message", "tool_input": {"to": "lead", "text": "hi"}}, "rawOutput": {"type": "MCP", "server_name": "crew", "tool_name": "send_message"}})
    if "ASK" in text:
        cid = "tool_" + uuid.uuid4().hex[:8]
        update(sid, {"sessionUpdate": "tool_call", "toolCallId": cid, "title": "run_terminal_command", "status": "pending", "rawInput": {"command": "printf hi > asked.txt", "description": "write"}})
        got = ask("session/request_permission", {"sessionId": sid, "toolCall": {"toolCallId": cid, "kind": "execute", "title": "Execute `printf hi > asked.txt`", "rawInput": {"variant": "Bash", "command": "printf hi > asked.txt", "description": "write", "is_background": False}}, "options": [{"kind": "allow_always", "optionId": "always-allow", "name": "always"}, {"kind": "allow_once", "optionId": "allow-once", "name": "Yes"}, {"kind": "reject_once", "optionId": "reject-once", "name": "No"}, {"kind": "reject_always", "optionId": "reject-always", "name": "never"}]})
        outcome = (got or {}).get("outcome", {})
        heard.append("decision: %s" % (outcome.get("optionId") or outcome.get("outcome")))
        update(sid, {"sessionUpdate": "tool_call_update", "toolCallId": cid, "status": "completed", "rawOutput": {"exit_code": 0, "output": ""}})
    m = __import__("re").search(r"SLEEP ([0-9.]+)", text)
    if m:
        cid = "tool_" + uuid.uuid4().hex[:8]
        update(sid, {"sessionUpdate": "tool_call", "toolCallId": cid, "title": "run_terminal_command", "kind": "execute", "status": "in_progress", "rawInput": {"command": "sleep %s" % m.group(1)}})
        end = time.time() + float(m.group(1))
        stubborn = "STUBBORN" in text
        while time.time() < end and not (turn["cancelled"].is_set() and not stubborn):
            time.sleep(0.02)
        if not turn["cancelled"].is_set():
            update(sid, {"sessionUpdate": "tool_call_update", "toolCallId": cid, "status": "completed", "rawOutput": {"exit_code": 0, "output": ""}})
    if turn["cancelled"].is_set() and "STUBBORN" not in text:
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
    update(sid, {"sessionUpdate": "agent_message_chunk", "content": {"type": "text", "text": reply}})
    convo = saved(sid) or []
    convo.append({"user": text, "agent": reply})
    save(sid, convo)
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
        out({"id": rid, "result": {"protocolVersion": 1, "agentCapabilities": {"loadSession": True, "promptCapabilities": {"image": False}}}})
    elif method == "session/new":
        sid = str(uuid.uuid4())
        save(sid, [])
        out({"id": rid, "result": {"sessionId": sid}})
        update(sid, {"sessionUpdate": "available_commands_update", "availableCommands": [{"name": "compact", "description": "Compact", "input": None}]})
    elif method == "session/load":
        sid = params.get("sessionId")
        convo = saved(sid)
        if convo is None:
            out({"id": rid, "error": {"code": -32602, "message": "Invalid params", "data": {"message": "Session not found"}}})
            continue
        for turn in convo:
            update(sid, {"sessionUpdate": "user_message_chunk", "content": {"type": "text", "text": turn["user"]}})
            update(sid, {"sessionUpdate": "agent_message_chunk", "content": {"type": "text", "text": turn["agent"]}})
        out({"id": rid, "result": {}})
    elif method == "session/set_config_option":
        out({"id": rid, "result": {"configOptions": [{"id": params.get("configId"), "currentValue": params.get("value")}]}})
    elif method == "session/prompt":
        if state["turn"]:
            out({"id": rid, "error": {"code": -32600, "message": "a prompt is already running"}})
            continue
        sid = params.get("sessionId")
        text = "\n".join(p.get("text", "") for p in params.get("prompt", []))
        turn = {"cancelled": threading.Event(), "promptId": (params.get("_meta") or {}).get("promptId")}
        state["turn"] = turn
        threading.Thread(target=run, args=(rid, sid, text, turn), daemon=True).start()
    else:
        out({"id": rid, "error": {"code": -32601, "message": "Method not found: " + str(method)}})
"##;
    let path = crate::fakes::install(dir, &format!("fake-grok-{tag}"), script);
    (path.to_string_lossy().into_owned(), log)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::turns::TurnHost;

    struct Lines(TurnHost);

    impl crate::agent::AgentEvents for Lines {
        fn lines(&self, event: &str, session_id: &str, lines: Vec<String>) {
            self.0.on_agent_lines(event, session_id, lines);
        }
        fn exit(&self, session_id: &str, code: Option<i32>, _pid: u32) {
            self.0.on_agent_exit(session_id, code);
        }
    }

    struct Kept {
        host: TurnHost,
        session: String,
        cwd: String,
        log: std::path::PathBuf,
    }

    impl Kept {
        fn child() -> Self {
            let host = TurnHost::test_new();
            host.test_agents().set_events(std::sync::Arc::new(Lines(host.clone())));
            let dir = std::env::temp_dir().join(format!("crew-grok-{}", uuid::Uuid::new_v4()));
            std::fs::create_dir_all(&dir).expect("dir");
            let workspace =
                crate::workspace::create(host.test_store(), "w".into(), dir.to_string_lossy().into()).expect("workspace").id;
            let session = crate::session::create(
                host.test_store(),
                workspace,
                "terminal".into(),
                "shell".into(),
                "grok".into(),
                "grok-4.5".into(),
                String::new(),
                "full".into(),
            )
            .expect("session");
            crate::session::set_options(
                host.test_store(),
                session.id.clone(),
                session.model,
                "low".into(),
                session.service_tier,
                session.autonomy,
            )
            .expect("effort");
            let session = session.id;
            let cwd = dir.to_string_lossy().into_owned();
            let (fake, log) = fake_grok(std::path::Path::new(&cwd));
            host.override_binary("grok", fake);
            Self { host, session, cwd, log }
        }

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
                std::thread::sleep(std::time::Duration::from_millis(25));
            }
            panic!("the turn never ended: {:?}", self.log());
        }

        fn until(&self, what: &str, done: impl Fn() -> bool) {
            for _ in 0..800 {
                if done() {
                    return;
                }
                std::thread::sleep(std::time::Duration::from_millis(25));
            }
            panic!("never {what}: {:?}", self.log());
        }

        fn log(&self) -> Vec<Value> {
            std::fs::read_to_string(&self.log)
                .unwrap_or_default()
                .lines()
                .filter_map(|line| serde_json::from_str(line).ok())
                .collect()
        }

        fn count(&self, method: &str) -> usize {
            self.log().iter().filter(|line| line["method"] == method).count()
        }

        fn launches(&self) -> Vec<Vec<String>> {
            self.log()
                .iter()
                .filter_map(|line| line.get("argv"))
                .filter_map(|argv| argv.as_array())
                .map(|argv| argv.iter().filter_map(|arg| arg.as_str().map(str::to_string)).collect())
                .collect()
        }
    }

    /// `_x.ai/session/update` repeats `session/update`. A thought on the real
    /// channel is shown; the copy is not.
    #[test]
    fn a_duplicate_xai_update_is_not_shown_twice() {
        let host = TurnHost::test_new();
        let cap = host.test_capture();
        host.test_install_grok("s");
        let line = |method: &str, text: &str| {
            json!({
                "jsonrpc": "2.0",
                "method": method,
                "params": { "sessionId": "s", "update": { "sessionUpdate": "agent_thought_chunk", "content": { "type": "text", "text": text } } }
            })
            .to_string()
        };
        host.handle_grok_line("s", &line("session/update", "once"));
        host.handle_grok_line("s", &line("_x.ai/session/update", "twice"));
        assert_eq!(cap.take(), vec![HarnessEvent::ReasoningDelta { text: "once".into() }]);
    }

    #[test]
    fn a_turn_unwraps_use_tool_and_sets_the_sessions_model() {
        let k = Kept::child();
        k.say("USE");
        assert_eq!(k.launches().len(), 1, "{:?}", k.log());
        let argv = &k.launches()[0];
        assert_eq!(argv.first().map(String::as_str), Some("--no-auto-update"), "{argv:?}");
        assert!(
            argv.windows(2).any(|pair| pair == ["--always-approve", "--no-leader"] || pair[0] == "--always-approve"),
            "{argv:?}"
        );
        let prompt = k.log().into_iter().find(|line| line["method"] == "session/prompt").expect("prompt");
        assert!(!prompt["params"]["_meta"]["promptId"].as_str().unwrap_or("").is_empty());
        let init = k.log().into_iter().find(|line| line["method"] == "initialize").expect("initialize");
        assert_eq!(init["params"]["_meta"]["clientType"], "extension");
        assert!(!argv.iter().any(|arg| arg == "--model"), "{argv:?}");
        let env = &k.log()[0]["env"];
        assert_eq!(env["GROK_CLAUDE_HOOKS_ENABLED"], "0");
        assert_eq!(env["GROK_CLAUDE_MCPS_ENABLED"], "0");
        assert_eq!(env["GROK_CURSOR_HOOKS_ENABLED"], "0");
        assert_eq!(env["GROK_CURSOR_MCPS_ENABLED"], "0");
        assert_eq!(env["GROK_DISABLE_AUTOUPDATER"], "1");
        assert_eq!(env["_GROK_CLAUDE_MARKER_OVERRIDE"], "1");
        let model = k
            .log()
            .into_iter()
            .find(|line| line["method"] == "session/set_config_option" && line["params"]["configId"] == "model");
        let model = model.expect("model");
        assert_eq!(model["params"]["value"], "grok-4.5");
        let effort = k.log().into_iter().find(|line| line["params"]["configId"] == "reasoning_effort").expect("effort");
        assert_eq!(effort["params"]["value"], "low");
        let blocks = k.host.transcripts().since(&k.session, 0).0;
        let tool = blocks.iter().find_map(|block| block.tool.clone()).expect("a tool row");
        assert_eq!(tool.name, "mcp__crew__send_message");
        assert_ne!(tool.name, "use_tool");
        assert!(tool.title.contains("lead"), "{tool:?}");
        assert!(blocks.iter().any(|block| block.text.contains("report: USE")), "{blocks:?}");
        assert!(
            blocks.iter().any(|block| block.role == crew_protocol::BlockRole::Reasoning && block.text == "thinking"),
            "{blocks:?}"
        );
    }

    #[test]
    fn two_turns_keep_one_process_and_a_model_change_does_not_relaunch() {
        let k = Kept::child();
        k.say("one");
        k.say("two");
        assert_eq!(k.launches().len(), 1, "{:?}", k.log());
        assert_eq!((k.count("session/new"), k.count("session/load"), k.count("session/prompt")), (1, 0, 2));
        let row = k.host.test_store();
        let session = crate::session::get(row, k.session.clone()).expect("row").expect("session");
        crate::session::set_options(
            k.host.test_store(),
            k.session.clone(),
            "grok-4.6".into(),
            session.effort,
            session.service_tier,
            session.autonomy,
        )
        .expect("options");
        k.say("three");
        assert_eq!(k.launches().len(), 1, "a model change relaunched: {:?}", k.log());
        let models: Vec<String> = k
            .log()
            .into_iter()
            .filter(|line| line["method"] == "session/set_config_option" && line["params"]["configId"] == "model")
            .map(|line| line["params"]["value"].as_str().unwrap_or_default().to_string())
            .collect();
        assert!(models.contains(&"grok-4.5".to_string()) && models.contains(&"grok-4.6".to_string()), "{models:?}");
    }

    #[test]
    fn an_approval_is_a_card_and_always_is_allow_once() {
        let k = Kept::child();
        let session = crate::session::get(k.host.test_store(), k.session.clone()).expect("row").expect("session");
        crate::session::set_options(
            k.host.test_store(),
            k.session.clone(),
            session.model,
            session.effort,
            session.service_tier,
            "ask".into(),
        )
        .expect("ask");
        k.send("ASK");
        k.until("the card", || k.host.transcripts().since(&k.session, 0).0.iter().any(|block| block.approval.is_some()));
        let blocks = k.host.transcripts().since(&k.session, 0).0;
        let approval = blocks.iter().find_map(|block| block.approval.clone()).expect("approval");
        assert_eq!(approval.name, "bash");
        k.host.respond(&k.session, approval.request_id, ApprovalDecision::Always).expect("respond");
        k.settle();
        let answer = k.log().into_iter().find(|line| line.get("answer").is_some()).expect("answer");
        assert_eq!(answer["result"]["outcome"]["optionId"], "allow-once");
        let blocks = k.host.transcripts().since(&k.session, 0).0;
        assert!(blocks.iter().any(|block| block.text.contains("decision: allow-once")), "{blocks:?}");
    }

    #[test]
    fn a_stop_kills_the_process_group_and_the_next_turn_loads() {
        let k = Kept::child();
        k.send("SLEEP 30");
        k.until("the prompt", || k.count("session/prompt") == 1);
        std::thread::sleep(std::time::Duration::from_millis(200));
        k.host.stop(&k.session).expect("stop");
        k.settle();
        // The cancel is written and the group is killed at once. The process
        // can be gone before it logs the line; the payload is checked beside
        // `cancel_params`.
        assert!(k.host.idle_since(&k.session).is_none());
        k.say("again");
        assert_eq!(k.launches().len(), 2, "{:?}", k.log());
        assert_eq!(k.count("session/load"), 1);
    }

    #[test]
    fn an_autonomy_change_relaunches_and_loads_the_session() {
        let k = Kept::child();
        k.say("one");
        let session = crate::session::get(k.host.test_store(), k.session.clone()).expect("row").expect("session");
        crate::session::set_options(
            k.host.test_store(),
            k.session.clone(),
            session.model,
            session.effort,
            session.service_tier,
            "ask".into(),
        )
        .expect("options");
        k.say("two");
        assert_eq!(k.launches().len(), 2, "{:?}", k.log());
        assert!(k.launches()[1].windows(2).any(|pair| pair == ["--permission-mode", "default"]), "{:?}", k.launches());
        assert_eq!((k.count("session/new"), k.count("session/load")), (1, 1));
        let blocks = k.host.transcripts().since(&k.session, 0).0;
        assert!(blocks.iter().any(|block| block.text.contains("report: two")), "the load's replay was shown: {blocks:?}");
    }

    #[test]
    fn a_stop_grok_ignores_lets_the_process_go() {
        let k = Kept::child();
        k.say("one");
        k.send("SLEEP 30 STUBBORN");
        k.until("the second prompt", || k.count("session/prompt") == 2);
        std::thread::sleep(std::time::Duration::from_millis(200));
        k.host.stop(&k.session).expect("stop");
        k.settle();
        assert!(k.host.idle_since(&k.session).is_none());
        k.say("three");
        assert_eq!(k.launches().len(), 2, "{:?}", k.log());
        assert_eq!(k.count("session/load"), 1);
    }

    #[test]
    fn a_prompt_complete_ends_the_turn_and_a_task_wake_does_not() {
        let k = Kept::child();
        k.say("HANG");
        let blocks = k.host.transcripts().since(&k.session, 0).0;
        assert!(blocks.iter().any(|block| block.text.contains("hung-done")), "{blocks:?}");
        assert!(!blocks.iter().any(|block| block.text.contains("cancelled")), "{blocks:?}");
    }

    #[test]
    fn full_access_allows_a_shell_once_and_edits_allow_the_session() {
        let k = Kept::child();
        k.say("ASK");
        let answer = k.log().into_iter().find(|line| line.get("answer").is_some()).expect("answer");
        assert_eq!(answer["result"]["outcome"]["optionId"], "allow-once");
        assert!(k.host.transcripts().since(&k.session, 0).0.iter().all(|block| block.approval.is_none()));
        let session = crate::session::get(k.host.test_store(), k.session.clone()).expect("row").expect("session");
        crate::session::set_options(
            k.host.test_store(),
            k.session.clone(),
            session.model,
            session.effort,
            session.service_tier,
            "edits".into(),
        )
        .expect("edits");
        k.say("EDIT");
        let edits = k
            .log()
            .into_iter()
            .filter(|line| line.get("answer").is_some())
            .map(|line| line["result"]["outcome"]["optionId"].as_str().unwrap_or("").to_string())
            .collect::<Vec<_>>();
        assert!(edits.iter().any(|id| id == "allow-edits-session"), "{edits:?}");
        assert!(!edits.iter().any(|id| id == "always-allow"), "{edits:?}");
        assert!(k.launches()[1].windows(2).any(|pair| pair == ["--permission-mode", "default"]), "{:?}", k.launches());
    }

    #[test]
    fn a_question_and_a_plan_are_answered_so_the_turn_can_finish() {
        let k = Kept::child();
        k.send("QUESTION");
        k.until("the question", || k.host.transcripts().since(&k.session, 0).0.iter().any(|block| block.question.is_some()));
        let question =
            k.host.transcripts().since(&k.session, 0).0.into_iter().find_map(|block| block.question).expect("question");
        let mut answers = std::collections::HashMap::new();
        answers.insert("Which scope?".into(), "Workspace".into());
        k.host.answer(&k.session, question.request_id, Some(answers)).expect("answer");
        k.settle();
        let blocks = k.host.transcripts().since(&k.session, 0).0;
        assert!(blocks.iter().any(|block| block.text.contains("Workspace")), "{blocks:?}");
        k.say("PLAN");
        let blocks = k.host.transcripts().since(&k.session, 0).0;
        assert!(blocks.iter().any(|block| block.text.contains("Do the thing.")), "{blocks:?}");
        let plan = k.log().into_iter().rev().find(|line| line.get("answer").is_some()).expect("plan");
        assert_eq!(plan["result"]["outcome"], "abandoned");
    }

    #[test]
    fn a_monitor_stays_open_until_task_completed() {
        let k = Kept::child();
        k.say("MONITOR");
        let tool = k.host.transcripts().since(&k.session, 0).0.into_iter().find_map(|block| block.tool).expect("tool");
        assert_eq!(tool.status, ToolStatus::Completed);
        assert_eq!(tool.name, "bash");
    }

    #[test]
    fn a_commands_update_does_not_count_as_the_model_speaking() {
        let host = TurnHost::test_new();
        host.test_install_grok("s");
        let commands = json!({
            "jsonrpc": "2.0",
            "method": "session/update",
            "params": { "update": { "sessionUpdate": "available_commands_update", "availableCommands": [] } }
        })
        .to_string();
        host.on_agent_lines("stdout", "s", vec![commands]);
        let silent = matches!(host.lock().get("s"), Some(Live::Grok(live)) if !live.saw_output);
        assert!(silent);
        let thought = json!({
            "jsonrpc": "2.0",
            "method": "session/update",
            "params": { "update": { "sessionUpdate": "agent_thought_chunk", "content": { "type": "text", "text": "" } } }
        })
        .to_string();
        host.on_agent_lines("stdout", "s", vec![thought]);
        let still = matches!(host.lock().get("s"), Some(Live::Grok(live)) if !live.saw_output);
        assert!(still, "an empty thought is not output");
    }
}
