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

use crew_protocol::BotRef;
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

/// A letter nobody has been handed yet.
const PENDING: &str = "claimed_at IS NULL AND delivered_at IS NULL AND disposed_at IS NULL";

/// The header a message is handed over under.
///
/// A letter arrives as a user turn — the same shape as something the person
/// typed — so the header is what tells them apart: who wrote it, the id they
/// are reached at, when (for a letter that waited in the box), and how to
/// answer.
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
        ("you (the user, from the crew command line)".to_string(), "They read your reply here.".to_string())
    } else if from.id.is_empty() {
        (format!("{} ({kind}, no longer in this workspace)", from.name), String::new())
    } else if parent == Some(from.id.as_str()) {
        (
            format!("{} ({kind} {})", from.name, from.id),
            "It started you: your report at the end of this turn reaches it.".to_string(),
        )
    } else if kind == "terminal" {
        (
            format!("{} (terminal {})", from.name, from.id),
            "A terminal cannot be written to: what you write here is read by the user, not by it.".to_string(),
        )
    } else {
        (format!("{} ({kind} {})", from.name, from.id), format!("Reply with send_message to {}.", from.id))
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
        "INSERT INTO mailbox (id, to_session, from_session, from_name, text, at, from_kind, kind, event_cursor)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
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
        letter.event_cursor
    ])?;
    Ok(())
}

/// Drop a message in a box.
pub fn enqueue(store: &Store, to_session: &str, from: &BotRef, text: &str) -> Result<Letter, String> {
    put(store, Letter::new(to_session, from, text, MESSAGE, None))
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
    let letter = Letter::new(to_session, from, text, MESSAGE, None);
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

const SELECT: &str =
    "SELECT id, to_session, from_session, from_name, text, at, from_kind, kind, event_cursor FROM mailbox";
const RETURNING: &str =
    "RETURNING id, to_session, from_session, from_name, text, at, from_kind, kind, event_cursor";

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
    })
}

/// Everything still waiting for one bot, oldest first.
pub fn waiting(store: &Store, to_session: &str) -> Result<Vec<Letter>, String> {
    store.with(|conn| {
        let mut stmt = conn.prepare_cached(&format!(
            "{SELECT} WHERE to_session = ?1 AND {PENDING} ORDER BY at ASC, rowid ASC"
        ))?;
        let rows = stmt.query_map(params![to_session], row_to_letter)?;
        rows.collect()
    })
}

/// Claim the oldest waiting letter alone, for a hand-over that takes one: a
/// terminal's opening prompt. Claiming in the same statement that picks it is
/// what keeps two callers from handing the same letter over twice.
pub fn claim(store: &Store, to_session: &str) -> Result<Option<Letter>, String> {
    store.with(|conn| {
        conn.prepare_cached(&format!(
            "UPDATE mailbox SET claimed_at = ?2
             WHERE id = (
               SELECT id FROM mailbox
               WHERE to_session = ?1 AND {PENDING}
               -- Two letters can share a millisecond; the rowid breaks the tie
               -- so the order out is the order in.
               ORDER BY at ASC, rowid ASC LIMIT 1
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

/// Claim what one turn is handed: every waiting letter, oldest first, until
/// their text passes `cap` characters (the first is taken whatever its size).
pub fn claim_batch(store: &Store, to_session: &str, cap: usize) -> Result<Vec<Letter>, String> {
    store.with(|conn| {
        let tx = conn.unchecked_transaction()?;
        let pending: Vec<Letter> = tx
            .prepare_cached(&format!(
                "{SELECT} WHERE to_session = ?1 AND {PENDING} ORDER BY at ASC, rowid ASC"
            ))?
            .query_map(params![to_session], row_to_letter)?
            .collect::<rusqlite::Result<_>>()?;
        let mut batch: Vec<Letter> = Vec::new();
        let mut spent = 0;
        for letter in pending {
            let size = letter.text.chars().count();
            if !batch.is_empty() && spent + size > cap {
                break;
            }
            spent += size;
            batch.push(letter);
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
        m.rowid
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
            state: row.get(10)?,
        },
        row.get(11)?,
    ))
}

/// What waits in a session's box and what a turn has taken but not finished,
/// oldest first: the queue its chat shows. A claimed letter may already be in
/// the transcript (the turn carrying it put it there); the block's
/// `letterId` says which.
pub fn pending(store: &Store, to_session: &str) -> Result<Vec<crew_protocol::ThreadLetter>, String> {
    store.with(|conn| {
        conn.prepare_cached(&format!(
            "{THREAD_SELECT} WHERE m.to_session = ?1 AND m.delivered_at IS NULL AND m.disposed_at IS NULL
              ORDER BY m.at ASC, m.rowid ASC"
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
    // One entry per pair, keyed by its two parties in order: the newest letter
    // and how many there are.
    let mut by_pair: std::collections::HashMap<(String, String), (crew_protocol::ThreadLetter, i64, i64)> =
        std::collections::HashMap::new();
    for (letter, rowid) in letters {
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
        assert_eq!(letter, "## Message\nFrom: Coder (bot s1)\nReply with send_message to s1.\n\nthe branch is green");
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

    /// Each kind of sender says what a reply can do: a terminal cannot be
    /// written to, the user reads the chat, and a session's own parent reads
    /// its report.
    #[test]
    fn the_envelope_says_how_to_answer_each_kind_of_sender() {
        let terminal = BotRef { id: "t1".into(), name: "shell".into(), kind: Some("terminal".into()) };
        let out = envelope(&terminal, "hi", None, None);
        assert!(out.starts_with("## Message\nFrom: shell (terminal t1)\nA terminal cannot be written to"), "{out}");
        let user = BotRef { id: String::new(), name: "You".into(), kind: Some("user".into()) };
        assert!(envelope(&user, "hi", None, None).contains("From: you (the user"), "user");
        let session = BotRef { id: "c1".into(), name: "codex: fix".into(), kind: Some("session".into()) };
        assert!(envelope(&session, "hi", None, None).contains("From: codex: fix (session c1)\nReply with send_message to c1."));
        let parent = envelope(&sender("p1"), "more", None, Some("p1"));
        assert!(parent.contains("your report at the end of this turn reaches it") && !parent.contains("Reply with"), "{parent}");
        let shell = envelope(&terminal, "the job", None, Some("t1"));
        assert!(shell.contains("your report at the end of this turn reaches it") && !shell.contains("cannot be written"), "{shell}");
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
        assert!(out.starts_with("## Message\nFrom: codex: fix (session c1)\nAt: "), "{out}");
        assert!(out.contains("Reply with send_message to c1."), "{out}");
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
}
