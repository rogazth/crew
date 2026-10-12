//! Messages between bots.
//!
//! A bot never calls another one. It drops a letter here; the daemon hands
//! it to the target as a user turn with the sender's name on it, and the reply
//! comes back the same way. Nothing blocks: if the target is mid-turn the
//! letter waits, and a turn that ends drains the box.
//!
//! Blocking would deadlock the obvious case — two bots that message each
//! other — so `send_message` answers how it was delivered and never waits for
//! a reply.
//!
//! A child session's report reaches the bot that started it the same way, as
//! a `report` letter, its question as a `question` letter, and an approval it
//! waits on as an `approval` letter: that is what wakes the bot, so it never
//! has to wait.
//!
//! A letter goes pending → claimed → delivered, or is disposed. Claimed means
//! a turn is carrying it; delivered, that the turn ended. A daemon stopped
//! mid-turn leaves it claimed, and the next start puts it back in the box.
//! Nothing is deleted: a letter nobody needs any more is marked disposed.

use crew_protocol::{AttachedFile, BotRef};
use rusqlite::{params, OptionalExtension};
use serde::{Deserialize, Serialize};

use crate::store::{now_millis, stamp, Store};

/// A letter somebody wrote: from a bot, a terminal, the user or a session.
pub const MESSAGE: &str = "message";
/// A child's turn ended (or failed, stopped, exited, or stopped to ask): what
/// it said, for the bot that started it.
pub const REPORT: &str = "report";
/// A child stopped on a question (its question tool) for the bot that
/// started it, which answers with `send_message`.
pub const QUESTION: &str = "question";
/// A child under ask autonomy waits on an approval (a command, an edit, a
/// process it defined) that its bot parent may decide, with `send_message`
/// and a `decision`. Only to a parent that could do the same itself.
pub const APPROVAL: &str = "approval";

/// About how much letter text one turn is handed, in characters. A turn always
/// takes at least one letter, however long; the rest wait for the next turn.
pub const BATCH_CHARS: usize = 20_000;

/// What a letter asks of the provider beyond its text: the command it opens
/// with and the skills it invokes, as the composer picked them. Only the
/// user's own messages have any.
#[derive(Serialize, Deserialize, Clone, Debug, Default, PartialEq, Eq)]
pub struct Dispatch {
    /// A provider command that opens the text, without its slash.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub command: Option<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub skills: Vec<String>,
}

impl Dispatch {
    /// What a message asks for, or nothing when it asks for nothing: a
    /// letter without a command or skills has no dispatch at all.
    pub fn of(command: Option<&str>, skills: Option<&[String]>) -> Option<Self> {
        let dispatch = Self {
            command: command.map(str::trim).filter(|name| !name.is_empty()).map(str::to_string),
            skills: skills.unwrap_or_default().to_vec(),
        };
        (dispatch != Self::default()).then_some(dispatch)
    }

    /// What of it the text still says. An edit can take the command out of a
    /// letter or leave a skill's name behind, and a command that no longer
    /// opens the text would be sent as a word in the middle of it.
    fn kept_by(self, text: &str) -> Option<Self> {
        let text = text.trim();
        let command = self.command.filter(|name| crate::providers::invokes_at(text, 0, name));
        let skills: Vec<String> =
            self.skills.into_iter().filter(|name| !crate::providers::invocations(text, name).is_empty()).collect();
        Self::of(command.as_deref(), Some(&skills))
    }
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
pub struct Letter {
    pub id: String,
    pub to_session: String,
    pub from: BotRef,
    pub text: String,
    pub at: i64,
    /// [`MESSAGE`], [`REPORT`], [`QUESTION`] or [`APPROVAL`].
    pub kind: String,
    /// For a report: the `session_events` cursor of the event it reports, so
    /// handing it over and reading the session some other way can each tell
    /// the other has already shown it.
    pub event_cursor: Option<i64>,
    /// What the user attached to it. Empty for every letter but the user's.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub files: Vec<AttachedFile>,
    /// The command and skills the user picked for it. A letter with a command
    /// is a turn of its own (see [`claim_batch`]) and is never steered.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub dispatch: Option<Dispatch>,
}

impl Letter {
    pub fn new(to_session: &str, from: &BotRef, text: &str, kind: &str, event_cursor: Option<i64>) -> Self {
        Self {
            id: uuid::Uuid::new_v4().to_string(),
            to_session: to_session.to_string(),
            from: from.clone(),
            text: text.to_string(),
            at: now_millis(),
            kind: kind.to_string(),
            event_cursor,
            files: Vec::new(),
            dispatch: None,
        }
    }

    pub fn is_report(&self) -> bool {
        self.kind == REPORT
    }
}

pub const MIGRATION_V11: &str = r#"
CREATE TABLE IF NOT EXISTS mailbox (
  id           TEXT PRIMARY KEY,
  to_session   TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  from_session TEXT REFERENCES sessions(id) ON DELETE SET NULL,
  from_name    TEXT NOT NULL,
  text         TEXT NOT NULL,
  at           INTEGER NOT NULL,
  delivered_at INTEGER
);

-- Reading the box is "what is still waiting for this bot", so the index
-- covers exactly that.
CREATE INDEX IF NOT EXISTS mailbox_waiting_idx
  ON mailbox (to_session, at) WHERE delivered_at IS NULL;
"#;

/// Who wrote it, when that was not a bot: `terminal` or `user`. A terminal
/// session has no turns to hand a reply to, and the user reads the reply in the
/// chat, so both change what the envelope tells the bot about answering.
pub const MIGRATION_FROM_KIND: &str = "ALTER TABLE mailbox ADD COLUMN from_kind TEXT;";

/// Migration 26: what a letter is, what it reports, and where it is in its
/// life. A letter that was delivered before stays delivered (and counts as
/// claimed then too); one that waits stays pending. A letter a child left its
/// parent is taken for a report, reporting the child's last event before it.
/// Each step looks before it acts, so a database wound back gets here intact.
pub(crate) fn migrate_lifecycle(conn: &rusqlite::Connection) -> rusqlite::Result<()> {
    use crate::store::has_column;
    if !has_column(conn, "mailbox", "kind")? {
        conn.execute_batch(
            "ALTER TABLE mailbox ADD COLUMN kind TEXT NOT NULL DEFAULT 'message';
             UPDATE mailbox SET kind = 'report'
              WHERE from_kind = 'session'
                AND from_session IN (SELECT id FROM sessions WHERE parent_id = mailbox.to_session);",
        )?;
    }
    if !has_column(conn, "mailbox", "event_cursor")? {
        conn.execute_batch(
            "ALTER TABLE mailbox ADD COLUMN event_cursor INTEGER;
             UPDATE mailbox SET event_cursor = (
               SELECT MAX(e.cursor) FROM session_events e
                WHERE e.session_id = mailbox.from_session AND e.at <= mailbox.at
             ) WHERE kind = 'report';",
        )?;
    }
    if !has_column(conn, "mailbox", "claimed_at")? {
        conn.execute_batch(
            "ALTER TABLE mailbox ADD COLUMN claimed_at INTEGER;
             UPDATE mailbox SET claimed_at = delivered_at WHERE delivered_at IS NOT NULL;",
        )?;
    }
    if !has_column(conn, "mailbox", "disposed_at")? {
        conn.execute_batch("ALTER TABLE mailbox ADD COLUMN disposed_at INTEGER;")?;
    }
    conn.execute_batch(
        "DROP INDEX IF EXISTS mailbox_waiting_idx;
         CREATE INDEX IF NOT EXISTS mailbox_pending_idx ON mailbox (to_session, at)
          WHERE claimed_at IS NULL AND delivered_at IS NULL AND disposed_at IS NULL;",
    )
}

/// Migration 30: what the user attaches to a letter still in the box, and
/// the order the user puts those letters in. Both are empty for every letter
/// before it, which is the order they came in. Each step looks before it acts.
pub(crate) fn migrate_queue(conn: &rusqlite::Connection) -> rusqlite::Result<()> {
    use crate::store::has_column;
    if !has_column(conn, "mailbox", "files_json")? {
        conn.execute_batch("ALTER TABLE mailbox ADD COLUMN files_json TEXT;")?;
    }
    if !has_column(conn, "mailbox", "queue_order")? {
        conn.execute_batch("ALTER TABLE mailbox ADD COLUMN queue_order INTEGER;")?;
    }
    Ok(())
}

/// Migration 32: what the user picked for a letter besides its text, a command
/// and skills (see [`Dispatch`]), as JSON. Empty for every letter before it.
/// The step looks before it acts.
pub(crate) fn migrate_dispatch(conn: &rusqlite::Connection) -> rusqlite::Result<()> {
    use crate::store::has_column;
    if !has_column(conn, "mailbox", "dispatch_json")? {
        conn.execute_batch("ALTER TABLE mailbox ADD COLUMN dispatch_json TEXT;")?;
    }
    Ok(())
}

/// A letter nobody has been handed yet.
const PENDING: &str = "claimed_at IS NULL AND delivered_at IS NULL AND disposed_at IS NULL";

/// The header a message is handed over under.
///
/// A letter arrives as a user turn — the same shape as something the person
/// typed — so the header is what tells them apart: who wrote it, the id they
/// are reached at, whether a model or a person wrote it, when (for a letter
/// that waited in the box), and how to answer. It is one text for a letter
/// that starts a turn and one steered into a turn that runs.
///
/// The id and not the name, because the name is the user's: they rename a
/// bot and a reply addressed to the old one reaches nobody. A sender that
/// has been deleted since has no id left (`ON DELETE SET NULL`), and saying so
/// is better than offering an address that is not one.
///
/// `parent` is the reader's parent, when the reader is a session somebody
/// started: a message from it is answered by the report the turn ends with,
/// not by writing back.
pub fn envelope(from: &BotRef, body: &str, at: Option<i64>, parent: Option<&str>) -> String {
    let kind = from.kind.as_deref().unwrap_or("bot");
    let (who, reply) = if kind == "user" {
        (
            "the user (a person, from the crew command line)".to_string(),
            "They read your reply here.".to_string(),
        )
    } else if from.id.is_empty() {
        (format!("{} ({kind}, no longer in this workspace), a model", from.name), String::new())
    } else if parent == Some(from.id.as_str()) {
        (
            format!("{} ({kind} {}), a model", from.name, from.id),
            "It started you: your report at the end of this turn reaches it, so there is no need for `send_message`. \
             No reply is needed beyond it."
                .to_string(),
        )
    } else {
        (
            format!("{} ({kind} {}), a model", from.name, from.id),
            format!(
                "Reply with `send_message` to `{}` if you want to answer. No reply is needed: end your turn when you \
                 have nothing to add.",
                from.id
            ),
        )
    };
    let mut head = format!("## Message\nFrom: {who}");
    if let Some(at) = at {
        head.push_str(&format!("\nAt: {}", stamp(at)));
    }
    if !reply.is_empty() {
        head.push('\n');
        head.push_str(&reply);
    }
    format!("{head}\n\n{body}")
}

/// The header a child's report is handed over under: whose it is, then what
/// it said. Nothing about what to do next; above all, nothing that sends the
/// bot to wait on the session, since this letter is what a wait would return.
pub fn report_envelope(from: &BotRef, body: &str) -> String {
    format!("## Report from session {}\n\n{}", who_session(from), body.trim())
}

/// The header a child's question is handed over under: the questions, then
/// how to answer them.
pub fn question_envelope(from: &BotRef, body: &str) -> String {
    let answer = if from.id.is_empty() {
        String::new()
    } else {
        format!(
            "\n\nAnswer with send_message to {}: text answers a single question, answers gives one per question in \
             order. If the decision is the user's, say so in your reply instead; the user can answer it in Crew.",
            from.id
        )
    };
    format!("## Question from session {}\n\n{}{answer}", who_session(from), body.trim())
}

/// The header a child's approval request is handed over under: what it
/// wants to do and why, then how to decide it.
pub fn approval_envelope(from: &BotRef, body: &str) -> String {
    let decide = if from.id.is_empty() {
        String::new()
    } else {
        format!(
            "\n\nDecide with send_message to {id}: {{\"to\": \"{id}\", \"decision\": \"allow\"}} or \"deny\". \
             If it is the user's call, ask the user first with your question tool; the user can also decide it in \
             Crew, and the first answer counts.",
            id = from.id
        )
    };
    format!("## Approval from session {}\n\n{}{decide}", who_session(from), body.trim())
}

fn who_session(from: &BotRef) -> String {
    if from.id.is_empty() {
        format!("{} (no longer in this workspace)", from.name)
    } else {
        format!("{} ({})", from.name, from.id)
    }
}

/// A child's questions as its parent reads them: each with its options.
pub fn questions_text(request: &serde_json::Value) -> String {
    let questions = request.get("questions").and_then(serde_json::Value::as_array).cloned().unwrap_or_default();
    questions
        .iter()
        .enumerate()
        .map(|(at, question)| {
            let text = question.get("question").and_then(serde_json::Value::as_str).unwrap_or("");
            let options: Vec<String> = question
                .get("options")
                .and_then(serde_json::Value::as_array)
                .map(|options| {
                    options
                        .iter()
                        .filter_map(|option| {
                            let label = option.get("label").and_then(serde_json::Value::as_str)?;
                            Some(match option.get("description").and_then(serde_json::Value::as_str) {
                                Some(about) if !about.is_empty() => format!("{label} ({about})"),
                                _ => label.to_string(),
                            })
                        })
                        .collect()
                })
                .unwrap_or_default();
            let multi = question.get("multiSelect").or_else(|| question.get("multi_select")).and_then(serde_json::Value::as_bool)
                == Some(true);
            let mut line = format!("{}. {text}", at + 1);
            if !options.is_empty() {
                line.push_str(&format!(
                    "\n   Options{}: {}",
                    if multi { " (several allowed, comma-separated)" } else { "" },
                    options.join("; ")
                ));
            }
            line
        })
        .collect::<Vec<_>>()
        .join("\n")
}

/// What a child's approval request asks, as its parent reads it: the tool,
/// what it would do, why (when the CLI said), and its input.
pub fn approval_text(request: &serde_json::Value) -> String {
    use serde_json::Value;
    let tool = request.get("tool").and_then(Value::as_str).unwrap_or("a tool");
    let title = request.get("title").and_then(Value::as_str).unwrap_or("").trim();
    let input = request.get("input").filter(|input| input.as_object().is_some_and(|map| !map.is_empty()));
    let mut out = if title.is_empty() { format!("It wants to use {tool}.") } else { format!("It wants to use {tool}: {title}") };
    let why = input.and_then(|input| {
        ["description", "reason", "justification"]
            .iter()
            .find_map(|key| input.get(*key).and_then(Value::as_str).map(str::trim).filter(|why| !why.is_empty()))
    });
    if let Some(why) = why {
        out.push_str(&format!("\nWhy: {why}"));
    }
    if let Some(input) = input {
        let raw = input.to_string();
        let clipped: String = raw.chars().take(2000).collect();
        out.push_str(&format!("\nInput: {clipped}{}", if clipped.len() < raw.len() { "…" } else { "" }));
    }
    out
}

/// A process a child defined or wants changed under ask autonomy, as its
/// parent reads it: what would run once it is accepted.
pub fn process_approval_text(process: &crew_protocol::Process) -> String {
    let describe = |spec: &crew_protocol::ProcessSpec| {
        let mut lines = vec![format!("  command: {}", spec.command)];
        if !spec.cwd.is_empty() {
            lines.push(format!("  cwd: {}", spec.cwd));
        }
        if !spec.env.is_empty() {
            let env: Vec<String> = spec.env.iter().map(|(key, value)| format!("{key}={value}")).collect();
            lines.push(format!("  env: {}", env.join(" ")));
        }
        if spec.auto_restart {
            lines.push("  auto_restart: true".into());
        }
        lines.join("\n")
    };
    match (&process.proposed, process.approved) {
        (_, false) => format!(
            "It defined the process \"{}\", which cannot start until it is accepted:\n{}",
            process.spec.name,
            describe(&process.spec)
        ),
        (Some(proposed), true) => format!(
            "It wants to change the process \"{}\". Now:\n{}\nProposed:\n{}",
            process.spec.name,
            describe(&process.spec),
            describe(proposed)
        ),
        (None, true) => format!("Its change to the process \"{}\" has already been decided.", process.spec.name),
    }
}

/// A letter as the model reads it, by its kind. `parent` is the reader's
/// parent, for a reader that is a session somebody started.
pub fn render(letter: &Letter, parent: Option<&str>) -> String {
    match letter.kind.as_str() {
        REPORT => report_envelope(&letter.from, &letter.text),
        QUESTION => question_envelope(&letter.from, &letter.text),
        APPROVAL => approval_envelope(&letter.from, &letter.text),
        _ => envelope(&letter.from, &letter.text, Some(letter.at), parent),
    }
}

/// Write a letter, on a connection the caller may hold a transaction on.
pub(crate) fn insert(conn: &rusqlite::Connection, letter: &Letter) -> rusqlite::Result<()> {
    conn.prepare_cached(
        "INSERT INTO mailbox (id, to_session, from_session, from_name, text, at, from_kind, kind, event_cursor, files_json, dispatch_json)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)",
    )?
    .execute(params![
        letter.id,
        letter.to_session,
        // The user is no session; an empty id would fail the foreign key.
        Some(letter.from.id.as_str()).filter(|id| !id.is_empty()),
        letter.from.name,
        letter.text,
        letter.at,
        letter.from.kind,
        letter.kind,
        letter.event_cursor,
        files_json(&letter.files),
        dispatch_json(letter.dispatch.as_ref())
    ])?;
    Ok(())
}

/// What a letter's files are stored as: nothing for a letter with none.
fn files_json(files: &[AttachedFile]) -> Option<String> {
    (!files.is_empty()).then(|| serde_json::to_string(files).unwrap_or_default())
}

/// What a letter's dispatch is stored as: nothing for a letter with none.
fn dispatch_json(dispatch: Option<&Dispatch>) -> Option<String> {
    dispatch.and_then(|dispatch| serde_json::to_string(dispatch).ok())
}

/// The dispatch a stored letter holds. A column that does not read is none.
fn dispatch_from(json: Option<String>) -> Option<Dispatch> {
    json.and_then(|json| serde_json::from_str(&json).ok())
}

/// The files a stored letter holds. A column that does not read is no files.
fn files_from(json: Option<String>) -> Vec<AttachedFile> {
    json.and_then(|json| serde_json::from_str(&json).ok()).unwrap_or_default()
}

/// Drop a message in a box.
pub fn enqueue(store: &Store, to_session: &str, from: &BotRef, text: &str) -> Result<Letter, String> {
    enqueue_with_files(store, to_session, from, text, Vec::new(), None)
}

/// Drop a message in a box with the files its writer attached to it and the
/// command and skills they picked.
pub fn enqueue_with_files(
    store: &Store,
    to_session: &str,
    from: &BotRef,
    text: &str,
    files: Vec<AttachedFile>,
    dispatch: Option<Dispatch>,
) -> Result<Letter, String> {
    let mut letter = Letter::new(to_session, from, text, MESSAGE, None);
    letter.files = files;
    letter.dispatch = dispatch;
    put(store, letter)
}

/// Drop a letter of any kind in its box.
pub fn put(store: &Store, letter: Letter) -> Result<Letter, String> {
    store.with(|conn| insert(conn, &letter))?;
    store.mailbox_changed(&letter.to_session);
    Ok(letter)
}

/// A message that goes over at once rather than through the box: a
/// session's first prompt, a message written into a running turn, the user
/// writing to a child. Kept like any other, already claimed, so no turn's end
/// hands it over again; the turn that carries it marks it delivered.
pub fn record_claimed(store: &Store, to_session: &str, from: &BotRef, text: &str) -> Result<Letter, String> {
    record_claimed_with_files(store, to_session, from, text, Vec::new(), None)
}

/// [`record_claimed`] for a message with files attached and a command and
/// skills picked.
pub fn record_claimed_with_files(
    store: &Store,
    to_session: &str,
    from: &BotRef,
    text: &str,
    files: Vec<AttachedFile>,
    dispatch: Option<Dispatch>,
) -> Result<Letter, String> {
    let mut letter = Letter::new(to_session, from, text, MESSAGE, None);
    letter.files = files;
    letter.dispatch = dispatch;
    store.with(|conn| {
        insert(conn, &letter)?;
        conn.prepare_cached("UPDATE mailbox SET claimed_at = ?2 WHERE id = ?1")?.execute(params![letter.id, letter.at])
    })?;
    store.mailbox_changed(to_session);
    Ok(letter)
}

/// A message that was read the moment it was written: an answer to a
/// question the reader stopped on.
pub fn record_delivered(store: &Store, to_session: &str, from: &BotRef, text: &str) -> Result<Letter, String> {
    let letter = Letter::new(to_session, from, text, MESSAGE, None);
    store.with(|conn| {
        insert(conn, &letter)?;
        conn.prepare_cached("UPDATE mailbox SET claimed_at = ?2, delivered_at = ?2 WHERE id = ?1")?
            .execute(params![letter.id, letter.at])
    })?;
    store.mailbox_changed(to_session);
    Ok(letter)
}

/// Claim one letter by id, for a turn handed it directly: a first prompt
/// that a restart put back in the box goes with the turn that resumes it,
/// not with whatever turn next drains the box.
pub fn claim_id(store: &Store, id: &str) -> Result<(), String> {
    let to: Option<String> = store.with(|conn| {
        conn.prepare_cached(
            "UPDATE mailbox SET claimed_at = ?2 WHERE id = ?1 AND claimed_at IS NULL AND disposed_at IS NULL
             RETURNING to_session",
        )?
        .query_row(params![id, now_millis()], |row| row.get(0))
        .optional()
    })?;
    if let Some(to) = to {
        store.mailbox_changed(&to);
    }
    Ok(())
}

/// Set one letter aside: the turn it was to start never did.
pub fn dispose(store: &Store, id: &str) -> Result<(), String> {
    let to: Option<String> = store.with(|conn| {
        conn.prepare_cached(
            "UPDATE mailbox SET disposed_at = ?2 WHERE id = ?1 AND delivered_at IS NULL AND disposed_at IS NULL
             RETURNING to_session",
        )?
        .query_row(params![id, now_millis()], |row| row.get(0))
        .optional()
    })?;
    if let Some(to) = to {
        store.mailbox_changed(&to);
    }
    Ok(())
}

/// A file known by its path alone: its name is the path's last part.
pub(crate) fn file_at(path: &str) -> AttachedFile {
    AttachedFile {
        name: std::path::Path::new(path).file_name().map_or_else(|| path.to_string(), |name| name.to_string_lossy().into_owned()),
        path: path.to_string(),
        kind: None,
        size: None,
    }
}

/// Why `letter_id` is not a letter of the user's that `session_id` has yet to
/// be handed, for the message that refuses an edit, a removal or a Send now.
/// `what` finishes "can no longer be": "edited", "removed", "sent now".
fn not_the_users_to_change(conn: &rusqlite::Connection, session_id: &str, letter_id: &str, what: &str) -> String {
    let found: Option<(String, Option<String>, bool, bool, bool)> = conn
        .prepare_cached(
            "SELECT to_session, from_kind, claimed_at IS NOT NULL, delivered_at IS NOT NULL, disposed_at IS NOT NULL
               FROM mailbox WHERE id = ?1",
        )
        .and_then(|mut stmt| {
            stmt.query_row(params![letter_id], |row| {
                Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?, row.get(4)?))
            })
            .optional()
        })
        .unwrap_or(None);
    match found {
        Some((to, from_kind, claimed, delivered, disposed)) if to == session_id && from_kind.as_deref() == Some("user") => {
            if disposed {
                "That message was already removed.".into()
            } else if delivered {
                format!("The session already read that message; it can no longer be {what}.")
            } else if claimed {
                format!("The running turn already took that message; it can no longer be {what}.")
            } else {
                "That message is not waiting.".into()
            }
        }
        Some((to, ..)) if to == session_id => "Only a message you wrote can be changed.".into(),
        _ => "That message is not in this session's queue.".into(),
    }
}

/// Changes the text and the files of a letter the user wrote that its session
/// has yet to be handed. `files` of `None` leaves the files as they are. Refused
/// once a turn has taken the letter (a steer, or a batch), and for any letter
/// that is not the user's.
pub fn edit(
    store: &Store,
    session_id: &str,
    letter_id: &str,
    text: &str,
    files: Option<Vec<String>>,
) -> Result<(), String> {
    store.with(|conn| {
        let tx = conn.unchecked_transaction()?;
        let held: Option<(Option<String>, Option<String>)> = tx
            .prepare_cached(&format!(
                "SELECT files_json, dispatch_json FROM mailbox
                  WHERE id = ?1 AND to_session = ?2 AND from_kind = 'user' AND from_session IS NULL AND {PENDING}"
            ))?
            .query_row(params![letter_id, session_id], |row| Ok((row.get(0)?, row.get(1)?)))
            .optional()?;
        let Some((held, dispatch)) = held else {
            return Ok(Err(not_the_users_to_change(&tx, session_id, letter_id, "edited")));
        };
        let dispatch = dispatch_from(dispatch).and_then(|dispatch| dispatch.kept_by(text));
        let files = match files {
            None => held,
            // The ones it already holds keep what was known of them (an image
            // stays an image); a new path is known by its name.
            Some(paths) => {
                let held = files_from(held);
                let files: Vec<AttachedFile> = paths
                    .into_iter()
                    .map(|path| {
                        held.iter().find(|file| file.path == path).cloned().unwrap_or_else(|| file_at(&path))
                    })
                    .collect();
                files_json(&files)
            }
        };
        if text.trim().is_empty() && files.is_none() {
            return Ok(Err("A message needs some text or a file.".to_string()));
        }
        tx.prepare_cached("UPDATE mailbox SET text = ?2, files_json = ?3, dispatch_json = ?4 WHERE id = ?1")?
            .execute(params![letter_id, text, files, dispatch_json(dispatch.as_ref())])?;
        tx.commit()?;
        Ok(Ok(()))
    })?
    .inspect(|_| store.mailbox_changed(session_id))
}

/// Sets aside a letter the user wrote that its session has yet to be handed,
/// unread. Refused once a turn has taken it, and for any letter that is not
/// the user's.
pub fn dispose_users(store: &Store, session_id: &str, letter_id: &str) -> Result<(), String> {
    store.with(|conn| {
        let set_aside = conn
            .prepare_cached(&format!(
                "UPDATE mailbox SET disposed_at = ?3
                  WHERE id = ?1 AND to_session = ?2 AND from_kind = 'user' AND from_session IS NULL AND {PENDING}"
            ))?
            .execute(params![letter_id, session_id, now_millis()])?;
        Ok(if set_aside == 1 { Ok(()) } else { Err(not_the_users_to_change(conn, session_id, letter_id, "removed")) })
    })?
    .inspect(|_| store.mailbox_changed(session_id))
}

/// Puts the letters named first, in the order given. Ids that are not waiting
/// in the box are ignored, and what is not named keeps its place after them.
/// They are given a place just before the first letter the box holds, so no
/// other letter's order changes (a steer put back keeps the place its time
/// gives it).
pub fn reorder(store: &Store, session_id: &str, letter_ids: &[String]) -> Result<(), String> {
    let moved = store.with(|conn| {
        let tx = conn.unchecked_transaction()?;
        let moved = put_first(&tx, session_id, letter_ids)?;
        tx.commit()?;
        Ok(moved)
    })?;
    if moved > 0 {
        store.mailbox_changed(session_id);
    }
    Ok(())
}

/// Moves a letter of the user's to the head of its box, for Send now: the same
/// as [`reorder`] with that one id, but refused for a letter that is not the
/// user's to move (taken by a turn already, or someone else's).
pub fn send_first(store: &Store, session_id: &str, letter_id: &str) -> Result<(), String> {
    store.with(|conn| {
        let tx = conn.unchecked_transaction()?;
        let waiting: bool = tx
            .prepare_cached(&format!(
                "SELECT EXISTS(SELECT 1 FROM mailbox
                  WHERE id = ?1 AND to_session = ?2 AND from_kind = 'user' AND from_session IS NULL AND {PENDING})"
            ))?
            .query_row(params![letter_id, session_id], |row| row.get(0))?;
        if !waiting {
            return Ok(Err(not_the_users_to_change(&tx, session_id, letter_id, "sent now")));
        }
        put_first(&tx, session_id, &[letter_id.to_string()])?;
        tx.commit()?;
        Ok(Ok(()))
    })??;
    store.mailbox_changed(session_id);
    Ok(())
}

fn put_first(conn: &rusqlite::Connection, session_id: &str, letter_ids: &[String]) -> rusqlite::Result<usize> {
    let mut named: Vec<&String> = Vec::new();
    for id in letter_ids {
        let waiting: bool = conn
            .prepare_cached(&format!("SELECT EXISTS(SELECT 1 FROM mailbox WHERE id = ?1 AND to_session = ?2 AND {PENDING})"))?
            .query_row(params![id, session_id], |row| row.get(0))?;
        if waiting && !named.contains(&id) {
            named.push(id);
        }
    }
    if named.is_empty() {
        return Ok(0);
    }
    // Under every letter still on its way, claimed ones included: a steer the
    // turn gives back must not end up ahead of the letter sent now.
    let first: i64 = conn
        .prepare_cached(
            "SELECT MIN(COALESCE(queue_order, at)) FROM mailbox
              WHERE to_session = ?1 AND delivered_at IS NULL AND disposed_at IS NULL",
        )?
        .query_row(params![session_id], |row| row.get(0))?;
    for (at, id) in named.iter().enumerate() {
        conn.prepare_cached("UPDATE mailbox SET queue_order = ?2 WHERE id = ?1")?
            .execute(params![id, first - (named.len() - at) as i64])?;
    }
    Ok(named.len())
}

const SELECT: &str = "SELECT id, to_session, from_session, from_name, text, at, from_kind, kind, event_cursor, files_json, dispatch_json FROM mailbox";
const RETURNING: &str =
    "RETURNING id, to_session, from_session, from_name, text, at, from_kind, kind, event_cursor, files_json, dispatch_json";

/// The order a box hands its letters over in: the one the user put the queue
/// in, else the one they came in. A reordered letter's `queue_order` stands in
/// for its `at`, so the two kinds sort together; the rowid breaks a tie, since
/// two letters can share a millisecond.
const QUEUE: &str = "COALESCE(queue_order, at) ASC, rowid ASC";

fn row_to_letter(row: &rusqlite::Row) -> rusqlite::Result<Letter> {
    Ok(Letter {
        id: row.get(0)?,
        to_session: row.get(1)?,
        from: BotRef {
            // The sender may have been deleted since; its name is what the
            // transcript needs, and that was copied in at send time.
            id: row.get::<_, Option<String>>(2)?.unwrap_or_default(),
            name: row.get(3)?,
            kind: row.get(6)?,
        },
        text: row.get(4)?,
        at: row.get(5)?,
        kind: row.get(7)?,
        event_cursor: row.get(8)?,
        files: files_from(row.get(9)?),
        dispatch: dispatch_from(row.get(10)?),
    })
}

/// Everything still waiting for one bot, in the order it goes over.
pub fn waiting(store: &Store, to_session: &str) -> Result<Vec<Letter>, String> {
    store.with(|conn| {
        let mut stmt = conn.prepare_cached(&format!(
            "{SELECT} WHERE to_session = ?1 AND {PENDING} ORDER BY {QUEUE}"
        ))?;
        let rows = stmt.query_map(params![to_session], row_to_letter)?;
        rows.collect()
    })
}

/// Claim the first waiting letter alone. Claiming in the same statement that
/// picks it is what keeps two callers from handing the same letter over twice.
pub fn claim(store: &Store, to_session: &str) -> Result<Option<Letter>, String> {
    store.with(|conn| {
        conn.prepare_cached(&format!(
            "UPDATE mailbox SET claimed_at = ?2
             WHERE id = (
               SELECT id FROM mailbox
               WHERE to_session = ?1 AND {PENDING}
               -- Two letters can share a millisecond; the rowid breaks the tie
               -- so the order out is the order in.
               ORDER BY {QUEUE} LIMIT 1
             )
             {RETURNING}"
        ))?
        .query_row(params![to_session, now_millis()], row_to_letter)
        .optional()
    })
    .inspect(|letter| {
        if letter.is_some() {
            store.mailbox_changed(to_session);
        }
    })
}

/// Claim what one turn is handed: every waiting letter, in queue order, until
/// their text passes `cap` characters (the first is taken whatever its size).
/// A letter with a command is a turn of its own: it joins no other, so a
/// `/compact` is neither run with the letters before it nor given the next one
/// as its arguments.
pub fn claim_batch(store: &Store, to_session: &str, cap: usize) -> Result<Vec<Letter>, String> {
    store.with(|conn| {
        let tx = conn.unchecked_transaction()?;
        let pending: Vec<Letter> = tx
            .prepare_cached(&format!(
                "{SELECT} WHERE to_session = ?1 AND {PENDING} ORDER BY {QUEUE}"
            ))?
            .query_map(params![to_session], row_to_letter)?
            .collect::<rusqlite::Result<_>>()?;
        let mut batch: Vec<Letter> = Vec::new();
        let mut spent = 0;
        for letter in pending {
            let size = letter.text.chars().count();
            let command = letter.dispatch.as_ref().is_some_and(|dispatch| dispatch.command.is_some());
            if !batch.is_empty() && (command || spent + size > cap) {
                break;
            }
            spent += size;
            batch.push(letter);
            if command {
                break;
            }
        }
        let now = now_millis();
        for letter in &batch {
            tx.prepare_cached("UPDATE mailbox SET claimed_at = ?2 WHERE id = ?1")?
                .execute(params![letter.id, now])?;
        }
        tx.commit()?;
        Ok(batch)
    })
    .inspect(|batch| {
        if !batch.is_empty() {
            store.mailbox_changed(to_session);
        }
    })
}

/// Put a claimed letter back, for a delivery that could not go through. It
/// keeps its original `at`, so it stays at the head of the queue.
pub fn release(store: &Store, id: &str) -> Result<(), String> {
    let to: Option<String> = store.with(|conn| {
        conn.prepare_cached(
            "UPDATE mailbox SET claimed_at = NULL WHERE id = ?1 AND delivered_at IS NULL RETURNING to_session",
        )?
        .query_row(params![id], |row| row.get(0))
        .optional()
    })?;
    if let Some(to) = to {
        store.mailbox_changed(&to);
    }
    Ok(())
}

/// The turn that carried these letters has ended: they are delivered.
pub fn delivered(store: &Store, ids: &[String]) -> Result<(), String> {
    if ids.is_empty() {
        return Ok(());
    }
    let boxes: std::collections::BTreeSet<String> = store.with(|conn| {
        let now = now_millis();
        let mut boxes = std::collections::BTreeSet::new();
        for id in ids {
            // Delivered is claimed too: a letter read in a running turn was
            // claimed when it was written into it, but say so either way.
            let to: Option<String> = conn
                .prepare_cached(
                    "UPDATE mailbox SET delivered_at = ?2, claimed_at = COALESCE(claimed_at, ?2)
                      WHERE id = ?1 AND delivered_at IS NULL RETURNING to_session",
                )?
                .query_row(params![id, now], |row| row.get(0))
                .optional()?;
            boxes.extend(to);
        }
        Ok(boxes)
    })?;
    for to in boxes {
        store.mailbox_changed(&to);
    }
    Ok(())
}

/// Letters handed to a turn that never ended — the daemon stopped under it —
/// go back in the box, to be handed over again. Only at startup, when no turn
/// is running: any other time, a claimed letter is one a live turn carries.
pub(crate) fn release_unfinished(conn: &rusqlite::Connection) -> rusqlite::Result<usize> {
    conn.execute(
        "UPDATE mailbox SET claimed_at = NULL
          WHERE claimed_at IS NOT NULL AND delivered_at IS NULL AND disposed_at IS NULL",
        [],
    )
}

/// Set aside whatever still waits for a session that has exited: nobody is
/// left to hand it to. Kept, marked disposed.
pub fn drop_waiting(store: &Store, to_session: &str) -> Result<usize, String> {
    store
        .with(|conn| {
            conn.prepare_cached(
                "UPDATE mailbox SET disposed_at = ?2
                  WHERE to_session = ?1 AND delivered_at IS NULL AND disposed_at IS NULL",
            )?
            .execute(params![to_session, now_millis()])
        })
        .inspect(|&count| changed(store, to_session, count))
}

fn changed(store: &Store, to_session: &str, count: usize) {
    if count > 0 {
        store.mailbox_changed(to_session);
    }
}

/// Take back the reports and questions a child left in its parent's box that
/// the parent has since read some other way: a wait or a read showed it the
/// session up to `seen`. Only those, and only at or below that cursor: a
/// message the child wrote, or a later turn's report, still has to be handed
/// over.
pub fn take_back(store: &Store, to_session: &str, from_session: &str, seen: i64) -> Result<usize, String> {
    store.with(|conn| {
        conn.prepare_cached(&format!(
            "UPDATE mailbox SET disposed_at = ?4
              WHERE to_session = ?1 AND from_session = ?2 AND kind IN ('report', 'question', 'approval')
                AND event_cursor IS NOT NULL AND event_cursor <= ?3 AND {PENDING}"
        ))?
        .execute(params![to_session, from_session, seen, now_millis()])
    })
    .inspect(|&count| changed(store, to_session, count))
}

/// A child's question was answered, by its parent or by the user: a question
/// letter still waiting to wake the parent has nothing left to ask.
pub fn dispose_questions(store: &Store, to_session: &str, from_session: &str) -> Result<usize, String> {
    dispose_kind(store, to_session, from_session, QUESTION)
}

/// A child's approval was decided, by its parent or by the user: an
/// approval letter still waiting to wake the parent has nothing left to ask.
pub fn dispose_approvals(store: &Store, to_session: &str, from_session: &str) -> Result<usize, String> {
    dispose_kind(store, to_session, from_session, APPROVAL)
}

fn dispose_kind(store: &Store, to_session: &str, from_session: &str, kind: &str) -> Result<usize, String> {
    store.with(|conn| {
        conn.prepare_cached(&format!(
            "UPDATE mailbox SET disposed_at = ?3
              WHERE to_session = ?1 AND from_session = ?2 AND kind = ?4 AND {PENDING}"
        ))?
        .execute(params![to_session, from_session, now_millis(), kind])
    })
    .inspect(|&count| changed(store, to_session, count))
}

/// Whether `from_session` has ever written `to_session` a message: a session
/// that asked a bot something may be answered by it, whoever started it.
pub fn has_written(store: &Store, from_session: &str, to_session: &str) -> bool {
    store
        .with(|conn| {
            conn.prepare_cached(
                "SELECT EXISTS(SELECT 1 FROM mailbox WHERE from_session = ?1 AND to_session = ?2 AND kind = 'message')",
            )?
            .query_row(params![from_session, to_session], |row| row.get::<_, bool>(0))
        })
        .unwrap_or(false)
}

/// How many letters are waiting. The sidebar shows it; the tool answers with it
/// so the sender knows its message landed in a queue rather than in a turn.
pub fn waiting_count(store: &Store, to_session: &str) -> Result<i64, String> {
    store.with(|conn| {
        conn.prepare_cached(&format!("SELECT COUNT(*) FROM mailbox WHERE to_session = ?1 AND {PENDING}"))?
            .query_row(params![to_session], |row| row.get(0))
    })
}

/// Letters still on their way: waiting, or claimed by a turn that has not
/// started or not ended yet. A turn's own letters are marked delivered before
/// it settles, so this is never stuck on a turn that is over.
pub fn undelivered_count(store: &Store, to_session: &str) -> Result<i64, String> {
    store.with(|conn| {
        conn.prepare_cached("SELECT COUNT(*) FROM mailbox WHERE to_session = ?1 AND delivered_at IS NULL AND disposed_at IS NULL")?
            .query_row(params![to_session], |row| row.get(0))
    })
}

/// Migration 28: the indexes the threads read by. A pair's thread is every
/// letter one wrote the other, both ways, so a box is read by sender as well
/// as by reader, whatever its letters' state.
pub const MIGRATION_V28: &str = "
CREATE INDEX IF NOT EXISTS mailbox_to_idx ON mailbox (to_session, at);
CREATE INDEX IF NOT EXISTS mailbox_from_idx ON mailbox (from_session, at);
";

/// How much of a letter a pair's preview keeps, in characters.
pub const PREVIEW_CHARS: usize = 280;
/// A thread page's default size, and the most one page holds.
const THREAD_LIMIT: u32 = 50;
const THREAD_MAX: u32 = 200;

/// The user, as a party to a thread.
pub fn user() -> BotRef {
    BotRef { id: String::new(), name: "You".into(), kind: Some("user".into()) }
}

/// Whether a party named by a request is the user.
fn is_user(id: &str) -> bool {
    id.is_empty() || id == "user"
}

/// A letter with both parties named as they are now and its state, for
/// [`row_to_thread_letter`]: the sender's and the reader's current names
/// (a bot renamed since reads under its new name), the reader's kind, where
/// the letter is in its life.
const THREAD_SELECT: &str = "SELECT m.id, m.to_session, m.from_session, COALESCE(fb.name, f.name, m.from_name),
        m.text, m.at, m.from_kind, m.kind, COALESCE(tb.name, t.name), t.kind,
        CASE WHEN m.disposed_at IS NOT NULL THEN 'disposed'
             WHEN m.delivered_at IS NOT NULL THEN 'delivered'
             WHEN m.claimed_at IS NOT NULL THEN 'claimed'
             ELSE 'pending' END,
        m.rowid, m.files_json
   FROM mailbox m
   JOIN sessions t ON t.id = m.to_session LEFT JOIN bots tb ON tb.id = t.bot_id
   LEFT JOIN sessions f ON f.id = m.from_session LEFT JOIN bots fb ON fb.id = f.bot_id";

/// A session's kind as a [`BotRef`] says it: absent for a bot.
fn party_kind(kind: &str) -> Option<String> {
    match kind {
        "bot" => None,
        "terminal" => Some("terminal".into()),
        _ => Some("session".into()),
    }
}

fn row_to_thread_letter(row: &rusqlite::Row) -> rusqlite::Result<(crew_protocol::ThreadLetter, i64)> {
    let to_kind: String = row.get(9)?;
    let state: String = row.get(10)?;
    let paths: Vec<String> = files_from(row.get(12)?).into_iter().map(|file| file.path).collect();
    Ok((
        crew_protocol::ThreadLetter {
            id: row.get(0)?,
            from: BotRef {
                id: row.get::<_, Option<String>>(2)?.unwrap_or_default(),
                name: row.get(3)?,
                kind: row.get(6)?,
            },
            to: BotRef { id: row.get(1)?, name: row.get(8)?, kind: party_kind(&to_kind) },
            text: row.get(4)?,
            at: row.get(5)?,
            kind: row.get(7)?,
            queue: if state == "claimed" { "steering" } else { "waiting" }.into(),
            state,
            files: Some(paths).filter(|paths| !paths.is_empty()),
        },
        row.get(11)?,
    ))
}

/// What waits in a session's box and what a turn has taken but not finished,
/// in the order it goes over: the queue its chat shows. A claimed letter may already be in
/// the transcript (the turn carrying it put it there); the block's
/// `letterId` says which.
pub fn pending(store: &Store, to_session: &str) -> Result<Vec<crew_protocol::ThreadLetter>, String> {
    store.with(|conn| {
        conn.prepare_cached(&format!(
            "{THREAD_SELECT} WHERE m.to_session = ?1 AND m.delivered_at IS NULL AND m.disposed_at IS NULL
              ORDER BY COALESCE(m.queue_order, m.at) ASC, m.rowid ASC"
        ))?
        .query_map(params![to_session], |row| row_to_thread_letter(row).map(|(letter, _)| letter))?
        .collect()
    })
}

/// The letters between `a` and `b`, both ways, oldest first: the page that
/// ends just before the letter `before`, or the newest. Either party may be
/// the user (`""` or `"user"`), who only ever writes.
pub fn thread(
    store: &Store,
    a: &str,
    b: &str,
    before: Option<&str>,
    limit: Option<u32>,
) -> Result<crew_protocol::ThreadPage, String> {
    let limit = limit.unwrap_or(THREAD_LIMIT).clamp(1, THREAD_MAX);
    let (pair, first, second) = match (is_user(a), is_user(b)) {
        (true, true) => return Err("A thread is between two parties; both were the user".into()),
        (true, false) | (false, true) => (
            "m.from_kind = 'user' AND m.from_session IS NULL AND m.to_session = ?1",
            if is_user(a) { b } else { a },
            "",
        ),
        (false, false) => (
            "((m.from_session = ?1 AND m.to_session = ?2) OR (m.from_session = ?2 AND m.to_session = ?1))",
            a,
            b,
        ),
    };
    store.with(|conn| {
        // Where the page ends: the letter `before`, by its time and then the
        // order it went in, so two letters in one millisecond are not lost
        // between pages.
        let end: Option<(i64, i64)> = match before {
            Some(id) => conn
                .prepare_cached("SELECT at, rowid FROM mailbox WHERE id = ?1")?
                .query_row(params![id], |row| Ok((row.get(0)?, row.get(1)?)))
                .optional()?,
            None => None,
        };
        let (at, rowid) = end.unwrap_or((i64::MAX, i64::MAX));
        let mut rows: Vec<crew_protocol::ThreadLetter> = conn
            .prepare_cached(&format!(
                "{THREAD_SELECT} WHERE {pair} AND (m.at < ?3 OR (m.at = ?3 AND m.rowid < ?4))
                  ORDER BY m.at DESC, m.rowid DESC LIMIT ?5"
            ))?
            .query_map(params![first, second, at, rowid, limit + 1], |row| {
                row_to_thread_letter(row).map(|(letter, _)| letter)
            })?
            .collect::<rusqlite::Result<_>>()?;
        let more = rows.len() > limit as usize;
        rows.truncate(limit as usize);
        rows.reverse();
        Ok(crew_protocol::ThreadPage { letters: rows, more })
    })
}

/// The pairs a session's Conversations menu lists, newest first: each one it
/// wrote to or was written by, and each child of its own the user wrote to.
pub fn pairs(store: &Store, session_id: &str) -> Result<Vec<crew_protocol::ThreadPair>, String> {
    let preview = format!("substr(m.text, 1, {PREVIEW_CHARS})");
    let select = THREAD_SELECT.replacen("m.text", &preview, 1);
    let letters: Vec<(crew_protocol::ThreadLetter, i64)> = store.with(|conn| {
        conn.prepare_cached(&format!(
            "{select} WHERE m.to_session = ?1
             UNION ALL {select} WHERE m.from_session = ?1
             UNION ALL {select} WHERE m.from_kind = 'user' AND m.from_session IS NULL
                AND m.to_session IN (SELECT id FROM sessions WHERE parent_id = ?1)"
        ))?
        .query_map(params![session_id], row_to_thread_letter)?
        .collect()
    })?;
    // What the user typed to their own session is the chat itself, not a
    // conversation with "You" beside it.
    let own = crate::session::get(store, session_id.to_string())?.is_some_and(|row| row.kind == "terminal");
    // One entry per pair, keyed by its two parties in order: the newest letter
    // and how many there are.
    let mut by_pair: std::collections::HashMap<(String, String), (crew_protocol::ThreadLetter, i64, i64)> =
        std::collections::HashMap::new();
    for (letter, rowid) in letters {
        if own && letter.from.kind.as_deref() == Some("user") && letter.to.id == session_id {
            continue;
        }
        let from = if letter.from.kind.as_deref() == Some("user") { "user".to_string() } else { letter.from.id.clone() };
        if from.is_empty() {
            // A sender deleted since: no party left to pair with.
            continue;
        }
        let to = letter.to.id.clone();
        let key = if from <= to { (from, to) } else { (to, from) };
        let entry = by_pair.entry(key).or_insert_with(|| (letter.clone(), rowid, 0));
        entry.2 += 1;
        if (letter.at, rowid) > (entry.0.at, entry.1) {
            entry.0 = letter;
            entry.1 = rowid;
        }
    }
    let mut out: Vec<crew_protocol::ThreadPair> = by_pair
        .into_values()
        .map(|(last, _, count)| {
            let (from, to) = (last.from.clone(), last.to.clone());
            let (peer, with) = if to.id == session_id {
                (from, None)
            } else if from.id == session_id && from.kind.as_deref() != Some("user") {
                (to, None)
            } else {
                // The user and this session's child: the pair is theirs.
                (from, Some(to))
            };
            crew_protocol::ThreadPair { peer, with, last, count }
        })
        .collect();
    out.sort_by(|x, y| y.last.at.cmp(&x.last.at));
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn store() -> Store {
        let dir = std::env::temp_dir().join(format!("crew-mailbox-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).expect("dir");
        Store::open(dir.join("crew.sqlite3")).expect("store")
    }

    fn session(store: &Store, name: &str) -> String {
        let root = std::env::temp_dir().join(uuid::Uuid::new_v4().to_string());
        std::fs::create_dir_all(&root).expect("root");
        let workspace =
            crate::workspace::create(store, format!("w-{name}"), root.to_string_lossy().into())
                .expect("workspace");
        crate::session::create(
            store,
            workspace.id,
            "bot".into(),
            name.into(),
            "claude".into(),
            "m".into(),
            "".into(),
            "ask".into(),
        )
        .expect("session")
        .id
    }

    fn sender(id: &str) -> BotRef {
        BotRef::bot(id, "Coder")
    }

    #[test]
    fn the_envelope_carries_the_id_the_sender_is_reached_at() {
        let letter = envelope(&sender("s1"), "the branch is green", None, None);
        assert_eq!(
            letter,
            "## Message\nFrom: Coder (bot s1), a model\nReply with `send_message` to `s1` if you want to answer. No reply is \
             needed: end your turn when you have nothing to add.\n\nthe branch is green"
        );
    }

    /// The time it was written, not the time it was handed over: a letter that
    /// waited an hour in a busy bot's box still says when it was written.
    #[test]
    fn the_envelope_says_when_it_was_written() {
        let at = crate::store::now_millis() - 3_600_000;
        let letter = envelope(&sender("s1"), "hi", Some(at), None);
        assert!(letter.contains(&format!("At: {}", crate::store::stamp(at))), "{letter}");
    }

    /// A sender that was deleted leaves a name and no address. Offering the
    /// empty id would be offering a reply that goes nowhere.
    #[test]
    fn a_deleted_sender_is_named_without_an_address() {
        let letter = envelope(&BotRef::bot("", "Coder"), "hi", None, None);
        assert!(letter.contains("Coder (bot, no longer in this workspace)"), "{letter}");
        assert!(!letter.contains("send_message"), "{letter}");
    }

    /// Each kind of sender says who wrote it and what a reply can do: the user
    /// is a person who reads the chat, and a session's own parent reads its report. None
    /// needs an answer.
    #[test]
    fn the_envelope_says_how_to_answer_each_kind_of_sender() {
        let terminal = BotRef { id: "t1".into(), name: "shell".into(), kind: Some("terminal".into()) };
        let out = envelope(&terminal, "hi", None, None);
        assert!(out.starts_with("## Message\nFrom: shell (terminal t1), a model\nReply with `send_message` to `t1`"), "{out}");
        let user = BotRef { id: String::new(), name: "You".into(), kind: Some("user".into()) };
        let person = envelope(&user, "hi", None, None);
        assert!(person.contains("From: the user (a person") && !person.contains("a model"), "{person}");
        let session = BotRef { id: "c1".into(), name: "codex: fix".into(), kind: Some("session".into()) };
        let from_session = envelope(&session, "hi", None, None);
        assert!(from_session.contains("From: codex: fix (session c1), a model\nReply with `send_message` to `c1`"), "{from_session}");
        assert!(from_session.contains("No reply is needed"), "{from_session}");
        let parent = envelope(&sender("p1"), "more", None, Some("p1"));
        assert!(parent.contains("your report at the end of this turn reaches it") && !parent.contains("Reply with"), "{parent}");
        assert!(parent.contains("(bot p1), a model"), "{parent}");
        let shell = envelope(&terminal, "the job", None, Some("t1"));
        assert!(shell.contains("your report at the end of this turn reaches it"), "{shell}");
    }

    /// A question lists each question with its options, and says how to answer.
    #[test]
    fn an_approval_says_what_it_wants_and_why_and_how_to_decide() {
        let from = BotRef { id: "c1".into(), name: "claude: build".into(), kind: Some("session".into()) };
        let request = serde_json::json!({ "kind": "approval", "tool": "Bash", "title": "npm test",
            "input": { "command": "npm test", "description": "Run the unit tests" } });
        let out = render(&Letter::new("p1", &from, &approval_text(&request), APPROVAL, Some(3)), None);
        assert!(out.starts_with("## Approval from session claude: build (c1)\n\nIt wants to use Bash: npm test\nWhy: Run the unit tests\nInput: {"), "{out}");
        assert!(out.contains(r#"{"to": "c1", "decision": "allow"}"#) && out.contains("first answer counts"), "{out}");
    }

    #[test]
    fn a_question_is_headed_by_the_session_and_says_how_to_answer() {
        let from = BotRef { id: "c1".into(), name: "codex: fix".into(), kind: Some("session".into()) };
        let request = serde_json::json!({ "kind": "question", "questions": [
            { "question": "Which color?", "header": "Color", "options": [{ "label": "Red", "description": "warm" }, { "label": "Blue" }] },
            { "question": "Ship it?", "header": "Ship", "multiSelect": true, "options": [{ "label": "Yes" }] }
        ] });
        let out = render(&Letter::new("p1", &from, &questions_text(&request), QUESTION, Some(3)), None);
        assert!(out.starts_with("## Question from session codex: fix (c1)\n\n1. Which color?\n   Options: Red (warm); Blue\n2. Ship it?\n   Options (several allowed"), "{out}");
        assert!(out.ends_with("the user can answer it in Crew."), "{out}");
        assert!(out.contains("send_message to c1"), "{out}");
    }

    #[test]
    fn a_letter_waits_until_it_is_claimed() {
        let store = store();
        let to = session(&store, "to");
        let from = session(&store, "from");
        enqueue(&store, &to, &sender(&from), "ping").expect("enqueue");
        assert_eq!(waiting_count(&store, &to).expect("count"), 1);

        let claimed = claim(&store, &to).expect("claim").expect("a letter");
        assert_eq!(claimed.text, "ping");
        assert_eq!(claimed.from.name, "Coder");
        assert_eq!(waiting_count(&store, &to).expect("count"), 0);
        assert!(claim(&store, &to).expect("empty").is_none());
    }

    #[test]
    fn letters_come_out_in_the_order_they_went_in() {
        let store = store();
        let to = session(&store, "to");
        let from = session(&store, "from");
        for text in ["first", "second", "third"] {
            enqueue(&store, &to, &sender(&from), text).expect("enqueue");
        }
        let order: Vec<String> = (0..3)
            .map(|_| claim(&store, &to).expect("claim").expect("letter").text)
            .collect();
        assert_eq!(order, ["first", "second", "third"]);
    }

    #[test]
    fn a_released_letter_stays_at_the_head_of_the_queue() {
        let store = store();
        let to = session(&store, "to");
        let from = session(&store, "from");
        enqueue(&store, &to, &sender(&from), "first").expect("enqueue");
        enqueue(&store, &to, &sender(&from), "second").expect("enqueue");

        let claimed = claim(&store, &to).expect("claim").expect("letter");
        release(&store, &claimed.id).expect("release");
        assert_eq!(waiting_count(&store, &to).expect("count"), 2);
        assert_eq!(claim(&store, &to).expect("claim").expect("letter").text, "first");
    }

    #[test]
    fn a_box_belongs_to_one_bot() {
        let store = store();
        let mine = session(&store, "mine");
        let yours = session(&store, "yours");
        enqueue(&store, &mine, &sender(&yours), "for me").expect("enqueue");
        assert!(claim(&store, &yours).expect("claim").is_none());
        assert_eq!(waiting(&store, &mine).expect("waiting").len(), 1);
    }

    #[test]
    fn a_deleted_sender_leaves_its_name_behind() {
        let store = store();
        let to = session(&store, "to");
        let from = session(&store, "from");
        enqueue(&store, &to, &sender(&from), "last words").expect("enqueue");
        crate::session::delete(&store, from).expect("delete");
        let letter = claim(&store, &to).expect("claim").expect("letter");
        assert_eq!(letter.from.name, "Coder");
        assert!(letter.from.id.is_empty());
    }

    fn child_of(store: &Store, parent: &str) -> BotRef {
        let row = crate::session::get(store, parent.to_string()).expect("get").expect("parent");
        let child = crate::session::create_child(
            store,
            row.workspace_id,
            "codex: fix".into(),
            "codex".into(),
            "m".into(),
            "full".into(),
            None,
            Some(parent.to_string()),
        )
        .expect("child");
        BotRef { id: child.id, name: child.name, kind: Some("session".into()) }
    }

    fn report(store: &Store, to: &str, from: &BotRef, text: &str, cursor: i64) -> Letter {
        let letter = Letter::new(to, from, text, REPORT, Some(cursor));
        store.with(|conn| insert(conn, &letter)).expect("report");
        letter
    }

    /// Where a letter is in its life, as the columns have it.
    fn state(store: &Store, id: &str) -> (bool, bool, bool) {
        store
            .with(|conn| {
                conn.query_row(
                    "SELECT claimed_at IS NOT NULL, delivered_at IS NOT NULL, disposed_at IS NOT NULL FROM mailbox WHERE id = ?1",
                    params![id],
                    |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
                )
            })
            .expect("state")
    }

    /// A report says whose it is and what it said, and nothing else: no
    /// boilerplate about turns, and no advice to wait on or read the session,
    /// since this letter is what a wait would have returned.
    #[test]
    fn a_report_is_headed_by_the_session_it_comes_from() {
        let from = BotRef { id: "c1".into(), name: "codex: fix".into(), kind: Some("session".into()) };
        let letter = Letter::new("p1", &from, "done: 3 files\n", REPORT, Some(4));
        let out = render(&letter, None);
        assert_eq!(out, "## Report from session codex: fix (c1)\n\ndone: 3 files");
        for advice in ["wait_for_session", "read_session", "send_message", "Its turn ended"] {
            assert!(!out.contains(advice), "{out}");
        }
    }

    /// A message from a session says how to reply to it, and no more.
    #[test]
    fn a_message_from_a_session_says_how_to_reply_and_not_to_wait() {
        let from = BotRef { id: "c1".into(), name: "codex: fix".into(), kind: Some("session".into()) };
        let out = render(&Letter::new("p1", &from, "a question about the API", MESSAGE, None), None);
        assert!(out.starts_with("## Message\nFrom: codex: fix (session c1), a model\nAt: "), "{out}");
        assert!(out.contains("Reply with `send_message` to `c1`"), "{out}");
        assert!(!out.contains("wait_for_session") && !out.contains("read_session"), "{out}");
    }

    #[test]
    fn a_batch_is_every_letter_waiting_oldest_first() {
        let store = store();
        let to = session(&store, "to");
        let child = child_of(&store, &to);
        report(&store, &to, &child, "one", 1);
        report(&store, &to, &child, "two", 2);
        enqueue(&store, &to, &child, "a message too").expect("enqueue");
        let batch = claim_batch(&store, &to, BATCH_CHARS).expect("claim");
        let texts: Vec<&str> = batch.iter().map(|letter| letter.text.as_str()).collect();
        assert_eq!(texts, ["one", "two", "a message too"]);
        assert_eq!(batch[0].kind, REPORT);
        assert_eq!(batch[0].event_cursor, Some(1));
        assert_eq!(batch[2].kind, MESSAGE);
        assert_eq!(waiting_count(&store, &to).expect("count"), 0);
        assert!(claim_batch(&store, &to, BATCH_CHARS).expect("again").is_empty());
    }

    /// The cap splits a box over turns, in order; a letter longer than the cap
    /// still goes, alone, rather than blocking the box for good.
    #[test]
    fn the_cap_leaves_the_rest_for_the_next_turn() {
        let store = store();
        let to = session(&store, "to");
        let from = session(&store, "from");
        let big = "x".repeat(8_000);
        for _ in 0..3 {
            enqueue(&store, &to, &sender(&from), &big).expect("enqueue");
        }
        enqueue(&store, &to, &sender(&from), &"y".repeat(30_000)).expect("enqueue");
        assert_eq!(claim_batch(&store, &to, BATCH_CHARS).expect("first").len(), 2);
        assert_eq!(waiting_count(&store, &to).expect("count"), 2);
        assert_eq!(claim_batch(&store, &to, BATCH_CHARS).expect("second").len(), 1);
        let huge = claim_batch(&store, &to, BATCH_CHARS).expect("third");
        assert_eq!(huge.len(), 1);
        assert!(huge[0].text.starts_with('y'));
    }

    /// Claimed is not delivered: a turn carries the letter until it ends. A
    /// daemon that stops first leaves it claimed, and opening the store again
    /// puts it back in the box; a delivered one stays delivered.
    #[test]
    fn a_letter_claimed_by_a_turn_that_never_ended_goes_back_in_the_box() {
        let dir = std::env::temp_dir().join(format!("crew-mailbox-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).expect("dir");
        let path = dir.join("crew.sqlite3");
        let (to, lost, done) = {
            let store = Store::open(path.clone()).expect("store");
            let to = session(&store, "to");
            let from = session(&store, "from");
            enqueue(&store, &to, &sender(&from), "lost").expect("enqueue");
            enqueue(&store, &to, &sender(&from), "done").expect("enqueue");
            let first = claim(&store, &to).expect("claim").expect("letter");
            let second = claim(&store, &to).expect("claim").expect("letter");
            delivered(&store, &[second.id.clone()]).expect("delivered");
            assert_eq!(state(&store, &first.id), (true, false, false));
            assert_eq!(state(&store, &second.id), (true, true, false));
            assert_eq!(waiting_count(&store, &to).expect("count"), 0);
            (to, first.id, second.id)
        };
        let store = Store::open(path).expect("reopen");
        assert_eq!(state(&store, &lost), (false, false, false));
        assert_eq!(state(&store, &done), (true, true, false));
        let back = waiting(&store, &to).expect("waiting");
        assert_eq!(back.iter().map(|letter| letter.text.as_str()).collect::<Vec<_>>(), ["lost"]);
    }

    /// A parent that read its child up to some point takes back the reports
    /// of what it read, and only those: a later report, and anything the
    /// child wrote it, still go over. Nothing is deleted.
    #[test]
    fn take_back_sets_aside_seen_reports_and_never_a_message() {
        let store = store();
        let parent = session(&store, "parent");
        let child = child_of(&store, &parent);
        let seen = report(&store, &parent, &child, "turn one", 3);
        let later = report(&store, &parent, &child, "turn two", 7);
        let message = enqueue(&store, &parent, &child, "which branch?").expect("enqueue");
        let asked = Letter::new(&parent, &child, "1. Which color?", QUESTION, Some(4));
        store.with(|conn| insert(conn, &asked)).expect("question");
        assert_eq!(take_back(&store, &parent, &child.id, 5).expect("take back"), 2);
        assert_eq!(state(&store, &seen.id), (false, false, true));
        assert_eq!(state(&store, &asked.id), (false, false, true));
        let left: Vec<String> = waiting(&store, &parent).expect("waiting").into_iter().map(|letter| letter.id).collect();
        assert_eq!(left, [later.id, message.id]);
    }

    /// An answered question no longer wakes the parent; a report still does.
    #[test]
    fn an_answered_question_is_set_aside() {
        let store = store();
        let parent = session(&store, "parent");
        let child = child_of(&store, &parent);
        let asked = Letter::new(&parent, &child, "1. Which color?", QUESTION, Some(4));
        store.with(|conn| insert(conn, &asked)).expect("question");
        let later = report(&store, &parent, &child, "done", 7);
        assert_eq!(dispose_questions(&store, &parent, &child.id).expect("dispose"), 1);
        let left: Vec<String> = waiting(&store, &parent).expect("waiting").into_iter().map(|letter| letter.id).collect();
        assert_eq!(left, [later.id]);
    }

    #[test]
    fn an_exited_reader_has_its_box_set_aside_not_deleted() {
        let store = store();
        let to = session(&store, "to");
        let from = session(&store, "from");
        let letter = enqueue(&store, &to, &sender(&from), "too late").expect("enqueue");
        assert_eq!(drop_waiting(&store, &to).expect("drop"), 1);
        assert_eq!(waiting_count(&store, &to).expect("count"), 0);
        assert_eq!(state(&store, &letter.id), (false, false, true));
    }

    #[test]
    fn deleting_the_reader_empties_its_box() {
        let store = store();
        let to = session(&store, "to");
        let from = session(&store, "from");
        enqueue(&store, &to, &sender(&from), "gone").expect("enqueue");
        crate::session::delete(&store, to.clone()).expect("delete");
        assert_eq!(waiting_count(&store, &to).expect("count"), 0);
    }

    /// Every change to a box is heard, for the window's queue: a letter in,
    /// handed to a turn, back, delivered, set aside. `pending` is that queue.
    #[test]
    fn every_change_to_a_box_is_heard() {
        let store = store();
        let heard = std::sync::Arc::new(std::sync::Mutex::new(Vec::<String>::new()));
        let log = heard.clone();
        store.set_listener(std::sync::Arc::new(move |what| {
            if let crate::store::Changed::Mailbox(id) = what {
                log.lock().unwrap().push(id.to_string());
            }
        }));
        let to = session(&store, "to");
        let from = session(&store, "from");
        let first = enqueue(&store, &to, &sender(&from), "one").expect("enqueue");
        let second = enqueue(&store, &to, &sender(&from), "two").expect("enqueue");
        let queue = pending(&store, &to).expect("pending");
        assert_eq!(queue.iter().map(|l| (l.text.as_str(), l.state.as_str())).collect::<Vec<_>>(), [("one", "pending"), ("two", "pending")]);
        assert_eq!(queue[0].from.id, from);
        claim(&store, &to).expect("claim");
        assert_eq!(pending(&store, &to).expect("pending")[0].state, "claimed");
        release(&store, &first.id).expect("release");
        claim_batch(&store, &to, BATCH_CHARS).expect("batch");
        delivered(&store, &[first.id.clone(), second.id.clone()]).expect("delivered");
        assert!(pending(&store, &to).expect("pending").is_empty());
        enqueue(&store, &to, &sender(&from), "three").expect("enqueue");
        drop_waiting(&store, &to).expect("drop");
        // Nothing to do is nothing heard.
        drop_waiting(&store, &to).expect("drop again");
        assert_eq!(heard.lock().unwrap().len(), 8);
        assert!(heard.lock().unwrap().iter().all(|id| id == &to));
    }

    fn texts(letters: &[Letter]) -> Vec<&str> {
        letters.iter().map(|letter| letter.text.as_str()).collect()
    }

    fn file(path: &str) -> AttachedFile {
        file_at(path)
    }

    /// The letters named go first, in the order given; the rest keep their
    /// places after them, and what comes in later comes in last.
    #[test]
    fn a_reorder_puts_the_named_letters_first_and_leaves_the_rest_in_place() {
        let store = store();
        let to = session(&store, "to");
        let ids: Vec<String> =
            ["a", "b", "c", "d"].iter().map(|text| enqueue(&store, &to, &user(), text).expect("enqueue").id).collect();
        reorder(&store, &to, &[ids[2].clone(), ids[0].clone(), "nope".into(), ids[2].clone()]).expect("reorder");
        assert_eq!(texts(&waiting(&store, &to).expect("waiting")), ["c", "a", "b", "d"]);
        enqueue(&store, &to, &user(), "e").expect("enqueue");
        reorder(&store, &to, &[ids[3].clone()]).expect("again");
        assert_eq!(texts(&waiting(&store, &to).expect("waiting")), ["d", "c", "a", "b", "e"]);
        let batch = claim_batch(&store, &to, BATCH_CHARS).expect("claim");
        assert_eq!(texts(&batch), ["d", "c", "a", "b", "e"], "a turn is handed the queue as it was put");
    }

    /// A claimed letter is not the user's to move, and one a turn gives back
    /// is where its time puts it among the letters nobody moved.
    #[test]
    fn a_letter_given_back_keeps_the_place_its_time_gives_it() {
        let store = store();
        let to = session(&store, "to");
        enqueue(&store, &to, &user(), "first").expect("enqueue");
        std::thread::sleep(std::time::Duration::from_millis(3));
        let second = record_claimed(&store, &to, &user(), "second").expect("claimed");
        std::thread::sleep(std::time::Duration::from_millis(3));
        enqueue(&store, &to, &user(), "third").expect("enqueue");
        reorder(&store, &to, std::slice::from_ref(&second.id)).expect("a claimed letter is not waiting, so it is not moved");
        release(&store, &second.id).expect("release");
        assert_eq!(texts(&waiting(&store, &to).expect("waiting")), ["first", "second", "third"]);
        send_first(&store, &to, &second.id).expect("send first");
        assert_eq!(texts(&waiting(&store, &to).expect("waiting")), ["second", "first", "third"]);
    }

    /// Files stay with their letter from the box to the turn, and the queue shows their paths.
    #[test]
    fn a_letter_keeps_its_files_from_the_box_to_the_turn() {
        let store = store();
        let to = session(&store, "to");
        let sent = enqueue_with_files(&store, &to, &user(), "look", vec![file("/tmp/a.md"), file("/tmp/b.png")], None).expect("enqueue");
        enqueue(&store, &to, &user(), "and no more").expect("enqueue");
        let queue = pending(&store, &to).expect("pending");
        assert_eq!(queue[0].files, Some(vec!["/tmp/a.md".to_string(), "/tmp/b.png".to_string()]));
        assert_eq!((queue[0].queue.as_str(), queue[1].files.clone()), ("waiting", None));
        let batch = claim_batch(&store, &to, BATCH_CHARS).expect("claim");
        assert_eq!(batch[0], Letter { files: vec![file("/tmp/a.md"), file("/tmp/b.png")], ..sent });
        assert!(batch[1].files.is_empty());
        assert_eq!(pending(&store, &to).expect("pending")[0].queue, "steering", "claimed, not read");
    }

    fn dispatch(command: Option<&str>, skills: &[&str]) -> Option<Dispatch> {
        Dispatch::of(command, Some(&skills.iter().map(|skill| skill.to_string()).collect::<Vec<_>>()))
    }

    /// A message that asks for nothing has no dispatch at all, so a letter
    /// stored before the column existed and one without a command read alike.
    #[test]
    fn a_message_with_no_command_or_skills_has_no_dispatch() {
        assert_eq!(Dispatch::of(None, None), None);
        assert_eq!(Dispatch::of(Some("  "), Some(&[])), None);
        assert_eq!(dispatch(Some("compact"), &[]), Some(Dispatch { command: Some("compact".into()), skills: Vec::new() }));
    }

    /// The command and skills the user picked stay with their letter from the
    /// box to the turn, whether it waited or was claimed on arrival.
    #[test]
    fn a_letter_keeps_its_command_and_skills_from_the_box_to_the_turn() {
        let store = store();
        let to = session(&store, "to");
        let waits = enqueue_with_files(&store, &to, &user(), "/review main", Vec::new(), dispatch(Some("review"), &[])).expect("enqueue");
        let skilled = enqueue_with_files(&store, &to, &user(), "use /lint here", Vec::new(), dispatch(None, &["lint"])).expect("enqueue");
        let batch = claim_batch(&store, &to, BATCH_CHARS).expect("claim");
        assert_eq!(batch, vec![waits]);
        assert_eq!(claim_batch(&store, &to, BATCH_CHARS).expect("next"), vec![skilled]);
        let direct = record_claimed_with_files(&store, &to, &user(), "/goal ship it", Vec::new(), dispatch(Some("goal"), &[])).expect("claimed");
        release(&store, &direct.id).expect("release");
        assert_eq!(claim_batch(&store, &to, BATCH_CHARS).expect("again")[0].dispatch, dispatch(Some("goal"), &[]));
    }

    /// A letter with a command is a turn of its own: the letters before it
    /// leave in a batch without it, and the letters after it do not become its
    /// arguments.
    #[test]
    fn a_command_goes_in_a_batch_of_its_own() {
        let store = store();
        let to = session(&store, "to");
        for text in ["one", "two"] {
            enqueue(&store, &to, &user(), text).expect("enqueue");
        }
        enqueue_with_files(&store, &to, &user(), "/compact", Vec::new(), dispatch(Some("compact"), &[])).expect("enqueue");
        for text in ["three", "four"] {
            enqueue(&store, &to, &user(), text).expect("enqueue");
        }
        let batches: Vec<Vec<String>> = (0..3)
            .map(|_| claim_batch(&store, &to, BATCH_CHARS).expect("claim").into_iter().map(|letter| letter.text).collect())
            .collect();
        assert_eq!(batches, [vec!["one", "two"], vec!["/compact"], vec!["three", "four"]]);
        assert!(claim_batch(&store, &to, BATCH_CHARS).expect("empty").is_empty());
    }

    /// Two commands in a row are two turns, and a command first in the box
    /// still leaves the next letter for the turn after it.
    #[test]
    fn a_command_first_in_the_box_does_not_take_the_next_letter_with_it() {
        let store = store();
        let to = session(&store, "to");
        enqueue_with_files(&store, &to, &user(), "/compact", Vec::new(), dispatch(Some("compact"), &[])).expect("enqueue");
        enqueue_with_files(&store, &to, &user(), "/review", Vec::new(), dispatch(Some("review"), &[])).expect("enqueue");
        enqueue(&store, &to, &user(), "after").expect("enqueue");
        let sizes: Vec<usize> = (0..3).map(|_| claim_batch(&store, &to, BATCH_CHARS).expect("claim").len()).collect();
        assert_eq!(sizes, [1, 1, 1]);
    }

    /// A skill alone joins the letters around it: it is text the model reads
    /// with the rest.
    #[test]
    fn a_letter_with_only_skills_joins_a_batch() {
        let store = store();
        let to = session(&store, "to");
        enqueue(&store, &to, &user(), "one").expect("enqueue");
        enqueue_with_files(&store, &to, &user(), "/lint two", Vec::new(), dispatch(None, &["lint"])).expect("enqueue");
        assert_eq!(claim_batch(&store, &to, BATCH_CHARS).expect("claim").len(), 2);
    }

    /// An edit that no longer opens with the command, or no longer names a
    /// skill, takes it from the letter: the text is what is sent.
    #[test]
    fn an_edit_keeps_only_the_command_and_skills_the_text_still_names() {
        let store = store();
        let to = session(&store, "to");
        let both = || dispatch(Some("review"), &["lint"]);
        let skill_gone = enqueue_with_files(&store, &to, &user(), "/review /lint main", Vec::new(), both()).expect("enqueue");
        let command_gone = enqueue_with_files(&store, &to, &user(), "/review /lint main", Vec::new(), both()).expect("enqueue");
        let both_gone = enqueue_with_files(&store, &to, &user(), "/review /lint main", Vec::new(), both()).expect("enqueue");
        edit(&store, &to, &skill_gone.id, "/review the lint changes", None).expect("edit");
        edit(&store, &to, &command_gone.id, "please run /lint now", None).expect("edit");
        edit(&store, &to, &both_gone.id, "just words", None).expect("edit");
        let kept: Vec<Option<Dispatch>> = waiting(&store, &to).expect("waiting").into_iter().map(|letter| letter.dispatch).collect();
        assert_eq!(kept, [dispatch(Some("review"), &[]), dispatch(None, &["lint"]), None]);
    }

    /// The user changes what they wrote while it waits; a turn that took it is past that.
    #[test]
    fn an_edit_changes_a_waiting_letter_and_is_refused_once_it_is_claimed() {
        let store = store();
        let to = session(&store, "to");
        let from = session(&store, "from");
        let mine = enqueue_with_files(&store, &to, &user(), "draft", vec![file("/tmp/a.md")], None).expect("enqueue");
        edit(&store, &to, &mine.id, "better", None).expect("edit the text alone");
        edit(&store, &to, &mine.id, "best", Some(vec!["/tmp/a.md".into(), "/tmp/c.md".into()])).expect("edit both");
        let queue = pending(&store, &to).expect("pending");
        assert_eq!((queue[0].text.as_str(), queue[0].files.clone()), ("best", Some(vec!["/tmp/a.md".into(), "/tmp/c.md".into()])));
        edit(&store, &to, &mine.id, "text only", Some(Vec::new())).expect("clear the files");
        assert_eq!(pending(&store, &to).expect("pending")[0].files, None);
        assert!(edit(&store, &to, &mine.id, " ", None).expect_err("empty").contains("some text or a file"));

        let theirs = enqueue(&store, &to, &sender(&from), "from a bot").expect("enqueue");
        assert!(edit(&store, &to, &theirs.id, "mine now", None).expect_err("bot's").contains("Only a message you wrote"));
        assert!(edit(&store, &from, &mine.id, "x", None).expect_err("other box").contains("not in this session's queue"));

        claim_batch(&store, &to, BATCH_CHARS).expect("claim");
        let refused = edit(&store, &to, &mine.id, "too late", None).expect_err("claimed");
        assert!(refused.contains("running turn already took"), "{refused}");
        assert_eq!(texts(&claim_batch(&store, &to, BATCH_CHARS).expect("empty")), Vec::<&str>::new());
    }

    /// Dropping a letter is hearing about it too, like every change to the box.
    #[test]
    fn disposing_and_reordering_a_queue_are_heard() {
        let store = store();
        let to = session(&store, "to");
        let ids: Vec<String> = ["a", "b"].iter().map(|text| enqueue(&store, &to, &user(), text).expect("enqueue").id).collect();
        let heard = std::sync::Arc::new(std::sync::Mutex::new(0));
        let count = heard.clone();
        store.set_listener(std::sync::Arc::new(move |what| {
            if matches!(what, crate::store::Changed::Mailbox(_)) {
                *count.lock().unwrap() += 1;
            }
        }));
        reorder(&store, &to, &[ids[1].clone()]).expect("reorder");
        edit(&store, &to, &ids[0], "a again", None).expect("edit");
        dispose_users(&store, &to, &ids[1]).expect("dispose");
        // Nothing moved is nothing heard.
        reorder(&store, &to, &["nope".into()]).expect("reorder");
        assert_eq!(*heard.lock().unwrap(), 3);
        assert_eq!(texts(&waiting(&store, &to).expect("waiting")), ["a again"]);
    }
}
