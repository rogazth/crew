use serde_json::{json, Value};

use crate::mailbox::{self, Letter};
use crate::routine::{self, Routine};
use crate::schedule::{describe_schedule, next_run, parse_schedule, schedule_help, validate_schedule};
use crate::session::{self, Session};
use crate::store::{now_millis, Store};
use crate::transcript::TranscriptHub;

const PROVIDERS: &[(&str, &[&str])] = &[
    (
        "claude",
        &[
            "claude-opus-5",
            "claude-sonnet-5",
            "claude-fable-5-1",
            "claude-haiku-4-5-20251001",
        ],
    ),
    ("cursor", &["grok-4.6", "composer-1"]),
    ("codex", &["gpt-5.6-codex", "gpt-5.6"]),
];

struct Tool {
    name: &'static str,
    description: &'static str,
    schema: Value,
    /// Words someone would search for that the name and description miss.
    keywords: &'static [&'static str],
    /// Listed to every agent on every turn. Everything else is found with
    /// `find_tool`: a roster of a hundred tools would cost more prompt than the
    /// conversation, and most turns need none of them.
    core: bool,
}

fn catalog() -> Vec<Tool> {
    let schedule = json!({
        "type": "object",
        "description": schedule_help(),
        "properties": {
            "kind": { "type": "string", "enum": ["interval", "daily", "cron"] },
            "minutes": { "type": "integer", "minimum": 1 },
            "hour": { "type": "integer", "minimum": 0, "maximum": 23 },
            "minute": { "type": "integer", "minimum": 0, "maximum": 59 },
            "days": { "type": "array", "items": { "type": "integer", "minimum": 0, "maximum": 6 } },
            "expression": { "type": "string", "description": "Five-field cron, local time." }
        },
        "required": ["kind"]
    });
    vec![
        Tool {
            name: "list_agents",
            description: "List the agents in this workspace, including yourself.",
            schema: json!({ "type": "object", "properties": {} }),
            keywords: &["roster", "team", "who", "agents"],
            core: true,
        },
        Tool {
            name: "create_agent",
            description: "Create a new agent in this workspace. It stays idle until the user messages it or a routine wakes it. Provider and model default to yours; autonomy defaults to ask.",
            schema: json!({
                "type": "object",
                "properties": {
                    "name": { "type": "string" },
                    "description": { "type": "string", "description": "Its job, written as instructions to it." },
                    "provider": { "type": "string", "enum": ["claude", "cursor", "codex"] },
                    "model": { "type": "string" },
                    "autonomy": { "type": "string", "enum": ["ask", "full"] }
                },
                "required": ["name", "description"]
            }),
            keywords: &["new", "hire", "spawn", "agent"],
            core: false,
        },
        Tool {
            name: "message_agent",
            description: "Send a message to another agent in this workspace. It arrives as a turn with your name on it and is answered in its own time; you are not waiting for a reply, and a reply comes back as a message to you. If the agent is busy the message waits in its box.",
            schema: json!({
                "type": "object",
                "properties": {
                    "to": { "type": "string", "description": "The agent's name or id. Use list_agents if unsure." },
                    "text": { "type": "string", "description": "What to say. Give it everything it needs; it cannot see your conversation." }
                },
                "required": ["to", "text"]
            }),
            keywords: &["send", "tell", "ask", "dm", "reply", "message"],
            core: true,
        },
        Tool {
            name: "search_messages",
            description: "Search every message in this workspace: yours, the user's, and other agents'. Use it before asking the user something they may already have said.",
            schema: json!({
                "type": "object",
                "properties": {
                    "query": { "type": "string", "description": "Words to look for." },
                    "agent_id": { "type": "string", "description": "Only this agent's conversation. Omit for all of them." },
                    "days": { "type": "integer", "minimum": 1, "description": "Only the last N days. Omit for all of time." },
                    "limit": { "type": "integer", "minimum": 1, "maximum": 50 }
                },
                "required": ["query"]
            }),
            keywords: &["find", "grep", "history", "transcript", "said"],
            core: true,
        },
        Tool {
            name: "list_routines",
            description: "List the routines of an agent: standing orders that wake it on a schedule with a saved prompt. Defaults to your own.",
            schema: json!({
                "type": "object",
                "properties": { "agent_id": { "type": "string", "description": "Omit for yourself." } }
            }),
            keywords: &["schedule", "cron", "standing", "orders"],
            core: false,
        },
        Tool {
            name: "upsert_routine",
            description: "Create a routine, or update one by routine_id. Times are the user's local time.",
            schema: json!({
                "type": "object",
                "properties": {
                    "routine_id": { "type": "string", "description": "Set to update an existing routine." },
                    "agent_id": { "type": "string", "description": "Whose routine. Omit for yourself." },
                    "name": { "type": "string" },
                    "prompt": { "type": "string", "description": "What the agent does each time it fires." },
                    "schedule": schedule,
                    "enabled": { "type": "boolean" }
                }
            }),
            keywords: &["schedule", "cron", "every", "daily", "remind"],
            core: false,
        },
        Tool {
            name: "delete_routine",
            description: "Delete a routine by id. Works on any agent in this workspace.",
            schema: json!({
                "type": "object",
                "properties": { "routine_id": { "type": "string" } },
                "required": ["routine_id"]
            }),
            keywords: &["schedule", "cron", "stop", "remove"],
            core: false,
        },
    ]
}

/// The two tools that stand in for everything not listed. They are described
/// so an agent reaches for them instead of guessing a name.
fn gateway() -> Vec<Tool> {
    vec![
        Tool {
            name: "find_tool",
            description: "Search the tools Crew gives you beyond the few always listed. Returns each match with its arguments, ready to call. Try it before deciding something is impossible here.",
            schema: json!({
                "type": "object",
                "properties": {
                    "query": { "type": "string", "description": "What you are trying to do, in your own words." },
                    "limit": { "type": "integer", "minimum": 1, "maximum": 20 }
                },
                "required": ["query"]
            }),
            keywords: &[],
            core: false,
        },
        Tool {
            name: "call_tool",
            description: "Run a tool that find_tool returned.",
            schema: json!({
                "type": "object",
                "properties": {
                    "name": { "type": "string" },
                    "arguments": { "type": "object" }
                },
                "required": ["name"]
            }),
            keywords: &[],
            core: false,
        },
    ]
}

fn describe(tool: &Tool) -> Value {
    json!({
        "name": tool.name,
        "description": tool.description,
        "inputSchema": tool.schema
    })
}

/// How well a tool answers what someone typed. Zero means it does not.
///
/// A hundred tools scored in memory is microseconds; an index would be a table
/// to keep in step with the catalog for no gain at this size.
const MATCH_FLOOR: u32 = 10;

fn score(tool: &Tool, tokens: &[String]) -> u32 {
    let name = tool.name.to_lowercase();
    let description = tool.description.to_lowercase();
    let mut total = 0;
    for token in tokens {
        if name == *token {
            total += 100;
        } else if name.split('_').any(|part| part == token) {
            total += 50;
        } else if name.contains(token.as_str()) {
            total += 30;
        }
        if tool.keywords.iter().any(|word| word == token) {
            total += 20;
        }
        if description.contains(token.as_str()) {
            total += 5;
        }
    }
    total
}

fn find_tool(args: &Value) -> Result<Value, String> {
    let query = text(args.get("query")).ok_or_else(|| "query is required".to_string())?;
    let limit = args.get("limit").and_then(Value::as_u64).unwrap_or(5).clamp(1, 20) as usize;
    // Two letters carry no intent and match half the catalog by accident.
    let tokens: Vec<String> = query
        .split(|c: char| !c.is_alphanumeric())
        .filter(|word| word.len() > 2)
        .map(str::to_lowercase)
        .collect();

    let mut ranked: Vec<(u32, Tool)> = catalog()
        .into_iter()
        .map(|tool| (score(&tool, &tokens), tool))
        // One passing word in a description is a coincidence, not a match:
        // "order a pizza" should not surface the routine tools.
        .filter(|(points, _)| *points >= MATCH_FLOOR)
        .collect();
    ranked.sort_by(|a, b| b.0.cmp(&a.0).then_with(|| a.1.name.cmp(b.1.name)));
    ranked.truncate(limit);

    if ranked.is_empty() {
        return Ok(json!({
            "matches": [],
            "note": format!(
                "Nothing here does that. Everything Crew offers: {}",
                catalog().iter().map(|tool| tool.name).collect::<Vec<_>>().join(", ")
            )
        }));
    }
    Ok(json!({
        "matches": ranked.iter().map(|(_, tool)| describe(tool)).collect::<Vec<_>>()
    }))
}

/// Hand a letter to its reader: start a turn on it, or say it could not.
/// `tools.rs` owns the queue; starting a turn belongs to whoever owns the
/// runtime, which is why this arrives as a callback.
pub type Deliver<'a> = &'a dyn Fn(&Session, &Letter) -> bool;

pub fn handle(
    store: &Store,
    transcripts: &TranscriptHub,
    on_created: &dyn Fn(&Session),
    deliver: Deliver<'_>,
    session_id: &str,
    method: &str,
    params: Value,
) -> Result<Value, String> {
    let caller = session::get(store, session_id.to_string())?
        .ok_or_else(|| "This session no longer exists in Crew".to_string())?;
    match method {
        "tools/list" => Ok(json!({
            "tools": catalog()
                .iter()
                .filter(|tool| tool.core)
                .chain(gateway().iter())
                .map(describe)
                .collect::<Vec<_>>()
        })),
        "tools/call" => {
            let name = params.get("name").and_then(Value::as_str).unwrap_or("");
            let args = params.get("arguments").cloned().unwrap_or(json!({}));
            let args = if args.is_object() { args } else { json!({}) };
            match run(store, transcripts, on_created, deliver, &caller, name, &args) {
                Ok(out) => {
                    let body = match out {
                        Value::String(text) => text,
                        other => serde_json::to_string_pretty(&other).unwrap_or_else(|_| other.to_string()),
                    };
                    Ok(json!({ "content": [{ "type": "text", "text": body }] }))
                }
                Err(error) => Ok(json!({
                    "content": [{ "type": "text", "text": error }],
                    "isError": true
                })),
            }
        }
        _ => Err(format!("Unknown method {method}")),
    }
}

#[allow(clippy::too_many_arguments)]
fn run(
    store: &Store,
    transcripts: &TranscriptHub,
    on_created: &dyn Fn(&Session),
    deliver: Deliver<'_>,
    caller: &Session,
    name: &str,
    args: &Value,
) -> Result<Value, String> {
    match name {
        "list_agents" => list_agents(store, caller),
        "create_agent" => create_agent(store, transcripts, on_created, caller, args),
        "message_agent" => message_agent(store, deliver, caller, args),
        "search_messages" => search_messages(store, caller, args),
        "find_tool" => find_tool(args),
        "call_tool" => {
            let inner = text(args.get("name")).ok_or_else(|| "name is required".to_string())?;
            if inner == "call_tool" || inner == "find_tool" {
                return Err(format!("{inner} cannot call itself. Name a tool find_tool returned."));
            }
            let inner_args = args.get("arguments").cloned().unwrap_or_else(|| json!({}));
            run(store, transcripts, on_created, deliver, caller, &inner, &inner_args)
        }
        "list_routines" => list_routines(store, caller, args),
        "upsert_routine" => upsert_routine(store, transcripts, caller, args),
        "delete_routine" => delete_routine(store, transcripts, caller, args),
        _ => Err(format!(
            "Unknown tool \"{name}\". One of: {}",
            catalog().into_iter().map(|t| t.name).collect::<Vec<_>>().join(", ")
        )),
    }
}

fn list_agents(store: &Store, caller: &Session) -> Result<Value, String> {
    let sessions = session::list(store, caller.workspace_id.clone())?;
    let rows: Vec<Value> = sessions
        .into_iter()
        .filter(|session| session.kind == "agent")
        .map(|session| {
            let mut row = json!({
                "id": session.id,
                "name": session.name,
                "description": session.description,
                "provider": session.provider,
                "model": session.model,
                "autonomy": session.autonomy,
                "status": session.status
            });
            if session.id == caller.id {
                row["self"] = json!(true);
            }
            row
        })
        .collect();
    Ok(Value::Array(rows))
}

/// Resolve "who" the way a person would: an id if that is what arrived, else a
/// name, case and spacing forgiven.
fn find_agent(store: &Store, caller: &Session, who: &str) -> Result<Session, String> {
    let agents: Vec<Session> = session::list(store, caller.workspace_id.clone())?
        .into_iter()
        .filter(|row| row.kind == "agent")
        .collect();
    let wanted = who.trim().to_lowercase();
    agents
        .iter()
        .find(|row| row.id == who)
        .or_else(|| agents.iter().find(|row| row.name.to_lowercase() == wanted))
        .cloned()
        .ok_or_else(|| {
            format!(
                "No agent \"{who}\" in this workspace. One of: {}",
                agents.iter().map(|row| row.name.as_str()).collect::<Vec<_>>().join(", ")
            )
        })
}

fn message_agent(
    store: &Store,
    deliver: Deliver<'_>,
    caller: &Session,
    args: &Value,
) -> Result<Value, String> {
    let who = text(args.get("to")).ok_or_else(|| "to is required".to_string())?;
    let body = text(args.get("text")).ok_or_else(|| "text is required".to_string())?;
    let target = find_agent(store, caller, &who)?;
    if target.id == caller.id {
        return Err("That is you. Answer in this conversation instead.".into());
    }

    let from = crew_protocol::AgentRef { id: caller.id.clone(), name: caller.name.clone() };
    mailbox::enqueue(store, &target.id, &from, &body)?;

    // Hand over the oldest letter, which may not be this one: a queue that
    // delivers out of order is worse than one that waits.
    let mut delivered = false;
    if let Some(letter) = mailbox::claim(store, &target.id)? {
        delivered = deliver(&target, &letter);
        if !delivered {
            mailbox::release(store, &letter.id)?;
        }
    }
    let waiting = mailbox::waiting_count(store, &target.id)?;
    Ok(json!({
        "to": target.name,
        "delivered": delivered,
        "waiting": waiting,
        "note": if delivered {
            format!("{} is reading it now. Its reply will reach you as a message.", target.name)
        } else {
            format!("{} is busy; it will read this when its turn ends.", target.name)
        }
    }))
}

fn search_messages(store: &Store, caller: &Session, args: &Value) -> Result<Value, String> {
    let query = text(args.get("query")).ok_or_else(|| "query is required".to_string())?;
    let limit = args.get("limit").and_then(Value::as_u64).unwrap_or(10).clamp(1, 50) as u32;
    let days = args.get("days").and_then(Value::as_u64);
    let session_ids = match text(args.get("agent_id")) {
        Some(who) => vec![find_agent(store, caller, &who)?.id],
        None => session::list(store, caller.workspace_id.clone())?
            .into_iter()
            .filter(|row| row.kind == "agent")
            .map(|row| row.id)
            .collect(),
    };
    let hits = crate::messages::search(
        store,
        crew_protocol::SearchQuery {
            query,
            session_ids,
            from: days.map(|days| now_millis() - (days as i64) * 86_400_000),
            to: None,
            limit: Some(limit),
            offset: None,
            sort: None,
        },
    )?;
    let rows: Vec<Value> = hits
        .into_iter()
        .map(|hit| {
            json!({
                "agent": hit.session_name,
                "when": when(hit.at),
                "role": format!("{:?}", hit.role).to_lowercase(),
                // The marks are for painting a UI; a model reads the words.
                "text": hit.snippet.replace(crate::messages::MARK_OPEN, "").replace(crate::messages::MARK_CLOSE, "")
            })
        })
        .collect();
    Ok(Value::Array(rows))
}

fn create_agent(
    store: &Store,
    transcripts: &TranscriptHub,
    on_created: &dyn Fn(&Session),
    caller: &Session,
    args: &Value,
) -> Result<Value, String> {
    let name = text(args.get("name")).ok_or_else(|| "name is required".to_string())?;
    let description = text(args.get("description"))
        .ok_or_else(|| "description is required: say what the agent is for".to_string())?;
    let provider = text(args.get("provider")).unwrap_or_else(|| caller.provider.clone());
    let models = provider_models(&provider).ok_or_else(|| {
        format!(
            "Unknown provider \"{provider}\". One of: {}",
            PROVIDERS.iter().map(|(id, _)| *id).collect::<Vec<_>>().join(", ")
        )
    })?;
    let requested = text(args.get("model"));
    if let Some(requested) = &requested {
        if !models.contains(&requested.as_str()) {
            return Err(format!(
                "Unknown model \"{requested}\" for {provider}. One of: {}",
                models.join(", ")
            ));
        }
    }
    let model = requested.unwrap_or_else(|| {
        if provider == caller.provider {
            caller.model.clone()
        } else {
            models.first().copied().unwrap_or_default().to_string()
        }
    });
    let autonomy = if args.get("autonomy").and_then(Value::as_str) == Some("full") {
        "full"
    } else {
        "ask"
    };
    let session = session::create(
        store,
        caller.workspace_id.clone(),
        "agent".into(),
        name.clone(),
        provider.clone(),
        model.clone(),
        description,
        autonomy.into(),
    )?;
    on_created(&session);
    transcripts.append_system(&session.id, &format!("Created by {}", caller.name));
    Ok(json!({
        "id": session.id,
        "name": name,
        "provider": provider,
        "model": model,
        "autonomy": autonomy,
        "status": "idle"
    }))
}

fn list_routines(store: &Store, caller: &Session, args: &Value) -> Result<Value, String> {
    let target = resolve_agent(store, caller, args.get("agent_id"))?;
    let rows = routine::list_for_session(store, target.id.clone())?;
    let listed: Vec<Value> = rows
        .into_iter()
        .map(|row| describe_routine(&row, &target))
        .collect();
    Ok(Value::Array(listed))
}

fn upsert_routine(
    store: &Store,
    transcripts: &TranscriptHub,
    caller: &Session,
    args: &Value,
) -> Result<Value, String> {
    let target = resolve_agent(store, caller, args.get("agent_id"))?;
    let id = text(args.get("routine_id"));
    let existing = if let Some(id) = &id {
        let found = routine::list_for_session(store, target.id.clone())?
            .into_iter()
            .find(|row| row.id == *id);
        if found.is_none() {
            return Err(format!("{} has no routine {id}", target.name));
        }
        found
    } else {
        None
    };
    let name = text(args.get("name")).or_else(|| existing.as_ref().map(|row| row.name.clone()));
    let prompt = text(args.get("prompt")).or_else(|| existing.as_ref().map(|row| row.prompt.clone()));
    let name = name.ok_or_else(|| "name is required".to_string())?;
    let prompt = prompt.ok_or_else(|| "prompt is required".to_string())?;
    let schedule = if args.get("schedule").is_some_and(|v| !v.is_null()) {
        validate_schedule(args.get("schedule").unwrap())?
    } else if let Some(existing) = &existing {
        parse_schedule(&existing.schedule).ok_or_else(|| schedule_help().to_string())?
    } else {
        return Err(format!("schedule is required. {}", schedule_help()));
    };
    let enabled = args
        .get("enabled")
        .and_then(Value::as_bool)
        .unwrap_or_else(|| existing.as_ref().map(|row| row.enabled).unwrap_or(true));
    let now = now_millis();
    let next = if enabled { next_run(&schedule, now) } else { None };
    let row = routine::upsert(
        store,
        id.clone(),
        target.id.clone(),
        name.clone(),
        enabled,
        prompt,
        schedule.to_json(),
        next,
        Some(caller.id.clone()),
    )?;
    if target.id != caller.id {
        let verb = if existing.is_some() { "updated" } else { "set up" };
        transcripts.append_system(&target.id, &format!("Routine · {name} {verb} by {}", caller.name));
    }
    Ok(describe_routine(&row, &target))
}

fn delete_routine(
    store: &Store,
    transcripts: &TranscriptHub,
    caller: &Session,
    args: &Value,
) -> Result<Value, String> {
    let id = text(args.get("routine_id")).ok_or_else(|| "routine_id is required".to_string())?;
    let found = find_routine(store, caller, &id)?;
    routine::delete(store, id)?;
    if found.0.id != caller.id {
        transcripts.append_system(
            &found.0.id,
            &format!("Routine · {} removed by {}", found.1.name, caller.name),
        );
    }
    Ok(Value::String(format!(
        "Deleted \"{}\" from {}.",
        found.1.name, found.0.name
    )))
}

fn resolve_agent(store: &Store, caller: &Session, agent_id: Option<&Value>) -> Result<Session, String> {
    let Some(id) = text(agent_id) else {
        return Ok(caller.clone());
    };
    if id == caller.id {
        return Ok(caller.clone());
    }
    let target = session::get(store, id.clone())?
        .filter(|session| session.kind == "agent" && session.workspace_id == caller.workspace_id)
        .ok_or_else(|| format!("No agent {id} in this workspace. Use list_agents for ids."))?;
    Ok(target)
}

fn find_routine(store: &Store, caller: &Session, id: &str) -> Result<(Session, Routine), String> {
    let agents = session::list(store, caller.workspace_id.clone())?
        .into_iter()
        .filter(|session| session.kind == "agent");
    for owner in agents {
        if let Some(routine) = routine::list_for_session(store, owner.id.clone())?
            .into_iter()
            .find(|row| row.id == id)
        {
            return Ok((owner, routine));
        }
    }
    Err(format!("No routine {id} in this workspace"))
}

fn describe_routine(routine: &Routine, owner: &Session) -> Value {
    let runs = parse_runs(&routine.runs_json);
    let last = runs.first();
    let schedule = parse_schedule(&routine.schedule);
    json!({
        "id": routine.id,
        "agent": owner.name,
        "agent_id": owner.id,
        "name": routine.name,
        "enabled": routine.enabled,
        "schedule": schedule.as_ref().map(describe_schedule).unwrap_or_else(|| routine.schedule.clone()),
        "prompt": routine.prompt,
        "last_run": last.map(|run| format!("{} at {}", run.0, when(run.1))).unwrap_or_else(|| "never".into()),
        "next_run": routine.next_run_at.map(when).unwrap_or_else(|| "not scheduled".into())
    })
}

fn parse_runs(raw: &str) -> Vec<(String, i64)> {
    let Ok(value) = serde_json::from_str::<Value>(raw) else {
        return Vec::new();
    };
    let Some(items) = value.as_array() else {
        return Vec::new();
    };
    items
        .iter()
        .filter_map(|item| {
            let id = item.get("id").and_then(Value::as_str)?;
            let started = item.get("startedAt").and_then(Value::as_i64)?;
            let status = item.get("status").and_then(Value::as_str).unwrap_or("");
            Some((status.to_string(), started, id.to_string()))
        })
        .map(|(status, started, _)| (status, started))
        .collect()
}

fn provider_models(id: &str) -> Option<Vec<&'static str>> {
    PROVIDERS
        .iter()
        .find(|(name, _)| *name == id)
        .map(|(_, models)| models.to_vec())
}

fn text(value: Option<&Value>) -> Option<String> {
    value
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_string)
}

fn when(ms: i64) -> String {
    let secs = (ms / 1000) as libc::time_t;
    let mut tm = unsafe { std::mem::zeroed() };
    unsafe {
        libc::localtime_r(&secs, &mut tm);
    }
    let months = [
        "Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
    ];
    let month = months.get(tm.tm_mon as usize).copied().unwrap_or("");
    let mut hour = tm.tm_hour;
    let suffix = if hour >= 12 { "PM" } else { "AM" };
    hour %= 12;
    if hour == 0 {
        hour = 12;
    }
    format!(
        "{month} {}, {}, {hour}:{:02} {suffix}",
        tm.tm_mday,
        tm.tm_year + 1900,
        tm.tm_min
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::RefCell;

    fn store() -> Store {
        let dir = std::env::temp_dir().join(format!("crew-tools-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).expect("dir");
        Store::open(dir.join("crew.sqlite3")).expect("store")
    }

    fn workspace(store: &Store) -> String {
        let root = std::env::temp_dir().join(uuid::Uuid::new_v4().to_string());
        std::fs::create_dir_all(&root).expect("root");
        crate::workspace::create(store, "w".into(), root.to_string_lossy().into())
            .expect("workspace")
            .id
    }

    fn agent(store: &Store, workspace_id: &str, name: &str) -> Session {
        session::create(
            store,
            workspace_id.to_string(),
            "agent".into(),
            name.into(),
            "claude".into(),
            "claude-opus-5".into(),
            "".into(),
            "ask".into(),
        )
        .expect("agent")
    }

    /// Records who was handed what, and can refuse like a busy agent would.
    #[derive(Default)]
    struct Postman {
        handed: RefCell<Vec<(String, String)>>,
        busy: bool,
    }

    impl Postman {
        fn deliver(&self, target: &Session, letter: &Letter) -> bool {
            if self.busy {
                return false;
            }
            self.handed
                .borrow_mut()
                .push((target.name.clone(), letter.text.clone()));
            true
        }
    }

    fn call(
        store: &Store,
        transcripts: &TranscriptHub,
        postman: &Postman,
        caller: &Session,
        name: &str,
        args: Value,
    ) -> Result<Value, String> {
        handle(
            store,
            transcripts,
            &|_| {},
            &|target, letter| postman.deliver(target, letter),
            &caller.id,
            "tools/call",
            json!({ "name": name, "arguments": args }),
        )
    }

    fn body(result: &Value) -> String {
        result["content"][0]["text"].as_str().unwrap_or_default().to_string()
    }

    fn is_error(result: &Value) -> bool {
        result["isError"].as_bool().unwrap_or(false)
    }

    fn listed(store: &Store, transcripts: &TranscriptHub, caller: &Session) -> Vec<String> {
        let postman = Postman::default();
        let out = handle(
            store,
            transcripts,
            &|_| {},
            &|target, letter| postman.deliver(target, letter),
            &caller.id,
            "tools/list",
            json!({}),
        )
        .expect("list");
        out["tools"]
            .as_array()
            .expect("tools")
            .iter()
            .map(|tool| tool["name"].as_str().unwrap_or_default().to_string())
            .collect()
    }

    #[test]
    fn the_listing_is_the_few_tools_worth_every_prompt() {
        let store = store();
        let transcripts = TranscriptHub::new(store.clone());
        let ws = workspace(&store);
        let coder = agent(&store, &ws, "Coder");
        let names = listed(&store, &transcripts, &coder);

        for core in ["list_agents", "message_agent", "search_messages", "find_tool", "call_tool"] {
            assert!(names.contains(&core.to_string()), "{core} missing from {names:?}");
        }
        // The rest is reachable, not listed.
        assert!(!names.contains(&"upsert_routine".to_string()));
        assert!(!names.contains(&"create_agent".to_string()));
    }

    #[test]
    fn find_tool_answers_with_something_callable() {
        let out = find_tool(&json!({ "query": "run something every morning" })).expect("find");
        let names: Vec<&str> = out["matches"]
            .as_array()
            .expect("matches")
            .iter()
            .map(|row| row["name"].as_str().unwrap_or_default())
            .collect();
        assert!(names.contains(&"upsert_routine"), "{names:?}");
        let first = &out["matches"][0];
        assert!(first["inputSchema"]["properties"].is_object(), "no schema to call with");
    }

    #[test]
    fn find_tool_ranks_the_name_over_a_passing_mention() {
        let out = find_tool(&json!({ "query": "create_agent" })).expect("find");
        assert_eq!(out["matches"][0]["name"], "create_agent");
    }

    #[test]
    fn find_tool_says_so_when_nothing_fits() {
        let out = find_tool(&json!({ "query": "order a pizza" })).expect("find");
        assert!(out["matches"].as_array().expect("matches").is_empty());
        assert!(out["note"].as_str().unwrap_or_default().contains("list_agents"));
    }

    #[test]
    fn find_tool_honours_its_limit() {
        let out = find_tool(&json!({ "query": "agent routine message", "limit": 2 })).expect("find");
        assert_eq!(out["matches"].as_array().expect("matches").len(), 2);
    }

    #[test]
    fn call_tool_runs_what_was_found() {
        let store = store();
        let transcripts = TranscriptHub::new(store.clone());
        let ws = workspace(&store);
        let coder = agent(&store, &ws, "Coder");
        agent(&store, &ws, "Cuddles");
        let postman = Postman::default();
        let out = call(
            &store,
            &transcripts,
            &postman,
            &coder,
            "call_tool",
            json!({ "name": "message_agent", "arguments": { "to": "Cuddles", "text": "via gateway" } }),
        )
        .expect("call");
        assert!(!is_error(&out));
        assert_eq!(postman.handed.borrow()[0].1, "via gateway");
    }

    #[test]
    fn call_tool_refuses_to_call_itself() {
        let store = store();
        let transcripts = TranscriptHub::new(store.clone());
        let ws = workspace(&store);
        let coder = agent(&store, &ws, "Coder");
        let postman = Postman::default();
        let out = call(&store, &transcripts, &postman, &coder, "call_tool", json!({ "name": "call_tool" }))
            .expect("call");
        assert!(is_error(&out));
    }

    #[test]
    fn an_agent_can_search_what_was_said() {
        let store = store();
        let transcripts = TranscriptHub::new(store.clone());
        let ws = workspace(&store);
        let coder = agent(&store, &ws, "Coder");
        let cuddles = agent(&store, &ws, "Cuddles");
        transcripts.append_user(&cuddles.id, "the staging password is in 1password", false, None);
        transcripts.flush(&cuddles.id);

        let postman = Postman::default();
        let out = call(
            &store,
            &transcripts,
            &postman,
            &coder,
            "search_messages",
            json!({ "query": "staging password" }),
        )
        .expect("call");
        assert!(!is_error(&out), "{}", body(&out));
        let text = body(&out);
        assert!(text.contains("1password"), "{text}");
        assert!(text.contains("Cuddles"), "{text}");
        // The UI's hit markers never reach a model.
        assert!(!text.contains(crate::messages::MARK_OPEN));
    }

    #[test]
    fn a_search_can_be_narrowed_to_one_agent() {
        let store = store();
        let transcripts = TranscriptHub::new(store.clone());
        let ws = workspace(&store);
        let coder = agent(&store, &ws, "Coder");
        let cuddles = agent(&store, &ws, "Cuddles");
        let other = agent(&store, &ws, "Other");
        transcripts.append_user(&cuddles.id, "shared secret", false, None);
        transcripts.flush(&cuddles.id);
        transcripts.append_user(&other.id, "shared secret", false, None);
        transcripts.flush(&other.id);

        let postman = Postman::default();
        let out = call(
            &store,
            &transcripts,
            &postman,
            &coder,
            "search_messages",
            json!({ "query": "shared", "agent_id": "Cuddles" }),
        )
        .expect("call");
        let text = body(&out);
        assert!(text.contains("Cuddles"));
        assert!(!text.contains("Other"), "{text}");
    }

    #[test]
    fn a_message_reaches_an_idle_agent_right_away() {
        let store = store();
        let transcripts = TranscriptHub::new(store.clone());
        let ws = workspace(&store);
        let coder = agent(&store, &ws, "Coder");
        agent(&store, &ws, "Cuddles");
        let postman = Postman::default();

        let out = call(
            &store,
            &transcripts,
            &postman,
            &coder,
            "message_agent",
            json!({ "to": "Cuddles", "text": "the branch is green" }),
        )
        .expect("call");
        assert!(!is_error(&out));
        assert!(body(&out).contains("\"delivered\": true"), "{}", body(&out));
        assert_eq!(
            postman.handed.borrow().as_slice(),
            [("Cuddles".to_string(), "the branch is green".to_string())]
        );
    }

    #[test]
    fn a_message_to_a_busy_agent_waits_in_its_box() {
        let store = store();
        let transcripts = TranscriptHub::new(store.clone());
        let ws = workspace(&store);
        let coder = agent(&store, &ws, "Coder");
        let cuddles = agent(&store, &ws, "Cuddles");
        let postman = Postman { busy: true, ..Postman::default() };

        let out = call(
            &store,
            &transcripts,
            &postman,
            &coder,
            "message_agent",
            json!({ "to": "Cuddles", "text": "when you get a minute" }),
        )
        .expect("call");
        assert!(body(&out).contains("\"delivered\": false"), "{}", body(&out));
        assert!(postman.handed.borrow().is_empty());
        // Released, not lost: it is still first in line.
        let waiting = mailbox::waiting(&store, &cuddles.id).expect("waiting");
        assert_eq!(waiting.len(), 1);
        assert_eq!(waiting[0].text, "when you get a minute");
        assert_eq!(waiting[0].from.name, "Coder");
    }

    #[test]
    fn the_oldest_letter_goes_first_even_when_a_newer_one_triggered_the_delivery() {
        let store = store();
        let transcripts = TranscriptHub::new(store.clone());
        let ws = workspace(&store);
        let coder = agent(&store, &ws, "Coder");
        let cuddles = agent(&store, &ws, "Cuddles");

        let busy = Postman { busy: true, ..Postman::default() };
        call(&store, &transcripts, &busy, &coder, "message_agent", json!({ "to": "Cuddles", "text": "first" }))
            .expect("first");
        let free = Postman::default();
        call(&store, &transcripts, &free, &coder, "message_agent", json!({ "to": "Cuddles", "text": "second" }))
            .expect("second");

        assert_eq!(free.handed.borrow()[0].1, "first");
        assert_eq!(mailbox::waiting_count(&store, &cuddles.id).expect("count"), 1);
    }

    #[test]
    fn an_agent_cannot_message_itself() {
        let store = store();
        let transcripts = TranscriptHub::new(store.clone());
        let ws = workspace(&store);
        let coder = agent(&store, &ws, "Coder");
        let postman = Postman::default();
        let out = call(&store, &transcripts, &postman, &coder, "message_agent", json!({ "to": "Coder", "text": "hi" }))
            .expect("call");
        assert!(is_error(&out));
        assert!(body(&out).contains("That is you"));
    }

    #[test]
    fn an_unknown_name_lists_the_agents_there_are() {
        let store = store();
        let transcripts = TranscriptHub::new(store.clone());
        let ws = workspace(&store);
        let coder = agent(&store, &ws, "Coder");
        agent(&store, &ws, "Cuddles");
        let postman = Postman::default();
        let out = call(&store, &transcripts, &postman, &coder, "message_agent", json!({ "to": "Nobody", "text": "hi" }))
            .expect("call");
        assert!(is_error(&out));
        assert!(body(&out).contains("Cuddles"), "{}", body(&out));
    }

    #[test]
    fn a_name_is_matched_however_it_was_typed() {
        let store = store();
        let transcripts = TranscriptHub::new(store.clone());
        let ws = workspace(&store);
        let coder = agent(&store, &ws, "Coder");
        agent(&store, &ws, "Cuddles");
        let postman = Postman::default();
        call(&store, &transcripts, &postman, &coder, "message_agent", json!({ "to": "  cuddles ", "text": "hi" }))
            .expect("call");
        assert_eq!(postman.handed.borrow()[0].0, "Cuddles");
    }

    #[test]
    fn an_agent_in_another_workspace_is_out_of_reach() {
        let store = store();
        let transcripts = TranscriptHub::new(store.clone());
        let here = workspace(&store);
        let there = workspace(&store);
        let coder = agent(&store, &here, "Coder");
        agent(&store, &there, "Stranger");
        let postman = Postman::default();
        let out = call(&store, &transcripts, &postman, &coder, "message_agent", json!({ "to": "Stranger", "text": "hi" }))
            .expect("call");
        assert!(is_error(&out));
        assert!(postman.handed.borrow().is_empty());
    }

    #[test]
    fn an_id_works_as_well_as_a_name() {
        let store = store();
        let transcripts = TranscriptHub::new(store.clone());
        let ws = workspace(&store);
        let coder = agent(&store, &ws, "Coder");
        let cuddles = agent(&store, &ws, "Cuddles");
        let postman = Postman::default();
        call(
            &store,
            &transcripts,
            &postman,
            &coder,
            "message_agent",
            json!({ "to": cuddles.id, "text": "by id" }),
        )
        .expect("call");
        assert_eq!(postman.handed.borrow()[0].0, "Cuddles");
    }

    #[test]
    fn a_message_needs_something_to_say() {
        let store = store();
        let transcripts = TranscriptHub::new(store.clone());
        let ws = workspace(&store);
        let coder = agent(&store, &ws, "Coder");
        agent(&store, &ws, "Cuddles");
        let postman = Postman::default();
        let out = call(&store, &transcripts, &postman, &coder, "message_agent", json!({ "to": "Cuddles" }))
            .expect("call");
        assert!(is_error(&out));
        assert!(body(&out).contains("text is required"));
    }
}
