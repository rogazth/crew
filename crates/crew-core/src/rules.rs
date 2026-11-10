//! A bot's rules: the decisions the user gave it about how to work ("Never
//! push to master", "Run the tests before pushing"), shown to it at the top of
//! every turn.
//!
//! They replace the notes, one text split by `§` that the bot could not
//! address: a patch replaced the whole entry that held a phrase, a remove
//! matched by substring, and the bot kept ids, prices and pending work there.
//! A rule is a row with an id the bot edits or removes it by (`r3`, numbered
//! within the bot and never given twice).
//!
//! The description is still who the bot is, its job and where it works.
//!
//! A workspace has rules too (`w3`), the user's decisions for every session
//! and bot that works in it, written only by the user. Neither has a most:
//! they hold as many as the user wants.

use crew_protocol::{Block, BlockRole};
use rusqlite::{params, Connection};

use crate::store::{now_millis, Store};

/// v51: the rules lose their cap (v43 gave each bot one), and a workspace
/// gets a description and rules of its own. The column goes only where v43
/// added it.
pub(crate) fn migrate_v51(conn: &Connection) -> rusqlite::Result<()> {
    if crate::store::has_column(conn, "bots", "rules_cap")? {
        conn.execute_batch("ALTER TABLE bots DROP COLUMN rules_cap;")?;
    }
    if !crate::store::has_column(conn, "workspaces", "description")? {
        conn.execute_batch("ALTER TABLE workspaces ADD COLUMN description TEXT NOT NULL DEFAULT '';")?;
    }
    if !crate::store::has_column(conn, "workspaces", "rules_made")? {
        conn.execute_batch("ALTER TABLE workspaces ADD COLUMN rules_made INTEGER NOT NULL DEFAULT 0;")?;
    }
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS workspace_rules (
           id           INTEGER PRIMARY KEY,
           workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
           number       INTEGER NOT NULL,
           body         TEXT NOT NULL,
           created_at   INTEGER NOT NULL,
           updated_at   INTEGER NOT NULL,
           UNIQUE (workspace_id, number)
         );",
    )
}

/// The notes the rules replace: v40 made the table, v41 reads it into rules
/// and drops it.
pub const MIGRATION_V40: &str = "
CREATE TABLE IF NOT EXISTS bot_notes (
  session_id TEXT PRIMARY KEY REFERENCES sessions(id) ON DELETE CASCADE,
  body       TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);
";

/// One row per rule. `number` is the rule's id within its bot (`r3`).
/// `message_id` and `source` are from when a rule cited the user's message and
/// said who wrote it; nothing reads them now, and a new rule leaves them at
/// their defaults.
const RULES_TABLE: &str = "
CREATE TABLE IF NOT EXISTS bot_rules (
  id          INTEGER PRIMARY KEY,
  bot_id      TEXT NOT NULL REFERENCES bots(id) ON DELETE CASCADE,
  number      INTEGER NOT NULL,
  body        TEXT NOT NULL,
  message_id  TEXT,
  source      TEXT NOT NULL DEFAULT 'bot',
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL,
  UNIQUE (bot_id, number)
);
";

/// v41: the rules table, and on each bot how many rules it has had
/// (`rules_made`), so a number is never given twice even after the newest
/// rule is removed. Every bot's notes become its rules, an entry a rule,
/// numbered in order, and the notes go. An entry keeps its text and the time
/// the notes were last written. Notes of a session that is not a bot (none should exist) go with
/// the table.
pub(crate) fn migrate_v41(conn: &Connection) -> rusqlite::Result<()> {
    conn.execute_batch(RULES_TABLE)?;
    if !crate::store::has_column(conn, "bots", "rules_made")? {
        conn.execute_batch("ALTER TABLE bots ADD COLUMN rules_made INTEGER NOT NULL DEFAULT 0;")?;
    }
    if crate::store::has_table(conn, "bot_notes")? {
        let notes: Vec<(String, String, i64)> = conn
            .prepare(
                "SELECT n.session_id, n.body, n.updated_at FROM bot_notes n
                  WHERE EXISTS (SELECT 1 FROM bots b WHERE b.id = n.session_id)",
            )?
            .query_map([], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)))?
            .collect::<rusqlite::Result<_>>()?;
        for (bot, body, at) in notes {
            for (index, entry) in split_notes(&body).into_iter().enumerate() {
                conn.execute(
                    "INSERT INTO bot_rules (bot_id, number, body, message_id, source, created_at, updated_at)
                     VALUES (?1, ?2, ?3, NULL, 'notes', ?4, ?4)",
                    params![bot, index as i64 + 1, tidy(&entry), at],
                )?;
            }
        }
    }
    conn.execute_batch(
        "DROP TABLE IF EXISTS bot_notes;
         UPDATE bots SET rules_made = (SELECT COALESCE(MAX(number), 0) FROM bot_rules WHERE bot_id = bots.id);",
    )
}

/// The notes' entries: separated by a line holding only `§`.
fn split_notes(body: &str) -> Vec<String> {
    body.lines()
        .collect::<Vec<_>>()
        .split(|line| line.trim() == "§")
        .map(|lines| lines.join("\n").trim().to_string())
        .filter(|entry| !entry.is_empty())
        .collect()
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Rule {
    /// Its number within the bot: what [`label`] names it by.
    pub id: i64,
    pub body: String,
    pub created_at: i64,
    pub updated_at: i64,
}

/// Whose rules: a bot's (`r3`) or a workspace's (`w3`), each numbered within
/// its owner.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Owner<'a> {
    Bot(&'a str),
    Workspace(&'a str),
}

impl Owner<'_> {
    fn id(&self) -> &str {
        match self {
            Owner::Bot(id) | Owner::Workspace(id) => id,
        }
    }

    /// The rules' table, the column naming the owner, and the owner's table,
    /// which counts the rules it has had (`rules_made`).
    fn tables(&self) -> (&'static str, &'static str, &'static str) {
        match self {
            Owner::Bot(_) => ("bot_rules", "bot_id", "bots"),
            Owner::Workspace(_) => ("workspace_rules", "workspace_id", "workspaces"),
        }
    }

    fn prefix(&self) -> char {
        match self {
            Owner::Bot(_) => 'r',
            Owner::Workspace(_) => 'w',
        }
    }

    /// `r3` or `w3`: how a rule is named wherever it is shown or taken: the
    /// prompt, the tool, the CLI, the bot sheet, the workspace's settings.
    pub fn label(&self, id: i64) -> String {
        format!("{}{id}", self.prefix())
    }

    /// A rule's id as it may be written: `r3`, `R3` or `3` for a bot.
    pub fn parse(&self, text: &str) -> Option<i64> {
        let text = text.trim();
        let prefix = self.prefix();
        let digits = text.strip_prefix([prefix, prefix.to_ascii_uppercase()]).unwrap_or(text);
        digits.parse().ok().filter(|id| *id > 0)
    }
}

/// `r3`: a bot's rule as it is named.
pub fn label(id: i64) -> String {
    Owner::Bot("").label(id)
}

/// A bot's rule id as the bot may write it: `r3`, `R3` or `3`.
pub fn parse_label(text: &str) -> Option<i64> {
    Owner::Bot("").parse(text)
}

/// The owner's rules, oldest first.
pub fn list(store: &Store, owner: Owner) -> Result<Vec<Rule>, String> {
    store.with(|conn| read(conn, owner))
}

fn read(conn: &Connection, owner: Owner) -> rusqlite::Result<Vec<Rule>> {
    let (table, column, _) = owner.tables();
    conn.prepare_cached(&format!(
        "SELECT number, body, created_at, updated_at FROM {table} WHERE {column} = ?1 ORDER BY number"
    ))?
    .query_map(params![owner.id()], |row| {
        Ok(Rule { id: row.get(0)?, body: row.get(1)?, created_at: row.get(2)?, updated_at: row.get(3)? })
    })?
    .collect()
}

/// A rule as it is stored: one line, its whitespace collapsed. A rule is a
/// sentence, and the prompt shows one per line.
pub fn tidy(body: &str) -> String {
    body.split_whitespace().collect::<Vec<_>>().join(" ")
}

/// What a write to the rules does.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Change {
    Add { body: String },
    Edit { id: i64, body: String },
    Remove(i64),
}

/// What a change did.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Done {
    Added(Rule),
    /// The same body was already there: this rule.
    Repeated(Rule),
    /// The rule as it is now.
    Edited(Rule),
    /// The rule as it was.
    Removed(Rule),
}

/// Why a write was refused, said so the bot can fix it in one more call.
#[derive(Debug, PartialEq, Eq)]
pub enum Refused {
    /// Missing arguments.
    Asked(String),
    /// No rule has this id; `ids` are the ones there are.
    Unknown { id: i64, ids: Vec<i64> },
}

impl Refused {
    /// What the bot is told: one line.
    pub fn say(&self) -> String {
        match self {
            Refused::Asked(why) => why.clone(),
            Refused::Unknown { id, ids } if ids.is_empty() => format!("No rule {}: you have no rules yet.", label(*id)),
            Refused::Unknown { id, ids } => format!(
                "No rule {}. Your rules are {}.",
                label(*id),
                ids.iter().map(|id| label(*id)).collect::<Vec<_>>().join(", ")
            ),
        }
    }
}

/// `changes`, in order, under one hold of the connection and all or none: a
/// write that lands meanwhile (the bot sheet, a second tool call) cannot be
/// lost.
pub fn apply(store: &Store, owner: Owner, changes: Vec<Change>) -> Result<Result<Vec<Done>, Refused>, String> {
    store.with(|conn| {
        let tx = conn.unchecked_transaction()?;
        let mut done = Vec::new();
        for change in changes {
            match apply_one(&tx, owner, change)? {
                Ok(one) => done.push(one),
                // Dropped without a commit: nothing of the batch is kept.
                Err(refused) => return Ok(Err(refused)),
            }
        }
        tx.commit()?;
        Ok(Ok(done))
    })
}

fn apply_one(conn: &Connection, owner: Owner, change: Change) -> rusqlite::Result<Result<Done, Refused>> {
    let now = now_millis();
    let (table, column, counter) = owner.tables();
    let rules = read(conn, owner)?;
    let find = |id: i64| match rules.iter().find(|rule| rule.id == id) {
        Some(rule) => Ok(rule.clone()),
        None => Err(Refused::Unknown { id, ids: rules.iter().map(|rule| rule.id).collect() }),
    };
    Ok(match change {
        Change::Add { body } => {
            let body = tidy(&body);
            if body.is_empty() {
                return Ok(Err(Refused::Asked("content is required: the rule.".into())));
            }
            if let Some(same) = rules.iter().find(|rule| rule.body == body) {
                return Ok(Ok(Done::Repeated(same.clone())));
            }
            // The next number this owner has never had.
            let id: i64 = conn.query_row(
                &format!("UPDATE {counter} SET rules_made = rules_made + 1 WHERE id = ?1 RETURNING rules_made"),
                params![owner.id()],
                |row| row.get(0),
            )?;
            conn.execute(
                &format!("INSERT INTO {table} ({column}, number, body, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?4)"),
                params![owner.id(), id, body, now],
            )?;
            Ok(Done::Added(read(conn, owner)?.into_iter().find(|rule| rule.id == id).expect("just added")))
        }
        Change::Edit { id, body } => {
            let body = tidy(&body);
            if body.is_empty() {
                return Ok(Err(Refused::Asked("content is required: what the rule becomes. To drop it, remove it.".into())));
            }
            if let Err(refused) = find(id) {
                return Ok(Err(refused));
            }
            conn.execute(
                &format!("UPDATE {table} SET body = ?3, updated_at = ?4 WHERE {column} = ?1 AND number = ?2"),
                params![owner.id(), id, body, now],
            )?;
            Ok(Done::Edited(read(conn, owner)?.into_iter().find(|rule| rule.id == id).expect("just edited")))
        }
        Change::Remove(id) => {
            let rule = match find(id) {
                Ok(rule) => rule,
                Err(refused) => return Ok(Err(refused)),
            };
            conn.execute(&format!("DELETE FROM {table} WHERE {column} = ?1 AND number = ?2"), params![owner.id(), id])?;
            Ok(Done::Removed(rule))
        }
    })
}

/// A message the user typed in this conversation, not a letter, a line of
/// Crew's or a routine's prompt: what the trail numbers.
pub fn typed_by_user(block: &Block) -> bool {
    block.role == BlockRole::User && block.from_bot.is_none() && block.hidden != Some(true)
}

/// The rules as the prompt shows them, one a line: `[r1] Never push to
/// master.`
pub fn lines(owner: Owner, rules: &[Rule]) -> String {
    if rules.is_empty() {
        return "None yet.".into();
    }
    rules.iter().map(|rule| format!("[{}] {}", owner.label(rule.id), tidy(&rule.body))).collect::<Vec<_>>().join("\n")
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

#[cfg(test)]
mod tests {
    use super::*;
    use crate::blocks::new_block;

    fn store() -> (Store, String, std::path::PathBuf) {
        let dir = std::env::temp_dir().join(format!("crew-rules-{}", uuid::Uuid::new_v4()));
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
        (store, bot.id, dir)
    }

    fn add(body: &str) -> Change {
        Change::Add { body: body.into() }
    }

    fn bodies(store: &Store, bot: &str) -> Vec<String> {
        list(store, Owner::Bot(bot)).unwrap().into_iter().map(|rule| rule.body).collect()
    }

    fn added(done: Result<Result<Vec<Done>, Refused>, String>) -> Rule {
        match done.unwrap().unwrap().pop() {
            Some(Done::Added(rule)) => rule,
            other => panic!("not added: {other:?}"),
        }
    }

    #[test]
    fn rules_are_kept_per_bot_and_go_with_it() {
        let (store, bot, _) = store();
        assert!(list(&store, Owner::Bot(&bot)).unwrap().is_empty());
        apply(&store, Owner::Bot(&bot), vec![add("Never push to master"), add("Run the tests\n  before pushing")]).unwrap().unwrap();
        assert_eq!(bodies(&store, &bot), ["Never push to master", "Run the tests before pushing"]);
        crate::session::delete(&store, bot.clone()).unwrap();
        let left: i64 = store.with(|conn| conn.query_row("SELECT COUNT(*) FROM bot_rules", [], |row| row.get(0))).unwrap();
        assert_eq!(left, 0);
    }

    /// An edit and a remove go by id and touch that one rule; a repeat is the
    /// rule already there.
    #[test]
    fn edits_and_removes_go_by_id() {
        let (store, bot, _) = store();
        let first = added(apply(&store, Owner::Bot(&bot), vec![add("Never push to master")]));
        let second = added(apply(&store, Owner::Bot(&bot), vec![add("Run the tests before pushing")]));
        let again = apply(&store, Owner::Bot(&bot), vec![add("Never push to master")]).unwrap().unwrap();
        assert!(matches!(&again[..], [Done::Repeated(rule)] if rule.id == first.id), "{again:?}");

        let edited = apply(&store, Owner::Bot(&bot), vec![Change::Edit { id: first.id, body: "Never push to main".into() }]);
        assert!(matches!(&edited.unwrap().unwrap()[..], [Done::Edited(rule)] if rule.body == "Never push to main"));
        assert_eq!(bodies(&store, &bot), ["Never push to main", "Run the tests before pushing"]);
        let kept = list(&store, Owner::Bot(&bot)).unwrap().remove(0);
        assert_eq!(kept.created_at, first.created_at);

        apply(&store, Owner::Bot(&bot), vec![Change::Remove(second.id)]).unwrap().unwrap();
        assert_eq!(bodies(&store, &bot), ["Never push to main"]);
        let unknown = apply(&store, Owner::Bot(&bot), vec![Change::Remove(second.id)]).unwrap().unwrap_err();
        assert_eq!(unknown, Refused::Unknown { id: second.id, ids: vec![first.id] });
        assert_eq!(unknown.say(), format!("No rule r{}. Your rules are r{}.", second.id, first.id));
        assert!(matches!(apply(&store, Owner::Bot(&bot), vec![add("  ")]).unwrap(), Err(Refused::Asked(_))));
    }

    /// A bot's rules are numbered within it, from r1, and a number is never
    /// given twice: not after the newest is removed, not to another bot.
    #[test]
    fn a_bots_rules_are_numbered_within_it_and_never_twice() {
        let (store, bot, dir) = store();
        let first = added(apply(&store, Owner::Bot(&bot), vec![add("Never push to master")]));
        let second = added(apply(&store, Owner::Bot(&bot), vec![add("Run the tests before pushing")]));
        assert_eq!((first.id, second.id), (1, 2));
        apply(&store, Owner::Bot(&bot), vec![Change::Remove(2)]).unwrap().unwrap();
        assert_eq!(added(apply(&store, Owner::Bot(&bot), vec![add("Ask before deleting a branch")])).id, 3);

        std::fs::create_dir_all(dir.join("x")).unwrap();
        let workspace = crate::workspace::create(&store, "x".into(), dir.join("x").to_string_lossy().into()).unwrap();
        let other = crate::session::create(
            &store,
            workspace.id,
            "bot".into(),
            "Other".into(),
            "claude".into(),
            String::new(),
            String::new(),
            "ask".into(),
        )
        .unwrap()
        .id;
        assert_eq!(added(apply(&store, Owner::Bot(&other), vec![add("Never push to master")])).id, 1);
        // Each bot's r1 is its own.
        apply(&store, Owner::Bot(&other), vec![Change::Remove(1)]).unwrap().unwrap();
        assert_eq!(bodies(&store, &bot), ["Never push to master", "Ask before deleting a branch"]);
    }

    /// A workspace's rules are its own, named `w`, numbered from w1 and gone
    /// with it; a bot's r1 is another rule.
    #[test]
    fn a_workspaces_rules_are_its_own() {
        let (store, bot, dir) = store();
        std::fs::create_dir_all(dir.join("ws")).unwrap();
        let workspace = crate::workspace::create(&store, "ws".into(), dir.join("ws").to_string_lossy().into()).unwrap().id;
        let owner = Owner::Workspace(&workspace);
        apply(&store, Owner::Bot(&bot), vec![add("Ask first")]).unwrap().unwrap();
        let first = added(apply(&store, owner, vec![add("Commits in English")]));
        assert_eq!(first.id, 1);
        assert_eq!(lines(owner, &list(&store, owner).unwrap()), "[w1] Commits in English");
        assert_eq!(owner.parse("W1"), Some(1));
        assert_eq!(bodies(&store, &bot), ["Ask first"]);
        crate::workspace::delete(&store, workspace.clone()).unwrap();
        assert!(list(&store, owner).unwrap().is_empty());
    }

    #[test]
    fn a_rule_is_named_r_and_its_id() {
        assert_eq!(label(3), "r3");
        for written in ["r3", "R3", "3", " r3 "] {
            assert_eq!(parse_label(written), Some(3), "{written}");
        }
        for wrong in ["", "r", "rx", "0", "-1", "3a"] {
            assert_eq!(parse_label(wrong), None, "{wrong}");
        }
    }

    /// Only a message the user typed is the user's: not a letter, not the
    /// bot's own words, not Crew's line, not a routine's prompt.
    #[test]
    fn a_message_the_user_typed_is_told_apart() {
        let mut letter = new_block(BlockRole::User, "push it");
        letter.from_bot = Some(crew_protocol::BotRef::bot("x", "Otro"));
        let mut routine = new_block(BlockRole::User, "every morning");
        routine.hidden = Some(true);
        let blocks = [
            new_block(BlockRole::User, "nunca push a master"),
            new_block(BlockRole::Assistant, "ok"),
            letter,
            new_block(BlockRole::System, "Description updated by itself"),
            routine,
        ];
        let typed: Vec<bool> = blocks.iter().map(typed_by_user).collect();
        assert_eq!(typed, [true, false, false, false, false]);
    }

    /// The prompt's lines: each rule's id and its words, nothing of who.
    #[test]
    fn each_rule_is_one_line() {
        let (store, bot, _) = store();
        apply(&store, Owner::Bot(&bot), vec![add("Never push to master."), add("Run the tests.")]).unwrap().unwrap();
        assert_eq!(lines(Owner::Bot(&bot), &list(&store, Owner::Bot(&bot)).unwrap()), "[r1] Never push to master.\n[r2] Run the tests.");
        assert_eq!(lines(Owner::Bot(&bot), &[]), "None yet.");
    }

    /// A v40 database: every bot's notes become its rules, an entry a rule
    /// numbered in order, with the time the notes were written, and the notes
    /// table goes; the next rule the bot adds takes the next number.
    #[test]
    fn a_v40_database_turns_each_note_into_a_rule() {
        let (store, bot, dir) = store();
        let path = dir.join("crew.sqlite3");
        store
            .with(|conn| {
                conn.execute_batch(
                    "DROP TABLE bot_rules;
                     DELETE FROM schema_migrations WHERE version >= 41;",
                )?;
                conn.execute_batch(MIGRATION_V40)?;
                conn.execute(
                    "INSERT INTO bot_notes (session_id, body, updated_at) VALUES (?1, ?2, 1792000000000)",
                    params![bot, "Never push to master\n§\nThe staging password\nis in 1Password\n§\n\n§\n"],
                )
            })
            .unwrap();
        drop(store);

        let store = Store::open(path).expect("reopen");
        let rules = list(&store, Owner::Bot(&bot)).unwrap();
        assert_eq!(
            rules.iter().map(|rule| (rule.id, rule.body.as_str())).collect::<Vec<_>>(),
            [(1, "Never push to master"), (2, "The staging password is in 1Password")]
        );
        for rule in &rules {
            assert_eq!((rule.created_at, rule.updated_at), (1_792_000_000_000, 1_792_000_000_000));
        }
        assert!(!store.with(|conn| crate::store::has_table(conn, "bot_notes")).unwrap());
        assert_eq!(added(apply(&store, Owner::Bot(&bot), vec![add("Ask first")])).id, 3);
    }
}
