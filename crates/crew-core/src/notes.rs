//! A bot's notes: what it keeps for later turns, apart from its description.
//!
//! The description is who the bot is and its standing rules; the user reads it
//! in the bot sheet. Bots used to write everything there (ids, prices, what
//! they were allowed, how far a job had got) because nothing else outlived a
//! turn. Notes are that notebook: short entries, a hard cap so the bot has to
//! keep them tidy, and the whole of them in front of it every turn.
//!
//! Entries are stored as one text, separated by a line holding only `§`.

use rusqlite::{params, OptionalExtension};

use crate::store::{now_millis, Store};

/// The most the notes may hold, in characters, separators included.
pub const CAP: usize = 4_000;

/// Between two entries, stored and shown.
pub const SEPARATOR: &str = "\n§\n";

pub const MIGRATION_V40: &str = "
CREATE TABLE IF NOT EXISTS bot_notes (
  session_id TEXT PRIMARY KEY REFERENCES sessions(id) ON DELETE CASCADE,
  body       TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);
";

/// A bot's entries, oldest first.
pub fn get(store: &Store, session_id: &str) -> Result<Vec<String>, String> {
    let body: Option<String> = store.with(|conn| {
        conn.query_row("SELECT body FROM bot_notes WHERE session_id = ?1", params![session_id], |row| row.get(0)).optional()
    })?;
    Ok(body.map(|body| split(&body)).unwrap_or_default())
}

/// Replace a bot's entries with `entries`, tidied (see [`tidy`]). Refused
/// over the cap, saying by how much.
pub fn set(store: &Store, session_id: &str, entries: Vec<String>) -> Result<Vec<String>, String> {
    let entries = tidy(entries);
    let used = used(&entries);
    if used > CAP {
        return Err(format!("Notes hold at most {} characters; these are {}.", thousands(CAP), thousands(used)));
    }
    store.with(|conn| {
        conn.execute(
            "INSERT INTO bot_notes (session_id, body, updated_at) VALUES (?1, ?2, ?3)
             ON CONFLICT(session_id) DO UPDATE SET body = excluded.body, updated_at = excluded.updated_at",
            params![session_id, entries.join(SEPARATOR), now_millis()],
        )
    })?;
    Ok(entries)
}

/// Each entry trimmed, the empty ones and repeats dropped, and one that holds
/// a separator split there: what is stored is what reads back.
pub fn tidy(entries: Vec<String>) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    for entry in entries.iter().flat_map(|entry| split(entry)) {
        if !out.contains(&entry) {
            out.push(entry);
        }
    }
    out
}

fn split(body: &str) -> Vec<String> {
    body.lines()
        .collect::<Vec<_>>()
        .split(|line| line.trim() == "§")
        .map(|lines| lines.join("\n").trim().to_string())
        .filter(|entry| !entry.is_empty())
        .collect()
}

/// Characters the entries take, as stored.
pub fn used(entries: &[String]) -> usize {
    entries.iter().map(|entry| entry.chars().count()).sum::<usize>() + SEPARATOR.chars().count() * entries.len().saturating_sub(1)
}

/// `[62% - 2,480/4,000]`: how full the notes are.
pub fn usage(entries: &[String]) -> String {
    let used = used(entries);
    format!("[{}% - {}/{}]", used * 100 / CAP, thousands(used), thousands(CAP))
}

pub fn thousands(n: usize) -> String {
    let digits = n.to_string();
    let mut out = String::new();
    for (index, digit) in digits.chars().enumerate() {
        if index > 0 && (digits.len() - index) % 3 == 0 {
            out.push(',');
        }
        out.push(digit);
    }
    out
}

/// What a write to the notes does, as `memory` takes it.
pub enum Edit<'a> {
    Add(&'a str),
    /// The one entry holding `old` becomes `new`.
    Patch {
        old: &'a str,
        new: &'a str,
    },
    Remove(&'a str),
}

/// Why a write was refused, said so the bot can fix it in one more call.
#[derive(Debug, PartialEq, Eq)]
pub enum Refused {
    /// Missing or ambiguous arguments, or nothing to match.
    Asked(String),
    /// Over the cap: the bot has to make room first.
    Full { needed: usize },
}

/// `entries` with `edit` applied. An exact repeat of an entry is not added
/// again (and is not an error).
pub fn apply(entries: &[String], edit: Edit) -> Result<Vec<String>, Refused> {
    let mut next = entries.to_vec();
    match edit {
        Edit::Add(content) => {
            let content = content.trim();
            if content.is_empty() {
                return Err(Refused::Asked("content is required: the entry to add.".into()));
            }
            if !next.iter().any(|entry| entry == content) {
                next.push(content.to_string());
            }
        }
        Edit::Patch { old, new } => {
            let new = new.trim();
            if new.is_empty() {
                return Err(Refused::Asked("content is required: what the entry becomes. To drop it, remove it.".into()));
            }
            let at = one(entries, old)?;
            next[at] = new.to_string();
        }
        Edit::Remove(old) => {
            let at = one(entries, old)?;
            next.remove(at);
        }
    }
    let next = tidy(next);
    let used = used(&next);
    if used > CAP {
        return Err(Refused::Full { needed: used - CAP });
    }
    Ok(next)
}

/// The one entry that holds `old`.
fn one(entries: &[String], old: &str) -> Result<usize, Refused> {
    if old.trim().is_empty() {
        return Err(Refused::Asked("old_text is required: a piece of the entry, enough to tell it from the others.".into()));
    }
    let found: Vec<usize> = (0..entries.len()).filter(|at| entries[*at].contains(old.trim())).collect();
    match found.as_slice() {
        [one] => Ok(*one),
        [] => Err(Refused::Asked(format!("No entry holds \"{}\".", old.trim()))),
        many => Err(Refused::Asked(format!(
            "{} entries hold \"{}\"; give old_text enough to pick one:\n{}",
            many.len(),
            old.trim(),
            many.iter().map(|at| format!("- {}", entries[*at])).collect::<Vec<_>>().join("\n")
        ))),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn notes(entries: &[&str]) -> Vec<String> {
        entries.iter().map(|entry| entry.to_string()).collect()
    }

    fn store() -> (Store, String) {
        let dir = std::env::temp_dir().join(format!("crew-notes-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).expect("dir");
        let store = Store::open(dir.join("crew.sqlite3")).expect("store");
        let workspace = crate::workspace::create(&store, "w".into(), dir.to_string_lossy().into()).expect("workspace").id;
        let bot = crate::session::create(
            &store,
            workspace,
            "bot".into(),
            "Home".into(),
            "claude".into(),
            "claude-opus-5-5".into(),
            String::new(),
            "ask".into(),
        )
        .expect("bot");
        (store, bot.id)
    }

    #[test]
    fn notes_are_kept_per_bot_and_read_back_as_written() {
        let (store, bot) = store();
        assert!(get(&store, &bot).unwrap().is_empty());
        set(&store, &bot, notes(&["el item es 7731942", "puede comprar hasta 50 USD"])).unwrap();
        assert_eq!(get(&store, &bot).unwrap(), notes(&["el item es 7731942", "puede comprar hasta 50 USD"]));
        // A deleted bot takes its notes with it.
        crate::session::delete(&store, bot.clone()).unwrap();
        let left: i64 = store.with(|conn| conn.query_row("SELECT COUNT(*) FROM bot_notes", [], |row| row.get(0))).unwrap();
        assert_eq!(left, 0);
    }

    #[test]
    fn add_skips_an_exact_repeat_and_patch_and_remove_need_one_match() {
        let start = notes(&["silla: id 7731942", "mesa: id 5512"]);
        assert_eq!(apply(&start, Edit::Add("silla: id 7731942")).unwrap(), start);
        let patched = apply(&start, Edit::Patch { old: "silla", new: "silla: comprada" }).unwrap();
        assert_eq!(patched, notes(&["silla: comprada", "mesa: id 5512"]));
        assert_eq!(apply(&start, Edit::Remove("mesa")).unwrap(), notes(&["silla: id 7731942"]));
        let Err(Refused::Asked(both)) = apply(&start, Edit::Remove(": id")) else { panic!("two entries match") };
        assert!(both.contains("2 entries") && both.contains("- silla") && both.contains("- mesa"), "{both}");
        assert!(matches!(apply(&start, Edit::Remove("sofá")), Err(Refused::Asked(none)) if none.contains("No entry")));
        assert!(matches!(apply(&start, Edit::Add("  ")), Err(Refused::Asked(_))));
    }

    /// Over the cap, a write is refused, saying how much room it needs.
    #[test]
    fn a_write_over_the_cap_is_refused() {
        let full = notes(&[&"a".repeat(CAP - 10)]);
        assert_eq!(apply(&full, Edit::Add("bbbbbbbbbbbbbbbbbbbb")), Err(Refused::Full { needed: 13 }));
        let (store, bot) = store();
        assert!(set(&store, &bot, notes(&[&"a".repeat(CAP + 1)])).is_err_and(|e| e.contains("4,000")));
    }

    #[test]
    fn usage_says_how_full_the_notes_are() {
        assert_eq!(usage(&[]), "[0% - 0/4,000]");
        assert_eq!(usage(&notes(&[&"x".repeat(2_480)])), "[62% - 2,480/4,000]");
        assert_eq!(used(&notes(&["ab", "cd"])), 2 + 2 + SEPARATOR.chars().count());
    }

    /// What the user types in the sheet is tidied the same way: an entry
    /// holding a separator line is two entries.
    #[test]
    fn a_separator_inside_an_entry_splits_it() {
        assert_eq!(tidy(notes(&["uno\n§\ndos", "", " uno "])), notes(&["uno", "dos"]));
    }
}
