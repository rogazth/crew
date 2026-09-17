pub mod claude;
pub mod codex;
pub mod cursor;
pub mod opencode;
pub mod runtime;

pub use runtime::{Autonomy, InlineImage};

use serde_json::{Map, Value};

pub fn as_record(value: &Value) -> Option<&Map<String, Value>> {
    value.as_object()
}

pub fn as_record_owned(value: &Value) -> Option<Map<String, Value>> {
    value.as_object().cloned()
}

pub fn string_field(rec: Option<&Map<String, Value>>, key: &str) -> Option<String> {
    rec.and_then(|map| map.get(key))
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string)
}

/// The bare name of a Crew tool, whatever the provider prefixed it with:
/// Claude and Codex namespace MCP tools `mcp__crew__x`, opencode `crew_x`.
pub fn crew_tool(name: &str) -> Option<&str> {
    name.strip_prefix("mcp__crew__")
        .or_else(|| name.strip_prefix("crew_"))
        .filter(|verb| !verb.is_empty())
}

/// What a Crew tool did, for the one that is worth reading in a transcript: a
/// message to another agent is half of a conversation happening in two places.
pub fn crew_tool_detail(name: &str, input: &Map<String, Value>) -> Option<crew_protocol::ToolDetail> {
    if crew_tool(name)? != "message_agent" {
        return None;
    }
    Some(crew_protocol::ToolDetail::Message {
        to: string_field(Some(input), "to")?,
        text: string_field(Some(input), "text").unwrap_or_default(),
    })
}

pub fn parse_json_line(line: &str) -> Option<Map<String, Value>> {
    let trimmed = line.trim();
    if !trimmed.starts_with('{') {
        return None;
    }
    serde_json::from_str::<Value>(trimmed)
        .ok()
        .and_then(|value| value.as_object().cloned())
}

pub fn try_parse_json_record(value: &str) -> Option<Map<String, Value>> {
    serde_json::from_str::<Value>(value)
        .ok()
        .and_then(|parsed| parsed.as_object().cloned())
}

pub fn finite_number(value: Option<&Value>) -> Option<f64> {
    value.and_then(Value::as_f64).filter(|n| n.is_finite())
}

pub fn clip(value: &str, max: usize) -> String {
    let line = value.split('\n').next().unwrap_or(value);
    if line.chars().count() > max {
        let take = max.saturating_sub(1);
        format!("{}…", line.chars().take(take).collect::<String>())
    } else {
        line.to_string()
    }
}

pub fn leaf(path: &str) -> String {
    let normalized = path.replace('\\', "/");
    normalized
        .rsplit('/')
        .next()
        .filter(|part| !part.is_empty())
        .unwrap_or(path)
        .to_string()
}
