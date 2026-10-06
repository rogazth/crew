//! Sessions and messaging as MCP tools: who is there (`list_peers`), write to
//! one (`send_message`), start a session on a job, read what it did, stop it.
//!
//! The words, as every model that reads these tools is told: a bot is a
//! persistent identity Crew keeps; a session is one provider CLI and can be
//! thrown away. A session a caller starts is its child: each turn it ends, its
//! final message is its report, which wakes a bot parent; a terminal parent
//! (which cannot be woken) reads it, or waits for it with `wait: true`.
//!
//! `send_message` is one way to write to anyone: a bot, a session you
//! started, a top-level session. The mailbox is the queue: idle, the reader
//! starts on it now; busy, it waits for the turn to end; `steer` puts it into
//! the running turn where the CLI can take that. To a child waiting on a
//! question, it is the answer.

use std::collections::{BTreeMap, HashMap};
use std::sync::Arc;
use std::time::{Duration, Instant};

use crew_protocol::{Block, BlockRole, ToolStatus, TurnStart};
use serde_json::{json, Value};

use crate::caller::Caller;
use crate::mailbox;
use crate::session::{self, Session};
use crate::session_events::{self, Event, Signal};
use crate::store::{now_millis, Store};
use crate::tools::{cli, provider_models, provider_names, text, unknown_model, Audience, Tool, ToolFamily, ToolOutput, GLOSSARY};
use crate::turns::TurnHost;
use crate::worktree::Worktree;

/// Live sessions one parent may have: anything not exited counts.
pub const LIVE_CAP: usize = 4;
/// How long `start_session` with `wait` blocks by default, and at most. The
/// MCP shim gives the call that long and a margin more (`mcp::call_timeout`).
pub const WAIT_DEFAULT_S: u64 = 600;
pub const WAIT_MAX_S: u64 = 3600;
/// The CLIs that take a message into a turn that is running.
const STEERABLE: [&str; 2] = ["claude", "codex"];
/// What `read_session` hands back without `max_bytes`, and at most.
const READ_DEFAULT: usize = 16 * 1024;
const READ_MAX: usize = 256 * 1024;
/// How long an idle child is kept before it exits, unless
/// `CREW_SESSION_IDLE_MINUTES` says otherwise.
pub const IDLE_MINUTES: u64 = 30;

type Made = Arc<dyn Fn(&Session) + Send + Sync>;
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
        }
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
    /// under their parent's cap and nothing else, since there is no process to
    /// keep between turns. Returns the ids that went.
    pub fn reap(&self, limit: Duration) -> Result<Vec<String>, String> {
        let before = now_millis() - limit.as_millis() as i64;
        let idle: Vec<Session> = session::list_all(&self.store)?
            .into_iter()
            .filter(|row| row.kind == "child" && matches!(row.status.as_str(), "idle" | "error"))
            .filter(|row| row.updated_at < before && !self.turns.is_running(&row.id))
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

    /// The session `id`, if this caller may drive it: one it started, or any
    /// at all for the user. A bot and a terminal are refused with what
    /// reaches them instead.
    fn owned(&self, caller: &Caller, id: &str) -> Result<Session, String> {
        let workspace = caller.workspace_id()?;
        let found = session::get(&self.store, id.trim().to_string())?
            .filter(|row| row.workspace_id == workspace)
            .ok_or_else(|| format!("No session {id} in this workspace. list_peers has the ones you started."))?;
        match found.kind.as_str() {
            "bot" => {
                return Err(format!(
                    "{id} is the bot {}: reach it with send_message. A bot is written to, not driven as a session.",
                    found.name
                ))
            }
            "terminal" => {
                return Err(format!(
                    "{id} is a terminal session: the user drives its CLI, not Crew. Only a session started with \
                     start_session can be driven."
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

    /// Whether the caller is the one a session reports to, whose `seen` it is.
    fn is_owner(caller: &Caller, row: &Session) -> bool {
        match caller {
            Caller::User { .. } => row.parent_id.is_none(),
            _ => caller.session_id() == row.parent_id.as_deref(),
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

    /// The status as a peer reads it: waiting on a question it can answer,
    /// or on the user.
    fn peer_status(&self, row: &Session) -> String {
        match row.status.as_str() {
            "needs-input" if self.pending_question(row).is_some() => "question".into(),
            "needs-input" => "waiting_for_user".into(),
            "starting" => "working".into(),
            "done" => "idle".into(),
            other => other.to_string(),
        }
    }

    /// Whether `caller` may write to `target`, and if not, why. A bot takes
    /// anyone's letters; a session takes its parent's, the user's, the
    /// answer of anyone it wrote to, and, when it has no parent (a top-level
    /// session), anyone's. Nobody writes to itself, and a terminal has no
    /// turns to put a message in.
    fn may_write(&self, caller: &Caller, target: &Session) -> Result<(), String> {
        if caller.session_id() == Some(target.id.as_str()) {
            return Err(
                "That is you. Nothing writes to itself: carry on in this turn, or to come back to something later, \
                 save_routine with a once schedule."
                    .into(),
            );
        }
        match target.kind.as_str() {
            "terminal" => Err(format!(
                "{} ({}) is a terminal session: the user drives its CLI, and Crew has no turns to put a message in.",
                target.name, target.id
            )),
            _ if target.status == "exited" => Err(format!(
                "{} has exited, so nothing can reach it. read_session still reads it; start_session starts another.",
                target.name
            )),
            "bot" => Ok(()),
            _ if target.parent_id.is_none() => Ok(()),
            _ if matches!(caller, Caller::User { .. }) || caller.session_id() == target.parent_id.as_deref() => Ok(()),
            // It asked: the answer may go back.
            _ if caller.session_id().is_some_and(|me| mailbox::has_written(&self.store, &target.id, me)) => Ok(()),
            _ => Err(format!(
                "{} ({}) was started by {}, not by you: only whoever started a session (and the user) writes to it.",
                target.name,
                target.id,
                self.who(target.parent_id.as_deref())
            )),
        }
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
        let user = matches!(caller, Caller::User { .. });
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
                "child" => {
                    let mine = row.parent_id.is_some() && row.parent_id.as_deref() == me;
                    mine || ((row.parent_id.is_none() || user) && row.status != "exited")
                }
                _ => true,
            })
            .map(|row| {
                let kind = match row.kind.as_str() {
                    "bot" => "bot",
                    "terminal" => "terminal",
                    _ => "session",
                };
                let mut out = json!({
                    "id": row.id,
                    "name": row.name,
                    "kind": kind,
                    "status": self.peer_status(row),
                });
                if let Some(parent) = row.parent_id.as_deref() {
                    out["parent"] = json!(if Some(parent) == me { "you".to_string() } else { self.who(Some(parent)) });
                }
                if let Some(by) = row.handed_off_by.as_deref() {
                    out["handed_off_by"] = json!(if Some(by) == me { "you".to_string() } else { self.who(Some(by)) });
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
                out["write"] = json!(self.may_write(caller, row).is_ok());
                out
            })
            .collect();
        Ok(Value::Array(listed))
    }

    fn send(&self, caller: &Caller, args: &Value) -> Result<Value, String> {
        let to = text(args.get("to"))
            .ok_or("to is required: an id from list_peers, or from the line a message arrived on")?;
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
        let body = text(args.get("text"));
        if body.is_none() && answers.is_none() {
            return Err("text is required".into());
        }
        let target = self.find_peer(caller, &to)?;
        self.may_write(caller, &target)?;
        // A child stopped on a question takes this as the answer, from whoever
        // may drive it: the question is theirs to answer.
        let drives = matches!(caller, Caller::User { .. }) || caller.session_id() == target.parent_id.as_deref();
        if let Some(request) = self.pending_question(&target).filter(|_| target.kind == "child" && drives) {
            return self.answer(caller, &target, &request, body.as_deref(), answers);
        }
        let Some(body) = body else {
            return Err(format!("{} is not waiting on a question, so there is nothing for answers to answer: send text.", target.name));
        };
        let mut fell_back = None;
        if steer {
            let tried = if !STEERABLE.contains(&target.provider.as_str()) {
                Err(format!("{} cannot take a message in the middle of a turn", target.provider))
            } else if !self.turns.is_running(&target.id) {
                Err("no turn was running".to_string())
            } else {
                self.turns.steer(&target.id, &body, caller.sender())
            };
            match tried {
                Ok(()) => {
                    return Ok(json!({
                        "to": target.name,
                        "id": target.id,
                        "delivery": "steered",
                        "note": "It reads this at its next step, in the turn it is in, so that turn's answer takes it into \
                                 account. Should the turn end first, it becomes the next turn."
                    }))
                }
                Err(why) => fell_back = Some(why),
            }
        }
        mailbox::enqueue(&self.store, &target.id, &caller.sender(), &body)?;
        // What goes over is the oldest letter, which may not be this one: a
        // queue that delivers out of order is worse than one that waits.
        let started = self.turns.deliver_to(&target);
        let waiting = mailbox::waiting_count(&self.store, &target.id)?;
        let mut note = if started {
            format!("{} is reading it now.", target.name)
        } else if target.status == "needs-input" {
            format!("{} is waiting for the user's approval in Crew; it reads this when its turn ends.", target.name)
        } else {
            format!("{} is busy; it reads this the moment its current turn ends.", target.name)
        };
        if let Some(why) = fell_back {
            note = format!("Not steered ({why}), so it was queued as a message. {note}");
        }
        match caller {
            Caller::Terminal(_) => note.push_str(" It cannot write back to you."),
            Caller::Child(me) if me.parent_id.as_deref() != Some(target.id.as_str()) => {
                note.push_str(" It cannot write back to you: only whoever started you can.")
            }
            Caller::User { .. } => note.push_str(" Its reply will be in its chat."),
            _ => {}
        }
        Ok(json!({
            "to": target.name,
            "id": target.id,
            "delivery": if started { "started" } else { "queued" },
            "waiting": waiting,
            "note": note
        }))
    }

    /// `send_message` to a child waiting on a question: the answer, through
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
        let map: HashMap<String, String> = questions.into_iter().zip(given).collect();
        self.turns.answer(&target.id, request_id, Some(map)).map_err(|error| {
            if error.contains("already answered") {
                format!("{}'s question was already answered (the user may have answered it in Crew). Nothing was sent.", target.name)
            } else {
                format!("{}'s question could not be answered: {error}", target.name)
            }
        })?;
        self.saw(caller, target, target.cursor);
        let note = match caller {
            Caller::Bot(_) => "It carries on with your answer. Its report wakes you when its turn ends.",
            Caller::Terminal(_) => "It carries on with your answer. Check it with read_session.",
            _ => "It carries on with your answer.",
        };
        Ok(json!({ "to": target.name, "id": target.id, "delivery": "answered", "note": note }))
    }

    fn start(&self, caller: &Caller, args: &Value) -> Result<Value, String> {
        let workspace = caller.workspace_id()?.to_string();
        let owner = text(args.get("owner")).unwrap_or_else(|| "me".into());
        if owner != "me" && owner != "user" {
            return Err(format!("owner is me or user, not \"{owner}\""));
        }
        let wait = args.get("wait").and_then(Value::as_bool).unwrap_or(false);
        if owner == "user" && wait {
            return Err(
                "wait is for a session you own. One handed to the user (owner user) reports to nobody, so there is \
                 nothing to wait for."
                    .into(),
            );
        }
        let timeout = wait_seconds(args)?;
        let prompt = text(args.get("prompt"))
            .ok_or_else(|| "prompt is required: the session starts with nothing but it".to_string())?;
        let provider = text(args.get("provider"))
            .or_else(|| caller.session().map(|me| me.provider.clone()))
            .unwrap_or_else(|| "claude".into());
        let models = provider_models(&provider)
            .ok_or_else(|| format!("Unknown provider \"{provider}\". One of: {}", provider_names().join(", ")))?;
        let model = match text(args.get("model")) {
            Some(model) if models.contains(&model.as_str()) => model,
            Some(model) => return Err(unknown_model(&model, &provider, &models)),
            None => match caller.session().filter(|me| me.provider == provider && !me.model.is_empty()) {
                Some(me) => me.model.clone(),
                None => crate::tools::default_model(&provider).to_string(),
            },
        };
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
        if owner == "me" {
            if let Some(me) = caller.session() {
                let live = self.live_children(&workspace, &me.id)?;
                if live.len() >= LIVE_CAP {
                    return Err(format!(
                        "You already have {LIVE_CAP} live sessions: {}. Stop one with stop_session first; one idle \
                         for {} minutes ends on its own.",
                        live.iter()
                            .map(|row| format!("{} {} ({})", row.name, row.id, row.status))
                            .collect::<Vec<_>>()
                            .join(", "),
                        Self::idle_limit().as_secs() / 60
                    ));
                }
            }
        }
        let worktree = self.worktree(caller, &workspace, args.get("worktree"), &name)?;
        if owner == "user" {
            return self.hand_off(caller, &workspace, name, provider, model, autonomy, worktree, prompt);
        }
        let row = session::create_child(
            &self.store,
            workspace.clone(),
            name.clone(),
            provider.clone(),
            model.clone(),
            autonomy.clone(),
            worktree.clone(),
            caller.session_id().map(str::to_string),
        )?;
        (self.on_created)(&row);
        if let Caller::Bot(me) = caller {
            self.turns
                .transcripts()
                .append_system(&me.id, &format!("Started session {name} ({})", row.id));
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
        }) {
            let _ = session::set_status(&self.store, row.id.clone(), "error".into());
            return Err(format!("The session was made ({}) but its first turn did not start: {error}", row.id));
        }
        let mut out = json!({
            "id": row.id,
            "name": name,
            "provider": provider,
            "model": model,
            "autonomy": autonomy,
            "worktree": worktree.as_deref().unwrap_or("main checkout"),
            "owner": "me",
        });
        let waited = if wait {
            self.await_turn(caller, &row, Duration::from_secs(timeout))?
        } else {
            json!({
                "status": "starting",
                "note": match caller {
                    Caller::Bot(_) => "It is working on the prompt now. Its report wakes you when its turn ends: end your \
                                       turn rather than wait. read_session shows what it did; send_message gives it more.",
                    Caller::Terminal(_) => "It is working on the prompt now. Nothing can wake you, so check it with \
                                            read_session (or pass wait: true next time); send_message gives it more.",
                    _ => "It is working on the prompt now; its chat is in Crew. read_session shows what it did.",
                }
            })
        };
        if let (Some(out), Some(waited)) = (out.as_object_mut(), waited.as_object()) {
            out.extend(waited.clone());
        }
        Ok(out)
    }

    /// `start_session` with owner user: a terminal session on its own, the
    /// user's to carry on, with the prompt waiting in its box for its CLI's
    /// first prompt (see `terminal::launch`); the window opens its tab. It is
    /// nobody's child and reports to nobody.
    #[allow(clippy::too_many_arguments)]
    fn hand_off(
        &self,
        caller: &Caller,
        workspace: &str,
        name: String,
        provider: String,
        model: String,
        autonomy: String,
        worktree: Option<String>,
        prompt: String,
    ) -> Result<Value, String> {
        let row = session::create_in_worktree(
            &self.store,
            workspace.to_string(),
            "terminal".into(),
            name.clone(),
            provider.clone(),
            model.clone(),
            String::new(),
            autonomy.clone(),
            worktree.clone(),
        )
        .map_err(|error| match &worktree {
            Some(tree) => format!("The worktree is at {tree}, but its session could not be made: {error}"),
            None => error,
        })?;
        if let Some(me) = caller.session() {
            session::set_handed_off_by(&self.store, &row.id, &me.id)?;
        }
        mailbox::enqueue(&self.store, &row.id, &caller.sender(), &prompt)?;
        let row = session::get(&self.store, row.id.clone())?.unwrap_or(row);
        (self.on_created)(&row);
        if let Caller::Bot(me) = caller {
            self.turns
                .transcripts()
                .append_system(&me.id, &format!("Handed {name} ({}) to the user", row.id));
        }
        let branch = worktree.as_deref().and_then(|tree| {
            crate::worktree::branches(tree).into_iter().find(|(path, _)| path == tree).and_then(|(_, branch)| branch)
        });
        Ok(json!({
            "id": row.id,
            "name": name,
            "provider": provider,
            "model": model,
            "worktree": worktree.as_deref().unwrap_or("main checkout"),
            "branch": branch,
            "owner": "user",
            "status": "handed off",
            "note": format!(
                "{name} opens in a tab of Crew{} and starts on the prompt. It is the user's now: it does not report to \
                 you, and nothing you send reaches it.",
                worktree.as_deref().map(|tree| format!(", in {tree},")).unwrap_or_default()
            )
        }))
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
                        if request["kind"] != "question" {
                            // An approval: the user's, in Crew. Keep waiting.
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
                    for key in ["outcome", "report_truncated"] {
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
                        "status": self.peer_status(&now),
                        "note": "It is not working, and has nothing new to report. read_session shows what it did."
                    }))
                }
                _ => return Ok(self.still_running(caller, &now, timeout)),
            }
        }
    }

    fn still_running(&self, caller: &Caller, row: &Session, timeout: Duration) -> Value {
        let mut note = format!("Still working after {}s; it carries on.", timeout.as_secs());
        if self.peer_status(row) == "waiting_for_user" {
            note.push_str(" It is waiting for the user to approve something in Crew.");
        }
        note.push_str(match caller {
            Caller::Bot(_) => " Its report will wake you: end your turn.",
            Caller::Terminal(_) => " Check it with read_session.",
            _ => " Check it with read_session, or in Crew.",
        });
        json!({ "status": "running", "note": note })
    }

    /// Where a new session works: `current` (the caller's own folder), `new`
    /// (a branch of its own), or a branch or a worktree path, made if it is
    /// not there yet (checked out if the branch exists, tracked from a remote
    /// if only a remote has it, otherwise made from the main checkout's HEAD).
    fn worktree(&self, caller: &Caller, workspace: &str, wanted: Option<&Value>, name: &str) -> Result<Option<String>, String> {
        let here = caller.worktree().map(str::to_string);
        let wanted = text(wanted).unwrap_or_else(|| "current".into());
        if wanted == "current" {
            return Ok(here);
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
            return (self.make_worktree)(&folder, &branch).map(|tree| Some(tree.path));
        }
        let existing = crate::worktree::list(&folder).into_iter().find(|tree| {
            tree.branch.as_deref() == Some(wanted.as_str()) || tree.path == wanted
        });
        match existing {
            Some(tree) if tree.main => Ok(None),
            Some(tree) => Ok(Some(tree.path)),
            None if wanted.starts_with('/') => Err(format!("{wanted} is not a worktree of this workspace")),
            None => (self.make_worktree)(&folder, &wanted).map(|tree| Some(tree.path)),
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
                let queued = matches!(row.status.as_str(), "idle" | "error")
                    && mailbox::undelivered_count(&self.store, &row.id)? > 0;
                running |= matches!(row.status.as_str(), "starting" | "working") || self.turns.is_running(&row.id) || queued;
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
        let ids: Vec<String> = args["sessions"].as_array().into_iter().flatten().filter_map(Value::as_str).map(str::to_string).collect();
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

    fn read(&self, caller: &Caller, args: &Value) -> Result<Value, String> {
        let id = text(args.get("session")).ok_or("session is required")?;
        let row = self.owned(caller, &id)?;
        let since = args.get("since").and_then(Value::as_i64).map(|n| n.max(0) as usize);
        let budget = args
            .get("max_bytes")
            .and_then(Value::as_u64)
            .map(|n| (n as usize).clamp(1, READ_MAX))
            .unwrap_or(READ_DEFAULT);
        let tools = args.get("include_tools").and_then(Value::as_bool).unwrap_or(false);
        let (blocks, _) = self.turns.transcripts().since(&row.id, 0);
        let total = blocks.len();
        let running = matches!(row.status.as_str(), "starting" | "working" | "needs-input");
        // A block still being written ends the read before it, so the next
        // read with this cursor reads it again, whole.
        let settled = if running {
            blocks.iter().position(open).unwrap_or(total)
        } else {
            total
        };
        let (start, end) = match since {
            Some(from) => {
                let from = from.min(total);
                let mut end = from;
                let mut spent = 0;
                while end < settled.max(from) {
                    let line = render(&blocks[end], end + 1, tools);
                    if spent + line.len() > budget && end > from {
                        break;
                    }
                    spent += line.len() + 1;
                    end += 1;
                }
                (from, end)
            }
            None => {
                let end = settled;
                let mut start = end;
                let mut spent = 0;
                while start > 0 {
                    let line = render(&blocks[start - 1], start, tools);
                    if spent + line.len() > budget && start < end {
                        break;
                    }
                    spent += line.len() + 1;
                    start -= 1;
                }
                (start, end)
            }
        };
        let text: Vec<String> = (start..end).map(|at| render(&blocks[at], at + 1, tools)).collect();
        self.saw(caller, &row, end as i64);
        let status = self.peer_status(&row);
        let mut note = if end < total {
            "There is more after cursor: call again with since = cursor.".to_string()
        } else {
            "That is everything so far. Pass cursor as since next time to read only what is new.".to_string()
        };
        match status.as_str() {
            "question" => note.push_str(&format!(
                " It is waiting on a question: answer it with send_message to {} (text for one question, answers for several).",
                row.id
            )),
            "waiting_for_user" => note.push_str(" It is waiting for the user to approve something in Crew."),
            _ => {}
        }
        Ok(json!({
            "session": row.id,
            "status": status,
            "text": text.join("\n"),
            "start": start,
            "cursor": end,
            "more": end < total,
            "note": note
        }))
    }

    fn stop(&self, caller: &Caller, args: &Value) -> Result<Value, String> {
        let id = text(args.get("session")).ok_or("session is required")?;
        let row = self.owned(caller, &id)?;
        if row.status == "exited" {
            return Ok(json!({ "session": row.id, "status": "exited", "cursor": row.cursor, "note": "It had already exited." }));
        }
        let by = match caller {
            Caller::User { .. } => "the user".to_string(),
            _ => caller.label(),
        };
        if self.turns.exit_child(&row.id, &by) {
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
                &row,
                &format!("stopped by {by}"),
                &format!("Stopped by {by}. The session has exited; its transcript stays here."),
            );
        }
        let now = session::get(&self.store, row.id.clone())?.unwrap_or(row);
        Ok(json!({
            "session": now.id,
            "status": now.status,
            "cursor": now.cursor,
            "note": "Its CLI is gone; read_session still reads what it did."
        }))
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
    let (report, clipped) = session_events::clip_report(&event.report);
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
        out["report"] = json!(report);
        if clipped {
            out["report_truncated"] = json!(format!(
                "The report is longer than this; read_session with since = {} reads the turn.",
                event.cursor.saturating_sub(40).max(0)
            ));
        }
    }
    if let Some(request) = &event.request {
        out["request"] = request.clone();
    }
    if earlier > 0 {
        out["earlier_events"] = json!(format!(
            "{earlier} earlier event(s) happened since your cursor; read_session shows them."
        ));
    }
    out
}

/// A block still being written: text streaming in, a tool not done.
fn open(block: &Block) -> bool {
    block.streaming == Some(true)
        || block.tool.as_ref().is_some_and(|tool| tool.status == ToolStatus::Pending)
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
    let slug: String = name
        .to_lowercase()
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() { c } else { '-' })
        .collect();
    let slug = slug.split('-').filter(|part| !part.is_empty()).take(5).collect::<Vec<_>>().join("-");
    if slug.is_empty() {
        "session".into()
    } else {
        slug.chars().take(40).collect()
    }
}

fn session_arg() -> Value {
    json!({ "type": "string", "description": "The session's id, from start_session or list_peers." })
}

/// The session tools. They need no host to be described, so the CLI builds
/// its commands from the same list the daemon runs.
pub fn catalog() -> Vec<Tool> {
    vec![
        Tool {
            name: "list_peers",
            description: "Who is in this workspace and who you can write to: its bots and sessions, each with its id, kind (bot, session or terminal), status (idle, working, question: waiting on a question you can answer, waiting_for_user: waiting on the user's approval, error, exited), who started it, where it works (main checkout or its branch), and write: whether send_message reaches it from you.",
            schema: json!({ "type": "object", "properties": {} }),
            audience: Audience::EVERYONE,
            cli: vec![crate::tools::top("peers").about("The bots and sessions here: status, who started them, and whether you can write to them.").eg("crew peers\n  crew peers --json | jq '.[] | select(.kind == \"bot\") | .id'")],
        },
        Tool {
            name: "send_message",
            description: concat!(
                "Write to a bot, to a session you started or that wrote to you, or to a top-level session (one nobody started). It arrives as a turn with your name and id on it: idle, the reader starts on it now; busy, it waits until the current turn ends. ",
                "steer: true puts it into the running turn instead, to correct its course, where the CLI can take that (Claude and Codex); anywhere else it is queued. ",
                "To a session you started that is waiting on a question, it answers the question: text answers a single question (free text is fine), answers gives one answer per question, in order. ",
                "The result says how it went: delivery started, queued, steered or answered. Its answer, if any, reaches you as a message of its own. Nobody writes to itself, to someone else's session, or to a terminal."
            ),
            schema: json!({
                "type": "object",
                "properties": {
                    "to": { "type": "string", "description": "The id of a bot or a session, from list_peers or from the line a message arrived on. Not a name: names are the user's to change." },
                    "text": { "type": "string", "description": "What to say. Give it everything it needs; it cannot see your conversation." },
                    "steer": { "type": "boolean", "description": "Into its running turn, read at its next step (Claude and Codex). Only to correct course; otherwise it is queued." },
                    "answers": { "type": "array", "items": { "type": "string" }, "description": "To a session waiting on several questions: one answer per question, in the order asked." }
                },
                "required": ["to", "text"]
            }),
            audience: Audience::EVERYONE,
            cli: vec![crate::tools::top("send").eg("crew send Reviewer \"look at the diff on main\"\n  crew send 3f2a… run the tests and fix what fails\n  git diff | crew send Reviewer -\n  crew send --steer 3f2a… stop, the API changed")],
        },
        Tool {
            name: "start_session",
            description: concat!(
                "Start a session on one job: a provider CLI (claude, codex, opencode or cursor) working on prompt, in this workspace. It sees nothing of your conversation: put everything it needs in the prompt. ",
                "owner me (the default): it is yours. Each time it ends a turn, its final message, its report, wakes you (a bot) as a turn of its own, so end your turn rather than wait; read_session reads it, send_message gives it more, stop_session ends it. ",
                "wait: true blocks here until its turn ends and returns the report, or returns early with its questions if it asks one; timeout_s is 600 by default and 3600 at most, and on timeout it keeps working (status running). For work that takes more than a few minutes, do not wait. ",
                "owner user: a handoff, a top-level session the user carries on in Crew, with prompt as its first message; it reports to nobody, so it cannot be waited on. ",
                "worktree: current (yours, the default), new (a fresh branch and worktree of its own), or a branch name or worktree path. It runs with your autonomy or less, never more. At most 4 live sessions of your own at once. ",
                "A bot outlives its sessions; a session is one provider CLI process and can be thrown away: to hand work to a bot, use send_message."
            ),
            schema: json!({
                "type": "object",
                "properties": {
                    "prompt": { "type": "string", "description": "The job, with everything it needs: the goal, the files, the constraints, what done looks like, and whether it may commit." },
                    "provider": { "type": "string", "enum": provider_names(), "description": "Which CLI runs it. Defaults to yours." },
                    "model": { "type": "string", "description": format!("Defaults to yours when the provider is yours, else the provider's first. What there is:\n{}", crate::tools::model_sheet()) },
                    "owner": { "type": "string", "enum": ["me", "user"], "description": "me (the default): yours, it reports to you. user: handed to the user, reports to nobody." },
                    "worktree": { "type": "string", "description": "current (the default), new, or a branch name or worktree path." },
                    "wait": { "type": "boolean", "description": "Block until its turn ends and return its report. Not with owner user." },
                    "timeout_s": { "type": "integer", "minimum": 1, "maximum": WAIT_MAX_S, "description": "With wait: seconds to wait, 600 by default, 3600 at most." },
                    "name": { "type": "string", "description": "What it is listed as. Defaults to the provider and the first words of the prompt." },
                    "autonomy": { "type": "string", "enum": ["ask", "edits", "auto", "full"], "description": "Defaults to yours. Never more than yours." }
                },
                "required": ["prompt"]
            }),
            audience: Audience::PARENTS,
            cli: vec![cli("sessions", "start").rest(&["prompt"]).eg("crew sessions start --provider codex fix the failing login test\n  crew sessions start --wait --timeout-s 300 -- what does the billing webhook do?\n  crew sessions start --owner user --worktree new -- carry on with the plan in docs/plan.md")],
        },
        Tool {
            name: "read_session",
            description: "Read a session you started as numbered lines: what was said to it, what it said, each tool it ran as one line (include_tools adds their output). Without since: the tail, up to max_bytes (16 KB by default, 256 KB at most). With since: what came after that cursor. cursor is where the read stopped: pass it back as since to read only what is new; more says there is more. status says whether it is waiting on a question (answer it with send_message) or on the user.",
            schema: json!({
                "type": "object",
                "properties": {
                    "session": session_arg(),
                    "since": { "type": "integer", "minimum": 0, "description": "A cursor from start_session or an earlier read." },
                    "max_bytes": { "type": "integer", "minimum": 1, "maximum": READ_MAX },
                    "include_tools": { "type": "boolean", "description": "Add each tool's output under its line." }
                },
                "required": ["session"]
            }),
            audience: Audience::PARENTS,
            cli: vec![cli("sessions", "read").pos(&["session"]).eg("crew sessions read 3f2a…\n  crew sessions read 3f2a… --since 12 --include-tools")],
        },
        Tool {
            name: "stop_session",
            description: "End a session you started: its CLI is killed mid-turn if it is working, and it exits for good. Its transcript stays in Crew, and read_session still reads it.",
            schema: json!({ "type": "object", "properties": { "session": session_arg() }, "required": ["session"] }),
            audience: Audience::PARENTS,
            cli: vec![cli("sessions", "stop").pos(&["session"]).eg("crew sessions stop 3f2a…")],
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
        let mut note = format!(
            "{GLOSSARY} start_session hands a job to a new session (another provider CLI, in this checkout or a \
             worktree of its own): its report wakes a bot when its turn ends, or wait: true waits for it; \
             read_session reads what it did, send_message gives it more, stop_session ends it. list_peers \
             lists who you can write to."
        );
        if let (Some(me), Ok(workspace)) = (caller.session(), caller.workspace_id()) {
            if let Ok(live) = self.live_children(workspace, &me.id) {
                if !live.is_empty() {
                    note.push_str(&format!(
                        " Sessions you started: {}.",
                        live.iter()
                            .map(|row| format!("{} {} ({}, {})", row.name, row.id, row.provider, self.peer_status(row)))
                            .collect::<Vec<_>>()
                            .join("; ")
                    ));
                }
            }
        }
        Some(note)
    }

    fn run(&self, caller: &Caller, name: &str, args: &Value) -> Result<ToolOutput, String> {
        let out = match name {
            "list_peers" => self.peers(caller)?,
            "send_message" => self.send(caller, args)?,
            "start_session" => self.start(caller, args)?,
            "read_session" => self.read(caller, args)?,
            "stop_session" => self.stop(caller, args)?,
            _ => return Err(format!("Unknown tool \"{name}\"")),
        };
        Ok(out.into())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::caller::CallerKind;
    use crew_protocol::ApprovalDecision;
    use std::os::unix::fs::PermissionsExt;
    use std::path::{Path, PathBuf};
    use std::sync::Mutex;

    /// An opencode that answers with the last line it was handed, keeps the
    /// session it was told to carry on, and logs every launch. `SLEEP n` in
    /// the prompt makes it take that long; `CRASH` makes it die mid-turn.
    fn fake_opencode(dir: &Path) -> (String, PathBuf) {
        let log = dir.join("launches.jsonl");
        let path = dir.join("fake-opencode");
        std::fs::write(
            &path,
            format!(
                r#"#!/usr/bin/env python3
import json, os, sys, time, re, uuid
prompt = sys.stdin.read()
args = sys.argv[1:]
sid = args[args.index("--session") + 1] if "--session" in args else "ses_" + uuid.uuid4().hex[:8]
config = json.loads(os.environ.get("OPENCODE_CONFIG_CONTENT", "{{}}"))
system = "".join(open(path).read() for path in config.get("instructions", []))
with open({log:?}, "a") as f:
    f.write(json.dumps({{"args": args, "prompt": prompt, "system": system}}) + "\n")
print(json.dumps({{"type": "step_start", "sessionID": sid, "part": {{"id": "st", "type": "step-start"}}}}), flush=True)
m = re.search(r"SLEEP (\d+(?:\.\d+)?)", prompt)
if m:
    time.sleep(float(m.group(1)))
if "CRASH" in prompt:
    sys.exit(3)
last = prompt.strip().splitlines()[-1]
print(json.dumps({{"type": "text", "sessionID": sid, "part": {{"id": "t" + uuid.uuid4().hex[:6], "type": "text", "text": "report: " + last}}}}), flush=True)
print(json.dumps({{"type": "step_finish", "sessionID": sid, "part": {{"id": "sf", "type": "step-finish", "reason": "stop", "tokens": {{"input": 1, "output": 1, "reasoning": 0, "cache": {{"read": 0, "write": 0}}}}, "cost": 0}}}}), flush=True)
"#,
                log = log.to_string_lossy()
            ),
        )
        .expect("write fake");
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o755)).expect("chmod");
        (path.to_string_lossy().into_owned(), log)
    }

    /// A Claude Code on stream-json: it answers the initialize request, echoes
    /// each user message as it takes it in (`--replay-user-messages`), and
    /// folds whatever arrived during a turn's `SLEEP n` into that turn.
    fn fake_claude(dir: &Path) -> String {
        let path = dir.join("fake-claude");
        std::fs::write(
            &path,
            r#"#!/usr/bin/env python3
import json, sys, threading, time, re, uuid, queue
args = sys.argv[1:]
sid = args[args.index("--resume") + 1] if "--resume" in args else args[args.index("--session-id") + 1]
replay = "--replay-user-messages" in args
inbox = queue.Queue()
def out(obj):
    print(json.dumps(obj), flush=True)
def text_of(rec):
    return rec["message"]["content"][-1]["text"]
def reader():
    for line in sys.stdin:
        try:
            rec = json.loads(line)
        except Exception:
            continue
        if rec.get("type") == "control_request":
            out({"type": "control_response", "response": {"subtype": "success", "request_id": rec["request_id"], "response": {}}})
        elif rec.get("type") == "user":
            inbox.put(rec)
threading.Thread(target=reader, daemon=True).start()
while True:
    first = inbox.get()
    heard = [text_of(first)]
    if replay:
        out({"type": "user", "message": {"role": "user", "content": [{"type": "text", "text": heard[0]}]}, "session_id": sid})
    b = re.search(r"BACKGROUND (\d+(?:\.\d+)?)", heard[0])
    if b:
        out({"type": "system", "subtype": "task_started", "task_id": "bg1", "is_backgrounded": True, "session_id": sid})
        out({"type": "assistant", "message": {"id": "m0", "role": "assistant", "content": [{"type": "text", "text": "started it in the background"}]}, "session_id": sid})
        out({"type": "result", "subtype": "success", "is_error": False, "result": "started", "session_id": sid, "total_cost_usd": 0, "usage": {}})
        time.sleep(float(b.group(1)))
        out({"type": "system", "subtype": "task_notification", "task_id": "bg1", "status": "completed", "session_id": sid})
        heard.append("the background command finished")
    m = re.search(r"SLEEP (\d+(?:\.\d+)?)", heard[0])
    if m:
        time.sleep(float(m.group(1)))
    while not inbox.empty():
        more = text_of(inbox.get())
        if replay:
            out({"type": "user", "message": {"role": "user", "content": [{"type": "text", "text": more}]}, "session_id": sid})
        heard.append(more)
    reply = "report: " + " + ".join(h.strip().splitlines()[-1] for h in heard)
    out({"type": "assistant", "message": {"id": "m" + uuid.uuid4().hex[:6], "role": "assistant", "content": [{"type": "text", "text": reply}]}, "session_id": sid})
    out({"type": "result", "subtype": "success", "is_error": False, "result": reply, "session_id": sid, "total_cost_usd": 0, "usage": {}})
"#,
        )
        .expect("write fake");
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o755)).expect("chmod");
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
    }

    fn world() -> World {
        let turns = TurnHost::test_new();
        turns.test_agents().set_events(Arc::new(Fanout(turns.clone())));
        let dir = std::env::temp_dir().join(format!("crew-st-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).expect("dir");
        let (fake, log) = fake_opencode(&dir);
        turns.override_binary("opencode", fake);
        let workspace = crate::workspace::create(turns.store(), "w".into(), dir.to_string_lossy().into())
            .expect("workspace")
            .id;
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
                })
            }),
        ));
        // As the daemon has it: the sheet in a session's prompt names these.
        turns.toolbox().register(tools.clone());
        World { turns, tools, workspace, log, made, dir: dir_kept }
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
            Caller::from_session(row)
        }

        fn user(&self) -> Caller {
            Caller::User { workspace_id: Some(self.workspace.clone()) }
        }

        fn call(&self, caller: &Caller, name: &str, args: Value) -> Result<Value, String> {
            match self.tools.run(caller, name, &args)? {
                ToolOutput::Value(value) => Ok(value),
                ToolOutput::Content(_) => Err("content".into()),
            }
        }

        fn start(&self, caller: &Caller, prompt: &str) -> String {
            let out = self
                .call(caller, "start_session", json!({ "provider": "opencode", "prompt": prompt }))
                .expect("start");
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
        let first: Vec<String> = serde_json::from_value(launches[0]["args"].clone()).unwrap();
        let second: Vec<String> = serde_json::from_value(launches[1]["args"].clone()).unwrap();
        assert!(!first.contains(&"--session".to_string()), "the first turn resumed something: {first:?}");
        let bound = w.row(&id).provider_session_id.expect("bound");
        let at = second.iter().position(|arg| arg == "--session").expect("the second turn did not resume");
        assert_eq!(second[at + 1], bound);
        // The persona is the system prompt of every turn, through the file
        // opencode's config names; the message is the message alone.
        for launch in &launches {
            let system = launch["system"].as_str().unwrap();
            assert!(system.contains("Your final message of each turn is your report"), "{system}");
            assert!(system.contains("`crew_send_message`") && !system.contains("`crew_start_session`"), "{system}");
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
        let id = w.start(&parent, "SLEEP 3");
        let out = w.tools.wait(&parent, &json!({ "sessions": [id], "timeout_s": 1 })).expect("wait");
        assert_eq!(out["result"], "timed-out", "{out}");
        let cursors = out["cursors"].clone();
        let done = w.wait(&parent, &id, json!({ "cursors": cursors }));
        assert_eq!(done["result"], "event", "{done}");
        assert_eq!(done["sessions"][0]["report"], "report: SLEEP 3");
    }

    #[test]
    fn the_first_of_several_to_finish_answers_the_wait() {
        let w = world();
        let parent = w.session("terminal", "shell", "full");
        let slow = w.start(&parent, "SLEEP 4");
        let quick = w.start(&parent, "quick");
        let out = w.tools.wait(&parent, &json!({ "sessions": [slow, quick], "timeout_s": 20 })).expect("wait");
        let ended: Vec<&str> = out["sessions"].as_array().unwrap().iter().map(|s| s["id"].as_str().unwrap()).collect();
        assert_eq!(ended, vec![quick.as_str()], "{out}");
        let next = w.tools.wait(&parent, &json!({ "sessions": [slow, quick], "timeout_s": 20, "cursors": out["cursors"] })).expect("wait");
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
        let started = w.call(&parent, "start_session", json!({ "provider": "claude", "prompt": "SLEEP 2" })).expect("start");
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
        /// A Codex child on the fake app server, and the log of what it was sent.
        fn codex(&self, parent: &Caller, prompt: &str, autonomy: Option<&str>) -> (String, PathBuf) {
            let (fake, log) = crate::turns::fake_codex(&self.dir);
            self.turns.override_binary("codex", fake);
            let mut args = json!({ "provider": "codex", "model": "gpt-5.6-luna", "prompt": prompt });
            if let Some(autonomy) = autonomy {
                args["autonomy"] = json!(autonomy);
            }
            let started = self.call(parent, "start_session", args).expect("start");
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

    /// One app server per turn: the first opens a thread with Crew's server on
    /// it and the persona as context, the next resumes that thread with the
    /// model named again.
    #[test]
    fn a_codex_session_opens_a_thread_and_the_next_turn_resumes_it() {
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
        assert_eq!((crew["tool_timeout_sec"].clone(), crew["default_tools_approval_mode"].clone()), (json!(3900), json!("approve")));
        assert_eq!(started[0]["model"], "gpt-5.6-luna");
        assert_eq!((started[0]["approvalPolicy"].clone(), started[0]["sandbox"].clone()), (json!("never"), json!("danger-full-access")));
        let turn = &sent(&log, "turn/start")[0];
        let first = turn["input"][0]["text"].as_str().unwrap();
        assert!(first.ends_with("remember 4817") && !first.contains("Your final message"), "the persona is in the message: {turn}");
        let context = turn["additionalContext"]["crew"]["value"].as_str().unwrap_or_default();
        assert!(context.contains("Your final message of each turn is your report"), "{context}");
        assert!(context.contains("`mcp__crew__send_message`") && !context.contains("find_tool"), "{context}");

        let more = w.call(&parent, "send_message", json!({ "to": id, "text": "what number?" })).expect("send");
        assert_eq!(more["delivery"], "started", "{more}");
        assert_eq!(w.wait(&parent, &id, json!({}))["sessions"][0]["report"], "report: what number?");
        let resumed = sent(&log, "thread/resume");
        assert_eq!(resumed.len(), 1, "{resumed:?}");
        assert_eq!(resumed[0]["threadId"], json!(bound));
        assert_eq!(resumed[0]["model"], "gpt-5.6-luna");
        assert!(resumed[0]["config"]["mcp_servers"]["crew"].is_object(), "{}", resumed[0]);
        let second = &sent(&log, "turn/start")[1];
        assert!(second["input"][0]["text"].as_str().unwrap().starts_with("## Message\nFrom: shell (terminal"), "{second}");
        assert!(second["additionalContext"]["crew"]["value"].as_str().unwrap().contains("Your final message"), "{second}");
        // Each turn had its own process, and it is gone.
        let launches = std::fs::read_to_string(&log).unwrap().lines().filter(|line| line.contains("\"argv\"")).count();
        assert_eq!(launches, 2);
        assert!(w.turns.test_agents().running().is_empty());
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
        assert_eq!((started["approvalPolicy"].clone(), started["sandbox"].clone()), (json!("on-request"), json!("workspace-write")));
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
        assert!(at.elapsed() < Duration::from_secs(2), "the interrupt was not taken: {:?}", at.elapsed());
        assert_eq!(sent(&log, "turn/interrupt").len(), 1);

        let (stubborn, _) = w.codex(&parent, "STUBBORN SLEEP 30", None);
        until_tool(&w, &parent, &stubborn);
        let at = Instant::now();
        let stopped = w.call(&parent, "stop_session", json!({ "session": stubborn })).expect("stop");
        assert_eq!(stopped["status"], "exited", "{stopped}");
        let took = at.elapsed();
        assert!(took >= Duration::from_secs(2) && took < Duration::from_secs(5), "{took:?}");
        std::thread::sleep(Duration::from_millis(300));
        assert!(w.turns.test_agents().running().is_empty(), "the hung app server was left running");
    }

    #[test]
    fn a_failed_codex_turn_reports_why() {
        let w = world();
        let parent = w.session("terminal", "shell", "full");
        let (id, _) = w.codex(&parent, "FAIL", None);
        let out = w.wait(&parent, &id, json!({}));
        assert_eq!((out["sessions"][0]["event"].clone(), out["sessions"][0]["outcome"].clone()), (json!("error"), json!("boom")), "{out}");
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
            let started = self.call(parent, "start_session", args).expect("start");
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

    /// One `cursor-agent acp` per turn: the first opens a session with Crew's
    /// server on it and the persona in the message, the next loads that
    /// session. The history the load replays is not shown twice.
    #[test]
    fn a_cursor_session_opens_a_session_and_the_next_turn_loads_it() {
        let w = world();
        let parent = w.session("terminal", "shell", "full");
        let (id, log) = w.cursor(&parent, "remember 4817", None);
        let out = w.wait(&parent, &id, json!({}));
        assert_eq!(out["sessions"][0]["report"], "report: remember 4817", "{out}");
        w.settle(&id);
        let bound = w.row(&id).provider_session_id.expect("bound");

        assert_eq!(launches_of(&log)[0], json!(["--model", "composer-2.5", "--force", "acp"]));
        assert_eq!(sent(&log, "initialize")[0]["protocolVersion"], 1);
        assert_eq!(sent(&log, "authenticate")[0]["methodId"], "cursor_login");
        let opened = sent(&log, "session/new");
        assert_eq!(opened.len(), 1, "{opened:?}");
        let crew = &opened[0]["mcpServers"][0];
        assert_eq!((crew["name"].clone(), crew["args"].clone()), (json!("crew"), json!(["--mcp"])), "{crew}");
        let token = crew["env"].as_array().unwrap().iter().find(|pair| pair["name"] == "CREW_TOKEN").expect("token");
        assert!(token["value"].as_str().is_some_and(|t| !t.is_empty()), "{crew}");
        let first = sent(&log, "session/prompt")[0]["prompt"][0]["text"].as_str().unwrap().to_string();
        assert!(first.contains("Your final message of each turn is your report"), "the persona is in the message: {first}");
        assert!(first.contains("on the MCP server `crew`") && first.contains("`send_message`"), "the MCP tools, not the crew CLI: {first}");
        assert!(!first.contains("find_tool") && !first.contains("start_session"), "{first}");
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
        assert!(w.turns.test_agents().running().is_empty());
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
        assert_eq!(launches_of(&log).len(), 2, "each prompt had its own process");
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
        assert_eq!((request["kind"].clone(), request["tool"].clone(), request["title"].clone()), (json!("approval"), json!("bash"), json!("touch asked.txt")), "{request}");
        assert_eq!(request["input"]["reason"], "Shell allowlist is empty", "{request}");
        assert_eq!(w.row(&id).status, "needs-input");
        w.turns.respond(&id, request["request_id"].as_u64().unwrap(), ApprovalDecision::Always).expect("respond");
        let done = w.wait(&parent, &id, json!({}));
        assert_eq!(done["sessions"][0]["report"], "report: ASK + decision: allow-once", "{done}");
        assert_eq!(launches_of(&log)[0], json!(["--model", "composer-2.5", "acp"]), "ask runs without --force");
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
        assert!(at.elapsed() < Duration::from_secs(2), "the cancel was not taken: {:?}", at.elapsed());
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
        assert!(took >= Duration::from_secs(2) && took < Duration::from_secs(6), "{took:?}");
        std::thread::sleep(Duration::from_millis(300));
        assert!(w.turns.test_agents().running().is_empty(), "the hung cursor-agent was left running");
    }

    #[test]
    fn a_failed_cursor_turn_reports_why() {
        let w = world();
        let parent = w.session("terminal", "shell", "full");
        let (id, _) = w.cursor(&parent, "FAIL", None);
        let out = w.wait(&parent, &id, json!({}));
        assert_eq!((out["sessions"][0]["event"].clone(), out["sessions"][0]["outcome"].clone()), (json!("error"), json!("boom")), "{out}");
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
        assert!(second.contains("Your final message of each turn is your report"), "a new conversation gets the persona: {second}");
        let notes = |w: &World| {
            let (blocks, _) = w.turns.transcripts().since(&id, 0);
            blocks.iter().filter(|block| block.text == crate::turns::CURSOR_ACP_NOTE).count()
        };
        assert_eq!(notes(&w), 1);

        // Later turns load the new conversation, and say nothing more.
        w.settle(&id);
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
        let started = w.call(&parent, "start_session", json!({ "provider": "claude", "prompt": "BACKGROUND 1.5" })).expect("start");
        let id = started["id"].as_str().unwrap().to_string();
        let out = w.wait(&parent, &id, json!({}));
        assert_eq!(out["sessions"][0]["report"], "report: BACKGROUND 1.5 + the background command finished", "{out}");
        let read = w.call(&parent, "read_session", json!({ "session": id })).expect("read");
        assert_eq!(read["text"].as_str().unwrap().matches("Turn ended").count(), 1, "{read}");
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

    #[test]
    fn only_whoever_started_a_session_drives_it() {
        let w = world();
        let parent = w.session("terminal", "mine", "full");
        let stranger = w.session("terminal", "other", "full");
        let bot = w.session("bot", "Planner", "full");
        let id = w.start(&parent, "SLEEP 1");
        for (tool, args) in [
            ("read_session", json!({ "session": id })),
            ("send_message", json!({ "to": id, "text": "hi" })),
            ("stop_session", json!({ "session": id })),
        ] {
            let out = w.call(&stranger, tool, args.clone());
            assert!(out.as_ref().is_err_and(|e| e.contains("not by you")), "{tool}: {out:?}");
            let out = w.call(&bot, tool, args);
            assert!(out.is_err_and(|e| e.contains("not by you")), "{tool}");
        }
        // The user may, from the command line, as in the window.
        assert!(w.call(&w.user(), "read_session", json!({ "session": id })).is_ok());
        // A bot's session is reached as the bot; a terminal is the user's CLI.
        let theirs = w.call(&parent, "read_session", json!({ "session": bot.session_id().unwrap() }));
        assert!(theirs.is_err_and(|e| e.contains("send_message")));
        let shell = w.call(&parent, "read_session", json!({ "session": stranger.session_id().unwrap() }));
        assert!(shell.is_err_and(|e| e.contains("terminal session")));
        // Listing is not driving: someone else's session is not among the
        // stranger's peers; the parent's is, writable.
        let listed = w.call(&stranger, "list_peers", json!({})).expect("list");
        assert!(!listed.as_array().unwrap().iter().any(|row| row["id"] == id), "{listed}");
        let mine = w.call(&parent, "list_peers", json!({})).expect("list");
        let row = mine.as_array().unwrap().iter().find(|row| row["id"] == id).expect("its child");
        assert_eq!((row["kind"].clone(), row["parent"].clone(), row["write"].clone()), (json!("session"), json!("you"), json!(true)), "{row}");
        w.settle(&id);
    }

    #[test]
    fn a_child_sees_no_session_tools() {
        let w = world();
        let parent = w.session("terminal", "shell", "full");
        let id = w.start(&parent, "x");
        let child = Caller::from_session(w.row(&id));
        assert_eq!(child.kind(), CallerKind::Child);
        let toolbox = crate::tools::Toolbox::default();
        toolbox.register(Arc::new(catalog_only()));
        let listed = toolbox.visible_names(CallerKind::Child);
        for name in ["start_session", "read_session", "stop_session", "create_bot"].iter().chain(crate::tools::REMOVED_TOOLS) {
            assert!(!listed.contains(name), "a child is listed {name}");
        }
        assert!(listed.contains(&"send_message") && listed.contains(&"list_peers"));
        for parent in [CallerKind::Bot, CallerKind::Terminal, CallerKind::User] {
            assert!(toolbox.visible_names(parent).contains(&"start_session"), "{parent:?}");
        }
        w.settle(&id);
    }

    /// Models have confused the two words before, so each place a model reads
    /// about sessions says what one is, and what a bot is.
    #[test]
    fn the_words_are_said_wherever_a_model_reads_them() {
        let w = world();
        let toolbox = crate::tools::Toolbox::default();
        toolbox.register(Arc::new(catalog_only()));
        let shell = w.session("terminal", "shell", "full");
        let told = crate::tools::instructions(&toolbox, &shell);
        assert!(told.contains("A bot outlives its sessions; a session is one provider CLI process and can be thrown away."), "{told}");
        let start = catalog().into_iter().find(|tool| tool.name == "start_session").unwrap();
        assert!(start.description.contains("A bot outlives its sessions"), "{}", start.description);
        assert!(w.tools.instructions(&shell).unwrap().contains("A bot outlives its sessions"));
        let id = w.start(&shell, "x");
        assert!(w.tools.instructions(&shell).unwrap().contains(&id), "the parent is not reminded of its sessions");
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
        let fifth = w.call(&parent, "start_session", json!({ "provider": "opencode", "prompt": "one more" }));
        assert!(fifth.is_err_and(|e| e.contains("already have 4 live sessions")), "the cap let a fifth through");
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
        let full = w.call(&careful, "start_session", json!({ "provider": "opencode", "prompt": "x", "autonomy": "full" }));
        assert!(full.is_err_and(|e| e.contains("cannot have full")));
        let id = w.start(&careful, "x");
        assert_eq!(w.row(&id).autonomy, "ask");
        let trusted = w.session("terminal", "trusted", "full");
        let inherits = w.start(&trusted, "y");
        assert_eq!(w.row(&inherits).autonomy, "full");
        let lowered = w.call(&trusted, "start_session", json!({ "provider": "opencode", "prompt": "z", "autonomy": "ask" })).expect("start");
        assert_eq!(lowered["autonomy"], "ask");
        for id in [id, inherits, lowered["id"].as_str().unwrap().to_string()] {
            w.settle(&id);
        }
    }

    #[test]
    fn a_new_worktree_is_a_branch_of_its_own() {
        let w = world();
        let parent = w.session("terminal", "shell", "full");
        let out = w.call(&parent, "start_session", json!({ "provider": "opencode", "prompt": "x", "worktree": "new", "name": "Fix login" })).expect("start");
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
                    w.turns.store(), w.workspace.clone(), format!("kid {n}"), "opencode".into(), "m".into(), "full".into(),
                    None, Some(me.clone()),
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
            })
            .expect("busy");
        for (n, kid) in kids.iter().enumerate() {
            let from = crate::caller::Caller::from_session(kid.clone()).sender();
            let cursor = n as i64 + 2;
            let letter = crate::mailbox::Letter::new(&me, &from, &format!("kid {n} is done"), crate::mailbox::REPORT, Some(cursor));
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
        let letters: Vec<Block> = w
            .turns
            .transcripts()
            .since(&me, 0)
            .0
            .into_iter()
            .filter(|b| b.from_bot.is_some())
            .collect();
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
        let args: Vec<String> = serde_json::from_value(launches.last().unwrap()["args"].clone()).unwrap();
        assert!(args.contains(&"--session".to_string()), "the turn started over instead of carrying on: {args:?}");
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
                })
                .expect("busy");
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
        assert!(sent["note"].as_str().unwrap().contains("cannot write back to you"), "{sent}");
        w.heard(&to, shell.session_id().unwrap());
        w.settle(&to);
        let prompt = prompts(&w).into_iter().find(|p| p.contains("the branch is green")).expect("the bot never read it");
        assert!(prompt.contains("## Message\nFrom: shell (terminal "), "{prompt}");

        w.busy(&bot, 1.5);
        let queued = w.call(&shell, "send_message", json!({ "to": to, "text": "when you get a minute" })).expect("send");
        assert_eq!((queued["delivery"].clone(), queued["waiting"].clone()), (json!("queued"), json!(1)), "{queued}");
        // opencode takes nothing mid-turn: a steer is queued, and says why.
        let steer = w.call(&shell, "send_message", json!({ "to": to, "text": "and this", "steer": true })).expect("send");
        assert_eq!(steer["delivery"], "queued", "{steer}");
        assert!(steer["note"].as_str().unwrap().contains("opencode cannot take a message"), "{steer}");
        for _ in 0..200 {
            if prompts(&w).iter().any(|p| p.contains("when you get a minute") && p.contains("and this")) {
                break;
            }
            std::thread::sleep(Duration::from_millis(25));
        }
        assert!(prompts(&w).iter().any(|p| p.contains("when you get a minute") && p.contains("and this")), "the two were not handed over together");
        w.settle(&to);
    }

    /// Who may write to whom (plan §4.2, P1): anyone to a bot and to a
    /// top-level session; a session's own parent and the user to a child;
    /// nobody to itself, to a terminal or to someone else's child.
    #[test]
    fn who_may_write_to_whom() {
        let w = world();
        let shell = w.session("terminal", "shell", "full");
        let other = w.session("terminal", "other", "full");
        let bot = w.session("bot", "Planner", "full");
        let child = w.start(&shell, "x");
        let top = w.start(&w.user(), "y");
        w.settle(&child);
        w.settle(&top);
        let refused = |caller: &Caller, to: &str, why: &str| {
            let out = w.call(caller, "send_message", json!({ "to": to, "text": "hi" }));
            assert!(out.as_ref().is_err_and(|e| e.contains(why)), "{to}: {out:?}");
        };
        refused(&bot, bot.session_id().unwrap(), "That is you");
        refused(&bot, shell.session_id().unwrap(), "terminal session");
        refused(&other, &child, "not by you");
        refused(&bot, &child, "not by you");
        refused(&bot, "Planner", "addressed by id");
        refused(&bot, "Nobody", "list_peers has the ids");
        let missing = w.call(&shell, "send_message", json!({ "to": child }));
        assert!(missing.is_err_and(|e| e.contains("text is required")));
        // Its own parent, the user, and anyone to a top-level session.
        assert_eq!(w.call(&shell, "send_message", json!({ "to": child, "text": "more" })).expect("parent")["delivery"], "started");
        w.settle(&child);
        assert_eq!(w.call(&w.user(), "send_message", json!({ "to": child, "text": "more" })).expect("user")["delivery"], "started");
        w.settle(&child);
        assert_eq!(w.call(&other, "send_message", json!({ "to": top, "text": "hello" })).expect("top")["delivery"], "started");
        w.settle(&top);
        // A child writes to its parent's peers: a bot.
        let kid = Caller::from_session(w.row(&child));
        assert_eq!(w.call(&kid, "send_message", json!({ "to": bot.session_id().unwrap(), "text": "a question" })).expect("kid")["delivery"], "started");
        w.settle(bot.session_id().unwrap());
        // It asked, so the bot may answer it, though it did not start it; a
        // bot it never wrote to may not.
        let other_bot = w.session("bot", "Other", "full");
        refused(&other_bot, &child, "not by you");
        assert_eq!(w.call(&bot, "send_message", json!({ "to": child, "text": "an answer" })).expect("reply")["delivery"], "started");
        w.settle(&child);
        // The listing says the same.
        assert_eq!(w.peer(&shell, &child)["write"], json!(true));
        assert_eq!(w.peer(&other, &top)["write"], json!(true));
        assert_eq!(w.peer(&bot, shell.session_id().unwrap())["write"], json!(false));
        assert_eq!(w.peer(&bot, shell.session_id().unwrap())["kind"], "terminal");
        assert!(w.peer(&bot, bot.session_id().unwrap()).is_null(), "a caller is not its own peer");
        // Someone else's child is not listed; a top-level one is.
        assert!(w.peer(&other, &child).is_null() && w.peer(&bot, &child).is_null());
        // An exited session takes nothing.
        w.call(&shell, "stop_session", json!({ "session": child })).expect("stop");
        refused(&shell, &child, "has exited");
    }

    /// A bot that waits gets the report back from the call, and only there:
    /// the same report does not also wake it.
    #[test]
    fn a_bot_that_waits_is_handed_the_report_and_not_woken_by_it() {
        let w = world();
        let bot = w.session("bot", "Planner", "full");
        let me = bot.session_id().unwrap().to_string();
        w.busy(&bot, 2.0);
        let out = w.call(&bot, "start_session", json!({ "provider": "opencode", "prompt": "find it", "wait": true, "timeout_s": 20 })).expect("start");
        assert_eq!((out["status"].clone(), out["report"].clone()), (json!("reported"), json!("report: find it")), "{out}");
        let id = out["id"].as_str().unwrap().to_string();
        w.settle(&me);
        std::thread::sleep(Duration::from_millis(300));
        w.settle(&me);
        assert!(!prompts(&w).iter().any(|p| p.contains("## Report from session")), "the report woke the bot as well: {:?}", prompts(&w));
        let reports: i64 = w
            .turns
            .store()
            .with(|conn| conn.query_row("SELECT COUNT(*) FROM mailbox WHERE kind = 'report' AND disposed_at IS NULL", [], |row| row.get(0)))
            .unwrap();
        assert_eq!(reports, 0, "a report is still on its way");
        assert_eq!(session_events::seen(w.turns.store(), &id).unwrap(), w.row(&id).cursor);
    }

    /// A wait that runs out leaves the child working; its report wakes the
    /// bot when it comes. A terminal is told to read it instead.
    #[test]
    fn a_wait_that_runs_out_leaves_the_child_running_and_the_report_wakes_the_bot() {
        let w = world();
        let bot = w.session("bot", "Planner", "full");
        let me = bot.session_id().unwrap().to_string();
        w.busy(&bot, 0.5);
        let out = w.call(&bot, "start_session", json!({ "provider": "opencode", "prompt": "SLEEP 2", "wait": true, "timeout_s": 1 })).expect("start");
        assert_eq!(out["status"], "running", "{out}");
        assert!(out["note"].as_str().unwrap().contains("Its report will wake you"), "{out}");
        let id = out["id"].as_str().unwrap().to_string();
        w.heard(&me, &id);
        w.settle(&me);
        let woke = prompts(&w).into_iter().find(|p| p.contains("## Report from session")).expect("never woken");
        assert!(woke.contains("report: SLEEP 2"), "{woke}");

        let shell = w.session("terminal", "shell", "full");
        let out = w.call(&shell, "start_session", json!({ "provider": "opencode", "prompt": "SLEEP 2", "wait": true, "timeout_s": 1 })).expect("start");
        assert_eq!(out["status"], "running", "{out}");
        assert!(out["note"].as_str().unwrap().contains("read_session"), "{out}");
        w.settle(out["id"].as_str().unwrap());
        let refused = w.call(&shell, "start_session", json!({ "provider": "opencode", "prompt": "x", "wait": true, "owner": "user" }));
        assert!(refused.is_err_and(|e| e.contains("nothing to wait for")));
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
            .call(&shell, "start_session", json!({ "provider": "codex", "model": "gpt-5.6-luna", "prompt": "QUESTION", "wait": true, "timeout_s": 20 }))
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
        let late = w.turns.answer(&id, request["request_id"].as_u64().unwrap(), Some(HashMap::from([("Which color?".into(), "Red".into())])));
        assert!(late.is_err_and(|e| e.contains("already answered")));
        let done = w.wait(&shell, &id, json!({}));
        assert_eq!(done["sessions"][0]["report"], r#"report: QUESTION + answers: {"color": {"answers": ["Blue"]}}"#, "{done}");
    }

    /// A child's question wakes its bot parent, with the question and its
    /// options; an approval is the user's alone and wakes nobody.
    #[test]
    fn a_question_wakes_the_bot_parent_and_an_approval_does_not() {
        let w = world();
        let (fake, _) = crate::turns::fake_codex(&w.dir);
        w.turns.override_binary("codex", fake);
        let bot = w.session("bot", "Planner", "full");
        let me = bot.session_id().unwrap().to_string();
        let asks = w.call(&bot, "start_session", json!({ "provider": "codex", "model": "gpt-5.6-luna", "prompt": "QUESTION" })).expect("start");
        let id = asks["id"].as_str().unwrap().to_string();
        w.heard(&me, &id);
        w.settle(&me);
        let woke = prompts(&w).into_iter().find(|p| p.contains("## Question from session")).expect("the bot was never asked");
        assert!(woke.contains(&format!("## Question from session {} ({id})\n\n1. Which color?\n   Options: Red (Choose red.); Blue (Choose blue.)", w.row(&id).name)), "{woke}");
        assert!(woke.contains(&format!("send_message to {id}")), "{woke}");
        assert!(!woke.contains("respond_to_session"), "{woke}");
        assert_eq!(w.call(&bot, "send_message", json!({ "to": id, "text": "Blue" })).expect("answer")["delivery"], "answered");
        w.settle(&id);
        w.heard(&me, &id);
        w.settle(&me);

        let (approval, _) = w.codex(&bot, "ASK", Some("ask"));
        for _ in 0..400 {
            if w.row(&approval).status == "needs-input" {
                break;
            }
            std::thread::sleep(Duration::from_millis(25));
        }
        std::thread::sleep(Duration::from_millis(300));
        assert_eq!(w.peer(&bot, &approval)["status"], "waiting_for_user");
        assert_eq!(w.call(&bot, "read_session", json!({ "session": approval })).expect("read")["status"], "waiting_for_user");
        let letters: i64 = w
            .turns
            .store()
            .with(|conn| conn.query_row("SELECT COUNT(*) FROM mailbox WHERE from_session = ?1", [&approval], |row| row.get(0)))
            .unwrap();
        assert_eq!(letters, 0, "an approval wrote to the parent");
        // A message to it waits for its turn; it is not taken for an answer.
        let sent = w.call(&bot, "send_message", json!({ "to": approval, "text": "later" })).expect("send");
        assert_eq!(sent["delivery"], "queued", "{sent}");
        let request = session_events::latest(w.turns.store(), &approval).unwrap().unwrap().request.unwrap();
        w.turns.respond(&approval, request["request_id"].as_u64().unwrap(), ApprovalDecision::Deny).expect("deny");
        w.settle(&approval);
        w.settle(&me);
    }

    /// owner user: a terminal session of the user's, in its worktree, with
    /// the prompt waiting for its CLI; nobody's child, handed off by the
    /// caller, and no turn started.
    #[test]
    fn a_handoff_is_the_users_session_with_the_prompt_waiting_for_its_cli() {
        let w = world();
        let bot = w.session("bot", "Lead", "full");
        let out = w
            .call(&bot, "start_session", json!({ "prompt": "Carry on with the plan: step 2.", "owner": "user", "worktree": "new", "name": "Auth refactor" }))
            .expect("hand off");
        assert_eq!((out["owner"].clone(), out["status"].clone()), (json!("user"), json!("handed off")), "{out}");
        let id = out["id"].as_str().unwrap().to_string();
        let row = w.row(&id);
        assert_eq!((row.kind.as_str(), row.parent_id.as_deref(), row.handed_off_by.as_deref()), ("terminal", None, bot.session_id()));
        assert!(row.worktree.as_deref().is_some_and(|tree| tree.contains("crew-auth-refactor-")), "{row:?}");
        assert_eq!(out["worktree"], json!(row.worktree));
        assert_eq!(row.provider, "opencode", "the caller's provider");
        assert!(w.made.lock().unwrap().contains(&id), "the window was not told");
        let waiting = mailbox::waiting(w.turns.store(), &id).unwrap();
        assert_eq!(waiting.iter().map(|l| l.text.as_str()).collect::<Vec<_>>(), ["Carry on with the plan: step 2."]);
        assert!(w.launches().is_empty(), "a turn was started for it");
        let peer = w.peer(&bot, &id);
        assert_eq!((peer["kind"].clone(), peer["handed_off_by"].clone(), peer["write"].clone()), (json!("terminal"), json!("you"), json!(false)), "{peer}");
        let blocks = w.turns.transcripts().since(bot.session_id().unwrap(), 0).0;
        assert!(blocks.iter().any(|b| b.text.contains(&format!("Handed Auth refactor ({id}) to the user"))), "{blocks:?}");
        let bad = w.call(&bot, "start_session", json!({ "prompt": "x", "owner": "them" }));
        assert!(bad.is_err_and(|e| e.contains("owner is me or user")));
    }

    #[test]
    fn autonomy_is_never_above_the_callers() {
        let w = world();
        let edits = w.session("terminal", "edits", "edits");
        let auto = w.call(&edits, "start_session", json!({ "provider": "opencode", "prompt": "x", "autonomy": "auto" }));
        assert!(auto.is_err_and(|e| e.contains("Your autonomy is edits, so a session you start cannot have auto")));
        let odd = w.call(&edits, "start_session", json!({ "provider": "opencode", "prompt": "x", "autonomy": "yolo" }));
        assert!(odd.is_err_and(|e| e.contains("ask, edits, auto or full")));
        for wanted in ["ask", "edits"] {
            let out = w.call(&edits, "start_session", json!({ "provider": "opencode", "prompt": "x", "autonomy": wanted })).expect("start");
            assert_eq!(out["autonomy"], wanted);
            w.settle(out["id"].as_str().unwrap());
        }
        let inherits = w.start(&edits, "y");
        assert_eq!(w.row(&inherits).autonomy, "edits");
        w.settle(&inherits);
    }

    /// The tool a terminal reads does not promise it a reply, and nothing a
    /// model reads names a tool that is gone.
    #[test]
    fn what_a_model_reads_names_only_the_tools_there_are() {
        let w = world();
        let toolbox = crate::tools::Toolbox::default();
        toolbox.register(w.tools.clone());
        let shell = w.session("terminal", "shell", "full");
        let bot = w.session("bot", "Planner", "full");
        let host = crate::tools::Host { store: w.turns.store(), transcripts: w.turns.transcripts(), on_created: &|_| {}, on_routines: &|| {}, toolbox: &toolbox };
        let listed = crate::tools::handle(&host, &shell, "tools/list", json!({})).expect("list");
        let send = listed["tools"].as_array().unwrap().iter().find(|t| t["name"] == "send_message").expect("send_message");
        assert!(send["description"].as_str().unwrap().contains("You cannot receive a reply"), "{send}");
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
}
