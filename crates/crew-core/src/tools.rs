use serde_json::{json, Value};

use crate::mailbox;
use crate::routine::{self, Routine};
use crate::schedule::{describe_schedule, next_run, parse_schedule, schedule_help, validate_schedule};
use crate::session::{self, Session};
use crate::store::{now_millis, Store};
use crate::transcript::TranscriptHub;

const PROVIDERS: &[(&str, &[&str])] = &[
    (
        "claude",
        &[
            "claude-fable-5-1",
            "claude-opus-5",
            "claude-sonnet-5",
            "claude-fable-5",
            "claude-opus-4-8",
            "claude-opus-4-7",
            "claude-opus-4-6",
            "claude-opus-4-5",
            "claude-sonnet-4-6",
            "claude-sonnet-4-5",
        ],
    ),
    (
        "cursor",
        &[
            "auto",
            "composer-2.5",
            "cursor-grok-4.6-high",
            "gpt-5.3-codex",
            "claude-fable-5-1-thinking-high",
            "claude-opus-5-thinking-high",
            "claude-sonnet-5-thinking-high",
            "gpt-5.6-sol-medium",
            "gemini-3.8-flash-high",
            "cursor-grok-4.5-high",
            "claude-opus-4-8-thinking-high",
            "claude-4.6-opus-high-thinking",
            "claude-4.6-sonnet-medium-thinking",
            "gpt-5.5-medium",
            "gpt-5.4-medium",
            "gpt-5.2",
        ],
    ),
    (
        "codex",
        &[
            "gpt-6-astra",
            "gpt-5.6-sol",
            "gpt-5.6-terra",
            "gpt-5.6-luna",
            "gpt-5.5",
        ],
    ),
    (
        "opencode",
        &[
            "opencode/ling-3.0-flash-fin-free",
            "opencode/nemotron-3.5-lightning-free",
            "opencode/nemotron-3-ultra-free",
            "opencode/mimo-v2.5-free",
            "opencode/muse-spark-1.3-contributor-free",
        ],
    ),
];

pub(crate) struct Tool {
    pub(crate) name: &'static str,
    description: &'static str,
    schema: Value,
    /// Words someone would search for that the name and description miss.
    keywords: &'static [&'static str],
    /// Listed to every agent on every turn. Everything else is found with
    /// `find_tool`: a roster of a hundred tools would cost more prompt than the
    /// conversation, and most turns need none of them.
    core: bool,
}

pub(crate) fn catalog() -> Vec<Tool> {
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
                    "provider": { "type": "string", "enum": ["claude", "cursor", "codex", "opencode"] },
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
                    "to": { "type": "string", "description": "The agent's name or id, or your own name to continue after this turn. Use list_agents if unsure." },
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

/// Exactly what `tools/list` answers with, and exactly what the sheet in an
/// agent's prompt names: the two have to agree or the agent is told about a
/// tool it cannot call.
pub(crate) fn standing() -> Vec<Tool> {
    catalog().into_iter().filter(|tool| tool.core).chain(gateway()).collect()
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

/// Drain an agent's box now: claim its oldest letter and start a turn on it.
/// Returns whether one went over. Starting a turn belongs to whoever owns the
/// runtime, which is why this arrives as a callback.
///
/// It takes the agent, not the letter, so that claiming stays in one place. A
/// caller that claimed first and handed the letter over would hide it from the
/// drain that runs when the target's turn ends, and a letter nobody can see is
/// a letter nobody delivers.
pub type Deliver<'a> = &'a dyn Fn(&Session) -> bool;

#[allow(clippy::too_many_arguments)]
pub fn handle(
    store: &Store,
    transcripts: &TranscriptHub,
    on_created: &dyn Fn(&Session),
    on_routines: &dyn Fn(),
    deliver: Deliver<'_>,
    session_id: &str,
    method: &str,
    params: Value,
) -> Result<Value, String> {
    let caller = session::get(store, session_id.to_string())?
        .ok_or_else(|| "This session no longer exists in Crew".to_string())?;
    match method {
        "tools/list" => Ok(json!({
            "tools": standing().iter().map(describe).collect::<Vec<_>>()
        })),
        "tools/call" => {
            let name = params.get("name").and_then(Value::as_str).unwrap_or("");
            let args = params.get("arguments").cloned().unwrap_or(json!({}));
            let args = if args.is_object() { args } else { json!({}) };
            match run(store, transcripts, on_created, on_routines, deliver, &caller, name, &args) {
                Ok(out) => {
                    let body = match out {
                        Value::String(text) => text,
                        other => serde_json::to_string_pretty(&other).unwrap_or_else(|_| other.to_string()),
                    };
                    Ok(json!({ "content": [{ "type": "text", "text": body }] }))
                }
                // A refusal carries the arguments the tool wanted. An agent
                // that guessed one field name has usually guessed the others,
                // and a round trip per field is a turn spent on paperwork.
                Err(error) => Ok(json!({
                    "content": [{ "type": "text", "text": with_arguments(name, &error) }],
                    "isError": true
                })),
            }
        }
        _ => Err(format!("Unknown method {method}")),
    }
}

/// The tool's arguments, appended to whatever it said when it refused.
fn with_arguments(name: &str, error: &str) -> String {
    let Some(tool) = catalog().into_iter().chain(gateway()).find(|tool| tool.name == name) else {
        return error.to_string();
    };
    // Required first, in the order the schema names them, because that is the
    // order the tool's own description talks about them in.
    let required: Vec<String> = tool
        .schema
        .get("required")
        .and_then(Value::as_array)
        .map(|names| names.iter().filter_map(Value::as_str).map(str::to_string).collect())
        .unwrap_or_default();
    let mut fields = required.clone();
    if let Some(props) = tool.schema.get("properties").and_then(Value::as_object) {
        fields.extend(props.keys().filter(|key| !required.contains(key)).cloned());
    }
    if fields.is_empty() {
        return error.to_string();
    }
    format!("{error}\n{name} takes: {}.", fields.join(", "))
}

#[allow(clippy::too_many_arguments)]
fn run(
    store: &Store,
    transcripts: &TranscriptHub,
    on_created: &dyn Fn(&Session),
    // A routine the agent just wrote is a routine the daemon has to wake for.
    on_routines: &dyn Fn(),
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
            run(store, transcripts, on_created, on_routines, deliver, caller, &inner, &inner_args)
        }
        "list_routines" => list_routines(store, caller, args),
        "upsert_routine" => upsert_routine(store, transcripts, on_routines, caller, args),
        "delete_routine" => delete_routine(store, transcripts, on_routines, caller, args),
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
    let to_self = target.id == caller.id;

    let from = crew_protocol::AgentRef { id: caller.id.clone(), name: caller.name.clone() };
    mailbox::enqueue(store, &target.id, &from, &body)?;

    // What goes over is the oldest letter, which may not be this one: a queue
    // that delivers out of order is worse than one that waits.
    let delivered = deliver(&target);
    let waiting = mailbox::waiting_count(store, &target.id)?;
    Ok(json!({
        "to": target.name,
        "delivered": delivered,
        "waiting": waiting,
        "note": if to_self {
            "You will read this as a new turn once this one ends. That is how you keep working; stop writing to yourself when the work is done.".to_string()
        } else if delivered {
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
    // The workspace is the fence; naming an agent narrows it further.
    let session_ids = match text(args.get("agent_id")) {
        Some(who) => vec![find_agent(store, caller, &who)?.id],
        None => Vec::new(),
    };
    let hits = crate::messages::search(
        store,
        crew_protocol::SearchQuery {
            query,
            workspace_id: Some(caller.workspace_id.clone()),
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
                "text": hit.snippet.replace([crate::messages::MARK_OPEN, crate::messages::MARK_CLOSE], "")
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
    on_routines: &dyn Fn(),
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
    on_routines();
    Ok(describe_routine(&row, &target))
}

fn delete_routine(
    store: &Store,
    transcripts: &TranscriptHub,
    on_routines: &dyn Fn(),
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
    on_routines();
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
        /// Stands in for the runtime: claims the oldest letter and "starts a
        /// turn" on it, exactly where TurnHost::drain_mailbox does.
        fn deliver(&self, store: &Store, target: &Session) -> bool {
            if self.busy {
                return false;
            }
            let Ok(Some(letter)) = mailbox::claim(store, &target.id) else {
                return false;
            };
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
            &|| {},
            &|target| postman.deliver(store, target),
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
            &|| {},
            &|target| postman.deliver(store, target),
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

        // An exact set: a tool that quietly becomes core would otherwise slip
        // the whole hidden catalogue back into every prompt.
        assert_eq!(
            names,
            vec![
                "list_agents".to_string(),
                "message_agent".to_string(),
                "search_messages".to_string(),
                "find_tool".to_string(),
                "call_tool".to_string(),
            ]
        );
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
        // With arguments, so that a missing guard would recurse rather than
        // fail on a missing field and look like the guard worked.
        let out = call(
            &store,
            &transcripts,
            &postman,
            &coder,
            "call_tool",
            json!({ "name": "call_tool", "arguments": { "name": "list_agents" } }),
        )
        .expect("call");
        assert!(is_error(&out));
        assert!(body(&out).contains("cannot call itself"), "{}", body(&out));
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
    fn writing_to_itself_is_how_an_agent_carries_on() {
        let store = store();
        let transcripts = TranscriptHub::new(store.clone());
        let ws = workspace(&store);
        let coder = agent(&store, &ws, "Coder");
        // The caller is mid-turn by definition, so its own letter cannot be
        // handed over now; it waits for the turn to end.
        let postman = Postman { busy: true, ..Postman::default() };
        let out = call(
            &store,
            &transcripts,
            &postman,
            &coder,
            "message_agent",
            json!({ "to": "Coder", "text": "next: run the tests" }),
        )
        .expect("call");
        assert!(!is_error(&out), "{}", body(&out));
        assert!(body(&out).contains("once this one ends"), "{}", body(&out));
        let waiting = mailbox::waiting(&store, &coder.id).expect("waiting");
        assert_eq!(waiting.len(), 1);
        assert_eq!(waiting[0].from.id, coder.id);
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

    /// `message_agent` marks the oldest letter delivered *before* it knows the
    /// target will take it, and only puts it back afterwards. `drain_mailbox`
    /// runs on the target's own turn thread the moment that turn ends, so it
    /// can land inside that window — and then it drains an empty box and the
    /// agent goes idle with a letter still queued and nobody left to hand it
    /// over. The callback below stands in for that turn ending.
    #[test]
    fn a_turn_ending_while_a_letter_is_in_flight_still_sees_it() {
        let store = store();
        let transcripts = TranscriptHub::new(store.clone());
        let ws = workspace(&store);
        let coder = agent(&store, &ws, "Coder");
        let cuddles = agent(&store, &ws, "Cuddles");

        let drained: RefCell<Option<String>> = RefCell::new(None);
        let out = handle(
            &store,
            &transcripts,
            &|_| {},
            &|| {},
            &|_target| {
                // TurnHost::drain_mailbox, on the target's thread, racing the
                // delivery this call is about to attempt.
                *drained.borrow_mut() = mailbox::claim(&store, &cuddles.id)
                    .expect("drain")
                    .map(|letter| letter.text);
                false
            },
            &coder.id,
            "tools/call",
            json!({
                "name": "message_agent",
                "arguments": { "to": "Cuddles", "text": "the branch is green" }
            }),
        )
        .expect("call");
        assert!(!is_error(&out), "{}", body(&out));

        let left = mailbox::waiting_count(&store, &cuddles.id).expect("count");
        assert_eq!(
            drained.borrow().as_deref(),
            Some("the branch is green"),
            "the drain saw an empty box; {left} letter(s) are now queued for an idle agent that will never be woken"
        );
    }

    // ---------------------------------------------------------------
    // Adversarial review additions (tool gateway).
    // ---------------------------------------------------------------

    fn agent_with_provider(store: &Store, workspace_id: &str, name: &str, provider: &str) -> Session {
        session::create(
            store,
            workspace_id.to_string(),
            "agent".into(),
            name.into(),
            provider.into(),
            "".into(),
            "".into(),
            "ask".into(),
        )
        .expect("agent")
    }

    /// opencode shipped as a provider but never reached `PROVIDERS`, so an
    /// opencode agent inherits its own provider as the default and is told it
    /// does not exist. It cannot create any agent at all without naming someone
    /// else's provider, and nobody can create an opencode agent.
    #[test]
    fn review_an_opencode_agent_can_create_an_agent() {
        let store = store();
        let transcripts = TranscriptHub::new(store.clone());
        let ws = workspace(&store);
        let coder = agent_with_provider(&store, &ws, "Coder", "opencode");
        let postman = Postman::default();
        let out = call(
            &store,
            &transcripts,
            &postman,
            &coder,
            "create_agent",
            json!({ "name": "Helper", "description": "runs errands" }),
        )
        .expect("call");
        assert!(!is_error(&out), "{}", body(&out));
    }

    /// `call_tool` refusing its own name is asserted by
    /// `call_tool_refuses_to_call_itself`, but that test passes the payload
    /// `{"name": "call_tool"}` with no inner arguments, which also errors with
    /// "name is required" when the guard is deleted. This is the payload that
    /// actually tells the two apart: without the guard it delivers the letter.
    #[test]
    fn review_call_tool_cannot_be_nested_to_reach_a_tool() {
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
            json!({
                "name": "call_tool",
                "arguments": {
                    "name": "message_agent",
                    "arguments": { "to": "Cuddles", "text": "smuggled" }
                }
            }),
        )
        .expect("call");
        assert!(is_error(&out), "{}", body(&out));
        assert!(postman.handed.borrow().is_empty(), "the nested call went through");
    }

    /// The gateway hides tools from `tools/list`; it does not gate them. The
    /// caller identity is whatever session id arrives on the request, and the
    /// bridge authenticates one daemon-wide token that every agent process is
    /// handed in `CREW_TOKEN`. So one agent's shell can act as another agent.
    #[test]
    fn review_the_caller_is_not_the_session_that_asked() {
        let store = store();
        let transcripts = TranscriptHub::new(store.clone());
        let ws = workspace(&store);
        let coder = agent(&store, &ws, "Coder");
        let cuddles = agent(&store, &ws, "Cuddles");
        let victim = agent(&store, &ws, "Victim");
        // Busy, so the letter queues and its sender can be read back.
        let postman = Postman { busy: true, ..Postman::default() };
        // Coder's bash tool inherits CREW_SOCKET/CREW_TOKEN and simply names
        // Cuddles' session id on the wire. `handle` believes it.
        let out = handle(
            &store,
            &transcripts,
            &|_| {},
            &|| {},
            &|target| postman.deliver(&store, target),
            &cuddles.id,
            "tools/call",
            json!({
                "name": "message_agent",
                "arguments": { "to": "Victim", "text": "signed, Cuddles" }
            }),
        )
        .expect("call");
        assert!(!is_error(&out), "{}", body(&out));
        let waiting = mailbox::waiting(&store, &victim.id).expect("waiting");
        let _ = coder;
        assert_eq!(
            waiting.first().map(|letter| letter.from.name.as_str()),
            Some("Cuddles"),
            "the request named Cuddles and was believed: any holder of CREW_TOKEN speaks as any session"
        );
    }
    /// An agent that guessed one field name has usually guessed the others.
    /// Answering "to is required" alone costs a round trip per field.
    #[test]
    fn a_refusal_says_what_the_tool_takes() {
        let store = store();
        let transcripts = TranscriptHub::new(store.clone());
        let ws = workspace(&store);
        let coder = agent(&store, &ws, "Coder");
        let postman = Postman::default();

        let answer = call(
            &store,
            &transcripts,
            &postman,
            &coder,
            "message_agent",
            json!({ "agent_id": "x", "message": "hi" }),
        )
        .expect("handled");

        assert!(is_error(&answer), "{}", body(&answer));
        assert!(body(&answer).contains("message_agent takes: to, text."), "{}", body(&answer));
    }

    #[test]
    fn a_refusal_from_a_tool_nobody_has_stays_as_it_came() {
        let store = store();
        let transcripts = TranscriptHub::new(store.clone());
        let ws = workspace(&store);
        let coder = agent(&store, &ws, "Coder");
        let postman = Postman::default();

        let answer = call(&store, &transcripts, &postman, &coder, "no_such_tool", json!({}))
            .expect("handled");

        assert!(body(&answer).starts_with("Unknown tool"), "{}", body(&answer));
        assert!(!body(&answer).contains("takes:"), "{}", body(&answer));
    }

}
