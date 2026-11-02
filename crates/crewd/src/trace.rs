//! The daemon's durable trace: structured events in `<data>/trace/`.
//!
//! `crewd.ndjson` (INFO and up) and `errors.ndjson` (WARN and up, so errors
//! outlive the main file's rotation) are JSON lines with the current span's
//! fields. stderr keeps feeding `crewd.log` in a human format. Only the
//! long-running daemon installs this; the CLI, `crew mcp` and one-shot
//! commands never do, and `tracing` events there go nowhere.
//!
//! A line is never worth the daemon: writes go through a lossy, bounded
//! channel to a worker thread, a rotation or write failure is counted and
//! survived, and the stderr writer ignores a closed stderr (`eprintln!` would
//! panic, and release builds abort on panic).
//!
//! What is recorded: ids, kinds, durations, sizes, counts, status names and
//! error text. Never prompts, responses, tool arguments or results, terminal
//! input or output, file contents, tokens, cookies or env values.

use std::fs::{self, File, OpenOptions};
use std::io::{self, Write};
use std::os::unix::fs::{DirBuilderExt, OpenOptionsExt, PermissionsExt};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex, TryLockError};
use std::thread;
use std::time::{Duration, Instant};

use tracing::level_filters::LevelFilter;
use tracing_appender::non_blocking::{ErrorCounter, NonBlocking, NonBlockingBuilder, WorkerGuard};
use tracing_subscriber::filter::filter_fn;
use tracing_subscriber::fmt;
use tracing_subscriber::prelude::*;
use tracing_subscriber::EnvFilter;

/// Name of the folder, inside the data dir, that holds the trace files.
pub const DIR: &str = "trace";
pub const MAIN_FILE: &str = "crewd.ndjson";
pub const ERRORS_FILE: &str = "errors.ndjson";
/// Lines the channel to a file's writer holds before it drops the newest.
const BUFFERED_LINES: usize = 50_000;
/// How often the drop counters are looked at.
const REPORT_EVERY: Duration = Duration::from_secs(15);
/// How long a failed file waits before it is opened again.
const REOPEN_AFTER: Duration = Duration::from_secs(1);
/// What a panic's backtrace is cut to, so one line stays a line.
const BACKTRACE_CAP: usize = 16 * 1024;

/// Writes failed in a [`RotatingFile`], for the `trace.dropped` record.
#[derive(Default)]
pub struct SinkStats {
    write_failures: AtomicU64,
}

/// A file that rotates by size: `name`, then `name.1` (the newest backup) to
/// `name.<keep-1>`, so `keep` files in all. Mode 0600. Never fails a write:
/// what cannot be written is counted and given up on, and the file is opened
/// again a moment later.
pub struct RotatingFile {
    path: PathBuf,
    max: u64,
    keep: u32,
    file: Option<File>,
    len: u64,
    failed_at: Option<Instant>,
    stats: Arc<SinkStats>,
}

impl RotatingFile {
    pub fn open(path: PathBuf, max: u64, keep: u32, stats: Arc<SinkStats>) -> io::Result<Self> {
        let (file, len) = Self::open_file(&path)?;
        Ok(Self { path, max, keep: keep.max(1), file: Some(file), len, failed_at: None, stats })
    }

    fn open_file(path: &Path) -> io::Result<(File, u64)> {
        let file = OpenOptions::new().create(true).append(true).mode(0o600).open(path)?;
        // One a looser umask or an older build made.
        let _ = file.set_permissions(fs::Permissions::from_mode(0o600));
        let len = file.metadata()?.len();
        Ok((file, len))
    }

    fn backup(&self, n: u32) -> PathBuf {
        let mut name = self.path.clone().into_os_string();
        name.push(format!(".{n}"));
        PathBuf::from(name)
    }

    /// Best effort throughout: a rename that fails leaves the file to grow
    /// rather than stop the trace.
    fn rotate(&mut self) {
        self.file = None;
        if self.keep > 1 {
            let _ = fs::remove_file(self.backup(self.keep - 1));
            for n in (1..self.keep - 1).rev() {
                let _ = fs::rename(self.backup(n), self.backup(n + 1));
            }
            let _ = fs::rename(&self.path, self.backup(1));
        } else {
            let _ = fs::remove_file(&self.path);
        }
        self.reopen();
    }

    fn reopen(&mut self) {
        match Self::open_file(&self.path) {
            Ok((file, len)) => {
                self.file = Some(file);
                self.len = len;
                self.failed_at = None;
            }
            Err(_) => self.failed_at = Some(Instant::now()),
        }
    }
}

/// Tests make the disk slow, so a line is still queued when a process dies.
#[cfg(test)]
static SLOW_WRITES: AtomicU64 = AtomicU64::new(0);

impl Write for RotatingFile {
    fn write(&mut self, buf: &[u8]) -> io::Result<usize> {
        #[cfg(test)]
        thread::sleep(Duration::from_millis(SLOW_WRITES.load(Ordering::Relaxed)));
        if self.file.is_none() {
            if self.failed_at.is_some_and(|at| at.elapsed() < REOPEN_AFTER) {
                self.stats.write_failures.fetch_add(1, Ordering::Relaxed);
                return Ok(buf.len());
            }
            self.reopen();
        }
        // A line is never split across files; an empty file takes one however long.
        if self.len > 0 && self.len + buf.len() as u64 > self.max {
            self.rotate();
        }
        let Some(file) = self.file.as_mut() else {
            self.stats.write_failures.fetch_add(1, Ordering::Relaxed);
            return Ok(buf.len());
        };
        match file.write_all(buf) {
            Ok(()) => self.len += buf.len() as u64,
            Err(_) => {
                self.stats.write_failures.fetch_add(1, Ordering::Relaxed);
                self.file = None;
                self.failed_at = Some(Instant::now());
            }
        }
        Ok(buf.len())
    }

    fn flush(&mut self) -> io::Result<()> {
        if let Some(file) = self.file.as_mut() {
            let _ = file.flush();
        }
        Ok(())
    }
}

/// stderr that cannot fail: `crewd.log` is a launchd file or a pipe to a
/// parent that may be gone, and a failed write is not worth a line.
#[derive(Clone, Copy)]
struct QuietStderr;

impl Write for QuietStderr {
    fn write(&mut self, buf: &[u8]) -> io::Result<usize> {
        let _ = io::stderr().write_all(buf);
        Ok(buf.len())
    }
    fn flush(&mut self) -> io::Result<()> {
        Ok(())
    }
}

impl<'a> fmt::MakeWriter<'a> for QuietStderr {
    type Writer = QuietStderr;
    fn make_writer(&'a self) -> Self::Writer {
        *self
    }
}

/// What must be flushed before the process goes, and watches the counters.
struct Sinks {
    _guards: Vec<WorkerGuard>,
}

/// `panic = "abort"` in release: a static is never dropped, so the guards
/// are here for the panic hook and for a clean exit to take.
static SINKS: Mutex<Option<Sinks>> = Mutex::new(None);
static DROPS: Mutex<Vec<Drops>> = Mutex::new(Vec::new());

struct Drops {
    file: &'static str,
    counter: ErrorCounter,
    stats: Arc<SinkStats>,
    reported_lines: usize,
    reported_failures: u64,
}

fn lock<T>(mutex: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
}

/// The sink for one file: a non-blocking, lossy writer around a rotating one.
fn sink(dir: &Path, file: &'static str, max: u64, keep: u32) -> io::Result<(NonBlocking, WorkerGuard)> {
    let stats = Arc::new(SinkStats::default());
    let rotating = RotatingFile::open(dir.join(file), max, keep, stats.clone())?;
    let (writer, guard) = NonBlockingBuilder::default()
        .lossy(true)
        .buffered_lines_limit(BUFFERED_LINES)
        .thread_name(&format!("trace-{file}"))
        .finish(rotating);
    lock(&DROPS).push(Drops { file, counter: writer.error_counter(), stats, reported_lines: 0, reported_failures: 0 });
    Ok((writer, guard))
}

/// A `trace.dropped` record for each file whose losses grew since the last look.
fn report_drops() {
    // try_lock: this runs from a panic hook, which may be on the thread that holds it.
    let mut drops = match DROPS.try_lock() {
        Ok(drops) => drops,
        Err(TryLockError::Poisoned(poisoned)) => poisoned.into_inner(),
        Err(TryLockError::WouldBlock) => return,
    };
    for d in drops.iter_mut() {
        let lines = d.counter.dropped_lines();
        let failures = d.stats.write_failures.load(Ordering::Relaxed);
        if lines > d.reported_lines || failures > d.reported_failures {
            tracing::warn!(
                file = d.file,
                dropped_lines = lines - d.reported_lines,
                write_failures = failures - d.reported_failures,
                "trace.dropped"
            );
            d.reported_lines = lines;
            d.reported_failures = failures;
        }
    }
}

fn json_layer<S>(writer: NonBlocking) -> impl tracing_subscriber::Layer<S>
where
    S: tracing::Subscriber + for<'a> tracing_subscriber::registry::LookupSpan<'a>,
{
    fmt::layer()
        .json()
        .with_ansi(false)
        .with_current_span(true)
        .with_span_list(false)
        .log_internal_errors(false)
        .with_writer(writer)
}

/// The filter for `crewd.ndjson`: `CREW_TRACE` as `RUST_LOG` writes it, INFO by default.
fn main_filter() -> EnvFilter {
    std::env::var("CREW_TRACE").ok().and_then(|spec| EnvFilter::try_new(spec).ok()).unwrap_or_else(|| EnvFilter::new("info"))
}

/// Installs the daemon's subscriber, writing under `<data>/trace/`. A file
/// that cannot be opened is left out and named in the error (the daemon runs
/// with what it has: stderr always); a second call is an error and does nothing.
pub fn init(data_dir: &Path) -> Result<(), String> {
    let dir = data_dir.join(DIR);
    let mut problems = Vec::new();
    if let Err(e) = fs::DirBuilder::new().recursive(true).mode(0o700).create(&dir) {
        problems.push(format!("{}: {e}", dir.display()));
    }
    let _ = fs::set_permissions(&dir, fs::Permissions::from_mode(0o700));
    let mut guards = Vec::new();
    let mut open = |file: &'static str, max: u64, keep: u32| match sink(&dir, file, max, keep) {
        Ok((writer, guard)) => {
            guards.push(guard);
            Some(writer)
        }
        Err(e) => {
            problems.push(format!("{file}: {e}"));
            None
        }
    };
    let main = open(MAIN_FILE, 10 << 20, 5);
    let errors = open(ERRORS_FILE, 5 << 20, 3);

    // crewd.log is what the app shows: warnings, errors and the daemon's own
    // lifecycle (target `daemon`). The RPC-by-RPC detail lives in the files. A
    // failed start (target `daemon.exit`) is printed by `main`, in plain form.
    let human = fmt::layer().with_ansi(false).with_target(false).log_internal_errors(false).with_writer(QuietStderr).with_filter(
        filter_fn(|meta| meta.target() != "daemon.exit" && (*meta.level() <= tracing::Level::WARN || meta.target() == "daemon")),
    );

    tracing_subscriber::registry()
        .with(main.map(|writer| json_layer(writer).with_filter(main_filter())))
        .with(errors.map(|writer| json_layer(writer).with_filter(LevelFilter::WARN)))
        .with(human)
        .try_init()
        .map_err(|e| e.to_string())?;

    *lock(&SINKS) = Some(Sinks { _guards: guards });
    install_panic_hook();
    let _ = thread::Builder::new().name("trace-report".into()).spawn(|| loop {
        thread::sleep(REPORT_EVERY);
        report_drops();
    });
    if problems.is_empty() {
        Ok(())
    } else {
        Err(problems.join("; "))
    }
}

/// A panic in a release build aborts without dropping anything, so the hook
/// writes the panic and flushes the files itself, then lets the old hook run.
fn install_panic_hook() {
    let previous = std::panic::take_hook();
    std::panic::set_hook(Box::new(move |info| {
        let mut backtrace = std::backtrace::Backtrace::force_capture().to_string();
        backtrace.truncate(BACKTRACE_CAP);
        tracing::error!(target: "daemon", panic = %info, backtrace = %backtrace, "daemon.panic");
        flush();
        previous(info);
    }));
}

/// Writes out what is buffered and stops the writers. Safe to call twice, from
/// a panic hook, and while another thread holds the lock (it then does nothing).
pub fn flush() {
    let sinks = match SINKS.try_lock() {
        Ok(mut sinks) => sinks.take(),
        Err(TryLockError::Poisoned(poisoned)) => poisoned.into_inner().take(),
        Err(TryLockError::WouldBlock) => None,
    };
    if sinks.is_some() {
        report_drops();
    }
    // Dropping a guard waits (a second at most) for its worker to write out.
    drop(sinks);
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tmp(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("crewd-trace-{name}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).expect("dir");
        dir
    }

    fn mode(path: &Path) -> u32 {
        fs::metadata(path).expect("meta").permissions().mode() & 0o777
    }

    #[test]
    fn a_file_rotates_at_the_size_boundary_and_keeps_named_backups() {
        let dir = tmp("rotate");
        let path = dir.join("crewd.ndjson");
        let mut file = RotatingFile::open(path.clone(), 30, 3, Arc::default()).expect("open");
        // Two 10-byte lines fill 20; a third (30) still fits exactly.
        for line in ["aaaaaaaaa\n", "bbbbbbbbb\n", "ccccccccc\n"] {
            file.write_all(line.as_bytes()).expect("write");
        }
        assert!(!dir.join("crewd.ndjson.1").exists(), "30 bytes is the cap, not past it");
        file.write_all(b"ddddddddd\n").expect("write");
        assert_eq!(fs::read_to_string(dir.join("crewd.ndjson.1")).expect("1"), "aaaaaaaaa\nbbbbbbbbb\nccccccccc\n");
        assert_eq!(fs::read_to_string(&path).expect("active"), "ddddddddd\n");
        // Two more rotations: the oldest falls off, keep = 3 files in all.
        for i in 0..6 {
            file.write_all(format!("line-{i}-xxx\n").as_bytes()).expect("write");
        }
        let mut names: Vec<String> =
            fs::read_dir(&dir).expect("dir").map(|e| e.expect("e").file_name().to_string_lossy().into_owned()).collect();
        names.sort();
        assert_eq!(names, ["crewd.ndjson", "crewd.ndjson.1", "crewd.ndjson.2"]);
        assert!(
            fs::read_to_string(dir.join("crewd.ndjson.2")).expect("2").contains("line-"),
            "the oldest kept is newer than the first"
        );
    }

    #[test]
    fn a_line_longer_than_the_cap_is_written_whole_into_an_empty_file() {
        let dir = tmp("long");
        let mut file = RotatingFile::open(dir.join("a.ndjson"), 5, 2, Arc::default()).expect("open");
        file.write_all(b"0123456789\n").expect("write");
        assert_eq!(fs::read_to_string(dir.join("a.ndjson")).expect("read"), "0123456789\n");
        assert!(!dir.join("a.ndjson.1").exists());
    }

    #[test]
    fn files_are_private_including_one_that_was_not_and_the_rotated_ones() {
        let dir = tmp("mode");
        let path = dir.join("a.ndjson");
        fs::write(&path, "old\n").expect("seed");
        fs::set_permissions(&path, fs::Permissions::from_mode(0o644)).expect("mode");
        let mut file = RotatingFile::open(path.clone(), 8, 2, Arc::default()).expect("open");
        assert_eq!(mode(&path), 0o600);
        file.write_all(b"new line\n").expect("write");
        assert_eq!(mode(&path), 0o600);
        assert_eq!(mode(&dir.join("a.ndjson.1")), 0o600);
        assert_eq!(fs::read_to_string(&path).expect("read"), "new line\n");
    }

    #[test]
    fn a_single_file_keeps_nothing_and_starts_again() {
        let dir = tmp("keep1");
        let mut file = RotatingFile::open(dir.join("a.ndjson"), 8, 1, Arc::default()).expect("open");
        file.write_all(b"aaaaaaa\n").expect("write");
        file.write_all(b"bbbbbbb\n").expect("write");
        assert_eq!(fs::read_to_string(dir.join("a.ndjson")).expect("read"), "bbbbbbb\n");
        assert!(!dir.join("a.ndjson.1").exists());
    }

    #[test]
    fn a_failing_rotation_or_write_is_counted_and_never_panics_or_errors() {
        let dir = tmp("fail");
        let path = dir.join("sub").join("a.ndjson");
        fs::create_dir_all(path.parent().expect("parent")).expect("sub");
        let stats = Arc::new(SinkStats::default());
        let mut file = RotatingFile::open(path.clone(), 8, 2, stats.clone()).expect("open");
        file.write_all(b"aaaaaaa\n").expect("write");
        // The folder goes away under it: rotation cannot rename or reopen.
        fs::remove_dir_all(path.parent().expect("parent")).expect("remove");
        assert!(file.write(b"bbbbbbb\n").is_ok(), "a failed rotation is not an error");
        assert!(file.write(b"ccccccc\n").is_ok());
        assert!(file.flush().is_ok());
        assert!(stats.write_failures.load(Ordering::Relaxed) >= 1);
        // It comes back by itself once the folder does.
        fs::create_dir_all(path.parent().expect("parent")).expect("sub");
        thread::sleep(REOPEN_AFTER + Duration::from_millis(100));
        file.write_all(b"ddddddd\n").expect("write");
        assert!(fs::read_to_string(&path).expect("read").contains("ddddddd"));
    }

    #[test]
    fn an_existing_file_is_appended_to_and_counted_from_its_size() {
        let dir = tmp("append");
        let path = dir.join("a.ndjson");
        fs::write(&path, "123456\n").expect("seed");
        let mut file = RotatingFile::open(path.clone(), 10, 2, Arc::default()).expect("open");
        file.write_all(b"abcdef\n").expect("write");
        assert_eq!(fs::read_to_string(dir.join("a.ndjson.1")).expect("1"), "123456\n");
        assert_eq!(fs::read_to_string(&path).expect("read"), "abcdef\n");
    }

    /// The child of `a_panic_flushes_the_last_line_before_the_process_dies`.
    /// Not a test of its own: it does nothing unless the parent asks.
    #[test]
    fn panic_child() {
        let Some(dir) = std::env::var_os("CREW_TRACE_TEST_CHILD") else { return };
        // What panic = "abort" does after the hooks: the process is gone at once.
        std::panic::set_hook(Box::new(|_| std::process::abort()));
        init(Path::new(&dir)).expect("init");
        tracing::info!("child.started");
        // The writer thread is still behind when the panic comes.
        SLOW_WRITES.store(5, Ordering::Relaxed);
        for i in 0..40 {
            tracing::info!(i, "child.tick");
        }
        tracing::info_span!("turn", turn_id = "t-1").in_scope(|| tracing::info!("child.before_panic"));
        // Nothing unwinds and no guard drops: the hook runs and the process is gone.
        let _ = thread::spawn(|| panic!("boom")).join();
        unreachable!("the hook aborts");
    }

    #[test]
    fn a_panic_flushes_the_last_line_before_the_process_dies() {
        let dir = tmp("panic");
        let exe = std::env::current_exe().expect("exe");
        let out = std::process::Command::new(exe)
            .args(["--exact", "trace::tests::panic_child", "--nocapture", "--test-threads=1"])
            .env("CREW_TRACE_TEST_CHILD", &dir)
            .output()
            .expect("child");
        assert!(!out.status.success(), "the child aborts");
        let text = fs::read_to_string(dir.join(DIR).join(MAIN_FILE)).expect("trace");
        let lines: Vec<serde_json::Value> = text.lines().map(|l| serde_json::from_str(l).expect("json line")).collect();
        let message = |l: &serde_json::Value| l["fields"]["message"].as_str().unwrap_or("").to_string();
        assert!(lines.iter().any(|l| message(l) == "child.started"));
        let before = lines.iter().find(|l| message(l) == "child.before_panic").expect("last line before the panic");
        assert_eq!(before["span"]["turn_id"], "t-1", "current span fields ride along");
        let panic = lines.iter().find(|l| message(l) == "daemon.panic").expect("panic record");
        assert_eq!(panic["level"], "ERROR");
        assert!(panic["fields"]["panic"].as_str().unwrap().contains("boom"));
        let errors = fs::read_to_string(dir.join(DIR).join(ERRORS_FILE)).expect("errors");
        assert!(errors.contains("daemon.panic"), "errors.ndjson has it too");
        assert_eq!(mode(&dir.join(DIR).join(MAIN_FILE)), 0o600);
    }
}
