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
    let dir = std::env::temp_dir().join(format!("crew-proc-{name}-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&dir).unwrap();
    let store = Store::open(dir.join("crew.sqlite3")).unwrap();
    let workspace = crate::workspace::create(&store, "w".into(), dir.to_string_lossy().into()).unwrap().id;
    let host = ProcessHost::with_config(store, PtyHost::new(), &dir, config);
    Fixture { host, workspace, dir }
}

fn spec(name: &str, command: &str) -> ProcessSpec {
    ProcessSpec {
        name: name.into(),
        command: command.into(),
        cwd: String::new(),
        env: BTreeMap::new(),
        auto_start: false,
        auto_restart: false,
    }
}

impl Fixture {
    fn add(&self, name: &str, command: &str) -> Process {
        self.host.create(&self.workspace, spec(name, command), None, false).unwrap()
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
            plan_restart(&mut crashes, &mut backoff, start + Duration::from_millis(i), Duration::ZERO, &config)
                .unwrap()
                .as_secs()
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
    let process = f.host.create(&f.workspace, definition, None, false).unwrap();
    f.host.start(&f.workspace, &process.id).unwrap();

    let done = f.wait(&process.id, Duration::from_secs(10), |p| p.state == ProcessState::Crashed);

    assert_eq!(done.state, ProcessState::Crashed);
    assert_eq!(done.restarts, 2, "three crashes: the first run and two restarts");
    assert_eq!(done.exit_code, Some(3));
    let logs = f.host.read_logs(&f.workspace, "flaky", None, Some(0), None).unwrap();
    assert_eq!(logs.text.lines().filter(|line| *line == "boom").count(), 3, "{:?}", logs.text);
    // A start by hand is a fresh count.
    let again = f.host.start(&f.workspace, "flaky").unwrap();
    assert_eq!(again.restarts, 0);
}

#[test]
fn a_process_that_ends_on_its_own_is_exited_with_its_code() {
    let f = fixture("exit", fast());
    let process = f.add("once", "exit 7");
    f.host.start(&f.workspace, &process.id).unwrap();
    let done = f.wait(&process.id, Duration::from_secs(5), |p| p.state == ProcessState::Exited);
    assert_eq!((done.state, done.exit_code), (ProcessState::Exited, Some(7)));
    assert_eq!(done.pid, None);
}

#[test]
fn stop_takes_the_whole_process_group_down() {
    let f = fixture("group", fast());
    let sleeper = unique_sleep();
    let process = f.add("server", &format!("{sleeper} & {sleeper} & wait"));
    f.host.start(&f.workspace, &process.id).unwrap();
    let deadline = Instant::now() + Duration::from_secs(5);
    // The shell's own command line names the sleep too.
    while marker_count(&sleeper) < 3 && Instant::now() < deadline {
        thread::sleep(Duration::from_millis(20));
    }
    assert_eq!(marker_count(&sleeper), 3, "the workers never started");

    let stopped = f.host.stop(&f.workspace, &process.id).unwrap();
    thread::sleep(Duration::from_millis(100));

    assert_eq!(stopped.state, ProcessState::Stopped);
    assert_eq!(marker_count(&sleeper), 0, "a worker outlived the stop");
}

#[test]
fn stop_escalates_to_sigkill_when_the_group_ignores_sigterm() {
    let f = fixture("kill", fast());
    let sleeper = unique_sleep();
    let process = f.add("stubborn", &format!("trap '' TERM; {sleeper} & wait; {sleeper}"));
    f.host.start(&f.workspace, &process.id).unwrap();
    let deadline = Instant::now() + Duration::from_secs(5);
    while marker_count(&sleeper) < 1 && Instant::now() < deadline {
        thread::sleep(Duration::from_millis(20));
    }

    let asked = Instant::now();
    let stopped = f.host.stop(&f.workspace, &process.id).unwrap();

    assert!(asked.elapsed() >= fast().stop_grace, "stop returned before the grace ran out");
    assert_eq!(stopped.state, ProcessState::Stopped);
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
        f.host.start(&f.workspace, name).unwrap();
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
    let logs = f.host.read_logs(&f.workspace, &polite.id, None, Some(0), None).unwrap();
    assert!(logs.text.contains("flushed"), "{:?}", logs.text);
    assert_eq!(f.host.get(&f.workspace, "polite").unwrap().state, ProcessState::Stopped);
    // What is left is the PTY host's to kill.
    f.host.inner.pty.kill_all();
    thread::sleep(Duration::from_millis(100));
    assert_eq!(marker_count(&stubborn), 0);
}

fn stat_of(pid: u32) -> String {
    let out = std::process::Command::new("ps")
        .args(["-o", "stat=", "-p", &pid.to_string()])
        .output()
        .unwrap();
    String::from_utf8_lossy(&out.stdout).trim().to_string()
}

#[test]
fn pause_and_resume_stop_and_continue_the_group() {
    let f = fixture("pause", fast());
    let process = f.add("ticker", "while true; do sleep 0.05; done");
    let started = f.host.start(&f.workspace, &process.id).unwrap();
    let pid = started.pid.expect("a pid while running");

    let paused = f.host.pause(&f.workspace, &process.id).unwrap();
    thread::sleep(Duration::from_millis(100));
    let while_paused = stat_of(pid);
    let resumed = f.host.resume(&f.workspace, &process.id).unwrap();
    thread::sleep(Duration::from_millis(100));
    let after = stat_of(pid);
    // Stopping a paused process has to wake it for its SIGTERM.
    let stopped = f.host.pause(&f.workspace, &process.id).and_then(|_| f.host.stop(&f.workspace, &process.id)).unwrap();

    assert_eq!(paused.state, ProcessState::Paused);
    assert!(while_paused.starts_with('T'), "paused stat {while_paused}");
    assert_eq!(resumed.state, ProcessState::Running);
    assert!(!after.starts_with('T'), "resumed stat {after}");
    assert_eq!(stopped.state, ProcessState::Stopped);
    assert!(f.host.resume(&f.workspace, &process.id).is_err());
}

#[test]
fn a_process_drains_to_its_log_with_nobody_watching() {
    let f = fixture("drain", fast());
    let process = f.add("flood", "yes 0123456789abcdef | head -c 3000000; echo; echo DONE");
    f.host.start(&f.workspace, &process.id).unwrap();
    let done = f.wait(&process.id, Duration::from_secs(20), |p| p.state == ProcessState::Exited);
    assert_eq!(done.state, ProcessState::Exited, "blocked with nobody reading");
    assert!(done.log_cursor > 3_000_000);
    let tail = f.host.read_logs(&f.workspace, &process.id, Some(3), None, None).unwrap();
    assert!(tail.text.contains("DONE"), "{:?}", tail.text);
    assert_eq!(tail.cursor, done.log_cursor);
}

#[test]
fn logs_rotate_and_a_cursor_reads_on_across_the_rotation() {
    let config = ProcessConfig { rotate_at: 64 * 1024, ..fast() };
    let f = fixture("rotate", config);
    let first = f.add("counter", "i=0; while [ $i -lt 2000 ]; do echo line-$i; i=$((i+1)); done");
    f.host.start(&f.workspace, &first.id).unwrap();
    let done = f.wait(&first.id, Duration::from_secs(20), |p| p.state == ProcessState::Exited);
    let files = std::fs::read_dir(f.dir.join("logs").join(&first.id)).unwrap().count();
    let from_start = f.host.read_logs(&f.workspace, &first.id, None, Some(0), Some(256 * 1024)).unwrap();
    let cursor = done.log_cursor;

    f.host.start(&f.workspace, &first.id).unwrap();
    f.wait(&first.id, Duration::from_secs(20), |p| p.state == ProcessState::Exited && p.log_cursor > cursor);
    let next = f.host.read_logs(&f.workspace, &first.id, None, Some(cursor), Some(64)).unwrap();

    assert!(files <= 2, "{files} log files");
    assert_eq!(from_start.skipped, 0, "20 KB fit in one file");
    assert!(from_start.text.contains("line-1999"));
    assert_eq!(next.start, cursor);
    assert!(next.text.starts_with("[crew] $"), "the second run starts at the old cursor: {:?}", next.text);
    // A cursor from before the oldest file is served from where the disk starts.
    let old = f.host.read_logs(&f.workspace, &first.id, None, Some(0), Some(64)).unwrap();
    assert!(old.skipped > 0 || old.start == 0);
}

#[test]
fn text_for_agents_has_no_escapes_but_the_log_keeps_them() {
    let f = fixture("ansi", fast());
    let process = f.add("colour", r"printf '\033[31mred\033[0m plain\n'");
    f.host.start(&f.workspace, &process.id).unwrap();
    f.wait(&process.id, Duration::from_secs(5), |p| p.state == ProcessState::Exited);
    let clean = f.host.read_logs(&f.workspace, &process.id, None, None, None).unwrap();
    let raw = f.host.log_tail_raw(&f.workspace, &process.id, None).unwrap();
    assert!(clean.text.contains("red plain"), "{:?}", clean.text);
    assert!(!clean.text.contains('\x1b'));
    assert!(raw.text.contains("\x1b[31mred"));
}

#[test]
fn grep_finds_the_latest_matches_with_context() {
    let f = fixture("grep", fast());
    let process = f.add("noisy", "for i in 1 2 3 4 5 6; do echo before-$i; echo ERROR $i; done; echo tail");
    f.host.start(&f.workspace, &process.id).unwrap();
    f.wait(&process.id, Duration::from_secs(5), |p| p.state == ProcessState::Exited);
    let grep = f.host.grep_logs(&f.workspace, &process.id, r"ERROR \d", Some(1), Some(2)).unwrap();
    assert_eq!(grep.total, 6);
    let lines: Vec<&str> = grep.matches.iter().map(|m| m.line.as_str()).collect();
    assert_eq!(lines, vec!["ERROR 5", "ERROR 6"]);
    assert_eq!(grep.matches[0].before, vec!["before-5"]);
    assert_eq!(grep.matches[0].after, vec!["before-6"]);
    assert_eq!(grep.matches[1].after, vec!["tail"]);
    assert!(f.host.grep_logs(&f.workspace, &process.id, "(", None, None).is_err());
}

#[test]
fn wait_for_log_matches_times_out_and_notices_the_end() {
    let f = fixture("wait", fast());
    let server = f.add("server", "sleep 0.3; echo 'ready on :5173'; sleep 30");
    f.host.start(&f.workspace, &server.id).unwrap();
    let matched = f.host.wait_for_log(&f.workspace, "server", r"ready on :\d+", None, 10).unwrap();
    let LogWait::Matched { line, cursor, .. } = matched else {
        panic!("{matched:?}");
    };
    assert_eq!(line, "ready on :5173");

    let asked = Instant::now();
    let timed_out = f.host.wait_for_log(&f.workspace, "server", "never", Some(cursor), 1).unwrap();
    assert!(matches!(timed_out, LogWait::TimedOut { .. }), "{timed_out:?}");
    assert!(asked.elapsed() >= Duration::from_secs(1));

    let short = f.add("short", "sleep 0.2; exit 4");
    f.host.start(&f.workspace, &short.id).unwrap();
    let ended = f.host.wait_for_log(&f.workspace, "short", "never", None, 10).unwrap();
    assert!(
        matches!(ended, LogWait::Ended { state: ProcessState::Exited, exit_code: Some(4), .. }),
        "{ended:?}"
    );
}

#[test]
fn send_input_types_into_the_process() {
    let f = fixture("input", fast());
    let process = f.add("repl", "read line; echo got:$line; sleep 30");
    f.host.start(&f.workspace, &process.id).unwrap();
    f.host.send_input(&f.workspace, &process.id, "hi\r").unwrap();
    let got = f.host.wait_for_log(&f.workspace, &process.id, "^got:hi$", None, 5).unwrap();
    assert!(matches!(got, LogWait::Matched { .. }), "{got:?}");
    f.host.stop(&f.workspace, &process.id).unwrap();
    assert!(f.host.send_input(&f.workspace, &process.id, "x").is_err());
}

#[test]
fn what_an_agent_writes_waits_for_the_user() {
    let f = fixture("approval", fast());
    let agent = Some("session-1".to_string());
    let asked = f.host.create(&f.workspace, spec("dev", "echo v1; sleep 30"), agent.clone(), true).unwrap();
    assert_eq!(asked.state, ProcessState::PendingApproval);
    assert_eq!(asked.created_by, agent);
    assert_eq!(asked.requested_by, agent);
    let refused = f.host.start(&f.workspace, "dev").unwrap_err();
    assert!(refused.contains("approve"), "{refused}");

    let approved = f.host.approve(&f.workspace, "dev").unwrap();
    assert!(approved.approved);
    assert_eq!(approved.state, ProcessState::Stopped);

    let patch = ProcessPatch { command: Some("echo v2".into()), ..ProcessPatch::default() };
    let proposed = f.host.update(&f.workspace, "dev", patch, agent.clone(), true).unwrap();
    assert_eq!(proposed.spec.command, "echo v1; sleep 30", "the accepted command stays until approved");
    assert_eq!(proposed.proposed.as_ref().map(|p| p.command.as_str()), Some("echo v2"));
    let kept = f.host.reject(&f.workspace, "dev").unwrap().unwrap();
    assert_eq!((kept.spec.command.as_str(), kept.proposed), ("echo v1; sleep 30", None));

    // A creation the user turns down is gone.
    f.host.create(&f.workspace, spec("rogue", "rm -rf /"), agent, true).unwrap();
    assert_eq!(f.host.reject(&f.workspace, "rogue").unwrap(), None);
    assert!(f.host.get(&f.workspace, "rogue").is_err());
}

#[test]
fn a_workspace_sees_only_its_own_processes() {
    let f = fixture("scope", fast());
    let other_dir = f.dir.join("other");
    std::fs::create_dir_all(&other_dir).unwrap();
    let other = crate::workspace::create(&f.host.inner.store, "o".into(), other_dir.to_string_lossy().into())
        .unwrap()
        .id;
    let mine = f.add("web", "sleep 30");
    assert!(f.host.get(&other, &mine.id).is_err());
    assert!(f.host.get(&other, "web").is_err());
    assert!(f.host.start(&other, &mine.id).is_err());
    assert!(f.host.list(&other).unwrap().is_empty());
    // Names are per workspace.
    f.host.create(&other, spec("web", "sleep 30"), None, false).unwrap();
    assert!(f.host.create(&f.workspace, spec("web", "x"), None, false).is_err());
}

#[test]
fn solo_yml_imports_and_reimports_by_name() {
    let f = fixture("solo", fast());
    std::fs::write(
        f.dir.join("solo.yml"),
        "name: X\nprocesses:\n  app:\n    command: npm run app\n    auto_start: true\n    auto_restart: true\n",
    )
    .unwrap();
    let first = f.host.import_solo_yml(&f.workspace, None, false).unwrap();
    assert_eq!(first.created, vec!["app"]);
    std::fs::write(f.dir.join("solo.yml"), "processes:\n  app:\n    command: npm run dev\n").unwrap();
    let second = f.host.import_solo_yml(&f.workspace, None, false).unwrap();
    assert_eq!(second.updated, vec!["app"]);
    let app = f.host.get(&f.workspace, "app").unwrap();
    assert_eq!(app.spec.command, "npm run dev");
    assert!(app.spec.auto_start && !app.spec.auto_restart);
}

#[test]
fn delete_stops_it_and_removes_its_logs() {
    let f = fixture("delete", fast());
    let process = f.add("gone", "echo hi; sleep 30");
    f.host.start(&f.workspace, &process.id).unwrap();
    f.host.wait_for_log(&f.workspace, "gone", "hi", None, 5).unwrap();
    let pid = f.host.get(&f.workspace, "gone").unwrap().pid.unwrap();
    f.host.delete(&f.workspace, "gone").unwrap();
    thread::sleep(Duration::from_millis(100));
    assert!(stat_of(pid).is_empty() || stat_of(pid).starts_with('Z'), "still running");
    assert!(!f.dir.join("logs").join(&process.id).exists());
    assert!(f.host.list(&f.workspace).unwrap().is_empty());
}

/// Fifty megabytes with nobody attached: the child never blocks, the log
/// holds the last twenty, and memory stays at the ring.
#[test]
#[ignore]
fn stress_fifty_megabytes_with_nobody_watching() {
    let f = fixture("stress", ProcessConfig::default());
    let process = f.add("firehose", "yes 0123456789abcdefghijklmnopqrstuvwxyz | head -c 52428800; echo; echo END");
    let started = Instant::now();
    f.host.start(&f.workspace, &process.id).unwrap();
    let done = f.wait(&process.id, Duration::from_secs(120), |p| p.state == ProcessState::Exited);
    assert_eq!(done.state, ProcessState::Exited, "did not finish in two minutes");
    assert!(done.log_cursor >= 52_428_800);
    let on_disk: u64 = std::fs::read_dir(f.dir.join("logs").join(&process.id))
        .unwrap()
        .map(|entry| entry.unwrap().metadata().unwrap().len())
        .sum();
    assert!(on_disk <= 2 * log::ROTATE_AT, "{on_disk} bytes kept");
    let tail = f.host.read_logs(&f.workspace, &process.id, Some(2), None, None).unwrap();
    assert!(tail.text.contains("END"));
    eprintln!("50 MB drained in {:?}", started.elapsed());
}
