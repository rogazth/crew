//! `crew trace`: the daemon's, the app's and the window's trace files, read
//! straight from the data dir, merged by time. It never asks the daemon, so it
//! works while crewd is stalled or stopped, and over SSH on a machine without a
//! window. See `crewd::trace` for what is written and what is not.
//!
//! Files: `crewd.ndjson*`, `errors.ndjson*` (its WARN and up outlive the main
//! file's rotation, so a record is often in both) and `app.ndjson*`. A record
//! is one JSON line: `timestamp` (RFC 3339, UTC), `level`, `target`,
//! `fields.message` and the rest of `fields`, and `span` for the span it was
//! written in. A torn line, which a crash or a reader catching a writer
//! mid-line leaves, is skipped.

use std::collections::{HashMap, VecDeque};
use std::fs::{self, File};
use std::io::{BufRead, BufReader, Read, Seek, SeekFrom};
use std::os::unix::fs::MetadataExt;
use std::path::{Path, PathBuf};
use std::process::ExitCode;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use serde_json::Value;

use crate::args::{TraceArgs, TraceCommand};
use crate::{identity, output, CliError, Ctx};

pub const DIR: &str = "trace";
/// The families of files, oldest source first for ties: the daemon's, its
/// errors-only twin, the app's.
const FAMILIES: [&str; 3] = ["crewd.ndjson", "errors.ndjson", "app.ndjson"];
/// The same event written to two files is stamped twice, a few microseconds apart.
const TWIN_WINDOW_NS: i128 = 50_000_000;
const FOLLOW_POLL: Duration = Duration::from_millis(500);

pub fn run(ctx: &Ctx, args: &TraceArgs) -> Result<ExitCode, CliError> {
    // The flag, else CREW_DATA_DIR (which a session has too), else the app's:
    // it reads files, so nothing here is a call as anyone.
    let dir = identity::data_dir(ctx.global.data_dir.as_deref(), &ctx.env)?.join(DIR);
    if let Some(TraceCommand::Path) = args.command {
        output::say(&dir.to_string_lossy());
        return Ok(ExitCode::SUCCESS);
    }
    let query = Query::from_args(args, SystemTime::now())?.resolved(&dir);
    let raw = ctx.global.json;
    if !dir.is_dir() {
        if !raw {
            output::say(&format!("no trace yet in {}", dir.display()));
        }
        if !args.follow {
            return Ok(ExitCode::SUCCESS);
        }
    }
    let records = read(&dir, &query);
    if records.is_empty() && !raw {
        output::say("no trace records match");
    }
    for record in &records {
        print(record, raw);
    }
    if args.follow {
        follow(&dir, &query, raw);
    }
    Ok(ExitCode::SUCCESS)
}

fn print(record: &Record, raw: bool) {
    if raw {
        output::say(&record.raw);
    } else {
        output::say(&record.human());
    }
}

/// What `--session`, `--turn`, `--since`, `--level`, `--target`, `--grep` and `--limit` select.
#[derive(Debug, Clone)]
pub struct Query {
    pub session: Option<String>,
    pub turn: Option<String>,
    /// Records before this instant (ns since the epoch) are out.
    pub since: Option<i128>,
    pub level: Option<u8>,
    pub target: Option<String>,
    pub grep: Option<String>,
    /// 0 is no limit.
    pub limit: usize,
    /// What `turn` stands for once the files were read: see [`Query::resolved`].
    pub window: Option<TurnWindow>,
}

/// A turn as the files show it: the session it ran in and the span of time
/// between its `turn.start` and its `turn.end`.
#[derive(Debug, Clone)]
pub struct TurnWindow {
    pub id: String,
    pub session: String,
    pub from: i128,
    /// None: the turn has no end in the trace, so the window runs to its end.
    pub to: Option<i128>,
}

impl Query {
    pub fn from_args(args: &TraceArgs, now: SystemTime) -> Result<Self, CliError> {
        let since = match &args.since {
            Some(text) => {
                let ago = parse_duration(text)?;
                let now = now.duration_since(UNIX_EPOCH).map(|d| d.as_nanos() as i128).unwrap_or(0);
                Some(now - ago.as_nanos() as i128)
            }
            None => None,
        };
        let level = match &args.level {
            Some(text) => Some(
                level_rank(text)
                    .ok_or_else(|| CliError::Usage(format!("--level takes trace, debug, info, warn or error, not {text:?}")))?,
            ),
            None => None,
        };
        Ok(Query {
            session: args.session.clone(),
            turn: args.turn.clone(),
            since,
            level,
            target: args.target.clone(),
            grep: args.grep.as_ref().map(|text| text.to_lowercase()),
            limit: args.limit.unwrap_or(200),
            window: None,
        })
    }

    /// With `--turn`, reads the turn's `turn.start` and `turn.end` to learn its
    /// session and its window. A span's fields are only the innermost one's, and
    /// a tool call runs on a thread that never saw the turn's span, so most of a
    /// turn's lines carry no `turn_id`. What they do carry is their session and
    /// a time, which is how the turn is told from its neighbours.
    pub fn resolved(mut self, dir: &Path) -> Self {
        let Some(id) = self.turn.clone() else { return self };
        let mut starts: Vec<(i128, String, String)> = Vec::new();
        let mut end: Option<i128> = None;
        for family in FAMILIES {
            for path in family_files(dir, family) {
                scan(&path, family, |record| match record.message.as_str() {
                    "turn.start" => {
                        if let Some(session) = record.text(&["session_id", "session"]) {
                            let turn = record.text(&["turn_id", "turn"]).unwrap_or_default();
                            starts.push((record.at, session, turn));
                        }
                    }
                    "turn.end" if record.has(&["turn_id", "turn"], &id) => {
                        end = Some(end.map_or(record.at, |at| at.max(record.at)))
                    }
                    _ => {}
                });
            }
        }
        let Some((from, session, _)) = starts.iter().find(|(_, _, turn)| *turn == id).cloned() else { return self };
        // No end: until the session's next turn began, or the trace ends.
        let to = end.or_else(|| starts.iter().filter(|(at, who, _)| *who == session && *at > from).map(|(at, _, _)| *at).min());
        self.window = Some(TurnWindow { id, session, from, to });
        self
    }

    fn accepts(&self, record: &Record) -> bool {
        if self.since.is_some_and(|since| record.at < since) {
            return false;
        }
        if self.level.is_some_and(|min| level_rank(&record.level).unwrap_or(0) < min) {
            return false;
        }
        if self.target.as_ref().is_some_and(|prefix| !record.target.starts_with(prefix.as_str())) {
            return false;
        }
        if self.session.as_ref().is_some_and(|id| !record.has(&["session_id", "session"], id)) {
            return false;
        }
        if let Some(id) = &self.turn {
            let named = record.has(&["turn_id", "turn"], id);
            let inside = self.window.as_ref().is_some_and(|w| {
                record.has(&["session_id", "session"], &w.session) && record.at >= w.from && w.to.is_none_or(|to| record.at <= to)
            });
            if !named && !inside {
                return false;
            }
        }
        if self.grep.as_ref().is_some_and(|text| !record.raw.to_lowercase().contains(&text.to_lowercase())) {
            return false;
        }
        true
    }
}

/// `30s`, `30m`, `2h`, `1d` or `1w`.
pub fn parse_duration(text: &str) -> Result<Duration, CliError> {
    let bad = || CliError::Usage(format!("--since takes a number and s, m, h, d or w (30m, 2h, 1d), not {text:?}"));
    let text = text.trim();
    let unit = text.chars().last().ok_or_else(bad)?;
    let seconds = match unit {
        's' => 1,
        'm' => 60,
        'h' => 3600,
        'd' => 86_400,
        'w' => 604_800,
        _ => return Err(bad()),
    };
    let count: u64 = text[..text.len() - 1].parse().map_err(|_| bad())?;
    Ok(Duration::from_secs(count.saturating_mul(seconds)))
}

fn level_rank(level: &str) -> Option<u8> {
    match level.to_ascii_lowercase().as_str() {
        "trace" => Some(0),
        "debug" => Some(1),
        "info" => Some(2),
        "warn" | "warning" => Some(3),
        "error" => Some(4),
        _ => None,
    }
}

/// Which family a record came from, to tell a twin from a repeat.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Source {
    Daemon,
    Errors,
    App,
}

#[derive(Debug, Clone)]
pub struct Record {
    /// Nanoseconds since the epoch.
    pub at: i128,
    pub level: String,
    pub target: String,
    pub message: String,
    fields: serde_json::Map<String, Value>,
    span: serde_json::Map<String, Value>,
    pub raw: String,
    source: Source,
}

impl Record {
    fn parse(line: &str, source: Source) -> Option<Record> {
        let value: Value = serde_json::from_str(line.trim()).ok()?;
        let object = value.as_object()?;
        let at = parse_time(object.get("timestamp")?.as_str()?)?;
        let fields = object.get("fields").and_then(Value::as_object).cloned().unwrap_or_default();
        let span = object.get("span").and_then(Value::as_object).cloned().unwrap_or_default();
        Some(Record {
            at,
            level: object.get("level").and_then(Value::as_str).unwrap_or("INFO").to_ascii_uppercase(),
            target: object.get("target").and_then(Value::as_str).unwrap_or("").to_string(),
            message: fields.get("message").and_then(Value::as_str).unwrap_or("").to_string(),
            fields,
            span,
            raw: line.trim().to_string(),
            source,
        })
    }

    /// Whether `id` is the value of one of `keys` in the record's fields or its span.
    fn has(&self, keys: &[&str], id: &str) -> bool {
        keys.iter().any(|key| {
            [&self.fields, &self.span].iter().any(|map| match map.get(*key) {
                Some(Value::String(text)) => text == id,
                Some(other) => other.to_string() == id,
                None => false,
            })
        })
    }

    /// The first of `keys` that holds a string, in the fields, then the span.
    fn text(&self, keys: &[&str]) -> Option<String> {
        keys.iter().find_map(|key| {
            [&self.fields, &self.span].iter().find_map(|map| match map.get(*key) {
                Some(Value::String(text)) => Some(text.clone()),
                _ => None,
            })
        })
    }

    /// Everything but the time, which differs between the copies of one event.
    fn twin_key(&self) -> String {
        format!("{}\u{1}{}\u{1}{:?}\u{1}{:?}", self.level, self.target, self.fields, self.span)
    }

    fn human(&self) -> String {
        let mut line = format!("{} {:<5} {:<14} {}", format_time(self.at), self.level, self.target, self.message);
        let mut put = |map: &serde_json::Map<String, Value>, skip: &[&str]| {
            for (key, value) in map {
                if skip.contains(&key.as_str()) {
                    continue;
                }
                line.push(' ');
                line.push_str(key);
                line.push('=');
                match value {
                    Value::String(text) if !text.is_empty() && !text.contains(char::is_whitespace) && !text.contains('"') => {
                        line.push_str(text)
                    }
                    Value::String(text) => line.push_str(&serde_json::to_string(text).unwrap_or_default()),
                    other => line.push_str(&other.to_string()),
                }
            }
        };
        put(&self.fields, &["message"]);
        // The span's own fields, unless the event named them: a turn's id on every line of it.
        let own: Vec<String> = self.fields.keys().cloned().collect();
        let mut span = self.span.clone();
        span.retain(|key, _| !own.contains(key));
        let skip = ["name"];
        put(&span, &skip);
        line
    }
}

/// `2026-11-02T13:06:07.356565Z` (or `+00:00`) as nanoseconds since the epoch.
pub fn parse_time(text: &str) -> Option<i128> {
    let (date, rest) = text.split_once('T')?;
    let mut parts = date.split('-');
    let (year, month, day): (i64, i64, i64) =
        (parts.next()?.parse().ok()?, parts.next()?.parse().ok()?, parts.next()?.parse().ok()?);
    let (clock, offset) = match rest.find(['Z', '+']) {
        Some(at) => (&rest[..at], &rest[at..]),
        None => (rest, "Z"),
    };
    let (hms, frac) = clock.split_once('.').unwrap_or((clock, ""));
    let mut hms = hms.split(':');
    let (h, m, s): (i64, i64, i64) = (hms.next()?.parse().ok()?, hms.next()?.parse().ok()?, hms.next()?.parse().ok()?);
    let mut nanos: i128 = 0;
    if !frac.is_empty() {
        let digits: String = frac.chars().take(9).collect();
        if !digits.chars().all(|c| c.is_ascii_digit()) {
            return None;
        }
        nanos = digits.parse::<i128>().ok()? * 10i128.pow(9 - digits.len() as u32);
    }
    let mut zone: i64 = 0;
    if let Some(sign_at) = offset.find('+') {
        let (oh, om) = offset[sign_at + 1..].split_once(':').unwrap_or((&offset[sign_at + 1..], "0"));
        zone = oh.parse::<i64>().ok()? * 3600 + om.parse::<i64>().ok()? * 60;
    }
    let days = days_from_civil(year, month, day);
    let seconds = days * 86_400 + h * 3600 + m * 60 + s - zone;
    Some(seconds as i128 * 1_000_000_000 + nanos)
}

/// Howard Hinnant's days-from-civil.
fn days_from_civil(year: i64, month: i64, day: i64) -> i64 {
    let year = if month <= 2 { year - 1 } else { year };
    let era = year.div_euclid(400);
    let yoe = year.rem_euclid(400);
    let doy = (153 * (if month > 2 { month - 3 } else { month + 9 }) + 2) / 5 + day - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    era * 146_097 + doe - 719_468
}

fn civil_from_days(days: i64) -> (i64, i64, i64) {
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let day = doy - (153 * mp + 2) / 5 + 1;
    let month = if mp < 10 { mp + 3 } else { mp - 9 };
    (yoe + era * 400 + i64::from(month <= 2), month, day)
}

fn format_time(at: i128) -> String {
    let seconds = at.div_euclid(1_000_000_000) as i64;
    let millis = at.rem_euclid(1_000_000_000) / 1_000_000;
    let (year, month, day) = civil_from_days(seconds.div_euclid(86_400));
    let in_day = seconds.rem_euclid(86_400);
    format!("{year:04}-{month:02}-{day:02}T{:02}:{:02}:{:02}.{millis:03}Z", in_day / 3600, in_day % 3600 / 60, in_day % 60)
}

/// `name`, `name.1`, ..., oldest first: the files of one family that exist.
fn family_files(dir: &Path, family: &str) -> Vec<PathBuf> {
    let mut backups: Vec<(u32, PathBuf)> = Vec::new();
    if let Ok(entries) = fs::read_dir(dir) {
        for entry in entries.flatten() {
            let name = entry.file_name().to_string_lossy().into_owned();
            if let Some(n) = name.strip_prefix(family).and_then(|rest| rest.strip_prefix('.')).and_then(|n| n.parse::<u32>().ok())
            {
                backups.push((n, entry.path()));
            }
        }
    }
    backups.sort_by_key(|(n, _)| std::cmp::Reverse(*n));
    let mut files: Vec<PathBuf> = backups.into_iter().map(|(_, path)| path).collect();
    let active = dir.join(family);
    if active.is_file() {
        files.push(active);
    }
    files
}

fn source_of(family: &str) -> Source {
    match family {
        "crewd.ndjson" => Source::Daemon,
        "errors.ndjson" => Source::Errors,
        _ => Source::App,
    }
}

/// Every record of one file, in file order.
fn scan(path: &Path, family: &str, mut each: impl FnMut(Record)) {
    let Ok(file) = File::open(path) else { return };
    let mut reader = BufReader::new(file);
    let mut buf = Vec::new();
    loop {
        buf.clear();
        match reader.read_until(b'\n', &mut buf) {
            Ok(0) | Err(_) => break,
            Ok(_) => {}
        }
        if let Some(record) = Record::parse(&String::from_utf8_lossy(&buf), source_of(family)) {
            each(record);
        }
    }
}

/// The newest `limit` records that pass `query`, merged and deduplicated,
/// oldest first. A file is read line by line and only a bounded tail of what
/// passes is kept for each family, so a trace of any size reads in the same memory.
pub fn read(dir: &Path, query: &Query) -> Vec<Record> {
    let keep = if query.limit == 0 { usize::MAX } else { query.limit.saturating_mul(2).max(16) };
    let cutoff = query.since.map(|since| since / 1_000_000_000);
    let mut merged: Vec<Record> = Vec::new();
    for family in FAMILIES {
        let mut tail: VecDeque<Record> = VecDeque::new();
        for path in family_files(dir, family) {
            // A file last written before the window holds nothing inside it.
            let modified = fs::metadata(&path).and_then(|meta| meta.modified()).ok();
            if let (Some(cutoff), Some(modified)) = (cutoff, modified) {
                if modified.duration_since(UNIX_EPOCH).map(|d| (d.as_secs() as i128) < cutoff).unwrap_or(false) {
                    continue;
                }
            }
            scan(&path, family, |record| {
                if !query.accepts(&record) {
                    return;
                }
                if tail.len() == keep {
                    tail.pop_front();
                }
                tail.push_back(record);
            });
        }
        merged.extend(tail);
    }
    // Stable: records of one instant stay in the order of the families.
    merged.sort_by_key(|record| record.at);
    let mut twins = Twins::default();
    let mut unique: Vec<Record> = merged.into_iter().filter(|record| twins.fresh(record)).collect();
    if query.limit > 0 && unique.len() > query.limit {
        unique.drain(..unique.len() - query.limit);
    }
    unique
}

/// A WARN is written to `crewd.ndjson` and to `errors.ndjson`: the second
/// copy of an event, from another file and within a few milliseconds, is not shown.
#[derive(Default)]
struct Twins {
    /// By event content: the time, the file, and whether a twin has claimed it.
    recent: HashMap<String, Vec<(i128, Source, bool)>>,
    order: VecDeque<(String, i128)>,
}

impl Twins {
    /// False for the second copy of an event. Each copy pairs with one other, so
    /// the same event twice in one file, with one twin in the other, shows twice.
    fn fresh(&mut self, record: &Record) -> bool {
        // Only the two files of the daemon can hold twins.
        if record.source == Source::App {
            return true;
        }
        let key = record.twin_key();
        let list = self.recent.entry(key.clone()).or_default();
        let twin = list
            .iter_mut()
            .find(|(at, source, claimed)| !*claimed && *source != record.source && (record.at - *at).abs() <= TWIN_WINDOW_NS);
        if let Some(twin) = twin {
            twin.2 = true;
            return false;
        }
        list.push((record.at, record.source, false));
        self.order.push_back((key, record.at));
        // Forget what is too old to be a twin of anything new.
        while let Some((old_key, at)) = self.order.front().cloned() {
            if record.at - at <= TWIN_WINDOW_NS * 4 && self.order.len() < 5000 {
                break;
            }
            self.order.pop_front();
            if let Some(list) = self.recent.get_mut(&old_key) {
                list.retain(|(when, _, _)| *when != at);
                if list.is_empty() {
                    self.recent.remove(&old_key);
                }
            }
        }
        true
    }
}

/// Where in a file the follower stands.
struct Cursor {
    ino: u64,
    offset: u64,
    /// What a read left of a line without its newline.
    partial: Vec<u8>,
}

/// Prints what is appended from now on, across rotations, until interrupted.
fn follow(dir: &Path, query: &Query, raw: bool) {
    let mut cursors: HashMap<&'static str, Cursor> = HashMap::new();
    // Start at the end of every file: the history was just printed.
    for family in FAMILIES {
        if let Ok(meta) = fs::metadata(dir.join(family)) {
            cursors.insert(family, Cursor { ino: meta.ino(), offset: meta.len(), partial: Vec::new() });
        }
    }
    let mut twins = Twins::default();
    loop {
        std::thread::sleep(FOLLOW_POLL);
        let mut batch: Vec<Record> = Vec::new();
        for family in FAMILIES {
            let path = dir.join(family);
            let Ok(meta) = fs::metadata(&path) else { continue };
            let cursor = cursors.entry(family).or_insert(Cursor { ino: meta.ino(), offset: 0, partial: Vec::new() });
            if cursor.ino != meta.ino() {
                // Rotated: what was left of the old file is in a backup now.
                if let Some(old) = backup_with_ino(dir, family, cursor.ino) {
                    read_from(&old, cursor, family, &mut batch);
                }
                *cursor = Cursor { ino: meta.ino(), offset: 0, partial: Vec::new() };
            } else if meta.len() < cursor.offset {
                cursor.offset = 0;
                cursor.partial.clear();
            }
            read_from(&path, cursor, family, &mut batch);
        }
        batch.retain(|record| query.accepts(record));
        batch.sort_by_key(|record| record.at);
        for record in batch {
            if twins.fresh(&record) {
                print(&record, raw);
            }
        }
    }
}

fn backup_with_ino(dir: &Path, family: &str, ino: u64) -> Option<PathBuf> {
    family_files(dir, family).into_iter().find(|path| fs::metadata(path).is_ok_and(|meta| meta.ino() == ino))
}

/// Reads complete lines from the cursor on. A line without its newline waits for the rest.
fn read_from(path: &Path, cursor: &mut Cursor, family: &str, out: &mut Vec<Record>) {
    let Ok(mut file) = File::open(path) else { return };
    if file.seek(SeekFrom::Start(cursor.offset)).is_err() {
        return;
    }
    let mut chunk = Vec::new();
    if file.take(8 << 20).read_to_end(&mut chunk).is_err() {
        return;
    }
    cursor.offset += chunk.len() as u64;
    cursor.partial.extend_from_slice(&chunk);
    while let Some(end) = cursor.partial.iter().position(|byte| *byte == b'\n') {
        let line: Vec<u8> = cursor.partial.drain(..=end).collect();
        if let Some(record) = Record::parse(&String::from_utf8_lossy(&line), source_of(family)) {
            out.push(record);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    fn dir(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("crew-trace-{name}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).expect("dir");
        dir
    }

    fn line(ts: &str, level: &str, target: &str, message: &str, extra: &str) -> String {
        format!(r#"{{"timestamp":"{ts}","level":"{level}","fields":{{"message":"{message}"{extra}}},"target":"{target}"}}"#)
    }

    fn write(dir: &Path, name: &str, lines: &[String]) {
        let mut file = File::create(dir.join(name)).expect("file");
        for l in lines {
            writeln!(file, "{l}").expect("line");
        }
    }

    fn query() -> Query {
        Query { session: None, turn: None, since: None, level: None, target: None, grep: None, limit: 200, window: None }
    }

    fn messages(records: &[Record]) -> Vec<&str> {
        records.iter().map(|r| r.message.as_str()).collect()
    }

    #[test]
    fn time_parses_with_any_fraction_and_formats_back() {
        let a = parse_time("2026-11-02T13:06:07.356565Z").expect("micro");
        let b = parse_time("2026-11-02T13:06:07.356Z").expect("milli");
        assert!(b < a, "356 ms comes before 356.565 ms");
        assert_eq!(parse_time("1970-01-01T00:00:01Z"), Some(1_000_000_000));
        assert_eq!(parse_time("2026-11-02T14:06:07+01:00"), parse_time("2026-11-02T13:06:07Z"));
        assert_eq!(format_time(a), "2026-11-02T13:06:07.356Z");
        assert_eq!(parse_time("not a time"), None);
    }

    #[test]
    fn durations_take_s_m_h_d_w_and_nothing_else() {
        assert_eq!(parse_duration("30m").unwrap(), Duration::from_secs(1800));
        assert_eq!(parse_duration("2h").unwrap(), Duration::from_secs(7200));
        assert_eq!(parse_duration("1d").unwrap(), Duration::from_secs(86_400));
        assert!(parse_duration("soon").is_err());
        assert!(parse_duration("5").is_err());
    }

    #[test]
    fn files_merge_by_time_across_rotations_and_sources() {
        let d = dir("merge");
        write(&d, "crewd.ndjson.1", &[line("2026-11-02T10:00:00.000000Z", "INFO", "a", "old", "")]);
        write(
            &d,
            "crewd.ndjson",
            &[
                line("2026-11-02T10:00:03.000000Z", "INFO", "a", "newest daemon", ""),
                line("2026-11-02T10:00:01.000000Z", "INFO", "a", "mid daemon", ""),
            ],
        );
        write(&d, "app.ndjson", &[line("2026-11-02T10:00:02.500Z", "INFO", "app.main", "app between", "")]);
        let got = read(&d, &query());
        // Ordered by time, though one file is not (a thread logged late).
        assert_eq!(messages(&got), ["old", "mid daemon", "app between", "newest daemon"]);
    }

    #[test]
    fn a_warning_in_both_files_shows_once_but_a_repeat_in_one_file_shows_twice() {
        let d = dir("dedupe");
        let warn = |ts: &str| line(ts, "WARN", "crewd", "rpc.failed", r#","method":"x""#);
        write(&d, "crewd.ndjson", &[warn("2026-11-02T10:00:00.000100Z"), warn("2026-11-02T10:00:00.000200Z")]);
        write(&d, "errors.ndjson", &[warn("2026-11-02T10:00:00.000110Z")]);
        let got = read(&d, &query());
        assert_eq!(got.len(), 2, "{:?}", messages(&got));
        // Only in errors.ndjson, the main file having rotated away: it stays.
        let d = dir("dedupe-rotated");
        write(&d, "errors.ndjson", &[warn("2026-11-02T10:00:00.000110Z")]);
        assert_eq!(read(&d, &query()).len(), 1);
    }

    #[test]
    fn torn_blank_and_foreign_lines_are_skipped_and_missing_files_are_fine() {
        let d = dir("torn");
        let mut lines = vec![line("2026-11-02T10:00:00.000000Z", "INFO", "a", "whole", "")];
        lines.push(r#"{"timestamp":"2026-11-02T10:00:01.000000Z","level":"INFO","fie"#.into());
        lines.push(String::new());
        lines.push("plain text".into());
        lines.push("{}".into());
        write(&d, "crewd.ndjson", &lines);
        // A last line cut off by a crash, with no newline at all.
        fs::OpenOptions::new().append(true).open(d.join("crewd.ndjson")).unwrap().write_all(br#"{"timestamp":"2026"#).unwrap();
        assert_eq!(messages(&read(&d, &query())), ["whole"]);
        assert!(read(&d.join("nowhere"), &query()).is_empty(), "no dir at all");
    }

    #[test]
    fn filters_select_by_level_target_text_session_turn_and_window() {
        let d = dir("filters");
        write(
            &d,
            "crewd.ndjson",
            &[
                line("2026-11-02T10:00:00.000000Z", "DEBUG", "crewd::lib", "tick", ""),
                line("2026-11-02T10:00:01.000000Z", "INFO", "crewd::lib", "turn.start", r#","session_id":"s1","turn_id":"t1""#),
                line("2026-11-02T10:00:02.000000Z", "WARN", "crew_core::pty", "pty.exit", r#","session":"s2""#),
                line("2026-11-02T10:00:03.000000Z", "ERROR", "app.window", "socket.closed", r#","machine":"mac""#),
            ],
        );
        let with = |f: fn(&mut Query)| {
            let mut q = query();
            f(&mut q);
            messages(&read(&d, &q)).into_iter().map(String::from).collect::<Vec<_>>()
        };
        assert_eq!(with(|q| q.level = level_rank("warn")), ["pty.exit", "socket.closed"]);
        assert_eq!(with(|q| q.target = Some("app.".into())), ["socket.closed"]);
        assert_eq!(with(|q| q.target = Some("crew_core".into())), ["pty.exit"]);
        assert_eq!(with(|q| q.grep = Some("socket".into())), ["socket.closed"]);
        assert_eq!(with(|q| q.grep = Some("MAC".into())), ["socket.closed"], "case does not matter");
        assert_eq!(with(|q| q.session = Some("s1".into())), ["turn.start"]);
        assert_eq!(with(|q| q.session = Some("s2".into())), ["pty.exit"]);
        assert_eq!(with(|q| q.turn = Some("t1".into())), ["turn.start"]);
        assert_eq!(with(|q| q.since = parse_time("2026-11-02T10:00:02Z")), ["pty.exit", "socket.closed"]);
        assert_eq!(with(|q| q.limit = 2), ["pty.exit", "socket.closed"], "the newest ones, newest last");
        assert_eq!(with(|q| q.limit = 0).len(), 4, "0 is all of them");
    }

    #[test]
    fn a_session_is_found_by_the_span_the_event_was_written_in() {
        let d = dir("span");
        let l = r#"{"timestamp":"2026-11-02T10:00:00.000000Z","level":"INFO","fields":{"message":"agent.exit","code":0},"target":"crew_core::agent","span":{"session_id":"s9","pid":1,"name":"agent"}}"#;
        write(&d, "crewd.ndjson", &[l.to_string()]);
        let mut q = query();
        q.session = Some("s9".into());
        let got = read(&d, &q);
        assert_eq!(got.len(), 1);
        assert!(got[0].human().contains("session_id=s9"), "{}", got[0].human());
        assert!(got[0].human().contains("agent.exit code=0"), "{}", got[0].human());
    }

    #[test]
    fn a_big_trace_is_read_through_a_bounded_tail() {
        let d = dir("big");
        let lines: Vec<String> = (0..5000)
            .map(|i| line(&format!("2026-11-02T10:{:02}:{:02}.000000Z", i / 60, i % 60), "INFO", "a", &format!("m{i}"), ""))
            .collect();
        write(&d, "crewd.ndjson", &lines);
        let mut q = query();
        q.limit = 3;
        assert_eq!(messages(&read(&d, &q)), ["m4997", "m4998", "m4999"]);
    }

    /// The lines as the daemon writes them: only the innermost span's fields
    /// are on a line, so `agent.*` has the agent's span and `tool.call` has
    /// no span at all, only its own `session_id`.
    fn turn_lines(d: &Path) {
        let span = |ts: &str, msg: &str, level: &str, fields: &str, span: &str| {
            format!(
                r#"{{"timestamp":"{ts}","level":"{level}","fields":{{"message":"{msg}"{fields}}},"target":"crew_core::x","span":{span}}}"#
            )
        };
        let turn = |id: &str| format!(r#"{{"session_id":"s1","turn_id":"{id}","provider":"claude","name":"turn"}}"#);
        let agent = r#"{"session_id":"s1","pid":7,"name":"agent"}"#;
        write(
            d,
            "crewd.ndjson",
            &[
                span("2026-11-02T10:00:00.000000Z", "tool.call", "INFO", r#","tool":"before","session_id":"s1""#, "null")
                    .replace(r#","span":null"#, ""),
                span("2026-11-02T10:00:01.000000Z", "turn.start", "INFO", r#","kind":"user""#, &turn("t1")),
                span("2026-11-02T10:00:01.100000Z", "agent.spawn", "INFO", r#","program":"claude""#, agent),
                span("2026-11-02T10:00:02.000000Z", "tool.call", "INFO", r#","tool":"read","session_id":"s1""#, "null")
                    .replace(r#","span":null"#, ""),
                span("2026-11-02T10:00:02.500000Z", "tool.call", "INFO", r#","tool":"other","session_id":"s2""#, "null")
                    .replace(r#","span":null"#, ""),
                span("2026-11-02T10:00:03.000000Z", "turn.end", "INFO", r#","outcome":"completed""#, &turn("t1")),
                span("2026-11-02T10:00:03.200000Z", "tool.call", "INFO", r#","tool":"between","session_id":"s1""#, "null")
                    .replace(r#","span":null"#, ""),
                span("2026-11-02T10:00:04.000000Z", "turn.start", "INFO", r#","kind":"user""#, &turn("t2")),
                span("2026-11-02T10:00:05.000000Z", "agent.exit", "INFO", r#","code":0"#, agent),
                span("2026-11-02T10:00:06.000000Z", "tool.call", "INFO", r#","tool":"later","session_id":"s1""#, "null")
                    .replace(r#","span":null"#, ""),
            ],
        );
    }

    fn for_turn(d: &Path, id: &str) -> Vec<String> {
        let mut q = query();
        q.turn = Some(id.into());
        read(d, &q.resolved(d))
            .iter()
            .map(|r| format!("{} {}", r.message, r.text(&["tool", "program"]).unwrap_or_default()).trim().to_string())
            .collect()
    }

    #[test]
    fn a_turn_is_its_sessions_lines_between_its_start_and_its_end() {
        let d = dir("turn-window");
        turn_lines(&d);
        // The tool call before, the one of another session and the one after are out.
        assert_eq!(for_turn(&d, "t1"), ["turn.start", "agent.spawn claude", "tool.call read", "turn.end"]);
    }

    #[test]
    fn a_turn_without_an_end_runs_to_the_sessions_next_turn_or_the_end_of_the_trace() {
        let d = dir("turn-open");
        turn_lines(&d);
        // t2 never ended: it runs to the end of the trace.
        assert_eq!(for_turn(&d, "t2"), ["turn.start", "agent.exit", "tool.call later"]);
        // Drop t1's end: it stops where t2 began, and the tool call between stays in.
        let text = fs::read_to_string(d.join("crewd.ndjson")).unwrap();
        let cut: Vec<String> = text.lines().filter(|l| !l.contains("turn.end")).map(String::from).collect();
        write(&d, "crewd.ndjson", &cut);
        assert_eq!(for_turn(&d, "t1"), ["turn.start", "agent.spawn claude", "tool.call read", "tool.call between", "turn.start"]);
    }

    #[test]
    fn an_unknown_turn_matches_only_lines_that_name_it() {
        let d = dir("turn-unknown");
        turn_lines(&d);
        assert!(for_turn(&d, "nope").is_empty());
    }

    #[test]
    fn follow_reads_whole_lines_and_waits_for_the_rest() {
        let d = dir("follow");
        let path = d.join("crewd.ndjson");
        fs::write(&path, "").unwrap();
        let mut cursor = Cursor { ino: 0, offset: 0, partial: Vec::new() };
        let whole = line("2026-11-02T10:00:00.000000Z", "INFO", "a", "one", "");
        let second = line("2026-11-02T10:00:01.000000Z", "INFO", "a", "two", "");
        let (head, tail) = second.split_at(20);
        fs::write(&path, format!("{whole}\n{head}")).unwrap();
        let mut out = Vec::new();
        read_from(&path, &mut cursor, "crewd.ndjson", &mut out);
        assert_eq!(messages(&out), ["one"], "half a line is not a record");
        fs::OpenOptions::new().append(true).open(&path).unwrap().write_all(format!("{tail}\n").as_bytes()).unwrap();
        read_from(&path, &mut cursor, "crewd.ndjson", &mut out);
        assert_eq!(messages(&out), ["one", "two"]);
    }
}
