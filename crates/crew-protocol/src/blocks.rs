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

/// Who wrote a message, when it was not the user. Agents address each other by
/// name; the id is what the UI opens when you click it.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../../src/lib/protocol.ts", rename_all = "camelCase")]
pub struct AgentRef {
    pub id: String,
    pub name: String,
    /// Absent for an agent. `terminal` is a terminal session, which has no
    /// turns and so reads no reply; `user` is the person, from the `crew` CLI,
    /// who reads the reply in this chat.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub kind: Option<String>,
}

impl AgentRef {
    pub fn agent(id: impl Into<String>, name: impl Into<String>) -> Self {
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
    /// A file the agent wrote. The diff itself rides on the approval block.
    /// The counts are absent when the provider did not say — which is not the
    /// same as a write that changed nothing.
    Edit {
        path: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        #[ts(optional, type = "number")]
        added: Option<u32>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        #[ts(optional, type = "number")]
        removed: Option<u32>,
    },
    Search {
        query: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        #[ts(optional, type = "number")]
        matches: Option<u32>,
    },
    Fetch {
        url: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        #[ts(optional)]
        title: Option<String>,
    },
    /// One of Crew's own tools: a message to another agent.
    Message { to: String, text: String },
    /// Anything else: the result text, clipped.
    Output { text: String },
}

/// Transcripts are persisted, indexed and shipped over the websocket on every
/// reconnect, so a tool line keeps a readable excerpt, never the whole output.
pub const TOOL_TEXT_LIMIT: usize = 4096;

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

impl ToolDetail {
    /// Every detail that carries provider output goes through here before it is
    /// stored.
    pub fn clipped(self) -> Self {
        match self {
            ToolDetail::Command { command, exit_code, output } => ToolDetail::Command {
                command: clip(&command, TOOL_TEXT_LIMIT),
                exit_code,
                output: output.map(|text| clip(&text, TOOL_TEXT_LIMIT)),
            },
            ToolDetail::File { path, line_start, line_end, preview } => ToolDetail::File {
                path,
                line_start,
                line_end,
                preview: preview.map(|text| clip(&text, TOOL_TEXT_LIMIT)),
            },
            ToolDetail::Message { to, text } => ToolDetail::Message {
                to,
                text: clip(&text, TOOL_TEXT_LIMIT),
            },
            ToolDetail::Output { text } => ToolDetail::Output {
                text: clip(&text, TOOL_TEXT_LIMIT),
            },
            other => other,
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
    /// Set when another agent wrote this line instead of the user.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub from_agent: Option<AgentRef>,
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
        #[serde(default, rename = "fromAgent", skip_serializing_if = "Option::is_none")]
        #[ts(optional, rename = "fromAgent")]
        from_agent: Option<AgentRef>,
    },
    #[serde(rename = "system.message")]
    #[ts(rename = "system.message")]
    SystemMessage { text: String },
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
