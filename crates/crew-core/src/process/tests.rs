#![allow(clippy::disallowed_macros)] // tests print what they measured
use super::*;

struct Fixture {
    host: ProcessHost,
    workspace: String,
    dir: PathBuf,
}

impl Drop for Fixture {
    fn drop(&mut self) {
        self.host.shutdown();
        self.host.inner.pty.kill_all();
        let _ = std::fs::remove_dir_all(&self.dir);
    }
}

fn fast() -> ProcessConfig {
    ProcessConfig {
        stop_grace: Duration::from_millis(400),
        backoff_min: Duration::from_millis(20),
        backoff_max: Duration::from_millis(80),
        stable_after: Duration::from_secs(60),
        crash_limit: 3,
        crash_window: Duration::from_secs(30),
        rotate_at: log::ROTATE_AT,
    }
}

fn fixture(name: &str, config: ProcessConfig) -> Fixture {
    crate::trace::capture::install();
    let dir = std::env::temp_dir().join(format!("crew-proc-{name}-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&dir).unwrap();
    let store = Store::open(dir.join("crew.sqlite3")).unwrap();
    let workspace = crate::workspace::create(&store, "w".into(), dir.to_string_lossy().into()).unwrap().id;
    let host = ProcessHost::with_config(store, PtyHost::new(), &dir, config);
    Fixture { host, workspace, dir }
}

fn spec(name: &str, command: &str) -> ProcessSpec {
    ProcessSpec { name: name.into(), command: command.into(), cwd: String::new(), env: BTreeMap::new(), auto_restart: false }
}

impl Fixture {
    fn add(&self, name: &str, command: &str) -> Process {
        self.host.create(&self.workspace, spec(name, command), None).unwrap()
    }

    fn wait(&self, id: &str, limit: Duration, done: impl Fn(&Process) -> bool) -> Process {
        let deadline = Instant::now() + limit;
        loop {
            let process = self.host.get(&self.workspace, id).unwrap();
            if done(&process) || Instant::now() >= deadline {
                return process;
            }
            thread::sleep(Duration::from_millis(20));
        }
    }
}

/// The main checkout's run, or a stopped one if it never ran there: what a
/// process's own state was before runs had a worktree.
trait Main {
    fn main(&self) -> ProcessRun;
}

impl Main for Process {
    fn main(&self) -> ProcessRun {
        self.run_in(None).cloned().unwrap_or_else(|| ProcessRun {
            worktree: None,
            state: ProcessState::Stopped,
            pid: None,
            stream_id: None,
            started_at: None,
            exit_code: None,
            restarts: 0,
            pty_id: pty_id(&self.id, None),
            log_cursor: 0,
            run_cursor: 0,
            started_by: None,
            env: BTreeMap::new(),
            url: None,
        })
    }
}

fn marker_count(pattern: &str) -> usize {
    let out = std::process::Command::new("pgrep").args(["-f", pattern]).output().unwrap();
    String::from_utf8_lossy(&out.stdout).lines().filter(|l| !l.is_empty()).count()
}

/// A sleep only this test runs, so pgrep finds its processes and no one else's.
fn unique_sleep() -> String {
    format!("sleep 7{:05}", std::process::id() % 100_000 + rand_suffix())
}

fn rand_suffix() -> u32 {
    use std::sync::atomic::AtomicU32;
    static NEXT: AtomicU32 = AtomicU32::new(0);
    NEXT.fetch_add(1, Ordering::Relaxed)
}

#[test]
fn backoff_doubles_to_the_cap_and_starts_over_after_a_stable_run() {
    let config = ProcessConfig { crash_limit: 100, ..ProcessConfig::default() };
    let mut crashes = VecDeque::new();
    let mut backoff = Duration::ZERO;
    let start = Instant::now();
    let delays: Vec<u64> = (0..8)
        .map(|i| {
            plan_restart(&mut crashes, &mut backoff, start + Duration::from_millis(i), Duration::ZERO, &config).unwrap().as_secs()
        })
        .collect();
    assert_eq!(delays, vec![1, 2, 4, 8, 16, 30, 30, 30]);
    let after_a_minute_up = plan_restart(&mut crashes, &mut backoff, start, Duration::from_secs(60), &config);
    assert_eq!(after_a_minute_up, Some(Duration::from_secs(1)));
}

#[test]
fn five_crashes_in_two_minutes_give_up_but_spread_out_they_do_not() {
    let config = ProcessConfig::default();
    let mut crashes = VecDeque::new();
    let mut backoff = Duration::ZERO;
    let start = Instant::now();
    for i in 0..4 {
        assert!(plan_restart(&mut crashes, &mut backoff, start + Duration::from_secs(i), Duration::ZERO, &config).is_some());
    }
    assert_eq!(plan_restart(&mut crashes, &mut backoff, start + Duration::from_secs(10), Duration::ZERO, &config), None);

    let mut crashes = VecDeque::new();
    for i in 0..10 {
        let at = start + Duration::from_secs(i * 40);
        assert!(plan_restart(&mut crashes, &mut backoff, at, Duration::ZERO, &config).is_some(), "crash {i}");
    }
}

#[test]
fn a_crashing_process_restarts_until_the_limit_and_stays_crashed() {
    let f = fixture("crash", fast());
    let mut definition = spec("flaky", "echo boom; exit 3");
    definition.auto_restart = true;
    let process = f.host.create(&f.workspace, definition, None).unwrap();
    f.host.start(&f.workspace, &process.id, RunRequest::default()).unwrap();

    let done = f.wait(&process.id, Duration::from_secs(10), |p| p.main().state == ProcessState::Crashed);

    assert_eq!(done.main().state, ProcessState::Crashed);
    assert_eq!(done.main().restarts, 2, "three crashes: the first run and two restarts");
    assert_eq!(done.main().exit_code, Some(3));
    let logs = f.host.read_logs(&f.workspace, "flaky", None, None, Some(0), None).unwrap();
    assert_eq!(logs.text.lines().filter(|line| *line == "boom").count(), 3, "{:?}", logs.text);
    // Giving up is a warning that names the process and how many crashes it took; each start before it is a line.
    let crashed = crate::trace::capture::expect("process.crashed", "process_id", &process.id);
    assert_eq!((crashed.level, crashed.get("crashes")), (tracing::Level::WARN, Some("3")));
    assert!(crashed.fields.values().all(|v| !v.contains("boom")), "{crashed:?}");
    assert!(crate::trace::capture::find("process.start", "process_id", &process.id).len() >= 3);
    // A start by hand is a fresh count.
    let again = f.host.start(&f.workspace, "flaky", RunRequest::default()).unwrap();
    assert_eq!(again.main().restarts, 0);
}

#[test]
fn a_process_that_ends_on_its_own_is_exited_with_its_code() {
    let f = fixture("exit", fast());
    let process = f.add("once", "exit 7");
    f.host.start(&f.workspace, &process.id, RunRequest::default()).unwrap();
    let done = f.wait(&process.id, Duration::from_secs(5), |p| p.main().state == ProcessState::Exited);
    assert_eq!((done.main().state, done.main().exit_code), (ProcessState::Exited, Some(7)));
    assert_eq!(done.main().pid, None);
}

#[test]
fn stop_takes_the_whole_process_group_down() {
    let f = fixture("group", fast());
    let sleeper = unique_sleep();
    let process = f.add("server", &format!("{sleeper} & {sleeper} & wait"));
    f.host.start(&f.workspace, &process.id, RunRequest::default()).unwrap();
    let deadline = Instant::now() + Duration::from_secs(5);
    // The shell's own command line names the sleep too.
    while marker_count(&sleeper) < 3 && Instant::now() < deadline {
        thread::sleep(Duration::from_millis(20));
    }
    assert_eq!(marker_count(&sleeper), 3, "the workers never started");

    let stopped = f.host.stop(&f.workspace, &process.id, None).unwrap();
    thread::sleep(Duration::from_millis(100));

    assert_eq!(stopped.main().state, ProcessState::Stopped);
    assert_eq!(marker_count(&sleeper), 0, "a worker outlived the stop");
}

#[test]
fn stop_escalates_to_sigkill_when_the_group_ignores_sigterm() {
    let f = fixture("kill", fast());
    let sleeper = unique_sleep();
    let process = f.add("stubborn", &format!("trap '' TERM; {sleeper} & wait; {sleeper}"));
    f.host.start(&f.workspace, &process.id, RunRequest::default()).unwrap();
    let deadline = Instant::now() + Duration::from_secs(5);
    while marker_count(&sleeper) < 1 && Instant::now() < deadline {
        thread::sleep(Duration::from_millis(20));
    }

    let asked = Instant::now();
    let stopped = f.host.stop(&f.workspace, &process.id, None).unwrap();

    assert!(asked.elapsed() >= fast().stop_grace, "stop returned before the grace ran out");
    assert_eq!(stopped.main().state, ProcessState::Stopped);
    thread::sleep(Duration::from_millis(100));
    assert_eq!(marker_count(&sleeper), 0);
}

#[test]
fn shutdown_gives_every_process_one_shared_grace_to_exit() {
    let f = fixture("shutdown", fast());
    let polite = f.add("polite", "trap 'sleep 0.1; echo flushed; exit 0' TERM; while true; do sleep 0.05; done");
    let stubborn = unique_sleep();
    for name in ["stubborn-a", "stubborn-b"] {
        f.add(name, &format!("trap '' TERM; {stubborn} & wait; {stubborn}"));
    }
    for name in ["polite", "stubborn-a", "stubborn-b"] {
        f.host.start(&f.workspace, name, RunRequest::default()).unwrap();
    }
    let deadline = Instant::now() + Duration::from_secs(5);
    while marker_count(&stubborn) < 2 && Instant::now() < deadline {
        thread::sleep(Duration::from_millis(20));
    }

    let asked = Instant::now();
    f.host.shutdown();
    let took = asked.elapsed();

    // Two that ignore SIGTERM still cost one grace, not two.
    assert!(took >= fast().stop_grace, "returned before the grace: {took:?}");
    assert!(took < fast().stop_grace * 2, "the graces added up: {took:?}");
    let logs = f.host.read_logs(&f.workspace, &polite.id, None, None, Some(0), None).unwrap();
    assert!(logs.text.contains("flushed"), "{:?}", logs.text);
    assert_eq!(f.host.get(&f.workspace, "polite").unwrap().main().state, ProcessState::Stopped);
    // What is left is the PTY host's to kill.
    f.host.inner.pty.kill_all();
    thread::sleep(Duration::from_millis(100));
    assert_eq!(marker_count(&stubborn), 0);
}

fn stat_of(pid: u32) -> String {
    let out = std::process::Command::new("ps").args(["-o", "stat=", "-p", &pid.to_string()]).output().unwrap();
    String::from_utf8_lossy(&out.stdout).trim().to_string()
}

#[test]
fn pause_and_resume_stop_and_continue_the_group() {
    let f = fixture("pause", fast());
    let process = f.add("ticker", "while true; do sleep 0.05; done");
    let started = f.host.start(&f.workspace, &process.id, RunRequest::default()).unwrap();
    let pid = started.main().pid.expect("a pid while running");

    let paused = f.host.pause(&f.workspace, &process.id, None).unwrap();
    thread::sleep(Duration::from_millis(100));
    let while_paused = stat_of(pid);
    let resumed = f.host.resume(&f.workspace, &process.id, None).unwrap();
    thread::sleep(Duration::from_millis(100));
    let after = stat_of(pid);
    // Stopping a paused process has to wake it for its SIGTERM.
    let stopped =
        f.host.pause(&f.workspace, &process.id, None).and_then(|_| f.host.stop(&f.workspace, &process.id, None)).unwrap();

    assert_eq!(paused.main().state, ProcessState::Paused);
    assert!(while_paused.starts_with('T'), "paused stat {while_paused}");
    assert_eq!(resumed.main().state, ProcessState::Running);
    assert!(!after.starts_with('T'), "resumed stat {after}");
    assert_eq!(stopped.main().state, ProcessState::Stopped);
    assert!(f.host.resume(&f.workspace, &process.id, None).is_err());
}

#[test]
fn stopping_a_live_process_is_traced_once_and_says_whether_it_was_paused() {
    let f = fixture("stop-trace", fast());
    let running = f.add("running", "sleep 30");
    f.host.start(&f.workspace, &running.id, RunRequest::default()).unwrap();
    f.host.stop(&f.workspace, &running.id, None).unwrap();
    let line = crate::trace::capture::expect("process.stop", "process_id", &running.id);
    assert_eq!((line.level, line.get("paused")), (tracing::Level::INFO, Some("false")));
    // Stopping what is already stopped is not another stop.
    f.host.stop(&f.workspace, &running.id, None).unwrap();
    assert_eq!(crate::trace::capture::find("process.stop", "process_id", &running.id).len(), 1);

    let paused = f.add("paused", "sleep 30");
    f.host.start(&f.workspace, &paused.id, RunRequest::default()).unwrap();
    f.host.pause(&f.workspace, &paused.id, None).unwrap();
    f.host.stop(&f.workspace, &paused.id, None).unwrap();
    assert_eq!(crate::trace::capture::expect("process.stop", "process_id", &paused.id).get("paused"), Some("true"));
}

#[test]
fn a_process_drains_to_its_log_with_nobody_watching() {
    let f = fixture("drain", fast());
    let process = f.add("flood", "yes 0123456789abcdef | head -c 3000000; echo; echo DONE");
    f.host.start(&f.workspace, &process.id, RunRequest::default()).unwrap();
    let done = f.wait(&process.id, Duration::from_secs(20), |p| p.main().state == ProcessState::Exited);
    assert_eq!(done.main().state, ProcessState::Exited, "blocked with nobody reading");
    assert!(done.main().log_cursor > 3_000_000);
    let tail = f.host.read_logs(&f.workspace, &process.id, None, Some(3), None, None).unwrap();
    assert!(tail.text.contains("DONE"), "{:?}", tail.text);
    assert_eq!(tail.cursor, done.main().log_cursor);
}

#[test]
fn logs_rotate_and_a_cursor_reads_on_across_the_rotation() {
    let config = ProcessConfig { rotate_at: 64 * 1024, ..fast() };
    let f = fixture("rotate", config);
    let first = f.add("counter", "i=0; while [ $i -lt 2000 ]; do echo line-$i; i=$((i+1)); done");
    f.host.start(&f.workspace, &first.id, RunRequest::default()).unwrap();
    let done = f.wait(&first.id, Duration::from_secs(20), |p| p.main().state == ProcessState::Exited);
    let files = std::fs::read_dir(f.dir.join("logs").join(&first.id)).unwrap().count();
    let from_start = f.host.read_logs(&f.workspace, &first.id, None, None, Some(0), Some(256 * 1024)).unwrap();
    let cursor = done.main().log_cursor;

    f.host.start(&f.workspace, &first.id, RunRequest::default()).unwrap();
    f.wait(&first.id, Duration::from_secs(20), |p| p.main().state == ProcessState::Exited && p.main().log_cursor > cursor);
    let next = f.host.read_logs(&f.workspace, &first.id, None, None, Some(cursor), Some(64)).unwrap();

    assert!(files <= 2, "{files} log files");
    assert_eq!(from_start.skipped, 0, "20 KB fit in one file");
    assert!(from_start.text.contains("line-1999"));
    assert_eq!(next.start, cursor);
    assert!(next.text.starts_with("[crew] $"), "the second run starts at the old cursor: {:?}", next.text);
    // A cursor from before the oldest file is served from where the disk starts.
    let old = f.host.read_logs(&f.workspace, &first.id, None, None, Some(0), Some(64)).unwrap();
    assert!(old.skipped > 0 || old.start == 0);
}

#[test]
fn text_for_agents_has_no_escapes_but_the_log_keeps_them() {
    let f = fixture("ansi", fast());
    let process = f.add("colour", r"printf '\033[31mred\033[0m plain\n'");
    f.host.start(&f.workspace, &process.id, RunRequest::default()).unwrap();
    f.wait(&process.id, Duration::from_secs(5), |p| p.main().state == ProcessState::Exited);
    let clean = f.host.read_logs(&f.workspace, &process.id, None, None, None, None).unwrap();
    let raw = f.host.log_tail_raw(&f.workspace, &process.id, None, None).unwrap();
    assert!(clean.text.contains("red plain"), "{:?}", clean.text);
    assert!(!clean.text.contains('\x1b'));
    assert!(raw.text.contains("\x1b[31mred"));
}

#[test]
fn grep_finds_the_latest_matches_with_context() {
    let f = fixture("grep", fast());
    let process = f.add("noisy", "for i in 1 2 3 4 5 6; do echo before-$i; echo ERROR $i; done; echo tail");
    f.host.start(&f.workspace, &process.id, RunRequest::default()).unwrap();
    f.wait(&process.id, Duration::from_secs(5), |p| p.main().state == ProcessState::Exited);
    let grep = f.host.grep_logs(&f.workspace, &process.id, None, r"ERROR \d", Some(1), Some(2)).unwrap();
    assert_eq!(grep.total, 6);
    let lines: Vec<&str> = grep.matches.iter().map(|m| m.line.as_str()).collect();
    assert_eq!(lines, vec!["ERROR 5", "ERROR 6"]);
    assert_eq!(grep.matches[0].before, vec!["before-5"]);
    assert_eq!(grep.matches[0].after, vec!["before-6"]);
    assert_eq!(grep.matches[1].after, vec!["tail"]);
    assert!(f.host.grep_logs(&f.workspace, &process.id, None, "(", None, None).is_err());
}

#[test]
fn wait_for_log_matches_times_out_and_notices_the_end() {
    let f = fixture("wait", fast());
    let server = f.add("server", "sleep 0.3; echo 'ready on :5173'; sleep 30");
    f.host.start(&f.workspace, &server.id, RunRequest::default()).unwrap();
    let matched = f.host.wait_for_log(&f.workspace, "server", None, r"ready on :\d+", None, 10).unwrap();
    let LogWait::Matched { line, cursor, .. } = matched else {
        panic!("{matched:?}");
    };
    assert_eq!(line, "ready on :5173");

    let asked = Instant::now();
    let timed_out = f.host.wait_for_log(&f.workspace, "server", None, "never", Some(cursor), 1).unwrap();
    assert!(matches!(timed_out, LogWait::TimedOut { .. }), "{timed_out:?}");
    assert!(asked.elapsed() >= Duration::from_secs(1));

    let short = f.add("short", "sleep 0.2; exit 4");
    f.host.start(&f.workspace, &short.id, RunRequest::default()).unwrap();
    let ended = f.host.wait_for_log(&f.workspace, "short", None, "never", None, 10).unwrap();
    assert!(matches!(ended, LogWait::Ended { state: ProcessState::Exited, exit_code: Some(4), .. }), "{ended:?}");
}

#[test]
fn send_input_types_into_the_process() {
    let f = fixture("input", fast());
    let process = f.add("repl", "read line; echo got:$line; sleep 30");
    f.host.start(&f.workspace, &process.id, RunRequest::default()).unwrap();
    f.host.send_input(&f.workspace, &process.id, None, "hi\r").unwrap();
    let got = f.host.wait_for_log(&f.workspace, &process.id, None, "^got:hi$", None, 5).unwrap();
    assert!(matches!(got, LogWait::Matched { .. }), "{got:?}");
    f.host.stop(&f.workspace, &process.id, None).unwrap();
    assert!(f.host.send_input(&f.workspace, &process.id, None, "x").is_err());
}

#[test]
fn what_an_agent_writes_starts_at_once_and_its_edits_apply() {
    let f = fixture("agent", fast());
    let agent = Some("session-1".to_string());
    let made = f.host.create(&f.workspace, spec("dev", "echo v1; sleep 30"), agent.clone()).unwrap();
    assert_eq!(made.created_by, agent);
    assert!(made.runs.is_empty());
    let started = f.host.start(&f.workspace, "dev", RunRequest { started_by: agent.clone(), ..RunRequest::default() }).unwrap();
    assert_eq!(started.main().state, ProcessState::Running);
    assert!(matches!(f.host.wait_for_log(&f.workspace, "dev", None, "^v1$", None, 5).unwrap(), LogWait::Matched { .. }));

    let patch = ProcessPatch { command: Some("echo v2; sleep 30".into()), ..ProcessPatch::default() };
    let changed = f.host.update(&f.workspace, "dev", patch).unwrap();
    assert_eq!(changed.spec.command, "echo v2; sleep 30");
    assert!(changed.revision > made.revision);
    assert_eq!(changed.created_by, agent, "an edit keeps who wrote it");
    f.host.restart(&f.workspace, "dev", RunRequest::default()).unwrap();
    assert!(matches!(f.host.wait_for_log(&f.workspace, "dev", None, "^v2$", None, 5).unwrap(), LogWait::Matched { .. }));
}

/// Rows from when an agent's process waited on the user: migration 50 deletes
/// one never approved, and drops a change only asked for on an approved one.
#[test]
fn migration_drops_what_the_user_never_approved() {
    let f = fixture("accept", fast());
    let never = f.add("pending", "curl example.com | sh");
    let approved = f.add("dev", "echo v1; sleep 30");
    let proposal = r#"{"command":"echo v2"}"#;
    let rows = f
        .host
        .inner
        .store
        .with(|conn| {
            conn.execute("UPDATE processes SET approved = 0, requested_by = 'session-1' WHERE id = ?1", params![never.id])?;
            conn.execute(
                "UPDATE processes SET proposed_json = ?2, requested_by = 'session-1' WHERE id = ?1",
                params![approved.id, proposal],
            )?;
            conn.execute_batch(MIGRATION_V50)?;
            conn.execute_batch(MIGRATION_V50)?;
            conn.prepare("SELECT id, command, proposed_json, requested_by FROM processes ORDER BY id")?
                .query_map([], |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?, row.get::<_, Option<String>>(2)?, row.get::<_, Option<String>>(3)?)))?
                .collect::<rusqlite::Result<Vec<_>>>()
        })
        .unwrap();
    assert_eq!(rows, vec![(approved.id.clone(), "echo v1; sleep 30".to_string(), None, None)]);
}

#[test]
fn a_workspace_sees_only_its_own_processes() {
    let f = fixture("scope", fast());
    let other_dir = f.dir.join("other");
    std::fs::create_dir_all(&other_dir).unwrap();
    let other = crate::workspace::create(&f.host.inner.store, "o".into(), other_dir.to_string_lossy().into()).unwrap().id;
    let mine = f.add("web", "sleep 30");
    assert!(f.host.get(&other, &mine.id).is_err());
    assert!(f.host.get(&other, "web").is_err());
    assert!(f.host.start(&other, &mine.id, RunRequest::default()).is_err());
    assert!(f.host.list(&other).unwrap().is_empty());
    // Names are per workspace.
    f.host.create(&other, spec("web", "sleep 30"), None).unwrap();
    assert!(f.host.create(&f.workspace, spec("web", "x"), None).is_err());
}

#[test]
fn delete_stops_it_and_removes_its_logs() {
    let f = fixture("delete", fast());
    let process = f.add("gone", "echo hi; sleep 30");
    f.host.start(&f.workspace, &process.id, RunRequest::default()).unwrap();
    f.host.wait_for_log(&f.workspace, "gone", None, "hi", None, 5).unwrap();
    let pid = f.host.get(&f.workspace, "gone").unwrap().main().pid.unwrap();
    f.host.delete(&f.workspace, "gone").unwrap();
    thread::sleep(Duration::from_millis(100));
    assert!(stat_of(pid).is_empty() || stat_of(pid).starts_with('Z'), "still running");
    assert!(!f.dir.join("logs").join(&process.id).exists());
    assert!(f.host.list(&f.workspace).unwrap().is_empty());
}

#[test]
fn names_are_unique_in_a_workspace() {
    let f = fixture("names", fast());
    let web = f.add("web", "sleep 30");
    f.add("api", "sleep 30");
    let rename = ProcessPatch { name: Some("api".into()), ..ProcessPatch::default() };
    let refused = f.host.update(&f.workspace, "web", rename).unwrap_err();
    assert_eq!(refused, "A process named \"api\" already exists");
    assert_eq!(f.host.get(&f.workspace, &web.id).unwrap().spec.name, "web");

    // The index holds even for a write that skips the check.
    let taken = f.host.write_spec(&web.id, &spec("api", "x")).unwrap_err();
    assert_eq!(taken, "A process named \"api\" already exists");
}

#[test]
fn migration_renames_duplicate_names_before_making_them_unique() {
    let f = fixture("dedupe", fast());
    let rows = f.host.inner.store.with(|conn| {
        conn.execute_batch("DROP INDEX processes_name_idx;")?;
        for (i, name) in ["web", "web", "web (2)", "web", "api"].iter().enumerate() {
            conn.execute(
                "INSERT INTO processes (id, workspace_id, name, command, created_at, updated_at)
                 VALUES (?1, ?2, ?3, 'x', ?4, ?4)",
                params![format!("p{i}"), f.workspace, name, i as i64],
            )?;
        }
        migrate_unique_names(conn)?;
        let mut stmt = conn.prepare("SELECT id, name FROM processes ORDER BY id")?;
        let rows = stmt.query_map([], |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?)))?;
        rows.collect::<rusqlite::Result<Vec<_>>>()
    });
    let names: Vec<String> = rows.unwrap().into_iter().map(|(_, name)| name).collect();
    assert_eq!(names, vec!["web", "web (3)", "web (2)", "web (4)", "api"]);
    let again = f.host.inner.store.with(|conn| {
        conn.execute(
            "INSERT INTO processes (id, workspace_id, name, command, created_at, updated_at) VALUES ('p9', ?1, 'web', 'x', 9, 9)",
            params![f.workspace],
        )
    });
    assert!(again.unwrap_err().contains("UNIQUE"), "the index is back");
}

#[test]
fn wait_for_log_answers_ended_at_once_for_a_process_that_is_not_up() {
    let f = fixture("wait-down", fast());
    let once = f.add("once", "echo ready; exit 0");
    f.host.start(&f.workspace, &once.id, RunRequest::default()).unwrap();
    f.wait(&once.id, Duration::from_secs(5), |p| p.main().state == ProcessState::Exited);

    // The line is in the log, from a run that is over: it says nothing about now.
    let asked = Instant::now();
    let waited = f.host.wait_for_log(&f.workspace, "once", None, "ready", None, 5).unwrap();
    assert!(matches!(waited, LogWait::Ended { state: ProcessState::Exited, .. }), "{waited:?}");
    let waited = f.host.wait_for_log(&f.workspace, "once", None, "ready", Some(0), 5).unwrap();
    assert!(matches!(waited, LogWait::Ended { .. }), "{waited:?}");
    assert!(asked.elapsed() < Duration::from_secs(1));

    // A daemon that restarted knows no run: the log is not scanned from 0.
    let again = ProcessHost::with_config(f.host.inner.store.clone(), PtyHost::new(), &f.dir, fast());
    let waited = again.wait_for_log(&f.workspace, "once", None, "ready", None, 5).unwrap();
    assert!(matches!(waited, LogWait::Ended { state: ProcessState::Stopped, .. }), "{waited:?}");
}

#[test]
fn wait_for_log_in_a_backoff_waits_for_the_next_run_and_hears_a_stop() {
    let config = ProcessConfig { backoff_min: Duration::from_millis(600), backoff_max: Duration::from_millis(600), ..fast() };
    let f = fixture("wait-backoff", config);
    let marker = f.dir.join("second");
    let command = format!(
        "if [ -e {m} ]; then sleep 0.2; echo second-ready; sleep 30; else touch {m}; echo first-ready; exit 1; fi",
        m = marker.display()
    );
    let mut flaky = spec("flaky", &command);
    flaky.auto_restart = true;
    let process = f.host.create(&f.workspace, flaky, None).unwrap();
    f.host.start(&f.workspace, &process.id, RunRequest::default()).unwrap();
    f.wait(&process.id, Duration::from_secs(5), |p| p.main().state == ProcessState::Starting);

    // Waiting out the backoff, the dead run's ready line must not count.
    let waited = f.host.wait_for_log(&f.workspace, "flaky", None, "ready", None, 10).unwrap();
    let LogWait::Matched { line, .. } = waited else {
        panic!("{waited:?}");
    };
    assert_eq!(line, "second-ready");
    f.host.stop(&f.workspace, "flaky", None).unwrap();

    // A stop during the backoff writes nothing, and still wakes the waiter.
    std::fs::remove_file(&marker).unwrap();
    f.host.start(&f.workspace, &process.id, RunRequest::default()).unwrap();
    f.wait(&process.id, Duration::from_secs(5), |p| p.main().state == ProcessState::Starting);
    let host = f.host.clone();
    let workspace = f.workspace.clone();
    let waiter = thread::spawn(move || {
        let asked = Instant::now();
        (host.wait_for_log(&workspace, "flaky", None, "never", Some(u64::MAX), 30).unwrap(), asked.elapsed())
    });
    thread::sleep(Duration::from_millis(100));
    f.host.stop(&f.workspace, "flaky", None).unwrap();
    let (waited, took) = waiter.join().unwrap();
    assert!(matches!(waited, LogWait::Ended { state: ProcessState::Stopped, .. }), "{waited:?}");
    assert!(took < Duration::from_secs(2), "slept out its timeout: {took:?}");
}

/// Fifty megabytes with nobody attached: the child never blocks, the log
/// holds the last twenty, and memory stays at the ring.
#[test]
#[ignore]
fn stress_fifty_megabytes_with_nobody_watching() {
    let f = fixture("stress", ProcessConfig::default());
    let process = f.add("firehose", "yes 0123456789abcdefghijklmnopqrstuvwxyz | head -c 52428800; echo; echo END");
    let started = Instant::now();
    f.host.start(&f.workspace, &process.id, RunRequest::default()).unwrap();
    let done = f.wait(&process.id, Duration::from_secs(120), |p| p.main().state == ProcessState::Exited);
    assert_eq!(done.main().state, ProcessState::Exited, "did not finish in two minutes");
    assert!(done.main().log_cursor >= 52_428_800);
    let on_disk: u64 = std::fs::read_dir(f.dir.join("logs").join(&process.id))
        .unwrap()
        .map(|entry| entry.unwrap().metadata().unwrap().len())
        .sum();
    assert!(on_disk <= 2 * log::ROTATE_AT, "{on_disk} bytes kept");
    let tail = f.host.read_logs(&f.workspace, &process.id, None, Some(2), None, None).unwrap();
    assert!(tail.text.contains("END"));
    eprintln!("50 MB drained in {:?}", started.elapsed());
}

#[test]
fn a_log_from_before_worktrees_is_the_main_checkouts() {
    let f = fixture("old-log", fast());
    let web = f.add("web", "echo hi");
    let dir = f.dir.join("logs").join(&web.id);
    std::fs::create_dir_all(&dir).unwrap();
    std::fs::write(dir.join(format!("{:020}.log", 0)), "old line\n").unwrap();

    let host = ProcessHost::with_config(f.host.inner.store.clone(), PtyHost::new(), &f.dir, fast());
    assert!(dir.join("main").join(format!("{:020}.log", 0)).is_file());
    let read = host.read_logs(&f.workspace, "web", None, None, Some(0), None).unwrap();
    assert_eq!(read.text, "old line\n");
}

#[test]
fn a_folder_is_relative_to_the_worktree() {
    let f = fixture("relative", fast());
    let absolute = ProcessSpec { cwd: "/tmp".into(), ..spec("abs", "true") };
    assert!(f.host.create(&f.workspace, absolute, None).unwrap_err().contains("relative"));
    f.add("web", "true");
    let patch = ProcessPatch { cwd: Some("/etc".into()), ..ProcessPatch::default() };
    assert!(f.host.update(&f.workspace, "web", patch).unwrap_err().contains("relative"));
}

#[test]
fn a_run_offers_the_local_address_it_prints_until_it_ends() {
    let f = fixture("url", fast());
    let sleep = unique_sleep();
    let process = f.add("web", &format!("printf 'docs at https://example.com\\n  Local: http://0.0.0.0:4321/\\n'; {sleep}"));
    f.host.start(&f.workspace, &process.id, RunRequest::default()).unwrap();

    let up = f.wait(&process.id, Duration::from_secs(10), |p| p.main().url.is_some());
    assert_eq!(up.main().url.as_deref(), Some("http://localhost:4321/"));

    let stopped = f.host.stop(&f.workspace, &process.id, None).unwrap();
    assert_eq!(stopped.main().url, None);
}
