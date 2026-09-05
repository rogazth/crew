use serde_json::{json, Value};

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
        },
        Tool {
            name: "list_routines",
            description: "List the routines of an agent: standing orders that wake it on a schedule with a saved prompt. Defaults to your own.",
            schema: json!({
                "type": "object",
                "properties": { "agent_id": { "type": "string", "description": "Omit for yourself." } }
            }),
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
        },
        Tool {
            name: "delete_routine",
            description: "Delete a routine by id. Works on any agent in this workspace.",
            schema: json!({
                "type": "object",
                "properties": { "routine_id": { "type": "string" } },
                "required": ["routine_id"]
            }),
        },
    ]
}

pub fn handle(
    store: &Store,
    transcripts: &TranscriptHub,
    on_created: &dyn Fn(&Session),
    session_id: &str,
    method: &str,
    params: Value,
) -> Result<Value, String> {
    let caller = session::get(store, session_id.to_string())?
        .ok_or_else(|| "This session no longer exists in Crew".to_string())?;
    match method {
        "tools/list" => Ok(json!({
            "tools": catalog().into_iter().map(|tool| json!({
                "name": tool.name,
                "description": tool.description,
                "inputSchema": tool.schema
            })).collect::<Vec<_>>()
        })),
        "tools/call" => {
            let name = params.get("name").and_then(Value::as_str).unwrap_or("");
            let args = params.get("arguments").cloned().unwrap_or(json!({}));
            let args = if args.is_object() { args } else { json!({}) };
            match run(store, transcripts, on_created, &caller, name, &args) {
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

fn run(
    store: &Store,
    transcripts: &TranscriptHub,
    on_created: &dyn Fn(&Session),
    caller: &Session,
    name: &str,
    args: &Value,
) -> Result<Value, String> {
    match name {
        "list_agents" => list_agents(store, caller),
        "create_agent" => create_agent(store, transcripts, on_created, caller, args),
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
