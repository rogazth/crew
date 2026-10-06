//! `crew processes`: the table `list` prints, the line a lifecycle verb
//! answers with, `logs`, and the process definitions `add` and `edit` take.

use std::collections::BTreeMap;
use std::process::ExitCode;
use std::time::Duration;

use serde_json::{json, Map, Value};

use crate::args::{LogsArgs, ProcAdd, ProcEdit};
use crate::client::Client;
use crate::output::{self, Column};
use crate::{CliError, Ctx};

/// How long one wait for new output holds the bridge before `-f` asks again.
/// Under the 60 s the daemon caps a wait at, so an interrupt is never far off.
const FOLLOW_WAIT_S: u64 = 30;
/// Between reads when there is nothing to wait on: the process is not running,
/// or the daemon has no `wait_for_log`.
const FOLLOW_POLL: Duration = Duration::from_millis(750);

const PROCESS_COLUMNS: &[Column] = &[
    Column::new("NAME", &["name"]),
    Column::new("WORKTREE", &["worktree"]),
    Column::new("STATE", &["state", "status"]),
    Column::new("PID", &["pid"]),
    Column::new("UPTIME", &["uptime"]),
    Column::new("PORTS", &["ports"]),
    Column::new("EXIT", &["exitCode", "exit_code", "lastExitCode"]),
    Column::new("COMMAND", &["command"]),
];

pub fn ps(ctx: &Ctx) -> Result<ExitCode, CliError> {
    let reply = ctx.client()?.run("list_processes", json!({}))?;
    ctx.show(&reply, |value| {
        let rows = output::rows(value, &["processes"])?;
        if rows.is_empty() {
            return Some("No processes in this workspace. `crew processes add` defines one.".into());
        }
        let now = now_millis();
        let rows: Vec<Value> = rows.iter().flat_map(by_run).map(|row| with_uptime(&row, now)).collect();
        Some(output::table(&rows, PROCESS_COLUMNS).render(output::styled()))
    });
    Ok(ExitCode::SUCCESS)
}

/// A line per run of a process, its definition's fields beside each; one
/// that runs nowhere gets a line of its own, stopped or waiting to be approved.
fn by_run(row: &Value) -> Vec<Value> {
    let runs = row.get("runs").and_then(Value::as_array).cloned().unwrap_or_default();
    let mut base = row.clone();
    if let Some(object) = base.as_object_mut() {
        object.remove("runs");
    }
    if runs.is_empty() {
        let state = if row.get("pending_approval").is_some() { "pending-approval" } else { "stopped" };
        if let Some(object) = base.as_object_mut() {
            object.entry("state").or_insert(json!(state));
        }
        return vec![base];
    }
    runs.into_iter()
        .map(|run| {
            let mut line = base.clone();
            if let (Some(line), Some(run)) = (line.as_object_mut(), run.as_object()) {
                for (key, value) in run {
                    line.insert(key.clone(), value.clone());
                }
                if let Some(secs) = run.get("uptime_s") {
                    line.insert("uptime".into(), secs.clone());
                }
            }
            line
        })
        .collect()
}

/// A row with its uptime readable. The tool may say it in seconds, or only
/// say when the run started (milliseconds since the epoch); a process that is
/// not running has none either way.
fn with_uptime(row: &Value, now_ms: i64) -> Value {
    let mut row = row.clone();
    let running = matches!(
        row.get("state").or_else(|| row.get("status")).and_then(Value::as_str),
        Some("running" | "paused" | "starting")
    );
    let secs = match (row.get("uptime").and_then(Value::as_u64), row.get("startedAt").and_then(Value::as_i64)) {
        (Some(secs), _) => Some(secs),
        (None, Some(started)) if running => Some(((now_ms - started).max(0) / 1000) as u64),
        _ => None,
    };
    if let (Some(secs), Some(object)) = (secs, row.as_object_mut()) {
        object.insert("uptime".into(), json!(output::duration(secs)));
    }
    row
}

fn now_millis() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|elapsed| elapsed.as_millis() as i64)
        .unwrap_or(0)
}

/// `web  running  pid 4242`, from a process row: the run the verb acted on
/// (the reply marks it `here`), or the definition's own line if it has none.
pub fn summary(value: &Value) -> Option<String> {
    let name = value.get("name")?.as_str()?;
    let run = value
        .get("runs")
        .and_then(Value::as_array)
        .and_then(|runs| runs.iter().find(|run| run.get("here").is_some()))
        .unwrap_or(value);
    let fallback = if value.get("pending_approval").is_some() { "pending-approval" } else { "stopped" };
    let state = run.get("state").or_else(|| run.get("status")).and_then(Value::as_str).unwrap_or(fallback);
    let mut line = format!("{name}  {state}");
    if let Some(tree) = run.get("worktree").and_then(Value::as_str) {
        line.push_str(&format!("  {tree}"));
    }
    if let Some(pid) = run.get("pid").and_then(Value::as_u64) {
        line.push_str(&format!("  pid {pid}"));
    }
    if let Some(code) = run.get("exit_code").or_else(|| run.get("exitCode")).and_then(Value::as_i64) {
        line.push_str(&format!("  exit {code}"));
    }
    Some(line)
}

pub fn logs(ctx: &Ctx, args: &LogsArgs) -> Result<ExitCode, CliError> {
    let client = ctx.client()?;
    match &args.grep {
        Some(pattern) => grep(ctx, &client, args, pattern),
        None => tail(ctx, &client, args),
    }
}

/// The run a `logs` reads: the process, in the worktree named or the caller's.
fn target(args: &LogsArgs) -> Value {
    let mut target = json!({ "process": args.process });
    if let Some(worktree) = &args.worktree {
        target["worktree"] = json!(worktree);
    }
    target
}

/// `target` with more fields laid over it.
fn with(target: &Value, more: Value) -> Value {
    let mut out = target.clone();
    if let (Some(out), Some(more)) = (out.as_object_mut(), more.as_object()) {
        out.extend(more.clone());
    }
    out
}

fn tail(ctx: &Ctx, client: &Client, args: &LogsArgs) -> Result<ExitCode, CliError> {
    let mut request = target(args);
    if let Some(lines) = args.lines {
        request["tail"] = json!(lines);
    }
    let chunk = client.run("read_logs", request)?.value();
    let (text, cursor) = chunk_parts(&chunk)?;
    if ctx.global.json {
        json_out(&chunk, args.follow);
    } else {
        print_text(text);
    }
    if args.follow {
        follow(ctx, client, &target(args), cursor)?;
    }
    Ok(ExitCode::SUCCESS)
}

/// `tail -f` over the bridge. Reads from the cursor until there is nothing
/// new, then lets `wait_for_log` hold the call until a line arrives, so a
/// quiet process costs one request every half minute rather than a poll loop.
fn follow(ctx: &Ctx, client: &Client, target: &Value, mut cursor: u64) -> Result<(), CliError> {
    let mut can_wait = true;
    loop {
        let chunk = client.run("read_logs", with(target, json!({ "since": cursor })))?.value();
        let (text, next) = chunk_parts(&chunk)?;
        if let Some(skipped) = chunk.get("skipped").and_then(Value::as_u64).filter(|n| *n > 0) {
            eprintln!("crew: {skipped} bytes were rotated away before they could be read");
        }
        if next != cursor {
            if ctx.global.json {
                output::say(&chunk.to_string());
            } else {
                print_text(text);
            }
            cursor = next;
            continue;
        }
        if !can_wait {
            std::thread::sleep(FOLLOW_POLL);
            continue;
        }
        // An empty pattern matches the first line to arrive.
        let wait = with(target, json!({ "pattern": "", "since": cursor, "timeout_s": FOLLOW_WAIT_S }));
        let reply = client.tool("wait_for_log", wait)?;
        if reply.is_error {
            // A daemon without the tool still has read_logs; poll it.
            can_wait = false;
            continue;
        }
        if wait_kind(&reply.value()) == "ended" {
            // Nothing will arrive until someone starts it again, and the wait
            // would come straight back: poll until then.
            std::thread::sleep(FOLLOW_POLL);
        }
    }
}

fn grep(ctx: &Ctx, client: &Client, args: &LogsArgs, pattern: &str) -> Result<ExitCode, CliError> {
    let mut request = with(&target(args), json!({ "pattern": pattern }));
    if let Some(lines) = args.lines {
        request["max_matches"] = json!(lines);
    }
    if let Some(context) = args.context {
        request["context"] = json!(context);
    }
    let found = client.run("read_logs", request)?.value();
    if ctx.global.json {
        json_out(&found, args.follow);
    } else {
        let text = matches_text(&found, args.context.unwrap_or(0) > 0)
            .ok_or_else(|| CliError::Failed(format!("read_logs answered with something else: {found}")))?;
        if !text.is_empty() {
            output::say(&text);
        }
        let shown = found.get("matches").and_then(Value::as_array).map_or(0, Vec::len) as u64;
        if let Some(total) = found.get("total").and_then(Value::as_u64).filter(|total| *total > shown) {
            eprintln!("crew: the last {shown} of {total} matches; -n shows more");
        }
    }
    if !args.follow {
        return Ok(ExitCode::SUCCESS);
    }
    let mut cursor = found.get("cursor").and_then(Value::as_u64).unwrap_or(0);
    // Each wait blocks in the daemon until a matching line arrives, so only
    // matches cross the bridge.
    loop {
        let wait = with(&target(args), json!({ "pattern": pattern, "since": cursor, "timeout_s": FOLLOW_WAIT_S }));
        let result = client.run("wait_for_log", wait)?.value();
        let next = result
            .get("cursor")
            .and_then(Value::as_u64)
            .ok_or_else(|| CliError::Failed(format!("wait_for_log answered with something else: {result}")))?;
        match wait_kind(&result) {
            "matched" => {
                if ctx.global.json {
                    output::say(&result.to_string());
                } else if let Some(line) = result.get("line").and_then(Value::as_str) {
                    output::say(line);
                }
            }
            "ended" => std::thread::sleep(FOLLOW_POLL),
            _ => {}
        }
        cursor = next;
    }
}

/// Pretty for one answer; one object per line when following, so a reader
/// can take each as it comes.
fn json_out(value: &Value, following: bool) {
    if following {
        output::say(&value.to_string());
    } else {
        output::say_json(value);
    }
}

/// `matched`, `ended` or `timed-out`.
fn wait_kind(result: &Value) -> &str {
    result.get("result").and_then(Value::as_str).unwrap_or("")
}

fn chunk_parts(chunk: &Value) -> Result<(&str, u64), CliError> {
    match (chunk.get("text").and_then(Value::as_str), chunk.get("cursor").and_then(Value::as_u64)) {
        (Some(text), Some(cursor)) => Ok((text, cursor)),
        _ => Err(CliError::Failed(format!("read_logs answered with something else: {chunk}"))),
    }
}

/// Log text goes out as it is, without a newline added mid-line: the next
/// chunk may finish that line.
fn print_text(text: &str) {
    use std::io::Write;
    let mut out = std::io::stdout().lock();
    if out.write_all(text.as_bytes()).and_then(|_| out.flush()).is_err() {
        std::process::exit(0);
    }
}

/// Matches as grep prints them: context around each, `--` between groups.
fn matches_text(found: &Value, with_context: bool) -> Option<String> {
    let matches = found.get("matches")?.as_array()?;
    let lines = |value: Option<&Value>| -> Vec<String> {
        value
            .and_then(Value::as_array)
            .map(|lines| lines.iter().filter_map(Value::as_str).map(str::to_string).collect())
            .unwrap_or_default()
    };
    let groups: Vec<String> = matches
        .iter()
        .map(|found| {
            let mut group = lines(found.get("before"));
            group.push(found.get("line").and_then(Value::as_str).unwrap_or("").to_string());
            group.extend(lines(found.get("after")));
            group.join("\n")
        })
        .collect();
    Some(groups.join(if with_context { "\n--\n" } else { "\n" }))
}

pub fn add(ctx: &Ctx, add: ProcAdd) -> Result<ExitCode, CliError> {
    let ProcAdd { name, command, cwd, env, auto_restart } = add;
    let mut arguments = json!({
        "name": name,
        "command": command.join(" "),
    });
    // Only when asked: a process of that name already there is changed, and
    // a flag left off is no reason to turn its restarts off.
    if auto_restart {
        arguments["auto_restart"] = json!(true);
    }
    if let Some(cwd) = cwd {
        arguments["cwd"] = json!(cwd);
    }
    if !env.is_empty() {
        arguments["env"] = json!(parse_env(&env)?);
    }
    let reply = ctx.client()?.run("save_process", arguments)?;
    ctx.show(&reply, summary);
    Ok(ExitCode::SUCCESS)
}

pub fn edit(ctx: &Ctx, edit: ProcEdit) -> Result<ExitCode, CliError> {
    let ProcEdit { process, name, command, cwd, env, auto_restart } = edit;
    let mut changes = Map::new();
    let mut set = |key: &str, value: Option<Value>| {
        if let Some(value) = value {
            changes.insert(key.to_string(), value);
        }
    };
    set("name", name.map(Value::from));
    set("command", command.map(Value::from));
    set("cwd", cwd.map(Value::from));
    set("env", if env.is_empty() { None } else { Some(json!(parse_env(&env)?)) });
    set("auto_restart", auto_restart.map(Value::from));
    if changes.is_empty() {
        return Err(CliError::Usage("Nothing to change: name at least one of --name, --command, --cwd, --env, --auto-restart.".into()));
    }
    changes.insert("process".into(), json!(process));
    let reply = ctx.client()?.run("save_process", Value::Object(changes))?;
    ctx.show(&reply, summary);
    Ok(ExitCode::SUCCESS)
}

pub(crate) fn parse_env(pairs: &[String]) -> Result<BTreeMap<String, String>, CliError> {
    pairs
        .iter()
        .map(|pair| match pair.split_once('=') {
            Some((key, value)) if !key.is_empty() => Ok((key.to_string(), value.to_string())),
            _ => Err(CliError::Usage(format!("--env takes KEY=VALUE, not {pair}"))),
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn uptime_is_read_from_seconds_or_from_the_start() {
        let now = 10_000_000;
        let said = with_uptime(&json!({ "state": "running", "uptime": 90 }), now);
        assert_eq!(said["uptime"], "1m");
        let started = with_uptime(&json!({ "state": "running", "startedAt": now - 42_000 }), now);
        assert_eq!(started["uptime"], "42s");
        let stopped = with_uptime(&json!({ "state": "exited", "startedAt": now - 42_000 }), now);
        assert!(stopped.get("uptime").is_none(), "a stopped process has no uptime");
    }

    #[test]
    fn the_process_table_shows_what_the_tool_reports() {
        let rows = vec![
            with_uptime(&json!({ "name": "web", "state": "running", "pid": 7, "startedAt": 0, "command": "npm run dev", "exitCode": null }), 5_000),
            with_uptime(&json!({ "name": "db", "state": "exited", "pid": null, "command": "postgres", "exitCode": 1 }), 5_000),
        ];
        let table = output::table(&rows, PROCESS_COLUMNS).render(false);
        assert_eq!(
            table,
            "NAME  STATE    PID  UPTIME  EXIT  COMMAND\n\
             web   running  7    5s      -     npm run dev\n\
             db    exited   -    -       1     postgres"
        );
    }

    #[test]
    fn a_process_is_summed_up_in_a_line() {
        assert_eq!(summary(&json!({ "name": "web", "state": "running", "pid": 42 })).as_deref(), Some("web  running  pid 42"));
        assert_eq!(summary(&json!({ "name": "db", "state": "exited", "exitCode": 1 })).as_deref(), Some("db  exited  exit 1"));
        assert_eq!(summary(&json!("Stopped web.")), None);
    }

    #[test]
    fn matches_print_like_grep() {
        let found = json!({
            "matches": [
                { "offset": 0, "line": "error one", "before": ["a"], "after": ["b"] },
                { "offset": 9, "line": "error two", "before": [], "after": [] }
            ],
            "total": 2,
            "cursor": 20
        });
        assert_eq!(matches_text(&found, true).as_deref(), Some("a\nerror one\nb\n--\nerror two"));
        assert_eq!(matches_text(&json!({ "matches": [{ "line": "x" }, { "line": "y" }] }), false).as_deref(), Some("x\ny"));
        assert_eq!(matches_text(&json!("nope"), false), None);
    }

    #[test]
    fn a_log_chunk_needs_its_text_and_cursor() {
        let chunk = json!({ "text": "hi\n", "start": 0, "cursor": 3, "skipped": 0 });
        assert_eq!(chunk_parts(&chunk).expect("chunk"), ("hi\n", 3));
        assert!(chunk_parts(&json!({ "text": "hi" })).is_err());
    }

    #[test]
    fn env_pairs_split_at_the_first_equals() {
        let env = parse_env(&["A=1".into(), "B=x=y".into(), "C=".into()]).expect("env");
        assert_eq!(env["A"], "1");
        assert_eq!(env["B"], "x=y");
        assert_eq!(env["C"], "");
        assert!(parse_env(&["=1".into()]).is_err());
        assert!(parse_env(&["nokey".into()]).is_err());
    }
}
