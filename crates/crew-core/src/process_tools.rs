//! The process manager as MCP tools: a thin layer over [`ProcessHost`] that
//! reads arguments, scopes every call to the caller's workspace and says who
//! is asking.
//!
//! Watching is polling: MCP is request and response, and not every provider
//! takes notifications. `read_logs` hands back a cursor to continue from, and
//! `wait_for_log` blocks up to a minute; the shim gives a call that carries
//! `timeout_s` that long plus ten seconds.

use std::collections::BTreeMap;

use crew_protocol::{LogWait, Process, ProcessRun, ProcessSpec, ProcessState};
use serde_json::{json, Value};

use crate::caller::Caller;
use crate::process::{ProcessHost, ProcessPatch, RunRequest, WAIT_MAX_S};
use crate::session;
use crate::store::{now_millis, Store};
use crate::tools::{cli, Audience, CliVerb, Tool, ToolFamily, ToolOutput};

pub struct ProcessTools {
    host: ProcessHost,
    /// For naming whoever created a process.
    store: Store,
    /// For waking a bot parent with a process its child proposed.
    turns: Option<crate::turns::TurnHost>,
}

impl ProcessTools {
    pub fn new(host: ProcessHost, store: Store) -> Self {
        Self { host, store, turns: None }
    }

    /// With the turn host: a process a child proposes under ask autonomy
    /// wakes its bot parent, which may decide it.
    pub fn with_turns(mut self, turns: crate::turns::TurnHost) -> Self {
        self.turns = Some(turns);
        self
    }
}

/// `process` in every schema: the model has whichever it saw last.
fn process_arg() -> Value {
    json!({ "type": "string", "description": "The process's id or its name, from list_processes." })
}

/// `worktree` beside `process` wherever a run is meant.
fn worktree_arg() -> Value {
    json!({ "type": "string", "description": "The worktree's path, as list_processes shows it. Omit for the one you work in (the main checkout if you are not in a worktree)." })
}

fn run_env_arg() -> Value {
    json!({ "type": "object", "additionalProperties": { "type": "string" }, "description": "Over the command's own env, for this run only, e.g. {\"PORT\": \"3001\"} so two worktrees do not share a port; a command that reads $PORT picks it up. With autonomy ask, only names the command's env already has." })
}

/// The same rule wherever an agent may be deciding how to run something.
const KEEPS_RUNNING: &str = "For anything that keeps running (dev servers, watchers, workers) use control_process with action start instead of backgrounding it in your shell: the user sees it and can stop it, and it does not die with your session. Builds, tests and other commands that finish run in your shell as usual.";

/// What `control_process` does, by its `action`.
const ACTIONS: [&str; 5] = ["start", "stop", "restart", "pause", "resume"];

fn spec_properties() -> Value {
    json!({
        "name": { "type": "string", "description": "Unique in this workspace, e.g. \"web\" or \"api\". With process, renames it." },
        "command": { "type": "string", "description": "Run by the user's shell, so pipes, && and globs work as typed, e.g. \"npm run dev\". Required to create one." },
        "cwd": { "type": "string", "description": "Relative to the worktree it runs in, e.g. \"server\". Empty is its root." },
        "env": { "type": "object", "additionalProperties": { "type": "string" }, "description": "Extra environment variables, e.g. {\"PORT\": \"3000\"}: a start can override the ones named here for its run." },
        "auto_restart": { "type": "boolean", "description": "Restart it when it exits on its own, backing off from 1 s to 30 s; five crashes in two minutes leave it crashed." }
    })
}

/// `crew processes <action> <process>`, one per action of `control_process`.
fn control_verbs() -> Vec<CliVerb> {
    vec![
        cli("processes", "start").sets("action", "start").about("Start a process in your worktree (or the one you name).").pos(&["process"]).flags(&["worktree", "env"]).eg("crew processes start web\n  crew processes start web --worktree ../app-feat --env PORT=3001"),
        cli("processes", "stop").sets("action", "stop").about("Stop a process's run: SIGTERM to its group, SIGKILL after 5 s.").pos(&["process"]).flags(&["worktree"]).eg("crew processes stop web"),
        cli("processes", "restart").sets("action", "restart").about("Stop a process's run and start it again.").pos(&["process"]).flags(&["worktree", "env"]).eg("crew processes restart web"),
        cli("processes", "pause").sets("action", "pause").about("Freeze a running process (SIGSTOP).").pos(&["process"]).flags(&["worktree"]).eg("crew processes pause worker"),
        cli("processes", "resume").sets("action", "resume").about("Continue a paused process (SIGCONT).").pos(&["process"]).flags(&["worktree"]).eg("crew processes resume worker"),
    ]
}

/// The process tools. They need no host to be described, so the CLI builds
/// its commands from the same list the daemon runs.
pub fn catalog() -> Vec<Tool> {
    let mut save = spec_properties();
    save["process"] = json!({ "type": "string", "description": "An existing process's id or name, to change it (and rename it with name). Omit to create one, or to change the one called name." });
    vec![
        Tool {
            name: "list_processes",
            description: "List this workspace's processes: the dev servers, watchers and workers the user defined once for the workspace, each run in a terminal of its own with its output logged. A process runs in a worktree, at most once in each: runs lists where it is running or last ran, with its state (starting, running, paused, exited, crashed, stopped), pid, uptime, last exit code, automatic restarts, who started it and its own env; here marks the run in your worktree. log_cursor is where that run's log ends right now: pass it as since to read_logs or wait_for_log to see only what comes after. A process not yet approved by the user cannot start.",
            schema: json!({ "type": "object", "properties": {} }),
            audience: Audience::EVERYONE,
            cli: vec![cli("processes", "list").alias(&["ls"]).eg("crew processes list\n  crew processes list --json | jq '.[].name'")],
        },
        Tool {
            name: "control_process",
            description: concat!(
                "Start, stop, restart, pause or resume a process's run in your worktree (or the one you name). ",
                "start returns once it is running (already running there, it is left alone); follow with wait_for_log for its ready line, which without since reads the run from its first line. Two worktrees running the same server clash on its port: pass env, e.g. {\"PORT\": \"3001\"}. A process not yet approved by the user cannot start: only the user can approve it, in Crew. ",
                "stop sends SIGTERM to its process group, SIGKILL after 5 s, and returns once it has exited. restart stops and starts it, keeping the last run's env unless you pass env. pause freezes it (SIGSTOP), keeping its memory and ports; resume continues it. ",
                "For anything that keeps running (dev servers, watchers, workers) use this instead of backgrounding it in your shell: the user sees it and can stop it, and it does not die with your session. Builds, tests and other commands that finish run in your shell as usual."
            ),
            schema: json!({
                "type": "object",
                "properties": {
                    "process": process_arg(),
                    "action": { "type": "string", "enum": ACTIONS },
                    "worktree": worktree_arg(),
                    "env": run_env_arg()
                },
                "required": ["process", "action"]
            }),
            audience: Audience::EVERYONE,
            cli: control_verbs(),
        },
        Tool {
            name: "save_process",
            description: "Define a process for this workspace, or change one: a shell command Crew keeps running in a terminal of its own, with its output logged, in whichever worktree it is started. Without process, name picks it: an existing one is changed, otherwise one is created (command required). Only the fields you pass change, for every worktree; a running process picks a change up on its next restart. Saving does not start it: control_process does. If your autonomy is ask, a new process waits for the user's approval in Crew before it can start, and a change waits as a proposal while the accepted definition keeps running; tell the user it is waiting for them. Check list_processes first: the one you need may be there already.",
            schema: json!({ "type": "object", "properties": save }),
            audience: Audience::EVERYONE,
            cli: vec![
                cli("processes", "add").about("Define a process for this workspace (or change the one of that name).").eg("crew processes add web npm run dev\n  crew processes add api --cwd server --env PORT=4000 --auto-restart -- cargo run"),
                cli("processes", "edit").about("Change a process's definition: only what you pass.").eg("crew processes edit web --command 'npm run dev -- --port 3001'\n  crew processes edit web --auto-restart true"),
            ],
        },
        Tool {
            name: "delete_process",
            description: "Delete a process from the workspace: stop it in every worktree it runs in, and remove its definition and all its logs. With autonomy ask you can only delete the processes you created.",
            schema: json!({
                "type": "object",
                "properties": { "process": process_arg(), "worktree": worktree_arg() },
                "required": ["process"]
            }),
            audience: Audience::EVERYONE,
            cli: vec![cli("processes", "rm").pos(&["process"]).eg("crew processes rm web")],
        },
        Tool {
            name: "read_logs",
            description: "Read a process's output in your worktree (or the one you name) as plain text, colours and escapes stripped. Without since: its last tail lines (200 by default). With since: what was written from that cursor on, up to max_bytes (16 KB by default, 256 KB at most); a cursor short of log_cursor means there is more, so call again. Either way the answer's cursor is where this read ended: pass it back as since and you get only what is new. skipped above zero means log rotation dropped that many bytes after since. With pattern (a regex) it searches the whole log still on disk instead: the latest max_matches matching lines (20 by default), oldest first, each with context lines either side (up to 10); total counts every match. Crew's own [crew] lines are never matched.",
            schema: json!({
                "type": "object",
                "properties": {
                    "process": process_arg(),
                    "worktree": worktree_arg(),
                    "tail": { "type": "integer", "minimum": 1, "maximum": 5000, "description": "Lines from the end, when since is not given. Not with pattern." },
                    "since": { "type": "integer", "minimum": 0, "description": "A cursor from an earlier call, or a run's log_cursor from list_processes. Not with pattern." },
                    "max_bytes": { "type": "integer", "minimum": 1, "maximum": 262144, "description": "Not with pattern." },
                    "pattern": { "type": "string", "description": "A regex to search for instead of reading, e.g. \"(?i)error|warn\"." },
                    "context": { "type": "integer", "minimum": 0, "maximum": 10, "description": "With pattern: lines either side of each match." },
                    "max_matches": { "type": "integer", "minimum": 1, "maximum": 200, "description": "With pattern: how many of the latest matches." }
                },
                "required": ["process"]
            }),
            audience: Audience::EVERYONE,
            cli: vec![cli("processes", "logs").eg(
                "crew processes logs web                 the last lines\n  crew processes logs web -n 500\n  crew processes logs web -f              follow, like tail -f\n  crew processes logs web --grep 'error|panic' -C 2\n  crew processes logs web -f --grep ready print each matching line as it arrives",
            )],
        },
        Tool {
            name: "wait_for_log",
            description: "Block until a line of a process's log, in your worktree or the one you name, matches a regex, the process stops or exits, or timeout_s passes (at most 60). Without since it searches the current run from its first line, so a start or restart followed by this sees the whole boot, even a line printed before the call. With since, only what comes after that cursor. Answers with result matched (the line, and the cursor after it), ended (the state and exit code: nothing more is coming) or timed-out. To wait longer than a minute, call again with since set to the cursor it returned.",
            schema: json!({
                "type": "object",
                "properties": {
                    "process": process_arg(),
                    "worktree": worktree_arg(),
                    "pattern": { "type": "string", "description": "A regex, e.g. \"ready|listening on\"." },
                    "since": { "type": "integer", "minimum": 0, "description": "A cursor from an earlier call. Omit to search the current run from its start." },
                    "timeout_s": { "type": "integer", "minimum": 1, "maximum": WAIT_MAX_S, "description": "Seconds to wait, at most 60." }
                },
                "required": ["process", "pattern", "timeout_s"]
            }),
            audience: Audience::EVERYONE,
            cli: vec![cli("processes", "wait").pos(&["process", "pattern"]).eg("crew processes wait web 'ready|listening' --timeout-s 30")],
        },
        Tool {
            name: "send_input",
            description: "Type into a running process's terminal, in your worktree or the one you name, as if at its keyboard: an interactive key (vite's r to restart, q to quit) or an answer to a prompt. Sent exactly as given, so add \\r to press Enter. Needs full autonomy: with autonomy ask it is refused, since whatever the process reads it may run.",
            schema: json!({
                "type": "object",
                "properties": {
                    "process": process_arg(),
                    "worktree": worktree_arg(),
                    "text": { "type": "string" }
                },
                "required": ["process", "text"]
            }),
            audience: Audience::EVERYONE,
            cli: vec![cli("processes", "input").rest(&["process", "text"]).eg("crew processes input web r\n  printf 'y\\r' | crew processes input setup -")],
        },
    ]
}

impl ToolFamily for ProcessTools {
    fn catalog(&self) -> Vec<Tool> {
        catalog()
    }

    fn instructions(&self, caller: &Caller) -> Option<String> {
        Some(match self.inventory(caller) {
            Some(inventory) => format!("{KEEPS_RUNNING}\n{inventory}"),
            None => KEEPS_RUNNING.to_string(),
        })
    }

    fn run(&self, caller: &Caller, name: &str, args: &Value) -> Result<ToolOutput, String> {
        let workspace = caller.workspace_id()?;
        let host = &self.host;
        // Where a run is meant: the one named, or the caller's own.
        let named = string(args, "worktree")?.filter(|path| !path.trim().is_empty());
        let worktree = named.as_deref().or_else(|| caller.worktree());
        // A reply marks the run it acted on; a listing, the caller's own.
        let here = |process: &Process| self.row(process, worktree);
        let out = match name {
            "list_processes" => Value::Array(host.list(workspace)?.iter().map(here).collect()),
            "control_process" => {
                let target = process(args)?;
                let action = string(args, "action")?.ok_or_else(|| {
                    format!("action is required: one of {}", ACTIONS.join(", "))
                })?;
                let env = env(args)?;
                match action.as_str() {
                    "start" | "restart" => {
                        if let Some(env) = &env {
                            self.may_set_env(caller, workspace, &target, env)?;
                        }
                        let request = RunRequest {
                            worktree: worktree.map(str::to_string),
                            env,
                            started_by: caller.session_id().map(str::to_string),
                        };
                        let started = if action == "start" {
                            host.start(workspace, &target, request)?
                        } else {
                            host.restart(workspace, &target, request)?
                        };
                        here(&started)
                    }
                    "stop" | "pause" | "resume" if env.is_some() => {
                        return Err(format!("env is for start and restart, not {action}"));
                    }
                    "stop" => here(&host.stop(workspace, &target, worktree)?),
                    "pause" => here(&host.pause(workspace, &target, worktree)?),
                    "resume" => here(&host.resume(workspace, &target, worktree)?),
                    other => return Err(format!("action is one of {}, not {other}", ACTIONS.join(", "))),
                }
            }
            "save_process" => {
                let saved = self.save(caller, workspace, args)?;
                let mut row = here(&saved);
                let waits = !saved.approved || saved.proposed.is_some();
                if let (Caller::Child(me), Some(turns), true, false) = (caller, &self.turns, waits, caller.full_autonomy()) {
                    if turns.process_proposed(me, &saved) {
                        row["pending_approval"] = json!(format!(
                            "Waiting for approval: {} decides it, or the user in Crew.",
                            me.parent_id.as_deref().map(|id| self.who(Some(id))).unwrap_or_else(|| "whoever started you".into())
                        ));
                    }
                }
                row
            }
            "delete_process" => {
                let target = process(args)?;
                // Deleting throws away a definition and its logs with no
                // proposal to review, so an ask caller only gets to undo its own.
                if !caller.full_autonomy() {
                    let row = host.get(workspace, &target)?;
                    if row.created_by.as_deref() != caller.session_id() {
                        return Err(format!(
                            "\"{target}\" was not created by you; with autonomy ask you can only delete your own processes. Ask the user to delete it."
                        ));
                    }
                }
                host.delete(workspace, &target)?;
                json!(format!("Deleted \"{target}\"."))
            }
            "read_logs" => match string(args, "pattern")? {
                None => {
                    if let Some(key) = ["context", "max_matches"].into_iter().find(|key| args.get(*key).is_some_and(|v| !v.is_null())) {
                        return Err(format!("{key} goes with pattern: it shapes a search, not a read"));
                    }
                    let chunk = host.read_logs(
                        workspace,
                        &process(args)?,
                        worktree,
                        number(args, "tail")?.map(clamp_u32),
                        number(args, "since")?,
                        number(args, "max_bytes")?.map(clamp_u32),
                    )?;
                    json!({ "text": chunk.text, "cursor": chunk.cursor, "start": chunk.start, "skipped": chunk.skipped })
                }
                Some(pattern) => {
                    if let Some(key) = ["tail", "since", "max_bytes"].into_iter().find(|key| args.get(*key).is_some_and(|v| !v.is_null())) {
                        return Err(format!(
                            "{key} is for reading, and pattern searches the whole log: drop one (max_matches and context shape a search)"
                        ));
                    }
                    let grep = host.grep_logs(
                        workspace,
                        &process(args)?,
                        worktree,
                        &pattern,
                        number(args, "context")?.map(clamp_u32),
                        number(args, "max_matches")?.map(clamp_u32),
                    )?;
                    json!({
                        "matches": grep.matches.iter().map(|m| json!({
                            "offset": m.offset,
                            "line": m.line,
                            "before": m.before,
                            "after": m.after
                        })).collect::<Vec<_>>(),
                        "total": grep.total,
                        "cursor": grep.cursor
                    })
                }
            },
            "wait_for_log" => {
                let pattern = string(args, "pattern")?.ok_or("pattern is required")?;
                let timeout = wait_seconds(args)?;
                let waited =
                    host.wait_for_log(workspace, &process(args)?, worktree, &pattern, number(args, "since")?, timeout)?;
                describe_wait(waited, timeout)
            }
            "send_input" => {
                let target = process(args)?;
                // Keys typed into a process run with its powers: a REPL or a
                // shell takes `os.system(...)` as readily as `r`. That is
                // running a command no one reviewed, which ask does not allow.
                if !caller.full_autonomy() {
                    return Err(format!(
                        "With autonomy ask you cannot type into \"{target}\": what it reads, it runs. Ask the user to type it in Crew, or to give you full autonomy."
                    ));
                }
                let text = string(args, "text")?.filter(|text| !text.is_empty()).ok_or("text is required")?;
                host.send_input(workspace, &target, worktree, &text)?;
                json!(format!("Sent {} bytes to \"{target}\".", text.len()))
            }
            _ => return Err(format!("Unknown tool \"{name}\"")),
        };
        Ok(out.into())
    }
}

impl ProcessTools {
    /// `save_process`: change the process `process` names, or the one called
    /// `name`; with neither found, create it. Under ask, a creation waits for
    /// approval and a change is a proposal, as the host decides with `ask`.
    fn save(&self, caller: &Caller, workspace: &str, args: &Value) -> Result<Process, String> {
        let host = &self.host;
        let named = string(args, "process")?.map(|name| name.trim().to_string()).filter(|name| !name.is_empty());
        let name = string(args, "name")?.map(|name| name.trim().to_string()).filter(|name| !name.is_empty());
        let by = caller.session_id().map(str::to_string);
        let ask = !caller.full_autonomy();
        let existing = match (&named, &name) {
            (Some(key), _) => Some(host.get(workspace, key).map_err(|error| {
                format!("{error} To create a process, leave out process and pass name and command.")
            })?),
            (None, Some(key)) => host.get(workspace, key).ok(),
            (None, None) => return Err("name is required to create a process, or process to change one".into()),
        };
        match existing {
            Some(found) => {
                let patch = ProcessPatch {
                    // Keyed by name, the name is not a change.
                    name: if named.is_some() { name } else { None },
                    command: string(args, "command")?,
                    cwd: string(args, "cwd")?,
                    env: env(args)?,
                    auto_restart: flag(args, "auto_restart")?,
                };
                host.update(workspace, &found.id, patch, by, ask)
            }
            None => {
                let spec = ProcessSpec {
                    name: name.unwrap_or_default(),
                    command: string(args, "command")?
                        .filter(|command| !command.trim().is_empty())
                        .ok_or("command is required to create a process; to change one, name it with process")?,
                    cwd: string(args, "cwd")?.unwrap_or_default(),
                    env: env(args)?.unwrap_or_default(),
                    auto_restart: flag(args, "auto_restart")?.unwrap_or(false),
                };
                host.create(workspace, spec, by, ask)
            }
        }
    }

    /// A process as the model reads it: what it runs, where it runs and how
    /// each run stands, and anything the user still has to say about it.
    /// `mine` is the caller's worktree, for marking its run.
    fn row(&self, process: &Process, mine: Option<&str>) -> Value {
        let mut row = json!({
            "id": process.id,
            "name": process.spec.name,
            "command": process.spec.command,
            "auto_restart": process.spec.auto_restart,
            "created_by": self.who(process.created_by.as_deref()),
            "runs": process.runs.iter().map(|run| self.run_row(run, mine)).collect::<Vec<_>>()
        });
        if !process.spec.cwd.is_empty() {
            row["cwd"] = json!(process.spec.cwd);
        }
        if !process.spec.env.is_empty() {
            row["env"] = json!(process.spec.env);
        }
        if !process.approved {
            row["pending_approval"] = json!(format!(
                "Created by {} and waiting for the user to approve it in Crew; it cannot start until then.",
                self.who(process.requested_by.as_deref().or(process.created_by.as_deref()))
            ));
        } else if let Some(proposed) = &process.proposed {
            row["pending_approval"] = json!(format!(
                "A change by {} waits for the user's approval in Crew; what runs meanwhile is the definition above.",
                self.who(process.requested_by.as_deref())
            ));
            row["proposed"] = json!({
                "name": proposed.name,
                "command": proposed.command,
                "cwd": proposed.cwd,
                "env": proposed.env,
                "auto_restart": proposed.auto_restart
            });
        }
        row
    }

    fn run_row(&self, run: &ProcessRun, mine: Option<&str>) -> Value {
        let mut row = json!({
            "worktree": run.worktree.as_deref().unwrap_or("main checkout"),
            "state": run.state,
            "pid": run.pid,
            "exit_code": run.exit_code,
            "restarts": run.restarts,
            "started_by": self.who(run.started_by.as_deref()),
            "log_cursor": run.log_cursor
        });
        if run.worktree.as_deref() == mine {
            row["here"] = json!(true);
        }
        if !run.env.is_empty() {
            row["env"] = json!(run.env);
        }
        if matches!(run.state, ProcessState::Running | ProcessState::Paused) {
            if let Some(started) = run.started_at {
                row["uptime_s"] = json!((now_millis() - started).max(0) / 1000);
            }
        }
        row
    }

    /// An env for one run is a command no one reviewed, unless the command
    /// already names every variable in it: `NODE_OPTIONS` can run anything,
    /// a `PORT` the user put there cannot. Full autonomy may set any.
    fn may_set_env(
        &self,
        caller: &Caller,
        workspace: &str,
        process: &str,
        env: &BTreeMap<String, String>,
    ) -> Result<(), String> {
        if caller.full_autonomy() {
            return Ok(());
        }
        let declared = self.host.get(workspace, process)?.spec.env;
        let unknown: Vec<&str> = env.keys().filter(|key| !declared.contains_key(*key)).map(String::as_str).collect();
        if unknown.is_empty() {
            return Ok(());
        }
        Err(format!(
            "With autonomy ask you can only set the env names \"{process}\" already has ({}); {} is not one. Ask the user to add it to the process, or propose it with save_process.",
            if declared.is_empty() { "none".to_string() } else { declared.keys().cloned().collect::<Vec<_>>().join(", ") },
            unknown.join(", ")
        ))
    }

    /// The inventory in a line for `initialize`, marking what runs in the
    /// caller's worktree. Nothing when the workspace defines no process.
    fn inventory(&self, caller: &Caller) -> Option<String> {
        let workspace = caller.workspace_id().ok()?;
        let processes = self.host.list(workspace).ok()?;
        if processes.is_empty() {
            return None;
        }
        let mine = caller.worktree();
        let listed: Vec<String> = processes
            .iter()
            .map(|process| {
                let running = process
                    .run_in(mine)
                    .is_some_and(|run| matches!(run.state, ProcessState::Running | ProcessState::Starting | ProcessState::Paused));
                let note = if !process.approved {
                    ", waiting for approval"
                } else if running {
                    ", running here"
                } else {
                    ""
                };
                format!("{} ({}{note})", process.spec.name, process.spec.command)
            })
            .collect();
        Some(format!("Processes defined in this workspace: {}.", listed.join("; ")))
    }

    /// A session id as "Name (bot id)"; `None` is the user.
    fn who(&self, session_id: Option<&str>) -> String {
        let Some(id) = session_id else {
            return "the user".to_string();
        };
        match session::get(&self.store, id.to_string()) {
            Ok(Some(session)) => Caller::from_session(session).label(),
            _ => format!("a session since deleted ({id})"),
        }
    }
}

fn describe_wait(waited: LogWait, timeout: u32) -> Value {
    match waited {
        LogWait::Matched { offset, line, cursor } => {
            json!({ "result": "matched", "line": line, "offset": offset, "cursor": cursor })
        }
        LogWait::Ended { state, exit_code, cursor } => json!({
            "result": "ended",
            "state": state,
            "exit_code": exit_code,
            "cursor": cursor,
            "note": "The process is not running, so the line will not come. read_logs shows how it ended."
        }),
        LogWait::TimedOut { cursor } => json!({
            "result": "timed-out",
            "cursor": cursor,
            "note": format!("Nothing matched in {timeout}s. To keep waiting, call again with since = {cursor}.")
        }),
    }
}

/// `timeout_s`, held to what the shim waits for: at least a second, at most
/// [`WAIT_MAX_S`]. The name is the one the shim reads to stretch its own
/// timeout, so it must not change.
fn wait_seconds(args: &Value) -> Result<u32, String> {
    let raw = args.get("timeout_s").ok_or("timeout_s is required: how many seconds to wait, at most 60")?;
    let seconds = raw.as_f64().ok_or("timeout_s must be a number of seconds")?;
    Ok(seconds.ceil().clamp(1.0, f64::from(WAIT_MAX_S)) as u32)
}

fn process(args: &Value) -> Result<String, String> {
    string(args, "process")?
        .map(|name| name.trim().to_string())
        .filter(|name| !name.is_empty())
        .ok_or_else(|| "process is required: its id or its name, from list_processes".to_string())
}

fn string(args: &Value, key: &str) -> Result<Option<String>, String> {
    match args.get(key) {
        None | Some(Value::Null) => Ok(None),
        Some(Value::String(text)) => Ok(Some(text.clone())),
        Some(_) => Err(format!("{key} must be a string")),
    }
}

fn flag(args: &Value, key: &str) -> Result<Option<bool>, String> {
    match args.get(key) {
        None | Some(Value::Null) => Ok(None),
        Some(Value::Bool(value)) => Ok(Some(*value)),
        Some(_) => Err(format!("{key} must be true or false")),
    }
}

fn number(args: &Value, key: &str) -> Result<Option<u64>, String> {
    match args.get(key) {
        None | Some(Value::Null) => Ok(None),
        Some(value) => value
            .as_u64()
            .or_else(|| value.as_f64().filter(|n| *n >= 0.0).map(|n| n as u64))
            .map(Some)
            .ok_or_else(|| format!("{key} must be a whole number, zero or more")),
    }
}

fn clamp_u32(value: u64) -> u32 {
    value.min(u64::from(u32::MAX)) as u32
}

fn env(args: &Value) -> Result<Option<BTreeMap<String, String>>, String> {
    match args.get("env") {
        None | Some(Value::Null) => Ok(None),
        Some(Value::Object(vars)) => vars
            .iter()
            .map(|(key, value)| match value {
                Value::String(text) => Ok((key.clone(), text.clone())),
                Value::Number(n) => Ok((key.clone(), n.to_string())),
                Value::Bool(b) => Ok((key.clone(), b.to_string())),
                _ => Err(format!("env.{key} must be a string")),
            })
            .collect::<Result<_, _>>()
            .map(Some),
        Some(_) => Err("env must be an object of NAME: value".to_string()),
    }
}

#[cfg(test)]
mod tests {
    use std::path::PathBuf;
    use std::sync::Arc;
    use std::time::{Duration, Instant};

    use super::*;
    use crate::caller::CallerKind;
    use crate::process::ProcessConfig;
    use crate::pty::PtyHost;
    use crate::session::Session;
    use crate::tools::{handle, Host, Toolbox};
    use crate::transcript::TranscriptHub;

    struct Fixture {
        store: Store,
        pty: PtyHost,
        host: ProcessHost,
        toolbox: Toolbox,
        transcripts: TranscriptHub,
        workspace: String,
        dir: PathBuf,
    }

    impl Drop for Fixture {
        fn drop(&mut self) {
            self.host.shutdown();
            self.pty.kill_all();
            let _ = std::fs::remove_dir_all(&self.dir);
        }
    }

    fn fixture(name: &str) -> Fixture {
        let dir = std::env::temp_dir().join(format!("crew-ptools-{name}-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let store = Store::open(dir.join("crew.sqlite3")).unwrap();
        let workspace = crate::workspace::create(&store, "w".into(), dir.to_string_lossy().into()).unwrap().id;
        let pty = PtyHost::new();
        let config = ProcessConfig { stop_grace: Duration::from_millis(400), ..ProcessConfig::default() };
        let host = ProcessHost::with_config(store.clone(), pty.clone(), &dir, config);
        let toolbox = Toolbox::default();
        toolbox.register(Arc::new(ProcessTools::new(host.clone(), store.clone())));
        let transcripts = TranscriptHub::new(store.clone());
        Fixture { store, pty, host, toolbox, transcripts, workspace, dir }
    }

    impl Fixture {
        fn session(&self, workspace: &str, kind: &str, name: &str, autonomy: &str) -> Caller {
            let session: Session = session::create(
                &self.store,
                workspace.to_string(),
                kind.into(),
                name.into(),
                "claude".into(),
                "".into(),
                "".into(),
                autonomy.into(),
            )
            .unwrap();
            Caller::from_session(session)
        }

        fn user(&self) -> Caller {
            Caller::User { workspace_id: Some(self.workspace.clone()) }
        }

        /// Through `tools/call`, as the bridge would: `Err` is a refusal.
        fn call(&self, caller: &Caller, name: &str, args: Value) -> Result<Value, String> {
            let host = Host {
                store: &self.store,
                transcripts: &self.transcripts,
                on_created: &|_| {},
                on_routines: &|| {},
                toolbox: &self.toolbox,
            };
            let out = handle(&host, caller, "tools/call", json!({ "name": name, "arguments": args })).unwrap();
            let text = out["content"][0]["text"].as_str().unwrap_or_default().to_string();
            if out["isError"].as_bool().unwrap_or(false) {
                return Err(text);
            }
            Ok(serde_json::from_str(&text).unwrap_or(Value::String(text)))
        }
    }

    #[test]
    fn the_catalog_is_listed_to_everyone() {
        let f = fixture("catalog");
        let tools = ProcessTools::new(f.host.clone(), f.store.clone()).catalog();
        let names: Vec<&str> = tools.iter().map(|tool| tool.name).collect();
        assert_eq!(
            names,
            vec![
                "list_processes",
                "control_process",
                "save_process",
                "delete_process",
                "read_logs",
                "wait_for_log",
                "send_input",
            ]
        );
        assert!(tools.iter().all(|tool| tool.audience == Audience::EVERYONE));
        // The shim stretches its read by this argument's name.
        let wait = tools.iter().find(|tool| tool.name == "wait_for_log").unwrap();
        assert!(wait.schema["required"].as_array().unwrap().contains(&json!("timeout_s")));

        for kind in [CallerKind::Bot, CallerKind::Terminal, CallerKind::Child, CallerKind::User] {
            let listed = f.toolbox.visible_names(kind);
            assert!(listed.contains(&"read_logs") && listed.contains(&"list_processes"), "{kind:?}: {listed:?}");
        }
    }

    #[test]
    fn what_an_ask_bot_creates_waits_for_the_user_and_cannot_start() {
        let f = fixture("approval");
        let careful = f.session(&f.workspace, "bot", "Careful", "ask");
        let trusted = f.session(&f.workspace, "bot", "Trusted", "full");

        let asked = f
            .call(&careful, "save_process", json!({ "name": "dev", "command": "echo hi; sleep 30", "env": { "PORT": 5173 } }))
            .unwrap();
        assert_eq!(asked["runs"], json!([]));
        assert_eq!(asked["env"]["PORT"], "5173");
        let label = careful.label();
        assert_eq!(asked["created_by"], label.as_str());
        assert!(asked["pending_approval"].as_str().unwrap().contains(&label), "{asked}");

        let refused = f.call(&careful, "control_process", json!({ "action": "start", "process": "dev" })).unwrap_err();
        assert!(refused.contains("waiting for the user to approve it in Crew"), "{refused}");
        // Nobody else gets past it either.
        assert!(f.call(&trusted, "control_process", json!({ "action": "start", "process": asked["id"] })).is_err());

        let listed = f.call(&trusted, "list_processes", json!({})).unwrap();
        assert_eq!(listed[0]["name"], "dev");
        assert!(listed[0]["pending_approval"].is_string(), "{listed}");

        // Full autonomy, like the user, writes something that runs.
        let direct = f.call(&trusted, "save_process", json!({ "name": "api", "command": "sleep 30" })).unwrap();
        assert_eq!(direct["runs"], json!([]));
        assert!(direct.get("pending_approval").is_none(), "{direct}");
        let started = f.call(&trusted, "control_process", json!({ "action": "start", "process": "api" })).unwrap();
        let run = &started["runs"][0];
        assert_eq!((run["state"].clone(), run["here"].clone()), (json!("running"), json!(true)), "{started}");
        assert_eq!(run["worktree"], "main checkout");
        assert_eq!(run["started_by"], trusted.label().as_str());
        assert!(run["pid"].is_u64() && run["uptime_s"].is_u64(), "{started}");
        // An ask agent may stop and start what already exists…
        let stopped = f.call(&careful, "control_process", json!({ "action": "stop", "process": "api" })).unwrap();
        assert_eq!(stopped["runs"][0]["state"], "stopped");
        // …but its change to it is only a proposal.
        let proposed = f.call(&careful, "save_process", json!({ "process": "api", "command": "sleep 60" })).unwrap();
        assert_eq!(proposed["command"], "sleep 30");
        assert_eq!(proposed["proposed"]["command"], "sleep 60");
        assert!(proposed["pending_approval"].as_str().unwrap().contains(&label), "{proposed}");

        let by_user = f.call(&f.user(), "save_process", json!({ "name": "worker", "command": "sleep 30" })).unwrap();
        assert_eq!(by_user["created_by"], "the user");
        assert_eq!(by_user["runs"], json!([]));

        // An ask agent can undo what it made, and nothing else.
        let refused = f.call(&careful, "delete_process", json!({ "process": "worker" })).unwrap_err();
        assert!(refused.contains("not created by you"), "{refused}");
        f.call(&careful, "delete_process", json!({ "process": "dev" })).unwrap();
        f.call(&trusted, "delete_process", json!({ "process": "worker" })).unwrap();
    }

    #[test]
    fn read_logs_hands_back_a_cursor_that_reads_only_what_is_new() {
        let f = fixture("cursor");
        let user = f.user();
        let careful = f.session(&f.workspace, "bot", "Careful", "ask");
        let trusted = f.session(&f.workspace, "terminal", "Trusted", "full");
        f.call(&user, "save_process", json!({ "name": "repl", "command": "echo one; read x; echo two-$x; sleep 30" }))
            .unwrap();
        f.call(&user, "control_process", json!({ "action": "start", "process": "repl" })).unwrap();
        let first = f.call(&user, "wait_for_log", json!({ "process": "repl", "pattern": "^one$", "timeout_s": 5 })).unwrap();
        assert_eq!(first["result"], "matched", "{first}");

        let read = f.call(&user, "read_logs", json!({ "process": "repl" })).unwrap();
        assert!(read["text"].as_str().unwrap().contains("one"), "{read}");
        let cursor = read["cursor"].as_u64().unwrap();

        // An ask agent may read a running REPL but not type into it: what it
        // reads, it runs.
        let refused = f.call(&careful, "send_input", json!({ "process": "repl", "text": "evil\r" })).unwrap_err();
        assert!(refused.contains("autonomy ask"), "{refused}");
        f.call(&trusted, "send_input", json!({ "process": "repl", "text": "go" })).unwrap();
        f.call(&user, "send_input", json!({ "process": "repl", "text": "\r" })).unwrap();
        let second = f
            .call(&user, "wait_for_log", json!({ "process": "repl", "pattern": "^two-go$", "since": cursor, "timeout_s": 5 }))
            .unwrap();
        assert_eq!(second["result"], "matched", "{second}");

        let new = f.call(&user, "read_logs", json!({ "process": "repl", "since": cursor })).unwrap();
        let text = new["text"].as_str().unwrap();
        assert!(text.contains("two-go") && !text.contains("one"), "{text:?}");
        let next = new["cursor"].as_u64().unwrap();
        assert!(next > cursor);
        let nothing = f.call(&user, "read_logs", json!({ "process": "repl", "since": next })).unwrap();
        assert_eq!((nothing["text"].as_str(), nothing["cursor"].as_u64()), (Some(""), Some(next)));
    }

    /// One tool defines and changes: name picks the process, process names
    /// one to change (or rename), and only a missing one is created.
    #[test]
    fn save_process_creates_what_is_not_there_and_changes_what_is() {
        let f = fixture("save");
        let user = f.user();
        let made = f.call(&user, "save_process", json!({ "name": "web", "command": "sleep 30" })).unwrap();
        let changed = f.call(&user, "save_process", json!({ "name": "web", "auto_restart": true })).unwrap();
        assert_eq!((changed["id"].clone(), changed["command"].clone()), (made["id"].clone(), json!("sleep 30")));
        assert_eq!(changed["auto_restart"], true);
        let renamed = f.call(&user, "save_process", json!({ "process": "web", "name": "site" })).unwrap();
        assert_eq!((renamed["id"].clone(), renamed["name"].clone()), (made["id"].clone(), json!("site")));
        assert_eq!(f.call(&user, "list_processes", json!({})).unwrap().as_array().unwrap().len(), 1);

        let refused = f.call(&user, "save_process", json!({ "name": "api" })).unwrap_err();
        assert!(refused.contains("command is required to create a process"), "{refused}");
        let refused = f.call(&user, "save_process", json!({ "process": "nope", "command": "x" })).unwrap_err();
        assert!(refused.contains("No process") && refused.contains("leave out process"), "{refused}");
        let refused = f.call(&user, "save_process", json!({ "command": "x" })).unwrap_err();
        assert!(refused.contains("name is required"), "{refused}");
    }

    #[test]
    fn control_process_says_what_each_action_takes() {
        let f = fixture("control");
        let user = f.user();
        f.call(&user, "save_process", json!({ "name": "web", "command": "echo up; echo ERROR 1; sleep 30" })).unwrap();
        let refused = f.call(&user, "control_process", json!({ "process": "web" })).unwrap_err();
        assert!(refused.contains("control_process takes: process, action"), "{refused}");
        let refused = f.call(&user, "control_process", json!({ "process": "web", "action": "boot" })).unwrap_err();
        assert!(refused.contains("one of start, stop, restart, pause, resume, not boot"), "{refused}");
        let refused = f.call(&user, "control_process", json!({ "process": "web", "action": "stop", "env": { "A": "1" } })).unwrap_err();
        assert!(refused.contains("env is for start and restart"), "{refused}");

        for (action, state) in [("start", "running"), ("pause", "paused"), ("resume", "running"), ("restart", "running")] {
            let out = f.call(&user, "control_process", json!({ "process": "web", "action": action })).unwrap();
            assert_eq!(out["runs"][0]["state"], state, "{action}: {out}");
        }
        let line = f.call(&user, "wait_for_log", json!({ "process": "web", "pattern": "ERROR", "timeout_s": 5 })).unwrap();
        assert_eq!(line["result"], "matched", "{line}");

        // read_logs with a pattern searches, as grep_logs did.
        let found = f.call(&user, "read_logs", json!({ "process": "web", "pattern": "ERROR \\d", "context": 1 })).unwrap();
        assert_eq!(found["total"], 1, "{found}");
        assert_eq!(found["matches"][0]["line"], "ERROR 1", "{found}");
        assert_eq!(found["matches"][0]["before"], json!(["up"]), "{found}");
        let refused = f.call(&user, "read_logs", json!({ "process": "web", "pattern": "x", "since": 0 })).unwrap_err();
        assert!(refused.contains("since is for reading"), "{refused}");
        let refused = f.call(&user, "read_logs", json!({ "process": "web", "max_matches": 3 })).unwrap_err();
        assert!(refused.contains("max_matches goes with pattern"), "{refused}");

        let stopped = f.call(&user, "control_process", json!({ "process": "web", "action": "stop" })).unwrap();
        assert_eq!(stopped["runs"][0]["state"], "stopped");
    }

    #[test]
    fn wait_for_log_holds_timeout_s_to_between_one_second_and_a_minute() {
        assert_eq!(wait_seconds(&json!({ "timeout_s": 3600 })), Ok(WAIT_MAX_S));
        assert_eq!(wait_seconds(&json!({ "timeout_s": 60 })), Ok(60));
        assert_eq!(wait_seconds(&json!({ "timeout_s": 0 })), Ok(1));
        assert_eq!(wait_seconds(&json!({ "timeout_s": -5 })), Ok(1));
        assert_eq!(wait_seconds(&json!({ "timeout_s": 2.5 })), Ok(3));
        assert!(wait_seconds(&json!({ "timeout_s": "soon" })).is_err());
        assert!(wait_seconds(&json!({})).unwrap_err().contains("timeout_s"));

        let f = fixture("timeout");
        let user = f.user();
        f.call(&user, "save_process", json!({ "name": "quiet", "command": "sleep 30" })).unwrap();
        f.call(&user, "control_process", json!({ "action": "start", "process": "quiet" })).unwrap();
        let asked = Instant::now();
        let out = f.call(&user, "wait_for_log", json!({ "process": "quiet", "pattern": "never", "timeout_s": 0 })).unwrap();
        let took = asked.elapsed();
        assert_eq!(out["result"], "timed-out", "{out}");
        assert!(out["note"].as_str().unwrap().contains("in 1s"), "{out}");
        assert!(took >= Duration::from_secs(1) && took < Duration::from_secs(5), "{took:?}");
        let refused = f.call(&user, "wait_for_log", json!({ "process": "quiet", "pattern": "never" })).unwrap_err();
        assert!(refused.contains("wait_for_log takes: process, pattern, timeout_s"), "{refused}");
    }

    /// A worktree of the fixture's folder, made a repo for it.
    fn worktree(dir: &std::path::Path, branch: &str) -> String {
        let git = |args: &[&str]| {
            let out = std::process::Command::new("git").arg("-C").arg(dir).args(args).output().unwrap();
            assert!(out.status.success(), "git {args:?}: {}", String::from_utf8_lossy(&out.stderr));
        };
        git(&["init", "-q"]);
        git(&["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "--allow-empty", "-m", "init"]);
        let tree = dir.with_file_name(format!("{}-{branch}", dir.file_name().unwrap().to_string_lossy()));
        git(&["worktree", "add", "-q", "-b", branch, tree.to_str().unwrap()]);
        crate::worktree::paths(dir.to_str().unwrap()).pop().unwrap()
    }

    #[test]
    fn a_session_in_a_worktree_runs_there_on_a_port_of_its_own() {
        let f = fixture("worktree");
        let tree = worktree(&f.dir, "feat");
        let user = f.user();
        f.call(&user, "save_process", json!({ "name": "web", "command": "echo port=$PORT in $(pwd); sleep 30", "env": { "PORT": "3000" } }))
            .unwrap();
        let session = session::create_in_worktree(
            &f.store,
            f.workspace.clone(),
            "bot".into(),
            "Careful".into(),
            "claude".into(),
            "".into(),
            "".into(),
            "ask".into(),
            Some(tree.clone()),
        )
        .unwrap();
        let careful = Caller::from_session(session);

        // Its worktree unless told otherwise, and only the names the command has.
        let refused = f
            .call(&careful, "control_process", json!({ "action": "start", "process": "web", "env": { "NODE_OPTIONS": "--require x" } }))
            .unwrap_err();
        assert!(refused.contains("autonomy ask") && refused.contains("NODE_OPTIONS"), "{refused}");
        let started = f.call(&careful, "control_process", json!({ "action": "start", "process": "web", "env": { "PORT": "3001" } })).unwrap();
        let run = &started["runs"][0];
        assert_eq!((run["worktree"].as_str(), run["here"].as_bool()), (Some(tree.as_str()), Some(true)), "{started}");
        assert_eq!((run["env"]["PORT"].as_str(), run["started_by"].as_str()), (Some("3001"), Some(careful.label().as_str())));
        let line = f.call(&careful, "wait_for_log", json!({ "process": "web", "pattern": "port=3001", "timeout_s": 5 })).unwrap();
        assert_eq!(line["result"], "matched", "{line}");
        assert!(line["line"].as_str().unwrap().ends_with("-feat"), "runs in the worktree: {line}");

        // The user's run in the main checkout is another run, listed first.
        f.call(&user, "control_process", json!({ "action": "start", "process": "web" })).unwrap();
        let listed = f.call(&careful, "list_processes", json!({})).unwrap();
        let runs = listed[0]["runs"].as_array().unwrap();
        assert_eq!(runs.len(), 2, "{listed}");
        assert_eq!((runs[0]["worktree"].as_str(), runs[0].get("here")), (Some("main checkout"), None));
        assert_eq!(runs[1]["here"], true);
        let main = f.call(&user, "read_logs", json!({ "process": "web" })).unwrap();
        assert!(!main["text"].as_str().unwrap().contains("3001"), "each run its own log: {main}");

        let nowhere = f.call(&user, "control_process", json!({ "action": "start", "process": "web", "worktree": "/nope" })).unwrap_err();
        assert!(nowhere.contains("not a worktree"), "{nowhere}");

        // The user stops the agent's run by naming its worktree; theirs keeps going.
        let stopped = f.call(&user, "control_process", json!({ "action": "stop", "process": "web", "worktree": tree })).unwrap();
        let states: Vec<&str> = stopped["runs"].as_array().unwrap().iter().map(|run| run["state"].as_str().unwrap()).collect();
        assert_eq!(states, ["running", "stopped"]);

        // What `initialize` says to the agent: the rule, and what is there.
        let said = crate::tools::instructions(&f.toolbox, &careful);
        assert!(said.contains("use control_process with action start instead of backgrounding it in your shell"), "{said}");
        assert!(said.contains("Processes defined in this workspace: web (echo port=$PORT"), "{said}");
        f.call(&careful, "control_process", json!({ "action": "start", "process": "web" })).unwrap();
        let said = crate::tools::instructions(&f.toolbox, &careful);
        assert!(said.contains("sleep 30, running here)"), "{said}");

        // A worktree removed takes its runs and their logs with it.
        f.host.forget_worktree(&tree);
        let left = f.host.get(&f.workspace, "web").unwrap();
        assert_eq!(left.runs.iter().map(|run| run.worktree.clone()).collect::<Vec<_>>(), vec![None]);
        let _ = std::fs::remove_dir_all(&tree);
    }

    #[test]
    fn a_caller_reaches_only_its_own_workspace() {
        let f = fixture("scope");
        let elsewhere_dir = f.dir.join("elsewhere");
        std::fs::create_dir_all(&elsewhere_dir).unwrap();
        let elsewhere = crate::workspace::create(&f.store, "e".into(), elsewhere_dir.to_string_lossy().into())
            .unwrap()
            .id;
        let mine = f.call(&f.user(), "save_process", json!({ "name": "web", "command": "sleep 30" })).unwrap();

        let stranger = f.session(&elsewhere, "terminal", "Shell", "full");
        assert_eq!(f.call(&stranger, "list_processes", json!({})).unwrap(), json!([]));
        for target in [mine["id"].clone(), json!("web")] {
            let refused = f.call(&stranger, "control_process", json!({ "action": "start", "process": target })).unwrap_err();
            assert!(refused.contains("No process"), "{refused}");
        }

        let neighbour = f.session(&f.workspace, "terminal", "Neighbour", "ask");
        assert_eq!(f.call(&neighbour, "list_processes", json!({})).unwrap()[0]["id"], mine["id"]);

        let nowhere = Caller::User { workspace_id: None };
        let refused = f.call(&nowhere, "list_processes", json!({})).unwrap_err();
        assert!(refused.contains("--workspace"), "{refused}");
        let other_user = Caller::User { workspace_id: Some(elsewhere) };
        assert_eq!(f.call(&other_user, "list_processes", json!({})).unwrap(), json!([]));
    }
}
