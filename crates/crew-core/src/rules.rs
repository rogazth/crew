//! A bot's rules: the decisions the user gave it about how to work ("Never
//! push to master", "Run the tests before pushing"), shown to it at the top of
//! every turn.
//!
//! They replace the notes, one text split by `§` that the bot could not
//! address: a patch replaced the whole entry that held a phrase, a remove
//! matched by substring, and the bot kept ids, prices and pending work there.
//! A rule is a row with an id the bot edits or removes it by, and one the bot
//! adds cites the user's message that set it: what is not the user's decision
//! has no message to cite.
//!
//! The description is still who the bot is, its job and where it works.

use crew_protocol::{Block, BlockRole};
use rusqlite::{params, Connection};

use crate::store::{now_millis, Store};

/// The most the rules may hold, in characters, summed over their bodies.
pub const CAP: usize = 1_500;

/// The notes the rules replace: v40 made the table, v41 reads it into rules
/// and drops it.
pub const MIGRATION_V40: &str = "
CREATE TABLE IF NOT EXISTS bot_notes (
  session_id TEXT PRIMARY KEY REFERENCES sessions(id) ON DELETE CASCADE,
  body       TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);
";

/// One row per rule. `message_id` is the `messages.id` of the user's message
/// that set it; `source` says who wrote it (see [`Source`]).
pub const MIGRATION_V41: &str = "
CREATE TABLE IF NOT EXISTS bot_rules (
  id          INTEGER PRIMARY KEY,
  bot_id      TEXT NOT NULL REFERENCES bots(id) ON DELETE CASCADE,
  body        TEXT NOT NULL,
  message_id  TEXT,
  source      TEXT NOT NULL DEFAULT 'bot',
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS bot_rules_bot_idx ON bot_rules (bot_id);
";

/// Every bot's notes become its rules, an entry a rule, and the notes go.
/// An entry keeps its text and the time the notes were last written; it cites
/// no message, and says so by its source. Notes of a session that is not a
/// bot (none should exist) go with the table.
pub(crate) fn migrate_notes(conn: &Connection) -> rusqlite::Result<()> {
    if crate::store::has_table(conn, "bot_notes")? {
        let notes: Vec<(String, String, i64)> = conn
            .prepare(
                "SELECT n.session_id, n.body, n.updated_at FROM bot_notes n
                  WHERE EXISTS (SELECT 1 FROM bots b WHERE b.id = n.session_id)",
            )?
            .query_map([], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)))?
            .collect::<rusqlite::Result<_>>()?;
        for (bot, body, at) in notes {
            for entry in split_notes(&body) {
                conn.execute(
                    "INSERT INTO bot_rules (bot_id, body, message_id, source, created_at, updated_at)
                     VALUES (?1, ?2, NULL, 'notes', ?3, ?3)",
                    params![bot, tidy(&entry), at],
                )?;
            }
        }
    }
    conn.execute_batch("DROP TABLE IF EXISTS bot_notes;")
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

/// Who wrote a rule, which says what its line in the prompt ends with.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Source {
    /// The bot, citing the user's message (`message_id`).
    Bot,
    /// The user, in the bot sheet.
    Sheet,
    /// An entry of the notes the rules replaced: nobody can say who.
    Notes,
}

impl Source {
    fn as_str(self) -> &'static str {
        match self {
            Source::Bot => "bot",
            Source::Sheet => "sheet",
            Source::Notes => "notes",
        }
    }

    fn parse(text: &str) -> Self {
        match text {
            "sheet" => Source::Sheet,
            "notes" => Source::Notes,
            _ => Source::Bot,
        }
    }
}

/// The user's message a rule cites, as the transcript keeps it.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Cited {
    pub text: String,
    pub at: i64,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Rule {
    pub id: i64,
    pub body: String,
    pub message_id: Option<String>,
    pub source: Source,
    pub created_at: i64,
    pub updated_at: i64,
    /// The cited message, while the transcript still has it.
    pub cited: Option<Cited>,
}

/// `r3`: how the bot and its prompt name a rule.
pub fn label(id: i64) -> String {
    format!("r{id}")
}

/// A rule's id as the bot may write it: `r3`, `R3` or `3`.
pub fn parse_label(text: &str) -> Option<i64> {
    let text = text.trim();
    let digits = text.strip_prefix(['r', 'R']).unwrap_or(text);
    digits.parse().ok().filter(|id| *id > 0)
}

/// A bot's rules, oldest first.
pub fn list(store: &Store, bot_id: &str) -> Result<Vec<Rule>, String> {
    store.with(|conn| read(conn, bot_id))
}

fn read(conn: &Connection, bot_id: &str) -> rusqlite::Result<Vec<Rule>> {
    conn.prepare_cached(
        "SELECT r.id, r.body, r.message_id, r.source, r.created_at, r.updated_at, m.text, m.at
           FROM bot_rules r
           LEFT JOIN messages m ON m.session_id = r.bot_id AND m.id = r.message_id
          WHERE r.bot_id = ?1
          ORDER BY r.id",
    )?
    .query_map(params![bot_id], |row| {
        let text: Option<String> = row.get(6)?;
        let at: Option<i64> = row.get(7)?;
        Ok(Rule {
            id: row.get(0)?,
            body: row.get(1)?,
            message_id: row.get(2)?,
            source: Source::parse(&row.get::<_, String>(3)?),
            created_at: row.get(4)?,
            updated_at: row.get(5)?,
            cited: text.zip(at).map(|(text, at)| Cited { text, at }),
        })
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
    Add { body: String, message_id: Option<String>, source: Source },
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
    /// The rules would take `used` characters, more than [`CAP`].
    Full { used: usize },
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
            Refused::Full { used } => format!(
                "Your rules hold at most {} characters, and that would make them {}. Merge, shorten or remove rules first.",
                thousands(CAP),
                thousands(*used)
            ),
        }
    }
}

/// `changes`, in order, under one hold of the connection and all or none: a
/// write that lands meanwhile (the bot sheet, a second tool call) cannot be
/// lost. Over the cap the whole is refused, unless it leaves the rules no
/// longer than they were: rules from the notes may start over it, and
/// shortening or removing them is how they come back under.
pub fn apply(store: &Store, bot_id: &str, changes: Vec<Change>) -> Result<Result<Vec<Done>, Refused>, String> {
    store.with(|conn| {
        let tx = conn.unchecked_transaction()?;
        let before = used(&read(&tx, bot_id)?);
        let mut done = Vec::new();
        for change in changes {
            match apply_one(&tx, bot_id, change)? {
                Ok(one) => done.push(one),
                // Dropped without a commit: nothing of the batch is kept.
                Err(refused) => return Ok(Err(refused)),
            }
        }
        let after = used(&read(&tx, bot_id)?);
        if after > CAP && after > before {
            return Ok(Err(Refused::Full { used: after }));
        }
        tx.commit()?;
        Ok(Ok(done))
    })
}

fn apply_one(conn: &Connection, bot_id: &str, change: Change) -> rusqlite::Result<Result<Done, Refused>> {
    let now = now_millis();
    let rules = read(conn, bot_id)?;
    let find = |id: i64| match rules.iter().find(|rule| rule.id == id) {
        Some(rule) => Ok(rule.clone()),
        None => Err(Refused::Unknown { id, ids: rules.iter().map(|rule| rule.id).collect() }),
    };
    Ok(match change {
        Change::Add { body, message_id, source } => {
            let body = tidy(&body);
            if body.is_empty() {
                return Ok(Err(Refused::Asked("content is required: the rule.".into())));
            }
            if let Some(same) = rules.iter().find(|rule| rule.body == body) {
                return Ok(Ok(Done::Repeated(same.clone())));
            }
            conn.execute(
                "INSERT INTO bot_rules (bot_id, body, message_id, source, created_at, updated_at)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?5)",
                params![bot_id, body, message_id, source.as_str(), now],
            )?;
            let id = conn.last_insert_rowid();
            Ok(Done::Added(read(conn, bot_id)?.into_iter().find(|rule| rule.id == id).expect("just added")))
        }
        Change::Edit { id, body } => {
            let body = tidy(&body);
            if body.is_empty() {
                return Ok(Err(Refused::Asked("content is required: what the rule becomes. To drop it, remove it.".into())));
            }
            let rule = match find(id) {
                Ok(rule) => rule,
                Err(refused) => return Ok(Err(refused)),
            };
            conn.execute("UPDATE bot_rules SET body = ?2, updated_at = ?3 WHERE id = ?1", params![id, body, now])?;
            Ok(Done::Edited(Rule { body, updated_at: now, ..rule }))
        }
        Change::Remove(id) => {
            let rule = match find(id) {
                Ok(rule) => rule,
                Err(refused) => return Ok(Err(refused)),
            };
            conn.execute("DELETE FROM bot_rules WHERE id = ?1", params![id])?;
            Ok(Done::Removed(rule))
        }
    })
}

/// The block `at` (1-based, as the trail and `read_session` number them) when
/// it is a message the user typed in this conversation; otherwise the refusal
/// the bot is given. A letter from a bot or a session, the bot's own words, a
/// line of Crew's and a routine's prompt are nobody's decision about how the
/// bot works.
pub fn user_message(blocks: &[Block], at: i64) -> Result<&Block, String> {
    let refused = || format!("Rules hold the user's decisions, and block {at} is not a message from the user.");
    let block = usize::try_from(at).ok().and_then(|at| at.checked_sub(1)).and_then(|index| blocks.get(index));
    block.filter(|block| typed_by_user(block)).ok_or_else(refused)
}

/// A message the user typed in this conversation: what a rule may cite.
pub fn typed_by_user(block: &Block) -> bool {
    block.role == BlockRole::User && block.from_bot.is_none() && block.hidden != Some(true)
}

/// Characters the rules take: their bodies, nothing else.
pub fn used(rules: &[Rule]) -> usize {
    rules.iter().map(|rule| rule.body.chars().count()).sum()
}

/// `[22% - 335/1,500]`: how full the rules are.
pub fn usage(rules: &[Rule]) -> String {
    let used = used(rules);
    format!("[{}% - {}/{}]", used * 100 / CAP, thousands(used), thousands(CAP))
}

/// The rules as the prompt shows them, one a line: `[r1] Never push to
/// master. (user, 2026-10-21)`. The date is the cited message's, or the day
/// the user wrote it in the sheet; a rule from the notes says nothing of who.
pub fn lines(rules: &[Rule]) -> String {
    if rules.is_empty() {
        return "None yet.".into();
    }
    rules
        .iter()
        .map(|rule| {
            let who = match (rule.source, &rule.cited) {
                (Source::Bot, Some(cited)) => format!(" (user, {})", day(cited.at)),
                (Source::Bot, None) => " (user)".to_string(),
                (Source::Sheet, _) => format!(" (user, {})", day(rule.created_at)),
                (Source::Notes, _) => String::new(),
            };
            format!("[{}] {}{who}", label(rule.id), tidy(&rule.body))
        })
        .collect::<Vec<_>>()
        .join("\n")
}

/// `2026-10-21`, local.
pub fn day(ms: i64) -> String {
    crate::store::stamp(ms).chars().take(10).collect()
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
        Change::Add { body: body.into(), message_id: None, source: Source::Sheet }
    }

    fn bodies(store: &Store, bot: &str) -> Vec<String> {
        list(store, bot).unwrap().into_iter().map(|rule| rule.body).collect()
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
        assert!(list(&store, &bot).unwrap().is_empty());
        apply(&store, &bot, vec![add("Never push to master"), add("Run the tests\n  before pushing")]).unwrap().unwrap();
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
        let first = added(apply(&store, &bot, vec![add("Never push to master")]));
        let second = added(apply(&store, &bot, vec![add("Run the tests before pushing")]));
        let again = apply(&store, &bot, vec![add("Never push to master")]).unwrap().unwrap();
        assert!(matches!(&again[..], [Done::Repeated(rule)] if rule.id == first.id), "{again:?}");

        let edited = apply(&store, &bot, vec![Change::Edit { id: first.id, body: "Never push to main".into() }]);
        assert!(matches!(&edited.unwrap().unwrap()[..], [Done::Edited(rule)] if rule.body == "Never push to main"));
        assert_eq!(bodies(&store, &bot), ["Never push to main", "Run the tests before pushing"]);
        let kept = list(&store, &bot).unwrap().remove(0);
        assert_eq!((kept.created_at, kept.source), (first.created_at, Source::Sheet));

        apply(&store, &bot, vec![Change::Remove(second.id)]).unwrap().unwrap();
        assert_eq!(bodies(&store, &bot), ["Never push to main"]);
        let unknown = apply(&store, &bot, vec![Change::Remove(second.id)]).unwrap().unwrap_err();
        assert_eq!(unknown, Refused::Unknown { id: second.id, ids: vec![first.id] });
        assert_eq!(unknown.say(), format!("No rule r{}. Your rules are r{}.", second.id, first.id));
        assert!(matches!(apply(&store, &bot, vec![add("  ")]).unwrap(), Err(Refused::Asked(_))));
    }

    /// Over the cap the whole write is refused, and nothing of it is kept.
    #[test]
    fn a_write_over_the_cap_is_refused_whole() {
        let (store, bot, _) = store();
        apply(&store, &bot, vec![add(&"a".repeat(CAP - 10))]).unwrap().unwrap();
        let refused = apply(&store, &bot, vec![add("short"), add(&"b".repeat(20))]).unwrap().unwrap_err();
        assert_eq!(refused, Refused::Full { used: CAP - 10 + 5 + 20 });
        assert!(refused.say().contains("at most 1,500 characters, and that would make them 1,515"), "{}", refused.say());
        assert_eq!(list(&store, &bot).unwrap().len(), 1, "a refused write changes nothing");
    }

    /// Rules from the notes may start over the cap: what shortens them goes
    /// through, what grows them does not.
    #[test]
    fn rules_over_the_cap_may_still_shrink() {
        let (store, bot, _) = store();
        let big = store
            .with(|conn| {
                conn.execute(
                    "INSERT INTO bot_rules (bot_id, body, source, created_at, updated_at) VALUES (?1, ?2, 'notes', 1, 1)",
                    params![bot, "x".repeat(CAP + 100)],
                )?;
                Ok(conn.last_insert_rowid())
            })
            .unwrap();
        assert!(apply(&store, &bot, vec![add("one more")]).unwrap().is_err());
        let shorter = Change::Edit { id: big, body: "x".repeat(CAP + 50) };
        assert!(apply(&store, &bot, vec![shorter]).unwrap().is_ok());
    }

    #[test]
    fn usage_counts_bodies_only() {
        let (store, bot, _) = store();
        assert_eq!(usage(&[]), "[0% - 0/1,500]");
        apply(&store, &bot, vec![add(&"x".repeat(335))]).unwrap().unwrap();
        assert_eq!(usage(&list(&store, &bot).unwrap()), "[22% - 335/1,500]");
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

    /// Only a message the user typed can be cited: not a letter, not the
    /// bot's own words, not Crew's line, not a routine's prompt.
    #[test]
    fn a_rule_cites_a_message_the_user_typed() {
        let mut letter = new_block(BlockRole::User, "push it");
        letter.from_bot = Some(crew_protocol::BotRef::bot("x", "Otro"));
        let mut routine = new_block(BlockRole::User, "every morning");
        routine.hidden = Some(true);
        let blocks = vec![
            new_block(BlockRole::User, "nunca push a master"),
            new_block(BlockRole::Assistant, "ok"),
            letter,
            new_block(BlockRole::System, "Description updated by itself"),
            routine,
        ];
        assert_eq!(user_message(&blocks, 1).unwrap().text, "nunca push a master");
        for at in [0, -1, 2, 3, 4, 5, 9] {
            let refused = user_message(&blocks, at).unwrap_err();
            assert_eq!(refused, format!("Rules hold the user's decisions, and block {at} is not a message from the user."));
        }
    }

    /// The prompt's lines: the cited message's date, the sheet's day, and
    /// nothing for what came from the notes.
    #[test]
    fn each_rule_is_one_line_saying_who_set_it() {
        let (store, bot, _) = store();
        let at = crate::store::now_millis();
        store
            .with(|conn| {
                conn.execute(
                    "INSERT INTO messages (session_id, pos, id, role, text, at) VALUES (?1, 1, 'm1', 'user', 'never push', ?2)",
                    params![bot, at],
                )
            })
            .unwrap();
        let cited = Change::Add { body: "Never push to master.".into(), message_id: Some("m1".into()), source: Source::Bot };
        let gone = Change::Add { body: "Ask first.".into(), message_id: Some("m9".into()), source: Source::Bot };
        apply(&store, &bot, vec![cited, gone, add("Run the tests.")]).unwrap().unwrap();
        store
            .with(|conn| {
                conn.execute(
                    "INSERT INTO bot_rules (bot_id, body, source, created_at, updated_at) VALUES (?1, 'Old note', 'notes', 1, 1)",
                    params![bot],
                )
            })
            .unwrap();
        let rules = list(&store, &bot).unwrap();
        assert_eq!(rules[0].cited, Some(Cited { text: "never push".into(), at }));
        let ids: Vec<String> = rules.iter().map(|rule| label(rule.id)).collect();
        let today = day(at);
        assert_eq!(
            lines(&rules),
            format!(
                "[{}] Never push to master. (user, {today})\n[{}] Ask first. (user)\n[{}] Run the tests. (user, {today})\n[{}] Old note",
                ids[0], ids[1], ids[2], ids[3]
            )
        );
        assert_eq!(lines(&[]), "None yet.");
    }

    /// A v40 database: every bot's notes become its rules, an entry a rule,
    /// with the time the notes were written, and the notes table goes.
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
        let rules = list(&store, &bot).unwrap();
        assert_eq!(
            rules.iter().map(|rule| rule.body.as_str()).collect::<Vec<_>>(),
            ["Never push to master", "The staging password is in 1Password"]
        );
        for rule in &rules {
            assert_eq!((rule.message_id.as_deref(), rule.source), (None, Source::Notes));
            assert_eq!((rule.created_at, rule.updated_at), (1_792_000_000_000, 1_792_000_000_000));
        }
        assert!(!lines(&rules).contains("(user"), "{}", lines(&rules));
        assert!(!store.with(|conn| crate::store::has_table(conn, "bot_notes")).unwrap());
    }
}
