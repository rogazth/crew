//! Tokens spent by day and model, whatever the plan says of them: an absolute
//! count a provider cannot redefine by changing what its limits offer. Each
//! adapter reads its own records into a [`Tally`], from the day it is asked for
//! on; the host keeps the days, so history outlives the logs it was read from.

use std::collections::BTreeMap;
use std::fs::File;
use std::io::{BufRead, BufReader};
use std::path::{Path, PathBuf};
use std::time::UNIX_EPOCH;

/// What was spent, each kind apart: `input` never includes what the cache served.
#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct Spent {
    pub input: u64,
    pub output: u64,
    pub cache_write: u64,
    pub cache_read: u64,
}

impl Spent {
    fn is_empty(&self) -> bool {
        *self == Self::default()
    }
}

/// The days an adapter is asked to read.
#[derive(Clone, Debug)]
pub struct Since {
    /// The first of them, on the machine's calendar (`YYYY-MM-DD`).
    pub day: String,
    /// How many there are, today included.
    pub days: u32,
    /// A time at or before that day's start, in milliseconds since the epoch.
    pub from_ms: i64,
}

/// What a provider spent, by day and model.
#[derive(Debug, Default, PartialEq)]
pub struct Tally(pub BTreeMap<(String, String), Spent>);

impl Tally {
    pub fn add(&mut self, since: &Since, day: String, model: &str, spent: Spent) {
        if day.as_str() < since.day.as_str() || spent.is_empty() {
            return;
        }
        let held = self.0.entry((day, model.to_string())).or_default();
        held.input += spent.input;
        held.output += spent.output;
        held.cache_write += spent.cache_write;
        held.cache_read += spent.cache_read;
    }
}

/// Every `.jsonl` under `dir` written since `from_ms`, however deep.
pub fn jsonl_files(dir: &Path, from_ms: i64) -> Vec<PathBuf> {
    let mut found = Vec::new();
    let mut pending = vec![dir.to_path_buf()];
    while let Some(folder) = pending.pop() {
        let Ok(entries) = std::fs::read_dir(&folder) else { continue };
        for entry in entries.flatten() {
            let path = entry.path();
            match entry.file_type() {
                Ok(kind) if kind.is_dir() => pending.push(path),
                Ok(kind) if kind.is_file() && path.extension().is_some_and(|e| e == "jsonl") && written_since(&path, from_ms) => {
                    found.push(path)
                }
                _ => {}
            }
        }
    }
    found
}

pub fn written_since(path: &Path, from_ms: i64) -> bool {
    std::fs::metadata(path)
        .and_then(|meta| meta.modified())
        .ok()
        .and_then(|at| at.duration_since(UNIX_EPOCH).ok())
        .is_some_and(|at| at.as_millis() as i64 >= from_ms)
}

/// Each line of a file holding `needle`. A log can hold lines of any size and
/// bytes that are not text, so it is read by the byte and only a match is decoded.
pub fn lines_with(path: &Path, needle: &str, mut each: impl FnMut(&str)) {
    let Ok(file) = File::open(path) else { return };
    let mut reader = BufReader::new(file);
    let mut line = Vec::new();
    loop {
        line.clear();
        match reader.read_until(b'\n', &mut line) {
            Ok(0) | Err(_) => return,
            Ok(_) => {
                if let Ok(text) = std::str::from_utf8(&line) {
                    if text.contains(needle) {
                        each(text);
                    }
                }
            }
        }
    }
}

#[cfg(test)]
pub(crate) mod test_support {
    use super::*;

    pub fn since_ever() -> Since {
        Since { day: "2000-01-01".into(), days: 1, from_ms: 0 }
    }

    /// A folder of its own for one test.
    pub fn folder() -> PathBuf {
        let dir = std::env::temp_dir().join(format!("crew-usage-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).expect("folder");
        dir
    }
}

#[cfg(test)]
mod tests {
    use super::test_support::*;
    use super::*;

    #[test]
    fn a_tally_adds_up_and_leaves_out_earlier_days_and_nothing_spent() {
        let since = Since { day: "2026-11-02".into(), days: 2, from_ms: 0 };
        let mut tally = Tally::default();
        let spent = Spent { input: 1, output: 2, cache_write: 3, cache_read: 4 };
        tally.add(&since, "2026-11-02".into(), "m", spent);
        tally.add(&since, "2026-11-02".into(), "m", spent);
        tally.add(&since, "2026-11-01".into(), "m", spent);
        tally.add(&since, "2026-11-03".into(), "m", Spent::default());
        let held: Vec<_> = tally.0.into_iter().collect();
        assert_eq!(
            held,
            vec![(("2026-11-02".to_string(), "m".to_string()), Spent { input: 2, output: 4, cache_write: 6, cache_read: 8 })]
        );
    }

    #[test]
    fn logs_are_found_at_any_depth_and_only_when_recent() {
        let dir = folder();
        std::fs::create_dir_all(dir.join("a/b")).unwrap();
        std::fs::write(dir.join("a/b/deep.jsonl"), "{}\n").unwrap();
        std::fs::write(dir.join("a/other.txt"), "{}\n").unwrap();
        assert_eq!(jsonl_files(&dir, 0), vec![dir.join("a/b/deep.jsonl")]);
        assert!(jsonl_files(&dir, i64::MAX).is_empty());
    }

    #[test]
    fn a_line_that_is_not_text_is_passed_over() {
        let dir = folder();
        let path = dir.join("log.jsonl");
        std::fs::write(&path, b"keep one\n\xff keep bad\nskip\nkeep two").unwrap();
        let mut seen = Vec::new();
        lines_with(&path, "keep", |line| seen.push(line.trim().to_string()));
        assert_eq!(seen, ["keep one", "keep two"]);
    }
}
