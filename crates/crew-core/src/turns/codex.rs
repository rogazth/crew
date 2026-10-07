//! The Codex driver: one `codex app-server` per turn of a bot or a child,
//! spoken to in JSON-RPC over its stdio. The process is spawned when the turn
//! starts and killed when it ends, as Claude's is: a child carries on its
//! thread with `thread/resume`, a bot starts a clean one with the tail Crew
//! hands it. While the turn runs, Crew can steer it, interrupt it, and answer
//! the approvals and questions it sends, through the same events and cards as
//! Claude's.
//!
//! The protocol itself (params, items, request shapes) is in
//! `providers/codex.rs`.

use std::collections::{HashMap, HashSet};
use std::sync::mpsc::{self, RecvTimeoutError};
use std::thread;
use std::time::Duration;

use crew_protocol::{ApprovalDecision, ApprovalResolution, HarnessEvent};
use serde_json::{json, Map, Value};
use tokio::sync::oneshot;

use super::{
    child_resume, path_list, Harness, QuestionReply, Steer, TurnHost,
    TurnOutcome, INIT_TIMEOUT,
};
use crate::mailbox;
use crate::providers::codex::{
    approval_response, classify_request, completed_tool_status, exec_item, initialize_params, interrupt_params,
    is_tool_item, item_files, plan_detail, questions_response, rpc_error_message, steer_params, thread_id,
    thread_request, tool_call_id, tool_detail, tool_label, tool_name, turn_end, turn_id, turn_start_params,
    unsupported_error, user_message_text, with_attached_paths, ApprovalKind, CodexAsk, CodexThread, TurnEnd,
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
pub(super) const INTERRUPT_GRACE: Duration = Duration::from_secs(3);

/// How often the background terminals are listed while a command runs.
const TERMINAL_POLL: Duration = Duration::from_secs(2);

/// A request the app server is waiting on Crew for, by the id the UI knows.
pub(super) struct Pending<T> {
    rpc_id: Value,
    tx: mpsc::Sender<T>,
}

pub(super) struct CodexLive {
    thread_id: Option<String>,
    /// The turn that is running. `turn/start` on a busy thread would steer
    /// it without a word, so this is what says whether one is.
    turn_id: Option<String>,
    next_id: u64,
    /// Requests Crew sent, waiting for their answer.
    calls: HashMap<u64, mpsc::Sender<Result<Value, String>>>,
    pub(super) approvals: HashMap<u64, Pending<ApprovalResolution>>,
    pub(super) questions: HashMap<u64, Pending<QuestionReply>>,
    next_ui: u64,
    /// Items the turn started, by id: a file-change approval names only its
    /// item, and the item has the files.
    items: HashMap<String, Map<String, Value>>,
    seen_tools: HashSet<String>,
    /// The agent message being written, and what of it is in the transcript.
    message: Option<(String, String)>,
    /// Steers Codex accepted and has not echoed yet, oldest first.
    steers: Vec<Steer>,
    pub(super) active: bool,
    pub(super) cancelled: bool,
    pub(super) settled: bool,
    pub(super) turn_tx: Option<oneshot::Sender<TurnOutcome>>,
    pub(super) stderr: Vec<String>,
    pub(super) saw_output: bool,
}

impl CodexLive {
    pub(super) fn new(turn_tx: Option<oneshot::Sender<TurnOutcome>>) -> Self {
        Self {
            thread_id: None,
            turn_id: None,
            next_id: 1,
            calls: HashMap::new(),
            approvals: HashMap::new(),
            questions: HashMap::new(),
            next_ui: 1,
            items: HashMap::new(),
            seen_tools: HashSet::new(),
            message: None,
            steers: Vec::new(),
            active: true,
            cancelled: false,
            settled: false,
            turn_tx,
            stderr: Vec::new(),
            saw_output: false,
        }
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
    pub(super) fn run_codex(
        &self,
        session: crate::session::Session,
        params: crew_protocol::TurnStart,
        history: Option<String>,
    ) -> TurnOutcome {
        let session_id = session.id.clone();
        self.agents.kill(&session_id);
        let (tx, turn_rx) = oneshot::channel();
        self.lock()
            .insert(session_id.clone(), Live::Codex(Box::new(CodexLive::new(Some(tx)))));
        self.background.touch(&session_id, crate::background::Board::begin);
        self.watch_for_silence(&session_id);
        // A stop that came before the CLI was there to take it.
        if self.stop_requested(&session_id) {
            self.detach(&session_id);
            return TurnOutcome::Stopped;
        }
        let path = match self.resolve_bin("codex") {
            Ok(path) => path,
            Err(error) => {
                self.detach(&session_id);
                return TurnOutcome::Failed(error);
            }
        };
        let mcp = self.mcp();
        let child = session.kind == "child";
        // Every turn: Codex keeps no system prompt Crew can set, and newer
        // catalogs override developer instructions.
        let instructions = self.persona(&session, Harness::Mcp, mcp.is_some(), &params.cwd);
        let files = path_list(&params, &HashSet::new());
        let text = if child {
            crate::providers::with_files(params.text.trim(), &files)
        } else {
            crate::providers::assemble(
                String::new(),
                history.as_deref(),
                &with_attached_paths(params.text.trim(), &files),
            )
        };
        // Minted once and used twice: the agent's own shell gets it, and so
        // does the MCP server codex starts for it. A second mint would retire
        // the first.
        let env = self.agent_env(&session_id);
        let thread = CodexThread {
            cwd: params.cwd.clone(),
            resume: child_resume(&session),
            model: Some(session.model.clone()).filter(|m| !m.is_empty()),
            effort: Some(session.effort.clone()).filter(|e| !e.is_empty()),
            service_tier: Some(session.service_tier.clone()).filter(|tier| !tier.is_empty()),
            autonomy: self.autonomy(&session),
            mcp,
            mcp_env: env.clone().into_iter().collect(),
        };
        if let Err(error) = self.agents.spawn(
            session_id.clone(),
            path,
            vec!["app-server".into()],
            params.cwd.clone(),
            Some(env),
        ) {
            self.detach(&session_id);
            return TurnOutcome::Failed(error);
        }
        let outcome = match self.codex_open(&session_id, &thread, &text, &instructions) {
            Ok(()) => {
                self.watch_terminals(&session_id);
                self
                    .block_on(turn_rx)
                    .unwrap_or(TurnOutcome::Failed("Turn channel closed".into()))
            }
            Err(_) if self.stop_requested(&session_id) => TurnOutcome::Stopped,
            Err(error) => TurnOutcome::Failed(error),
        };
        // A steer the turn ended before reading is not lost: it waits in the
        // box, and the end of this turn hands it over as the next one.
        let unread = match self.lock().get_mut(&session_id) {
            Some(Live::Codex(live)) => {
                live.release();
                std::mem::take(&mut live.steers)
            }
            _ => Vec::new(),
        };
        for steer in unread {
            steer.put_back(&self.store, &session_id);
        }
        // Background terminals end with the process; a child's thread
        // carries on from its rollout next turn.
        self.agents.kill(&session_id);
        self.detach(&session_id);
        outcome
    }

    /// The handshake, the thread, and the turn. Returns once the turn runs;
    /// its end arrives as `turn/completed`.
    fn codex_open(&self, session_id: &str, thread: &CodexThread, text: &str, instructions: &str) -> Result<(), String> {
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
        }
        self.transcripts.apply(
            session_id,
            HarnessEvent::SessionProviderBound {
                provider_session_id: thread_id.clone(),
            },
        );
        self.transcripts.apply(session_id, HarnessEvent::SessionStarted {});
        if self.stop_requested(session_id) {
            return Err("cancelled".into());
        }
        let started = self
            .codex_call(
                session_id,
                "turn/start",
                turn_start_params(&thread_id, text, Some(instructions)),
                OPEN_TIMEOUT,
            )
            .map_err(|error| self.codex_failure(session_id, "Codex did not start the turn", &error))?;
        let turn = turn_id(&started).ok_or_else(|| "Codex started no turn.".to_string())?;
        let mut map = self.lock();
        if let Some(Live::Codex(live)) = map.get_mut(session_id) {
            // `turn/completed` may already have come and gone.
            if live.active && !live.settled && live.turn_id.is_none() {
                live.turn_id = Some(turn);
            }
        }
        Ok(())
    }

    /// While the turn runs, list the thread's background terminals whenever a
    /// command is running: a command that outlives its call is one, and the
    /// tray lists it. Nothing is asked while no command runs.
    fn watch_terminals(&self, session_id: &str) {
        let host = self.clone();
        let session_id = session_id.to_string();
        thread::spawn(move || loop {
            thread::sleep(TERMINAL_POLL);
            let thread_id = match host.lock().get(&session_id) {
                Some(Live::Codex(live)) if !live.settled && !live.cancelled => live.thread_id.clone(),
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
        let target = {
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
            target
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
            let open = matches!(host.lock().get(&id), Some(Live::Codex(live)) if !live.settled);
            if open {
                host.signal(&id, TurnOutcome::Stopped);
            }
        });
        true
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
    ) -> Result<(), String> {
        let sent = self.steer_text(session_id, &from, text);
        let (thread, turn) = {
            let mut map = self.lock();
            let Some(Live::Codex(live)) = map.get_mut(session_id) else {
                return Err("No Codex turn is running to take it.".into());
            };
            let Some(target) = live.running_turn() else {
                return Err("No Codex turn is running to take it.".into());
            };
            // In before the request: its echo can beat the answer.
            live.steers.push(Steer { sent: sent.clone(), text: text.to_string(), from, letter });
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
        let (ask, cancelled) = {
            let map = self.lock();
            let Some(Live::Codex(live)) = map.get(session_id) else {
                return;
            };
            (classify_request(method, &params, &live.items), live.cancelled || live.settled)
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
                thread::spawn(move || host.codex_question_wait(&session_id, rpc_id, questions));
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

    fn codex_question_wait(&self, session_id: &str, rpc_id: Value, questions: Vec<(String, crew_protocol::Question)>) {
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
        let shown: Vec<crew_protocol::Question> = questions.iter().map(|(_, question)| question.clone()).collect();
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

    fn codex_notification(&self, session_id: &str, method: &str, params: &Value) {
        let mut events = Vec::new();
        let mut outcome = None;
        // A command item for the tray, read out of the lock.
        let mut command: Option<(Map<String, Value>, bool)> = None;
        {
            let mut map = self.lock();
            let Some(Live::Codex(live)) = map.get_mut(session_id) else {
                return;
            };
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
                    live.turn_id = None;
                    if live.cancelled {
                        outcome = Some(TurnOutcome::Stopped);
                    } else {
                        live.message = None;
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
                    }
                }
                "item/agentMessage/delta" => {
                    let (Some(item), Some(delta)) = (
                        params.get("itemId").and_then(Value::as_str),
                        params.get("delta").and_then(Value::as_str),
                    ) else {
                        return;
                    };
                    if live.message.as_ref().is_some_and(|(open, _)| open != item) {
                        events.push(HarnessEvent::MessageCompleted {});
                        live.message = None;
                    }
                    let (_, written) = live.message.get_or_insert_with(|| (item.to_string(), String::new()));
                    written.push_str(delta);
                    if !delta.is_empty() {
                        events.push(HarnessEvent::MessageDelta { text: delta.to_string() });
                    }
                }
                "item/started" | "item/completed" => {
                    let Some(item) = params.get("item").and_then(Value::as_object) else {
                        return;
                    };
                    codex_item(live, item, method == "item/completed", &mut events);
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
                    if live.seen_tools.insert(call_id.clone()) {
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
        if let Some(outcome) = outcome {
            self.signal(session_id, outcome);
        }
    }
}

/// An item starting or ending: text, a steer's echo, or a tool row.
fn codex_item(live: &mut CodexLive, item: &Map<String, Value>, completed: bool, events: &mut Vec<HarnessEvent>) {
    let kind = string_field(Some(item), "type").unwrap_or_default();
    let id = string_field(Some(item), "id").unwrap_or_default();
    match kind.as_str() {
        "agentMessage" => {
            if live.message.as_ref().is_some_and(|(open, _)| *open != id) {
                events.push(HarnessEvent::MessageCompleted {});
                live.message = None;
            }
            if !completed {
                return;
            }
            // The deltas usually said it all; what they missed goes in now.
            let text = item.get("text").and_then(Value::as_str).unwrap_or_default();
            let written = live.message.take().map(|(_, written)| written).unwrap_or_default();
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
            let Some(echo) = user_message_text(item) else {
                return;
            };
            if let Some(at) = live.steers.iter().position(|steer| steer.sent.trim() == echo.trim()) {
                let steer = live.steers.remove(at);
                events.push(HarnessEvent::UserMessage {
                    text: steer.text,
                    hidden: None,
                    files: None,
                    from_bot: Some(steer.from),
                    letter_id: steer.letter,
                });
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
            live.items.insert(call_id.clone(), item.clone());
            let title = tool_label(&row);
            if live.seen_tools.insert(call_id.clone()) {
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
                live.items.remove(&call_id);
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

/// A stand-in for `codex app-server` 0.160 that speaks the part of the
/// protocol Crew uses: the handshake, `thread/start` and `thread/resume`,
/// `turn/start`, `turn/steer`, `turn/interrupt`, and the server's own
/// approval and question requests. Every request it gets is appended to the
/// log as `{method, params}`, after a first line with its argv and env.
///
/// What a turn does is spelled in its text: `SLEEP <s>` runs a command that
/// long (steers land after it), `ASK` asks to run one, `QUESTION` asks which
/// color, `MCP` calls Crew's `list_peers`, `FAIL` fails the turn,
/// `STUBBORN` ignores an interrupt. It answers `report: <last line>`, with
/// ` + <steer>` for each steer it took.
#[cfg(test)]
pub(crate) fn fake_codex(dir: &std::path::Path) -> (String, std::path::PathBuf) {
    use std::os::unix::fs::PermissionsExt;
    let log = dir.join(format!("fake-codex-{}.log", uuid::Uuid::new_v4().simple()));
    let path = dir.join(format!("fake-codex-{}", uuid::Uuid::new_v4().simple()));
    let script = r#"#!/usr/bin/env python3
import json, os, re, sys, threading, time, uuid
LOG = __LOG__
lock = threading.Lock()
def out(m):
    with lock:
        sys.stdout.write(json.dumps(m) + "\n"); sys.stdout.flush()
def log(m):
    with open(LOG, "a") as f: f.write(json.dumps(m) + "\n")
log({"argv": sys.argv[1:], "env": {k: os.environ.get(k) for k in ["CREW_SOCKET", "CREW_TOKEN"]}})
state = {"thread": None, "turn": None, "next": 0}
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
    reply = "report: " + " + ".join(heard)
    mid = "msg_" + uuid.uuid4().hex[:8]
    item("started", {"type": "agentMessage", "id": mid, "text": "", "phase": "final_answer"})
    half = len(reply) // 2
    for piece in (reply[:half], reply[half:]):
        out({"method": "item/agentMessage/delta", "params": {"threadId": state["thread"], "turnId": tid, "itemId": mid, "delta": piece}})
    with lock:
        state["turn"] = None
    item_done = {"type": "agentMessage", "id": mid, "text": reply, "phase": "final_answer"}
    out({"method": "item/completed", "params": {"threadId": state["thread"], "turnId": tid, "item": item_done}})
    out({"method": "turn/completed", "params": {"threadId": state["thread"], "turn": {"id": tid, "status": "completed", "error": None}}})
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
        out({"id": rid, "result": {"turn": {"id": turn["id"], "status": "inProgress"}}})
        out({"method": "turn/started", "params": {"threadId": state["thread"], "turn": {"id": turn["id"], "status": "inProgress"}}})
        threading.Thread(target=run, args=(turn, text), daemon=True).start()
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
        turn = state["turn"]
        if turn: turn["interrupted"].set()
        out({"id": rid, "result": {}})
    else:
        out({"id": rid, "error": {"code": -32601, "message": "unknown " + str(method)}})
"#
    .replace("__LOG__", &format!("{:?}", log.to_string_lossy()));
    std::fs::write(&path, script).expect("write fake codex");
    std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o755)).expect("chmod");
    (path.to_string_lossy().into_owned(), log)
}
