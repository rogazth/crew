use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::Duration;

use crew_protocol::{Block, HarnessEvent, TranscriptSnapshot};

use crate::blocks::{apply_event, new_block, parse_blocks};
use crew_protocol::BlockRole;
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
    saving: bool,
}

#[derive(Clone)]
pub struct TranscriptHub {
    store: Store,
    inner: Arc<Mutex<HashMap<String, Live>>>,
    events: Arc<Mutex<Option<Arc<dyn TranscriptEvents>>>>,
}

impl TranscriptHub {
    pub fn new(store: Store) -> Self {
        Self {
            store,
            inner: Arc::new(Mutex::new(HashMap::new())),
            events: Arc::new(Mutex::new(None)),
        }
    }

    pub fn set_events(&self, events: Arc<dyn TranscriptEvents>) {
        *self.events.lock().unwrap_or_else(|e| e.into_inner()) = Some(events);
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
        Live {
            blocks: parse_blocks(Some(&raw)),
            working: status == "working" || status == "needs-input",
            status,
            seq: 0,
            dirty: false,
            saving: false,
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
                saving: row.saving,
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
            saving: false,
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
        let mut block = new_block(BlockRole::User, text);
        if hidden {
            block.hidden = Some(true);
        }
        if let Some(files) = files.filter(|rows| !rows.is_empty()) {
            block.files = Some(files);
        }
        let mut map = self.lock();
        let row = map.entry(session_id.to_string()).or_insert_with(|| self.hydrate_locked(session_id));
        row.blocks.push(block);
        row.dirty = true;
        drop(map);
        self.schedule_save(session_id);
    }

    fn hydrate_locked(&self, session_id: &str) -> Live {
        self.hydrate(session_id)
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
        let block = new_block(BlockRole::System, text);
        let mut map = self.lock();
        let row = map
            .entry(session_id.to_string())
            .or_insert_with(|| self.hydrate(session_id));
        row.blocks.push(block);
        row.dirty = true;
        drop(map);
        self.flush(session_id);
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
        let blocks = {
            let mut map = self.lock();
            let Some(row) = map.get_mut(session_id) else {
                return;
            };
            if !row.dirty {
                return;
            }
            row.dirty = false;
            row.saving = false;
            row.blocks.clone()
        };
        let json = serde_json::to_string(&blocks).unwrap_or_else(|_| "[]".into());
        let _ = session::set_blocks(&self.store, session_id.to_string(), json);
    }

    fn schedule_save(&self, session_id: &str) {
        {
            let mut map = self.lock();
            let Some(row) = map.get_mut(session_id) else {
                return;
            };
            if row.saving {
                return;
            }
            row.saving = true;
        }
        let hub = self.clone();
        let id = session_id.to_string();
        thread::spawn(move || {
            thread::sleep(Duration::from_millis(SAVE_MS));
            hub.flush(&id);
        });
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::store::Store;

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
        assert_eq!(seq, 2);
        let snap = hub.get(&session.id);
        assert_eq!(snap.blocks.iter().filter(|b| b.role == BlockRole::Assistant).count(), 1);
        let raw = crate::session::get_blocks(&store, session.id).unwrap();
        assert!(raw.contains("ok"));
    }
}
