//! The parts of a 1.x opencode message, as the 1.x history reader finds them
//! in `opencode.db`'s `part` table: `{"part": data}`, the shape `opencode run`
//! printed. Crew no longer runs 1.x; these go with the reader when it moves
//! to 2.x's `session_message` (step 5 task 10). What a tool did is read by
//! the same code the 2.x driver uses.

use crew_protocol::{ToolDetail, ToolStatus, TurnUsage};
use serde_json::{Map, Value};

use crate::providers::opencode::{add_usage, finish_failure, tool_detail, tool_label, tool_status, ToolEnd};
use crate::providers::{as_record, as_record_owned, string_field};

fn event_part(rec: &Map<String, Value>) -> Option<&Map<String, Value>> {
    rec.get("part").and_then(as_record)
}

pub struct OpencodeText {
    pub text: String,
}

/// A text part carries its whole text.
pub fn text_part(rec: &Map<String, Value>) -> Option<OpencodeText> {
    let part = event_part(rec)?;
    if string_field(Some(part), "type").as_deref() != Some("text") {
        return None;
    }
    let text = part.get("text").and_then(Value::as_str).filter(|text| !text.is_empty())?;
    Some(OpencodeText { text: text.to_string() })
}

pub struct OpencodeToolCall {
    pub call_id: String,
    pub name: String,
    pub title: String,
    pub detail: Option<ToolDetail>,
    pub status: ToolStatus,
}

/// A tool part, settled: its state holds the input, and once it ran the
/// output or the error.
pub fn parse_tool_call(rec: &Map<String, Value>) -> Option<OpencodeToolCall> {
    let part = event_part(rec)?;
    if string_field(Some(part), "type").as_deref() != Some("tool") {
        return None;
    }
    let call_id = string_field(Some(part), "callID")?;
    let name = string_field(Some(part), "tool").unwrap_or_else(|| "tool".into());
    let state = part.get("state").and_then(as_record);
    let input = state.and_then(|row| row.get("input")).and_then(as_record_owned).unwrap_or_default();
    let text = |key: &str| state?.get(key).and_then(Value::as_str).filter(|text| !text.is_empty()).map(str::to_string);
    let status = state.and_then(|state| state.get("status")).and_then(Value::as_str);
    let end = ToolEnd {
        // A part printed at all has run: one with no status reads as done.
        status: Some(status.filter(|status| *status == "error").unwrap_or("completed")),
        output: text("output"),
        error: string_field(state, "error"),
        metadata: state.and_then(|state| state.get("metadata")).and_then(as_record),
    };
    Some(OpencodeToolCall {
        title: tool_label(&name, &input),
        detail: tool_detail(&name, &input, &end),
        status: tool_status(&name, &end),
        call_id,
        name,
    })
}

/// Why a step stopped, when that is not "it called tools" or "it answered".
pub fn step_failure(rec: &Map<String, Value>) -> Option<String> {
    finish_failure(&string_field(event_part(rec), "reason")?)
}

/// `tool-calls` means the model is coming back for another step; every other
/// reason ends the turn.
pub fn turn_ended(rec: &Map<String, Value>) -> bool {
    string_field(event_part(rec), "reason").as_deref() != Some("tool-calls")
}

/// A step's usage added to the turn's: the part carries its tokens and cost.
pub fn add_step_usage(prev: Option<&TurnUsage>, rec: &Map<String, Value>) -> TurnUsage {
    add_usage(prev, rec.get("part").unwrap_or(&Value::Null))
}

pub fn stream_error_message(rec: &Map<String, Value>) -> String {
    let error = rec.get("error").and_then(as_record);
    string_field(error.and_then(|error| error.get("data")).and_then(as_record), "message")
        .or_else(|| string_field(error, "name"))
        .unwrap_or_else(|| "opencode turn failed.".into())
}
