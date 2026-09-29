use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};
use ts_rs::TS;

/// Where one run of a command stands.
#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq, TS)]
#[serde(rename_all = "kebab-case")]
#[ts(export, export_to = "../../../src/lib/protocol.ts", rename_all = "kebab-case")]
pub enum ProcessState {
    Stopped,
    /// Spawning, or waiting out the backoff before an automatic restart.
    Starting,
    Running,
    Paused,
    /// Ended on its own; `exit_code` says how.
    Exited,
    /// Restarted too often in too little time and was left down.
    Crashed,
}

/// What a process runs: the part an agent may only propose.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../../src/lib/protocol.ts", rename_all = "camelCase")]
pub struct ProcessSpec {
    pub name: String,
    pub command: String,
    /// Relative to the worktree it runs in; empty is its root. Rows from
    /// before worktrees may hold an absolute path, which runs there from any.
    pub cwd: String,
    pub env: BTreeMap<String, String>,
    pub auto_restart: bool,
}

/// A command of the workspace's inventory, with the runs it has in its worktrees.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../../src/lib/protocol.ts", rename_all = "camelCase")]
pub struct Process {
    pub id: String,
    pub workspace_id: String,
    #[serde(flatten)]
    #[ts(flatten)]
    pub spec: ProcessSpec,
    /// The session that wrote it; `None` is the user.
    pub created_by: Option<String>,
    /// False until the user accepts what an agent created. It cannot start before.
    pub approved: bool,
    /// A change an agent asked for, waiting on the user. What runs meanwhile
    /// is `spec`, the definition already accepted.
    pub proposed: Option<ProcessSpec>,
    /// Who is asking: the creator of an unapproved process, or the proposer.
    pub requested_by: Option<String>,
    /// One per worktree it was started in since the daemon came up, the main
    /// checkout first. A run that ended stays, so its exit can be read.
    pub runs: Vec<ProcessRun>,
    /// Bumped by every change to the definition or to what waits on the
    /// user. An approval names the one the user read, so a change that
    /// lands while they read it is not what they approve.
    #[ts(type = "number")]
    pub revision: u64,
}

impl Process {
    /// Its run in `worktree` (`None` is the main checkout), if it has one.
    pub fn run_in(&self, worktree: Option<&str>) -> Option<&ProcessRun> {
        self.runs.iter().find(|run| run.worktree.as_deref() == worktree)
    }
}

/// A command running, or last run, in one worktree.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../../src/lib/protocol.ts", rename_all = "camelCase")]
pub struct ProcessRun {
    /// The worktree's path; `None` is the workspace's main checkout.
    pub worktree: Option<String>,
    pub state: ProcessState,
    pub pid: Option<u32>,
    /// The PTY stream a viewer reads while it runs.
    pub stream_id: Option<u32>,
    #[ts(type = "number | null")]
    pub started_at: Option<i64>,
    /// The last run's; `None` while running, or after a signal.
    pub exit_code: Option<i32>,
    /// Automatic restarts since it was last started by hand.
    pub restarts: u32,
    /// The PTY a viewer attaches to while it runs.
    pub pty_id: String,
    /// Bytes ever logged: `read_logs { since }` continues from here.
    #[ts(type = "number")]
    pub log_cursor: u64,
    /// Where the current (or last) run's output starts in the log.
    #[ts(type = "number")]
    pub run_cursor: u64,
    /// The session that started it; `None` is the user.
    pub started_by: Option<String>,
    /// Laid over the command's own for this run, e.g. a `PORT` of its own.
    pub env: BTreeMap<String, String>,
}

#[derive(Serialize, Deserialize, Clone, Debug, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../../src/lib/protocol.ts", rename_all = "camelCase")]
pub struct ProcessCreate {
    pub workspace_id: String,
    pub name: String,
    pub command: String,
    #[serde(default)]
    #[ts(optional)]
    pub cwd: Option<String>,
    #[serde(default)]
    #[ts(optional)]
    pub env: Option<BTreeMap<String, String>>,
    #[serde(default)]
    pub auto_restart: bool,
}

/// Only the fields present change.
#[derive(Serialize, Deserialize, Clone, Debug, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../../src/lib/protocol.ts", rename_all = "camelCase")]
pub struct ProcessUpdate {
    pub workspace_id: String,
    pub id: String,
    #[serde(default)]
    #[ts(optional)]
    pub name: Option<String>,
    #[serde(default)]
    #[ts(optional)]
    pub command: Option<String>,
    #[serde(default)]
    #[ts(optional)]
    pub cwd: Option<String>,
    #[serde(default)]
    #[ts(optional)]
    pub env: Option<BTreeMap<String, String>>,
    #[serde(default)]
    #[ts(optional)]
    pub auto_restart: Option<bool>,
}

/// One process of a workspace, by id or by name.
#[derive(Serialize, Deserialize, Clone, Debug, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../../src/lib/protocol.ts", rename_all = "camelCase")]
pub struct ProcessRef {
    pub workspace_id: String,
    pub id: String,
    /// The run's worktree; absent is the main checkout. Ignored by the
    /// commands that act on the definition (delete, reject).
    #[serde(default)]
    #[ts(optional)]
    pub worktree: Option<String>,
}

/// Starts, or restarts, a command in a worktree.
#[derive(Serialize, Deserialize, Clone, Debug, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../../src/lib/protocol.ts", rename_all = "camelCase")]
pub struct ProcessStart {
    pub workspace_id: String,
    pub id: String,
    #[serde(default)]
    #[ts(optional)]
    pub worktree: Option<String>,
    /// Over the command's own, for this run. Absent on a restart keeps the last run's.
    #[serde(default)]
    #[ts(optional)]
    pub env: Option<BTreeMap<String, String>>,
}

/// The user accepts a process, or a change to it, as it stood at `revision`.
#[derive(Serialize, Deserialize, Clone, Debug, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../../src/lib/protocol.ts", rename_all = "camelCase")]
pub struct ProcessApprove {
    pub workspace_id: String,
    pub id: String,
    #[ts(type = "number")]
    pub revision: u64,
}

#[derive(Serialize, Deserialize, Clone, Debug, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../../src/lib/protocol.ts", rename_all = "camelCase")]
pub struct ProcessReorder {
    pub workspace_id: String,
    pub ids: Vec<String>,
}

/// The raw tail of a process's log, escapes and all, for a terminal to paint.
#[derive(Serialize, Deserialize, Clone, Debug, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../../src/lib/protocol.ts", rename_all = "camelCase")]
pub struct ProcessLogTail {
    pub workspace_id: String,
    pub id: String,
    #[serde(default)]
    #[ts(optional)]
    pub worktree: Option<String>,
    #[serde(default)]
    #[ts(optional)]
    pub max_bytes: Option<u32>,
}

/// A stretch of log. `text` is ANSI-free for agents, raw for a terminal.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../../src/lib/protocol.ts", rename_all = "camelCase")]
pub struct LogChunk {
    pub text: String,
    /// Where `text` starts in the log.
    #[ts(type = "number")]
    pub start: u64,
    /// Where it ends: pass it back as `since` to read on.
    #[ts(type = "number")]
    pub cursor: u64,
    /// Bytes asked for that rotation had already dropped.
    #[ts(type = "number")]
    pub skipped: u64,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../../src/lib/protocol.ts", rename_all = "camelCase")]
pub struct LogMatch {
    /// Where the matching line starts in the log.
    #[ts(type = "number")]
    pub offset: u64,
    pub line: String,
    pub before: Vec<String>,
    pub after: Vec<String>,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../../src/lib/protocol.ts", rename_all = "camelCase")]
pub struct LogGrep {
    /// The latest matches, oldest first.
    pub matches: Vec<LogMatch>,
    /// Every match in what is still on disk, shown or not.
    pub total: u32,
    #[ts(type = "number")]
    pub cursor: u64,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, TS)]
#[serde(tag = "result", rename_all = "kebab-case")]
#[ts(export, export_to = "../../../src/lib/protocol.ts", tag = "result", rename_all = "kebab-case")]
pub enum LogWait {
    Matched {
        #[ts(type = "number")]
        offset: u64,
        line: String,
        #[ts(type = "number")]
        cursor: u64,
    },
    /// The process stopped or ended before the pattern showed up.
    Ended {
        state: ProcessState,
        #[serde(rename = "exitCode")]
        #[ts(rename = "exitCode")]
        exit_code: Option<i32>,
        #[ts(type = "number")]
        cursor: u64,
    },
    TimedOut {
        #[ts(type = "number")]
        cursor: u64,
    },
}

#[derive(Serialize, Deserialize, Clone, Debug, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../../src/lib/protocol.ts", rename_all = "camelCase")]
pub struct ProcessRemoved {
    pub workspace_id: String,
    pub id: String,
}

#[derive(Serialize, Deserialize, Clone, Debug, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../../src/lib/protocol.ts", rename_all = "camelCase")]
pub struct PtyResync {
    pub id: String,
}
