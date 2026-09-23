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
    AgentRef, AttachedFile, Block, BlockApproval, BlockQuestion, BlockRole, BlockTool,
    SearchHit, SearchQuery, SearchSort, TurnUsage,
};
use rusqlite::{params, Connection};
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
/// Feeds serde straight into the hasher. The payload is only ever hashed, so
/// building the string first is a megabyte of allocation per flush that nobody
/// reads.
struct HashSink<'a>(&'a mut DefaultHasher);

impl std::io::Write for HashSink<'_> {
    fn write(&mut self, buf: &[u8]) -> std::io::Result<usize> {
        self.0.write(buf);
        Ok(buf.len())
    }

    fn flush(&mut self) -> std::io::Result<()> {
        Ok(())
    }
}

pub fn fingerprint(block: &Block) -> u64 {
    let mut hasher = DefaultHasher::new();
    block.id.hash(&mut hasher);
    // Everything the row stores, or a change to a column the hash ignores
    // would leave the table holding the old value forever.
    role_str(&block.role).hash(&mut hasher);
    block.text.hash(&mut hasher);
    block.at.hash(&mut hasher);
    // The variable parts of a live row: a tool going from pending to completed,
    // an approval being decided, a question being answered.
    let _ = serde_json::to_writer(HashSink(&mut hasher), &extra_of(block));
    hasher.finish()
}

/// The same shape as `Extra`, borrowed. A flush fingerprints every block, and
/// cloning each one's payload to do it copies the whole transcript.
#[derive(Serialize)]
struct ExtraRef<'a> {
    #[serde(skip_serializing_if = "Option::is_none")]
    hidden: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    streaming: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    files: Option<&'a Vec<AttachedFile>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    tool: Option<&'a BlockTool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    approval: Option<&'a BlockApproval>,
    #[serde(skip_serializing_if = "Option::is_none")]
    question: Option<&'a BlockQuestion>,
    #[serde(skip_serializing_if = "Option::is_none")]
    usage: Option<&'a TurnUsage>,
    #[serde(skip_serializing_if = "Option::is_none")]
    from_agent: Option<&'a AgentRef>,
}

fn extra_of(block: &Block) -> ExtraRef<'_> {
    ExtraRef {
        hidden: block.hidden,
        streaming: block.streaming,
        files: block.files.as_ref(),
        tool: block.tool.as_ref(),
        approval: block.approval.as_ref(),
        question: block.question.as_ref(),
        usage: block.usage.as_ref(),
        from_agent: block.from_agent.as_ref(),
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

    // A savepoint, not a transaction: the v13 migration wraps its own repair in
    // one, and a transaction inside a transaction is an error.
    conn.execute_batch("SAVEPOINT crew_sync")?;
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
            conn.execute_batch("RELEASE crew_sync")?;
            *prior = next;
            Ok(())
        }
        Err(err) => {
            let _ = conn.execute_batch("ROLLBACK TO crew_sync; RELEASE crew_sync");
            Err(err)
        }
    }
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
         WHERE messages_fts MATCH ?1
           -- A hidden block is not part of the conversation anyone reads: a
           -- routine's wake-up prompt is sent that way.
           AND json_extract(m.extra_json, '$.hidden') IS NOT 1",
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
    if let Some(workspace_id) = &query.workspace_id {
        binds.push(workspace_id.clone().into());
        sql.push_str(&format!(" AND s.workspace_id = ?{}", binds.len()));
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
    // Relevance still falls back to recency, because two lines that match a
    // one-word query equally well are best answered newest first.
    let order = match query.sort.unwrap_or_default() {
        SearchSort::Relevance => "bm25(messages_fts) ASC, m.at DESC",
        SearchSort::Newest => "m.at DESC",
    };
    sql.push_str(&format!(
        " ORDER BY {order} LIMIT ?{} OFFSET ?{}",
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
/// A replayed send arrives within seconds of the first; anything older is a
/// row nobody will ever look at again.
const NONCE_TTL_MS: i64 = 24 * 60 * 60 * 1000;

pub fn claim_nonce(store: &Store, session_id: &str, nonce: &str) -> Result<bool, String> {
    store.with(|conn| {
        conn.prepare_cached("DELETE FROM send_nonces WHERE at < ?1")?
            .execute(params![now_millis() - NONCE_TTL_MS])?;
        let rows = conn
            .prepare_cached(
                "INSERT INTO send_nonces (session_id, nonce, at) VALUES (?1, ?2, ?3)
                 ON CONFLICT (session_id, nonce) DO NOTHING",
            )?
            .execute(params![session_id, nonce, now_millis()])?;
        Ok(rows == 1)
    })
}

/// Give a nonce back, for a send that was accepted here and then refused by the
/// runtime. Without this a retry of a turn that never ran is answered as if it
/// had.
pub fn release_nonce(store: &Store, session_id: &str, nonce: &str) -> Result<(), String> {
    store.with(|conn| {
        conn.prepare_cached("DELETE FROM send_nonces WHERE session_id = ?1 AND nonce = ?2")?
            .execute(params![session_id, nonce])
    })?;
    Ok(())
}

/// How many blocks a session has on disk. The transcript hub uses it to decide
/// whether its cache of fingerprints is still aligned with the table.
pub fn count(conn: &Connection, session_id: &str) -> rusqlite::Result<i64> {
    conn.prepare_cached("SELECT COUNT(*) FROM messages WHERE session_id = ?1")?
        .query_row(params![session_id], |row| row.get(0))
}

/// Every block of a session, in order. Nothing in production pages the table —
/// the hub answers windows from memory — so this is the one way to read it.
pub fn all(conn: &Connection, session_id: &str) -> rusqlite::Result<Vec<Block>> {
    let mut stmt = conn.prepare_cached(&format!(
        "SELECT {BLOCK_COLUMNS} FROM messages WHERE session_id = ?1 ORDER BY pos ASC"
    ))?;
    let rows = stmt.query_map(params![session_id], |row| row_to_block(row, 0))?;
    rows.collect()
}

/// Read back the fingerprints of what is already stored, so a hub that just
/// hydrated does not rewrite a whole transcript on its first flush.
pub fn fingerprints(conn: &Connection, session_id: &str) -> rusqlite::Result<Vec<u64>> {
    Ok(all(conn, session_id)?.iter().map(fingerprint).collect())
}

/// Top up any session whose rows fell behind the column, before the column
/// goes away. A sync that failed and was never retried is the case this exists
/// for; everything else is already a no-op by fingerprint.
pub fn backfill_missing(conn: &Connection) -> rusqlite::Result<usize> {
    let mut stmt = conn.prepare("SELECT id, blocks_json FROM sessions")?;
    let sessions = stmt
        .query_map([], |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?)))?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    drop(stmt);
    let mut repaired = 0;
    for (id, raw) in sessions {
        let blocks = crate::blocks::parse_blocks(Some(&raw));
        // Content, not length. The old flush wrote the column and the rows in
        // two transactions, so the ways the rows fall behind without the count
        // moving are the common ones: text that grew, a tool that completed, a
        // turn that attached its usage.
        let mut prior = fingerprints(conn, &id)?;
        let before = prior.clone();
        sync(conn, &id, &blocks, &mut prior)?;
        if prior != before {
            repaired += 1;
        }
    }
    Ok(repaired)
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

#[cfg(test)]
mod tests {
    use super::*;
    use crate::blocks::new_block;
    use crate::test_support::temp_store;

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

        let stored = store.with(|conn| all(conn, &id)).expect("read back");
        assert_eq!(stored.len(), 2);
        assert_eq!(stored[0].text, "hola");
        let detail = stored[1].tool.as_ref().unwrap().detail.as_ref().unwrap();
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
        let stored = store.with(|conn| all(conn, &id)).expect("read back");
        assert_eq!(stored[1].text, "two and a half");
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
        let left = store.with(|conn| count(conn, &id)).expect("count");
        assert_eq!(left, 1);
        let stored = store.with(|conn| all(conn, &id)).expect("read back");
        assert_eq!(stored.len(), 1, "the row the shorter transcript dropped is still there");
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
    fn newest_first_ignores_how_well_a_line_matches() {
        let store = store();
        let id = session(&store, "sorted");
        let mut strong = say(BlockRole::Assistant, "deploy deploy deploy");
        strong.at = Some(1_000);
        let mut recent = say(BlockRole::Assistant, "a deploy happened here today somewhere");
        recent.at = Some(9_000);
        write(&store, &id, &[strong, recent]);

        let best = search(&store, SearchQuery { query: "deploy".into(), ..Default::default() })
            .expect("relevance");
        assert_eq!(best[0].at, 1_000, "bm25 should favour the denser line");

        let newest = search(
            &store,
            SearchQuery {
                query: "deploy".into(),
                sort: Some(SearchSort::Newest),
                ..Default::default()
            },
        )
        .expect("newest");
        assert_eq!(newest[0].at, 9_000);
    }

    #[test]
    fn an_old_nonce_is_swept_so_the_table_does_not_grow_forever() {
        let store = store();
        let id = session(&store, "sweep");
        store
            .with(|conn| {
                conn.execute(
                    "INSERT INTO send_nonces (session_id, nonce, at) VALUES (?1, ?2, ?3)",
                    params![id, "ancient", now_millis() - NONCE_TTL_MS - 1],
                )
            })
            .expect("seed");
        claim_nonce(&store, &id, "fresh").expect("claim");
        let left: i64 = store
            .with(|conn| {
                conn.query_row("SELECT COUNT(*) FROM send_nonces", [], |row| row.get(0))
            })
            .expect("count");
        assert_eq!(left, 1, "the sweep kept a nonce nobody will ever replay");
    }

    #[test]
    fn a_turn_that_never_ran_gives_its_nonce_back() {
        let store = store();
        let id = session(&store, "refused");
        assert!(claim_nonce(&store, &id, "n1").expect("first"));
        release_nonce(&store, &id, "n1").expect("release");
        assert!(
            claim_nonce(&store, &id, "n1").expect("retry"),
            "the retry of a refused send was treated as a duplicate"
        );
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

    /// An agent in a workspace of its own, on a folder inside `dir`.
    fn agent_in(dir: &tempfile::TempDir, store: &Store, name: &str) -> crate::session::Session {
        let folder = dir.path().join(name);
        std::fs::create_dir(&folder).expect("folder");
        let workspace =
            crate::workspace::create(store, name.into(), folder.to_string_lossy().into())
                .expect("workspace");
        second_agent(store, &workspace.id, name)
    }

    fn second_agent(store: &Store, workspace_id: &str, name: &str) -> crate::session::Session {
        crate::session::create(
            store,
            workspace_id.into(),
            "agent".into(),
            name.into(),
            "claude".into(),
            "m".into(),
            "".into(),
            "ask".into(),
        )
        .expect("session")
    }

    fn at(role: BlockRole, text: &str, at: i64) -> Block {
        let mut block = new_block(role, text);
        block.at = Some(at);
        block
    }

    fn hits(store: &Store, query: SearchQuery) -> Vec<SearchHit> {
        search(store, query).expect("search")
    }

    fn ats(hits: &[SearchHit]) -> Vec<i64> {
        hits.iter().map(|hit| hit.at).collect()
    }

    fn sessions_hit(hits: &[SearchHit]) -> Vec<String> {
        let mut names: Vec<String> = hits.iter().map(|hit| hit.session_name.clone()).collect();
        names.sort();
        names
    }

    const ROLES: [BlockRole; 7] = [
        BlockRole::User,
        BlockRole::Assistant,
        BlockRole::Reasoning,
        BlockRole::Tool,
        BlockRole::Approval,
        BlockRole::Question,
        BlockRole::System,
    ];

    #[test]
    fn every_role_survives_a_row_and_comes_back_on_its_search_hit() {
        let (dir, store) = temp_store();
        let id = agent_in(&dir, &store, "roles").id;
        let blocks: Vec<Block> =
            ROLES.iter().map(|role| say(role.clone(), &format!("needle {role:?}"))).collect();
        write(&store, &id, &blocks);

        let stored = store.with(|conn| all(conn, &id)).expect("read back");
        assert_eq!(stored.iter().map(|b| b.role.clone()).collect::<Vec<_>>(), ROLES);
        let found = hits(
            &store,
            SearchQuery { query: "needle".into(), limit: Some(10), ..Default::default() },
        );
        let mut roles: Vec<(i64, BlockRole)> =
            found.into_iter().map(|hit| (hit.pos, hit.role)).collect();
        roles.sort_by_key(|(pos, _)| *pos);
        assert_eq!(roles.into_iter().map(|(_, role)| role).collect::<Vec<_>>(), ROLES);
    }

    #[test]
    fn a_date_range_keeps_both_of_its_ends() {
        let (dir, store) = temp_store();
        let id = agent_in(&dir, &store, "dated").id;
        write(
            &store,
            &id,
            &[
                at(BlockRole::User, "shared word", 1_000),
                at(BlockRole::User, "shared word", 5_000),
                at(BlockRole::User, "shared word", 9_000),
            ],
        );
        let range = |from: Option<i64>, to: Option<i64>| {
            ats(&hits(
                &store,
                SearchQuery {
                    query: "shared".into(),
                    from,
                    to,
                    sort: Some(SearchSort::Newest),
                    ..Default::default()
                },
            ))
        };

        assert_eq!(range(Some(1_000), Some(5_000)), [5_000, 1_000]);
        assert_eq!(range(None, Some(4_999)), [1_000]);
        assert_eq!(range(Some(5_001), None), [9_000]);
        assert!(range(Some(6_000), Some(2_000)).is_empty());
    }

    /// The workspace and the session list narrow the same search, so asking
    /// for a session of another workspace finds nothing.
    #[test]
    fn a_search_stays_inside_the_workspace_and_the_sessions_asked_for() {
        let (dir, store) = temp_store();
        let one = agent_in(&dir, &store, "one");
        let two = second_agent(&store, &one.workspace_id, "two");
        let other = agent_in(&dir, &store, "other");
        for id in [&one.id, &two.id, &other.id] {
            write(&store, id, &[say(BlockRole::Assistant, "kubernetes")]);
        }
        let find = |workspace_id: Option<&String>, session_ids: &[&String]| {
            sessions_hit(&hits(
                &store,
                SearchQuery {
                    query: "kubernetes".into(),
                    workspace_id: workspace_id.cloned(),
                    session_ids: session_ids.iter().map(|id| id.to_string()).collect(),
                    ..Default::default()
                },
            ))
        };

        assert_eq!(find(None, &[]), ["one", "other", "two"]);
        assert_eq!(find(Some(&one.workspace_id), &[]), ["one", "two"]);
        assert_eq!(find(Some(&one.workspace_id), &[&two.id]), ["two"]);
        assert_eq!(find(None, &[&one.id, &other.id]), ["one", "other"]);
        assert!(find(Some(&one.workspace_id), &[&other.id]).is_empty());
    }

    #[test]
    fn a_search_pages_with_a_limit_and_an_offset_it_keeps_in_bounds() {
        let (dir, store) = temp_store();
        let id = agent_in(&dir, &store, "paged").id;
        let blocks: Vec<Block> = (1..=5).map(|n| at(BlockRole::User, "page", n)).collect();
        write(&store, &id, &blocks);
        let page = |limit: Option<u32>, offset: Option<u32>| {
            ats(&hits(
                &store,
                SearchQuery {
                    query: "page".into(),
                    limit,
                    offset,
                    sort: Some(SearchSort::Newest),
                    ..Default::default()
                },
            ))
        };

        assert_eq!(page(Some(2), None), [5, 4]);
        assert_eq!(page(Some(2), Some(2)), [3, 2]);
        assert_eq!(page(Some(2), Some(4)), [1]);
        assert!(page(Some(2), Some(5)).is_empty());
        assert_eq!(page(Some(0), None), [5], "a limit of nothing is a limit of one");
        assert_eq!(page(Some(100_000), None), [5, 4, 3, 2, 1]);
        assert_eq!(page(None, None), [5, 4, 3, 2, 1]);
    }

    /// Whatever FTS5 would read as syntax is searched for as text: the words
    /// around it still find the line, and none of it is an error.
    #[test]
    fn fts_syntax_in_a_query_is_searched_for_not_parsed() {
        let (dir, store) = temp_store();
        let id = agent_in(&dir, &store, "syntax");
        write(
            &store,
            &id.id,
            &[say(BlockRole::Assistant, "call foo(bar) NEAR the a-b text:done \"quoted\" ^top")],
        );

        for (query, found) in [
            ("foo(bar", 1),
            ("foo)", 1),
            ("NEAR", 1),
            ("a-b", 1),
            ("text:done", 1),
            ("\"quoted", 1),
            ("^top", 1),
            ("-foo", 1),
            ("foo AND", 0),
            ("OR", 0),
            ("NOT foo", 0),
            ("*", 0),
            ("\"", 0),
        ] {
            let got = search(&store, SearchQuery { query: query.into(), ..Default::default() });
            assert_eq!(got.map(|hits| hits.len()), Ok(found), "{query}");
        }
    }

    #[test]
    fn a_nonce_belongs_to_one_session_and_one_that_does_not_exist_is_refused() {
        let (dir, store) = temp_store();
        let one = agent_in(&dir, &store, "one").id;
        let two = agent_in(&dir, &store, "two").id;

        assert!(claim_nonce(&store, &one, "n1").expect("one"));
        assert!(claim_nonce(&store, &two, "n1").expect("two"), "a nonce was shared across sessions");
        assert!(!claim_nonce(&store, &two, "n1").expect("replay"));
        assert!(claim_nonce(&store, "nobody", "n1").is_err());
    }

    /// A sync is one savepoint: a write that fails part way through lands no
    /// row and leaves the caller's cache alone, so the next flush redoes it.
    #[test]
    fn a_sync_that_fails_part_way_lands_nothing_and_keeps_the_cache() {
        let (dir, store) = temp_store();
        let id = agent_in(&dir, &store, "failing").id;
        let mut blocks = vec![say(BlockRole::User, "one")];
        let mut prior = Vec::new();
        store.with(|conn| sync(conn, &id, &blocks, &mut prior)).expect("first");
        let cached = prior.clone();
        store
            .with(|conn| {
                conn.execute_batch(
                    "CREATE TRIGGER full BEFORE INSERT ON messages WHEN new.pos = 3
                     BEGIN SELECT RAISE(FAIL, 'disk full'); END;",
                )
            })
            .expect("trap");
        blocks[0].text = "one, edited".into();
        blocks.push(say(BlockRole::Assistant, "two"));
        blocks.push(say(BlockRole::Assistant, "three"));

        let failed = store.with(|conn| sync(conn, &id, &blocks, &mut prior));

        assert!(failed.is_err_and(|e| e.contains("disk full")));
        assert_eq!(prior, cached);
        let stored = store.with(|conn| all(conn, &id)).expect("read back");
        assert_eq!(stored.iter().map(|b| b.text.as_str()).collect::<Vec<_>>(), ["one"]);
        store.with(|conn| conn.execute_batch("DROP TRIGGER full;")).expect("untrap");

        store.with(|conn| sync(conn, &id, &blocks, &mut prior)).expect("retry");
        assert_eq!(store.with(|conn| count(conn, &id)).expect("count"), 3);
    }

    #[test]
    fn backfill_writes_every_session_with_history_and_passes_over_the_rest() {
        let (dir, store) = temp_store();
        let talked = agent_in(&dir, &store, "talked").id;
        let quiet = agent_in(&dir, &store, "quiet").id;
        let garbled = agent_in(&dir, &store, "garbled").id;
        let history = [say(BlockRole::User, "hello"), say(BlockRole::Assistant, "hi")];
        store
            .with(|conn| {
                conn.execute_batch(
                    "ALTER TABLE sessions ADD COLUMN blocks_json TEXT NOT NULL DEFAULT '[]';",
                )?;
                let json = serde_json::to_string(&history).expect("json");
                conn.execute("UPDATE sessions SET blocks_json = ?2 WHERE id = ?1", params![talked, json])?;
                conn.execute("UPDATE sessions SET blocks_json = 'nope' WHERE id = ?1", params![garbled])
            })
            .expect("column");

        let written = store.with(backfill).expect("backfill");

        assert_eq!(written, 2);
        let stored = store.with(|conn| all(conn, &talked)).expect("rows");
        assert_eq!(stored.iter().map(|b| b.text.as_str()).collect::<Vec<_>>(), ["hello", "hi"]);
        for id in [&quiet, &garbled] {
            assert_eq!(store.with(|conn| count(conn, id)).expect("count"), 0);
        }
    }

    #[test]
    fn the_hash_sink_has_nothing_to_flush() {
        use std::io::Write;
        let mut hasher = DefaultHasher::new();
        HashSink(&mut hasher).write_all(b"block").expect("write");
        let before = hasher.clone().finish();

        HashSink(&mut hasher).flush().expect("flush");

        assert_eq!(hasher.finish(), before);
    }
}

#[cfg(test)]
mod review_tests {
    use super::*;
    use crate::blocks::new_block;

    fn workspace_of(store: &Store, session_id: &str) -> Option<String> {
        crate::session::get(store, session_id.to_string())
            .ok()
            .flatten()
            .map(|row| row.workspace_id)
    }

    fn store() -> Store {
        let dir = std::env::temp_dir().join(format!("crew-review-{}", uuid::Uuid::new_v4()));
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

    /// A cascade delete does not fire the `messages_ad` trigger, so the FTS
    /// index keeps the rowid of a row that is gone. The next insert reuses that
    /// rowid and inherits the dead session's words.
    #[test]
    fn a_deleted_session_does_not_lend_its_words_to_the_next_one() {
        let store = store();
        let doomed = session(&store, "doomed");
        write(&store, &doomed, &[say(BlockRole::Assistant, "kubernetes")]);
        crate::session::delete(&store, doomed).expect("delete");

        let fresh = session(&store, "fresh");
        write(&store, &fresh, &[say(BlockRole::Assistant, "podman")]);

        let hits = search(
            &store,
            SearchQuery { query: "kubernetes".into(), ..Default::default() },
        )
        .expect("search");
        assert!(
            hits.is_empty(),
            "a deleted session's word still matches, and it points at {:?}",
            hits.iter().map(|h| (h.session_name.clone(), h.snippet.clone())).collect::<Vec<_>>()
        );
    }

    /// FTS5 can check itself against its content table. After a session is
    /// deleted the two disagree.
    #[test]
    fn the_index_stays_consistent_with_the_table_after_a_delete() {
        let store = store();
        let doomed = session(&store, "doomed");
        write(&store, &doomed, &[say(BlockRole::Assistant, "kubernetes")]);
        crate::session::delete(&store, doomed).expect("delete");
        let check = store.with(|conn| {
            conn.execute_batch("INSERT INTO messages_fts (messages_fts) VALUES ('integrity-check')")
        });
        assert!(check.is_ok(), "fts5 integrity-check failed: {:?}", check.err());
    }

    /// The existing `sync_only_touches_the_rows_that_moved` compares
    /// fingerprints, which are the same whether or not a statement ran. This
    /// counts the rows SQLite actually wrote.
    #[test]
    fn sync_really_writes_only_the_rows_that_moved() {
        let store = store();
        let id = session(&store, "counted");
        let mut blocks: Vec<Block> = (0..200)
            .map(|n| say(BlockRole::Assistant, &format!("line {n}")))
            .collect();
        let mut prior = Vec::new();
        store.with(|conn| sync(conn, &id, &blocks, &mut prior)).expect("first");

        let changes = |store: &Store| store.with(|conn| Ok(conn.total_changes())).expect("changes");

        let before = changes(&store);
        store.with(|conn| sync(conn, &id, &blocks, &mut prior)).expect("noop");
        let noop = changes(&store) - before;

        let before = changes(&store);
        blocks.last_mut().unwrap().text.push_str(" and more");
        store.with(|conn| sync(conn, &id, &blocks, &mut prior)).expect("tail");
        let one = changes(&store) - before;

        let before = changes(&store);
        blocks.push(say(BlockRole::Assistant, "brand new"));
        store.with(|conn| sync(conn, &id, &blocks, &mut prior)).expect("append");
        let appended = changes(&store) - before;

        println!("no-op flush: {noop} rows; tail edit: {one}; append: {appended}");
        assert_eq!(noop, 0, "a flush with nothing new still wrote {noop} rows");
        assert!(one < 20, "editing the last block wrote {one} rows");
        assert!(appended < 20, "appending one block wrote {appended} rows");
    }

    /// FTS5 external-content tables corrupt silently if a 'delete' command is
    /// given text other than what was indexed. The upsert path churns rows;
    /// check the index still agrees with the table afterwards.
    #[test]
    fn the_index_survives_the_upsert_churn() {
        let store = store();
        let id = session(&store, "churn");
        let mut blocks: Vec<Block> = (0..50)
            .map(|n| say(BlockRole::Assistant, &format!("word{n}")))
            .collect();
        let mut prior = Vec::new();
        for round in 0..10 {
            for (n, block) in blocks.iter_mut().enumerate() {
                block.text = format!("round{round} word{n}");
            }
            store.with(|conn| sync(conn, &id, &blocks, &mut prior)).expect("sync");
        }
        blocks.truncate(10);
        store.with(|conn| sync(conn, &id, &blocks, &mut prior)).expect("shrink");
        let check = store.with(|conn| {
            conn.execute_batch("INSERT INTO messages_fts (messages_fts) VALUES ('integrity-check')")
        });
        assert!(check.is_ok(), "fts5 integrity-check failed: {:?}", check.err());
        let stale = search(&store, SearchQuery { query: "round3".into(), ..Default::default() })
            .expect("stale");
        assert!(stale.is_empty(), "the index still holds text from round 3: {stale:?}");
    }

    /// An empty `session_ids` drops the filter entirely rather than matching
    /// nothing, so the Search page's "All agents" — which sends `[]` when no
    /// single agent is picked (src/surfaces/SearchView.tsx) — reads every
    /// workspace, not the one that is open.
    #[test]
    fn an_empty_session_filter_does_not_reach_into_other_workspaces() {
        let store = store();
        let mine = session(&store, "mine");
        let theirs = session(&store, "theirs"); // its own workspace
        write(&store, &mine, &[say(BlockRole::Assistant, "kubernetes here")]);
        write(&store, &theirs, &[say(BlockRole::Assistant, "kubernetes there")]);

        let hits = search(
            &store,
            SearchQuery {
                query: "kubernetes".into(),
                workspace_id: workspace_of(&store, &mine),
                session_ids: Vec::new(),
                ..Default::default()
            },
        )
        .expect("search");
        let names: Vec<String> = hits.iter().map(|hit| hit.session_name.clone()).collect();
        assert_eq!(names, vec!["mine".to_string()], "the search crossed workspaces: {names:?}");
    }

    /// The upsert is keyed by `pos`, not by the block id the plan specified
    /// (docs/plans/2026-09-17-harness.md, `messages_id_idx`). The cheap path is therefore
    /// only correct and only cheap while blocks are strictly append-only:
    /// one block arriving anywhere else renumbers everything after it.
    #[test]
    fn a_block_inserted_anywhere_but_the_end_rewrites_the_whole_transcript() {
        let store = store();
        let id = session(&store, "shift");
        let mut blocks: Vec<Block> = (1..=200)
            .map(|n| say(BlockRole::Assistant, &format!("line {n}")))
            .collect();
        let mut prior = Vec::new();
        store.with(|conn| sync(conn, &id, &blocks, &mut prior)).expect("first");

        blocks.insert(0, say(BlockRole::User, "an earlier line"));
        let before = store.with(|conn| Ok(conn.total_changes())).expect("changes");
        store.with(|conn| sync(conn, &id, &blocks, &mut prior)).expect("shifted");
        let written = store.with(|conn| Ok(conn.total_changes())).expect("changes") - before;
        println!("one new block at the head rewrote {written} rows");
        assert!(written > 200, "expected the whole transcript to be rewritten");
    }

    /// `fingerprint` hashes id, text, at and the extra payload — but not the
    /// role column it also writes. Two blocks that differ only in role are
    /// indistinguishable to the cache, so a role change in place would never
    /// reach the table.
    #[test]
    fn the_fingerprint_ignores_the_role_it_stores() {
        let mut one = say(BlockRole::Assistant, "same words");
        let mut two = one.clone();
        two.role = BlockRole::System;
        assert_ne!(
            fingerprint(&one),
            fingerprint(&two),
            "a role change is invisible to the write path"
        );
        one.text.push('!');
        assert_ne!(fingerprint(&one), fingerprint(&two), "sanity");
    }

    /// The comparison itself is not free: every flush re-serialises every
    /// block's optional payload to JSON just to hash it, on top of the
    /// `blocks_json` dump. This is the cost of a 600 ms debounce tick on a long
    /// transcript in which nothing changed.
    /// An instrument, not an assertion: `cargo test -- --ignored --nocapture`.
    /// Left out of the default run because it starves the tests that wait on a
    /// timeout.
    #[test]
    #[ignore]
    fn the_no_op_comparison_costs_a_full_json_pass() {
        let blocks: Vec<Block> = (0..2000)
            .map(|n| {
                let mut b = say(BlockRole::Tool, &format!("bash {n}"));
                b.tool = Some(BlockTool {
                    call_id: format!("c{n}"),
                    name: "Bash".into(),
                    title: format!("bash {n}"),
                    status: crew_protocol::ToolStatus::Completed,
                    detail: Some(crew_protocol::ToolDetail::Command {
                        command: format!("echo {n}"),
                        exit_code: Some(0),
                        output: Some("x".repeat(2048)),
                    }),
                });
                b
            })
            .collect();
        let start = std::time::Instant::now();
        for _ in 0..10 {
            let _: Vec<u64> = blocks.iter().map(fingerprint).collect();
        }
        println!("10 no-op fingerprint passes over 2000 tool blocks: {:?}", start.elapsed());
    }
}

#[cfg(test)]
mod plan_tests {
    use super::*;
    use crate::blocks::new_block;

    fn store() -> Store {
        let dir = std::env::temp_dir().join(format!("crew-plan-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).expect("dir");
        Store::open(dir.join("crew.sqlite3")).expect("store")
    }

    fn plan(store: &Store, sql: &str, binds: &[rusqlite::types::Value]) -> Vec<String> {
        store
            .with(|conn| {
                let mut stmt = conn.prepare(&format!("EXPLAIN QUERY PLAN {sql}"))?;
                let rows = stmt.query_map(rusqlite::params_from_iter(binds.iter()), |row| {
                    row.get::<_, String>(3)
                })?;
                rows.collect::<rusqlite::Result<Vec<_>>>()
            })
            .expect("plan")
    }

    /// An instrument, not an assertion: `cargo test -- --ignored --nocapture`.
    #[test]
    #[ignore]
    fn print_the_plans() {
        let store = store();
        let root = std::env::temp_dir().join(uuid::Uuid::new_v4().to_string());
        std::fs::create_dir_all(&root).expect("root");
        let ws = crate::workspace::create(&store, "w".into(), root.to_string_lossy().into())
            .expect("workspace");
        let mut ids = Vec::new();
        for n in 0..8 {
            let id = crate::session::create(
                &store,
                ws.id.clone(),
                "agent".into(),
                format!("a{n}"),
                "claude".into(),
                "m".into(),
                "".into(),
                "ask".into(),
            )
            .expect("session")
            .id;
            let blocks: Vec<Block> = (0..2000)
                .map(|i| {
                    let mut b = new_block(BlockRole::Assistant, format!("row {i} deploy word{i}"));
                    b.at = Some(1_700_000_000_000 + i as i64);
                    b
                })
                .collect();
            store
                .with(|conn| sync(conn, &id, &blocks, &mut Vec::new()))
                .expect("sync");
            ids.push(id);
        }
        store.with(|conn| conn.execute_batch("ANALYZE")).expect("analyze");

        let holes = ids.iter().enumerate().map(|(i, _)| format!("?{}", i + 4)).collect::<Vec<_>>().join(", ");
        let search_sql = format!(
            "SELECT m.session_id, s.name, m.pos, m.id, m.role, m.at,
                    snippet(messages_fts, 0, 'a', 'b', '…', 12)
             FROM messages_fts
             JOIN messages m ON m.rowid = messages_fts.rowid
             JOIN sessions s ON s.id = m.session_id
             WHERE messages_fts MATCH ?1 AND m.at >= ?2 AND m.at <= ?3
               AND m.session_id IN ({holes})
             ORDER BY bm25(messages_fts) ASC, m.at DESC LIMIT 50 OFFSET 0"
        );
        let newest_sql = search_sql.replace("bm25(messages_fts) ASC, m.at DESC", "m.at DESC");
        println!("--- search (fts + date + {} sessions) ---", ids.len());
        let mut binds: Vec<rusqlite::types::Value> = vec![
            "deploy".to_string().into(),
            0i64.into(),
            i64::MAX.into(),
        ];
        for id in &ids {
            binds.push(id.clone().into());
        }
        for line in plan(&store, &search_sql, &binds) {
            println!("  {line}");
        }
        println!("--- search, sort=newest ---");
        for line in plan(&store, &newest_sql, &binds) {
            println!("  {line}");
        }
        println!("--- tail ---");
        for line in plan(
            &store,
            "SELECT id, role, text, at, extra_json, pos FROM messages
             WHERE session_id = ?1 AND pos < ?2 ORDER BY pos DESC LIMIT ?3",
            &[ids[0].clone().into(), i64::MAX.into(), 50i64.into()],
        ) {
            println!("  {line}");
        }
        println!("--- last_activity ---");
        for line in plan(
            &store,
            "SELECT MAX(at) FROM messages WHERE session_id = ?1",
            &[ids[0].clone().into()],
        ) {
            println!("  {line}");
        }
        println!("--- fingerprints (hydrate) ---");
        for line in plan(
            &store,
            "SELECT id, role, text, at, extra_json FROM messages WHERE session_id = ?1 ORDER BY pos ASC",
            &[ids[0].clone().into()],
        ) {
            println!("  {line}");
        }

        // And the wall clock on the real path: 16k rows over 8 sessions.
        let start = std::time::Instant::now();
        let hits = search(
            &store,
            SearchQuery {
                query: "deploy".into(),
                session_ids: ids.clone(),
                from: Some(0),
                limit: Some(50),
                ..Default::default()
            },
        )
        .expect("search");
        println!("search over 16000 rows: {} hits in {:?}", hits.len(), start.elapsed());

        let start = std::time::Instant::now();
        let hits = search(
            &store,
            SearchQuery { query: "word7".into(), session_ids: ids, ..Default::default() },
        )
        .expect("search");
        println!("narrow search: {} hits in {:?}", hits.len(), start.elapsed());

        // The backfill the v10 migration runs at startup, on a database the
        // size of a few months of use.
        let raw = serde_json::to_string(
            &(0..2000)
                .map(|i| new_block(BlockRole::Assistant, format!("row {i} deploy word{i}")))
                .collect::<Vec<_>>(),
        )
        .unwrap();
        store
            .with(|conn| {
                // The column is gone from the current schema; the backfill only
                // ever runs while it still exists, so put it back to measure it.
                conn.execute_batch(
                    "DELETE FROM messages;
                     ALTER TABLE sessions ADD COLUMN blocks_json TEXT NOT NULL DEFAULT '[]';",
                )?;
                let mut stmt = conn.prepare("UPDATE sessions SET blocks_json = ?1")?;
                stmt.execute(rusqlite::params![raw])?;
                Ok(())
            })
            .expect("seed");
        let start = std::time::Instant::now();
        let written = store.with(backfill).expect("backfill");
        println!("backfill of {written} blocks over 8 sessions: {:?}", start.elapsed());
    }
}

/// Adversarial review of the A6 migration. Added by review; no production code
/// is touched.
#[cfg(test)]
mod drop_column_review {
    use super::*;
    use crate::blocks::new_block;

    fn store() -> Store {
        let dir = std::env::temp_dir().join(format!("crew-drop-{}", uuid::Uuid::new_v4()));
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

    /// Put the column back on a HEAD database, the way `print_the_plans`
    /// already does, so the pre-13 state can be built and migrated.
    fn with_column(store: &Store, id: &str, blocks: &[Block]) {
        let raw = serde_json::to_string(blocks).expect("json");
        store
            .with(|conn| {
                conn.execute_batch(
                    "ALTER TABLE sessions ADD COLUMN blocks_json TEXT NOT NULL DEFAULT '[]';",
                )?;
                conn.execute(
                    "UPDATE sessions SET blocks_json = ?1 WHERE id = ?2",
                    params![raw, id],
                )?;
                Ok(())
            })
            .expect("column");
    }

    /// `backfill_missing` decides a session is behind by comparing
    /// `blocks.len()` with `COUNT(*)`. A flush that died between the blob write
    /// and the row write leaves the rows behind in *content* with the same
    /// count — a streaming answer that grew, a tool row that went
    /// pending -> completed. Migration 13 then drops the only copy that had it.
    #[test]
    fn backfill_missing_walks_past_rows_that_are_stale_without_being_short() {
        let store = store();
        let id = session(&store, "drift");

        // What the last flush that landed wrote.
        let mut rows = vec![
            new_block(BlockRole::User, "summarise the plan".to_string()),
            new_block(BlockRole::Assistant, "The plan is".to_string()),
        ];
        store
            .with(|conn| sync(conn, &id, &rows, &mut Vec::new()))
            .expect("rows");

        // What `blocks_json` held when the daemon died: same blocks, further on.
        rows[1].text = "The plan is to ship A, then B, then C.".to_string();
        with_column(&store, &id, &rows);

        let repaired = store.with(backfill_missing).expect("backfill");
        let kept = store.with(|conn| all(conn, &id)).expect("read back");
        assert_eq!(
            kept[1].text, "The plan is to ship A, then B, then C.",
            "migration 13 dropped the only copy of the rest of the answer \
             (backfill_missing repaired {repaired} sessions)"
        );
    }

    /// A search hit is now an instruction to scroll: `focus()` maps `pos` to a
    /// block and `Transcript.tsx` looks for `[data-block=<id>]`. Only user,
    /// assistant and system rows carry that attribute — `groupRows` folds tool,
    /// reasoning, approval and question blocks into an ActivityGroup and skips
    /// `hidden` ones outright — so a hit on anything else opens the agent and
    /// then silently does nothing, leaving `focusId` set forever because
    /// `onFocused` is only called when the element is found.
    #[test]
    fn search_only_offers_hits_the_chat_can_scroll_to() {
        let store = store();
        let id = session(&store, "reachable");
        let mut hidden = new_block(BlockRole::User, "wake up and check the sidebar".to_string());
        hidden.hidden = Some(true); // what lib/scheduler.ts sends for a routine
        let blocks = vec![
            hidden,
            new_block(BlockRole::Reasoning, "the sidebar grouping is memoised".to_string()),
            new_block(BlockRole::Tool, "grep sidebar".to_string()),
        ];
        store
            .with(|conn| sync(conn, &id, &blocks, &mut Vec::new()))
            .expect("rows");

        let hits = search(
            &store,
            SearchQuery {
                query: "sidebar".into(),
                ..Default::default()
            },
        )
        .expect("search");
        let roles: Vec<String> = hits.iter().map(|hit| format!("{:?}", hit.role)).collect();
        assert!(
            !roles.contains(&"User".to_string()),
            "search offered a hidden block, which the chat does not render: {roles:?}"
        );
        // The other two are reachable: a tool row and a thought both carry a
        // `data-block` anchor, and finding the command you ran is the point.
        assert_eq!(hits.len(), 2, "{roles:?}");
    }

    /// The same one-sided test in the other direction: rows that outnumber the
    /// column are never trimmed, so blocks the transcript no longer had come
    /// back from the dead once the hub hydrates from the rows.
    #[test]
    fn backfill_missing_walks_past_rows_that_outnumber_the_column() {
        let store = store();
        let id = session(&store, "phantom");
        let blocks = vec![
            new_block(BlockRole::User, "one".to_string()),
            new_block(BlockRole::Assistant, "two".to_string()),
            new_block(BlockRole::Assistant, "three".to_string()),
        ];
        store
            .with(|conn| sync(conn, &id, &blocks, &mut Vec::new()))
            .expect("rows");
        with_column(&store, &id, &blocks[..1]);

        store.with(backfill_missing).expect("backfill");
        let kept = store.with(|conn| all(conn, &id)).expect("read back");
        assert_eq!(
            kept.len(),
            1,
            "two blocks the transcript had dropped are back: {:?}",
            kept.iter().map(|b| b.text.clone()).collect::<Vec<_>>()
        );
    }
}
