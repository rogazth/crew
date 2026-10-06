//! Messages between bots.
//!
//! A bot never calls another one. It drops a letter here; the daemon hands
//! it to the target as a user turn with the sender's name on it, and the reply
//! comes back the same way. Nothing blocks: if the target is mid-turn the
//! letter waits, and a turn that ends drains the box.
//!
//! Blocking would deadlock the obvious case — two bots that message each
//! other — so `message_agent` answers "delivered" and never waits for a reply.
//!
//! A child session's report reaches the bot that started it the same way, as
//! a `report` letter: that is what wakes the bot, so it never has to wait.
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
/// A child asks its parent something. Not written yet: a child that stops to
/// ask still sends a `report`.
pub const QUESTION: &str = "question";

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
    /// [`MESSAGE`], [`REPORT`] or [`QUESTION`].
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

/// The header a letter is handed over under.
///
/// A letter arrives as a user turn — the same shape as something the person
/// typed — so the header is what tells them apart. It carries facts and no
/// instructions: who wrote it, the id they are reached at, and when they wrote
/// it. What to do about it is the bot's to decide, with the tool sheet in
/// the persona and the tail above.
///
/// The id and not the name, because the name is the user's: they rename a
/// bot and a reply addressed to the old one reaches nobody. A sender that
/// has been deleted since has no id left (`ON DELETE SET NULL`), and saying so
/// is better than offering an address that is not one.
///
/// The two senders that are not bots are said so, with what that means for
/// a reply: the envelope is the only place the bot learns it, and a bot
/// that answers a terminal with `message_agent` is told "no bot" and guesses.
pub fn envelope(from: &BotRef, body: &str, at: i64, to_self: bool) -> String {
    let who = if to_self {
        "yourself, to continue".to_string()
    } else if from.kind.as_deref() == Some("user") {
        "the user, from the crew command line. They read your reply here, in this chat.".to_string()
    } else if from.kind.as_deref() == Some("terminal") {
        format!(
            "{} (terminal session {}). It cannot receive a reply: message_agent does not reach it, \
             and what you write here is read by the user, not by it.",
            from.name, from.id
        )
    } else if from.kind.as_deref() == Some("session") {
        format!(
            "{} (session {}). A session is a provider CLI Crew runs, not a bot: message_agent does \
             not reach it. If you started it, send_to_session does.",
            from.name, from.id
        )
    } else if from.id.is_empty() {
        format!("{} (bot, no longer in this workspace)", from.name)
    } else {
        format!("{} (bot {})", from.name, from.id)
    };
    format!("## Message\nFrom: {who}\nAt: {}\n\n{body}", stamp(at))
}

/// The header a child's report is handed over under: whose it is, then what
/// it said. Nothing about what to do next; above all, nothing that sends the
/// bot to wait on the session, since this letter is what a wait would return.
pub fn report_envelope(from: &BotRef, body: &str) -> String {
    let who = if from.id.is_empty() {
        format!("{} (no longer in this workspace)", from.name)
    } else {
        format!("{} ({})", from.name, from.id)
    };
    format!("## Report from session {who}\n\n{}", body.trim())
}

/// A letter as the model reads it, by its kind.
pub fn render(letter: &Letter) -> String {
    if letter.is_report() || letter.kind == QUESTION {
        report_envelope(&letter.from, &letter.text)
    } else {
        envelope(&letter.from, &letter.text, letter.at, letter.from.id == letter.to_session)
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
    let letter = Letter::new(to_session, from, text, MESSAGE, None);
    store.with(|conn| insert(conn, &letter))?;
    Ok(letter)
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
}

/// Claim what one turn is handed: every waiting letter, oldest first, until
/// their text passes `cap` characters (the first is taken whatever its size).
///
/// A note a bot left itself (`continue_after_turn`) goes alone, and ends a
/// batch: it is a turn of its own, and the lap budget counts those.
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
            let to_self = letter.from.id == to_session;
            let size = letter.text.chars().count();
            if !batch.is_empty() && (to_self || spent + size > cap) {
                break;
            }
            spent += size;
            batch.push(letter);
            if to_self {
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
}

/// Put a claimed letter back, for a delivery that could not go through. It
/// keeps its original `at`, so it stays at the head of the queue.
pub fn release(store: &Store, id: &str) -> Result<(), String> {
    store.with(|conn| {
        conn.prepare_cached("UPDATE mailbox SET claimed_at = NULL WHERE id = ?1 AND delivered_at IS NULL")?
            .execute(params![id])
    })?;
    Ok(())
}

/// The turn that carried these letters has ended: they are delivered.
pub fn delivered(store: &Store, ids: &[String]) -> Result<(), String> {
    if ids.is_empty() {
        return Ok(());
    }
    store.with(|conn| {
        let now = now_millis();
        for id in ids {
            conn.prepare_cached("UPDATE mailbox SET delivered_at = ?2 WHERE id = ?1 AND delivered_at IS NULL")?
                .execute(params![id, now])?;
        }
        Ok(())
    })
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
    store.with(|conn| {
        conn.prepare_cached(
            "UPDATE mailbox SET disposed_at = ?2
              WHERE to_session = ?1 AND delivered_at IS NULL AND disposed_at IS NULL",
        )?
        .execute(params![to_session, now_millis()])
    })
}

/// Take back the reports a child left in its parent's box that the parent has
/// since read some other way: a wait or a read showed it the session up to
/// `seen`. Only reports, and only those at or below that cursor: a message the
/// child wrote, or a later turn's report, still has to be handed over.
pub fn take_back(store: &Store, to_session: &str, from_session: &str, seen: i64) -> Result<usize, String> {
    store.with(|conn| {
        conn.prepare_cached(&format!(
            "UPDATE mailbox SET disposed_at = ?4
              WHERE to_session = ?1 AND from_session = ?2 AND kind = 'report'
                AND event_cursor IS NOT NULL AND event_cursor <= ?3 AND {PENDING}"
        ))?
        .execute(params![to_session, from_session, seen, now_millis()])
    })
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
        let letter = envelope(&sender("s1"), "the branch is green", 0, false);
        assert!(letter.starts_with("## Message\nFrom: Coder (bot s1)\nAt: "), "{letter}");
        assert!(letter.ends_with("\n\nthe branch is green"), "{letter}");
    }

    /// The time it was written, not the time it was handed over: a letter that
    /// waited an hour in a busy bot's box still says when it was written.
    #[test]
    fn the_envelope_says_when_it_was_written() {
        let at = crate::store::now_millis() - 3_600_000;
        let letter = envelope(&sender("s1"), "hi", at, false);
        assert!(letter.contains(&format!("At: {}", crate::store::stamp(at))), "{letter}");
    }

    /// A sender that was deleted leaves a name and no address. Offering the
    /// empty id would be offering a reply that goes nowhere.
    #[test]
    fn a_deleted_sender_is_named_without_an_address() {
        let letter = envelope(&BotRef::bot("", "Coder"), "hi", 0, false);
        assert!(letter.contains("Coder (bot, no longer in this workspace)"), "{letter}");
    }

    /// A note a bot left itself is not the user either, and saying who wrote
    /// it is the whole point: "Coder (bot)" in your own transcript reads like
    /// somebody else.
    #[test]
    fn a_note_to_yourself_says_so() {
        let letter = envelope(&sender("s1"), "next: run the tests", 0, true);
        assert!(letter.contains("From: yourself, to continue"), "{letter}");
        assert!(letter.ends_with("next: run the tests"), "{letter}");
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
        let out = render(&letter);
        assert_eq!(out, "## Report from session codex: fix (c1)\n\ndone: 3 files");
        for advice in ["wait_for_session", "read_session", "respond_to_session", "send_to_session", "Its turn ended"] {
            assert!(!out.contains(advice), "{out}");
        }
    }

    /// A message from a session says how to reply to it, and no more.
    #[test]
    fn a_message_from_a_session_says_how_to_reply_and_not_to_wait() {
        let from = BotRef { id: "c1".into(), name: "codex: fix".into(), kind: Some("session".into()) };
        let out = render(&Letter::new("p1", &from, "a question about the API", MESSAGE, None));
        assert!(out.starts_with("## Message\nFrom: codex: fix (session c1)."), "{out}");
        assert!(out.contains("send_to_session does"), "{out}");
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

    /// A note a bot left itself is a turn of its own: the lap budget counts them.
    #[test]
    fn a_note_to_yourself_is_not_batched() {
        let store = store();
        let to = session(&store, "to");
        let from = session(&store, "from");
        enqueue(&store, &to, &sender(&from), "first").expect("enqueue");
        enqueue(&store, &to, &sender(&to), "note").expect("enqueue");
        enqueue(&store, &to, &sender(&from), "last").expect("enqueue");
        let texts = |batch: Vec<Letter>| batch.into_iter().map(|letter| letter.text).collect::<Vec<_>>();
        assert_eq!(texts(claim_batch(&store, &to, BATCH_CHARS).unwrap()), ["first"]);
        assert_eq!(texts(claim_batch(&store, &to, BATCH_CHARS).unwrap()), ["note"]);
        assert_eq!(texts(claim_batch(&store, &to, BATCH_CHARS).unwrap()), ["last"]);
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
        assert_eq!(take_back(&store, &parent, &child.id, 5).expect("take back"), 1);
        assert_eq!(state(&store, &seen.id), (false, false, true));
        let left: Vec<String> = waiting(&store, &parent).expect("waiting").into_iter().map(|letter| letter.id).collect();
        assert_eq!(left, [later.id, message.id]);
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
}
