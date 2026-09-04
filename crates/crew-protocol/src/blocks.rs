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

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../../src/lib/protocol.ts", rename_all = "camelCase")]
pub struct BlockTool {
    pub call_id: String,
    pub name: String,
    pub title: String,
    pub status: ToolStatus,
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
