//! Sessions as MCP tools: start a provider CLI on a job, wait for it, read what
//! it did, give it more, answer it, stop it.
//!
//! The words, as every model that reads these tools is told: a bot is a
//! persistent identity Crew keeps; a session is one provider CLI and can be
//! thrown away. These tools are about sessions a caller starts for itself
//! (children). A bot's own session is reached through `message_agent`, and
//! a terminal is the user's CLI.
//!
//! They are modelled on the process tools on purpose — `start_process`,
//! `wait_for_log`, `read_logs` — so a model that has driven a dev server knows
//! the moves. The child's reply is the end of its turn: it needs no tool to
//! answer, which is what lets a terminal (that cannot be written back to) be a
//! parent.

use std::collections::BTreeMap;
use std::sync::Arc;
use std::time::{Duration, Instant};

use crew_protocol::{ApprovalDecision, Block, BlockRole, ToolStatus, TurnStart};
use serde_json::{json, Value};

use crate::caller::Caller;
use crate::mailbox;
use crate::session::{self, Session};
use crate::session_events::{self, Event, Signal};
use crate::store::{now_millis, Store};
use crate::tools::{provider_models, provider_names, text, unknown_model, Audience, Tool, ToolFamily, ToolOutput, GLOSSARY};
use crate::turns::TurnHost;
use crate::worktree::Worktree;

/// Live sessions one parent may have: anything not exited counts.
pub const LIVE_CAP: usize = 4;
/// The longest a wait blocks, the same minute `wait_for_log` has: the MCP shim
/// gives a call that carries `timeout_s` that long and ten seconds more.
pub const WAIT_MAX_S: u64 = 60;
/// What `read_session` hands back without `max_bytes`, and at most.
/// The CLIs that take a message into a turn that is running.
const STEERABLE: [&str; 2] = ["claude", "codex"];
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
    /// Tells the window a session was made, so it lists it at once.
    on_created: Made,
    /// `worktree::add`, as an argument so a test puts worktrees elsewhere.
    make_worktree: MakeWorktree,
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
    /// at all for the user. A bot's session and a terminal are refused with
    /// what reaches them instead.
    fn owned(&self, caller: &Caller, id: &str) -> Result<Session, String> {
        let workspace = caller.workspace_id()?;
        let found = session::get(&self.store, id.trim().to_string())?
            .filter(|row| row.workspace_id == workspace)
            .ok_or_else(|| format!("No session {id} in this workspace. list_sessions has the ones you started."))?;
        match found.kind.as_str() {
            "bot" => {
                return Err(format!(
                    "{id} is the session that runs the bot {}'s turns. A bot is reached with message_agent, \
                     by its id {}, not driven as a session.",
                    found.name,
                    found.bot_id.as_deref().unwrap_or(&found.id)
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
    /// there, and a report of what it has now seen, still waiting in a bot
    /// parent's box, is set aside. A message the session wrote is not.
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

    fn row(&self, caller: &Caller, row: &Session) -> Value {
        let mut out = json!({
            "id": row.id,
            "name": row.name,
            "kind": row.kind,
            "provider": row.provider,
            "model": row.model,
            "status": row.status,
            "autonomy": row.autonomy,
            "worktree": row.worktree.as_deref().unwrap_or("main checkout"),
            "cursor": row.cursor,
        });
        match row.kind.as_str() {
            "child" => {
                out["parent"] = json!(self.who(row.parent_id.as_deref()));
                if let Ok(seen) = session_events::seen(&self.store, &row.id) {
                    if row.cursor > seen {
                        out["unread"] = json!(true);
                    }
                }
            }
            "bot" => {
                out["bot"] = json!(row.name);
                out["note"] = json!("Runs a bot's turns: reach it with message_agent.");
            }
            _ => {}
        }
        if caller.session_id() == Some(row.id.as_str()) {
            out["self"] = json!(true);
        }
        out
    }

    fn start(&self, caller: &Caller, args: &Value) -> Result<Value, String> {
        let workspace = caller.workspace_id()?.to_string();
        let prompt = text(args.get("prompt"))
            .ok_or_else(|| "prompt is required: the session starts with nothing but it".to_string())?;
        let provider = text(args.get("provider")).ok_or_else(|| {
            format!("provider is required: one of {}", provider_names().join(", "))
        })?;
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
        let autonomy = match text(args.get("autonomy")).as_deref() {
            None => caller.autonomy().to_string(),
            Some("ask") => "ask".to_string(),
            Some("full") if caller.full_autonomy() => "full".to_string(),
            Some("full") => {
                return Err(
                    "Your autonomy is ask, so a session you start cannot have full: it asks too. Leave autonomy out."
                        .to_string(),
                )
            }
            Some(other) => return Err(format!("autonomy is ask or full, not \"{other}\"")),
        };
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
        let name = text(args.get("name")).unwrap_or_else(|| default_name(&provider, &prompt));
        let worktree = self.worktree(caller, &workspace, args.get("worktree"), &name)?;
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
        Ok(json!({
            "id": row.id,
            "name": name,
            "provider": provider,
            "model": model,
            "autonomy": autonomy,
            "worktree": worktree.as_deref().unwrap_or("main checkout"),
            "status": "starting",
            "cursor": 0,
            "note": "It is working on the prompt now. wait_for_session blocks until it ends its turn and answers \
                     with its report (its final message); read_session shows everything it did. You started it, \
                     so only you (and the user) can drive it."
        }))
    }

    /// Where a new session works: `current` (the caller's own folder), `new`
    /// (a branch of its own), or a branch or a worktree path, made if it is
    /// not there yet.
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

    fn list(&self, caller: &Caller, args: &Value) -> Result<Value, String> {
        let workspace = caller.workspace_id()?.to_string();
        let mine = args.get("mine").and_then(Value::as_bool).unwrap_or(true);
        let rows: Vec<Value> = session::list(&self.store, workspace)?
            .into_iter()
            .filter(|row| {
                if !mine {
                    return true;
                }
                row.kind == "child"
                    && match caller {
                        Caller::User { .. } => row.parent_id.is_none(),
                        _ => row.parent_id.as_deref() == caller.session_id(),
                    }
            })
            .map(|row| self.row(caller, &row))
            .collect();
        Ok(Value::Array(rows))
    }

    fn wait(&self, caller: &Caller, args: &Value) -> Result<Value, String> {
        let ids = session_ids(args)?;
        let timeout = wait_seconds(args)?;
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
        let deadline = Instant::now() + Duration::from_secs(timeout);
        loop {
            let mark = self.signal.mark();
            let mut news = Vec::new();
            let mut running = false;
            let mut rows = Vec::new();
            for target in &targets {
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
                return Ok(json!({
                    "result": "event",
                    "sessions": out,
                    "cursors": next,
                    "note": "To wait for what comes next, call wait_for_session again; without cursors it starts \
                             from what you have now seen. read_session with since shows the whole turn."
                }));
            }
            if !running {
                return Ok(json!({
                    "result": "nothing-running",
                    "sessions": rows.iter().map(|row| json!({
                        "id": row.id,
                        "name": row.name,
                        "status": row.status,
                        "cursor": row.cursor,
                        "note": idle_note(&row.status),
                    })).collect::<Vec<_>>(),
                    "cursors": since,
                    "note": "None of them is working, so there is nothing to wait for."
                }));
            }
            if !self.signal.wait(mark, deadline) {
                return Ok(json!({
                    "result": "timed-out",
                    "sessions": rows.iter().map(|row| json!({ "id": row.id, "name": row.name, "status": row.status })).collect::<Vec<_>>(),
                    "cursors": since,
                    "note": format!("Nothing ended in {timeout}s; they are still working. Call wait_for_session again \
                                     (with these cursors, or none) to keep waiting.")
                }));
            }
        }
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
        Ok(json!({
            "session": row.id,
            "status": row.status,
            "text": text.join("\n"),
            "start": start,
            "cursor": end,
            "more": end < total,
            "note": if end < total {
                "There is more after cursor: call again with since = cursor."
            } else {
                "That is everything so far. Pass cursor as since next time to read only what is new."
            }
        }))
    }

    fn send(&self, caller: &Caller, args: &Value) -> Result<Value, String> {
        let id = text(args.get("session")).ok_or("session is required")?;
        let body = text(args.get("text")).ok_or("text is required")?;
        let mode = text(args.get("mode")).unwrap_or_else(|| "auto".into());
        let row = self.owned(caller, &id)?;
        match mode.as_str() {
            "auto" | "queue" | "steer" => {}
            other => return Err(format!("mode is auto, queue or steer, not \"{other}\"")),
        }
        match row.status.as_str() {
            "exited" => {
                return Err(format!(
                    "{} has exited, so nothing can reach it. Its transcript is still there for read_session; start_session starts another.",
                    row.name
                ))
            }
            "needs-input" => {
                return Err(format!(
                    "{} is waiting for an answer to what it asked, not for a message: answer with respond_to_session \
                     (wait_for_session or read_session show the request).",
                    row.name
                ))
            }
            _ => {}
        }
        let cursor = self.turns.transcripts().len(&row.id) as i64;
        // Into the turn that is running, when its CLI can take it there (Claude,
        // Codex); a turn that is not running yet, has just ended, or runs on a
        // CLI that cannot take it, gets it queued instead. Never refused.
        let mut unsteered = None;
        if mode == "steer" {
            let tried = if !STEERABLE.contains(&row.provider.as_str()) {
                Err(format!("{} cannot take a message in the middle of a turn", row.provider))
            } else if !self.turns.is_running(&row.id) {
                Err("no turn was running".to_string())
            } else {
                self.turns.steer(&row.id, &body, caller.sender())
            };
            match tried {
                Ok(()) => {
                    return Ok(json!({
                        "session": row.id,
                        "steered": true,
                        "cursor": cursor,
                        "note": "It reads this at its next step and takes it into the turn it is in, so this turn's report \
                                 answers it. Should the turn end before it gets there, it becomes the next turn."
                    }))
                }
                Err(why) => unsteered = Some(why),
            }
        }
        mailbox::enqueue(&self.store, &row.id, &caller.sender(), &body)?;
        // The same drain a bot's box has: an idle session starts a turn on
        // the oldest message now; a busy one takes it when its turn ends.
        let delivered = self.turns.deliver_to(&row);
        let waiting = mailbox::waiting_count(&self.store, &row.id)?;
        let note = if delivered {
            "It is working on it now, in the same conversation: it remembers its earlier turns. wait_for_session answers with its report."
        } else {
            "It is busy; it reads this the moment its current turn ends. wait_for_session answers with each turn's report."
        };
        let mut out = json!({
            "session": row.id,
            "delivered": delivered,
            "queued": !delivered,
            "waiting": waiting,
            "cursor": cursor,
            "note": note,
        });
        if let Some(why) = unsteered {
            out["steered"] = json!(false);
            out["note"] = json!(format!("Not steered ({why}), so it went in as a message instead. {note}"));
        }
        Ok(out)
    }

    fn respond(&self, caller: &Caller, args: &Value) -> Result<Value, String> {
        let id = text(args.get("session")).ok_or("session is required")?;
        let row = self.owned(caller, &id)?;
        let request = args
            .get("request_id")
            .and_then(Value::as_u64)
            .ok_or("request_id is required: the one wait_for_session or read_session showed")?;
        if row.status != "needs-input" {
            return Err(format!("{} is not waiting for an answer (it is {}).", row.name, row.status));
        }
        if let Some(answers) = args.get("answers").and_then(Value::as_object) {
            let answers = answers
                .iter()
                .map(|(question, answer)| {
                    let answer = match answer {
                        Value::String(text) => text.clone(),
                        other => other.to_string(),
                    };
                    (question.clone(), answer)
                })
                .collect();
            self.turns.answer(&row.id, request, Some(answers))?;
            return Ok(json!({ "session": row.id, "answered": request, "note": "It carries on. wait_for_session answers with its report." }));
        }
        let decision = match text(args.get("decision")).as_deref() {
            Some("allow") => ApprovalDecision::Allow,
            Some("always") => ApprovalDecision::Always,
            Some("deny") => ApprovalDecision::Deny,
            Some(other) => return Err(format!("decision is allow, always or deny, not \"{other}\"")),
            None => return Err("decision is required for an approval (allow, always or deny); a question takes answers".into()),
        };
        // Allowing is running the command: an ask parent may not, any more than
        // it could run it itself. Its card waits for the user in Crew.
        if decision != ApprovalDecision::Deny && !caller.full_autonomy() {
            return Err(format!(
                "Your autonomy is ask, so you cannot allow what {} asked for: the user can, in Crew. You can deny it.",
                row.name
            ));
        }
        self.turns.respond(&row.id, request, decision)?;
        Ok(json!({ "session": row.id, "answered": request, "note": "It carries on. wait_for_session answers with its report." }))
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

/// `sessions` as a list of ids; one id alone is taken too.
fn session_ids(args: &Value) -> Result<Vec<String>, String> {
    let ids: Vec<String> = match args.get("sessions") {
        Some(Value::Array(items)) => items.iter().filter_map(Value::as_str).map(|id| id.trim().to_string()).collect(),
        // The command line hands its words over as one string.
        Some(Value::String(one)) => one.split([',', ' ', '\n']).map(|id| id.trim().to_string()).collect(),
        _ => Vec::new(),
    };
    let ids: Vec<String> = ids.into_iter().filter(|id| !id.is_empty()).collect();
    if ids.is_empty() {
        return Err("sessions is required: the ids to wait on, from start_session or list_sessions".into());
    }
    Ok(ids)
}

fn wait_seconds(args: &Value) -> Result<u64, String> {
    let raw = args.get("timeout_s").ok_or("timeout_s is required: how many seconds to wait, at most 60")?;
    let seconds = raw
        .as_f64()
        .or_else(|| raw.as_str().and_then(|text| text.trim().parse().ok()))
        .ok_or("timeout_s is a number of seconds, at most 60")?;
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
        out["note"] = json!("It is waiting for an answer: respond_to_session with this request_id.");
    }
    if earlier > 0 {
        out["earlier_events"] = json!(format!(
            "{earlier} earlier event(s) happened since your cursor; read_session shows them."
        ));
    }
    out
}

fn idle_note(status: &str) -> &'static str {
    match status {
        "idle" => "Its turn is over. send_to_session gives it more work.",
        "needs-input" => "It is waiting for an answer: respond_to_session.",
        "error" => "Its last turn failed. send_to_session tries again in the same conversation.",
        "exited" => "It has exited. read_session still reads it.",
        _ => "",
    }
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
    json!({ "type": "string", "description": "The session's id, from start_session or list_sessions." })
}

/// The session tools. They need no host to be described, so the CLI builds
/// its commands from the same list the daemon runs.
pub fn catalog() -> Vec<Tool> {
    vec![
        Tool {
            name: "start_session",
            description: concat!(
                "Start a session: one provider CLI (claude, codex, opencode or cursor) working on a prompt, in this workspace. It returns at once, with the session's id; you are its parent. Its reply is the end of each turn: wait_for_session blocks until it ends one and answers with its final message, its report. read_session shows everything it did; send_to_session gives it more in the same conversation; stop_session ends it. ",
                "worktree is where it works: current (yours, the default), new (a fresh branch and worktree of its own, for work that must not touch your checkout), or a branch name or worktree path. It runs with your autonomy, or ask; never more than yours. At most 4 live sessions each. ",
                "A bot outlives its sessions; a session is one provider CLI process and can be thrown away. To hand work to a bot (a persistent identity with a mailbox), use message_agent instead."
            ),
            schema: json!({
                "type": "object",
                "properties": {
                    "provider": { "type": "string", "enum": provider_names(), "description": "Which CLI runs it." },
                    "model": { "type": "string", "description": format!("Defaults to yours when the provider is yours, else the provider's first. What there is:\n{}", crate::tools::model_sheet()) },
                    "prompt": { "type": "string", "description": "The job. It cannot see your conversation: give it everything it needs." },
                    "worktree": { "type": "string", "description": "current (the default), new, or a branch name or worktree path." },
                    "name": { "type": "string", "description": "What it is listed as. Defaults to the provider and the first words of the prompt." },
                    "autonomy": { "type": "string", "enum": ["ask", "full"], "description": "Defaults to yours. full only if yours is full." }
                },
                "required": ["provider", "prompt"]
            }),
            keywords: &["session", "spawn", "delegate", "hand", "run", "codex", "claude", "cursor", "opencode", "cli", "child", "parallel", "worker", "subagent"],
            audience: Audience::PARENTS,
        },
        Tool {
            name: "list_sessions",
            description: "List the sessions you started (the default), or with mine false every session in this workspace: id, provider, model, status (starting, working, idle, needs-input, exited, error), parent, worktree and cursor; self marks your own. A session is one provider CLI process; a bot is the identity some sessions run for (list_agents), reached with message_agent.",
            schema: json!({
                "type": "object",
                "properties": { "mine": { "type": "boolean", "description": "Only the ones you started. Defaults to true." } }
            }),
            keywords: &["sessions", "children", "running", "status", "workers"],
            audience: Audience::PARENTS,
        },
        Tool {
            name: "wait_for_session",
            description: "Block until any of the sessions you name ends a turn, stops to ask for input, fails or exits, or timeout_s passes (at most 60). Answers with whichever did: its event, status, cursor and report (the final message of its turn, cut at 4 KB), or the request it is waiting on. Without since or cursors it starts from what you last saw of each, so a turn that started and ended between two waits is not missed. timed-out answers with the cursors to call again with; nothing-running answers at once when none of them is working.",
            schema: json!({
                "type": "object",
                "properties": {
                    "sessions": { "type": "array", "items": { "type": "string" }, "description": "Session ids, from start_session or list_sessions." },
                    "since": { "type": "integer", "minimum": 0, "description": "A cursor to wait past, for every session named. Omit to start from what you last saw." },
                    "cursors": { "type": "object", "additionalProperties": { "type": "integer" }, "description": "A cursor per session id, as an earlier wait answered with." },
                    "timeout_s": { "type": "integer", "minimum": 1, "maximum": WAIT_MAX_S, "description": "Seconds to wait, at most 60." }
                },
                "required": ["sessions", "timeout_s"]
            }),
            keywords: &["wait", "block", "until", "done", "finish", "report", "result", "poll"],
            audience: Audience::PARENTS,
        },
        Tool {
            name: "read_session",
            description: "Read a session's transcript as numbered lines: what was said to it, what it said, each tool it ran as one line (include_tools adds their output). Without since: the tail, up to max_bytes (16 KB by default, 256 KB at most). With since: what came after that cursor. cursor is where the read stopped: pass it back as since to read only what is new; more says there is more.",
            schema: json!({
                "type": "object",
                "properties": {
                    "session": session_arg(),
                    "since": { "type": "integer", "minimum": 0, "description": "A cursor from start_session, wait_for_session or an earlier read." },
                    "max_bytes": { "type": "integer", "minimum": 1, "maximum": READ_MAX },
                    "include_tools": { "type": "boolean", "description": "Add each tool's output under its line." }
                },
                "required": ["session"]
            }),
            keywords: &["read", "transcript", "output", "log", "what", "did", "history"],
            audience: Audience::PARENTS,
        },
        Tool {
            name: "send_to_session",
            description: "Give a session you started more work, in the same conversation: it remembers its earlier turns. Idle (or after an error), it starts a turn now; busy, the text waits and is read the moment its turn ends (auto and queue). mode steer puts it into the running turn instead, read at the CLI's next step, so that turn's report answers it: Claude and Codex take that; with no turn running, or another CLI, it goes in as a message (steered: false says so). A session waiting for an answer takes respond_to_session, not this; an exited one takes nothing.",
            schema: json!({
                "type": "object",
                "properties": {
                    "session": session_arg(),
                    "text": { "type": "string" },
                    "mode": { "type": "string", "enum": ["auto", "queue", "steer"], "description": "auto (the default) and queue wait for the turn to end; steer goes into the running turn (Claude and Codex; otherwise it is queued)." }
                },
                "required": ["session", "text"]
            }),
            keywords: &["send", "tell", "continue", "more", "follow", "queue", "message"],
            audience: Audience::PARENTS,
        },
        Tool {
            name: "respond_to_session",
            description: "Answer what a session you started is waiting on: an approval (decision allow, always or deny) or a question (answers, by question text). The request_id is in wait_for_session's answer. With autonomy ask you can deny and answer questions, but not allow: that is the user's, in Crew.",
            schema: json!({
                "type": "object",
                "properties": {
                    "session": session_arg(),
                    "request_id": { "type": "integer", "minimum": 0 },
                    "decision": { "type": "string", "enum": ["allow", "always", "deny"] },
                    "answers": { "type": "object", "additionalProperties": { "type": "string" }, "description": "For a question: each question's text and its answer." }
                },
                "required": ["session", "request_id"]
            }),
            keywords: &["approve", "allow", "deny", "answer", "permission", "question", "respond"],
            audience: Audience::PARENTS,
        },
        Tool {
            name: "stop_session",
            description: "End a session you started: its CLI is killed mid-turn if it is working, and it exits for good. Its transcript stays in Crew, and read_session still reads it.",
            schema: json!({ "type": "object", "properties": { "session": session_arg() }, "required": ["session"] }),
            keywords: &["stop", "kill", "end", "cancel", "abort", "exit"],
            audience: Audience::PARENTS,
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
             worktree of its own); wait_for_session waits for its report, read_session reads what it did, \
             send_to_session gives it more."
        );
        if let (Some(me), Ok(workspace)) = (caller.session(), caller.workspace_id()) {
            if let Ok(live) = self.live_children(workspace, &me.id) {
                if !live.is_empty() {
                    note.push_str(&format!(
                        " Sessions you started: {}.",
                        live.iter()
                            .map(|row| format!("{} {} ({}, {}, cursor {})", row.name, row.id, row.provider, row.status, row.cursor))
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
            "start_session" => self.start(caller, args)?,
            "list_sessions" => self.list(caller, args)?,
            "wait_for_session" => self.wait(caller, args)?,
            "read_session" => self.read(caller, args)?,
            "send_to_session" => self.send(caller, args)?,
            "respond_to_session" => self.respond(caller, args)?,
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
        tools: SessionTools,
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
        let tools = SessionTools::with_worktrees(
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
        );
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
            self.call(caller, "wait_for_session", args).expect("wait")
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
        let sent = w.call(&parent, "send_to_session", json!({ "session": id, "text": "what number?" })).expect("send");
        assert_eq!(sent["delivered"], true, "{sent}");
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
            assert!(system.contains("`crew_message_agent`") && !system.contains("`crew_start_session`"), "{system}");
        }
        let prompt = launches[0]["prompt"].as_str().unwrap();
        assert!(prompt.starts_with("## From shell (terminal") && !prompt.contains("Your final message"), "{prompt}");
        let next = launches[1]["prompt"].as_str().unwrap();
        assert!(next.starts_with("## From shell (terminal"), "{next}");
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
        w.call(&parent, "send_to_session", json!({ "session": id, "text": "two" })).expect("send");
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
        let out = w.call(&parent, "wait_for_session", json!({ "sessions": [id], "timeout_s": 1 })).expect("wait");
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
        let out = w.call(&parent, "wait_for_session", json!({ "sessions": [slow, quick], "timeout_s": 20 })).expect("wait");
        let ended: Vec<&str> = out["sessions"].as_array().unwrap().iter().map(|s| s["id"].as_str().unwrap()).collect();
        assert_eq!(ended, vec![quick.as_str()], "{out}");
        let next = w.call(&parent, "wait_for_session", json!({ "sessions": [slow, quick], "timeout_s": 20, "cursors": out["cursors"] })).expect("wait");
        let ended: Vec<&str> = next["sessions"].as_array().unwrap().iter().map(|s| s["id"].as_str().unwrap()).collect();
        assert_eq!(ended, vec![slow.as_str()], "{next}");
    }

    #[test]
    fn a_message_to_a_busy_session_waits_for_its_turn_to_end() {
        let w = world();
        let parent = w.session("terminal", "shell", "full");
        let id = w.start(&parent, "SLEEP 2");
        std::thread::sleep(Duration::from_millis(300));
        let sent = w.call(&parent, "send_to_session", json!({ "session": id, "text": "then this", "mode": "queue" })).expect("send");
        assert_eq!((sent["queued"].clone(), sent["waiting"].clone()), (json!(true), json!(1)), "{sent}");
        let first = w.wait(&parent, &id, json!({}));
        assert_eq!(first["sessions"][0]["report"], "report: SLEEP 2");
        let second = w.wait(&parent, &id, json!({}));
        assert_eq!(second["sessions"][0]["report"], "report: then this", "{second}");
        // opencode cannot take it mid-turn: it goes in as a message, and says so.
        let steer = w.call(&parent, "send_to_session", json!({ "session": id, "text": "x", "mode": "steer" })).expect("send");
        assert_eq!(steer["steered"], false, "{steer}");
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
        let steered = w.call(&parent, "send_to_session", json!({ "session": id, "text": "and this", "mode": "steer" })).expect("steer");
        assert_eq!(steered["steered"], true, "{steered}");
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
        let idle = w.call(&parent, "send_to_session", json!({ "session": id, "text": "next", "mode": "steer" })).expect("send");
        assert_eq!(idle["delivered"], true, "{idle}");
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
        assert!(context.contains("`mcp__crew__message_agent`") && !context.contains("find_tool"), "{context}");

        let more = w.call(&parent, "send_to_session", json!({ "session": id, "text": "what number?" })).expect("send");
        assert_eq!(more["delivered"], true, "{more}");
        assert_eq!(w.wait(&parent, &id, json!({}))["sessions"][0]["report"], "report: what number?");
        let resumed = sent(&log, "thread/resume");
        assert_eq!(resumed.len(), 1, "{resumed:?}");
        assert_eq!(resumed[0]["threadId"], json!(bound));
        assert_eq!(resumed[0]["model"], "gpt-5.6-luna");
        assert!(resumed[0]["config"]["mcp_servers"]["crew"].is_object(), "{}", resumed[0]);
        let second = &sent(&log, "turn/start")[1];
        assert!(second["input"][0]["text"].as_str().unwrap().starts_with("## From shell (terminal"), "{second}");
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
        let steered = w.call(&parent, "send_to_session", json!({ "session": id, "text": "and this", "mode": "steer" })).expect("steer");
        assert_eq!(steered["steered"], true, "{steered}");
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
        let idle = w.call(&parent, "send_to_session", json!({ "session": id, "text": "next", "mode": "steer" })).expect("send");
        assert_eq!((idle["steered"].clone(), idle["delivered"].clone()), (json!(false), json!(true)), "{idle}");
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
        w.call(&parent, "respond_to_session", json!({ "session": id, "request_id": request["request_id"], "decision": "always" }))
            .expect("respond");
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
        w.call(&parent, "respond_to_session", json!({ "session": id, "request_id": request["request_id"], "answers": { "Which color?": "Blue" } }))
            .expect("answer");
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
        assert!(first.contains("on the MCP server `crew`") && first.contains("`message_agent`"), "the MCP tools, not the crew CLI: {first}");
        assert!(!first.contains("find_tool") && !first.contains("start_session"), "{first}");
        assert!(first.trim_end().ends_with("remember 4817"), "{first}");

        let more = w.call(&parent, "send_to_session", json!({ "session": id, "text": "what number?" })).expect("send");
        assert_eq!(more["delivered"], true, "{more}");
        assert_eq!(w.wait(&parent, &id, json!({}))["sessions"][0]["report"], "report: what number?");
        let loaded = sent(&log, "session/load");
        assert_eq!(loaded.len(), 1, "{loaded:?}");
        assert_eq!(loaded[0]["sessionId"], json!(bound));
        assert_eq!(loaded[0]["mcpServers"][0]["name"], "crew", "{}", loaded[0]);
        assert_eq!(sent(&log, "session/new").len(), 1, "a load that worked opened another session");
        let second = sent(&log, "session/prompt")[1]["prompt"][0]["text"].as_str().unwrap().to_string();
        assert!(second.starts_with("## From shell (terminal") && !second.contains("Your final message"), "{second}");
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
        let steer = w.call(&parent, "send_to_session", json!({ "session": id, "text": "and this", "mode": "steer" })).expect("steer");
        assert_eq!((steer["steered"].clone(), steer["queued"].clone()), (json!(false), json!(true)), "{steer}");
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
        w.call(&parent, "respond_to_session", json!({ "session": id, "request_id": request["request_id"], "decision": "always" }))
            .expect("respond");
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
        w.call(&parent, "respond_to_session", json!({ "session": id, "request_id": request["request_id"], "answers": { "Which color?": "Blue" } }))
            .expect("answer");
        let done = w.wait(&parent, &id, json!({}));
        assert_eq!(
            done["sessions"][0]["report"],
            r#"report: MCP QUESTION PLAN + crew: allow-once + answers: {"answers": [{"questionId": "color", "selectedOptionIds": ["b"]}], "outcome": "answered"} + plan: accepted"#,
            "{done}"
        );
        let (blocks, _) = w.turns.transcripts().since(&id, 0);
        assert!(blocks.iter().any(|block| block.text == "Crew list agents"), "{blocks:?}");
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

        w.call(&parent, "send_to_session", json!({ "session": id, "text": "second" })).expect("send");
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
        w.call(&parent, "send_to_session", json!({ "session": id, "text": "third" })).expect("send");
        assert_eq!(w.wait(&parent, &id, json!({}))["sessions"][0]["report"], "report: third");
        assert_eq!(sent(&log, "session/load").len(), 1);
        assert_eq!(notes(&w), 1);

        // A conversation cursor no longer has.
        w.settle(&id);
        crate::session::set_provider_session(w.turns.store(), id.clone(), "gone".into()).unwrap();
        w.call(&parent, "send_to_session", json!({ "session": id, "text": "fourth" })).expect("send");
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
        let sent = w.call(&parent, "send_to_session", json!({ "session": id, "text": "again" })).expect("send");
        assert_eq!(sent["delivered"], true);
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
        let refused = w.call(&parent, "send_to_session", json!({ "session": id, "text": "more" }));
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
        w.call(&parent, "send_to_session", json!({ "session": id, "text": "second job" })).expect("send");
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
            ("send_to_session", json!({ "session": id, "text": "hi" })),
            ("stop_session", json!({ "session": id })),
            ("respond_to_session", json!({ "session": id, "request_id": 1, "decision": "deny" })),
            ("wait_for_session", json!({ "sessions": [id], "timeout_s": 1 })),
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
        assert!(theirs.is_err_and(|e| e.contains("message_agent")));
        let shell = w.call(&parent, "read_session", json!({ "session": stranger.session_id().unwrap() }));
        assert!(shell.is_err_and(|e| e.contains("terminal session")));
        // Listing is not driving: everyone sees what is there, marked.
        let listed = w.call(&stranger, "list_sessions", json!({ "mine": false })).expect("list");
        let me = listed.as_array().unwrap().iter().find(|row| row["self"] == true).expect("self");
        assert_eq!(me["id"], stranger.session_id().unwrap());
        let mine = w.call(&stranger, "list_sessions", json!({})).expect("list");
        assert_eq!(mine, json!([]));
        let theirs = w.call(&parent, "list_sessions", json!({})).expect("list");
        assert_eq!(theirs[0]["id"], id);
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
        for name in ["start_session", "list_sessions", "wait_for_session", "read_session", "send_to_session", "respond_to_session", "stop_session", "create_bot", "create_worktree"] {
            assert!(!listed.contains(&name), "a child is listed {name}");
        }
        assert!(listed.contains(&"message_agent") && listed.contains(&"list_agents"));
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
    fn an_ask_parent_can_deny_but_not_allow() {
        let w = world();
        let careful = w.session("terminal", "careful", "ask");
        let id = w.start(&careful, "x");
        w.settle(&id);
        let idle = w.call(&careful, "respond_to_session", json!({ "session": id, "request_id": 1, "decision": "deny" }));
        assert!(idle.is_err_and(|e| e.contains("not waiting for an answer")));
        // As a Claude child stopped on a tool would be.
        session::set_status(w.turns.store(), id.clone(), "needs-input".into()).unwrap();
        let allow = w.call(&careful, "respond_to_session", json!({ "session": id, "request_id": 1, "decision": "allow" }));
        assert!(allow.is_err_and(|e| e.contains("cannot allow")));
        let send = w.call(&careful, "send_to_session", json!({ "session": id, "text": "hi" }));
        assert!(send.is_err_and(|e| e.contains("respond_to_session")));
        // Denying reaches the turn host, which has nothing waiting here.
        let deny = w.call(&careful, "respond_to_session", json!({ "session": id, "request_id": 1, "decision": "deny" }));
        assert!(deny.is_err_and(|e| e.contains("No approval is waiting")));
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
}
