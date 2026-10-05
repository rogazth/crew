//! opencode's sessions, kept in `$XDG_DATA_HOME/opencode/opencode.db` rather
//! than in a file.
//!
//! A session is `message` rows (`data` is the message's JSON: role, `time`,
//! `finish`, `error`) and `part` rows under them (`data` is the part's JSON,
//! the same shape `opencode run --format json` prints), so the parts go through
//! the helpers the agent turns use. opencode rewrites a part in place as it
//! goes (a tool from pending to running to completed, a text from empty to
//! whole) and writes concurrently in WAL mode: this side opens the database
//! read-only, notices a change by the rows' `time_updated`, and rebuilds the
//! held range. Blocks are named after opencode's own message and part ids, so
//! a rebuilt block keeps its id.

use std::io;
use std::path::{Path, PathBuf};
use std::time::Duration;

use crew_protocol::{Block, HarnessEvent, ToolStatus, TurnUsage};
use rusqlite::{params, Connection, ErrorCode, OpenFlags};
use serde_json::{Map, Value};

use super::{Change, SessionHistory, Window, MAX_RECORD_BYTES};
use crate::blocks::{apply_event, settle_turn};
use crate::providers::opencode::{
    add_step_usage, parse_tool_call, step_failure, stream_error_message, text_part, turn_ended,
};
use crate::providers::{as_record, string_field};

/// Where a message sits in the session: opencode orders them by creation time,
/// then by id (`message_session_time_created_id_idx`).
#[derive(Debug, Clone, PartialEq, Eq)]
struct Key {
    created: i64,
    id: String,
}

/// What moves whenever opencode writes to the session, deletions included.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
struct Stamp {
    messages: i64,
    message_updated: i64,
    parts: i64,
    part_updated: i64,
}

struct Message {
    id: String,
    created: i64,
    updated: i64,
    data: Map<String, Value>,
    parts: Vec<Part>,
}

struct Part {
    id: String,
    created: i64,
    /// `{"part": data}`, with the part's id put back in: the event shape the
    /// `providers::opencode` helpers read.
    rec: Map<String, Value>,
}

impl Part {
    fn data(&self) -> Option<&Map<String, Value>> {
        self.rec.get("part").and_then(as_record)
    }

    fn kind(&self) -> Option<&str> {
        self.data()?.get("type")?.as_str()
    }
}

/// The turn a range opens in the middle of: what its earlier steps cost and
/// when it was asked, so the turn adds up the same whichever page holds it.
#[derive(Debug, Clone, Default)]
struct Seed {
    usage: Option<TurnUsage>,
    started: Option<i64>,
}

pub struct OpencodeHistory {
    db: PathBuf,
    session_id: String,
    conn: Option<Connection>,
    blocks: Vec<Block>,
    /// The global index of `blocks[0]`; earlier pages lower it.
    base: i64,
    /// The oldest message held, or `None` when the held range starts at the
    /// session's first message.
    from: Option<Key>,
    /// Whether the tail has been placed: a session with no message yet is
    /// placed when its first one appears.
    placed: bool,
    stamp: Stamp,
    /// Messages in the held range, for telling a broken decode from an empty one.
    messages: usize,
    /// The last message is a prompt still being answered.
    answering: bool,
    seed: Option<(Key, Seed)>,
    min_messages: usize,
}

impl OpencodeHistory {
    /// The last `min_messages` messages of `session_id`. A database or a
    /// session that is not there yet is not an error: the history stays empty
    /// until opencode writes it.
    pub fn open(db: &Path, session_id: &str, min_messages: usize) -> io::Result<Self> {
        let mut history = Self {
            db: db.to_path_buf(),
            session_id: session_id.to_string(),
            conn: None,
            blocks: Vec::new(),
            base: 0,
            from: None,
            placed: false,
            stamp: Stamp::default(),
            messages: 0,
            answering: false,
            seed: None,
            min_messages: min_messages.max(1),
        };
        history.refresh()?;
        Ok(history)
    }

    pub fn path(&self) -> &Path {
        &self.db
    }

    pub fn base(&self) -> i64 {
        self.base
    }

    pub fn blocks(&self) -> &[Block] {
        &self.blocks
    }

    pub fn exists(&self) -> bool {
        self.stamp.messages > 0
    }

    pub fn has_earlier(&self) -> bool {
        self.from.is_some()
    }

    pub fn is_empty_decode(&self) -> bool {
        self.messages > 0 && self.blocks.is_empty()
    }

    /// Rereads the held range when anything in the session was written.
    pub fn poll(&mut self) -> io::Result<Option<Change>> {
        let answering = self.answering;
        let Some(before) = self.refresh()? else {
            return Ok(None);
        };
        let turn_ended = answering && !self.answering;
        let first = before
            .iter()
            .zip(&self.blocks)
            .position(|(old, new)| old != new)
            .unwrap_or(before.len().min(self.blocks.len()));
        if first == before.len() && first == self.blocks.len() && !turn_ended {
            return Ok(None);
        }
        Ok(Some(Change {
            from: self.base + first as i64,
            blocks: self.blocks[first..].to_vec(),
            turn_ended,
            reset: false,
        }))
    }

    pub fn window(&self, before: Option<i64>, limit: usize) -> Window {
        let len = self.blocks.len();
        let end = match before {
            Some(index) => (index - self.base).clamp(0, len as i64) as usize,
            None => len,
        };
        let start = end.saturating_sub(limit);
        Window {
            blocks: self.blocks[start..end].to_vec(),
            start: self.base + start as i64,
            more: start > 0 || self.from.is_some(),
        }
    }

    /// Puts the `min_messages` messages before the held range in front.
    /// Returns how many blocks that added: 0 only once the session's first
    /// message is held.
    pub fn load_earlier(&mut self, min_messages: usize) -> io::Result<usize> {
        while let Some(end) = self.from.clone() {
            let Some(conn) = self.connect()? else {
                return Ok(0);
            };
            let step = || -> rusqlite::Result<(Option<Key>, Vec<Message>)> {
                let start = start_before(&conn, &self.session_id, Some(&end), min_messages.max(1))?;
                let page = read_messages(&conn, &self.session_id, start.as_ref(), Some(&end))?;
                Ok((start, page))
            };
            let (start, page) = match step() {
                Ok(read) => read,
                Err(err) => return self.failed(err).map(|_| 0),
            };
            let seed = match self.seed_for(&conn, start.as_ref(), &page) {
                Ok(seed) => seed,
                Err(err) => return self.failed(err).map(|_| 0),
            };
            self.conn = Some(conn);
            self.from = start;
            self.messages += page.len();
            let built = build(&page, seed, false);
            // Nothing after the page's end is in it, so a call it left running
            // ran on: its result is in the held range or never came.
            let earlier = settle_turn(built.blocks, ToolStatus::Completed);
            if earlier.is_empty() {
                continue;
            }
            let added = earlier.len();
            self.base -= added as i64;
            let mut blocks = earlier;
            blocks.append(&mut self.blocks);
            self.blocks = blocks;
            return Ok(added);
        }
        Ok(0)
    }

    /// Reads the session again if its stamp moved, and returns the blocks
    /// held before.
    fn refresh(&mut self) -> io::Result<Option<Vec<Block>>> {
        let Some(conn) = self.connect()? else {
            return Ok(None);
        };
        let result = self.reread(&conn);
        self.conn = Some(conn);
        match result {
            Ok(before) => Ok(before),
            Err(err) => self.failed(err).map(|_| None),
        }
    }

    fn reread(&mut self, conn: &Connection) -> rusqlite::Result<Option<Vec<Block>>> {
        let stamp = stamp(conn, &self.session_id)?;
        if stamp == self.stamp {
            return Ok(None);
        }
        if !self.placed && stamp.messages > 0 {
            self.from = start_before(conn, &self.session_id, None, self.min_messages)?;
            self.placed = true;
        }
        let from = self.from.clone();
        let messages = read_messages(conn, &self.session_id, from.as_ref(), None)?;
        let seed = self.seed_for(conn, from.as_ref(), &messages)?;
        let built = build(&messages, seed, true);
        self.stamp = stamp;
        self.messages = messages.len();
        self.answering = built.answering;
        Ok(Some(std::mem::replace(&mut self.blocks, built.blocks)))
    }

    /// The earlier steps of a turn the range starts in the middle of. Asked
    /// once per range start: it only changes when an earlier page is loaded.
    fn seed_for(&mut self, conn: &Connection, from: Option<&Key>, messages: &[Message]) -> rusqlite::Result<Seed> {
        let Some(from) = from else {
            return Ok(Seed::default());
        };
        if let Some((key, seed)) = &self.seed {
            if key == from {
                return Ok(seed.clone());
            }
        }
        let parent = messages
            .first()
            .filter(|first| role(&first.data) == Some("assistant"))
            .and_then(|first| string_field(Some(&first.data), "parentID"));
        let seed = match parent {
            Some(parent) => turn_seed(conn, &self.session_id, from, &parent)?,
            None => Seed::default(),
        };
        self.seed = Some((from.clone(), seed.clone()));
        Ok(seed)
    }

    /// The held connection, or a new one. `None` while there is no database
    /// to open yet.
    fn connect(&mut self) -> io::Result<Option<Connection>> {
        if let Some(conn) = self.conn.take() {
            return Ok(Some(conn));
        }
        if !self.db.exists() {
            return Ok(None);
        }
        let open = || -> rusqlite::Result<Connection> {
            let conn = Connection::open_with_flags(&self.db, OpenFlags::SQLITE_OPEN_READ_ONLY)?;
            conn.busy_timeout(Duration::from_millis(500))?;
            Ok(conn)
        };
        match open() {
            Ok(conn) => Ok(Some(conn)),
            Err(err) if not_ready(&err) => Ok(None),
            Err(err) => Err(io::Error::other(err)),
        }
    }

    /// Drops the connection, so the next look opens the database afresh. A
    /// database opencode has not finished creating, or one busy past the
    /// timeout, is only not ready yet.
    fn failed(&mut self, err: rusqlite::Error) -> io::Result<()> {
        self.conn = None;
        if not_ready(&err) {
            Ok(())
        } else {
            Err(io::Error::other(err))
        }
    }
}

fn not_ready(err: &rusqlite::Error) -> bool {
    match err {
        rusqlite::Error::SqliteFailure(failure, message) => {
            matches!(
                failure.code,
                ErrorCode::DatabaseBusy | ErrorCode::DatabaseLocked | ErrorCode::CannotOpen
            ) || message.as_deref().is_some_and(|text| text.starts_with("no such table"))
        }
        _ => false,
    }
}

fn stamp(conn: &Connection, session: &str) -> rusqlite::Result<Stamp> {
    conn.query_row(
        "SELECT
           (SELECT count(*) FROM message WHERE session_id = ?1),
           (SELECT coalesce(max(time_updated), 0) FROM message WHERE session_id = ?1),
           (SELECT count(*) FROM part WHERE session_id = ?1),
           (SELECT coalesce(max(time_updated), 0) FROM part WHERE session_id = ?1)",
        params![session],
        |row| {
            Ok(Stamp {
                messages: row.get(0)?,
                message_updated: row.get(1)?,
                parts: row.get(2)?,
                part_updated: row.get(3)?,
            })
        },
    )
}

/// Where the last `n` messages before `end` (or before the session's end)
/// start: `None` when that reaches the session's first message.
fn start_before(conn: &Connection, session: &str, end: Option<&Key>, n: usize) -> rusqlite::Result<Option<Key>> {
    let (created, id) = match end {
        Some(key) => (key.created, key.id.as_str()),
        None => (i64::MAX, ""),
    };
    // One more than asked says whether anything is left before the start.
    let mut stmt = conn.prepare_cached(
        "SELECT time_created, id FROM message
         WHERE session_id = ?1 AND (time_created < ?2 OR (time_created = ?2 AND id < ?3))
         ORDER BY time_created DESC, id DESC LIMIT ?4",
    )?;
    let keys = stmt
        .query_map(params![session, created, id, n as i64 + 1], |row| {
            Ok(Key {
                created: row.get(0)?,
                id: row.get(1)?,
            })
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    Ok(if keys.len() > n { keys.into_iter().nth(n - 1) } else { None })
}

/// The messages in `[from, end)`, each with its parts in order. A part too
/// big to be worth reading (a pasted image, inline) is left out unread.
fn read_messages(
    conn: &Connection,
    session: &str,
    from: Option<&Key>,
    end: Option<&Key>,
) -> rusqlite::Result<Vec<Message>> {
    let (from_created, from_id) = match from {
        Some(key) => (key.created, key.id.as_str()),
        None => (i64::MIN, ""),
    };
    let (end_created, end_id, bounded) = match end {
        Some(key) => (key.created, key.id.as_str(), true),
        None => (0, "", false),
    };
    let mut stmt = conn.prepare_cached(
        "SELECT m.id, m.time_created, m.time_updated, m.data, p.id, p.time_created,
                CASE WHEN octet_length(p.data) > ?7 THEN NULL ELSE p.data END
         FROM message m LEFT JOIN part p ON p.message_id = m.id
         WHERE m.session_id = ?1
           AND (m.time_created > ?2 OR (m.time_created = ?2 AND m.id >= ?3))
           AND (NOT ?6 OR m.time_created < ?4 OR (m.time_created = ?4 AND m.id < ?5))
         ORDER BY m.time_created, m.id, p.id",
    )?;
    let mut rows = stmt.query(params![
        session,
        from_created,
        from_id,
        end_created,
        end_id,
        bounded,
        MAX_RECORD_BYTES as i64
    ])?;
    let mut messages: Vec<Message> = Vec::new();
    while let Some(row) = rows.next()? {
        let id: String = row.get(0)?;
        if messages.last().is_none_or(|last| last.id != id) {
            let data: String = row.get(3)?;
            messages.push(Message {
                id,
                created: row.get(1)?,
                updated: row.get(2)?,
                data: serde_json::from_str(&data).unwrap_or_default(),
                parts: Vec::new(),
            });
        }
        let (Some(part_id), Some(data)) = (row.get::<_, Option<String>>(4)?, row.get::<_, Option<String>>(6)?) else {
            continue;
        };
        let Ok(mut data) = serde_json::from_str::<Map<String, Value>>(&data) else {
            continue;
        };
        // The row keeps the part's id in a column; the printed event has it inside.
        data.entry("id").or_insert_with(|| Value::String(part_id.clone()));
        let mut rec = Map::new();
        rec.insert("part".into(), Value::Object(data));
        if let Some(message) = messages.last_mut() {
            message.parts.push(Part {
                id: part_id,
                created: row.get(5)?,
                rec,
            });
        }
    }
    Ok(messages)
}

/// The steps of `parent`'s turn that come before `from`, and when it was asked.
fn turn_seed(conn: &Connection, session: &str, from: &Key, parent: &str) -> rusqlite::Result<Seed> {
    let mut stmt = conn.prepare_cached(
        "SELECT p.data FROM message m JOIN part p ON p.message_id = m.id
         WHERE m.session_id = ?1
           AND (m.time_created < ?2 OR (m.time_created = ?2 AND m.id < ?3))
           AND json_extract(m.data, '$.parentID') = ?4
           AND json_extract(p.data, '$.type') = 'step-finish'
         ORDER BY m.time_created, m.id, p.id",
    )?;
    let mut usage = None;
    let steps = stmt.query_map(params![session, from.created, from.id, parent], |row| row.get::<_, String>(0))?;
    for step in steps {
        let Ok(data) = serde_json::from_str::<Value>(&step?) else {
            continue;
        };
        let mut rec = Map::new();
        rec.insert("part".into(), data);
        usage = Some(add_step_usage(usage.as_ref(), &rec));
    }
    let started = conn
        .query_row("SELECT time_created FROM message WHERE id = ?1", params![parent], |row| row.get(0))
        .ok();
    Ok(Seed { usage, started })
}

fn role(data: &Map<String, Value>) -> Option<&str> {
    data.get("role")?.as_str()
}

fn time_field(data: &Map<String, Value>, key: &str) -> Option<i64> {
    data.get("time").and_then(as_record)?.get(key)?.as_i64()
}

fn message_error(data: &Map<String, Value>) -> Option<&Value> {
    data.get("error").filter(|error| !error.is_null())
}

/// Nothing more will be written to the message.
fn closed(data: &Map<String, Value>) -> bool {
    message_error(data).is_some() || time_field(data, "completed").is_some()
}

/// The answer is over: it failed, or its last step stopped for good rather
/// than to run the tools it called.
fn finished(data: &Map<String, Value>) -> bool {
    message_error(data).is_some()
        || (closed(data) && string_field(Some(data), "finish").as_deref() != Some("tool-calls"))
}

/// A text or reasoning part opencode has started and not yet closed.
fn unended(data: &Map<String, Value>) -> bool {
    data.contains_key("time") && time_field(data, "end").is_none()
}

fn flag(data: Option<&Map<String, Value>>, key: &str) -> bool {
    data.and_then(|data| data.get(key)) == Some(&Value::Bool(true))
}

struct Built {
    blocks: Vec<Block>,
    answering: bool,
}

/// `live` says the range runs to the session's end, so its last message may
/// still be being written.
fn build(messages: &[Message], seed: Seed, live: bool) -> Built {
    let mut out = Builder {
        blocks: Vec::new(),
        usage: seed.usage,
        started: seed.started,
    };
    for (index, message) in messages.iter().enumerate() {
        let writing = live && index + 1 == messages.len() && !closed(&message.data);
        let start = out.blocks.len();
        match role(&message.data) {
            Some("user") => out.user(message),
            Some("assistant") => out.assistant(message, writing),
            _ => {}
        }
        // Only the message being written can have a part still open; anything
        // left open in one that is done ran on, with no result coming.
        if !writing && start < out.blocks.len() {
            let own = out.blocks.split_off(start);
            out.blocks.extend(settle_turn(own, ToolStatus::Completed));
        }
    }
    let answering = live
        && messages.last().is_some_and(|last| match role(&last.data) {
            Some("user") => true,
            Some("assistant") => !finished(&last.data),
            _ => false,
        });
    Built {
        blocks: out.blocks,
        answering,
    }
}

struct Builder {
    blocks: Vec<Block>,
    /// The turn's steps so far: opencode counts each one apart.
    usage: Option<TurnUsage>,
    started: Option<i64>,
}

impl Builder {
    /// Applies `events` and names the blocks they created `source`,
    /// `source.1`, …, dated `at`. A block they restamped (a turn's usage) is
    /// dated `at` too, as `super::apply_stamped` does for the JSONL histories.
    fn apply(&mut self, source: &str, at: i64, events: Vec<HarnessEvent>) {
        let before = self.blocks.len();
        let last = self.blocks.last().map(|block| (block.id.clone(), block.at));
        for event in events {
            self.blocks = apply_event(std::mem::take(&mut self.blocks), event);
        }
        let mut made = 0;
        for (index, block) in self.blocks.iter_mut().enumerate().skip(before.saturating_sub(1)) {
            if index >= before {
                block.id = match made {
                    0 => source.to_string(),
                    n => format!("{source}.{n}"),
                };
                made += 1;
                block.at = Some(at);
            } else if last.as_ref().is_some_and(|(id, stamp)| *id != block.id || *stamp != block.at) {
                block.at = Some(at);
            }
        }
    }

    fn user(&mut self, message: &Message) {
        self.usage = None;
        self.started = Some(message.created);
        // Synthetic text is what opencode adds for the model (a file's
        // contents, a command's template), never what was typed.
        let typed: Vec<&str> = message
            .parts
            .iter()
            .filter(|part| part.kind() == Some("text"))
            .filter(|part| !flag(part.data(), "synthetic") && !flag(part.data(), "ignored"))
            .filter_map(|part| part.data()?.get("text")?.as_str())
            .collect();
        let text = typed.join("\n");
        let text = text.trim_end();
        if !text.trim().is_empty() {
            let event = HarnessEvent::UserMessage {
                text: text.to_string(),
                hidden: None,
                files: None,
                from_bot: None,
            };
            self.apply(&message.id, message.created, vec![event]);
        }
        for part in message.parts.iter().filter(|part| part.kind() == Some("compaction")) {
            let note = HarnessEvent::SessionNote {
                message: "Context compacted".into(),
            };
            self.apply(&part.id, part.created, vec![note]);
        }
    }

    fn assistant(&mut self, message: &Message, writing: bool) {
        // A compaction's summary is written for the model, as Claude's is.
        if flag(Some(&message.data), "summary") {
            return;
        }
        for part in &message.parts {
            let open = writing && part.data().is_some_and(unended);
            match part.kind() {
                Some("text") if !flag(part.data(), "synthetic") && !flag(part.data(), "ignored") => {
                    if let Some(text) = text_part(&part.rec).filter(|text| !text.text.trim().is_empty()) {
                        self.streamed(part, HarnessEvent::MessageDelta { text: text.text }, open);
                    }
                }
                Some("reasoning") => {
                    let text = part.data().and_then(|data| data.get("text")?.as_str()).unwrap_or_default();
                    if !text.trim().is_empty() {
                        self.streamed(part, HarnessEvent::ReasoningDelta { text: text.to_string() }, open);
                    }
                }
                Some("tool") => self.tool(part, writing),
                Some("step-finish") => self.step_finish(part),
                _ => {}
            }
        }
        if let Some(error) = message_error(&message.data) {
            // Esc in the TUI aborts the message; that is the user stopping
            // it, not something going wrong.
            let aborted = string_field(error.as_object(), "name").as_deref() == Some("MessageAbortedError");
            let mut rec = Map::new();
            rec.insert("error".into(), error.clone());
            let message_text = if aborted {
                "Interrupted".to_string()
            } else {
                stream_error_message(&rec)
            };
            let mut events = Vec::new();
            if let Some(usage) = self.end_turn(time_field(&message.data, "completed")) {
                events.push(HarnessEvent::TurnCompleted { usage: Some(usage) });
            }
            events.push(HarnessEvent::SessionError { message: message_text });
            let at = time_field(&message.data, "completed").unwrap_or(message.updated);
            self.apply(&format!("{}.error", message.id), at, events);
        }
    }

    /// A text or reasoning part: whole, as opencode writes it, and still open
    /// while the message that holds it is being written and it has no end.
    fn streamed(&mut self, part: &Part, delta: HarnessEvent, open: bool) {
        // Two parts in a row are two messages, not one that grew.
        let mut events = vec![HarnessEvent::MessageCompleted {}, delta];
        if !open {
            events.push(HarnessEvent::MessageCompleted {});
        }
        self.apply(&part.id, part.created, events);
    }

    fn tool(&mut self, part: &Part, writing: bool) {
        let Some(call) = parse_tool_call(&part.rec) else {
            return;
        };
        let state = part.data().and_then(|data| data.get("state")).and_then(as_record);
        let status = match string_field(state, "status").as_deref() {
            Some("pending" | "running") if writing => ToolStatus::Pending,
            _ => call.status,
        };
        let events = vec![
            HarnessEvent::ToolStarted {
                call_id: call.call_id.clone(),
                name: call.name,
                title: call.title,
                detail: call.detail.clone(),
            },
            HarnessEvent::ToolUpdated {
                call_id: call.call_id,
                title: None,
                status: Some(status),
                detail: call.detail,
            },
        ];
        self.apply(&part.id, part.created, events);
    }

    fn step_finish(&mut self, part: &Part) {
        self.usage = Some(add_step_usage(self.usage.as_ref(), &part.rec));
        if !turn_ended(&part.rec) {
            return;
        }
        let mut events = vec![
            HarnessEvent::MessageCompleted {},
            HarnessEvent::TurnCompleted {
                usage: self.end_turn(Some(part.created)),
            },
        ];
        // A step can stop for a reason that is not success; the turn that died
        // mid-answer says so, as an agent turn does.
        if let Some(reason) = step_failure(&part.rec) {
            events.push(HarnessEvent::SessionError { message: reason });
        }
        self.apply(&part.id, part.created, events);
    }

    /// The turn's usage, with how long it took, and a clean slate for the next.
    fn end_turn(&mut self, at: Option<i64>) -> Option<TurnUsage> {
        let mut usage = self.usage.take()?;
        usage.duration_ms = match (self.started.take(), at) {
            (Some(started), Some(at)) if at >= started => Some((at - started) as u64),
            _ => None,
        };
        Some(usage)
    }
}

impl SessionHistory for OpencodeHistory {
    fn poll(&mut self) -> io::Result<Option<Change>> {
        OpencodeHistory::poll(self)
    }
    fn window(&self, before: Option<i64>, limit: usize) -> Window {
        OpencodeHistory::window(self, before, limit)
    }
    fn load_earlier(&mut self, min_messages: usize) -> io::Result<usize> {
        OpencodeHistory::load_earlier(self, min_messages)
    }
    fn has_earlier(&self) -> bool {
        OpencodeHistory::has_earlier(self)
    }
    fn is_empty_decode(&self) -> bool {
        OpencodeHistory::is_empty_decode(self)
    }
    fn base(&self) -> i64 {
        OpencodeHistory::base(self)
    }
    fn blocks(&self) -> &[Block] {
        OpencodeHistory::blocks(self)
    }
    fn path(&self) -> &Path {
        OpencodeHistory::path(self)
    }
    fn exists(&self) -> bool {
        OpencodeHistory::exists(self)
    }
}

#[cfg(test)]
mod tests {
    use crew_protocol::{BlockRole, ToolDetail};
    use serde_json::json;

    use super::*;

    const SCHEMA: &str = include_str!("../../tests/fixtures/opencode/opencode-schema.sql");
    /// Four turns run with `opencode run` on nemotron-3.5-lightning-free:
    /// a write, a plain question, a read, and a shell command that fails.
    const SESSION: &str = include_str!("../../tests/fixtures/opencode/opencode-session.jsonl");
    const SESSION_ID: &str = "ses_f165df3f1ffeT02rFye5kYcFAQ";
    /// A turn the provider refused: the assistant message carries the error.
    const ERROR: &str = include_str!("../../tests/fixtures/opencode/opencode-error.jsonl");
    const ERROR_ID: &str = "ses_f165fa9e3ffeJwkyevRlVncUXm";
    /// Every version of every row, in the order a reader polling the database
    /// saw them while opencode ran a shell command and answered.
    const LIVE: &str = include_str!("../../tests/fixtures/opencode/opencode-live.jsonl");
    const LIVE_ID: &str = "ses_f165357f1ffeO3WW3dxDjeo967";

    struct Db {
        dir: PathBuf,
        conn: Option<Connection>,
    }

    impl Db {
        /// A folder with no database in it yet.
        fn missing() -> Self {
            let dir = std::env::temp_dir().join(format!("crew-opencode-history-{}", uuid::Uuid::new_v4()));
            std::fs::create_dir_all(&dir).expect("temp dir");
            Db { dir, conn: None }
        }

        fn new() -> Self {
            let mut db = Self::missing();
            db.create();
            db
        }

        fn with(fixture: &str) -> Self {
            let db = Self::new();
            db.load(fixture);
            db
        }

        fn path(&self) -> PathBuf {
            self.dir.join("opencode.db")
        }

        fn create(&mut self) {
            let conn = Connection::open(self.path()).expect("create db");
            conn.pragma_update(None, "journal_mode", "WAL").expect("wal");
            // The rows come without their `session` row, which the schema's
            // keys point at; the bundled SQLite enforces them by default.
            conn.pragma_update(None, "foreign_keys", false).expect("no keys");
            conn.execute_batch(SCHEMA).expect("schema");
            self.conn = Some(conn);
        }

        fn conn(&self) -> &Connection {
            self.conn.as_ref().expect("created")
        }

        fn load(&self, fixture: &str) {
            for line in fixture.lines().filter(|line| !line.trim().is_empty()) {
                self.upsert(&serde_json::from_str(line).expect("fixture row"));
            }
        }

        /// Writes a row the way opencode does: inserted once, then replaced
        /// whole on every change.
        fn upsert(&self, row: &Value) {
            let text = |key: &str| row[key].as_str().expect(key).to_string();
            let int = |key: &str| row[key].as_i64().expect(key);
            match row["table"].as_str() {
                Some("message") => self.conn().execute(
                    "INSERT OR REPLACE INTO message (id, session_id, time_created, time_updated, data)
                     VALUES (?1, ?2, ?3, ?4, ?5)",
                    params![text("id"), text("session_id"), int("time_created"), int("time_updated"), text("data")],
                ),
                Some("part") => self.conn().execute(
                    "INSERT OR REPLACE INTO part (id, message_id, session_id, time_created, time_updated, data)
                     VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
                    params![
                        text("id"),
                        text("message_id"),
                        text("session_id"),
                        int("time_created"),
                        int("time_updated"),
                        text("data")
                    ],
                ),
                other => panic!("unknown table {other:?}"),
            }
            .expect("upsert");
        }
    }

    impl Drop for Db {
        fn drop(&mut self) {
            self.conn = None;
            let _ = std::fs::remove_dir_all(&self.dir);
        }
    }

    fn open(db: &Db, session: &str, min: usize) -> OpencodeHistory {
        OpencodeHistory::open(&db.path(), session, min).expect("open")
    }

    fn shape(blocks: &[Block]) -> Vec<(BlockRole, String)> {
        blocks.iter().map(|block| (block.role.clone(), block.text.clone())).collect()
    }

    fn roles(blocks: &[Block]) -> Vec<BlockRole> {
        blocks.iter().map(|block| block.role.clone()).collect()
    }

    fn tool(block: &Block) -> &crew_protocol::BlockTool {
        block.tool.as_ref().expect("a tool row")
    }

    #[test]
    fn a_session_reads_as_its_turns() {
        use BlockRole::{Assistant, Reasoning, Tool, User};
        let db = Db::with(SESSION);
        let history = open(&db, SESSION_ID, 300);
        let blocks = history.blocks();
        assert_eq!(
            roles(blocks),
            [
                User, Reasoning, Tool, Reasoning, Assistant, // write
                User, Reasoning, Assistant, // question
                User, Reasoning, Tool, Reasoning, Assistant, // read
                User, Reasoning, Tool, Reasoning, Assistant, // failing command
            ]
        );
        let said: Vec<&str> = blocks
            .iter()
            .filter(|block| matches!(block.role, User | Assistant | Tool))
            .map(|block| block.text.as_str())
            .collect();
        assert_eq!(
            said,
            [
                "Create a file named hello.txt containing hi, then say done",
                "Write hello.txt",
                "done",
                "What is the capital of France? Answer in one word.",
                "Paris",
                "Read notes.txt and tell me what its second line says.",
                "Read notes.txt",
                "jumps over the lazy dog",
                "Run the shell command: cat missing.txt  -- then tell me in one sentence what happened.",
                "cat missing.txt",
                "The `cat missing.txt` command returned \"No such file or directory,\" meaning the file \
                 `missing.txt` does not exist in the current directory.",
            ]
        );
        assert!(blocks[1].text.starts_with("The user wants me to create a file"));

        let write = tool(&blocks[2]);
        assert_eq!((write.name.as_str(), &write.status), ("write", &ToolStatus::Completed));
        assert!(matches!(&write.detail, Some(ToolDetail::Edit { path, .. }) if path.ends_with("/repo/hello.txt")));
        let read = tool(&blocks[10]);
        assert_eq!(read.status, ToolStatus::Completed);
        assert!(matches!(
            &read.detail,
            Some(ToolDetail::File { preview: Some(text), .. }) if text.contains("lazy dog")
        ));
        // `cat` exited 1, which opencode still calls completed.
        let cat = tool(&blocks[15]);
        assert_eq!(cat.status, ToolStatus::Failed);
        assert!(matches!(&cat.detail, Some(ToolDetail::Command { exit_code: Some(1), .. })));

        // Named and dated by opencode's own rows.
        assert_eq!(blocks[0].id, "msg_0e9a20c39001QBmsKVzNH32O8Q");
        assert_eq!(blocks[0].at, Some(1_790_626_106_425));
        assert_eq!(blocks[2].id, "prt_0e9a21c2c001X5SE1RZz5Cj2Gr");
        assert_eq!(blocks[2].at, Some(1_790_626_110_508));
        assert!(blocks.iter().all(|block| block.streaming != Some(true)));

        // The turn's two steps add up on its last row, dated when it stopped.
        let usage = blocks[4].usage.as_ref().expect("the write turn's usage");
        assert_eq!((usage.input_tokens, usage.output_tokens), (Some(20_747), Some(163)));
        assert_eq!(usage.duration_ms, Some(1_790_626_112_379 - 1_790_626_106_425));
        assert_eq!(blocks[4].at, Some(1_790_626_112_379));

        assert!(history.exists());
        assert!(!history.has_earlier());
        assert!(!history.is_empty_decode());
        assert_eq!(history.path(), db.path());
    }

    #[test]
    fn a_provider_error_ends_the_turn_with_its_message() {
        let db = Db::with(ERROR);
        let history = open(&db, ERROR_ID, 300);
        assert_eq!(
            shape(history.blocks()),
            [
                (
                    BlockRole::User,
                    "\"Create a file named hello.txt containing hi, then say done\"".to_string()
                ),
                (
                    BlockRole::System,
                    "Error from provider (Console): Upstream request failed: Endpoint is unavailable.".to_string()
                ),
            ]
        );
        assert_eq!(history.blocks()[1].id, "msg_0e9a058a2001oSfiT7SwUQnFYC.error");
    }

    #[test]
    fn nothing_written_is_no_change_and_ids_survive_a_rebuild() {
        let db = Db::with(SESSION);
        let mut history = open(&db, SESSION_ID, 300);
        assert_eq!(history.poll().expect("poll"), None);
        let ids: Vec<String> = history.blocks().iter().map(|block| block.id.clone()).collect();

        // opencode rewrites a prompt's row when it adds the turn's diff
        // summary: the rows moved, the blocks did not.
        db.conn()
            .execute(
                "UPDATE message SET time_updated = time_updated + 60000 WHERE id = 'msg_0e9a2376d001CK8HyA8pisNFf7'",
                [],
            )
            .expect("touch");
        assert_eq!(history.poll().expect("poll"), None);
        let again: Vec<String> = history.blocks().iter().map(|block| block.id.clone()).collect();
        assert_eq!(again, ids);
    }

    /// Replays every version of every row the CLI wrote, polling after each
    /// one as crewd would.
    #[test]
    fn the_cli_writing_a_turn_updates_its_rows_in_place() {
        let db = Db::new();
        let mut history = open(&db, LIVE_ID, 300);
        assert!(history.blocks().is_empty() && !history.exists());

        let mut changes = Vec::new();
        let mut seen: Vec<(Vec<String>, Vec<Block>)> = Vec::new();
        for line in LIVE.lines() {
            let row: Value = serde_json::from_str(line).expect("row");
            // The CLI's own text went from empty to whole between two looks;
            // one in the middle shows the part growing where it stands.
            if row["id"] == "prt_0e9acc0b2001wdACI615wkEAkG" && row["data"].as_str().unwrap().contains("finished") {
                let mut partial = row.clone();
                let growing = json!({ "type": "text", "text": "fini", "time": { "start": 1_790_626_807_986_i64 } });
                partial["data"] = json!(growing.to_string());
                partial["time_updated"] = json!(1_790_626_808_000_i64);
                db.upsert(&partial);
                let change = history.poll().expect("poll").expect("the text grew");
                let text = history.blocks().last().unwrap();
                assert_eq!((text.text.as_str(), text.streaming), ("fini", Some(true)));
                assert_eq!(change.from, history.blocks().len() as i64 - 1);
                changes.push(change);
            }
            db.upsert(&row);
            if let Some(change) = history.poll().expect("poll") {
                changes.push(change);
            }
            assert!(history.exists());
            let ids = history.blocks().iter().map(|block| block.id.clone()).collect();
            seen.push((ids, history.blocks().to_vec()));
        }

        let blocks = history.blocks();
        assert_eq!(
            roles(blocks),
            [BlockRole::User, BlockRole::Reasoning, BlockRole::Tool, BlockRole::Reasoning, BlockRole::Assistant]
        );
        assert_eq!(blocks[4].text, "finished");
        assert_eq!(blocks[4].streaming, Some(false));
        assert!(matches!(
            &tool(&blocks[2]).detail,
            Some(ToolDetail::Command { output: Some(out), exit_code: Some(0), .. }) if out == "ok\n"
        ));

        // A block, once there, keeps its id and its place.
        for (ids, _) in &seen {
            let held: Vec<&String> = blocks.iter().map(|block| &block.id).take(ids.len()).collect();
            assert_eq!(held, ids.iter().collect::<Vec<_>>());
        }

        // The call went pending → running → completed on one row, and each
        // change started at that row.
        let tool_states: Vec<(String, ToolStatus)> = changes
            .iter()
            .filter(|change| change.from == 2)
            .filter_map(|change| change.blocks.first())
            .map(|block| (block.text.clone(), tool(block).status.clone()))
            .collect();
        assert_eq!(
            tool_states,
            [
                ("Bash".to_string(), ToolStatus::Pending),
                ("sleep 2 && echo ok".to_string(), ToolStatus::Pending),
                ("sleep 2 && echo ok".to_string(), ToolStatus::Completed),
            ]
        );

        // Only the step that stopped for good ended the turn, once.
        let ended: Vec<&Change> = changes.iter().filter(|change| change.turn_ended).collect();
        assert_eq!(ended.len(), 1);
        assert!(std::ptr::eq(ended[0], changes.last().unwrap()));
        assert!(changes.iter().all(|change| !change.reset));
        assert_eq!(history.poll().expect("poll"), None);
    }

    #[test]
    fn open_holds_the_tail_and_earlier_pages_come_in_front() {
        let db = Db::with(SESSION);
        let whole = open(&db, SESSION_ID, 300).blocks().to_vec();

        // The last three messages: the failing command's turn.
        let mut history = open(&db, SESSION_ID, 3);
        assert_eq!(history.blocks(), &whole[13..]);
        assert_eq!(history.base(), 0);
        assert!(history.has_earlier());
        assert!(history.window(None, 100).more);

        // The two steps of the read's answer, without the prompt they answer.
        let added = history.load_earlier(2).expect("earlier");
        assert_eq!(added, 4);
        assert_eq!(history.base(), -4);
        assert_eq!(history.blocks(), &whole[9..]);

        while history.load_earlier(2).expect("earlier") > 0 {}
        assert_eq!(history.blocks(), whole.as_slice());
        assert_eq!(history.base(), -13);
        assert!(!history.has_earlier());
        assert!(!history.window(None, 100).more);
        assert_eq!(history.load_earlier(2).expect("earlier"), 0);

        let window = history.window(Some(history.base() + 5), 3);
        assert_eq!(window.start, history.base() + 2);
        assert_eq!(window.blocks, whole[2..5]);
        assert!(window.more);

        // A tail that starts inside a turn still adds the whole turn up.
        let last = open(&db, SESSION_ID, 1);
        assert_eq!(last.blocks(), &whole[16..]);
        assert!(last.blocks()[1].usage.is_some());
    }

    #[test]
    fn a_page_that_ends_on_a_running_call_settles_it() {
        let db = Db::with(SESSION);
        // The read left running, as if opencode died there; the next turn
        // went on regardless.
        db.conn()
            .execute(
                "UPDATE part SET data = json_set(data, '$.state.status', 'running')
                 WHERE id = 'prt_0e9a27e6c001djH0JkX26r7jx3'",
                [],
            )
            .expect("unfinish");
        let mut history = open(&db, SESSION_ID, 4);
        while history.load_earlier(1).expect("earlier") > 0 {}
        let read = history.blocks().iter().find(|block| block.text == "Read notes.txt").expect("read row");
        assert_eq!(tool(read).status, ToolStatus::Completed);
    }

    #[test]
    fn a_missing_database_or_session_fills_in_once_rows_appear() {
        let mut db = Db::missing();
        let mut history = open(&db, SESSION_ID, 300);
        assert!(history.blocks().is_empty());
        assert!(!history.exists() && !history.is_empty_decode() && !history.has_earlier());
        assert_eq!(history.poll().expect("poll"), None);

        // opencode creates the file before its tables.
        drop(Connection::open(db.path()).expect("bare db").execute_batch("PRAGMA user_version = 1;"));
        assert_eq!(history.poll().expect("poll"), None);
        std::fs::remove_file(db.path()).expect("remove");

        db.create();
        assert_eq!(history.poll().expect("poll"), None);
        db.load(ERROR);
        assert_eq!(history.poll().expect("poll"), None, "another session's rows");
        assert!(!history.exists());

        db.load(SESSION);
        let change = history.poll().expect("poll").expect("a change");
        assert_eq!(change.from, 0);
        assert_eq!(change.blocks.len(), 18);
        assert!(!change.turn_ended, "a turn that was over before it was seen");
        assert!(history.exists());
    }

    #[test]
    fn messages_that_decode_to_nothing_are_an_error_not_an_empty_chat() {
        let db = Db::new();
        db.upsert(&json!({
            "table": "message", "id": "msg_1", "session_id": "ses_x", "time_created": 1, "time_updated": 1,
            "data": json!({ "role": "assistant", "time": { "created": 1, "completed": 2 } }).to_string(),
        }));
        db.upsert(&json!({
            "table": "part", "id": "prt_1", "message_id": "msg_1", "session_id": "ses_x", "time_created": 1,
            "time_updated": 1, "data": json!({ "type": "hologram" }).to_string(),
        }));
        let history = open(&db, "ses_x", 300);
        assert!(history.exists());
        assert!(history.is_empty_decode());
    }
}
