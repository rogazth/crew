use std::collections::{HashMap, HashSet};
use std::sync::mpsc::{self, Sender};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::Duration;

use crew_protocol::{
    ApprovalDecision, ApprovalResolution, HarnessEvent, ToolStatus, TurnStart, TurnStarted,
};
use serde_json::{json, Map, Value};

use crate::agent::AgentHost;
use crate::bridge::Bridge;
use crate::providers::claude::{
    assistant_text_blocks, assistant_tool_uses, build_claude_spawn_args, build_claude_user_message,
    build_control_request, build_control_response, input_json_delta_from_event, is_compact_boundary,
    is_message_start, is_subagent_message, parse_control_cancel_id, parse_control_request, parse_questions,
    persona_prompt as claude_persona, session_id_from_message, stream_text_delta, to_permission_result,
    to_question_result, tool_label as claude_tool_label, tool_results_from_user_message, tool_start_from_event,
    try_parse_json_record, turn_failed as claude_turn_failed, turn_usage as claude_turn_usage, ClaudeControlRequest,
    ClaudeSpawn,
};
use crate::providers::codex::{
    agent_message_text, build_codex_prompt, build_codex_spawn_args, completed_tool_status, item_error_message,
    item_from_event, is_tool_item, parse_json_line, stream_error_message, thread_id_from_event,
    tool_call_id, tool_label as codex_tool_label, tool_name as codex_tool_name, turn_usage as codex_turn_usage,
    CodexSpawn,
};
use crate::providers::cursor::{
    assistant_delta_text, build_cursor_spawn_args, parse_tool_call, persona_prompt as cursor_persona,
    session_id_from_event, tool_status as cursor_tool_status, turn_failed as cursor_turn_failed,
    turn_usage as cursor_turn_usage, with_attached_files, with_persona, CursorSpawn, ToolPhase,
};
use crate::providers::{string_field, Autonomy};
use crate::session;
use crate::store::Store;
use crate::transcript::TranscriptHub;

const INIT_TIMEOUT: Duration = Duration::from_secs(15);
const INTERRUPT_GRACE: Duration = Duration::from_millis(1500);
const IDLE_KILL: Duration = Duration::from_secs(10 * 60);
const STDERR_TAIL: usize = 12;
const TOOLS_HINT: &str = "Crew also gives you tools (the crew MCP server) to list and create agents in this workspace and to manage routines: standing orders that wake an agent on a schedule with a saved prompt. Use them when asked to schedule work or set up an agent.";

type Answers = HashMap<String, String>;

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
    init_tx: Option<Sender<bool>>,
    turn_tx: Option<Sender<Result<(), String>>>,
    emitted_assistant: String,
    stderr: Vec<String>,
    idle_gen: u64,
}

struct StreamLive {
    cancelled: bool,
    active: bool,
    turn_tx: Option<Sender<Result<(), String>>>,
    emitted_assistant: String,
    seen_tools: HashSet<String>,
    stderr: Vec<String>,
    saw_text: bool,
    settled: bool,
}

enum Live {
    Claude(Box<ClaudeLive>),
    Codex(StreamLive),
    Cursor(StreamLive),
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

    pub fn start(&self, params: TurnStart) -> Result<TurnStarted, String> {
        let session = session::get(&self.store, params.session_id.clone())?
            .ok_or_else(|| "Session not found".to_string())?;
        if session.kind != "agent" {
            return Err("Not an agent session".into());
        }
        {
            let map = self.lock();
            if map.get(&params.session_id).is_some_and(|live| match live {
                Live::Claude(row) => row.active,
                Live::Codex(row) | Live::Cursor(row) => row.active,
            }) {
                return Err("Turn already running".into());
            }
        }
        let hidden = params.hidden.unwrap_or(false);
        self.transcripts
            .append_user(&params.session_id, &params.text, hidden, params.files.clone());
        self.transcripts.set_working(&params.session_id, true);
        self.transcripts.set_status(&params.session_id, "working", session.provider_session_id.as_deref());
        let host = self.clone();
        thread::spawn(move || {
            let _ = host.run_turn(session, params);
        });
        Ok(TurnStarted { working: true })
    }

    pub fn stop(&self, session_id: &str) -> Result<(), String> {
        self.cancel(session_id, true);
        self.transcripts.apply(session_id, HarnessEvent::SessionEnded { code: None });
        self.transcripts.append_system(session_id, "Stopped");
        self.transcripts.set_status(session_id, "idle", None);
        self.transcripts.flush(session_id);
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
                    Live::Codex(row) | Live::Cursor(row) => &mut row.stderr,
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
                    self.fail_turn(session_id, exit_message("Claude Code", code, &stderr));
                    return;
                }
                if let Some(tx) = row.turn_tx.take() {
                    let _ = tx.send(Ok(()));
                }
            }
            Live::Codex(row) | Live::Cursor(row) => {
                if row.cancelled || row.settled {
                    if let Some(tx) = row.turn_tx.take() {
                        let _ = tx.send(Ok(()));
                    }
                    return;
                }
                let mid = row.active;
                let stderr = row.stderr.clone();
                let provider = if matches!(live, Live::Codex(_)) {
                    "Codex"
                } else {
                    "Cursor Agent"
                };
                if mid {
                    drop(map);
                    self.transcripts.apply(session_id, HarnessEvent::SessionEnded { code });
                    self.fail_turn(session_id, exit_message(provider, code, &stderr));
                }
            }
        }
    }

    fn fail_turn(&self, session_id: &str, message: String) {
        self.transcripts
            .apply(session_id, HarnessEvent::SessionError { message: message.clone() });
        let mut map = self.lock();
        if let Some(live) = map.get_mut(session_id) {
            match live {
                Live::Claude(row) => {
                    row.active = false;
                    if let Some(tx) = row.turn_tx.take() {
                        let _ = tx.send(Err(message));
                    }
                }
                Live::Codex(row) | Live::Cursor(row) => {
                    row.active = false;
                    row.settled = true;
                    if let Some(tx) = row.turn_tx.take() {
                        let _ = tx.send(Err(message));
                    }
                }
            }
        }
        self.transcripts.set_status(session_id, "error", None);
        self.transcripts.flush(session_id);
        self.detach(session_id);
    }

    fn finish_ok(&self, session_id: &str) {
        self.transcripts.set_status(session_id, "done", None);
        self.transcripts.flush(session_id);
        let mut map = self.lock();
        if let Some(live) = map.get_mut(session_id) {
            match live {
                Live::Claude(row) => {
                    row.active = false;
                    if let Some(tx) = row.turn_tx.take() {
                        let _ = tx.send(Ok(()));
                    }
                }
                Live::Codex(row) | Live::Cursor(row) => {
                    row.active = false;
                    row.settled = true;
                    if let Some(tx) = row.turn_tx.take() {
                        let _ = tx.send(Ok(()));
                    }
                }
            }
        }
    }

    fn cancel(&self, session_id: &str, kill: bool) {
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
        if let Some(id) = interrupt {
            let _ = self.agents.write(
                session_id,
                &serde_json::to_string(&build_control_request(&id, json!({ "subtype": "interrupt" })))
                    .unwrap_or_default(),
            );
            thread::sleep(INTERRUPT_GRACE);
        }
        let mut map = self.lock();
        if let Some(live) = map.get_mut(session_id) {
            match live {
                Live::Claude(row) => {
                    row.cancelled = true;
                    row.mute = true;
                    row.active = false;
                    drop_pending(row);
                    if let Some(tx) = row.turn_tx.take() {
                        let _ = tx.send(Ok(()));
                    }
                }
                Live::Codex(row) | Live::Cursor(row) => {
                    row.cancelled = true;
                    row.active = false;
                    row.settled = true;
                    if let Some(tx) = row.turn_tx.take() {
                        let _ = tx.send(Ok(()));
                    }
                }
            }
        }
        drop(map);
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

    fn run_turn(&self, session: crate::session::Session, params: TurnStart) -> Result<(), String> {
        let session_id = session.id.clone();
        let result = match session.provider.as_str() {
            "claude" => self.run_claude(session, params),
            "codex" => self.run_codex(session, params),
            "cursor" => self.run_cursor(session, params),
            other => Err(format!("{other} agents are not wired up yet. Pick Claude for now.")),
        };
        match &result {
            Ok(()) => self.finish_ok(&session_id),
            Err(error) => {
                self.transcripts.apply(
                    &session_id,
                    HarnessEvent::SessionError {
                        message: error.clone(),
                    },
                );
                self.transcripts.set_status(&session_id, "error", None);
                self.transcripts.flush(&session_id);
            }
        }
        result
    }

    fn run_claude(&self, session: crate::session::Session, params: TurnStart) -> Result<(), String> {
        let session_id = session.id.clone();
        self.ensure_claude(&session, &params)?;
        let (turn_rx, claude_session_id) = {
            let mut map = self.lock();
            let Some(Live::Claude(live)) = map.get_mut(&session_id) else {
                return Err("Claude session is gone".into());
            };
            live.cancelled = false;
            live.mute = false;
            live.active = true;
            live.emitted_assistant.clear();
            live.tools_by_index.clear();
            live.tools_by_id.clear();
            live.idle_gen += 1;
            let (tx, rx) = mpsc::channel();
            live.turn_tx = Some(tx);
            (rx, live.claude_session_id.clone())
        };
        let images = crate::files::load_inline_images(params.files.as_deref().unwrap_or(&[]));
        let inline: HashSet<String> = images.iter().map(|image| image.path.clone()).collect();
        let files = path_list(&params, &inline);
        let message = build_claude_user_message(&claude_session_id, params.text.trim(), &files, &images);
        self.agents
            .write(&session_id, &serde_json::to_string(&message).unwrap_or_default())?;
        let outcome = turn_rx.recv().unwrap_or(Ok(()));
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
        {
            let map = self.lock();
            if let Some(Live::Claude(live)) = map.get(&session_id) {
                if !params.fresh.unwrap_or(false)
                    && live.cwd == params.cwd
                    && live.autonomy == autonomy
                    && live.model == session.model
                {
                    return Ok(());
                }
            }
        }
        if params.fresh.unwrap_or(false) || self.lock().contains_key(&session_id) {
            self.agents.kill(&session_id);
            self.detach(&session_id);
        }

        let stored = session.provider_session_id.clone().filter(|id| !id.is_empty());
        let moved = stored.is_some() && {
            let map = self.lock();
            map.get(&session_id)
                .and_then(|live| match live {
                    Live::Claude(row) => Some(row.cwd.as_str() != params.cwd),
                    _ => None,
                })
                .unwrap_or(false)
        };
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
        self.agents.spawn(
            session_id.clone(),
            path,
            build_claude_spawn_args(&spawn),
            params.cwd.clone(),
            Some(self.agent_env(&session_id)),
        )?;

        let (init_tx, init_rx) = mpsc::channel();
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
        match init_rx.recv_timeout(INIT_TIMEOUT) {
            Ok(true) => {}
            Ok(false) => {
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

    fn run_codex(&self, session: crate::session::Session, params: TurnStart) -> Result<(), String> {
        let session_id = session.id.clone();
        self.agents.kill(&session_id);
        let resume = if params.fresh.unwrap_or(false) {
            None
        } else {
            session.provider_session_id.clone().filter(|id| !id.is_empty())
        };
        let (turn_rx, _) = self.install_stream(&session_id, params.cwd.clone(), true)?;
        let path = self.resolve_bin("codex")?;
        let mcp = self.mcp();
        let prompt = build_codex_prompt(
            if resume.is_some() { "" } else { &session.name },
            if resume.is_some() { "" } else { &session.description },
            &params.text,
            &path_list(&params, &HashSet::new()),
            resume.is_none(),
            mcp.as_ref().map(|_| TOOLS_HINT),
        );
        self.agents.spawn(
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
        )?;
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
        let result = turn_rx.recv().unwrap_or(Ok(()));
        self.agents.kill(&session_id);
        self.detach(&session_id);
        result
    }

    fn run_cursor(&self, session: crate::session::Session, params: TurnStart) -> Result<(), String> {
        let session_id = session.id.clone();
        let resume = if params.fresh.unwrap_or(false) {
            None
        } else {
            session.provider_session_id.clone().filter(|id| !id.is_empty())
        };
        let (turn_rx, _) = self.install_stream(&session_id, params.cwd.clone(), false)?;
        let path = self.resolve_bin("cursor-agent")?;
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
        self.agents.spawn(
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
        )?;
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
        let result = turn_rx.recv().unwrap_or(Ok(()));
        self.agents.kill(&session_id);
        self.detach(&session_id);
        result
    }

    fn install_stream(
        &self,
        session_id: &str,
        _cwd: String,
        _codex: bool,
    ) -> Result<(mpsc::Receiver<Result<(), String>>, ()), String> {
        let (tx, rx) = mpsc::channel();
        let live = StreamLive {
            cancelled: false,
            active: true,
            turn_tx: Some(tx),
            emitted_assistant: String::new(),
            seen_tools: HashSet::new(),
            stderr: Vec::new(),
            saw_text: false,
            settled: false,
        };
        let mut map = self.lock();
        map.insert(
            session_id.to_string(),
            if _codex {
                Live::Codex(live)
            } else {
                Live::Cursor(live)
            },
        );
        Ok((rx, ()))
    }

    fn handle_line(&self, session_id: &str, line: &str) {
        let kind = {
            let map = self.lock();
            match map.get(session_id) {
                Some(Live::Claude(_)) => "claude",
                Some(Live::Codex(_)) => "codex",
                Some(Live::Cursor(_)) => "cursor",
                None => return,
            }
        };
        match kind {
            "claude" => self.handle_claude_line(session_id, line),
            "codex" => self.handle_codex_line(session_id, line),
            "cursor" => self.handle_cursor_line(session_id, line),
            _ => {}
        }
    }

    fn handle_claude_line(&self, session_id: &str, line: &str) {
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
        let mut fail: Option<String> = None;
        let mut finished = false;
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
                    events.push(HarnessEvent::ToolUpdated {
                        call_id: result.tool_use_id,
                        title: None,
                        status: Some(if result.is_error {
                            ToolStatus::Failed
                        } else {
                            ToolStatus::Completed
                        }),
                    });
                }
            } else if type_name.as_deref() == Some("result") {
                if let Some(error) = claude_turn_failed(&rec) {
                    if !live.cancelled {
                        fail = Some(error);
                    }
                }
                events.push(HarnessEvent::TurnCompleted {
                    usage: Some(claude_turn_usage(&rec)),
                });
                live.active = false;
                finished = true;
                if let Some(tx) = live.turn_tx.take() {
                    let _ = tx.send(Ok(()));
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
        if let Some(error) = fail {
            self.transcripts
                .apply(session_id, HarnessEvent::SessionError { message: error });
        }
        if finished {
            self.transcripts.set_status(session_id, "done", None);
            self.transcripts.flush(session_id);
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

    fn handle_codex_line(&self, session_id: &str, line: &str) {
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
        if let Some(fatal) = stream_error_message(&rec) {
            self.transcripts
                .apply(session_id, HarnessEvent::SessionError { message: fatal });
        }
        let type_name = string_field(Some(&rec), "type");
        if type_name.as_deref() == Some("turn.completed") {
            self.transcripts
                .apply(session_id, HarnessEvent::MessageCompleted {});
            self.transcripts.apply(
                session_id,
                HarnessEvent::TurnCompleted {
                    usage: codex_turn_usage(&rec),
                },
            );
            self.finish_ok(session_id);
            return;
        }
        if type_name.as_deref() == Some("turn.failed") {
            self.transcripts
                .apply(session_id, HarnessEvent::MessageCompleted {});
            self.transcripts
                .apply(session_id, HarnessEvent::TurnCompleted { usage: None });
            self.finish_ok(session_id);
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
                },
            );
        } else {
            self.transcripts.apply(
                session_id,
                HarnessEvent::ToolUpdated {
                    call_id: call_id.clone(),
                    title: Some(title),
                    status: None,
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

    fn handle_cursor_line(&self, session_id: &str, line: &str) {
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
                    },
                );
            }
            return;
        }
        if type_name.as_deref() != Some("result") {
            return;
        }
        if let Some(error) = cursor_turn_failed(&rec) {
            self.transcripts
                .apply(session_id, HarnessEvent::SessionError { message: error });
        }
        let fallback = string_field(Some(&rec), "result");
        let saw = {
            let map = self.lock();
            matches!(map.get(session_id), Some(Live::Cursor(row)) if row.saw_text)
        };
        if !saw {
            if let Some(fallback) = fallback {
                if cursor_turn_failed(&rec).is_none() {
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
        self.finish_ok(session_id);
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
    events.push(HarnessEvent::ToolUpdated {
        call_id: tool.id.clone(),
        title: Some(claude_tool_label(&tool.name, &parsed)),
        status: None,
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
        if live.tools_by_id.contains_key(&use_.id) {
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

