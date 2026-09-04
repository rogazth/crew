use std::collections::HashMap;

use serde::{Deserialize, Serialize};
use serde_json::Value;
use ts_rs::TS;

#[derive(Serialize, Deserialize, Clone, Debug, TS)]
#[ts(export, export_to = "../../../src/lib/protocol.ts")]
pub struct Auth {
    pub auth: String,
}

#[derive(Serialize, Deserialize, Clone, Debug, TS)]
#[ts(export, export_to = "../../../src/lib/protocol.ts")]
pub struct Request {
    pub id: u32,
    pub method: String,
    #[ts(type = "unknown")]
    pub params: Value,
}

#[derive(Serialize, Deserialize, Clone, Debug, TS)]
#[ts(export, export_to = "../../../src/lib/protocol.ts")]
pub struct Response {
    pub id: u32,
    pub ok: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    #[ts(optional, type = "unknown")]
    pub result: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub error: Option<String>,
}

#[derive(Serialize, Deserialize, Clone, Debug, TS)]
#[ts(export, export_to = "../../../src/lib/protocol.ts")]
pub struct Event {
    pub event: String,
    #[ts(type = "unknown")]
    pub payload: Value,
}

#[derive(Serialize, Deserialize, Clone, Debug, TS)]
#[ts(export, export_to = "../../../src/lib/protocol.ts")]
pub struct DaemonInfo {
    pub url: String,
    pub token: String,
}

#[derive(Serialize, Deserialize, Clone, Debug, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../../src/lib/protocol.ts", rename_all = "camelCase")]
pub struct PtySpawn {
    pub id: String,
    pub cwd: String,
    pub command: Vec<String>,
    pub cols: u16,
    pub rows: u16,
}

#[derive(Serialize, Deserialize, Clone, Debug, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../../src/lib/protocol.ts", rename_all = "camelCase")]
pub struct PtyWrite {
    pub id: String,
    pub data: String,
}

#[derive(Serialize, Deserialize, Clone, Debug, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../../src/lib/protocol.ts", rename_all = "camelCase")]
pub struct PtyResize {
    pub id: String,
    pub cols: u16,
    pub rows: u16,
}

#[derive(Serialize, Deserialize, Clone, Debug, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../../src/lib/protocol.ts", rename_all = "camelCase")]
pub struct PtyAck {
    pub id: String,
    #[ts(type = "number")]
    pub processed: u64,
}

#[derive(Serialize, Deserialize, Clone, Debug, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../../src/lib/protocol.ts", rename_all = "camelCase")]
pub struct PtyKill {
    pub id: String,
}

#[derive(Serialize, Deserialize, Clone, Debug, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../../src/lib/protocol.ts", rename_all = "camelCase")]
pub struct PtyAttach {
    pub id: String,
    #[ts(type = "number")]
    pub from: u64,
}

#[derive(Serialize, Deserialize, Clone, Debug, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../../src/lib/protocol.ts", rename_all = "camelCase")]
pub struct PtyAttached {
    #[ts(type = "number")]
    pub start: u64,
    #[ts(type = "number")]
    pub emitted: u64,
}

#[derive(Serialize, Deserialize, Clone, Debug, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../../src/lib/protocol.ts", rename_all = "camelCase")]
pub struct PtyExit {
    pub id: String,
    pub code: Option<i32>,
}

#[derive(Serialize, Deserialize, Clone, Debug, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../../src/lib/protocol.ts", rename_all = "camelCase")]
pub struct PtyError {
    pub id: String,
    pub error: String,
}

pub fn ok(id: u32, result: Value) -> Response {
    Response {
        id,
        ok: true,
        result: Some(result),
        error: None,
    }
}

pub fn err(id: u32, error: impl Into<String>) -> Response {
    Response {
        id,
        ok: false,
        result: None,
        error: Some(error.into()),
    }
}

#[derive(Serialize, Deserialize, Clone, Debug, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../../src/lib/protocol.ts", rename_all = "camelCase")]
pub struct AgentLines {
    pub session_id: String,
    pub lines: Vec<String>,
}

#[derive(Serialize, Deserialize, Clone, Debug, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../../src/lib/protocol.ts", rename_all = "camelCase")]
pub struct AgentExit {
    pub session_id: String,
    pub code: Option<i32>,
    pub pid: u32,
}

#[derive(Serialize, Deserialize, Clone, Debug, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../../src/lib/protocol.ts", rename_all = "camelCase")]
pub struct ToolCall {
    #[ts(type = "number")]
    pub id: u64,
    pub session_id: String,
    pub method: String,
    #[ts(type = "unknown")]
    pub params: Value,
}

#[derive(Serialize, Deserialize, Clone, Debug, TS)]
#[ts(export, export_to = "../../../src/lib/protocol.ts")]
pub struct Id {
    pub id: String,
}

#[derive(Serialize, Deserialize, Clone, Debug, TS)]
#[ts(export, export_to = "../../../src/lib/protocol.ts")]
pub struct OptionalId {
    pub id: Option<String>,
}

#[derive(Serialize, Deserialize, Clone, Debug, TS)]
#[ts(export, export_to = "../../../src/lib/protocol.ts")]
pub struct Ids {
    pub ids: Vec<String>,
}

#[derive(Serialize, Deserialize, Clone, Debug, TS)]
#[ts(export, export_to = "../../../src/lib/protocol.ts")]
pub struct IdName {
    pub id: String,
    pub name: String,
}

#[derive(Serialize, Deserialize, Clone, Debug, TS)]
#[ts(export, export_to = "../../../src/lib/protocol.ts")]
pub struct NamePath {
    pub name: String,
    pub path: String,
}

#[derive(Serialize, Deserialize, Clone, Debug, TS)]
#[ts(export, export_to = "../../../src/lib/protocol.ts")]
pub struct Name {
    pub name: String,
}

#[derive(Serialize, Deserialize, Clone, Debug, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../../src/lib/protocol.ts", rename_all = "camelCase")]
pub struct WorkspaceId {
    pub workspace_id: String,
}

#[derive(Serialize, Deserialize, Clone, Debug, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../../src/lib/protocol.ts", rename_all = "camelCase")]
pub struct SessionId {
    pub session_id: String,
}

#[derive(Serialize, Deserialize, Clone, Debug, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../../src/lib/protocol.ts", rename_all = "camelCase")]
pub struct SessionCreate {
    pub workspace_id: String,
    pub kind: String,
    pub name: String,
    pub provider: String,
    pub model: String,
    pub description: String,
    pub autonomy: String,
}

#[derive(Serialize, Deserialize, Clone, Debug, TS)]
#[ts(export, export_to = "../../../src/lib/protocol.ts")]
pub struct SessionUpdate {
    pub id: String,
    pub name: String,
    pub provider: String,
    pub model: String,
    pub description: String,
    pub notifications: bool,
    pub autonomy: String,
}

#[derive(Serialize, Deserialize, Clone, Debug, TS)]
#[ts(export, export_to = "../../../src/lib/protocol.ts")]
pub struct IdStatus {
    pub id: String,
    pub status: String,
}

#[derive(Serialize, Deserialize, Clone, Debug, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../../src/lib/protocol.ts", rename_all = "camelCase")]
pub struct IdBlocks {
    pub id: String,
    pub blocks_json: String,
}

#[derive(Serialize, Deserialize, Clone, Debug, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../../src/lib/protocol.ts", rename_all = "camelCase")]
pub struct IdProvider {
    pub id: String,
    pub provider_session_id: String,
}

#[derive(Serialize, Deserialize, Clone, Debug, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../../src/lib/protocol.ts", rename_all = "camelCase")]
pub struct RoutineUpsert {
    pub id: Option<String>,
    pub session_id: String,
    pub name: String,
    pub enabled: bool,
    pub prompt: String,
    pub schedule: String,
    #[ts(optional, type = "number")]
    pub next_run_at: Option<i64>,
    pub created_by: Option<String>,
}

#[derive(Serialize, Deserialize, Clone, Debug, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../../src/lib/protocol.ts", rename_all = "camelCase")]
pub struct RoutineMark {
    pub id: String,
    #[ts(type = "number")]
    pub last_run_at: i64,
    #[ts(optional, type = "number")]
    pub next_run_at: Option<i64>,
    pub runs_json: String,
}

#[derive(Serialize, Deserialize, Clone, Debug, TS)]
#[ts(export, export_to = "../../../src/lib/protocol.ts")]
pub struct Key {
    pub key: String,
}

#[derive(Serialize, Deserialize, Clone, Debug, TS)]
#[ts(export, export_to = "../../../src/lib/protocol.ts")]
pub struct KeyValue {
    pub key: String,
    pub value: String,
}

#[derive(Serialize, Deserialize, Clone, Debug, TS)]
#[ts(export, export_to = "../../../src/lib/protocol.ts")]
pub struct Cwd {
    pub cwd: String,
}

#[derive(Serialize, Deserialize, Clone, Debug, TS)]
#[ts(export, export_to = "../../../src/lib/protocol.ts")]
pub struct PathArg {
    pub path: String,
}

#[derive(Serialize, Deserialize, Clone, Debug, TS)]
#[ts(export, export_to = "../../../src/lib/protocol.ts")]
pub struct PathContents {
    pub path: String,
    pub contents: String,
}

#[derive(Serialize, Deserialize, Clone, Debug, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../../src/lib/protocol.ts", rename_all = "camelCase")]
pub struct TempFile {
    pub extension: String,
    pub base64_contents: String,
}

#[derive(Serialize, Deserialize, Clone, Debug, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../../src/lib/protocol.ts", rename_all = "camelCase")]
pub struct AgentSpawn {
    pub session_id: String,
    pub command: String,
    pub args: Vec<String>,
    pub cwd: String,
    pub env: Option<HashMap<String, String>>,
}

#[derive(Serialize, Deserialize, Clone, Debug, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../../src/lib/protocol.ts", rename_all = "camelCase")]
pub struct SessionLine {
    pub session_id: String,
    pub line: String,
}

#[derive(Serialize, Deserialize, Clone, Debug, TS)]
#[ts(export, export_to = "../../../src/lib/protocol.ts")]
pub struct BridgeReply {
    #[ts(type = "number")]
    pub id: u64,
    #[ts(type = "unknown")]
    pub response: Value,
}

#[derive(Serialize, Deserialize, Clone, Debug, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../../src/lib/protocol.ts", rename_all = "camelCase")]
pub struct Workspace {
    pub id: String,
    pub name: String,
    pub path: String,
    #[ts(type = "number")]
    pub created_at: i64,
}

#[derive(Serialize, Deserialize, Clone, Debug, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../../src/lib/protocol.ts", rename_all = "camelCase")]
pub struct Session {
    pub id: String,
    pub workspace_id: String,
    pub kind: String,
    pub name: String,
    pub provider: String,
    pub model: String,
    pub provider_session_id: Option<String>,
    pub description: String,
    pub notifications: bool,
    pub autonomy: String,
    pub status: String,
    #[ts(type = "number")]
    pub created_at: i64,
    #[ts(type = "number")]
    pub updated_at: i64,
}

#[derive(Serialize, Deserialize, Clone, Debug, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../../src/lib/protocol.ts", rename_all = "camelCase")]
pub struct Routine {
    pub id: String,
    pub session_id: String,
    pub name: String,
    pub enabled: bool,
    pub prompt: String,
    pub schedule: String,
    #[ts(optional, type = "number")]
    pub last_run_at: Option<i64>,
    #[ts(optional, type = "number")]
    pub next_run_at: Option<i64>,
    pub runs_json: String,
    pub created_by: Option<String>,
}

#[derive(Serialize, Deserialize, Clone, Debug, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../../src/lib/protocol.ts", rename_all = "camelCase")]
pub struct ScheduledRoutine {
    pub routine: Routine,
    pub session: Session,
    pub cwd: String,
}

#[derive(Serialize, Deserialize, Clone, Debug, TS)]
#[ts(export, export_to = "../../../src/lib/protocol.ts")]
pub struct AgentBinary {
    pub path: String,
}

#[derive(Serialize, Deserialize, Clone, Debug, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../../src/lib/protocol.ts", rename_all = "camelCase")]
pub struct ProjectFile {
    pub name: String,
    pub path: String,
    pub relative: String,
}

#[derive(Serialize, Deserialize, Clone, Debug, TS)]
#[ts(export, export_to = "../../../src/lib/protocol.ts")]
pub struct FileBytes {
    pub mime: String,
    pub data: String,
}

#[derive(Serialize, Deserialize, Clone, Debug, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../../src/lib/protocol.ts", rename_all = "camelCase")]
pub struct BridgeInfo {
    pub socket_path: String,
    pub token: String,
    pub exe: String,
}

pub fn event(event: impl Into<String>, payload: impl Serialize) -> Result<Event, serde_json::Error> {
    Ok(Event {
        event: event.into(),
        payload: serde_json::to_value(payload)?,
    })
}
