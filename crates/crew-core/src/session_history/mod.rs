//! A provider CLI's own session file, read as the chat's history.
//!
//! The CLI in the terminal is the only writer; this side only ever reads, by
//! byte offset, while the file grows under it. A decoder per provider turns
//! each record into the same `HarnessEvent`s an agent turn produces, so the
//! chat renders both the same way.

pub mod claude;
pub mod codex;
pub mod opencode;

use std::fs::File;
use std::io::{self, Read as _, Seek, SeekFrom};
use std::path::{Path, PathBuf};

use crew_protocol::{Block, HarnessEvent, ToolStatus};

use crate::blocks::{apply_event, settle_turn};

/// Records past this are skipped whole. A pasted screenshot or a giant tool
/// result can make one line tens of megabytes; nothing in it is worth holding
/// the whole thing in memory for.
pub const MAX_RECORD_BYTES: usize = 2 * 1024 * 1024;

/// How far back each step reads when looking for where the last messages start.
const BACK_CHUNK: u64 = 256 * 1024;
const FORWARD_CHUNK: usize = 64 * 1024;

#[derive(Debug, Clone, PartialEq)]
pub enum Decoded {
    /// Applied with `crate::blocks::apply_event`; `at_ms` (from the record's own
    /// timestamp) stamps the blocks it creates.
    Event { event: HarnessEvent, at_ms: Option<i64> },
    /// The CLI finished (or was interrupted out of) a turn: lets the caller
    /// clear a stuck spinner.
    TurnEnded { at_ms: Option<i64> },
}

pub trait Decoder {
    fn decode(&mut self, line: &str) -> Vec<Decoded>;
    /// Whether a line counts toward "the last n messages". Called on raw
    /// bytes while reading backwards, so it should be cheap.
    fn is_message(&self, line: &[u8]) -> bool;
    /// What the decoder still holds once its lines run out, for a page that
    /// ends where the next one was already read: nothing will follow to
    /// bring it out.
    fn finish(&mut self) -> Vec<Decoded> {
        Vec::new()
    }
}

/// What one `LineReader::read` found.
#[derive(Debug, Default, PartialEq)]
pub struct Read {
    pub lines: Vec<String>,
    /// The file shrank or was replaced: `lines` start from its beginning, and
    /// anything read before belongs to a file that is gone.
    pub reset: bool,
    pub exists: bool,
}

/// Cuts bytes into lines as they arrive, carrying a half-written last line
/// and dropping any line longer than `MAX_RECORD_BYTES` without buffering it.
#[derive(Default)]
struct Splitter {
    carry: Vec<u8>,
    skipping: bool,
}

impl Splitter {
    fn push(&mut self, mut bytes: &[u8], out: &mut Vec<String>) {
        while let Some(at) = bytes.iter().position(|&b| b == b'\n') {
            if self.skipping {
                self.skipping = false;
            } else {
                self.carry.extend_from_slice(&bytes[..at]);
                if self.carry.len() <= MAX_RECORD_BYTES {
                    emit(&self.carry, out);
                }
            }
            self.carry.clear();
            bytes = &bytes[at + 1..];
        }
        if self.skipping {
            return;
        }
        self.carry.extend_from_slice(bytes);
        if self.carry.len() > MAX_RECORD_BYTES {
            self.carry = Vec::new();
            self.skipping = true;
        }
    }
}

fn emit(line: &[u8], out: &mut Vec<String>) {
    let line = line.strip_suffix(b"\r").unwrap_or(line);
    if line.iter().all(u8::is_ascii_whitespace) {
        return;
    }
    out.push(String::from_utf8_lossy(line).into_owned());
}

/// The file's identity, so a file written anew and renamed over the old one
/// is noticed even when it is already longer than what was read.
#[cfg(unix)]
fn identity(meta: &std::fs::Metadata) -> (u64, u64) {
    use std::os::unix::fs::MetadataExt;
    (meta.dev(), meta.ino())
}

#[cfg(not(unix))]
fn identity(_meta: &std::fs::Metadata) -> (u64, u64) {
    (0, 0)
}

/// Reads the complete lines appended to a file since the last read.
pub struct LineReader {
    path: PathBuf,
    /// How far the file has been read, the carried partial line included.
    pos: u64,
    split: Splitter,
    identity: Option<(u64, u64)>,
}

impl LineReader {
    pub fn new(path: impl Into<PathBuf>) -> Self {
        Self::at(path, 0)
    }

    /// Starts reading at `offset`, which must be a line start.
    pub fn at(path: impl Into<PathBuf>, offset: u64) -> Self {
        Self {
            path: path.into(),
            pos: offset,
            split: Splitter::default(),
            identity: None,
        }
    }

    pub fn path(&self) -> &Path {
        &self.path
    }

    /// The offset every returned line ends before: where a reader of the same
    /// file would pick up.
    pub fn offset(&self) -> u64 {
        self.pos - self.split.carry.len() as u64
    }

    /// Whether the next read would start over: the file shrank below what was
    /// read, or another file took its name. Asks the filesystem only.
    pub fn stale(&self) -> io::Result<bool> {
        let meta = match std::fs::metadata(&self.path) {
            Ok(meta) => meta,
            Err(err) if err.kind() == io::ErrorKind::NotFound => return Ok(false),
            Err(err) => return Err(err),
        };
        Ok(meta.len() < self.pos || self.identity.is_some_and(|known| known != identity(&meta)))
    }

    pub fn read(&mut self) -> io::Result<Read> {
        let mut file = match File::open(&self.path) {
            Ok(file) => file,
            Err(err) if err.kind() == io::ErrorKind::NotFound => {
                return Ok(Read::default());
            }
            Err(err) => return Err(err),
        };
        let meta = file.metadata()?;
        let id = identity(&meta);
        let replaced = self.identity.is_some_and(|known| known != id);
        let shrank = meta.len() < self.pos;
        self.identity = Some(id);
        let reset = replaced || shrank;
        if reset {
            self.pos = 0;
            self.split = Splitter::default();
        }
        let mut lines = Vec::new();
        file.seek(SeekFrom::Start(self.pos))?;
        let mut buf = vec![0u8; FORWARD_CHUNK];
        loop {
            let n = file.read(&mut buf)?;
            if n == 0 {
                break;
            }
            self.pos += n as u64;
            self.split.push(&buf[..n], &mut lines);
        }
        Ok(Read {
            lines,
            reset,
            exists: true,
        })
    }
}

/// The lines in `[start, end)` of a file, for loading an earlier page. `start`
/// must be a line start; a line cut off by `end` is left out.
pub fn read_range(path: &Path, start: u64, end: u64) -> io::Result<Vec<String>> {
    let mut file = File::open(path)?;
    file.seek(SeekFrom::Start(start))?;
    let mut rest = end.saturating_sub(start);
    let mut split = Splitter::default();
    let mut lines = Vec::new();
    let mut buf = vec![0u8; FORWARD_CHUNK];
    while rest > 0 {
        let want = rest.min(buf.len() as u64) as usize;
        let n = file.read(&mut buf[..want])?;
        if n == 0 {
            break;
        }
        rest -= n as u64;
        split.push(&buf[..n], &mut lines);
    }
    Ok(lines)
}

/// Where the last `n` message lines before `end` start, found by reading
/// backwards so a 200 MB file is not read whole. Always a line start: 0 when
/// the file holds fewer than `n` messages.
pub fn tail_offset(path: &Path, end: u64, n: usize, is_message: impl Fn(&[u8]) -> bool) -> io::Result<u64> {
    if n == 0 {
        return Ok(end);
    }
    let mut file = File::open(path)?;
    let end = end.min(file.metadata()?.len());
    let mut pos = end;
    // The line being assembled right to left, in file order, and whether it
    // grew past the cap (then it is not a message and is not kept).
    let mut tail: Vec<u8> = Vec::new();
    let mut oversized = false;
    let mut seen = 0usize;
    let mut chunk = vec![0u8; BACK_CHUNK as usize];
    while pos > 0 {
        let from = pos.saturating_sub(BACK_CHUNK);
        let len = (pos - from) as usize;
        file.seek(SeekFrom::Start(from))?;
        file.read_exact(&mut chunk[..len])?;
        let bytes = &chunk[..len];
        let mut line_end = len;
        for i in (0..len).rev() {
            if bytes[i] != b'\n' {
                continue;
            }
            if !oversized && tail.len() + (line_end - i - 1) <= MAX_RECORD_BYTES {
                let mut line = bytes[i + 1..line_end].to_vec();
                line.extend_from_slice(&tail);
                if is_message(&line) {
                    seen += 1;
                    if seen == n {
                        return Ok(from + i as u64 + 1);
                    }
                }
            }
            tail.clear();
            oversized = false;
            line_end = i;
        }
        if !oversized {
            if tail.len() + line_end > MAX_RECORD_BYTES {
                tail = Vec::new();
                oversized = true;
            } else {
                let mut joined = bytes[..line_end].to_vec();
                joined.extend_from_slice(&tail);
                tail = joined;
            }
        }
        pos = from;
    }
    Ok(0)
}

/// "Replace every block at global index >= `from` with `blocks`."
#[derive(Debug, Clone, PartialEq)]
pub struct Change {
    pub from: i64,
    pub blocks: Vec<Block>,
    pub turn_ended: bool,
    pub reset: bool,
}

#[derive(Debug, Clone, PartialEq)]
pub struct Window {
    pub blocks: Vec<Block>,
    /// The global index of `blocks[0]`.
    pub start: i64,
    /// Older blocks exist, in memory or still unread in the file.
    pub more: bool,
}

/// A session file's blocks, the tail of it at first, kept up to date as the
/// CLI appends and extended backwards a page at a time.
pub struct History<D: Decoder + Default> {
    path: PathBuf,
    decoder: D,
    blocks: Vec<Block>,
    /// The global index of `blocks[0]`. Earlier pages lower it, so a block
    /// keeps its index (and its id) for as long as it is held.
    base: i64,
    /// Where in the file the held range starts.
    start: u64,
    reader: LineReader,
    /// Message records seen: a file with some that decoded to no block is
    /// broken, not empty.
    messages: usize,
    min_messages: usize,
}

impl<D: Decoder + Default> History<D> {
    /// The last `min_messages` messages and everything after them.
    pub fn open(path: impl Into<PathBuf>, decoder: D, min_messages: usize) -> io::Result<Self> {
        let path = path.into();
        let mut history = Self {
            reader: LineReader::new(&path),
            path,
            decoder,
            blocks: Vec::new(),
            base: 0,
            start: 0,
            messages: 0,
            min_messages,
        };
        history.load_tail()?;
        Ok(history)
    }

    /// Starts over at the file's tail. A file that is not there yet is not an
    /// error: the CLI writes it once there is something to write.
    fn load_tail(&mut self) -> io::Result<bool> {
        self.start = match std::fs::metadata(&self.path) {
            Ok(meta) => tail_offset(&self.path, meta.len(), self.min_messages, |line| self.decoder.is_message(line))?,
            Err(err) if err.kind() == io::ErrorKind::NotFound => 0,
            Err(err) => return Err(err),
        };
        self.reader = LineReader::at(&self.path, self.start);
        let read = self.reader.read()?;
        if read.reset {
            // Replaced again between the two looks; this read is from the top.
            self.start = 0;
        }
        Ok(self.ingest(read.lines))
    }

    pub fn path(&self) -> &Path {
        &self.path
    }

    pub fn base(&self) -> i64 {
        self.base
    }

    pub fn blocks(&self) -> &[Block] {
        &self.blocks
    }

    /// The global index one past the last block.
    pub fn end(&self) -> i64 {
        self.base + self.blocks.len() as i64
    }

    /// Reads what was appended and says which blocks it changed.
    pub fn poll(&mut self) -> io::Result<Option<Change>> {
        // Checked before reading, so a replaced 200 MB file is read from its
        // tail rather than from the top.
        if self.reader.stale()? {
            self.forget();
            let turn_ended = self.load_tail()?;
            return Ok(Some(self.rebuilt(turn_ended)));
        }
        let read = self.reader.read()?;
        if read.reset {
            self.forget();
            let turn_ended = self.ingest(read.lines);
            return Ok(Some(self.rebuilt(turn_ended)));
        }
        if read.lines.is_empty() {
            return Ok(None);
        }
        // A tool's result rewrites the row it started, which can be far above
        // the end; comparing is what finds where the change begins.
        let before = self.blocks.clone();
        let turn_ended = self.ingest(read.lines);
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

    /// Everything read so far belonged to a file that is gone. The global
    /// indexes carry on from `base`, so the caller replaces from there.
    fn forget(&mut self) {
        self.decoder = D::default();
        self.blocks.clear();
        self.start = 0;
        self.messages = 0;
    }

    fn rebuilt(&self, turn_ended: bool) -> Change {
        Change {
            from: self.base,
            blocks: self.blocks.clone(),
            turn_ended,
            reset: true,
        }
    }

    /// The last `limit` blocks, or the `limit` before global index `before`.
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
            more: start > 0 || self.start > 0,
        }
    }

    /// Whether bytes before the held range are still unread.
    pub fn has_earlier(&self) -> bool {
        self.start > 0
    }

    /// Decodes the `min_messages` messages before the held range and puts
    /// them in front. Returns how many blocks that added: 0 only once the
    /// file's start is reached.
    pub fn load_earlier(&mut self, min_messages: usize) -> io::Result<usize> {
        while self.start > 0 {
            let decoder = D::default();
            let from = tail_offset(&self.path, self.start, min_messages.max(1), |line| decoder.is_message(line))?;
            let lines = read_range(&self.path, from, self.start)?;
            let mut page = Page {
                decoder,
                blocks: Vec::new(),
                messages: 0,
            };
            page.ingest(lines);
            page.finish();
            self.start = from;
            self.messages += page.messages;
            // The page ends where the held range begins, so a call it started
            // may have its result there: it ran, and nothing will come back
            // for this copy of the row.
            let earlier = settle_turn(page.blocks, ToolStatus::Completed);
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

    /// Message records were read and none of them became a block: the file
    /// is in a shape this decoder does not know, which the chat reports
    /// rather than showing an empty conversation.
    pub fn is_empty_decode(&self) -> bool {
        self.messages > 0 && self.blocks.is_empty()
    }

    /// Returns whether a turn ended along the way.
    fn ingest(&mut self, lines: Vec<String>) -> bool {
        let mut page = Page {
            decoder: std::mem::take(&mut self.decoder),
            blocks: std::mem::take(&mut self.blocks),
            messages: 0,
        };
        let turn_ended = page.ingest(lines);
        self.decoder = page.decoder;
        self.blocks = page.blocks;
        self.messages += page.messages;
        turn_ended
    }
}

/// A run of lines decoded into blocks by one decoder.
struct Page<D: Decoder> {
    decoder: D,
    blocks: Vec<Block>,
    messages: usize,
}

impl<D: Decoder> Page<D> {
    fn ingest(&mut self, lines: Vec<String>) -> bool {
        let mut turn_ended = false;
        for line in lines {
            if self.decoder.is_message(line.as_bytes()) {
                self.messages += 1;
            }
            for decoded in self.decoder.decode(&line) {
                match decoded {
                    Decoded::Event { event, at_ms } => {
                        self.blocks = apply_stamped(std::mem::take(&mut self.blocks), event, at_ms);
                    }
                    Decoded::TurnEnded { .. } => turn_ended = true,
                }
            }
        }
        turn_ended
    }

    fn finish(&mut self) {
        for decoded in self.decoder.finish() {
            if let Decoded::Event { event, at_ms } = decoded {
                self.blocks = apply_stamped(std::mem::take(&mut self.blocks), event, at_ms);
            }
        }
    }
}

/// `apply_event`, with the blocks it created or restamped dated by the record
/// rather than by when the file happened to be read.
fn apply_stamped(blocks: Vec<Block>, event: HarnessEvent, at_ms: Option<i64>) -> Vec<Block> {
    let before = blocks.len();
    let last = blocks.last().map(|block| (block.id.clone(), block.at));
    let mut next = apply_event(blocks, event);
    let Some(at) = at_ms else {
        return next;
    };
    for (index, block) in next.iter_mut().enumerate().skip(before.saturating_sub(1)) {
        let fresh = index >= before
            || last
                .as_ref()
                .is_some_and(|(id, stamp)| *id != block.id || *stamp != block.at);
        if fresh {
            block.at = Some(at);
        }
    }
    next
}

/// What crewd holds for a chat, whatever the CLI keeps its history in: a
/// JSONL file (Claude, Codex) or a database (opencode).
pub trait SessionHistory: Send {
    /// What changed since the last look, if anything.
    fn poll(&mut self) -> io::Result<Option<Change>>;
    fn window(&self, before: Option<i64>, limit: usize) -> Window;
    fn load_earlier(&mut self, min_messages: usize) -> io::Result<usize>;
    fn has_earlier(&self) -> bool;
    /// Messages are there and none of them decoded: an error, never an empty chat.
    fn is_empty_decode(&self) -> bool;
    fn base(&self) -> i64;
    fn blocks(&self) -> &[Block];
    /// The file whose folder is watched for changes.
    fn path(&self) -> &Path;
    /// The CLI has written anything yet.
    fn exists(&self) -> bool;
}

impl<D: Decoder + Default + Send> SessionHistory for History<D> {
    fn poll(&mut self) -> io::Result<Option<Change>> {
        History::poll(self)
    }
    fn window(&self, before: Option<i64>, limit: usize) -> Window {
        History::window(self, before, limit)
    }
    fn load_earlier(&mut self, min_messages: usize) -> io::Result<usize> {
        History::load_earlier(self, min_messages)
    }
    fn has_earlier(&self) -> bool {
        History::has_earlier(self)
    }
    fn is_empty_decode(&self) -> bool {
        History::is_empty_decode(self)
    }
    fn base(&self) -> i64 {
        History::base(self)
    }
    fn blocks(&self) -> &[Block] {
        History::blocks(self)
    }
    fn path(&self) -> &Path {
        History::path(self)
    }
    fn exists(&self) -> bool {
        History::path(self).exists()
    }
}

#[cfg(test)]
mod tests {
    use std::io::Write;

    use crew_protocol::BlockRole;
    use serde_json::json;

    use super::claude::ClaudeDecoder;
    use super::*;

    struct Dir(PathBuf);

    impl Dir {
        fn new() -> Self {
            let dir = std::env::temp_dir().join(format!("crew-session-history-{}", uuid::Uuid::new_v4()));
            std::fs::create_dir_all(&dir).expect("temp dir");
            Dir(dir)
        }

        fn file(&self) -> PathBuf {
            self.0.join("session.jsonl")
        }
    }

    impl Drop for Dir {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    fn user(text: &str) -> String {
        json!({
            "type": "user",
            "isSidechain": false,
            "message": { "role": "user", "content": text },
            "timestamp": "2026-09-28T18:00:00.000Z",
        })
        .to_string()
    }

    fn reply(text: &str) -> String {
        json!({
            "type": "assistant",
            "isSidechain": false,
            "message": { "role": "assistant", "content": [{ "type": "text", "text": text }] },
            "timestamp": "2026-09-28T18:00:01.000Z",
        })
        .to_string()
    }

    fn bash(id: &str, command: &str) -> String {
        json!({
            "type": "assistant",
            "isSidechain": false,
            "message": {
                "role": "assistant",
                "content": [{ "type": "tool_use", "id": id, "name": "Bash", "input": { "command": command } }],
            },
            "timestamp": "2026-09-28T18:00:02.000Z",
        })
        .to_string()
    }

    fn result(id: &str, output: &str) -> String {
        json!({
            "type": "user",
            "isSidechain": false,
            "message": {
                "role": "user",
                "content": [{ "type": "tool_result", "tool_use_id": id, "content": output, "is_error": false }],
            },
            "timestamp": "2026-09-28T18:00:03.000Z",
        })
        .to_string()
    }

    fn write(path: &Path, lines: &[String]) {
        let body: String = lines.iter().map(|line| format!("{line}\n")).collect();
        std::fs::write(path, body).expect("write");
    }

    fn append(path: &Path, text: &str) {
        let mut file = std::fs::OpenOptions::new().append(true).create(true).open(path).expect("open");
        file.write_all(text.as_bytes()).expect("append");
    }

    fn texts(blocks: &[Block]) -> Vec<String> {
        blocks.iter().map(|block| block.text.clone()).collect()
    }

    fn open(path: &Path, min: usize) -> History<ClaudeDecoder> {
        History::open(path, ClaudeDecoder::default(), min).expect("open")
    }

    #[test]
    fn a_half_written_line_waits_for_its_newline() {
        let dir = Dir::new();
        let path = dir.file();
        write(&path, &[user("hi")]);
        let mut history = open(&path, 300);
        assert_eq!(texts(history.blocks()), ["hi"]);

        let line = reply("hello there");
        let (head, tail) = line.split_at(line.len() / 2);
        append(&path, head);
        assert_eq!(history.poll().expect("poll"), None);
        append(&path, &format!("{tail}\n"));
        let change = history.poll().expect("poll").expect("a change");
        assert_eq!(change.from, 1);
        assert_eq!(texts(&change.blocks), ["hello there"]);
        assert!(!change.reset);
    }

    #[test]
    fn crlf_and_blank_lines_are_not_records() {
        let dir = Dir::new();
        let path = dir.file();
        append(&path, &format!("{}\r\n\n\n{}\n", user("one"), user("two")));
        let mut reader = LineReader::new(&path);
        let read = reader.read().expect("read");
        assert_eq!(read.lines, [user("one"), user("two")]);
        assert!(read.exists && !read.reset);
        assert_eq!(reader.offset(), std::fs::metadata(&path).unwrap().len());
    }

    #[test]
    fn an_oversized_record_is_skipped_and_the_reader_stays_in_step() {
        let dir = Dir::new();
        let path = dir.file();
        write(&path, &[user("before")]);
        let mut history = open(&path, 300);
        let huge = user(&"x".repeat(MAX_RECORD_BYTES + 10));
        append(&path, &format!("{huge}\n{}\n", user("after")));
        let change = history.poll().expect("poll").expect("a change");
        assert_eq!(texts(&change.blocks), ["after"]);
        assert_eq!(texts(history.blocks()), ["before", "after"]);

        // Arriving in pieces, the cap is hit before the newline is.
        let mut reader = LineReader::new(&path);
        let _ = reader.read().expect("read");
        let piece = "y".repeat(MAX_RECORD_BYTES / 2);
        for _ in 0..3 {
            append(&path, &piece);
            assert!(reader.read().expect("read").lines.is_empty());
        }
        append(&path, &format!("tail of the huge one\n{}\n", user("next")));
        assert_eq!(reader.read().expect("read").lines, [user("next")]);
    }

    #[test]
    fn a_file_replaced_under_the_same_name_starts_over() {
        let dir = Dir::new();
        let path = dir.file();
        write(&path, &[user("old one"), reply("old two")]);
        let mut history = open(&path, 300);
        assert_eq!(history.blocks().len(), 2);

        // Longer than what was read, so only the inode gives it away.
        let fresh = dir.0.join("fresh.jsonl");
        write(&fresh, &[user("new one"), reply("new two"), user("new three")]);
        std::fs::rename(&fresh, &path).expect("rename");
        let change = history.poll().expect("poll").expect("a change");
        assert!(change.reset);
        assert_eq!(change.from, history.base());
        assert_eq!(texts(&change.blocks), ["new one", "new two", "new three"]);
        assert_eq!(texts(history.blocks()), ["new one", "new two", "new three"]);
    }

    #[test]
    fn a_file_that_shrank_starts_over() {
        let dir = Dir::new();
        let path = dir.file();
        write(&path, &[user("one"), reply("two"), user("three")]);
        let mut history = open(&path, 300);
        std::fs::OpenOptions::new()
            .write(true)
            .open(&path)
            .expect("open")
            .set_len(0)
            .expect("truncate");
        append(&path, &format!("{}\n", user("again")));
        let change = history.poll().expect("poll").expect("a change");
        assert!(change.reset);
        assert_eq!(texts(history.blocks()), ["again"]);

        let mut reader = LineReader::new(&path);
        let _ = reader.read().expect("read");
        std::fs::write(&path, "").expect("truncate");
        let read = reader.read().expect("read");
        assert!(read.reset && read.lines.is_empty());
    }

    #[test]
    fn a_file_that_appears_late_is_picked_up() {
        let dir = Dir::new();
        let path = dir.file();
        let mut history = open(&path, 300);
        assert!(history.blocks().is_empty());
        assert!(!history.is_empty_decode());
        assert_eq!(history.poll().expect("poll"), None);
        assert!(!LineReader::new(&path).read().expect("read").exists);

        write(&path, &[user("hello"), reply("hi")]);
        let change = history.poll().expect("poll").expect("a change");
        assert_eq!(change.from, 0);
        assert_eq!(texts(&change.blocks), ["hello", "hi"]);
    }

    /// Turn `i`: a prompt, a call, its result, a reply. Four records, three
    /// blocks (the result lands on the call's row).
    fn turns(count: usize) -> Vec<String> {
        (0..count)
            .flat_map(|i| {
                [
                    user(&format!("prompt {i}")),
                    bash(&format!("call-{i}"), &format!("echo {i}")),
                    result(&format!("call-{i}"), &format!("{i}")),
                    reply(&format!("reply {i}")),
                ]
            })
            .collect()
    }

    #[test]
    fn open_decodes_only_the_tail_and_earlier_pages_come_in_front() {
        let dir = Dir::new();
        let path = dir.file();
        write(&path, &turns(10));
        let mut history = open(&path, 8);
        // The last eight messages: the last two turns whole.
        assert_eq!(texts(history.blocks()).first().map(String::as_str), Some("prompt 8"));
        assert_eq!(history.base(), 0);
        assert!(history.window(None, 100).more);
        let held: Vec<String> = history.blocks().iter().map(|block| block.id.clone()).collect();

        let added = history.load_earlier(6).expect("earlier");
        assert!(added > 0);
        assert_eq!(history.base(), -(added as i64));
        let ids: Vec<String> = history.blocks()[added..].iter().map(|block| block.id.clone()).collect();
        assert_eq!(ids, held, "held blocks kept their ids");

        while history.load_earlier(6).expect("earlier") > 0 {}
        assert_eq!(history.blocks().len(), 30);
        assert_eq!(history.blocks()[0].text, "prompt 0");
        assert_eq!(history.base(), -((30 - held.len()) as i64));
        assert!(!history.window(None, 100).more);
        assert!(!history.has_earlier());
        assert!(history
            .blocks()
            .iter()
            .filter_map(|block| block.tool.as_ref())
            .all(|tool| tool.status == ToolStatus::Completed));

        let window = history.window(Some(history.base() + 5), 3);
        assert_eq!(window.start, history.base() + 2);
        assert_eq!(window.blocks.len(), 3);
        assert!(window.more);
    }

    #[test]
    fn a_call_whose_result_is_on_the_later_page_does_not_stay_pending() {
        let dir = Dir::new();
        let path = dir.file();
        write(
            &path,
            &[
                user("go"),
                bash("c1", "sleep 1"),
                result("c1", "done"),
                reply("finished"),
                user("next"),
            ],
        );
        // The tail starts at the result, so the call is on the earlier page.
        let mut history = open(&path, 3);
        assert_eq!(texts(history.blocks()), ["finished", "next"]);
        history.load_earlier(300).expect("earlier");
        let tool = history.blocks()[1].tool.as_ref().expect("tool row");
        assert_eq!(tool.status, ToolStatus::Completed);
    }

    #[test]
    fn a_late_result_changes_from_the_row_it_updates() {
        let dir = Dir::new();
        let path = dir.file();
        write(&path, &[user("go"), bash("c1", "npm test"), reply("running it")]);
        let mut history = open(&path, 300);
        assert_eq!(history.blocks()[1].tool.as_ref().unwrap().status, ToolStatus::Pending);

        append(&path, &format!("{}\n", result("c1", "ok")));
        let change = history.poll().expect("poll").expect("a change");
        assert_eq!(change.from, 1);
        assert_eq!(change.blocks.len(), 2);
        assert_eq!(change.blocks[0].tool.as_ref().unwrap().status, ToolStatus::Completed);
        assert_eq!(change.blocks[1].text, "running it");
    }

    #[test]
    fn records_that_decode_to_nothing_are_an_error_not_an_empty_chat() {
        let dir = Dir::new();
        let path = dir.file();
        let odd = json!({
            "type": "assistant",
            "message": { "role": "assistant", "content": [{ "type": "hologram", "data": "?" }] },
        })
        .to_string();
        write(&path, &[odd.clone(), odd]);
        let history = open(&path, 300);
        assert!(history.blocks().is_empty());
        assert!(history.is_empty_decode());

        let quiet = Dir::new();
        let path = quiet.file();
        write(&path, &[json!({ "type": "mode", "mode": "normal" }).to_string()]);
        assert!(!open(&path, 300).is_empty_decode());
    }

    #[test]
    fn blocks_are_dated_by_their_records() {
        let dir = Dir::new();
        let path = dir.file();
        write(&path, &[user("hi")]);
        let history = open(&path, 300);
        assert_eq!(history.blocks()[0].at, Some(1_790_618_400_000));
        assert_eq!(history.blocks()[0].role, BlockRole::User);
    }

    #[test]
    fn tail_offset_lands_on_a_line_start_across_chunks() {
        let dir = Dir::new();
        let path = dir.file();
        // Lines longer than a chunk, and one past the cap, between messages.
        let long = user(&"a".repeat(300 * 1024));
        let huge = json!({ "type": "attachment", "blob": "b".repeat(MAX_RECORD_BYTES + 1) }).to_string();
        let lines = vec![user("first"), long.clone(), huge, user("third"), long, user("last")];
        write(&path, &lines);
        let len = std::fs::metadata(&path).unwrap().len();
        let decoder = ClaudeDecoder::default();
        let starts: Vec<u64> = lines
            .iter()
            .scan(0u64, |at, line| {
                let start = *at;
                *at += line.len() as u64 + 1;
                Some(start)
            })
            .collect();
        let offset = |n| tail_offset(&path, len, n, |line| decoder.is_message(line)).expect("tail");
        assert_eq!(offset(1), starts[5]);
        assert_eq!(offset(2), starts[4]);
        assert_eq!(offset(3), starts[3]);
        assert_eq!(offset(4), starts[1]);
        assert_eq!(offset(5), 0);
        assert_eq!(offset(50), 0);
        assert_eq!(tail_offset(&path, starts[3], 1, |line| decoder.is_message(line)).unwrap(), starts[1]);

        let range = read_range(&path, starts[3], starts[5]).expect("range");
        assert_eq!(range.len(), 2);
        assert_eq!(range[0], lines[3]);
    }
}
