pub mod claude;
pub mod codex;
pub mod cursor;
pub mod runtime;

pub use runtime::{Autonomy, InlineImage, ProviderRuntime, TurnInput};

pub fn runtime_for(id: &str) -> Option<&'static dyn ProviderRuntime> {
    match id {
        "claude" => Some(&claude::ClaudeRuntime),
        "codex" => Some(&codex::CodexRuntime),
        "cursor" => Some(&cursor::CursorRuntime),
        _ => None,
    }
}

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
