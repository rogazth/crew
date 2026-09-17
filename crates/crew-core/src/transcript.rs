use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::Duration;

use crew_protocol::{Block, HarnessEvent, TranscriptSnapshot};
use tokio::task::AbortHandle;

use crate::blocks::{apply_event, parse_blocks};
use crate::session;
use crate::store::{now_millis, Store};

const SAVE_MS: u64 = 600;

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
        let raw = session::get_blocks(&self.store, session_id.to_string()).unwrap_or_else(|_| "[]".into());
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
            blocks: parse_blocks(Some(&raw)),
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

    pub fn get(&self, session_id: &str) -> TranscriptSnapshot {
        let row = self.live(session_id);
        TranscriptSnapshot {
            blocks: row.blocks,
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
        let json = serde_json::to_string(&blocks).unwrap_or_else(|_| "[]".into());
        let _ = session::set_blocks(&self.store, session_id.to_string(), json);
        let written = self
            .store
            .with(|conn| crate::messages::sync(conn, session_id, &blocks, &mut synced))
            .is_ok();
        // A failed write leaves the cache empty, so the next flush rewrites
        // every row instead of trusting fingerprints for rows that never landed.
        if let Some(row) = self.lock().get_mut(session_id) {
            if written {
                row.synced = synced;
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
        let snap = hub.get(&session.id);
        assert_eq!(snap.blocks.iter().filter(|b| b.role == BlockRole::Assistant).count(), 1);
        let raw = crate::session::get_blocks(&store, session.id).unwrap();
        assert!(raw.contains("ok"));
    }
}

#[cfg(test)]
mod review_tests {
    use super::*;
    use crate::store::Store;

    fn tmp_store() -> Store {
        let dir = std::env::temp_dir().join(format!("crew-flush-{}", uuid::Uuid::new_v4()));
        let _ = std::fs::create_dir_all(&dir);
        Store::open(dir.join("crew.sqlite3")).expect("store")
    }

    fn agent(store: &Store) -> String {
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

        let live = hub.get(&id).blocks.len();
        let stored = parse_blocks(Some(&session::get_blocks(&store, id.clone()).unwrap())).len();
        let rows = store
            .with(|conn| crate::messages::count(conn, &id))
            .expect("count") as usize;
        assert_eq!(stored, live, "blocks_json lost {} blocks", live - stored);
        assert_eq!(rows, live, "the messages table holds {rows} of {live} blocks");
    }
}
