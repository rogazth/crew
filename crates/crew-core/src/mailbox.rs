//! Messages between agents.
//!
//! An agent never calls another one. It drops a letter here; the daemon hands
//! it to the target as a user turn with the sender's name on it, and the reply
//! comes back the same way. Nothing blocks: if the target is mid-turn the
//! letter waits, and a turn that ends drains the box.
//!
//! Blocking would deadlock the obvious case — two agents that message each
//! other — so `message_agent` answers "delivered" and never waits for a reply.

use crew_protocol::AgentRef;
use rusqlite::{params, OptionalExtension};
use serde::{Deserialize, Serialize};

use crate::store::{now_millis, stamp, Store};

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
pub struct Letter {
    pub id: String,
    pub to_session: String,
    pub from: AgentRef,
    pub text: String,
    pub at: i64,
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

-- Reading the box is "what is still waiting for this agent", so the index
-- covers exactly that.
CREATE INDEX IF NOT EXISTS mailbox_waiting_idx
  ON mailbox (to_session, at) WHERE delivered_at IS NULL;
"#;

/// The header a letter is handed over under.
///
/// A letter arrives as a user turn — the same shape as something the person
/// typed — so the header is what tells them apart. It carries facts and no
/// instructions: who wrote it, the id they are reached at, and when they wrote
/// it. What to do about it is the agent's to decide, with the tool sheet in
/// the persona and the tail above.
///
/// The id and not the name, because the name is the user's: they rename an
/// agent and a reply addressed to the old one reaches nobody. A sender that
/// has been deleted since has no id left (`ON DELETE SET NULL`), and saying so
/// is better than offering an address that is not one.
pub fn envelope(from: &AgentRef, body: &str, at: i64, to_self: bool) -> String {
    let who = if to_self {
        "yourself, to continue".to_string()
    } else if from.id.is_empty() {
        format!("{} (agent, no longer in this workspace)", from.name)
    } else {
        format!("{} (agent {})", from.name, from.id)
    };
    format!("## Message\nFrom: {who}\nAt: {}\n\n{body}", stamp(at))
}

pub fn enqueue(store: &Store, to_session: &str, from: &AgentRef, text: &str) -> Result<Letter, String> {
    let letter = Letter {
        id: uuid::Uuid::new_v4().to_string(),
        to_session: to_session.to_string(),
        from: from.clone(),
        text: text.to_string(),
        at: now_millis(),
    };
    store.with(|conn| {
        conn.prepare_cached(
            "INSERT INTO mailbox (id, to_session, from_session, from_name, text, at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
        )?
        .execute(params![
            letter.id,
            letter.to_session,
            letter.from.id,
            letter.from.name,
            letter.text,
            letter.at
        ])
    })?;
    Ok(letter)
}

const SELECT: &str = "SELECT id, to_session, from_session, from_name, text, at FROM mailbox";

fn row_to_letter(row: &rusqlite::Row) -> rusqlite::Result<Letter> {
    Ok(Letter {
        id: row.get(0)?,
        to_session: row.get(1)?,
        from: AgentRef {
            // The sender may have been deleted since; its name is what the
            // transcript needs, and that was copied in at send time.
            id: row.get::<_, Option<String>>(2)?.unwrap_or_default(),
            name: row.get(3)?,
        },
        text: row.get(4)?,
        at: row.get(5)?,
    })
}

/// Everything still waiting for one agent, oldest first.
pub fn waiting(store: &Store, to_session: &str) -> Result<Vec<Letter>, String> {
    store.with(|conn| {
        let mut stmt = conn.prepare_cached(&format!(
            "{SELECT} WHERE to_session = ?1 AND delivered_at IS NULL ORDER BY at ASC, rowid ASC"
        ))?;
        let rows = stmt.query_map(params![to_session], row_to_letter)?;
        rows.collect()
    })
}

/// Claim the oldest waiting letter. Marking it delivered inside the same
/// statement is what keeps two drains from handing the same letter over twice.
pub fn claim(store: &Store, to_session: &str) -> Result<Option<Letter>, String> {
    store.with(|conn| {
        conn.prepare_cached(
            "UPDATE mailbox SET delivered_at = ?2
             WHERE id = (
               SELECT id FROM mailbox
               WHERE to_session = ?1 AND delivered_at IS NULL
               -- Two letters can share a millisecond; the rowid breaks the tie
               -- so the order out is the order in.
               ORDER BY at ASC, rowid ASC LIMIT 1
             )
             RETURNING id, to_session, from_session, from_name, text, at",
        )?
        .query_row(params![to_session, now_millis()], row_to_letter)
        .optional()
    })
}

/// Put a claimed letter back, for a delivery that could not go through. It
/// keeps its original `at`, so it stays at the head of the queue.
pub fn release(store: &Store, id: &str) -> Result<(), String> {
    store.with(|conn| {
        conn.prepare_cached("UPDATE mailbox SET delivered_at = NULL WHERE id = ?1")?
            .execute(params![id])
    })?;
    Ok(())
}

/// How many letters are waiting. The sidebar shows it; the tool answers with it
/// so the sender knows its message landed in a queue rather than in a turn.
pub fn waiting_count(store: &Store, to_session: &str) -> Result<i64, String> {
    store.with(|conn| {
        conn.prepare_cached(
            "SELECT COUNT(*) FROM mailbox WHERE to_session = ?1 AND delivered_at IS NULL",
        )?
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
            "agent".into(),
            name.into(),
            "claude".into(),
            "m".into(),
            "".into(),
            "ask".into(),
        )
        .expect("session")
        .id
    }

    fn sender(id: &str) -> AgentRef {
        AgentRef { id: id.to_string(), name: "Coder".into() }
    }

    #[test]
    fn the_envelope_carries_the_id_the_sender_is_reached_at() {
        let letter = envelope(&sender("s1"), "the branch is green", 0, false);
        assert!(letter.starts_with("## Message\nFrom: Coder (agent s1)\nAt: "), "{letter}");
        assert!(letter.ends_with("\n\nthe branch is green"), "{letter}");
    }

    /// The time it was written, not the time it was handed over: a letter that
    /// waited an hour in a busy agent's box still says when it was written.
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
        let letter = envelope(&AgentRef { id: String::new(), name: "Coder".into() }, "hi", 0, false);
        assert!(letter.contains("Coder (agent, no longer in this workspace)"), "{letter}");
    }

    /// A note an agent left itself is not the user either, and saying who wrote
    /// it is the whole point: "Coder (agent)" in your own transcript reads like
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
    fn a_box_belongs_to_one_agent() {
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
