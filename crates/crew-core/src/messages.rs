//! Transcripts as rows.
//!
//! `sessions.blocks_json` keeps the whole conversation in one column, which is
//! right for rendering one open chat and wrong for everything else: a tail
//! costs a full parse, a date filter is impossible, and searching across agents
//! means loading every transcript into memory. The same blocks live here as
//! rows with an FTS5 index over their text.
//!
//! `pos` is the block's position in the transcript, 1-based. It is not the
//! `seq` of `TranscriptHub`, which counts live events; a transcript of ten
//! blocks can be the result of a thousand deltas.

use std::collections::hash_map::DefaultHasher;
use std::hash::{Hash, Hasher};

use crew_protocol::{
    AgentRef, AttachedFile, Block, BlockApproval, BlockQuestion, BlockRole, BlockTool, MessagePage,
    SearchHit, SearchQuery, TurnUsage,
};
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};

use crate::store::{now_millis, Store};

/// The optional half of a block. The columns carry what queries filter and sort
/// on; everything else rides along as JSON so a new block field does not need a
/// migration.
#[derive(Serialize, Deserialize, Default)]
struct Extra {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    hidden: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    streaming: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    files: Option<Vec<AttachedFile>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    tool: Option<BlockTool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    approval: Option<BlockApproval>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    question: Option<BlockQuestion>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    usage: Option<TurnUsage>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    from_agent: Option<AgentRef>,
}

const DEFAULT_LIMIT: u32 = 50;
const MAX_LIMIT: u32 = 500;

pub const MIGRATION_V10: &str = r#"
CREATE TABLE IF NOT EXISTS messages (
  session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  pos        INTEGER NOT NULL,
  id         TEXT NOT NULL,
  role       TEXT NOT NULL,
  text       TEXT NOT NULL,
  at         INTEGER NOT NULL,
  extra_json TEXT NOT NULL DEFAULT '{}',
  PRIMARY KEY (session_id, pos)
);

CREATE INDEX IF NOT EXISTS messages_at_idx ON messages (at DESC);

CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts
  USING fts5(text, content='messages', content_rowid='rowid');

CREATE TRIGGER IF NOT EXISTS messages_ai AFTER INSERT ON messages BEGIN
  INSERT INTO messages_fts (rowid, text) VALUES (new.rowid, new.text);
END;

CREATE TRIGGER IF NOT EXISTS messages_ad AFTER DELETE ON messages BEGIN
  INSERT INTO messages_fts (messages_fts, rowid, text) VALUES ('delete', old.rowid, old.text);
END;

CREATE TRIGGER IF NOT EXISTS messages_au AFTER UPDATE ON messages BEGIN
  INSERT INTO messages_fts (messages_fts, rowid, text) VALUES ('delete', old.rowid, old.text);
  INSERT INTO messages_fts (rowid, text) VALUES (new.rowid, new.text);
END;

-- One row per accepted send. A retry replays its nonce and is refused here
-- instead of starting a second turn.
CREATE TABLE IF NOT EXISTS send_nonces (
  session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  nonce      TEXT NOT NULL,
  at         INTEGER NOT NULL,
  PRIMARY KEY (session_id, nonce)
);
"#;

/// Cheap content fingerprint. Blocks are append-mostly and only the tail
/// mutates, so a flush compares hashes and writes the handful of rows that
/// actually changed instead of rewriting the transcript every 600 ms.
pub fn fingerprint(block: &Block) -> u64 {
    let mut hasher = DefaultHasher::new();
    block.id.hash(&mut hasher);
    block.text.hash(&mut hasher);
    block.at.hash(&mut hasher);
    // The variable parts of a live row: a tool going from pending to completed,
    // an approval being decided, a question being answered.
    serde_json::to_string(&extra_of(block))
        .unwrap_or_default()
        .hash(&mut hasher);
    hasher.finish()
}

fn extra_of(block: &Block) -> Extra {
    Extra {
        hidden: block.hidden,
        streaming: block.streaming,
        files: block.files.clone(),
        tool: block.tool.clone(),
        approval: block.approval.clone(),
        question: block.question.clone(),
        usage: block.usage.clone(),
        from_agent: block.from_agent.clone(),
    }
}

fn role_str(role: &BlockRole) -> &'static str {
    match role {
        BlockRole::User => "user",
        BlockRole::Assistant => "assistant",
        BlockRole::Reasoning => "reasoning",
        BlockRole::Tool => "tool",
        BlockRole::Approval => "approval",
        BlockRole::Question => "question",
        BlockRole::System => "system",
    }
}

fn role_from(raw: &str) -> BlockRole {
    match raw {
        "user" => BlockRole::User,
        "reasoning" => BlockRole::Reasoning,
        "tool" => BlockRole::Tool,
        "approval" => BlockRole::Approval,
        "question" => BlockRole::Question,
        "system" => BlockRole::System,
        _ => BlockRole::Assistant,
    }
}

fn row_to_block(row: &rusqlite::Row, at: usize) -> rusqlite::Result<Block> {
    let role: String = row.get(at + 1)?;
    let extra: String = row.get(at + 4)?;
    let extra: Extra = serde_json::from_str(&extra).unwrap_or_default();
    Ok(Block {
        id: row.get(at)?,
        role: role_from(&role),
        text: row.get(at + 2)?,
        at: Some(row.get(at + 3)?),
        hidden: extra.hidden,
        streaming: extra.streaming,
        files: extra.files,
        tool: extra.tool,
        approval: extra.approval,
        question: extra.question,
        usage: extra.usage,
        from_agent: extra.from_agent,
    })
}

const BLOCK_COLUMNS: &str = "id, role, text, at, extra_json";

/// Write the blocks of one session, touching only the rows whose fingerprint
/// moved. `prior` is the caller's cache of the last written fingerprints and is
/// updated in place; pass an empty vec to force a full write.
pub fn sync(
    conn: &Connection,
    session_id: &str,
    blocks: &[Block],
    prior: &mut Vec<u64>,
) -> rusqlite::Result<()> {
    let next: Vec<u64> = blocks.iter().map(fingerprint).collect();
    let changed: Vec<usize> = (0..blocks.len())
        .filter(|index| prior.get(*index) != next.get(*index))
        .collect();
    let removed = prior.len() > blocks.len();
    if changed.is_empty() && !removed {
        return Ok(());
    }

    conn.execute_batch("BEGIN IMMEDIATE")?;
    let result = (|| -> rusqlite::Result<()> {
        {
            let mut stmt = conn.prepare_cached(
                "INSERT INTO messages (session_id, pos, id, role, text, at, extra_json)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
                 ON CONFLICT(session_id, pos) DO UPDATE SET
                   id = excluded.id, role = excluded.role, text = excluded.text,
                   at = excluded.at, extra_json = excluded.extra_json",
            )?;
            for index in changed {
                let block = &blocks[index];
                let extra = serde_json::to_string(&extra_of(block)).unwrap_or_else(|_| "{}".into());
                stmt.execute(params![
                    session_id,
                    index as i64 + 1,
                    block.id,
                    role_str(&block.role),
                    block.text,
                    block.at.unwrap_or_else(now_millis),
                    extra,
                ])?;
            }
        }
        if removed {
            conn.prepare_cached("DELETE FROM messages WHERE session_id = ?1 AND pos > ?2")?
                .execute(params![session_id, blocks.len() as i64])?;
        }
        Ok(())
    })();
    match result {
        Ok(()) => {
            conn.execute_batch("COMMIT")?;
            *prior = next;
            Ok(())
        }
        Err(err) => {
            let _ = conn.execute_batch("ROLLBACK");
            Err(err)
        }
    }
}

/// The last `limit` blocks, oldest first. `before_pos` pages backwards.
pub fn tail(
    store: &Store,
    session_id: String,
    limit: Option<u32>,
    before_pos: Option<i64>,
) -> Result<MessagePage, String> {
    let limit = limit.unwrap_or(DEFAULT_LIMIT).clamp(1, MAX_LIMIT) as i64;
    store.with(|conn| {
        let before = before_pos.unwrap_or(i64::MAX);
        let mut stmt = conn.prepare_cached(&format!(
            "SELECT {BLOCK_COLUMNS}, pos FROM messages
             WHERE session_id = ?1 AND pos < ?2
             ORDER BY pos DESC LIMIT ?3"
        ))?;
        let mut rows = stmt
            .query_map(params![session_id, before, limit], |row| {
                Ok((row.get::<_, i64>(5)?, row_to_block(row, 0)?))
            })?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        rows.reverse();
        let from_pos = rows.first().map(|(pos, _)| *pos).unwrap_or(0);
        let to_pos = rows.last().map(|(pos, _)| *pos).unwrap_or(0);
        let more = from_pos > 1;
        Ok(MessagePage {
            blocks: rows.into_iter().map(|(_, block)| block).collect(),
            from_pos,
            to_pos,
            more,
        })
    })
}

/// Everything after `pos`. What a client asks for when it reconnects holding a
/// stale transcript.
pub fn since(store: &Store, session_id: String, pos: i64) -> Result<MessagePage, String> {
    store.with(|conn| {
        let mut stmt = conn.prepare_cached(&format!(
            "SELECT {BLOCK_COLUMNS}, pos FROM messages
             WHERE session_id = ?1 AND pos > ?2
             ORDER BY pos ASC LIMIT ?3"
        ))?;
        let rows = stmt
            .query_map(params![session_id, pos, MAX_LIMIT], |row| {
                Ok((row.get::<_, i64>(5)?, row_to_block(row, 0)?))
            })?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        let from_pos = rows.first().map(|(pos, _)| *pos).unwrap_or(0);
        let to_pos = rows.last().map(|(pos, _)| *pos).unwrap_or(0);
        Ok(MessagePage {
            blocks: rows.into_iter().map(|(_, block)| block).collect(),
            from_pos,
            to_pos,
            more: false,
        })
    })
}

/// Turn what someone typed into an FTS5 expression. Everything is quoted, so a
/// stray paren or `AND` is searched for instead of parsed, and the last word
/// gets a prefix star so the results move while you type.
pub fn fts_query(raw: &str) -> Option<String> {
    let tokens: Vec<String> = raw
        .split_whitespace()
        .filter(|token| token.chars().any(|c| c.is_alphanumeric()))
        .map(|token| format!("\"{}\"", token.replace('"', "\"\"")))
        .collect();
    let (last, rest) = tokens.split_last()?;
    let mut parts: Vec<String> = rest.to_vec();
    parts.push(format!("{last}*"));
    Some(parts.join(" "))
}

pub fn search(store: &Store, query: SearchQuery) -> Result<Vec<SearchHit>, String> {
    let Some(expression) = fts_query(&query.query) else {
        return Ok(Vec::new());
    };
    let limit = query.limit.unwrap_or(DEFAULT_LIMIT).clamp(1, MAX_LIMIT) as i64;
    let offset = query.offset.unwrap_or(0) as i64;

    // The session filter is a variable-length IN list, so this one statement is
    // built rather than cached. Every value is still bound.
    let mut sql = format!(
        "SELECT m.session_id, s.name, m.pos, m.id, m.role, m.at,
                snippet(messages_fts, 0, '{}', '{}', '…', 12)
         FROM messages_fts
         JOIN messages m ON m.rowid = messages_fts.rowid
         JOIN sessions s ON s.id = m.session_id
         WHERE messages_fts MATCH ?1",
        MARK_OPEN, MARK_CLOSE
    );
    let mut binds: Vec<rusqlite::types::Value> = vec![expression.into()];
    if let Some(from) = query.from {
        binds.push(from.into());
        sql.push_str(&format!(" AND m.at >= ?{}", binds.len()));
    }
    if let Some(to) = query.to {
        binds.push(to.into());
        sql.push_str(&format!(" AND m.at <= ?{}", binds.len()));
    }
    if !query.session_ids.is_empty() {
        let first = binds.len() + 1;
        for id in &query.session_ids {
            binds.push(id.clone().into());
        }
        let holes: Vec<String> = (first..=binds.len()).map(|n| format!("?{n}")).collect();
        sql.push_str(&format!(" AND m.session_id IN ({})", holes.join(", ")));
    }
    binds.push(limit.into());
    binds.push(offset.into());
    sql.push_str(&format!(
        " ORDER BY bm25(messages_fts) ASC, m.at DESC LIMIT ?{} OFFSET ?{}",
        binds.len() - 1,
        binds.len()
    ));

    store.with(|conn| {
        let mut stmt = conn.prepare(&sql)?;
        let rows = stmt.query_map(rusqlite::params_from_iter(binds.iter()), |row| {
            Ok(SearchHit {
                session_id: row.get(0)?,
                session_name: row.get(1)?,
                pos: row.get(2)?,
                id: row.get(3)?,
                role: role_from(&row.get::<_, String>(4)?),
                at: row.get(5)?,
                snippet: row.get(6)?,
            })
        })?;
        rows.collect()
    })
}

/// Private-use characters: a snippet can contain any text the agent produced,
/// so the marks have to be something that text can never be.
pub const MARK_OPEN: char = '\u{e000}';
pub const MARK_CLOSE: char = '\u{e001}';

/// True the first time a nonce is seen for a session, false on a replay. The
/// caller starts a turn only when it is true.
pub fn claim_nonce(store: &Store, session_id: &str, nonce: &str) -> Result<bool, String> {
    store.with(|conn| {
        let rows = conn
            .prepare_cached(
                "INSERT INTO send_nonces (session_id, nonce, at) VALUES (?1, ?2, ?3)
                 ON CONFLICT (session_id, nonce) DO NOTHING",
            )?
            .execute(params![session_id, nonce, now_millis()])?;
        Ok(rows == 1)
    })
}

/// How many blocks a session has on disk. The transcript hub uses it to decide
/// whether its cache of fingerprints is still aligned with the table.
pub fn count(conn: &Connection, session_id: &str) -> rusqlite::Result<i64> {
    conn.prepare_cached("SELECT COUNT(*) FROM messages WHERE session_id = ?1")?
        .query_row(params![session_id], |row| row.get(0))
}

/// Read back the fingerprints of what is already stored, so a hub that just
/// hydrated does not rewrite a whole transcript on its first flush.
pub fn fingerprints(conn: &Connection, session_id: &str) -> rusqlite::Result<Vec<u64>> {
    let mut stmt = conn.prepare_cached(&format!(
        "SELECT {BLOCK_COLUMNS} FROM messages WHERE session_id = ?1 ORDER BY pos ASC"
    ))?;
    let rows = stmt.query_map(params![session_id], |row| row_to_block(row, 0))?;
    rows.map(|block| block.map(|block| fingerprint(&block)))
        .collect()
}

/// Fill the table from the `blocks_json` of every session. Runs once, inside
/// the v10 migration, so search covers the history that existed before it.
pub fn backfill(conn: &Connection) -> rusqlite::Result<usize> {
    let mut stmt = conn.prepare("SELECT id, blocks_json FROM sessions")?;
    let sessions = stmt
        .query_map([], |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?)))?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    drop(stmt);
    let mut written = 0;
    for (id, raw) in sessions {
        let blocks = crate::blocks::parse_blocks(Some(&raw));
        if blocks.is_empty() {
            continue;
        }
        sync(conn, &id, &blocks, &mut Vec::new())?;
        written += blocks.len();
    }
    Ok(written)
}

/// The last time each session produced a block. Cheap enough to read on the
/// list screen because of `messages_at_idx`.
pub fn last_activity(store: &Store, session_id: String) -> Result<Option<i64>, String> {
    store.with(|conn| {
        conn.prepare_cached("SELECT MAX(at) FROM messages WHERE session_id = ?1")?
            .query_row(params![session_id], |row| row.get::<_, Option<i64>>(0))
            .optional()
            .map(Option::flatten)
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::blocks::new_block;

    fn store() -> Store {
        let dir = std::env::temp_dir().join(format!("crew-messages-{}", uuid::Uuid::new_v4()));
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

    fn write(store: &Store, session_id: &str, blocks: &[Block]) {
        store
            .with(|conn| sync(conn, session_id, blocks, &mut Vec::new()))
            .expect("sync");
    }

    fn say(role: BlockRole, text: &str) -> Block {
        new_block(role, text)
    }

    #[test]
    fn sync_writes_blocks_and_reads_them_back_whole() {
        let store = store();
        let id = session(&store, "a");
        let mut tool = say(BlockRole::Tool, "ls");
        tool.tool = Some(BlockTool {
            call_id: "c1".into(),
            name: "Bash".into(),
            title: "ls".into(),
            status: crew_protocol::ToolStatus::Completed,
            detail: Some(crew_protocol::ToolDetail::Command {
                command: "ls -la".into(),
                exit_code: Some(0),
                output: Some("total 0".into()),
            }),
        });
        let blocks = vec![say(BlockRole::User, "hola"), tool];
        write(&store, &id, &blocks);

        let page = tail(&store, id, None, None).expect("tail");
        assert_eq!(page.blocks.len(), 2);
        assert_eq!(page.from_pos, 1);
        assert_eq!(page.to_pos, 2);
        assert!(!page.more);
        let detail = page.blocks[1].tool.as_ref().unwrap().detail.as_ref().unwrap();
        assert_eq!(detail.summary(), "ls -la");
    }

    #[test]
    fn sync_only_touches_the_rows_that_moved() {
        let store = store();
        let id = session(&store, "b");
        let mut blocks = vec![say(BlockRole::User, "one"), say(BlockRole::Assistant, "two")];
        let mut prior = Vec::new();
        store
            .with(|conn| sync(conn, &id, &blocks, &mut prior))
            .expect("first");
        assert_eq!(prior.len(), 2);

        // Rewriting the same blocks is a no-op: same fingerprints, no statement.
        let before = prior.clone();
        store
            .with(|conn| sync(conn, &id, &blocks, &mut prior))
            .expect("second");
        assert_eq!(before, prior);

        blocks[1].text = "two and a half".into();
        store
            .with(|conn| sync(conn, &id, &blocks, &mut prior))
            .expect("third");
        assert_ne!(before[1], prior[1]);
        assert_eq!(before[0], prior[0]);
        let page = tail(&store, id, None, None).expect("tail");
        assert_eq!(page.blocks[1].text, "two and a half");
    }

    #[test]
    fn sync_drops_rows_a_shorter_transcript_left_behind() {
        let store = store();
        let id = session(&store, "c");
        let blocks = vec![say(BlockRole::User, "one"), say(BlockRole::Assistant, "two")];
        let mut prior = Vec::new();
        store
            .with(|conn| sync(conn, &id, &blocks, &mut prior))
            .expect("write");
        store
            .with(|conn| sync(conn, &id, &blocks[..1], &mut prior))
            .expect("shrink");
        let page = tail(&store, id.clone(), None, None).expect("tail");
        assert_eq!(page.blocks.len(), 1);
        let left = store.with(|conn| count(conn, &id)).expect("count");
        assert_eq!(left, 1);
    }

    #[test]
    fn tail_pages_backwards_and_reports_more() {
        let store = store();
        let id = session(&store, "d");
        let blocks: Vec<Block> = (1..=10)
            .map(|n| say(BlockRole::Assistant, &format!("line {n}")))
            .collect();
        write(&store, &id, &blocks);

        let last = tail(&store, id.clone(), Some(3), None).expect("tail");
        assert_eq!(last.blocks.len(), 3);
        assert_eq!(last.blocks[0].text, "line 8");
        assert_eq!(last.from_pos, 8);
        assert!(last.more);

        let earlier = tail(&store, id, Some(3), Some(last.from_pos)).expect("page");
        assert_eq!(earlier.blocks[0].text, "line 5");
        assert_eq!(earlier.to_pos, 7);
        assert!(earlier.more);
    }

    #[test]
    fn tail_of_the_first_page_says_there_is_nothing_older() {
        let store = store();
        let id = session(&store, "e");
        write(&store, &id, &[say(BlockRole::User, "only")]);
        let page = tail(&store, id, Some(10), None).expect("tail");
        assert!(!page.more);
        assert_eq!(page.from_pos, 1);
    }

    #[test]
    fn since_returns_what_a_reconnecting_client_missed() {
        let store = store();
        let id = session(&store, "f");
        let blocks: Vec<Block> = (1..=5)
            .map(|n| say(BlockRole::Assistant, &format!("line {n}")))
            .collect();
        write(&store, &id, &blocks);
        let page = since(&store, id, 3).expect("since");
        assert_eq!(page.blocks.len(), 2);
        assert_eq!(page.blocks[0].text, "line 4");
        assert_eq!(page.from_pos, 4);
    }

    #[test]
    fn search_finds_a_word_and_marks_it() {
        let store = store();
        let id = session(&store, "searchable");
        write(
            &store,
            &id,
            &[
                say(BlockRole::User, "deploy the marketplace branch"),
                say(BlockRole::Assistant, "nothing to do with it"),
            ],
        );
        let hits = search(
            &store,
            SearchQuery {
                query: "marketplace".into(),
                ..Default::default()
            },
        )
        .expect("search");
        assert_eq!(hits.len(), 1);
        assert_eq!(hits[0].session_name, "searchable");
        assert_eq!(hits[0].pos, 1);
        assert!(hits[0].snippet.contains(MARK_OPEN));
    }

    #[test]
    fn search_filters_by_date_and_session() {
        let store = store();
        let one = session(&store, "one");
        let two = session(&store, "two");
        let mut old = say(BlockRole::User, "shared word");
        old.at = Some(1_000);
        let mut new = say(BlockRole::User, "shared word");
        new.at = Some(9_000);
        write(&store, &one, &[old]);
        write(&store, &two, &[new]);

        let by_date = search(
            &store,
            SearchQuery {
                query: "shared".into(),
                from: Some(5_000),
                ..Default::default()
            },
        )
        .expect("date");
        assert_eq!(by_date.len(), 1);
        assert_eq!(by_date[0].session_name, "two");

        let by_session = search(
            &store,
            SearchQuery {
                query: "shared".into(),
                session_ids: vec![one.clone()],
                ..Default::default()
            },
        )
        .expect("session");
        assert_eq!(by_session.len(), 1);
        assert_eq!(by_session[0].session_id, one);
    }

    #[test]
    fn search_sees_an_edit_and_forgets_the_old_text() {
        let store = store();
        let id = session(&store, "edited");
        let mut blocks = vec![say(BlockRole::Assistant, "kubernetes")];
        let mut prior = Vec::new();
        store
            .with(|conn| sync(conn, &id, &blocks, &mut prior))
            .expect("write");
        blocks[0].text = "podman".into();
        store
            .with(|conn| sync(conn, &id, &blocks, &mut prior))
            .expect("update");

        let stale = search(
            &store,
            SearchQuery { query: "kubernetes".into(), ..Default::default() },
        )
        .expect("stale");
        assert!(stale.is_empty(), "the index still holds replaced text");
        let fresh = search(
            &store,
            SearchQuery { query: "podman".into(), ..Default::default() },
        )
        .expect("fresh");
        assert_eq!(fresh.len(), 1);
    }

    #[test]
    fn search_survives_punctuation_that_fts_would_read_as_syntax() {
        let store = store();
        let id = session(&store, "punct");
        write(&store, &id, &[say(BlockRole::Assistant, "call foo(bar) now")]);
        for query in ["foo(bar", "foo(bar)", "AND foo", "\"quoted"] {
            let hits = search(
                &store,
                SearchQuery { query: query.into(), ..Default::default() },
            );
            assert!(hits.is_ok(), "{query} raised {:?}", hits.err());
        }
    }

    #[test]
    fn a_query_of_only_punctuation_finds_nothing_instead_of_failing() {
        let store = store();
        let id = session(&store, "empty");
        write(&store, &id, &[say(BlockRole::Assistant, "text")]);
        let hits = search(&store, SearchQuery { query: "!!! ???".into(), ..Default::default() })
            .expect("search");
        assert!(hits.is_empty());
    }

    #[test]
    fn fts_query_quotes_every_token_and_makes_the_last_one_a_prefix() {
        assert_eq!(fts_query("foo bar"), Some("\"foo\" \"bar\"*".into()));
        assert_eq!(fts_query("foo(bar)"), Some("\"foo(bar)\"*".into()));
        assert_eq!(fts_query("say \"hi\""), Some("\"say\" \"\"\"hi\"\"\"*".into()));
        assert_eq!(fts_query("   "), None);
    }

    #[test]
    fn a_nonce_is_claimed_once() {
        let store = store();
        let id = session(&store, "nonce");
        assert!(claim_nonce(&store, &id, "n1").expect("first"));
        assert!(!claim_nonce(&store, &id, "n1").expect("replay"));
        assert!(claim_nonce(&store, &id, "n2").expect("other"));
    }

    #[test]
    fn deleting_a_session_takes_its_messages_with_it() {
        let store = store();
        let id = session(&store, "doomed");
        write(&store, &id, &[say(BlockRole::User, "bye")]);
        crate::session::delete(&store, id.clone()).expect("delete");
        let left = store.with(|conn| count(conn, &id)).expect("count");
        assert_eq!(left, 0);
        let hits = search(&store, SearchQuery { query: "bye".into(), ..Default::default() })
            .expect("search");
        assert!(hits.is_empty(), "the index outlived the session");
    }

    #[test]
    fn fingerprints_read_back_match_what_was_written() {
        let store = store();
        let id = session(&store, "prints");
        let blocks = vec![say(BlockRole::User, "one"), say(BlockRole::Assistant, "two")];
        let mut prior = Vec::new();
        store
            .with(|conn| sync(conn, &id, &blocks, &mut prior))
            .expect("write");
        let read = store.with(|conn| fingerprints(conn, &id)).expect("read");
        assert_eq!(read, prior, "a fresh hub would rewrite rows that never changed");
    }
}
