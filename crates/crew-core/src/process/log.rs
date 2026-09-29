//! A process's output on disk, raw. Two files at most, each named after the
//! absolute offset of its first byte, so a cursor handed to an agent keeps
//! meaning the same byte across rotations and daemon restarts.

use std::fs::{self, File, OpenOptions};
use std::io::{Read, Seek, SeekFrom, Write};
use std::path::{Path, PathBuf};
use std::sync::{Condvar, Mutex};
use std::time::{Duration, Instant};

pub const ROTATE_AT: u64 = 10 * 1024 * 1024;
/// The files kept: the one being written and the one before it.
const KEEP: usize = 2;
/// What a scan reads at a time, so a grep over the whole log is not a 20 MB read.
const SCAN_BLOCK: usize = 1024 * 1024;

struct Segment {
    start: u64,
    len: u64,
}

struct State {
    /// Oldest first; the last is the one appended to.
    segments: Vec<Segment>,
    file: Option<File>,
    /// Bumped by every append and every `notify`, for waiters to tell a wake
    /// that means something from a spurious one.
    seq: u64,
    /// The output so far ends a line, so a note can start its own without a blank one.
    at_line_start: bool,
}

pub struct LogStore {
    dir: PathBuf,
    rotate_at: u64,
    state: Mutex<State>,
    changed: Condvar,
}

fn segment_path(dir: &Path, start: u64) -> PathBuf {
    dir.join(format!("{start:020}.log"))
}

impl LogStore {
    pub fn open(dir: PathBuf, rotate_at: u64) -> Result<Self, String> {
        fs::create_dir_all(&dir).map_err(|e| format!("{}: {e}", dir.display()))?;
        let mut segments: Vec<Segment> = fs::read_dir(&dir)
            .map_err(|e| format!("{}: {e}", dir.display()))?
            .filter_map(|entry| {
                let entry = entry.ok()?;
                let name = entry.file_name();
                let start = name.to_str()?.strip_suffix(".log")?.parse().ok()?;
                let len = entry.metadata().ok()?.len();
                Some(Segment { start, len })
            })
            .collect();
        segments.sort_by_key(|segment| segment.start);
        // A daemon that died mid-rotation may have left a third behind.
        while segments.len() > KEEP {
            let old = segments.remove(0);
            let _ = fs::remove_file(segment_path(&dir, old.start));
        }
        Ok(Self {
            dir,
            rotate_at: rotate_at.max(1),
            state: Mutex::new(State { segments, file: None, seq: 0, at_line_start: true }),
            changed: Condvar::new(),
        })
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, State> {
        self.state.lock().unwrap_or_else(|e| e.into_inner())
    }

    pub fn append(&self, bytes: &[u8]) {
        if bytes.is_empty() {
            return;
        }
        let mut state = self.lock();
        if let Err(error) = self.write(&mut state, bytes) {
            eprintln!("[process] {}: {error}", self.dir.display());
        }
        state.seq += 1;
        state.at_line_start = bytes.ends_with(b"\n");
        drop(state);
        self.changed.notify_all();
    }

    fn write(&self, state: &mut State, bytes: &[u8]) -> std::io::Result<()> {
        let full = state.segments.last().is_none_or(|last| last.len >= self.rotate_at);
        if full {
            let start = end_of(&state.segments);
            state.file = None;
            state.segments.push(Segment { start, len: 0 });
            while state.segments.len() > KEEP {
                let old = state.segments.remove(0);
                let _ = fs::remove_file(segment_path(&self.dir, old.start));
            }
        }
        let last = state.segments.last_mut().expect("a segment was just ensured");
        if state.file.is_none() {
            state.file = Some(
                OpenOptions::new()
                    .create(true)
                    .append(true)
                    .open(segment_path(&self.dir, last.start))?,
            );
        }
        // Counted even if the disk refuses it: the cursor is the bytes the
        // process wrote, and a hole reads back short rather than shifting
        // every later offset.
        last.len += bytes.len() as u64;
        state.file.as_mut().expect("opened above").write_all(bytes)
    }

    /// Wakes whoever waits on this log without adding to it: the process ended.
    pub fn notify(&self) {
        self.lock().seq += 1;
        self.changed.notify_all();
    }

    /// A note from Crew on its own line: after the output's last newline, or after one of its own.
    pub fn note(&self, text: &str) {
        let lead = if self.lock().at_line_start { "" } else { "\r\n" };
        self.append(format!("{lead}\x1b[2m[crew] {text}\x1b[0m\r\n").as_bytes());
    }

    pub fn seq(&self) -> u64 {
        self.lock().seq
    }

    /// Blocks until something changes after `seen` or `deadline` passes.
    pub fn wait_change(&self, seen: u64, deadline: Instant) {
        let mut state = self.lock();
        while state.seq == seen {
            let left = deadline.saturating_duration_since(Instant::now());
            if left.is_zero() {
                return;
            }
            state = self
                .changed
                .wait_timeout(state, left.min(Duration::from_secs(1)))
                .unwrap_or_else(|e| e.into_inner())
                .0;
        }
    }

    /// Bytes ever written: the cursor after the last one.
    pub fn total(&self) -> u64 {
        end_of(&self.lock().segments)
    }

    /// The oldest offset still on disk.
    pub fn first(&self) -> u64 {
        self.lock().segments.first().map_or(0, |segment| segment.start)
    }

    /// `[from, to)` clamped to what is on disk, and where it really starts.
    pub fn read(&self, from: u64, to: u64) -> (u64, Vec<u8>) {
        let state = self.lock();
        let first = state.segments.first().map_or(0, |segment| segment.start);
        let from = from.max(first);
        let to = to.min(end_of(&state.segments));
        let mut out = Vec::with_capacity(to.saturating_sub(from) as usize);
        for segment in &state.segments {
            let seg_end = segment.start + segment.len;
            if seg_end <= from || segment.start >= to {
                continue;
            }
            let lo = from.max(segment.start);
            let hi = to.min(seg_end);
            let Ok(mut file) = File::open(segment_path(&self.dir, segment.start)) else {
                continue;
            };
            if file.seek(SeekFrom::Start(lo - segment.start)).is_err() {
                continue;
            }
            let _ = file.take(hi - lo).read_to_end(&mut out);
        }
        (from, out)
    }

    /// Calls `each(offset, line)` for every line in `[from, to)`, the newline
    /// left off. A last line with no newline yet comes through as well; the
    /// return is where the complete lines end.
    pub fn scan_lines(&self, from: u64, to: u64, mut each: impl FnMut(u64, &[u8], bool) -> bool) -> u64 {
        let mut pos = from.max(self.first());
        let mut carry: Vec<u8> = Vec::new();
        let mut carry_at = pos;
        while pos < to {
            let (at, block) = self.read(pos, to.min(pos + SCAN_BLOCK as u64));
            if block.is_empty() {
                break;
            }
            if at != pos {
                // Rotated away under the scan: start over from what is there.
                carry.clear();
                carry_at = at;
            }
            pos = at + block.len() as u64;
            let mut rest = &block[..];
            while let Some(newline) = rest.iter().position(|&b| b == b'\n') {
                carry.extend_from_slice(&rest[..newline]);
                let line_at = carry_at;
                carry_at += carry.len() as u64 + 1;
                let keep_going = each(line_at, &carry, true);
                carry.clear();
                rest = &rest[newline + 1..];
                if !keep_going {
                    return carry_at;
                }
            }
            carry.extend_from_slice(rest);
        }
        if !carry.is_empty() {
            each(carry_at, &carry, false);
        }
        carry_at
    }

    pub fn remove(self) {
        let dir = self.dir.clone();
        drop(self);
        let _ = fs::remove_dir_all(dir);
    }
}

fn end_of(segments: &[Segment]) -> u64 {
    segments.last().map_or(0, |segment| segment.start + segment.len)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp(name: &str) -> PathBuf {
        std::env::temp_dir().join(format!("crew-log-{name}-{}", uuid::Uuid::new_v4()))
    }

    fn files(dir: &Path) -> Vec<String> {
        let mut names: Vec<String> = fs::read_dir(dir)
            .unwrap()
            .map(|entry| entry.unwrap().file_name().to_string_lossy().into_owned())
            .collect();
        names.sort();
        names
    }

    #[test]
    fn rotation_keeps_two_files_named_by_their_offset() {
        let dir = temp("rotate");
        let log = LogStore::open(dir.clone(), 100).unwrap();
        for i in 0..35 {
            log.append(format!("line {i:04}\n").as_bytes()); // 10 bytes each
        }
        assert_eq!(log.total(), 350);
        assert_eq!(files(&dir), vec![format!("{:020}.log", 200), format!("{:020}.log", 300)]);
        assert_eq!(log.first(), 200);
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn a_cursor_means_the_same_byte_across_rotation_and_reopen() {
        let dir = temp("cursor");
        let log = LogStore::open(dir.clone(), 100).unwrap();
        for i in 0..25 {
            log.append(format!("line {i:04}\n").as_bytes());
        }
        let (at, bytes) = log.read(230, 250);
        assert_eq!((at, bytes.as_slice()), (230, &b"line 0023\nline 0024\n"[..]));
        // Across the boundary between the two files.
        let (_, bytes) = log.read(190, 210);
        assert_eq!(bytes, b"line 0019\nline 0020\n");
        drop(log);

        let log = LogStore::open(dir.clone(), 100).unwrap();
        assert_eq!(log.total(), 250);
        log.append(b"line 0025\n");
        assert_eq!(log.read(250, 260).1, b"line 0025\n");
        // Asked for something rotated away: it starts where the disk does.
        let (at, _) = log.read(0, 10);
        assert_eq!(at, 100);
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn scan_lines_reports_offsets_and_the_unfinished_line() {
        let dir = temp("scan");
        let log = LogStore::open(dir.clone(), 1000).unwrap();
        log.append(b"one\ntwo\nthr");
        let mut seen = Vec::new();
        let end = log.scan_lines(0, log.total(), |at, line, complete| {
            seen.push((at, String::from_utf8_lossy(line).into_owned(), complete));
            true
        });
        assert_eq!(end, 8);
        assert_eq!(
            seen,
            vec![(0, "one".into(), true), (4, "two".into(), true), (8, "thr".into(), false)]
        );
        let _ = fs::remove_dir_all(dir);
    }
}
