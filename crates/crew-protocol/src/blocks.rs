use std::collections::HashMap;

use serde::{Deserialize, Serialize};
use serde_json::Value;
use ts_rs::TS;

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../../src/lib/protocol.ts", rename_all = "camelCase")]
pub enum BlockRole {
    User,
    Assistant,
    Reasoning,
    Tool,
    Approval,
    Question,
    System,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../../src/lib/protocol.ts", rename_all = "camelCase")]
pub enum ToolStatus {
    Pending,
    Completed,
    Failed,
    Interrupted,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../../src/lib/protocol.ts", rename_all = "camelCase")]
pub enum ApprovalDecision {
    Allow,
    Always,
    Deny,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../../src/lib/protocol.ts", rename_all = "camelCase")]
pub enum ApprovalResolution {
    Allow,
    Always,
    Deny,
    Cancelled,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../../src/lib/protocol.ts", rename_all = "camelCase")]
pub enum AttachedFileKind {
    Image,
    File,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../../src/lib/protocol.ts", rename_all = "camelCase")]
pub struct AttachedFile {
    pub name: String,
    pub path: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub kind: Option<AttachedFileKind>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional, type = "number")]
    pub size: Option<u64>,
}

/// Who wrote a message, when it was not the user. Bots address each other by
/// name; the id is what the UI opens when you click it.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../../src/lib/protocol.ts", rename_all = "camelCase")]
pub struct BotRef {
    pub id: String,
    pub name: String,
    /// Absent for a bot. `terminal` is a terminal session, which has no
    /// turns and so reads no reply; `user` is the person, from the `crew` CLI,
    /// who reads the reply in this chat.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub kind: Option<String>,
}

impl BotRef {
    pub fn bot(id: impl Into<String>, name: impl Into<String>) -> Self {
        Self { id: id.into(), name: name.into(), kind: None }
    }
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, TS)]
#[ts(export, export_to = "../../../src/lib/protocol.ts")]
pub struct QuestionOption {
    pub label: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub description: Option<String>,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../../src/lib/protocol.ts", rename_all = "camelCase")]
pub struct Question {
    pub question: String,
    pub header: String,
    pub multi_select: bool,
    pub options: Vec<QuestionOption>,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../../src/lib/protocol.ts", rename_all = "camelCase")]
pub struct TurnUsage {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional, type = "number")]
    pub input_tokens: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional, type = "number")]
    pub output_tokens: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional, type = "number")]
    pub cost_usd: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional, type = "number")]
    pub duration_ms: Option<u64>,
}

/// What a tool actually did, normalized across providers. A transcript line
/// reads the same whether it came from Claude's `Bash`, Codex's `exec_command`
/// or opencode's `bash`: the adapters translate into this, and the UI renders
/// one shape instead of four.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, TS)]
#[serde(tag = "kind", rename_all = "camelCase", rename_all_fields = "camelCase")]
#[ts(
    export,
    export_to = "../../../src/lib/protocol.ts",
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum ToolDetail {
    /// A shell command. `exitCode` is absent while it runs.
    Command {
        command: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        #[ts(optional, type = "number")]
        exit_code: Option<i32>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        #[ts(optional)]
        output: Option<String>,
    },
    /// A file the agent read, with the window it looked at.
    File {
        path: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        #[ts(optional, type = "number")]
        line_start: Option<u32>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        #[ts(optional, type = "number")]
        line_end: Option<u32>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        #[ts(optional)]
        preview: Option<String>,
    },
    /// A file the agent wrote. The counts are absent when the provider did not
    /// say — which is not the same as a write that changed nothing.
    Edit {
        path: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        #[ts(optional, type = "number")]
        added: Option<u32>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        #[ts(optional, type = "number")]
        removed: Option<u32>,
        /// The replacements as the call named them, when it named them and they
        /// fit: a write is one hunk with nothing before it. Absent when too big
        /// to keep, rather than kept in part: half a diff reads as a wrong one.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        #[ts(optional)]
        hunks: Option<Vec<EditHunk>>,
    },
    Search {
        query: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        #[ts(optional, type = "number")]
        matches: Option<u32>,
        /// What came back: the files, the lines, the results.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        #[ts(optional)]
        output: Option<String>,
    },
    Fetch {
        url: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        #[ts(optional)]
        title: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        #[ts(optional)]
        output: Option<String>,
    },
    /// One of Crew's own tools that writes to somebody: `send_message`, or
    /// `start_session` (whose prompt is the new session's first letter). What
    /// the call answered fills in the rest, once it answers.
    Message {
        /// Whom the call named: an id, a name, or for `start_session` the
        /// name it asked for.
        to: String,
        text: String,
        /// The letter the call made. The receiver's block carries the same
        /// id, and `thread_messages` lists it under it.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        #[ts(optional)]
        letter_id: Option<String>,
        /// The session it reached, by id.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        #[ts(optional)]
        to_id: Option<String>,
        /// That session's name when it was reached.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        #[ts(optional)]
        to_name: Option<String>,
        /// `start` (a session the caller owns) or `handoff` (one handed to
        /// the user) for `start_session`; absent for a message.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        #[ts(optional)]
        what: Option<String>,
        /// How it went over: `started`, `queued`, `steered` or `answered`.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        #[ts(optional)]
        delivery: Option<String>,
        /// Why Crew refused it: no letter was made.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        #[ts(optional)]
        error: Option<String>,
    },
    /// The agent's checklist, whole: every call restates all of it.
    Todo { items: Vec<TodoItem> },
    /// A subagent the agent handed part of the work to.
    Agent {
        description: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        #[ts(optional)]
        agent_type: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        #[ts(optional)]
        prompt: Option<String>,
        /// What it reported back.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        #[ts(optional)]
        output: Option<String>,
        /// It runs in the background: the call returned at once, and the
        /// subagent goes on after the turn that started it.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        #[ts(optional)]
        background: Option<bool>,
        /// Where it is, once the CLI said; absent, the call's own status
        /// stands for it.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        #[ts(optional)]
        state: Option<SubagentState>,
        /// What it is on now, in the CLI's words ("Reading a.txt").
        #[serde(default, skip_serializing_if = "Option::is_none")]
        #[ts(optional)]
        activity: Option<String>,
        /// Its own work, as blocks of the same shapes as the transcript's:
        /// its calls and what it wrote between them. Filled by
        /// `subagent.event`, never by the call's own updates.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        #[ts(optional)]
        steps: Option<Vec<Block>>,
    },
    /// A tool from an MCP server. `input` is the arguments as JSON.
    Mcp {
        server: String,
        tool: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        #[ts(optional)]
        input: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        #[ts(optional)]
        output: Option<String>,
    },
    /// A plan the agent proposed, in markdown.
    Plan { text: String },
    /// Anything else: the result text, clipped.
    Output { text: String },
}

/// Where a subagent is. A background one outlives the call that started it,
/// so the call's status cannot say.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../../src/lib/protocol.ts", rename_all = "camelCase")]
pub enum SubagentState {
    Running,
    Done,
    Failed,
    Stopped,
}

/// How much of each field a subagent's step keeps: a long run has many,
/// and they all live in the one row of the call that started it.
pub const STEP_TEXT_LIMIT: usize = 4 * 1024;

/// One replacement in a file: `before` became `after`.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, TS)]
#[ts(export, export_to = "../../../src/lib/protocol.ts")]
pub struct EditHunk {
    pub before: String,
    pub after: String,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../../src/lib/protocol.ts", rename_all = "camelCase")]
pub enum TodoStatus {
    Pending,
    InProgress,
    Completed,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, TS)]
#[ts(export, export_to = "../../../src/lib/protocol.ts")]
pub struct TodoItem {
    pub text: String,
    pub status: TodoStatus,
}

/// How much of a diff a tool line keeps, before and after together. A diff
/// is kept whole or not at all.
pub const EDIT_TEXT_LIMIT: usize = 16 * 1024;

/// Hunks that fit, or none: the row still shows the path and the counts.
pub fn edit_hunks(hunks: Vec<EditHunk>) -> Option<Vec<EditHunk>> {
    fits(&hunks, EDIT_TEXT_LIMIT).then_some(hunks)
}

fn fits(hunks: &[EditHunk], limit: usize) -> bool {
    let size: usize = hunks.iter().map(|hunk| hunk.before.len() + hunk.after.len()).sum();
    !hunks.is_empty() && size <= limit
}

/// Transcripts are persisted, indexed and shipped over the websocket on every
/// reconnect, so a tool line keeps a readable excerpt, never the whole output.
/// Enough for a test run's failures or a file's first few hundred lines; the
/// row folds anything long behind a line count.
pub const TOOL_TEXT_LIMIT: usize = 16 * 1024;

/// Clip on a char boundary and say how much was dropped, so the UI never has to
/// guess whether it is looking at everything.
pub fn clip(text: &str, limit: usize) -> String {
    if text.len() <= limit {
        return text.to_string();
    }
    let mut end = limit;
    while end > 0 && !text.is_char_boundary(end) {
        end -= 1;
    }
    let dropped = text.len() - end;
    format!("{}\n… {dropped} more bytes", &text[..end])
}

/// A subagent's step as it is kept: its text and its call's detail to
/// `STEP_TEXT_LIMIT`.
pub fn clipped_step(mut step: Block) -> Block {
    step.text = clip(&step.text, STEP_TEXT_LIMIT);
    if let Some(tool) = step.tool.as_mut() {
        tool.detail = tool.detail.take().map(|detail| detail.clipped_to(STEP_TEXT_LIMIT));
    }
    step
}

impl ToolDetail {
    /// Every detail that carries provider output goes through here before it is
    /// stored.
    pub fn clipped(self) -> Self {
        self.clipped_to(TOOL_TEXT_LIMIT)
    }

    /// `clipped`, to a limit of its own: a subagent's steps keep less.
    pub fn clipped_to(self, limit: usize) -> Self {
        match self {
            ToolDetail::Command { command, exit_code, output } => ToolDetail::Command {
                command: clip(&command, limit),
                exit_code,
                output: output.map(|text| clip(&text, limit)),
            },
            ToolDetail::File { path, line_start, line_end, preview } => ToolDetail::File {
                path,
                line_start,
                line_end,
                preview: preview.map(|text| clip(&text, limit)),
            },
            ToolDetail::Edit { path, added, removed, hunks } => ToolDetail::Edit {
                path,
                added,
                removed,
                hunks: hunks.filter(|hunks| fits(hunks, limit.min(EDIT_TEXT_LIMIT))),
            },
            ToolDetail::Search { query, matches, output } => ToolDetail::Search {
                query,
                matches,
                output: output.map(|text| clip(&text, limit)),
            },
            ToolDetail::Fetch { url, title, output } => ToolDetail::Fetch {
                url,
                title,
                output: output.map(|text| clip(&text, limit)),
            },
            ToolDetail::Message { to, text, letter_id, to_id, to_name, what, delivery, error } => ToolDetail::Message {
                to,
                text: clip(&text, limit),
                letter_id,
                to_id,
                to_name,
                what,
                delivery,
                error: error.map(|text| clip(&text, limit)),
            },
            ToolDetail::Todo { items } => ToolDetail::Todo {
                items: items
                    .into_iter()
                    .map(|item| TodoItem { text: clip(&item.text, 512.min(limit)), status: item.status })
                    .collect(),
            },
            ToolDetail::Agent { description, agent_type, prompt, output, background, state, activity, steps } => {
                ToolDetail::Agent {
                    description,
                    agent_type,
                    prompt: prompt.map(|text| clip(&text, limit)),
                    output: output.map(|text| clip(&text, limit)),
                    background,
                    state,
                    activity,
                    steps: steps.map(|steps| steps.into_iter().map(clipped_step).collect()),
                }
            }
            ToolDetail::Mcp { server, tool, input, output } => ToolDetail::Mcp {
                server,
                tool,
                input: input.map(|text| clip(&text, limit)),
                output: output.map(|text| clip(&text, limit)),
            },
            ToolDetail::Plan { text } => ToolDetail::Plan {
                text: clip(&text, limit),
            },
            ToolDetail::Output { text } => ToolDetail::Output {
                text: clip(&text, limit),
            },
        }
    }

    /// The one line a collapsed row shows. Never the output.
    pub fn summary(&self) -> String {
        match self {
            ToolDetail::Command { command, .. } => command.lines().next().unwrap_or("").to_string(),
            ToolDetail::File { path, .. } => path.clone(),
            ToolDetail::Edit { path, .. } => path.clone(),
            ToolDetail::Search { query, .. } => query.clone(),
            ToolDetail::Fetch { url, .. } => url.clone(),
            ToolDetail::Message { to, .. } => to.clone(),
            ToolDetail::Todo { items } => {
                let done = items.iter().filter(|item| item.status == TodoStatus::Completed).count();
                format!("{done}/{} done", items.len())
            }
            ToolDetail::Agent { description, .. } => description.clone(),
            ToolDetail::Mcp { server, tool, .. } => format!("{server} · {tool}"),
            ToolDetail::Plan { text } => text.lines().find(|line| !line.trim().is_empty()).unwrap_or("").to_string(),
            ToolDetail::Output { text } => text.lines().next().unwrap_or("").to_string(),
        }
    }
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../../src/lib/protocol.ts", rename_all = "camelCase")]
pub struct BlockTool {
    pub call_id: String,
    pub name: String,
    pub title: String,
    pub status: ToolStatus,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub detail: Option<ToolDetail>,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../../src/lib/protocol.ts", rename_all = "camelCase")]
pub struct BlockApproval {
    #[ts(type = "number")]
    pub request_id: u64,
    pub name: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional, type = "Record<string, unknown>")]
    pub input: Option<Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub decided: Option<ApprovalDecision>,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../../src/lib/protocol.ts", rename_all = "camelCase")]
pub struct BlockQuestion {
    #[ts(type = "number")]
    pub request_id: u64,
    pub questions: Vec<Question>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub answers: Option<HashMap<String, String>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub dismissed: Option<bool>,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../../src/lib/protocol.ts", rename_all = "camelCase")]
pub struct Block {
    pub id: String,
    pub role: BlockRole,
    pub text: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional, type = "number")]
    pub at: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub hidden: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub streaming: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub files: Option<Vec<AttachedFile>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub tool: Option<BlockTool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub approval: Option<BlockApproval>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub question: Option<BlockQuestion>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub usage: Option<TurnUsage>,
    /// Set when another bot wrote this line instead of the user.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub from_bot: Option<BotRef>,
    /// The letter this block shows, in the mailbox: on a user block a letter
    /// handed over; on a system line a session this one started or handed
    /// off ("Started session …"), or the user writing to its child ("You
    /// wrote to …"). The sender's tool row carries the same id.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub letter_id: Option<String>,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, TS)]
#[serde(tag = "type")]
#[ts(export, export_to = "../../../src/lib/protocol.ts", tag = "type")]
pub enum HarnessEvent {
    #[serde(rename = "session.started")]
    #[ts(rename = "session.started")]
    SessionStarted {},
    #[serde(rename = "session.ended")]
    #[ts(rename = "session.ended")]
    SessionEnded {
        #[serde(default, skip_serializing_if = "Option::is_none")]
        #[ts(optional, type = "number | null")]
        code: Option<i32>,
    },
    #[serde(rename = "session.error")]
    #[ts(rename = "session.error")]
    SessionError { message: String },
    #[serde(rename = "session.note")]
    #[ts(rename = "session.note")]
    SessionNote { message: String },
    #[serde(rename = "user.message")]
    #[ts(rename = "user.message")]
    UserMessage {
        text: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        #[ts(optional)]
        hidden: Option<bool>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        #[ts(optional)]
        files: Option<Vec<AttachedFile>>,
        // Named as the block is: one spelling on the wire, so a reducer that
        // reads it off the event cannot miss it.
        #[serde(default, rename = "fromBot", skip_serializing_if = "Option::is_none")]
        #[ts(optional, rename = "fromBot")]
        from_bot: Option<BotRef>,
        #[serde(default, rename = "letterId", skip_serializing_if = "Option::is_none")]
        #[ts(optional, rename = "letterId")]
        letter_id: Option<String>,
    },
    #[serde(rename = "system.message")]
    #[ts(rename = "system.message")]
    SystemMessage {
        text: String,
        #[serde(default, rename = "letterId", skip_serializing_if = "Option::is_none")]
        #[ts(optional, rename = "letterId")]
        letter_id: Option<String>,
    },
    #[serde(rename = "session.providerBound")]
    #[ts(rename = "session.providerBound")]
    SessionProviderBound {
        #[serde(rename = "providerSessionId")]
        provider_session_id: String,
    },
    #[serde(rename = "message.delta")]
    #[ts(rename = "message.delta")]
    MessageDelta { text: String },
    #[serde(rename = "message.completed")]
    #[ts(rename = "message.completed")]
    MessageCompleted {},
    #[serde(rename = "reasoning.delta")]
    #[ts(rename = "reasoning.delta")]
    ReasoningDelta { text: String },
    #[serde(rename = "turn.completed")]
    #[ts(rename = "turn.completed")]
    TurnCompleted {
        #[serde(default, skip_serializing_if = "Option::is_none")]
        #[ts(optional)]
        usage: Option<TurnUsage>,
    },
    #[serde(rename = "tool.started")]
    #[ts(rename = "tool.started")]
    ToolStarted {
        #[serde(rename = "callId")]
        call_id: String,
        name: String,
        title: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        #[ts(optional)]
        detail: Option<ToolDetail>,
    },
    #[serde(rename = "tool.updated")]
    #[ts(rename = "tool.updated")]
    ToolUpdated {
        #[serde(rename = "callId")]
        call_id: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        #[ts(optional)]
        title: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        #[ts(optional)]
        status: Option<ToolStatus>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        #[ts(optional)]
        detail: Option<ToolDetail>,
    },
    /// Something a subagent did, nested under the call that started it: its
    /// own text and calls, applied to that call's `steps` as the transcript
    /// applies the agent's. Never a block of the transcript itself, so a
    /// subagent's words never read as the agent's reply.
    #[serde(rename = "subagent.event")]
    #[ts(rename = "subagent.event")]
    SubagentEvent {
        #[serde(rename = "callId")]
        call_id: String,
        event: Box<HarnessEvent>,
    },
    /// Where a subagent is, and what it is on, as the CLI reports it.
    #[serde(rename = "subagent.updated")]
    #[ts(rename = "subagent.updated")]
    SubagentUpdated {
        #[serde(rename = "callId")]
        call_id: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        #[ts(optional)]
        state: Option<SubagentState>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        #[ts(optional)]
        activity: Option<String>,
        /// Its report, when it came this way rather than as the call's result.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        #[ts(optional)]
        output: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        #[ts(optional)]
        background: Option<bool>,
    },
    #[serde(rename = "approval.requested")]
    #[ts(rename = "approval.requested")]
    ApprovalRequested {
        #[serde(rename = "requestId")]
        #[ts(type = "number")]
        request_id: u64,
        name: String,
        title: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        #[ts(optional, type = "Record<string, unknown>")]
        input: Option<Value>,
    },
    #[serde(rename = "approval.resolved")]
    #[ts(rename = "approval.resolved")]
    ApprovalResolved {
        #[serde(rename = "requestId")]
        #[ts(type = "number")]
        request_id: u64,
        decision: ApprovalResolution,
    },
    #[serde(rename = "question.requested")]
    #[ts(rename = "question.requested")]
    QuestionRequested {
        #[serde(rename = "requestId")]
        #[ts(type = "number")]
        request_id: u64,
        questions: Vec<Question>,
    },
    #[serde(rename = "question.resolved")]
    #[ts(rename = "question.resolved")]
    QuestionResolved {
        #[serde(rename = "requestId")]
        #[ts(type = "number")]
        request_id: u64,
        answers: Option<HashMap<String, String>>,
    },
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn clip_keeps_short_text_intact() {
        assert_eq!(clip("echo hi", TOOL_TEXT_LIMIT), "echo hi");
    }

    #[test]
    fn clip_never_splits_a_multibyte_char() {
        // A limit that lands mid-character: the cut walks back to the boundary
        // instead of panicking on a slice.
        let text = "áéíóú".repeat(4);
        let clipped = clip(&text, 5);
        assert!(text.starts_with(clipped.split('\n').next().unwrap()));
        assert!(clipped.contains("more bytes"));
    }

    #[test]
    fn clipped_trims_command_output_but_keeps_the_exit_code() {
        let detail = ToolDetail::Command {
            command: "ls".into(),
            exit_code: Some(0),
            output: Some("x".repeat(TOOL_TEXT_LIMIT * 2)),
        }
        .clipped();
        let ToolDetail::Command { output, exit_code, .. } = detail else {
            panic!("kind changed");
        };
        assert_eq!(exit_code, Some(0));
        assert!(output.unwrap().len() < TOOL_TEXT_LIMIT + 64);
    }

    #[test]
    fn summary_is_the_first_line_of_a_command() {
        let detail = ToolDetail::Command {
            command: "git status\ngit log".into(),
            exit_code: None,
            output: None,
        };
        assert_eq!(detail.summary(), "git status");
    }
}
