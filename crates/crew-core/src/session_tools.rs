//! Sessions and messaging as MCP tools: who is there (`list_peers`), write to
//! one (`send_message`), hand a job to a subagent (`delegate`), start a
//! separate session (`start_session`), read what a subagent did, stop it.
//!
//! The words, as every model that reads these tools is told: a bot is a
//! persistent identity Crew keeps; a session is one provider CLI and can be
//! thrown away. A subagent is a session `delegate` starts for the session that
//! started it: it is that session's child, and each turn its parent starts
//! ends with a final message, its report, which wakes a bot parent or a session parent;
//! a session may also read it, or wait for it with `wait: true`.
//! An independent session is one `start_session` starts: a top-level chat
//! session that is the user's, reports to nobody and records who launched it.
//!
//! `send_message` writes to any bot or session in the workspace but the
//! caller itself and an exited subagent, as long as the target's autonomy is
//! not above the caller's (the user is exempt). The mailbox is the queue:
//! idle, the reader starts on it now; busy, it waits for the turn to end;
//! `steer` puts it into the running turn where the CLI can take that. To a
//! subagent waiting on a question, it is the answer.

use std::collections::{BTreeMap, HashMap, HashSet};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, Instant};

use crew_protocol::{ApprovalDecision, Block, BlockRole, ToolStatus, TurnStart};
use serde_json::{json, Value};

use crate::caller::Caller;
use crate::mailbox;
use crate::session::{self, Session};
use crate::session_events::{self, Event, Signal};
use crate::store::{now_millis, Store};
use crate::tools::{cli, provider_models, provider_names, text, unknown_model, Audience, Tool, ToolFamily, ToolOutput};
use crate::turns::{TurnHost, STEERABLE};
use crate::worktree::Worktree;

/// Most sessions one `start_sessions` call starts.
pub const BATCH_MAX: usize = 20;
/// Longest `request_id`.
const REQUEST_ID_MAX: usize = 128;

/// The call's `request_id`, if it gave one.
fn request_id(args: &Value) -> Result<Option<String>, String> {
    match args.get("request_id") {
        None | Some(Value::Null) => Ok(None),
        Some(Value::String(id)) if id.trim().is_empty() => Ok(None),
        Some(Value::String(id)) if id.trim().chars().count() <= REQUEST_ID_MAX => Ok(Some(id.trim().to_string())),
        Some(_) => Err(format!("request_id is a string of at most {REQUEST_ID_MAX} characters")),
    }
}

/// Live sessions one parent may have: anything not exited counts.
pub const LIVE_CAP: usize = 4;
/// How long `start_session` with `wait` blocks by default, and at most. The
/// MCP shim gives the call that long and a margin more (`mcp::call_timeout`).
pub const WAIT_DEFAULT_S: u64 = 600;
pub const WAIT_MAX_S: u64 = 3600;
/// What `read_session` hands back without `max_bytes`, and at most.
const READ_DEFAULT: usize = 16 * 1024;
const READ_MAX: usize = 256 * 1024;
/// How many blocks `around` reads either side of its block, by default and at most.
const AROUND_DEFAULT: u64 = 5;
const AROUND_MAX: u64 = 50;
/// Hits a search answers, by default and at most.
const HITS_DEFAULT: u64 = 8;
const HITS_MAX: u64 = 50;
/// A hit's snippet, in tokens, and the length under which a hit is its whole message.
const SNIPPET_TOKENS: u32 = 40;
const WHOLE_CHARS: usize = 1_500;
/// The neighbours the best hit comes with, either side.
const TOP_WINDOW: usize = 3;
/// How long an idle child is kept before it exits, unless
/// `CREW_SESSION_IDLE_MINUTES` says otherwise.
pub const IDLE_MINUTES: u64 = 30;

/// Which of the two tools is starting a session.
#[derive(Clone, Copy, PartialEq, Eq)]
enum Start {
    /// A subagent: the caller's child, which reports to it.
    Delegate,
    /// A separate session of the user's, which reports to nobody.
    Launch,
}

type Made = Arc<dyn Fn(&Session) + Send + Sync>;
/// The daemon's part of deleting a session: `release` lets go of
/// what only it holds (the session's terminal, its token, its browser tabs);
/// `gone` tells every window the sessions are no longer listed.
pub struct Retirement {
    pub release: Arc<dyn Fn(&str) + Send + Sync>,
    pub gone: Arc<dyn Fn(&[String]) + Send + Sync>,
}

type MakeWorktree = Arc<dyn Fn(&str, &str) -> Result<Worktree, String> + Send + Sync>;

pub struct SessionTools {
    store: Store,
    turns: TurnHost,
    signal: Signal,
    /// Tells the window a session was made, so it lists it at once (and opens
    /// a handoff's terminal).
    on_created: Made,
    /// `worktree::add`, as an argument so a test puts worktrees elsewhere.
    make_worktree: MakeWorktree,
    /// The workspace's processes, for a parent deciding a process its child
    /// defined under ask autonomy.
    processes: Option<crate::process::ProcessHost>,
    /// Start requests being made right now, by caller and `request_id`, so a
    /// retry that overlaps its first call does not start everything twice.
    in_flight: Mutex<HashSet<String>>,
    /// What the daemon does when a session is deleted, beyond
    /// what the turn host knows.
    retirement: OnceLock<Retirement>,
}

/// What a caller may ask a session to run with, least first.
fn autonomy_rank(autonomy: &str) -> Option<u8> {
    match autonomy {
        "ask" => Some(0),
        "edits" => Some(1),
        "auto" => Some(2),
        "full" => Some(3),
        _ => None,
    }
}

impl SessionTools {
    pub fn new(turns: TurnHost, on_created: Made) -> Self {
        Self::with_worktrees(turns, on_created, Arc::new(crate::worktree::add))
    }

    pub fn with_worktrees(turns: TurnHost, on_created: Made, make_worktree: MakeWorktree) -> Self {
        Self {
            store: turns.store().clone(),
            signal: turns.waiters(),
            turns,
            on_created,
            make_worktree,
            processes: None,
            in_flight: Mutex::new(HashSet::new()),
            retirement: OnceLock::new(),
        }
    }

    /// With the process host: a parent's decision can accept or reject a
    /// process its child proposed.
    pub fn with_processes(mut self, processes: crate::process::ProcessHost) -> Self {
        self.processes = Some(processes);
        self
    }

    /// With what the daemon does to retire a session (see [`Retirement`]).
    pub fn set_retirement(&self, retirement: Retirement) {
        let _ = self.retirement.set(retirement);
    }

    /// How long an idle child is kept.
    pub fn idle_limit() -> Duration {
        let minutes = std::env::var("CREW_SESSION_IDLE_MINUTES")
            .ok()
            .and_then(|raw| raw.trim().parse::<f64>().ok())
            .filter(|minutes| *minutes > 0.0)
            .unwrap_or(IDLE_MINUTES as f64);
        Duration::from_secs_f64(minutes * 60.0)
    }

    /// Children idle (or failed) for longer than `limit` exit: they hold a slot
    /// under their parent's cap, and their process, which goes with them. A
    /// child that background work or a child of its own still pins is not idle.
    /// Returns the ids that went.
    pub fn reap(&self, limit: Duration) -> Result<Vec<String>, String> {
        let before = now_millis() - limit.as_millis() as i64;
        let idle: Vec<Session> = session::list_all(&self.store)?
            .into_iter()
            .filter(|row| row.kind == "child" && matches!(row.status.as_str(), "idle" | "error"))
            .filter(|row| row.updated_at < before && !self.turns.is_running(&row.id))
            .filter(|row| !self.turns.is_pinned(&row.id))
            .collect();
        let minutes = (limit.as_secs_f64() / 60.0).round().max(1.0) as u64;
        let mut gone = Vec::new();
        for row in idle {
            self.turns.exit_idle_child(
                &row,
                &format!("idle for {minutes} minutes"),
                &format!("Ended after {minutes} minutes idle. Its transcript stays here."),
            );
            gone.push(row.id);
        }
        Ok(gone)
    }

    /// The subagent `id`, if this caller may drive it: one it started, or any
    /// at all for the user. A bot and a session of the user's are refused with
    /// what reaches them instead.
    fn owned(&self, caller: &Caller, id: &str) -> Result<Session, String> {
        let workspace = caller.workspace_id()?;
        let found = session::get(&self.store, id.trim().to_string())?
            .filter(|row| row.workspace_id == workspace)
            .ok_or_else(|| format!("No session {id} in this workspace. list_peers has who is here."))?;
        match found.kind.as_str() {
            "bot" => {
                return Err(format!(
                    "{id} is the bot {}: reach it with send_message. A bot is written to, not driven as a session.",
                    found.name
                ))
            }
            "terminal" => {
                return Err(format!(
                    "{id} is a session of the user's, not a subagent of yours: reach it with send_message. \
                     read_session and stop_session are for the subagents you start with delegate."
                ))
            }
            _ => {}
        }
        if matches!(caller, Caller::User { .. }) || caller.session_id() == found.parent_id.as_deref() {
            return Ok(found);
        }
        Err(format!(
            "{} ({id}) was started by {}, not by you: only whoever started a session, or the user, can drive it.",
            found.name,
            self.who(found.parent_id.as_deref())
        ))
    }

    /// Any session or bot in the caller's workspace, to read.
    fn visible(&self, caller: &Caller, id: &str) -> Result<Session, String> {
        let workspace = caller.workspace_id()?;
        session::get(&self.store, id.trim().to_string())?
            .filter(|row| row.workspace_id == workspace)
            .ok_or_else(|| format!("No session {id} in this workspace. list_peers has who is here."))
    }

    /// Whether the caller is the one a session reports to, whose `seen` it is.
    fn is_owner(caller: &Caller, row: &Session) -> bool {
        match caller {
            Caller::User { .. } => row.kind == "child" && row.parent_id.is_none(),
            _ => row.parent_id.is_some() && caller.session_id() == row.parent_id.as_deref(),
        }
    }

    /// The owner has now seen `row` up to `cursor`: the next wait starts
    /// there, and a report or question of what it has now seen, still waiting
    /// in a bot parent's box, is set aside. A message the session wrote is not.
    fn saw(&self, caller: &Caller, row: &Session, cursor: i64) {
        if !Self::is_owner(caller, row) {
            return;
        }
        let _ = session_events::mark_seen(&self.store, &row.id, cursor);
        if let Some(parent) = row.parent_id.as_deref() {
            let seen = session_events::seen(&self.store, &row.id).unwrap_or(cursor);
            let _ = mailbox::take_back(&self.store, parent, &row.id, seen);
        }
    }

    /// A session id as "Name (bot id)"; `None` is the user.
    fn who(&self, session_id: Option<&str>) -> String {
        let Some(id) = session_id else {
            return "the user".to_string();
        };
        match session::get(&self.store, id.to_string()) {
            Ok(Some(row)) => Caller::from_session(row).label(),
            _ => format!("a session since deleted ({id})"),
        }
    }

    fn live_children(&self, workspace: &str, parent: &str) -> Result<Vec<Session>, String> {
        Ok(session::list(&self.store, workspace.to_string())?
            .into_iter()
            .filter(|row| row.kind == "child" && row.parent_id.as_deref() == Some(parent) && row.status != "exited")
            .collect())
    }

    /// The question a session is waiting on, as it asked it: only while it
    /// waits, and only one it asked with its question tool (an approval is
    /// the user's).
    fn pending_question(&self, row: &Session) -> Option<Value> {
        if row.status != "needs-input" {
            return None;
        }
        let event = session_events::latest(&self.store, &row.id).ok().flatten()?;
        let request = event.request.filter(|_| event.kind == "needs-input")?;
        (request.get("kind").and_then(Value::as_str) == Some("question")).then_some(request)
    }

    /// The approval a session is waiting on, as it asked it: only while it
    /// waits.
    fn pending_approval(&self, row: &Session) -> Option<Value> {
        if row.status != "needs-input" {
            return None;
        }
        let event = session_events::latest(&self.store, &row.id).ok().flatten()?;
        let request = event.request.filter(|_| event.kind == "needs-input")?;
        (request.get("kind").and_then(Value::as_str) == Some("approval")).then_some(request)
    }

    /// Whether `caller` may decide `request` for `row`: the user always; the
    /// bot that started it, when it could do the same itself. A terminal's
    /// sessions are the user's to approve: nothing wakes a terminal.
    fn may_decide(&self, caller: &Caller, row: &Session, request: &Value) -> bool {
        match caller {
            Caller::User { .. } => true,
            Caller::Bot(me) => {
                row.parent_id.as_deref() == Some(me.id.as_str())
                    && crate::turns::may_decide(&self.turns.effective_autonomy(me), request)
            }
            _ => false,
        }
    }

    /// The status as `caller` reads it: waiting on a question it can answer,
    /// on an approval it can decide, or on the user.
    fn peer_status(&self, caller: &Caller, row: &Session) -> String {
        match row.status.as_str() {
            "needs-input" if self.pending_question(row).is_some() => "question".into(),
            "needs-input" if self.pending_approval(row).is_some_and(|request| self.may_decide(caller, row, &request)) => {
                "approval".into()
            }
            "needs-input" => "waiting_for_user".into(),
            "starting" => "working".into(),
            "done" => "idle".into(),
            other => other.to_string(),
        }
    }

    /// Whether `caller` may write to `target`, and if not, why. Any bot or
    /// session in the workspace takes a letter, but not from itself, not once
    /// a subagent has exited (subagents are disposable: start another with
    /// `delegate`), and not from a caller with less autonomy than the target
    /// has: a session that has to ask could otherwise hand work to one that
    /// does not. The user is exempt.
    fn may_write(&self, caller: &Caller, target: &Session) -> Result<(), String> {
        self.reach(caller, target, false)
    }

    /// Whether `caller` may send `target` a letter: as `may_write`, except
    /// that a letter to an independent session that has exited resumes it
    /// (plan decision 14), and a subagent may always write to the
    /// session that started it, since its reports reach that parent anyway.
    fn may_send(&self, caller: &Caller, target: &Session) -> Result<(), String> {
        self.reach(caller, target, true)
    }

    fn reach(&self, caller: &Caller, target: &Session, letter: bool) -> Result<(), String> {
        if caller.session_id() == Some(target.id.as_str()) {
            return Err("That is you. Nothing writes to itself: carry on in this turn, or to come back to something later, \
                 offer the user a routine with a once schedule."
                .into());
        }
        if target.status == "exited" && (target.kind == "child" || !letter) {
            return Err(if target.kind == "child" {
                format!(
                    "{} is a subagent that has exited, and a subagent stays exited. read_session still reads it; start \
                     another with delegate.",
                    target.name
                )
            } else {
                format!("{} has exited, so nothing can reach it.", target.name)
            });
        }
        let to_my_parent = letter
            && match caller {
                Caller::Child(me) => me.parent_id.as_deref() == Some(target.id.as_str()),
                _ => false,
            };
        if !matches!(caller, Caller::User { .. }) && !to_my_parent {
            let (mine, theirs) = (caller.autonomy(), target.autonomy.as_str());
            if autonomy_rank(theirs).unwrap_or(0) > autonomy_rank(mine).unwrap_or(0) {
                return Err(format!(
                    "{} ({}) runs with {theirs} autonomy and you with {mine}: a session cannot write to one that is \
                     allowed more than it is. Ask the user, who can.",
                    target.name, target.id
                ));
            }
        }
        Ok(())
    }

    /// Whether a subagent's report starts a turn of `caller`'s: a bot's or a session's.
    fn woken_by_reports(caller: &Caller) -> bool {
        matches!(caller, Caller::Bot(_) | Caller::Terminal(_))
    }

    /// Who `to` is: a bot or a session in this workspace, by id. A name is
    /// answered with the id it meant: names are the user's and go stale.
    fn find_peer(&self, caller: &Caller, to: &str) -> Result<Session, String> {
        let to = to.trim();
        let rows = session::list(&self.store, caller.workspace_id()?.to_string())?;
        if let Some(found) = rows.iter().find(|row| row.id == to) {
            return Ok(found.clone());
        }
        let named: Vec<&Session> = rows.iter().filter(|row| row.name.eq_ignore_ascii_case(to)).collect();
        if !named.is_empty() {
            return Err(format!(
                "Peers are addressed by id, not by name. {}",
                named.iter().map(|row| format!("{} is {}.", row.name, row.id)).collect::<Vec<_>>().join(" ")
            ));
        }
        let bots: Vec<String> =
            rows.iter().filter(|row| row.kind == "bot").map(|row| format!("{} {}", row.name, row.id)).collect();
        Err(format!(
            "No bot or session {to} in this workspace. list_peers has the ids{}",
            if bots.is_empty() { ".".to_string() } else { format!("; the bots: {}", bots.join(", ")) }
        ))
    }

    fn peers(&self, caller: &Caller) -> Result<Value, String> {
        let workspace = caller.workspace_id()?.to_string();
        let rows = session::list(&self.store, workspace.clone())?;
        let me = caller.session_id();
        let folder = crate::workspace::get(&self.store, workspace)?.map(|row| row.path);
        let branches: HashMap<String, Option<String>> = match &folder {
            Some(folder) if rows.iter().any(|row| row.worktree.is_some()) => {
                crate::worktree::branches(folder).into_iter().collect()
            }
            _ => HashMap::new(),
        };
        let listed: Vec<Value> = rows
            .iter()
            .filter(|row| Some(row.id.as_str()) != me)
            .filter(|row| match row.kind.as_str() {
                // A subagent that has exited is listed only to whoever started it.
                "child" => (row.parent_id.is_some() && row.parent_id.as_deref() == me) || row.status != "exited",
                _ => true,
            })
            .map(|row| {
                let kind = if row.kind == "bot" { "bot" } else { "session" };
                let mut out = json!({
                    "id": row.id,
                    "name": row.name,
                    "type": match row.kind.as_str() {
                        "bot" => "bot",
                        "child" => "subagent",
                        _ => "session",
                    },
                    "kind": kind,
                    "status": self.peer_status(caller, row),
                });
                if let Some(parent) = row.parent_id.as_deref() {
                    out["parent"] = json!(if Some(parent) == me { "you".to_string() } else { self.who(Some(parent)) });
                }
                if let Some(by) = row.launched_by.as_deref() {
                    out["launched_by"] = json!(if Some(by) == me { "you".to_string() } else { self.who(Some(by)) });
                }
                out["worktree"] = json!(match row.worktree.as_deref() {
                    None => "main checkout".to_string(),
                    Some(path) => branches.get(path).cloned().flatten().unwrap_or_else(|| path.to_string()),
                });
                if row.kind == "bot" && !row.description.trim().is_empty() {
                    let line = row.description.trim().lines().next().unwrap_or("");
                    let about: String = line.chars().take(100).collect();
                    out["about"] = json!(if about.len() < line.len() { format!("{about}…") } else { about });
                }
                out["write"] = json!(self.may_send(caller, row).is_ok());
                out
            })
            .collect();
        Ok(Value::Array(listed))
    }

    fn send(&self, caller: &Caller, args: &Value) -> Result<Value, String> {
        let to = text(args.get("to")).ok_or("to is required: an id from list_peers, or from the line a message arrived on")?;
        let steer = args.get("steer").and_then(Value::as_bool).unwrap_or(false);
        let answers: Option<Vec<String>> = match args.get("answers") {
            None | Some(Value::Null) => None,
            Some(Value::Array(items)) => Some(
                items
                    .iter()
                    .map(|item| match item {
                        Value::String(text) => text.trim().to_string(),
                        Value::Array(many) => many
                            .iter()
                            .map(|one| one.as_str().map(str::to_string).unwrap_or_else(|| one.to_string()))
                            .collect::<Vec<_>>()
                            .join(", "),
                        other => other.to_string(),
                    })
                    .collect(),
            ),
            Some(_) => return Err("answers is a list: one answer per question, in the order they were asked".into()),
        };
        let decision = match text(args.get("decision")).as_deref() {
            None => None,
            Some("allow") => Some(ApprovalDecision::Allow),
            Some("deny") => Some(ApprovalDecision::Deny),
            Some(other) => return Err(format!("decision is allow or deny, not \"{other}\"")),
        };
        let body = text(args.get("text"));
        if body.is_none() && answers.is_none() && decision.is_none() {
            return Err("text is required".into());
        }
        let target = self.find_peer(caller, &to)?;
        self.may_send(caller, &target)?;
        if let Some(decision) = decision {
            return self.decide(caller, &target, decision, body.as_deref());
        }
        // A subagent stopped on a question takes this as the answer, from
        // anyone who may write to it: whoever may write may answer.
        if let Some(request) = self.pending_question(&target).filter(|_| target.kind == "child") {
            return self.answer(caller, &target, &request, body.as_deref(), answers);
        }
        let Some(body) = body else {
            return Err(format!(
                "{} is not waiting on a question, so there is nothing for answers to answer: send text.",
                target.name
            ));
        };
        // An independent session that has exited takes the letter as a turn
        // on the conversation it left (plan decision 14).
        let resuming = target.status == "exited";
        let mut fell_back = None;
        // The letter a steer that did not go through left in the box.
        let mut released = None;
        if steer && !resuming {
            let tried = if !STEERABLE.contains(&target.provider.as_str()) {
                Err(format!("{} cannot take a message in the middle of a turn", target.provider))
            } else if !self.turns.is_running(&target.id) {
                Err("no turn was running".to_string())
            } else {
                // Written into the turn, the letter is claimed by it: read, it is
                // delivered; not taken, it goes back in the box below.
                let letter = mailbox::record_claimed(&self.store, &target.id, &caller.sender(), &body)?;
                match self.turns.steer(&target.id, &body, caller.sender(), Some(letter.id.clone())) {
                    Ok(()) => Ok(letter),
                    Err(why) => {
                        mailbox::release(&self.store, &letter.id)?;
                        released = Some(letter.id);
                        Err(why)
                    }
                }
            };
            match tried {
                Ok(letter) => {
                    return Ok(json!({
                        "to": target.name,
                        "id": target.id,
                        "letter_id": letter.id,
                        "delivery": "steered",
                        "note": "It reads this at its next step, in the turn it is in, so that turn's answer takes it into \
                                 account. Should the turn end first, it becomes the next turn."
                    }))
                }
                Err(why) => fell_back = Some(why),
            }
        }
        let letter = match released {
            Some(id) => id,
            None => mailbox::enqueue(&self.store, &target.id, &caller.sender(), &body)?.id,
        };
        // What goes over is the oldest letter, which may not be this one: a
        // queue that delivers out of order is worse than one that waits.
        let started = if resuming { self.turns.drain_mailbox(&target.id) } else { self.turns.deliver_to(&target) };
        let waiting = mailbox::waiting_count(&self.store, &target.id)?;
        let mut note = if resuming && started {
            format!("{} had exited. It is resumed on its conversation and reads this now.", target.name)
        } else if resuming {
            format!("{} had exited, and could not be resumed now; the letter waits in its mailbox.", target.name)
        } else if started {
            format!("{} is reading it now.", target.name)
        } else if target.status == "needs-input" {
            format!("{} is waiting for the user's approval in Crew; it reads this when its turn ends.", target.name)
        } else if crate::session::paused(&self.store, &target.id) {
            format!(
                "{} is paused after {} automatic turns in a row. The letter waits in its mailbox until the user writes to it.",
                target.name,
                crate::session::PAUSE_AFTER
            )
        } else if !self.turns.is_running(&target.id) && target.kind != "bot" {
            format!(
                "{} reads it in a moment, with any letter that comes close behind it: letters that arrive together go as one turn.",
                target.name
            )
        } else {
            format!("{} is busy; it reads this the moment its current turn ends.", target.name)
        };
        if let Some(why) = fell_back {
            note = format!("Not steered ({why}), so it was queued as a message. {note}");
        }
        match caller {
            Caller::User { .. } => note.push_str(" Its reply will be in its chat."),
            _ => {}
        }
        Ok(json!({
            "to": target.name,
            "id": target.id,
            "letter_id": letter,
            "delivery": if resuming && started { "resumed" } else if started { "started" } else { "queued" },
            "waiting": waiting,
            "note": note
        }))
    }

    /// `send_message` to a subagent waiting on a question: the answer, through
    /// the same door the window's card uses, so the first answer wins.
    fn answer(
        &self,
        caller: &Caller,
        target: &Session,
        request: &Value,
        text: Option<&str>,
        answers: Option<Vec<String>>,
    ) -> Result<Value, String> {
        let questions: Vec<String> = request
            .get("questions")
            .and_then(Value::as_array)
            .map(|items| items.iter().filter_map(|q| q.get("question").and_then(Value::as_str)).map(str::to_string).collect())
            .unwrap_or_default();
        let request_id = request.get("request_id").and_then(Value::as_u64).ok_or("The question has no request id")?;
        let asked = mailbox::questions_text(request);
        let given = match (answers, text) {
            (Some(answers), _) => answers,
            (None, Some(text)) if questions.len() == 1 => vec![text.to_string()],
            (None, _) => {
                return Err(format!(
                    "{} asked {} questions: pass answers, one per question in order.\n{asked}",
                    target.name,
                    questions.len()
                ))
            }
        };
        if given.len() != questions.len() {
            return Err(format!(
                "{} asked {} question(s) and answers has {}: one per question, in order.\n{asked}",
                target.name,
                questions.len(),
                given.len()
            ));
        }
        // What the thread shows of the answer: the one answer, or each in order.
        let said = match given.as_slice() {
            [one] => one.clone(),
            many => many.iter().enumerate().map(|(at, answer)| format!("{}. {answer}", at + 1)).collect::<Vec<_>>().join("\n"),
        };
        let map: HashMap<String, String> = questions.into_iter().zip(given).collect();
        self.turns.answer(&target.id, request_id, Some(map)).map_err(|error| {
            if error.contains("already answered") {
                format!(
                    "{}'s question was already answered (the user may have answered it in Crew). Nothing was sent.",
                    target.name
                )
            } else {
                format!("{}'s question could not be answered: {error}", target.name)
            }
        })?;
        self.saw(caller, target, target.cursor);
        let letter = mailbox::record_delivered(&self.store, &target.id, &caller.sender(), &said)?;
        let note = match caller {
            c if Self::woken_by_reports(c) => "It carries on with your answer. Its report wakes you when its turn ends.",
            Caller::Terminal(_) => {
                "It carries on with your answer. Nothing wakes you when it reports: check it with read_session."
            }
            _ => "It carries on with your answer.",
        };
        Ok(json!({ "to": target.name, "id": target.id, "letter_id": letter.id, "delivery": "answered", "note": note }))
    }

    /// `send_message` with a decision: allow or deny what a child is waiting
    /// on, through the same door the window's card uses, so the first answer
    /// wins. A live approval first; otherwise a process it proposed. Only for
    /// a parent that could do it itself; `text`, if any, follows as a message.
    fn decide(&self, caller: &Caller, target: &Session, decision: ApprovalDecision, note: Option<&str>) -> Result<Value, String> {
        let drives = matches!(caller, Caller::User { .. }) || caller.session_id() == target.parent_id.as_deref();
        if target.kind != "child" || !drives {
            return Err(format!(
                "{} ({}) is not a session you started: a decision is only for an approval your own session waits on.",
                target.name, target.id
            ));
        }
        if matches!(caller, Caller::Terminal(_)) {
            return Err(format!(
                "Approvals of the sessions a terminal starts are the user's: {} waits for them in Crew. Nothing was decided.",
                target.name
            ));
        }
        let allow = decision == ApprovalDecision::Allow;
        let verb = if allow { "allowed" } else { "denied" };
        let by = match caller {
            Caller::User { .. } => "The user".to_string(),
            _ => caller.session().map(|me| me.name.clone()).unwrap_or_default(),
        };
        let mine = caller.autonomy().to_string();
        let refused = |what: &str| {
            format!(
                "Your autonomy is {mine}: you would have to ask before doing {what} yourself, so it is not yours to \
                 decide for {}. It waits for the user in Crew; nothing was decided.",
                target.name
            )
        };
        let title = if let Some(request) = self.pending_approval(target) {
            if !self.may_decide(caller, target, &request) {
                return Err(refused("this"));
            }
            let request_id = request.get("request_id").and_then(Value::as_u64).ok_or("The approval has no request id")?;
            let title = request
                .get("title")
                .and_then(Value::as_str)
                .filter(|title| !title.trim().is_empty())
                .or_else(|| request.get("tool").and_then(Value::as_str))
                .unwrap_or("its request")
                .to_string();
            self.turns.respond(&target.id, request_id, decision).map_err(|error| {
                if error.contains("already answered") {
                    format!(
                        "{}'s approval was already answered (the user may have decided it in Crew). Nothing was decided.",
                        target.name
                    )
                } else {
                    format!("{}'s approval could not be decided: {error}", target.name)
                }
            })?;
            self.saw(caller, target, target.cursor);
            title
        } else if let Some(process) = self.proposed_process(target)? {
            if !self.may_decide(caller, target, &json!({ "kind": "process" })) {
                return Err(refused("a process"));
            }
            let host = self.processes.as_ref().ok_or("Processes are not available here")?;
            if allow {
                host.approve(&process.workspace_id, &process.id, process.revision)?;
            } else {
                host.reject(&process.workspace_id, &process.id)?;
            }
            let _ = mailbox::dispose_approvals(&self.store, target.parent_id.as_deref().unwrap_or_default(), &target.id);
            format!("the process \"{}\"", process.spec.name)
        } else {
            return Err(format!(
                "{} is not waiting on an approval: it was already answered (the user may have decided it in Crew), or \
                 it never asked. Nothing was decided.",
                target.name
            ));
        };
        // Who decided, in the session's own transcript, beside the card.
        self.turns
            .transcripts()
            .apply(&target.id, crew_protocol::HarnessEvent::SessionNote { message: format!("{by} {verb}: {title}") });
        let said = format!("{}: {title}", if allow { "Allowed" } else { "Denied" });
        let letter = mailbox::record_delivered(&self.store, &target.id, &caller.sender(), &said)?;
        let mut out = json!({ "to": target.name, "id": target.id, "letter_id": letter.id, "delivery": "answered" });
        let mut text = format!("{} {verb}. It carries on.", title);
        if let Some(note) = note.filter(|note| !note.trim().is_empty()) {
            let queued = mailbox::enqueue(&self.store, &target.id, &caller.sender(), note)?;
            self.turns.deliver_to(target);
            out["message_letter_id"] = json!(queued.id);
            text.push_str(" Your text follows as a message, read when its current turn ends.");
        }
        if Self::woken_by_reports(caller) {
            text.push_str(" Its report wakes you when its turn ends.");
        }
        out["note"] = json!(text);
        Ok(out)
    }

    /// The oldest process `row` defined or proposed a change to that still
    /// waits for approval.
    fn proposed_process(&self, row: &Session) -> Result<Option<crew_protocol::Process>, String> {
        let Some(host) = &self.processes else {
            return Ok(None);
        };
        Ok(host.list(&row.workspace_id)?.into_iter().find(|process| {
            let asker = process.requested_by.as_deref().or(process.created_by.as_deref());
            asker == Some(row.id.as_str()) && (!process.approved || process.proposed.is_some())
        }))
    }

    /// `delegate` and `start_session`, which share everything up to the row
    /// they make: the prompt, the provider and model, the autonomy ceiling and
    /// the worktree.
    fn start(&self, caller: &Caller, args: &Value, how: Start) -> Result<Value, String> {
        caller.workspace_id()?;
        if args.get("owner").is_some_and(|owner| !owner.is_null()) {
            return Err("owner is gone. delegate hands a job to a subagent that reports to you; start_session starts a \
                 separate session the user can see and talk to, and reports to nobody."
                .into());
        }
        self.depth_one(caller)?;
        let wait = args.get("wait").and_then(Value::as_bool).unwrap_or(false);
        if how == Start::Launch && (wait || args.get("timeout_s").is_some_and(|raw| !raw.is_null())) {
            return Err("start_session does not wait: a separate session reports to nobody, so there is nothing to wait \
                 for. To get a job's answer back, use delegate with wait."
                .into());
        }
        let timeout = wait_seconds(args)?;
        let tool = if how == Start::Delegate { "delegate" } else { "start_session" };
        let (made, repeated) = self.once(caller, args, tool, || {
            let mut kept = None;
            self.make_session(caller, args, how, &mut kept).map(|(_, out)| out)
        })?;
        let id = made["id"].as_str().unwrap_or_default().to_string();
        let mut out = made;
        let Some(row) = session::get(&self.store, id.clone())? else {
            out["repeated"] = json!(true);
            out["status"] = json!("gone");
            out["note"] = json!("An earlier call with this request_id started it, and it has since been deleted. Nothing new was started: use a fresh request_id to start another.");
            return Ok(out);
        };
        let name = row.name.clone();
        let waited = if how == Start::Launch {
            let hears = caller.session().is_some();
            json!({
                "status": "starting",
                "note": format!(
                    "{name} is a separate session, the user's: it opens in its own tab in Crew and works on the prompt \
                     now. It reports to nobody, so its work does not come back to you{}",
                    if hears {
                        format!(
                            "; it can reach you with send_message to {} if the prompt says to. read_session and \
                             stop_session are for subagents.",
                            caller.session_id().unwrap_or_default()
                        )
                    } else {
                        ".".to_string()
                    }
                )
            })
        } else if wait {
            self.await_turn(caller, &row, Duration::from_secs(timeout))?
        } else {
            json!({
                "status": "starting",
                "note": match caller {
                    c if Self::woken_by_reports(c) => "It is working on the prompt now. Its report wakes you when its turn ends: end your \
                                       turn rather than wait. read_session shows what it did; send_message gives it more.",
                    Caller::Terminal(_) => "It is working on the prompt now. Nothing wakes you when it reports, so check it \
                                            with read_session (or pass wait: true next time); send_message gives it more.",
                    _ => "It is working on the prompt now; its chat is in Crew. read_session shows what it did.",
                }
            })
        };
        if let (Some(out), Some(waited)) = (out.as_object_mut(), waited.as_object()) {
            out.extend(waited.clone());
        }
        if repeated {
            out["repeated"] = json!(true);
            if !wait {
                out["status"] = json!(self.peer_status(caller, &row));
                out["note"] = json!("An earlier call with this request_id already started it; nothing new was started. read_session shows what it did.");
            }
        }
        Ok(out)
    }

    /// Make a session and start its first turn: everything `delegate` and
    /// `start_session` share, and what each entry of `start_sessions` does.
    /// `kept` is set to the worktree this call made, so a caller whose session
    /// then failed can say it was left behind. Returns the row and what the
    /// tool says of it.
    fn make_session(
        &self,
        caller: &Caller,
        args: &Value,
        how: Start,
        kept: &mut Option<String>,
    ) -> Result<(Session, Value), String> {
        let workspace = caller.workspace_id()?.to_string();
        let prompt =
            text(args.get("prompt")).ok_or_else(|| "prompt is required: the session starts with nothing but it".to_string())?;
        let provider = text(args.get("provider"))
            .or_else(|| caller.session().map(|me| me.provider.clone()))
            .unwrap_or_else(|| "claude".into());
        let models = provider_models(&provider)
            .ok_or_else(|| format!("Unknown provider \"{provider}\". One of: {}", provider_names().join(", ")))?;
        let model = match text(args.get("model")) {
            Some(model) if models.contains(&model) => model,
            Some(model) => return Err(unknown_model(&model, &provider)),
            None => match caller.session().filter(|me| me.provider == provider && !me.model.is_empty()) {
                Some(me) => me.model.clone(),
                None => crate::tools::unnamed_model(&provider),
            },
        };
        let effort = crate::tools::named_effort(&provider, args)?;
        // Never more than the caller has: a parent that has to ask before a
        // command could otherwise start a child that does not, and hand it
        // the command.
        let mine = caller.autonomy().to_string();
        let ceiling = autonomy_rank(&mine).unwrap_or(0);
        let autonomy = match text(args.get("autonomy")) {
            None => mine.clone(),
            Some(wanted) => match autonomy_rank(&wanted) {
                None => return Err(format!("autonomy is ask, edits, auto or full, not \"{wanted}\"")),
                Some(rank) if rank > ceiling => {
                    return Err(format!(
                        "Your autonomy is {mine}, so a session you start cannot have {wanted}: it would be allowed \
                         more than you. Leave autonomy out, or ask for {mine} or less."
                    ))
                }
                Some(_) => wanted,
            },
        };
        let name = text(args.get("name")).unwrap_or_else(|| default_name(&provider, &prompt));
        if how == Start::Delegate {
            if let Some(me) = caller.session() {
                let live = self.live_children(&workspace, &me.id)?;
                if live.len() >= LIVE_CAP {
                    return Err(format!(
                        "You already have {LIVE_CAP} live subagents: {}. Stop one with stop_session first; one idle \
                         for {} minutes ends on its own.",
                        live.iter().map(|row| format!("{} {} ({})", row.name, row.id, row.status)).collect::<Vec<_>>().join(", "),
                        Self::idle_limit().as_secs() / 60
                    ));
                }
            }
        }
        let (worktree, made_tree) = self.worktree(caller, &workspace, args.get("worktree"), &name)?;
        if made_tree {
            *kept = worktree.clone();
        }
        let row = match how {
            Start::Delegate => session::create_child(
                &self.store,
                workspace.clone(),
                name.clone(),
                provider.clone(),
                model.clone(),
                autonomy.clone(),
                worktree.clone(),
                caller.session_id().map(str::to_string),
            )?,
            Start::Launch => self.make_launched(caller, &workspace, &name, &provider, &model, &autonomy, &worktree)?,
        };
        session::set_options(
            &self.store,
            row.id.clone(),
            row.model.clone(),
            effort.clone(),
            row.service_tier.clone(),
            row.autonomy.clone(),
        )?;
        let row = session::get(&self.store, row.id.clone())?.unwrap_or(row);
        (self.on_created)(&row);
        // The prompt is the first letter between the two: the pair's thread
        // starts with it.
        let letter = mailbox::record_claimed(&self.store, &row.id, &caller.sender(), &prompt)?;
        if let Caller::Bot(me) = caller {
            self.turns.transcripts().append_system_letter(
                &me.id,
                &match how {
                    Start::Delegate => format!("Delegated to subagent {name} ({})", row.id),
                    Start::Launch => format!("Started session {name} ({})", row.id),
                },
                &letter.id,
            );
        }
        let cwd = session::cwd(&self.store, &row)?;
        let from = match caller {
            Caller::User { .. } => None,
            _ => Some(caller.sender()),
        };
        if let Err(error) = self.turns.start(TurnStart {
            session_id: row.id.clone(),
            cwd,
            text: prompt,
            files: None,
            mentions: None,
            hidden: None,
            from_bot: from,
            sent_at: None,
            nonce: None,
            letter_id: Some(letter.id.clone()),
            mode: None,
            command: None,
            skills: None,
        }) {
            let _ = mailbox::dispose(&self.store, &letter.id);
            let _ = session::set_status(&self.store, row.id.clone(), "error".into());
            return Err(format!("The session was made ({}) but its first turn did not start: {error}", row.id));
        }
        let out = json!({
            "id": row.id,
            "letter_id": letter.id,
            "name": name,
            "provider": provider,
            "model": model,
            "effort": effort,
            "autonomy": autonomy,
            "worktree": worktree.as_deref().unwrap_or("main checkout"),
            "kind": if how == Start::Delegate { "subagent" } else { "session" },
            "branch": worktree.as_deref().and_then(|tree| {
                crate::worktree::branches(tree).into_iter().find(|(path, _)| path == tree).and_then(|(_, branch)| branch)
            }),
        });
        Ok((row, out))
    }

    /// Runs `make` once per `request_id`: a retry with the same id from the
    /// same caller gets what the first call made, and `true` for repeated. With
    /// no id it just runs. A call that failed leaves nothing behind, so its
    /// retry runs again.
    fn once(
        &self,
        caller: &Caller,
        args: &Value,
        tool: &str,
        make: impl FnOnce() -> Result<Value, String>,
    ) -> Result<(Value, bool), String> {
        let Some(request) = request_id(args)? else {
            return Ok((make()?, false));
        };
        let who = caller.session_id().unwrap_or("user").to_string();
        if let Some((was, made)) = crate::requests::get(&self.store, &who, &request)? {
            if was != tool {
                return Err(format!(
                    "request_id {request} was already used by {was}, not {tool}: an id names one call. Use a fresh one."
                ));
            }
            return Ok((made, true));
        }
        let key = format!("{who}\u{0}{request}");
        if !self.in_flight.lock().unwrap_or_else(|e| e.into_inner()).insert(key.clone()) {
            return Err(format!(
                "A call with request_id {request} is still starting its sessions. Retry in a moment: it then returns what that call made."
            ));
        }
        let made = make();
        self.in_flight.lock().unwrap_or_else(|e| e.into_inner()).remove(&key);
        let made = made?;
        crate::requests::put(&self.store, &who, &request, tool, &made)?;
        Ok((made, false))
    }

    /// `start_sessions`: up to [`BATCH_MAX`] separate sessions in one call,
    /// each made on its own. An entry that fails does not stop the others, and
    /// a worktree made for one that then failed stays, named in its result.
    /// Decision 28: a subagent works at depth one. It is not listed the start
    /// tools; a call that reaches them anyway (opencode's one server lists
    /// every session the same tools) is told what to do instead.
    fn depth_one(&self, caller: &Caller) -> Result<(), String> {
        let Caller::Child(me) = caller else { return Ok(()) };
        Err(format!(
            "A subagent cannot delegate or start sessions: do this yourself, or ask {} with send_message.",
            match me.parent_id.as_deref() {
                Some(parent) => format!("your parent ({})", self.who(Some(parent))),
                None => "whoever started you".to_string(),
            }
        ))
    }

    fn start_many(&self, caller: &Caller, args: &Value) -> Result<Value, String> {
        caller.workspace_id()?;
        self.depth_one(caller)?;
        let list = args
            .get("sessions")
            .and_then(Value::as_array)
            .ok_or("sessions is required: a list of 1 to 20 entries, each with its own prompt")?;
        if list.is_empty() {
            return Err("sessions is empty: give 1 to 20 entries, each with its own prompt".into());
        }
        if list.len() > BATCH_MAX {
            return Err(format!(
                "{} entries: start_sessions takes at most {BATCH_MAX} and refuses a longer list whole. Nothing was \
                 started: send it in lists of {BATCH_MAX} or fewer.",
                list.len()
            ));
        }
        let (made, repeated) = self.once(caller, args, "start_sessions", || {
            let mut results = Vec::new();
            for (index, entry) in list.iter().enumerate() {
                let mut kept = None;
                let outcome = if entry.is_object() {
                    self.make_session(caller, entry, Start::Launch, &mut kept)
                } else {
                    Err("an entry is an object with at least a prompt".to_string())
                };
                results.push(match outcome {
                    Ok((_, mut out)) => {
                        out["index"] = json!(index);
                        out["ok"] = json!(true);
                        out["status"] = json!("starting");
                        out
                    }
                    Err(error) => {
                        let mut out = json!({ "index": index, "ok": false, "error": error });
                        if let Some(tree) = kept {
                            out["worktree"] = json!(tree);
                            out["note"] = json!(
                                "The worktree was made for this entry and is kept, so it is not made twice: start the \
                                 entry again with worktree set to this path, or remove it."
                            );
                        }
                        out
                    }
                });
            }
            let started = results.iter().filter(|out| out["ok"] == true).count();
            Ok(json!({
                "started": started,
                "failed": results.len() - started,
                "sessions": results,
                "note": "Each is a separate session of the user's, in its own tab in Crew, working on its prompt now. \
                         They report to nobody, so their work does not come back to you."
            }))
        })?;
        let mut out = made;
        if repeated {
            out["repeated"] = json!(true);
            out["note"] = json!("An earlier call with this request_id already made these; nothing new was started.");
        }
        Ok(out)
    }

    /// The row `start_session` makes: a top-level session,
    /// fixed at creation, that is the user's. It is nobody's child, so it is
    /// never reaped and counts against no one's cap, and it records who
    /// launched it, which grants nothing.
    #[allow(clippy::too_many_arguments)]
    fn make_launched(
        &self,
        caller: &Caller,
        workspace: &str,
        name: &str,
        provider: &str,
        model: &str,
        autonomy: &str,
        worktree: &Option<String>,
    ) -> Result<Session, String> {
        let row = session::create_in_worktree(
            &self.store,
            workspace.to_string(),
            "terminal".into(),
            name.to_string(),
            provider.to_string(),
            model.to_string(),
            String::new(),
            autonomy.to_string(),
            worktree.clone(),
        )
        .map_err(|error| match worktree {
            Some(tree) => format!("The worktree is at {tree}, but its session could not be made: {error}"),
            None => error,
        })?;
        if let Some(me) = caller.session() {
            session::set_launched_by(&self.store, &row.id, &me.id)?;
        }
        Ok(session::get(&self.store, row.id.clone())?.unwrap_or(row))
    }

    /// Block until `row` ends a turn (its report), stops on a question, or
    /// `timeout` passes. An approval it waits on is the user's, so the wait
    /// carries on past it. What the wait hands back counts as seen: the same
    /// report or question does not also wake the caller.
    fn await_turn(&self, caller: &Caller, row: &Session, timeout: Duration) -> Result<Value, String> {
        let deadline = Instant::now() + timeout;
        loop {
            let since = BTreeMap::from([(row.id.clone(), session_events::seen(&self.store, &row.id)?)]);
            let left = deadline.saturating_duration_since(Instant::now());
            let out = self.wait_events(caller, std::slice::from_ref(row), since, left)?;
            let now = session::get(&self.store, row.id.clone())?.unwrap_or_else(|| row.clone());
            match out["result"].as_str() {
                Some("event") => {
                    let event = &out["sessions"][0];
                    if event["event"] == "needs-input" {
                        let request = &event["request"];
                        if request["kind"] == "approval" {
                            if !self.may_decide(caller, &now, request) {
                                // The user's, in Crew. Keep waiting.
                                continue;
                            }
                            return Ok(json!({
                                "status": "approval",
                                "approval": mailbox::approval_text(request),
                                "note": format!(
                                    "It waits on an approval you may decide. Decide with send_message to {}: \
                                     {{\"decision\": \"allow\"}} or \"deny\". If it is the user's call, ask the user \
                                     first; the user can also decide it in Crew.",
                                    row.id
                                )
                            }));
                        }
                        if request["kind"] != "question" {
                            continue;
                        }
                        return Ok(json!({
                            "status": "question",
                            "questions": request["questions"],
                            "note": format!(
                                "It stopped to ask. Answer with send_message to {}: text answers a single question, \
                                 answers gives one per question in order. If the decision is the user's, say so; the \
                                 user can answer it in Crew.",
                                row.id
                            )
                        }));
                    }
                    let status = match (event["event"].as_str(), event["outcome"].as_str()) {
                        (Some("turn"), Some("completed")) => "reported",
                        (Some("turn"), _) => "stopped",
                        (Some("error"), _) => "failed",
                        (Some("exited"), _) => "exited",
                        _ => "reported",
                    };
                    let mut result = json!({
                        "status": status,
                        "report": event["report"],
                        "cursor": event["cursor"],
                        "note": format!("send_message to {} gives it more in the same conversation; read_session shows what it did.", row.id),
                    });
                    for key in ["outcome"] {
                        if !event[key].is_null() && !(key == "outcome" && status == "reported") {
                            result[key] = event[key].clone();
                        }
                    }
                    return Ok(result);
                }
                Some("nothing-running") if now.status == "needs-input" => {
                    // Waiting on an approval with no turn host behind it; the
                    // deadline is the only way out.
                    if Instant::now() >= deadline {
                        return Ok(self.still_running(caller, &now, timeout));
                    }
                    std::thread::sleep(Duration::from_millis(200));
                }
                Some("nothing-running") => {
                    return Ok(json!({
                        "status": self.peer_status(caller, &now),
                        "note": "It is not working, and has nothing new to report. read_session shows what it did."
                    }))
                }
                _ => return Ok(self.still_running(caller, &now, timeout)),
            }
        }
    }

    fn still_running(&self, caller: &Caller, row: &Session, timeout: Duration) -> Value {
        let mut note = format!("Still working after {}s; it carries on.", timeout.as_secs());
        if self.peer_status(caller, row) == "waiting_for_user" {
            note.push_str(" It is waiting for the user to approve something in Crew.");
        }
        note.push_str(match caller {
            c if Self::woken_by_reports(c) => " Its report will wake you: end your turn.",
            Caller::Terminal(_) => " Check it with read_session.",
            _ => " Check it with read_session, or in Crew.",
        });
        json!({ "status": "running", "note": note })
    }

    /// Where a new session works (and whether this call made the worktree): `current` (the caller's own folder), `new`
    /// (a branch of its own), or a branch or a worktree path, made if it is
    /// not there yet (checked out if the branch exists, tracked from a remote
    /// if only a remote has it, otherwise made from the main checkout's HEAD).
    fn worktree(
        &self,
        caller: &Caller,
        workspace: &str,
        wanted: Option<&Value>,
        name: &str,
    ) -> Result<(Option<String>, bool), String> {
        let here = caller.worktree().map(str::to_string);
        let wanted = text(wanted).unwrap_or_else(|| "current".into());
        if wanted == "current" {
            return Ok((here, false));
        }
        let folder = match &here {
            Some(tree) if std::path::Path::new(tree).is_dir() => tree.clone(),
            _ => crate::workspace::get(&self.store, workspace.to_string())?
                .map(|row| row.path)
                .ok_or_else(|| "Workspace not found".to_string())?,
        };
        if wanted == "new" {
            let suffix = &uuid::Uuid::new_v4().simple().to_string()[..4];
            let branch = format!("crew/{}-{suffix}", branch_slug(name));
            return (self.make_worktree)(&folder, &branch).map(|tree| (Some(tree.path), true));
        }
        let existing = crate::worktree::list(&folder)
            .into_iter()
            .find(|tree| tree.branch.as_deref() == Some(wanted.as_str()) || tree.path == wanted);
        match existing {
            Some(tree) if tree.main => Ok((None, false)),
            Some(tree) => Ok((Some(tree.path), false)),
            None if wanted.starts_with('/') => Err(format!("{wanted} is not a worktree of this workspace")),
            None => (self.make_worktree)(&folder, &wanted).map(|tree| (Some(tree.path), true)),
        }
    }

    /// Block until any of `targets` has an event past its cursor in `since`,
    /// none of them is working, or `timeout` passes. What it hands back
    /// counts as seen. Backs `start_session`'s `wait`.
    fn wait_events(
        &self,
        caller: &Caller,
        targets: &[Session],
        since: BTreeMap<String, i64>,
        timeout: Duration,
    ) -> Result<Value, String> {
        let deadline = Instant::now() + timeout;
        loop {
            let mark = self.signal.mark();
            let mut news = Vec::new();
            let mut running = false;
            let mut rows = Vec::new();
            for target in targets {
                let row = session::get(&self.store, target.id.clone())?
                    .ok_or_else(|| format!("Session {} was deleted while you waited.", target.id))?;
                let events = session_events::after(&self.store, &row.id, since[&row.id])?;
                if !events.is_empty() {
                    news.push((row.clone(), events));
                }
                // Idle with a message on its way is a turn about to start:
                // the drain at the end of the last one has not got to it yet,
                // or has claimed it and not started the turn.
                let queued =
                    matches!(row.status.as_str(), "idle" | "error") && mailbox::undelivered_count(&self.store, &row.id)? > 0;
                running |= matches!(row.status.as_str(), "starting" | "working")
                    || self.turns.is_running(&row.id)
                    || self.turns.is_settling(&row.id)
                    || queued;
                rows.push(row);
            }
            if !news.is_empty() {
                let mut out = Vec::new();
                let mut next = since.clone();
                for (row, events) in news {
                    let latest = events.last().cloned().expect("news has an event");
                    next.insert(row.id.clone(), latest.cursor);
                    self.saw(caller, &row, latest.cursor);
                    out.push(describe_event(&row, &latest, events.len() - 1));
                }
                return Ok(json!({ "result": "event", "sessions": out, "cursors": next }));
            }
            if !running {
                return Ok(json!({
                    "result": "nothing-running",
                    "sessions": rows.iter().map(|row| json!({
                        "id": row.id,
                        "name": row.name,
                        "status": row.status,
                        "cursor": row.cursor,
                    })).collect::<Vec<_>>(),
                    "cursors": since,
                }));
            }
            if !self.signal.wait(mark, deadline) {
                return Ok(json!({
                    "result": "timed-out",
                    "sessions": rows.iter().map(|row| json!({ "id": row.id, "name": row.name, "status": row.status })).collect::<Vec<_>>(),
                    "cursors": since,
                }));
            }
        }
    }

    /// The wait as tests drive it: `sessions`, with `since` or `cursors` or
    /// what the caller last saw, for `timeout_s`. The same `wait_events`
    /// `start_session` waits with.
    #[cfg(test)]
    pub(crate) fn wait(&self, caller: &Caller, args: &Value) -> Result<Value, String> {
        let ids: Vec<String> =
            args["sessions"].as_array().into_iter().flatten().filter_map(Value::as_str).map(str::to_string).collect();
        let timeout = args["timeout_s"].as_u64().unwrap_or(20);
        let mut targets = Vec::new();
        for id in &ids {
            targets.push(self.owned(caller, id)?);
        }
        let cursors = args.get("cursors").and_then(Value::as_object);
        let given = args.get("since").and_then(Value::as_i64);
        let mut since: BTreeMap<String, i64> = BTreeMap::new();
        for row in &targets {
            let from = match cursors.and_then(|map| map.get(&row.id)).and_then(Value::as_i64) {
                Some(cursor) => cursor,
                None => match given {
                    Some(cursor) => cursor,
                    None if Self::is_owner(caller, row) => session_events::seen(&self.store, &row.id)?,
                    None => row.cursor,
                },
            };
            since.insert(row.id.clone(), from);
        }
        self.wait_events(caller, &targets, since, Duration::from_secs(timeout))
    }

    /// `read_session`: a search, the blocks around one, a cursor, a period
    /// or the tail, of one conversation. Without `session` it is the caller's
    /// own; the user has none, and searches the whole workspace instead.
    fn read(&self, caller: &Caller, args: &Value) -> Result<Value, String> {
        let row = match text(args.get("session")) {
            Some(id) => Some(self.visible(caller, &id)?),
            None => match caller.session() {
                Some(me) => Some(session::get(&self.store, me.id.clone())?.unwrap_or_else(|| me.clone())),
                None => None,
            },
        };
        let budget =
            args.get("max_bytes").and_then(Value::as_u64).map(|n| (n as usize).clamp(1, READ_MAX)).unwrap_or(READ_DEFAULT);
        let tools = args.get("include_tools").and_then(Value::as_bool).unwrap_or(false);
        let roles = roles(args)?;
        let read = Read { budget, tools, roles: roles.as_deref() };
        if let Some(query) = text(args.get("query")) {
            return self.search(caller, row.as_ref(), &query, args, &read);
        }
        let row = row.ok_or("session is required: you have no conversation of your own to read. list_peers has who is here.")?;
        if let Some(at) = args.get("around").filter(|at| !at.is_null()) {
            let at = at.as_i64().filter(|at| *at >= 1).ok_or("around is a block number from a line or a hit (#12 is 12)")?;
            let window = args.get("window").and_then(Value::as_u64).map(|n| n.clamp(1, AROUND_MAX)).unwrap_or(AROUND_DEFAULT);
            return self.around(caller, &row, at as usize, window as usize, &read);
        }
        let since = args.get("since").and_then(Value::as_i64).map(|n| n.max(0) as usize);
        let days = days(args);
        // A period without a query is read like a cursor from its first block,
        // but it is a look back: what it reads is not marked seen. Nor is a
        // read kept to some roles: the report or question it leaves out would
        // be taken back unread.
        let (from, advances) = match (since, days) {
            (Some(from), _) => (Some(ReadFrom::Cursor(from)), read.roles.is_none()),
            (None, Some(days)) => (Some(ReadFrom::Time(now_millis() - days * 86_400_000)), false),
            (None, None) => (None, read.roles.is_none()),
        };
        let running = matches!(row.status.as_str(), "starting" | "working" | "needs-input");
        let (text, start, end, total) = self.turns.transcripts().read(&row.id, |blocks| {
            let total = blocks.len();
            // A block still being written ends the read before it, so the next
            // read with this cursor reads it again, whole.
            let settled = if running { blocks.iter().position(open).unwrap_or(total) } else { total };
            let (start, end, lines) = match from {
                Some(from) => {
                    let from = match from {
                        ReadFrom::Cursor(from) => from.min(total),
                        ReadFrom::Time(cutoff) => {
                            blocks.iter().position(|block| block.at.is_some_and(|at| at >= cutoff)).unwrap_or(total)
                        }
                    };
                    let mut end = from;
                    let mut spent = 0;
                    let mut lines = Vec::new();
                    while end < settled.max(from) {
                        if let Some(line) = read.line(&blocks[end], end + 1) {
                            if spent + line.len() > read.budget && !lines.is_empty() {
                                break;
                            }
                            spent += line.len() + 1;
                            lines.push(line);
                        }
                        end += 1;
                    }
                    (from, end, lines)
                }
                None => {
                    let end = settled;
                    let mut start = end;
                    let mut spent = 0;
                    let mut lines = Vec::new();
                    while start > 0 {
                        if let Some(line) = read.line(&blocks[start - 1], start) {
                            if spent + line.len() > read.budget && !lines.is_empty() {
                                break;
                            }
                            spent += line.len() + 1;
                            lines.push(line);
                        }
                        start -= 1;
                    }
                    lines.reverse();
                    (start, end, lines)
                }
            };
            (lines.join("\n"), start, end, total)
        });
        if advances {
            self.saw(caller, &row, end as i64);
        }
        let status = self.peer_status(caller, &row);
        let mut note = if end < total {
            "There is more after cursor: call again with since = cursor.".to_string()
        } else {
            "That is everything so far. Pass cursor as since next time to read only what is new.".to_string()
        };
        if from.is_none() && start > 0 {
            note.push_str(" Older blocks are before start: query finds them, around reads them.");
        }
        match status.as_str() {
            "question" => note.push_str(&format!(
                " It is waiting on a question: answer it with send_message to {} (text for one question, answers for several).",
                row.id
            )),
            "approval" => note.push_str(&format!(
                " It is waiting on an approval you may decide: send_message to {} with decision allow or deny.",
                row.id
            )),
            "waiting_for_user" => note.push_str(" It is waiting for the user to approve something in Crew."),
            _ => {}
        }
        Ok(json!({
            "session": row.id,
            "status": status,
            "text": text,
            "start": start,
            "cursor": end,
            "more": end < total,
            "note": note
        }))
    }

    /// The blocks either side of `at`, to scroll a conversation from a hit or
    /// a line. A look back: nothing it reads is marked seen.
    fn around(&self, caller: &Caller, row: &Session, at: usize, window: usize, read: &Read) -> Result<Value, String> {
        let (text, start, end, total) = self
            .turns
            .transcripts()
            .read(&row.id, |blocks| read.around(blocks, at, window).map(|(text, start, end)| (text, start, end, blocks.len())))
            .ok_or_else(|| format!("{} has no block #{at}; its lines run from #1 on.", row.name))?;
        let mut note = format!("Blocks #{} to #{end} of {total}.", start + 1);
        if start > 0 {
            note.push_str(&format!(" Earlier: around {}.", start.saturating_sub(window).max(1)));
        }
        if end < total {
            note.push_str(&format!(" Later: around {}, or since {end} to read on.", (end + window + 1).min(total)));
        }
        Ok(json!({
            "session": row.id,
            "status": self.peer_status(caller, row),
            "text": text,
            "start": start,
            "cursor": end,
            "more": end < total,
            "note": note
        }))
    }

    /// Search one conversation (`row`), or, for the user with none named, the
    /// whole workspace. Each hit has the number its block reads as, so
    /// `around` scrolls to it; the best one comes with its neighbours.
    fn search(&self, caller: &Caller, row: Option<&Session>, query: &str, args: &Value, read: &Read) -> Result<Value, String> {
        let days = days(args);
        let limit = args.get("limit").and_then(Value::as_u64).unwrap_or(HITS_DEFAULT).clamp(1, HITS_MAX) as u32;
        let mut roles: Vec<&str> = read.roles.map(|roles| roles.to_vec()).unwrap_or_else(|| vec!["user", "assistant"]);
        if read.tools && !roles.contains(&"tool") {
            roles.push("tool");
        }
        // A question or an approval reads as a tool line, and is stored as itself.
        if roles.contains(&"tool") {
            roles.extend(["approval", "question"]);
        }
        let found = crate::messages::find(
            &self.store,
            crew_protocol::SearchQuery {
                query: query.to_string(),
                workspace_id: Some(caller.workspace_id()?.to_string()),
                session_ids: row.map(|row| vec![row.id.clone()]).unwrap_or_default(),
                from: days.map(|days| now_millis() - days * 86_400_000),
                to: None,
                limit: Some(limit),
                offset: None,
                sort: None,
            },
            &crate::messages::Find { tokens: SNIPPET_TOKENS, roles: &roles, whole: WHOLE_CHARS },
        )?;
        // Every search, so whether words are enough (or vectors are needed)
        // can be judged from what bots actually looked for and found.
        eprintln!(
            "[search] {} in {}: {query:?} → {} hit(s)",
            caller.label(),
            row.map(|row| row.id.as_str()).unwrap_or("the workspace"),
            found.len()
        );
        let mut spent = 0;
        let mut hits = Vec::new();
        for found in &found {
            let hit = &found.hit;
            // The marks are for painting a UI; a model reads the words.
            let words = found
                .text
                .clone()
                .unwrap_or_else(|| hit.snippet.replace([crate::messages::MARK_OPEN, crate::messages::MARK_CLOSE], ""));
            let words = words.trim().to_string();
            if spent + words.len() > read.budget && !hits.is_empty() {
                break;
            }
            spent += words.len() + 64;
            let mut out = json!({
                "at": hit.pos,
                "when": crate::schedule::local_time(hit.at),
                "role": format!("{:?}", hit.role).to_lowercase(),
                "text": words,
            });
            if row.is_none() {
                out["session"] = json!(hit.session_id);
                out["session_name"] = json!(hit.session_name);
            }
            hits.push(out);
        }
        let mut out = json!({ "query": query, "hits": hits });
        if let Some(row) = row {
            out["session"] = json!(row.id);
        }
        let Some(top) = found.first().map(|found| &found.hit) else {
            out["note"] =
                json!("Nothing matched. Try other words: a name, a number, the word the user would have used; or drop days.");
            return Ok(out);
        };
        // The best hit with its neighbours, in what the budget has left.
        let left = Read { budget: read.budget.saturating_sub(spent).max(1024), tools: read.tools, roles: None };
        let at = top.pos.max(1) as usize;
        if let Some((text, start, end)) =
            self.turns.transcripts().read(&top.session_id, |blocks| left.around(blocks, at, TOP_WINDOW))
        {
            out["top"] = json!({ "at": at, "start": start, "cursor": end, "text": text });
        }
        let other = if row.is_none() { ", with its session," } else { "" };
        out["note"] = json!(format!(
            "at is the block number lines read as: around (with at{other}) reads the conversation there; since reads on from a cursor."
        ));
        Ok(out)
    }

    fn stop(&self, caller: &Caller, args: &Value) -> Result<Value, String> {
        let id = text(args.get("session")).ok_or("session is required")?;
        let row = self.owned(caller, &id)?;
        let by = match caller {
            Caller::User { .. } => "the user".to_string(),
            _ => caller.label(),
        };
        // Its subagents go first, deepest first, then it: a parent that exits
        // first would leave them with nobody to report to. Independent
        // sessions it launched are the user's and stay.
        let below = self.subagents_below(&row)?;
        let mut also = Vec::new();
        for sub in below.iter().filter(|sub| sub.status != "exited") {
            self.stop_one(&by, sub)?;
            also.push(json!({ "id": sub.id, "name": sub.name }));
        }
        if row.status == "exited" {
            let mut out =
                json!({ "session": row.id, "status": "exited", "cursor": row.cursor, "note": "It had already exited." });
            if !also.is_empty() {
                out["also_stopped"] = json!(also);
            }
            return Ok(out);
        }
        let now = self.stop_one(&by, &row)?;
        let mut out = json!({
            "session": now.id,
            "status": now.status,
            "cursor": now.cursor,
            "note": "Its CLI is gone; read_session still reads what it did."
        });
        if !also.is_empty() {
            out["also_stopped"] = json!(also);
            out["note"] = json!(
                "Its CLI is gone, and so are its subagents' (also_stopped); read_session still reads what they did.                  Sessions it launched for the user are not touched."
            );
        }
        Ok(out)
    }

    /// The subagents below `row`, at any depth, deepest first.
    fn subagents_below(&self, row: &Session) -> Result<Vec<Session>, String> {
        let all = session::list(&self.store, row.workspace_id.clone())?;
        let mut out = Vec::new();
        let mut seen = HashSet::from([row.id.clone()]);
        fn walk(all: &[Session], parent: &str, seen: &mut HashSet<String>, out: &mut Vec<Session>) {
            for sub in all.iter().filter(|sub| sub.kind == "child" && sub.parent_id.as_deref() == Some(parent)) {
                if seen.insert(sub.id.clone()) {
                    walk(all, &sub.id, seen, out);
                    out.push(sub.clone());
                }
            }
        }
        walk(&all, &row.id, &mut seen, &mut out);
        Ok(out)
    }

    /// End one subagent for good and say what it is now.
    fn stop_one(&self, by: &str, row: &Session) -> Result<Session, String> {
        if self.turns.exit_child(&row.id, by) {
            // Its turn settles on its own thread; give it a moment so the
            // answer says what is true.
            let until = Instant::now() + Duration::from_secs(5);
            while Instant::now() < until {
                if session::get(&self.store, row.id.clone())?.is_some_and(|now| now.status == "exited") {
                    break;
                }
                std::thread::sleep(Duration::from_millis(50));
            }
        } else {
            self.turns.exit_idle_child(
                row,
                &format!("stopped by {by}"),
                &format!("Stopped by {by}. The session has exited; its transcript stays here."),
            );
        }
        Ok(session::get(&self.store, row.id.clone())?.unwrap_or_else(|| row.clone()))
    }

    /// Whether `caller` started `row`: it is its subagent, or it launched it.
    /// The user started every session they want to act on.
    fn started_by(caller: &Caller, row: &Session) -> bool {
        match caller {
            Caller::User { .. } => true,
            _ => caller
                .session_id()
                .is_some_and(|me| row.parent_id.as_deref() == Some(me) || row.launched_by.as_deref() == Some(me)),
        }
    }

    /// `update_session`: rename, change the effort, or delete.
    fn update(&self, caller: &Caller, args: &Value) -> Result<Value, String> {
        let id = text(args.get("session")).ok_or("session is required")?;
        let action = text(args.get("action")).ok_or("action is required: rename, effort or delete")?;
        let row = self.visible(caller, &id)?;
        if row.kind == "bot" {
            return Err(format!(
                "{} is a bot, not a session: a bot is the user's to rename or remove. send_message reaches it.",
                row.name
            ));
        }
        match action.as_str() {
            "rename" => {
                let name = text(args.get("name")).ok_or("name is required to rename")?;
                if !Self::started_by(caller, &row) {
                    self.may_write(caller, &row).map_err(|why| {
                        format!("{} ({}) is not yours to rename: you did not start it, and {why}", row.name, row.id)
                    })?;
                }
                session::rename(&self.store, row.id.clone(), name.clone())?;
                self.store.session_changed(&row.id);
                Ok(json!({ "session": row.id, "name": name.trim(), "note": "Renamed." }))
            }
            "delete" => {
                if !Self::started_by(caller, &row) {
                    return Err(format!(
                        "{} ({}) was not started by you: only whoever started a session, or the user, can delete it.",
                        row.name, row.id
                    ));
                }
                self.delete(&row)
            }
            "effort" => {
                let wanted = text(args.get("effort")).ok_or("effort is required to change the effort")?;
                if !Self::started_by(caller, &row) {
                    self.may_write(caller, &row).map_err(|why| {
                        format!("{} ({}) is not yours to change: you did not start it, and {why}", row.name, row.id)
                    })?;
                }
                let allowed = crate::tools::efforts(&row.provider);
                if allowed.is_empty() {
                    return Err(format!(
                        "{} runs on {}, whose effort is part of the model id, not a setting of its own.",
                        row.name, row.provider
                    ));
                }
                if !allowed.contains(&wanted.as_str()) {
                    return Err(format!("effort for {} is one of {}, not \"{wanted}\"", row.provider, allowed.join(", ")));
                }
                session::set_options(
                    &self.store,
                    row.id.clone(),
                    row.model.clone(),
                    wanted.clone(),
                    row.service_tier.clone(),
                    row.autonomy.clone(),
                )?;
                self.store.session_changed(&row.id);
                Ok(json!({
                    "session": row.id,
                    "effort": wanted,
                    "note": "Applies from its next turn. It may invalidate the prompt cache, except on Anthropic models from the 5 family on."
                }))
            }
            other => Err(format!("action is rename, effort or delete, not \"{other}\"")),
        }
    }

    /// Stop whatever a session has running and let go of its process.
    fn take_down(&self, row: &Session) {
        if self.turns.is_running(&row.id) {
            let _ = self.turns.stop(&row.id);
            let until = Instant::now() + Duration::from_secs(5);
            while Instant::now() < until && self.turns.is_running(&row.id) {
                std::thread::sleep(Duration::from_millis(50));
            }
        }
        self.turns.release(&row.id);
        if let Some(retirement) = self.retirement.get() {
            (retirement.release)(&row.id);
        }
    }

    /// Remove a session and its transcript, its subagents with it, and never
    /// a worktree. Refused while a worktree any of them works in has
    /// uncommitted changes.
    fn delete(&self, row: &Session) -> Result<Value, String> {
        let mut all = self.subagents_below(row)?;
        all.push(row.clone());
        let folder = crate::workspace::get(&self.store, row.workspace_id.clone())?.map(|workspace| workspace.path);
        for one in &all {
            let (Some(tree), Some(folder)) = (one.worktree.as_deref(), folder.as_deref()) else { continue };
            if !std::path::Path::new(tree).is_dir() {
                continue;
            }
            if let Some(dirty) =
                crate::worktree::list(folder).into_iter().find(|t| t.path == tree).map(|t| t.dirty).filter(|dirty| *dirty > 0)
            {
                return Err(format!(
                    "{} works in {tree}, which has {dirty} uncommitted change{}: nothing was deleted. Commit or discard \
                     them, then delete.",
                    one.name,
                    if dirty == 1 { "" } else { "s" }
                ));
            }
        }
        let mut ids = Vec::new();
        for one in &all {
            self.take_down(one);
            session::delete(&self.store, one.id.clone())?;
            self.turns.transcripts().forget(&one.id);
            self.turns.background().forget(&one.id);
            self.turns.mcp_status().forget(&one.id);
            ids.push(one.id.clone());
        }
        if let Some(retirement) = self.retirement.get() {
            (retirement.gone)(&ids);
        }
        Ok(json!({
            "session": row.id,
            "deleted": ids,
            "note": "Deleted with its transcript. Its worktree, if it had one, is untouched."
        }))
    }

    /// `interrupt_session`: stop the turn it is in without ending it. With
    /// `text`, that is the next message, put first in its queue, so the one
    /// call stops and redirects.
    fn interrupt(&self, caller: &Caller, args: &Value) -> Result<Value, String> {
        let id = text(args.get("session")).ok_or("session is required")?;
        let target = self.find_peer(caller, &id)?;
        self.may_write(caller, &target)?;
        let running = self.turns.is_running(&target.id);
        let body = text(args.get("text"));
        let mut out = json!({ "session": target.id, "name": target.name, "interrupted": running });
        match body {
            None => {
                if running {
                    self.turns.stop(&target.id)?;
                    let until = Instant::now() + Duration::from_secs(5);
                    while Instant::now() < until && self.turns.is_running(&target.id) {
                        std::thread::sleep(Duration::from_millis(50));
                    }
                }
                out["note"] = json!(if running {
                    format!("{} stopped what it was doing and is still here: send_message gives it the next thing.", target.name)
                } else {
                    format!("{} was not working, so there was nothing to interrupt.", target.name)
                });
            }
            Some(body) => {
                let letter = mailbox::enqueue(&self.store, &target.id, &caller.sender(), &body)?;
                let sent = self.turns.interrupt_with(&target.id, &letter.id)?;
                out["letter_id"] = json!(letter.id);
                out["delivery"] = json!(sent.delivery.unwrap_or_else(|| "queued".into()));
                out["note"] = json!(if running {
                    format!("{} stopped what it was doing; your message is its next turn.", target.name)
                } else {
                    format!("{} was not working, so nothing was interrupted; your message goes to it as a message.", target.name)
                });
            }
        }
        Ok(out)
    }
}

/// How long `start_session` waits: `timeout_s`, 600 by default, 3600 at most.
fn wait_seconds(args: &Value) -> Result<u64, String> {
    let Some(raw) = args.get("timeout_s").filter(|raw| !raw.is_null()) else {
        return Ok(WAIT_DEFAULT_S);
    };
    let seconds = raw
        .as_f64()
        .or_else(|| raw.as_str().and_then(|text| text.trim().parse().ok()))
        .ok_or_else(|| format!("timeout_s is a number of seconds, at most {WAIT_MAX_S}"))?;
    Ok((seconds.round() as i64).clamp(1, WAIT_MAX_S as i64) as u64)
}

fn describe_event(row: &Session, event: &Event, earlier: usize) -> Value {
    let mut out = json!({
        "id": row.id,
        "name": row.name,
        "status": row.status,
        "event": event.kind,
        "cursor": event.cursor,
    });
    if !event.outcome.is_empty() {
        out["outcome"] = json!(event.outcome);
    }
    if event.kind != "needs-input" {
        out["report"] = json!(event.report);
    }
    if let Some(request) = &event.request {
        out["request"] = request.clone();
    }
    if earlier > 0 {
        out["earlier_events"] = json!(format!("{earlier} earlier event(s) happened since your cursor; read_session shows them."));
    }
    out
}

/// A block still being written: text streaming in, a tool not done.
fn open(block: &Block) -> bool {
    block.streaming == Some(true) || block.tool.as_ref().is_some_and(|tool| tool.status == ToolStatus::Pending)
}

/// Where a forward read starts: a cursor, or the first block of a period.
#[derive(Clone, Copy)]
enum ReadFrom {
    Cursor(usize),
    Time(i64),
}

/// How `read_session` renders the lines it reads.
struct Read<'a> {
    budget: usize,
    tools: bool,
    /// The roles to show; `None` is every one.
    roles: Option<&'a [&'a str]>,
}

impl Read<'_> {
    /// A block's numbered line, unless its role is filtered out.
    fn line(&self, block: &Block, position: usize) -> Option<String> {
        if let Some(roles) = self.roles {
            if !roles.contains(&role_name(&block.role)) {
                return None;
            }
        }
        Some(render(block, position, self.tools))
    }

    /// The lines from `window` blocks before `at` (1-based) to as many after,
    /// dropping the farthest first when they do not fit. `None` when there is
    /// no block `at`. Answers the text and the 0-based range it covers.
    fn around(&self, blocks: &[Block], at: usize, window: usize) -> Option<(String, usize, usize)> {
        if at == 0 || at > blocks.len() {
            return None;
        }
        let index = at - 1;
        let (mut start, mut end) = (index.saturating_sub(window), (index + window + 1).min(blocks.len()));
        let mut lines: Vec<(usize, String)> =
            (start..end).filter_map(|i| self.line(&blocks[i], i + 1).map(|line| (i, line))).collect();
        let mut spent: usize = lines.iter().map(|(_, line)| line.len() + 1).sum();
        while spent > self.budget && lines.len() > 1 {
            let (first, last) = (lines[0].0, lines[lines.len() - 1].0);
            let (gone, edge) = if index.abs_diff(first) >= last.abs_diff(index) {
                (lines.remove(0), true)
            } else {
                (lines.pop().unwrap_or_default(), false)
            };
            spent -= gone.1.len() + 1;
            if edge {
                start = gone.0 + 1;
            } else {
                end = gone.0;
            }
        }
        Some((lines.into_iter().map(|(_, line)| line).collect::<Vec<_>>().join("\n"), start, end))
    }
}

/// A role as `roles` names it, and as the message rows store it.
fn role_name(role: &BlockRole) -> &'static str {
    match role {
        BlockRole::User => "user",
        BlockRole::Assistant => "assistant",
        BlockRole::Reasoning => "reasoning",
        BlockRole::Tool | BlockRole::Approval | BlockRole::Question => "tool",
        BlockRole::System => "system",
    }
}

/// `days`, at most a century: further back is all of it, and a bigger number
/// would overflow the cutoff.
fn days(args: &Value) -> Option<i64> {
    args.get("days").and_then(Value::as_u64).filter(|days| *days > 0).map(|days| days.min(36_500) as i64)
}

const ROLES: &[&str] = &["user", "assistant", "tool", "system", "reasoning"];

/// `roles`, checked. `None` when not given.
fn roles(args: &Value) -> Result<Option<Vec<&'static str>>, String> {
    let Some(given) = args.get("roles").filter(|roles| !roles.is_null()) else {
        return Ok(None);
    };
    let names: Vec<&str> = match given {
        Value::Array(items) => items.iter().filter_map(Value::as_str).collect(),
        Value::String(one) => one.split(',').map(str::trim).collect(),
        _ => Vec::new(),
    };
    let mut roles = Vec::new();
    for name in names.into_iter().filter(|name| !name.is_empty()) {
        let role = ROLES.iter().find(|role| **role == name).ok_or_else(|| format!("roles are some of: {}", ROLES.join(", ")))?;
        roles.push(*role);
    }
    Ok((!roles.is_empty()).then_some(roles))
}

/// One block as a numbered line of the transcript.
fn render(block: &Block, position: usize, tools: bool) -> String {
    let (who, body) = match block.role {
        BlockRole::User => {
            let who = match &block.from_bot {
                Some(from) if from.id.is_empty() => from.name.clone(),
                Some(from) => format!("{} {}", from.name, from.id),
                None => "user".into(),
            };
            (who, block.text.trim().to_string())
        }
        BlockRole::Assistant => ("assistant".into(), block.text.trim().to_string()),
        BlockRole::Reasoning => ("thinking".into(), block.text.trim().to_string()),
        BlockRole::System => ("crew".into(), block.text.trim().to_string()),
        BlockRole::Tool => {
            let Some(tool) = &block.tool else { return format!("#{position} [tool]") };
            let line = match &tool.detail {
                Some(detail) => crate::working_set::detail_line(detail),
                None => tool.title.clone(),
            };
            let mut body = format!("{line}{}", crate::working_set::outcome(&tool.status));
            if tools {
                if let Some(output) = tool.detail.as_ref().and_then(tool_output) {
                    body.push('\n');
                    body.push_str(output.trim_end());
                }
            }
            ("tool".into(), body)
        }
        BlockRole::Approval => match &block.approval {
            Some(approval) => (
                "asks".into(),
                format!(
                    "approve {} (request_id {}){}",
                    approval.name,
                    approval.request_id,
                    match &approval.decided {
                        Some(decided) => format!(" → {decided:?}").to_lowercase(),
                        None => " → waiting".into(),
                    }
                ),
            ),
            None => ("asks".into(), String::new()),
        },
        BlockRole::Question => match &block.question {
            Some(question) => (
                "asks".into(),
                format!(
                    "{} (request_id {}){}",
                    question.questions.iter().map(|q| q.question.clone()).collect::<Vec<_>>().join(" / "),
                    question.request_id,
                    match &question.answers {
                        Some(answers) => format!(" → {}", answers.values().cloned().collect::<Vec<_>>().join(", ")),
                        None => " → waiting".into(),
                    }
                ),
            ),
            None => ("asks".into(), String::new()),
        },
    };
    format!("#{position} [{who}] {body}")
}

fn tool_output(detail: &crew_protocol::ToolDetail) -> Option<&str> {
    use crew_protocol::ToolDetail;
    match detail {
        ToolDetail::Command { output, .. } | ToolDetail::Search { output, .. } | ToolDetail::Fetch { output, .. } => {
            output.as_deref()
        }
        ToolDetail::Output { text } => Some(text.as_str()),
        _ => None,
    }
}

/// "codex: fix the login test", from the first words of the job.
fn default_name(provider: &str, prompt: &str) -> String {
    let words: Vec<&str> = prompt.split_whitespace().take(6).collect();
    let mut name = format!("{provider}: {}", words.join(" "));
    if name.chars().count() > 48 {
        name = name.chars().take(47).collect::<String>() + "…";
    }
    name
}

/// A name as a branch's last segment.
fn branch_slug(name: &str) -> String {
    let slug: String = name.to_lowercase().chars().map(|c| if c.is_ascii_alphanumeric() { c } else { '-' }).collect();
    let slug = slug.split('-').filter(|part| !part.is_empty()).take(5).collect::<Vec<_>>().join("-");
    if slug.is_empty() {
        "session".into()
    } else {
        slug.chars().take(40).collect()
    }
}

fn session_arg() -> Value {
    json!({ "type": "string", "description": "The session's id, from delegate, start_session or list_peers." })
}

fn request_id_property() -> Value {
    json!({ "type": "string", "description": "Makes the call safe to retry: a second call with the same request_id from you returns what the first one made, and starts nothing. Pick one per job (a short unique string) and send it again if the call timed out." })
}

/// The arguments `delegate` and `start_session` share; `delegate` also waits.
fn start_schema(wait: bool) -> Value {
    let mut properties = json!({
        "prompt": { "type": "string", "description": "The job, with everything it needs: the goal, the files, the constraints, what done looks like, and whether it may commit." },
        "provider": { "type": "string", "enum": provider_names(), "description": "Which CLI runs it. Defaults to yours." },
        "model": { "type": "string", "description": format!("Defaults to yours when the provider is yours, else the provider's first. What there is:\n{}", crate::tools::model_sheet()) },
        "worktree": { "type": "string", "description": "current (the default), new, or a branch name or worktree path." },
        "name": { "type": "string", "description": "What it is listed as. Defaults to the provider and the first words of the prompt." },
        "autonomy": { "type": "string", "enum": ["ask", "edits", "auto", "full"], "description": "Defaults to yours. Never more than yours." }
    });
    properties["request_id"] = request_id_property();
    if wait {
        properties["wait"] = json!({ "type": "boolean", "description": "Block until its turn ends and return its report." });
        properties["timeout_s"] = json!({ "type": "integer", "minimum": 1, "maximum": WAIT_MAX_S, "description": "With wait: seconds to wait, 600 by default, 3600 at most." });
    }
    properties["effort"] = crate::tools::effort_property();
    json!({ "type": "object", "properties": properties, "required": ["prompt", "effort"] })
}

/// The session tools. They need no host to be described, so the CLI builds
/// its commands from the same list the daemon runs.
pub fn catalog() -> Vec<Tool> {
    vec![
        Tool {
            name: "list_peers",
            description: "Who is in this workspace and who you can write to: its bots and sessions, each with its id, type (bot; subagent, started with delegate by the session in parent; session, a session of the user's, which launched_by names if another session started it), kind (bot; session, a subagent or a session of the user's), status (idle, working, background: its turn is over with work still running in the background, question: waiting on a question you can answer, approval: waiting on an approval you can decide, waiting_for_user: waiting on the user's approval, error, exited), where it works (main checkout or its branch), and write: whether send_message and interrupt_session reach it from you (a session cannot write to one that runs with more autonomy than it has).",
            schema: json!({ "type": "object", "properties": {} }),
            audience: Audience::EVERYONE,
            cli: vec![crate::tools::top("peers").about("The bots and sessions here: status, who started them, and whether you can write to them.").eg("crew peers\n  crew peers --json | jq '.[] | select(.kind == \"bot\") | .id'")],
        },
        Tool {
            name: "send_message",
            description: concat!(
                "Write to a bot or a session in this workspace: any but yourself and a subagent that has exited (start another with delegate), and none that runs with more autonomy than you have (list_peers says write for each; the user can write to any). A letter to an independent session that has exited resumes it (the result says resumed); a subagent may always write to the session that started it. ",
                "It arrives as a turn, in an envelope naming you: your name and id, and that a model wrote it. Idle, the reader starts on it now; busy, it waits until the current turn ends. ",
                "steer: true puts it into the running turn instead, to correct its course, where the CLI can take that (Claude and Codex); anywhere else it is queued. ",
                "To a subagent that is waiting on a question, it answers the question, from anyone who may write to it: text answers a single question (free text is fine), answers gives one answer per question, in order. ",
                "To a subagent you started that is waiting on an approval, decision allow or deny decides it, if you could do the same yourself (text, if any, follows as a message). ",
                "The result says how it went: delivery started, queued, steered or answered. A reply, if any, reaches you as a message of its own, if your CLI has turns to put it in."
            ),
            schema: json!({
                "type": "object",
                "properties": {
                    "to": { "type": "string", "description": "The id of a bot or a session, from list_peers or from the line a message arrived on. Not a name: names are the user's to change." },
                    "text": { "type": "string", "description": "What to say. Give it everything it needs; it cannot see your conversation." },
                    "steer": { "type": "boolean", "description": "Into its running turn, read at its next step (Claude and Codex). Only to correct course; otherwise it is queued." },
                    "answers": { "type": "array", "items": { "type": "string" }, "description": "To a subagent waiting on several questions: one answer per question, in the order asked." },
                    "decision": { "type": "string", "enum": ["allow", "deny"], "description": "To a subagent you started that waits on an approval (a command, an edit, a process it defined): allow or deny it. Only what you could do yourself without asking." }
                },
                "required": ["to"]
            }),
            audience: Audience::EVERYONE,
            cli: vec![crate::tools::top("send").eg("crew send Reviewer \"look at the diff on main\"\n  crew send 3f2a… run the tests and fix what fails\n  git diff | crew send Reviewer -\n  crew send --steer 3f2a… stop, the API changed")],
        },
        Tool {
            name: "delegate",
            description: concat!(
                "Hand one job to a subagent: a provider CLI (claude, codex, opencode, cursor or grok) working on prompt, in this workspace, for you, as a harness's own subagent would. It is nested under you and disposable. It sees nothing of your conversation: put everything it needs in the prompt. ",
                "Each time it ends a turn you started, its final message, its report, comes back to you; a bot or a session is woken by it as a turn of its own (reports that come close together are one turn), so end your turn rather than wait or poll. A turn the user starts in its tab reports only to the user. read_session reads what it did, send_message gives it more or answers its question, stop_session ends it. ",
                "wait: true blocks here until its turn ends and returns the report, or returns early with its questions if it asks one; timeout_s is 600 by default and 3600 at most, and on timeout it keeps working (status running). For work that takes more than a few minutes, do not wait. ",
                "worktree: current (yours, the default), new (a fresh branch and worktree of its own), or a branch name or worktree path. It runs with your autonomy or less, never more. At most 4 live subagents of your own at once; one idle for 30 minutes exits, and a subagent that has exited stays exited: start another. ",
                "request_id makes the call safe to retry: the same id from you returns the subagent the first call made. Use start_session instead when the user wants a separate session they can see and talk to. A bot outlives its sessions: to hand work to a bot, use send_message."
            ),
            schema: start_schema(true),
            audience: Audience::PARENTS,
            cli: vec![cli("sessions", "delegate").rest(&["prompt"]).eg("crew sessions delegate --provider codex --effort medium fix the failing login test\n  crew sessions delegate --effort low --wait --timeout-s 300 -- what does the billing webhook do?")],
        },
        Tool {
            name: "start_session",
            description: concat!(
                "Start a separate session: a provider CLI (claude, codex, opencode, cursor or grok) working on prompt, in this workspace, that shows in the sidebar like one the user opened. It is the user's: it works for the user, reports to nobody, is not capped and is not ended when idle. It opens as a chat. ",
                "Use it when the user wants a session they can see and talk to. Do not use it just because the user said \"subagent\": that is delegate. ",
                "It sees nothing of your conversation: put everything it needs in the prompt. Its first prompt arrives in a message naming you, so it can answer with send_message to your id (unless your CLI takes no letters); to coordinate, say so in the prompt (\"product decisions: ask me with send_message to <your id>, not the user\"). Crew does nothing more for you than record that you launched it. read_session and stop_session are for subagents. ",
                "worktree: current (yours, the default), new (a fresh branch and worktree of its own), or a branch name or worktree path. It runs with your autonomy or less, never more. request_id makes the call safe to retry: the same id from you returns the session the first call made. For several at once, start_sessions."
            ),
            schema: start_schema(false),
            audience: Audience::PARENTS,
            cli: vec![cli("sessions", "start").rest(&["prompt"]).eg("crew sessions start --effort high --worktree new -- carry on with the plan in docs/plan.md\n  crew sessions start --provider codex --effort medium --name Reviewer review the diff on main")],
        },
        Tool {
            name: "start_sessions",
            description: concat!(
                "Start several separate sessions in one call: sessions is a list of 1 to 20 entries, each what start_session takes (prompt, effort, provider, model, worktree, name, autonomy), each with its own prompt. Each is the user's, like one start_session makes: it shows in the sidebar, reports to nobody and is not capped. ",
                "Each entry succeeds or fails on its own, and the result lists both: sessions has one result per entry, in order, with ok, and on a failure the error. A worktree made for an entry that then failed is kept and named in its result. More than 20 entries is refused whole, before anything starts. ",
                "request_id makes the whole call safe to retry. Use it for independent jobs that each need a session of their own; for one, use start_session."
            ),
            schema: json!({
                "type": "object",
                "properties": {
                    "sessions": {
                        "type": "array",
                        "minItems": 1,
                        "maxItems": BATCH_MAX,
                        "items": {
                            "type": "object",
                            "properties": {
                                "prompt": { "type": "string", "description": "As in start_session." },
                                "provider": { "type": "string", "enum": provider_names() },
                                "model": { "type": "string", "description": "As in start_session." },
                                "worktree": { "type": "string" },
                                "name": { "type": "string" },
                                "autonomy": { "type": "string", "enum": ["ask", "edits", "auto", "full"] },
                                "effort": crate::tools::effort_property()
                            },
                            "required": ["prompt", "effort"]
                        },
                        "description": "One entry per session to start."
                    },
                    "request_id": request_id_property()
                },
                "required": ["sessions"]
            }),
            audience: Audience::PARENTS,
            cli: vec![cli("sessions", "start-many").eg("crew sessions start-many --sessions '{\"prompt\": \"fix the login test\", \"effort\": \"medium\", \"worktree\": \"new\"}' --sessions '{\"prompt\": \"update the docs\", \"effort\": \"low\", \"provider\": \"codex\"}'")],
        },
        Tool {
            name: "read_session",
            description: "Read a conversation in this workspace as numbered lines (#12 is block 12): what was said, and each tool that ran as one line (include_tools adds their output). Without session: your own conversation; with an id, any session or bot here. What it reads: query searches it (words, not meaning) and answers hits, each with at, when, role and the words around the match (a short message whole), the best hit with its neighbours; around reads the blocks either side of a block number, to scroll from a hit or a line; since reads on from a cursor; days alone reads that many days back, oldest first; nothing reads the tail. Up to max_bytes (16 KB by default, 256 KB at most). cursor is where a read stopped: pass it back as since to read only what is new; more says there is more. Only the session a subagent reports to advances what it has seen, with since or the tail and no roles, so another session reading it never swallows a report. status says whether it is waiting on a question (answer it with send_message), on an approval you can decide (send_message with decision), or on the user.",
            schema: json!({
                "type": "object",
                "properties": {
                    "session": { "type": "string", "description": "The session's or bot's id, from delegate, start_session or list_peers. Omit for your own conversation." },
                    "query": { "type": "string", "description": "Words to look for: a name, an id, a number, what the user called it. Each word matches whole, but the last also matches as a prefix: end on a stem (permis) to find its forms." },
                    "around": { "type": "integer", "minimum": 1, "description": "A block number (a hit's at, or #N of a line): read the blocks either side of it." },
                    "window": { "type": "integer", "minimum": 1, "maximum": AROUND_MAX, "description": "With around: blocks either side. 5 by default." },
                    "since": { "type": "integer", "minimum": 0, "description": "A cursor from delegate or an earlier read." },
                    "days": { "type": "integer", "minimum": 1, "description": "With query: only the last N days. Alone: read from N days ago on." },
                    "roles": { "type": "array", "items": { "type": "string", "enum": ROLES }, "description": "Only these lines. A search looks in user and assistant by default; the rest read every role." },
                    "limit": { "type": "integer", "minimum": 1, "maximum": HITS_MAX, "description": "With query: most hits, 8 by default." },
                    "max_bytes": { "type": "integer", "minimum": 1, "maximum": READ_MAX },
                    "include_tools": { "type": "boolean", "description": "Add each tool's output under its line; a search also looks in tool rows." }
                }
            }),
            audience: Audience::PARENTS,
            cli: vec![
                cli("sessions", "read").pos(&["session"]).eg("crew sessions read 3f2a…\n  crew sessions read 3f2a… --since 12 --include-tools\n  crew sessions read 3f2a… --around 412"),
                cli("messages", "search").rest(&["query"]).eg("crew messages search deploy key --days 7\n  crew messages search --session 3f2a… staging password"),
            ],
        },
        Tool {
            name: "stop_session",
            description: "End a subagent you started: its CLI is killed mid-turn if it is working, and it exits for good. Its own subagents end first, deepest first; sessions it launched for the user are not touched. Its transcript stays in Crew, and read_session still reads it.",
            schema: json!({ "type": "object", "properties": { "session": session_arg() }, "required": ["session"] }),
            audience: Audience::PARENTS,
            cli: vec![cli("sessions", "stop").pos(&["session"]).eg("crew sessions stop 3f2a…")],
        },
        Tool {
            name: "interrupt_session",
            description: concat!(
                "Stop what a session is doing right now without ending it, as Esc does in its chat: the current turn stops and the session stays, ready for its next message. It works through the provider's own protocol, so what the CLI was in the middle of is cancelled cleanly. ",
                "text, if given, is delivered as its next message right after, so one call stops and redirects (without it, send_message gives it the next thing). ",
                "Allowed for whoever send_message reaches: any bot or session in this workspace but yourself, an exited subagent, and none that runs with more autonomy than you have. A session that is not working has nothing to interrupt; text is still delivered. stop_session is the one that ends a subagent."
            ),
            schema: json!({
                "type": "object",
                "properties": {
                    "session": json!({ "type": "string", "description": "The id of the session or bot to interrupt, from list_peers." }),
                    "text": json!({ "type": "string", "description": "What it does next, delivered as its next message. Give it everything it needs; it cannot see your conversation." })
                },
                "required": ["session"]
            }),
            audience: Audience::EVERYONE,
            cli: vec![cli("sessions", "interrupt").pos(&["session"]).eg("crew sessions interrupt 3f2a…\n  crew sessions interrupt 3f2a… --text \"stop, use the new endpoint instead\"")],
        },
        Tool {
            name: "update_session",
            description: concat!(
                "Rename, change the effort of, or delete a session (a bot is the user's to rename or remove). action: rename (name is the new name; allowed for whoever started the session and whoever send_message reaches); ",
                "effort (effort is the new level, from its next turn; same reach as rename; there is no action for the model, which stays what it started with). Changing effort can invalidate the prompt cache; it does not on Anthropic models from the 5 family on. ",
                "delete (removes the session, its subagents and their transcripts, and never a worktree; refused while a worktree they work in has uncommitted changes). ",
                "Delete is only for sessions you started (your subagents, or a session you launched with start_session); the user may delete any."
            ),
            schema: json!({
                "type": "object",
                "properties": {
                    "session": session_arg(),
                    "action": { "type": "string", "enum": ["rename", "effort", "delete"] },
                    "name": { "type": "string", "description": "With rename: the new name." },
                    "effort": { "type": "string", "description": "With effort: low, medium, high, xhigh or max for claude; minimal to max for codex; low to xhigh for grok. cursor and opencode carry it in the model id and refuse." }
                },
                "required": ["session", "action"]
            }),
            audience: Audience::PARENTS,
            cli: vec![
                cli("sessions", "rename").sets("action", "rename").rest(&["session", "name"]).eg("crew sessions rename 3f2a… Auth refactor"),
                cli("sessions", "effort").sets("action", "effort").pos(&["session", "effort"]).eg("crew sessions effort 3f2a… medium"),
                cli("sessions", "delete").sets("action", "delete").pos(&["session"]).eg("crew sessions delete 3f2a…"),
            ],
        },
    ]
}

impl ToolFamily for SessionTools {
    fn catalog(&self) -> Vec<Tool> {
        catalog()
    }

    fn instructions(&self, caller: &Caller) -> Option<String> {
        if matches!(caller, Caller::Child(_)) {
            return None;
        }
        // A bot and a terminal are told the words and the tools in their own
        // text (`prompts`); the user, calling from outside, gets the glossary
        // from `tools::instructions` and how the tools fit from here. What is
        // left for a session is its live subagents.
        let mut note = if !matches!(caller, Caller::User { .. }) {
            String::new()
        } else {
            "delegate hands a job to a subagent (another provider CLI, in this checkout or a worktree of \
             its own): its report wakes a bot when its turn ends, or wait: true waits for it; read_session reads \
             what it did, send_message gives it more, stop_session ends it. start_session starts a separate session \
             the user can see and talk to, which reports to nobody (start_sessions, up to 20 at once); do not use it \
             just because the user said \"subagent\". send_message writes to any bot or session that does not have more autonomy than you do. \
             list_peers lists who you can write to."
                .to_string()
        };
        if let (Some(me), Ok(workspace)) = (caller.session(), caller.workspace_id()) {
            if let Ok(live) = self.live_children(workspace, &me.id) {
                if !live.is_empty() {
                    note.push_str(&format!(
                        "{}Subagents you started: {}.",
                        if note.is_empty() { "" } else { " " },
                        live.iter()
                            .map(|row| format!("{} {} ({}, {})", row.name, row.id, row.provider, self.peer_status(caller, row)))
                            .collect::<Vec<_>>()
                            .join("; ")
                    ));
                }
            }
        }
        (!note.is_empty()).then_some(note)
    }

    fn run(&self, caller: &Caller, name: &str, args: &Value) -> Result<ToolOutput, String> {
        let out = match name {
            "list_peers" => self.peers(caller)?,
            "send_message" => self.send(caller, args)?,
            "delegate" => self.start(caller, args, Start::Delegate)?,
            "start_session" => self.start(caller, args, Start::Launch)?,
            "start_sessions" => self.start_many(caller, args)?,
            "read_session" => self.read(caller, args)?,
            "stop_session" => self.stop(caller, args)?,
            "interrupt_session" => self.interrupt(caller, args)?,
            "update_session" => self.update(caller, args)?,
            _ => return Err(format!("Unknown tool \"{name}\"")),
        };
        Ok(out.into())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::caller::CallerKind;
    use std::path::{Path, PathBuf};

    /// opencode's server (`turns::fake_opencode_server`), and the log of each
    /// turn's message beside it: a turn answers with the last line of what it
    /// was handed, `SLEEP n` makes it take that long, `CRASH` kills the server
    /// mid-turn.
    fn fake_opencode(dir: &Path) -> (String, PathBuf) {
        let (path, _) = crate::turns::fake_opencode_server(dir);
        (path, dir.join("launches.jsonl"))
    }

    /// A Claude Code on stream-json: it answers the initialize request, echoes
    /// each user message as it takes it in (`--replay-user-messages`), and
    /// folds whatever arrived during a turn's `SLEEP n` into that turn. Like
    /// the real CLI it says `system/init` at the start of every turn, and it
    /// serves as many turns as it is sent on one stdin. Each launch is logged
    /// to `claude-launch.log` with its argv, pid and token; each control
    /// request to `claude-control.log`, and a file `refuse-<subtype>` in its
    /// directory makes the next such request answer with an error. Its
    /// `initialize` answers two commands, `system/init` names one skill, and a
    /// message with COMMANDS in it makes it send a changed list. `reload_plugins`
    /// and `reload_skills` answer the list with `fresh` among them. A message
    /// of `/context` or `/cost` is a command the CLI runs itself: the first
    /// prints through `system/local_command_output`, the second as a synthetic
    /// assistant message (what 2.1.295 does), and a result follows with no model
    /// turn. Every block
    /// of every user message it is handed is logged, one line per message, to
    /// `claude-input.log`, though it answers the last one alone.
    ///
    /// `BACKGROUND n` starts a shell in the background (`bg1`, then `bg2`…)
    /// and answers at once; n seconds later the shell completes and the CLI
    /// starts a turn by itself on its notification, as 2.1.295 does. A task
    /// stopped with `stop_task` wakes nobody. With `SLEEP` in the same message
    /// the turn goes on after starting it. `AGENT n` does the same with a
    /// subagent (`ag1`…): it reports its tokens and its step, speaks, and
    /// completes after n seconds saying what it used; `AGENTFG n` is one the
    /// turn waits on, which the turn's answer follows. `interrupt` ends a
    /// running turn with an error result (a file `late-interrupt` holding
    /// seconds makes that result come so late); it spares the background work
    /// only if `initialize` declared `perTaskStopAffordance`, and
    /// `cancel_queued` drops what waits unread.
    fn fake_claude(dir: &Path) -> String {
        let path = crate::fakes::install(
            dir,
            "fake-claude",
            r#"#!/usr/bin/env python3
import collections, json, os, signal, sys, threading, time, re, uuid
# A moment to read what was written just before the end, as a CLI would.
signal.signal(signal.SIGTERM, lambda *_: (time.sleep(0.2), os._exit(0)))
args = sys.argv[1:]
HERE = os.path.dirname(os.path.abspath(sys.argv[0]))
CONTROL = os.path.join(HERE, "claude-control.log")
LAUNCH = os.path.join(HERE, "claude-launch.log")
INPUT = os.path.join(HERE, "claude-input.log")
MCP = os.path.join(HERE, "claude-mcp.log")
with open(LAUNCH, "a") as f: f.write(json.dumps({"argv": args, "pid": os.getpid(), "cwd": os.getcwd(), "env": {"CREW_TOKEN": os.environ.get("CREW_TOKEN", "")}}) + "\n")
sid = args[args.index("--resume") + 1] if "--resume" in args else args[args.index("--session-id") + 1]
replay = "--replay-user-messages" in args
spare = [False]
# What waits for the main loop: ("user", text) from stdin, ("wake", text) from
# background work that completed.
cond = threading.Condition()
items = collections.deque()
running = [False]
interrupted = threading.Event()
tasks = {}
def out(obj):
    print(json.dumps(obj), flush=True)
def text_of(rec):
    return rec["message"]["content"][-1]["text"]
def put(item):
    with cond:
        items.append(item)
        cond.notify()
def take():
    with cond:
        while not items:
            cond.wait()
        return items.popleft()
def take_user():
    with cond:
        for at, item in enumerate(items):
            if item[0] == "user":
                del items[at]
                return item[1]
    return None
def reader():
    for line in sys.stdin:
        try:
            rec = json.loads(line)
        except Exception:
            continue
        if rec.get("type") == "control_request":
            req = rec.get("request") or {}
            if req.get("subtype") == "mcp_status":
                # Asked on its own schedule too, and logged apart. `sentry` waits
                # for a login until a file `mcp-signed-in` is there; `late` is
                # still connecting for its first two asks.
                with open(MCP, "a") as f: f.write("mcp_status\n")
                signed = os.path.exists(os.path.join(HERE, "mcp-signed-in"))
                late = "connected" if len(open(MCP).read().splitlines()) >= 3 else "pending"
                servers = [
                    {"name": "docs", "status": "connected", "scope": "user", "config": {"type": "http", "url": "https://docs.example/mcp", "headers": {"KEY": "secret-key"}}, "tools": [{"name": "query"}]},
                    {"name": "sentry", "status": "connected" if signed else "needs-auth", "scope": "project", "config": {"type": "http", "url": "https://mcp.sentry.example/mcp"}},
                    {"name": "broken", "status": "failed", "error": "ENOENT: no such file or directory, posix_spawn '/nonexistent/bin'", "scope": "project", "config": {"command": "/nonexistent/bin"}},
                    {"name": "late", "status": late, "scope": "user", "config": {}},
                ]
                out({"type": "control_response", "response": {"subtype": "success", "request_id": rec["request_id"], "response": {"mcpServers": servers}}})
                continue
            if req.get("subtype") == "generate_session_title":
                # Asked beside the turn, so it keeps a log of its own.
                with open(os.path.join(HERE, "claude-titles.log"), "a") as f: f.write("%s %s\n" % (req.get("persist"), req.get("description")))
                out({"type": "control_response", "response": {"subtype": "success", "request_id": rec["request_id"], "response": {"title": "Named"}}})
                continue
            if req.get("subtype") == "get_context_usage":
                # Asked on its own schedule, so it stays out of the control log.
                out({"type": "control_response", "response": {"subtype": "success", "request_id": rec["request_id"], "response": {"totalTokens": 1234, "maxTokens": 200000, "rawMaxTokens": 200000, "autoCompactThreshold": 160000, "isAutoCompactEnabled": True, "model": "fake"}}})
                continue
            # A setting says what it sets, where a task control says its task.
            detail = req.get("task_id", "")
            if req.get("subtype") == "set_model": detail = req.get("model", "")
            if req.get("subtype") == "set_permission_mode": detail = req.get("mode", "")
            if req.get("subtype") == "apply_flag_settings": detail = json.dumps(req.get("settings"), sort_keys=True)
            if req.get("subtype") == "initialize": detail = " ".join(flag for flag in ("perTaskStopAffordance", "forwardSubagentText") if req.get(flag))
            if req.get("subtype") == "interrupt": detail = "cancel_queued" if req.get("cancel_queued") else ""
            if req.get("subtype") == "mcp_reconnect": detail = req.get("serverName", "")
            with open(CONTROL, "a") as f: f.write("%s %s\n" % (req.get("subtype"), detail))
            # A file `delay-<subtype>` holding seconds makes the next one of it
            # answer that late, as the CLI does a set_model it checks with the server.
            late = os.path.join(HERE, "delay-" + str(req.get("subtype")))
            if os.path.exists(late):
                seconds = float(open(late).read() or "0")
                os.remove(late)
                threading.Timer(seconds, out, [{"type": "control_response", "response": {"subtype": "success", "request_id": rec["request_id"], "response": {}}}]).start()
                continue
            # A file named for the subtype makes the next one of it refuse; if it
            # holds a number, that many of them.
            refuse = os.path.join(HERE, "refuse-" + str(req.get("subtype")))
            if os.path.exists(refuse):
                left = int(open(refuse).read().strip() or "1") - 1
                if left > 0:
                    open(refuse, "w").write(str(left))
                else:
                    os.remove(refuse)
                out({"type": "control_response", "response": {"subtype": "error", "request_id": rec["request_id"], "error": "no"}})
                continue
            answer = {"output": "tick\n", "total_bytes": 5, "truncated": False} if req.get("subtype") == "get_task_output" else {}
            if req.get("subtype") == "mcp_reconnect" and req.get("serverName") == "sentry" and not os.path.exists(os.path.join(HERE, "mcp-signed-in")):
                out({"type": "control_response", "response": {"subtype": "error", "request_id": rec["request_id"], "error": "Server status: needs-auth"}})
                continue
            if req.get("subtype") == "initialize":
                spare[0] = bool(req.get("perTaskStopAffordance"))
                answer = {"commands": [{"name": "prototype", "description": "Build a prototype", "argumentHint": ""}, {"name": "compact", "description": "Free up context", "argumentHint": "<hint>", "builtin": True}]}
            if req.get("subtype") == "reload_plugins":
                # A plugin brought a command: the whole list again, with it.
                answer = {"commands": [{"name": "prototype", "description": "Build a prototype", "argumentHint": ""}, {"name": "compact", "description": "Free up context", "argumentHint": "<hint>"}, {"name": "fresh", "description": "Added by a plugin", "argumentHint": ""}], "agents": [], "plugins": [], "mcpServers": []}
            if req.get("subtype") == "reload_skills":
                answer = {"skills": [{"name": "prototype"}, {"name": "fresh"}]}
            if req.get("subtype") == "interrupt":
                answer = {"still_queued": []}
                if req.get("cancel_queued"):
                    with cond:
                        items.clear()
                # Without the declaration the interrupt takes the background work too.
                if not spare[0]:
                    for task in tasks.values():
                        task["killed"] = True
                        task["stop"].set()
                if running[0]:
                    interrupted.set()
            out({"type": "control_response", "response": {"subtype": "success", "request_id": rec["request_id"], "response": answer}})
            if req.get("subtype") == "stop_task" and req.get("task_id") in tasks:
                tasks[req["task_id"]]["stop"].set()
        elif rec.get("type") == "user":
            # Every block of every message, as the CLI is handed them: it
            # expands a slash only in the last one, so the order matters.
            blocks = [{"type": b.get("type"), "text": b.get("text")} if b.get("type") == "text" else {"type": b.get("type")} for b in rec["message"]["content"]]
            with open(INPUT, "a") as f: f.write(json.dumps(blocks) + "\n")
            put(("user", text_of(rec)))
    # Its input closed, as when Crew (or the test) that ran it is gone: the
    # CLI ends, where the main loop would wait on for good, an orphan.
    os._exit(0)
threading.Thread(target=reader, daemon=True).start()
def background(seconds, text):
    # As written, for the command; as a number, for the wait.
    n = len(tasks) + 1
    tid, call = "bg%d" % n, "toolu_bg" if n == 1 else "toolu_bg%d" % n
    task = tasks[tid] = {"stop": threading.Event(), "killed": False}
    out({"type": "assistant", "message": {"id": "mb%d" % n, "role": "assistant", "content": [{"type": "tool_use", "id": call, "name": "Bash", "input": {"command": "sleep %s" % seconds, "description": "Wait in the background", "run_in_background": True}}]}, "session_id": sid})
    out({"type": "system", "subtype": "task_started", "task_id": tid, "tool_use_id": call, "description": "Wait in the background", "task_type": "local_bash", "is_backgrounded": True, "session_id": sid})
    out({"type": "system", "subtype": "background_tasks_changed", "tasks": [{"task_id": tid, "task_type": "local_bash", "description": "Wait in the background"}], "session_id": sid})
    def finish():
        task["stop"].wait(float(seconds))
        if task["stop"].is_set():
            status = "killed" if task["killed"] else "stopped"
            out({"type": "system", "subtype": "task_updated", "task_id": tid, "patch": {"status": "killed"}, "session_id": sid})
            out({"type": "system", "subtype": "task_notification", "task_id": tid, "tool_use_id": call, "status": status, "summary": "Wait in the background", "session_id": sid})
            out({"type": "system", "subtype": "background_tasks_changed", "tasks": [], "session_id": sid})
            return
        out({"type": "system", "subtype": "task_updated", "task_id": tid, "patch": {"status": "completed"}, "session_id": sid})
        out({"type": "system", "subtype": "task_notification", "task_id": tid, "tool_use_id": call, "status": "completed", "summary": "Background command completed (exit code 0)", "session_id": sid})
        out({"type": "system", "subtype": "background_tasks_changed", "tasks": [], "session_id": sid})
        put(("wake", text))
    threading.Thread(target=finish, daemon=True).start()
def agent(seconds, text, foreground):
    # A subagent as 2.1.295 reports one: the Agent call, its task, its tokens
    # so far with the step it is on, and a frame of its own with its words.
    n = len(tasks) + 1
    tid, call = "ag%d" % n, "toolu_ag%d" % n
    task = tasks[tid] = {"stop": threading.Event(), "killed": False, "done": threading.Event()}
    out({"type": "assistant", "message": {"id": "ma%d" % n, "role": "assistant", "content": [{"type": "tool_use", "id": call, "name": "Agent", "input": {"description": "Explore the repo", "subagent_type": "Explore", "prompt": "Look around", "run_in_background": not foreground}}]}, "session_id": sid})
    out({"type": "system", "subtype": "task_started", "task_id": tid, "tool_use_id": call, "description": "Explore the repo", "subagent_type": "Explore", "task_type": "local_agent", "is_backgrounded": not foreground, "prompt": "Look around", "session_id": sid})
    if not foreground:
        out({"type": "system", "subtype": "background_tasks_changed", "tasks": [{"task_id": tid, "task_type": "local_agent", "description": "Explore the repo"}], "session_id": sid})
    out({"type": "assistant", "parent_tool_use_id": call, "agent_id": tid, "message": {"id": "msa%d" % n, "role": "assistant", "model": "fake", "content": [{"type": "text", "text": "Looking at README.md"}, {"type": "tool_use", "id": "toolu_ag%d_read" % n, "name": "Read", "input": {"file_path": "README.md"}}]}, "session_id": sid})
    out({"type": "system", "subtype": "task_progress", "task_id": tid, "tool_use_id": call, "description": "Reading README.md", "subagent_type": "Explore", "usage": {"total_tokens": 7812, "tool_uses": 1, "duration_ms": 926}, "last_tool_name": "Read", "session_id": sid})
    def finish():
        task["stop"].wait(float(seconds))
        if task["stop"].is_set():
            out({"type": "system", "subtype": "task_updated", "task_id": tid, "patch": {"status": "killed"}, "session_id": sid})
            out({"type": "system", "subtype": "task_notification", "task_id": tid, "tool_use_id": call, "status": "stopped", "summary": "Explore the repo", "session_id": sid})
        else:
            out({"type": "system", "subtype": "task_updated", "task_id": tid, "patch": {"status": "completed"}, "session_id": sid})
            out({"type": "system", "subtype": "task_notification", "task_id": tid, "tool_use_id": call, "status": "completed", "summary": "Found it", "usage": {"total_tokens": 8382, "tool_uses": 1, "duration_ms": 2816}, "session_id": sid})
            if foreground:
                out({"type": "user", "parent_tool_use_id": None, "message": {"role": "user", "content": [{"type": "tool_result", "tool_use_id": call, "content": [{"type": "text", "text": "Found it"}]}]}, "tool_use_result": {"status": "completed", "agentId": tid, "agentType": "Explore", "resolvedModel": "fake", "totalTokens": 8382, "totalToolUseCount": 1}, "session_id": sid})
        if not foreground:
            out({"type": "system", "subtype": "background_tasks_changed", "tasks": [], "session_id": sid})
            if not task["stop"].is_set():
                put(("wake", text))
        task["done"].set()
    threading.Thread(target=finish, daemon=True).start()
    return task
def result(reply, failed=False):
    running[0] = False
    out({"type": "result", "subtype": "error_during_execution" if failed else "success", "is_error": failed, "result": "it broke" if failed else reply, "session_id": sid, "total_cost_usd": 0, "usage": {}, "modelUsage": {"fake": {"contextWindow": 200000}}})
def stopped():
    # The interrupted turn ends where it is, as an error result.
    if not interrupted.is_set():
        return False
    late = os.path.join(HERE, "late-interrupt")
    if os.path.exists(late):
        seconds = float(open(late).read() or "0")
        os.remove(late)
        time.sleep(seconds)
    interrupted.clear()
    running[0] = False
    out({"type": "result", "subtype": "error_during_execution", "is_error": True, "result": "[Request interrupted by user]", "session_id": sid, "total_cost_usd": 0, "usage": {}})
    return True
while True:
    kind, first = take()
    running[0] = True
    interrupted.clear()
    out({"type": "system", "subtype": "init", "session_id": sid, "model": "fake", "tools": [], "skills": ["prototype"], "mcp_servers": [{"name": "docs", "status": "connected", "source": "user"}, {"name": "sentry", "status": "needs-auth", "source": "project"}, {"name": "broken", "status": "failed", "source": "project"}, {"name": "late", "status": "connected", "source": "user"}]})
    if kind == "wake":
        # A turn of its own, on the notification of what it left running.
        reply = "report: %s + the background command finished" % first.strip().splitlines()[-1]
        out({"type": "assistant", "message": {"id": "m" + uuid.uuid4().hex[:6], "role": "assistant", "content": [{"type": "text", "text": reply}]}, "session_id": sid})
        result(reply)
        continue
    heard = [first]
    # A command the CLI runs itself costs no model turn. /context prints through
    # the SDK's own line; /cost is what 2.1.295 does, a synthetic assistant
    # message with no usage; either way the result follows.
    if heard[0].strip().startswith("/context"):
        out({"type": "system", "subtype": "local_command_output", "content": "\u001b[1mContext Usage\u001b[22m\n12k / 200k tokens", "session_id": sid})
        result("")
        continue
    if heard[0].strip().startswith("/cost"):
        out({"type": "assistant", "message": {"id": "msyn", "model": "<synthetic>", "role": "assistant", "usage": {"input_tokens": 0, "output_tokens": 0}, "content": [{"type": "text", "text": "Current session: 29% used"}]}, "session_id": sid})
        result("Current session: 29% used")
        continue
    # COMMANDS finds a skill in a folder mid-session: the whole list again.
    if "COMMANDS" in heard[0]:
        out({"type": "system", "subtype": "commands_changed", "session_id": sid, "commands": [{"name": "prototype", "description": "Build a prototype", "argumentHint": ""}, {"name": "deploy", "description": "Ship it", "argumentHint": "<env>"}]})
    if replay:
        out({"type": "user", "message": {"role": "user", "content": [{"type": "text", "text": heard[0]}]}, "session_id": sid})
    b = re.search(r"BACKGROUND (\d+(?:\.\d+)?)", heard[0])
    if b:
        background(b.group(1), heard[0])
        if "SLEEP" not in heard[0]:
            out({"type": "assistant", "message": {"id": "m0", "role": "assistant", "content": [{"type": "text", "text": "started it in the background"}]}, "session_id": sid})
            result("started")
            continue
    g = re.search(r"AGENT(FG)? (\d+(?:\.\d+)?)", heard[0])
    if g:
        waited_on = agent(g.group(2), heard[0], bool(g.group(1)))
        if g.group(1):
            # The turn waits on it, until it completes or is stopped.
            waited_on["done"].wait()
        else:
            out({"type": "assistant", "message": {"id": "m0", "role": "assistant", "content": [{"type": "text", "text": "started the agent"}]}, "session_id": sid})
            result("started")
            continue
    m = re.search(r"SLEEP (\d+(?:\.\d+)?)", heard[0])
    if m:
        interrupted.wait(float(m.group(1)))
    if stopped():
        continue
    # STUBBORN never looks up before it answers: what is sent meanwhile stays
    # queued, and the CLI starts a turn of its own on it afterwards.
    while "STUBBORN" not in heard[0]:
        more = take_user()
        if more is None:
            break
        if replay:
            out({"type": "user", "message": {"role": "user", "content": [{"type": "text", "text": more}]}, "session_id": sid})
        heard.append(more)
    reply = "report: " + " + ".join(h.strip().splitlines()[-1] for h in heard)
    # The request's usage: 100 + 1000 + 10 + 5 tokens. A subagent's frame and a
    # message said twice carry usage too, which are not new readings.
    usage = {"input_tokens": 100, "cache_read_input_tokens": 1000, "cache_creation_input_tokens": 10, "output_tokens": 5}
    mid = "m" + uuid.uuid4().hex[:6]
    if "SUBAGENT" in heard[0]:
        out({"type": "assistant", "parent_tool_use_id": "toolu_sub", "message": {"id": "msub", "role": "assistant", "usage": dict(usage, input_tokens=90000), "content": [{"type": "text", "text": "inside"}]}, "session_id": sid})
    out({"type": "assistant", "message": {"id": mid, "role": "assistant", "usage": usage, "content": [{"type": "text", "text": reply}]}, "session_id": sid})
    if "TWICE" in heard[0]:
        out({"type": "assistant", "message": {"id": mid, "role": "assistant", "usage": dict(usage, input_tokens=50000), "content": [{"type": "text", "text": reply}]}, "session_id": sid})
    result(reply, "FAIL" in heard[0])
"#,
        );
        path.to_string_lossy().into_owned()
    }

    struct Fanout(TurnHost);

    impl crate::agent::AgentEvents for Fanout {
        fn lines(&self, event: &str, session_id: &str, lines: Vec<String>) {
            self.0.on_agent_lines(event, session_id, lines);
        }
        fn exit(&self, session_id: &str, code: Option<i32>, _pid: u32) {
            self.0.on_agent_exit(session_id, code);
        }
    }

    struct World {
        turns: TurnHost,
        tools: Arc<SessionTools>,
        workspace: String,
        log: PathBuf,
        made: Arc<Mutex<Vec<String>>>,
        dir: PathBuf,
        /// The fake opencode server's script: its `.mcp` beside it lists its servers.
        fake: String,
    }

    /// The bridge's tool host for a test: the toolbox `world` registers.
    struct BridgeHost {
        turns: TurnHost,
    }

    impl crate::bridge::ToolHost for BridgeHost {
        fn resolve(&self, bearer: &crate::bridge::Bearer, workspace: Option<&str>) -> Result<Caller, String> {
            Caller::resolve(self.turns.store(), bearer, workspace)
        }

        fn handle(&self, caller: &Caller, method: &str, params: Value) -> Result<Value, String> {
            let host = crate::tools::Host {
                store: self.turns.store(),
                transcripts: self.turns.transcripts(),
                on_created: &|_| {},
                on_routines: &|| {},
                toolbox: &self.turns.toolbox(),
            };
            crate::tools::handle(&host, caller, method, params)
        }

        fn handle_opencode(&self, caller: Option<&Caller>, method: &str, params: Value) -> Result<Value, String> {
            let host = crate::tools::Host {
                store: self.turns.store(),
                transcripts: self.turns.transcripts(),
                on_created: &|_| {},
                on_routines: &|| {},
                toolbox: &self.turns.toolbox(),
            };
            crate::tools::handle_opencode(&host, caller, method, params)
        }
    }

    fn world() -> World {
        let turns = TurnHost::test_new();
        turns.test_agents().set_events(Arc::new(Fanout(turns.clone())));
        let dir = std::env::temp_dir().join(format!("crew-st-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).expect("dir");
        let (fake, log) = fake_opencode(&dir);
        turns.override_binary("opencode", fake.clone());
        let workspace = crate::workspace::create(turns.store(), "w".into(), dir.to_string_lossy().into()).expect("workspace").id;
        let made = Arc::new(Mutex::new(Vec::new()));
        let seen = made.clone();
        let trees = dir.join("trees");
        let dir_kept = dir.clone();
        let tools = Arc::new(SessionTools::with_worktrees(
            turns.clone(),
            Arc::new(move |row: &Session| seen.lock().unwrap().push(row.id.clone())),
            Arc::new(move |_: &str, branch: &str| {
                let path = trees.join(crate::worktree::slug(branch));
                std::fs::create_dir_all(&path).map_err(|e| e.to_string())?;
                Ok(Worktree {
                    path: path.to_string_lossy().into_owned(),
                    branch: Some(branch.to_string()),
                    main: false,
                    add: 0,
                    del: 0,
                    dirty: 0,
                    locked: None,
                })
            }),
        ));
        // As the daemon has it: the sheet in a session's prompt names these,
        // and the bridge answers `crew mcp` from the same toolbox. Without the
        // handler a live CLI is told the server has no tools.
        turns.toolbox().register(tools.clone());
        turns.test_bridge().set_handler(Arc::new(BridgeHost { turns: turns.clone() }));
        World { turns, tools, workspace, log, made, dir: dir_kept, fake }
    }

    impl World {
        fn session(&self, kind: &str, name: &str, autonomy: &str) -> Caller {
            let row = session::create(
                self.turns.store(),
                self.workspace.clone(),
                kind.into(),
                name.into(),
                "opencode".into(),
                "opencode/nemotron-3.5-lightning-free".into(),
                String::new(),
                autonomy.into(),
            )
            .expect("session");
            // A session of the user's that letters never wake (it has had its 20
            // automatic turns), so a test parent holds still while its subagents report.
            if kind == "terminal" {
                session::set_auto_turns(self.turns.store(), &row.id, session::PAUSE_AFTER);
            }
            Caller::from_session(row)
        }

        fn user(&self) -> Caller {
            Caller::User { workspace_id: Some(self.workspace.clone()) }
        }

        fn call(&self, caller: &Caller, name: &str, args: Value) -> Result<Value, String> {
            self.call_bare(caller, name, crate::tools::with_effort(caller, name, args))
        }

        /// As written, with no effort filled in.
        fn call_bare(&self, caller: &Caller, name: &str, args: Value) -> Result<Value, String> {
            match self.tools.run(caller, name, &args)? {
                ToolOutput::Value(value) => Ok(value),
                ToolOutput::Content(_) => Err("content".into()),
            }
        }

        fn start(&self, caller: &Caller, prompt: &str) -> String {
            let out = self.call(caller, "delegate", json!({ "provider": "opencode", "prompt": prompt })).expect("start");
            out["id"].as_str().expect("id").to_string()
        }

        fn row(&self, id: &str) -> Session {
            session::get(self.turns.store(), id.to_string()).unwrap().expect("row")
        }

        /// Until the session is between turns, the way a poller without a wait would.
        fn settle(&self, id: &str) -> Session {
            for _ in 0..400 {
                let row = self.row(id);
                if !matches!(row.status.as_str(), "starting" | "working") && !self.turns.is_running(id) {
                    return row;
                }
                std::thread::sleep(Duration::from_millis(25));
            }
            panic!("{id} never settled: {}", self.row(id).status);
        }

        fn launches(&self) -> Vec<Value> {
            std::fs::read_to_string(&self.log)
                .unwrap_or_default()
                .lines()
                .filter_map(|line| serde_json::from_str(line).ok())
                .collect()
        }

        fn wait(&self, caller: &Caller, id: &str, extra: Value) -> Value {
            let mut args = json!({ "sessions": [id], "timeout_s": 20 });
            if let (Some(args), Some(extra)) = (args.as_object_mut(), extra.as_object()) {
                args.extend(extra.clone());
            }
            self.tools.wait(caller, &args).expect("wait")
        }
    }

    #[test]
    fn a_session_runs_its_job_and_the_wait_hands_back_its_report() {
        let w = world();
        let parent = w.session("terminal", "shell", "full");
        let id = w.start(&parent, "find the bug");
        let started = w.row(&id);
        assert_eq!(started.kind, "child");
        assert_eq!(started.parent_id.as_deref(), parent.session_id());
        assert_eq!(*w.made.lock().unwrap(), vec![id.clone()], "the window was not told");

        let out = w.wait(&parent, &id, json!({}));
        assert_eq!(out["result"], "event", "{out}");
        let event = &out["sessions"][0];
        assert_eq!(event["event"], "turn");
        assert_eq!(event["outcome"], "completed");
        assert_eq!(event["report"], "report: find the bug");
        let row = w.settle(&id);
        assert_eq!(row.status, "idle");
        // The cursor is a position in the transcript, and the event's block is the last one.
        let len = w.turns.transcripts().len(&id) as i64;
        assert_eq!(event["cursor"], len);
        assert_eq!(row.cursor, len);
        assert_eq!(out["cursors"][&id], len);
    }

    #[test]
    fn the_first_turn_starts_a_conversation_and_the_next_one_carries_it_on() {
        let w = world();
        let parent = w.session("terminal", "shell", "full");
        let id = w.start(&parent, "remember 4817");
        w.wait(&parent, &id, json!({}));
        w.settle(&id);
        let sent = w.call(&parent, "send_message", json!({ "to": id, "text": "what number?" })).expect("send");
        assert_eq!(sent["delivery"], "started", "{sent}");
        let out = w.wait(&parent, &id, json!({}));
        assert_eq!(out["sessions"][0]["report"], "report: what number?");

        let launches = w.launches();
        assert_eq!(launches.len(), 2);
        assert_eq!(launches[0]["resumed"], json!(false), "the first turn carried something on: {launches:?}");
        let bound = w.row(&id).provider_session_id.expect("bound");
        assert_eq!((launches[1]["resumed"].clone(), launches[1]["session"].clone()), (json!(true), json!(bound)));
        // The persona is the session's instruction entry, set on its first
        // turn and kept by opencode; the message is the message alone.
        for launch in &launches {
            let system = launch["system"].as_str().unwrap();
            assert!(system.contains("is delivered to"), "{system}");
            assert!(
                system.contains("`crew_send_message`") && system.contains("you cannot delegate or start sessions"),
                "{system}"
            );
        }
        let prompt = launches[0]["prompt"].as_str().unwrap();
        assert!(prompt.starts_with("## Message\nFrom: shell (terminal") && !prompt.contains("Your final message"), "{prompt}");
        let next = launches[1]["prompt"].as_str().unwrap();
        assert!(next.starts_with("## Message\nFrom: shell (terminal"), "{next}");
        assert!(!next.contains("Your final message"), "{next}");
    }

    #[test]
    fn a_turn_that_started_and_ended_between_two_waits_is_still_found() {
        let w = world();
        let parent = w.session("terminal", "shell", "full");
        let id = w.start(&parent, "one");
        let first = w.wait(&parent, &id, json!({}));
        let cursor = first["cursors"][&id].as_i64().unwrap();
        w.settle(&id);
        // A turn starts and ends with nobody waiting.
        w.call(&parent, "send_message", json!({ "to": id, "text": "two" })).expect("send");
        w.settle(&id);
        assert_eq!(w.row(&id).status, "idle", "the status alone says nothing happened");

        let out = w.wait(&parent, &id, json!({ "cursors": { id.clone(): cursor } }));
        assert_eq!(out["result"], "event", "{out}");
        assert_eq!(out["sessions"][0]["report"], "report: two");
        // Without a cursor the wait starts from what the parent last saw: it just saw that.
        let again = w.wait(&parent, &id, json!({}));
        assert_eq!(again["result"], "nothing-running", "{again}");
        // An old cursor reads it again; the parent asked for that.
        let old = w.wait(&parent, &id, json!({ "since": cursor }));
        assert_eq!(old["sessions"][0]["report"], "report: two");
    }

    #[test]
    fn a_wait_with_nothing_new_times_out_with_a_cursor_to_carry_on_from() {
        let w = world();
        let parent = w.session("terminal", "shell", "full");
        let id = w.start(&parent, "SLEEP 2");
        let out = w.tools.wait(&parent, &json!({ "sessions": [id], "timeout_s": 1 })).expect("wait");
        assert_eq!(out["result"], "timed-out", "{out}");
        let cursors = out["cursors"].clone();
        let done = w.wait(&parent, &id, json!({ "cursors": cursors }));
        assert_eq!(done["result"], "event", "{done}");
        assert_eq!(done["sessions"][0]["report"], "report: SLEEP 2");
    }

    #[test]
    fn the_first_of_several_to_finish_answers_the_wait() {
        let w = world();
        let parent = w.session("terminal", "shell", "full");
        let slow = w.start(&parent, "SLEEP 2");
        let quick = w.start(&parent, "quick");
        let out = w.tools.wait(&parent, &json!({ "sessions": [slow, quick], "timeout_s": 20 })).expect("wait");
        let ended: Vec<&str> = out["sessions"].as_array().unwrap().iter().map(|s| s["id"].as_str().unwrap()).collect();
        assert_eq!(ended, vec![quick.as_str()], "{out}");
        let next = w
            .tools
            .wait(&parent, &json!({ "sessions": [slow, quick], "timeout_s": 20, "cursors": out["cursors"] }))
            .expect("wait");
        let ended: Vec<&str> = next["sessions"].as_array().unwrap().iter().map(|s| s["id"].as_str().unwrap()).collect();
        assert_eq!(ended, vec![slow.as_str()], "{next}");
    }

    #[test]
    fn a_message_to_a_busy_session_waits_for_its_turn_to_end() {
        let w = world();
        let parent = w.session("terminal", "shell", "full");
        let id = w.start(&parent, "SLEEP 2");
        std::thread::sleep(Duration::from_millis(300));
        let sent = w.call(&parent, "send_message", json!({ "to": id, "text": "then this" })).expect("send");
        assert_eq!((sent["delivery"].clone(), sent["waiting"].clone()), (json!("queued"), json!(1)), "{sent}");
        let first = w.wait(&parent, &id, json!({}));
        assert_eq!(first["sessions"][0]["report"], "report: SLEEP 2");
        let second = w.wait(&parent, &id, json!({}));
        assert_eq!(second["sessions"][0]["report"], "report: then this", "{second}");
        // opencode cannot take it mid-turn: it goes in as a message, and says so.
        let steer = w.call(&parent, "send_message", json!({ "to": id, "text": "x", "steer": true })).expect("send");
        assert_eq!(steer["delivery"], "started", "{steer}");
        assert!(steer["note"].as_str().unwrap().contains("Not steered"), "{steer}");
        assert_eq!(w.wait(&parent, &id, json!({}))["sessions"][0]["report"], "report: x");
    }

    #[test]
    fn a_claude_session_takes_a_steer_into_the_turn_it_is_in() {
        let w = world();
        w.turns.override_binary("claude", fake_claude(&w.dir));
        let parent = w.session("terminal", "shell", "full");
        let started = w.call(&parent, "delegate", json!({ "provider": "claude", "prompt": "SLEEP 2" })).expect("start");
        let id = started["id"].as_str().unwrap().to_string();
        // Its CLI is up once its conversation is bound; the turn follows at once.
        for _ in 0..400 {
            if w.row(&id).provider_session_id.is_some() {
                break;
            }
            std::thread::sleep(Duration::from_millis(25));
        }
        std::thread::sleep(Duration::from_millis(300));
        let steered = w.call(&parent, "send_message", json!({ "to": id, "text": "and this", "steer": true })).expect("steer");
        assert_eq!(steered["delivery"], "steered", "{steered}");
        let out = w.wait(&parent, &id, json!({}));
        assert_eq!(out["sessions"][0]["report"], "report: SLEEP 2 + and this", "{out}");
        // One turn took both, and the steer shows where it was read.
        let read = w.call(&parent, "read_session", json!({ "session": id })).expect("read");
        let text = read["text"].as_str().unwrap();
        let steer = text.find("] and this").expect("the steer is not in the transcript");
        assert!(steer < text.find("report: SLEEP 2 + and this").unwrap(), "{text}");
        assert_eq!(text.matches("Turn ended").count(), 1, "{text}");
        // Nothing running: a steer starts a turn, like any message.
        w.settle(&id);
        let idle = w.call(&parent, "send_message", json!({ "to": id, "text": "next", "steer": true })).expect("send");
        assert_eq!(idle["delivery"], "started", "{idle}");
        assert!(idle["note"].as_str().unwrap().contains("no turn was running"), "{idle}");
        assert_eq!(w.wait(&parent, &id, json!({}))["sessions"][0]["report"], "report: next");
    }

    impl World {
        /// A Claude child on the fake CLI, and the log of what it was launched with.
        fn claude(&self, parent: &Caller, prompt: &str) -> (String, PathBuf) {
            self.claude_as(parent, prompt, None)
        }

        /// The same, under an autonomy of its own.
        fn claude_as(&self, parent: &Caller, prompt: &str, autonomy: Option<&str>) -> (String, PathBuf) {
            self.turns.override_binary("claude", fake_claude(&self.dir));
            let mut args = json!({ "provider": "claude", "prompt": prompt });
            if let Some(autonomy) = autonomy {
                args["autonomy"] = json!(autonomy);
            }
            let started = self.call(parent, "delegate", args).expect("start");
            (started["id"].as_str().unwrap().to_string(), self.dir.join("claude-launch.log"))
        }

        /// What the fake CLI was asked to change, one request to a line; its
        /// `initialize`, at every launch, is not a change.
        fn claude_control(&self) -> Vec<String> {
            std::fs::read_to_string(self.dir.join("claude-control.log"))
                .unwrap_or_default()
                .lines()
                .filter(|line| !line.starts_with("initialize"))
                .map(str::to_string)
                .collect()
        }
    }

    /// The wait, for a turn whose end may come just before it: a child is
    /// idle a moment before the event of its turn is written, which a wait
    /// in between reads as nothing running.
    fn wait_ended(w: &World, caller: &Caller, id: &str) -> Value {
        for _ in 0..40 {
            let out = w.wait(caller, id, json!({}));
            if out["result"] != "nothing-running" {
                return out;
            }
            std::thread::sleep(Duration::from_millis(25));
        }
        w.wait(caller, id, json!({}))
    }

    /// The value a launch's argv gives a flag.
    fn after_flag(launch: &Value, flag: &str) -> Option<String> {
        let argv = launch["argv"].as_array()?;
        let at = argv.iter().position(|arg| arg == flag)?;
        argv.get(at + 1)?.as_str().map(str::to_string)
    }

    /// Until the child's turn has read its first message: its conversation is
    /// bound and the fake CLI has logged the message, which it does as it
    /// reads it. A moment more lets it take the turn up.
    fn until_claude_turn(w: &World, id: &str) {
        until("the fake CLI read the message", || {
            w.row(id).provider_session_id.is_some()
                && std::fs::read_to_string(w.dir.join("claude-input.log")).is_ok_and(|log| !log.is_empty())
        });
        std::thread::sleep(Duration::from_millis(50));
    }

    /// One Claude process for a child: its second turn is a user message on
    /// the stdin of the one the first left up, with no new launch and no
    /// `--resume`, and the process is idle between them.
    #[test]
    fn a_claude_childs_next_turn_runs_on_the_process_it_kept() {
        let w = world();
        let parent = w.session("terminal", "shell", "full");
        let (id, log) = w.claude(&parent, "remember 4817");
        let out = w.wait(&parent, &id, json!({}));
        assert_eq!(out["sessions"][0]["report"], "report: remember 4817", "{out}");
        w.settle(&id);
        assert_eq!(w.turns.test_agents().running(), vec![id.clone()]);
        assert!(w.turns.idle_since(&id).is_some());

        let more = w.call(&parent, "send_message", json!({ "to": id, "text": "what number?" })).expect("send");
        assert_eq!(more["delivery"], "started", "{more}");
        assert_eq!(w.wait(&parent, &id, json!({}))["sessions"][0]["report"], "report: what number?");
        w.settle(&id);
        let launches = launched(&log);
        assert_eq!(launches.len(), 1, "{launches:?}");
        assert!(after_flag(&launches[0], "--resume").is_none(), "{}", launches[0]);
        assert_eq!(after_flag(&launches[0], "--session-id"), w.row(&id).provider_session_id);
        assert_eq!(w.turns.test_agents().running(), vec![id.clone()]);
        // The CLI's own `system/init` of each turn started nothing: two turns,
        // each ended once, and no error.
        let read = w.call(&parent, "read_session", json!({ "session": id })).expect("read");
        let text = read["text"].as_str().unwrap();
        assert_eq!(text.matches("Turn ended").count(), 2, "{text}");
        assert!(text.find("report: remember 4817").unwrap() < text.find("report: what number?").unwrap(), "{text}");
        assert_eq!(w.row(&id).status, "idle");
    }

    /// The token the CLI's MCP server was given at launch is the one the bridge
    /// still honours on a later turn: nothing minted another for the session.
    #[test]
    fn a_kept_claude_process_keeps_the_token_it_was_launched_with() {
        let w = world();
        let parent = w.session("terminal", "shell", "full");
        let (id, log) = w.claude(&parent, "one");
        w.wait(&parent, &id, json!({}));
        w.settle(&id);
        let token = launched(&log)[0]["env"]["CREW_TOKEN"].clone();
        assert!(token.as_str().is_some_and(|token| !token.is_empty()), "{token}");
        w.call(&parent, "send_message", json!({ "to": id, "text": "two" })).expect("send");
        w.wait(&parent, &id, json!({}));
        assert_eq!(launched(&log).len(), 1);
        let bearer = w.turns.test_bridge().whose(token.as_str().unwrap());
        assert_eq!(bearer, Some(crate::bridge::Bearer::Session(id.clone())), "the live process lost its token");
    }

    /// A process that died while nobody was talking to it is not written to:
    /// the next message launches another and resumes the conversation.
    #[test]
    fn a_claude_process_killed_while_idle_is_launched_again_and_resumes() {
        let w = world();
        let parent = w.session("terminal", "shell", "full");
        let (id, log) = w.claude(&parent, "remember 4817");
        w.wait(&parent, &id, json!({}));
        w.settle(&id);
        let bound = w.row(&id).provider_session_id.expect("bound");
        w.turns.test_agents().kill(&id);

        let more = w.call(&parent, "send_message", json!({ "to": id, "text": "what number?" })).expect("send");
        assert_eq!(more["delivery"], "started", "{more}");
        assert_eq!(w.wait(&parent, &id, json!({}))["sessions"][0]["report"], "report: what number?");
        let launches = launched(&log);
        assert_eq!(launches.len(), 2, "{launches:?}");
        assert_eq!(after_flag(&launches[1], "--resume"), Some(bound));
    }

    /// `/compact` is not a `turn/start`, so it cannot carry the settings that
    /// changed: the turn after it still has to.
    #[test]
    fn a_compaction_between_a_settings_change_and_the_next_turn_does_not_swallow_the_change() {
        let w = world();
        let parent = w.session("terminal", "shell", "full");
        let (id, log) = w.codex(&parent, "one", Some("ask"));
        w.wait(&parent, &id, json!({}));
        let row = w.settle(&id);
        session::set_options(
            w.turns.store(),
            id.clone(),
            "gpt-5.6-sol".into(),
            "high".into(),
            row.service_tier.clone(),
            "full".into(),
        )
        .expect("options");

        w.turns
            .start_by_user(TurnStart {
                session_id: id.clone(),
                cwd: session::cwd(w.turns.store(), &row).unwrap(),
                text: "/compact".into(),
                files: None,
                mentions: None,
                hidden: None,
                from_bot: None,
                sent_at: None,
                nonce: None,
                letter_id: None,
                mode: None,
                command: Some("compact".into()),
                skills: None,
            })
            .expect("compact");
        w.settle(&id);
        assert_eq!(sent(&log, "thread/compact/start").len(), 1);
        assert_eq!(sent(&log, "turn/start").len(), 1, "the compaction was not a message");

        w.call(&parent, "send_message", json!({ "to": id, "text": "two" })).expect("send");
        until("the next turn started", || sent(&log, "turn/start").len() == 2);
        w.settle(&id);
        let turns = sent(&log, "turn/start");
        assert_eq!(turns[1]["model"], "gpt-5.6-sol");
        assert_eq!(turns[1]["effort"], "high");
        assert_eq!(launched(&log).len(), 1);
    }

    /// The same when the exit is heard: the entry is dropped, the tray closed,
    /// and the process no longer counts as idle.
    #[test]
    fn a_claude_process_that_exits_while_idle_is_forgotten() {
        let w = world();
        let parent = w.session("terminal", "shell", "full");
        let (id, log) = w.claude(&parent, "one");
        w.wait(&parent, &id, json!({}));
        w.settle(&id);
        assert!(w.turns.idle_since(&id).is_some());
        assert!(w.turns.background_list(&id).live, "the tray closed with the turn");

        let pid = launched(&log)[0]["pid"].as_u64().expect("pid").to_string();
        std::process::Command::new("kill").args(["-9", pid.as_str()]).status().expect("kill");
        for _ in 0..200 {
            if w.turns.idle_since(&id).is_none() {
                break;
            }
            std::thread::sleep(Duration::from_millis(25));
        }
        assert!(w.turns.idle_since(&id).is_none(), "the dead process is still thought idle");
        assert!(!w.turns.background_list(&id).live, "its tray is still open");
        // No error: nobody was talking to it.
        assert_eq!(w.row(&id).status, "idle");

        w.call(&parent, "send_message", json!({ "to": id, "text": "again" })).expect("send");
        assert_eq!(w.wait(&parent, &id, json!({}))["sessions"][0]["report"], "report: again");
        let launches = launched(&log);
        assert_eq!(launches.len(), 2);
        assert!(after_flag(&launches[1], "--resume").is_some(), "{}", launches[1]);
    }

    /// A bot starts a clean provider session every turn, so each turn gets its
    /// own process and it is gone when the turn ends.
    #[test]
    fn a_claude_bot_launches_once_for_each_turn() {
        let w = world();
        w.turns.override_binary("claude", fake_claude(&w.dir));
        let bot = session::create(
            w.turns.store(),
            w.workspace.clone(),
            "bot".into(),
            "robin".into(),
            "claude".into(),
            "sonnet".into(),
            String::new(),
            "full".into(),
        )
        .expect("bot");
        for text in ["one", "two"] {
            w.turns
                .start(TurnStart {
                    session_id: bot.id.clone(),
                    cwd: w.dir.to_string_lossy().into_owned(),
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
            w.settle(&bot.id);
            assert!(w.turns.test_agents().running().is_empty(), "the bot's process outlived its turn");
            assert!(w.turns.idle_since(&bot.id).is_none());
        }
        let launches = launched(&w.dir.join("claude-launch.log"));
        assert_eq!(launches.len(), 2, "{launches:?}");
        assert!(launches.iter().all(|launch| after_flag(launch, "--resume").is_none()), "{launches:?}");
    }

    /// A `result` that comes while no turn runs belongs to none: it ends
    /// nothing, shows nothing, and the next message still starts a turn.
    #[test]
    fn a_claude_process_that_answers_while_idle_does_not_end_the_next_turn() {
        let w = world();
        let parent = w.session("terminal", "shell", "full");
        let (id, _) = w.claude(&parent, "one");
        w.wait(&parent, &id, json!({}));
        w.settle(&id);
        let before = w.turns.transcripts().len(&id);
        let late = json!({ "type": "result", "subtype": "success", "is_error": false, "result": "late", "usage": {} });
        w.turns.on_agent_lines("agent-stdout", &id, vec![late.to_string()]);
        assert_eq!(w.turns.transcripts().len(&id), before);
        w.call(&parent, "send_message", json!({ "to": id, "text": "SLEEP 1" })).expect("send");
        assert_eq!(w.wait(&parent, &id, json!({}))["sessions"][0]["report"], "report: SLEEP 1");
    }

    /// A stop interrupts the turn and keeps the process: the CLI closes the
    /// stopped turn with a result of its own, and the next message is a turn
    /// on the same process, with nothing launched.
    #[test]
    fn a_stopped_claude_turn_keeps_the_process_and_the_next_turn_runs_on_it() {
        let w = world();
        let parent = w.session("terminal", "shell", "full");
        let (id, log) = w.claude(&parent, "SLEEP 30");
        until_claude_turn(&w, &id);
        w.turns.stop(&id).expect("stop");
        w.settle(&id);
        assert_eq!(w.turns.test_agents().running(), vec![id.clone()], "the stopped turn's process went");
        assert!(w.turns.idle_since(&id).is_some());
        assert_eq!(wait_ended(&w, &parent, &id)["sessions"][0]["outcome"], "stopped");
        assert_eq!(w.claude_control(), ["interrupt cancel_queued"]);

        let more = w.call(&parent, "send_message", json!({ "to": id, "text": "again" })).expect("send");
        assert_eq!(more["delivery"], "started", "{more}");
        assert_eq!(w.wait(&parent, &id, json!({}))["sessions"][0]["report"], "report: again");
        assert_eq!(launched(&log).len(), 1, "a process was launched for the next turn");
    }

    /// The interrupt's own result can come after the next turn has been sent
    /// for: that turn waits for it, so the late result ends the stopped turn
    /// on the CLI's side and not the next one, which runs on the same process.
    #[test]
    fn an_interrupts_late_result_does_not_end_the_next_claude_turn() {
        let w = world();
        let parent = w.session("terminal", "shell", "full");
        let (id, log) = w.claude(&parent, "SLEEP 30");
        until_claude_turn(&w, &id);
        std::fs::write(w.dir.join("late-interrupt"), "0.6").expect("late");
        w.turns.stop(&id).expect("stop");
        w.settle(&id);
        w.call(&parent, "send_message", json!({ "to": id, "text": "SLEEP 1" })).expect("send");
        let out = w.wait(&parent, &id, json!({}));
        assert_eq!(out["sessions"][0]["outcome"], "stopped", "{out}");
        let out = w.wait(&parent, &id, json!({}));
        assert_eq!(out["sessions"][0]["report"], "report: SLEEP 1", "the late result ended the next turn: {out}");
        assert_eq!(launched(&log).len(), 1);
    }

    /// A CLI that does not answer the interrupt within the grace is in a state
    /// nobody vouches for: it is let go, and the next turn launches another on
    /// the same conversation.
    #[test]
    fn a_claude_process_that_never_answers_its_interrupt_is_let_go() {
        let w = world();
        let parent = w.session("terminal", "shell", "full");
        let (id, log) = w.claude(&parent, "SLEEP 30");
        until_claude_turn(&w, &id);
        let bound = w.row(&id).provider_session_id.expect("bound");
        std::fs::write(w.dir.join("late-interrupt"), "20").expect("late");
        w.turns.stop(&id).expect("stop");
        w.settle(&id);
        until("the hung process went", || w.turns.test_agents().running().is_empty() && w.turns.idle_since(&id).is_none());

        w.call(&parent, "send_message", json!({ "to": id, "text": "again" })).expect("send");
        let mut out = w.wait(&parent, &id, json!({}));
        if out["sessions"][0]["outcome"] == "stopped" {
            out = w.wait(&parent, &id, json!({}));
        }
        assert_eq!(out["sessions"][0]["report"], "report: again", "{out}");
        let launches = launched(&log);
        assert_eq!(launches.len(), 2, "{launches:?}");
        assert_eq!(after_flag(&launches[1], "--resume"), Some(bound));
    }

    /// The grace of a stop that kills the process after a moment is the stopped
    /// turn's: the process launched for the message that follows it lives on.
    #[test]
    fn the_grace_of_a_stopped_claude_turn_does_not_kill_the_process_after_it() {
        let w = world();
        let parent = w.session("terminal", "shell", "full");
        let (id, _) = w.claude(&parent, "SLEEP 30");
        until_claude_turn(&w, &id);
        w.turns.stop(&id).expect("stop");
        w.settle(&id);
        assert_eq!(wait_ended(&w, &parent, &id)["sessions"][0]["outcome"], "stopped");
        w.call(&parent, "send_message", json!({ "to": id, "text": "SLEEP 3" })).expect("send");
        // Past the stopped turn's grace, which is over while this one still runs.
        let out = w.wait(&parent, &id, json!({}));
        assert_eq!(out["sessions"][0]["report"], "report: SLEEP 3", "{out}");
    }

    /// A failed turn does not keep its process either.
    #[test]
    fn a_failed_claude_turn_releases_the_process() {
        let w = world();
        let parent = w.session("terminal", "shell", "full");
        let (id, log) = w.claude(&parent, "FAIL");
        w.wait(&parent, &id, json!({}));
        w.settle(&id);
        assert!(w.turns.test_agents().running().is_empty());
        assert!(w.turns.idle_since(&id).is_none());
        w.call(&parent, "send_message", json!({ "to": id, "text": "again" })).expect("send");
        assert_eq!(w.wait(&parent, &id, json!({}))["sessions"][0]["report"], "report: again");
        assert_eq!(launched(&log).len(), 2);
    }

    /// A steer the turn answered without reading is queued inside the CLI,
    /// which starts a turn of its own on it: that turn is the session's next,
    /// on the same process, and the steer's echo there is where it is read,
    /// once.
    #[test]
    fn a_steer_a_claude_turn_never_read_is_read_in_the_turn_the_cli_starts_on_it() {
        let w = world();
        let parent = w.session("terminal", "shell", "full");
        let (id, log) = w.claude(&parent, "STUBBORN SLEEP 2");
        until_claude_turn(&w, &id);
        let steered = w.call(&parent, "send_message", json!({ "to": id, "text": "and this", "steer": true })).expect("steer");
        assert_eq!(steered["delivery"], "steered", "{steered}");
        // The CLI's own turn follows, a moment later: a wait may come before
        // it or after.
        w.wait(&parent, &id, json!({}));
        until("the CLI's own turn ended", || {
            w.turns.transcripts().since(&id, 0).0.iter().any(|block| block.text == "report: and this") && !w.turns.is_running(&id)
        });
        w.settle(&id);
        assert_eq!(launched(&log).len(), 1, "a process was launched for it");
        assert_eq!(mailbox::waiting_count(w.turns.store(), &id).unwrap(), 0, "the box holds it again");
        let read = w.call(&parent, "read_session", json!({ "session": id })).expect("read");
        let text = read["text"].as_str().unwrap();
        assert_eq!(text.matches("report: STUBBORN SLEEP 2").count(), 1, "{text}");
        assert_eq!(text.matches("] and this").count(), 1, "{text}");
    }

    /// What a session's menu pushed to the windows, in order.
    fn hear_commands(w: &World) -> Arc<Mutex<Vec<crew_protocol::CommandsChanged>>> {
        let heard = Arc::new(Mutex::new(Vec::new()));
        let seen = heard.clone();
        w.turns.commands().set_listener(Arc::new(move |change| seen.lock().unwrap().push(change)));
        heard
    }

    /// The menu's entries that came from the CLI, as (name, kind).
    fn provider_entries(catalog: &crew_protocol::CommandCatalog) -> Vec<(String, String)> {
        catalog
            .entries
            .iter()
            .filter(|entry| entry.kind != "crew")
            .map(|entry| (entry.name.clone(), entry.kind.clone()))
            .collect()
    }

    /// The menu of a folder comes from the CLI the session already runs: the
    /// commands its `initialize` answered, the skills among them that its
    /// turn's `init` named, and the whole list again when it changes. Each
    /// change reaches the windows, and no CLI is started to ask.
    #[test]
    fn a_claude_sessions_menu_follows_what_its_cli_says_of_the_folder() {
        let w = world();
        let heard = hear_commands(&w);
        let parent = w.session("terminal", "shell", "full");
        let (id, log) = w.claude(&parent, "hello");
        w.wait(&parent, &id, json!({}));
        w.settle(&id);

        let menu = w.turns.commands_list(&id).expect("menu");
        assert_eq!(
            provider_entries(&menu),
            [("prototype".to_string(), "skill".to_string()), ("compact".to_string(), "command".to_string())]
        );
        let actions: Vec<_> = menu.entries.iter().filter(|e| e.kind == "crew").map(|e| e.name.as_str()).collect();
        assert!(["model", "effort", "access", "restart", "reload"].iter().all(|name| actions.contains(name)), "{actions:?}");
        {
            let heard = heard.lock().unwrap();
            let last = heard.last().expect("a push");
            assert_eq!(last.session_id, id);
            assert_eq!(provider_entries(&last.catalog), provider_entries(&menu));
        }

        // A skill found as the agent works: the list is replaced, and the
        // skills the turn named still stand.
        w.call(&parent, "send_message", json!({ "to": id, "text": "COMMANDS" })).expect("send");
        w.wait(&parent, &id, json!({}));
        w.settle(&id);
        let menu = w.turns.commands_list(&id).expect("menu");
        assert_eq!(
            provider_entries(&menu),
            [("prototype".to_string(), "skill".to_string()), ("deploy".to_string(), "command".to_string())]
        );
        assert_eq!(menu.entries.iter().find(|e| e.name == "deploy").unwrap().argument_hint.as_deref(), Some("<env>"));
        let pushed = provider_entries(&heard.lock().unwrap().last().expect("a push").catalog);
        assert_eq!(pushed, provider_entries(&menu));
        assert_eq!(launched(&log).len(), 1, "a list started a CLI");
    }

    /// A bot's menu is Crew's actions alone, whatever its folder holds: its
    /// persona must not see the user's skills, and no CLI is asked.
    #[test]
    fn a_bots_menu_is_crews_actions_alone() {
        let w = world();
        let bot = w.session("bot", "helper", "ask");
        let id = bot.session_id().unwrap().to_string();
        let menu = w.turns.commands_list(&id).expect("menu");
        assert!(!menu.entries.is_empty() && menu.entries.iter().all(|entry| entry.kind == "crew"), "{menu:?}");
        assert!(!w.turns.commands().holds("claude", &w.dir.to_string_lossy()));
        assert!(w.turns.commands_list("nobody").is_err());
    }

    /// A Claude that answers `initialize` and `reload_skills`, and logs how it
    /// was started: what a probe launches.
    fn fake_menu_claude(dir: &Path) -> String {
        let path = crate::fakes::install(
            dir,
            "fake-menu-claude",
            r#"#!/usr/bin/env python3
import json, os, sys, time
with open(os.path.join(os.path.dirname(os.path.abspath(sys.argv[0])), "menu-launch.log"), "a") as f:
    f.write(json.dumps({"argv": sys.argv[1:], "cwd": os.getcwd()}) + "\n")
first = json.loads(sys.stdin.readline())
second = json.loads(sys.stdin.readline())
def answer(rec, body):
    print(json.dumps({"type": "control_response", "response": {"subtype": "success", "request_id": rec["request_id"], "response": body}}), flush=True)
answer(first, {"commands": [{"name": "prototype", "description": "Build a prototype", "argumentHint": ""}, {"name": "compact", "description": "Free up context", "argumentHint": "<hint>"}]})
answer(second, {"skills": [{"name": "prototype"}]})
time.sleep(600)
"#,
        );
        path.to_string_lossy().into_owned()
    }

    /// With no process up the CLI is started once for the folder, with no
    /// turn, and what it said is kept: the next list, from this session or
    /// another in the folder, starts nothing. The windows are told.
    #[test]
    fn a_claude_session_with_no_process_has_its_folders_menu_read_once() {
        let w = world();
        let heard = hear_commands(&w);
        w.turns.override_binary("claude", fake_menu_claude(&w.dir));
        let make = |name: &str| {
            session::create(
                w.turns.store(),
                w.workspace.clone(),
                "terminal".into(),
                name.into(),
                "claude".into(),
                String::new(),
                String::new(),
                "ask".into(),
            )
            .expect("session")
            .id
        };
        let (one, two) = (make("one"), make("two"));

        let menu = w.turns.commands_list(&one).expect("menu");
        assert_eq!(
            provider_entries(&menu),
            [("prototype".to_string(), "skill".to_string()), ("compact".to_string(), "command".to_string())]
        );
        assert_eq!(provider_entries(&w.turns.commands_list(&two).expect("menu")), provider_entries(&menu));
        let launches = launched(&w.dir.join("menu-launch.log"));
        assert_eq!(launches.len(), 1, "{launches:?}");
        let argv: Vec<_> = launches[0]["argv"].as_array().unwrap().iter().filter_map(Value::as_str).collect();
        assert!(argv.contains(&"--setting-sources=user,project,local") && argv.contains(&"--strict-mcp-config"), "{argv:?}");
        assert_eq!(std::fs::canonicalize(launches[0]["cwd"].as_str().unwrap()).unwrap(), std::fs::canonicalize(&w.dir).unwrap());
        let heard = heard.lock().unwrap();
        assert_eq!(heard.len(), 1, "{heard:?}");
        assert_eq!(heard[0].session_id, one);
        assert_eq!(provider_entries(&heard[0].catalog), provider_entries(&menu));
    }

    /// A CLI that cannot be asked leaves the menu to Crew's actions, and is
    /// asked again next time rather than remembered as empty.
    #[test]
    fn a_claude_that_cannot_be_asked_leaves_the_menu_to_crews_actions() {
        let w = world();
        w.turns.override_binary("claude", w.dir.join("absent").to_string_lossy().into_owned());
        let id = session::create(
            w.turns.store(),
            w.workspace.clone(),
            "terminal".into(),
            "x".into(),
            "claude".into(),
            String::new(),
            String::new(),
            "ask".into(),
        )
        .expect("session")
        .id;
        let menu = w.turns.commands_list(&id).expect("menu");
        assert!(menu.entries.iter().all(|entry| entry.kind == "crew"), "{menu:?}");
        assert!(!w.turns.commands().holds("claude", &w.dir.to_string_lossy()));
    }

    /// A command the CLI runs itself prints through `local_command_output`:
    /// the output is a note in the transcript with its colours dropped, and the
    /// result that follows ends the turn.
    #[test]
    fn a_command_the_cli_runs_itself_prints_as_a_note_and_ends_its_turn() {
        let w = world();
        let mine = users_claude(&w);
        w.type_with(&mine, "/context", Some("context"), &[], None, None);
        assert_eq!(w.settle(&mine.id).status, "done");
        let note =
            w.blocks(&mine.id).into_iter().find(|block| block.text == "Context Usage\n12k / 200k tokens").expect("no note");
        assert_eq!(note.role, BlockRole::System);
        w.turns.release(&mine.id);
    }

    /// What 2.1.295 really sends for a command it runs itself (read from the
    /// CLI): a synthetic assistant message with no usage and then a result
    /// with no turns. It is the reply, as any other, with nothing to add.
    #[test]
    fn a_command_the_cli_answers_as_a_synthetic_message_shows_as_the_reply() {
        let w = world();
        let mine = users_claude(&w);
        w.type_with(&mine, "/cost", Some("cost"), &[], None, None);
        assert_eq!(w.settle(&mine.id).status, "done");
        let reply = w.blocks(&mine.id).into_iter().find(|block| block.text == "Current session: 29% used").expect("no reply");
        assert_eq!(reply.role, BlockRole::Assistant);
        assert_eq!(w.blocks(&mine.id).iter().filter(|block| block.text == "Current session: 29% used").count(), 1);
        w.turns.release(&mine.id);
    }

    /// The CLI names a conversation in stream-json only when asked: a user's
    /// Claude is asked once, on its first message, to name it after that.
    #[test]
    fn a_users_claude_is_asked_once_to_name_its_conversation() {
        let w = world();
        let mine = users_claude(&w);
        w.say(&mine, "hello");
        w.say(&mine, "again");
        let titles = w.dir.join("claude-titles.log");
        until("the title was asked", || titles.exists());
        assert_eq!(std::fs::read_to_string(&titles).unwrap().lines().collect::<Vec<_>>(), ["True hello"]);
        w.turns.release(&mine.id);
    }

    /// A live Claude is asked for its plugins and then its skills, and what it
    /// says replaces the folder's menu: the windows hear it, nothing is
    /// launched, and the transcript says what was read.
    #[test]
    fn a_reload_asks_a_live_claude_for_its_plugins_then_its_skills_and_the_menu_follows() {
        let w = world();
        let heard = hear_commands(&w);
        let mine = users_claude(&w);
        w.say(&mine, "hello");
        let skill = |name: &str| (name.to_string(), "skill".to_string());
        let command = |name: &str| (name.to_string(), "command".to_string());
        assert_eq!(provider_entries(&w.turns.commands_list(&mine.id).expect("menu")), [skill("prototype"), command("compact")]);

        let menu = w.turns.commands_reload(&mine.id).expect("reload");
        assert_eq!(provider_entries(&menu), [skill("prototype"), command("compact"), skill("fresh")]);
        assert_eq!(provider_entries(&w.turns.commands_list(&mine.id).expect("menu")), provider_entries(&menu));
        assert_eq!(
            w.claude_control().iter().map(|line| line.trim_end()).collect::<Vec<_>>(),
            ["reload_plugins", "reload_skills"]
        );
        assert_eq!(provider_entries(&heard.lock().unwrap().last().expect("a push").catalog), provider_entries(&menu));
        assert!(
            says(&w, &mine.id, "Reloaded plugins and skills: 1 command, 2 skills."),
            "{:?}",
            w.blocks(&mine.id).iter().map(|block| block.text.clone()).collect::<Vec<_>>()
        );
        assert_eq!(launched(&w.dir.join("claude-launch.log")).len(), 1, "a reload started a CLI");
        w.turns.release(&mine.id);
    }

    /// What the fake Claude was asked about its servers, one line per ask.
    fn mcp_asks(w: &World) -> usize {
        std::fs::read_to_string(w.dir.join("claude-mcp.log")).map(|log| log.lines().count()).unwrap_or(0)
    }

    fn hear_mcp(w: &World) -> Arc<Mutex<Vec<crew_protocol::McpChanged>>> {
        let heard = Arc::new(Mutex::new(Vec::new()));
        let sink = heard.clone();
        w.turns.mcp_status().set_listener(Arc::new(move |change| sink.lock().unwrap().push(change)));
        heard
    }

    fn mcp_named(w: &World, id: &str, name: &str) -> Option<crew_protocol::McpServer> {
        w.turns.mcp_list(id).expect("list").servers.into_iter().find(|server| server.name == name)
    }

    /// A Claude names its servers in `system/init` and is asked how they
    /// stand once it is up: one that waits for a login says so, and how to
    /// sign in; one still connecting is asked about until it has settled. The
    /// windows hear it, without the config the CLI answers with.
    #[test]
    fn a_claude_session_lists_its_servers_and_reads_them_again_while_one_connects() {
        use crew_protocol::McpState::{Connected, Failed, NeedsAuth};
        let w = world();
        let heard = hear_mcp(&w);
        let mine = users_claude(&w);
        assert_eq!(w.turns.mcp_list(&mine.id).expect("list"), crew_protocol::McpStatus { servers: Vec::new(), reported: false });
        w.say(&mine, "hello");
        until("the servers settle", || mcp_asks(&w) == 3);
        until("the last answer is kept", || mcp_named(&w, &mine.id, "late").is_some_and(|server| server.state == Connected));
        let list = w.turns.mcp_list(&mine.id).expect("list");
        assert!(list.reported);
        let states: Vec<_> = list.servers.iter().map(|server| (server.name.as_str(), server.state)).collect();
        assert_eq!(states, [("docs", Connected), ("sentry", NeedsAuth), ("broken", Failed), ("late", Connected)]);
        assert_eq!(
            list.servers[1].sign_in,
            Some(crew_protocol::McpSignIn::Terminal {
                command: vec!["claude".into(), "mcp".into(), "login".into(), "sentry".into()]
            })
        );
        assert_eq!(list.servers[2].error.as_deref(), Some("ENOENT: no such file or directory, posix_spawn '/nonexistent/bin'"));
        let pushed = serde_json::to_string(&*heard.lock().unwrap()).expect("json");
        assert!(
            pushed.contains("needs_auth") && !pushed.contains("secret-key") && !pushed.contains("https://docs.example"),
            "{pushed}"
        );
        assert_eq!(mcp_asks(&w), 3, "asked until nothing was left connecting");
        w.turns.release(&mine.id);
    }

    /// The login is the CLI's own command in a terminal; the reconnect that
    /// follows is refused until the login is done, and then the server is up.
    #[test]
    fn a_claude_server_that_needs_a_login_signs_in_in_a_terminal_and_reconnects_after() {
        let w = world();
        let mine = users_claude(&w);
        w.say(&mine, "hello");
        until("the list", || mcp_named(&w, &mine.id, "sentry").is_some());
        assert_eq!(
            w.turns.mcp_login(&mine.id, "sentry").expect("login"),
            crew_protocol::McpSignIn::Terminal { command: vec!["claude".into(), "mcp".into(), "login".into(), "sentry".into()] }
        );
        assert!(w.turns.mcp_login(&mine.id, "nothing").is_err());

        let refused = w.turns.mcp_reconnect(&mine.id, "sentry").expect_err("refused");
        assert_eq!(refused, "Server status: needs-auth");
        assert_eq!(mcp_named(&w, &mine.id, "sentry").expect("sentry").state, crew_protocol::McpState::NeedsAuth);

        std::fs::write(w.dir.join("mcp-signed-in"), "").expect("signed in");
        let after = w.turns.mcp_reconnect(&mine.id, "sentry").expect("reconnect");
        let sentry = after.servers.iter().find(|server| server.name == "sentry").expect("sentry");
        assert_eq!((sentry.state, sentry.sign_in.clone()), (crew_protocol::McpState::Connected, None));
        let asked = w.claude_control();
        assert_eq!(asked.iter().filter(|line| line.trim_end() == "mcp_reconnect sentry").count(), 2, "{asked:?}");
        w.turns.release(&mine.id);
    }

    /// A reload connects the plugins' servers, so the servers are read again.
    #[test]
    fn a_reload_reads_a_claudes_servers_again() {
        let w = world();
        let mine = users_claude(&w);
        w.say(&mine, "hello");
        until("settled", || mcp_asks(&w) == 3);
        w.turns.commands_reload(&mine.id).expect("reload");
        until("asked again", || mcp_asks(&w) >= 4);
        w.turns.release(&mine.id);
    }

    /// Sets the servers the fake opencode server lists for its folders. Its
    /// `.mcp` file is read when the server starts, so it is set before a turn.
    fn opencode_servers(w: &World, rows: Value) {
        std::fs::write(format!("{}.mcp", w.fake), rows.to_string()).expect("servers");
    }

    /// An opencode session lists its folder's servers as its server says them:
    /// a failure keeps the server's words, a login is offered as opencode's
    /// page, and a server's own change reaches the windows.
    #[test]
    fn an_opencode_session_lists_its_servers_and_hears_them_change() {
        use crew_protocol::McpState::{Connected, Disabled, Failed, NeedsAuth};
        let w = world();
        opencode_servers(
            &w,
            json!([
                { "name": "crew", "status": "connected" },
                { "name": "broken", "status": "failed", "error": "NotFound: ChildProcess.spawn (/nope)" },
                { "name": "sentry", "status": "needs_auth", "error": "requires a login", "integrationID": "mcp_sentry", "completes": true },
                { "name": "off", "status": "disabled" }
            ]),
        );
        let heard = hear_mcp(&w);
        let mine = w.user_session("opencode", "opencode/nemotron-3.5-lightning-free", "full");
        assert_eq!(w.turns.mcp_list(&mine.id).expect("list"), crew_protocol::McpStatus { servers: Vec::new(), reported: false });
        w.type_to(&mine, "Reply with just the word one.", None, None);
        until("the servers are listed", || mcp_named(&w, &mine.id, "off").is_some());
        let list = w.turns.mcp_list(&mine.id).expect("list");
        assert!(list.reported);
        let states: Vec<_> = list.servers.iter().map(|server| (server.name.as_str(), server.state)).collect();
        assert_eq!(states, [("crew", Connected), ("broken", Failed), ("sentry", NeedsAuth), ("off", Disabled)]);
        assert_eq!(list.servers[1].error.as_deref(), Some("NotFound: ChildProcess.spawn (/nope)"));
        assert_eq!(list.servers[2].sign_in, None, "the page is minted when asked for");
        let pushed = serde_json::to_string(&*heard.lock().unwrap()).expect("json");
        assert!(pushed.contains("needs_auth") && !pushed.contains("mcp_sentry"), "{pushed}");
        w.settle(&mine.id);
    }

    /// A login is opencode's own: the page it names is the one to open, and
    /// the server connects by itself once the browser's redirect is taken,
    /// which the windows hear. A server that wants a code back is not taken
    /// here, and one without a sign-in has none to offer.
    #[test]
    fn an_opencode_server_signs_in_with_its_own_page_and_connects_after() {
        use crew_protocol::McpState::{Connected, NeedsAuth};
        let w = world();
        opencode_servers(
            &w,
            json!([
                { "name": "crew", "status": "connected" },
                { "name": "sentry", "status": "needs_auth", "error": "requires a login", "integrationID": "mcp_sentry", "completes": true },
                { "name": "codes", "status": "needs_auth", "error": "requires a login", "integrationID": "mcp_codes", "mode": "code" }
            ]),
        );
        let mine = w.user_session("opencode", "opencode/nemotron-3.5-lightning-free", "full");
        w.type_to(&mine, "Reply with just the word one.", None, None);
        until("the servers are listed", || mcp_named(&w, &mine.id, "codes").is_some());
        assert_eq!(
            w.turns.mcp_login(&mine.id, "sentry").expect("login"),
            crew_protocol::McpSignIn::Url { url: "https://auth.example/authorize?server=sentry".into() }
        );
        until("connected once the redirect is taken", || {
            mcp_named(&w, &mine.id, "sentry").is_some_and(|server| server.state == Connected)
        });
        assert!(w.turns.mcp_login(&mine.id, "crew").expect_err("login").contains("no sign-in"));
        assert!(w.turns.mcp_login(&mine.id, "nothing").is_err());
        let code = w.turns.mcp_login(&mine.id, "codes").expect_err("a code");
        assert!(code.contains("opencode mcp auth codes"), "{code}");
        assert_eq!(mcp_named(&w, &mine.id, "codes").expect("codes").state, NeedsAuth);
        w.settle(&mine.id);
    }

    /// Reconnect has opencode connect the server again, and answers the list
    /// as it stands after; a server that fails again says so, and one that is
    /// not listed is an error.
    #[test]
    fn reconnect_connects_an_opencode_server_again() {
        use crew_protocol::McpState::{Connected, Failed};
        let w = world();
        opencode_servers(
            &w,
            json!([
                { "name": "crew", "status": "connected" },
                { "name": "flaky", "status": "failed", "error": "timeout", "connects": "connected" },
                { "name": "down", "status": "failed", "error": "refused", "connects": "failed" }
            ]),
        );
        let mine = w.user_session("opencode", "opencode/nemotron-3.5-lightning-free", "full");
        w.type_to(&mine, "Reply with just the word one.", None, None);
        until("the servers are listed", || mcp_named(&w, &mine.id, "down").is_some());
        let after = w.turns.mcp_reconnect(&mine.id, "flaky").expect("reconnect");
        assert_eq!(after.servers.iter().find(|server| server.name == "flaky").map(|server| server.state), Some(Connected));
        let again = w.turns.mcp_reconnect(&mine.id, "down").expect("reconnect");
        assert_eq!(again.servers.iter().find(|server| server.name == "down").map(|server| server.state), Some(Failed));
        assert!(w.turns.mcp_reconnect(&mine.id, "nothing").is_err());
        assert_eq!(mcp_named(&w, &mine.id, "flaky").expect("flaky").state, Connected);
        w.settle(&mine.id);
    }

    /// Cursor says nothing of its servers, so none are reported, and there is
    /// nothing to sign in to or reconnect; a session that is not there is an error.
    #[test]
    fn cursor_does_not_report_its_servers() {
        let w = world();
        let id = session::create(
            w.turns.store(),
            w.workspace.clone(),
            "terminal".into(),
            "x".into(),
            "cursor".into(),
            String::new(),
            String::new(),
            "ask".into(),
        )
        .expect("session")
        .id;
        assert_eq!(w.turns.mcp_list(&id).expect("list"), crew_protocol::McpStatus { servers: Vec::new(), reported: false });
        assert!(w.turns.mcp_login(&id, "x").expect_err("login").contains("does not report"));
        assert!(w.turns.mcp_reconnect(&id, "x").expect_err("reconnect").contains("does not report"));
        assert!(w.turns.mcp_list("nobody").is_err());
    }

    /// A CLI that refuses `reload_skills` still reloads its plugins: the skills
    /// it named before stand, and what is new is a command until a read says
    /// otherwise.
    #[test]
    fn a_claude_that_refuses_to_reload_its_skills_keeps_the_skills_it_had() {
        let w = world();
        let mine = users_claude(&w);
        w.say(&mine, "hello");
        std::fs::write(w.dir.join("refuse-reload_skills"), "").expect("refuse");
        let menu = w.turns.commands_reload(&mine.id).expect("reload");
        let kinds: Vec<_> = provider_entries(&menu).into_iter().map(|(name, kind)| format!("{name} {kind}")).collect();
        assert_eq!(kinds, ["prototype skill", "compact command", "fresh command"]);
        w.turns.release(&mine.id);
    }

    /// With no process up, a reload reads the folder with a CLI of its own
    /// even though the last read is fresh: that is the point of asking.
    #[test]
    fn a_reload_with_no_claude_process_reads_the_folder_again_past_a_fresh_menu() {
        let w = world();
        w.turns.override_binary("claude", fake_menu_claude(&w.dir));
        let id = session::create(
            w.turns.store(),
            w.workspace.clone(),
            "terminal".into(),
            "one".into(),
            "claude".into(),
            String::new(),
            String::new(),
            "ask".into(),
        )
        .expect("session")
        .id;
        w.turns.commands_list(&id).expect("menu");
        w.turns.commands_list(&id).expect("menu");
        assert_eq!(launched(&w.dir.join("menu-launch.log")).len(), 1, "a fresh menu was read again");

        let menu = w.turns.commands_reload(&id).expect("reload");
        assert_eq!(launched(&w.dir.join("menu-launch.log")).len(), 2);
        assert_eq!(provider_entries(&menu).len(), 2);
        let said = w.blocks(&id).into_iter().map(|block| block.text).collect::<Vec<_>>();
        assert!(said.contains(&"Read the commands and skills again: 1 command, 1 skill.".to_string()), "{said:?}");
    }

    /// A bot reads its folder afresh with each turn, so a reload has nothing
    /// to read and starts nothing; a CLI that lists nothing says it does so
    /// when the session restarts.
    #[test]
    fn a_reload_of_a_bot_or_a_cli_with_no_listing_starts_nothing_and_says_when_it_reads() {
        let w = world();
        w.turns.override_binary("claude", w.dir.join("absent").to_string_lossy().into_owned());
        let bot = session::create(
            w.turns.store(),
            w.workspace.clone(),
            "bot".into(),
            "helper".into(),
            "claude".into(),
            String::new(),
            String::new(),
            "ask".into(),
        )
        .expect("bot")
        .id;
        let menu = w.turns.commands_reload(&bot).expect("reload");
        assert!(menu.entries.iter().all(|entry| entry.kind == "crew"), "{menu:?}");
        assert!(w.blocks(&bot).iter().any(|block| block.text == "A bot reads its commands and skills afresh with each turn."));

        for (provider, head) in [("cursor", "Cursor reads"), ("grok", "Grok reads")] {
            let id = session::create(
                w.turns.store(),
                w.workspace.clone(),
                "terminal".into(),
                "x".into(),
                provider.into(),
                String::new(),
                String::new(),
                "ask".into(),
            )
            .expect("session")
            .id;
            w.turns.commands_reload(&id).expect("reload");
            let said = w.blocks(&id).into_iter().map(|block| block.text).collect::<Vec<_>>();
            assert_eq!(said, [format!("{head} its commands and skills again when the session restarts. Use /restart.")]);
        }
        assert!(w.turns.commands_reload("nobody").is_err());
    }

    /// A restart lets go of the idle process and keeps the conversation: the
    /// next message launches another on it with `--resume`.
    #[test]
    fn a_restart_lets_go_of_the_idle_process_and_the_next_message_resumes_the_conversation() {
        let w = world();
        let mine = users_claude(&w);
        w.say(&mine, "remember 4817");
        // Claude has written the conversation by the time it is resumed.
        w.claude_wrote(&mine.id);
        assert_eq!(w.turns.test_agents().running(), vec![mine.id.clone()]);

        w.turns.session_restart(&mine.id, false).expect("restart");
        assert!(w.turns.test_agents().running().is_empty(), "the process stayed");
        assert!(w.turns.idle_since(&mine.id).is_none());
        assert!(says(&w, &mine.id, "Restarted. The CLI starts again with the next message."));

        w.say(&mine, "what number?");
        assert!(says(&w, &mine.id, "report: what number?"));
        let launches = launched(&w.dir.join("claude-launch.log"));
        assert_eq!(launches.len(), 2, "{launches:?}");
        assert_eq!(after_flag(&launches[0], "--session-id"), Some(mine.id.clone()));
        assert_eq!(after_flag(&launches[1], "--resume"), Some(mine.id.clone()));
        w.turns.release(&mine.id);
    }

    /// A session with no process has nothing to let go of, and says so.
    #[test]
    fn a_restart_of_a_session_with_no_process_says_there_was_nothing_to_restart() {
        let w = world();
        let mine = users_claude(&w);
        w.turns.session_restart(&mine.id, false).expect("restart");
        assert!(says(&w, &mine.id, "Nothing was running; the CLI starts with the next message."));
        assert!(w.turns.session_restart("nobody", false).is_err());
    }

    /// A login's restart leaves the one note, whether or not a process was held.
    #[test]
    fn a_restart_after_sign_in_says_so() {
        let w = world();
        let mine = users_claude(&w);
        w.turns.session_signed_in(&mine.id).expect("restart");
        assert!(says(&w, &mine.id, "Signed in. Send a message to continue."));
        assert!(!says(&w, &mine.id, "Nothing was running; the CLI starts with the next message."));
    }

    /// A turn is stopped first: restarting under it would take its process.
    #[test]
    fn a_restart_is_refused_while_a_turn_runs() {
        let w = world();
        let mine = users_claude(&w);
        w.type_to(&mine, "SLEEP 30", None, None);
        until("the CLI was launched", || w.turns.test_agents().running() == vec![mine.id.clone()]);
        assert_eq!(w.turns.session_restart(&mine.id, true), Err("Stop the turn first.".to_string()));
        assert_eq!(w.turns.test_agents().running(), vec![mine.id.clone()], "the refusal let go of the process");
        w.turns.stop(&mine.id).expect("stop");
        w.settle(&mine.id);
        w.turns.release(&mine.id);
    }

    /// Work the board shows running goes with the process, so a restart names
    /// it and waits for `force`; forced, the entry is stopped with the CLI and
    /// the conversation goes on in a process of its own.
    #[test]
    fn a_restart_over_background_work_names_it_and_needs_force() {
        use crew_protocol::BackgroundState;
        let w = world();
        let mine = users_claude(&w);
        w.type_to(&mine, "BACKGROUND 60", None, None);
        assert_eq!(w.settle(&mine.id).status, "done");
        assert_eq!(w.turns.background_list(&mine.id).commands[0].state, BackgroundState::Running);

        let refused = w.turns.session_restart(&mine.id, false).expect_err("restarted over running work");
        assert_eq!(refused, "Still running in the background: Wait in the background. Restarting stops it.");
        assert_eq!(w.turns.test_agents().running(), vec![mine.id.clone()]);

        w.turns.session_restart(&mine.id, true).expect("forced restart");
        assert!(w.turns.test_agents().running().is_empty());
        assert_eq!(w.turns.background_list(&mine.id).commands[0].state, BackgroundState::Stopped);
        w.say(&mine, "again");
        assert_eq!(launched(&w.dir.join("claude-launch.log")).len(), 2);
        w.turns.release(&mine.id);
    }

    /// Background commands still open when the grace runs out: the turn ends
    /// on the result it had, and the process stays up with them, pinned, so
    /// the next turn runs on it and the work goes on.
    #[test]
    fn a_claude_childs_turn_that_outwaits_its_grace_ends_and_keeps_the_process_with_the_work() {
        use crew_protocol::BackgroundState;
        let w = world();
        let parent = w.session("terminal", "shell", "full");
        let (id, log) = w.claude(&parent, "BACKGROUND 60");
        let out = w.wait(&parent, &id, json!({}));
        assert_eq!(out["sessions"][0]["report"], "started it in the background", "{out}");
        w.settle(&id);
        assert_eq!(w.turns.test_agents().running(), vec![id.clone()], "the process went with the work");
        let list = w.turns.background_list(&id);
        assert!(list.live && !list.waiting, "{list:?}");
        assert_eq!(list.commands[0].state, BackgroundState::Running);
        std::thread::sleep(Duration::from_millis(5));
        assert!(
            w.turns.release_idle(Duration::from_millis(1), Duration::from_secs(3600)).is_empty(),
            "a pinned process was let go"
        );

        w.call(&parent, "send_message", json!({ "to": id, "text": "again" })).expect("send");
        assert_eq!(w.wait(&parent, &id, json!({}))["sessions"][0]["report"], "report: again");
        assert_eq!(launched(&log).len(), 1, "a process was launched for the next turn");
        assert_eq!(w.turns.background_list(&id).commands[0].state, BackgroundState::Running);
        w.turns.release(&id);
    }

    /// What the CLI takes while it idles is told to it between turns, on the
    /// process that is up: the model, the effort and the autonomy between Ask,
    /// Edits and Auto each get their control request, and nothing is launched.
    #[test]
    fn a_claude_session_whose_settings_changed_is_told_so_on_the_process_it_keeps() {
        let w = world();
        let parent = w.session("terminal", "shell", "full");
        let (id, log) = w.claude_as(&parent, "one", Some("ask"));
        w.wait(&parent, &id, json!({}));
        let row = w.settle(&id);
        session::set_options(w.turns.store(), id.clone(), "opus".into(), "medium".into(), row.service_tier, "edits".into())
            .expect("options");

        w.call(&parent, "send_message", json!({ "to": id, "text": "two" })).expect("send");
        assert_eq!(w.wait(&parent, &id, json!({}))["sessions"][0]["report"], "report: two");
        let row = w.settle(&id);
        session::set_options(w.turns.store(), id.clone(), row.model, "xhigh".into(), row.service_tier, "auto".into())
            .expect("options");
        w.call(&parent, "send_message", json!({ "to": id, "text": "three" })).expect("send");
        assert_eq!(w.wait(&parent, &id, json!({}))["sessions"][0]["report"], "report: three");

        assert_eq!(launched(&log).len(), 1, "{:?}", launched(&log));
        assert_eq!(
            w.claude_control(),
            [
                "set_model opus",
                r#"apply_flag_settings {"effortLevel": "medium"}"#,
                "set_permission_mode acceptEdits",
                r#"apply_flag_settings {"effortLevel": "xhigh"}"#,
                "set_permission_mode auto",
            ]
        );
        // Nothing changed: nothing is said.
        w.settle(&id);
        w.call(&parent, "send_message", json!({ "to": id, "text": "four" })).expect("send");
        assert_eq!(w.wait(&parent, &id, json!({}))["sessions"][0]["report"], "report: four");
        assert_eq!(w.claude_control().len(), 5);
        assert_eq!(launched(&log).len(), 1);
    }

    /// Full is a flag of the launch: leaving it takes another process, on the
    /// same conversation, and no request.
    #[test]
    fn a_claude_session_leaving_full_is_launched_again_on_its_conversation() {
        let w = world();
        let parent = w.session("terminal", "shell", "full");
        let (id, log) = w.claude(&parent, "one");
        w.wait(&parent, &id, json!({}));
        let row = w.settle(&id);
        let bound = row.provider_session_id.clone().expect("bound");
        assert_eq!(row.autonomy, "full");
        session::set_options(w.turns.store(), id.clone(), row.model, row.effort, row.service_tier, "ask".into())
            .expect("options");

        w.call(&parent, "send_message", json!({ "to": id, "text": "two" })).expect("send");
        assert_eq!(w.wait(&parent, &id, json!({}))["sessions"][0]["report"], "report: two");
        w.settle(&id);
        let launches = launched(&log);
        assert_eq!(launches.len(), 2, "{launches:?}");
        assert_eq!(after_flag(&launches[1], "--resume"), Some(bound));
        assert_eq!(after_flag(&launches[1], "--permission-mode"), Some("default".to_string()));
        assert!(w.claude_control().is_empty(), "{:?}", w.claude_control());
        // The new process is the one kept now.
        w.call(&parent, "send_message", json!({ "to": id, "text": "three" })).expect("send");
        assert_eq!(w.wait(&parent, &id, json!({}))["sessions"][0]["report"], "report: three");
        assert_eq!(launched(&log).len(), 2);
    }

    /// The real CLI checks a full model id with the server before it answers
    /// `set_model`, up to a deadline of 5 s of its own, so that answer can
    /// come later than any other control request's. Waiting for it is not a
    /// reason to launch the process again.
    #[test]
    fn a_claude_session_whose_process_is_slow_to_take_a_model_keeps_it() {
        let w = world();
        let parent = w.session("terminal", "shell", "full");
        let (id, log) = w.claude(&parent, "one");
        w.wait(&parent, &id, json!({}));
        let row = w.settle(&id);
        // Past the wait for any other request, within the one for a model.
        std::fs::write(w.dir.join("delay-set_model"), "3").expect("delay");
        session::set_options(w.turns.store(), id.clone(), "opus".into(), row.effort, row.service_tier, row.autonomy)
            .expect("options");

        w.call(&parent, "send_message", json!({ "to": id, "text": "two" })).expect("send");
        assert_eq!(w.wait(&parent, &id, json!({}))["sessions"][0]["report"], "report: two");
        w.settle(&id);
        assert_eq!(w.claude_control(), ["set_model opus"]);
        assert_eq!(launched(&log).len(), 1, "the slow answer launched another process: {:?}", launched(&log));
    }

    /// A CLI that refuses a setting is not left on the old one under the new
    /// name: the process goes and another takes its place, launched with the
    /// settings, and the turn still runs. A model is asked for twice before
    /// that (see the next test).
    #[test]
    fn a_claude_session_whose_process_refuses_a_setting_is_launched_again() {
        let w = world();
        let parent = w.session("terminal", "shell", "full");
        let (id, log) = w.claude(&parent, "one");
        w.wait(&parent, &id, json!({}));
        let row = w.settle(&id);
        let bound = row.provider_session_id.clone().expect("bound");
        std::fs::write(w.dir.join("refuse-set_model"), "2").expect("refusal");
        session::set_options(w.turns.store(), id.clone(), "opus".into(), row.effort, row.service_tier, row.autonomy)
            .expect("options");

        w.call(&parent, "send_message", json!({ "to": id, "text": "two" })).expect("send");
        assert_eq!(w.wait(&parent, &id, json!({}))["sessions"][0]["report"], "report: two");
        w.settle(&id);
        assert_eq!(w.claude_control(), ["set_model opus", "set_model opus"]);
        let launches = launched(&log);
        assert_eq!(launches.len(), 2, "{launches:?}");
        assert_eq!(after_flag(&launches[1], "--model"), Some("opus".to_string()));
        assert_eq!(after_flag(&launches[1], "--resume"), Some(bound));
        w.call(&parent, "send_message", json!({ "to": id, "text": "three" })).expect("send");
        assert_eq!(w.wait(&parent, &id, json!({}))["sessions"][0]["report"], "report: three");
        assert_eq!(launched(&log).len(), 2);
    }

    /// The real CLI refuses a `set_model` once in a while only because its
    /// check of the model with the server did not finish in its 5 s ("Couldn't
    /// confirm model ... with the API. Try again."). Asked again, it takes it:
    /// the process stays.
    #[test]
    fn a_claude_session_whose_process_refuses_a_model_once_is_asked_again() {
        let w = world();
        let parent = w.session("terminal", "shell", "full");
        let (id, log) = w.claude(&parent, "one");
        w.wait(&parent, &id, json!({}));
        let row = w.settle(&id);
        std::fs::write(w.dir.join("refuse-set_model"), "").expect("refusal");
        session::set_options(w.turns.store(), id.clone(), "opus".into(), row.effort, row.service_tier, row.autonomy)
            .expect("options");

        w.call(&parent, "send_message", json!({ "to": id, "text": "two" })).expect("send");
        assert_eq!(w.wait(&parent, &id, json!({}))["sessions"][0]["report"], "report: two");
        w.settle(&id);
        assert_eq!(w.claude_control(), ["set_model opus", "set_model opus"]);
        assert_eq!(launched(&log).len(), 1, "{:?}", launched(&log));
    }

    impl World {
        /// A Codex child on the fake app server, and the log of what it was sent.
        fn codex(&self, parent: &Caller, prompt: &str, autonomy: Option<&str>) -> (String, PathBuf) {
            let (fake, log) = crate::turns::fake_codex(&self.dir);
            self.turns.override_binary("codex", fake);
            let mut args = json!({ "provider": "codex", "model": "gpt-5.6-luna", "prompt": prompt });
            if let Some(autonomy) = autonomy {
                args["autonomy"] = json!(autonomy);
            }
            let started = self.call(parent, "delegate", args).expect("start");
            (started["id"].as_str().unwrap().to_string(), log)
        }
    }

    /// Until the turn's command row is in the transcript: the turn is running.
    fn until_tool(w: &World, _parent: &Caller, id: &str) {
        for _ in 0..800 {
            let (blocks, _) = w.turns.transcripts().since(id, 0);
            if blocks.iter().any(|block| block.role == crew_protocol::BlockRole::Tool) {
                return;
            }
            std::thread::sleep(Duration::from_millis(25));
        }
        panic!("{id} never ran its command");
    }

    /// What the fake app server was sent, request by request.
    fn sent(log: &std::path::Path, method: &str) -> Vec<Value> {
        std::fs::read_to_string(log)
            .unwrap_or_default()
            .lines()
            .filter_map(|line| serde_json::from_str::<Value>(line).ok())
            .filter(|line| line["method"] == method)
            .map(|line| line["params"].clone())
            .collect()
    }

    /// The app servers launched, one entry for each, as the fake logged its
    /// argv, pid and env on starting.
    fn launched(log: &std::path::Path) -> Vec<Value> {
        std::fs::read_to_string(log)
            .unwrap_or_default()
            .lines()
            .filter_map(|line| serde_json::from_str::<Value>(line).ok())
            .filter(|line| line.get("argv").is_some())
            .collect()
    }

    /// One app server for a child: the first turn opens a thread with Crew's
    /// server on it and the persona as context, the next is a `turn/start` on
    /// that thread, with the persona again, and starts nothing.
    #[test]
    fn a_codex_session_opens_a_thread_and_the_next_turn_runs_on_it() {
        let w = world();
        let parent = w.session("terminal", "shell", "full");
        let (id, log) = w.codex(&parent, "remember 4817", None);
        let out = w.wait(&parent, &id, json!({}));
        assert_eq!(out["sessions"][0]["report"], "report: remember 4817", "{out}");
        w.settle(&id);
        let bound = w.row(&id).provider_session_id.expect("bound");

        let started = sent(&log, "thread/start");
        assert_eq!(started.len(), 1, "{started:?}");
        let crew = &started[0]["config"]["mcp_servers"]["crew"];
        assert_eq!(crew["args"], json!(["--mcp"]), "{crew}");
        assert!(crew["env"]["CREW_TOKEN"].as_str().is_some_and(|t| !t.is_empty()), "{crew}");
        assert_eq!(
            (crew["tool_timeout_sec"].clone(), crew["default_tools_approval_mode"].clone()),
            (json!(3900), json!("approve"))
        );
        assert_eq!(started[0]["model"], "gpt-5.6-luna");
        assert_eq!(
            (started[0]["approvalPolicy"].clone(), started[0]["sandbox"].clone()),
            (json!("never"), json!("danger-full-access"))
        );
        let turn = &sent(&log, "turn/start")[0];
        let first = turn["input"][0]["text"].as_str().unwrap();
        assert!(
            first.ends_with("remember 4817") && !first.contains("Your final message"),
            "the persona is in the message: {turn}"
        );
        let context = turn["additionalContext"]["crew"]["value"].as_str().unwrap_or_default();
        assert!(context.contains("is delivered to"), "{context}");
        assert!(context.contains("`mcp__crew__send_message`") && !context.contains("find_tool"), "{context}");

        let more = w.call(&parent, "send_message", json!({ "to": id, "text": "what number?" })).expect("send");
        assert_eq!(more["delivery"], "started", "{more}");
        assert_eq!(w.wait(&parent, &id, json!({}))["sessions"][0]["report"], "report: what number?");
        assert!(sent(&log, "thread/resume").is_empty(), "the live thread was opened again");
        assert_eq!(sent(&log, "thread/start").len(), 1);
        let turns = sent(&log, "turn/start");
        assert_eq!(turns.len(), 2, "{turns:?}");
        assert_eq!((turns[0]["threadId"].clone(), turns[1]["threadId"].clone()), (json!(bound), json!(bound)));
        let second = &turns[1];
        assert!(second["input"][0]["text"].as_str().unwrap().starts_with("## Message\nFrom: shell (terminal"), "{second}");
        assert!(second["additionalContext"]["crew"]["value"].as_str().unwrap().contains("Your final message"), "{second}");
        // One process served both turns, with the token it was given, and it
        // is still up between them, idle.
        let launches = launched(&log);
        assert_eq!(launches.len(), 1, "{launches:?}");
        assert!(launches[0]["env"]["CREW_TOKEN"].as_str().is_some_and(|t| !t.is_empty()), "{}", launches[0]);
        w.settle(&id);
        assert_eq!(w.turns.test_agents().running(), vec![id.clone()]);
        assert!(w.turns.idle_since(&id).is_some());
    }

    /// The token the CLI's MCP server was given at launch is the one the bridge
    /// still honours on a later turn: nothing minted another for the session.
    #[test]
    fn a_kept_codex_process_keeps_the_token_it_was_launched_with() {
        let w = world();
        let parent = w.session("terminal", "shell", "full");
        let (id, log) = w.codex(&parent, "one", None);
        w.wait(&parent, &id, json!({}));
        w.settle(&id);
        let token = sent(&log, "thread/start")[0]["config"]["mcp_servers"]["crew"]["env"]["CREW_TOKEN"].clone();
        w.call(&parent, "send_message", json!({ "to": id, "text": "two" })).expect("send");
        w.wait(&parent, &id, json!({}));
        assert_eq!(launched(&log).len(), 1);
        let bearer = w.turns.test_bridge().whose(token.as_str().unwrap());
        assert_eq!(bearer, Some(crate::bridge::Bearer::Session(id.clone())), "the live process lost its token");
    }

    /// A process that died while nobody was talking to it is not written to:
    /// the next message launches another and opens the thread it was bound to.
    #[test]
    fn a_codex_process_killed_while_idle_is_launched_again_and_resumes_the_thread() {
        let w = world();
        let parent = w.session("terminal", "shell", "full");
        let (id, log) = w.codex(&parent, "remember 4817", None);
        w.wait(&parent, &id, json!({}));
        w.settle(&id);
        let bound = w.row(&id).provider_session_id.expect("bound");
        w.turns.test_agents().kill(&id);

        let more = w.call(&parent, "send_message", json!({ "to": id, "text": "what number?" })).expect("send");
        assert_eq!(more["delivery"], "started", "{more}");
        assert_eq!(w.wait(&parent, &id, json!({}))["sessions"][0]["report"], "report: what number?");
        assert_eq!(launched(&log).len(), 2);
        let resumed = sent(&log, "thread/resume");
        assert_eq!(resumed.len(), 1, "{resumed:?}");
        assert_eq!(resumed[0]["threadId"], json!(bound));
        assert_eq!(resumed[0]["model"], "gpt-5.6-luna");
        assert!(resumed[0]["config"]["mcp_servers"]["crew"].is_object(), "{}", resumed[0]);
    }

    /// A session whose settings changed is still on the app server it has:
    /// the second `turn/start` names the new model, effort, approval policy
    /// and sandbox, and nothing is launched. The first names none of them,
    /// since its thread was opened with them, and the second leaves out the
    /// working directory, which did not move.
    #[test]
    fn a_codex_session_whose_settings_changed_says_so_on_its_next_turn() {
        let w = world();
        let parent = w.session("terminal", "shell", "full");
        let (id, log) = w.codex(&parent, "one", Some("ask"));
        w.wait(&parent, &id, json!({}));
        let row = w.settle(&id);
        session::set_options(w.turns.store(), id.clone(), "gpt-5.6-sol".into(), "high".into(), row.service_tier, "full".into())
            .expect("options");

        w.call(&parent, "send_message", json!({ "to": id, "text": "two" })).expect("send");
        assert_eq!(w.wait(&parent, &id, json!({}))["sessions"][0]["report"], "report: two");
        assert_eq!(launched(&log).len(), 1);
        assert!(sent(&log, "thread/resume").is_empty());
        let turns = sent(&log, "turn/start");
        assert_eq!(turns.len(), 2, "{turns:?}");
        for key in ["model", "effort", "approvalPolicy", "sandboxPolicy", "approvalsReviewer", "cwd"] {
            assert!(turns[0].get(key).is_none(), "{key}: {}", turns[0]);
        }
        assert_eq!(turns[1]["model"], "gpt-5.6-sol");
        assert_eq!(turns[1]["effort"], "high");
        assert_eq!(
            (turns[1]["approvalPolicy"].clone(), turns[1]["sandboxPolicy"].clone()),
            (json!("never"), json!({ "type": "dangerFullAccess" }))
        );
        assert_eq!(turns[1]["approvalsReviewer"], "user");
        assert!(turns[1].get("cwd").is_none(), "{}", turns[1]);
    }

    /// The same when the exit is heard: the entry is dropped, the tray closed,
    /// and the process no longer counts as idle.
    #[test]
    fn a_codex_process_that_exits_while_idle_is_forgotten() {
        let w = world();
        let parent = w.session("terminal", "shell", "full");
        let (id, log) = w.codex(&parent, "one", None);
        w.wait(&parent, &id, json!({}));
        w.settle(&id);
        assert!(w.turns.idle_since(&id).is_some());
        assert!(w.turns.background_list(&id).live, "the tray closed with the turn");

        let pid = launched(&log)[0]["pid"].as_u64().expect("pid").to_string();
        std::process::Command::new("kill").args(["-9", pid.as_str()]).status().expect("kill");
        for _ in 0..200 {
            if w.turns.idle_since(&id).is_none() {
                break;
            }
            std::thread::sleep(Duration::from_millis(25));
        }
        assert!(w.turns.idle_since(&id).is_none(), "the dead process is still thought idle");
        assert!(!w.turns.background_list(&id).live, "its tray is still open");
        // No error: nobody was talking to it.
        assert_eq!(w.row(&id).status, "idle");

        w.call(&parent, "send_message", json!({ "to": id, "text": "again" })).expect("send");
        assert_eq!(w.wait(&parent, &id, json!({}))["sessions"][0]["report"], "report: again");
        assert_eq!(launched(&log).len(), 2);
        assert_eq!(sent(&log, "thread/resume").len(), 1);
    }

    /// A bot starts a clean provider session every turn, so each turn gets its
    /// own process and it is gone when the turn ends.
    #[test]
    fn a_codex_bot_launches_once_for_each_turn() {
        let w = world();
        let (fake, log) = crate::turns::fake_codex(&w.dir);
        w.turns.override_binary("codex", fake);
        let bot = session::create(
            w.turns.store(),
            w.workspace.clone(),
            "bot".into(),
            "robin".into(),
            "codex".into(),
            "gpt-5.6-luna".into(),
            String::new(),
            "full".into(),
        )
        .expect("bot");
        for text in ["one", "two"] {
            w.turns
                .start(TurnStart {
                    session_id: bot.id.clone(),
                    cwd: w.dir.to_string_lossy().into_owned(),
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
            w.settle(&bot.id);
            assert!(w.turns.test_agents().running().is_empty(), "the bot's process outlived its turn");
            assert!(w.turns.idle_since(&bot.id).is_none());
        }
        assert_eq!(launched(&log).len(), 2);
        assert_eq!(sent(&log, "thread/start").len(), 2);
        assert!(sent(&log, "thread/resume").is_empty());
        assert_eq!(sent(&log, "turn/start").len(), 2);
    }

    /// A stop Codex closes (`turn/completed`, interrupted) leaves the thread
    /// idle: the process stays, with the background terminals an interrupt
    /// does not end, and the next message is a turn on it.
    #[test]
    fn a_stopped_codex_turn_keeps_the_process_and_its_background_terminals() {
        use crew_protocol::BackgroundState;
        let w = world();
        let parent = w.session("terminal", "shell", "full");
        let (id, log) = w.codex(&parent, "BGKEEP 30", None);
        w.wait(&parent, &id, json!({}));
        until_background(&w, &id, |list| !list.commands.is_empty());
        w.call(&parent, "send_message", json!({ "to": id, "text": "SLEEP 30" })).expect("send");
        until("the second turn runs", || sent(&log, "turn/start").len() == 2 && w.turns.is_running(&id));
        std::thread::sleep(Duration::from_millis(300));
        w.turns.stop(&id).expect("stop");
        assert_eq!(wait_ended(&w, &parent, &id)["sessions"][0]["outcome"], "stopped");
        w.settle(&id);
        assert_eq!(w.turns.test_agents().running(), vec![id.clone()], "the stopped turn's process went");
        assert!(w.turns.idle_since(&id).is_some());
        let list = w.turns.background_list(&id);
        assert!(list.live, "{list:?}");
        assert_eq!(list.commands[0].state, BackgroundState::Running);

        let more = w.call(&parent, "send_message", json!({ "to": id, "text": "again" })).expect("send");
        assert_eq!(more["delivery"], "started", "{more}");
        assert_eq!(w.wait(&parent, &id, json!({}))["sessions"][0]["report"], "report: again");
        assert_eq!(launched(&log).len(), 1);
        assert!(sent(&log, "thread/resume").is_empty());
        w.turns.release(&id);
    }

    /// The timer that ends a stopped turn the app server will not end is the
    /// stopped turn's: the turn that follows it, on a process of its own, runs.
    #[test]
    fn the_grace_of_a_stopped_codex_turn_does_not_end_the_turn_after_it() {
        let w = world();
        let parent = w.session("terminal", "shell", "full");
        let (id, _) = w.codex(&parent, "SLEEP 30", None);
        until_tool(&w, &parent, &id);
        w.turns.stop(&id).expect("stop");
        w.settle(&id);
        assert_eq!(wait_ended(&w, &parent, &id)["sessions"][0]["outcome"], "stopped");
        w.call(&parent, "send_message", json!({ "to": id, "text": "SLEEP 3" })).expect("send");
        // Past the stopped turn's grace, which is over while this one still runs.
        let out = w.wait(&parent, &id, json!({}));
        assert_eq!(out["sessions"][0]["report"], "report: SLEEP 3", "{out}");
    }

    /// What Codex says late of the turn before names that turn, and is not the
    /// next one's: not its text, and not its end.
    #[test]
    fn what_codex_says_of_the_last_turn_is_not_the_next_turns() {
        let w = world();
        let parent = w.session("terminal", "shell", "full");
        let (id, _) = w.codex(&parent, "one", None);
        w.wait(&parent, &id, json!({}));
        w.settle(&id);
        w.call(&parent, "send_message", json!({ "to": id, "text": "STALE" })).expect("send");
        let out = w.wait(&parent, &id, json!({}));
        let event = &out["sessions"][0];
        assert_eq!((event["event"].clone(), event["report"].clone()), (json!("turn"), json!("report: STALE")), "{out}");
    }

    /// A failed turn does not keep its process either.
    #[test]
    fn a_failed_codex_turn_releases_the_process() {
        let w = world();
        let parent = w.session("terminal", "shell", "full");
        let (id, log) = w.codex(&parent, "FAIL", None);
        w.wait(&parent, &id, json!({}));
        w.settle(&id);
        assert!(w.turns.test_agents().running().is_empty());
        w.call(&parent, "send_message", json!({ "to": id, "text": "again" })).expect("send");
        assert_eq!(w.wait(&parent, &id, json!({}))["sessions"][0]["report"], "report: again");
        assert_eq!(launched(&log).len(), 2);
    }

    /// A steer the turn ended before reading is not lost: the process is let
    /// go with the stopped turn, and the steer waits in the box.
    #[test]
    fn a_steer_a_stopped_codex_turn_never_read_goes_back_to_the_box() {
        let w = world();
        let parent = w.session("terminal", "shell", "full");
        let (id, _) = w.codex(&parent, "STUBBORN SLEEP 30", None);
        until_tool(&w, &parent, &id);
        let steered = w.call(&parent, "send_message", json!({ "to": id, "text": "and this", "steer": true })).expect("steer");
        assert_eq!(steered["delivery"], "steered", "{steered}");
        w.turns.stop(&id).expect("stop");
        w.settle(&id);
        let waiting = crate::mailbox::waiting(w.turns.store(), &id).expect("waiting");
        assert_eq!(waiting.len(), 1, "{waiting:?}");
        assert!(waiting[0].text.contains("and this"), "{waiting:?}");
        assert!(w.turns.test_agents().running().is_empty());
    }

    /// Notifications that come while no turn runs are not a turn's: they
    /// change nothing the next one starts from.
    #[test]
    fn a_codex_process_that_speaks_while_idle_does_not_start_a_turn() {
        let w = world();
        let parent = w.session("terminal", "shell", "full");
        let (id, _) = w.codex(&parent, "one", None);
        w.wait(&parent, &id, json!({}));
        w.settle(&id);
        let before = w.turns.transcripts().len(&id);
        let thread = w.row(&id).provider_session_id.expect("bound");
        let late = json!({ "method": "turn/started", "params": { "threadId": thread, "turn": { "id": "late", "status": "inProgress" } } });
        w.turns.on_agent_lines("agent-stdout", &id, vec![late.to_string()]);
        let delta = json!({ "method": "item/agentMessage/delta", "params": { "threadId": thread, "turnId": "late", "itemId": "m", "delta": "x" } });
        w.turns.on_agent_lines("agent-stdout", &id, vec![delta.to_string()]);
        assert_eq!(w.turns.transcripts().len(&id), before);
        // The next message still starts a turn on the same process.
        w.call(&parent, "send_message", json!({ "to": id, "text": "two" })).expect("send");
        assert_eq!(w.wait(&parent, &id, json!({}))["sessions"][0]["report"], "report: two");
    }

    #[test]
    fn a_codex_session_takes_a_steer_and_queues_one_with_no_turn_to_take_it() {
        let w = world();
        let parent = w.session("terminal", "shell", "full");
        let (id, log) = w.codex(&parent, "SLEEP 2", None);
        until_tool(&w, &parent, &id);
        let steered = w.call(&parent, "send_message", json!({ "to": id, "text": "and this", "steer": true })).expect("steer");
        assert_eq!(steered["delivery"], "steered", "{steered}");
        let out = w.wait(&parent, &id, json!({}));
        assert_eq!(out["sessions"][0]["report"], "report: SLEEP 2 + and this", "{out}");
        let steer = &sent(&log, "turn/steer")[0];
        assert!(steer["expectedTurnId"].as_str().is_some_and(|turn| !turn.is_empty()), "{steer}");
        // One turn took both, and the steer shows where it was read.
        let read = w.call(&parent, "read_session", json!({ "session": id })).expect("read");
        let text = read["text"].as_str().unwrap();
        let at = text.find("] and this").expect("the steer is not in the transcript");
        assert!(at < text.find("report: SLEEP 2 + and this").unwrap(), "{text}");
        assert_eq!(text.matches("Turn ended").count(), 1, "{text}");
        // Nothing running: it is queued, says so, and starts a turn.
        w.settle(&id);
        let idle = w.call(&parent, "send_message", json!({ "to": id, "text": "next", "steer": true })).expect("send");
        assert_eq!(idle["delivery"], "started", "{idle}");
        assert!(idle["note"].as_str().unwrap().contains("no turn was running"), "{idle}");
        assert_eq!(w.wait(&parent, &id, json!({}))["sessions"][0]["report"], "report: next");
    }

    /// An ask child's command waits on the card; the answer goes back on the
    /// request Codex made, in its own words.
    #[test]
    fn a_codex_approval_is_a_card_and_its_answer_goes_back_to_codex() {
        let w = world();
        let parent = w.session("terminal", "shell", "full");
        let (id, log) = w.codex(&parent, "ASK", Some("ask"));
        let asked = w.wait(&parent, &id, json!({}));
        assert_eq!(asked["sessions"][0]["event"], "needs-input", "{asked}");
        let request = &asked["sessions"][0]["request"];
        assert_eq!((request["kind"].clone(), request["tool"].clone()), (json!("approval"), json!("bash")), "{request}");
        assert_eq!(request["title"], "touch asked.txt");
        assert_eq!(w.row(&id).status, "needs-input");
        w.turns.respond(&id, request["request_id"].as_u64().unwrap(), ApprovalDecision::Always).expect("respond");
        let done = w.wait(&parent, &id, json!({}));
        assert_eq!(done["sessions"][0]["report"], "report: ASK + decision: acceptForSession", "{done}");
        let started = &sent(&log, "thread/start")[0];
        assert_eq!(
            (started["approvalPolicy"].clone(), started["sandbox"].clone()),
            (json!("on-request"), json!("workspace-write"))
        );
    }

    #[test]
    fn a_codex_question_is_answered_by_its_text_and_goes_back_by_id() {
        let w = world();
        let parent = w.session("terminal", "shell", "full");
        let (id, _) = w.codex(&parent, "QUESTION", None);
        let asked = w.wait(&parent, &id, json!({}));
        let request = &asked["sessions"][0]["request"];
        assert_eq!(request["kind"], "question", "{asked}");
        assert_eq!(request["questions"][0]["question"], "Which color?");
        let answered = w.call(&parent, "send_message", json!({ "to": id, "text": "Blue" })).expect("answer");
        assert_eq!(answered["delivery"], "answered", "{answered}");
        let done = w.wait(&parent, &id, json!({}));
        assert_eq!(done["sessions"][0]["report"], r#"report: QUESTION + answers: {"color": {"answers": ["Blue"]}}"#, "{done}");
    }

    /// Stopped: the turn is interrupted, and ends when Codex says so; one
    /// that does not say so in time is killed under it.
    #[test]
    fn a_stopped_codex_turn_is_interrupted_then_killed_if_it_hangs_on() {
        let w = world();
        let parent = w.session("terminal", "shell", "full");
        let (id, log) = w.codex(&parent, "SLEEP 30", None);
        until_tool(&w, &parent, &id);
        let at = Instant::now();
        let stopped = w.call(&parent, "stop_session", json!({ "session": id })).expect("stop");
        assert_eq!(stopped["status"], "exited", "{stopped}");
        assert!(at.elapsed() < Duration::from_millis(1500), "the interrupt was not taken: {:?}", at.elapsed());
        assert_eq!(sent(&log, "turn/interrupt").len(), 1);

        let (stubborn, _) = w.codex(&parent, "STUBBORN SLEEP 30", None);
        until_tool(&w, &parent, &stubborn);
        let at = Instant::now();
        let stopped = w.call(&parent, "stop_session", json!({ "session": stubborn })).expect("stop");
        assert_eq!(stopped["status"], "exited", "{stopped}");
        let took = at.elapsed();
        assert!(took >= Duration::from_millis(1500) && took < Duration::from_secs(4), "{took:?}");
        std::thread::sleep(Duration::from_millis(300));
        assert!(w.turns.test_agents().running().is_empty(), "the hung app server was left running");
    }

    #[test]
    fn a_failed_codex_turn_reports_why() {
        let w = world();
        let parent = w.session("terminal", "shell", "full");
        let (id, _) = w.codex(&parent, "FAIL", None);
        let out = w.wait(&parent, &id, json!({}));
        assert_eq!(
            (out["sessions"][0]["event"].clone(), out["sessions"][0]["outcome"].clone()),
            (json!("error"), json!("boom")),
            "{out}"
        );
    }

    impl World {
        /// A Cursor child on the fake `cursor-agent acp`, and the log of what it was sent.
        fn cursor(&self, parent: &Caller, prompt: &str, autonomy: Option<&str>) -> (String, PathBuf) {
            let (fake, log) = crate::turns::fake_cursor(&self.dir);
            self.turns.override_binary("cursor-agent", fake);
            let mut args = json!({ "provider": "cursor", "model": "composer-2.5", "prompt": prompt });
            if let Some(autonomy) = autonomy {
                args["autonomy"] = json!(autonomy);
            }
            let started = self.call(parent, "delegate", args).expect("start");
            (started["id"].as_str().unwrap().to_string(), log)
        }
    }

    fn launches_of(log: &std::path::Path) -> Vec<Value> {
        std::fs::read_to_string(log)
            .unwrap_or_default()
            .lines()
            .filter_map(|line| serde_json::from_str::<Value>(line).ok())
            .filter(|line| line.get("argv").is_some())
            .map(|line| line["argv"].clone())
            .collect()
    }

    /// The first turn opens a session with Crew's server on it and the persona
    /// in the message; a process let go in between (the idle release) is
    /// replaced by one that loads that session. The history the load replays
    /// is not shown twice.
    #[test]
    fn a_cursor_session_opens_a_session_and_the_next_turn_loads_it() {
        let w = world();
        let parent = w.session("terminal", "shell", "full");
        let (id, log) = w.cursor(&parent, "remember 4817", None);
        let out = w.wait(&parent, &id, json!({}));
        assert_eq!(out["sessions"][0]["report"], "report: remember 4817", "{out}");
        w.settle(&id);
        let bound = w.row(&id).provider_session_id.expect("bound");
        w.turns.release(&id);

        assert_eq!(launches_of(&log)[0], json!(["--model", "composer-2.5", "--force", "--disable-codebase-ref", "acp"]));
        assert_eq!(sent(&log, "initialize")[0]["protocolVersion"], 1);
        assert_eq!(sent(&log, "authenticate")[0]["methodId"], "cursor_login");
        let opened = sent(&log, "session/new");
        assert_eq!(opened.len(), 1, "{opened:?}");
        let crew = &opened[0]["mcpServers"][0];
        assert_eq!((crew["name"].clone(), crew["args"].clone()), (json!("crew"), json!(["--mcp"])), "{crew}");
        let token = crew["env"].as_array().unwrap().iter().find(|pair| pair["name"] == "CREW_TOKEN").expect("token");
        assert!(token["value"].as_str().is_some_and(|t| !t.is_empty()), "{crew}");
        let first = sent(&log, "session/prompt")[0]["prompt"][0]["text"].as_str().unwrap().to_string();
        assert!(first.contains("is delivered to"), "the persona is in the message: {first}");
        assert!(
            first.contains("the MCP server `crew`") && first.contains("`send_message`"),
            "the MCP tools, not the crew CLI: {first}"
        );
        assert!(!first.contains("find_tool") && first.contains("you cannot delegate or start sessions"), "{first}");
        assert!(first.trim_end().ends_with("remember 4817"), "{first}");

        let more = w.call(&parent, "send_message", json!({ "to": id, "text": "what number?" })).expect("send");
        assert_eq!(more["delivery"], "started", "{more}");
        assert_eq!(w.wait(&parent, &id, json!({}))["sessions"][0]["report"], "report: what number?");
        let loaded = sent(&log, "session/load");
        assert_eq!(loaded.len(), 1, "{loaded:?}");
        assert_eq!(loaded[0]["sessionId"], json!(bound));
        assert_eq!(loaded[0]["mcpServers"][0]["name"], "crew", "{}", loaded[0]);
        assert_eq!(sent(&log, "session/new").len(), 1, "a load that worked opened another session");
        let second = sent(&log, "session/prompt")[1]["prompt"][0]["text"].as_str().unwrap().to_string();
        assert!(second.starts_with("## Message\nFrom: shell (terminal") && !second.contains("Your final message"), "{second}");
        let read = w.call(&parent, "read_session", json!({ "session": id })).expect("read");
        let text = read["text"].as_str().unwrap();
        assert_eq!(text.matches("report: remember 4817").count(), 1, "the replay was shown again: {text}");
        assert!(!text.contains("echo old"), "{text}");
        assert_eq!(launches_of(&log).len(), 2);
        w.settle(&id);
        assert_eq!(w.turns.test_agents().running(), vec![id.clone()], "the process stays for the next turn");
    }

    /// Cursor takes nothing into a running turn: a steer is queued, says so,
    /// and is the next turn. Crew never sends a second prompt mid-turn.
    #[test]
    fn a_cursor_steer_is_queued_for_the_next_turn() {
        let w = world();
        let parent = w.session("terminal", "shell", "full");
        let (id, log) = w.cursor(&parent, "SLEEP 2", None);
        until_tool(&w, &parent, &id);
        let steer = w.call(&parent, "send_message", json!({ "to": id, "text": "and this", "steer": true })).expect("steer");
        assert_eq!(steer["delivery"], "queued", "{steer}");
        assert!(steer["note"].as_str().unwrap().contains("cursor cannot take a message"), "{steer}");
        assert_eq!(w.wait(&parent, &id, json!({}))["sessions"][0]["report"], "report: SLEEP 2");
        let next = w.wait(&parent, &id, json!({}));
        assert_eq!(next["sessions"][0]["report"], "report: and this", "{next}");
        assert_eq!(sent(&log, "session/prompt").len(), 2);
        assert_eq!(launches_of(&log).len(), 1, "both prompts ran on the one process");
    }

    /// An ask child's command waits on the card, and Crew's "always" goes back
    /// as `allow-once`: `allow-always` would write the user's global config.
    /// Cursor's first request is id 0.
    #[test]
    fn a_cursor_approval_is_a_card_and_always_is_allowed_once() {
        let w = world();
        let parent = w.session("terminal", "shell", "full");
        let (id, log) = w.cursor(&parent, "ASK", Some("ask"));
        let asked = w.wait(&parent, &id, json!({}));
        assert_eq!(asked["sessions"][0]["event"], "needs-input", "{asked}");
        let request = &asked["sessions"][0]["request"];
        assert_eq!(
            (request["kind"].clone(), request["tool"].clone(), request["title"].clone()),
            (json!("approval"), json!("bash"), json!("touch asked.txt")),
            "{request}"
        );
        assert_eq!(request["input"]["reason"], "Shell allowlist is empty", "{request}");
        assert_eq!(w.row(&id).status, "needs-input");
        w.turns.respond(&id, request["request_id"].as_u64().unwrap(), ApprovalDecision::Always).expect("respond");
        let done = w.wait(&parent, &id, json!({}));
        assert_eq!(done["sessions"][0]["report"], "report: ASK + decision: allow-once", "{done}");
        assert_eq!(
            launches_of(&log)[0],
            json!(["--model", "composer-2.5", "--disable-codebase-ref", "acp"]),
            "ask runs without --force"
        );
        let answered: Vec<Value> = std::fs::read_to_string(&log)
            .unwrap()
            .lines()
            .filter_map(|line| serde_json::from_str::<Value>(line).ok())
            .filter(|line| line.get("answer").is_some())
            .collect();
        assert_eq!(answered[0]["answer"], 0, "{answered:?}");
    }

    /// Crew's own MCP calls are allowed without a card; a question is a card
    /// answered by its label and sent back by id; a plan is accepted and shown.
    #[test]
    fn a_cursor_child_calls_crew_freely_asks_by_card_and_plans() {
        let w = world();
        let parent = w.session("terminal", "shell", "full");
        let (id, _) = w.cursor(&parent, "MCP QUESTION PLAN", Some("ask"));
        let asked = w.wait(&parent, &id, json!({}));
        let request = &asked["sessions"][0]["request"];
        assert_eq!(request["kind"], "question", "the Crew call asked: {asked}");
        assert_eq!(request["questions"][0]["question"], "Which color?");
        let answered = w.call(&parent, "send_message", json!({ "to": id, "answers": ["Blue"] })).expect("answer");
        assert_eq!(answered["delivery"], "answered", "{answered}");
        let done = w.wait(&parent, &id, json!({}));
        assert_eq!(
            done["sessions"][0]["report"],
            r#"report: MCP QUESTION PLAN + crew: allow-once + answers: {"answers": [{"questionId": "color", "selectedOptionIds": ["b"]}], "outcome": "answered"} + plan: accepted"#,
            "{done}"
        );
        let (blocks, _) = w.turns.transcripts().since(&id, 0);
        assert!(blocks.iter().any(|block| block.text == "Crew list peers"), "{blocks:?}");
        assert!(blocks.iter().any(|block| block.text == "Plan: Hello"), "{blocks:?}");
        assert!(blocks.iter().any(|block| block.text == "Todos"), "{blocks:?}");
    }

    /// Stopped: the prompt is cancelled, and the turn ends when it says so;
    /// one that does not say so in time is killed under it.
    #[test]
    fn a_stopped_cursor_turn_is_cancelled_then_killed_if_it_hangs_on() {
        let w = world();
        let parent = w.session("terminal", "shell", "full");
        let (id, log) = w.cursor(&parent, "SLEEP 30", None);
        until_tool(&w, &parent, &id);
        let at = Instant::now();
        let stopped = w.call(&parent, "stop_session", json!({ "session": id })).expect("stop");
        assert_eq!(stopped["status"], "exited", "{stopped}");
        assert!(at.elapsed() < Duration::from_millis(1500), "the cancel was not taken: {:?}", at.elapsed());
        assert_eq!(sent(&log, "session/cancel").len(), 1);
        let (blocks, _) = w.turns.transcripts().since(&id, 0);
        let row = blocks.iter().find_map(|block| block.tool.as_ref()).expect("the command row");
        assert_eq!(row.status, crew_protocol::ToolStatus::Interrupted);

        let (stubborn, _) = w.cursor(&parent, "STUBBORN SLEEP 30", None);
        until_tool(&w, &parent, &stubborn);
        let at = Instant::now();
        let stopped = w.call(&parent, "stop_session", json!({ "session": stubborn })).expect("stop");
        assert_eq!(stopped["status"], "exited", "{stopped}");
        let took = at.elapsed();
        assert!(took >= Duration::from_millis(1500) && took < Duration::from_secs(5), "{took:?}");
        std::thread::sleep(Duration::from_millis(300));
        assert!(w.turns.test_agents().running().is_empty(), "the hung cursor-agent was left running");
    }

    #[test]
    fn a_failed_cursor_turn_reports_why() {
        let w = world();
        let parent = w.session("terminal", "shell", "full");
        let (id, _) = w.cursor(&parent, "FAIL", None);
        let out = w.wait(&parent, &id, json!({}));
        assert_eq!(
            (out["sessions"][0]["event"].clone(), out["sessions"][0]["outcome"].clone()),
            (json!("error"), json!("boom")),
            "{out}"
        );
    }

    /// A child from before ACP: migration 27 dropped the `-p` chat it cannot
    /// load, and its next turn starts a new conversation with a note. One
    /// whose conversation is gone for another reason says so and starts anew.
    #[test]
    fn a_cursor_child_from_before_acp_starts_a_new_conversation_with_a_note() {
        let w = world();
        let parent = w.session("terminal", "shell", "full");
        let (id, log) = w.cursor(&parent, "first", None);
        w.wait(&parent, &id, json!({}));
        w.settle(&id);
        crate::session::set_provider_session(w.turns.store(), id.clone(), "4496282a-p-chat".into()).unwrap();
        w.turns.store().with(|conn| crate::store::cursor_children_to_acp(conn)).unwrap();
        assert_eq!(w.row(&id).provider_session_id, None);

        w.call(&parent, "send_message", json!({ "to": id, "text": "second" })).expect("send");
        assert_eq!(w.wait(&parent, &id, json!({}))["sessions"][0]["report"], "report: second");
        assert!(sent(&log, "session/load").is_empty(), "it tried the old chat");
        let second = sent(&log, "session/prompt")[1]["prompt"][0]["text"].as_str().unwrap().to_string();
        assert!(second.contains("is delivered to"), "a new conversation gets the persona: {second}");
        let notes = |w: &World| {
            let (blocks, _) = w.turns.transcripts().since(&id, 0);
            blocks.iter().filter(|block| block.text == crate::turns::CURSOR_ACP_NOTE).count()
        };
        assert_eq!(notes(&w), 1);

        // Later turns load the new conversation, and say nothing more.
        w.settle(&id);
        w.turns.release(&id);
        w.call(&parent, "send_message", json!({ "to": id, "text": "third" })).expect("send");
        assert_eq!(w.wait(&parent, &id, json!({}))["sessions"][0]["report"], "report: third");
        assert_eq!(sent(&log, "session/load").len(), 1);
        assert_eq!(notes(&w), 1);

        // A conversation cursor no longer has.
        w.settle(&id);
        crate::session::set_provider_session(w.turns.store(), id.clone(), "gone".into()).unwrap();
        w.call(&parent, "send_message", json!({ "to": id, "text": "fourth" })).expect("send");
        assert_eq!(w.wait(&parent, &id, json!({}))["sessions"][0]["report"], "report: fourth");
        let read = w.call(&parent, "read_session", json!({ "session": id })).expect("read");
        assert!(read["text"].as_str().unwrap().contains("Cursor could not load this session's conversation"), "{read}");
        assert_ne!(w.row(&id).provider_session_id.as_deref(), Some("gone"));
    }

    /// Claude carries on by itself when a command it backgrounded ends, with
    /// a second result. The child's report is what it says then.
    #[test]
    fn a_claude_session_turn_waits_for_what_it_left_running_in_the_background() {
        let w = world();
        w.turns.override_binary("claude", fake_claude(&w.dir));
        let parent = w.session("terminal", "shell", "full");
        let started = w.call(&parent, "delegate", json!({ "provider": "claude", "prompt": "BACKGROUND 0.5" })).expect("start");
        let id = started["id"].as_str().unwrap().to_string();
        let out = w.wait(&parent, &id, json!({}));
        assert_eq!(out["sessions"][0]["report"], "report: BACKGROUND 0.5 + the background command finished", "{out}");
        let read = w.call(&parent, "read_session", json!({ "session": id })).expect("read");
        assert_eq!(read["text"].as_str().unwrap().matches("Turn ended").count(), 1, "{read}");
    }

    /// Until the session's tray lists `count` commands, and that list.
    fn until_background(
        w: &World,
        id: &str,
        check: impl Fn(&crew_protocol::BackgroundList) -> bool,
    ) -> crew_protocol::BackgroundList {
        for _ in 0..400 {
            let list = w.turns.background_list(id);
            if check(&list) {
                return list;
            }
            std::thread::sleep(Duration::from_millis(25));
        }
        panic!("the tray never got there: {:?}", w.turns.background_list(id));
    }

    /// What the call of a subagent shows as its steps, in the transcript.
    fn agent_steps(w: &World, id: &str) -> Vec<(BlockRole, String)> {
        use crew_protocol::ToolDetail;
        let (blocks, _) = w.turns.transcripts().since(id, 0);
        let call =
            blocks.iter().filter_map(|block| block.tool.as_ref()).find(|tool| tool.name == "Agent").expect("the Agent call");
        let Some(ToolDetail::Agent { steps: Some(steps), .. }) = &call.detail else {
            panic!("the Agent call has no steps: {call:?}");
        };
        steps.iter().map(|step| (step.role.clone(), step.text.clone())).collect()
    }

    /// A child's subagent in the background: listed as it works with the
    /// tokens, step and model Claude reports for it, its words among the
    /// steps of its call (`forwardSubagentText`), stopped from the panel with
    /// `stop_task`.
    #[test]
    fn a_claude_childs_background_subagent_is_listed_with_its_tokens_and_stopped_from_the_panel() {
        use crew_protocol::{BackgroundKind, BackgroundState};
        let w = world();
        w.turns.override_binary("claude", fake_claude(&w.dir));
        let parent = w.session("terminal", "shell", "full");
        let started = w.call(&parent, "delegate", json!({ "provider": "claude", "prompt": "AGENT 30" })).expect("start");
        let id = started["id"].as_str().unwrap().to_string();
        let list = until_background(&w, &id, |list| list.waiting);
        let row = &list.commands[0];
        assert_eq!((row.id.as_str(), row.command.as_str()), ("ag1", "Explore the repo"));
        assert_eq!((row.kind, row.state, row.foreground), (BackgroundKind::Subagent, BackgroundState::Running, None));
        assert_eq!((row.stoppable, row.tokens, row.activity.as_deref()), (Some(true), Some(7812), Some("Reading README.md")));
        assert_eq!((row.model.as_deref(), row.window), (Some("fake"), Some(200_000)));
        assert_eq!(row.tool_call_id.as_deref(), Some("toolu_ag1"));
        let steps = agent_steps(&w, &id);
        assert!(steps.contains(&(BlockRole::Assistant, "Looking at README.md".to_string())), "{steps:?}");

        w.turns.background_stop(&id, "ag1").expect("stop");
        let row = w.turns.background_list(&id).commands.into_iter().next().expect("row");
        assert_eq!((row.state, row.activity), (BackgroundState::Stopped, None));
        assert_eq!(row.tokens, Some(7812), "what it had used stays");
        let control = std::fs::read_to_string(w.dir.join("claude-control.log")).unwrap();
        assert!(control.contains("stop_task ag1\n"), "{control}");
        wait_ended(&w, &parent, &id);
    }

    /// A subagent the turn waits on is on the board too, and `stop_task` takes
    /// it the same way (measured on 2.1.295). One that completes says what it
    /// used in all, from the notification and the answer to its call.
    #[test]
    fn a_claude_childs_foreground_subagent_is_listed_stopped_or_left_to_complete() {
        use crew_protocol::BackgroundState;
        let w = world();
        w.turns.override_binary("claude", fake_claude(&w.dir));
        let parent = w.session("terminal", "shell", "full");
        let started = w.call(&parent, "delegate", json!({ "provider": "claude", "prompt": "AGENTFG 30" })).expect("start");
        let id = started["id"].as_str().unwrap().to_string();
        let list = until_background(&w, &id, |list| list.commands.first().is_some_and(|row| row.tokens.is_some()));
        let row = &list.commands[0];
        assert_eq!(
            (row.state, row.foreground, row.stoppable, row.stop_note.as_deref()),
            (BackgroundState::Running, Some(true), Some(true), None)
        );
        assert!(!list.waiting, "the turn is not held on it: it is running");
        w.turns.background_stop(&id, "ag1").expect("stop");
        let out = wait_ended(&w, &parent, &id);
        assert_eq!(out["sessions"][0]["report"], "report: AGENTFG 30", "{out}");
        let row = &w.turns.background_list(&id).commands[0];
        assert_eq!((row.state, row.stop_note.as_deref()), (BackgroundState::Stopped, None));
        let control = std::fs::read_to_string(w.dir.join("claude-control.log")).unwrap();
        assert!(control.contains("stop_task ag1\n"), "{control}");

        w.settle(&id);
        w.call(&parent, "send_message", json!({ "to": id, "text": "AGENTFG 0.3" })).expect("send");
        w.wait(&parent, &id, json!({}));
        let list = w.turns.background_list(&id);
        let row = list.commands.iter().find(|row| row.id == "ag2").expect("the second subagent");
        assert_eq!((row.state, row.tokens, row.model.as_deref()), (BackgroundState::Completed, Some(8382), Some("fake")));
        assert_eq!((row.activity.as_deref(), row.foreground), (None, Some(true)));
    }

    /// A child's command in the background: listed while it runs, its
    /// output read from Claude, stopped from the tray, and kept, ended, once
    /// the turn is over; the next turn still lists it.
    #[test]
    fn a_claude_childs_background_command_is_listed_read_and_stopped() {
        use crew_protocol::{BackgroundKind, BackgroundState};
        let w = world();
        w.turns.override_binary("claude", fake_claude(&w.dir));
        let parent = w.session("terminal", "shell", "full");
        let started = w.call(&parent, "delegate", json!({ "provider": "claude", "prompt": "BACKGROUND 30" })).expect("start");
        let id = started["id"].as_str().unwrap().to_string();
        let list = until_background(&w, &id, |list| list.waiting);
        assert!(list.live);
        let row = &list.commands[0];
        assert_eq!((row.id.as_str(), row.command.as_str()), ("bg1", "sleep 30"));
        assert_eq!((row.kind, row.state), (BackgroundKind::Shell, BackgroundState::Running));
        assert_eq!(row.tool_call_id.as_deref(), Some("toolu_bg"));
        assert_eq!(w.turns.background_output(&id, "bg1").expect("output").output, "tick\n");
        w.turns.background_stop(&id, "bg1").expect("stop");
        assert_eq!(w.turns.background_list(&id).commands[0].state, BackgroundState::Stopped);
        // A task stopped wakes nobody: the turn held on it ends on the result
        // it had, as the stop is answered.
        let out = wait_ended(&w, &parent, &id);
        assert_eq!(out["sessions"][0]["report"], "started it in the background", "{out}");
        // Nothing is left running, so the CLI is kept for the next turn: the
        // row stays, ended, and its output is the last read.
        w.settle(&id);
        let after = until_background(&w, &id, |list| !list.waiting);
        assert!(after.live);
        assert_eq!(after.commands[0].state, BackgroundState::Stopped);
        assert_eq!(w.turns.background_output(&id, "bg1").expect("kept").output, "tick\n");
        assert!(w.turns.background_stop(&id, "bg1").is_ok(), "an ended command needs no stop");
        let control = std::fs::read_to_string(w.dir.join("claude-control.log")).unwrap();
        assert!(control.contains("get_task_output bg1\nstop_task bg1\n"), "{control}");
        // The next turn still lists it.
        w.call(&parent, "send_message", json!({ "to": id, "text": "again" })).expect("send");
        w.wait(&parent, &id, json!({}));
        let next = w.turns.background_list(&id);
        assert_eq!(next.commands.len(), 1, "{next:?}");
        assert_eq!(next.commands[0].state, BackgroundState::Stopped);
    }

    /// The board is the session's, not the turn's: a task of turn one is
    /// listed in turn two on the process the first turn left up, with how it
    /// ended, and no process was launched for it.
    #[test]
    fn a_task_from_turn_one_is_still_listed_in_turn_two_on_the_kept_process() {
        use crew_protocol::BackgroundState;
        let w = world();
        w.turns.override_binary("claude", fake_claude(&w.dir));
        let parent = w.session("terminal", "shell", "full");
        let started = w.call(&parent, "delegate", json!({ "provider": "claude", "prompt": "BACKGROUND 0.5" })).expect("start");
        let id = started["id"].as_str().unwrap().to_string();
        let log = w.dir.join("claude-launch.log");
        let out = w.wait(&parent, &id, json!({}));
        assert_eq!(out["sessions"][0]["report"], "report: BACKGROUND 0.5 + the background command finished", "{out}");
        w.settle(&id);
        let one = until_background(&w, &id, |list| {
            !list.waiting && list.commands.iter().all(|row| row.state != BackgroundState::Running)
        });
        assert_eq!((one.commands.len(), one.commands[0].state), (1, BackgroundState::Completed));
        assert!(w.turns.idle_since(&id).is_some(), "the process was not kept");

        w.call(&parent, "send_message", json!({ "to": id, "text": "again" })).expect("send");
        assert_eq!(w.wait(&parent, &id, json!({}))["sessions"][0]["report"], "report: again");
        let two = w.turns.background_list(&id);
        assert!(two.live);
        assert_eq!(two.commands, one.commands, "turn two changed what turn one left");
        assert_eq!(launched(&log).len(), 1, "a second process was launched");
    }

    /// A process that dies under work it still ran (here, killed from
    /// outside) takes that work with it: the entries stop, saying so, and stay
    /// listed.
    #[test]
    fn a_claude_process_that_dies_with_work_running_stops_its_entries() {
        use crew_protocol::BackgroundState;
        let w = world();
        w.turns.override_binary("claude", fake_claude(&w.dir));
        let parent = w.session("terminal", "shell", "full");
        let started = w.call(&parent, "delegate", json!({ "provider": "claude", "prompt": "BACKGROUND 60" })).expect("start");
        let id = started["id"].as_str().unwrap().to_string();
        let log = w.dir.join("claude-launch.log");
        let list = until_background(&w, &id, |list| list.waiting);
        assert_eq!(list.commands[0].state, BackgroundState::Running);

        let pid = launched(&log)[0]["pid"].as_u64().expect("pid").to_string();
        std::process::Command::new("kill").args(["-9", pid.as_str()]).status().expect("kill");
        let after = until_background(&w, &id, |list| !list.live);
        let row = &after.commands[0];
        assert_eq!((row.state, row.stop_note.as_deref()), (BackgroundState::Stopped, Some("its CLI exited")));
        assert!(row.ended_at.is_some());
    }

    /// Clearing from the window: the finished entries go, a running one stays,
    /// and the list the window hears is the cleared one.
    #[test]
    fn clearing_a_sessions_background_entries_leaves_what_runs() {
        use crew_protocol::BackgroundState;
        let w = world();
        w.turns.override_binary("claude", fake_claude(&w.dir));
        let heard = Arc::new(Mutex::new(Vec::new()));
        let into = heard.clone();
        w.turns.background().set_listener(Arc::new(move |list| into.lock().unwrap().push(list)));
        let parent = w.session("terminal", "shell", "full");
        let started = w.call(&parent, "delegate", json!({ "provider": "claude", "prompt": "BACKGROUND 30" })).expect("start");
        let id = started["id"].as_str().unwrap().to_string();
        until_background(&w, &id, |list| list.waiting);
        w.turns.background_clear(&id, None, &[]);
        assert_eq!(w.turns.background_list(&id).commands[0].state, BackgroundState::Running, "a running entry was cleared");
        w.turns.background_stop(&id, "bg1").expect("stop");
        w.wait(&parent, &id, json!({}));
        w.settle(&id);
        w.turns.background_clear(&id, Some(&["other".to_string()]), &[]);
        assert_eq!(w.turns.background_list(&id).commands.len(), 1, "an id it does not know cleared something");
        w.turns.background_clear(&id, Some(&["bg1".to_string()]), &[]);
        assert!(w.turns.background_list(&id).commands.is_empty());
        let heard = heard.lock().unwrap();
        let last = heard.iter().rev().find(|list| list.session_id == id).expect("a push");
        assert!(last.commands.is_empty(), "the window was told of the clear: {last:?}");
    }

    /// Esc on a child whose result is held on its background work stops the
    /// turn only: there is no turn in the CLI to interrupt, nothing is told
    /// to stop, and the work runs on in the process the child keeps.
    #[test]
    fn stopping_a_claude_child_held_on_background_work_ends_its_turn_and_spares_the_work() {
        use crew_protocol::BackgroundState;
        let w = world();
        let parent = w.session("terminal", "shell", "full");
        let (id, log) = w.claude(&parent, "BACKGROUND 30");
        until_background(&w, &id, |list| list.waiting);
        w.turns.stop(&id).expect("stop");
        assert_eq!(wait_ended(&w, &parent, &id)["sessions"][0]["outcome"], "stopped");
        w.settle(&id);
        assert!(w.claude_control().is_empty(), "{:?}", w.claude_control());
        let list = w.turns.background_list(&id);
        assert!(list.live, "{list:?}");
        assert_eq!(list.commands[0].state, BackgroundState::Running);
        assert_eq!(w.turns.test_agents().running(), vec![id.clone()]);

        w.call(&parent, "send_message", json!({ "to": id, "text": "again" })).expect("send");
        assert_eq!(w.wait(&parent, &id, json!({}))["sessions"][0]["report"], "report: again");
        assert_eq!(launched(&log).len(), 1);
        w.turns.release(&id);
    }

    /// The readings a session's context meter was told, in order.
    fn context_readings(applied: &crate::turns::Applied) -> Vec<crew_protocol::ContextReading> {
        applied
            .take()
            .into_iter()
            .filter_map(|event| match event {
                crew_protocol::HarnessEvent::ContextUpdated { used, window, auto_compact_at, stale } => {
                    Some(crew_protocol::ContextReading { used, window, auto_compact_at, stale })
                }
                _ => None,
            })
            .collect()
    }

    /// Until the session's merged reading is the one wanted: the window comes
    /// in on a thread of its own, after the turn.
    fn until_context(w: &World, id: &str, want: crew_protocol::ContextReading) {
        for _ in 0..400 {
            if w.turns.context(id).as_ref() == Some(&want) {
                return;
            }
            std::thread::sleep(Duration::from_millis(25));
        }
        panic!("the meter never read {want:?}: {:?}", w.turns.context(id));
    }

    /// Claude's context meter: `used` is what each request of the main agent
    /// filled (input, cache and output), once per message, and the window and
    /// auto-compact point are what `get_context_usage` says. A subagent's
    /// frame and a message said twice move nothing, and none of it is saved
    /// in the transcript.
    #[test]
    fn a_claude_childs_context_is_read_once_per_request_and_never_saved() {
        use crew_protocol::ContextReading;
        let w = world();
        let applied = w.turns.test_capture();
        w.turns.override_binary("claude", fake_claude(&w.dir));
        let parent = w.session("terminal", "shell", "full");
        let started = w.call(&parent, "delegate", json!({ "provider": "claude", "prompt": "SUBAGENT TWICE" })).expect("start");
        let id = started["id"].as_str().unwrap().to_string();
        w.wait(&parent, &id, json!({}));
        w.settle(&id);
        let full = ContextReading { used: 1115, window: Some(200_000), auto_compact_at: Some(160_000), stale: None };
        until_context(&w, &id, full.clone());
        let heard = context_readings(&applied);
        // 1234 is the CLI's own count, which seeds the meter before the first
        // answer; 91115 and 51015 are the subagent's frame and the repeat.
        assert!(!heard.is_empty() && heard.iter().all(|reading| [1234, 1115].contains(&reading.used)), "{heard:?}");
        assert_eq!(heard.last(), Some(&full), "{heard:?}");
        assert!(heard.iter().filter(|reading| reading.used == 1115).count() <= 2, "{heard:?}");
        // A reading without a window kept the window; the next turn's request
        // fills more of it and the same window stays.
        w.call(&parent, "send_message", json!({ "to": id, "text": "again" })).expect("send");
        w.wait(&parent, &id, json!({}));
        w.settle(&id);
        until_context(&w, &id, full);
        // The transcript holds the conversation and no meter.
        w.turns.transcripts().flush(&id);
        let stored = w.turns.store().with(|conn| crate::messages::all(conn, &id)).expect("read back");
        let live = w.turns.transcripts().since(&id, 0).0;
        assert_eq!(stored.len(), live.len());
        assert!(!serde_json::to_string(&stored).unwrap().contains("context"), "{stored:?}");
    }

    /// Codex's meter reads what the newest response held (`last`), never the
    /// thread's running `total`, over the model's window; a reading that names
    /// no window keeps the one before.
    #[test]
    fn a_codex_childs_context_is_the_last_response_not_the_thread_total() {
        use crew_protocol::ContextReading;
        let w = world();
        let applied = w.turns.test_capture();
        let parent = w.session("terminal", "shell", "full");
        let (id, _) = w.codex(&parent, "TOKENS", None);
        w.wait(&parent, &id, json!({}));
        w.settle(&id);
        let heard = context_readings(&applied);
        assert_eq!(
            heard,
            vec![
                ContextReading { used: 5000, window: Some(258_400), auto_compact_at: None, stale: None },
                ContextReading { used: 6000, window: Some(258_400), auto_compact_at: None, stale: None },
            ],
        );
        assert_eq!(w.turns.context(&id), heard.last().cloned());
    }

    /// A Codex command that outlives its call is a background terminal: the
    /// tray lists it from `thread/backgroundTerminals/list`, its output from
    /// the deltas, and Stop terminates it.
    #[test]
    fn a_codex_background_terminal_is_listed_read_and_terminated() {
        use crew_protocol::BackgroundState;
        let w = world();
        let parent = w.session("terminal", "shell", "full");
        let (id, log) = w.codex(&parent, "BGTERM 30", None);
        let list = until_background(&w, &id, |list| !list.commands.is_empty());
        let row = &list.commands[0];
        assert_eq!((row.id.as_str(), row.command.as_str(), row.state), ("exec-bg", "sleep 30", BackgroundState::Running));
        assert_eq!(w.turns.background_output(&id, "exec-bg").expect("output").output, "tick\n");
        w.turns.background_stop(&id, "exec-bg").expect("stop");
        let out = w.wait(&parent, &id, json!({}));
        assert_eq!(out["sessions"][0]["report"], "report: BGTERM 30 + terminal terminated", "{out}");
        let after = until_background(&w, &id, |list| list.commands[0].state == BackgroundState::Stopped);
        assert_eq!((after.commands[0].state, after.commands[0].exit_code), (BackgroundState::Stopped, Some(143)));
        // The child's process is kept for its next turn, and the tray with it;
        // the tray closes when the process is let go.
        w.settle(&id);
        assert!(w.turns.background_list(&id).live);
        w.turns.release(&id);
        assert!(!w.turns.background_list(&id).live);
        let sent = std::fs::read_to_string(log).unwrap();
        assert!(
            sent.contains(r#""method": "thread/backgroundTerminals/terminate", "params": {"processId": "4242", "threadId""#),
            "{sent}"
        );
    }

    /// A child whose turn ended with nothing pinning it is let go once it has
    /// been idle long enough: its process is killed, and the next message
    /// launches another that resumes the conversation.
    #[test]
    fn an_idle_claude_child_is_released_and_the_next_message_resumes_it() {
        let w = world();
        let parent = w.session("terminal", "shell", "full");
        let (id, log) = w.claude(&parent, "remember 4817");
        w.wait(&parent, &id, json!({}));
        w.settle(&id);
        let bound = w.row(&id).provider_session_id.expect("bound");
        std::thread::sleep(Duration::from_millis(5));
        assert_eq!(w.turns.release_idle(Duration::from_millis(1), Duration::from_secs(3600)), vec![id.clone()]);
        assert!(w.turns.test_agents().running().is_empty());
        assert!(w.turns.idle_since(&id).is_none());

        let more = w.call(&parent, "send_message", json!({ "to": id, "text": "what number?" })).expect("send");
        assert_eq!(more["delivery"], "started", "{more}");
        assert_eq!(w.wait(&parent, &id, json!({}))["sessions"][0]["report"], "report: what number?");
        let launches = launched(&log);
        assert_eq!(launches.len(), 2, "{launches:?}");
        assert_eq!(after_flag(&launches[1], "--resume"), Some(bound));
    }

    /// The Codex counterpart: the released app server is launched again, and
    /// the next message resumes the thread it had.
    #[test]
    fn an_idle_codex_child_is_released_and_the_next_message_resumes_its_thread() {
        let w = world();
        let parent = w.session("terminal", "shell", "full");
        let (id, log) = w.codex(&parent, "remember 4817", None);
        w.wait(&parent, &id, json!({}));
        w.settle(&id);
        let bound = w.row(&id).provider_session_id.expect("bound");
        std::thread::sleep(Duration::from_millis(5));
        assert_eq!(w.turns.release_idle(Duration::from_millis(1), Duration::from_secs(3600)), vec![id.clone()]);
        assert!(w.turns.test_agents().running().is_empty());

        let more = w.call(&parent, "send_message", json!({ "to": id, "text": "what number?" })).expect("send");
        assert_eq!(more["delivery"], "started", "{more}");
        assert_eq!(w.wait(&parent, &id, json!({}))["sessions"][0]["report"], "report: what number?");
        assert_eq!(launched(&log).len(), 2);
        let resumed = sent(&log, "thread/resume");
        assert_eq!(resumed.len(), 1, "{resumed:?}");
        assert_eq!(resumed[0]["threadId"], json!(bound));
    }

    /// A background terminal still running pins its child's process: the idle
    /// release leaves it up, and only the pin cap lets it go.
    #[test]
    fn a_child_with_a_background_terminal_running_is_released_only_past_the_pin_cap() {
        use crew_protocol::BackgroundState;
        let w = world();
        let parent = w.session("terminal", "shell", "full");
        let (id, _) = w.codex(&parent, "BGKEEP 30", None);
        w.wait(&parent, &id, json!({}));
        w.settle(&id);
        let list = until_background(&w, &id, |list| !list.commands.is_empty());
        assert_eq!(list.commands[0].state, BackgroundState::Running);
        std::thread::sleep(Duration::from_millis(5));

        assert!(w.turns.release_idle(Duration::from_millis(1), Duration::from_secs(3600)).is_empty());
        assert_eq!(w.turns.test_agents().running(), vec![id.clone()]);
        assert_eq!(w.turns.release_idle(Duration::from_millis(1), Duration::from_millis(1)), vec![id.clone()]);
        assert!(w.turns.test_agents().running().is_empty());
        assert!(!w.turns.background_list(&id).live, "its tray is still open");
    }

    /// The reaper frees a slot by exiting an idle child, but a child that a
    /// background terminal still pins is not idle.
    #[test]
    fn the_reaper_leaves_a_child_whose_background_terminal_still_runs() {
        let w = world();
        let parent = w.session("terminal", "shell", "full");
        let (id, _) = w.codex(&parent, "BGKEEP 30", None);
        w.wait(&parent, &id, json!({}));
        w.settle(&id);
        until_background(&w, &id, |list| !list.commands.is_empty());
        std::thread::sleep(Duration::from_millis(5));
        assert!(w.tools.reap(Duration::from_millis(1)).unwrap().is_empty(), "a pinned child was reaped");
        assert_eq!(w.row(&id).status, "idle");
        assert_eq!(w.turns.test_agents().running(), vec![id.clone()]);
        w.turns.release(&id);
    }

    /// Esc on an idle Claude child stops nothing: its process and its tray
    /// stay, with whatever runs in the background. `stop_session` ends the
    /// child, and closes the tray with its process.
    #[test]
    fn stopping_an_idle_child_from_the_window_keeps_its_tray_and_stop_session_closes_it() {
        let w = world();
        let parent = w.session("terminal", "shell", "full");
        let (kept, _) = w.claude(&parent, "one");
        w.wait(&parent, &kept, json!({}));
        w.settle(&kept);
        assert!(w.turns.background_list(&kept).live, "the kept process's tray is closed");
        w.turns.stop(&kept).expect("stop");
        assert_eq!(w.turns.test_agents().running(), vec![kept.clone()], "the idle process went with the stop");
        assert!(w.turns.background_list(&kept).live, "its tray was closed");
        w.turns.release(&kept);

        let (exited, _) = w.claude(&parent, "two");
        w.wait(&parent, &exited, json!({}));
        w.settle(&exited);
        w.call(&parent, "stop_session", json!({ "session": exited })).expect("stop");
        assert!(!w.turns.background_list(&exited).live, "its tray is still open");
    }

    /// A turn's CLI is installed on the turn's own thread. A message that
    /// arrived before that used to start a second turn on the same session.
    #[test]
    fn a_second_turn_cannot_start_before_the_first_has_its_cli() {
        let w = world();
        let parent = w.session("terminal", "shell", "full");
        let id = w.start(&parent, "SLEEP 1");
        let again = w.turns.start(TurnStart {
            session_id: id.clone(),
            cwd: String::new(),
            text: "at once".into(),
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
        });
        assert!(again.is_err_and(|e| e.contains("already running")));
        w.wait(&parent, &id, json!({}));
        assert_eq!(w.launches().len(), 1, "two turns ran at once");
    }

    #[test]
    fn a_crash_mid_turn_is_an_error_the_wait_returns() {
        let w = world();
        let parent = w.session("terminal", "shell", "full");
        let id = w.start(&parent, "CRASH");
        let out = w.wait(&parent, &id, json!({}));
        let event = &out["sessions"][0];
        assert_eq!(event["event"], "error", "{out}");
        assert_eq!(event["status"], "error");
        assert!(event["outcome"].as_str().unwrap().contains("opencode"), "{event}");
        // The conversation is still there: the next message tries again in it.
        let sent = w.call(&parent, "send_message", json!({ "to": id, "text": "again" })).expect("send");
        assert_eq!(sent["delivery"], "started");
        assert_eq!(w.wait(&parent, &id, json!({}))["sessions"][0]["report"], "report: again");
    }

    #[test]
    fn stopping_mid_turn_exits_and_keeps_the_transcript() {
        let w = world();
        let parent = w.session("terminal", "shell", "full");
        let id = w.start(&parent, "SLEEP 30");
        std::thread::sleep(Duration::from_millis(400));
        let stopped = w.call(&parent, "stop_session", json!({ "session": id })).expect("stop");
        assert_eq!(stopped["status"], "exited", "{stopped}");
        let out = w.wait(&parent, &id, json!({}));
        assert_eq!(out["sessions"][0]["event"], "exited", "{out}");
        let read = w.call(&parent, "read_session", json!({ "session": id })).expect("read");
        let text = read["text"].as_str().unwrap();
        assert!(text.contains("SLEEP 30") && text.contains("Stopped by shell"), "{text}");
        let refused = w.call(&parent, "send_message", json!({ "to": id, "text": "more" }));
        assert!(refused.is_err_and(|e| e.contains("has exited")));
        assert_eq!(w.settle(&id).status, "exited");
    }

    #[test]
    fn stopping_an_idle_session_exits_it_too() {
        let w = world();
        let parent = w.session("terminal", "shell", "full");
        let id = w.start(&parent, "one");
        w.wait(&parent, &id, json!({}));
        w.settle(&id);
        let stopped = w.call(&parent, "stop_session", json!({ "session": id })).expect("stop");
        assert_eq!(stopped["status"], "exited");
        let out = w.wait(&parent, &id, json!({}));
        assert_eq!(out["sessions"][0]["event"], "exited", "{out}");
    }

    #[test]
    fn read_session_reads_from_a_cursor_like_read_logs() {
        let w = world();
        let parent = w.session("terminal", "shell", "full");
        let id = w.start(&parent, "first job");
        let first = w.wait(&parent, &id, json!({}));
        let cursor = first["cursors"][&id].as_i64().unwrap();
        w.settle(&id);
        let all = w.call(&parent, "read_session", json!({ "session": id })).expect("read");
        assert_eq!(all["cursor"], cursor);
        assert_eq!(all["more"], false);
        assert!(all["text"].as_str().unwrap().starts_with("#1 [shell "), "{all}");
        w.call(&parent, "send_message", json!({ "to": id, "text": "second job" })).expect("send");
        w.wait(&parent, &id, json!({}));
        let new = w.call(&parent, "read_session", json!({ "session": id, "since": cursor })).expect("read");
        let text = new["text"].as_str().unwrap();
        assert!(text.contains("second job") && !text.contains("first job"), "{text}");
        assert!(text.starts_with(&format!("#{} ", cursor + 1)), "{text}");
        // A small budget stops early and says there is more.
        let page = w.call(&parent, "read_session", json!({ "session": id, "since": 0, "max_bytes": 10 })).expect("read");
        assert_eq!(page["cursor"], 1);
        assert_eq!(page["more"], true);
    }

    /// A bot's conversation, written straight into its transcript: a tool
    /// call between every pair of messages, as a real turn has.
    fn conversation(w: &World, bot: &Caller, lines: &[&str]) -> String {
        let id = bot.session_id().unwrap().to_string();
        let transcripts = w.turns.transcripts();
        for (n, line) in lines.iter().enumerate() {
            match n % 2 {
                0 => transcripts.append_user(&id, line, false, None, None),
                _ => {
                    transcripts.apply(
                        &id,
                        crew_protocol::HarnessEvent::ToolStarted {
                            call_id: format!("c{n}"),
                            name: "browser_navigate".into(),
                            title: format!("navigate {n}"),
                            detail: None,
                        },
                    );
                    transcripts.apply(
                        &id,
                        crew_protocol::HarnessEvent::ToolUpdated {
                            call_id: format!("c{n}"),
                            title: None,
                            status: Some(ToolStatus::Completed),
                            detail: None,
                        },
                    );
                    transcripts.apply(&id, crew_protocol::HarnessEvent::MessageDelta { text: line.to_string() });
                    transcripts.apply(&id, crew_protocol::HarnessEvent::MessageCompleted {});
                }
            }
        }
        transcripts.flush(&id);
        id
    }

    /// The search answers where each hit is, by the number its line reads
    /// as, and the best one with its neighbours; around scrolls from there.
    #[test]
    fn read_session_finds_a_message_and_reads_around_it() {
        let w = world();
        let bot = w.session("bot", "Home", "full");
        let id = conversation(
            &w,
            &bot,
            &["busca la silla", "La encontré.", "el id del item es 7731942", "Guardado.", "y el precio?", "Son 40 dólares."],
        );
        let found = w.call(&bot, "read_session", json!({ "query": "7731942" })).expect("search");
        let hits = found["hits"].as_array().unwrap();
        assert_eq!(hits.len(), 1, "{found}");
        let at = hits[0]["at"].as_i64().unwrap();
        // Short, so whole; and its number is the one read_session prints.
        assert_eq!(hits[0]["text"], "el id del item es 7731942", "{found}");
        assert_eq!(hits[0]["role"], "user");
        let tail = w.call(&bot, "read_session", json!({ "session": id })).expect("tail");
        assert!(tail["text"].as_str().unwrap().contains(&format!("#{at} [user] el id del item es 7731942")), "{tail}");
        let top = found["top"]["text"].as_str().unwrap();
        assert!(top.contains("La encontré.") && top.contains("Guardado."), "the neighbours: {found}");

        let around = w.call(&bot, "read_session", json!({ "around": at, "window": 1 })).expect("around");
        let text = around["text"].as_str().unwrap();
        assert_eq!(text.lines().count(), 3, "{around}");
        assert!(text.starts_with(&format!("#{} ", at - 1)) && text.contains("7731942"), "{around}");
        assert_eq!(around["start"], at - 2);
        assert_eq!(around["cursor"], at + 1);
        // Filtered to lines that all come after the block asked for, and over
        // budget: the farthest goes first, and the nearest stays.
        let after = json!({ "around": 1, "window": 5, "roles": ["assistant"], "max_bytes": 10 });
        let after = w.call(&bot, "read_session", after).expect("around, filtered");
        assert_eq!(after["text"], "#3 [assistant] La encontré.", "{after}");
        let gone = w.call(&bot, "read_session", json!({ "around": 999 }));
        assert!(gone.is_err_and(|e| e.contains("no block #999")));
    }

    /// A search looks in what was said: tool rows only when asked for.
    #[test]
    fn read_session_searches_what_was_said_unless_asked_for_tools() {
        let w = world();
        let bot = w.session("bot", "Home", "full");
        conversation(&w, &bot, &["abre marketplace", "Abierto."]);
        let said = w.call(&bot, "read_session", json!({ "query": "navigate" })).expect("search");
        assert!(said["hits"].as_array().unwrap().is_empty(), "{said}");
        assert!(said["note"].as_str().unwrap().contains("Nothing matched"), "{said}");
        let tools = w.call(&bot, "read_session", json!({ "query": "navigate", "include_tools": true })).expect("search");
        assert_eq!(tools["hits"][0]["role"], "tool", "{tools}");
        let roles = w.call(&bot, "read_session", json!({ "query": "navigate", "roles": ["tool"] })).expect("search");
        assert_eq!(roles["hits"].as_array().unwrap().len(), 1, "{roles}");
        let wrong = w.call(&bot, "read_session", json!({ "query": "x", "roles": ["robot"] }));
        assert!(wrong.is_err_and(|e| e.contains("roles are some of")));
    }

    /// Without a session a bot searches its own conversation; with one, that
    /// one, as reading does. The user, who has none, searches the workspace.
    #[test]
    fn read_session_searches_where_it_reads() {
        let w = world();
        let home = w.session("bot", "Home", "full");
        let innata = w.session("bot", "Innata", "full");
        conversation(&w, &home, &["el cliente es Acme", "Anotado."]);
        let theirs = conversation(&w, &innata, &["la tarea de octubre es Acme", "Hecho."]);
        let mine = w.call(&home, "read_session", json!({ "query": "Acme" })).expect("search");
        assert_eq!(mine["hits"].as_array().unwrap().len(), 1, "{mine}");
        assert!(mine["hits"][0]["text"].as_str().unwrap().contains("cliente"), "{mine}");
        let other = w.call(&home, "read_session", json!({ "session": theirs, "query": "Acme" })).expect("search");
        assert!(other["hits"][0]["text"].as_str().unwrap().contains("octubre"), "{other}");
        let everyone = w.call(&w.user(), "read_session", json!({ "query": "Acme" })).expect("the user");
        let hits = everyone["hits"].as_array().unwrap();
        assert_eq!(hits.len(), 2, "{everyone}");
        assert!(hits.iter().all(|hit| hit["session"].is_string() && hit["session_name"].is_string()), "{everyone}");
        let nothing = w.call(&w.user(), "read_session", json!({}));
        assert!(nothing.is_err_and(|e| e.contains("session is required")));
    }

    /// days alone reads that period oldest first, and leaves `seen` alone; a
    /// long message is a snippet, not the whole of it.
    #[test]
    fn read_session_reads_a_period_and_snips_a_long_hit() {
        let w = world();
        let bot = w.session("bot", "Innata", "full");
        let long = format!("{} la factura de octubre {}", "antes ".repeat(400), "después ".repeat(400));
        conversation(&w, &bot, &["primero", "Vale.", &long, "Listo."]);
        let period = w.call(&bot, "read_session", json!({ "days": 1 })).expect("period");
        assert!(period["text"].as_str().unwrap().starts_with("#1 [user] primero"), "{period}");
        let found = w.call(&bot, "read_session", json!({ "query": "factura" })).expect("search");
        let text = found["hits"][0]["text"].as_str().unwrap();
        assert!(text.contains("factura") && text.len() < 600, "{text}");
    }

    #[test]
    fn only_whoever_started_a_subagent_drives_it() {
        let w = world();
        let parent = w.session("terminal", "mine", "full");
        let stranger = w.session("terminal", "other", "full");
        let bot = w.session("bot", "Planner", "full");
        let id = w.start(&parent, "SLEEP 1");
        // Stopping is the starter's; reading is anyone's in the workspace.
        for caller in [&stranger, &bot] {
            let out = w.call(caller, "stop_session", json!({ "session": id }));
            assert!(out.is_err_and(|e| e.contains("not by you")));
            assert!(w.call(caller, "read_session", json!({ "session": id })).is_ok());
        }
        // Writing is not driving: anyone with as much autonomy may send it a letter.
        for caller in [&stranger, &bot] {
            let sent = w.call(caller, "send_message", json!({ "to": id, "text": "hi" })).expect("a letter is not driving");
            assert!(matches!(sent["delivery"].as_str(), Some("queued" | "started")), "{sent}");
        }
        // The user may drive it, from the command line, as in the window.
        assert!(w.call(&w.user(), "read_session", json!({ "session": id })).is_ok());
        // A bot and a session of the user's are not subagents to stop.
        let theirs = w.call(&parent, "stop_session", json!({ "session": bot.session_id().unwrap() }));
        assert!(theirs.is_err_and(|e| e.contains("send_message")));
        let shell = w.call(&parent, "stop_session", json!({ "session": stranger.session_id().unwrap() }));
        assert!(shell.is_err_and(|e| e.contains("session of the user's")));
        // Listing is not driving either: someone else's subagent is among the
        // stranger's peers, writable, and the parent's own is too.
        let listed = w.call(&stranger, "list_peers", json!({})).expect("list");
        let seen = listed.as_array().unwrap().iter().find(|row| row["id"] == id).expect("listed to a stranger");
        assert_eq!(
            (seen["parent"].clone(), seen["write"].clone()),
            (json!("mine (terminal ".to_string() + parent.session_id().unwrap() + ")"), json!(true)),
            "{seen}"
        );
        let mine = w.call(&parent, "list_peers", json!({})).expect("list");
        let row = mine.as_array().unwrap().iter().find(|row| row["id"] == id).expect("its child");
        assert_eq!(
            (row["kind"].clone(), row["parent"].clone(), row["write"].clone()),
            (json!("session"), json!("you"), json!(true)),
            "{row}"
        );
        w.settle(&id);
    }

    #[test]
    fn a_subagent_is_offered_neither_the_start_tools_nor_the_driving_ones() {
        let w = world();
        let parent = w.session("terminal", "shell", "full");
        let id = w.start(&parent, "x");
        let child = Caller::from_session(w.row(&id));
        assert_eq!(child.kind(), CallerKind::Child);
        let toolbox = crate::tools::Toolbox::default();
        toolbox.register(Arc::new(catalog_only()));
        let listed = toolbox.visible_names(CallerKind::Child);
        let gone =
            ["read_session", "stop_session", "create_bot", "delegate", "start_session", "start_sessions", "update_session"];
        for name in gone.iter().chain(crate::tools::REMOVED_TOOLS) {
            assert!(!listed.contains(name), "a child is listed {name}");
        }
        for name in ["send_message", "list_peers", "interrupt_session"] {
            assert!(listed.contains(&name), "a child is not listed {name}");
        }
        for parent in [CallerKind::Bot, CallerKind::Terminal, CallerKind::User] {
            let listed = toolbox.visible_names(parent);
            assert!(listed.contains(&"start_session") && listed.contains(&"delegate"), "{parent:?}");
        }
        w.settle(&id);
    }

    /// Decision 28: a subagent works at depth one. A start call that reaches
    /// it anyway answers what to do instead, and makes nothing.
    #[test]
    fn a_subagent_cannot_delegate_or_start_a_session() {
        let w = world();
        w.turns.override_binary("claude", fake_claude(&w.dir));
        w.turns.override_claude_home(w.dir.join("home"));
        let parent = w.session("terminal", "shell", "full");
        let id = w.start(&parent, "x");
        w.settle(&id);
        let kid = Caller::from_session(w.row(&id));
        for (tool, args) in [
            ("delegate", json!({ "provider": "claude", "prompt": "y" })),
            ("start_session", json!({ "provider": "claude", "prompt": "y" })),
            ("start_sessions", json!({ "sessions": [{ "prompt": "y" }] })),
        ] {
            let why = w.call(&kid, tool, args).expect_err("a subagent started one");
            assert!(why.contains("do this yourself, or ask your parent") && why.contains("shell"), "{tool}: {why}");
        }
        assert!(w.live_of(&id).is_empty(), "something was made");

        // One the user started has no parent to ask.
        let top = w.start(&w.user(), "y");
        w.settle(&top);
        let orphan = Caller::from_session(w.row(&top));
        let why = w.call(&orphan, "delegate", json!({ "prompt": "z" })).expect_err("a subagent delegated");
        assert!(why.contains("do this yourself, or ask whoever started you"), "{why}");
    }

    /// Models have confused the words before, so each place a model reads
    /// about sessions says what a bot, a session, a subagent, a message and a
    /// report are, in the same words.
    #[test]
    fn the_words_are_said_wherever_a_model_reads_them() {
        use crate::tools::GLOSSARY;
        let w = world();
        let toolbox = crate::tools::Toolbox::default();
        toolbox.register(Arc::new(catalog_only()));
        let shell = w.session("terminal", "shell", "full");
        let told = crate::tools::instructions(&toolbox, &shell);
        assert!(told.contains(GLOSSARY), "{told}");
        let user = crate::tools::instructions(&toolbox, &Caller::User { workspace_id: None });
        assert_eq!(user.matches(GLOSSARY).count(), 1, "{user}");
        for word in [
            "A bot is",
            "A session is",
            "A subagent is",
            "independent one",
            "A message is",
            "A report is",
            "A subagent works for the session that started it",
        ] {
            assert!(GLOSSARY.contains(word), "{word}: {GLOSSARY}");
        }
        for name in ["delegate", "start_session"] {
            let tool = catalog().into_iter().find(|tool| tool.name == name).unwrap();
            assert!(!tool.description.contains("owner"), "{name}: {}", tool.description);
            assert!(
                tool.description.contains("subagent") || tool.description.contains("separate session"),
                "{name}: {}",
                tool.description
            );
        }
        let start = catalog().into_iter().find(|tool| tool.name == "start_session").unwrap();
        assert!(start.description.contains("Do not use it just because the user said \"subagent\""), "{}", start.description);
        assert!(w.tools.instructions(&shell).is_none(), "the terminal's own text says it already");
        let bot = w.session("bot", "Planner", "full");
        // A bot's prompt is Crew's and says it all: nothing to add until it has subagents.
        assert!(w.tools.instructions(&bot).is_none(), "a bot is told again what its prompt says");
        let told = w.tools.instructions(&Caller::User { workspace_id: None }).unwrap();
        assert!(!told.contains(GLOSSARY) && told.contains("do not use it just because the user said"), "{told}");
        let id = w.start(&shell, "x");
        assert!(w.tools.instructions(&shell).unwrap().contains(&id), "the parent is not reminded of its subagents");
        let child = Caller::from_session(w.row(&id));
        assert!(w.tools.instructions(&child).is_none(), "a child is told about tools it cannot see");
        w.settle(&id);
    }

    /// The catalog alone, for a toolbox that only lists.
    struct CatalogOnly;
    fn catalog_only() -> CatalogOnly {
        CatalogOnly
    }
    impl ToolFamily for CatalogOnly {
        fn catalog(&self) -> Vec<Tool> {
            catalog()
        }
        fn run(&self, _: &Caller, _: &str, _: &Value) -> Result<ToolOutput, String> {
            Err("not here".into())
        }
    }

    #[test]
    fn the_fifth_live_session_is_refused_until_one_stops() {
        let w = world();
        let parent = w.session("terminal", "shell", "full");
        let ids: Vec<String> = (0..LIVE_CAP).map(|n| w.start(&parent, &format!("job {n}"))).collect();
        let fifth = w.call(&parent, "delegate", json!({ "provider": "opencode", "prompt": "one more" }));
        assert!(fifth.is_err_and(|e| e.contains("already have 4 live subagents")), "the cap let a fifth through");
        for id in &ids {
            w.settle(id);
        }
        w.call(&parent, "stop_session", json!({ "session": ids[0] })).expect("stop");
        let id = w.start(&parent, "now there is room");
        w.settle(&id);
        // Another parent has its own four; the user has no cap.
        let other = w.session("terminal", "other", "full");
        w.settle(&w.start(&other, "mine"));
    }

    #[test]
    fn a_session_never_has_more_autonomy_than_whoever_started_it() {
        let w = world();
        let careful = w.session("terminal", "careful", "ask");
        let full = w.call(&careful, "delegate", json!({ "provider": "opencode", "prompt": "x", "autonomy": "full" }));
        assert!(full.is_err_and(|e| e.contains("cannot have full")));
        let id = w.start(&careful, "x");
        assert_eq!(w.row(&id).autonomy, "ask");
        let trusted = w.session("terminal", "trusted", "full");
        let inherits = w.start(&trusted, "y");
        assert_eq!(w.row(&inherits).autonomy, "full");
        let lowered =
            w.call(&trusted, "delegate", json!({ "provider": "opencode", "prompt": "z", "autonomy": "ask" })).expect("start");
        assert_eq!(lowered["autonomy"], "ask");
        for id in [id, inherits, lowered["id"].as_str().unwrap().to_string()] {
            w.settle(&id);
        }
    }

    #[test]
    fn a_new_worktree_is_a_branch_of_its_own() {
        let w = world();
        let parent = w.session("terminal", "shell", "full");
        let out = w
            .call(&parent, "delegate", json!({ "provider": "opencode", "prompt": "x", "worktree": "new", "name": "Fix login" }))
            .expect("start");
        let id = out["id"].as_str().unwrap();
        let tree = w.row(id).worktree.expect("a worktree");
        assert!(tree.contains("crew-fix-login-"), "{tree}");
        assert_eq!(out["worktree"], tree);
        w.settle(id);
        let launches = w.launches();
        assert_eq!(launches.len(), 1);
    }

    #[test]
    fn an_idle_session_is_reaped_and_frees_its_slot() {
        let w = world();
        let parent = w.session("terminal", "shell", "full");
        let id = w.start(&parent, "x");
        w.wait(&parent, &id, json!({}));
        w.settle(&id);
        assert!(w.tools.reap(Duration::from_secs(3600)).unwrap().is_empty(), "a fresh session went");
        std::thread::sleep(Duration::from_millis(30));
        assert_eq!(w.tools.reap(Duration::from_millis(1)).unwrap(), vec![id.clone()]);
        assert_eq!(w.row(&id).status, "exited");
        let out = w.wait(&parent, &id, json!({}));
        assert_eq!(out["sessions"][0]["event"], "exited");
        assert!(out["sessions"][0]["outcome"].as_str().unwrap().contains("idle"));
    }

    impl World {
        /// Until a block from `from` is in `to`'s transcript.
        fn heard(&self, to: &str, from: &str) -> Vec<Block> {
            for _ in 0..200 {
                let blocks = self.turns.transcripts().since(to, 0).0;
                if blocks.iter().any(|b| b.from_bot.as_ref().is_some_and(|f| f.id == from)) {
                    return blocks;
                }
                std::thread::sleep(Duration::from_millis(25));
            }
            panic!("nothing from {from} reached {to}");
        }
    }

    #[test]
    fn a_bot_parent_hears_each_turn_in_its_box_unless_it_already_looked() {
        let w = world();
        let bot = w.session("bot", "Planner", "full");
        let me = bot.session_id().unwrap().to_string();
        let id = w.start(&bot, "x");
        w.settle(&id);
        // The letter woke the bot: its turn ran on it.
        let blocks = w.heard(&me, &id);
        let letter = blocks.iter().find(|b| b.from_bot.as_ref().is_some_and(|f| f.id == id)).expect("no report reached the bot");
        assert_eq!(letter.text, "report: x");
        assert_eq!(letter.letter_kind, Some(crew_protocol::LetterKind::Report));
        w.settle(&me);
        // A report the parent read itself does not come again; a message the
        // child wrote it still does.
        let cursor = w.row(&id).cursor;
        let from = crate::caller::Caller::from_session(w.row(&id)).sender();
        let stale = crate::mailbox::Letter::new(&me, &from, "report: x", crate::mailbox::REPORT, Some(cursor));
        w.turns.store().with(|conn| crate::mailbox::insert(conn, &stale)).unwrap();
        let message = crate::mailbox::enqueue(w.turns.store(), &me, &from, "which branch?").unwrap();
        w.call(&bot, "read_session", json!({ "session": id })).expect("read");
        let left: Vec<String> = crate::mailbox::waiting(w.turns.store(), &me).unwrap().into_iter().map(|l| l.id).collect();
        assert_eq!(left, [message.id]);
    }

    /// A child that goes idle and is reaped, or stopped while idle, has
    /// nothing new for its bot parent: the report of its last turn already
    /// reached it, so the exit wakes no one.
    #[test]
    fn an_idle_child_that_exits_does_not_wake_its_bot_parent() {
        let w = world();
        let bot = w.session("bot", "Planner", "full");
        let me = bot.session_id().unwrap().to_string();
        let reaped = w.start(&bot, "x");
        let stopped = w.start(&bot, "y");
        w.settle(&reaped);
        w.settle(&stopped);
        w.heard(&me, &reaped);
        w.heard(&me, &stopped);
        w.settle(&me);
        let launched = w.launches().len();
        std::thread::sleep(Duration::from_millis(30));
        w.call(&bot, "stop_session", json!({ "session": stopped })).expect("stop");
        assert_eq!(w.tools.reap(Duration::from_millis(1)).unwrap(), vec![reaped.clone()]);
        for id in [&reaped, &stopped] {
            assert_eq!(w.row(id).status, "exited");
        }
        std::thread::sleep(Duration::from_millis(200));
        assert_eq!(crate::mailbox::waiting_count(w.turns.store(), &me).unwrap(), 0, "an exit left a letter");
        assert_eq!(w.launches().len(), launched, "an exit woke the bot");
        let out = w.wait(&bot, &reaped, json!({ "timeout_s": 1 }));
        assert_eq!(out["sessions"][0]["event"], "exited", "{out}");
    }

    /// The prompt the bot's turn was handed: what it read.
    fn prompts(w: &World) -> Vec<String> {
        w.launches().iter().filter_map(|launch| launch["prompt"].as_str().map(str::to_string)).collect()
    }

    /// The report that woke the bot is what it has seen of the child: a wait
    /// afterwards does not hand the same turn out again.
    #[test]
    fn a_report_handed_over_is_not_handed_out_again_by_a_wait() {
        let w = world();
        let bot = w.session("bot", "Planner", "full");
        let me = bot.session_id().unwrap().to_string();
        let id = w.start(&bot, "x");
        w.settle(&id);
        w.heard(&me, &id);
        w.settle(&me);
        assert_eq!(session_events::seen(w.turns.store(), &id).unwrap(), w.row(&id).cursor);
        let out = w.wait(&bot, &id, json!({ "timeout_s": 1 }));
        assert_eq!(out["result"], "nothing-running", "{out}");
        let woke = prompts(&w).into_iter().find(|p| p.contains("## Report from session")).expect("the bot was never woken");
        assert!(woke.contains(&format!("## Report from session {} ({id})\n\nreport: x", w.row(&id).name)), "{woke}");
    }

    /// Reports that land while the bot is busy wait, and the end of its turn
    /// hands them over together: one turn, one section each, each kept in the
    /// transcript under the session that wrote it.
    #[test]
    fn reports_that_land_while_the_bot_is_busy_wake_it_once() {
        let w = world();
        let bot = w.session("bot", "Planner", "full");
        let me = bot.session_id().unwrap().to_string();
        let row = w.row(&me);
        let kids: Vec<Session> = (0..3)
            .map(|n| {
                session::create_child(
                    w.turns.store(),
                    w.workspace.clone(),
                    format!("kid {n}"),
                    "opencode".into(),
                    "m".into(),
                    "full".into(),
                    None,
                    Some(me.clone()),
                )
                .unwrap()
            })
            .collect();
        w.turns
            .start(TurnStart {
                session_id: me.clone(),
                cwd: session::cwd(w.turns.store(), &row).unwrap(),
                text: "SLEEP 1.5".into(),
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
            .expect("busy");
        for (n, kid) in kids.iter().enumerate() {
            let from = crate::caller::Caller::from_session(kid.clone()).sender();
            let cursor = n as i64 + 2;
            let letter =
                crate::mailbox::Letter::new(&me, &from, &format!("kid {n} is done"), crate::mailbox::REPORT, Some(cursor));
            session_events::record_reporting(w.turns.store(), &kid.id, cursor, "turn", "completed", "", None, Some(&letter))
                .unwrap();
            assert!(!w.turns.deliver_to(&row), "a busy bot took a letter mid-turn");
        }
        w.heard(&me, &kids[2].id);
        w.settle(&me);
        let woke: Vec<String> = prompts(&w).into_iter().filter(|p| p.contains("## Report from session")).collect();
        assert_eq!(woke.len(), 1, "{woke:?}");
        assert_eq!(woke[0].matches("## Report from session").count(), 3, "{}", woke[0]);
        for (n, kid) in kids.iter().enumerate() {
            assert!(woke[0].contains(&format!("## Report from session kid {n} ({})\n\nkid {n} is done", kid.id)), "{}", woke[0]);
            assert_eq!(session_events::seen(w.turns.store(), &kid.id).unwrap(), n as i64 + 2);
        }
        let letters: Vec<Block> = w.turns.transcripts().since(&me, 0).0.into_iter().filter(|b| b.from_bot.is_some()).collect();
        let senders: Vec<String> = letters.iter().map(|b| b.from_bot.as_ref().unwrap().id.clone()).collect();
        assert_eq!(senders, kids.iter().map(|k| k.id.clone()).collect::<Vec<_>>());
        assert_eq!(crate::mailbox::waiting_count(w.turns.store(), &me).unwrap(), 0);
        let undelivered: i64 = w
            .turns
            .store()
            .with(|conn| conn.query_row("SELECT COUNT(*) FROM mailbox WHERE delivered_at IS NULL", [], |row| row.get(0)))
            .unwrap();
        assert_eq!(undelivered, 0, "the turn that carried them ended, so they are delivered");
    }

    /// A letter a turn was carrying when the daemon stopped is handed over
    /// again once it is back.
    #[test]
    fn a_letter_a_dead_turn_carried_is_handed_over_again() {
        let w = world();
        let bot = w.session("bot", "Planner", "full");
        let me = bot.session_id().unwrap().to_string();
        let shell = w.session("terminal", "Shell", "full");
        crate::mailbox::enqueue(w.turns.store(), &me, &shell.sender(), "tests pass").unwrap();
        // Claimed by a turn that never ended, as a daemon killed mid-turn leaves it.
        crate::mailbox::claim(w.turns.store(), &me).unwrap().expect("claimed");
        w.turns.deliver_waiting();
        assert!(w.turns.transcripts().since(&me, 0).0.is_empty(), "a claimed letter is not handed over twice while it is");
        // What opening the store does on the way back up.
        w.turns.store().with(crate::mailbox::release_unfinished).unwrap();
        w.turns.deliver_waiting();
        let blocks = w.heard(&me, shell.session_id().unwrap());
        assert!(blocks.iter().any(|b| b.text == "tests pass"));
        w.settle(&me);
    }

    #[test]
    fn a_restart_mid_turn_resumes_the_turn() {
        let w = world();
        let parent = w.session("terminal", "shell", "full");
        let id = w.start(&parent, "first");
        w.wait(&parent, &id, json!({}));
        w.settle(&id);
        // As the daemon leaves it when it stops mid-turn, and the store finds it on opening.
        session::set_status(w.turns.store(), id.clone(), "starting".into()).unwrap();
        w.turns.resume_interrupted();
        let out = w.wait(&parent, &id, json!({}));
        assert_eq!(out["result"], "event", "{out}");
        assert!(out["sessions"][0]["report"].as_str().unwrap().contains("Crew restarted"), "{out}");
        let launches = w.launches();
        let last = launches.last().unwrap();
        assert_eq!(last["resumed"], json!(true), "the turn started over instead of carrying on: {last}");
        assert_eq!(last["session"], launches[0]["session"], "{launches:?}");
        let read = w.call(&parent, "read_session", json!({ "session": id })).expect("read");
        assert!(read["text"].as_str().unwrap().contains("Crew restarted mid-turn"), "{read}");
    }

    // ---------------------------------------------------------------
    // send_message, list_peers, start_session's owner and wait.
    // ---------------------------------------------------------------

    impl World {
        /// A bot turn running for `seconds`, so the bot is busy, as a bot
        /// calling a tool always is.
        fn busy(&self, bot: &Caller, seconds: f32) {
            let me = bot.session_id().unwrap().to_string();
            let row = self.row(&me);
            self.turns
                .start(TurnStart {
                    session_id: me,
                    cwd: session::cwd(self.turns.store(), &row).unwrap(),
                    text: format!("SLEEP {seconds}"),
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
                .expect("busy");
        }

        /// The live subagents of `parent`.
        fn live_of(&self, parent: &str) -> Vec<Session> {
            self.tools.live_children(&self.workspace, parent).expect("live")
        }

        fn peer(&self, caller: &Caller, id: &str) -> Value {
            let peers = self.call(caller, "list_peers", json!({})).expect("peers");
            peers.as_array().unwrap().iter().find(|row| row["id"] == id).cloned().unwrap_or(Value::Null)
        }
    }

    #[test]
    fn a_message_starts_an_idle_bot_and_waits_for_a_busy_one() {
        let w = world();
        let shell = w.session("terminal", "shell", "full");
        let bot = w.session("bot", "Cuddles", "full");
        let to = bot.session_id().unwrap().to_string();
        let sent = w.call(&shell, "send_message", json!({ "to": to, "text": "the branch is green" })).expect("send");
        assert_eq!(sent["delivery"], "started", "{sent}");
        w.heard(&to, shell.session_id().unwrap());
        w.settle(&to);
        let prompt = prompts(&w).into_iter().find(|p| p.contains("the branch is green")).expect("the bot never read it");
        assert!(prompt.contains("## Message\nFrom: shell (terminal "), "{prompt}");

        w.busy(&bot, 1.5);
        let queued = w.call(&shell, "send_message", json!({ "to": to, "text": "when you get a minute" })).expect("send");
        assert_eq!((queued["delivery"].clone(), queued["waiting"].clone()), (json!("queued"), json!(1)), "{queued}");
        // opencode reads a steer at the running turn's next step; what was
        // queued goes as the next turn. The turn has to be in opencode first.
        for _ in 0..200 {
            if prompts(&w).iter().any(|p| p.contains("SLEEP 1.5")) {
                break;
            }
            std::thread::sleep(Duration::from_millis(25));
        }
        let steer = w.call(&shell, "send_message", json!({ "to": to, "text": "and this", "steer": true })).expect("send");
        assert_eq!(steer["delivery"], "steered", "{steer}");
        for _ in 0..200 {
            if prompts(&w).iter().any(|p| p.contains("when you get a minute")) {
                break;
            }
            std::thread::sleep(Duration::from_millis(25));
        }
        // The next turn is what waited, under the tail that holds the steer
        // where the busy turn read it.
        let next = prompts(&w).into_iter().find(|p| p.contains("when you get a minute")).expect("the queue never went over");
        let (tail, this_turn) = next.split_once("## This turn").expect("a tail");
        assert!(tail.contains("] and this\n") && tail.contains("report: SLEEP 1.5 + and this"), "{next}");
        assert!(!this_turn.contains("and this"), "{next}");
        w.settle(&to);
    }

    /// Who may write to whom (decision 11): any bot or session but itself and
    /// an exited subagent, none that has more autonomy than the caller; the
    /// user may write to any.
    #[test]
    fn who_may_write_to_whom() {
        let w = world();
        let shell = w.session("terminal", "shell", "full");
        let other = w.session("terminal", "other", "full");
        let bot = w.session("bot", "Planner", "full");
        let careful = w.session("bot", "Careful", "ask");
        let child = w.start(&shell, "x");
        let top = w.start(&w.user(), "y");
        let chat = w.user_session("opencode", "opencode/nemotron-3.5-lightning-free", "full");
        w.settle(&child);
        w.settle(&top);
        let refused = |caller: &Caller, to: &str, why: &str| {
            let out = w.call(caller, "send_message", json!({ "to": to, "text": "hi" }));
            assert!(out.as_ref().is_err_and(|e| e.contains(why)), "{to}: {out:?}");
        };
        refused(&bot, bot.session_id().unwrap(), "That is you");
        refused(&bot, "Planner", "addressed by id");
        refused(&bot, "Nobody", "list_peers has the ids");
        let missing = w.call(&shell, "send_message", json!({ "to": child }));
        assert!(missing.is_err_and(|e| e.contains("text is required")));
        // The reach is the workspace's: a parent, a stranger, a bot and the
        // user all write to a subagent, to a user's subagent, to a bot and to
        // a session of the user's that is in the chat.
        let delivered = |caller: &Caller, to: &str| {
            let out = w.call(caller, "send_message", json!({ "to": to, "text": "more" })).expect("send");
            assert!(matches!(out["delivery"].as_str(), Some("started" | "queued")), "{to}: {out}");
        };
        delivered(&shell, &child);
        w.settle(&child);
        delivered(&other, &child);
        w.settle(&child);
        delivered(&bot, &child);
        w.settle(&child);
        delivered(&w.user(), &child);
        w.settle(&child);
        delivered(&other, &top);
        w.settle(&top);
        delivered(&other, bot.session_id().unwrap());
        w.settle(bot.session_id().unwrap());
        delivered(&shell, &chat.id);
        w.settle(&chat.id);
        // A subagent writes to its parent's peers, and the parent's peers write to it.
        let kid = Caller::from_session(w.row(&child));
        delivered(&kid, bot.session_id().unwrap());
        w.settle(bot.session_id().unwrap());
        // The one rule: not to a target with more autonomy than the caller has.
        for to in [bot.session_id().unwrap(), child.as_str(), chat.id.as_str()] {
            refused(&careful, to, "allowed more than it is");
        }
        let ask_peer = w.session("bot", "Ask", "ask");
        delivered(&bot, ask_peer.session_id().unwrap());
        delivered(&careful, ask_peer.session_id().unwrap());
        w.settle(ask_peer.session_id().unwrap());
        // The user is exempt, whatever the target runs with.
        delivered(&w.user(), bot.session_id().unwrap());
        w.settle(bot.session_id().unwrap());
        // The listing says the same.
        assert_eq!(w.peer(&shell, &child)["write"], json!(true));
        assert_eq!(w.peer(&other, &child)["write"], json!(true));
        assert_eq!(w.peer(&other, &top)["write"], json!(true));
        assert_eq!(w.peer(&careful, &child)["write"], json!(false));
        assert_eq!(w.peer(&careful, ask_peer.session_id().unwrap())["write"], json!(true));
        assert_eq!(w.peer(&bot, shell.session_id().unwrap())["write"], json!(true));
        assert_eq!(w.peer(&bot, shell.session_id().unwrap())["kind"], "session");
        assert_eq!(
            (w.peer(&bot, &chat.id)["kind"].clone(), w.peer(&bot, &chat.id)["write"].clone()),
            (json!("session"), json!(true))
        );
        assert!(w.peer(&bot, bot.session_id().unwrap()).is_null(), "a caller is not its own peer");
        // An exited subagent takes nothing, and only its parent still lists it.
        w.call(&shell, "stop_session", json!({ "session": child })).expect("stop");
        refused(&shell, &child, "start another with delegate");
        refused(&other, &child, "start another with delegate");
        assert!(w.peer(&other, &child).is_null() && w.peer(&bot, &child).is_null());
        assert_eq!(w.peer(&shell, &child)["status"], "exited");
        assert_eq!(w.peer(&shell, &child)["write"], json!(false));
    }

    /// Decision 12: whoever may write to a subagent waiting on a question may
    /// answer it, the first answer counting; an approval stays with its parent
    /// and the user.
    #[test]
    fn whoever_may_write_may_answer_a_question_and_only_the_parent_decides() {
        let w = world();
        let (fake, _) = crate::turns::fake_codex(&w.dir);
        w.turns.override_binary("codex", fake);
        let shell = w.session("terminal", "shell", "full");
        let stranger = w.session("terminal", "stranger", "full");
        let careful = w.session("terminal", "careful", "ask");
        let asks = w
            .call(&shell, "delegate", json!({ "provider": "codex", "model": "gpt-5.6-luna", "prompt": "QUESTION" }))
            .expect("start");
        let id = asks["id"].as_str().unwrap().to_string();
        until_asking(&w, &id);
        // Less autonomy than the one asking: it may not write, so it may not answer.
        let low = w.call(&careful, "send_message", json!({ "to": id, "text": "Red" }));
        assert!(low.is_err_and(|e| e.contains("allowed more than it is")));
        // An approval is not a stranger's to decide, question or none.
        let decided = w.call(&stranger, "send_message", json!({ "to": id, "decision": "allow" }));
        assert!(decided.is_err_and(|e| e.contains("not a session you started")));
        let asked_at = w.row(&id).cursor;
        let answered = w.call(&stranger, "send_message", json!({ "to": id, "text": "Blue" })).expect("a stranger answers");
        assert_eq!(answered["delivery"], "answered", "{answered}");
        let done = w.wait(&shell, &id, json!({ "since": asked_at }));
        assert_eq!(done["sessions"][0]["report"], r#"report: QUESTION + answers: {"color": {"answers": ["Blue"]}}"#, "{done}");
    }

    /// A bot that waits gets the report back from the call, and only there:
    /// the same report does not also wake it.
    #[test]
    fn a_bot_that_waits_is_handed_the_report_and_not_woken_by_it() {
        let w = world();
        let bot = w.session("bot", "Planner", "full");
        let me = bot.session_id().unwrap().to_string();
        w.busy(&bot, 2.0);
        let out = w
            .call(&bot, "delegate", json!({ "provider": "opencode", "prompt": "find it", "wait": true, "timeout_s": 20 }))
            .expect("start");
        assert_eq!((out["status"].clone(), out["report"].clone()), (json!("reported"), json!("report: find it")), "{out}");
        let id = out["id"].as_str().unwrap().to_string();
        w.settle(&me);
        std::thread::sleep(Duration::from_millis(300));
        w.settle(&me);
        assert!(
            !prompts(&w).iter().any(|p| p.contains("## Report from session")),
            "the report woke the bot as well: {:?}",
            prompts(&w)
        );
        let reports: i64 = w
            .turns
            .store()
            .with(|conn| {
                conn.query_row("SELECT COUNT(*) FROM mailbox WHERE kind = 'report' AND disposed_at IS NULL", [], |row| row.get(0))
            })
            .unwrap();
        assert_eq!(reports, 0, "a report is still on its way");
        assert_eq!(session_events::seen(w.turns.store(), &id).unwrap(), w.row(&id).cursor);
    }

    /// A long report reaches the parent whole, by the wait's result and by the
    /// letter that wakes it: nothing cuts it, and it is not left to read_session.
    #[test]
    fn a_long_report_reaches_the_parent_whole_by_wait_and_by_wake() {
        let long: String = (0..2100).map(|n| format!("w{n:04} ")).collect::<String>().trim_end().to_string();
        assert!(long.len() > 12_000);
        let expected = format!("report: {long}");
        let w = world();
        let bot = w.session("bot", "Planner", "full");
        let out = w
            .call(
                &bot,
                "delegate",
                json!({ "provider": "opencode", "prompt": format!("go\n{long}"), "wait": true, "timeout_s": 20 }),
            )
            .expect("start");
        assert_eq!(out["report"], json!(expected), "the wait cut the report");
        assert!(out.get("report_truncated").is_none(), "{out}");

        let woken = w.session("bot", "Planner 2", "full");
        let me = woken.session_id().unwrap().to_string();
        w.busy(&woken, 0.5);
        let out = w
            .call(
                &woken,
                "delegate",
                json!({ "provider": "opencode", "prompt": format!("SLEEP 2\n{long}"), "wait": true, "timeout_s": 1 }),
            )
            .expect("start");
        assert_eq!(out["status"], "running", "{out}");
        let id = out["id"].as_str().unwrap().to_string();
        w.heard(&me, &id);
        w.settle(&me);
        let woke = prompts(&w)
            .into_iter()
            .find(|p| p.contains("## Report from session") && p.contains("w2099"))
            .expect("never woken with the report");
        assert!(woke.contains(&expected), "the wake cut the report");
    }

    /// A wait that runs out leaves the child working; its report wakes the
    /// bot when it comes.
    #[test]
    fn a_wait_that_runs_out_leaves_the_child_running_and_the_report_wakes_the_bot() {
        let w = world();
        let bot = w.session("bot", "Planner", "full");
        let me = bot.session_id().unwrap().to_string();
        w.busy(&bot, 0.5);
        let out = w
            .call(&bot, "delegate", json!({ "provider": "opencode", "prompt": "SLEEP 2", "wait": true, "timeout_s": 1 }))
            .expect("start");
        assert_eq!(out["status"], "running", "{out}");
        assert!(out["note"].as_str().unwrap().contains("Its report will wake you"), "{out}");
        let id = out["id"].as_str().unwrap().to_string();
        w.heard(&me, &id);
        w.settle(&me);
        let woke = prompts(&w).into_iter().find(|p| p.contains("## Report from session")).expect("never woken");
        assert!(woke.contains("report: SLEEP 2"), "{woke}");
        // A separate session reports to nobody, so there is nothing to wait for.
        let shell = w.session("terminal", "shell", "full");
        let refused = w.call(&shell, "start_session", json!({ "provider": "opencode", "prompt": "x", "wait": true }));
        assert!(refused.is_err_and(|e| e.contains("nothing to wait for")));
        let refused = w.call(&shell, "start_session", json!({ "provider": "opencode", "prompt": "x", "timeout_s": 5 }));
        assert!(refused.is_err_and(|e| e.contains("does not wait")));
    }

    /// A child's question ends a wait early; send_message answers it, and
    /// the window's card, coming second, is told it was already answered.
    #[test]
    fn a_question_ends_the_wait_and_send_message_answers_it() {
        let w = world();
        let (fake, _) = crate::turns::fake_codex(&w.dir);
        w.turns.override_binary("codex", fake);
        let shell = w.session("terminal", "shell", "full");
        let out = w
            .call(
                &shell,
                "delegate",
                json!({ "provider": "codex", "model": "gpt-5.6-luna", "prompt": "QUESTION", "wait": true, "timeout_s": 20 }),
            )
            .expect("start");
        assert_eq!(out["status"], "question", "{out}");
        assert_eq!(out["questions"][0]["question"], "Which color?", "{out}");
        let id = out["id"].as_str().unwrap().to_string();
        assert_eq!(w.peer(&shell, &id)["status"], "question");
        let read = w.call(&shell, "read_session", json!({ "session": id })).expect("read");
        assert_eq!(read["status"], "question", "{read}");
        assert!(read["note"].as_str().unwrap().contains("send_message"), "{read}");
        let request = session_events::latest(w.turns.store(), &id).unwrap().unwrap().request.unwrap();
        let too_many = w.call(&shell, "send_message", json!({ "to": id, "answers": ["Blue", "Red"] }));
        assert!(too_many.is_err_and(|e| e.contains("one per question")));
        let answered = w.call(&shell, "send_message", json!({ "to": id, "text": "Blue" })).expect("answer");
        assert_eq!(answered["delivery"], "answered", "{answered}");
        let late = w.turns.answer(
            &id,
            request["request_id"].as_u64().unwrap(),
            Some(HashMap::from([("Which color?".into(), "Red".into())])),
        );
        assert!(late.is_err_and(|e| e.contains("already answered")));
        let done = w.wait(&shell, &id, json!({}));
        assert_eq!(done["sessions"][0]["report"], r#"report: QUESTION + answers: {"color": {"answers": ["Blue"]}}"#, "{done}");
    }

    /// A child's question wakes its bot parent, with the question and its
    /// options.
    #[test]
    fn a_question_wakes_the_bot_parent() {
        let w = world();
        let (fake, _) = crate::turns::fake_codex(&w.dir);
        w.turns.override_binary("codex", fake);
        let bot = w.session("bot", "Planner", "full");
        let me = bot.session_id().unwrap().to_string();
        let asks = w
            .call(&bot, "delegate", json!({ "provider": "codex", "model": "gpt-5.6-luna", "prompt": "QUESTION" }))
            .expect("start");
        let id = asks["id"].as_str().unwrap().to_string();
        w.heard(&me, &id);
        w.settle(&me);
        let woke = prompts(&w).into_iter().find(|p| p.contains("## Question from session")).expect("the bot was never asked");
        assert!(
            woke.contains(&format!(
                "## Question from session {} ({id})\n\n1. Which color?\n   Options: Red (Choose red.); Blue (Choose blue.)",
                w.row(&id).name
            )),
            "{woke}"
        );
        assert!(woke.contains(&format!("send_message to {id}")), "{woke}");
        assert!(!woke.contains("respond_to_session"), "{woke}");
        assert_eq!(w.call(&bot, "send_message", json!({ "to": id, "text": "Blue" })).expect("answer")["delivery"], "answered");
        w.settle(&id);
        w.heard(&me, &id);
        w.settle(&me);
    }

    /// Until the session waits on something.
    fn until_asking(w: &World, id: &str) {
        for _ in 0..400 {
            if w.row(id).status == "needs-input" {
                break;
            }
            std::thread::sleep(Duration::from_millis(25));
        }
        assert_eq!(w.row(id).status, "needs-input", "{id} never asked");
        std::thread::sleep(Duration::from_millis(200));
    }

    fn letters_from(w: &World, id: &str, kind: &str) -> i64 {
        w.turns
            .store()
            .with(|conn| {
                conn.query_row("SELECT COUNT(*) FROM mailbox WHERE from_session = ?1 AND kind = ?2", [id, kind], |row| row.get(0))
            })
            .unwrap()
    }

    /// An approval of an ask child wakes a bot parent on full autonomy with
    /// what it wants to run and why; the parent allows it with send_message,
    /// the child carries on, the transcript says who decided, and the
    /// window's card, coming second, is told it was already answered.
    #[test]
    fn an_approval_wakes_a_full_bot_parent_which_decides_it() {
        let w = world();
        let bot = w.session("bot", "Lead", "full");
        let me = bot.session_id().unwrap().to_string();
        let (id, _) = w.codex(&bot, "ASK", Some("ask"));
        until_asking(&w, &id);
        assert_eq!(w.peer(&bot, &id)["status"], "approval");
        let read = w.call(&bot, "read_session", json!({ "session": id })).expect("read");
        assert_eq!(read["status"], "approval", "{read}");
        assert!(read["note"].as_str().unwrap().contains("decision"), "{read}");
        w.heard(&me, &id);
        w.settle(&me);
        let woke = prompts(&w).into_iter().find(|p| p.contains("## Approval from session")).expect("the bot was never asked");
        assert!(
            woke.contains(&format!("## Approval from session {} ({id})\n\nIt wants to use bash: ", w.row(&id).name)),
            "{woke}"
        );
        assert!(woke.contains("Why: outside the workspace"), "{woke}");
        assert!(woke.contains(&format!("{{\"to\": \"{id}\", \"decision\": \"allow\"}}")), "{woke}");
        let request = session_events::latest(w.turns.store(), &id).unwrap().unwrap().request.unwrap();
        let bad = w.call(&bot, "send_message", json!({ "to": id, "decision": "maybe" }));
        assert!(bad.is_err_and(|e| e.contains("allow or deny")));
        let decided = w.call(&bot, "send_message", json!({ "to": id, "decision": "allow" })).expect("allow");
        assert_eq!(decided["delivery"], "answered", "{decided}");
        let late = w.turns.respond(&id, request["request_id"].as_u64().unwrap(), ApprovalDecision::Deny);
        assert!(late.is_err_and(|e| e.contains("already answered")));
        let again = w.call(&bot, "send_message", json!({ "to": id, "decision": "deny" }));
        assert!(again.is_err_and(|e| e.contains("not waiting on an approval")));
        let done = w.wait(&bot, &id, json!({}));
        assert_eq!(done["sessions"][0]["report"], "report: ASK + decision: accept", "{done}");
        let (blocks, _) = w.turns.transcripts().since(&id, 0);
        assert!(blocks.iter().any(|block| block.text.contains("Lead allowed: ")), "no note of who decided");
        w.settle(&me);
    }

    /// A parent that would have to ask for the same thing itself is not
    /// asked: no letter, its decision is refused, and the card is the user's.
    #[test]
    fn an_approval_stays_with_the_user_when_the_parent_could_not_do_it_itself() {
        let w = world();
        let bot = w.session("bot", "Careful", "edits");
        let (id, _) = w.codex(&bot, "ASK", Some("ask"));
        until_asking(&w, &id);
        assert_eq!(w.peer(&bot, &id)["status"], "waiting_for_user");
        assert_eq!(w.call(&bot, "read_session", json!({ "session": id })).expect("read")["status"], "waiting_for_user");
        assert_eq!(letters_from(&w, &id, "approval"), 0, "an approval wrote to a parent that could not decide it");
        let refused = w.call(&bot, "send_message", json!({ "to": id, "decision": "allow" }));
        assert!(refused.is_err_and(|e| e.contains("Your autonomy is edits") && e.contains("user")));
        // A message to it waits for its turn; it is not taken for a decision.
        let sent = w.call(&bot, "send_message", json!({ "to": id, "text": "later" })).expect("send");
        assert_eq!(sent["delivery"], "queued", "{sent}");
        // A terminal parent is never asked either.
        let shell = w.session("terminal", "shell", "full");
        let (theirs, _) = w.codex(&shell, "ASK", Some("ask"));
        until_asking(&w, &theirs);
        assert_eq!(w.peer(&shell, &theirs)["status"], "waiting_for_user");
        let refused = w.call(&shell, "send_message", json!({ "to": theirs, "decision": "allow" }));
        assert!(refused.is_err_and(|e| e.contains("are the user's")));
        // The user decides both from the card.
        for child in [&id, &theirs] {
            let request = session_events::latest(w.turns.store(), child).unwrap().unwrap().request.unwrap();
            w.turns.respond(child, request["request_id"].as_u64().unwrap(), ApprovalDecision::Deny).expect("deny");
            w.settle(child);
        }
        w.settle(bot.session_id().unwrap());
    }

    /// A process an ask child defines is an approval like any other: it
    /// wakes a full bot parent, whose decision accepts it as the user's card
    /// would.
    #[test]
    fn a_process_an_ask_child_defines_is_decided_by_its_parent() {
        let w = world();
        let pty = crate::pty::PtyHost::new();
        let processes = crate::process::ProcessHost::with_config(
            w.turns.store().clone(),
            pty.clone(),
            &w.dir,
            crate::process::ProcessConfig::default(),
        );
        let tools = SessionTools::new(w.turns.clone(), Arc::new(|_: &Session| {})).with_processes(processes.clone());
        let family =
            crate::process_tools::ProcessTools::new(processes.clone(), w.turns.store().clone()).with_turns(w.turns.clone());
        let bot = w.session("bot", "Lead", "full");
        let me = bot.session_id().unwrap().to_string();
        let started =
            w.call(&bot, "delegate", json!({ "provider": "opencode", "prompt": "x", "autonomy": "ask" })).expect("start");
        let id = started["id"].as_str().unwrap().to_string();
        w.settle(&id);
        w.heard(&me, &id);
        w.settle(&me);
        let child = Caller::from_session(w.row(&id));
        let saved = match family.run(&child, "save_process", &json!({ "name": "web", "command": "npm run dev" })).expect("save") {
            ToolOutput::Value(value) => value,
            ToolOutput::Content(_) => panic!("content"),
        };
        assert!(saved["pending_approval"].as_str().unwrap().contains("Lead"), "{saved}");
        for _ in 0..200 {
            if prompts(&w).iter().any(|p| p.contains("## Approval from session")) {
                break;
            }
            std::thread::sleep(Duration::from_millis(25));
        }
        let woke = prompts(&w).into_iter().find(|p| p.contains("## Approval from session")).expect("the bot was never asked");
        assert!(woke.contains("It defined the process \"web\"") && woke.contains("command: npm run dev"), "{woke}");
        w.settle(&me);
        let run = |caller: &Caller, args: Value| match tools.run(caller, "send_message", &args) {
            Ok(ToolOutput::Value(value)) => Ok(value),
            Ok(ToolOutput::Content(_)) => Err("content".to_string()),
            Err(error) => Err(error),
        };
        let decided = run(&bot, json!({ "to": id, "decision": "allow" })).expect("allow");
        assert_eq!(decided["delivery"], "answered", "{decided}");
        assert!(processes.get(&w.workspace, "web").unwrap().approved);
        let again = run(&bot, json!({ "to": id, "decision": "allow" }));
        assert!(again.is_err_and(|e| e.contains("not waiting on an approval")));
        processes.shutdown();
        pty.kill_all();
    }

    /// A parent waiting on its child with wait: true is handed the approval
    /// it may decide, rather than sitting on it until the timeout.
    #[test]
    fn a_wait_returns_early_on_an_approval_the_parent_may_decide() {
        let w = world();
        let (fake, _) = crate::turns::fake_codex(&w.dir);
        w.turns.override_binary("codex", fake);
        let bot = w.session("bot", "Lead", "full");
        let out = w
            .call(&bot, "delegate", json!({ "provider": "codex", "model": "gpt-5.6-luna", "prompt": "ASK", "autonomy": "ask", "wait": true, "timeout_s": 20 }))
            .expect("start");
        assert_eq!(out["status"], "approval", "{out}");
        assert!(out["approval"].as_str().unwrap().contains("touch asked.txt"), "{out}");
        let id = out["id"].as_str().unwrap().to_string();
        assert_eq!(w.call(&bot, "send_message", json!({ "to": id, "decision": "deny" })).expect("deny")["delivery"], "answered");
        let done = w.wait(&bot, &id, json!({}));
        assert_eq!(done["sessions"][0]["report"], "report: ASK + decision: decline", "{done}");
        w.settle(bot.session_id().unwrap());
    }

    /// Decisions 6 to 8: `start_session` makes a top-level session in the chat
    /// view, fixed at creation, that is the user's: nobody's child, not capped,
    /// not reaped, owed no report. It records who launched it, and its first
    /// prompt arrives in an envelope that names the launcher.
    #[test]
    fn start_session_makes_a_top_level_chat_session_that_reports_to_nobody() {
        let w = world();
        w.turns.override_binary("claude", fake_claude(&w.dir));
        w.turns.override_claude_home(w.dir.join("home"));
        let bot = w.session("bot", "Lead", "full");
        let me = bot.session_id().unwrap().to_string();
        let out = w
            .call(&bot, "start_session", json!({ "provider": "claude", "prompt": "Carry on with the plan: step 2.", "worktree": "new", "name": "Auth refactor" }))
            .expect("start");
        assert_eq!((out["kind"].clone(), out["status"].clone()), (json!("session"), json!("starting")), "{out}");
        assert!(out["note"].as_str().unwrap().contains("reports to nobody"), "{out}");
        let id = out["id"].as_str().unwrap().to_string();
        let row = w.row(&id);
        assert_eq!((row.kind.as_str(), row.parent_id.as_deref()), ("terminal", None));
        assert_eq!(row.launched_by.as_deref(), Some(me.as_str()));
        assert!(row.worktree.as_deref().is_some_and(|tree| tree.contains("crew-auth-refactor-")), "{row:?}");
        assert_eq!(out["worktree"], json!(row.worktree));
        assert!(w.made.lock().unwrap().contains(&id), "the window was not told");
        w.settle(&id);

        // The first prompt is a message from the launcher, in the envelope that names it.
        let first = w.claude_inputs().into_iter().next().expect("the CLI was never handed a prompt");
        assert!(first[0].1.starts_with(&format!("## Message\nFrom: Lead (bot {me}), a model")), "{first:?}");
        assert!(first[0].1.contains(&format!("Reply with `send_message` to `{me}`")), "{first:?}");
        assert!(first[0].1.trim_end().ends_with("Carry on with the plan: step 2."), "{first:?}");
        let said = w.blocks(&id).into_iter().find(|block| block.role == BlockRole::User).expect("the prompt");
        assert_eq!(said.text, "Carry on with the plan: step 2.");
        assert_eq!(said.from_bot.map(|from| from.id), Some(me.clone()));
        // The prompt is the session's first letter, from the bot that started it.
        assert_eq!(said.letter_kind, Some(crew_protocol::LetterKind::Started));

        // Listed for what it is, and the launcher's chat says it started it.
        let peer = w.peer(&bot, &id);
        assert_eq!(
            (peer["kind"].clone(), peer["launched_by"].clone(), peer["write"].clone()),
            (json!("session"), json!("you"), json!(true)),
            "{peer}"
        );
        assert!(peer.get("parent").is_none(), "{peer}");
        let blocks = w.turns.transcripts().since(&me, 0).0;
        assert!(blocks.iter().any(|b| b.text.contains(&format!("Started session Auth refactor ({id})"))), "{blocks:?}");

        // It reports to nobody, and launching grants nothing: no report, no
        // event, no stopping it (reading is open to anyone in the workspace).
        assert_eq!(letters_from(&w, &id, "report"), 0);
        assert_eq!(mailbox::waiting_count(w.turns.store(), &me).unwrap(), 0);
        assert!(session_events::latest(w.turns.store(), &id).unwrap().is_none());
        let out = w.call(&bot, "stop_session", json!({ "session": id }));
        assert!(out.is_err_and(|e| e.contains("session of the user's")));
        assert_eq!(session_events::seen(w.turns.store(), &id).unwrap(), 0);
        w.call(&bot, "read_session", json!({ "session": id })).expect("read");
        assert_eq!(session_events::seen(w.turns.store(), &id).unwrap(), 0, "a launcher's read moved seen");
        // The user has it in their chat like any session of theirs.
        assert_eq!(w.say(&w.row(&id), "and then?").status, "done");
    }

    /// Decisions 1 and 6: no `owner`, no wait; and a separate session is not
    /// capped, not counted against anyone, and not reaped when idle.
    #[test]
    fn independent_sessions_are_not_capped_not_counted_and_not_reaped() {
        let w = world();
        w.turns.override_binary("claude", fake_claude(&w.dir));
        w.turns.override_claude_home(w.dir.join("home"));
        let shell = w.session("terminal", "shell", "full");
        for tool in ["delegate", "start_session"] {
            let out = w.call(&shell, tool, json!({ "provider": "claude", "prompt": "x", "owner": "user" }));
            assert!(out.is_err_and(|e| e.contains("owner is gone")), "{tool}");
        }
        let ids: Vec<String> = (0..=LIVE_CAP)
            .map(|n| {
                let out = w
                    .call(&shell, "start_session", json!({ "provider": "claude", "prompt": format!("job {n}") }))
                    .expect("start");
                out["id"].as_str().unwrap().to_string()
            })
            .collect();
        for id in &ids {
            w.settle(id);
        }
        assert_eq!(ids.len(), LIVE_CAP + 1);
        assert!(w.live_of(shell.session_id().unwrap()).is_empty(), "a session of the user's counted against its launcher");
        // The cap still holds for subagents beside them.
        let subagents: Vec<String> = (0..LIVE_CAP).map(|n| w.start(&shell, &format!("sub {n}"))).collect();
        assert!(w.call(&shell, "delegate", json!({ "provider": "opencode", "prompt": "one more" })).is_err());
        for id in subagents.iter().chain(&ids) {
            w.settle(id);
        }
        let gone = w.tools.reap(Duration::ZERO).expect("reap");
        assert!(ids.iter().all(|id| !gone.contains(id)), "an independent session was reaped: {gone:?}");
        assert!(ids.iter().all(|id| w.row(id).status != "exited"));
        // A fifth subagent started, and a session started by one the cap forbade, are not the same thing.
        w.call(&shell, "start_session", json!({ "provider": "claude", "prompt": "and another" })).expect("still open");
    }

    /// Decision 3: a report goes to whoever started the turn. The parent's
    /// prompt and messages report to it; a turn the user starts by writing in
    /// the subagent's tab reports only to the user.
    #[test]
    fn a_report_goes_to_whoever_started_the_turn() {
        let w = world();
        let bot = w.session("bot", "Lead", "full");
        let me = bot.session_id().unwrap().to_string();
        let child = w.start(&bot, "x");
        w.settle(&child);
        until("the first report", || letters_from(&w, &child, "report") == 1);
        w.heard(&me, &child);
        w.settle(&me);

        let before = w.row(&child).cursor;
        w.type_to(&w.row(&child), "use the new client", None, None);
        w.settle(&child);
        until("the user's turn to be written as an event", || w.row(&child).cursor > before);
        std::thread::sleep(Duration::from_millis(300));
        assert_eq!(letters_from(&w, &child, "report"), 1, "the user's turn was reported to the parent");
        assert!(mailbox::waiting(w.turns.store(), &me).unwrap().is_empty());
        // The event is still there for a wait that wants it.
        assert_eq!(session_events::latest(w.turns.store(), &child).unwrap().unwrap().kind, "turn");

        // The parent writes to it, and that turn is the parent's.
        w.call(&bot, "send_message", json!({ "to": child, "text": "and the signup" })).expect("send");
        w.settle(&child);
        until("the parent's turn to be reported", || letters_from(&w, &child, "report") == 2);
    }

    /// Decision 13: a steer and a turn read one envelope: the sender's name and
    /// id, that a model wrote it, how to reply and that no reply is needed.
    /// Only the time a waiting letter was written differs.
    #[test]
    fn a_steer_and_a_turn_read_the_same_envelope() {
        let w = world();
        let parent = w.session("terminal", "shell", "full");
        let id = w.start(&parent, "one");
        w.wait(&parent, &id, json!({}));
        let from = crew_protocol::BotRef { id: "s1".into(), name: "Sender".into(), kind: Some("session".into()) };
        let steer = w.turns.steer_text(&id, &from, "look at the diff");
        let letter = mailbox::Letter::new(&id, &from, "look at the diff", mailbox::MESSAGE, None);
        let turn = mailbox::render(&letter, w.row(&id).parent_id.as_deref());
        let untimed: Vec<&str> = turn.lines().filter(|line| !line.starts_with("At: ")).collect();
        assert_eq!(steer, untimed.join("\n"));
        for said in ["From: Sender (session s1), a model", "Reply with `send_message` to `s1`", "No reply is needed"] {
            assert!(steer.contains(said), "{said}: {steer}");
        }
        // The parent's own, which answers by its report.
        let from_parent = crate::caller::Caller::from_session(w.row(parent.session_id().unwrap())).sender();
        let steered = w.turns.steer_text(&id, &from_parent, "more");
        assert!(steered.contains("your report at the end of this turn reaches it"), "{steered}");
    }

    #[test]
    fn autonomy_is_never_above_the_callers() {
        let w = world();
        let edits = w.session("terminal", "edits", "edits");
        let auto = w.call(&edits, "delegate", json!({ "provider": "opencode", "prompt": "x", "autonomy": "auto" }));
        assert!(auto.is_err_and(|e| e.contains("Your autonomy is edits, so a session you start cannot have auto")));
        let odd = w.call(&edits, "delegate", json!({ "provider": "opencode", "prompt": "x", "autonomy": "yolo" }));
        assert!(odd.is_err_and(|e| e.contains("ask, edits, auto or full")));
        for wanted in ["ask", "edits"] {
            let out =
                w.call(&edits, "delegate", json!({ "provider": "opencode", "prompt": "x", "autonomy": wanted })).expect("start");
            assert_eq!(out["autonomy"], wanted);
            w.settle(out["id"].as_str().unwrap());
        }
        let inherits = w.start(&edits, "y");
        assert_eq!(w.row(&inherits).autonomy, "edits");
        w.settle(&inherits);
    }

    /// What a model reads about `send_message` is the same for every session,
    /// and nothing a model reads names a tool that is gone.
    #[test]
    fn what_a_model_reads_names_only_the_tools_there_are() {
        let w = world();
        let toolbox = crate::tools::Toolbox::default();
        toolbox.register(w.tools.clone());
        let shell = w.session("terminal", "shell", "full");
        let bot = w.session("bot", "Planner", "full");
        let host = crate::tools::Host {
            store: w.turns.store(),
            transcripts: w.turns.transcripts(),
            on_created: &|_| {},
            on_routines: &|| {},
            toolbox: &toolbox,
        };
        let listed = crate::tools::handle(&host, &shell, "tools/list", json!({})).expect("list");
        let send = listed["tools"].as_array().unwrap().iter().find(|t| t["name"] == "send_message").expect("send_message");
        let said = send["description"].as_str().unwrap();
        assert!(said.contains("any but yourself and a subagent that has exited") && said.contains("more autonomy"), "{send}");
        assert!(!said.contains("You cannot receive a reply"), "{send}");
        for caller in [&shell, &bot, &w.user()] {
            let said = format!(
                "{}{}",
                crate::tools::handle(&host, caller, "tools/list", json!({})).unwrap(),
                crate::tools::instructions(&toolbox, caller)
            );
            for gone in crate::tools::REMOVED_TOOLS {
                assert!(!said.contains(gone), "{gone}: {said}");
            }
        }
    }

    /// Every letter has one id from the sender's side to the reader's: the
    /// prompt a session was started on, a message, the report back. The
    /// reader's block and the starter's line carry it, and the pair's thread
    /// lists them in the order they were written, both ways.
    #[test]
    fn a_letter_has_one_id_from_its_sender_to_its_reader_and_the_thread() {
        let w = world();
        let bot = w.session("bot", "Lead", "full");
        let me = bot.session_id().unwrap().to_string();
        let started = w
            .call(&bot, "delegate", json!({ "provider": "opencode", "prompt": "fix the login", "name": "Auth" }))
            .expect("start");
        let child = started["id"].as_str().unwrap().to_string();
        let first = started["letter_id"].as_str().expect("start_session names its letter").to_string();
        w.settle(&child);
        w.heard(&me, &child);
        w.settle(&me);
        let sent = w.call(&bot, "send_message", json!({ "to": child, "text": "and the signup" })).expect("send");
        let second = sent["letter_id"].as_str().expect("send_message names its letter").to_string();
        w.settle(&child);
        w.heard(&me, &child);
        w.settle(&me);

        let read: Vec<String> = w
            .turns
            .transcripts()
            .since(&child, 0)
            .0
            .into_iter()
            .filter(|block| block.role == crew_protocol::BlockRole::User)
            .filter_map(|block| block.letter_id)
            .collect();
        assert_eq!(read, [first.clone(), second.clone()]);
        let lead = w.turns.transcripts().since(&me, 0).0;
        let line = lead.iter().find(|block| block.letter_id.as_deref() == Some(first.as_str())).expect("the starter's line");
        assert!(line.text.starts_with("Delegated to subagent Auth"), "{}", line.text);
        // The reports came back as letters too, and the bot's blocks say which.
        let reports: Vec<&Block> = lead.iter().filter(|block| block.from_bot.as_ref().is_some_and(|f| f.id == child)).collect();
        assert_eq!(reports.len(), 2);
        assert!(reports.iter().all(|block| block.letter_id.is_some()));
        assert!(reports.iter().all(|block| block.letter_kind == Some(crew_protocol::LetterKind::Report)));

        let page = mailbox::thread(w.turns.store(), &child, &me, None, None).expect("thread");
        let shape: Vec<(String, &str, &str)> =
            page.letters.iter().map(|letter| (letter.from.id.clone(), letter.kind.as_str(), letter.state.as_str())).collect();
        assert_eq!(
            shape,
            [
                (me.clone(), "message", "delivered"),
                (child.clone(), "report", "delivered"),
                (me.clone(), "message", "delivered"),
                (child.clone(), "report", "delivered"),
            ]
        );
        assert_eq!((page.letters[0].id.as_str(), page.letters[2].id.as_str()), (first.as_str(), second.as_str()));
        assert_eq!((page.letters[0].to.name.as_str(), page.letters[0].to.kind.as_deref()), ("Auth", Some("session")));
        assert!(!page.more);
        let older = mailbox::thread(w.turns.store(), &me, &child, Some(&second), Some(1)).expect("page");
        assert_eq!((older.letters.len(), older.letters[0].kind.as_str(), older.more), (1, "report", true));

        let pairs = mailbox::pairs(w.turns.store(), &me).expect("pairs");
        assert_eq!(pairs.len(), 1);
        assert_eq!((pairs[0].peer.id.as_str(), pairs[0].with.is_none(), pairs[0].count), (child.as_str(), true, 4));
        assert_eq!(pairs[0].last.kind, "report");
        assert!(mailbox::pending(w.turns.store(), &me).expect("pending").is_empty());
    }

    /// The user writing to a bot's child from its chat is a letter too: the
    /// child's block carries it, the parent's chat has a line for it, and the
    /// parent's Conversations list the pair "You ⇄ child".
    #[test]
    fn the_user_writing_to_a_child_is_a_pair_its_parent_sees() {
        let w = world();
        let bot = w.session("bot", "Lead", "full");
        let me = bot.session_id().unwrap().to_string();
        let child = w.start(&bot, "x");
        w.settle(&child);
        w.heard(&me, &child);
        w.settle(&me);
        let row = w.row(&child);
        w.turns
            .start_by_user(TurnStart {
                session_id: child.clone(),
                cwd: session::cwd(w.turns.store(), &row).unwrap(),
                text: "use the new client".into(),
                files: None,
                mentions: None,
                hidden: None,
                from_bot: None,
                sent_at: None,
                nonce: None,
                letter_id: Some("forged".into()),
                mode: None,
                command: None,
                skills: None,
            })
            .expect("start");
        w.settle(&child);
        let block = w
            .turns
            .transcripts()
            .since(&child, 0)
            .0
            .into_iter()
            .rfind(|block| block.role == crew_protocol::BlockRole::User && block.text == "use the new client")
            .expect("the user's block");
        let id = block.letter_id.expect("a letter id");
        assert_ne!(id, "forged", "the window does not pick letter ids");
        assert!(block.from_bot.is_none(), "the user's own words, not a letter's bubble");
        let note = w.turns.transcripts().since(&me, 0).0.into_iter().find(|b| b.letter_id.as_deref() == Some(id.as_str()));
        assert_eq!(note.map(|b| b.text), Some(format!("You wrote to {}", row.name)));

        let pairs = mailbox::pairs(w.turns.store(), &me).expect("pairs");
        let theirs = pairs.iter().find(|pair| pair.with.is_some()).expect("You ⇄ child");
        assert_eq!((theirs.peer.kind.as_deref(), theirs.peer.name.as_str()), (Some("user"), "You"));
        assert_eq!(theirs.with.as_ref().map(|to| to.id.as_str()), Some(child.as_str()));
        let page = mailbox::thread(w.turns.store(), "user", &child, None, None).expect("thread");
        assert_eq!(page.letters.iter().map(|l| l.id.as_str()).collect::<Vec<_>>(), [id.as_str()]);
        assert_eq!(page.letters[0].state, "delivered");
        // From the child's side the user is a pair of its own.
        let mine = mailbox::pairs(w.turns.store(), &child).expect("pairs");
        assert!(mine.iter().any(|pair| pair.peer.kind.as_deref() == Some("user") && pair.with.is_none()));
    }

    /// A steer is a letter claimed by the turn it goes into: delivered once
    /// read, with its id on the block where the model read it.
    #[test]
    fn a_steer_is_a_letter_delivered_where_it_was_read() {
        let w = world();
        w.turns.override_binary("claude", fake_claude(&w.dir));
        let parent = w.session("terminal", "shell", "full");
        let started = w.call(&parent, "delegate", json!({ "provider": "claude", "prompt": "SLEEP 2" })).expect("start");
        let id = started["id"].as_str().unwrap().to_string();
        for _ in 0..400 {
            if w.row(&id).provider_session_id.is_some() {
                break;
            }
            std::thread::sleep(Duration::from_millis(25));
        }
        std::thread::sleep(Duration::from_millis(300));
        let steered = w.call(&parent, "send_message", json!({ "to": id, "text": "and this", "steer": true })).expect("steer");
        assert_eq!(steered["delivery"], "steered", "{steered}");
        let letter = steered["letter_id"].as_str().expect("a letter id").to_string();
        w.settle(&id);
        let block = w.turns.transcripts().since(&id, 0).0.into_iter().find(|b| b.text == "and this").expect("the steer");
        assert_eq!(block.letter_id.as_deref(), Some(letter.as_str()));
        let page = mailbox::thread(w.turns.store(), parent.session_id().unwrap(), &id, None, None).expect("thread");
        let steer = page.letters.iter().find(|l| l.id == letter).expect("in the thread");
        assert_eq!(steer.state, "delivered");
    }

    // ---- The user's own session: a session of the user's, driven by Crew ----

    impl World {
        /// A top-level session, which Crew drives.
        fn user_session(&self, provider: &str, model: &str, autonomy: &str) -> Session {
            session::create(
                self.turns.store(),
                self.workspace.clone(),
                "terminal".into(),
                "mine".into(),
                provider.into(),
                model.into(),
                String::new(),
                autonomy.into(),
            )
            .expect("user session")
        }

        /// What the user types in the window, and the wait for the turn to end.
        fn say(&self, row: &Session, text: &str) -> Session {
            self.type_to(row, text, None, None);
            self.settle(&row.id)
        }

        /// Claude's side of a conversation `id` having been written in the
        /// folder the sessions run in: the CLI's jsonl, under a home of this
        /// test's own.
        fn claude_wrote(&self, id: &str) {
            let home = self.dir.join("home");
            self.turns.override_claude_home(&home);
            let folder = home.join(".claude/projects").join(crate::claude_title::project_slug(&self.dir.to_string_lossy()));
            std::fs::create_dir_all(&folder).expect("folder");
            std::fs::write(folder.join(format!("{id}.jsonl")), "{\"type\":\"user\",\"message\":{\"content\":\"hi\"}}\n")
                .expect("jsonl");
        }

        fn blocks(&self, id: &str) -> Vec<Block> {
            self.turns.transcripts().since(id, 0).0
        }
    }

    /// The user's session is their CLI on Crew's protocol: it keeps one process
    /// across their messages, on the conversation Crew's own id names, and the
    /// status it ends on is the one a session they watch has.
    #[test]
    fn a_users_session_runs_its_turns_on_one_claude_process() {
        let w = world();
        w.turns.override_binary("claude", fake_claude(&w.dir));
        w.turns.override_claude_home(w.dir.join("home"));
        let mine = w.user_session("claude", "", "full");

        let first = w.say(&mine, "remember 4817");
        assert_eq!(first.status, "done");
        assert_eq!(w.turns.test_agents().running(), vec![mine.id.clone()]);
        assert!(w.turns.idle_since(&mine.id).is_some());
        w.say(&mine, "what number?");

        let launches = launched(&w.dir.join("claude-launch.log"));
        assert_eq!(launches.len(), 1, "{launches:?}");
        assert_eq!(after_flag(&launches[0], "--session-id"), Some(mine.id.clone()));
        assert!(after_flag(&launches[0], "--resume").is_none(), "{}", launches[0]);
        assert_eq!(w.row(&mine.id).provider_session_id, Some(mine.id.clone()));
        let text: Vec<String> = w.blocks(&mine.id).into_iter().map(|block| block.text).collect();
        assert!(text.contains(&"report: remember 4817".to_string()), "{text:?}");
        assert!(text.contains(&"report: what number?".to_string()), "{text:?}");
        assert_eq!(w.row(&mine.id).last_event, None, "nobody waits on a user's turn");
    }

    /// Nothing is added to the user's own CLI: no persona, their settings
    /// loaded, and the question tool kept so its questions reach them.
    #[test]
    fn a_users_session_is_launched_without_a_persona_and_with_the_users_settings() {
        let w = world();
        w.turns.override_binary("claude", fake_claude(&w.dir));
        w.turns.override_claude_home(w.dir.join("home"));
        let mine = w.user_session("claude", "", "full");
        w.say(&mine, "hello");
        // The same CLI as a subagent, for comparison.
        let parent = w.session("terminal", "shell", "full");
        let started = w.call(&parent, "delegate", json!({ "provider": "claude", "prompt": "hello" })).expect("start");
        w.wait(&parent, started["id"].as_str().unwrap(), json!({}));

        let launches = launched(&w.dir.join("claude-launch.log"));
        assert_eq!(launches.len(), 2, "{launches:?}");
        let (user, subagent) = (&launches[0], &launches[1]);
        let argv: Vec<&str> = user["argv"].as_array().unwrap().iter().filter_map(Value::as_str).collect();
        assert!(!argv.contains(&"--append-system-prompt"), "{argv:?}");
        assert!(argv.contains(&"--setting-sources=user,project,local"), "{argv:?}");
        assert_eq!(after_flag(user, "--permission-prompt-tool"), Some("stdio".to_string()), "{argv:?}");
        assert!(subagent["argv"].to_string().contains("--append-system-prompt"), "{subagent}");
    }

    /// Claude refuses a new session under an id it holds, so a conversation
    /// the terminal view wrote is resumed, on the id the CLI is in now.
    #[test]
    fn a_users_claude_conversation_on_disk_is_resumed() {
        let w = world();
        w.turns.override_binary("claude", fake_claude(&w.dir));
        let mine = w.user_session("claude", "", "ask");
        w.claude_wrote(&mine.id);
        w.say(&mine, "carry on");

        let moved = w.user_session("claude", "", "ask");
        session::set_provider_session(w.turns.store(), moved.id.clone(), "after-clear".into()).expect("bind");
        w.claude_wrote("after-clear");
        w.say(&moved, "carry on");

        let launches = launched(&w.dir.join("claude-launch.log"));
        assert_eq!(launches.len(), 2, "{launches:?}");
        assert_eq!(after_flag(&launches[0], "--resume"), Some(mine.id.clone()));
        assert_eq!(after_flag(&launches[1], "--resume"), Some("after-clear".to_string()));
        for launch in &launches {
            assert!(after_flag(launch, "--session-id").is_none(), "{launch}");
        }
    }

    /// Released after the idle time, the process is launched again by the next
    /// message, which resumes the conversation Claude has written by then.
    #[test]
    fn an_idle_users_claude_session_is_released_and_the_next_message_resumes_it() {
        let w = world();
        w.turns.override_binary("claude", fake_claude(&w.dir));
        w.turns.override_claude_home(w.dir.join("home"));
        let mine = w.user_session("claude", "", "full");
        w.say(&mine, "remember 4817");
        w.claude_wrote(&mine.id);
        std::thread::sleep(Duration::from_millis(5));
        assert_eq!(w.turns.release_idle(Duration::from_millis(1), Duration::from_secs(3600)), vec![mine.id.clone()]);
        assert!(w.turns.test_agents().running().is_empty());
        assert!(w.turns.idle_since(&mine.id).is_none());

        w.say(&mine, "what number?");
        let launches = launched(&w.dir.join("claude-launch.log"));
        assert_eq!(launches.len(), 2, "{launches:?}");
        assert_eq!(after_flag(&launches[0], "--session-id"), Some(mine.id.clone()));
        assert_eq!(after_flag(&launches[1], "--resume"), Some(mine.id.clone()));
    }

    /// Codex resumes the thread the session already has, and told nothing
    /// beyond what the user typed.
    #[test]
    fn a_users_codex_session_resumes_its_thread_with_no_instructions_of_ours() {
        let w = world();
        let (fake, log) = crate::turns::fake_codex(&w.dir);
        w.turns.override_binary("codex", fake);
        let mine = w.user_session("codex", "gpt-5.6-luna", "full");
        session::set_provider_session(w.turns.store(), mine.id.clone(), "thread-77".into()).expect("bind");
        w.say(&mine, "remember 4817");
        w.say(&mine, "what number?");

        let resumed = sent(&log, "thread/resume");
        assert_eq!(resumed.len(), 1, "{resumed:?}");
        assert_eq!(resumed[0]["threadId"], json!("thread-77"));
        assert!(sent(&log, "thread/start").is_empty());
        let turns = sent(&log, "turn/start");
        assert_eq!(turns.len(), 2, "{turns:?}");
        for (turn, text) in turns.iter().zip(["remember 4817", "what number?"]) {
            assert_eq!(turn["threadId"], json!("thread-77"));
            assert_eq!(turn["input"][0]["text"], json!(text), "{turn}");
            assert!(turn.get("additionalContext").is_none(), "{turn}");
        }
        assert_eq!(launched(&log).len(), 1, "the second message started another app server");
    }

    /// A session with no thread yet opens one, and keeps its id to resume.
    #[test]
    fn a_users_codex_session_keeps_the_id_of_the_thread_it_opens() {
        let w = world();
        let (fake, log) = crate::turns::fake_codex(&w.dir);
        w.turns.override_binary("codex", fake);
        let mine = w.user_session("codex", "gpt-5.6-luna", "full");
        let row = w.say(&mine, "hello");

        assert_eq!(sent(&log, "thread/start").len(), 1);
        assert!(sent(&log, "thread/resume").is_empty());
        let thread = sent(&log, "turn/start")[0]["threadId"].as_str().unwrap().to_string();
        assert_eq!(row.provider_session_id, Some(thread));
    }

    /// What the user types is the message: no "from the crew command line"
    /// header, and no persona in the system prompt, whether it goes in as the
    /// turn, waits in the box behind one, or is steered into a running one.
    #[test]
    fn what_the_user_types_to_their_own_session_reaches_the_model_as_typed() {
        let w = world();
        let mine = w.user_session("opencode", "opencode/nemotron-3.5-lightning-free", "full");
        let coder = w.session("bot", "Coder", "full");
        let coder = coder.session_id().unwrap().to_string();
        let sender = crew_protocol::BotRef::bot(coder, "Coder");
        w.type_to(&mine, "SLEEP 1\nfix the parser", None, None);
        mailbox::enqueue(w.turns.store(), &mine.id, &mailbox::user(), "from me").expect("user letter");
        mailbox::enqueue(w.turns.store(), &mine.id, &sender, "from coder").expect("bot letter");
        // The box goes over when the turn ends, a moment after its status does.
        for _ in 0..400 {
            if w.launches().len() == 2 {
                break;
            }
            std::thread::sleep(Duration::from_millis(25));
        }
        w.settle(&mine.id);
        let launches = w.launches();
        assert_eq!(launches.len(), 2, "{launches:?}");
        assert_eq!(launches[0]["prompt"].as_str().map(str::trim_end), Some("SLEEP 1\nfix the parser"));
        assert_eq!(launches[0]["system"], json!(""));
        // The box went over as one turn: the user's letter as typed, the bot's in its envelope.
        let batch = launches[1]["prompt"].as_str().unwrap();
        assert!(batch.starts_with("from me\n\n## Message\nFrom: Coder (bot "), "{batch}");
        assert!(batch.trim_end().ends_with("from coder"), "{batch}");
        let mine_in_transcript = w.blocks(&mine.id).into_iter().find(|block| block.text == "from me").expect("block");
        assert_eq!((mine_in_transcript.role, mine_in_transcript.from_bot), (BlockRole::User, None));

        let steer = w.turns.steer_text(&mine.id, &mailbox::user(), "and this");
        assert_eq!(steer, "and this");
        let wrapped = w.turns.steer_text(&mine.id, &sender, "and that");
        assert!(wrapped.starts_with("## Message\nFrom: Coder"), "{wrapped}");
    }

    /// A subagent is not the user's: what the user writes to it is mail, from
    /// the crew command line.
    #[test]
    fn what_the_user_steers_into_a_subagent_keeps_its_envelope() {
        let w = world();
        let parent = w.session("terminal", "shell", "full");
        let id = w.start(&parent, "one");
        w.wait(&parent, &id, json!({}));
        let steer = w.turns.steer_text(&id, &mailbox::user(), "x");
        assert!(steer.starts_with("## Message\nFrom: the user (a person, from the crew command line)"), "{steer}");
    }

    /// Nobody waits on the user's turn, so it ends as a bot's does: done until
    /// read, error with the message, and a stop leaves the box for them.
    #[test]
    fn a_users_turn_settles_like_a_bots() {
        let w = world();
        let mine = w.user_session("opencode", "opencode/nemotron-3.5-lightning-free", "full");
        assert_eq!(w.say(&mine, "all well").status, "done");
        assert_eq!(w.say(&mine, "CRASH").status, "error");

        w.type_to(&mine, "SLEEP 5", None, None);
        mailbox::enqueue(w.turns.store(), &mine.id, &mailbox::user(), "after the stop").expect("enqueue");
        std::thread::sleep(Duration::from_millis(300));
        w.turns.stop(&mine.id).expect("stop");
        assert_eq!(w.settle(&mine.id).status, "idle");
        assert_eq!(mailbox::waiting_count(w.turns.store(), &mine.id).unwrap(), 1, "a stop must hold the box");
        assert_eq!(w.row(&mine.id).last_event, None);
    }

    /// A letter a restart left waiting for an idle chat session is delivered
    /// when the daemon comes up, as for a bot.
    #[test]
    fn a_letter_waiting_for_a_users_session_is_delivered_at_startup() {
        let w = world();
        let mine = w.user_session("opencode", "opencode/nemotron-3.5-lightning-free", "full");
        mailbox::enqueue(w.turns.store(), &mine.id, &mailbox::user(), "left behind").expect("enqueue");
        w.turns.deliver_waiting();
        w.settle(&mine.id);
        assert_eq!(mailbox::waiting_count(w.turns.store(), &mine.id).unwrap(), 0);
        assert_eq!(w.launches()[0]["prompt"].as_str().map(str::trim_end), Some("left behind"));
    }

    // ---- Sending while the session works: steered, or waiting in the queue ----

    impl World {
        /// What the user types in the window, as the daemon answers it, without
        /// waiting for the turn.
        fn type_to(
            &self,
            row: &Session,
            text: &str,
            mode: Option<&str>,
            files: Option<Vec<crew_protocol::AttachedFile>>,
        ) -> crew_protocol::TurnStarted {
            self.turns
                .start_by_user(TurnStart {
                    session_id: row.id.clone(),
                    cwd: self.dir.to_string_lossy().into_owned(),
                    text: text.into(),
                    files,
                    mentions: None,
                    hidden: None,
                    from_bot: None,
                    sent_at: None,
                    nonce: None,
                    letter_id: None,
                    mode: mode.map(str::to_string),
                    command: None,
                    skills: None,
                })
                .expect("start")
        }

        /// The same for a message that opens with a command or invokes skills.
        fn type_with(
            &self,
            row: &Session,
            text: &str,
            command: Option<&str>,
            skills: &[&str],
            mode: Option<&str>,
            files: Option<Vec<crew_protocol::AttachedFile>>,
        ) -> crew_protocol::TurnStarted {
            self.turns
                .start_by_user(TurnStart {
                    session_id: row.id.clone(),
                    cwd: self.dir.to_string_lossy().into_owned(),
                    text: text.into(),
                    files,
                    mentions: None,
                    hidden: None,
                    from_bot: None,
                    sent_at: None,
                    nonce: None,
                    letter_id: None,
                    mode: mode.map(str::to_string),
                    command: command.map(str::to_string),
                    skills: Some(skills.iter().map(|skill| skill.to_string()).collect())
                        .filter(|skills: &Vec<String>| !skills.is_empty()),
                })
                .expect("start")
        }

        /// Every user message the fake Claude was handed, each as its blocks
        /// `(type, text)` in the order they came.
        fn claude_inputs(&self) -> Vec<Vec<(String, String)>> {
            std::fs::read_to_string(self.dir.join("claude-input.log"))
                .unwrap_or_default()
                .lines()
                .map(|line| {
                    serde_json::from_str::<Vec<Value>>(line)
                        .expect("a logged message")
                        .iter()
                        .map(|block| {
                            (
                                block["type"].as_str().unwrap_or_default().to_string(),
                                block["text"].as_str().unwrap_or_default().to_string(),
                            )
                        })
                        .collect()
                })
                .collect()
        }

        /// The letters a session's queue shows the user: those the box holds and
        /// the transcript does not yet (a turn's own message is in both).
        fn waiting(&self, id: &str) -> Vec<crew_protocol::ThreadLetter> {
            let shown: Vec<String> = self.blocks(id).into_iter().filter_map(|block| block.letter_id).collect();
            mailbox::pending(self.turns.store(), id)
                .expect("pending")
                .into_iter()
                .filter(|letter| !shown.contains(&letter.id))
                .collect()
        }

        /// The same, each letter with the lane it is in.
        fn queue(&self, id: &str) -> Vec<(String, String)> {
            self.waiting(id).into_iter().map(|letter| (letter.text, letter.queue)).collect()
        }
    }

    /// Until `done` holds, which a turn that ends on its own thread makes true.
    fn until(what: &str, done: impl Fn() -> bool) {
        for _ in 0..400 {
            if done() {
                return;
            }
            std::thread::sleep(Duration::from_millis(25));
        }
        panic!("never {what}");
    }

    fn file(path: &str) -> crew_protocol::AttachedFile {
        crew_protocol::AttachedFile { name: "notes.md".into(), path: path.into(), kind: None, size: None }
    }

    /// Enter while a Claude turn works hands the message to the turn: the queue
    /// shows it as steering until the turn reads it, and the echo that says it
    /// did marks the letter delivered, where the user sees it in the transcript.
    #[test]
    fn a_message_sent_while_a_claude_users_turn_works_is_steered_and_its_echo_marks_it_delivered() {
        let w = world();
        w.turns.override_binary("claude", fake_claude(&w.dir));
        w.turns.override_claude_home(w.dir.join("home"));
        let mine = w.user_session("claude", "", "full");
        assert_eq!(w.type_to(&mine, "SLEEP 2", None, None).delivery.as_deref(), Some("started"));
        until_claude_turn(&w, &mine.id);

        let steered = w.type_to(&mine, "and this", None, None);
        assert_eq!((steered.working, steered.delivery.as_deref()), (true, Some("steered")));
        let letter = steered.letter_id.expect("the letter it became");
        assert_eq!(w.queue(&mine.id), [("and this".to_string(), "steering".to_string())]);

        w.settle(&mine.id);
        assert!(w.queue(&mine.id).is_empty(), "the echo did not mark it delivered");
        let block = w.blocks(&mine.id).into_iter().find(|block| block.text == "and this").expect("the steer");
        assert_eq!((block.role, block.from_bot, block.letter_id), (BlockRole::User, None, Some(letter.clone())));
        let page = mailbox::thread(w.turns.store(), "", &mine.id, None, None).expect("thread");
        assert_eq!(page.letters.iter().find(|l| l.id == letter).map(|l| l.state.as_str()), Some("delivered"));
        assert!(w.blocks(&mine.id).iter().any(|block| block.text == "report: SLEEP 2 + and this"));
        assert_eq!(launched(&w.dir.join("claude-launch.log")).len(), 1, "the steer started another process");
    }

    fn text_block(text: &str) -> (String, String) {
        ("text".into(), text.into())
    }

    /// A command sent while a turn works is not steered into it: it waits, goes
    /// as a turn of its own after the running one, and the letters that waited
    /// with it go before and after, not with it (a `/compact` must not be handed
    /// them as its arguments).
    #[test]
    fn a_command_sent_mid_turn_is_queued_and_goes_alone_after_the_running_turn() {
        let w = world();
        w.turns.override_binary("claude", fake_claude(&w.dir));
        w.turns.override_claude_home(w.dir.join("home"));
        let mine = w.user_session("claude", "", "full");
        w.type_to(&mine, "SLEEP 2", None, None);
        until_claude_turn(&w, &mine.id);

        w.type_to(&mine, "before", Some("queue"), None);
        let command = w.type_with(&mine, "/compact", Some("compact"), &[], None, None);
        assert_eq!((command.working, command.delivery.as_deref()), (true, Some("queued")), "a command is never steered");
        w.type_to(&mine, "after one", Some("queue"), None);
        w.type_to(&mine, "after two", Some("queue"), None);
        assert_eq!(
            w.queue(&mine.id),
            ["before", "/compact", "after one", "after two"].map(|text| (text.to_string(), "waiting".to_string()))
        );

        until("the queue went over", || w.queue(&mine.id).is_empty() && !w.turns.is_running(&mine.id));
        w.settle(&mine.id);
        let said: Vec<String> =
            w.blocks(&mine.id).into_iter().filter(|block| block.role == BlockRole::User).map(|block| block.text).collect();
        assert_eq!(said, ["SLEEP 2", "before", "/compact", "after one", "after two"]);
        let handed: Vec<Vec<(String, String)>> = w.claude_inputs();
        assert_eq!(
            handed,
            [
                vec![text_block("SLEEP 2")],
                vec![text_block("before")],
                vec![text_block("/compact")],
                vec![text_block("after one\n\nafter two")],
            ],
            "the command was the whole of its own message"
        );
        assert_eq!(launched(&w.dir.join("claude-launch.log")).len(), 1, "one process served them all");
    }

    /// A message that invokes a skill is not steered either (a steer is not
    /// known to expand it): it waits for the turn after. What it carries goes
    /// by the rules of a turn: the files note in the block ahead of the slash,
    /// the slash last.
    #[test]
    fn a_skill_sent_mid_turn_is_queued_and_reaches_claude_as_blocks_with_the_slash_last() {
        let w = world();
        w.turns.override_binary("claude", fake_claude(&w.dir));
        w.turns.override_claude_home(w.dir.join("home"));
        let mine = w.user_session("claude", "", "full");
        w.type_to(&mine, "SLEEP 2", None, None);
        until_claude_turn(&w, &mine.id);

        let queued = w.type_with(&mine, "look at it /lint now", None, &["lint"], None, Some(vec![file("/tmp/notes.md")]));
        assert_eq!((queued.working, queued.delivery.as_deref()), (true, Some("queued")), "a skill is not steered");
        until("the queue went over", || w.queue(&mine.id).is_empty() && !w.turns.is_running(&mine.id));
        w.settle(&mine.id);
        let handed = w.claude_inputs();
        assert_eq!(handed.len(), 2, "{handed:?}");
        assert_eq!(
            handed[1],
            [
                text_block("look at it\n\nAttached files. Read them if you need their contents:\n- /tmp/notes.md"),
                text_block("/lint now"),
            ]
        );
    }

    /// On an idle session a command needs no queue: it starts a turn at once,
    /// and the text before a skill is its own block.
    #[test]
    fn a_command_on_an_idle_session_starts_a_turn_whose_message_is_the_command() {
        let w = world();
        w.turns.override_binary("claude", fake_claude(&w.dir));
        w.turns.override_claude_home(w.dir.join("home"));
        let mine = w.user_session("claude", "", "full");
        let started = w.type_with(&mine, "/review main", Some("review"), &[], None, Some(vec![file("/tmp/notes.md")]));
        assert_eq!(started.delivery.as_deref(), Some("started"));
        w.settle(&mine.id);
        assert_eq!(
            w.claude_inputs(),
            [vec![
                text_block("Attached files. Read them if you need their contents:\n- /tmp/notes.md"),
                text_block("/review main"),
            ]]
        );
    }

    /// A steer the turn did not read is not lost, and a stop leaves it where the
    /// user can see it: waiting, ahead of whatever they send next.
    #[test]
    fn a_steer_a_users_turn_never_read_goes_back_to_waiting() {
        let w = world();
        w.turns.override_binary("claude", fake_claude(&w.dir));
        w.turns.override_claude_home(w.dir.join("home"));
        let mine = w.user_session("claude", "", "full");
        w.type_to(&mine, "STUBBORN SLEEP 5", None, None);
        until_claude_turn(&w, &mine.id);
        assert_eq!(w.type_to(&mine, "and this", None, None).delivery.as_deref(), Some("steered"));

        w.turns.stop(&mine.id).expect("stop");
        w.settle(&mine.id);
        assert_eq!(w.queue(&mine.id), [("and this".to_string(), "waiting".to_string())]);
        assert!(w.blocks(&mine.id).iter().all(|block| block.text != "and this"), "it was never read");

        // The next send releases the queue: the unread steer goes first, in the same turn.
        let next = w.type_to(&mine, "next", None, None);
        assert_eq!(next.delivery.as_deref(), Some("started"));
        until("the queue went over", || w.queue(&mine.id).is_empty() && !w.turns.is_running(&mine.id));
        let said: Vec<String> =
            w.blocks(&mine.id).into_iter().filter(|block| block.role == BlockRole::User).map(|block| block.text).collect();
        assert_eq!(said, ["STUBBORN SLEEP 5", "and this", "next"]);
    }

    /// The user's Claude session with fake Claude, its home in the test's dir.
    fn users_claude(w: &World) -> Session {
        w.turns.override_binary("claude", fake_claude(&w.dir));
        w.turns.override_claude_home(w.dir.join("home"));
        w.user_session("claude", "", "full")
    }

    /// Whether some block of the session's says exactly `text`.
    fn says(w: &World, id: &str, text: &str) -> bool {
        w.blocks(id).iter().any(|block| block.text == text)
    }

    /// What the user's own messages in the session say, in order.
    fn users_lines(w: &World, id: &str) -> Vec<String> {
        w.blocks(id).into_iter().filter(|block| block.role == BlockRole::User).map(|block| block.text).collect()
    }

    /// The user's turn ends at its answer with work left in the background:
    /// the process stays up with it, pinned, and the turn the CLI starts by
    /// itself when the work reports is the session's, with no message of the
    /// user's, its reply in the transcript, and the entry done: the entry's
    /// row says it ended, so no line says what woke it.
    #[test]
    fn a_users_claude_turn_ends_at_its_answer_and_the_turn_the_cli_starts_when_its_work_reports_is_adopted() {
        use crew_protocol::BackgroundState;
        let w = world();
        let mine = users_claude(&w);
        assert_eq!(w.type_to(&mine, "BACKGROUND 0.5", None, None).delivery.as_deref(), Some("started"));
        assert_eq!(w.settle(&mine.id).status, "done");
        assert!(says(&w, &mine.id, "started it in the background"));
        let list = w.turns.background_list(&mine.id);
        assert!(list.live && !list.waiting, "{list:?}");
        assert_eq!(list.commands[0].state, BackgroundState::Running);
        assert!(w.turns.is_pinned(&mine.id));
        std::thread::sleep(Duration::from_millis(5));
        assert!(
            w.turns.release_idle(Duration::from_millis(1), Duration::from_secs(3600)).is_empty(),
            "a pinned process was let go"
        );

        let reply = "report: BACKGROUND 0.5 + the background command finished";
        until("the CLI's own turn ended", || says(&w, &mine.id, reply) && !w.turns.is_running(&mine.id));
        assert_eq!(w.settle(&mine.id).status, "done");
        assert_eq!(w.turns.background_list(&mine.id).commands[0].state, BackgroundState::Completed);
        assert_eq!(users_lines(&w, &mine.id), ["BACKGROUND 0.5"], "the CLI's turn was given a message");
        assert!(!says(&w, &mine.id, "Background command completed (exit code 0)"), "its row says it ended, not a line");
        assert_eq!(launched(&w.dir.join("claude-launch.log")).len(), 1);
        assert_eq!(w.turns.test_agents().running(), vec![mine.id.clone()]);
        w.turns.release(&mine.id);
    }

    /// Esc stops the turn and nothing else: the CLI is interrupted with the
    /// background work spared (declared at `initialize`), no task is told to
    /// stop, and the next message runs on the same process while the work
    /// goes on. Stopped from the panel, the work wakes nobody.
    #[test]
    fn esc_on_a_users_claude_turn_stops_the_turn_and_spares_its_background_work() {
        use crew_protocol::BackgroundState;
        let w = world();
        let mine = users_claude(&w);
        w.type_to(&mine, "BACKGROUND 30 SLEEP 30", None, None);
        until_background(&w, &mine.id, |list| list.commands.iter().any(|row| row.state == BackgroundState::Running));
        w.turns.stop(&mine.id).expect("stop");
        assert_eq!(w.settle(&mine.id).status, "idle");
        assert!(says(&w, &mine.id, "Stopped"));
        let control = std::fs::read_to_string(w.dir.join("claude-control.log")).unwrap();
        assert!(control.starts_with("initialize perTaskStopAffordance forwardSubagentText\n"), "{control}");
        assert!(control.contains("interrupt cancel_queued\n") && !control.contains("stop_task"), "{control}");
        let list = w.turns.background_list(&mine.id);
        assert!(list.live, "{list:?}");
        assert_eq!(list.commands[0].state, BackgroundState::Running);
        assert_eq!(w.turns.test_agents().running(), vec![mine.id.clone()]);

        assert_eq!(w.type_to(&mine, "next", None, None).delivery.as_deref(), Some("started"));
        until("the next turn answered", || says(&w, &mine.id, "report: next") && !w.turns.is_running(&mine.id));
        assert_eq!(launched(&w.dir.join("claude-launch.log")).len(), 1, "the next turn launched a process");
        assert_eq!(w.turns.background_list(&mine.id).commands[0].state, BackgroundState::Running);

        w.turns.background_stop(&mine.id, "bg1").expect("stop the task");
        std::thread::sleep(Duration::from_millis(400));
        assert!(!w.turns.is_running(&mine.id), "a task stopped from the panel woke the model");
        assert_eq!(w.turns.background_list(&mine.id).commands[0].state, BackgroundState::Stopped);
        w.turns.release(&mine.id);
    }

    /// Send now stops the turn the same way: the queue goes over as the next
    /// turn on the process the stopped one had.
    #[test]
    fn send_now_interrupts_a_users_claude_turn_and_the_queue_runs_on_the_same_process() {
        let w = world();
        let mine = users_claude(&w);
        w.type_to(&mine, "SLEEP 30", None, None);
        until_claude_turn(&w, &mine.id);
        let b = w.type_to(&mine, "b", Some("queue"), None).letter_id.expect("letter");
        w.turns.send_now(&mine.id, &b).expect("send now");
        until("the queue went over", || says(&w, &mine.id, "report: b") && !w.turns.is_running(&mine.id));
        assert!(says(&w, &mine.id, "Stopped"));
        assert_eq!(w.claude_control(), ["interrupt cancel_queued"]);
        assert_eq!(launched(&w.dir.join("claude-launch.log")).len(), 1, "the stop let the process go");
        w.turns.release(&mine.id);
    }

    /// The CLI starts a turn by itself just as Crew's turn is about to write
    /// its message: Crew's turn takes the CLI's over, and its message goes in
    /// as a steer of it, so there is one turn running, not two, and the
    /// session settles.
    #[test]
    fn a_message_crew_sends_as_the_cli_starts_a_turn_by_itself_joins_that_turn() {
        let w = world();
        let mine = users_claude(&w);
        w.type_to(&mine, "one", None, None);
        w.settle(&mine.id);
        let bound = w.row(&mine.id).provider_session_id.expect("bound");
        let host = w.turns.clone();
        let id = mine.id.clone();
        w.turns.test_before_message(move || {
            let init = json!({ "type": "system", "subtype": "init", "session_id": bound, "model": "fake", "tools": [] });
            host.on_agent_lines("agent-stdout", &id, vec![init.to_string()]);
        });
        assert_eq!(w.type_to(&mine, "two", None, None).delivery.as_deref(), Some("started"));
        until("the turn ended", || says(&w, &mine.id, "report: two") && !w.turns.is_running(&mine.id));
        assert_eq!(w.settle(&mine.id).status, "done");
        assert_eq!(users_lines(&w, &mine.id), ["one", "two"]);

        assert_eq!(w.type_to(&mine, "three", None, None).delivery.as_deref(), Some("started"));
        until("the next turn ended", || says(&w, &mine.id, "report: three") && !w.turns.is_running(&mine.id));
        assert_eq!(launched(&w.dir.join("claude-launch.log")).len(), 1);
        w.turns.release(&mine.id);
    }

    /// Work that reports the moment the turn answers: the CLI's own turn starts
    /// while Crew is still ending the one before, and is taken all the same.
    #[test]
    fn a_turn_the_cli_starts_as_the_last_one_ends_is_adopted() {
        let w = world();
        let mine = users_claude(&w);
        for round in 1..=3 {
            w.type_to(&mine, "BACKGROUND 0.05", None, None);
            let reply = "report: BACKGROUND 0.05 + the background command finished";
            until("the CLI's own turn ended", || {
                w.blocks(&mine.id).iter().filter(|block| block.text == reply).count() == round && !w.turns.is_running(&mine.id)
            });
            assert_eq!(w.settle(&mine.id).status, "done");
        }
        assert_eq!(launched(&w.dir.join("claude-launch.log")).len(), 1);
        w.turns.release(&mine.id);
    }

    /// opencode reads a steer at the running turn's next step, once the turn is
    /// in it; a message asked to queue waits and goes as the next turn.
    #[test]
    fn on_opencode_a_message_is_steered_unless_asked_to_queue() {
        let w = world();
        let mine = w.user_session("opencode", "opencode/nemotron-3.5-lightning-free", "full");
        w.type_to(&mine, "SLEEP 1", None, None);
        until("the turn is in opencode", || w.launches().len() == 1);
        let queued = w.type_to(&mine, "and this", Some("queue"), None);
        assert_eq!((queued.working, queued.delivery.as_deref()), (true, Some("queued")));
        assert!(queued.letter_id.is_some());
        let steered = w.type_to(&mine, "and that", None, None);
        assert_eq!(steered.delivery.as_deref(), Some("steered"));
        assert_eq!(
            w.queue(&mine.id),
            [("and this".to_string(), "waiting".to_string()), ("and that".to_string(), "steering".to_string())]
        );

        until("the queue went over", || w.launches().len() == 2);
        w.settle(&mine.id);
        let launches = w.launches();
        assert_eq!(launches[0]["prompt"].as_str().map(str::trim_end), Some("SLEEP 1"));
        assert_eq!(launches[1]["prompt"].as_str().map(str::trim_end), Some("and this"));
        assert!(w.queue(&mine.id).is_empty());
    }

    #[test]
    fn on_cursor_a_message_sent_while_a_turn_works_is_queued_and_goes_as_the_next_turn() {
        let w = world();
        let (fake, log) = crate::turns::fake_cursor(&w.dir);
        w.turns.override_binary("cursor-agent", fake);
        let mine = w.user_session("cursor", "composer-2.5", "full");
        w.type_to(&mine, "SLEEP 2", None, None);
        until_tool(&w, &w.user(), &mine.id);
        let queued = w.type_to(&mine, "and this", Some("steer"), None);
        assert_eq!(queued.delivery.as_deref(), Some("queued"));
        assert_eq!(w.queue(&mine.id), [("and this".to_string(), "waiting".to_string())]);

        until("the second prompt", || sent(&log, "session/prompt").len() == 2);
        w.settle(&mine.id);
        assert_eq!(sent(&log, "session/prompt")[1]["prompt"][0]["text"], json!("and this"));
        assert_eq!(launches_of(&log).len(), 1, "both prompts ran on the one process");
    }

    /// What waits goes as one turn, in the order the user put it in: moved
    /// letters first, the others after them in their own order.
    #[test]
    fn two_queued_messages_go_as_one_turn_in_queue_order_after_a_reorder() {
        let w = world();
        let mine = w.user_session("opencode", "opencode/nemotron-3.5-lightning-free", "full");
        w.type_to(&mine, "SLEEP 1", None, None);
        let ids: Vec<String> =
            ["one", "two", "three"].iter().map(|text| w.type_to(&mine, text, None, None).letter_id.expect("letter")).collect();
        let events = Arc::new(Mutex::new(0));
        let heard = events.clone();
        w.turns.store().set_listener(Arc::new(move |what| {
            if matches!(what, crate::store::Changed::Mailbox(_)) {
                *heard.lock().unwrap() += 1;
            }
        }));
        mailbox::reorder(w.turns.store(), &mine.id, &[ids[2].clone(), ids[0].clone(), "not-a-letter".into()]).expect("reorder");
        assert!(*events.lock().unwrap() > 0, "the window was not told");
        let order: Vec<String> = w.queue(&mine.id).into_iter().map(|(text, _)| text).collect();
        assert_eq!(order, ["three", "one", "two"]);

        until("the queue went over", || w.launches().len() == 2);
        w.settle(&mine.id);
        assert_eq!(w.launches()[1]["prompt"].as_str().map(str::trim_end), Some("three\n\none\n\ntwo"));
        let said: Vec<String> =
            w.blocks(&mine.id).into_iter().filter(|block| block.role == BlockRole::User).map(|block| block.text).collect();
        assert_eq!(said, ["SLEEP 1", "three", "one", "two"]);
    }

    /// Once a turn has taken a letter (here, a steer) it is the turn's: editing,
    /// removing and sending it now are refused, and say why.
    #[test]
    fn a_letter_a_turn_has_taken_is_refused_by_edit_dispose_and_send_now() {
        let w = world();
        w.turns.override_binary("claude", fake_claude(&w.dir));
        w.turns.override_claude_home(w.dir.join("home"));
        let mine = w.user_session("claude", "", "full");
        w.type_to(&mine, "SLEEP 2", None, None);
        until_claude_turn(&w, &mine.id);
        let letter = w.type_to(&mine, "and this", None, None).letter_id.expect("letter");

        let store = w.turns.store();
        let edit = mailbox::edit(store, &mine.id, &letter, "and that", None).expect_err("edited a claimed letter");
        assert!(edit.contains("already took") && edit.contains("edited"), "{edit}");
        let removed = mailbox::dispose_users(store, &mine.id, &letter).expect_err("removed a claimed letter");
        assert!(removed.contains("already took") && removed.contains("removed"), "{removed}");
        let sent_now = w.turns.send_now(&mine.id, &letter).expect_err("sent a claimed letter now");
        assert!(sent_now.contains("already took"), "{sent_now}");
        assert!(w.turns.is_running(&mine.id), "the refused Send now stopped the turn");

        w.settle(&mine.id);
        let read = mailbox::edit(store, &mine.id, &letter, "late", None).expect_err("edited a delivered letter");
        assert!(read.contains("already read"), "{read}");
    }

    /// A waiting letter is the user's to change: its text and its files.
    #[test]
    fn an_edited_letter_goes_with_its_new_text_and_files() {
        let w = world();
        let mine = w.user_session("opencode", "opencode/nemotron-3.5-lightning-free", "full");
        w.type_to(&mine, "SLEEP 1", None, None);
        let letter = w.type_to(&mine, "first draft", None, Some(vec![file("/tmp/a.md")])).letter_id.expect("letter");
        assert_eq!(w.waiting(&mine.id)[0].files, Some(vec!["/tmp/a.md".to_string()]));

        mailbox::edit(w.turns.store(), &mine.id, &letter, "second draft", Some(vec!["/tmp/b.md".into()])).expect("edit");
        assert_eq!(w.waiting(&mine.id)[0].files, Some(vec!["/tmp/b.md".to_string()]));
        let nothing = mailbox::edit(w.turns.store(), &mine.id, &letter, "  ", Some(Vec::new())).expect_err("emptied");
        assert!(nothing.contains("some text or a file"), "{nothing}");

        until("the queue went over", || w.launches().len() == 2);
        w.settle(&mine.id);
        let prompt = w.launches()[1]["prompt"].as_str().unwrap().to_string();
        assert!(prompt.starts_with("second draft") && prompt.contains("- /tmp/b.md") && !prompt.contains("a.md"), "{prompt}");
    }

    /// Only the user's own waiting letters can be dropped, and a dropped one is never sent.
    #[test]
    fn disposing_drops_a_waiting_letter_of_the_users_and_no_one_elses() {
        let w = world();
        let mine = w.user_session("opencode", "opencode/nemotron-3.5-lightning-free", "full");
        let coder = w.session("bot", "Coder", "full");
        let sender = crew_protocol::BotRef::bot(coder.session_id().unwrap().to_string(), "Coder");
        w.type_to(&mine, "SLEEP 1", None, None);
        let dropped = w.type_to(&mine, "drop me", None, None).letter_id.expect("letter");
        w.type_to(&mine, "keep me", None, None);
        let theirs = mailbox::enqueue(w.turns.store(), &mine.id, &sender, "from coder").expect("letter").id;

        mailbox::dispose_users(w.turns.store(), &mine.id, &dropped).expect("dispose");
        let not_theirs = mailbox::dispose_users(w.turns.store(), &mine.id, &theirs).expect_err("dropped a bot's letter");
        assert!(not_theirs.contains("Only a message you wrote"), "{not_theirs}");
        let elsewhere = mailbox::dispose_users(w.turns.store(), coder.session_id().unwrap(), &dropped)
            .expect_err("dropped it from another box");
        assert!(elsewhere.contains("not in this session's queue"), "{elsewhere}");
        let again = mailbox::dispose_users(w.turns.store(), &mine.id, &dropped).expect_err("dropped twice");
        assert!(again.contains("already removed"), "{again}");

        until("the queue went over", || w.launches().len() == 2);
        w.settle(&mine.id);
        let prompt = w.launches()[1]["prompt"].as_str().unwrap().to_string();
        assert!(prompt.starts_with("keep me\n\n## Message\nFrom: Coder") && !prompt.contains("drop me"), "{prompt}");
    }

    /// Send now stops the turn, puts the letter first, and the queue goes over
    /// as the next turn with it at the head.
    #[test]
    fn send_now_stops_the_turn_and_the_next_turn_starts_with_that_letter() {
        let w = world();
        let mine = w.user_session("opencode", "opencode/nemotron-3.5-lightning-free", "full");
        w.type_to(&mine, "SLEEP 30", None, None);
        w.type_to(&mine, "a", None, None);
        let b = w.type_to(&mine, "b", None, None).letter_id.expect("letter");
        until("the first turn is up", || w.launches().len() == 1);

        let answer = w.turns.send_now(&mine.id, &b).expect("send now");
        assert_eq!(answer.letter_id.as_deref(), Some(b.as_str()));
        until("the next turn", || w.launches().len() == 2);
        w.settle(&mine.id);
        assert_eq!(w.launches()[1]["prompt"].as_str().map(str::trim_end), Some("b\n\na"));
        let text: Vec<String> = w.blocks(&mine.id).into_iter().map(|block| block.text).collect();
        assert!(text.contains(&"Stopped".to_string()) && text.contains(&"report: a".to_string()), "{text:?}");
        assert!(w.queue(&mine.id).is_empty());
        assert_eq!(w.row(&mine.id).status, "done");
    }

    /// The same on Codex, whose turn is interrupted rather than killed.
    #[test]
    fn send_now_interrupts_a_codex_users_turn_and_the_next_turn_starts_with_that_letter() {
        let w = world();
        let (fake, log) = crate::turns::fake_codex(&w.dir);
        w.turns.override_binary("codex", fake);
        let mine = w.user_session("codex", "gpt-5.6-luna", "full");
        w.type_to(&mine, "SLEEP 30", None, None);
        until_tool(&w, &w.user(), &mine.id);
        let first = w.type_to(&mine, "a", Some("queue"), None).letter_id.expect("letter");
        let second = w.type_to(&mine, "b", Some("queue"), None).letter_id.expect("letter");
        assert_ne!(first, second);

        w.turns.send_now(&mine.id, &second).expect("send now");
        until("the next turn", || sent(&log, "turn/start").len() == 2);
        w.settle(&mine.id);
        assert_eq!(sent(&log, "turn/start")[1]["input"][0]["text"], json!("b\n\na"));
        assert!(w.queue(&mine.id).is_empty());
    }

    /// With nothing running, Send now is just the queue going over, headed by the letter.
    #[test]
    fn send_now_with_nothing_running_sends_the_queue_headed_by_the_letter() {
        let w = world();
        let mine = w.user_session("opencode", "opencode/nemotron-3.5-lightning-free", "full");
        w.type_to(&mine, "SLEEP 30", None, None);
        until("the first turn is up", || w.launches().len() == 1);
        w.type_to(&mine, "a", None, None);
        let b = w.type_to(&mine, "b", None, None).letter_id.expect("letter");
        w.turns.stop(&mine.id).expect("stop");
        w.settle(&mine.id);
        assert_eq!(w.queue(&mine.id).len(), 2, "a stop must hold the queue");

        let answer = w.turns.send_now(&mine.id, &b).expect("send now");
        assert_eq!(answer.delivery.as_deref(), Some("started"));
        until("the next turn", || w.launches().len() == 2);
        w.settle(&mine.id);
        assert_eq!(w.launches()[1]["prompt"].as_str().map(str::trim_end), Some("b\n\na"));
    }

    /// A stop is the user saying enough: the queue waits, and sending
    /// something is what lets it go, together with the new message.
    #[test]
    fn stop_holds_the_queue_and_the_next_send_releases_it() {
        let w = world();
        let mine = w.user_session("opencode", "opencode/nemotron-3.5-lightning-free", "full");
        w.type_to(&mine, "SLEEP 30", None, None);
        w.type_to(&mine, "held", None, None);
        until("the first turn is up", || w.launches().len() == 1);
        w.turns.stop(&mine.id).expect("stop");
        assert_eq!(w.settle(&mine.id).status, "idle");
        std::thread::sleep(Duration::from_millis(300));
        assert_eq!(w.launches().len(), 1, "the queue went over after a stop");
        assert_eq!(w.queue(&mine.id), [("held".to_string(), "waiting".to_string())]);

        let released = w.type_to(&mine, "go on", None, None);
        assert_eq!(released.delivery.as_deref(), Some("started"));
        until("the next turn", || w.launches().len() == 2);
        w.settle(&mine.id);
        assert_eq!(w.launches()[1]["prompt"].as_str().map(str::trim_end), Some("held\n\ngo on"));
        assert!(w.queue(&mine.id).is_empty());
    }

    /// What the user attached to a message that waits reaches the turn it goes in.
    #[test]
    fn the_files_of_a_queued_message_reach_the_turn_it_goes_in() {
        let w = world();
        let mine = w.user_session("opencode", "opencode/nemotron-3.5-lightning-free", "full");
        w.type_to(&mine, "SLEEP 1", None, None);
        w.type_to(&mine, "look at this", None, Some(vec![file("/tmp/notes.md")]));
        assert_eq!(w.waiting(&mine.id)[0].files, Some(vec!["/tmp/notes.md".to_string()]));

        until("the queue went over", || w.launches().len() == 2);
        w.settle(&mine.id);
        let prompt = w.launches()[1]["prompt"].as_str().unwrap().to_string();
        assert!(prompt.starts_with("look at this") && prompt.contains("- /tmp/notes.md"), "{prompt}");
        let block = w.blocks(&mine.id).into_iter().find(|block| block.text == "look at this").expect("block");
        assert_eq!(
            block.files.map(|files| files.into_iter().map(|file| file.path).collect::<Vec<_>>()),
            Some(vec!["/tmp/notes.md".to_string()])
        );
    }

    /// A steer carries its files as a turn's message would: Claude is handed
    /// the paths with the text, and the echo that marks the letter delivered
    /// is of that text.
    #[test]
    fn a_steer_to_a_claude_users_turn_carries_its_files() {
        let w = world();
        w.turns.override_binary("claude", fake_claude(&w.dir));
        w.turns.override_claude_home(w.dir.join("home"));
        let mine = w.user_session("claude", "", "full");
        w.type_to(&mine, "SLEEP 2", None, None);
        until_claude_turn(&w, &mine.id);
        let steered = w.type_to(&mine, "and this", Some("steer"), Some(vec![file("/tmp/notes.md")]));
        assert_eq!(steered.delivery.as_deref(), Some("steered"));

        w.settle(&mine.id);
        assert!(w.queue(&mine.id).is_empty(), "the echo of a steer with files did not match");
        let block = w.blocks(&mine.id).into_iter().find(|block| block.text == "and this").expect("the steer");
        assert_eq!(block.files.map(|files| files.len()), Some(1));
        assert!(w.blocks(&mine.id).iter().any(|block| block.text == "report: SLEEP 2 + - /tmp/notes.md"));
    }

    #[test]
    fn a_steer_to_a_codex_users_turn_carries_its_files() {
        let w = world();
        let (fake, log) = crate::turns::fake_codex(&w.dir);
        w.turns.override_binary("codex", fake);
        let mine = w.user_session("codex", "gpt-5.6-luna", "full");
        w.type_to(&mine, "SLEEP 2", None, None);
        until_tool(&w, &w.user(), &mine.id);
        let steered = w.type_to(&mine, "and this", None, Some(vec![file("/tmp/notes.md")]));
        assert_eq!(steered.delivery.as_deref(), Some("steered"));

        w.settle(&mine.id);
        let text = sent(&log, "turn/steer")[0]["input"][0]["text"].as_str().unwrap().to_string();
        assert!(text.starts_with("and this") && text.contains("- /tmp/notes.md"), "{text}");
        assert!(w.queue(&mine.id).is_empty(), "the echo of a steer with files did not match");
        let block = w.blocks(&mine.id).into_iter().find(|block| block.text == "and this").expect("the steer");
        assert_eq!((block.role, block.from_bot), (BlockRole::User, None));
        assert_eq!(block.files.map(|files| files.len()), Some(1));
    }

    /// A subagent's user messages are letters too: waiting while it works, and
    /// the one it takes in is shown as the user's message.
    #[test]
    fn a_message_sent_to_a_busy_subagent_waits_in_its_queue() {
        let w = world();
        let parent = w.session("terminal", "shell", "full");
        let id = w.start(&parent, "SLEEP 1");
        let row = w.row(&id);
        let queued = w.type_to(&row, "and this", None, None);
        assert_eq!(queued.delivery.as_deref(), Some("queued"));
        assert_eq!(w.queue(&id), [("and this".to_string(), "waiting".to_string())]);
        until("the queue went over", || w.launches().len() == 2);
        w.settle(&id);
        let block = w.blocks(&id).into_iter().find(|block| block.text == "and this").expect("block");
        assert_eq!((block.role, block.from_bot), (BlockRole::User, None));
    }

    /// The user's own session has no "You" conversation beside its chat.
    #[test]
    fn what_the_user_typed_to_their_own_session_is_no_conversation_with_you() {
        let w = world();
        let mine = w.user_session("opencode", "opencode/nemotron-3.5-lightning-free", "full");
        w.say(&mine, "hello");
        assert!(mailbox::pairs(w.turns.store(), &mine.id).expect("pairs").is_empty());
    }

    // ---- Live tests: the real CLIs, run on demand ----

    /// The real binary for a CLI, found the way the app finds it.
    fn real_binary(name: &str) -> String {
        crate::shell_path::resolve(name).unwrap_or_else(|| panic!("`{name}` is not installed")).to_string_lossy().into_owned()
    }

    /// Kills the child's process when the test ends, passed or not.
    struct Reap<'a>(&'a World, String);

    impl Drop for Reap<'_> {
        fn drop(&mut self) {
            self.0.turns.test_agents().kill(&self.1);
        }
    }

    impl World {
        /// A child on the real CLI of `provider`, made as `start_session` makes
        /// it but with a model that Crew's own list does not have to name, and
        /// not yet sent anything.
        fn live_child(&self, parent: &Caller, provider: &str, model: &str, effort: &str, autonomy: &str) -> String {
            self.turns.override_binary(provider, real_binary(provider));
            if provider == "grok" {
                self.turns.override_mcp_exe(crewd_for_live_tests());
            }
            let row = session::create_child(
                self.turns.store(),
                self.workspace.clone(),
                format!("live-{provider}"),
                provider.into(),
                model.into(),
                autonomy.into(),
                None,
                parent.session_id().map(str::to_string),
            )
            .expect("child");
            session::set_options(
                self.turns.store(),
                row.id.clone(),
                model.into(),
                effort.into(),
                row.service_tier,
                autonomy.into(),
            )
            .expect("options");
            row.id
        }

        /// One turn on the real CLI: the message, and the report that ends it.
        fn live_say(&self, parent: &Caller, id: &str, text: &str) -> String {
            let sent = self.call(parent, "send_message", json!({ "to": id, "text": text })).expect("send");
            assert_eq!(sent["delivery"], "started", "{sent}");
            let out = self.wait(parent, id, json!({ "timeout_s": 180 }));
            assert_eq!(out["result"], "event", "{out}");
            let event = &out["sessions"][0];
            assert_eq!(event["outcome"], "completed", "{out}");
            event["report"].as_str().unwrap_or_default().to_string()
        }

        fn live_pid(&self, id: &str) -> u32 {
            self.turns.test_agents().pid_of(id).unwrap_or_else(|| panic!("{id} has no process up"))
        }

        /// Until the session's meter has a window: it comes in after the turn.
        fn live_window(&self, id: &str) -> crew_protocol::ContextReading {
            for _ in 0..400 {
                if let Some(reading) = self.turns.context(id).filter(|reading| reading.window.is_some()) {
                    return reading;
                }
                std::thread::sleep(Duration::from_millis(50));
            }
            panic!("the meter never had a window: {:?}", self.turns.context(id));
        }
    }

    fn says_one(report: &str) {
        assert!(report.to_lowercase().contains("one"), "the report was: {report:?}");
    }

    fn grok_live() -> bool {
        std::env::var("GROK_LIVE").ok().as_deref() == Some("1")
    }

    /// Kills the process and deletes the grok session it opened.
    struct GrokReap<'a>(&'a World, String);

    impl Drop for GrokReap<'_> {
        fn drop(&mut self) {
            let bound = self.0.row(&self.1).provider_session_id.filter(|id| !id.is_empty());
            self.0.turns.test_agents().kill(&self.1);
            let Some(id) = bound else { return };
            let Some(bin) = crate::shell_path::resolve("grok") else { return };
            let status = std::process::Command::new(bin)
                .args(["sessions", "delete", &id])
                .stdin(std::process::Stdio::null())
                .stdout(std::process::Stdio::null())
                .stderr(std::process::Stdio::null())
                .status();
            if !status.as_ref().is_ok_and(|code| code.success()) {
                eprintln!("grok sessions delete {id} exited {status:?}");
            }
        }
    }

    /// Prints what grok billed, read before the session is deleted.
    struct GrokSpend {
        label: &'static str,
        session: Option<String>,
    }

    impl GrokSpend {
        fn new(label: &'static str) -> Self {
            Self { label, session: None }
        }

        fn see(&mut self, w: &World, id: &str) {
            if self.session.is_none() {
                self.session = w.row(id).provider_session_id.filter(|value| !value.is_empty());
            }
        }
    }

    impl Drop for GrokSpend {
        fn drop(&mut self) {
            let Some(id) = self.session.take() else { return };
            let Some(path) = crate::provider_session::grok_transcript(&id) else {
                eprintln!("GROK_LIVE_SPEND {} {id} no-log", self.label);
                return;
            };
            let Ok(text) = std::fs::read_to_string(path) else { return };
            let mut total = 0.0;
            for line in text.lines() {
                let Ok(value) = serde_json::from_str::<Value>(line) else { continue };
                let Some(ticks) = value.pointer("/params/update/usage/costUsdTicks") else { continue };
                let ticks = ticks.as_f64().or_else(|| ticks.as_u64().map(|n| n as f64)).unwrap_or(0.0);
                total += ticks / 10_000_000_000.0;
            }
            eprintln!("GROK_LIVE_SPEND {} {total:.6}", self.label);
        }
    }

    /// The session id is bound before the model answers, so a failed turn
    /// still has a log to bill and delete.
    fn live_report(w: &World, parent: &Caller, id: &str, text: &str, spend: &mut GrokSpend) -> String {
        let sent = w.call(parent, "send_message", json!({ "to": id, "text": text })).expect("send");
        assert_eq!(sent["delivery"], "started", "{sent}");
        let deadline = Instant::now() + Duration::from_secs(30);
        while spend.session.is_none() && Instant::now() < deadline {
            spend.see(w, id);
            if spend.session.is_some() {
                break;
            }
            std::thread::sleep(Duration::from_millis(50));
        }
        let out = w.wait(parent, id, json!({ "timeout_s": 180 }));
        spend.see(w, id);
        assert_eq!(out["result"], "event", "{out}");
        let event = &out["sessions"][0];
        assert_eq!(event["outcome"], "completed", "{out}");
        event["report"].as_str().unwrap_or_default().to_string()
    }

    fn live_idle(w: &World, id: &str, spend: &mut GrokSpend) {
        let start = Instant::now();
        while start.elapsed() < Duration::from_secs(180) {
            spend.see(w, id);
            let status = w.row(id).status;
            if !matches!(status.as_str(), "starting" | "working" | "needs-input")
                && !w.turns.is_running(id)
                && !w.turns.is_settling(id)
            {
                return;
            }
            std::thread::sleep(Duration::from_millis(200));
        }
        panic!("{id} never went idle: {}", w.row(id).status);
    }

    /// The unit-test binary does not speak `--mcp`. `crewd` from this build does.
    fn crewd_for_live_tests() -> String {
        let exe = std::env::current_exe().expect("exe");
        let crewd = exe.parent().and_then(|deps| deps.parent()).map(|dir| dir.join("crewd")).expect("target dir");
        assert!(crewd.is_file(), "build crewd before a live grok test: cargo build -p crewd ({crewd:?})");
        crewd.to_string_lossy().into_owned()
    }

    fn live_grok_user(w: &World, autonomy: &str) -> Session {
        w.turns.override_binary("grok", real_binary("grok"));
        w.turns.override_mcp_exe(crewd_for_live_tests());
        let mine = w.user_session("grok", "grok-4.5", autonomy);
        session::set_options(
            w.turns.store(),
            mine.id.clone(),
            "grok-4.5".into(),
            "low".into(),
            mine.service_tier,
            autonomy.into(),
        )
        .expect("options");
        w.row(&mine.id)
    }

    fn assistant_text(blocks: &[Block]) -> String {
        blocks.iter().filter(|block| block.role == BlockRole::Assistant).map(|block| block.text.as_str()).collect()
    }

    /// An 8×8 solid red PNG. The name must not say the colour.
    const RED_PNG: &[u8] = &[
        137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13, 73, 72, 68, 82, 0, 0, 0, 8, 0, 0, 0, 8, 8, 2, 0, 0, 0, 75, 109, 41, 220, 0,
        0, 0, 17, 73, 68, 65, 84, 120, 218, 99, 248, 207, 192, 128, 21, 49, 12, 45, 9, 0, 40, 255, 63, 193, 206, 119, 200, 79, 0,
        0, 0, 0, 73, 69, 78, 68, 174, 66, 96, 130,
    ];

    fn grok_summary_field(provider_id: &str, key: &str) -> Option<String> {
        let path = crate::provider_session::grok_transcript(provider_id)?;
        let text = std::fs::read_to_string(path.parent()?.join("summary.json")).ok()?;
        let summary: Value = serde_json::from_str(&text).ok()?;
        summary.get(key).and_then(Value::as_str).map(str::to_string)
    }

    /// Runs the real `claude`: two haiku turns of a few tokens each (the
    /// persona's system prompt is the bulk). Needs `claude auth login`.
    /// `cargo test -p crew-core --lib -- --ignored --test-threads=1 live_claude_two_turns`
    #[test]
    #[ignore]
    fn live_claude_two_turns_run_on_one_process_and_the_meter_reads_a_window() {
        let w = world();
        let parent = w.session("terminal", "shell", "full");
        let id = w.live_child(&parent, "claude", "claude-haiku-5-5", "low", "full");
        let _reap = Reap(&w, id.clone());

        says_one(&w.live_say(&parent, &id, "Reply with just the word one."));
        w.settle(&id);
        let pid = w.live_pid(&id);
        let reading = w.live_window(&id);
        assert!(reading.used > 0 && reading.window.is_some_and(|window| window > reading.used), "{reading:?}");

        says_one(&w.live_say(&parent, &id, "Again: reply with just the word one."));
        w.settle(&id);
        assert_eq!(w.live_pid(&id), pid, "the second turn started another process");
    }

    /// A real child of `provider` runs one turn for a bot parent, whose
    /// report wakes it; then the child goes idle and is reaped, and the
    /// parent is not woken again for it: no letter, no turn. The parent runs
    /// on a fake CLI of another provider, so the real one never stands in
    /// for it and every turn it takes is in a launch log.
    /// `binary`, when the one `live_child` finds is not the one to run.
    fn live_idle_exit_wakes_no_one(w: &World, provider: &str, model: &str, effort: &str, binary: Option<String>) {
        let bot = if provider == "opencode" {
            w.turns.override_binary("claude", fake_claude(&w.dir));
            let row = session::create(
                w.turns.store(),
                w.workspace.clone(),
                "bot".into(),
                "Planner".into(),
                "claude".into(),
                "sonnet".into(),
                String::new(),
                "full".into(),
            )
            .expect("bot");
            Caller::from_session(row)
        } else {
            w.session("bot", "Planner", "full")
        };
        let me = bot.session_id().unwrap().to_string();
        let turns_of_parent = || w.launches().len() + launched(&w.dir.join("claude-launch.log")).len();
        let id = w.live_child(&bot, provider, model, effort, "full");
        if let Some(binary) = binary {
            w.turns.override_binary(provider, binary);
        }
        let _reap = Reap(w, id.clone());
        let sent = w.call(&bot, "send_message", json!({ "to": id, "text": "Reply with just the word one." })).expect("send");
        assert_eq!(sent["delivery"], "started", "{sent}");
        until_long("the child's turn ended", Duration::from_secs(240), || {
            !w.turns.is_running(&id) && !matches!(w.row(&id).status.as_str(), "starting" | "working")
        });
        let ended =
            w.blocks(&id).iter().rev().take(4).map(|b| format!("{:?}: {}", b.role, b.text)).collect::<Vec<_>>().join("\n");
        assert_eq!(w.row(&id).status, "idle", "{provider}'s turn did not end cleanly:\n{ended}");
        let report = w.heard(&me, &id);
        says_one(&report.iter().find(|b| b.from_bot.as_ref().is_some_and(|f| f.id == id)).expect("no report").text);
        w.settle(&me);
        let waiting = |w: &World| -> Vec<String> {
            crate::mailbox::waiting(w.turns.store(), &me)
                .unwrap()
                .into_iter()
                .map(|l| format!("{} from {}: {}", l.kind, l.from.name, l.text))
                .collect()
        };
        // A parent turn that fails before its CLI reads the report hands the
        // letter back to the box: that is the parent's failure, not the exit's.
        let before = waiting(w);
        assert!(before.is_empty() && w.row(&me).status != "error", "the parent's turn on the report failed: {before:?}");
        let woken = turns_of_parent();
        let heard = w.blocks(&me).len();

        std::thread::sleep(Duration::from_millis(30));
        assert_eq!(w.tools.reap(Duration::from_millis(1)).unwrap(), vec![id.clone()]);
        assert_eq!(w.row(&id).status, "exited");
        assert!(w.turns.test_agents().pid_of(&id).is_none(), "{provider}'s process outlived the exit");
        std::thread::sleep(Duration::from_secs(3));
        let left = waiting(w);
        assert!(left.is_empty(), "the exit left a letter: {left:?}");
        assert_eq!(turns_of_parent(), woken, "the exit woke the parent");
        assert_eq!(w.blocks(&me).len(), heard, "the exit reached the parent's transcript");
        let out = w.wait(&bot, &id, json!({ "timeout_s": 1 }));
        assert_eq!(out["sessions"][0]["event"], "exited", "{out}");
        eprintln!("{provider}: reaped without waking the parent");
    }

    /// Runs the real `claude` on haiku, low effort. Needs `claude auth login`.
    /// `cargo test -p crew-core --lib -- --ignored --nocapture live_claude_idle_exit`
    #[test]
    #[ignore]
    fn live_claude_idle_exit_wakes_no_one() {
        live_idle_exit_wakes_no_one(&world(), "claude", "claude-haiku-5-5", "low", None);
    }

    /// Runs the real `codex` on luna, low effort. Needs `codex login`.
    /// `cargo test -p crew-core --lib -- --ignored --nocapture live_codex_idle_exit`
    #[test]
    #[ignore]
    fn live_codex_idle_exit_wakes_no_one() {
        live_idle_exit_wakes_no_one(&world(), "codex", "gpt-5.6-luna", "low", None);
    }

    /// Runs the real opencode 2.x server on a free model, with folders of its
    /// own as `live_opencode_a_turn` has. Run it alone: it moves HOME.
    /// `cargo test -p crew-core --lib -- --ignored --nocapture live_opencode_idle_exit`
    #[test]
    #[ignore]
    fn live_opencode_idle_exit_wakes_no_one() {
        let w = world();
        let binary = crate::shell_path::resolve_opencode().expect("opencode 2.x").to_string_lossy().into_owned();
        let home = w.dir.join("opencode-home");
        for (key, sub) in [
            ("XDG_DATA_HOME", "data"),
            ("XDG_CONFIG_HOME", "config"),
            ("XDG_STATE_HOME", "state"),
            ("XDG_CACHE_HOME", "cache"),
            ("HOME", ""),
        ] {
            let dir = home.join(sub);
            std::fs::create_dir_all(&dir).expect("dir");
            std::env::set_var(key, dir);
        }
        let _server = Reap(&w, "opencode:server".into());
        let model = std::env::var("OPENCODE_LIVE_MODEL").unwrap_or_else(|_| "opencode/nemotron-3.5-lightning-free".into());
        live_idle_exit_wakes_no_one(&w, "opencode", &model, "", Some(binary));
    }

    /// Until `done` holds, for as long as a real model may take.
    fn until_long(what: &str, limit: Duration, done: impl Fn() -> bool) {
        let end = std::time::Instant::now() + limit;
        while std::time::Instant::now() < end {
            if done() {
                return;
            }
            std::thread::sleep(Duration::from_millis(200));
        }
        panic!("never {what}");
    }

    /// The user's own session on the real `claude`, on haiku.
    fn live_users_claude(w: &World) -> Session {
        w.turns.override_binary("claude", real_binary("claude"));
        w.user_session("claude", "claude-haiku-5-5", "full")
    }

    /// Runs the real `claude`: one haiku turn that leaves `sleep 20` running in
    /// the background and answers, which ends the turn with the process up;
    /// then, when the shell completes, the turn the CLI starts by itself,
    /// which the session takes as its own. Needs `claude auth login`.
    /// `cargo test -p crew-core --lib -- --ignored --test-threads=1 live_claude_background`
    #[test]
    #[ignore]
    fn live_claude_background_work_outlives_the_turn_and_the_cli_reports_it_in_a_turn_of_its_own() {
        use crew_protocol::BackgroundState;
        let w = world();
        let mine = live_users_claude(&w);
        let _reap = Reap(&w, mine.id.clone());
        let at = std::time::Instant::now();
        w.type_to(
            &mine,
            "Use the Bash tool with run_in_background: true to run `sleep 20`. Then reply with just the word started. \
             When you are told it finished, reply with just the word done.",
            None,
            None,
        );
        until_long("the turn answered", Duration::from_secs(120), || {
            !w.turns.is_running(&mine.id) && w.row(&mine.id).status == "done"
        });
        let answered = at.elapsed();
        let list = w.turns.background_list(&mine.id);
        assert!(list.live && list.commands.len() == 1, "{list:?}");
        assert_eq!(list.commands[0].state, BackgroundState::Running, "{list:?}");
        assert!(w.turns.is_pinned(&mine.id));
        let pid = w.live_pid(&mine.id);

        let done = || {
            w.blocks(&mine.id)
                .iter()
                .any(|block| block.role == BlockRole::Assistant && block.text.to_lowercase().contains("done"))
        };
        until_long("the CLI's own turn ended", Duration::from_secs(120), || done() && !w.turns.is_running(&mine.id));
        let reported = at.elapsed();
        assert_eq!(w.row(&mine.id).status, "done");
        assert_eq!(w.turns.background_list(&mine.id).commands[0].state, BackgroundState::Completed);
        assert_eq!(w.live_pid(&mine.id), pid, "the CLI's turn ran on another process");
        assert_eq!(users_lines(&w, &mine.id).len(), 1, "the CLI's turn was given a message");
        eprintln!("answered at {answered:?}, the CLI's own turn ended at {reported:?}");
    }

    /// Runs the real `claude`: one haiku turn in which the model starts an
    /// Explore subagent in the foreground and waits on it. The entry is listed
    /// as the one the turn waits on, with the tokens and the step the CLI
    /// reports, and `stop_task` from the panel stops it: the subagent ends
    /// `stopped` long before its 40 s, and the model is told the call was
    /// rejected, which ends the turn. Needs `claude auth login`.
    /// `cargo test -p crew-core --lib -- --ignored --test-threads=1 live_claude_stop_task`
    #[test]
    #[ignore]
    fn live_claude_stop_task_stops_a_subagent_the_turn_waits_on() {
        use crew_protocol::{BackgroundKind, BackgroundState};
        let w = world();
        let mine = live_users_claude(&w);
        let _reap = Reap(&w, mine.id.clone());
        w.type_to(
            &mine,
            "Use the Agent tool with subagent_type Explore and run_in_background false (a foreground subagent) whose \
             prompt is: run exactly this with Bash: python3 -c \"import time; time.sleep(40)\" and then say done. \
             Then reply ok.",
            None,
            None,
        );
        let list = {
            let end = std::time::Instant::now() + Duration::from_secs(120);
            loop {
                let list = w.turns.background_list(&mine.id);
                if list.commands.iter().any(|row| row.tokens.is_some_and(|tokens| tokens > 0)) {
                    break list;
                }
                assert!(std::time::Instant::now() < end, "the subagent never reported its tokens: {list:?}");
                std::thread::sleep(Duration::from_millis(200));
            }
        };
        let row = list.commands.iter().find(|row| row.kind == BackgroundKind::Subagent).expect("the subagent");
        assert_eq!((row.state, row.foreground, row.stoppable), (BackgroundState::Running, Some(true), Some(true)), "{row:?}");
        assert!(row.activity.is_some(), "{row:?}");
        let at = std::time::Instant::now();
        w.turns.background_stop(&mine.id, &row.id).expect("stop the subagent");
        until_long("the turn ended", Duration::from_secs(60), || !w.turns.is_running(&mine.id));
        eprintln!("stopped, and the turn ended, after {:?}", at.elapsed());
        assert!(at.elapsed() < Duration::from_secs(30), "the subagent ran to its end");
        let row = w.turns.background_list(&mine.id).commands.into_iter().find(|one| one.id == row.id).expect("row");
        assert_eq!(row.state, BackgroundState::Stopped, "{row:?}");
        assert!(row.tokens.is_some_and(|tokens| tokens > 0), "{row:?}");
        assert!(row.model.is_some() && row.window.is_some(), "{row:?}");
    }

    /// Runs the real `claude`: one haiku turn that leaves `sleep 60` running in
    /// the background and goes on in the foreground, stopped with Esc. The
    /// interrupt (with `perTaskStopAffordance` declared) spares the shell, the
    /// process stays, and the shell is stopped from the panel after, which
    /// wakes nobody. Needs `claude auth login`.
    /// `cargo test -p crew-core --lib -- --ignored --test-threads=1 live_claude_esc`
    #[test]
    #[ignore]
    fn live_claude_esc_stops_the_turn_and_spares_the_work_in_the_background() {
        use crew_protocol::BackgroundState;
        let w = world();
        let mine = live_users_claude(&w);
        let _reap = Reap(&w, mine.id.clone());
        w.type_to(
            &mine,
            "First use the Bash tool with run_in_background: true to run `sleep 60`. Then, in a separate Bash call in \
             the foreground, run `python3 -c \"import time; time.sleep(20)\"`. Then reply with just the word ok.",
            None,
            None,
        );
        until_long("the shell runs in the background", Duration::from_secs(120), || {
            w.turns.background_list(&mine.id).commands.iter().any(|row| row.state == BackgroundState::Running)
        });
        std::thread::sleep(Duration::from_secs(3));
        assert!(w.turns.is_running(&mine.id), "the turn ended before it could be stopped");
        let pid = w.live_pid(&mine.id);
        w.turns.stop(&mine.id).expect("stop");
        until_long("the session is idle", Duration::from_secs(30), || {
            !w.turns.is_running(&mine.id) && w.row(&mine.id).status == "idle"
        });
        // The interrupt's own result came: the process is idle, kept.
        until_long("the stop was answered", Duration::from_secs(10), || w.turns.idle_since(&mine.id).is_some());
        std::thread::sleep(Duration::from_secs(2));
        let list = w.turns.background_list(&mine.id);
        assert!(list.live, "{list:?}");
        let shell = list.commands.iter().find(|row| row.state == BackgroundState::Running).expect("the interrupt took the shell");
        assert_eq!(w.live_pid(&mine.id), pid, "the stop let the process go");
        assert!(w.turns.background_output(&mine.id, &shell.id).is_ok());

        w.turns.background_stop(&mine.id, &shell.id).expect("stop the shell");
        std::thread::sleep(Duration::from_secs(5));
        assert!(!w.turns.is_running(&mine.id), "a shell stopped from the panel woke the model");
        let row = w.turns.background_list(&mine.id).commands.into_iter().find(|row| row.id == shell.id).expect("row");
        assert_eq!(row.state, BackgroundState::Stopped);
    }

    /// Runs the real `claude`: three turns, haiku then sonnet, with the model
    /// and the effort changed between them (a `set_model` and an
    /// `apply_flag_settings` on the live process). Needs `claude auth login`.
    /// It once failed about 1 run in 5, and not because a request went
    /// unanswered: the CLI checks a full model id (`claude-sonnet-4-5`) with
    /// the server before it answers `set_model`, for up to a deadline of 5 s
    /// of its own, so the answer came at 5.0 to 5.6 s in some runs, just past
    /// the 5 s that Crew waited. And when that check does not finish in time
    /// the CLI refuses with "Couldn't confirm model ... Try again" (1 run in
    /// 15). A `set_model` is now waited for longer (`SET_MODEL_TIMEOUT`) and
    /// asked a second time after a refusal; a launch again here means
    /// something else broke.
    /// `cargo test -p crew-core --lib -- --ignored --test-threads=1 live_claude_model`
    #[test]
    #[ignore]
    fn live_claude_model_and_effort_change_between_turns_on_the_same_process() {
        let w = world();
        let parent = w.session("terminal", "shell", "full");
        let id = w.live_child(&parent, "claude", "claude-haiku-5-5", "low", "full");
        let _reap = Reap(&w, id.clone());

        says_one(&w.live_say(&parent, &id, "Reply with just the word one."));
        let row = w.settle(&id);
        let pid = w.live_pid(&id);
        session::set_options(
            w.turns.store(),
            id.clone(),
            "claude-sonnet-4-5".into(),
            "medium".into(),
            row.service_tier,
            row.autonomy,
        )
        .expect("options");

        says_one(&w.live_say(&parent, &id, "Reply with just the word one."));
        w.settle(&id);
        assert_eq!(w.live_pid(&id), pid, "the settings change launched another process");
        assert_eq!(w.row(&id).model, "claude-sonnet-4-5");
        let row = w.row(&id);
        session::set_options(w.turns.store(), id.clone(), row.model, "low".into(), row.service_tier, row.autonomy)
            .expect("options");
        says_one(&w.live_say(&parent, &id, "Reply with just the word one."));
        w.settle(&id);
        assert_eq!(w.live_pid(&id), pid);
    }

    /// Runs the real `codex app-server`: three gpt-5.6-luna turns at low or
    /// medium effort. Needs `codex login`.
    /// `cargo test -p crew-core --lib -- --ignored --test-threads=1 live_codex`
    #[test]
    #[ignore]
    fn live_codex_two_turns_run_on_one_app_server_and_an_effort_change_keeps_it() {
        let w = world();
        let parent = w.session("terminal", "shell", "full");
        let id = w.live_child(&parent, "codex", "gpt-5.6-luna", "low", "full");
        let _reap = Reap(&w, id.clone());

        says_one(&w.live_say(&parent, &id, "Reply with just the word one."));
        w.settle(&id);
        let pid = w.live_pid(&id);
        let reading = w.live_window(&id);
        assert!(reading.used > 0, "{reading:?}");

        says_one(&w.live_say(&parent, &id, "Again: reply with just the word one."));
        w.settle(&id);
        assert_eq!(w.live_pid(&id), pid, "the second turn started another app server");

        let row = w.row(&id);
        session::set_options(w.turns.store(), id.clone(), row.model, "medium".into(), row.service_tier, row.autonomy)
            .expect("options");
        says_one(&w.live_say(&parent, &id, "Once more: reply with just the word one."));
        w.settle(&id);
        assert_eq!(w.live_pid(&id), pid, "the effort change started another app server");
    }

    /// Runs the real opencode 2.x server on a free model, with its own data,
    /// config and home folders so nothing of the user's is read or written: a
    /// plain turn, a steer into a turn running a command, and the meter.
    /// Needs the network. `OPENCODE_LIVE_MODEL` names another free model.
    /// `cargo test -p crew-core --lib -- --ignored --test-threads=1 live_opencode`
    #[test]
    #[ignore]
    fn live_opencode_a_turn_a_steer_and_the_meter_run_on_the_shared_server() {
        let w = world();
        // Found with the user's own home, before the server gets another.
        let binary = crate::shell_path::resolve_opencode().expect("opencode 2.x").to_string_lossy().into_owned();
        let home = w.dir.join("opencode-home");
        for (key, sub) in [
            ("XDG_DATA_HOME", "data"),
            ("XDG_CONFIG_HOME", "config"),
            ("XDG_STATE_HOME", "state"),
            ("XDG_CACHE_HOME", "cache"),
            ("HOME", ""),
        ] {
            let dir = home.join(sub);
            std::fs::create_dir_all(&dir).expect("dir");
            std::env::set_var(key, dir);
        }
        w.turns.override_binary("opencode", binary);
        // The server is the daemon's, not a session's: it outlives the test.
        let _reap = Reap(&w, "opencode:server".into());
        let model = std::env::var("OPENCODE_LIVE_MODEL").unwrap_or_else(|_| "opencode/nemotron-3.5-lightning-free".into());
        let mine = w.user_session("opencode", &model, "full");
        let words = |w: &World| -> String {
            w.blocks(&mine.id)
                .iter()
                .filter(|block| block.role == crew_protocol::BlockRole::Assistant)
                .map(|block| block.text.clone())
                .collect::<Vec<_>>()
                .join("\n")
        };
        let idle = |w: &World| !w.turns.is_running(&mine.id);

        w.type_to(&mine, "Reply with just the word one.", None, None);
        until_long("the first turn ended", Duration::from_secs(180), || idle(&w) && !words(&w).is_empty());
        assert!(words(&w).to_lowercase().contains("one"), "{}", words(&w));
        let reading = w.live_window(&mine.id);
        assert!(reading.used > 0 && reading.window.is_some_and(|window| window > reading.used), "{reading:?}");
        let bound = w.row(&mine.id).provider_session_id.expect("bound to an opencode session");
        // The `/` menu is what the server reports for the folder.
        let menu = w.turns.commands_list(&mine.id).expect("menu");
        assert!(menu.entries.iter().any(|entry| entry.kind != "crew"), "nothing of opencode's in {menu:?}");

        w.type_to(&mine, "Run `sleep 6` in the shell, then say done.", None, None);
        until_tool(&w, &w.user(), &mine.id);
        let steered = w.type_to(&mine, "Also finish your answer with the word banana.", Some("steer"), None);
        assert_eq!(steered.delivery.as_deref(), Some("steered"));
        until_long("the second turn ended", Duration::from_secs(240), || idle(&w) && w.queue(&mine.id).is_empty());
        let said = words(&w).to_lowercase();
        assert!(said.contains("banana"), "the steer was never read: {said}");
        assert_eq!(w.row(&mine.id).provider_session_id, Some(bound.clone()), "the second turn carried the conversation on");
        let after = w.live_window(&mine.id);
        assert!(after.used >= reading.used, "{reading:?} then {after:?}");

        // `/compact` goes to the server's compaction, and ends as a turn does.
        w.type_with(&mine, "/compact", Some("compact"), &[], None, None);
        until_long("the compaction ended", Duration::from_secs(240), || idle(&w));
        let compacted = w.live_window(&mine.id);
        assert!(compacted.used < after.used || compacted.stale.is_some(), "{after:?} then {compacted:?}");
    }

    /// Runs the real opencode 2.x server on a free model, isolated as above:
    /// a turn that starts one task subagent. Its entry names the model it ran
    /// on and, when opencode gives it a variant, the effort.
    /// `cargo test -p crew-core --lib -- --ignored --test-threads=1 --nocapture live_opencode_a_subagent`
    #[test]
    #[ignore]
    fn live_opencode_a_subagent_entry_names_its_model() {
        use crew_protocol::BackgroundKind;
        let w = world();
        let binary = crate::shell_path::resolve_opencode().expect("opencode 2.x").to_string_lossy().into_owned();
        let home = w.dir.join("opencode-home");
        for (key, sub) in [
            ("XDG_DATA_HOME", "data"),
            ("XDG_CONFIG_HOME", "config"),
            ("XDG_STATE_HOME", "state"),
            ("XDG_CACHE_HOME", "cache"),
            ("HOME", ""),
        ] {
            let dir = home.join(sub);
            std::fs::create_dir_all(&dir).expect("dir");
            std::env::set_var(key, dir);
        }
        w.turns.override_binary("opencode", binary);
        let _reap = Reap(&w, "opencode:server".into());
        let model = std::env::var("OPENCODE_LIVE_MODEL").unwrap_or_else(|_| "opencode/nemotron-3.5-lightning-free".into());
        let mine = w.user_session("opencode", &model, "full");
        w.type_to(
            &mine,
            "Use the task tool to start exactly one general subagent whose task is to reply with just the word one. Wait for it, then reply with just the word finished.",
            None,
            None,
        );
        until_long("the turn ended", Duration::from_secs(240), || !w.turns.is_running(&mine.id));
        let list = w.turns.background_list(&mine.id);
        eprintln!("entries: {:#?}", list.commands);
        let row = list.commands.iter().find(|row| row.kind == BackgroundKind::Subagent).expect("an entry for the subagent");
        assert_eq!(row.model.as_deref(), Some(model.as_str()), "{row:?}");
    }

    /// Runs the real `cursor-agent acp` on its auto model: three short turns.
    /// The first two share one process and one ACP session; Crew's MCP server
    /// started with the session answers on the second turn; the meter reads
    /// the session's `store.db` after each. A model change then launches
    /// another process that loads the session and still remembers it.
    /// Needs `cursor-agent login`.
    /// `cargo test -p crew-core --lib -- --ignored --test-threads=1 live_cursor`
    #[test]
    #[ignore]
    fn live_cursor_two_turns_run_on_one_acp_process_and_a_model_change_loads_the_session() {
        let w = world();
        let parent = w.session("terminal", "shell", "full");
        let id = w.live_child(&parent, "cursor", "auto", "", "full");
        w.turns.override_binary("cursor-agent", real_binary("cursor-agent"));
        let _reap = Reap(&w, id.clone());

        let report = w.live_say(&parent, &id, "Remember the word mango. Reply with just the word one.");
        // An account out of quota answers every prompt with this, and writes no store.
        assert!(!report.contains("Upgrade your plan"), "Cursor has no quota left on this account: {report:?}");
        says_one(&report);
        w.settle(&id);
        let pid = w.live_pid(&id);
        let first = w.live_window(&id);
        assert!(first.used > 0 && first.window.is_some_and(|window| window > first.used), "{first:?}");

        let report =
            w.live_say(&parent, &id, "Call the list_peers tool of the crew MCP server once, then reply with just the word two.");
        w.settle(&id);
        assert!(report.to_lowercase().contains("two"), "the report was: {report:?}");
        assert_eq!(w.live_pid(&id), pid, "the second turn started another process");
        let second = w.turns.context(&id).expect("a reading");
        assert!(second.used > first.used, "the store did not move between prompts: {first:?} then {second:?}");
        let blocks = w.turns.transcripts().since(&id, 0).0;
        assert!(
            blocks.iter().filter_map(|block| block.tool.as_ref()).any(|tool| tool.name == "mcp__crew__list_peers"),
            "the MCP server did not answer on the second turn: {:?}",
            blocks.iter().filter_map(|block| block.tool.as_ref().map(|tool| &tool.name)).collect::<Vec<_>>()
        );

        let row = w.row(&id);
        session::set_options(w.turns.store(), id.clone(), "composer-2.5".into(), row.effort, row.service_tier, row.autonomy)
            .expect("options");
        let report = w.live_say(&parent, &id, "What word did I ask you to remember? Reply with just the word.");
        w.settle(&id);
        assert_ne!(w.live_pid(&id), pid, "the model change kept the process");
        assert!(report.to_lowercase().contains("mango"), "the session was not loaded: {report:?}");
    }

    /// One real `grok agent stdio` turn, then a second on the same process.
    /// Needs `grok` logged in. Does nothing unless `GROK_LIVE=1`, so
    /// `--ignored` does not spend a call by accident.
    /// `GROK_LIVE=1 cargo test -p crew-core --lib -- --ignored --test-threads=1 live_grok`
    #[test]
    #[ignore]
    fn live_grok_two_turns_run_on_one_process() {
        if std::env::var("GROK_LIVE").ok().as_deref() != Some("1") {
            return;
        }
        let w = world();
        let parent = w.session("terminal", "shell", "full");
        let id = w.live_child(&parent, "grok", "grok-4.5", "low", "ask");
        let _reap = GrokReap(&w, id.clone());
        let report = w.live_say(&parent, &id, "Reply with just the word one.");
        says_one(&report);
        w.settle(&id);
        let pid = w.live_pid(&id);
        let report = w.live_say(&parent, &id, "Reply with just the word two.");
        w.settle(&id);
        assert!(report.to_lowercase().contains("two"), "the report was: {report:?}");
        assert_eq!(w.live_pid(&id), pid, "the second turn started another process");
    }

    /// Crew's MCP server answers a child. The row is the real tool, not the
    /// `use_tool` wrapper grok calls it through.
    /// `GROK_LIVE=1 cargo test -p crew-core --lib -- --ignored --test-threads=1 live_grok_mcp_list_peers`
    #[test]
    #[ignore]
    fn live_grok_mcp_list_peers() {
        use crew_protocol::ToolDetail;
        if !grok_live() {
            return;
        }
        let w = world();
        let parent = w.session("terminal", "shell", "full");
        let id = w.live_child(&parent, "grok", "grok-4.5", "low", "ask");
        let _reap = GrokReap(&w, id.clone());
        let mut spend = GrokSpend::new("mcp");
        let report =
            live_report(&w, &parent, &id, "Call crew__list_peers once. Reply with just the other session's name.", &mut spend);
        w.settle(&id);
        let blocks = w.blocks(&id);
        let tool = blocks
            .iter()
            .find_map(|block| {
                block.tool.as_ref().filter(|tool| tool.name == "mcp__crew__list_peers" && tool.status == ToolStatus::Completed)
            })
            .unwrap_or_else(|| {
                let shown: Vec<String> = blocks
                    .iter()
                    .filter_map(|block| block.tool.as_ref().map(|tool| format!("{} {:?}", tool.name, tool.status)))
                    .collect();
                panic!("no completed list_peers: {shown:?}");
            });
        assert_ne!(tool.name, "use_tool");
        match &tool.detail {
            Some(ToolDetail::Crew { verb, targets, text, .. }) => {
                assert_eq!(verb, "list_peers");
                assert!(targets.is_empty() && text.is_none(), "the call was not list_peers with no arguments: {tool:?}");
            }
            other => panic!("list_peers was not the unwrapped call: {other:?}"),
        }
        assert!(report.to_lowercase().contains("shell"), "the report did not reflect list_peers: {report:?}");
    }

    /// Ask to full relaunches. The new process loads the session, so the word
    /// from the first turn is still there.
    /// `GROK_LIVE=1 cargo test -p crew-core --lib -- --ignored --test-threads=1 live_grok_autonomy_relaunches`
    #[test]
    #[ignore]
    fn live_grok_autonomy_relaunches_and_remembers() {
        if !grok_live() {
            return;
        }
        let w = world();
        let parent = w.session("terminal", "shell", "full");
        let id = w.live_child(&parent, "grok", "grok-4.5", "low", "ask");
        let _reap = GrokReap(&w, id.clone());
        let mut spend = GrokSpend::new("autonomy");
        let report = live_report(&w, &parent, &id, "Remember the word mango. Reply with just the word ok.", &mut spend);
        assert!(report.to_lowercase().contains("ok"), "{report:?}");
        w.settle(&id);
        let pid = w.live_pid(&id);
        let bound = w.row(&id).provider_session_id.clone();
        let row = w.row(&id);
        session::set_options(w.turns.store(), id.clone(), row.model, row.effort, row.service_tier, "full".into())
            .expect("options");
        let report = live_report(&w, &parent, &id, "What word did I ask you to remember? Reply with just the word.", &mut spend);
        w.settle(&id);
        assert_ne!(w.live_pid(&id), pid, "full kept the ask process");
        assert_eq!(w.row(&id).provider_session_id, bound, "the load opened a new grok session");
        assert!(report.to_lowercase().contains("mango"), "the session was not loaded: {report:?}");
    }

    /// The model and the effort are set on the process already held.
    /// `GROK_LIVE=1 cargo test -p crew-core --lib -- --ignored --test-threads=1 live_grok_effort_change`
    #[test]
    #[ignore]
    fn live_grok_effort_change_keeps_the_process() {
        if !grok_live() {
            return;
        }
        let w = world();
        let parent = w.session("terminal", "shell", "full");
        let id = w.live_child(&parent, "grok", "grok-4.5", "low", "ask");
        let _reap = GrokReap(&w, id.clone());
        let mut spend = GrokSpend::new("effort");
        live_report(&w, &parent, &id, "Reply with just the word one.", &mut spend);
        w.settle(&id);
        let pid = w.live_pid(&id);
        let row = w.row(&id);
        session::set_options(w.turns.store(), id.clone(), row.model, "medium".into(), row.service_tier, row.autonomy)
            .expect("options");
        let report = live_report(&w, &parent, &id, "Reply with just the word two.", &mut spend);
        w.settle(&id);
        assert!(report.to_lowercase().contains("two"), "{report:?}");
        assert_eq!(w.live_pid(&id), pid, "the effort change started another process");
        let bound = w.row(&id).provider_session_id.clone().expect("bound");
        let mut effort = None;
        for _ in 0..20 {
            effort = grok_summary_field(&bound, "reasoning_effort");
            if effort.as_deref().is_some_and(|value| value.eq_ignore_ascii_case("medium")) {
                break;
            }
            std::thread::sleep(Duration::from_millis(250));
        }
        assert_eq!(effort.as_deref().map(|value| value.to_ascii_lowercase()), Some("medium".into()), "summary.json");
        let model = grok_summary_field(&bound, "current_model_id").unwrap_or_default();
        assert!(model.contains("grok-4.5"), "the turn left {model}");
    }

    /// Ask mode stops a shell on the card. Allow is the same answer the UI
    /// sends, and the command then runs in the session's folder.
    /// `GROK_LIVE=1 cargo test -p crew-core --lib -- --ignored --test-threads=1 live_grok_ask_approval`
    #[test]
    #[ignore]
    fn live_grok_ask_approval_creates_the_file() {
        if !grok_live() {
            return;
        }
        let w = world();
        let parent = w.session("terminal", "shell", "full");
        let id = w.live_child(&parent, "grok", "grok-4.5", "low", "ask");
        let _reap = GrokReap(&w, id.clone());
        let mut spend = GrokSpend::new("approval");
        let sent = w
            .call(
                &parent,
                "send_message",
                json!({ "to": id, "text": "Run exactly this shell command, then reply with just the word done: printf ok > grok-asked.txt" }),
            )
            .expect("send");
        assert_eq!(sent["delivery"], "started", "{sent}");
        let asked = w.wait(&parent, &id, json!({ "timeout_s": 180 }));
        spend.see(&w, &id);
        assert_eq!(asked["result"], "event", "{asked}");
        assert_eq!(asked["sessions"][0]["event"], "needs-input", "{asked}");
        let request = &asked["sessions"][0]["request"];
        assert_eq!(request["kind"], "approval", "{request}");
        assert!(request.to_string().contains("grok-asked.txt"), "the approval was not the shell command: {request}");
        assert_eq!(w.row(&id).status, "needs-input");
        let card = w.blocks(&id).into_iter().find_map(|block| block.approval).expect("no approval card");
        assert!(card.decided.is_none(), "the card was already decided: {card:?}");
        w.turns.respond(&id, request["request_id"].as_u64().expect("request id"), ApprovalDecision::Allow).expect("allow");
        let done = w.wait(&parent, &id, json!({ "timeout_s": 180 }));
        assert_eq!(done["sessions"][0]["outcome"], "completed", "{done}");
        w.settle(&id);
        let path = w.dir.join("grok-asked.txt");
        let body = std::fs::read_to_string(&path).unwrap_or_else(|error| panic!("{path:?} missing: {error}"));
        assert!(body.contains("ok"), "{body:?}");
    }

    /// A file attached the way the composer attaches one is a path in the
    /// prompt. The model reads it and names the colour.
    /// `GROK_LIVE=1 cargo test -p crew-core --lib -- --ignored --test-threads=1 live_grok_image`
    #[test]
    #[ignore]
    fn live_grok_image_attachment_is_read() {
        if !grok_live() {
            return;
        }
        let w = world();
        let mine = live_grok_user(&w, "full");
        let _reap = GrokReap(&w, mine.id.clone());
        let mut spend = GrokSpend::new("image");
        let path = w.dir.join("swatch.png");
        std::fs::write(&path, RED_PNG).expect("png");
        let file = crew_protocol::AttachedFile {
            name: "swatch.png".into(),
            path: path.to_string_lossy().into_owned(),
            kind: Some(crew_protocol::AttachedFileKind::Image),
            size: Some(RED_PNG.len() as u64),
        };
        let started = w.type_to(&mine, "What colour is the attached image? Reply with one word.", None, Some(vec![file]));
        assert_eq!(started.delivery.as_deref(), Some("started"));
        live_idle(&w, &mine.id, &mut spend);
        let blocks = w.blocks(&mine.id);
        let attached = blocks.iter().any(|block| {
            block.role == BlockRole::User
                && block.files.as_ref().is_some_and(|files| {
                    files
                        .iter()
                        .any(|file| file.kind == Some(crew_protocol::AttachedFileKind::Image) && file.name == "swatch.png")
                })
        });
        assert!(attached, "the image was not on the user message: {blocks:?}");
        let said = assistant_text(&blocks);
        assert!(said.to_lowercase().contains("red"), "the model did not see the image: {said:?}");
    }

    /// Stop kills the turn. The next one loads the same grok session and can
    /// still answer from the turn that finished.
    /// `GROK_LIVE=1 cargo test -p crew-core --lib -- --ignored --test-threads=1 live_grok_stop_then_resume`
    #[test]
    #[ignore]
    fn live_grok_stop_then_resume_keeps_the_session() {
        if !grok_live() {
            return;
        }
        let w = world();
        let parent = w.session("terminal", "shell", "full");
        let id = w.live_child(&parent, "grok", "grok-4.5", "low", "full");
        let _reap = GrokReap(&w, id.clone());
        let mut spend = GrokSpend::new("stop");
        let report = live_report(&w, &parent, &id, "Remember the word kiwi. Reply with just the word ok.", &mut spend);
        assert!(report.to_lowercase().contains("ok"), "{report:?}");
        w.settle(&id);
        let bound = w.row(&id).provider_session_id.clone();
        let tools_before = w.blocks(&id).iter().filter(|block| block.tool.is_some()).count();
        let sent = w
            .call(
                &parent,
                "send_message",
                json!({ "to": id, "text": "Run the shell command sleep 30. Do not reply until it exits." }),
            )
            .expect("send");
        assert_eq!(sent["delivery"], "started", "{sent}");
        let deadline = Instant::now() + Duration::from_secs(45);
        while Instant::now() < deadline && w.turns.is_running(&id) {
            if w.blocks(&id).iter().filter(|block| block.tool.is_some()).count() > tools_before {
                break;
            }
            std::thread::sleep(Duration::from_millis(200));
        }
        assert!(w.turns.is_running(&id), "the turn ended before it could be stopped");
        let stopped = w.call(&parent, "interrupt_session", json!({ "session": id })).expect("interrupt");
        assert_eq!(stopped["interrupted"], true, "{stopped}");
        w.settle(&id);
        // The stopped turn is its own event. Mark it seen, or the next wait
        // returns it and never reaches the turn that follows.
        let ended = w.wait(&parent, &id, json!({ "timeout_s": 30 }));
        assert_eq!(ended["sessions"][0]["outcome"], "stopped", "{ended}");
        let report = live_report(&w, &parent, &id, "What word did I ask you to remember? Reply with just the word.", &mut spend);
        w.settle(&id);
        assert_eq!(w.row(&id).provider_session_id, bound, "the session id changed");
        assert!(report.to_lowercase().contains("kiwi"), "the resumed session forgot the first turn: {report:?}");
    }

    /// The history decoder, on the session's own `updates.jsonl`, shows the
    /// same user text, assistant text, and tool names the live turn stored.
    /// `GROK_LIVE=1 cargo test -p crew-core --lib -- --ignored --test-threads=1 live_grok_history_matches`
    #[test]
    #[ignore]
    fn live_grok_history_matches_the_live_transcript() {
        if !grok_live() {
            return;
        }
        let w = world();
        let mine = live_grok_user(&w, "full");
        let _reap = GrokReap(&w, mine.id.clone());
        let mut spend = GrokSpend::new("history");
        let prompt = "Run the shell command echo grok-live. Then reply with just the word done.";
        let started = w.type_to(&mine, prompt, None, None);
        assert_eq!(started.delivery.as_deref(), Some("started"));
        live_idle(&w, &mine.id, &mut spend);
        let live = transcript_view(&w.blocks(&mine.id));
        let bound = w.row(&mine.id).provider_session_id.clone().expect("bound");
        let path = crate::provider_session::grok_transcript(&bound).expect("updates.jsonl");
        let mut history = crate::session_history::History::open(&path, crate::session_history::grok::GrokDecoder::default(), 64)
            .expect("history");
        while history.has_earlier() {
            history.load_earlier(64).expect("earlier");
        }
        let decoded = transcript_view(history.blocks());
        assert_eq!(decoded.0, live.0, "user text");
        assert_eq!(decoded.1, live.1, "assistant text");
        assert_eq!(decoded.2, live.2, "tool names");
        assert!(live.2.iter().any(|name| name == "bash"), "no shell ran: {:?}", live.2);
        assert!(live.1.to_lowercase().contains("done"), "assistant: {}", live.1);
        assert_eq!(live.0, prompt);
    }

    /// User text, assistant text, and tool names, in transcript order.
    fn transcript_view(blocks: &[Block]) -> (String, String, Vec<String>) {
        let user = blocks
            .iter()
            .filter(|block| block.role == BlockRole::User && block.hidden != Some(true))
            .map(|block| block.text.trim().to_string())
            .filter(|text| !text.is_empty())
            .collect::<Vec<_>>()
            .join("\n");
        let assistant = assistant_text(blocks).trim().to_string();
        let tools = blocks.iter().filter_map(|block| block.tool.as_ref().map(|tool| tool.name.clone())).collect();
        (user, assistant, tools)
    }

    /// Runs the real `codex app-server`: one gpt-5.6-luna turn at low effort
    /// in which the model spawns an agent that says one. The agent's words are
    /// the steps of the spawn call and its tokens and end are its entry's; the
    /// parent's message holds the parent's words alone. Needs `codex login`.
    /// `cargo test -p crew-core --lib -- --ignored --test-threads=1 --nocapture live_codex_a_spawned`
    #[test]
    #[ignore]
    fn live_codex_a_spawned_agent_is_steps_and_an_entry_and_none_of_the_parents_message() {
        use crew_protocol::{BackgroundKind, BackgroundState, BlockRole, ToolDetail};
        let w = world();
        let parent = w.session("terminal", "shell", "full");
        let id = w.live_child(&parent, "codex", "gpt-5.6-luna", "low", "full");
        let _reap = Reap(&w, id.clone());

        let report = w.live_say(
            &parent,
            &id,
            "You must call the spawn_agent tool exactly once, with the task: reply with just the word one. Do not answer before spawning it. Wait for the agent, then reply with just the word finished.",
        );
        w.settle(&id);
        let list = until_background(&w, &id, |list| list.commands.iter().any(|row| row.state != BackgroundState::Running));
        let blocks = w.turns.transcripts().since(&id, 0).0;
        eprintln!("report: {report:?}\nentry: {:#?}", list.commands);
        for block in &blocks {
            eprintln!(
                "{:?} {:?} {:?}",
                block.role,
                block.text,
                block.tool.as_ref().map(|tool| (&tool.name, &tool.status, &tool.detail))
            );
        }

        let row = list.commands.iter().find(|row| row.kind == BackgroundKind::Subagent).expect("an entry for the agent");
        assert_eq!(row.state, BackgroundState::Completed, "{row:?}");
        assert!(row.thread_id.is_some() && row.tool_call_id.is_some(), "{row:?}");
        assert!(row.tokens.is_some_and(|tokens| tokens > 0) && row.window.is_some(), "{row:?}");
        assert!(row.model.is_some() && row.effort.is_some(), "the agent's model and effort: {row:?}");
        let call = blocks
            .iter()
            .filter_map(|block| block.tool.as_ref())
            .find(|tool| Some(&tool.call_id) == row.tool_call_id.as_ref())
            .expect("the spawn call");
        let Some(ToolDetail::Agent { steps: Some(steps), .. }) = &call.detail else {
            panic!("the spawn call has no steps: {call:?}");
        };
        assert!(
            steps.iter().any(|step| step.role == BlockRole::Assistant && step.text.to_lowercase().contains("one")),
            "{steps:?}"
        );
        let said: String =
            blocks.iter().filter(|block| block.role == BlockRole::Assistant).map(|block| block.text.as_str()).collect();
        assert!(
            said.to_lowercase().contains("finished") && !said.to_lowercase().contains("one"),
            "the parent's message was {said:?}"
        );
    }

    /// Runs the real `claude`: three haiku turns. Ask to Edits is a control
    /// request on the live process; Edits to Full is a flag of the launch, so
    /// another process takes the same conversation, and still remembers it.
    /// Needs `claude auth login`.
    /// `cargo test -p crew-core --lib -- --ignored --test-threads=1 live_claude_autonomy`
    #[test]
    #[ignore]
    fn live_claude_autonomy_edits_in_place_and_full_relaunches_on_the_conversation() {
        let w = world();
        let parent = w.session("terminal", "shell", "full");
        let id = w.live_child(&parent, "claude", "claude-haiku-5-5", "low", "ask");
        let _reap = Reap(&w, id.clone());

        w.live_say(&parent, &id, "Remember the word mango. Reply with just the word ok.");
        let row = w.settle(&id);
        let first = w.live_pid(&id);
        session::set_options(w.turns.store(), id.clone(), row.model, row.effort, row.service_tier, "edits".into())
            .expect("options");

        w.live_say(&parent, &id, "Reply with just the word ok.");
        let row = w.settle(&id);
        assert_eq!(w.live_pid(&id), first, "Ask to Edits launched another process");
        session::set_options(w.turns.store(), id.clone(), row.model, row.effort, row.service_tier, "full".into())
            .expect("options");

        let report = w.live_say(&parent, &id, "What word did I ask you to remember? Reply with just the word.");
        w.settle(&id);
        assert_ne!(w.live_pid(&id), first, "Edits to Full kept the process");
        assert!(report.to_lowercase().contains("mango"), "the conversation was not resumed: {report:?}");
    }

    fn entry(prompt: &str) -> Value {
        json!({ "provider": "opencode", "prompt": prompt })
    }

    /// Decision 9: each entry succeeds or fails on its own, and the result
    /// lists both; a longer list than 20 is refused whole.
    #[test]
    fn start_sessions_starts_each_entry_on_its_own_and_lists_both() {
        let w = world();
        let shell = w.session("terminal", "shell", "full");
        let out = w
            .call(
                &shell,
                "start_sessions",
                json!({ "sessions": [
                    entry("first job"),
                    json!({ "provider": "nope", "prompt": "bad provider" }),
                    json!({ "provider": "opencode" }),
                    json!({ "provider": "opencode", "prompt": "third job", "name": "Third", "worktree": "new" }),
                    "not an object"
                ] }),
            )
            .expect("a batch");
        assert_eq!((out["started"].clone(), out["failed"].clone()), (json!(2), json!(3)), "{out}");
        let results = out["sessions"].as_array().unwrap();
        assert_eq!(results.iter().map(|r| r["ok"] == true).collect::<Vec<_>>(), [true, false, false, true, false]);
        assert!(results[1]["error"].as_str().unwrap().contains("Unknown provider"), "{out}");
        assert!(results[2]["error"].as_str().unwrap().contains("prompt is required"), "{out}");
        assert_eq!(results[3]["name"], "Third");
        for index in [0, 3] {
            let id = results[index]["id"].as_str().unwrap().to_string();
            let row = w.row(&id);
            // Each is a separate session of the user's, launched by the caller.
            assert_eq!((row.kind.as_str(), row.parent_id.as_deref()), ("terminal", None));
            assert_eq!(row.launched_by.as_deref(), shell.session_id());
            assert!(w.made.lock().unwrap().contains(&id));
            w.settle(&id);
        }
        assert!(w.row(results[3]["id"].as_str().unwrap()).worktree.is_some());
        assert_eq!(results[0]["worktree"], "main checkout");
    }

    #[test]
    fn start_sessions_refuses_a_list_over_twenty_whole_and_an_empty_one() {
        let w = world();
        let shell = w.session("terminal", "shell", "full");
        let before = session::list(w.turns.store(), w.workspace.clone()).unwrap().len();
        let many: Vec<Value> = (0..=BATCH_MAX).map(|n| entry(&format!("job {n}"))).collect();
        let out = w.call(&shell, "start_sessions", json!({ "sessions": many }));
        assert!(out.is_err_and(|e| e.contains("at most 20") && e.contains("Nothing was started")));
        assert!(w.call(&shell, "start_sessions", json!({ "sessions": [] })).is_err());
        assert!(w.call(&shell, "start_sessions", json!({})).is_err());
        assert_eq!(session::list(w.turns.store(), w.workspace.clone()).unwrap().len(), before, "something started");
        // Twenty is the most that goes.
        let twenty: Vec<Value> = (0..BATCH_MAX).map(|n| entry(&format!("job {n}"))).collect();
        let out = w.call(&shell, "start_sessions", json!({ "sessions": twenty })).expect("twenty");
        assert_eq!(out["started"], 20, "{out}");
        for result in out["sessions"].as_array().unwrap() {
            w.settle(result["id"].as_str().unwrap());
        }
    }

    #[test]
    fn a_worktree_made_for_an_entry_that_failed_is_kept_and_named() {
        let w = world();
        let trees = w.dir.join("kept");
        let store = w.turns.store().clone();
        let workspace = w.workspace.clone();
        let tools = SessionTools::with_worktrees(
            w.turns.clone(),
            Arc::new(|_: &Session| {}),
            Arc::new(move |_: &str, branch: &str| {
                let path = trees.join(crate::worktree::slug(branch));
                std::fs::create_dir_all(&path).map_err(|e| e.to_string())?;
                // The workspace goes while the worktree is being made, so the
                // session that was to run in it cannot be.
                crate::workspace::delete(&store, workspace.clone())?;
                Ok(Worktree {
                    path: path.to_string_lossy().into_owned(),
                    branch: Some(branch.to_string()),
                    main: false,
                    add: 0,
                    del: 0,
                    dirty: 0,
                    locked: None,
                })
            }),
        );
        let user = w.user();
        let out = match tools
            .run(
                &user,
                "start_sessions",
                &json!({ "sessions": [json!({ "provider": "opencode", "prompt": "x", "effort": "none", "worktree": "new" })] }),
            )
            .expect("a batch")
        {
            ToolOutput::Value(value) => value,
            ToolOutput::Content(_) => panic!("content"),
        };
        assert_eq!((out["started"].clone(), out["failed"].clone()), (json!(0), json!(1)), "{out}");
        let failed = &out["sessions"][0];
        let tree = failed["worktree"].as_str().expect("the worktree is named");
        assert!(std::path::Path::new(tree).is_dir(), "{failed}");
        assert!(failed["note"].as_str().unwrap().contains("kept"), "{failed}");
        assert!(failed["error"].as_str().unwrap().contains(tree), "{failed}");
    }

    /// Decision 10: a retry with the same request_id from the same caller
    /// returns what the first call made.
    #[test]
    fn a_retry_with_the_same_request_id_returns_what_the_first_call_made() {
        let w = world();
        let shell = w.session("terminal", "shell", "full");
        let other = w.session("terminal", "other", "full");
        // The first call's turn must still be running when the retry waits, or
        // its report is already past and the wait has nothing new to return.
        let args = json!({ "provider": "opencode", "prompt": "SLEEP 2", "request_id": "job-1" });
        let first = w.call(&shell, "delegate", args.clone()).expect("first");
        let again = w.call(&shell, "delegate", args.clone()).expect("retry");
        assert_eq!(first["id"], again["id"]);
        assert_eq!(again["repeated"], true, "{again}");
        assert!(first.get("repeated").is_none());
        let id = first["id"].as_str().unwrap().to_string();
        assert_eq!(w.live_of(shell.session_id().unwrap()).len(), 1, "a retry started another");
        // Per caller: another caller's id of the same text is its own.
        let theirs = w.call(&other, "delegate", args.clone()).expect("other");
        assert_ne!(theirs["id"], first["id"]);
        // A retry that waits waits for the first call's session.
        let waited = w
            .call(
                &shell,
                "delegate",
                json!({ "provider": "opencode", "prompt": "job", "request_id": "job-1", "wait": true, "timeout_s": 20 }),
            )
            .expect("wait");
        assert_eq!(waited["id"], first["id"]);
        assert_eq!(waited["status"], "reported", "{waited}");
        // An id names one tool.
        let mixed = w.call(&shell, "start_session", args.clone());
        assert!(mixed.is_err_and(|e| e.contains("already used by delegate")));
        // Without one, every call starts its own.
        let plain = json!({ "provider": "opencode", "prompt": "job" });
        let one = w.call(&shell, "start_session", plain.clone()).expect("one");
        let two = w.call(&shell, "start_session", plain).expect("two");
        assert_ne!(one["id"], two["id"]);
        // A bad id is refused.
        assert!(w.call(&shell, "start_session", json!({ "provider": "opencode", "prompt": "x", "request_id": 7 })).is_err());
        for id in
            [id, theirs["id"].as_str().unwrap().into(), one["id"].as_str().unwrap().into(), two["id"].as_str().unwrap().into()]
        {
            w.settle(&id);
        }
    }

    #[test]
    fn a_batch_retried_with_its_request_id_starts_nothing_twice() {
        let w = world();
        let user = w.user();
        let args = json!({ "request_id": "batch-1", "sessions": [entry("a"), entry("b")] });
        let first = w.call(&user, "start_sessions", args.clone()).expect("first");
        let again = w.call(&user, "start_sessions", args).expect("retry");
        assert_eq!(first["sessions"], again["sessions"]);
        assert_eq!(again["repeated"], true);
        let all = session::list(w.turns.store(), w.workspace.clone()).unwrap();
        assert_eq!(all.len(), 2, "{all:?}");
        for row in all {
            w.settle(&row.id);
        }
    }

    const MODEL: &str = "opencode/nemotron-3.5-lightning-free";

    /// Decision 21: the turn stops, the session stays, and `text` is the next
    /// message.
    #[test]
    fn interrupt_session_stops_the_turn_and_leaves_the_session_to_carry_on() {
        let w = world();
        let shell = w.session("terminal", "shell", "full");
        let other = w.session("terminal", "other", "full");
        let id = w.start(&shell, "SLEEP 30");
        until("the turn is up", || w.launches().len() == 1);
        // Whoever may write may interrupt: a stranger, not only the parent.
        let out = w.call(&other, "interrupt_session", json!({ "session": id })).expect("interrupt");
        assert_eq!(out["interrupted"], true, "{out}");
        let row = w.settle(&id);
        assert_ne!(row.status, "exited", "an interrupt ended the session");
        assert!(!w.turns.is_running(&id));
        // It is still there, and takes the next message.
        let sent = w.call(&shell, "send_message", json!({ "to": id, "text": "carry on" })).expect("send");
        assert_eq!(sent["delivery"], "started", "{sent}");
        w.settle(&id);
        // With nothing running there is nothing to interrupt, and the text still goes.
        let idle = w.call(&other, "interrupt_session", json!({ "session": id })).expect("idle");
        assert_eq!(idle["interrupted"], false, "{idle}");
        let idle = w.call(&other, "interrupt_session", json!({ "session": id, "text": "and then this" })).expect("idle text");
        assert_eq!((idle["interrupted"].clone(), idle["delivery"].clone()), (json!(false), json!("started")), "{idle}");
        w.settle(&id);
        assert!(w.blocks(&id).iter().any(|block| block.text == "report: and then this"));
    }

    #[test]
    fn interrupt_session_with_text_redirects_in_one_call() {
        let w = world();
        let mine = w.user_session("opencode", MODEL, "full");
        let bot = w.session("bot", "Lead", "full");
        w.type_to(&mine, "SLEEP 30", None, None);
        until("the turn is up", || w.launches().len() == 1);
        let out = w.call(&bot, "interrupt_session", json!({ "session": mine.id, "text": "stop, go left" })).expect("interrupt");
        assert_eq!(out["interrupted"], true, "{out}");
        until("the next turn", || w.launches().len() == 2);
        w.settle(&mine.id);
        // The redirect is a message from the caller, in its envelope.
        let prompt = w.launches()[1]["prompt"].as_str().unwrap().to_string();
        assert!(prompt.contains("From: Lead (bot ") && prompt.trim_end().ends_with("stop, go left"), "{prompt}");
        assert_eq!(w.row(&mine.id).status, "done");
    }

    #[test]
    fn interrupt_session_is_for_whoever_may_write() {
        let w = world();
        let careful = w.session("bot", "Careful", "ask");
        let top = w.start(&w.user(), "SLEEP 30");
        let chat = w.user_session("opencode", MODEL, "full");
        let refused = |caller: &Caller, to: &str, why: &str| {
            let out = w.call(caller, "interrupt_session", json!({ "session": to }));
            assert!(out.as_ref().is_err_and(|e| e.contains(why)), "{to}: {out:?}");
        };
        refused(&careful, &top, "allowed more than it is");
        refused(&careful, &chat.id, "allowed more than it is");
        refused(&careful, careful.session_id().unwrap(), "That is you");
        refused(&careful, "nobody", "list_peers has the ids");
        // The user is exempt from the autonomy rule.
        w.call(&w.user(), "interrupt_session", json!({ "session": top })).expect("user");
        w.settle(&top);
        w.call(&w.user(), "stop_session", json!({ "session": top })).expect("stop");
        refused(&w.user(), &top, "has exited");
    }

    /// Decision 23: stopping a subagent stops the ones below it first and
    /// leaves independent sessions it launched alone.
    #[test]
    fn stop_session_cascades_depth_first_and_spares_independent_sessions() {
        let w = world();
        let shell = w.session("terminal", "shell", "full");
        let a = w.start(&shell, "first");
        w.settle(&a);
        let make = |name: &str, parent: &str| {
            session::create_child(
                w.turns.store(),
                w.workspace.clone(),
                name.into(),
                "opencode".into(),
                MODEL.into(),
                "full".into(),
                None,
                Some(parent.into()),
            )
            .expect("child")
            .id
        };
        let b = make("B", &a);
        let c = make("C", &b);
        let sibling = make("S", &a);
        // A session it launched before subagents worked at depth one (decision 28).
        let launched = w.call(&shell, "start_session", json!({ "provider": "opencode", "prompt": "mine" })).expect("launch")
            ["id"]
            .as_str()
            .unwrap()
            .to_string();
        session::set_launched_by(w.turns.store(), &launched, &a).expect("launched by a");
        w.settle(&launched);
        w.call(&shell, "send_message", json!({ "to": a, "text": "SLEEP 30" })).expect("busy");
        until("the turn is up", || w.launches().len() == 3);

        let out = w.call(&shell, "stop_session", json!({ "session": a })).expect("stop");
        assert_eq!(out["status"], "exited", "{out}");
        let order: Vec<&str> = out["also_stopped"].as_array().unwrap().iter().map(|one| one["id"].as_str().unwrap()).collect();
        assert_eq!(order, [c.as_str(), b.as_str(), sibling.as_str()], "{out}");
        for id in [&a, &b, &c, &sibling] {
            assert_eq!(w.row(id).status, "exited", "{id}");
        }
        assert_ne!(w.row(&launched).status, "exited", "an independent session was stopped");
        assert!(out["note"].as_str().unwrap().contains("not touched"));
        // Stopping what already exited says so and changes nothing.
        let again = w.call(&shell, "stop_session", json!({ "session": a })).expect("again");
        assert_eq!(again["note"], "It had already exited.");
    }

    /// Decision 24: any session in the workspace can be read; only the
    /// parent's read moves `seen`.
    #[test]
    fn read_session_reads_any_session_and_only_the_parents_read_advances_seen() {
        let w = world();
        let parent = w.session("terminal", "parent", "full");
        let stranger = w.session("terminal", "stranger", "full");
        let bot = w.session("bot", "Lead", "full");
        let id = w.start(&parent, "first job");
        w.settle(&id);
        let store = w.turns.store();
        assert_eq!(session_events::seen(store, &id).unwrap(), 0);
        for reader in [&stranger, &bot] {
            let read = w.call(reader, "read_session", json!({ "session": id })).expect("a stranger reads");
            assert!(read["text"].as_str().unwrap().contains("first job"), "{read}");
        }
        assert_eq!(session_events::seen(store, &id).unwrap(), 0, "a stranger's read advanced seen");
        // Kept to some roles, the parent's read skips what it leaves out (the
        // report among them), so it is a look back and moves nothing.
        w.call(&parent, "read_session", json!({ "session": id, "roles": ["tool"] })).expect("filtered");
        assert_eq!(session_events::seen(store, &id).unwrap(), 0, "a filtered read advanced seen");
        let read = w.call(&parent, "read_session", json!({ "session": id })).expect("parent");
        assert_eq!(session_events::seen(store, &id).unwrap(), read["cursor"].as_i64().unwrap());
        // The user's read of a subagent of someone else does not move it either.
        w.call(&parent, "send_message", json!({ "to": id, "text": "second job" })).expect("send");
        w.settle(&id);
        let before = session_events::seen(store, &id).unwrap();
        w.call(&w.user(), "read_session", json!({ "session": id })).expect("user");
        assert_eq!(session_events::seen(store, &id).unwrap(), before);
        // A bot and a session of the user's in the chat read too.
        let chat = w.user_session("opencode", MODEL, "full");
        w.say(&chat, "hello there");
        let read = w.call(&parent, "read_session", json!({ "session": chat.id })).expect("a chat");
        assert!(read["text"].as_str().unwrap().contains("hello there"), "{read}");
        let read = w.call(&parent, "read_session", json!({ "session": bot.session_id().unwrap() })).expect("a bot");
        assert_eq!(read["status"], "idle");
        // Another workspace's session is not in reach.
        std::fs::create_dir_all(w.dir.join("else")).unwrap();
        let elsewhere = crate::workspace::create(store, "other".into(), w.dir.join("else").to_string_lossy().into()).unwrap();
        let foreign = session::create(
            store,
            elsewhere.id,
            "terminal".into(),
            "far".into(),
            "opencode".into(),
            MODEL.into(),
            String::new(),
            "full".into(),
        )
        .unwrap();
        let out = w.call(&parent, "read_session", json!({ "session": foreign.id }));
        assert!(out.is_err_and(|e| e.contains("No session")));
    }

    /// Decision 25: `type` and `launched_by`, and `write` by the reach rule.
    #[test]
    fn list_peers_says_what_each_is_and_who_launched_it() {
        let w = world();
        let shell = w.session("terminal", "shell", "full");
        let careful = w.session("bot", "Careful", "ask");
        let bot = w.session("bot", "Lead", "full");
        let sub = w.start(&shell, "x");
        let top = w.call(&bot, "start_session", json!({ "provider": "opencode", "prompt": "y" })).expect("start")["id"]
            .as_str()
            .unwrap()
            .to_string();
        let chat = w.user_session("opencode", MODEL, "full");
        w.settle(&sub);
        w.settle(&top);
        let from_careful = |id: &str| w.peer(&careful, id);
        assert_eq!(from_careful(&sub)["type"], "subagent");
        assert_eq!(from_careful(bot.session_id().unwrap())["type"], "bot");
        assert_eq!(from_careful(&top)["type"], "session");
        assert_eq!(from_careful(&chat.id)["type"], "session");
        assert_eq!(from_careful(shell.session_id().unwrap())["type"], "session");
        assert_eq!(from_careful(&sub)["parent"], format!("shell (terminal {})", shell.session_id().unwrap()));
        assert_eq!(w.peer(&bot, &top)["launched_by"], "you");
        assert_eq!(from_careful(&top)["launched_by"], format!("Lead (bot {})", bot.session_id().unwrap()));
        assert!(w.peer(&shell, &top).get("parent").is_none());
        assert!(from_careful(&chat.id).get("launched_by").is_none());
        // `write` is the reach rule: an ask-autonomy caller cannot write up.
        assert_eq!(from_careful(&top)["write"], false);
        assert_eq!(w.peer(&bot, &top)["write"], true);
        assert_eq!(w.peer(&careful, &top)["write"], false);
    }

    fn recorded(w: &World) -> (Arc<Mutex<Vec<String>>>, Arc<Mutex<Vec<String>>>) {
        let released = Arc::new(Mutex::new(Vec::new()));
        let gone = Arc::new(Mutex::new(Vec::new()));
        let (r, g) = (released.clone(), gone.clone());
        w.tools.set_retirement(Retirement {
            release: Arc::new(move |id| r.lock().unwrap().push(id.to_string())),
            gone: Arc::new(move |ids| g.lock().unwrap().extend(ids.iter().cloned())),
        });
        (released, gone)
    }

    /// Decision 22: rename is for whoever started it or may write to it.
    #[test]
    fn update_session_renames_for_whoever_started_it_or_may_write_to_it() {
        let w = world();
        let shell = w.session("terminal", "shell", "full");
        let careful = w.session("bot", "Careful", "ask");
        let id = w.start(&shell, "x");
        w.settle(&id);
        let renamed =
            w.call(&shell, "update_session", json!({ "session": id, "action": "rename", "name": " Auth fix " })).expect("rename");
        assert_eq!(renamed["name"], "Auth fix");
        assert_eq!(w.row(&id).name, "Auth fix");
        // A caller with less autonomy than the session does not reach it.
        let out = w.call(&careful, "update_session", json!({ "session": id, "action": "rename", "name": "mine" }));
        assert!(out.is_err_and(|e| e.contains("not yours to rename")));
        assert_eq!(w.row(&id).name, "Auth fix");
        assert!(w.call(&shell, "update_session", json!({ "session": id, "action": "rename" })).is_err());
        assert!(w.call(&shell, "update_session", json!({ "session": id, "action": "burn" })).is_err());
        let bot = w.call(
            &shell,
            "update_session",
            json!({ "session": careful.session_id().unwrap(), "action": "rename", "name": "x" }),
        );
        assert!(bot.is_err_and(|e| e.contains("is a bot")));
    }

    #[test]
    fn the_tools_that_start_a_session_require_an_effort() {
        let w = world();
        let shell = w.session("terminal", "shell", "full");
        for tool in ["delegate", "start_session"] {
            let out = w.call_bare(&shell, tool, json!({ "provider": "claude", "prompt": "x" }));
            assert!(out.is_err_and(|e| e.contains("effort is required")), "{tool}");
        }
        let out = w.call_bare(&shell, "delegate", json!({ "provider": "claude", "prompt": "x", "effort": "ludicrous" }));
        assert!(out.is_err_and(|e| e.contains("one of low, medium, high, xhigh, max")));
        let out = w.call_bare(&shell, "delegate", json!({ "provider": "opencode", "prompt": "x", "effort": "high" }));
        assert!(out.is_err_and(|e| e.contains("Pass effort \"none\"")));
        let made =
            w.call_bare(&shell, "delegate", json!({ "provider": "opencode", "prompt": "x", "effort": "none" })).expect("none");
        assert_eq!(made["effort"], "");
        let many = w
            .call_bare(&shell, "start_sessions", json!({ "sessions": [{ "provider": "opencode", "prompt": "y" }] }))
            .expect("batch");
        assert_eq!(many["sessions"][0]["ok"], false);
    }

    #[test]
    fn update_session_changes_the_effort_of_a_session_whose_cli_takes_one() {
        let w = world();
        let shell = w.session("terminal", "shell", "full");
        let careful = w.session("bot", "Careful", "ask");
        let id = w.start(&shell, "x");
        w.settle(&id);
        let provider = w.row(&id).provider;
        let valid = crate::tools::efforts(&provider);
        if let Some(level) = valid.first() {
            let out =
                w.call(&shell, "update_session", json!({ "session": id, "action": "effort", "effort": level })).expect("effort");
            assert_eq!(out["effort"], *level);
            assert_eq!(w.row(&id).effort, *level);
            assert!(out["note"].as_str().unwrap().contains("prompt cache"));
            let bad = w.call(&shell, "update_session", json!({ "session": id, "action": "effort", "effort": "ludicrous" }));
            assert!(bad.is_err_and(|e| e.contains("one of")));
            let out = w.call(&careful, "update_session", json!({ "session": id, "action": "effort", "effort": level }));
            assert!(out.is_err_and(|e| e.contains("not yours to change")));
        }
        assert!(w.call(&shell, "update_session", json!({ "session": id, "action": "effort" })).is_err());
    }

    #[test]
    fn delete_is_for_the_starter_and_the_user() {
        let w = world();
        let (_, gone) = recorded(&w);
        let bot = w.session("bot", "Lead", "full");
        let other = w.session("bot", "Other", "full");
        let launched = w.call(&bot, "start_session", json!({ "provider": "opencode", "prompt": "a" })).expect("start")["id"]
            .as_str()
            .unwrap()
            .to_string();
        let theirs = w.call(&bot, "start_session", json!({ "provider": "opencode", "prompt": "b" })).expect("start")["id"]
            .as_str()
            .unwrap()
            .to_string();
        let chat = w.user_session("opencode", MODEL, "full");
        w.settle(&launched);
        w.settle(&theirs);
        for (caller, id) in [(&other, &launched), (&bot, &chat.id)] {
            let out = w.call(caller, "update_session", json!({ "session": id, "action": "delete" }));
            assert!(out.is_err_and(|e| e.contains("not started by you")));
        }
        // Archiving is not an action any more.
        let out = w.call(&bot, "update_session", json!({ "session": launched, "action": "archive" }));
        assert!(out.is_err_and(|e| e.contains("rename, effort or delete")));
        // Launching is enough to delete.
        let out = w.call(&bot, "update_session", json!({ "session": theirs, "action": "delete" })).expect("delete");
        assert_eq!(out["deleted"], json!([theirs]));
        assert!(session::get(w.turns.store(), theirs.clone()).unwrap().is_none());
        assert!(w.blocks(&theirs).is_empty(), "the transcript outlived the session");
        // The user may delete any.
        w.call(&w.user(), "update_session", json!({ "session": chat.id, "action": "delete" })).expect("user delete");
        assert_eq!(*gone.lock().unwrap(), vec![theirs, chat.id]);
    }

    fn git(dir: &Path, args: &[&str]) {
        let status = std::process::Command::new("git")
            .args(["-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false"])
            .args(args)
            .current_dir(dir)
            .output()
            .expect("git");
        assert!(status.status.success(), "git {args:?}: {}", String::from_utf8_lossy(&status.stderr));
    }

    /// Delete removes the session and its transcript but never its worktree,
    /// and refuses while the worktree holds uncommitted work.
    #[test]
    fn delete_removes_the_session_never_its_worktree_and_refuses_uncommitted_changes() {
        let w = world();
        git(&w.dir, &["init", "-q"]);
        std::fs::write(w.dir.join("a.txt"), "a").unwrap();
        git(&w.dir, &["add", "a.txt"]);
        git(&w.dir, &["commit", "-q", "-m", "init"]);
        let tree = w.dir.join("tree");
        git(&w.dir, &["worktree", "add", "-q", "-b", "feature", tree.to_str().unwrap()]);
        let tree = std::fs::canonicalize(&tree).unwrap().to_string_lossy().into_owned();
        let bot = w.session("bot", "Lead", "full");
        let row = session::create_in_worktree(
            w.turns.store(),
            w.workspace.clone(),
            "terminal".into(),
            "Feature".into(),
            "opencode".into(),
            MODEL.into(),
            String::new(),
            "full".into(),
            Some(tree.clone()),
        )
        .unwrap();
        session::set_launched_by(w.turns.store(), &row.id, bot.session_id().unwrap()).unwrap();
        w.say(&row, "work on it");

        std::fs::write(std::path::Path::new(&tree).join("wip.txt"), "unsaved").unwrap();
        let out = w.call(&bot, "update_session", json!({ "session": row.id, "action": "delete" }));
        assert!(out.is_err_and(|e| e.contains("1 uncommitted change") && e.contains("nothing was deleted")));
        assert!(session::get(w.turns.store(), row.id.clone()).unwrap().is_some());
        assert!(w.blocks(&row.id).iter().any(|block| block.text == "work on it"));
        std::fs::remove_file(std::path::Path::new(&tree).join("wip.txt")).unwrap();

        let out = w.call(&bot, "update_session", json!({ "session": row.id, "action": "delete" })).expect("delete");
        assert_eq!(out["deleted"], json!([row.id]), "{out}");
        assert!(session::get(w.turns.store(), row.id.clone()).unwrap().is_none());
        assert!(w.blocks(&row.id).is_empty());
        assert!(std::path::Path::new(&tree).is_dir(), "the worktree went with the session");
    }

    #[test]
    fn deleting_a_session_takes_its_subagents_with_it() {
        let w = world();
        let user = w.user();
        let chat = w.user_session("opencode", MODEL, "full");
        let sub = session::create_child(
            w.turns.store(),
            w.workspace.clone(),
            "Sub".into(),
            "opencode".into(),
            MODEL.into(),
            "full".into(),
            None,
            Some(chat.id.clone()),
        )
        .unwrap();
        session::set_launched_by(w.turns.store(), &chat.id, "someone").ok();
        let out = w.call(&user, "update_session", json!({ "session": chat.id, "action": "delete" })).expect("delete");
        assert_eq!(out["deleted"], json!([sub.id, chat.id]), "{out}");
        assert!(session::get(w.turns.store(), sub.id).unwrap().is_none());
    }

    /// Product decision after step 1: a subagent may always write to the
    /// session that started it, whatever its autonomy, since its reports reach
    /// that parent anyway; the autonomy rule holds for everyone else.
    #[test]
    fn a_subagent_may_write_to_its_parent_whatever_its_autonomy() {
        let w = world();
        let lead = w.session("bot", "Lead", "full");
        let other = w.session("bot", "Other", "full");
        let out =
            w.call(&lead, "delegate", json!({ "provider": "opencode", "prompt": "x", "autonomy": "ask" })).expect("delegate");
        let id = out["id"].as_str().unwrap().to_string();
        w.settle(&id);
        let kid = Caller::from_session(w.row(&id));
        assert_eq!(kid.autonomy(), "ask");
        let to_parent = w.call(&kid, "send_message", json!({ "to": lead.session_id().unwrap(), "text": "a question" }));
        assert!(to_parent.is_ok(), "{to_parent:?}");
        assert_eq!(w.peer(&kid, lead.session_id().unwrap())["write"], json!(true));
        let to_other = w.call(&kid, "send_message", json!({ "to": other.session_id().unwrap(), "text": "hi" }));
        assert!(to_other.is_err_and(|e| e.contains("allowed more than it is")));
        w.settle(lead.session_id().unwrap());
    }

    // ---- Delivery to a session in the chat: wake, batch, steer, confirm, resume, pause ----

    impl World {
        /// A subagent of `parent`, with a report from it dropped in `parent`'s
        /// box the way the end of its turn would, and the wake after it.
        fn report_to(&self, parent: &str, kid: &Session, text: &str, cursor: i64) -> mailbox::Letter {
            let from = crate::caller::Caller::from_session(kid.clone()).sender();
            let letter = mailbox::Letter::new(parent, &from, text, mailbox::REPORT, Some(cursor));
            session_events::record_reporting(self.turns.store(), &kid.id, cursor, "turn", "completed", "", None, Some(&letter))
                .unwrap();
            self.turns.wake(parent);
            letter
        }

        fn kid_of(&self, parent: &str, name: &str) -> Session {
            session::create_child(
                self.turns.store(),
                self.workspace.clone(),
                name.into(),
                "opencode".into(),
                "m".into(),
                "full".into(),
                None,
                Some(parent.to_string()),
            )
            .unwrap()
        }
    }

    #[test]
    fn a_batch_goes_wait_after_the_newest_letter_and_never_later_than_max_after_the_first() {
        use crate::turns::batch_remaining as left;
        // Two seconds after the newest while that is inside the ten seconds.
        assert_eq!(left(1_000, 1_000, 1_000, 2_000, 10_000), 2_000);
        assert_eq!(left(1_000, 2_500, 3_000, 2_000, 10_000), 1_500);
        // A letter every second keeps pushing the window; the ten seconds cut it.
        assert_eq!(left(1_000, 10_500, 10_600, 2_000, 10_000), 400);
        assert!(left(1_000, 10_900, 11_000, 2_000, 10_000) <= 0, "the tenth second from the first goes now");
        // Long overdue goes at once.
        assert!(left(0, 100, 50_000, 2_000, 10_000) < 0);
    }

    /// Decision 15 and 17: what its subagents report wakes a session in the
    /// chat, and reports that land close together are one turn.
    #[test]
    fn reports_to_a_chat_session_wake_it_as_one_turn() {
        let w = world();
        let mine = w.user_session("opencode", "opencode/nemotron-3.5-lightning-free", "full");
        w.turns.set_batch_window(Duration::from_millis(400), Duration::from_millis(3_000));
        let (a, b) = (w.kid_of(&mine.id, "kid a"), w.kid_of(&mine.id, "kid b"));
        w.report_to(&mine.id, &a, "a is done", 2);
        std::thread::sleep(Duration::from_millis(150));
        assert!(w.launches().is_empty(), "the first report did not wait for the next");
        w.report_to(&mine.id, &b, "b is done", 2);
        until("one turn on both reports", || w.launches().len() == 1);
        w.settle(&mine.id);
        let woke = prompts(&w);
        assert_eq!(woke.len(), 1, "{woke:?}");
        assert_eq!(woke[0].matches("## Report from session").count(), 2, "{}", woke[0]);
        assert_eq!(mailbox::undelivered_count(w.turns.store(), &mine.id).unwrap(), 0);
        // The count of turns that letters started went up by one.
        assert_eq!(session::auto_turns(w.turns.store(), &mine.id), 1);
    }

    #[test]
    fn a_question_does_not_wait_for_the_batch() {
        let w = world();
        let mine = w.user_session("opencode", "opencode/nemotron-3.5-lightning-free", "full");
        w.turns.set_batch_window(Duration::from_secs(30), Duration::from_secs(60));
        let kid = w.kid_of(&mine.id, "asker");
        let from = crate::caller::Caller::from_session(kid.clone()).sender();
        mailbox::put(w.turns.store(), mailbox::Letter::new(&mine.id, &from, "which branch?", mailbox::QUESTION, Some(2)))
            .unwrap();
        assert!(w.turns.wake(&mine.id), "a question waited for the window");
        w.settle(&mine.id);
        // A report in the same window does wait.
        w.report_to(&mine.id, &kid, "done", 3);
        std::thread::sleep(Duration::from_millis(300));
        assert_eq!(w.launches().len(), 1, "a report did not wait");
        assert_eq!(mailbox::waiting_count(w.turns.store(), &mine.id).unwrap(), 1);
    }

    /// Decision 15 and 17 on a running turn: reports go in as one steer, and
    /// each is a letter delivered where the model read it.
    #[test]
    fn reports_for_a_running_chat_turn_are_one_steer() {
        let w = world();
        w.turns.override_binary("claude", fake_claude(&w.dir));
        w.turns.override_claude_home(w.dir.join("home"));
        let mine = w.user_session("claude", "", "full");
        w.turns.set_batch_window(Duration::from_millis(200), Duration::from_millis(2_000));
        w.type_to(&mine, "SLEEP 2", None, None);
        until("the process", || w.row(&mine.id).provider_session_id.is_some());
        std::thread::sleep(Duration::from_millis(300));
        let (a, b) = (w.kid_of(&mine.id, "kid a"), w.kid_of(&mine.id, "kid b"));
        let (la, lb) = (w.report_to(&mine.id, &a, "a is done", 2), w.report_to(&mine.id, &b, "b is done", 2));
        until("both letters read", || mailbox::undelivered_count(w.turns.store(), &mine.id).unwrap() == 0);
        w.settle(&mine.id);
        // One message into the turn that ran, carrying both reports.
        let input = std::fs::read_to_string(w.dir.join("claude-input.log")).unwrap_or_default();
        let steers: Vec<&str> = input.lines().filter(|line| line.contains("a is done")).collect();
        assert_eq!(steers.len(), 1, "{input}");
        assert!(steers[0].contains("b is done"), "{input}");
        let blocks = w.blocks(&mine.id);
        for letter in [&la, &lb] {
            assert!(blocks.iter().any(|b| b.letter_id.as_deref() == Some(letter.id.as_str())), "{}", letter.text);
        }
        assert_eq!(launched(&w.dir.join("claude-launch.log")).len(), 1, "the reports ran on the turn that was running");
    }

    /// Decision 18: a letter handed to a turn stays undelivered until the
    /// provider says it read it; a daemon that stops first hands it over again.
    #[test]
    fn a_letter_stays_in_the_box_until_the_provider_confirms_it() {
        let w = world();
        let mine = w.user_session("opencode", "opencode/nemotron-3.5-lightning-free", "full");
        let kid = w.kid_of(&mine.id, "kid");
        let from = crate::caller::Caller::from_session(kid).sender();
        let letter = mailbox::enqueue(w.turns.store(), &mine.id, &from, "hello").unwrap();
        let claimed = mailbox::claim_batch(w.turns.store(), &mine.id, 1000).unwrap();
        assert_eq!(claimed.len(), 1);
        // Handed to a turn that has not been confirmed: still on its way.
        w.turns.carrying_for_test(&mine.id, vec![letter.id.clone()]);
        assert_eq!(mailbox::undelivered_count(w.turns.store(), &mine.id).unwrap(), 1);
        // The daemon restarts: it goes back in the box, and the sweep hands it over.
        w.turns.store().with(mailbox::release_unfinished).unwrap();
        assert_eq!(mailbox::waiting_count(w.turns.store(), &mine.id).unwrap(), 1);
        w.turns.deliver_waiting();
        w.settle(&mine.id);
        assert_eq!(mailbox::undelivered_count(w.turns.store(), &mine.id).unwrap(), 0);
        assert!(prompts(&w)[0].contains("hello"), "{:?}", prompts(&w));
        // The confirmation itself marks the letters of the turn delivered.
        let again = mailbox::enqueue(w.turns.store(), &mine.id, &from_of(&w, &mine.id), "again").unwrap();
        mailbox::claim_batch(w.turns.store(), &mine.id, 1000).unwrap();
        w.turns.carrying_for_test(&mine.id, vec![again.id.clone()]);
        assert_eq!(mailbox::undelivered_count(w.turns.store(), &mine.id).unwrap(), 1);
        w.turns.confirm_carried(&mine.id);
        assert_eq!(mailbox::undelivered_count(w.turns.store(), &mine.id).unwrap(), 0);
    }

    fn from_of(w: &World, parent: &str) -> crew_protocol::BotRef {
        crate::caller::Caller::from_session(w.kid_of(parent, "someone")).sender()
    }

    /// Decision 18: a turn that fails before the provider read its letters
    /// gives them back, and does not start the same turn again by itself.
    #[test]
    fn a_turn_that_failed_unread_gives_its_letters_back_and_waits() {
        let w = world();
        let mine = session::create(
            w.turns.store(),
            w.workspace.clone(),
            "terminal".into(),
            "mine".into(),
            "nothing-wired".into(),
            String::new(),
            String::new(),
            "full".into(),
        )
        .unwrap();
        let from = from_of(&w, &mine.id);
        let letter = mailbox::enqueue(w.turns.store(), &mine.id, &from, "hello").unwrap();
        assert!(w.turns.drain_mailbox(&mine.id));
        w.settle(&mine.id);
        let page = mailbox::waiting(w.turns.store(), &mine.id).unwrap();
        assert_eq!(page.iter().map(|l| l.id.as_str()).collect::<Vec<_>>(), [letter.id.as_str()], "the letter is back in the box");
        std::thread::sleep(Duration::from_millis(200));
        assert!(!w.turns.is_running(&mine.id), "the same failing turn started again");
    }

    /// Decision 14: a letter to an exited independent session is a turn on
    /// its conversation.
    #[test]
    fn a_message_to_an_exited_independent_session_resumes_it() {
        let w = world();
        let mine = w.user_session("opencode", "opencode/nemotron-3.5-lightning-free", "full");
        w.say(&mine, "first");
        let bound = w.row(&mine.id).provider_session_id.clone();
        assert!(bound.is_some());
        w.turns.transcripts().set_status(&mine.id, "exited", None);
        w.turns.transcripts().flush(&mine.id);
        let bot = w.session("bot", "Planner", "full");
        let out = w.call(&bot, "send_message", json!({ "to": mine.id, "text": "and now this" })).expect("send");
        assert_eq!(out["delivery"], "resumed", "{out}");
        w.settle(&mine.id);
        assert_eq!(prompts(&w).last().map(|p| p.contains("and now this")), Some(true), "{:?}", prompts(&w));
        assert_eq!(w.row(&mine.id).provider_session_id, bound, "it resumed the conversation it had");
        // A subagent that exited stays exited.
        let lead = w.session("terminal", "shell", "full");
        let kid = w.start(&lead, "x");
        w.settle(&kid);
        w.call(&lead, "stop_session", json!({ "session": kid })).expect("stop");
        let refused = w.call(&bot, "send_message", json!({ "to": kid, "text": "again" }));
        assert!(refused.is_err_and(|e| e.contains("start another with delegate")));
    }

    /// Decision 18: the startup sweep also hands a top-level session the
    /// letters its subagents left, even long after the batch window.
    #[test]
    fn the_startup_sweep_delivers_a_top_level_sessions_reports() {
        let w = world();
        let mine = w.user_session("opencode", "opencode/nemotron-3.5-lightning-free", "full");
        w.turns.set_batch_window(Duration::from_secs(2), Duration::from_secs(10));
        let kid = w.kid_of(&mine.id, "kid");
        let from = crate::caller::Caller::from_session(kid).sender();
        let mut old = mailbox::Letter::new(&mine.id, &from, "done while the daemon was down", mailbox::REPORT, Some(2));
        old.at -= 60_000;
        mailbox::put(w.turns.store(), old).unwrap();
        w.turns.deliver_waiting();
        w.settle(&mine.id);
        assert_eq!(mailbox::waiting_count(w.turns.store(), &mine.id).unwrap(), 0);
        assert!(prompts(&w)[0].contains("done while the daemon was down"), "{:?}", prompts(&w));
    }

    /// Decision 27: twenty turns in a row that letters started pause a
    /// session; letters keep landing without waking it, and the user writing
    /// resumes it.
    #[test]
    fn a_session_pauses_after_twenty_automatic_turns_and_the_user_resumes_it() {
        let w = world();
        let mine = w.user_session("opencode", "opencode/nemotron-3.5-lightning-free", "full");
        let kid = w.kid_of(&mine.id, "kid");
        session::set_auto_turns(w.turns.store(), &mine.id, session::PAUSE_AFTER - 1);
        assert!(!w.row(&mine.id).paused);
        w.report_to(&mine.id, &kid, "nineteen and one", 2);
        w.settle(&mine.id);
        assert_eq!(session::auto_turns(w.turns.store(), &mine.id), session::PAUSE_AFTER);
        assert!(w.row(&mine.id).paused, "the row says it is paused");
        let launches = w.launches().len();
        // Letters still land, and wake nothing.
        w.report_to(&mine.id, &kid, "one more", 3);
        let from = from_of(&w, &mine.id);
        let sent = mailbox::enqueue(w.turns.store(), &mine.id, &from, "and a message").unwrap();
        assert!(!w.turns.deliver_to(&w.row(&mine.id)));
        std::thread::sleep(Duration::from_millis(200));
        assert_eq!(w.launches().len(), launches);
        assert_eq!(mailbox::waiting_count(w.turns.store(), &mine.id).unwrap(), 2);
        assert!(sent.at > 0);
        // The user writes: the count starts over and what waited goes in the turn.
        w.say(&mine, "carry on");
        assert_eq!(session::auto_turns(w.turns.store(), &mine.id), 0);
        assert!(!w.row(&mine.id).paused);
        let last = prompts(&w).last().cloned().unwrap();
        assert!(last.contains("carry on") && last.contains("one more") && last.contains("and a message"), "{last}");
    }

    /// Decision 27 for a bot: twenty turns in a row that another's letters
    /// started pause it, so two bots cannot answer each other for ever; the
    /// user writing to it resumes it.
    #[test]
    fn a_bot_pauses_after_twenty_automatic_turns_and_the_user_resumes_it() {
        let w = world();
        let bot = w.session("bot", "Planner", "full");
        let other = w.session("bot", "Other", "full");
        let id = bot.session_id().unwrap().to_string();
        let from = other.sender();
        session::set_auto_turns(w.turns.store(), &id, session::PAUSE_AFTER - 1);
        assert!(!w.row(&id).paused);
        mailbox::enqueue(w.turns.store(), &id, &from, "nineteen and one").unwrap();
        assert!(w.turns.wake(&id), "the letter started a turn");
        w.settle(&id);
        assert_eq!(session::auto_turns(w.turns.store(), &id), session::PAUSE_AFTER);
        assert!(w.row(&id).paused, "the row says it is paused");
        let launches = w.launches().len();
        // Letters still land, and wake nothing.
        mailbox::enqueue(w.turns.store(), &id, &from, "one more").unwrap();
        assert!(!w.turns.wake(&id));
        std::thread::sleep(Duration::from_millis(200));
        assert_eq!(w.launches().len(), launches);
        assert_eq!(mailbox::waiting_count(w.turns.store(), &id).unwrap(), 1);
        // The user writes: the count starts over, and the letter that waited
        // goes in the turn that follows (one automatic turn again).
        w.say(&w.row(&id), "carry on");
        until("the letter that waited is read", || mailbox::waiting_count(w.turns.store(), &id).unwrap() == 0);
        w.settle(&id);
        assert!(!w.row(&id).paused);
        assert!(session::auto_turns(w.turns.store(), &id) <= 1);
    }
}
