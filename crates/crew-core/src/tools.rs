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

/// The provider names, from the one place they are listed. The enum used to be
/// written out again in the schema, which is a second list to keep in step.
fn provider_names() -> Vec<&'static str> {
    PROVIDERS.iter().map(|(id, _)| *id).collect()
}

/// Every model there is, grouped by the provider that has it.
///
/// It rides in `create_agent`'s own schema rather than behind a tool of its
/// own: the moment an agent needs a model id is the moment it is reading this
/// schema, and there is no second moment. Thirty-six ids are shorter than most
/// tools' arguments, and only a turn that looks up `create_agent` pays for
/// them. Without it an agent guesses from memory — `grok-4.6` under codex,
/// which is neither the provider nor the spelling — and reports back that the
/// model does not exist here.
fn model_sheet() -> String {
    PROVIDERS
        .iter()
        .map(|(provider, models)| format!("{provider}: {}", models.join(", ")))
        .collect::<Vec<_>>()
        .join("\n")
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
            description: "Create a new agent in this workspace. It stays idle until the user messages it or a routine wakes it. Provider and model default to yours, and it runs with your autonomy: you cannot make one that is allowed more than you are.",
            schema: json!({
                "type": "object",
                "properties": {
                    "name": { "type": "string" },
                    "description": { "type": "string", "description": "Its job, written as instructions to it." },
                    "provider": { "type": "string", "enum": provider_names(), "description": "Defaults to yours." },
                    "model": {
                        "type": "string",
                        "description": format!(
                            "Defaults to yours when the provider is yours. A model belongs to one \
                             provider and is spelled differently by each, so pass the two together. \
                             What there is:\n{}",
                            model_sheet()
                        )
                    }
                },
                "required": ["name", "description"]
            }),
            keywords: &["new", "hire", "spawn", "agent"],
            core: false,
        },
        Tool {
            name: "message_agent",
            description: "Send a message to another agent in this workspace. It arrives as a turn with your name and id on it and is answered in its own time, or not at all: you are not waiting here, and anything it sends back reaches you as a message of its own. If the agent is busy the message waits in its box.",
            schema: json!({
                "type": "object",
                "properties": {
                    "to": { "type": "string", "description": "The agent's id — from list_agents, or from the line a message arrived on. Not its name: names are the user's to change." },
                    "text": { "type": "string", "description": "What to say. Give it everything it needs; it cannot see your conversation." }
                },
                "required": ["to", "text"]
            }),
            keywords: &["send", "tell", "ask", "dm", "reply", "message"],
            core: true,
        },
        Tool {
            name: "continue_after_turn",
            description: "Leave yourself the next step. It arrives as a new turn the moment this one ends, with the tail of this conversation, so it is how you carry on past work that does not fit in one turn. Twenty-five of these in a row with nobody else speaking stops you.",
            schema: json!({
                "type": "object",
                "properties": {
                    "text": { "type": "string", "description": "What to pick up next, and anything you will need that this turn found out." }
                },
                "required": ["text"]
            }),
            keywords: &["continue", "carry", "loop", "next", "self", "resume"],
            core: true,
        },
        Tool {
            name: "update_description",
            description: "Rewrite your own description: the standing instructions you are handed at the top of every turn. It replaces the whole thing, so include what you want to keep. Your name, model and autonomy belong to the user.",
            schema: json!({
                "type": "object",
                "properties": {
                    "text": { "type": "string", "description": "The new description, written as instructions to you." }
                },
                "required": ["text"]
            }),
            keywords: &["persona", "instructions", "description", "myself", "rewrite"],
            core: false,
        },
        Tool {
            name: "search_messages",
            description: "Search your own conversation: everything you, the user and whoever wrote to you have said in it. Use it before asking the user something they may already have said. What another agent knows is not in here; that you ask it for.",
            schema: json!({
                "type": "object",
                "properties": {
                    "query": { "type": "string", "description": "Words to look for." },
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

/// The names behind the gateway, for the sheet to list.
///
/// Names only, never schemas — the schemas are what the gateway exists to keep
/// out of the prompt, and `create_agent` alone now carries the whole model
/// catalogue. But an agent that is told only that "everything else" exists has
/// no reason to go looking: asked to create an agent, a codex one reached for
/// its own `spawn_agent`, which sounds exactly like the job and is not Crew's.
pub fn hidden_names() -> Vec<&'static str> {
    catalog()
        .into_iter()
        .filter(|tool| !tool.core)
        .map(|tool| tool.name)
        .collect()
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
        "continue_after_turn" => continue_after_turn(store, caller, args),
        "update_description" => update_description(store, transcripts, caller, args),
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

/// Who a message is addressed to. An id, and only an id.
///
/// A name is the user's: they rename an agent in the sheet and every name that
/// ever resolved goes stale, sometimes onto a different agent. An id outlives
/// that. A name that arrives anyway is answered with the id it meant, so the
/// recovery is one call and not a round of guessing.
fn find_agent(store: &Store, caller: &Session, who: &str) -> Result<Session, String> {
    let who = who.trim();
    let agents: Vec<Session> = session::list(store, caller.workspace_id.clone())?
        .into_iter()
        .filter(|row| row.kind == "agent")
        .collect();
    if let Some(found) = agents.iter().find(|row| row.id == who) {
        return Ok(found.clone());
    }
    Err(match agents.iter().find(|row| row.name.eq_ignore_ascii_case(who)) {
        Some(named) => format!(
            "Agents are addressed by id, not by name. {} is {}.",
            named.name, named.id
        ),
        None => format!(
            "No agent {who} in this workspace. list_agents has the ids: {}",
            agents
                .iter()
                .map(|row| format!("{} {}", row.name, row.id))
                .collect::<Vec<_>>()
                .join(", ")
        ),
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
    // Two intentions that used to share one argument: a name that resolved to
    // the caller started a turn nobody had asked for, and the agent read it as
    // a message from somebody else.
    if who.trim() == caller.id || who.trim().eq_ignore_ascii_case(&caller.name) {
        return Err(
            "That is you. To carry on after this turn ends, use continue_after_turn.".to_string(),
        );
    }
    let target = find_agent(store, caller, &who)?;

    let from = crew_protocol::AgentRef { id: caller.id.clone(), name: caller.name.clone() };
    mailbox::enqueue(store, &target.id, &from, &body)?;

    // What goes over is the oldest letter, which may not be this one: a queue
    // that delivers out of order is worse than one that waits.
    let delivered = deliver(&target);
    let waiting = mailbox::waiting_count(store, &target.id)?;
    Ok(json!({
        "to": target.name,
        "id": target.id,
        "delivered": delivered,
        "waiting": waiting,
        "note": if delivered {
            format!("{} is reading it now.", target.name)
        } else {
            format!("{} is busy; it will read this when its turn ends.", target.name)
        }
    }))
}

/// A note an agent leaves itself, which the end of this turn hands back as the
/// next one. No delivery attempt: the caller is mid-turn by definition, so the
/// letter would only bounce and go back in the box. `run_turn` drains it.
fn continue_after_turn(store: &Store, caller: &Session, args: &Value) -> Result<Value, String> {
    let body = text(args.get("text")).ok_or_else(|| "text is required".to_string())?;
    let from = crew_protocol::AgentRef { id: caller.id.clone(), name: caller.name.clone() };
    mailbox::enqueue(store, &caller.id, &from, &body)?;
    Ok(json!({
        "waiting": mailbox::waiting_count(store, &caller.id)?,
        "note": "You will read this as a new turn once this one ends, with the tail of this conversation. Stop leaving yourself notes when the work is done."
    }))
}

/// The standing instructions an agent is handed every turn, rewritten by the
/// agent itself. Whole, not patched: a description assembled from edits nobody
/// read end to end is one nobody can predict the next turn from.
fn update_description(
    store: &Store,
    transcripts: &TranscriptHub,
    caller: &Session,
    args: &Value,
) -> Result<Value, String> {
    let body = text(args.get("text")).ok_or_else(|| "text is required".to_string())?;
    session::update(
        store,
        caller.id.clone(),
        caller.name.clone(),
        caller.provider.clone(),
        caller.model.clone(),
        body.clone(),
        caller.notifications,
        caller.autonomy.clone(),
    )?;
    transcripts.append_system(&caller.id, "Description updated by itself");
    Ok(json!({
        "description": body,
        "note": "This is what you will be told you are at the top of your next turn."
    }))
}

fn search_messages(store: &Store, caller: &Session, args: &Value) -> Result<Value, String> {
    let query = text(args.get("query")).ok_or_else(|| "query is required".to_string())?;
    let limit = args.get("limit").and_then(Value::as_u64).unwrap_or(10).clamp(1, 50) as u32;
    let days = args.get("days").and_then(Value::as_u64);
    // One conversation, the caller's own. The transcript is the only memory an
    // agent has, and the mailbox is the only way into somebody else's: a search
    // across the workspace would be a second channel that shows up in no chat.
    let hits = crate::messages::search(
        store,
        crew_protocol::SearchQuery {
            query,
            workspace_id: Some(caller.workspace_id.clone()),
            session_ids: vec![caller.id.clone()],
            // The schema has no upper bound; past any calendar is all of time.
            from: days.map(|days| {
                now_millis().saturating_sub(i64::try_from(days).unwrap_or(i64::MAX).saturating_mul(86_400_000))
            }),
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
            provider_names().join(", ")
        )
    })?;
    let requested = text(args.get("model"));
    if let Some(requested) = &requested {
        if !models.contains(&requested.as_str()) {
            return Err(unknown_model(requested, &provider, &models));
        }
    }
    let model = requested.unwrap_or_else(|| {
        if provider == caller.provider {
            caller.model.clone()
        } else {
            models.first().copied().unwrap_or_default().to_string()
        }
    });
    // Inherited, never asked for. An agent that has to stop at every command
    // could otherwise build one that does not, and then send it the command.
    let autonomy = caller.autonomy.clone();
    let session = session::create(
        store,
        caller.workspace_id.clone(),
        "agent".into(),
        name.clone(),
        provider.clone(),
        model.clone(),
        description,
        autonomy.clone(),
    )?;
    on_created(&session);
    transcripts.append_system(&session.id, &format!("Created by {}", caller.name));
    // The creator's own chat, so the roster growing is something the user reads
    // where they are, not something they find in the sidebar.
    transcripts.append_system(&caller.id, &format!("Created agent {name} ({})", session.id));
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

/// Everything that could be the model somebody asked for, wherever it lives.
///
/// The same model is spelled differently by every provider — Grok 4.6 is
/// `cursor-grok-4.6-high` under cursor and does not exist under codex — so a
/// caller who knows it as "grok 4.6" has no way to reach it by guessing.
/// Matching on letters and digits alone forgives the spacing, the dashes and
/// the case, which is all the difference usually is.
fn like(wanted: &str) -> Vec<(&'static str, &'static str)> {
    let squash = |text: &str| {
        text.chars()
            .filter(|c| c.is_alphanumeric())
            .flat_map(char::to_lowercase)
            .collect::<String>()
    };
    let wanted = squash(wanted);
    if wanted.is_empty() {
        return Vec::new();
    }
    PROVIDERS
        .iter()
        .flat_map(|(provider, models)| models.iter().map(move |model| (*provider, *model)))
        .filter(|(_, model)| {
            let model = squash(model);
            model.contains(&wanted) || wanted.contains(&model)
        })
        .collect()
}

/// A refusal that ends the guessing: where the model actually is, or the whole
/// catalogue when it is nowhere. Paid once, on a miss.
fn unknown_model(wanted: &str, provider: &str, models: &[&str]) -> String {
    let found = like(wanted);
    if !found.is_empty() {
        let where_ = found
            .iter()
            .map(|(provider, model)| format!("{model} (provider {provider})"))
            .collect::<Vec<_>>()
            .join(", ");
        return format!(
            "No model \"{wanted}\" under {provider}. Spelled this way it is: {where_}. \
             Pass provider and model together."
        );
    }
    let catalogue = PROVIDERS
        .iter()
        .map(|(provider, models)| format!("{provider}: {}", models.join(", ")))
        .collect::<Vec<_>>()
        .join("\n");
    format!(
        "No model \"{wanted}\" anywhere, under {provider} or elsewhere. {provider} has: {}.\n\
         Everything there is:\n{catalogue}",
        models.join(", ")
    )
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
                "continue_after_turn".to_string(),
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
        let cuddles = agent(&store, &ws, "Cuddles");
        let postman = Postman::default();
        let out = call(
            &store,
            &transcripts,
            &postman,
            &coder,
            "call_tool",
            json!({ "name": "message_agent", "arguments": { "to": cuddles.id, "text": "via gateway" } }),
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
        transcripts.append_user(&coder.id, "the staging password is in 1password", false, None);
        transcripts.flush(&coder.id);

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
        // The UI's hit markers never reach a model.
        assert!(!text.contains(crate::messages::MARK_OPEN));
    }

    /// The mailbox is the only way into another agent's conversation. A search
    /// that reached it would be a second channel, read-only and silent, that
    /// shows up in no chat.
    #[test]
    fn a_search_stops_at_the_edge_of_its_own_conversation() {
        let store = store();
        let transcripts = TranscriptHub::new(store.clone());
        let ws = workspace(&store);
        let coder = agent(&store, &ws, "Coder");
        let cuddles = agent(&store, &ws, "Cuddles");
        transcripts.append_user(&cuddles.id, "the client is Acme", false, None);
        transcripts.flush(&cuddles.id);

        let postman = Postman::default();
        let out = call(
            &store,
            &transcripts,
            &postman,
            &coder,
            "search_messages",
            json!({ "query": "Acme" }),
        )
        .expect("call");
        assert!(!is_error(&out), "{}", body(&out));
        assert!(!body(&out).contains("Acme"), "{}", body(&out));
    }

    #[test]
    fn a_message_reaches_an_idle_agent_right_away() {
        let store = store();
        let transcripts = TranscriptHub::new(store.clone());
        let ws = workspace(&store);
        let coder = agent(&store, &ws, "Coder");
        let cuddles = agent(&store, &ws, "Cuddles");
        let postman = Postman::default();

        let out = call(
            &store,
            &transcripts,
            &postman,
            &coder,
            "message_agent",
            json!({ "to": cuddles.id, "text": "the branch is green" }),
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
            json!({ "to": cuddles.id, "text": "when you get a minute" }),
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
        call(&store, &transcripts, &busy, &coder, "message_agent", json!({ "to": cuddles.id, "text": "first" }))
            .expect("first");
        let free = Postman::default();
        call(&store, &transcripts, &free, &coder, "message_agent", json!({ "to": cuddles.id, "text": "second" }))
            .expect("second");

        assert_eq!(free.handed.borrow()[0].1, "first");
        assert_eq!(mailbox::waiting_count(&store, &cuddles.id).expect("count"), 1);
    }

    #[test]
    fn a_note_to_yourself_is_how_an_agent_carries_on() {
        let store = store();
        let transcripts = TranscriptHub::new(store.clone());
        let ws = workspace(&store);
        let coder = agent(&store, &ws, "Coder");
        let postman = Postman::default();
        let out = call(
            &store,
            &transcripts,
            &postman,
            &coder,
            "continue_after_turn",
            json!({ "text": "next: run the tests" }),
        )
        .expect("call");
        assert!(!is_error(&out), "{}", body(&out));
        assert!(body(&out).contains("once this one ends"), "{}", body(&out));
        // The caller is mid-turn by definition, so nothing is handed over now:
        // the end of the turn drains it.
        assert!(postman.handed.borrow().is_empty());
        let waiting = mailbox::waiting(&store, &coder.id).expect("waiting");
        assert_eq!(waiting.len(), 1);
        assert_eq!(waiting[0].from.id, coder.id);
    }

    /// The bug this closes: the agent meant the one it had just created, wrote
    /// its own name, and started a turn nobody asked for.
    #[test]
    fn message_agent_sends_you_to_the_other_tool_when_you_address_yourself() {
        let store = store();
        let transcripts = TranscriptHub::new(store.clone());
        let ws = workspace(&store);
        let coder = agent(&store, &ws, "Coder");
        let postman = Postman::default();
        for who in [coder.id.as_str(), "Coder", "  coder "] {
            let out = call(
                &store,
                &transcripts,
                &postman,
                &coder,
                "message_agent",
                json!({ "to": who, "text": "next: run the tests" }),
            )
            .expect("call");
            assert!(is_error(&out), "{who} was accepted: {}", body(&out));
            assert!(body(&out).contains("continue_after_turn"), "{}", body(&out));
        }
        assert_eq!(mailbox::waiting_count(&store, &coder.id).expect("count"), 0);
    }

    /// A description written by another model is fine; one the agent cannot
    /// revise is a persona it is stuck with.
    #[test]
    fn an_agent_can_rewrite_what_it_is() {
        let store = store();
        let transcripts = TranscriptHub::new(store.clone());
        let ws = workspace(&store);
        let coder = agent(&store, &ws, "Coder");
        let postman = Postman::default();
        let out = call(
            &store,
            &transcripts,
            &postman,
            &coder,
            "update_description",
            json!({ "text": "You keep the release notes." }),
        )
        .expect("call");
        assert!(!is_error(&out), "{}", body(&out));

        let after = session::get(&store, coder.id.clone()).expect("get").expect("agent");
        assert_eq!(after.description, "You keep the release notes.");
        // Untouched: they are the user's to change.
        assert_eq!(after.name, "Coder");
        assert_eq!(after.autonomy, "ask");

        let notes = transcripts.window(&coder.id, None, None).blocks;
        assert!(
            notes.iter().any(|block| block.text.contains("Description updated by itself")),
            "the chat does not say it happened"
        );
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

    /// Names are the user's and go stale the moment they rename an agent, so
    /// one that arrives is refused — and answered with the id it meant, which
    /// costs a call instead of a round of guessing.
    #[test]
    fn a_name_is_answered_with_the_id_it_meant() {
        let store = store();
        let transcripts = TranscriptHub::new(store.clone());
        let ws = workspace(&store);
        let coder = agent(&store, &ws, "Coder");
        let cuddles = agent(&store, &ws, "Cuddles");
        let postman = Postman::default();
        let out = call(&store, &transcripts, &postman, &coder, "message_agent", json!({ "to": "  cuddles ", "text": "hi" }))
            .expect("call");
        assert!(is_error(&out), "{}", body(&out));
        assert!(body(&out).contains(&cuddles.id), "{}", body(&out));
        assert!(postman.handed.borrow().is_empty());
    }

    #[test]
    fn an_agent_in_another_workspace_is_out_of_reach() {
        let store = store();
        let transcripts = TranscriptHub::new(store.clone());
        let here = workspace(&store);
        let there = workspace(&store);
        let coder = agent(&store, &here, "Coder");
        let stranger = agent(&store, &there, "Stranger");
        let postman = Postman::default();
        // By id, so the workspace is what refuses it and not the name lookup.
        let out = call(&store, &transcripts, &postman, &coder, "message_agent", json!({ "to": stranger.id, "text": "hi" }))
            .expect("call");
        assert!(is_error(&out));
        assert!(postman.handed.borrow().is_empty());
    }

    #[test]
    fn an_id_is_how_an_agent_is_addressed() {
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
        let cuddles = agent(&store, &ws, "Cuddles");
        let postman = Postman::default();
        let out = call(&store, &transcripts, &postman, &coder, "message_agent", json!({ "to": cuddles.id }))
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
                "arguments": { "to": cuddles.id, "text": "the branch is green" }
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
    /// The catalogue lives in one const and is read into the schema, so a model
    /// added to one cannot go missing from the other — which is how an agent
    /// ends up guessing a spelling.
    #[test]
    fn the_create_schema_names_every_model_there_is() {
        let tool = catalog()
            .into_iter()
            .find(|tool| tool.name == "create_agent")
            .expect("create_agent");
        let schema = describe(&tool).to_string();
        for (provider, models) in PROVIDERS {
            assert!(schema.contains(provider), "{provider} is not in the schema");
            for model in *models {
                assert!(schema.contains(model), "{model} is not in the schema");
            }
        }
    }

    /// Measured, not guessed: a codex agent asked for "grok-4.6", `create_agent`
    /// defaulted the provider to its own, and the refusal listed five codex
    /// models. The agent reported back that Grok was not available here. It is
    /// — under cursor, spelled `cursor-grok-4.6-high`.
    #[test]
    fn a_model_that_lives_under_another_provider_says_where_it_is() {
        let store = store();
        let transcripts = TranscriptHub::new(store.clone());
        let ws = workspace(&store);
        let luna = session::create(
            &store,
            ws.clone(),
            "agent".into(),
            "Luna".into(),
            "codex".into(),
            "gpt-5.6-luna".into(),
            "".into(),
            "ask".into(),
        )
        .expect("agent");
        let postman = Postman::default();

        for asked in ["grok-4.6", "Grok 4.6", "grok_4_6"] {
            let out = call(
                &store,
                &transcripts,
                &postman,
                &luna,
                "create_agent",
                json!({ "name": "Grok", "description": "You think.", "model": asked }),
            )
            .expect("call");
            assert!(is_error(&out), "{asked} was accepted: {}", body(&out));
            let said = body(&out);
            assert!(said.contains("cursor-grok-4.6-high"), "{asked}: {said}");
            assert!(said.contains("provider cursor"), "{asked}: {said}");
        }
    }

    /// And when it really is nowhere, the answer is the whole catalogue rather
    /// than one provider's corner of it.
    #[test]
    fn a_model_that_is_nowhere_answers_with_everything_there_is() {
        let store = store();
        let transcripts = TranscriptHub::new(store.clone());
        let ws = workspace(&store);
        let coder = agent(&store, &ws, "Coder");
        let postman = Postman::default();

        let out = call(
            &store,
            &transcripts,
            &postman,
            &coder,
            "create_agent",
            json!({ "name": "X", "description": "You do X.", "model": "llama-9" }),
        )
        .expect("call");
        assert!(is_error(&out), "{}", body(&out));
        let said = body(&out);
        for provider in ["claude:", "cursor:", "codex:", "opencode:"] {
            assert!(said.contains(provider), "{provider} missing: {said}");
        }
    }

    #[test]
    fn an_agent_cannot_create_one_that_is_allowed_more_than_it_is() {
        let store = store();
        let transcripts = TranscriptHub::new(store.clone());
        let ws = workspace(&store);
        let coder = agent(&store, &ws, "Coder");
        assert_eq!(coder.autonomy, "ask");
        let postman = Postman::default();

        let out = call(
            &store,
            &transcripts,
            &postman,
            &coder,
            "create_agent",
            // The old escape hatch, now not a field the schema has.
            json!({ "name": "Runner", "description": "You run things.", "autonomy": "full" }),
        )
        .expect("call");
        assert!(!is_error(&out), "{}", body(&out));

        let made = session::list(&store, ws.clone())
            .expect("list")
            .into_iter()
            .find(|row| row.name == "Runner")
            .expect("the agent");
        assert_eq!(made.autonomy, "ask", "autonomy was granted, not inherited");

        // Both chats say it happened: the child's, and the one the user is in.
        let mine = transcripts.window(&coder.id, None, None).blocks;
        assert!(
            mine.iter().any(|block| block.text.contains(&format!("Created agent Runner ({})", made.id))),
            "the creator's chat does not say a new agent exists"
        );
        let theirs = transcripts.window(&made.id, None, None).blocks;
        assert!(theirs.iter().any(|block| block.text.contains("Created by Coder")), "{theirs:?}");
    }

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
        let cuddles = agent(&store, &ws, "Cuddles");
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
                    "arguments": { "to": cuddles.id, "text": "smuggled" }
                }
            }),
        )
        .expect("call");
        assert!(is_error(&out), "{}", body(&out));
        assert!(postman.handed.borrow().is_empty(), "the nested call went through");
    }

    /// `handle` believes the session id it is given: it is a function, and the
    /// caller is an argument. Establishing who that is belongs to the bridge,
    /// which resolves it from a token it minted for one session and ignores any
    /// id on the request — see
    /// `crewd::tests::a_token_speaks_only_for_the_session_it_was_minted_for`.
    #[test]
    fn the_caller_is_whoever_the_bridge_says_it_is() {
        let store = store();
        let transcripts = TranscriptHub::new(store.clone());
        let ws = workspace(&store);
        let coder = agent(&store, &ws, "Coder");
        let cuddles = agent(&store, &ws, "Cuddles");
        let victim = agent(&store, &ws, "Victim");
        // Busy, so the letter queues and its sender can be read back.
        let postman = Postman { busy: true, ..Postman::default() };
        // Handed Cuddles as the caller, the letter is from Cuddles.
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
                "arguments": { "to": victim.id, "text": "signed, Cuddles" }
            }),
        )
        .expect("call");
        assert!(!is_error(&out), "{}", body(&out));
        let waiting = mailbox::waiting(&store, &victim.id).expect("waiting");
        let _ = coder;
        assert_eq!(
            waiting.first().map(|letter| letter.from.name.as_str()),
            Some("Cuddles"),
            "the caller handed in is who the letter is from"
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

    use crate::routine::{RoutineRun, RunStatus, RunTrigger};
    use crew_protocol::{Block, BlockRole};
    use std::cell::Cell;

    /// One workspace with its own store, in a directory removed when it drops,
    /// and a record of what the tool host was told.
    struct Desk {
        dir: tempfile::TempDir,
        store: Store,
        transcripts: TranscriptHub,
        ws: String,
        created: RefCell<Vec<String>>,
        routines_changed: Cell<u32>,
    }

    fn desk() -> Desk {
        let (dir, store) = crate::test_support::temp_store();
        let transcripts = TranscriptHub::new(store.clone());
        let ws = crate::workspace::create(&store, "w".into(), dir.path().to_string_lossy().into())
            .expect("workspace")
            .id;
        Desk { dir, store, transcripts, ws, created: RefCell::default(), routines_changed: Cell::new(0) }
    }

    impl Desk {
        fn agent(&self, name: &str) -> Session {
            agent(&self.store, &self.ws, name)
        }

        fn session(&self, kind: &str, name: &str, provider: &str, model: &str) -> Session {
            session::create(
                &self.store,
                self.ws.clone(),
                kind.into(),
                name.into(),
                provider.into(),
                model.into(),
                "".into(),
                "ask".into(),
            )
            .expect("session")
        }

        /// An agent in a workspace of its own, out of this one's reach.
        fn stranger(&self) -> Session {
            let root = self.dir.path().join("elsewhere");
            std::fs::create_dir_all(&root).expect("root");
            let there = crate::workspace::create(&self.store, "x".into(), root.to_string_lossy().into())
                .expect("workspace")
                .id;
            agent(&self.store, &there, "Stranger")
        }

        fn handle(&self, caller: &str, method: &str, params: Value) -> Result<Value, String> {
            let postman = Postman::default();
            handle(
                &self.store,
                &self.transcripts,
                &|made| self.created.borrow_mut().push(made.name.clone()),
                &|| self.routines_changed.set(self.routines_changed.get() + 1),
                &|target| postman.deliver(&self.store, target),
                caller,
                method,
                params,
            )
        }

        fn call(&self, caller: &Session, tool: &str, args: Value) -> Value {
            self.handle(&caller.id, "tools/call", json!({ "name": tool, "arguments": args }))
                .expect("handled")
        }

        /// A tool that answered, read back as the JSON it answered with.
        fn ok(&self, caller: &Session, tool: &str, args: Value) -> Value {
            let out = self.call(caller, tool, args);
            assert!(!is_error(&out), "{tool} refused: {}", body(&out));
            serde_json::from_str(&body(&out)).unwrap_or_else(|_| Value::String(body(&out)))
        }

        /// A tool that refused, and what it said.
        fn refused(&self, caller: &Session, tool: &str, args: Value) -> String {
            let out = self.call(caller, tool, args);
            assert!(is_error(&out), "{tool} accepted: {}", body(&out));
            body(&out)
        }

        fn notes(&self, session: &Session) -> Vec<String> {
            self.transcripts
                .window(&session.id, None, None)
                .blocks
                .into_iter()
                .filter(|block| block.role == BlockRole::System)
                .map(|block| block.text)
                .collect()
        }

        /// A store that refuses one kind of write, the way a full disk would.
        fn refuse(&self, write: &str, table: &str) {
            self.store
                .with(|conn| {
                    conn.execute_batch(&format!(
                        "CREATE TEMP TRIGGER refuse_{write}_{table} BEFORE {write} ON {table}
                         BEGIN SELECT RAISE(ABORT, 'disk full'); END;"
                    ))
                })
                .expect("trigger");
        }

        fn routines(&self, owner: &Session) -> Vec<Routine> {
            routine::list_for_session(&self.store, owner.id.clone()).expect("routines")
        }

        fn routine(&self, owner: &Session, name: &str, next: Option<i64>) -> Routine {
            routine::upsert(
                &self.store,
                None,
                owner.id.clone(),
                name.into(),
                true,
                "check the board".into(),
                crate::schedule::Schedule::Interval { minutes: 30 }.to_json(),
                next,
                None,
            )
            .expect("routine")
        }
    }

    /// Local wall clock, the way `when` reads a moment back.
    fn at(year: i32, month: i32, day: i32, hour: i32, minute: i32) -> i64 {
        let mut tm: libc::tm = unsafe { std::mem::zeroed() };
        tm.tm_year = year - 1900;
        tm.tm_mon = month - 1;
        tm.tm_mday = day;
        tm.tm_hour = hour;
        tm.tm_min = minute;
        tm.tm_isdst = -1;
        (unsafe { libc::mktime(&mut tm) }) as i64 * 1000
    }

    /// Lines in a conversation, each at the moment given.
    fn said(store: &Store, session: &Session, lines: &[(BlockRole, &str, i64)]) {
        let blocks: Vec<Block> = lines
            .iter()
            .enumerate()
            .map(|(index, (role, text, at))| Block {
                id: format!("b{index}"),
                role: role.clone(),
                text: text.to_string(),
                at: Some(*at),
                hidden: None,
                streaming: None,
                files: None,
                tool: None,
                approval: None,
                question: None,
                usage: None,
                from_agent: None,
            })
            .collect();
        store
            .with(|conn| crate::messages::sync(conn, &session.id, &blocks, &mut Vec::new()))
            .expect("sync");
    }

    fn texts(hits: &Value) -> Vec<&str> {
        hits.as_array().expect("hits").iter().map(|hit| hit["text"].as_str().unwrap_or_default()).collect()
    }

    #[test]
    fn a_caller_that_no_longer_exists_is_turned_away_before_anything_runs() {
        let desk = desk();
        let error = desk.handle("ghost", "tools/list", json!({})).expect_err("a ghost was served");
        assert_eq!(error, "This session no longer exists in Crew");
    }

    #[test]
    fn a_method_the_bridge_does_not_speak_is_an_error_not_a_tool_answer() {
        let desk = desk();
        let coder = desk.agent("Coder");
        let error = desk.handle(&coder.id, "resources/list", json!({})).expect_err("answered");
        assert_eq!(error, "Unknown method resources/list");
    }

    #[test]
    fn arguments_that_are_not_an_object_read_as_none_at_all() {
        let desk = desk();
        let coder = desk.agent("Coder");
        let out = desk
            .handle(&coder.id, "tools/call", json!({ "name": "message_agent", "arguments": "hi Cuddles" }))
            .expect("handled");
        assert!(is_error(&out));
        assert_eq!(body(&out), "to is required\nmessage_agent takes: to, text.");
    }

    #[test]
    fn a_call_that_names_no_tool_lists_the_tools_there_are() {
        let desk = desk();
        let coder = desk.agent("Coder");
        let out = desk.handle(&coder.id, "tools/call", json!({})).expect("handled");
        assert!(is_error(&out));
        assert!(body(&out).starts_with("Unknown tool \"\". One of: list_agents, create_agent"), "{}", body(&out));
    }

    #[test]
    fn list_agents_names_every_agent_here_and_marks_the_caller() {
        let desk = desk();
        let coder = desk.agent("Coder");
        let cuddles = desk.session("agent", "Cuddles", "codex", "gpt-5.5");
        desk.session("terminal", "Shell", "", "");
        desk.stranger();

        let rows = desk.ok(&coder, "list_agents", json!({}));

        assert_eq!(
            rows,
            json!([
                {
                    "id": coder.id, "name": "Coder", "description": "", "provider": "claude",
                    "model": "claude-opus-5", "autonomy": "ask", "status": "idle", "self": true
                },
                {
                    "id": cuddles.id, "name": "Cuddles", "description": "", "provider": "codex",
                    "model": "gpt-5.5", "autonomy": "ask", "status": "idle"
                }
            ])
        );
    }

    /// Required first, in the order the schema names them, then the rest.
    #[test]
    fn a_refusal_lists_what_is_required_before_what_is_optional() {
        let desk = desk();
        let coder = desk.agent("Coder");
        assert_eq!(
            desk.refused(&coder, "create_agent", json!({})),
            "name is required\ncreate_agent takes: name, description, model, provider."
        );
        assert_eq!(desk.refused(&coder, "find_tool", json!({})), "query is required\nfind_tool takes: query, limit.");
    }

    #[test]
    fn a_tool_with_nothing_required_still_names_what_it_takes() {
        let desk = desk();
        let coder = desk.agent("Coder");
        let said = desk.refused(&coder, "upsert_routine", json!({ "title": "Standup" }));
        assert!(said.starts_with("name is required\nupsert_routine takes: "), "{said}");
        for field in ["routine_id", "agent_id", "name", "prompt", "schedule", "enabled"] {
            assert!(said.contains(field), "{field} missing: {said}");
        }
    }

    /// A number where a string goes is refused the way a missing one is, and
    /// the refusal still says what the tool takes.
    #[test]
    fn a_wrong_typed_argument_is_refused_like_a_missing_one() {
        let desk = desk();
        let coder = desk.agent("Coder");
        assert_eq!(
            desk.refused(&coder, "message_agent", json!({ "to": 5, "text": ["hi"] })),
            "to is required\nmessage_agent takes: to, text."
        );
        assert_eq!(
            desk.refused(&coder, "search_messages", json!({ "query": 42 })),
            "query is required\nsearch_messages takes: query, days, limit."
        );
    }

    #[test]
    fn a_refusal_from_a_tool_that_takes_nothing_stays_as_it_came() {
        assert_eq!(with_arguments("list_agents", "the store is locked"), "the store is locked");
    }

    #[test]
    fn a_description_needs_text_and_is_left_alone_without_it() {
        let desk = desk();
        let coder = desk.agent("Coder");
        for args in [json!({}), json!({ "text": "   " }), json!({ "text": 7 })] {
            assert!(desk.refused(&coder, "update_description", args).starts_with("text is required"));
        }
        assert!(desk.notes(&coder).is_empty(), "{:?}", desk.notes(&coder));
    }

    /// The name is the user's. A field the schema does not have changes nothing.
    #[test]
    fn update_description_cannot_rename_the_agent() {
        let desk = desk();
        let coder = desk.agent("Coder");

        let out = desk.ok(&coder, "update_description", json!({ "text": "You ship.", "name": "Boss" }));

        assert_eq!(out["description"], "You ship.");
        let after = session::get(&desk.store, coder.id.clone()).expect("get").expect("agent");
        assert_eq!((after.name.as_str(), after.description.as_str()), ("Coder", "You ship."));
    }

    #[test]
    fn a_description_the_store_would_not_keep_is_not_announced() {
        let desk = desk();
        let coder = desk.agent("Coder");
        desk.refuse("UPDATE", "sessions");

        assert!(desk.refused(&coder, "update_description", json!({ "text": "You ship." })).contains("disk full"));
        assert!(desk.notes(&coder).is_empty(), "the chat says it changed: {:?}", desk.notes(&coder));
    }

    #[test]
    fn a_search_needs_something_to_look_for() {
        let desk = desk();
        let coder = desk.agent("Coder");
        for args in [json!({}), json!({ "query": "   " })] {
            assert!(desk.refused(&coder, "search_messages", args).starts_with("query is required"));
        }
    }

    #[test]
    fn a_hit_says_who_said_it_when_and_in_what_role() {
        let desk = desk();
        let coder = desk.agent("Coder");
        said(&desk.store, &coder, &[
            (BlockRole::User, "the deploy key rotates monthly", at(2026, 3, 4, 15, 4)),
            (BlockRole::Assistant, "noted, the deploy key rotates", at(2026, 3, 4, 0, 5)),
        ]);

        let hits = desk.ok(&coder, "search_messages", json!({ "query": "deploy key" }));

        let mut rows: Vec<(String, String, String)> = hits
            .as_array()
            .expect("hits")
            .iter()
            .map(|hit| {
                assert_eq!(hit["agent"], "Coder");
                (
                    hit["role"].as_str().unwrap_or_default().to_string(),
                    hit["when"].as_str().unwrap_or_default().to_string(),
                    hit["text"].as_str().unwrap_or_default().to_string(),
                )
            })
            .collect();
        rows.sort();
        assert_eq!(
            rows,
            vec![
                ("assistant".into(), "Mar 4, 2026, 12:05 AM".into(), "noted, the deploy key rotates".into()),
                ("user".into(), "Mar 4, 2026, 3:04 PM".into(), "the deploy key rotates monthly".into()),
            ]
        );
    }

    /// Timestamps far on either side of today, so "the last day" has one
    /// answer without the test reading the clock.
    #[test]
    fn days_keeps_the_search_to_the_last_so_many_days() {
        let desk = desk();
        let coder = desk.agent("Coder");
        said(&desk.store, &coder, &[
            (BlockRole::User, "the old deploy key", at(1990, 1, 1, 9, 0)),
            (BlockRole::User, "the new deploy key", at(2100, 1, 1, 9, 0)),
        ]);

        let recent = desk.ok(&coder, "search_messages", json!({ "query": "deploy", "days": 1 }));
        let all = desk.ok(&coder, "search_messages", json!({ "query": "deploy" }));

        assert_eq!(texts(&recent), vec!["the new deploy key"]);
        assert_eq!(all.as_array().map(Vec::len), Some(2));
    }

    /// No upper bound in the schema, so a number of days past any calendar is
    /// all of time, not arithmetic that runs off the end of an i64.
    #[test]
    fn days_beyond_any_calendar_means_all_of_time() {
        let desk = desk();
        let coder = desk.agent("Coder");
        said(&desk.store, &coder, &[(BlockRole::User, "the old deploy key", at(1990, 1, 1, 9, 0))]);

        for days in [200_000_000_000_u64, u64::MAX] {
            let hits = desk.ok(&coder, "search_messages", json!({ "query": "deploy", "days": days }));
            assert_eq!(texts(&hits), vec!["the old deploy key"], "{days}");
        }
    }

    #[test]
    fn limit_caps_the_hits_and_never_asks_for_none() {
        let desk = desk();
        let coder = desk.agent("Coder");
        said(&desk.store, &coder, &[
            (BlockRole::User, "deploy one", at(2026, 3, 4, 9, 0)),
            (BlockRole::User, "deploy two", at(2026, 3, 4, 10, 0)),
            (BlockRole::User, "deploy three", at(2026, 3, 4, 11, 0)),
        ]);

        let two = desk.ok(&coder, "search_messages", json!({ "query": "deploy", "limit": 2 }));
        let floor = desk.ok(&coder, "search_messages", json!({ "query": "deploy", "limit": 0 }));

        assert_eq!(two.as_array().map(Vec::len), Some(2));
        assert_eq!(floor.as_array().map(Vec::len), Some(1));
    }

    #[test]
    fn a_search_the_store_cannot_run_is_a_refusal() {
        let desk = desk();
        let coder = desk.agent("Coder");
        desk.store.with(|conn| conn.execute_batch("DROP TABLE messages_fts")).expect("drop");

        assert!(desk.refused(&coder, "search_messages", json!({ "query": "deploy" })).contains("messages_fts"));
    }

    #[test]
    fn create_agent_needs_a_name_and_a_job() {
        let desk = desk();
        let coder = desk.agent("Coder");
        assert!(desk.refused(&coder, "create_agent", json!({ "description": "You test." })).starts_with("name is required"));
        assert!(desk
            .refused(&coder, "create_agent", json!({ "name": "Tester", "description": " " }))
            .starts_with("description is required: say what the agent is for"));
        assert!(desk.created.borrow().is_empty());
    }

    #[test]
    fn a_provider_crew_does_not_have_is_refused_with_the_ones_it_does() {
        let desk = desk();
        let coder = desk.agent("Coder");
        let gemini = desk.session("agent", "Gem", "gemini", "gemini-pro");
        let expected = "Unknown provider \"gemini\". One of: claude, cursor, codex, opencode";

        let asked = desk.refused(&coder, "create_agent", json!({ "name": "T", "description": "d", "provider": "gemini" }));
        // Defaulted from a caller whose own provider is not one Crew has.
        let inherited = desk.refused(&gemini, "create_agent", json!({ "name": "T", "description": "d" }));

        assert!(asked.starts_with(expected), "{asked}");
        assert!(inherited.starts_with(expected), "{inherited}");
        assert!(desk.created.borrow().is_empty());
    }

    #[test]
    fn a_new_agent_takes_the_model_it_was_given_or_a_sensible_default() {
        let desk = desk();
        let coder = desk.session("agent", "Coder", "claude", "claude-sonnet-5");
        let cases = [
            // Same provider: the caller's own model.
            (json!({}), "claude", "claude-sonnet-5"),
            (json!({ "provider": "claude" }), "claude", "claude-sonnet-5"),
            // Another provider: that provider's first.
            (json!({ "provider": "codex" }), "codex", "gpt-6-astra"),
            (json!({ "provider": "cursor", "model": "gpt-5.2" }), "cursor", "gpt-5.2"),
            (json!({ "model": "claude-opus-4-5" }), "claude", "claude-opus-4-5"),
        ];
        for (index, (extra, provider, model)) in cases.into_iter().enumerate() {
            let mut args = json!({ "name": format!("Helper {index}"), "description": "You help." });
            args.as_object_mut().expect("args").extend(extra.as_object().expect("extra").clone());

            let made = desk.ok(&coder, "create_agent", args.clone());

            assert_eq!((made["provider"].as_str(), made["model"].as_str()), (Some(provider), Some(model)), "{args}");
            assert_eq!(made["status"], "idle");
            let row = session::get(&desk.store, made["id"].as_str().unwrap_or_default().into())
                .expect("get")
                .expect("created");
            assert_eq!((row.provider.as_str(), row.model.as_str()), (provider, model));
            assert_eq!(row.description, "You help.");
        }
        assert_eq!(desk.created.borrow().len(), 5, "the host was not told about every new agent");
    }

    #[test]
    fn a_model_with_no_letters_in_it_answers_with_the_whole_catalogue() {
        let desk = desk();
        let coder = desk.agent("Coder");
        let said = desk.refused(&coder, "create_agent", json!({ "name": "X", "description": "d", "model": "--" }));
        assert!(said.starts_with("No model \"--\" anywhere, under claude or elsewhere."), "{said}");
    }

    /// The host announces a new agent to every client. One the store never
    /// kept would be a tab for an agent that does not exist.
    #[test]
    fn an_agent_the_store_would_not_keep_is_not_announced() {
        let desk = desk();
        let coder = desk.agent("Coder");
        desk.refuse("INSERT", "sessions");

        desk.refused(&coder, "create_agent", json!({ "name": "Tester", "description": "You test." }));

        assert!(desk.created.borrow().is_empty(), "the host was told about it");
        assert!(desk.notes(&coder).is_empty(), "the chat says it was made");
    }

    #[test]
    fn list_routines_describes_each_routine_in_words() {
        let desk = desk();
        let coder = desk.agent("Coder");
        let made = desk.routine(&coder, "Standup", Some(at(2030, 1, 2, 15, 4)));
        routine::record_run(&desk.store, &made.id, Some(1), Some(at(2030, 1, 2, 15, 4)), &RoutineRun {
            id: "r1".into(),
            started_at: at(2030, 1, 2, 9, 0),
            finished_at: None,
            status: RunStatus::Ok,
            trigger: RunTrigger::Schedule,
        })
        .expect("run");

        assert_eq!(
            desk.ok(&coder, "list_routines", json!({})),
            json!([{
                "id": made.id,
                "agent": "Coder",
                "agent_id": coder.id,
                "name": "Standup",
                "enabled": true,
                "schedule": "Every 30 minutes",
                "prompt": "check the board",
                "last_run": "ok at Jan 2, 2030, 9:00 AM",
                "next_run": "Jan 2, 2030, 3:04 PM"
            }])
        );
    }

    /// Whatever an older Crew left in the columns, the listing still answers.
    #[test]
    fn a_routine_whose_columns_cannot_be_read_is_listed_as_they_are() {
        let desk = desk();
        let coder = desk.agent("Coder");
        let made = desk.routine(&coder, "Standup", None);
        desk.store
            .with(|conn| {
                conn.execute(
                    "UPDATE routines SET schedule = 'every so often', runs_json = 'not json' WHERE id = ?1",
                    rusqlite::params![made.id],
                )
            })
            .expect("corrupt");

        let listed = desk.ok(&coder, "list_routines", json!({}));

        assert_eq!(listed[0]["schedule"], "every so often");
        assert_eq!(listed[0]["last_run"], "never");
        assert_eq!(listed[0]["next_run"], "not scheduled");
    }

    #[test]
    fn list_routines_reads_any_agent_here_and_no_one_elsewhere() {
        let desk = desk();
        let coder = desk.agent("Coder");
        let cuddles = desk.agent("Cuddles");
        let shell = desk.session("terminal", "Shell", "", "");
        let stranger = desk.stranger();
        desk.routine(&cuddles, "Review", None);

        assert_eq!(desk.ok(&coder, "list_routines", json!({})), json!([]));
        assert_eq!(desk.ok(&coder, "list_routines", json!({ "agent_id": coder.id })), json!([]));
        assert_eq!(desk.ok(&coder, "list_routines", json!({ "agent_id": cuddles.id }))[0]["name"], "Review");
        for other in [shell.id.as_str(), stranger.id.as_str(), "nobody"] {
            assert_eq!(
                desk.refused(&coder, "list_routines", json!({ "agent_id": other })),
                format!("No agent {other} in this workspace. Use list_agents for ids.\nlist_routines takes: agent_id.")
            );
        }
    }

    #[test]
    fn upsert_routine_sets_up_a_routine_for_the_caller() {
        let desk = desk();
        let coder = desk.agent("Coder");

        let made = desk.ok(
            &coder,
            "upsert_routine",
            json!({
                "name": "Standup",
                "prompt": "check the board",
                "schedule": { "kind": "daily", "hour": 9, "days": [1, 2, 3, 4, 5] }
            }),
        );

        assert_eq!(made["schedule"], "Weekdays at 09:00");
        assert_eq!(made["enabled"], true);
        assert_eq!(made["last_run"], "never");
        assert_ne!(made["next_run"], "not scheduled");
        let rows = desk.routines(&coder);
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].created_by.as_deref(), Some(coder.id.as_str()));
        assert!(rows[0].next_run_at.is_some());
        assert_eq!(desk.routines_changed.get(), 1, "the scheduler was not told to look again");
        assert!(desk.notes(&coder).is_empty(), "its own routine was announced to itself");
    }

    #[test]
    fn upsert_routine_refuses_what_it_cannot_schedule_and_writes_nothing() {
        let desk = desk();
        let coder = desk.agent("Coder");
        let good = || {
            json!({
                "name": "Standup",
                "prompt": "check the board",
                "schedule": { "kind": "interval", "minutes": 30 }
            })
        };
        let without = |field: &str| {
            let mut args = good();
            args.as_object_mut().expect("args").remove(field);
            args
        };
        let with = |field: &str, value: Value| {
            let mut args = good();
            args[field] = value;
            args
        };
        let cases = [
            (without("name"), "name is required"),
            (without("prompt"), "prompt is required"),
            (without("schedule"), "schedule is required. schedule is {"),
            (with("schedule", Value::Null), "schedule is required. schedule is {"),
            (with("schedule", json!({ "kind": "interval", "minutes": 0 })), "minutes must be a whole number"),
            (with("schedule", json!({ "kind": "cron", "expression": "soon" })), "expression must be five cron fields"),
        ];
        for (args, starts) in cases {
            let said = desk.refused(&coder, "upsert_routine", args.clone());
            assert!(said.starts_with(starts), "{args}: {said}");
        }
        assert!(desk.routines(&coder).is_empty());
        assert_eq!(desk.routines_changed.get(), 0);
    }

    #[test]
    fn a_routine_set_up_for_another_agent_is_announced_in_its_chat() {
        let desk = desk();
        let coder = desk.agent("Coder");
        let cuddles = desk.agent("Cuddles");

        let made = desk.ok(
            &coder,
            "upsert_routine",
            json!({
                "agent_id": cuddles.id,
                "name": "Nightly",
                "prompt": "run the suite",
                "schedule": { "kind": "cron", "expression": "0 2 * * *" }
            }),
        );

        assert_eq!(made["agent"], "Cuddles");
        assert_eq!(made["schedule"], "Cron 0 2 * * *");
        assert_eq!(desk.notes(&cuddles), vec!["Routine · Nightly set up by Coder".to_string()]);
        assert_eq!(desk.routines(&cuddles)[0].created_by.as_deref(), Some(coder.id.as_str()));
        assert!(desk.routines(&coder).is_empty());
    }

    #[test]
    fn a_routine_the_store_would_not_keep_is_not_announced() {
        let desk = desk();
        let coder = desk.agent("Coder");
        let cuddles = desk.agent("Cuddles");
        desk.refuse("INSERT", "routines");

        desk.refused(
            &coder,
            "upsert_routine",
            json!({
                "agent_id": cuddles.id,
                "name": "Nightly",
                "prompt": "run the suite",
                "schedule": { "kind": "interval", "minutes": 60 }
            }),
        );

        assert!(desk.notes(&cuddles).is_empty(), "its chat says it was set up");
        assert_eq!(desk.routines_changed.get(), 0, "the scheduler was told to look for it");
    }

    /// An update names what changes. Everything it leaves out stays as it was.
    #[test]
    fn an_update_changes_only_what_it_names() {
        let desk = desk();
        let coder = desk.agent("Coder");
        let cuddles = desk.agent("Cuddles");
        let made = desk.routine(&cuddles, "Review", Some(at(2030, 1, 2, 15, 4)));

        let updated = desk.ok(
            &coder,
            "upsert_routine",
            json!({ "agent_id": cuddles.id, "routine_id": made.id, "prompt": "review the open PRs" }),
        );

        assert_eq!(updated["id"], made.id.as_str());
        assert_eq!(updated["name"], "Review");
        assert_eq!(updated["prompt"], "review the open PRs");
        assert_eq!(updated["schedule"], "Every 30 minutes");
        assert_eq!(updated["enabled"], true);
        assert_eq!(desk.routines(&cuddles).len(), 1);
        assert_eq!(desk.notes(&cuddles), vec!["Routine · Review updated by Coder".to_string()]);
    }

    #[test]
    fn switching_a_routine_off_takes_it_off_the_clock_and_on_puts_it_back() {
        let desk = desk();
        let coder = desk.agent("Coder");
        let made = desk.routine(&coder, "Standup", Some(at(2030, 1, 2, 15, 4)));

        let off = desk.ok(&coder, "upsert_routine", json!({ "routine_id": made.id, "enabled": false }));
        assert_eq!((off["enabled"].as_bool(), off["next_run"].as_str()), (Some(false), Some("not scheduled")));
        assert_eq!(desk.routines(&coder)[0].next_run_at, None);

        // Off stays off through an edit that does not mention it.
        let renamed = desk.ok(&coder, "upsert_routine", json!({ "routine_id": made.id, "name": "Daily standup" }));
        assert_eq!(renamed["enabled"], false);

        let on = desk.ok(&coder, "upsert_routine", json!({ "routine_id": made.id, "enabled": true }));
        assert_eq!(on["enabled"], true);
        assert!(desk.routines(&coder)[0].next_run_at.is_some(), "switched on with no time to run");
    }

    /// A routine id is looked up under the agent the call is about, which is
    /// the caller unless it says otherwise.
    #[test]
    fn an_update_to_a_routine_that_is_not_there_is_refused() {
        let desk = desk();
        let coder = desk.agent("Coder");
        let cuddles = desk.agent("Cuddles");
        let theirs = desk.routine(&cuddles, "Review", None);

        for id in ["nope", theirs.id.as_str()] {
            let said = desk.refused(&coder, "upsert_routine", json!({ "routine_id": id, "name": "Mine now" }));
            assert!(said.starts_with(&format!("Coder has no routine {id}")), "{said}");
        }
        assert_eq!(desk.routines(&cuddles)[0].name, "Review");
    }

    /// An update that leaves the schedule out keeps the one stored. One the
    /// column no longer holds as a schedule has nothing to keep.
    #[test]
    fn an_update_on_top_of_a_schedule_that_cannot_be_read_asks_for_one() {
        let desk = desk();
        let coder = desk.agent("Coder");
        let made = desk.routine(&coder, "Standup", None);
        desk.store
            .with(|conn| {
                conn.execute("UPDATE routines SET schedule = '{oh no' WHERE id = ?1", rusqlite::params![made.id])
            })
            .expect("corrupt");

        let said = desk.refused(&coder, "upsert_routine", json!({ "routine_id": made.id, "name": "Standup" }));
        assert!(said.starts_with(schedule_help()), "{said}");

        let fixed = desk.ok(
            &coder,
            "upsert_routine",
            json!({ "routine_id": made.id, "schedule": { "kind": "interval", "minutes": 60 } }),
        );
        assert_eq!(fixed["schedule"], "Every hour");
    }

    #[test]
    fn delete_routine_needs_an_id_that_is_in_this_workspace() {
        let desk = desk();
        let coder = desk.agent("Coder");
        let stranger = desk.stranger();
        let far = desk.routine(&stranger, "Theirs", None);

        assert!(desk.refused(&coder, "delete_routine", json!({})).starts_with("routine_id is required"));
        for id in ["nope", far.id.as_str()] {
            let said = desk.refused(&coder, "delete_routine", json!({ "routine_id": id }));
            assert!(said.starts_with(&format!("No routine {id} in this workspace")), "{said}");
        }
        assert_eq!(desk.routines(&stranger).len(), 1, "a routine in another workspace was deleted");
        assert_eq!(desk.routines_changed.get(), 0);
    }

    #[test]
    fn deleting_your_own_routine_says_so_in_words() {
        let desk = desk();
        let coder = desk.agent("Coder");
        let made = desk.routine(&coder, "Standup", None);

        let out = desk.call(&coder, "delete_routine", json!({ "routine_id": made.id }));

        assert!(!is_error(&out));
        assert_eq!(body(&out), "Deleted \"Standup\" from Coder.");
        assert!(desk.routines(&coder).is_empty());
        assert!(desk.notes(&coder).is_empty());
        assert_eq!(desk.routines_changed.get(), 1);
    }

    #[test]
    fn deleting_another_agents_routine_is_announced_in_its_chat() {
        let desk = desk();
        let coder = desk.agent("Coder");
        let cuddles = desk.agent("Cuddles");
        let made = desk.routine(&cuddles, "Review", None);

        assert_eq!(desk.ok(&coder, "delete_routine", json!({ "routine_id": made.id })), "Deleted \"Review\" from Cuddles.");

        assert!(desk.routines(&cuddles).is_empty());
        assert_eq!(desk.notes(&cuddles), vec!["Routine · Review removed by Coder".to_string()]);
    }

    /// The listing's "last run" reads the newest entry it can make sense of.
    #[test]
    fn a_run_history_line_needs_an_id_and_a_start_to_count() {
        assert!(parse_runs("not json").is_empty());
        assert!(parse_runs(r#"{"id":"a","startedAt":1}"#).is_empty());
        assert_eq!(
            parse_runs(
                r#"[{"startedAt":1,"status":"ok"},
                    {"id":"b","status":"ok"},
                    {"id":"c","startedAt":3},
                    {"id":"d","startedAt":4,"status":"error"}]"#
            ),
            vec![(String::new(), 3), ("error".to_string(), 4)]
        );
    }

    #[test]
    fn a_moment_reads_as_a_date_and_a_twelve_hour_clock() {
        let cases = [
            (at(2026, 1, 2, 0, 5), "Jan 2, 2026, 12:05 AM"),
            (at(2026, 6, 30, 11, 59), "Jun 30, 2026, 11:59 AM"),
            (at(2026, 7, 1, 12, 0), "Jul 1, 2026, 12:00 PM"),
            (at(2026, 12, 31, 23, 9), "Dec 31, 2026, 11:09 PM"),
        ];
        for (moment, expected) in cases {
            assert_eq!(when(moment), expected);
        }
    }

    #[test]
    fn find_tool_needs_a_query_it_can_read() {
        assert_eq!(find_tool(&json!({})).expect_err("found"), "query is required");
        // Words of two letters carry no intent and are not searched for.
        let out = find_tool(&json!({ "query": "do it" })).expect("find");
        assert!(out["matches"].as_array().expect("matches").is_empty());
    }

    #[test]
    fn find_tool_ranks_name_over_keyword_over_description() {
        let names = |query: &str| -> Vec<String> {
            let out = find_tool(&json!({ "query": query, "limit": 20 })).expect("find");
            out["matches"]
                .as_array()
                .expect("matches")
                .iter()
                .map(|row| row["name"].as_str().unwrap_or_default().to_string())
                .collect()
        };
        assert_eq!(names("delete routine")[0], "delete_routine");
        // A keyword alone is enough: "hire" is in no name.
        assert_eq!(names("hire"), vec!["create_agent"]);
        // A word that only passes through descriptions is not.
        assert!(names("workspace").is_empty(), "{:?}", names("workspace"));
    }

    #[test]
    fn find_tool_answers_with_at_least_one_match() {
        let out = find_tool(&json!({ "query": "agent routine message", "limit": 0 })).expect("find");
        assert_eq!(out["matches"].as_array().expect("matches").len(), 1);
    }
}
