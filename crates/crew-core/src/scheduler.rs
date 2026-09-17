//! Standing orders fire here.
//!
//! A routine that only runs while a window is open is not a standing order, so
//! the timer lives in the daemon: one timer for the earliest due routine, and
//! a tick that wakes every routine whose time has passed. Firing joins the
//! agent's own conversation as a hidden turn — what it found last time is
//! context for this time — and the note is the only visible trace of the
//! wake-up.

use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::Duration;

use crew_protocol::TurnStart;

use crate::routine::{
    self, push_run, runs_json, wake_prompt, Routine, RoutineRun, RunStatus, RunTrigger, ScheduledRoutine,
};
use crate::schedule::{next_run, parse_schedule, Schedule};
use crate::session::{self, Session};
use crate::store::{now_millis, Store};
use crate::turns::TurnHost;

/// Timers drift across sleep; a short cap keeps a due run from waiting until tomorrow.
const MAX_WAIT_MS: i64 = 60_000;
/// How often the tail of a fire looks at the agent it woke.
const SETTLE_POLL: Duration = Duration::from_millis(100);

/// A fire is the one thing that changes a routine without a client asking, so
/// it is the one thing the routines screen cannot learn any other way.
pub trait RoutineEvents: Send + Sync {
    fn routines_changed(&self);
}

#[derive(Clone)]
pub struct Scheduler {
    store: Store,
    turns: TurnHost,
    runtime: Arc<Mutex<Option<tokio::runtime::Handle>>>,
    events: Arc<Mutex<Option<Arc<dyn RoutineEvents>>>>,
    /// Bumped on every arm: a timer that wakes with a stale one was replaced.
    generation: Arc<AtomicU64>,
    stopped: Arc<AtomicBool>,
}

impl Scheduler {
    pub fn new(store: Store, turns: TurnHost) -> Self {
        Self {
            store,
            turns,
            runtime: Arc::new(Mutex::new(None)),
            events: Arc::new(Mutex::new(None)),
            generation: Arc::new(AtomicU64::new(0)),
            stopped: Arc::new(AtomicBool::new(false)),
        }
    }

    pub fn set_runtime(&self, handle: tokio::runtime::Handle) {
        *self.runtime.lock().unwrap_or_else(|e| e.into_inner()) = Some(handle);
    }

    pub fn set_events(&self, events: Arc<dyn RoutineEvents>) {
        *self.events.lock().unwrap_or_else(|e| e.into_inner()) = Some(events);
    }

    /// Re-read the routines and point the timer at the earliest one. Called at
    /// boot, after every tick, and whenever a routine is written.
    pub fn arm(&self) {
        if self.stopped.load(Ordering::Relaxed) {
            return;
        }
        let rows = routine::list(&self.store).unwrap_or_default();
        let Some(due) = rows.iter().filter_map(|row| row.routine.next_run_at).min() else {
            return;
        };
        let generation = self.generation.fetch_add(1, Ordering::Relaxed) + 1;
        let wait = (due - now_millis()).clamp(0, MAX_WAIT_MS) as u64;
        let scheduler = self.clone();
        self.after(Duration::from_millis(wait), move || scheduler.tick(generation));
    }

    /// The daemon is going away; timers still asleep do nothing when they wake.
    pub fn stop(&self) {
        self.stopped.store(true, Ordering::Relaxed);
    }

    /// "Run now" on the routines screen, down the same path a due one takes.
    pub fn run_now(&self, routine_id: String) -> Result<(), String> {
        let row = routine::scheduled(&self.store, routine_id.clone())?
            .ok_or_else(|| format!("No routine {routine_id}"))?;
        self.fire(row, RunTrigger::Manual);
        self.arm();
        Ok(())
    }

    fn tick(&self, generation: u64) {
        if self.stopped.load(Ordering::Relaxed)
            || self.generation.load(Ordering::Relaxed) != generation
        {
            return;
        }
        let now = now_millis();
        for row in routine::list(&self.store).unwrap_or_default() {
            if row.routine.enabled && row.routine.next_run_at.is_some_and(|at| at <= now) {
                self.fire(row, RunTrigger::Schedule);
            }
        }
        self.arm();
    }

    fn fire(&self, row: ScheduledRoutine, trigger: RunTrigger) {
        let started = now_millis();
        // An unreadable schedule reads as the app's default rather than as no
        // schedule at all, so a fired routine always gets a next time.
        let schedule = parse_schedule(&row.routine.schedule).unwrap_or(Schedule::Daily {
            hour: 9,
            minute: 0,
            days: Vec::new(),
        });
        let next = if row.routine.enabled {
            next_run(&schedule, started)
        } else {
            None
        };
        let run = RoutineRun {
            id: uuid::Uuid::new_v4().to_string(),
            started_at: started,
            finished_at: None,
            status: RunStatus::Running,
            trigger,
        };
        let runs = push_run(&routine::parse_runs(&row.routine.runs_json), run.clone());
        self.mark(&row.routine.id, started, next, &runs);

        // The agent is mid-turn: a routine waits for the next time round rather
        // than queueing behind whatever it is doing.
        if row.session.status == "working" || row.session.status == "needs-input" {
            self.finish(&row.routine, started, next, &runs, &run, RunStatus::Skipped);
            return;
        }
        self.turns
            .transcripts()
            .append_system(&row.session.id, &format!("Routine · {}", row.routine.name));
        let text = wake_prompt(
            &row.routine.name,
            &schedule,
            trigger,
            &row.routine.prompt,
            self.creator_name(&row.routine, &row.session).as_deref(),
        );
        let started_turn = self.turns.start(TurnStart {
            session_id: row.session.id.clone(),
            cwd: row.cwd.clone(),
            text,
            files: None,
            mentions: None,
            hidden: Some(true),
            fresh: None,
            from_agent: None,
            nonce: None,
        });
        if started_turn.is_err() {
            self.finish(&row.routine, started, next, &runs, &run, RunStatus::Error);
            return;
        }
        // The run is over when the agent is, so the history keeps saying
        // "running" while the turn it woke is still going.
        let scheduler = self.clone();
        thread::spawn(move || {
            if let Some(ok) = scheduler.await_turn(&row.session.id) {
                let status = if ok { RunStatus::Ok } else { RunStatus::Error };
                scheduler.finish(&row.routine, started, next, &runs, &run, status);
            }
        });
    }

    /// Whether the turn ended well, or None when the daemon went away first: a
    /// run whose end nobody saw stays "running" rather than claiming it failed.
    fn await_turn(&self, session_id: &str) -> Option<bool> {
        loop {
            thread::sleep(SETTLE_POLL);
            if self.stopped.load(Ordering::Relaxed) {
                return None;
            }
            let status = session::get(&self.store, session_id.to_string())
                .ok()
                .flatten()
                .map(|row| row.status)
                .unwrap_or_default();
            if status != "working" && status != "needs-input" {
                return Some(status != "error");
            }
        }
    }

    fn finish(
        &self,
        routine: &Routine,
        started: i64,
        next: Option<i64>,
        runs: &[RoutineRun],
        run: &RoutineRun,
        status: RunStatus,
    ) {
        let done = RoutineRun {
            finished_at: Some(now_millis()),
            status,
            ..run.clone()
        };
        self.mark(&routine.id, started, next, &push_run(runs, done));
    }

    /// A history nobody could write is a run that still happened; the turn is
    /// the point, so a failed write is not worth failing the fire over.
    fn mark(&self, id: &str, started: i64, next: Option<i64>, runs: &[RoutineRun]) {
        let _ = routine::mark_run(&self.store, id.to_string(), started, next, runs_json(runs));
        let events = self.events.lock().unwrap_or_else(|e| e.into_inner()).clone();
        if let Some(events) = events {
            events.routines_changed();
        }
    }

    /// None when the user or the agent itself wrote the routine.
    fn creator_name(&self, routine: &Routine, session: &Session) -> Option<String> {
        let by = routine
            .created_by
            .as_deref()
            .filter(|id| !id.is_empty() && *id != session.id)?;
        Some(
            session::get(&self.store, by.to_string())
                .ok()
                .flatten()
                .map(|creator| creator.name)
                .unwrap_or_else(|| "another agent".into()),
        )
    }

    fn after(&self, wait: Duration, work: impl FnOnce() + Send + 'static) {
        let handle = self.runtime.lock().unwrap_or_else(|e| e.into_inner()).clone();
        match handle {
            Some(handle) => {
                handle.spawn(async move {
                    tokio::time::sleep(wait).await;
                    // A tick reads the database and starts turns; it has no
                    // business on an async worker.
                    tokio::task::spawn_blocking(work);
                });
            }
            None => {
                thread::spawn(move || {
                    thread::sleep(wait);
                    work();
                });
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::routine::{RoutineRun, MAX_RUNS};
    use crew_protocol::BlockRole;

    /// An opencode that answers once and stops: enough for a turn to end, which
    /// is when a run stops being "running".
    fn fake_opencode(dir: &std::path::Path) -> String {
        let path = dir.join("fake-opencode");
        std::fs::write(
            &path,
            r#"#!/usr/bin/env python3
import json, sys
sys.stdin.read()
sid = "ses_test"
print(json.dumps({"type":"text","sessionID":sid,"part":{"id":"p1","type":"text","text":"ok"}}), flush=True)
print(json.dumps({"type":"step_finish","sessionID":sid,"part":{"id":"s1","type":"step-finish","reason":"stop","tokens":{"input":1,"output":1,"reasoning":0,"cache":{"read":0,"write":0}},"cost":0}}), flush=True)
"#,
        )
        .expect("write fake");
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o755)).expect("chmod");
        path.to_string_lossy().into_owned()
    }

    /// The daemon wires the agent process's stdout back into the turn host; a
    /// test that spawns a real process has to do the same or nothing ever ends.
    struct Fanout(TurnHost);

    impl crate::agent::AgentEvents for Fanout {
        fn lines(&self, event: &str, session_id: &str, lines: Vec<String>) {
            self.0.on_agent_lines(event, session_id, lines);
        }
        fn exit(&self, session_id: &str, code: Option<i32>, _pid: u32) {
            self.0.on_agent_exit(session_id, code);
        }
    }

    struct World {
        scheduler: Scheduler,
        host: TurnHost,
        workspace: String,
    }

    fn world() -> World {
        let host = TurnHost::test_new();
        host.test_agents().set_events(Arc::new(Fanout(host.clone())));
        let dir = std::env::temp_dir().join(uuid::Uuid::new_v4().to_string());
        std::fs::create_dir_all(&dir).expect("dir");
        host.override_binary("opencode", fake_opencode(&dir));
        let workspace = crate::workspace::create(
            host.test_store(),
            "w".into(),
            dir.to_string_lossy().into_owned(),
        )
        .expect("workspace")
        .id;
        let scheduler = Scheduler::new(host.test_store().clone(), host.clone());
        World { scheduler, host, workspace }
    }

    impl World {
        fn store(&self) -> &Store {
            self.host.test_store()
        }

        fn agent(&self, name: &str) -> Session {
            session::create(
                self.store(),
                self.workspace.clone(),
                "agent".into(),
                name.into(),
                "opencode".into(),
                "m".into(),
                "".into(),
                "full".into(),
            )
            .expect("agent")
        }

        fn routine(&self, agent: &Session, name: &str, due: Option<i64>) -> Routine {
            routine::upsert(
                self.store(),
                None,
                agent.id.clone(),
                name.into(),
                true,
                "check the board".into(),
                Schedule::Interval { minutes: 30 }.to_json(),
                due,
                None,
            )
            .expect("routine")
        }

        /// The tick the armed timer would run, without waiting for the clock.
        fn tick(&self) {
            self.scheduler
                .tick(self.scheduler.generation.load(Ordering::Relaxed));
        }

        fn blocks(&self, session_id: &str) -> Vec<crew_protocol::Block> {
            self.host.transcripts().window(session_id, Some(500), None).blocks
        }

        fn runs(&self, routine_id: &str) -> Vec<RoutineRun> {
            let row = routine::scheduled(self.store(), routine_id.to_string())
                .expect("scheduled")
                .expect("routine");
            routine::parse_runs(&row.routine.runs_json)
        }

        fn reload(&self, routine_id: &str) -> Routine {
            routine::scheduled(self.store(), routine_id.to_string())
                .expect("scheduled")
                .expect("routine")
                .routine
        }

        /// The tail of a fire runs on its own thread; wait for it to land.
        fn settled_run(&self, routine_id: &str) -> RoutineRun {
            for _ in 0..200 {
                let runs = self.runs(routine_id);
                if let Some(run) = runs.first() {
                    if run.status != RunStatus::Running {
                        return run.clone();
                    }
                }
                thread::sleep(Duration::from_millis(30));
            }
            panic!("the run never finished");
        }
    }

    fn wake_text(world: &World, session_id: &str) -> String {
        world
            .blocks(session_id)
            .into_iter()
            .find(|block| block.role == BlockRole::User && block.text.starts_with("[routine]"))
            .map(|block| block.text)
            .unwrap_or_default()
    }

    #[test]
    fn a_due_routine_wakes_its_agent_with_a_hidden_turn() {
        let world = world();
        let coder = world.agent("Coder");
        world.routine(&coder, "Standup", Some(now_millis() - 1_000));

        world.tick();

        let blocks = world.blocks(&coder.id);
        assert!(
            blocks
                .iter()
                .any(|block| block.role == BlockRole::System && block.text == "Routine · Standup"),
            "the transcript does not say the routine woke it"
        );
        let woke = blocks
            .iter()
            .find(|block| block.role == BlockRole::User)
            .expect("no turn was started");
        assert_eq!(woke.hidden, Some(true), "the wake-up was not hidden");
        assert!(woke.text.contains("[routine] \"Standup\" is due (every 30 minutes)"), "{}", woke.text);
        assert!(woke.text.contains("check the board"), "{}", woke.text);
    }

    #[test]
    fn an_armed_timer_fires_a_routine_that_is_already_due() {
        let world = world();
        let coder = world.agent("Coder");
        let routine = world.routine(&coder, "Standup", Some(now_millis() - 1_000));

        world.scheduler.arm();

        assert_eq!(world.settled_run(&routine.id).status, RunStatus::Ok);
        world.scheduler.stop();
    }

    /// Nobody asked for this run, so nobody is holding a stale list on purpose:
    /// the screen only learns the history moved because the daemon says so.
    #[test]
    fn a_fire_tells_the_clients_the_history_moved() {
        struct Counter(Arc<AtomicU64>);
        impl RoutineEvents for Counter {
            fn routines_changed(&self) {
                self.0.fetch_add(1, Ordering::Relaxed);
            }
        }
        let world = world();
        let said = Arc::new(AtomicU64::new(0));
        world.scheduler.set_events(Arc::new(Counter(said.clone())));
        let coder = world.agent("Coder");
        let routine = world.routine(&coder, "Standup", Some(now_millis() - 1_000));

        world.tick();
        world.settled_run(&routine.id);

        // Once when the run starts and once when it ends: a history that only
        // arrives at the end leaves the screen showing nothing for a whole turn.
        assert!(said.load(Ordering::Relaxed) >= 2, "the daemon fired in silence");
    }

    #[test]
    fn a_fire_moves_the_next_run_forward_and_records_ok() {
        let world = world();
        let coder = world.agent("Coder");
        let due = now_millis() - 1_000;
        let routine = world.routine(&coder, "Standup", Some(due));

        world.tick();

        let run = world.settled_run(&routine.id);
        assert_eq!(run.status, RunStatus::Ok);
        assert_eq!(run.trigger, RunTrigger::Schedule);
        assert!(run.finished_at.is_some_and(|at| at >= run.started_at));
        let after = world.reload(&routine.id);
        assert_eq!(after.last_run_at, Some(run.started_at));
        assert!(
            after.next_run_at.is_some_and(|at| at > due),
            "next_run_at stayed at {:?}",
            after.next_run_at
        );
    }

    #[test]
    fn a_disabled_routine_never_fires() {
        let world = world();
        let coder = world.agent("Coder");
        let routine = routine::upsert(
            world.store(),
            None,
            coder.id.clone(),
            "Standup".into(),
            false,
            "check the board".into(),
            Schedule::Interval { minutes: 30 }.to_json(),
            Some(now_millis() - 60_000),
            None,
        )
        .expect("routine");

        world.tick();

        assert!(world.blocks(&coder.id).is_empty(), "a disabled routine woke its agent");
        assert!(world.runs(&routine.id).is_empty(), "a disabled routine wrote history");
    }

    #[test]
    fn a_busy_agent_skips_the_run() {
        let world = world();
        let coder = world.agent("Coder");
        let routine = world.routine(&coder, "Standup", Some(now_millis() - 1_000));
        session::set_status(world.store(), coder.id.clone(), "working".into()).expect("status");

        world.tick();

        let runs = world.runs(&routine.id);
        assert_eq!(runs.len(), 1);
        assert_eq!(runs[0].status, RunStatus::Skipped);
        assert!(runs[0].finished_at.is_some());
        assert!(world.blocks(&coder.id).is_empty(), "a busy agent was woken anyway");
    }

    #[test]
    fn the_wake_prompt_says_who_set_the_routine_up() {
        let world = world();
        let coder = world.agent("Coder");
        let cuddles = world.agent("Cuddles");
        routine::upsert(
            world.store(),
            None,
            coder.id.clone(),
            "Standup".into(),
            true,
            "check the board".into(),
            Schedule::Interval { minutes: 30 }.to_json(),
            Some(now_millis() - 1_000),
            Some(cuddles.id.clone()),
        )
        .expect("routine");

        world.tick();

        assert!(
            wake_text(&world, &coder.id).contains("a standing order Cuddles set up for you"),
            "{}",
            wake_text(&world, &coder.id)
        );
    }

    #[test]
    fn a_routine_an_agent_set_up_for_itself_names_nobody() {
        let world = world();
        let coder = world.agent("Coder");
        routine::upsert(
            world.store(),
            None,
            coder.id.clone(),
            "Standup".into(),
            true,
            "check the board".into(),
            Schedule::Interval { minutes: 30 }.to_json(),
            Some(now_millis() - 1_000),
            Some(coder.id.clone()),
        )
        .expect("routine");

        world.tick();

        let text = wake_text(&world, &coder.id);
        assert!(text.contains("your own standing order"), "{text}");
        assert!(!text.contains("set up for you"), "{text}");
    }

    #[test]
    fn run_now_fires_one_routine_on_demand() {
        let world = world();
        let coder = world.agent("Coder");
        // Not due for half an hour: only the manual trigger can start it.
        let routine = world.routine(&coder, "Standup", Some(now_millis() + 1_800_000));

        world.scheduler.run_now(routine.id.clone()).expect("run now");

        let run = world.settled_run(&routine.id);
        assert_eq!(run.trigger, RunTrigger::Manual);
        assert_eq!(run.status, RunStatus::Ok);
        assert!(
            wake_text(&world, &coder.id).contains("was run on demand"),
            "the manual cue is missing"
        );
        world.scheduler.stop();
    }

    #[test]
    fn the_run_history_stays_capped_and_newest_first() {
        let world = world();
        let coder = world.agent("Coder");
        let routine = world.routine(&coder, "Standup", Some(now_millis() - 1_000));
        let old: Vec<RoutineRun> = (0..MAX_RUNS)
            .map(|i| RoutineRun {
                id: format!("old-{i}"),
                started_at: i as i64,
                finished_at: Some(i as i64),
                status: RunStatus::Ok,
                trigger: RunTrigger::Schedule,
            })
            .collect();
        routine::mark_run(
            world.store(),
            routine.id.clone(),
            0,
            Some(now_millis() - 1_000),
            routine::runs_json(&old),
        )
        .expect("history");

        world.tick();

        let run = world.settled_run(&routine.id);
        let runs = world.runs(&routine.id);
        assert_eq!(runs.len(), MAX_RUNS);
        assert_eq!(runs[0].id, run.id, "the newest run is not first");
        assert_eq!(runs[1].id, "old-0");
        assert!(
            !runs.iter().any(|row| row.id == format!("old-{}", MAX_RUNS - 1)),
            "the oldest run survived the cap"
        );
    }

    #[test]
    fn a_run_entry_is_the_json_the_routines_screen_reads() {
        let run = RoutineRun {
            id: "r1".into(),
            started_at: 1,
            finished_at: None,
            status: RunStatus::Skipped,
            trigger: RunTrigger::Manual,
        };
        assert_eq!(
            routine::runs_json(&[run]),
            r#"[{"id":"r1","startedAt":1,"finishedAt":null,"status":"skipped","trigger":"manual"}]"#
        );
    }
}
