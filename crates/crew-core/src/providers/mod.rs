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

/// What every provider is told before the first word of the conversation.
///
/// It says where the agent is and what the reply is for, and stops there. How
/// the model writes is the model's; a house style here would reach every agent
/// the user ever makes, and they did not ask for one.
///
/// Every turn gets this, because every turn is a new session. The date is part
/// of it for the same reason: a model with no session behind it has no way to
/// know what day it is except the one it was trained on.
pub fn persona_prompt(name: &str, description: &str, tools: Option<&str>) -> String {
    let who = match name.trim() {
        "" => "the user's agent",
        named => named,
    };
    let job = description.trim();
    let rules = format!(
        "You are chatting inside Crew, a desktop app. Today is {}. Your reply is read by the user \
         in a chat window, next to the tools you ran: do the work first, then say what happened.",
        today()
    );
    let persona = if job.is_empty() {
        format!("You are {who}. {rules}")
    } else {
        format!("You are {who}. {job}\n\n{rules}")
    };
    match tools {
        Some(tools) if !tools.is_empty() => format!("{persona}\n\n{tools}"),
        _ => persona,
    }
}

/// The machine's own date, the way a person here would write it.
fn today() -> String {
    const DAYS: [&str; 7] = [
        "Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday",
    ];
    const MONTHS: [&str; 12] = [
        "January", "February", "March", "April", "May", "June", "July", "August", "September",
        "October", "November", "December",
    ];
    let secs = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|since| since.as_secs() as libc::time_t)
        .unwrap_or(0);
    let mut tm: libc::tm = unsafe { std::mem::zeroed() };
    unsafe {
        libc::localtime_r(&secs, &mut tm);
    }
    let day = DAYS.get(tm.tm_wday.clamp(0, 6) as usize).copied().unwrap_or("");
    let month = MONTHS.get(tm.tm_mon.clamp(0, 11) as usize).copied().unwrap_or("");
    format!("{day}, {} {month} {}", tm.tm_mday, tm.tm_year + 1900)
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_persona_names_the_agent_and_its_job() {
        let prompt = persona_prompt("Planner", "You keep the roadmap.", None);
        assert!(prompt.starts_with("You are Planner. You keep the roadmap."), "{prompt}");
        assert!(prompt.contains("chatting inside Crew"), "{prompt}");
    }

    #[test]
    fn an_agent_with_no_job_is_still_somebody() {
        let prompt = persona_prompt("Planner", "   ", None);
        assert!(prompt.starts_with("You are Planner. You are chatting"), "{prompt}");
        let unnamed = persona_prompt("  ", "", None);
        assert!(unnamed.starts_with("You are the user's agent."), "{unnamed}");
    }

    /// The user asked for a harness that does not tell the model how to talk.
    /// This is a blocklist, not the property: it catches the house style that
    /// used to be here coming back, which is the thing worth catching.
    #[test]
    fn the_persona_does_not_dictate_a_voice() {
        let prompt = persona_prompt("Planner", "You keep the roadmap.", None).to_lowercase();
        for dictated in ["short", "concise", "brief", "no headers", "no preamble", "tone"] {
            assert!(!prompt.contains(dictated), "the persona still dictates \"{dictated}\": {prompt}");
        }
    }

    /// A clean session per turn means the model has no conversation behind it
    /// to date itself from.
    #[test]
    fn the_persona_says_what_day_it_is() {
        let prompt = persona_prompt("Planner", "", None);
        let today = today();
        assert!(prompt.contains(&format!("Today is {today}.")), "{prompt}");
        assert!(today.contains(", "), "the date reads as a date: {today}");
    }

    #[test]
    fn the_tool_sheet_goes_last_and_only_when_there_is_one() {
        let with = persona_prompt("Planner", "", Some("You have: message_agent."));
        assert!(with.ends_with("\n\nYou have: message_agent."), "{with}");
        assert_eq!(persona_prompt("Planner", "", Some("")), persona_prompt("Planner", "", None));
    }
}
