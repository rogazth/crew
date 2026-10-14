//! The opencode driver: every opencode session is an opencode 2.x session on
//! the daemon's one `opencode serve` (`opencode_server.rs`), spoken to over
//! HTTP, its events read from the server's one stream.
//!
//! What a Crew session keeps between turns is its binding: the opencode
//! session it runs on, routed to it, bound with the bridge so Crew's MCP
//! server answers its calls as it, with its shell's own `CREW_TOKEN`. A user's
//! session and a child carry their conversation on, so they keep the binding,
//! and the next turn takes up the same opencode session (by its provider id
//! once the binding was let go). A bot gets a fresh opencode session every
//! turn, deleted when the turn ends: its memory is the tail Crew hands it, and
//! Crew keeps the transcript.
//!
//! A turn is a prompt; it ends when opencode's execution does. Model and
//! autonomy changes go to the session in place (`/model`, its permission
//! rules); a persona is an instruction entry of the session. Approvals are
//! opencode's permission asks, questions its forms, a stop its interrupt.
//! A message sent while a turn runs is steered in (`delivery: steer`), read
//! at the turn's next step; `session.inbox.delivered` says it was, the way
//! Claude's echo does, and one still unread when the turn ends is taken back
//! from opencode and waits in Crew's queue, the only queue. A turn opencode
//! starts by itself (a steer that came as the last one ended) is taken as
//! one nobody sent, as Claude's are.

use std::collections::{HashMap, HashSet};
use std::sync::mpsc;
use std::thread;
use std::time::Duration;

use crew_protocol::{
    ApprovalDecision, ApprovalResolution, AttachedFile, BackgroundState, BotRef, ContextReading, HarnessEvent,
    SubagentState, ToolStatus, TurnStart, TurnUsage,
};
use serde_json::{json, Map, Value};
use tokio::sync::oneshot;

use super::codex::{subagent_updated, ChildBoard, ChildWork};
use super::opencode_server::Conn;
use super::{
    carries_conversation, conversation_to_resume, driven, keeps_process, path_list, typed_by_user, Answers, Harness,
    Launch, Live, QuestionReply, Steer, TurnHost, TurnOutcome,
};
use crate::http_local::Reply;
use crate::mailbox;
use crate::providers::opencode::{
    add_usage, ask_of, bot_text, command_entries, context_used, context_window, crew_commands, error_message,
    finish_failure, form_answer, form_questions, model_ref, permission_rules, prompt_body, session_of, skill_entries,
    tool_detail, tool_label, tool_output, tool_status, ToolEnd,
};
use crate::session;

/// After an interrupt, how long the execution may take to say it ended
/// before the turn ends without it.
const INTERRUPT_GRACE: Duration = Duration::from_secs(if cfg!(test) { 2 } else { 3 });
/// The instruction entry that holds a session's persona.
const PERSONA_KEY: &str = "crew.persona";

/// An ask opencode waits on Crew for, by the id the window knows.
struct Pending<T> {
    /// opencode's id for it: `per_…` or `frm_…`.
    id: String,
    tx: mpsc::Sender<T>,
}

/// One Crew session's binding on the server, and the turn running on it.
pub(super) struct OpencodeLive {
    /// The opencode session, once there is one.
    pub(super) oc: Option<String>,
    /// The server launch it was bound on: a later one is bound again.
    epoch: u64,
    applied: Launch,
    /// The folder it runs in, for its menu.
    cwd: String,
    /// Its model's window, for the meter.
    window: Option<u64>,
    /// When the turn began, in ms: an execution that ended before it is
    /// not this turn's.
    pub(super) started_at: i64,
    pub(super) active: bool,
    pub(super) cancelled: bool,
    pub(super) settled: bool,
    /// The running turn is one opencode started by itself. With no sender
    /// for its outcome it waits for the turn of Crew's being started.
    self_started: bool,
    pub(super) turn_tx: Option<oneshot::Sender<TurnOutcome>>,
    pub(super) saw_output: bool,
    /// Steers sent and not read yet, with opencode's inbox id once its
    /// answer came.
    steers: Vec<(Option<String>, Steer)>,
    /// Inbox ids read before Crew knew whose they were: a steer's delivery
    /// can beat the answer to the request that sent it.
    delivered_early: HashSet<String>,
    /// Each call of the turn, by its id: its tool and input, which a
    /// permission ask names only by the call.
    calls: HashMap<String, (String, Map<String, Value>)>,
    /// The text being written (`message/ordinal`).
    text: Option<String>,
    usage: Option<TurnUsage>,
    /// A step that ended in a way that is not success, for the turn's end.
    failure: Option<String>,
    approvals: HashMap<u64, Pending<ApprovalResolution>>,
    questions: HashMap<u64, Pending<QuestionReply>>,
    next_ui: u64,
    /// The child sessions the model's task calls started, by opencode's id:
    /// they outlive the turn that started them, and what they say is their
    /// call's, never the turn's.
    children: HashMap<String, Child>,
}

/// How many events of a child are kept until its call names it.
const HELD_LIMIT: usize = 200;

/// A child session a `task`/`subagent` call started: opencode runs it on the
/// same server, its events carry its own session id.
#[derive(Default)]
struct Child {
    /// The parent's call that started it, once a `session.tool.progress`
    /// (or the call's end) names the child. Until then its events wait.
    call: Option<String>,
    /// `provider/id` of its model, and that model's window.
    model: Option<String>,
    /// Its model's variant, the effort it runs at; opencode's "default" is none.
    effort: Option<String>,
    window: Option<u64>,
    held: Vec<(String, Value)>,
    /// Its calls, by id: the tool and input an end names only by the call.
    calls: HashMap<String, (String, Map<String, Value>)>,
    /// The text being written (`message/ordinal`), and what it says so far.
    text: Option<String>,
    current: String,
    /// The last thing it said whole: what the call answers with.
    report: Option<String>,
}

impl OpencodeLive {
    fn new(turn_tx: Option<oneshot::Sender<TurnOutcome>>, applied: Launch, cwd: &str) -> Self {
        Self {
            oc: None,
            epoch: 0,
            applied,
            cwd: cwd.to_string(),
            window: None,
            started_at: crate::store::now_millis(),
            active: true,
            cancelled: false,
            settled: false,
            self_started: false,
            turn_tx,
            saw_output: false,
            steers: Vec::new(),
            delivered_early: HashSet::new(),
            calls: HashMap::new(),
            text: None,
            usage: None,
            failure: None,
            approvals: HashMap::new(),
            questions: HashMap::new(),
            next_ui: 1,
            children: HashMap::new(),
        }
    }

    /// A turn on the binding the last one left: what that turn knew goes.
    /// The steers it left unread are the binding's, until they are read or
    /// taken back.
    fn begin_turn(&mut self, turn_tx: Option<oneshot::Sender<TurnOutcome>>, self_started: bool) {
        self.release_asks();
        self.started_at = crate::store::now_millis();
        self.active = true;
        self.cancelled = false;
        self.settled = false;
        self.self_started = self_started;
        self.turn_tx = turn_tx;
        self.saw_output = false;
        self.delivered_early.clear();
        self.calls.clear();
        self.text = None;
        self.usage = None;
        self.failure = None;
    }

    /// A turn opencode started by itself, that a turn of Crew's is to take over.
    pub(super) fn unclaimed(&self) -> bool {
        self.active && self.self_started && self.turn_tx.is_none() && !self.settled
    }

    /// The server is gone, and the child sessions with it.
    pub(super) fn forget_children(&mut self) {
        self.children.clear();
    }

    /// Every card waiting on it closes: the turn or the server is gone.
    pub(super) fn release_asks(&mut self) {
        for (_, pending) in self.approvals.drain() {
            let _ = pending.tx.send(ApprovalResolution::Cancelled);
        }
        for (_, pending) in self.questions.drain() {
            let _ = pending.tx.send(QuestionReply::Cancelled);
        }
    }
}

/// How a turn takes its binding.
enum Arm {
    /// The binding the last turn left, run with these settings until now.
    Kept(Launch),
    /// A new one.
    Fresh,
    /// A turn opencode started by itself, taken over: the message joins it.
    Joined,
}

/// What a request answered, or why it failed, as a turn's error says it.
fn ok(reply: Result<Reply, crate::http_local::HttpError>, what: &str) -> Result<Value, String> {
    match reply {
        Ok(reply) if (200..300).contains(&reply.status) => Ok(reply.body),
        Ok(reply) => {
            let why = reply
                .body
                .get("message")
                .and_then(Value::as_str)
                .map(str::to_string)
                .unwrap_or_else(|| format!("status {}", reply.status));
            Err(format!("opencode refused to {what}: {why}"))
        }
        Err(error) => Err(format!("opencode did not {what}: {error}")),
    }
}

impl TurnHost {
    pub(super) fn run_opencode(&self, session: session::Session, params: TurnStart, history: Option<String>) -> TurnOutcome {
        let id = session.id.clone();
        let (tx, rx) = oneshot::channel();
        let arm = self.opencode_arm(&session, &params.cwd, tx);
        self.watch_for_silence(&id);
        let outcome = match self.opencode_start(&session, &params, history, arm) {
            Ok(()) => self.block_on(rx).unwrap_or(TurnOutcome::Failed("Turn channel closed".into())),
            Err(_) if self.stop_requested(&id) => TurnOutcome::Stopped,
            Err(error) => TurnOutcome::Failed(error),
        };
        self.opencode_turn_ended(&session, &outcome);
        outcome
    }

    /// Gives the turn the binding the last one left, when the session keeps
    /// one and it is idle, and otherwise an entry of its own.
    fn opencode_arm(&self, session: &session::Session, cwd: &str, tx: oneshot::Sender<TurnOutcome>) -> Arm {
        let applied = self.applied(session, cwd);
        let mut map = self.lock();
        let arm = match map.get_mut(&session.id) {
            Some(Live::Opencode(live)) if live.unclaimed() => {
                live.turn_tx = Some(tx);
                Arm::Joined
            }
            Some(Live::Opencode(live)) if keeps_process(session) && live.oc.is_some() && !live.active => {
                live.begin_turn(Some(tx), false);
                live.cwd = cwd.to_string();
                Arm::Kept(std::mem::replace(&mut live.applied, applied))
            }
            _ => {
                let gone = map.insert(session.id.clone(), Live::Opencode(Box::new(OpencodeLive::new(Some(tx), applied, cwd))));
                drop(map);
                if let Some(Live::Opencode(gone)) = gone {
                    self.opencode_forget(*gone, &session.id);
                }
                Arm::Fresh
            }
        };
        self.idle.lock().unwrap_or_else(|e| e.into_inner()).remove(&session.id);
        arm
    }

    /// Everything up to the turn's message going in: the server, the
    /// binding, its settings, and the message. Its end comes as events.
    fn opencode_start(
        &self,
        session: &session::Session,
        params: &TurnStart,
        history: Option<String>,
        arm: Arm,
    ) -> Result<(), String> {
        let id = session.id.as_str();
        if self.stop_requested(id) {
            return Err("cancelled".into());
        }
        let conn = self.opencode_conn(Some(id))?;
        if self.stop_requested(id) {
            return Err("cancelled".into());
        }
        let oc = match arm {
            Arm::Fresh => self.opencode_open(session, params, &conn)?,
            Arm::Kept(since) => self.opencode_settle(session, params, &conn, &since)?,
            Arm::Joined => self.opencode_bound(id).ok_or("opencode session is gone")?,
        };
        self.transcripts.apply(id, HarnessEvent::SessionProviderBound { provider_session_id: oc.clone() });
        self.transcripts.apply(id, HarnessEvent::SessionStarted {});
        self.opencode_read_mcp_soon(id, &params.cwd);
        let window = self.opencode_window(&conn, &params.cwd, session);
        if let Some(Live::Opencode(live)) = self.lock().get_mut(id) {
            live.window = window;
        }
        // Its children are listed and stopped while the server is up; a board
        // already live keeps what runs on it (the server outlives a turn).
        let now = crate::store::now_millis();
        self.background.touch(id, |board| !board.is_live() && board.launch(now));
        if self.stop_requested(id) {
            return Err("cancelled".into());
        }
        let files = path_list(params, &HashSet::new());
        let text = if carries_conversation(session) {
            crate::providers::with_files(params.text.trim(), &files)
        } else {
            bot_text(history.as_deref(), &params.text, &files)
        };
        let client = conn.client();
        let skills = params.skills.clone().unwrap_or_default();
        let command = params.command.as_deref().filter(|name| crate::providers::invokes_at(params.text.trim(), 0, name));
        match command {
            Some("compact") => {
                ok(client.post_json(&format!("/api/session/{oc}/compact"), &json!({})), "compact the conversation")?;
            }
            Some(name) => {
                let args = params.text.trim()[1 + name.len()..].trim();
                let body = json!({ "name": name, "text": args, "delivery": "steer" });
                match client.post_json(&format!("/api/session/{oc}/command"), &body) {
                    // A command opencode does not know is the text of a turn.
                    Ok(reply) if reply.status == 404 => {
                        ok(client.post_json(&format!("/api/session/{oc}/prompt"), &prompt_body(&text, &skills)), "take the message")?;
                    }
                    reply => {
                        ok(reply, &format!("run /{name}"))?;
                    }
                }
            }
            None => {
                ok(client.post_json(&format!("/api/session/{oc}/prompt"), &prompt_body(&text, &skills)), "take the message")?;
            }
        }
        self.confirm_carried(id);
        Ok(())
    }

    /// The opencode session a binding holds.
    fn opencode_bound(&self, session_id: &str) -> Option<String> {
        match self.lock().get(session_id) {
            Some(Live::Opencode(live)) => live.oc.clone(),
            _ => None,
        }
    }

    /// A new binding: the opencode session the conversation carries on, when
    /// opencode still has it, or a new one with the session's settings; bound
    /// with the bridge, its shell's environment set before it can run a
    /// command, and its persona as an instruction entry.
    fn opencode_open(&self, session: &session::Session, params: &TurnStart, conn: &Conn) -> Result<String, String> {
        let client = conn.client();
        let autonomy = self.autonomy(session);
        let rules = permission_rules(&autonomy, session.kind == "bot");
        let model = model_ref(&session.model, &session.effort);
        let resume = conversation_to_resume(session).filter(|oc| {
            client.get_json(&format!("/api/session/{oc}")).is_ok_and(|reply| reply.status == 200)
        });
        let oc = match &resume {
            Some(oc) => {
                // Taken up again: it runs on what the session asks for now.
                ok(client.patch_json(&format!("/api/session/{oc}"), &json!({ "permissions": rules })), "set the permissions")?;
                if let Some(model) = &model {
                    ok(client.post_json(&format!("/api/session/{oc}/model"), &json!({ "model": model })), "switch the model")?;
                }
                oc.clone()
            }
            None => {
                // No title: opencode names a session it was not given one
                // for, after its first message.
                let mut body = json!({
                    "location": { "directory": params.cwd },
                    "permissions": rules,
                });
                if let Some(model) = &model {
                    body["model"] = model.clone();
                }
                let created = ok(client.post_json("/api/session", &body), "open a session")?;
                created
                    .pointer("/data/id")
                    .and_then(Value::as_str)
                    .map(str::to_string)
                    .ok_or("opencode opened no session.")?
            }
        };
        if let Some(Live::Opencode(live)) = self.lock().get_mut(&session.id) {
            live.oc = Some(oc.clone());
        }
        self.opencode_bind(session, conn, &oc)?;
        // A child is told who started it on its first turn; a bot every turn,
        // as each is a session of its own.
        let first = resume.is_none();
        let persona = self.persona(session, Harness::Opencode, self.mcp().is_some(), &params.cwd);
        if let Some(persona) = persona.filter(|_| first) {
            ok(
                client.put_json(&format!("/api/experimental/session/{oc}/instructions/entries/{PERSONA_KEY}"), &json!({ "value": persona })),
                "take the persona",
            )?;
        }
        Ok(oc)
    }

    /// Binds an opencode session with the bridge on this run and gives its
    /// shell its environment: opencode replaces a session's environment
    /// whole (measured on 2.0.26: after a `PUT` the shell had no `PATH`), so
    /// it is the environment an agent gets, with this session's token, and
    /// none of the server's own (its password and config).
    fn opencode_bind(&self, session: &session::Session, conn: &Conn, oc: &str) -> Result<(), String> {
        let token = self.bind_opencode_session(conn, oc, &session.id)?;
        self.opencode_shell(conn, oc, &token)?;
        if let Some(Live::Opencode(live)) = self.lock().get_mut(&session.id) {
            live.epoch = conn.epoch;
        }
        Ok(())
    }

    fn opencode_shell(&self, conn: &Conn, oc: &str, token: &str) -> Result<(), String> {
        let mut variables: Map<String, Value> = std::env::vars()
            .filter(|(key, _)| !crate::child_env::inherited_from_parent(key) && !key.starts_with("OPENCODE_"))
            .map(|(key, value)| (key, json!(value)))
            .collect();
        variables.insert("PATH".into(), json!(crate::shell_path::joined()));
        if let Ok(info) = self.bridge.info() {
            variables.insert("CREW_SOCKET".into(), json!(info.socket_path));
        }
        variables.insert("CREW_TOKEN".into(), json!(token));
        ok(
            conn.client().put_json(&format!("/api/session/{oc}/environment"), &json!({ "variables": variables })),
            "set the session's environment",
        )?;
        Ok(())
    }

    /// A kept binding, told what moved since its last turn: the model in
    /// place, the autonomy as its rules. One bound on a server that has since
    /// stopped is bound again on this one.
    fn opencode_settle(&self, session: &session::Session, params: &TurnStart, conn: &Conn, since: &Launch) -> Result<String, String> {
        let (oc, epoch) = match self.lock().get(&session.id) {
            Some(Live::Opencode(live)) => (live.oc.clone(), live.epoch),
            _ => (None, 0),
        };
        let oc = oc.ok_or("opencode session is gone")?;
        let client = conn.client();
        let now = self.applied(session, &params.cwd);
        if now.model != since.model || now.effort != since.effort {
            if let Some(model) = model_ref(&session.model, &session.effort) {
                ok(client.post_json(&format!("/api/session/{oc}/model"), &json!({ "model": model })), "switch the model")?;
            }
        }
        if now.autonomy != since.autonomy {
            let rules = permission_rules(&now.autonomy, session.kind == "bot");
            ok(client.patch_json(&format!("/api/session/{oc}"), &json!({ "permissions": rules })), "set the permissions")?;
        }
        if epoch != conn.epoch {
            self.opencode_bind(session, conn, &oc)?;
        }
        Ok(oc)
    }

    /// The window of the model the session runs, from `/api/model` (read
    /// once per model, and again after opencode says its models changed).
    fn opencode_window(&self, conn: &Conn, cwd: &str, session: &session::Session) -> Option<u64> {
        let model = model_ref(&session.model, &session.effort)?;
        let key = format!("{}/{}", model["providerID"].as_str()?, model["id"].as_str()?);
        if let Some(window) = self.opencode.window(&key) {
            return Some(window);
        }
        let client = conn.client();
        // The first read of a folder can answer before it settled, empty.
        for attempt in 0..2 {
            if attempt > 0 {
                thread::sleep(Duration::from_millis(300));
            }
            let listed = client.get_json_in("/api/model", cwd).ok()?.body;
            if let Some(window) = context_window(&listed, &model) {
                self.opencode.learn_window(&key, window);
                return Some(window);
            }
        }
        None
    }

    /// What a turn's end leaves of its binding. Steers it never read are
    /// taken back from opencode's inbox and wait in Crew's queue; one opencode
    /// would not give back is being read by a turn it started by itself, and
    /// stays the binding's. A bot's session goes, and so does its binding.
    /// Otherwise the binding stays for the next turn when the turn completed
    /// or was stopped.
    pub(super) fn opencode_turn_ended(&self, session: &session::Session, outcome: &TurnOutcome) {
        let id = session.id.as_str();
        let (oc, unread) = match self.lock().get_mut(id) {
            Some(Live::Opencode(live)) => {
                live.release_asks();
                (live.oc.clone(), std::mem::take(&mut live.steers))
            }
            _ => (None, Vec::new()),
        };
        let conn = self.opencode.conn();
        let mut kept = Vec::new();
        for (inbox, steer) in unread {
            let taken_back = match (&oc, &inbox, &conn) {
                (Some(oc), Some(inbox), Some(conn)) => conn
                    .client()
                    .delete(&format!("/api/session/{oc}/inbox/{inbox}"))
                    .is_ok_and(|reply| (200..300).contains(&reply.status)),
                // Never sent, or no server to hold it.
                (_, None, _) | (_, _, None) => true,
                _ => true,
            };
            if taken_back {
                steer.put_back(&self.store, id);
            } else {
                kept.push((inbox, steer));
            }
        }
        if let Some(Live::Opencode(live)) = self.lock().get_mut(id) {
            live.steers.extend(kept);
        }
        if !keeps_process(session) {
            if let (Some(oc), Some(conn)) = (&oc, &conn) {
                let _ = conn.client().delete(&format!("/api/session/{oc}"));
            }
            self.release(id);
            return;
        }
        self.park(session, matches!(outcome, TurnOutcome::Completed | TurnOutcome::Stopped));
    }

    /// A binding let go: its routes and its standing with the bridge go, and
    /// steers it still held wait in Crew's queue.
    pub(super) fn opencode_forget(&self, mut live: OpencodeLive, session_id: &str) {
        live.release_asks();
        if let Some(oc) = &live.oc {
            self.unbind_opencode_session(oc);
        }
        for (_, steer) in live.steers.drain(..) {
            steer.put_back(&self.store, session_id);
        }
    }

    /// Stop the turn: opencode's interrupt, and the turn ends when opencode
    /// says the execution did, or after [`INTERRUPT_GRACE`]. Returns false
    /// with no turn to interrupt, and the caller settles it at once.
    pub(super) fn opencode_interrupt(&self, session_id: &str) -> bool {
        let oc = {
            let mut map = self.lock();
            let Some(Live::Opencode(live)) = map.get_mut(session_id) else {
                return false;
            };
            if !live.active || live.settled {
                return false;
            }
            let Some(oc) = live.oc.clone() else {
                return false;
            };
            live.cancelled = true;
            live.release_asks();
            oc
        };
        let Some(conn) = self.opencode.conn() else {
            return false;
        };
        // `resume=false`: what waits in its inbox is not run; the turn's end
        // takes it back to Crew's queue.
        if conn.client().post_json(&format!("/api/session/{oc}/interrupt?resume=false"), &json!({})).is_err() {
            return false;
        }
        let host = self.clone();
        let id = session_id.to_string();
        let started = match self.lock().get(session_id) {
            Some(Live::Opencode(live)) => live.started_at,
            _ => 0,
        };
        self.after(INTERRUPT_GRACE, move || {
            let open = matches!(
                host.lock().get(&id),
                Some(Live::Opencode(live)) if live.active && !live.settled && live.started_at == started
            );
            if open {
                host.signal(&id, TurnOutcome::Stopped);
            }
        });
        true
    }

    /// Stop one child session a task call started, without the parent's turn:
    /// opencode's interrupt on the child's own session (`resume=false`, so
    /// what waits in its inbox is not run). The child says it ended, and the
    /// call's state follows from that.
    pub(super) fn opencode_interrupt_child(&self, child: &str) -> Result<(), String> {
        let conn = self.opencode.conn().ok_or("opencode is not running.")?;
        ok(conn.client().post_json(&format!("/api/session/{child}/interrupt?resume=false"), &json!({})), "stop the subagent")?;
        Ok(())
    }

    /// Write a message into the running turn: opencode reads it at the turn's
    /// next step. Refused when no turn runs to take it, so the caller queues
    /// it instead.
    pub(super) fn opencode_steer(
        &self,
        session_id: &str,
        text: &str,
        from: BotRef,
        letter: Option<String>,
        files: Vec<AttachedFile>,
        rest: Vec<super::Extra>,
    ) -> Result<(), String> {
        let typed = session::get(&self.store, session_id.to_string())
            .ok()
            .flatten()
            .as_ref()
            .and_then(driven)
            .is_some_and(|drive| typed_by_user(drive, &from));
        let paths: Vec<String> = files.iter().map(|file| file.path.clone()).collect();
        let sent = crate::providers::with_files(self.steer_text_all(session_id, &from, text, &rest).trim(), &paths);
        let oc = {
            let mut map = self.lock();
            let Some(Live::Opencode(live)) = map.get_mut(session_id) else {
                return Err("No opencode turn is running to take it.".into());
            };
            let Some(oc) = live.oc.clone().filter(|_| live.active && !live.cancelled && !live.settled) else {
                return Err("No opencode turn is running to take it.".into());
            };
            // In before the request: its delivery can beat the answer.
            live.steers.push((None, Steer {
                    sent: sent.clone(),
                    text: text.to_string(),
                    from,
                    kind: letter.as_deref().and_then(|id| mailbox::letter_kind(&self.store, id)),
                    letter,
                    files,
                    typed,
                    rest,
                }));
            oc
        };
        let forget = || {
            if let Some(Live::Opencode(live)) = self.lock().get_mut(session_id) {
                live.steers.retain(|(inbox, steer)| inbox.is_some() || steer.sent != sent);
            }
        };
        let Some(conn) = self.opencode.conn() else {
            forget();
            return Err("opencode is not running.".into());
        };
        let inbox = match ok(conn.client().post_json(&format!("/api/session/{oc}/prompt"), &prompt_body(&sent, &[])), "take the message") {
            Ok(answer) => answer.pointer("/data/id").and_then(Value::as_str).map(str::to_string),
            Err(error) => {
                forget();
                return Err(error);
            }
        };
        let Some(inbox) = inbox else {
            forget();
            return Err("opencode took the message without saying where it put it.".into());
        };
        let read = {
            let mut map = self.lock();
            let Some(Live::Opencode(live)) = map.get_mut(session_id) else {
                return Ok(());
            };
            let at = live.steers.iter().position(|(id, steer)| id.is_none() && steer.sent == sent);
            match at {
                Some(at) if live.delivered_early.remove(&inbox) => Some(live.steers.remove(at).1),
                Some(at) => {
                    live.steers[at].0 = Some(inbox);
                    None
                }
                None => None,
            }
        };
        if let Some(steer) = read {
            self.opencode_read(session_id, steer);
        }
        Ok(())
    }

    /// A steer opencode read: in the transcript where it was read, and its
    /// letter delivered.
    fn opencode_read(&self, session_id: &str, steer: Steer) {
        for event in steer.read() {
            if let HarnessEvent::UserMessage { letter_id: Some(id), .. } = &event {
                let _ = mailbox::delivered(&self.store, std::slice::from_ref(id));
            }
            self.transcripts.apply(session_id, event);
        }
    }

    pub(super) fn opencode_respond(&self, session_id: &str, request_id: u64, decision: ApprovalDecision) -> Option<()> {
        let mut map = self.lock();
        let Some(Live::Opencode(live)) = map.get_mut(session_id) else {
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

    pub(super) fn opencode_answer(&self, session_id: &str, request_id: u64, answers: Option<Answers>) -> Option<()> {
        let mut map = self.lock();
        let Some(Live::Opencode(live)) = map.get_mut(session_id) else {
            return None;
        };
        let pending = live.questions.remove(&request_id)?;
        let _ = pending.tx.send(match answers {
            Some(answers) => QuestionReply::Answers(answers),
            None => QuestionReply::Dismiss,
        });
        Some(())
    }

    /// One event of the server's stream, to the session it is about.
    pub(super) fn opencode_event(&self, event: &Value) {
        let kind = event.get("type").and_then(Value::as_str).unwrap_or_default();
        let data = event.get("data").unwrap_or(&Value::Null);
        let Some(oc) = session_of(event) else {
            match kind {
                "command.updated" | "skill.updated" => {
                    if let Some(cwd) = crate::providers::opencode::directory_of(event) {
                        self.opencode_menu_changed(cwd);
                    }
                }
                "mcp.status.changed" => {
                    if let Some(cwd) = crate::providers::opencode::directory_of(event) {
                        self.opencode_mcp_changed(cwd);
                    }
                }
                "model.updated" => self.opencode.forget_windows(),
                _ => {}
            }
            return;
        };
        let Some(id) = self.opencode.route(oc) else {
            return self.opencode_child_event(kind, oc, data);
        };
        match kind {
            "permission.asked" => return self.opencode_ask(&id, oc, data),
            "permission.replied" => {
                let request = data.get("requestID").and_then(Value::as_str).unwrap_or_default();
                return self.opencode_settled_ask(&id, request);
            }
            "form.created" => return self.opencode_form(&id, oc, data.get("form").unwrap_or(&Value::Null)),
            "form.replied" | "form.cancelled" => {
                let form = data.get("id").and_then(Value::as_str).unwrap_or_default();
                return self.opencode_settled_ask(&id, form);
            }
            "session.execution.started" => {
                let idle = matches!(self.lock().get(&id), Some(Live::Opencode(live)) if !live.active || live.settled);
                if idle {
                    self.adopt_opencode_turn(&id);
                }
                return;
            }
            _ => {}
        }
        let mut events = Vec::new();
        let mut read = Vec::new();
        let mut outcome = None;
        let mut used = None;
        let mut stale = false;
        let mut work = ChildWork::default();
        {
            let mut map = self.lock();
            let Some(Live::Opencode(live)) = map.get_mut(&id) else {
                return;
            };
            if !live.active || live.settled {
                return;
            }
            // Its own message coming back, or the server making the session,
            // is not the model at work.
            if !matches!(kind, "session.inbox.enqueued" | "session.created") {
                live.saw_output = true;
            }
            let ends = kind.starts_with("session.execution.");
            // Stopped: deaf until the execution says it ended.
            if live.cancelled && !ends {
                return;
            }
            let text = |data: &Value| {
                format!(
                    "{}/{}",
                    data.get("assistantMessageID").and_then(Value::as_str).unwrap_or_default(),
                    data.get("ordinal").and_then(Value::as_u64).unwrap_or(0)
                )
            };
            match kind {
                "session.inbox.delivered" => {
                    let inbox = data.get("inboxID").and_then(Value::as_str).unwrap_or_default();
                    match live.steers.iter().position(|(id, _)| id.as_deref() == Some(inbox)) {
                        Some(at) => read.push(live.steers.remove(at).1),
                        None if live.steers.iter().any(|(id, _)| id.is_none()) => {
                            live.delivered_early.insert(inbox.to_string());
                        }
                        None => {}
                    }
                }
                "session.text.delta" => {
                    let key = text(data);
                    if live.text.as_deref() != Some(key.as_str()) {
                        if live.text.is_some() {
                            events.push(HarnessEvent::MessageCompleted {});
                        }
                        live.text = Some(key);
                    }
                    if let Some(delta) = data.get("delta").and_then(Value::as_str).filter(|delta| !delta.is_empty()) {
                        events.push(HarnessEvent::MessageDelta { text: delta.to_string() });
                    }
                }
                "session.text.ended" => {
                    if live.text.take().is_some() {
                        events.push(HarnessEvent::MessageCompleted {});
                    }
                }
                "session.reasoning.delta" => {
                    if let Some(delta) = data.get("delta").and_then(Value::as_str).filter(|delta| !delta.is_empty()) {
                        events.push(HarnessEvent::ReasoningDelta { text: delta.to_string() });
                    }
                }
                "session.tool.input.started" => {
                    let (Some(call), Some(name)) = (data.get("id").and_then(Value::as_str), data.get("name").and_then(Value::as_str))
                    else {
                        return;
                    };
                    if live.text.take().is_some() {
                        events.push(HarnessEvent::MessageCompleted {});
                    }
                    live.calls.insert(call.to_string(), (name.to_string(), Map::new()));
                    events.push(HarnessEvent::ToolStarted {
                        call_id: call.to_string(),
                        name: name.to_string(),
                        title: tool_label(name, &Map::new()),
                        detail: None,
                    });
                }
                "session.tool.called" => {
                    let Some(call) = data.get("id").and_then(Value::as_str) else {
                        return;
                    };
                    let input = data.get("input").and_then(Value::as_object).cloned().unwrap_or_default();
                    let Some((name, known)) = live.calls.get_mut(call) else {
                        return;
                    };
                    *known = input.clone();
                    let name = name.clone();
                    events.push(HarnessEvent::ToolUpdated {
                        call_id: call.to_string(),
                        title: Some(tool_label(&name, &input)),
                        status: None,
                        detail: tool_detail(&name, &input, &ToolEnd::default()),
                    });
                    // A call that continues a subagent names its session up front.
                    if matches!(name.as_str(), "task" | "subagent") {
                        if let Some(child) = input.get("sessionID").and_then(Value::as_str) {
                            link_child(live, None, call, child, &mut work);
                        }
                    }
                }
                "session.tool.progress" => {
                    // A task call names the child session it runs in.
                    if let (Some(call), Some(child)) =
                        (data.get("id").and_then(Value::as_str), data.pointer("/metadata/sessionID").and_then(Value::as_str))
                    {
                        link_child(live, None, call, child, &mut work);
                    }
                }
                "session.tool.success" | "session.tool.failed" => {
                    let Some(call) = data.get("id").and_then(Value::as_str) else {
                        return;
                    };
                    if let Some(child) = data.pointer("/metadata/sessionID").and_then(Value::as_str) {
                        link_child(live, None, call, child, &mut work);
                    }
                    let (name, input) = live.calls.get(call).cloned().unwrap_or_else(|| ("tool".into(), Map::new()));
                    let failed = kind == "session.tool.failed";
                    let end = ToolEnd {
                        status: Some(if failed { "error" } else { "completed" }),
                        output: tool_output(data),
                        error: failed.then(|| error_message(data)),
                        metadata: data.get("metadata").and_then(Value::as_object),
                    };
                    let aborted = data.pointer("/error/type").and_then(Value::as_str) == Some("aborted");
                    events.push(HarnessEvent::ToolUpdated {
                        call_id: call.to_string(),
                        title: None,
                        status: Some(if aborted { ToolStatus::Interrupted } else { tool_status(&name, &end) }),
                        detail: tool_detail(&name, &input, &end),
                    });
                }
                "session.step.ended" => {
                    live.usage = Some(add_usage(live.usage.as_ref(), data));
                    used = context_used(data).map(|used| (used, live.window));
                    let finish = data.get("finish").and_then(Value::as_str).unwrap_or_default();
                    if let Some(why) = finish_failure(finish) {
                        live.failure = Some(why);
                    }
                }
                "session.step.failed" => {
                    live.usage = Some(add_usage(live.usage.as_ref(), data));
                    if data.pointer("/error/type").and_then(Value::as_str) != Some("aborted") {
                        live.failure = Some(error_message(data));
                    }
                }
                "session.compaction.ended" => {
                    events.push(HarnessEvent::SessionNote { message: "Compacted the conversation.".into() });
                    stale = true;
                }
                "session.execution.succeeded" => {
                    if live.text.take().is_some() {
                        events.push(HarnessEvent::MessageCompleted {});
                    }
                    events.push(HarnessEvent::TurnCompleted { usage: live.usage.clone() });
                    outcome = Some(if live.cancelled {
                        TurnOutcome::Stopped
                    } else {
                        live.failure.take().map_or(TurnOutcome::Completed, TurnOutcome::Failed)
                    });
                }
                "session.execution.failed" => {
                    // The steps before it were paid for; a failure is not a
                    // reason to forget what the turn cost.
                    if live.usage.is_some() {
                        events.push(HarnessEvent::TurnCompleted { usage: live.usage.clone() });
                    }
                    outcome =
                        Some(if live.cancelled { TurnOutcome::Stopped } else { TurnOutcome::Failed(error_message(data)) });
                }
                "session.execution.interrupted" => outcome = Some(TurnOutcome::Stopped),
                _ => {}
            }
        }
        for steer in read {
            self.opencode_read(&id, steer);
        }
        for event in events {
            self.transcripts.apply(&id, event);
        }
        self.codex_children_apply(&id, work);
        if let Some((used, window)) = used {
            self.publish_context(&id, |_| Some(ContextReading { used, window, auto_compact_at: None, stale: None }));
        }
        if stale {
            self.publish_context(&id, |last| last.map(|last| ContextReading { stale: Some(true), ..last.clone() }));
        }
        if let Some(outcome) = outcome {
            self.signal(&id, outcome);
        }
    }

    /// An event of a session the server did not bind to Crew: a child session
    /// a task call started (its `session.created` carries `parentID`), or
    /// nothing of ours. A child's events are its call's: its steps, its
    /// state and its tokens go to the call and to the background board, and
    /// never to the parent's message, usage or turn end. Its asks are the
    /// owner's cards, answered on the child session.
    fn opencode_child_event(&self, kind: &str, oc: &str, data: &Value) {
        if kind == "session.created" {
            let Some(parent) = data.get("parentID").and_then(Value::as_str) else {
                return;
            };
            let model = data.get("model").and_then(|model| {
                Some(format!("{}/{}", model.get("providerID")?.as_str()?, model.get("id")?.as_str()?))
            });
            let effort = data
                .pointer("/model/variant")
                .and_then(Value::as_str)
                .filter(|variant| !variant.is_empty() && *variant != "default")
                .map(str::to_string);
            let window = model.as_deref().and_then(|model| self.opencode.window(model));
            let owner = self.opencode.route(parent);
            let mut map = self.lock();
            let owner = owner.or_else(|| {
                map.iter().find_map(|(id, live)| match live {
                    Live::Opencode(live) if live.children.contains_key(parent) => Some(id.clone()),
                    _ => None,
                })
            });
            if let Some(Live::Opencode(live)) = owner.and_then(|id| map.get_mut(&id)) {
                let window = window.or(live.window);
                live.children.entry(oc.to_string()).or_insert_with(|| Child { model, effort, window, ..Child::default() });
            }
            return;
        }
        let owner = self.lock().iter().find_map(|(id, live)| match live {
            Live::Opencode(live) if live.children.contains_key(oc) => Some(id.clone()),
            _ => None,
        });
        let Some(id) = owner else {
            return;
        };
        match kind {
            "permission.asked" => return self.opencode_ask(&id, oc, data),
            "permission.replied" => {
                let request = data.get("requestID").and_then(Value::as_str).unwrap_or_default();
                return self.opencode_settled_ask(&id, request);
            }
            "form.created" => return self.opencode_form(&id, oc, data.get("form").unwrap_or(&Value::Null)),
            "form.replied" | "form.cancelled" => {
                let form = data.get("id").and_then(Value::as_str).unwrap_or_default();
                return self.opencode_settled_ask(&id, form);
            }
            _ => {}
        }
        let mut work = ChildWork::default();
        {
            let mut map = self.lock();
            let Some(Live::Opencode(live)) = map.get_mut(&id) else {
                return;
            };
            child_note(live, oc, kind, data, &mut work);
        }
        self.codex_children_apply(&id, work);
    }

    /// A turn opencode started by itself on a session that keeps its
    /// binding: taken as one nobody sent, unless a turn of Crew's is being
    /// started this same moment, which takes it over (see
    /// [`TurnHost::adopt_claude_turn`]).
    fn adopt_opencode_turn(&self, session_id: &str) {
        let Ok(Some(row)) = session::get(&self.store, session_id.to_string()) else {
            return;
        };
        if !keeps_process(&row) {
            return;
        }
        let rx = {
            let mut running = self.running.lock().unwrap_or_else(|e| e.into_inner());
            let mut map = self.lock();
            let Some(Live::Opencode(live)) = map.get_mut(session_id) else {
                return;
            };
            if live.active && !live.settled {
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

    /// A card opencode settled itself (answered in its own TUI, or cancelled
    /// by a reload): it closes, and nobody answers it any more.
    fn opencode_settled_ask(&self, session_id: &str, ask: &str) {
        let mut map = self.lock();
        let Some(Live::Opencode(live)) = map.get_mut(session_id) else {
            return;
        };
        let approval = live.approvals.iter().find(|(_, p)| p.id == ask).map(|(id, _)| *id);
        if let Some(pending) = approval.and_then(|id| live.approvals.remove(&id)) {
            let _ = pending.tx.send(ApprovalResolution::Cancelled);
        }
        let question = live.questions.iter().find(|(_, p)| p.id == ask).map(|(id, _)| *id);
        if let Some(pending) = question.and_then(|id| live.questions.remove(&id)) {
            let _ = pending.tx.send(QuestionReply::Cancelled);
        }
    }

    /// A permission opencode asks for. Crew's own tools never become a card,
    /// whatever the rules said; the rest wait for the user's (or a parent's)
    /// decision on a thread of their own.
    fn opencode_ask(&self, session_id: &str, oc: &str, asked: &Value) {
        let Some(request) = asked.get("id").and_then(Value::as_str).map(str::to_string) else {
            return;
        };
        let action = asked.get("action").and_then(Value::as_str).unwrap_or_default();
        let host = self.clone();
        let session_id = session_id.to_string();
        let oc = oc.to_string();
        if action.starts_with("crew_") {
            thread::spawn(move || host.opencode_reply_ask(&oc, &request, "once"));
            return;
        }
        let ask = match self.lock().get(&session_id) {
            Some(Live::Opencode(live)) if live.active && !live.cancelled => ask_of(asked, &live.calls),
            _ => return,
        };
        thread::spawn(move || host.opencode_approval_wait(&session_id, &oc, request, ask));
    }

    fn opencode_reply_ask(&self, oc: &str, request: &str, decision: &str) {
        if let Some(conn) = self.opencode.conn() {
            let _ = conn
                .client()
                .post_json(&format!("/api/session/{oc}/permission/{request}/reply"), &json!({ "decision": decision }));
        }
    }

    fn opencode_approval_wait(&self, session_id: &str, oc: &str, request: String, ask: crate::providers::opencode::Ask) {
        let (tx, rx) = mpsc::channel();
        let ui_id = {
            let mut map = self.lock();
            let Some(Live::Opencode(live)) = map.get_mut(session_id) else {
                return;
            };
            let ui_id = live.next_ui;
            live.next_ui += 1;
            live.approvals.insert(ui_id, Pending { id: request.clone(), tx });
            ui_id
        };
        self.transcripts.set_status(session_id, "needs-input", None);
        let asked = json!({ "request_id": ui_id, "kind": "approval", "tool": ask.tool, "title": ask.title, "input": ask.input });
        self.transcripts.apply(
            session_id,
            HarnessEvent::ApprovalRequested { request_id: ui_id, name: ask.tool, title: ask.title, input: Some(ask.input) },
        );
        self.child_asks(session_id, asked);
        let decision = rx.recv().unwrap_or(ApprovalResolution::Cancelled);
        self.transcripts.apply(session_id, HarnessEvent::ApprovalResolved { request_id: ui_id, decision: decision.clone() });
        let reply = match decision {
            ApprovalResolution::Cancelled => return,
            ApprovalResolution::Allow => "once",
            ApprovalResolution::Always => "always",
            ApprovalResolution::Deny => "reject",
        };
        self.transcripts.set_status(session_id, "working", None);
        self.opencode_reply_ask(oc, &request, reply);
    }

    /// A form opencode puts to the user, its question tool's among them:
    /// Crew's question card, answered with the form's reply.
    fn opencode_form(&self, session_id: &str, oc: &str, form: &Value) {
        let questions = form_questions(form);
        let Some(form_id) = form.get("id").and_then(Value::as_str).map(str::to_string) else {
            return;
        };
        if questions.is_empty() || !matches!(self.lock().get(session_id), Some(Live::Opencode(live)) if live.active && !live.cancelled) {
            return;
        }
        let host = self.clone();
        let session_id = session_id.to_string();
        let oc = oc.to_string();
        let form = form.clone();
        thread::spawn(move || host.opencode_question_wait(&session_id, &oc, form_id, form, questions));
    }

    fn opencode_question_wait(
        &self,
        session_id: &str,
        oc: &str,
        form_id: String,
        form: Value,
        questions: Vec<(String, crew_protocol::Question)>,
    ) {
        let (tx, rx) = mpsc::channel();
        let ui_id = {
            let mut map = self.lock();
            let Some(Live::Opencode(live)) = map.get_mut(session_id) else {
                return;
            };
            let ui_id = live.next_ui;
            live.next_ui += 1;
            live.questions.insert(ui_id, Pending { id: form_id.clone(), tx });
            ui_id
        };
        let shown: Vec<crew_protocol::Question> = questions.into_iter().map(|(_, question)| question).collect();
        self.transcripts.set_status(session_id, "needs-input", None);
        let asked = json!({ "request_id": ui_id, "kind": "question", "questions": shown });
        self.transcripts.apply(session_id, HarnessEvent::QuestionRequested { request_id: ui_id, questions: shown });
        self.child_asks(session_id, asked);
        let reply = rx.recv().unwrap_or(QuestionReply::Cancelled);
        let answers = match reply {
            QuestionReply::Cancelled => {
                self.transcripts.apply(session_id, HarnessEvent::QuestionResolved { request_id: ui_id, answers: None });
                return;
            }
            QuestionReply::Dismiss => None,
            QuestionReply::Answers(answers) => Some(answers),
        };
        self.transcripts.apply(session_id, HarnessEvent::QuestionResolved { request_id: ui_id, answers: answers.clone() });
        self.transcripts.set_status(session_id, "working", None);
        let Some(conn) = self.opencode.conn() else {
            return;
        };
        let client = conn.client();
        let path = format!("/api/session/{oc}/form/{form_id}");
        let _ = match answers {
            Some(answers) => client.post_json(&format!("{path}/reply"), &json!({ "answer": form_answer(&form, &answers) })),
            None => client.delete(&path),
        };
    }

    /// Reads a folder's `/` menu from the server: its commands and skills,
    /// with the ones Crew runs through routes of its own. The first read of a
    /// folder can answer empty before it settled, so an empty first answer is
    /// read once more.
    pub(super) fn opencode_menu(&self, session_id: Option<&str>, cwd: &str) -> Result<(), String> {
        let conn = self.opencode_conn(None)?;
        let client = conn.client();
        let read = || -> Result<(Vec<crew_protocol::CommandEntry>, Vec<crew_protocol::CommandEntry>), String> {
            let commands = ok(client.get_json_in("/api/command", cwd), "list its commands")?;
            let skills = ok(client.get_json_in("/api/skill", cwd), "list its skills")?;
            Ok((command_entries(&commands), skill_entries(&skills)))
        };
        let (mut commands, mut skills) = read()?;
        if commands.is_empty() && skills.is_empty() {
            thread::sleep(Duration::from_millis(300));
            (commands, skills) = read()?;
        }
        let names: HashSet<String> = skills.iter().map(|skill| skill.name.clone()).collect();
        let mut entries = commands;
        entries.extend(crew_commands());
        entries.extend(skills);
        let actions = crate::commands::crew_actions(super::offers_fast("opencode"));
        let now = crate::store::now_millis();
        if self.commands.learn("opencode", cwd, Some(entries), Some(names), now) {
            // Every window on this folder hears it, not only the one that asked.
            let mut ids: Vec<String> = self
                .lock()
                .iter()
                .filter_map(|(id, live)| match live {
                    Live::Opencode(live) if live.cwd == cwd => Some(id.clone()),
                    _ => None,
                })
                .collect();
            if let Some(id) = session_id.filter(|id| !ids.iter().any(|known| known == id)) {
                ids.push(id.to_string());
            }
            let catalog = self.commands.catalog("opencode", cwd, actions, now);
            for id in ids {
                self.commands.notify(crew_protocol::CommandsChanged { session_id: id, catalog: catalog.clone() });
            }
        }
        Ok(())
    }

    /// opencode says a folder's commands or skills changed: read it again,
    /// once however many times it says so, if Crew keeps that folder's menu.
    fn opencode_menu_changed(&self, cwd: &str) {
        if !self.commands.holds("opencode", cwd) || !self.opencode.begin_menu_read(cwd) {
            return;
        }
        let host = self.clone();
        let cwd = cwd.to_string();
        thread::spawn(move || {
            thread::sleep(Duration::from_millis(200));
            host.opencode.end_menu_read(&cwd);
            if let Err(error) = host.opencode_menu(None, &cwd) {
                eprintln!("[commands] {error}");
            }
        });
    }

    /// `/reload` on opencode: the server reads every folder's config,
    /// commands, skills and servers again (`location/reload`). That cancels
    /// what every session on it is asking, so it is done only when no other
    /// session has an ask open, and says why otherwise.
    pub(super) fn reload_opencode(&self, session: &session::Session, cwd: &str) -> Result<String, String> {
        let waiting: Vec<String> = self
            .lock()
            .iter()
            .filter(|(id, live)| {
                *id != &session.id
                    && matches!(live, Live::Opencode(live) if !live.approvals.is_empty() || !live.questions.is_empty())
            })
            .filter_map(|(id, _)| session::get(&self.store, id.clone()).ok().flatten().map(|row| row.name))
            .collect();
        if !waiting.is_empty() {
            return Ok(format!(
                "Not reloaded: {} waits on an answer, and a reload would cancel it. Reload once it is answered.",
                waiting.join(", ")
            ));
        }
        let conn = self.opencode_conn(None)?;
        ok(conn.client().post_json_in("/api/location/reload", None, cwd), "reload")?;
        if session.kind != "bot" {
            self.opencode_menu(Some(&session.id), cwd)?;
        }
        Ok(self.reloaded("Reloaded commands, skills and MCP servers", "opencode", cwd))
    }

    /// Reads a folder's MCP servers as opencode says them (`GET /api/mcp` in
    /// that folder) and gives the list to the session asked for and to each
    /// live session of the folder: they share the folder's servers.
    pub(super) fn opencode_read_mcp(&self, cwd: &str, session_id: &str) -> Result<(), String> {
        let conn = self.opencode_conn(None)?;
        let listed = ok(conn.client().get_json_in("/api/mcp", cwd), "list its MCP servers")?;
        let servers = crate::providers::opencode::mcp_servers(listed.get("data").unwrap_or(&Value::Null));
        let mut ids = self.opencode_sessions_in(cwd);
        if !ids.iter().any(|id| id == session_id) {
            ids.push(session_id.to_string());
        }
        for id in ids {
            self.mcp_status.learn(&id, servers.clone());
        }
        Ok(())
    }

    /// Reads a folder's servers on a thread of its own, for the session that
    /// asks, and again when opencode says one changed: a change that comes
    /// while a read is under way makes the read go round once more, as Claude's
    /// and Codex's do.
    pub(super) fn opencode_read_mcp_soon(&self, session_id: &str, cwd: &str) {
        if !self.mcp_status.claim(session_id, true) {
            return;
        }
        let host = self.clone();
        let (id, cwd) = (session_id.to_string(), cwd.to_string());
        thread::spawn(move || loop {
            if let Err(error) = host.opencode_read_mcp(&cwd, &id) {
                eprintln!("[mcp] {error}");
            }
            if !host.mcp_status.release(&id) {
                break;
            }
        });
    }

    /// `mcp.status.changed`: a server of a folder changed. The folder's live
    /// sessions are read, through the first of them.
    fn opencode_mcp_changed(&self, cwd: &str) {
        if let Some(id) = self.opencode_sessions_in(cwd).into_iter().next() {
            self.opencode_read_mcp_soon(&id, cwd);
        }
    }

    /// The live opencode sessions whose folder is `cwd`.
    fn opencode_sessions_in(&self, cwd: &str) -> Vec<String> {
        self.lock()
            .iter()
            .filter_map(|(id, live)| match live {
                Live::Opencode(live) if live.cwd == cwd => Some(id.clone()),
                _ => None,
            })
            .collect()
    }

    /// Starts a server's sign-in with opencode (`connect/oauth`) and gives the
    /// page to open. opencode's own callback takes the browser's redirect and
    /// stores the token, and the server connects; its status change reaches
    /// the windows as an event. A sign-in that ends in a code the user copies
    /// back is not taken here.
    pub(super) fn opencode_mcp_login(&self, cwd: &str, name: &str) -> Result<String, String> {
        let conn = self.opencode_conn(None)?;
        let client = conn.client();
        let listed = ok(client.get_json_in("/api/mcp", cwd), "list its MCP servers")?;
        let integration = crate::providers::opencode::mcp_integration(listed.get("data").unwrap_or(&Value::Null), name)
            .ok_or_else(|| format!("opencode offers no sign-in for {name}."))?;
        let path = crate::providers::opencode::path_segment(&integration);
        let info = ok(client.get_json_in(&format!("/api/integration/{path}"), cwd), "read the sign-in")?;
        let method = crate::providers::opencode::oauth_method(&info)
            .ok_or_else(|| format!("opencode offers no OAuth sign-in for {name}."))?;
        let started = ok(
            client.post_json_in(&format!("/api/integration/{path}/connect/oauth"), Some(&json!({ "methodID": method })), cwd),
            "start the sign-in",
        )?;
        match crate::providers::opencode::sign_in_attempt(&started) {
            Some((url, mode)) if mode == "auto" => Ok(url),
            Some(_) => Err(format!("opencode finishes {name}'s sign-in with a code from its page, which Crew does not take. Run `opencode mcp auth {name}` in a terminal.")),
            None => Err("opencode gave no page to sign in on.".into()),
        }
    }

    /// Has opencode connect one server again (`experimental/mcp/{name}/connect`,
    /// answered once it has tried).
    pub(super) fn opencode_mcp_reconnect(&self, cwd: &str, name: &str) -> Result<(), String> {
        let conn = self.opencode_conn(None)?;
        let path = crate::providers::opencode::path_segment(name);
        ok(conn.client().post_json_in(&format!("/api/experimental/mcp/{path}/connect"), None, cwd), "connect the server")?;
        Ok(())
    }
}

/// A task call names the child session it runs in: the call gets the child's
/// entry on the board, and what the child said before it was named. `from`
/// is the child that made the call, when it was not the turn's own: an
/// agent's own agents are steps of the call that started the first.
fn link_child(live: &mut OpencodeLive, from: Option<&str>, call: &str, child: &str, work: &mut ChildWork) {
    let (named, top) = match from {
        None => (live.calls.get(call).cloned(), Some(call.to_string())),
        Some(from) => match live.children.get(from) {
            Some(parent) => (parent.calls.get(call).cloned(), parent.call.clone()),
            None => return,
        },
    };
    let (Some(top), Some(entry)) = (top, live.children.get_mut(child)) else {
        return;
    };
    if entry.call.as_deref() == Some(top.as_str()) {
        return;
    }
    // A call that names a child a call already named continues it: the same
    // entry runs again, and from now on its steps, state and report are this
    // call's. The first call keeps what it had.
    if entry.call.is_some() {
        entry.call = Some(top.clone());
        entry.text = None;
        entry.current.clear();
        entry.report = None;
        work.board.push(ChildBoard::State(child.to_string(), BackgroundState::Running));
        work.events.push(subagent_updated(&top, Some(SubagentState::Running), None, None));
        return;
    }
    entry.call = Some(top.clone());
    let (name, input) = named.unwrap_or_else(|| ("subagent".into(), Map::new()));
    work.board.push(ChildBoard::Spawned {
        thread: child.to_string(),
        call: top,
        label: tool_label(&name, &input),
        nickname: input.get("description").and_then(Value::as_str).map(str::to_string),
        model: entry.model.clone(),
        effort: entry.effort.clone(),
    });
    let held = std::mem::take(&mut entry.held);
    for (kind, data) in held {
        child_note(live, child, &kind, &data, work);
    }
}

/// What the child has said whole so far, as the call's answer.
fn settle_text(child: &mut Child, steps: &mut Vec<HarnessEvent>) {
    if child.text.take().is_some() {
        steps.push(HarnessEvent::MessageCompleted {});
        let said = std::mem::take(&mut child.current);
        if !said.trim().is_empty() {
            child.report = Some(said);
        }
    }
}

/// What a child's event adds to its call: steps, its state, its tokens.
/// Until a call names the child there is no call to add it to, and the event
/// is kept for then.
fn child_note(live: &mut OpencodeLive, oc: &str, kind: &str, data: &Value, work: &mut ChildWork) {
    // What is shown or counted; the rest is neither.
    if !matches!(
        kind,
        "session.execution.started"
            | "session.execution.succeeded"
            | "session.execution.failed"
            | "session.execution.interrupted"
            | "session.text.delta"
            | "session.text.ended"
            | "session.tool.input.started"
            | "session.tool.called"
            | "session.tool.progress"
            | "session.tool.success"
            | "session.tool.failed"
            | "session.step.ended"
    ) {
        return;
    }
    let Some(child) = live.children.get_mut(oc) else {
        return;
    };
    let Some(call) = child.call.clone() else {
        if child.held.len() >= HELD_LIMIT {
            child.held.remove(0);
        }
        child.held.push((kind.to_string(), data.clone()));
        return;
    };
    let mut steps = Vec::new();
    let mut after = Vec::new();
    let mut spawned = None;
    match kind {
        "session.execution.started" => {
            work.board.push(ChildBoard::State(oc.to_string(), BackgroundState::Running));
            after.push(subagent_updated(&call, Some(SubagentState::Running), None, None));
        }
        "session.execution.succeeded" | "session.execution.failed" | "session.execution.interrupted" => {
            settle_text(child, &mut steps);
            let report = child.report.take();
            let (shown, state, report) = match kind {
                "session.execution.succeeded" => (SubagentState::Done, BackgroundState::Completed, report),
                "session.execution.interrupted" => (SubagentState::Stopped, BackgroundState::Stopped, report),
                _ => (SubagentState::Failed, BackgroundState::Failed, report.or(Some(error_message(data)))),
            };
            work.board.push(ChildBoard::State(oc.to_string(), state));
            after.push(subagent_updated(&call, Some(shown), None, report));
        }
        "session.text.delta" => {
            let key = format!(
                "{}/{}",
                data.get("assistantMessageID").and_then(Value::as_str).unwrap_or_default(),
                data.get("ordinal").and_then(Value::as_u64).unwrap_or(0)
            );
            if child.text.as_deref() != Some(key.as_str()) {
                settle_text(child, &mut steps);
                child.current.clear();
                child.text = Some(key);
            }
            if let Some(delta) = data.get("delta").and_then(Value::as_str).filter(|delta| !delta.is_empty()) {
                child.current.push_str(delta);
                steps.push(HarnessEvent::MessageDelta { text: delta.to_string() });
            }
        }
        "session.text.ended" => settle_text(child, &mut steps),
        "session.tool.input.started" => {
            let (Some(id), Some(name)) = (data.get("id").and_then(Value::as_str), data.get("name").and_then(Value::as_str))
            else {
                return;
            };
            settle_text(child, &mut steps);
            child.calls.insert(id.to_string(), (name.to_string(), Map::new()));
            let title = tool_label(name, &Map::new());
            work.board.push(ChildBoard::Activity(oc.to_string(), title.clone()));
            after.push(subagent_updated(&call, None, Some(title.clone()), None));
            steps.push(HarnessEvent::ToolStarted { call_id: id.to_string(), name: name.to_string(), title, detail: None });
        }
        "session.tool.called" => {
            let Some(id) = data.get("id").and_then(Value::as_str) else {
                return;
            };
            let input = data.get("input").and_then(Value::as_object).cloned().unwrap_or_default();
            let Some((name, known)) = child.calls.get_mut(id) else {
                return;
            };
            *known = input.clone();
            if matches!(name.as_str(), "task" | "subagent") {
                if let Some(sub) = input.get("sessionID").and_then(Value::as_str) {
                    spawned = Some((id.to_string(), sub.to_string()));
                }
            }
            let title = tool_label(name, &input);
            work.board.push(ChildBoard::Activity(oc.to_string(), title.clone()));
            after.push(subagent_updated(&call, None, Some(title.clone()), None));
            steps.push(HarnessEvent::ToolUpdated {
                call_id: id.to_string(),
                title: Some(title),
                status: None,
                detail: tool_detail(name, &input, &ToolEnd::default()),
            });
        }
        "session.tool.progress" => {
            if let (Some(id), Some(sub)) =
                (data.get("id").and_then(Value::as_str), data.pointer("/metadata/sessionID").and_then(Value::as_str))
            {
                spawned = Some((id.to_string(), sub.to_string()));
            }
        }
        "session.tool.success" | "session.tool.failed" => {
            let Some(id) = data.get("id").and_then(Value::as_str) else {
                return;
            };
            let (name, input) = child.calls.get(id).cloned().unwrap_or_else(|| ("tool".into(), Map::new()));
            let failed = kind == "session.tool.failed";
            let end = ToolEnd {
                status: Some(if failed { "error" } else { "completed" }),
                output: tool_output(data),
                error: failed.then(|| error_message(data)),
                metadata: data.get("metadata").and_then(Value::as_object),
            };
            let aborted = data.pointer("/error/type").and_then(Value::as_str) == Some("aborted");
            steps.push(HarnessEvent::ToolUpdated {
                call_id: id.to_string(),
                title: None,
                status: Some(if aborted { ToolStatus::Interrupted } else { tool_status(&name, &end) }),
                detail: tool_detail(&name, &input, &end),
            });
            if let Some(sub) = data.pointer("/metadata/sessionID").and_then(Value::as_str) {
                spawned = Some((id.to_string(), sub.to_string()));
            }
        }
        "session.step.ended" => {
            if let Some(tokens) = context_used(data) {
                work.board.push(ChildBoard::Usage { thread: oc.to_string(), tokens, window: child.window });
            }
        }
        _ => {}
    }
    for step in steps {
        work.events.push(HarnessEvent::SubagentEvent { call_id: call.clone(), event: Box::new(step) });
    }
    work.events.extend(after);
    if let Some((id, sub)) = spawned {
        link_child(live, Some(oc), &id, &sub, work);
    }
}

#[cfg(test)]
pub(crate) fn fake_opencode_server(dir: &std::path::Path) -> (String, std::path::PathBuf) {
    let name = format!("fake-opencode-{}", uuid::Uuid::new_v4().simple());
    let log = dir.join(format!("{name}.log"));
    let path = crate::fakes::install(dir, &name, FAKE_OPENCODE);
    (path.to_string_lossy().into_owned(), log)
}

/// An `opencode serve` on HTTP and an event stream, as 2.0.26 shapes them.
/// Every request is logged to the script's path and `.log`, each server
/// launch (argv, which secrets its environment holds, its config) to `.launch`,
/// and each turn's message, with the session's persona and settings, to
/// `launches.jsonl` beside it. A file `.version` beside it is the version it
/// says; `.migrating` makes the migration run for a few reads; `.empty-first`
/// answers a folder's first menu read empty; `.mcp` is the list of its MCP
/// servers (the default is one connected `crew`), each `{name, status, error?,
/// integrationID?, mode?, completes?, connects?}`.
///
/// A turn answers `report: ` and the last line of every message it read, the
/// steers it took at its step boundaries joined with ` + `. `SLEEP n` makes
/// its first step take n seconds, `ASK` asks for a shell, `QUESTION` puts a
/// form, `MCP` calls `crew_list_peers`, `TOKENS` reports a bigger step,
/// `FAIL` fails the execution, `CRASH` kills the server, `HOLDSTEERS` leaves
/// what is steered in unread, and `SELFSTART n` has the server start a turn
/// by itself n seconds after this one ends; a message ending in `SILENT`
/// is taken and never answered.
#[cfg(test)]
const FAKE_OPENCODE: &str = r##"#!/usr/bin/env python3
import base64, json, os, queue, re, sys, threading, time, uuid
from http.server import ThreadingHTTPServer, BaseHTTPRequestHandler
from urllib.parse import unquote, urlparse
BASE = os.path.abspath(sys.argv[0])
HERE = os.path.dirname(BASE)
LOG = BASE + ".log"
LAUNCHES = os.path.join(HERE, "launches.jsonl")
def read(path, default=None):
    try: return open(path).read().strip()
    except Exception: return default
VERSION = read(BASE + ".version", "2.0.26")
PASSWORD = os.environ.get("OPENCODE_SERVER_PASSWORD", "")
CONFIG = read(os.environ.get("OPENCODE_CONFIG", "/nonexistent"), "{}")
lock = threading.RLock()
subscribers = []
sessions = {}
waits = {}
state = {"migration": int(read(BASE + ".migrating", "0") or 0), "menus": set()}
# The MCP servers, from BASE.mcp when there is one: {name, status, error?, integrationID?, mode?, completes?, connects?}.
# A server with an integrationID is one that signs in; `completes` has its sign-in finish by itself.
mcp = {row["name"]: row for row in json.loads(read(BASE + ".mcp") or '[{"name": "crew", "status": "connected"}]')}
def mcp_view(row):
    status = {"status": row["status"]}
    if row["status"] in ("failed", "needs_auth"): status["error"] = row.get("error", "")
    out = {"name": row["name"], "status": status}
    if "integrationID" in row: out["integrationID"] = row["integrationID"]
    return out
def mcp_by_integration(iid):
    return next((row for row in mcp.values() if row.get("integrationID") == iid), None)
def append(path, record):
    with lock:
        with open(path, "a") as f: f.write(json.dumps(record) + "\n")
append(BASE + ".launch", {"argv": sys.argv[1:], "pid": os.getpid(), "env": sorted(k for k in os.environ if k.startswith(("CREW_", "OPENCODE_"))), "env_values": sorted(os.environ.values()), "config": json.loads(CONFIG or "{}"), "password_on_argv": PASSWORD != "" and any(PASSWORD in a for a in sys.argv)})
def now(): return int(time.time() * 1000)
def hexid(prefix): return prefix + uuid.uuid4().hex[:24]
def emit(kind, data, sid=None, directory=None):
    event = {"id": hexid("evt_"), "created": now(), "type": kind, "data": data}
    if directory is not None: event["location"] = {"directory": directory}
    with lock:
        for q in list(subscribers): q.put(event)
def info(s):
    out = {"id": s["id"], "projectID": "global", "cost": 0, "tokens": {"input": 0, "output": 0, "reasoning": 0, "cache": {"read": 0, "write": 0}}, "time": {"created": s["created"], "updated": now()}, "title": s["title"], "location": s["location"]}
    if s.get("idle"): out["time"]["idle"] = s["idle"]
    if s.get("outcome"): out["outcome"] = s["outcome"]
    if s.get("model"): out["model"] = s["model"]
    return out
def wait_for(key, turn):
    ev = threading.Event(); waits[key] = {"ev": ev, "answer": None}
    while not ev.is_set():
        if turn["interrupted"].is_set(): return None
        time.sleep(0.02)
    return waits[key]["answer"]
def tool(sid, msg, name, inp, run):
    call = hexid("call_")
    emit("session.tool.input.started", {"sessionID": sid, "assistantMessageID": msg, "id": call, "name": name})
    emit("session.tool.called", {"sessionID": sid, "assistantMessageID": msg, "id": call, "input": inp, "executed": False})
    result = run(call)
    if result is None:
        emit("session.tool.failed", {"sessionID": sid, "assistantMessageID": msg, "id": call, "error": {"type": "aborted", "message": "Tool execution interrupted"}, "executed": False})
        return None
    emit("session.tool.success", {"sessionID": sid, "assistantMessageID": msg, "id": call, "content": [{"type": "text", "text": result}], "metadata": {"truncated": False}, "executed": False})
    return result
def tokens(n=100):
    return {"input": n, "output": 10, "reasoning": 2, "cache": {"read": 1000, "write": 0}}
def run_turn(s, item):
    sid = s["id"]
    turn = s["busy"]
    emit("session.execution.started", {"sessionID": sid})
    text = item["text"]
    emit("session.inbox.delivered", {"sessionID": sid, "inboxID": item["id"]})
    append(LAUNCHES, {"session": sid, "prompt": text, "system": s["instructions"].get("crew.persona", ""), "resumed": s["turns"] > 0, "skills": item.get("skills", []), "command": item.get("command"), "model": s.get("model"), "permissions": s.get("permissions"), "env": s.get("env", {})})
    s["turns"] += 1
    heard = [text.strip().splitlines()[-1] if text.strip() else ""]
    # What it is asked to do is on its last line, unless that line is a report
    # it is handed, which names what another turn did.
    last = "" if heard[0].startswith("report:") else heard[0]
    turn["hold"] = "HOLDSTEERS" in last
    msg = hexid("msg_")
    def interrupted():
        emit("session.step.failed", {"sessionID": sid, "assistantMessageID": msg, "error": {"type": "aborted", "message": "Step interrupted"}, "tokens": tokens(), "cost": 0})
        emit("session.execution.interrupted", {"sessionID": sid, "reason": "user"})
        finish(s, "interrupted")
    emit("session.step.started", {"sessionID": sid, "assistantMessageID": msg})
    if "CRASH" in text:
        os._exit(3)
    m = re.search(r"SLEEP ([0-9.]+)", text)
    if m:
        def sleep(call):
            end = time.time() + float(m.group(1))
            while time.time() < end:
                if turn["interrupted"].is_set(): return None
                time.sleep(0.02)
            return ""
        if tool(sid, msg, "shell", {"command": "sleep " + m.group(1)}, sleep) is None:
            return interrupted()
    if "ASK" in last:
        def ask(call):
            pid = hexid("per_")
            emit("permission.asked", {"id": pid, "sessionID": sid, "action": "shell", "resources": ["touch asked.txt"], "save": ["touch *"], "source": {"type": "tool", "messageID": msg, "id": call}})
            got = wait_for(pid, turn)
            if got is None: return None
            emit("permission.replied", {"sessionID": sid, "requestID": pid, "reply": got})
            heard.append("decision: %s" % got)
            return ""
        if tool(sid, msg, "shell", {"command": "touch asked.txt"}, ask) is None:
            return interrupted()
    if "QUESTION" in last:
        def question(call):
            fid = hexid("frm_")
            emit("form.created", {"form": {"id": fid, "sessionID": sid, "title": "Questions", "metadata": {"kind": "question", "tool": {"messageID": msg, "id": call}}, "fields": [{"key": "q0", "title": "Color", "description": "Which color?", "type": "string", "options": [{"value": "red", "label": "Red"}, {"value": "blue", "label": "Blue"}], "custom": True}]}})
            got = wait_for(fid, turn)
            if got is None: return None
            emit("form.replied" if got != "cancelled" else "form.cancelled", {"id": fid, "sessionID": sid, "answer": got})
            heard.append("answers: %s" % (json.dumps(got, sort_keys=True) if got != "cancelled" else "none"))
            return ""
        if tool(sid, msg, "question", {"questions": [{"question": "Which color?"}]}, question) is None:
            return interrupted()
    if "SUBAGENT" in last:
        # A task call that runs a child session (2.0.26): the call, the child's
        # `session.created` with its `parentID`, a `session.tool.progress` that
        # names the child, the child's own execution on its own session id, and
        # the call's answer. `SLOW` keeps the child at work until it is
        # interrupted (its own session's interrupt) or the turn is.
        csid = None
        # `RESUME` goes on with the same child: a second call names its session.
        for round in range(2 if "RESUME" in last else 1):
          inp = {"agent": "general", "description": "Reply with pong" if round == 0 else "Reply with pong again", "prompt": "Reply with the single word pong." if round == 0 else "Again, reply with the single word pong."}
          if csid: inp["sessionID"] = csid
          call = hexid("call_")
          emit("session.tool.input.started", {"sessionID": sid, "assistantMessageID": msg, "id": call, "name": "subagent"})
          emit("session.tool.called", {"sessionID": sid, "assistantMessageID": msg, "id": call, "input": inp, "executed": False})
          if not csid:
            csid = hexid("ses_")
            cturn = {"interrupted": threading.Event(), "inbox": [], "hold": False}
            sessions[csid] = {"id": csid, "created": now(), "title": inp["description"], "location": s["location"], "model": s.get("model"), "instructions": {}, "env": {}, "turns": 1, "busy": cturn, "held": []}
            emit("session.created", {"sessionID": csid, "parentID": sid, "title": inp["description"], "agent": "general", "model": {"providerID": "opencode", "id": "nemotron-3.5-lightning-free", "variant": "default"}})
            emit("session.tool.progress", {"sessionID": sid, "assistantMessageID": msg, "id": call, "metadata": {"sessionID": csid, "status": "running"}})
          else:
            sessions[csid]["busy"] = cturn
          cmsg = hexid("msg_")
          emit("session.inbox.enqueued", {"inboxID": hexid("msg_"), "sessionID": csid, "item": {"type": "user", "payload": {"text": "You are a subagent spawned by another session.\n" + inp["prompt"] if round == 0 else inp["prompt"]}, "delivery": "steer"}})
          emit("session.execution.started", {"sessionID": csid})
          emit("session.step.started", {"sessionID": csid, "assistantMessageID": cmsg})
          tool(csid, cmsg, "shell", {"command": "echo child"}, lambda c: "child\n")
          emit("session.step.ended", {"sessionID": csid, "assistantMessageID": cmsg, "finish": "tool-calls", "cost": 0, "tokens": tokens(2000)})
          cmsg = hexid("msg_")
          emit("session.step.started", {"sessionID": csid, "assistantMessageID": cmsg})
          stopped = False
          if "SLOW" in last:
            while not (cturn["interrupted"].is_set() or turn["interrupted"].is_set()):
                time.sleep(0.02)
            stopped = True
          answer = "pong" if round == 0 else "pong again"
          if stopped:
            emit("session.step.failed", {"sessionID": csid, "assistantMessageID": cmsg, "error": {"type": "aborted", "message": "Step interrupted"}, "tokens": tokens(), "cost": 0})
            emit("session.execution.interrupted", {"sessionID": csid, "reason": "user"})
            outcome = "interrupted"
          else:
            emit("session.text.started", {"sessionID": csid, "assistantMessageID": cmsg, "ordinal": 0})
            for piece in (answer[:2], answer[2:]):
                emit("session.text.delta", {"sessionID": csid, "assistantMessageID": cmsg, "ordinal": 0, "delta": piece})
            emit("session.text.ended", {"sessionID": csid, "assistantMessageID": cmsg, "ordinal": 0, "text": answer})
            emit("session.step.ended", {"sessionID": csid, "assistantMessageID": cmsg, "finish": "stop", "cost": 0, "tokens": tokens(3000)})
            emit("session.execution.succeeded", {"sessionID": csid})
            outcome = "completed"
          finish(sessions[csid], "interrupted" if stopped else "succeeded")
          body = '<subagent sessionID="%s" state="%s">\n%s\n</subagent>' % (csid, outcome, "" if stopped else answer)
          emit("session.tool.success", {"sessionID": sid, "assistantMessageID": msg, "id": call, "content": [{"type": "text", "text": body}], "metadata": {"sessionID": csid, "status": outcome, "truncated": False}, "executed": False})
          if turn["interrupted"].is_set():
            return interrupted()
    if "MCP" in last:
        tool(sid, msg, "crew_list_peers", {}, lambda call: "[]")
    if turn["interrupted"].is_set():
        return interrupted()
    while True:
        with lock:
            take = [] if turn["hold"] else turn["inbox"][:]
            if not turn["hold"]: turn["inbox"].clear()
        if not take: break
        emit("session.step.ended", {"sessionID": sid, "assistantMessageID": msg, "finish": "tool-calls", "cost": 0, "tokens": tokens()})
        for steer in take:
            emit("session.inbox.delivered", {"sessionID": sid, "inboxID": steer["id"]})
            heard.append(steer["text"].strip().splitlines()[-1])
        msg = hexid("msg_")
        emit("session.step.started", {"sessionID": sid, "assistantMessageID": msg})
    if "FAIL" in last:
        emit("session.step.ended", {"sessionID": sid, "assistantMessageID": msg, "finish": "tool-calls", "cost": 0, "tokens": tokens()})
        emit("session.execution.failed", {"sessionID": sid, "error": {"type": "provider", "message": "boom"}})
        return finish(s, "failed")
    reply = "report: " + " + ".join(heard)
    half = len(reply) // 2
    emit("session.text.started", {"sessionID": sid, "assistantMessageID": msg, "ordinal": 0})
    for piece in (reply[:half], reply[half:]):
        emit("session.text.delta", {"sessionID": sid, "assistantMessageID": msg, "ordinal": 0, "delta": piece})
    emit("session.text.ended", {"sessionID": sid, "assistantMessageID": msg, "ordinal": 0, "text": reply})
    emit("session.step.ended", {"sessionID": sid, "assistantMessageID": msg, "finish": "stop", "cost": 0, "tokens": tokens(5000 if "TOKENS" in last else 100)})
    emit("session.execution.succeeded", {"sessionID": sid})
    finish(s, "succeeded")
    m = re.search(r"SELFSTART ([0-9.]+)", last)
    if m:
        def later():
            time.sleep(float(m.group(1)))
            item = {"id": hexid("msg_"), "text": "on my own"}
            emit("session.inbox.enqueued", {"inboxID": item["id"], "sessionID": sid, "item": {"type": "user", "payload": {"text": item["text"]}, "delivery": "steer"}})
            start(s, item)
        threading.Thread(target=later, daemon=True).start()
def finish(s, outcome):
    with lock:
        left = s["busy"]["inbox"] if s["busy"] else []
        s["busy"] = None
        s["outcome"] = outcome
        s["idle"] = now()
        s["held"] = left
def start(s, item):
    with lock:
        if s["busy"]:
            s["busy"]["inbox"].append(item)
            return
        s["busy"] = {"interrupted": threading.Event(), "inbox": [], "hold": False}
        # SILENT: it takes the turn and says nothing, ever.
        if item.get("text", "").strip().endswith("SILENT"):
            append(LAUNCHES, {"session": s["id"], "prompt": item["text"], "silent": True})
            return
    threading.Thread(target=run_turn, args=(s, item), daemon=True).start()
def compact(s, item):
    sid = s["id"]
    s["busy"] = {"interrupted": threading.Event(), "inbox": [], "hold": False}
    append(LAUNCHES, {"session": sid, "compact": True, "prompt": "", "system": s["instructions"].get("crew.persona", "")})
    emit("session.execution.started", {"sessionID": sid})
    emit("session.inbox.delivered", {"sessionID": sid, "inboxID": item["id"]})
    emit("session.compaction.started", {"sessionID": sid, "reason": "manual"})
    emit("session.compaction.ended", {"sessionID": sid, "reason": "manual", "text": "Objective: the summary"})
    emit("session.execution.succeeded", {"sessionID": sid})
    finish(s, "succeeded")
COMMANDS = [{"name": "review", "description": "review changes"}, {"name": "init", "description": "guided AGENTS.md setup"}]
class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.0"
    def log_message(self, *args): pass
    def reply(self, status, body=None):
        raw = b"" if body is None else json.dumps(body).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(raw)))
        self.end_headers()
        self.wfile.write(raw)
    def handle_any(self, method):
        url = urlparse(self.path)
        path = url.path
        length = int(self.headers.get("Content-Length") or 0)
        body = json.loads(self.rfile.read(length) or b"null") if length else None
        directory = unquote(self.headers.get("x-opencode-directory") or "")
        append(LOG, {"method": method, "path": path, "query": url.query, "body": body, "directory": directory or None})
        auth = self.headers.get("Authorization") or ""
        if auth != "Basic " + base64.b64encode(("opencode:" + PASSWORD).encode()).decode():
            return self.reply(401, {"_tag": "Unauthorized"})
        parts = [p for p in path.split("/") if p]
        if path == "/api/event":
            return self.events()
        if path == "/api/info":
            return self.reply(200, {"version": VERSION, "pid": os.getpid(), "urls": [], "capabilities": {}})
        if path == "/api/experimental/migration/v1":
            if state["migration"] > 0:
                state["migration"] -= 1
                return self.reply(200, {"status": "running", "progress": {"label": "Migrating sessions", "numerator": 3, "denominator": 7}})
            return self.reply(200, {"status": "completed"})
        if path == "/api/session" and method == "POST":
            s = {"id": hexid("ses_"), "created": now(), "title": (body or {}).get("title", ""), "location": (body or {}).get("location"), "model": (body or {}).get("model"), "permissions": (body or {}).get("permissions"), "instructions": {}, "env": {}, "turns": 0, "busy": None, "held": []}
            sessions[s["id"]] = s
            emit("session.created", {"sessionID": s["id"]})
            return self.reply(200, {"data": info(s)})
        if path in ("/api/command", "/api/skill", "/api/model"):
            first = (path, directory) not in state["menus"]
            state["menus"].add((path, directory))
            if first and os.path.exists(BASE + ".empty-first") and path == "/api/command":
                return self.reply(200, {"location": {"directory": directory}, "data": []})
            if path == "/api/command":
                return self.reply(200, {"location": {"directory": directory}, "data": COMMANDS})
            if path == "/api/skill":
                return self.reply(200, {"location": {"directory": directory}, "data": [{"id": "review-pr", "name": "Review PR", "description": "Reviews a pull request.", "path": directory + "/.opencode/skills/review-pr/SKILL.md", "content": "..."}]})
            return self.reply(200, {"location": {"directory": directory}, "data": [{"id": "nemotron-3.5-lightning-free", "modelID": "nemotron-3.5-lightning-free", "providerID": "opencode", "limit": {"context": 262144, "output": 32768}}]})
        if path == "/api/mcp" and method == "GET":
            return self.reply(200, {"location": {"directory": directory}, "data": [mcp_view(row) for row in mcp.values()]})
        if len(parts) == 5 and parts[:3] == ["api", "experimental", "mcp"] and method == "POST":
            name = unquote(parts[3])
            row = mcp.get(name)
            if not row: return self.reply(404, {"_tag": "McpServerNotFoundError", "server": name, "message": "MCP server not found: " + name})
            row["status"] = row.get("connects", "connected") if parts[4] == "connect" else "disabled"
            emit("mcp.status.changed", {"server": name}, directory=directory)
            return self.reply(204)
        if len(parts) == 3 and parts[:2] == ["api", "integration"] and method == "GET":
            row = mcp_by_integration(unquote(parts[2]))
            if not row: return self.reply(404, {"_tag": "IntegrationNotFoundError", "integrationID": parts[2], "message": "Integration not found"})
            iid = row["integrationID"]
            return self.reply(200, {"location": {"directory": directory}, "data": {"id": iid, "name": row["name"], "metadata": {"source": "mcp"}, "methods": [{"id": iid, "type": "oauth", "label": row["name"]}], "connections": []}})
        if len(parts) == 5 and parts[:2] == ["api", "integration"] and parts[3:] == ["connect", "oauth"] and method == "POST":
            row = mcp_by_integration(unquote(parts[2]))
            if not row: return self.reply(404, {"_tag": "IntegrationNotFoundError", "integrationID": parts[2], "message": "Integration not found"})
            if (body or {}).get("methodID") != row["integrationID"]: return self.reply(400, {"_tag": "InvalidRequestError", "message": "Unknown method", "kind": "integration_authorization"})
            mode = row.get("mode", "auto")
            if row.get("completes") and mode == "auto":
                # The browser's redirect, played: the server takes the token and connects.
                def finish(row=row, directory=directory):
                    time.sleep(0.3)
                    row["status"] = "connected"
                    emit("mcp.status.changed", {"server": row["name"]}, directory=directory)
                threading.Thread(target=finish, daemon=True).start()
            url = "https://auth.example/authorize?server=" + row["name"]
            return self.reply(200, {"location": {"directory": directory}, "data": {"attemptID": hexid("con_"), "url": url, "instructions": "Authorize " + row["name"] + " in your browser.", "mode": mode, "time": {"created": now(), "expires": now() + 600000}}})
        if path == "/api/location/reload":
            emit("location.shutdown", {})
            return self.reply(204)
        if len(parts) >= 3 and parts[:2] == ["api", "experimental"] and parts[2] == "session":
            s = sessions.get(parts[3])
            if not s: return self.reply(404, {"_tag": "SessionNotFoundError"})
            s["instructions"][parts[-1]] = (body or {}).get("value")
            return self.reply(204)
        if len(parts) >= 3 and parts[:2] == ["api", "session"]:
            s = sessions.get(parts[2])
            if not s: return self.reply(404, {"_tag": "SessionNotFoundError", "message": "Session not found"})
            rest = parts[3:]
            if not rest:
                if method == "GET": return self.reply(200, {"data": info(s)})
                if method == "DELETE":
                    sessions.pop(s["id"], None)
                    emit("session.deleted", {"sessionID": s["id"]})
                    return self.reply(204)
                if method == "PATCH":
                    s.update({k: v for k, v in (body or {}).items() if k in ("permissions", "title")})
                    return self.reply(204)
            if rest == ["model"]:
                s["model"] = body["model"]; return self.reply(204)
            if rest == ["environment"]:
                s["env"] = body["variables"]; return self.reply(204)
            if rest == ["prompt"] or rest == ["command"]:
                text = body.get("text", "")
                if rest == ["command"]:
                    if body["name"] not in [c["name"] for c in COMMANDS]:
                        return self.reply(404, {"_tag": "CommandNotFoundError", "command": body["name"], "message": "Command not found: " + body["name"]})
                    text = ("/" + body["name"] + " " + text).strip()
                item = {"id": hexid("msg_"), "text": text, "skills": body.get("skills", []), "command": body.get("name") if rest == ["command"] else None}
                emit("session.inbox.enqueued", {"inboxID": item["id"], "sessionID": s["id"], "item": {"type": "user", "payload": {"text": text}, "delivery": body.get("delivery") or "steer"}})
                start(s, item)
                return self.reply(200, {"data": {"id": item["id"], "sessionID": s["id"], "type": "user", "payload": {"text": text}, "delivery": body.get("delivery") or "steer"}})
            if rest == ["compact"]:
                item = {"id": hexid("msg_")}
                threading.Thread(target=compact, args=(s, item), daemon=True).start()
                return self.reply(200, {"data": {"id": item["id"], "type": "compaction"}})
            if rest == ["interrupt"]:
                busy = s["busy"]
                if busy: busy["interrupted"].set()
                return self.reply(200, {"interrupted": bool(busy)})
            if len(rest) == 2 and rest[0] == "inbox" and method == "DELETE":
                with lock:
                    pools = [s["busy"]["inbox"]] if s["busy"] else []
                    pools.append(s.get("held", []))
                    for pool in pools:
                        for item in list(pool):
                            if item["id"] == rest[1]:
                                pool.remove(item)
                                emit("session.inbox.cancelled", {"sessionID": s["id"], "inboxID": rest[1]})
                                return self.reply(204)
                return self.reply(404, {"_tag": "InboxNotFoundError"})
            if len(rest) == 3 and rest[0] == "permission" and rest[2] == "reply":
                w = waits.get(rest[1])
                if w: w["answer"] = body["decision"]; w["ev"].set()
                return self.reply(204)
            if len(rest) >= 2 and rest[0] == "form":
                w = waits.get(rest[1])
                if w:
                    w["answer"] = body["answer"] if method == "POST" else "cancelled"
                    w["ev"].set()
                return self.reply(204)
        return self.reply(404, {"_tag": "NotFound"})
    def events(self):
        q = queue.Queue()
        with lock: subscribers.append(q)
        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream")
        self.end_headers()
        try:
            self.wfile.write(b'data: {"id":"evt_0","type":"server.connected","data":{}}\n\n'); self.wfile.flush()
            while True:
                try:
                    event = q.get(timeout=5)
                    self.wfile.write(("data: " + json.dumps(event) + "\n\n").encode())
                except queue.Empty:
                    self.wfile.write(b": heartbeat\n\n")
                self.wfile.flush()
        except Exception:
            pass
        finally:
            with lock:
                if q in subscribers: subscribers.remove(q)
    def do_GET(self): self.handle_any("GET")
    def do_POST(self): self.handle_any("POST")
    def do_PUT(self): self.handle_any("PUT")
    def do_PATCH(self): self.handle_any("PATCH")
    def do_DELETE(self): self.handle_any("DELETE")
def watch_stdin():
    # The daemon (or the test) that started it is gone: so is it.
    sys.stdin.read()
    os._exit(0)
threading.Thread(target=watch_stdin, daemon=True).start()
server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
server.daemon_threads = True
print("server listening on http://127.0.0.1:%d" % server.server_address[1], flush=True)
server.serve_forever()
"##;
