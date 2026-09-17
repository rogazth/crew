use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::Duration;

use crew_protocol::{Block, HarnessEvent, MessagePage};
use tokio::task::AbortHandle;

use crate::blocks::apply_event;
use crate::session;
use crate::store::{now_millis, Store};

const SAVE_MS: u64 = 600;
/// A chat opens on one window, so it asks for more than the fifty rows
/// `messages::tail` defaults to: two hundred blocks is several screens of
/// scrollback, and the "load earlier" affordance fetches the rest.
const WINDOW_LIMIT: u32 = 200;
/// The ceiling `messages::tail` uses, for the same reason: past this a window
/// is no cheaper than the whole transcript.
const MAX_WINDOW: u32 = 500;

pub trait TranscriptEvents: Send + Sync {
    fn apply(&self, session_id: &str, seq: u64, event: &HarnessEvent);
    fn status(
        &self,
        session_id: &str,
        status: &str,
        provider_session_id: Option<&str>,
        updated_at: i64,
    );
}

struct Live {
    blocks: Vec<Block>,
    working: bool,
    status: String,
    seq: u64,
    dirty: bool,
    save_gen: u64,
    save: Option<AbortHandle>,
    /// Fingerprints of the rows already in `messages`, so a flush writes the
    /// blocks that moved instead of the whole transcript.
    synced: Vec<u64>,
}

#[derive(Clone)]
pub struct TranscriptHub {
    store: Store,
    inner: Arc<Mutex<HashMap<String, Live>>>,
    events: Arc<Mutex<Option<Arc<dyn TranscriptEvents>>>>,
    runtime: Arc<Mutex<Option<tokio::runtime::Handle>>>,
}

impl TranscriptHub {
    pub fn new(store: Store) -> Self {
        Self {
            store,
            inner: Arc::new(Mutex::new(HashMap::new())),
            events: Arc::new(Mutex::new(None)),
            runtime: Arc::new(Mutex::new(None)),
        }
    }

    pub fn set_events(&self, events: Arc<dyn TranscriptEvents>) {
        *self.events.lock().unwrap_or_else(|e| e.into_inner()) = Some(events);
    }

    pub fn set_runtime(&self, handle: tokio::runtime::Handle) {
        *self.runtime.lock().unwrap_or_else(|e| e.into_inner()) = Some(handle);
    }

    fn events(&self) -> Option<Arc<dyn TranscriptEvents>> {
        self.events.lock().unwrap_or_else(|e| e.into_inner()).clone()
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, HashMap<String, Live>> {
        self.inner.lock().unwrap_or_else(|e| e.into_inner())
    }

    fn hydrate(&self, session_id: &str) -> Live {
        let blocks = self
            .store
            .with(|conn| crate::messages::all(conn, session_id))
            .unwrap_or_default();
        let status = session::get(&self.store, session_id.to_string())
            .ok()
            .flatten()
            .map(|row| row.status)
            .unwrap_or_else(|| "idle".into());
        let synced = self
            .store
            .with(|conn| crate::messages::fingerprints(conn, session_id))
            .unwrap_or_default();
        Live {
            blocks,
            working: status == "working" || status == "needs-input",
            status,
            synced,
            seq: 0,
            dirty: false,
            save_gen: 0,
            save: None,
        }
    }

    fn live(&self, session_id: &str) -> Live {
        let map = self.lock();
        if let Some(row) = map.get(session_id) {
            return Live {
                blocks: row.blocks.clone(),
                working: row.working,
                status: row.status.clone(),
                seq: row.seq,
                dirty: row.dirty,
                save_gen: row.save_gen,
                save: None,
                synced: Vec::new(),
            };
        }
        drop(map);
        let created = self.hydrate(session_id);
        let mut map = self.lock();
        map.entry(session_id.to_string()).or_insert_with(|| Live {
            blocks: created.blocks.clone(),
            working: created.working,
            status: created.status.clone(),
            seq: created.seq,
            dirty: false,
            save_gen: 0,
            save: None,
            synced: created.synced.clone(),
        });
        created
    }

    pub fn window(
        &self,
        session_id: &str,
        limit: Option<u32>,
        before_pos: Option<i64>,
    ) -> MessagePage {
        let limit = limit.unwrap_or(WINDOW_LIMIT).clamp(1, MAX_WINDOW) as usize;
        let row = self.live(session_id);
        let end = match before_pos {
            Some(pos) => (pos.max(1) as usize - 1).min(row.blocks.len()),
            None => row.blocks.len(),
        };
        let start = end.saturating_sub(limit);
        let blocks = row.blocks[start..end].to_vec();
        let from_pos = if blocks.is_empty() { 0 } else { start as i64 + 1 };
        MessagePage {
            to_pos: if blocks.is_empty() { 0 } else { end as i64 },
            blocks,
            from_pos,
            more: from_pos > 1,
            working: row.working,
            status: row.status,
            seq: row.seq,
        }
    }

    pub fn append_user(
        &self,
        session_id: &str,
        text: &str,
        hidden: bool,
        files: Option<Vec<crew_protocol::AttachedFile>>,
    ) {
        self.apply(
            session_id,
            HarnessEvent::UserMessage {
                text: text.to_string(),
                hidden: if hidden { Some(true) } else { None },
                files: files.filter(|rows| !rows.is_empty()),
                from_agent: None,
            },
        );
    }

    /// A line another agent wrote into this transcript.
    pub fn append_from_agent(&self, session_id: &str, text: &str, from: crew_protocol::AgentRef) {
        self.apply(
            session_id,
            HarnessEvent::UserMessage {
                text: text.to_string(),
                hidden: None,
                files: None,
                from_agent: Some(from),
            },
        );
    }

    pub fn apply(&self, session_id: &str, event: HarnessEvent) -> u64 {
        if let HarnessEvent::SessionProviderBound {
            provider_session_id,
        } = &event
        {
            let _ = session::set_provider_session(
                &self.store,
                session_id.to_string(),
                provider_session_id.clone(),
            );
        }
        let flush_now = matches!(
            event,
            HarnessEvent::MessageCompleted { .. }
                | HarnessEvent::TurnCompleted { .. }
                | HarnessEvent::SessionError { .. }
                | HarnessEvent::SessionEnded { .. }
                | HarnessEvent::SystemMessage { .. }
        );
        let (seq, emit_event) = {
            let mut map = self.lock();
            let row = map
                .entry(session_id.to_string())
                .or_insert_with(|| self.hydrate(session_id));
            row.blocks = apply_event(std::mem::take(&mut row.blocks), event.clone());
            row.seq += 1;
            row.dirty = true;
            (row.seq, event.clone())
        };
        if let Some(events) = self.events() {
            events.apply(session_id, seq, &emit_event);
        }
        if flush_now {
            self.flush(session_id);
        } else {
            self.schedule_save(session_id);
        }
        seq
    }

    pub fn append_system(&self, session_id: &str, text: &str) {
        self.apply(
            session_id,
            HarnessEvent::SystemMessage {
                text: text.to_string(),
            },
        );
    }

    pub fn set_working(&self, session_id: &str, working: bool) {
        let mut map = self.lock();
        let row = map
            .entry(session_id.to_string())
            .or_insert_with(|| self.hydrate(session_id));
        row.working = working;
    }

    pub fn set_status(&self, session_id: &str, status: &str, provider_session_id: Option<&str>) {
        let _ = session::set_status(&self.store, session_id.to_string(), status.to_string());
        {
            let mut map = self.lock();
            let row = map
                .entry(session_id.to_string())
                .or_insert_with(|| self.hydrate(session_id));
            row.status = status.to_string();
            row.working = status == "working" || status == "needs-input";
        }
        let updated_at = now_millis();
        if let Some(events) = self.events() {
            events.status(session_id, status, provider_session_id, updated_at);
        }
    }

    pub fn flush(&self, session_id: &str) {
        let (blocks, mut synced) = {
            let mut map = self.lock();
            let Some(row) = map.get_mut(session_id) else {
                return;
            };
            if let Some(save) = row.save.take() {
                save.abort();
            }
            if !row.dirty {
                return;
            }
            row.dirty = false;
            row.save_gen += 1;
            (row.blocks.clone(), std::mem::take(&mut row.synced))
        };
        let written = self
            .store
            .with(|conn| crate::messages::sync(conn, session_id, &blocks, &mut synced))
            .is_ok();
        if let Some(row) = self.lock().get_mut(session_id) {
            if written {
                row.synced = synced;
            } else {
                // Nothing landed, and the last flush of a turn has no next
                // flush to fix it: the row stays dirty so a later one retries,
                // with an empty cache so it rewrites what never arrived.
                row.dirty = true;
            }
        }
    }

    pub fn flush_all(&self) {
        let ids: Vec<String> = {
            let map = self.lock();
            map.iter()
                .filter(|(_, row)| row.dirty)
                .map(|(id, _)| id.clone())
                .collect()
        };
        for id in ids {
            self.flush(&id);
        }
    }

    fn schedule_save(&self, session_id: &str) {
        let gen = {
            let mut map = self.lock();
            let Some(row) = map.get_mut(session_id) else {
                return;
            };
            if let Some(save) = row.save.take() {
                save.abort();
            }
            row.save_gen += 1;
            row.save_gen
        };
        let hub = self.clone();
        let id = session_id.to_string();
        if let Some(handle) = self.runtime.lock().unwrap_or_else(|e| e.into_inner()).clone() {
            let wait_id = id.clone();
            let task = handle.spawn(async move {
                tokio::time::sleep(Duration::from_millis(SAVE_MS)).await;
                hub.flush_if(&wait_id, gen);
            });
            if let Some(row) = self.lock().get_mut(&id) {
                if row.save_gen == gen {
                    row.save = Some(task.abort_handle());
                } else {
                    task.abort();
                }
            }
        } else {
            thread::spawn(move || {
                thread::sleep(Duration::from_millis(SAVE_MS));
                hub.flush_if(&id, gen);
            });
        }
    }

    fn flush_if(&self, session_id: &str, gen: u64) {
        {
            let map = self.lock();
            let Some(row) = map.get(session_id) else {
                return;
            };
            if row.save_gen != gen || !row.dirty {
                return;
            }
        }
        self.flush(session_id);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::store::Store;
    use crew_protocol::BlockRole;

    fn tmp_store() -> Store {
        let dir = std::env::temp_dir().join(format!("crew-transcript-{}", uuid::Uuid::new_v4()));
        let _ = std::fs::create_dir_all(&dir);
        Store::open(dir.join("crew.sqlite3")).expect("store")
    }

    #[test]
    fn apply_increments_seq_and_persists_on_turn_end() {
        let store = tmp_store();
        let workspace = crate::workspace::create(&store, "w".into(), std::env::temp_dir().to_string_lossy().into()).unwrap();
        let session = crate::session::create(
            &store,
            workspace.id,
            "agent".into(),
            "A".into(),
            "claude".into(),
            "m".into(),
            "".into(),
            "ask".into(),
        )
        .unwrap();
        let hub = TranscriptHub::new(store.clone());
        hub.append_user(&session.id, "hi", false, None);
        hub.apply(
            &session.id,
            HarnessEvent::MessageDelta {
                text: "ok".into(),
            },
        );
        let seq = hub.apply(&session.id, HarnessEvent::TurnCompleted { usage: None });
        assert_eq!(seq, 3);
        let snap = hub.window(&session.id, None, None);
        assert_eq!(snap.blocks.iter().filter(|b| b.role == BlockRole::Assistant).count(), 1);
        let stored = store
            .with(|conn| crate::messages::all(conn, &session.id))
            .expect("read back");
        assert!(stored.iter().any(|block| block.text == "ok"));
    }
}

#[cfg(test)]
mod review_tests {
    use super::*;
    use crate::store::Store;

    pub(super) fn tmp_store() -> Store {
        let dir = std::env::temp_dir().join(format!("crew-flush-{}", uuid::Uuid::new_v4()));
        let _ = std::fs::create_dir_all(&dir);
        Store::open(dir.join("crew.sqlite3")).expect("store")
    }

    pub(super) fn agent(store: &Store) -> String {
        let root = std::env::temp_dir().join(uuid::Uuid::new_v4().to_string());
        let _ = std::fs::create_dir_all(&root);
        let workspace =
            crate::workspace::create(store, "w".into(), root.to_string_lossy().into()).unwrap();
        crate::session::create(
            store,
            workspace.id,
            "agent".into(),
            "A".into(),
            "claude".into(),
            "m".into(),
            "".into(),
            "ask".into(),
        )
        .unwrap()
        .id
    }

    /// `flush` clones the blocks under the lock and writes them outside it, so
    /// two flushes can be in flight at once and the older one can land last.
    /// Every event here is one the hub flushes immediately, which is what a
    /// provider stream and a turn ending do at the same moment.
    #[test]
    fn concurrent_flushes_do_not_lose_blocks() {
        let store = tmp_store();
        let id = agent(&store);
        let hub = TranscriptHub::new(store.clone());

        let threads: Vec<_> = (0..6)
            .map(|t| {
                let hub = hub.clone();
                let id = id.clone();
                thread::spawn(move || {
                    for n in 0..50 {
                        hub.append_system(&id, &format!("line {t}-{n}"));
                    }
                })
            })
            .collect();
        for handle in threads {
            handle.join().expect("thread");
        }
        hub.flush(&id);

        // An explicit limit: the default window is a page, and this compares
        // everything the hub holds against everything that landed.
        let live = hub.window(&id, Some(MAX_WINDOW), None).blocks.len();
        let rows = store
            .with(|conn| crate::messages::count(conn, &id))
            .expect("count") as usize;
        assert_eq!(rows, live, "the messages table holds {rows} of {live} blocks");
    }

    /// `flush` clears `dirty` before it writes, so a write that fails is never
    /// retried. Nothing else marks the session dirty again, and a turn that has
    /// just ended has no further events coming.
    #[test]
    fn a_flush_that_could_not_write_is_tried_again() {
        let store = tmp_store();
        let id = agent(&store);
        let hub = TranscriptHub::new(store.clone());
        hub.append_system(&id, "first");

        store
            .with(|conn| conn.pragma_update(None, "query_only", true))
            .expect("read only");
        hub.append_system(&id, "second");
        store
            .with(|conn| conn.pragma_update(None, "query_only", false))
            .expect("writable");

        hub.flush(&id);
        let stored = store
            .with(|conn| crate::messages::all(conn, &id))
            .expect("read back");
        assert!(
            stored.iter().any(|block| block.text == "second"),
            "the block whose write failed is gone from disk for good: {:?}",
            stored.iter().map(|b| b.text.clone()).collect::<Vec<_>>()
        );
    }
}

#[cfg(test)]
mod window_tests {
    use super::*;
    use crate::blocks::new_block;
    use crate::store::Store;
    use crew_protocol::BlockRole;

    fn tmp_store() -> Store {
        let dir = std::env::temp_dir().join(format!("crew-window-{}", uuid::Uuid::new_v4()));
        let _ = std::fs::create_dir_all(&dir);
        Store::open(dir.join("crew.sqlite3")).expect("store")
    }

    pub(super) fn agent(store: &Store) -> String {
        let root = std::env::temp_dir().join(uuid::Uuid::new_v4().to_string());
        let _ = std::fs::create_dir_all(&root);
        let workspace =
            crate::workspace::create(store, "w".into(), root.to_string_lossy().into()).unwrap();
        crate::session::create(
            store,
            workspace.id,
            "agent".into(),
            "A".into(),
            "claude".into(),
            "m".into(),
            "".into(),
            "ask".into(),
        )
        .unwrap()
        .id
    }

    fn lines(hub: &TranscriptHub, session_id: &str, count: usize) {
        for n in 1..=count {
            hub.append_system(session_id, &format!("line {n}"));
        }
    }

    fn texts(page: &MessagePage) -> Vec<String> {
        page.blocks.iter().map(|block| block.text.clone()).collect()
    }

    #[test]
    fn a_window_is_the_last_blocks_with_their_positions() {
        let store = tmp_store();
        let id = agent(&store);
        let hub = TranscriptHub::new(store);
        lines(&hub, &id, 10);

        let page = hub.window(&id, Some(3), None);
        assert_eq!(texts(&page), vec!["line 8", "line 9", "line 10"]);
        assert_eq!(page.from_pos, 8);
        assert_eq!(page.to_pos, 10);
        assert!(page.more, "seven blocks sit before the window");
    }

    #[test]
    fn the_default_window_is_the_last_two_hundred_blocks() {
        let store = tmp_store();
        let id = agent(&store);
        let blocks: Vec<Block> = (1..=250)
            .map(|n| new_block(BlockRole::Assistant, format!("line {n}")))
            .collect();
        store
            .with(|conn| crate::messages::sync(conn, &id, &blocks, &mut Vec::new()))
            .expect("seed");

        let hub = TranscriptHub::new(store);
        let page = hub.window(&id, None, None);
        assert_eq!(page.blocks.len(), 200);
        assert_eq!(page.from_pos, 51);
        assert_eq!(page.to_pos, 250);
        assert!(page.more);
    }

    #[test]
    fn a_window_pages_backwards_without_a_gap_or_an_overlap() {
        let store = tmp_store();
        let id = agent(&store);
        let hub = TranscriptHub::new(store);
        lines(&hub, &id, 10);

        let last = hub.window(&id, Some(4), None);
        let earlier = hub.window(&id, Some(4), Some(last.from_pos));
        assert_eq!(earlier.to_pos + 1, last.from_pos, "the two pages do not meet");
        assert_eq!(texts(&earlier), vec!["line 3", "line 4", "line 5", "line 6"]);
        assert!(earlier.more);

        let first = hub.window(&id, Some(4), Some(earlier.from_pos));
        assert_eq!(texts(&first), vec!["line 1", "line 2"]);
        assert_eq!(first.from_pos, 1);
        assert!(!first.more);

        let walked: Vec<String> = texts(&first)
            .into_iter()
            .chain(texts(&earlier))
            .chain(texts(&last))
            .collect();
        assert_eq!(walked, texts(&hub.window(&id, Some(10), None)));
    }

    #[test]
    fn a_transcript_shorter_than_the_limit_says_there_is_nothing_older() {
        let store = tmp_store();
        let id = agent(&store);
        let hub = TranscriptHub::new(store);
        lines(&hub, &id, 2);

        let page = hub.window(&id, Some(50), None);
        assert_eq!(page.blocks.len(), 2);
        assert_eq!(page.from_pos, 1);
        assert_eq!(page.to_pos, 2);
        assert!(!page.more);
    }

    #[test]
    fn an_empty_transcript_answers_an_empty_page() {
        let store = tmp_store();
        let id = agent(&store);
        let hub = TranscriptHub::new(store);

        let page = hub.window(&id, None, None);
        assert!(page.blocks.is_empty());
        assert_eq!(page.from_pos, 0);
        assert_eq!(page.to_pos, 0);
        assert!(!page.more);

        // And so does a page asked for from before the first block.
        let nothing_older = hub.window(&id, None, Some(1));
        assert!(nothing_older.blocks.is_empty());
        assert!(!nothing_older.more);
    }

    /// The reason the window is served from the hub: a turn in flight holds
    /// blocks that will not reach `messages` for up to `SAVE_MS`. Writing is
    /// turned off here, so a window read from the table could not hold the
    /// streamed block by any timing.
    #[test]
    fn the_window_shows_a_block_that_has_not_reached_the_table() {
        let store = tmp_store();
        let id = agent(&store);
        let hub = TranscriptHub::new(store.clone());
        hub.append_system(&id, "flushed");

        store
            .with(|conn| conn.pragma_update(None, "query_only", true))
            .expect("read only");
        hub.apply(
            &id,
            HarnessEvent::MessageDelta {
                text: "still streaming".into(),
            },
        );

        let page = hub.window(&id, None, None);
        assert_eq!(texts(&page), vec!["flushed", "still streaming"]);
        assert_eq!(page.to_pos, 2);
        let stored = store
            .with(|conn| crate::messages::count(conn, &id))
            .expect("count");
        assert_eq!(stored, 1, "sanity: the table already holds the unflushed block");

        store
            .with(|conn| conn.pragma_update(None, "query_only", false))
            .expect("writable");
    }

    #[test]
    fn the_window_carries_the_live_state_the_hub_holds() {
        let store = tmp_store();
        let id = agent(&store);
        let hub = TranscriptHub::new(store);
        hub.set_status(&id, "working", None);
        let seq = hub.apply(
            &id,
            HarnessEvent::MessageDelta {
                text: "thinking".into(),
            },
        );

        let page = hub.window(&id, Some(1), None);
        assert_eq!(page.seq, seq);
        assert_eq!(page.status, "working");
        assert!(page.working);

        hub.set_status(&id, "idle", None);
        let done = hub.window(&id, Some(1), None);
        assert_eq!(done.status, "idle");
        assert!(!done.working);
        assert_eq!(done.seq, seq, "reading a window is not an event");
    }
}

#[cfg(test)]
mod cost_tests {
    use super::*;
    use super::review_tests::{agent, tmp_store};
    use crew_protocol::{BlockTool, ToolDetail, ToolStatus};

    fn tool_block(n: usize) -> Block {
        let mut block = crate::blocks::new_block(crew_protocol::BlockRole::Tool, format!("bash {n}"));
        block.tool = Some(BlockTool {
            call_id: format!("c{n}"),
            name: "Bash".into(),
            title: format!("bash {n}"),
            status: ToolStatus::Completed,
            detail: Some(ToolDetail::Command {
                command: format!("echo {n}"),
                exit_code: Some(0),
                output: Some("x".repeat(2048)),
            }),
        });
        block
    }

    /// What one streamed delta costs on a long transcript. `blocks_json` is
    /// rewritten whole every flush, so this is the number to beat.
    #[test]
    fn what_a_flush_costs_on_a_long_transcript() {
        let store = tmp_store();
        let id = agent(&store);
        let hub = TranscriptHub::new(store.clone());
        {
            let mut map = hub.lock();
            let row = map.entry(id.clone()).or_insert_with(|| hub.hydrate(&id));
            row.blocks = (0..500).map(tool_block).collect();
            row.dirty = true;
        }
        hub.flush(&id);

        let start = std::time::Instant::now();
        for n in 0..5 {
            hub.apply(&id, HarnessEvent::MessageDelta { text: format!("{n}") });
            hub.flush(&id);
        }
        let each = start.elapsed() / 5;
        println!("flush after one delta, 500-block transcript: {each:?}");
        // Not an assertion on the number — machines differ — but a wall against
        // the whole transcript being rewritten on every delta again.
        assert!(each < Duration::from_millis(250), "a flush took {each:?}");
    }
}
