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
    self, wake_prompt, Routine, RoutineRun, RunStatus, RunTrigger, ScheduledRoutine,
};
use crate::schedule::{next_run, parse_schedule, Schedule};
use crate::session::{self, Session};
use crate::store::{now_millis, Store};
use crate::turns::TurnHost;

/// The bounds on one sleep; see `wait_for`.
const MAX_WAIT_MS: i64 = 60_000;
const MIN_WAIT_MS: i64 = 1_000;
/// How often the tail of a fire looks at the agent it woke.
const SETTLE_POLL: Duration = Duration::from_millis(100);
/// …backing off to this, so a turn waiting on the user costs a read every few seconds.
const SETTLE_MAX: Duration = Duration::from_secs(5);

/// A fire is the one thing that changes a routine without a client asking, so
/// it is the one thing the routines screen cannot learn any other way.
pub trait RoutineEvents: Send + Sync {
    fn routines_changed(&self);
}

/// How long to sleep before the next tick.
///
/// Nothing due still arms: a minute's heartbeat is what makes a lost write or a
/// failed read heal itself instead of stopping the clock. And the floor is what
/// keeps a timer that fires nothing from becoming a spin — whatever disagreement
/// arms it, it costs one read a second rather than a core.
fn wait_for(due: Option<i64>, now: i64) -> i64 {
    due.map(|at| at - now).unwrap_or(MAX_WAIT_MS).clamp(MIN_WAIT_MS, MAX_WAIT_MS)
}

#[derive(Clone)]
pub struct Scheduler {
    store: Store,
    turns: TurnHost,
    runtime: Arc<Mutex<Option<tokio::runtime::Handle>>>,
    events: Arc<Mutex<Option<Arc<dyn RoutineEvents>>>>,
    /// One tick at a time: two that overlap read the same due rows and fire
    /// the same routine twice.
    ticking: Arc<Mutex<()>>,
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
            ticking: Arc::new(Mutex::new(())),
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
        let generation = self.generation.fetch_add(1, Ordering::Relaxed) + 1;
        let due = self.due_at();
        let wait = wait_for(due, now_millis()) as u64;
        let scheduler = self.clone();
        self.after(Duration::from_millis(wait), move || scheduler.tick(generation));
    }

    /// The earliest time a tick would act on.
    ///
    /// Only the rows a tick would actually fire. A disabled row that still
    /// carries a time would otherwise arm a timer that fires nothing, and the
    /// next arm would find the same row, at once, forever.
    fn due_at(&self) -> Option<i64> {
        routine::list(&self.store)
            .unwrap_or_default()
            .iter()
            .filter(|row| row.routine.enabled)
            .filter_map(|row| row.routine.next_run_at)
            .min()
    }

    /// The daemon is going away; timers still asleep do nothing when they wake.
    pub fn stop(&self) {
        self.stopped.store(true, Ordering::Relaxed);
    }

    /// "Run now" on the routines screen, down the same path a due one takes.
    pub fn run_now(&self, routine_id: String) -> Result<(), String> {
        if self.stopped.load(Ordering::Relaxed) {
            return Err("The daemon is shutting down.".into());
        }
        let row = routine::scheduled(&self.store, routine_id.clone())?
            .ok_or_else(|| format!("No routine {routine_id}"))?;
        {
            // The same door a sweep goes through. Without it, Run now and a
            // tick that came due at the same moment both read a row nobody has
            // written yet and the agent is woken twice for one routine.
            let _one_at_a_time = self.ticking.lock().unwrap_or_else(|e| e.into_inner());
            self.fire(row, RunTrigger::Manual);
        }
        self.arm();
        Ok(())
    }

    fn tick(&self, generation: u64) {
        if self.stopped.load(Ordering::Relaxed)
            || self.generation.load(Ordering::Relaxed) != generation
        {
            return;
        }
        // Before the sweep, not after it: a fire that never returns would
        // otherwise stop the clock for good, and the heartbeat that would have
        // healed it is armed by the tick that never finished.
        self.arm();
        {
            // One sweep at a time. A second tick that arrives mid-sweep would
            // read the same rows, still due, and fire them again; it has
            // already armed the next timer, so it can simply leave.
            let Ok(_one_at_a_time) = self.ticking.try_lock() else {
                return;
            };
            let now = now_millis();
            for row in routine::list(&self.store).unwrap_or_default() {
                if row.routine.enabled && row.routine.next_run_at.is_some_and(|at| at <= now) {
                    self.fire(row, RunTrigger::Schedule);
                }
            }
        }
        self.arm();
    }

    fn fire(&self, row: ScheduledRoutine, trigger: RunTrigger) {
        // The row as it is now, not as the sweep read it. Firing the routine
        // ahead of this one takes as long as a process spawn, and a save or a
        // delete in that window is the user's word — more recent than ours,
        // and about to be written over by the schedule this fire computes.
        let Ok(Some(row)) = routine::scheduled(&self.store, row.routine.id.clone()) else {
            return;
        };
        if trigger == RunTrigger::Schedule && !row.routine.enabled {
            return;
        }
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
        // The status now, not the one the tick's snapshot read: an earlier
        // routine in this same sweep may already have woken this agent.
        let busy = match session::get(&self.store, row.session.id.clone()) {
            Ok(Some(live)) => live.status == "working" || live.status == "needs-input",
            // A session we cannot read is one we will not start a turn on.
            _ => true,
        };
        let run = RoutineRun {
            id: uuid::Uuid::new_v4().to_string(),
            started_at: started,
            finished_at: if busy { Some(started) } else { None },
            status: if busy { RunStatus::Skipped } else { RunStatus::Running },
            trigger,
        };
        // The clock moves either way — a routine left past due fires again on
        // the next tick, and the next — but "last run" is for runs that ran.
        let moved = routine::record_run(
            &self.store,
            &row.routine.id,
            if busy { None } else { Some(started) },
            next,
            &run,
        );
        self.changed();
        // Without a written next_run_at nothing bounds a re-fire, so a history
        // we could not write is a turn we do not start.
        if moved.is_err() || busy {
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
            from_agent: None,
            sent_at: None,
            nonce: None,
        });
        if started_turn.is_err() {
            self.finish(&row.routine.id, &run, RunStatus::Error);
            return;
        }
        // The run is over when the agent is, so the history keeps saying
        // "running" while the turn it woke is still going.
        let scheduler = self.clone();
        thread::spawn(move || {
            if let Some(ok) = scheduler.await_turn(&row.session.id) {
                let status = if ok { RunStatus::Ok } else { RunStatus::Error };
                scheduler.finish(&row.routine.id, &run, status);
            }
        });
    }

    /// Whether the turn ended well, or None when the daemon went away first: a
    /// run whose end nobody saw stays "running" rather than claiming it failed.
    ///
    /// A turn parked on an approval can last as long as the user takes, so the
    /// poll backs off: the first seconds are worth 100 ms, an afternoon is not.
    fn await_turn(&self, session_id: &str) -> Option<bool> {
        let mut wait = SETTLE_POLL;
        loop {
            thread::sleep(wait);
            wait = (wait * 2).min(SETTLE_MAX);
            if self.stopped.load(Ordering::Relaxed) {
                return None;
            }
            // A read that failed says nothing about the turn. A row that is
            // gone says everything: the agent was deleted, and the turn with
            // it. Only the failure is worth waiting through.
            let live = match session::get(&self.store, session_id.to_string()) {
                Ok(Some(live)) => live,
                Ok(None) => return Some(false),
                Err(_) => continue,
            };
            if live.status != "working" && live.status != "needs-input" {
                return Some(live.status != "error");
            }
        }
    }

    /// The end of a run, and only that. The schedule this fire computed is
    /// already written; a turn can outlast the row that started it, and the
    /// one the user saved in between is the one that stands.
    fn finish(&self, routine_id: &str, run: &RoutineRun, status: RunStatus) {
        let done = RoutineRun {
            finished_at: Some(now_millis()),
            status,
            ..run.clone()
        };
        let _ = routine::finish_run(&self.store, routine_id, &done);
        self.changed();
    }

    /// The history moved, and no client asked for it.
    fn changed(&self) {
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

        /// A history from before this test, written the way the column holds it.
        fn seed_runs(&self, routine_id: &str, runs: &[RoutineRun]) {
            self.store()
                .with(|conn| {
                    conn.execute(
                        "UPDATE routines SET runs_json = ?2 WHERE id = ?1",
                        rusqlite::params![routine_id, routine::runs_json(runs)],
                    )
                })
                .expect("seed");
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

    /// A tick reads every routine once and then fires them one after another,
    /// so the second routine on an agent holds a status from before the first
    /// one woke it. Trusting it appends a note for a turn that never starts.
    #[test]
    fn a_fire_reads_the_status_now_not_the_one_the_tick_read() {
        let world = world();
        let coder = world.agent("Coder");
        let routine = world.routine(&coder, "Standup", Some(now_millis() - 1_000));
        let row = routine::scheduled(world.store(), routine.id.clone())
            .expect("scheduled")
            .expect("routine");
        assert_eq!(row.session.status, "idle", "the snapshot should be the stale one");
        session::set_status(world.store(), coder.id.clone(), "working".into()).expect("status");

        world.scheduler.fire(row, RunTrigger::Schedule);

        assert!(world.blocks(&coder.id).is_empty(), "it woke an agent that was working");
        assert_eq!(world.runs(&routine.id)[0].status, RunStatus::Skipped);
    }

    /// "Last run" is for runs that ran. A skip moves the clock forward — a
    /// routine left past due fires again on the next tick — and leaves the
    /// last real run where it was.
    #[test]
    fn a_skip_moves_the_clock_but_not_the_last_run() {
        let world = world();
        let coder = world.agent("Coder");
        let due = now_millis() - 1_000;
        let routine = world.routine(&coder, "Standup", Some(due));
        world.tick();
        world.settled_run(&routine.id);
        let ran_at = world.reload(&routine.id).last_run_at.expect("the first run");

        // Now it comes due again while the agent is busy with something else.
        routine::record_run(world.store(), &routine.id, None, Some(due), &RoutineRun {
            id: "seed".into(),
            started_at: ran_at,
            finished_at: Some(ran_at),
            status: RunStatus::Ok,
            trigger: RunTrigger::Schedule,
        })
        .expect("seed");
        session::set_status(world.store(), coder.id.clone(), "working".into()).expect("status");

        world.tick();

        let after = world.reload(&routine.id);
        assert_eq!(after.last_run_at, Some(ran_at), "a skip claimed to be the last run");
        assert!(after.next_run_at.is_some_and(|at| at > due), "a skip left the routine past due");
        assert_eq!(world.runs(&routine.id)[0].status, RunStatus::Skipped);
    }

    /// The row `arm` waits for is the row `tick` would fire. A row one counts
    /// and the other refuses is a timer that fires nothing and arms another
    /// just like it.
    #[test]
    fn a_disabled_row_is_not_a_time_to_wait_for() {
        let world = world();
        let coder = world.agent("Coder");
        let routine = world.routine(&coder, "Standup", Some(now_millis() - 60_000));
        assert!(world.scheduler.due_at().is_some(), "an enabled routine was not waited for");

        routine::upsert(
            world.store(),
            Some(routine.id.clone()),
            coder.id.clone(),
            "Standup".into(),
            false,
            "check the board".into(),
            Schedule::Interval { minutes: 30 }.to_json(),
            Some(now_millis() - 60_000),
            None,
        )
        .expect("disable");

        assert_eq!(world.scheduler.due_at(), None, "a disabled row still armed the timer");
    }

    /// Firing the routine before this one takes as long as a process spawn.
    /// What the user did in that window is newer than what the sweep read.
    #[test]
    fn a_routine_deleted_between_the_sweep_and_the_fire_wakes_nobody() {
        let world = world();
        let coder = world.agent("Coder");
        let routine = world.routine(&coder, "Standup", Some(now_millis() - 1_000));
        let row = routine::scheduled(world.store(), routine.id.clone())
            .expect("scheduled")
            .expect("routine");
        routine::delete(world.store(), routine.id.clone()).expect("delete");

        world.scheduler.fire(row, RunTrigger::Schedule);

        assert!(world.blocks(&coder.id).is_empty(), "a deleted routine woke its agent");
    }

    #[test]
    fn a_routine_switched_off_between_the_sweep_and_the_fire_stays_off() {
        let world = world();
        let coder = world.agent("Coder");
        let routine = world.routine(&coder, "Standup", Some(now_millis() - 1_000));
        let row = routine::scheduled(world.store(), routine.id.clone())
            .expect("scheduled")
            .expect("routine");
        routine::upsert(
            world.store(),
            Some(routine.id.clone()),
            coder.id.clone(),
            "Standup".into(),
            false,
            "check the board".into(),
            Schedule::Interval { minutes: 30 }.to_json(),
            None,
            None,
        )
        .expect("disable");

        world.scheduler.fire(row, RunTrigger::Schedule);

        assert!(world.blocks(&coder.id).is_empty(), "a routine switched off still fired");
        assert_eq!(
            world.reload(&routine.id).next_run_at,
            None,
            "the fire wrote a schedule back onto a routine the user had just switched off"
        );
    }

    /// The agent was deleted while its turn ran. The turn went with it, and the
    /// thread watching for its end has to notice rather than poll for ever.
    #[test]
    fn a_session_that_is_gone_ends_the_run() {
        let world = world();
        let coder = world.agent("Coder");
        session::delete(world.store(), coder.id.clone()).expect("delete");

        // On its own thread with a deadline: the bug this pins is a loop that
        // never ends, and a test that hangs says less than one that fails.
        let (done, heard) = std::sync::mpsc::channel();
        let watcher = world.scheduler.clone();
        let id = coder.id.clone();
        thread::spawn(move || done.send(watcher.await_turn(&id)));

        let ended = heard.recv_timeout(Duration::from_secs(5));
        world.scheduler.stop();
        assert_eq!(ended.ok(), Some(Some(false)), "the watcher never noticed the agent was gone");
    }

    /// A turn can outlast the row that started it. What the user saved while it
    /// ran is the row that stands; the watcher only closes its own entry.
    #[test]
    fn the_end_of_a_run_does_not_write_back_the_schedule_it_started_with() {
        let world = world();
        let coder = world.agent("Coder");
        let routine = world.routine(&coder, "Standup", Some(now_millis() - 1_000));
        let run = RoutineRun {
            id: "run-1".into(),
            started_at: now_millis(),
            finished_at: None,
            status: RunStatus::Running,
            trigger: RunTrigger::Schedule,
        };
        routine::record_run(world.store(), &routine.id, Some(run.started_at), Some(1), &run)
            .expect("start");

        // The user edits the routine mid-run: every two minutes from now.
        let saved = now_millis() + 120_000;
        routine::upsert(
            world.store(),
            Some(routine.id.clone()),
            coder.id.clone(),
            "Standup".into(),
            true,
            "check the board".into(),
            Schedule::Interval { minutes: 2 }.to_json(),
            Some(saved),
            None,
        )
        .expect("save");
        // And a second run is recorded while the first is still going.
        let other = RoutineRun { id: "run-2".into(), status: RunStatus::Skipped, ..run.clone() };
        routine::record_run(world.store(), &routine.id, None, Some(saved), &other).expect("skip");

        world.scheduler.finish(&routine.id, &run, RunStatus::Ok);

        let after = world.reload(&routine.id);
        assert_eq!(after.next_run_at, Some(saved), "the watcher wrote back the old schedule");
        let runs = world.runs(&routine.id);
        assert_eq!(runs.len(), 2, "the watcher dropped a run written while it waited");
        assert_eq!(
            runs.iter().find(|row| row.id == "run-1").map(|row| row.status),
            Some(RunStatus::Ok)
        );
    }

    /// A timer that arms for a row no tick will fire is a timer that arms
    /// again the moment it wakes: the same row, still past due, still refused.
    #[test]
    fn a_disabled_row_that_is_past_due_does_not_spin_the_timer() {
        let world = world();
        let coder = world.agent("Coder");
        routine::upsert(
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

        world.scheduler.arm();
        thread::sleep(Duration::from_millis(1_200));
        let arms = world.scheduler.generation.load(Ordering::Relaxed);
        world.scheduler.stop();

        assert!(arms < 10, "the timer armed {arms} times in a second");
    }

    /// The heartbeat: with nothing to wait for the scheduler still wakes, so a
    /// write that failed or a read that did is one minute of lost time, not all
    /// of it.
    #[test]
    fn the_wait_never_stops_the_clock_and_never_spins_it() {
        // Nothing due: wake anyway, so a lost write costs a minute, not the day.
        assert_eq!(wait_for(None, 0), MAX_WAIT_MS);
        // Long past due: soon, but never immediately.
        assert_eq!(wait_for(Some(-600_000), 0), MIN_WAIT_MS);
        assert_eq!(wait_for(Some(5_000), 0), 5_000);
        // Tomorrow: timers drift across a suspend, so look again in a minute.
        assert_eq!(wait_for(Some(86_400_000), 0), MAX_WAIT_MS);
    }

    /// Every arm replaces the timer before it. The one it replaced has to wake
    /// to nothing, or a routine written twice fires twice.
    #[test]
    fn a_timer_that_was_replaced_fires_nothing() {
        let world = world();
        let coder = world.agent("Coder");
        let routine = world.routine(&coder, "Standup", Some(now_millis() - 1_000));
        let stale = world.scheduler.generation.load(Ordering::Relaxed);
        world.scheduler.arm();

        world.scheduler.tick(stale);

        assert!(world.blocks(&coder.id).is_empty(), "a replaced timer still fired");
        assert!(world.runs(&routine.id).is_empty(), "a replaced timer wrote history");
        world.scheduler.stop();
    }

    /// Shutting down stops the clock: a timer already asleep wakes to nothing,
    /// and nothing new is armed.
    #[test]
    fn a_stopped_scheduler_does_not_fire_or_arm() {
        let world = world();
        let coder = world.agent("Coder");
        let routine = world.routine(&coder, "Standup", Some(now_millis() - 1_000));
        world.scheduler.stop();
        let armed = world.scheduler.generation.load(Ordering::Relaxed);

        world.scheduler.arm();
        world.tick();

        assert_eq!(world.scheduler.generation.load(Ordering::Relaxed), armed, "it armed after stop");
        assert!(world.blocks(&coder.id).is_empty(), "it fired after stop");
        assert!(world.runs(&routine.id).is_empty());
        assert!(world.scheduler.run_now(routine.id).is_err(), "run now started after stop");
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
        world.seed_runs(&routine.id, &old);

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
