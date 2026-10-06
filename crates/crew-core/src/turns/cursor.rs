//! The Cursor driver: one `cursor-agent acp` per turn of a bot or a child,
//! spoken to in the Agent Client Protocol over its stdio. The process is
//! spawned when the turn starts and killed when it ends, as Claude's and
//! Codex's are: a child carries on its conversation with `session/load`, a bot
//! starts a clean one with the tail Crew hands it. While the turn runs, Crew
//! can stop it and answer the permissions and questions it sends, through the
//! same events and cards as the other providers. Cursor takes nothing into a
//! running turn (no `session/steer`; a second prompt cancels the first), so a
//! message to it always waits for the turn to end.
//!
//! The protocol itself (params, updates, request shapes) is in
//! `providers/cursor.rs`.

use std::collections::{HashMap, HashSet};
use std::sync::mpsc::{self, RecvTimeoutError};
use std::thread;
use std::time::Duration;

use crew_protocol::{ApprovalDecision, ApprovalResolution, HarnessEvent, ToolDetail, ToolStatus};
use serde_json::{json, Map, Value};
use tokio::sync::oneshot;

use super::{
    child_resume, path_list, Harness, Live, QuestionReply, TurnHost,
    TurnOutcome, INIT_TIMEOUT,
};
use crate::providers::cursor::{
    authenticate_params, build_cursor_prompt, build_cursor_spawn_args, cancel_params, classify_request,
    initialize_params, mcp_servers, new_session_id, permission_answer, permission_response, plan_accepted,
    plan_detail, prompt_params, questions_cancelled, questions_response, rpc_error_message, session_request,
    tool_detail, tool_end, tool_label, tool_name, turn_end, unsupported_error, AcpQuestion, AcpTool, CursorAsk,
    CursorSpawn, TurnEnd,
};
use crate::providers::{as_record, string_field, Autonomy};

/// How long logging in, and opening or loading a session, may take. A load
/// replays the whole conversation, and the user's own MCP servers start
/// alongside Crew's.
const OPEN_TIMEOUT: Duration = Duration::from_secs(90);
/// After `session/cancel`, how long the prompt may take to say it was
/// cancelled before its process is killed under it.
const INTERRUPT_GRACE: Duration = Duration::from_secs(3);

/// What a child whose `-p` chat could not come along is told, once, on the
/// turn that starts its new conversation (migration 27).
pub(crate) const ACP_NOTE: &str = "Cursor now runs over ACP: this session starts a new conversation.";

/// A request the agent is waiting on Crew for, by the id the UI knows.
struct Pending<T> {
    tx: mpsc::Sender<T>,
}

pub(super) struct CursorLive {
    /// The ACP session the turn runs in.
    acp_session: Option<String>,
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
            acp_session: None,
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

/// The two texts a child's turn may open with: the job alone, to carry on a
/// conversation, or with the persona, to start one.
struct Texts {
    fresh: String,
    resumed: String,
}

impl TurnHost {
    pub(super) fn run_cursor(
        &self,
        session: crate::session::Session,
        params: crew_protocol::TurnStart,
        history: Option<String>,
    ) -> TurnOutcome {
        let session_id = session.id.clone();
        self.agents.kill(&session_id);
        let (tx, turn_rx) = oneshot::channel();
        let autonomy = self.autonomy(&session);
        self.lock()
            .insert(session_id.clone(), Live::Cursor(Box::new(CursorLive::new(Some(tx), autonomy.clone()))));
        self.watch_for_silence(&session_id);
        // A stop that came before the CLI was there to take it.
        if self.stop_requested(&session_id) {
            self.detach(&session_id);
            return TurnOutcome::Stopped;
        }
        let path = match self.resolve_bin("cursor-agent") {
            Ok(path) => path,
            Err(error) => {
                self.detach(&session_id);
                return TurnOutcome::Failed(error);
            }
        };
        let mcp = self.mcp();
        let child = session.kind == "child";
        let resume = child_resume(&session);
        // No system channel: the persona and the tool sheet are the first
        // user message of a conversation, a bot's every turn.
        let hint = mcp.as_ref().map(|_| self.crew_tools_hint(&session, Harness::Cursor));
        let texts = if child {
            Texts {
                fresh: self.child_prompt(&session, false, hint.as_deref(), &params),
                resumed: self.child_prompt(&session, true, hint.as_deref(), &params),
            }
        } else {
            let text = build_cursor_prompt(
                &session.name,
                &session.description,
                history.as_deref(),
                &params.text,
                &path_list(&params, &HashSet::new()),
                hint.as_deref(),
            );
            Texts { fresh: text.clone(), resumed: text }
        };
        // Minted once and used twice: the agent's own shell gets it, and so
        // does the MCP server cursor starts for it. A second mint would
        // retire the first.
        let env = self.agent_env(&session_id);
        let mcp_env: Vec<(String, String)> = {
            let mut pairs: Vec<(String, String)> = env.clone().into_iter().collect();
            pairs.sort();
            pairs
        };
        let servers = mcp_servers(mcp.as_ref(), &mcp_env);
        let args = build_cursor_spawn_args(&CursorSpawn {
            model: Some(session.model.clone()).filter(|m| !m.is_empty()),
            autonomy,
        });
        if let Err(error) = self.agents.spawn(session_id.clone(), path, args, params.cwd.clone(), Some(env)) {
            self.detach(&session_id);
            return TurnOutcome::Failed(error);
        }
        let migrated = child && resume.is_none() && self.acp_note_pending(&session_id);
        let outcome = match self.cursor_open(&session_id, &params.cwd, resume.as_deref(), &servers, &texts, migrated) {
            Ok(()) => self
                .block_on(turn_rx)
                .unwrap_or(TurnOutcome::Failed("Turn channel closed".into())),
            Err(_) if self.stop_requested(&session_id) => TurnOutcome::Stopped,
            Err(error) => TurnOutcome::Failed(error),
        };
        if let Some(Live::Cursor(live)) = self.lock().get_mut(&session_id) {
            live.release();
        }
        // The conversation is in cursor's own store; a child loads it next
        // turn.
        self.agents.kill(&session_id);
        self.detach(&session_id);
        outcome
    }

    fn acp_note_pending(&self, session_id: &str) -> bool {
        crate::store::get(&self.store, format!("{}{session_id}", crate::store::CURSOR_ACP_NOTE))
            .ok()
            .flatten()
            .is_some()
    }

    /// The handshake, the session, and the prompt. Returns once the prompt is
    /// sent; its answer is the end of the turn.
    fn cursor_open(
        &self,
        session_id: &str,
        cwd: &str,
        resume: Option<&str>,
        servers: &Value,
        texts: &Texts,
        migrated: bool,
    ) -> Result<(), String> {
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
        self.transcripts.apply(
            session_id,
            HarnessEvent::SessionProviderBound {
                provider_session_id: acp_session.clone(),
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
        let line = json!({ "jsonrpc": "2.0", "id": id, "method": "session/prompt", "params": prompt_params(&acp_session, text) });
        self.agents.write(session_id, &line.to_string())
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
    /// says. The turn's end kills the process either way. Returns false when
    /// there was no prompt to cancel, and the caller settles it at once.
    pub(super) fn cursor_interrupt(&self, session_id: &str) -> bool {
        let (target, closed) = {
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
            (target, live.close_open())
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
            let open = matches!(host.lock().get(&id), Some(Live::Cursor(live)) if !live.settled);
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
/// What a turn does is spelled in its last line: `SLEEP <s>` runs a command that
/// long, `ASK` asks to run one, `MCP` calls Crew's `list_agents`, `QUESTION`
/// asks which color, `PLAN` writes a plan, `FAIL` fails the prompt,
/// `STUBBORN` ignores a cancel. It answers `report: <last line>`, with ` + <what
/// it heard>` for each request answered.
#[cfg(test)]
pub(crate) fn fake_cursor(dir: &std::path::Path) -> (String, std::path::PathBuf) {
    use std::os::unix::fs::PermissionsExt;
    let tag = uuid::Uuid::new_v4().simple().to_string();
    let log = dir.join(format!("fake-cursor-{tag}.log"));
    let store = dir.join(format!("fake-cursor-{tag}-sessions"));
    let path = dir.join(format!("fake-cursor-agent-{tag}"));
    let script = r##"#!/usr/bin/env python3
import json, os, re, sys, threading, time, uuid
LOG = __LOG__
STORE = __STORE__
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
def saved(sid):
    p = os.path.join(STORE, sid + ".json")
    return json.load(open(p)) if os.path.exists(p) else None
def save(sid, convo):
    json.dump(convo, open(os.path.join(STORE, sid + ".json"), "w"))
def run(rid, sid, text, turn):
    heard = [text.strip().splitlines()[-1] if text.strip() else ""]
    # What it is asked to do is the last line: the persona above it names MCP too.
    text = heard[0]
    stubborn = "STUBBORN" in text
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
        update(sid, {"sessionUpdate": "tool_call_update", "toolCallId": cid, "title": "crew: list_agents", "rawInput": {"providerIdentifier": "crew", "toolName": "list_agents", "args": {}}})
        update(sid, {"sessionUpdate": "tool_call_update", "toolCallId": cid, "status": "in_progress"})
        got = ask("session/request_permission", {"sessionId": sid, "toolCall": {"toolCallId": cid, "title": "crew-crew: list_agents", "kind": "other", "status": "pending"}, "options": [{"optionId": "allow-once", "name": "Allow once", "kind": "allow_once"}, {"optionId": "allow-always", "name": "Allow always", "kind": "allow_always"}, {"optionId": "reject-once", "name": "Reject", "kind": "reject_once"}]})
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
"##
    .replace("__LOG__", &format!("{:?}", log.to_string_lossy()))
    .replace("__STORE__", &format!("{:?}", store.to_string_lossy()));
    std::fs::write(&path, script).expect("write fake cursor-agent");
    std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o755)).expect("chmod");
    (path.to_string_lossy().into_owned(), log)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::turns::TurnHost;

    fn host(id: &str) -> (TurnHost, std::sync::Arc<crate::turns::Applied>) {
        let host = TurnHost::test_new();
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
}
