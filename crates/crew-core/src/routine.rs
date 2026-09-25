use rusqlite::{params, OptionalExtension};
use serde::{Deserialize, Serialize};

use crate::schedule::{describe_schedule, Schedule};
use crate::session::{row_to_session, Session, SESSION_COLUMNS, SESSION_COLUMN_COUNT};
use crate::store::{now_millis, Store};

/// A standing order for one agent. `schedule` and `runs_json` are JSON the UI
/// owns; Rust only stores the next due time and hands the rows back.
#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Routine {
    pub id: String,
    pub session_id: String,
    pub name: String,
    pub enabled: bool,
    pub prompt: String,
    pub schedule: String,
    pub last_run_at: Option<i64>,
    pub next_run_at: Option<i64>,
    pub runs_json: String,
    /// Session that set it up when it was an agent, not the user; the wake prompt names it.
    pub created_by: Option<String>,
}

/// What the scheduler needs to fire a run, and the routines screen to list one,
/// without another round trip.
#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct ScheduledRoutine {
    pub routine: Routine,
    pub session: Session,
    pub cwd: String,
}

const ROUTINE_COLUMNS: &str =
    "r.id, r.session_id, r.name, r.enabled, r.prompt, r.schedule, r.last_run_at, r.next_run_at, r.runs_json, r.created_by";
const ROUTINE_COLUMN_COUNT: usize = 10;

fn row_to_routine(row: &rusqlite::Row, offset: usize) -> rusqlite::Result<Routine> {
    Ok(Routine {
        id: row.get(offset)?,
        session_id: row.get(offset + 1)?,
        name: row.get(offset + 2)?,
        enabled: row.get::<_, i64>(offset + 3)? != 0,
        prompt: row.get(offset + 4)?,
        schedule: row.get(offset + 5)?,
        last_run_at: row.get(offset + 6)?,
        next_run_at: row.get(offset + 7)?,
        runs_json: row.get(offset + 8)?,
        created_by: row.get(offset + 9)?,
    })
}

pub fn list_for_session(store: &Store, session_id: String) -> Result<Vec<Routine>, String> {
    store.with(|conn| {
        let mut stmt = conn.prepare_cached(&format!(
            "SELECT {ROUTINE_COLUMNS} FROM routines r WHERE r.session_id = ?1 ORDER BY r.created_at"
        ))?;
        let rows = stmt.query_map(params![session_id], |row| row_to_routine(row, 0))?;
        rows.collect()
    })
}

pub fn list(store: &Store) -> Result<Vec<ScheduledRoutine>, String> {
    store.with(|conn| {
        let sql = format!(
            "SELECT {ROUTINE_COLUMNS}, {SESSION_COLUMNS}, COALESCE(s.worktree, w.path)
             FROM routines r
             JOIN sessions s ON s.id = r.session_id
             JOIN workspaces w ON w.id = s.workspace_id
             ORDER BY r.created_at"
        );
        let mut stmt = conn.prepare_cached(&sql)?;
        let rows = stmt.query_map([], |row| {
            let routine = row_to_routine(row, 0)?;
            let session = row_to_session(row, ROUTINE_COLUMN_COUNT)?;
            let cwd: String = row.get(ROUTINE_COLUMN_COUNT + SESSION_COLUMN_COUNT)?;
            Ok(ScheduledRoutine {
                routine,
                session,
                cwd,
            })
        })?;
        rows.collect()
    })
}

/// The one row the scheduler needs to fire a routine on demand.
pub fn scheduled(store: &Store, id: String) -> Result<Option<ScheduledRoutine>, String> {
    store.with(|conn| {
        let sql = format!(
            "SELECT {ROUTINE_COLUMNS}, {SESSION_COLUMNS}, COALESCE(s.worktree, w.path)
             FROM routines r
             JOIN sessions s ON s.id = r.session_id
             JOIN workspaces w ON w.id = s.workspace_id
             WHERE r.id = ?1"
        );
        conn.prepare_cached(&sql)?
            .query_row(params![id], |row| {
                Ok(ScheduledRoutine {
                    routine: row_to_routine(row, 0)?,
                    session: row_to_session(row, ROUTINE_COLUMN_COUNT)?,
                    cwd: row.get(ROUTINE_COLUMN_COUNT + SESSION_COLUMN_COUNT)?,
                })
            })
            .optional()
    })
}

#[allow(clippy::too_many_arguments)]
pub fn upsert(
    store: &Store,
    id: Option<String>,
    session_id: String,
    name: String,
    enabled: bool,
    prompt: String,
    schedule: String,
    next_run_at: Option<i64>,
    created_by: Option<String>,
) -> Result<Routine, String> {
    let now = now_millis();
    let id = id.unwrap_or_else(|| uuid::Uuid::new_v4().to_string());
    store.with(|conn| {
        conn.execute(
            "INSERT INTO routines
               (id, session_id, name, enabled, prompt, schedule, next_run_at, created_by, created_at, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?9, ?8, ?8)
             ON CONFLICT(id) DO UPDATE SET
               name = excluded.name, enabled = excluded.enabled, prompt = excluded.prompt,
               schedule = excluded.schedule, next_run_at = excluded.next_run_at,
               created_by = COALESCE(routines.created_by, excluded.created_by),
               updated_at = excluded.updated_at",
            params![id, session_id, name, enabled, prompt, schedule, next_run_at, now, created_by],
        )?;
        conn.prepare_cached(&format!("SELECT {ROUTINE_COLUMNS} FROM routines r WHERE r.id = ?1"))?
            .query_row(params![id], |row| row_to_routine(row, 0))
    })
}

pub fn delete(store: &Store, id: String) -> Result<(), String> {
    store.with(|conn| conn.execute("DELETE FROM routines WHERE id = ?1", params![id]))?;
    Ok(())
}

/// The clock the scheduler moves when a routine comes due, with the run that
/// moved it. `last_run_at` stays put on a skip: nothing ran.
///
/// Read-modify-write under the store's lock, because the history is a column
/// and two writers with a stale copy of it lose each other's lines.
pub fn record_run(
    store: &Store,
    id: &str,
    last_run_at: Option<i64>,
    next_run_at: Option<i64>,
    run: &RoutineRun,
) -> Result<(), String> {
    store.with(|conn| {
        let runs = read_runs(conn, id)?;
        conn.prepare_cached(
            "UPDATE routines
             SET last_run_at = COALESCE(?2, last_run_at), next_run_at = ?3,
                 runs_json = ?4, updated_at = ?5
             WHERE id = ?1",
        )?
        .execute(params![
            id,
            last_run_at,
            next_run_at,
            runs_json(&push_run(&runs, run.clone())),
            now_millis()
        ])
    })?;
    Ok(())
}

/// The end of a run, and nothing else. A turn can outlast the schedule that
/// started it: the user edits the routine while it works, and the row they
/// saved is the one that stands.
///
/// In place, not pushed: a run that started before the ones below it does not
/// become the newest by finishing last, and one that has already aged off the
/// end of the history does not come back.
pub fn finish_run(store: &Store, id: &str, run: &RoutineRun) -> Result<(), String> {
    store.with(|conn| {
        let runs: Vec<RoutineRun> = read_runs(conn, id)?
            .into_iter()
            .map(|row| if row.id == run.id { run.clone() } else { row })
            .collect();
        conn.prepare_cached("UPDATE routines SET runs_json = ?2 WHERE id = ?1")?
            .execute(params![id, runs_json(&runs)])
    })?;
    Ok(())
}

fn read_runs(conn: &rusqlite::Connection, id: &str) -> rusqlite::Result<Vec<RoutineRun>> {
    let raw: String = conn
        .prepare_cached("SELECT runs_json FROM routines WHERE id = ?1")?
        .query_row(params![id], |row| row.get(0))
        .optional()?
        .unwrap_or_else(|| "[]".into());
    Ok(parse_runs(&raw))
}

/// Newest first, capped, so the JSON column never grows past a screen of history.
pub const MAX_RUNS: usize = 20;

/// `Skipped`: it came due while the agent was still working on something else.
#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum RunStatus {
    Running,
    Ok,
    Error,
    Skipped,
}

#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum RunTrigger {
    Schedule,
    Manual,
}

/// One line of `runs_json`. The routines screen parses that column straight
/// out of the row, so these names are the ones it reads.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct RoutineRun {
    pub id: String,
    pub started_at: i64,
    pub finished_at: Option<i64>,
    pub status: RunStatus,
    pub trigger: RunTrigger,
}

/// A line the daemon cannot read is a line it drops, never a history it loses.
pub fn parse_runs(raw: &str) -> Vec<RoutineRun> {
    serde_json::from_str::<Vec<serde_json::Value>>(raw)
        .unwrap_or_default()
        .into_iter()
        .filter_map(|item| serde_json::from_value(item).ok())
        .collect()
}

pub fn push_run(runs: &[RoutineRun], run: RoutineRun) -> Vec<RoutineRun> {
    let mut out: Vec<RoutineRun> = runs.iter().filter(|row| row.id != run.id).cloned().collect();
    out.insert(0, run);
    out.truncate(MAX_RUNS);
    out
}

pub fn runs_json(runs: &[RoutineRun]) -> String {
    serde_json::to_string(runs).unwrap_or_else(|_| "[]".into())
}

/// The hidden turn that wakes the agent. It says who is talking so the reply
/// does not read the schedule back, and it allows silence: a routine that
/// found nothing should say nothing.
pub fn wake_prompt(
    name: &str,
    schedule: &Schedule,
    trigger: RunTrigger,
    prompt: &str,
    by: Option<&str>,
) -> String {
    let when = match schedule {
        Schedule::Cron { expression } => format!("on the cron schedule {expression}"),
        _ => {
            let described = describe_schedule(schedule);
            match described.strip_prefix("Every") {
                Some(rest) => format!("every{rest}"),
                None => described,
            }
        }
    };
    let cue = match trigger {
        RunTrigger::Manual => format!(
            "[routine] \"{name}\" was run on demand. The user pressed Run now in the app; it normally runs {when}."
        ),
        RunTrigger::Schedule => {
            let whose = match by {
                Some(by) => format!("a standing order {by} set up for you"),
                None => "your own standing order".into(),
            };
            format!(
                "[routine] \"{name}\" is due ({when}). This is {whose} firing on schedule, not a message the user just typed."
            )
        }
    };
    format!(
        "{cue}\nWhat you saved to do each time:\n{}\n\nCarry it out now. Report what matters in one short message. If nothing changed and the instruction does not ask for a report, end without filler.",
        prompt.trim()
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::schedule::Schedule;

    fn store() -> Store {
        let dir = std::env::temp_dir().join(format!("crew-routine-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).expect("dir");
        Store::open(dir.join("crew.sqlite3")).expect("store")
    }

    fn a_routine(store: &Store) -> Routine {
        let root = std::env::temp_dir().join(uuid::Uuid::new_v4().to_string());
        std::fs::create_dir_all(&root).expect("root");
        let workspace = crate::workspace::create(store, "w".into(), root.to_string_lossy().into())
            .expect("workspace");
        let agent = crate::session::create(
            store,
            workspace.id,
            "agent".into(),
            "Coder".into(),
            "claude".into(),
            "m".into(),
            "".into(),
            "ask".into(),
        )
        .expect("session");
        upsert(
            store,
            None,
            agent.id,
            "Standup".into(),
            true,
            "check the board".into(),
            Schedule::Interval { minutes: 30 }.to_json(),
            Some(1_000),
            None,
        )
        .expect("routine")
    }

    fn run(id: &str, status: RunStatus) -> RoutineRun {
        RoutineRun {
            id: id.into(),
            started_at: 1,
            finished_at: None,
            status,
            trigger: RunTrigger::Schedule,
        }
    }

    fn history(store: &Store, id: &str) -> Vec<RoutineRun> {
        parse_runs(&scheduled(store, id.to_string()).unwrap().unwrap().routine.runs_json)
    }

    /// The history is one column, and a writer holding a copy of it from before
    /// another writer's line would delete that line on the way out. Both of
    /// these read it back themselves.
    #[test]
    fn two_writers_do_not_lose_each_others_runs() {
        let store = store();
        let routine = a_routine(&store);

        record_run(&store, &routine.id, Some(1), Some(2), &run("a", RunStatus::Running)).unwrap();
        record_run(&store, &routine.id, None, Some(3), &run("b", RunStatus::Skipped)).unwrap();
        assert_eq!(history(&store, &routine.id).len(), 2, "the second write dropped the first");

        finish_run(&store, &routine.id, &run("a", RunStatus::Ok)).unwrap();

        let runs = history(&store, &routine.id);
        assert_eq!(runs.len(), 2, "a run was lost: {runs:?}");
        assert_eq!(runs.iter().find(|row| row.id == "a").map(|row| row.status), Some(RunStatus::Ok));
        assert_eq!(runs.iter().find(|row| row.id == "b").map(|row| row.status), Some(RunStatus::Skipped));
    }

    /// A long run that ends last is still the run that started first. Pushing
    /// it back on would put it above runs that began after it, and would
    /// resurrect one that had already aged off the end.
    #[test]
    fn finishing_a_run_leaves_it_where_it_started() {
        let store = store();
        let routine = a_routine(&store);
        record_run(&store, &routine.id, Some(1), Some(2), &run("long", RunStatus::Running)).unwrap();
        record_run(&store, &routine.id, None, Some(2), &run("later", RunStatus::Ok)).unwrap();

        finish_run(&store, &routine.id, &run("long", RunStatus::Ok)).unwrap();

        let runs = history(&store, &routine.id);
        let ids: Vec<&str> = runs.iter().map(|row| row.id.as_str()).collect();
        assert_eq!(ids, vec!["later", "long"], "the finished run jumped the queue");
        assert_eq!(runs[1].status, RunStatus::Ok, "it did not close where it was");
    }

    #[test]
    fn a_run_that_has_already_aged_off_the_history_does_not_come_back() {
        let store = store();
        let routine = a_routine(&store);
        record_run(&store, &routine.id, None, Some(1), &run("ancient", RunStatus::Running)).unwrap();
        for i in 0..MAX_RUNS {
            record_run(&store, &routine.id, None, Some(1), &run(&format!("r{i}"), RunStatus::Ok)).unwrap();
        }

        finish_run(&store, &routine.id, &run("ancient", RunStatus::Ok)).unwrap();

        let runs = history(&store, &routine.id);
        assert_eq!(runs.len(), MAX_RUNS);
        assert!(!runs.iter().any(|row| row.id == "ancient"), "a run came back from the dead");
    }

    /// A turn can outlast the row that started it. What the user saved while it
    /// ran is the row that stands.
    #[test]
    fn finishing_a_run_leaves_the_schedule_alone() {
        let store = store();
        let routine = a_routine(&store);
        record_run(&store, &routine.id, Some(1), Some(2), &run("a", RunStatus::Running)).unwrap();

        finish_run(&store, &routine.id, &run("a", RunStatus::Ok)).unwrap();

        let after = scheduled(&store, routine.id.clone()).unwrap().unwrap().routine;
        assert_eq!(after.next_run_at, Some(2));
        assert_eq!(after.last_run_at, Some(1));
    }

    /// A skip moves the clock — otherwise the routine stays past due and fires
    /// again at once — but it is not a run, so it is not the last one.
    #[test]
    fn a_run_that_did_not_happen_does_not_become_the_last_one() {
        let store = store();
        let routine = a_routine(&store);
        record_run(&store, &routine.id, Some(10), Some(20), &run("a", RunStatus::Ok)).unwrap();

        record_run(&store, &routine.id, None, Some(30), &run("b", RunStatus::Skipped)).unwrap();

        let after = scheduled(&store, routine.id.clone()).unwrap().unwrap().routine;
        assert_eq!(after.last_run_at, Some(10), "a skip claimed to be the last run");
        assert_eq!(after.next_run_at, Some(30), "a skip left the routine past due");
    }

    #[test]
    fn the_history_is_newest_first_and_capped() {
        let store = store();
        let routine = a_routine(&store);
        for i in 0..MAX_RUNS + 3 {
            record_run(&store, &routine.id, None, Some(1), &run(&format!("r{i}"), RunStatus::Ok)).unwrap();
        }

        let runs = history(&store, &routine.id);
        assert_eq!(runs.len(), MAX_RUNS);
        assert_eq!(runs[0].id, format!("r{}", MAX_RUNS + 2));
        assert!(!runs.iter().any(|row| row.id == "r0"), "the oldest run survived the cap");
    }

    /// A line the daemon cannot read is a line it drops, never a history it
    /// loses: the column holds whatever an older version of Crew wrote.
    #[test]
    fn a_line_that_cannot_be_read_does_not_take_the_others_with_it() {
        let runs = parse_runs(
            r#"[{"id":"a","startedAt":1,"finishedAt":null,"status":"ok","trigger":"schedule"},
                {"id":"b","status":"from the future"},
                {"id":"c","startedAt":2,"finishedAt":3,"status":"error","trigger":"manual"}]"#,
        );
        assert_eq!(runs.iter().map(|row| row.id.as_str()).collect::<Vec<_>>(), vec!["a", "c"]);
        assert!(parse_runs("not json").is_empty());
        assert!(parse_runs("{}").is_empty());
    }

    /// A routine fires where its agent works: the worktree when it has one,
    /// the workspace folder otherwise.
    #[test]
    fn a_routine_runs_in_its_agents_worktree() {
        let store = store();
        let routine = a_routine(&store);
        let before = scheduled(&store, routine.id.clone()).unwrap().unwrap();
        assert_eq!(before.cwd, crate::session::cwd(&store, &before.session).unwrap());
        store
            .with(|conn| {
                conn.execute(
                    "UPDATE sessions SET worktree = '/wt/feat' WHERE id = ?1",
                    params![routine.session_id],
                )
            })
            .unwrap();

        assert_eq!(scheduled(&store, routine.id.clone()).unwrap().unwrap().cwd, "/wt/feat");
        assert_eq!(list(&store).unwrap()[0].cwd, "/wt/feat");
    }

    #[test]
    fn a_routine_that_is_gone_is_not_an_error() {
        let store = store();
        assert!(scheduled(&store, "nobody".into()).unwrap().is_none());
    }
}
