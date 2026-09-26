//! The process manager as MCP tools: a thin layer over [`ProcessHost`] that
//! reads arguments, scopes every call to the caller's workspace and says who
//! is asking.
//!
//! Watching is polling: MCP is request and response, and not every provider
//! takes notifications. `read_logs` hands back a cursor to continue from, and
//! `wait_for_log` blocks up to a minute; the shim gives a call that carries
//! `timeout_s` that long plus ten seconds.

use std::collections::BTreeMap;

use crew_protocol::{LogWait, Process, ProcessSpec, ProcessState};
use serde_json::{json, Value};

use crate::caller::Caller;
use crate::process::{ProcessHost, ProcessPatch, WAIT_MAX_S};
use crate::session;
use crate::store::{now_millis, Store};
use crate::tools::{Audience, Tool, ToolFamily, ToolOutput};

pub struct ProcessTools {
    host: ProcessHost,
    /// For naming whoever created a process.
    store: Store,
}

impl ProcessTools {
    pub fn new(host: ProcessHost, store: Store) -> Self {
        Self { host, store }
    }
}

/// `process` in every schema: the model has whichever it saw last.
fn process_arg() -> Value {
    json!({ "type": "string", "description": "The process's id or its name, from list_processes." })
}

fn spec_properties() -> Value {
    json!({
        "name": { "type": "string", "description": "Unique in this workspace, e.g. \"web\" or \"api\"." },
        "command": { "type": "string", "description": "Run by the user's shell, so pipes, && and globs work as typed, e.g. \"npm run dev\"." },
        "cwd": { "type": "string", "description": "Relative to the workspace folder, or absolute. Empty is the folder itself." },
        "env": { "type": "object", "additionalProperties": { "type": "string" }, "description": "Extra environment variables." },
        "auto_start": { "type": "boolean", "description": "Start it whenever Crew starts." },
        "auto_restart": { "type": "boolean", "description": "Restart it when it exits on its own, backing off from 1 s to 30 s; five crashes in two minutes leave it crashed." }
    })
}

fn one(name: &'static str, description: &'static str, keywords: &'static [&'static str]) -> Tool {
    Tool {
        name,
        description,
        schema: json!({ "type": "object", "properties": { "process": process_arg() }, "required": ["process"] }),
        keywords,
        core: false,
        audience: Audience::EVERYONE,
    }
}

impl ToolFamily for ProcessTools {
    fn catalog(&self) -> Vec<Tool> {
        let mut update = spec_properties();
        update["process"] = process_arg();
        vec![
            Tool {
                name: "list_processes",
                description: "List this workspace's processes: the dev servers, watchers and workers Crew keeps running, each in a terminal of its own with its output logged. Each comes with its state (stopped, starting, running, paused, exited, crashed, pending-approval), pid, uptime, last exit code, automatic restarts, who created it and whether it waits for the user's approval. log_cursor is where its log ends right now: pass it as since to read_logs or wait_for_log to see only what comes after.",
                schema: json!({ "type": "object", "properties": {} }),
                keywords: &["dev", "server", "servers", "running", "status", "commands", "processes", "services", "watchers"],
                core: true,
                audience: Audience::EVERYONE,
            },
            one(
                "start_process",
                "Start a process of this workspace. It returns as soon as the process is running; to know it is up, follow with wait_for_log for its ready line (without since it reads this run from its first line, so nothing printed in between is missed). Already running, it is left alone. A process an agent created that the user has not approved yet cannot start: the error says so, and only the user can approve it, in Crew.",
                &["run", "launch", "boot", "dev", "server", "serve", "up"],
            ),
            one(
                "stop_process",
                "Stop a process: SIGTERM to its whole process group, SIGKILL if it is still up after the grace (5 s). Returns once it has exited; an automatic restart does not bring it back.",
                &["kill", "halt", "terminate", "shutdown", "down", "server"],
            ),
            one(
                "restart_process",
                "Stop a process and start it again: after changing its definition, or when it hangs. Follow with wait_for_log without since to watch the new run boot.",
                &["reload", "reboot", "bounce", "server", "dev"],
            ),
            one(
                "pause_process",
                "Freeze a running process (SIGSTOP to its group): it keeps its memory and its ports but runs nothing until resume_process.",
                &["suspend", "freeze", "sigstop"],
            ),
            one(
                "resume_process",
                "Continue a paused process (SIGCONT to its group).",
                &["continue", "unpause", "unfreeze", "sigcont"],
            ),
            Tool {
                name: "create_process",
                description: "Define a new process in this workspace: a shell command Crew keeps running in a terminal of its own, with its output logged. It is not started: call start_process. If your autonomy is ask, it is created pending-approval: the user has to accept it in Crew first, and start_process fails until then, so tell the user it is waiting for them.",
                schema: json!({ "type": "object", "properties": spec_properties(), "required": ["name", "command"] }),
                keywords: &["new", "add", "define", "dev", "server", "command", "watcher", "service"],
                core: false,
                audience: Audience::EVERYONE,
            },
            Tool {
                name: "update_process",
                description: "Change a process's definition; only the fields you pass change. If your autonomy is ask, the change waits for the user's approval as a proposal, and what runs meanwhile is the definition already accepted. A running process picks up a change on its next start: restart_process.",
                schema: json!({ "type": "object", "properties": update, "required": ["process"] }),
                keywords: &["edit", "change", "rename", "configure", "env", "command"],
                core: false,
                audience: Audience::EVERYONE,
            },
            one(
                "delete_process",
                "Delete a process: stop it if it runs, and remove its definition and its logs. With autonomy ask you can only delete the processes you created.",
                &["remove", "forget", "drop"],
            ),
            Tool {
                name: "read_logs",
                description: "Read a process's output as plain text, colours and escapes stripped. Without since: its last tail lines (200 by default). With since: what was written from that cursor on, up to max_bytes (16 KB by default, 256 KB at most); a cursor short of log_cursor means there is more, so call again. Either way the answer's cursor is where this read ended: pass it back as since and you get only what is new. That is how you watch a process: poll read_logs with the last cursor, or block on wait_for_log. skipped above zero means log rotation dropped that many bytes after since.",
                schema: json!({
                    "type": "object",
                    "properties": {
                        "process": process_arg(),
                        "tail": { "type": "integer", "minimum": 1, "maximum": 5000, "description": "Lines from the end, when since is not given." },
                        "since": { "type": "integer", "minimum": 0, "description": "A cursor from an earlier call, or log_cursor from list_processes." },
                        "max_bytes": { "type": "integer", "minimum": 1, "maximum": 262144 }
                    },
                    "required": ["process"]
                }),
                keywords: &["log", "output", "tail", "watch", "stdout", "stderr", "console", "print", "poll"],
                core: false,
                audience: Audience::EVERYONE,
            },
            Tool {
                name: "grep_logs",
                description: "Search a process's whole log still on disk for a regex: the latest max_matches matching lines (20 by default), oldest first, each with context lines either side (up to 10). total counts every match, shown or not. Crew's own [crew] lines are never matched.",
                schema: json!({
                    "type": "object",
                    "properties": {
                        "process": process_arg(),
                        "pattern": { "type": "string", "description": "A regex, e.g. \"(?i)error|warn\"." },
                        "context": { "type": "integer", "minimum": 0, "maximum": 10 },
                        "max_matches": { "type": "integer", "minimum": 1, "maximum": 200 }
                    },
                    "required": ["process", "pattern"]
                }),
                keywords: &["log", "search", "find", "error", "errors", "grep", "regex", "stack", "trace"],
                core: false,
                audience: Audience::EVERYONE,
            },
            Tool {
                name: "wait_for_log",
                description: "Block until a line of a process's log matches a regex, the process stops or exits, or timeout_s passes (at most 60). Without since it searches the current run from its first line, so start_process or restart_process followed by this sees the whole boot, even a line printed before the call. With since, only what comes after that cursor. Answers with result matched (the line, and the cursor after it), ended (the state and exit code: nothing more is coming) or timed-out. To wait longer than a minute, call again with since set to the cursor it returned.",
                schema: json!({
                    "type": "object",
                    "properties": {
                        "process": process_arg(),
                        "pattern": { "type": "string", "description": "A regex, e.g. \"ready|listening on\"." },
                        "since": { "type": "integer", "minimum": 0, "description": "A cursor from an earlier call. Omit to search the current run from its start." },
                        "timeout_s": { "type": "integer", "minimum": 1, "maximum": WAIT_MAX_S, "description": "Seconds to wait, at most 60." }
                    },
                    "required": ["process", "pattern", "timeout_s"]
                }),
                keywords: &["log", "watch", "ready", "listening", "until", "block", "boot", "started", "compiled"],
                core: false,
                audience: Audience::EVERYONE,
            },
            Tool {
                name: "send_input",
                description: "Type into a running process's terminal, as if at its keyboard: an interactive key (vite's r to restart, q to quit) or an answer to a prompt. Sent exactly as given, so add \\r to press Enter. Needs full autonomy: with autonomy ask it is refused, since whatever the process reads it may run.",
                schema: json!({
                    "type": "object",
                    "properties": {
                        "process": process_arg(),
                        "text": { "type": "string" }
                    },
                    "required": ["process", "text"]
                }),
                keywords: &["type", "keys", "keyboard", "stdin", "input", "press", "answer", "prompt"],
                core: false,
                audience: Audience::EVERYONE,
            },
        ]
    }

    fn run(&self, caller: &Caller, name: &str, args: &Value) -> Result<ToolOutput, String> {
        let workspace = caller.workspace_id()?;
        let host = &self.host;
        let out = match name {
            "list_processes" => Value::Array(host.list(workspace)?.iter().map(|p| self.row(p)).collect()),
            "start_process" => self.row(&host.start(workspace, &process(args)?)?),
            "stop_process" => self.row(&host.stop(workspace, &process(args)?)?),
            "restart_process" => self.row(&host.restart(workspace, &process(args)?)?),
            "pause_process" => self.row(&host.pause(workspace, &process(args)?)?),
            "resume_process" => self.row(&host.resume(workspace, &process(args)?)?),
            "create_process" => {
                let spec = ProcessSpec {
                    name: string(args, "name")?.ok_or("name is required")?,
                    command: string(args, "command")?.ok_or("command is required")?,
                    cwd: string(args, "cwd")?.unwrap_or_default(),
                    env: env(args)?.unwrap_or_default(),
                    auto_start: flag(args, "auto_start")?.unwrap_or(false),
                    auto_restart: flag(args, "auto_restart")?.unwrap_or(false),
                };
                let by = caller.session_id().map(str::to_string);
                self.row(&host.create(workspace, spec, by, !caller.full_autonomy())?)
            }
            "update_process" => {
                let patch = ProcessPatch {
                    name: string(args, "name")?,
                    command: string(args, "command")?,
                    cwd: string(args, "cwd")?,
                    env: env(args)?,
                    auto_start: flag(args, "auto_start")?,
                    auto_restart: flag(args, "auto_restart")?,
                };
                let by = caller.session_id().map(str::to_string);
                self.row(&host.update(workspace, &process(args)?, patch, by, !caller.full_autonomy())?)
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
            "read_logs" => {
                let chunk = host.read_logs(
                    workspace,
                    &process(args)?,
                    number(args, "tail")?.map(clamp_u32),
                    number(args, "since")?,
                    number(args, "max_bytes")?.map(clamp_u32),
                )?;
                json!({ "text": chunk.text, "cursor": chunk.cursor, "start": chunk.start, "skipped": chunk.skipped })
            }
            "grep_logs" => {
                let pattern = string(args, "pattern")?.ok_or("pattern is required")?;
                let grep = host.grep_logs(
                    workspace,
                    &process(args)?,
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
            "wait_for_log" => {
                let pattern = string(args, "pattern")?.ok_or("pattern is required")?;
                let timeout = wait_seconds(args)?;
                let waited = host.wait_for_log(workspace, &process(args)?, &pattern, number(args, "since")?, timeout)?;
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
                host.send_input(workspace, &target, &text)?;
                json!(format!("Sent {} bytes to \"{target}\".", text.len()))
            }
            _ => return Err(format!("Unknown tool \"{name}\"")),
        };
        Ok(out.into())
    }
}

impl ProcessTools {
    /// A process as the model reads it: what it runs, how it stands, and
    /// anything the user still has to say about it.
    fn row(&self, process: &Process) -> Value {
        let mut row = json!({
            "id": process.id,
            "name": process.spec.name,
            "command": process.spec.command,
            "state": process.state,
            "pid": process.pid,
            "exit_code": process.exit_code,
            "restarts": process.restarts,
            "auto_start": process.spec.auto_start,
            "auto_restart": process.spec.auto_restart,
            "created_by": self.who(process.created_by.as_deref()),
            "log_cursor": process.log_cursor
        });
        if !process.spec.cwd.is_empty() {
            row["cwd"] = json!(process.spec.cwd);
        }
        if !process.spec.env.is_empty() {
            row["env"] = json!(process.spec.env);
        }
        if matches!(process.state, ProcessState::Running | ProcessState::Paused) {
            if let Some(started) = process.started_at {
                row["uptime_s"] = json!((now_millis() - started).max(0) / 1000);
            }
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
                "auto_start": proposed.auto_start,
                "auto_restart": proposed.auto_restart
            });
        }
        row
    }

    /// A session id as "Name (agent id)"; `None` is the user.
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
                deliver: &|_: &Session| false,
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
    fn the_catalog_is_one_listed_tool_and_the_rest_behind_the_gateway_for_everyone() {
        let f = fixture("catalog");
        let tools = ProcessTools::new(f.host.clone(), f.store.clone()).catalog();
        let names: Vec<&str> = tools.iter().map(|tool| tool.name).collect();
        assert_eq!(
            names,
            vec![
                "list_processes",
                "start_process",
                "stop_process",
                "restart_process",
                "pause_process",
                "resume_process",
                "create_process",
                "update_process",
                "delete_process",
                "read_logs",
                "grep_logs",
                "wait_for_log",
                "send_input",
            ]
        );
        let core: Vec<&str> = tools.iter().filter(|tool| tool.core).map(|tool| tool.name).collect();
        assert_eq!(core, vec!["list_processes"]);
        assert!(tools.iter().all(|tool| tool.audience == Audience::EVERYONE));
        // The shim stretches its read by this argument's name.
        let wait = tools.iter().find(|tool| tool.name == "wait_for_log").unwrap();
        assert!(wait.schema["required"].as_array().unwrap().contains(&json!("timeout_s")));

        for kind in [CallerKind::Agent, CallerKind::Terminal, CallerKind::User] {
            let hidden = f.toolbox.hidden_names(kind);
            assert!(hidden.contains(&"read_logs") && !hidden.contains(&"list_processes"), "{kind:?}: {hidden:?}");
        }
        let agent = f.session(&f.workspace, "agent", "Coder", "ask");
        let found = f.call(&agent, "find_tool", json!({ "query": "tail the dev server logs" })).unwrap();
        assert_eq!(found["matches"][0]["name"], "read_logs", "{found}");
    }

    #[test]
    fn what_an_ask_agent_creates_waits_for_the_user_and_cannot_start() {
        let f = fixture("approval");
        let careful = f.session(&f.workspace, "agent", "Careful", "ask");
        let trusted = f.session(&f.workspace, "agent", "Trusted", "full");

        let asked = f
            .call(&careful, "create_process", json!({ "name": "dev", "command": "echo hi; sleep 30", "env": { "PORT": 5173 } }))
            .unwrap();
        assert_eq!(asked["state"], "pending-approval");
        assert_eq!(asked["env"]["PORT"], "5173");
        let label = careful.label();
        assert_eq!(asked["created_by"], label.as_str());
        assert!(asked["pending_approval"].as_str().unwrap().contains(&label), "{asked}");

        let refused = f.call(&careful, "start_process", json!({ "process": "dev" })).unwrap_err();
        assert!(refused.contains("waiting for the user to approve it in Crew"), "{refused}");
        // Nobody else gets past it either.
        assert!(f.call(&trusted, "start_process", json!({ "process": asked["id"] })).is_err());

        let listed = f.call(&trusted, "list_processes", json!({})).unwrap();
        assert_eq!(listed[0]["name"], "dev");
        assert!(listed[0]["pending_approval"].is_string(), "{listed}");

        // Full autonomy, like the user, writes something that runs.
        let direct = f.call(&trusted, "create_process", json!({ "name": "api", "command": "sleep 30" })).unwrap();
        assert_eq!(direct["state"], "stopped");
        assert!(direct.get("pending_approval").is_none(), "{direct}");
        let started = f.call(&trusted, "start_process", json!({ "process": "api" })).unwrap();
        assert_eq!(started["state"], "running");
        assert!(started["pid"].is_u64() && started["uptime_s"].is_u64(), "{started}");
        // An ask agent may stop and start what already exists…
        let stopped = f.call(&careful, "stop_process", json!({ "process": "api" })).unwrap();
        assert_eq!(stopped["state"], "stopped");
        // …but its change to it is only a proposal.
        let proposed = f.call(&careful, "update_process", json!({ "process": "api", "command": "sleep 60" })).unwrap();
        assert_eq!(proposed["command"], "sleep 30");
        assert_eq!(proposed["proposed"]["command"], "sleep 60");
        assert!(proposed["pending_approval"].as_str().unwrap().contains(&label), "{proposed}");

        let by_user = f.call(&f.user(), "create_process", json!({ "name": "worker", "command": "sleep 30" })).unwrap();
        assert_eq!(by_user["created_by"], "the user");
        assert_eq!(by_user["state"], "stopped");

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
        let careful = f.session(&f.workspace, "agent", "Careful", "ask");
        let trusted = f.session(&f.workspace, "terminal", "Trusted", "full");
        f.call(&user, "create_process", json!({ "name": "repl", "command": "echo one; read x; echo two-$x; sleep 30" }))
            .unwrap();
        f.call(&user, "start_process", json!({ "process": "repl" })).unwrap();
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
        f.call(&user, "create_process", json!({ "name": "quiet", "command": "sleep 30" })).unwrap();
        f.call(&user, "start_process", json!({ "process": "quiet" })).unwrap();
        let asked = Instant::now();
        let out = f.call(&user, "wait_for_log", json!({ "process": "quiet", "pattern": "never", "timeout_s": 0 })).unwrap();
        let took = asked.elapsed();
        assert_eq!(out["result"], "timed-out", "{out}");
        assert!(out["note"].as_str().unwrap().contains("in 1s"), "{out}");
        assert!(took >= Duration::from_secs(1) && took < Duration::from_secs(5), "{took:?}");
        let refused = f.call(&user, "wait_for_log", json!({ "process": "quiet", "pattern": "never" })).unwrap_err();
        assert!(refused.contains("wait_for_log takes: process, pattern, timeout_s"), "{refused}");
    }

    #[test]
    fn a_caller_reaches_only_its_own_workspace() {
        let f = fixture("scope");
        let elsewhere_dir = f.dir.join("elsewhere");
        std::fs::create_dir_all(&elsewhere_dir).unwrap();
        let elsewhere = crate::workspace::create(&f.store, "e".into(), elsewhere_dir.to_string_lossy().into())
            .unwrap()
            .id;
        let mine = f.call(&f.user(), "create_process", json!({ "name": "web", "command": "sleep 30" })).unwrap();

        let stranger = f.session(&elsewhere, "terminal", "Shell", "full");
        assert_eq!(f.call(&stranger, "list_processes", json!({})).unwrap(), json!([]));
        for target in [mine["id"].clone(), json!("web")] {
            let refused = f.call(&stranger, "start_process", json!({ "process": target })).unwrap_err();
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
