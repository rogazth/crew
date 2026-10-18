//! Brings each session's history from its CLI's own files into `messages`.
//!
//! Up to migration 38 a session in the terminal view had no transcript in
//! Crew: its chat was read from the provider's file each time (Claude's
//! `~/.claude/projects/<slug>/<id>.jsonl`, Codex's rollout, opencode's
//! database, cursor-agent's transcript). Migration 38 made every session a
//! chat, which reads `messages` only, so those sessions opened empty. This
//! reads each one's file once and stores what it said.
//!
//! It runs at every start and is a no-op once done: a session's history goes
//! in only ahead of the first block Crew stored for it, and only when that
//! block is from after migration 38 (a session already in the chat before it
//! has its whole conversation in `messages`).

use std::path::{Path, PathBuf};

use crew_protocol::{Block, ToolStatus};
use rusqlite::params;

use crate::blocks::settle_turn;
use crate::messages;
use crate::provider_session;
use crate::session::{self, Session};
use crate::session_history::claude::ClaudeDecoder;
use crate::session_history::codex::{rollout_path, CodexDecoder};
use crate::session_history::cursor::CursorDecoder;
use crate::session_history::opencode::OpencodeHistory;
use crate::session_history::{History, SessionHistory};
use crate::store::{Store, CURSOR_ACP_NOTE};
use crate::workspace;

/// Each read back from the file asks for at least this many messages.
const PAGE_MESSAGES: usize = 500;

/// Where each provider keeps its history; tests point them at a fixture.
pub struct Sources {
    pub claude_projects: Option<PathBuf>,
    pub codex_home: Option<PathBuf>,
    pub opencode_db: Option<PathBuf>,
    pub cursor_transcript: fn(&str) -> Option<PathBuf>,
}

impl Sources {
    pub fn from_env() -> Self {
        let home = std::env::var("HOME").ok().filter(|h| !h.is_empty()).map(PathBuf::from);
        Self {
            claude_projects: home.map(|h| h.join(".claude/projects")),
            codex_home: provider_session::codex_home(),
            opencode_db: provider_session::opencode_db(),
            cursor_transcript: provider_session::cursor_transcript,
        }
    }
}

/// Imports every session's history it can find; returns how many sessions
/// got any. A session whose file is missing or unreadable is left as it is.
pub fn import_all(store: &Store, sources: &Sources) -> Result<usize, String> {
    // Before migration 38 there is nothing to bring in: the terminal view
    // still read the files.
    let Some(cutoff) = store.with(|conn| {
        conn.query_row("SELECT MAX(applied_at) FROM schema_migrations WHERE version = 38", [], |row| row.get::<_, Option<i64>>(0))
    })?
    else {
        return Ok(0);
    };
    let mut imported = 0;
    for row in session::list_all(store)? {
        if row.kind != "terminal" {
            continue;
        }
        let existing = store.with(|conn| messages::all(conn, &row.id))?;
        let first_at = match existing.first() {
            None => None,
            Some(first) => match first.at {
                Some(at) if at >= cutoff => Some(at),
                // Already in the chat before migration 38: it is all there.
                _ => continue,
            },
        };
        let Some(history) = read(store, sources, &row) else { continue };
        let earlier: Vec<Block> = match first_at {
            None => history,
            // The CLI's file holds the turns since too; only what came before them goes in.
            Some(first_at) => history.into_iter().take_while(|block| block.at.is_some_and(|at| at < first_at)).collect(),
        };
        if earlier.is_empty() {
            continue;
        }
        let mut blocks = earlier;
        blocks.extend(existing);
        store.with(|conn| messages::sync(conn, &row.id, &blocks, &mut Vec::new()))?;
        imported += 1;
    }
    Ok(imported)
}

/// The whole history of `row` as its CLI recorded it, settled: nothing in
/// it is still running.
fn read(store: &Store, sources: &Sources, row: &Session) -> Option<Vec<Block>> {
    let bound = row.provider_session_id.clone().filter(|id| !id.is_empty());
    let blocks = match row.provider.as_str() {
        "claude" => {
            // A user's session runs Claude under Crew's id until the CLI names its own.
            let id = bound.unwrap_or_else(|| row.id.clone());
            let path = claude_file(store, sources.claude_projects.as_deref()?, row, &id)?;
            whole(History::open(path, ClaudeDecoder::default(), PAGE_MESSAGES).ok()?)?
        }
        "codex" => {
            let path = rollout_path(sources.codex_home.as_deref()?, &bound?)?;
            whole(History::open(path, CodexDecoder::default(), PAGE_MESSAGES).ok()?)?
        }
        "opencode" => {
            let db = sources.opencode_db.as_deref().filter(|db| db.exists())?;
            whole(OpencodeHistory::open(db, &bound?, PAGE_MESSAGES).ok()?)?
        }
        "cursor" => {
            // Migration 38 moved a terminal's chat id to its note; one in the chat kept it.
            let noted = store
                .with(|conn| {
                    conn.query_row(
                        "SELECT value FROM app_state WHERE key = ?1",
                        params![format!("{CURSOR_ACP_NOTE}{}", row.id)],
                        |r| r.get::<_, String>(0),
                    )
                    .map(Some)
                    .or_else(|e| if e == rusqlite::Error::QueryReturnedNoRows { Ok(None) } else { Err(e) })
                })
                .ok()
                .flatten();
            let path = noted.or(bound).and_then(|id| (sources.cursor_transcript)(&id))?;
            whole(History::open(path, CursorDecoder::default(), PAGE_MESSAGES).ok()?)?
        }
        _ => return None,
    };
    let blocks = settle_turn(blocks, ToolStatus::Completed);
    (!blocks.is_empty()).then_some(blocks)
}

/// Claude files a conversation under the folder it ran in; the id alone
/// finds it when that folder moved.
fn claude_file(store: &Store, projects: &Path, row: &Session, id: &str) -> Option<PathBuf> {
    let name = format!("{id}.jsonl");
    let cwd = row.worktree.clone().or_else(|| workspace::get(store, row.workspace_id.clone()).ok().flatten().map(|ws| ws.path));
    if let Some(cwd) = cwd {
        let path = projects.join(crate::claude_title::project_slug(&cwd)).join(&name);
        if path.is_file() {
            return Some(path);
        }
    }
    std::fs::read_dir(projects).ok()?.flatten().map(|dir| dir.path().join(&name)).find(|path| path.is_file())
}

fn whole(mut history: impl SessionHistory) -> Option<Vec<Block>> {
    while history.has_earlier() {
        if history.load_earlier(PAGE_MESSAGES).ok()? == 0 {
            break;
        }
    }
    (!history.is_empty_decode()).then(|| history.blocks().to_vec())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::blocks::new_block;
    use crew_protocol::BlockRole;

    const FIXTURE: &str = include_str!("../tests/fixtures/claude/claude-approvals.jsonl");

    fn temp_dir(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("crew-{tag}-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).expect("dir");
        dir
    }

    fn no_cursor(_: &str) -> Option<PathBuf> {
        None
    }

    fn stored(store: &Store, id: &str) -> Vec<Block> {
        store.with(|conn| messages::all(conn, id)).expect("messages")
    }

    fn write(store: &Store, id: &str, blocks: &[Block]) {
        store.with(|conn| messages::sync(conn, id, blocks, &mut Vec::new())).expect("sync");
    }

    /// A Claude session from the terminal view has its history only in
    /// Claude's file: it comes in whole, once. A session already in the chat
    /// before migration 38 keeps what it has, and one used since gets its
    /// history ahead of the turns Crew stored.
    #[test]
    fn brings_each_terminal_sessions_claude_history_into_the_chat() {
        let dir = temp_dir("history-import");
        let store = Store::open(dir.join("crew.sqlite3")).expect("open");
        let ws = workspace::create(&store, "w".into(), dir.to_string_lossy().into()).expect("ws");
        let make = |name: &str| {
            session::create(
                &store,
                ws.id.clone(),
                "terminal".into(),
                name.into(),
                "claude".into(),
                "m".into(),
                "".into(),
                "ask".into(),
            )
            .expect("session")
        };
        let (old, chat, used, missing) = (make("old"), make("chat"), make("used"), make("missing"));
        let projects = dir.join("projects");
        let folder = projects.join(crate::claude_title::project_slug(&ws.path));
        std::fs::create_dir_all(&folder).expect("folder");
        for row in [&old, &chat, &used] {
            std::fs::write(folder.join(format!("{}.jsonl", row.id)), FIXTURE).expect("fixture");
        }
        let mut before = new_block(BlockRole::User, "said in the chat before migration 38");
        before.at = Some(1);
        write(&store, &chat.id, &[before.clone()]);
        let mut since = new_block(BlockRole::User, "said after the upgrade");
        since.at = Some(crate::store::now_millis() + 1);
        write(&store, &used.id, &[since.clone()]);

        let sources =
            Sources { claude_projects: Some(projects), codex_home: None, opencode_db: None, cursor_transcript: no_cursor };
        assert_eq!(import_all(&store, &sources).expect("import"), 2);

        let history = stored(&store, &old.id);
        assert!(history.iter().any(|b| b.role == BlockRole::User), "the prompts come in");
        assert!(history.iter().any(|b| b.role == BlockRole::Assistant), "and the answers");
        assert!(history.iter().all(|b| b.streaming != Some(true)), "nothing is left running");
        assert_eq!(stored(&store, &chat.id), [before]);
        let used_blocks = stored(&store, &used.id);
        assert_eq!(used_blocks.len(), history.len() + 1);
        assert_eq!(used_blocks.last(), Some(&since));
        assert!(stored(&store, &missing.id).is_empty());

        // Run again, nothing moves.
        assert_eq!(import_all(&store, &sources).expect("again"), 0);
        assert_eq!(stored(&store, &old.id), history);
        assert_eq!(stored(&store, &used.id), used_blocks);
    }
}
