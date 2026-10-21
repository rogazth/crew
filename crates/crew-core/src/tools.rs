use std::sync::{Arc, RwLock};

use serde_json::{json, Value};

use crate::caller::{Caller, CallerKind};
use crate::routine::{self, Routine};
use crate::schedule::{describe_schedule, local_time, next_run, parse_schedule, schedule_help, validate_schedule, Schedule};
use crate::session::{self, Session};
use crate::store::{now_millis, Store};
use crate::transcript::TranscriptHub;

const PROVIDERS: &[(&str, &[&str])] = &[
    (
        "claude",
        &[
            "claude-fable-5-1",
            "claude-opus-5-5",
            "claude-sonnet-5-5",
            "claude-haiku-5-5",
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
            "grok-4.7-high",
            "cursor-grok-4.6-high",
            "gpt-5.3-codex",
            "claude-fable-5-1-thinking-high",
            "claude-opus-5-5-high",
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
    ("codex", &["gpt-6-astra", "gpt-6-luna", "gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna", "gpt-5.5"]),
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
    ("grok", &[]),
];

/// The model a session runs when none was picked and the CLI's own selection
/// cannot be read. Cursor, Codex, opencode and Grok otherwise use that
/// selection (`unnamed_model`). Mirrors `defaultModel` in `src/lib/providers.ts`.
pub fn default_model(provider: &str) -> &'static str {
    match provider {
        "claude" => "claude-opus-5-5",
        "cursor" => "auto",
        _ => PROVIDERS.iter().find(|(name, _)| *name == provider).and_then(|(_, models)| models.first().copied()).unwrap_or(""),
    }
}

/// The effort a session thinks at when none was picked; empty for a CLI that
/// takes none. Mirrors `defaultEffort` in `src/lib/providers.ts`.
pub fn default_effort(provider: &str) -> &'static str {
    match provider {
        "claude" => "high",
        "codex" => "medium",
        _ => "",
    }
}

/// A session's model when the caller named none. Cursor, Codex, opencode and
/// Grok use whatever their CLI has selected; the rest use `default_model`.
pub fn unnamed_model(provider: &str) -> String {
    match provider {
        "cursor" => crate::provider_session::cursor_configured_model(),
        "codex" => crate::provider_session::codex_configured_model(),
        "opencode" => crate::provider_session::opencode_configured_model(),
        "grok" => crate::provider_session::grok_configured_model(),
        _ => default_model(provider).to_string(),
    }
}

/// The effort the environment asks Claude, Codex and Grok sessions to start at
/// when none was picked: `CREW_DEFAULT_EFFORT` in the daemon's environment,
/// which a test run sets to `low` so the sessions it starts stay cheap. Nothing
/// else sets it.
fn effort_from_env(provider: &str, value: Option<String>) -> Option<String> {
    let value = value?.trim().to_string();
    (matches!(provider, "claude" | "codex" | "grok") && !value.is_empty()).then_some(value)
}

/// A session's effort when the caller named none. `CREW_DEFAULT_EFFORT` wins;
/// then Codex's is the one in its config. Grok's stays unset: sending the
/// model's marked effort would clear a higher default the CLI already has.
/// The rest use `default_effort`.
pub fn unnamed_effort(provider: &str) -> String {
    if let Some(effort) = effort_from_env(provider, std::env::var("CREW_DEFAULT_EFFORT").ok()) {
        return effort;
    }
    if provider == "codex" {
        return crate::provider_session::codex_configured_effort();
    }
    if provider == "grok" {
        return String::new();
    }
    default_effort(provider).to_string()
}

/// A session's service tier when the caller named none. Codex's is the one in
/// its config; everyone else has none.
pub fn unnamed_service_tier(provider: &str) -> String {
    if provider == "codex" {
        crate::provider_session::codex_configured_service_tier()
    } else {
        String::new()
    }
}

/// One tool, as `tools/list` describes it.
///
/// Public so a family of tools that lives in its own module — processes, the
/// browser — builds its catalog out of the same thing Crew's own tools are.
pub struct Tool {
    pub name: &'static str,
    pub description: &'static str,
    pub schema: Value,
    /// Who may see it and call it. A tool is not listed or run for a caller
    /// it does not admit.
    pub audience: Audience,
    /// Its `crew <group> <verb>` commands. Usually one; a tool that merges
    /// several verbs (`control_process`'s `action`) has one per verb, each
    /// setting the argument that tells them apart.
    pub cli: Vec<CliVerb>,
}

/// One `crew <group> <verb>` command and the tool call it makes. Declared
/// with the tool, so a tool added, renamed or merged takes its command with
/// it; the CLI builds its tree from these.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct CliVerb {
    /// The group, or for a top-level command (an empty `verb`) its name.
    pub group: &'static str,
    pub verb: &'static str,
    /// An argument this verb fixes, e.g. `("action", "start")`: not a flag,
    /// always sent.
    pub sets: Option<(&'static str, &'static str)>,
    /// Schema properties taken by position, in this order.
    pub positional: &'static [&'static str],
    /// The last positional takes every word left, joined with spaces, and
    /// `-` reads it from stdin.
    pub rest: bool,
    /// The other properties it takes as flags; `None` is all of them. For a
    /// merged tool, so `crew tabs click` does not offer `--key`.
    pub flags: Option<&'static [&'static str]>,
    pub aliases: &'static [&'static str],
    pub examples: &'static str,
    /// Its line in the group's list, when the tool's first sentence is not
    /// it: a merged tool's describes every action.
    pub about: &'static str,
}

/// `crew <group> <verb>`, built up with the methods below.
pub const fn cli(group: &'static str, verb: &'static str) -> CliVerb {
    CliVerb { group, verb, sets: None, positional: &[], rest: false, flags: None, aliases: &[], examples: "", about: "" }
}

/// `crew <name>`: a command of its own, in no group (`crew send`,
/// `crew peers`). Its `verb` is empty.
pub const fn top(name: &'static str) -> CliVerb {
    cli(name, "")
}

impl CliVerb {
    pub const fn pos(self, positional: &'static [&'static str]) -> Self {
        Self { positional, ..self }
    }
    pub const fn rest(self, positional: &'static [&'static str]) -> Self {
        Self { positional, rest: true, ..self }
    }
    pub const fn sets(self, name: &'static str, value: &'static str) -> Self {
        Self { sets: Some((name, value)), ..self }
    }
    pub const fn flags(self, flags: &'static [&'static str]) -> Self {
        Self { flags: Some(flags), ..self }
    }
    pub const fn alias(self, aliases: &'static [&'static str]) -> Self {
        Self { aliases, ..self }
    }
    pub const fn eg(self, examples: &'static str) -> Self {
        Self { examples, ..self }
    }
    pub const fn about(self, about: &'static str) -> Self {
        Self { about, ..self }
    }
}

/// Which kinds of caller a tool is for.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Audience {
    pub bot: bool,
    pub terminal: bool,
    /// A session another caller started. It is depth one: nothing that makes
    /// sessions, bots or worktrees, because its work is its parent's.
    pub child: bool,
    pub user: bool,
}

impl Audience {
    pub const EVERYONE: Self = Self { bot: true, terminal: true, child: true, user: true };
    /// Bots and terminal sessions: it needs a session behind the call, and
    /// one that may start work of its own.
    pub const SESSIONS: Self = Self { bot: true, terminal: true, child: false, user: false };
    /// Bots alone: it needs turns.
    pub const BOTS: Self = Self { bot: true, terminal: false, child: false, user: false };
    /// Bots and the user, who both have a conversation to look through.
    pub const BOTS_AND_USER: Self = Self { bot: true, terminal: false, child: false, user: true };
    /// Whoever may start sessions and drive them: everyone but a child.
    pub const PARENTS: Self = Self { bot: true, terminal: true, child: false, user: true };

    pub fn admits(self, kind: CallerKind) -> bool {
        match kind {
            CallerKind::Bot => self.bot,
            CallerKind::Terminal => self.terminal,
            CallerKind::Child => self.child,
            CallerKind::User => self.user,
        }
    }
}

/// What a tool answers with.
pub enum ToolOutput {
    /// A string goes out as it is; anything else as pretty-printed JSON.
    Value(Value),
    /// MCP content blocks exactly as they go out, for an answer that is more
    /// than text: a screenshot is an `image` block.
    Content(Vec<Value>),
}

impl From<Value> for ToolOutput {
    fn from(value: Value) -> Self {
        ToolOutput::Value(value)
    }
}

/// A family of tools that lives in its own module, next to the host it drives.
///
/// Its tools go through everything Crew's own do: listed in `tools/list` and
/// run to every caller the `audience` admits, refused to any other, and
/// answered with the tool's arguments when they are wrong. The
/// family holds whatever handles it needs; register it with
/// [`Toolbox::register`] where `crewd` builds its `ToolDispatch`.
pub trait ToolFamily: Send + Sync {
    /// Its tools. A name already taken by one of Crew's own is never reached.
    fn catalog(&self) -> Vec<Tool>;
    /// Run one of them. Only called with a name from `catalog()` whose
    /// audience admits `caller`. An `Err` is read by the model, so say what to
    /// do next.
    fn run(&self, caller: &Caller, name: &str, args: &Value) -> Result<ToolOutput, String>;
    /// A few lines for `initialize` to tell this caller, when its tools need
    /// saying more than their names: when to reach for them, what is there.
    fn instructions(&self, _caller: &Caller) -> Option<String> {
        None
    }
}

/// The tool families registered beside Crew's own. Cloned handles share one
/// list, so a family registered after the dispatcher and the turn host were
/// built is seen by both: the tool sheet in a bot's prompt names its tools
/// too.
#[derive(Clone, Default)]
pub struct Toolbox {
    families: Arc<RwLock<Vec<Arc<dyn ToolFamily>>>>,
}

/// A tool and whoever runs it: `None` is Crew's own.
struct Entry {
    tool: Tool,
    family: Option<Arc<dyn ToolFamily>>,
}

impl Toolbox {
    pub fn register(&self, family: Arc<dyn ToolFamily>) {
        self.families.write().unwrap_or_else(|e| e.into_inner()).push(family);
    }

    /// What the families have to say to this caller, in the order they registered.
    fn notes(&self, caller: &Caller) -> Vec<String> {
        let families = self.families.read().unwrap_or_else(|e| e.into_inner()).clone();
        families.iter().filter_map(|family| family.instructions(caller)).collect()
    }

    /// Every tool there is, Crew's own first.
    fn entries(&self) -> Vec<Entry> {
        let mut entries: Vec<Entry> = catalog().into_iter().map(|tool| Entry { tool, family: None }).collect();
        let families = self.families.read().unwrap_or_else(|e| e.into_inner()).clone();
        for family in families {
            for tool in family.catalog() {
                if entries.iter().any(|entry| entry.tool.name == tool.name) {
                    continue;
                }
                entries.push(Entry { tool, family: Some(family.clone()) });
            }
        }
        entries
    }

    fn visible(&self, kind: CallerKind) -> Vec<Entry> {
        self.entries().into_iter().filter(|entry| entry.tool.audience.admits(kind)).collect()
    }

    /// Every tool some kind of caller may call, each with the first kind that
    /// may (bot, terminal, child, user): what opencode's one shared server
    /// lists to all of its sessions at once.
    fn visible_to_any(&self) -> Vec<(Entry, CallerKind)> {
        const KINDS: [CallerKind; 4] = [CallerKind::Bot, CallerKind::Terminal, CallerKind::Child, CallerKind::User];
        self.entries()
            .into_iter()
            .filter_map(|entry| {
                let kind = KINDS.into_iter().find(|kind| entry.tool.audience.admits(*kind))?;
                Some((entry, kind))
            })
            .collect()
    }

    /// The names `tools/list` answers with for this kind of caller, in its
    /// order: what a prompt's tool sheet names, so the two cannot disagree.
    pub fn visible_names(&self, kind: CallerKind) -> Vec<&'static str> {
        self.visible(kind).into_iter().map(|entry| entry.tool.name).collect()
    }
}

/// Everything a tool call can reach in the daemon. Crew's own tools use the
/// fields; a family carries its own handles and only needs the toolbox to be
/// found.
pub struct Host<'a> {
    pub store: &'a Store,
    pub transcripts: &'a TranscriptHub,
    pub on_created: &'a dyn Fn(&Session),
    /// A routine just written is one the daemon has to wake for.
    pub on_routines: &'a dyn Fn(),
    pub toolbox: &'a Toolbox,
}

/// The provider names, from the one place they are listed. The enum used to be
/// written out again in the schema, which is a second list to keep in step.
pub(crate) fn provider_names() -> Vec<&'static str> {
    PROVIDERS.iter().map(|(id, _)| *id).collect()
}

/// Every model there is, grouped by the provider that has it.
///
/// It rides in `create_bot`'s own schema rather than behind a tool of its
/// own: the moment a bot needs a model id is the moment it is reading this
/// schema, and there is no second moment. Thirty-six ids are shorter than most
/// tools' arguments, and only a turn that looks up `create_bot` pays for
/// them. Without it a bot guesses from memory — `grok-4.6` under codex,
/// which is neither the provider nor the spelling — and reports back that the
/// model does not exist here.
pub(crate) fn model_sheet() -> String {
    let sheet = PROVIDERS
        .iter()
        .filter(|(_, models)| !models.is_empty())
        .map(|(provider, models)| format!("{provider}: {}", models.join(", ")))
        .collect::<Vec<_>>()
        .join("\n");
    format!("{sheet}\n{CURSOR_LISTED}\n{GROK_LISTED}")
}

/// cursor-agent lists hundreds of ids for an account, one per effort and fast
/// variant: too many for a schema, so the sheet names the pattern instead.
const CURSOR_LISTED: &str = "cursor also takes every id `cursor-agent models` lists, its effort and speed in the id: \
     grok-4.7-high, claude-opus-5-5-xhigh, gpt-5.6-sol-low-fast.";

/// Grok's catalogue and each model's efforts change without a release of Crew,
/// so the sheet names the pattern instead of a list.
const GROK_LISTED: &str = "grok takes every id its CLI lists, and a separate effort that model offers \
     (low, medium, high or xhigh). Pass provider \"grok\", the id, and the effort. Hidden models are not offered.";

/// Each provider's models: Crew's own list, then what its CLI lists for this
/// account that the list does not have yet.
fn catalogue() -> Vec<(&'static str, Vec<String>)> {
    PROVIDERS.iter().map(|(provider, models)| (*provider, with_listed(provider, models))).collect()
}

fn with_listed(provider: &str, models: &[&str]) -> Vec<String> {
    let mut all: Vec<String> = models.iter().map(|m| m.to_string()).collect();
    for listed in listed_models(provider) {
        if !all.contains(&listed) {
            all.push(listed);
        }
    }
    all
}

#[cfg(not(test))]
fn listed_models(provider: &str) -> Vec<String> {
    match provider {
        "cursor" => crate::provider_session::cursor_models().into_iter().map(|m| m.id).collect(),
        "grok" => crate::provider_session::grok_models().into_iter().map(|m| m.id).collect(),
        _ => Vec::new(),
    }
}

/// Tests run on machines with and without the CLIs; they see Crew's list.
#[cfg(test)]
fn listed_models(_provider: &str) -> Vec<String> {
    Vec::new()
}

/// Every tool Crew has, its families' included, for the CLI to build a
/// command from each: a person at a shell has no prompt to keep them out of.
pub fn every_tool() -> Vec<Tool> {
    catalog()
        .into_iter()
        .chain(crate::session_tools::catalog())
        .chain(crate::process_tools::catalog())
        .chain(crate::browser_tools::catalog())
        .collect()
}

/// Crew's own tools. Sessions and messaging (`list_peers`, `send_message`,
/// `start_session`, …) are the session family's, which has the turn host
/// they need.
///
/// Who sees what: a terminal session has no turns, so nothing that rewrites
/// the persona a turn is handed, and no transcript in Crew to search. The
/// user, from the command line, is no session: nothing that acts on
/// "yourself", and no `create_bot`, whose provider, model and autonomy
/// default to the caller's own. What the user may do is what the window
/// already lets them: search the chats and manage routines.
pub(crate) fn catalog() -> Vec<Tool> {
    let schedule = json!({
        "type": "object",
        "description": schedule_help(),
        "properties": {
            "kind": { "type": "string", "enum": ["interval", "daily", "cron", "once"] },
            "minutes": { "type": "integer", "minimum": 1 },
            "hour": { "type": "integer", "minimum": 0, "maximum": 23 },
            "minute": { "type": "integer", "minimum": 0, "maximum": 59 },
            "days": { "type": "array", "items": { "type": "integer", "minimum": 0, "maximum": 6 } },
            "expression": { "type": "string", "description": "Five-field cron, local time." },
            "at": { "type": ["string", "integer"], "description": "For once: an ISO-8601 time (local unless it has Z or an offset), e.g. \"2026-10-05T15:30\", or epoch milliseconds. Must be in the future." }
        },
        "required": ["kind"]
    });
    vec![
        Tool {
            name: "create_bot",
            description: "Create a new bot in this workspace. It stays idle until the user messages it or a routine wakes it. Provider and model default to yours, and it runs with your autonomy: you cannot make one that is allowed more than you are.",
            schema: json!({
                "type": "object",
                "properties": {
                    "name": { "type": "string" },
                    "description": { "type": "string", "description": "Who it is, its job and where it works, written as instructions to it." },
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
            audience: Audience::SESSIONS,
            cli: vec![cli("bots", "create").pos(&["name"]).eg("crew bots create Reviewer --description \"Review every diff on main\"")],
        },
        Tool {
            name: "update_description",
            description: "Rewrite your own description: who you are, your job and where you work, handed to you at the top of every turn. Not for the user's rules (those go in `rules`) and not for facts, findings or progress. It replaces the whole thing, so include what you want to keep. Your name, model and autonomy belong to the user.",
            schema: json!({
                "type": "object",
                "properties": {
                    "text": { "type": "string", "description": "The new description, written as instructions to you. At most 2,000 characters." }
                },
                "required": ["text"]
            }),
            audience: Audience::BOTS,
            cli: vec![cli("bots", "set-description").rest(&["text"]).eg("crew bots set-description \"You review diffs on main.\"")],
        },
        Tool {
            name: "rules",
            description: "Your rules: the decisions the user gave you about how to work, shown to you at the top of every turn with their ids, one short rule per entry (\"Never push to master\", \"Run the tests before pushing\"). add one when the user decides how you should work, with `from`: the block number of the user's message that set it; edit or remove one by its id when the user changes their mind. Nothing else goes here. They hold at most 1,500 characters: a write over that is refused, so merge, shorten or remove rules first.",
            schema: json!({
                "type": "object",
                "properties": {
                    "action": { "type": "string", "enum": ["add", "edit", "remove"] },
                    "content": { "type": "string", "description": "add, edit: the rule." },
                    "from": { "type": "integer", "description": "add: the block number of the user's message that set it." },
                    "id": { "type": ["string", "integer"], "description": "edit, remove: the rule's id, e.g. \"r3\"." }
                },
                "required": ["action"]
            }),
            audience: Audience::BOTS,
            cli: vec![cli("bots", "rules").rest(&["action", "content"]).eg("crew bots rules add --from 12 Never push to master\n  crew bots rules edit --id r3 Run the tests before pushing\n  crew bots rules remove --id r3")],
        },
        Tool {
            name: "list_routines",
            description: "List the routines of a bot: standing orders that wake it on a schedule with a saved prompt. Defaults to your own.",
            schema: json!({
                "type": "object",
                "properties": { "bot_id": { "type": "string", "description": "Omit for yourself." } }
            }),
            audience: Audience::PARENTS,
            cli: vec![cli("routines", "list").alias(&["ls"]).eg("crew routines list --bot-id 3f2a…")],
        },
        Tool {
            name: "save_routine",
            description: "Create a routine, or update one by routine_id (only the fields you pass change). Times are the user's local time. A once schedule fires a single time, at at, and is then switched off: that is how you check back on something later.",
            schema: json!({
                "type": "object",
                "properties": {
                    "routine_id": { "type": "string", "description": "Set to update an existing routine." },
                    "bot_id": { "type": "string", "description": "Whose routine. Omit for yourself." },
                    "name": { "type": "string" },
                    "prompt": { "type": "string", "description": "What the bot does each time it fires." },
                    "schedule": schedule,
                    "enabled": { "type": "boolean" }
                }
            }),
            audience: Audience::PARENTS,
            cli: vec![cli("routines", "set").alias(&["save"]).eg("crew routines set --bot-id 3f2a… --name standup --prompt \"Sum up yesterday\" \\\n      --schedule '{\"kind\": \"daily\", \"hour\": 9, \"minute\": 0}'\n  crew routines set --bot-id 3f2a… --name \"check back\" --prompt \"Did CI pass?\" --schedule '{\"kind\": \"once\", \"at\": \"2026-10-05T15:30\"}'")],
        },
        Tool {
            name: "delete_routine",
            description: "Delete a routine by id. Works on any bot in this workspace.",
            schema: json!({
                "type": "object",
                "properties": { "routine_id": { "type": "string" } },
                "required": ["routine_id"]
            }),
            audience: Audience::PARENTS,
            cli: vec![cli("routines", "rm").pos(&["routine_id"]).eg("crew routines rm 7c1e…")],
        },
    ]
}

/// Crew's own tools a caller of this kind is listed, before any family is
/// registered. [`Toolbox::visible_names`] adds the families'.
pub fn visible_names(kind: CallerKind) -> Vec<&'static str> {
    Toolbox::default().visible_names(kind)
}

/// A tool as this caller is told about it. One description is written for
/// every session; the user cannot be written back to, and being promised a
/// reply that never comes is worse than none.
fn describe(tool: &Tool, kind: CallerKind) -> Value {
    let description = match (tool.name, kind) {
        ("send_message", CallerKind::User) => "Write to a bot or a session in this workspace, as the user. It arrives as a turn and is answered in its own chat, in its own time; busy, it waits for its turn to end. To a session waiting on a question, it answers it.",
        _ => tool.description,
    };
    let mut listed = json!({
        "name": tool.name,
        "description": description,
        "inputSchema": tool.schema
    });
    if on_demand(tool.name) {
        listed["_meta"] = json!({ ON_DEMAND_META: false });
    }
    listed
}

/// What Claude Code reads off a tool in `tools/list` to keep it behind its
/// tool search even though the server is `alwaysLoad` (2.1.296: "except a tool
/// the server itself lists with _meta anthropic/alwaysLoad set to false").
/// Other harnesses ignore it.
const ON_DEMAND_META: &str = "anthropic/alwaysLoad";

/// The tools Claude loads only when a turn asks for them: its prompt names
/// them and says when to reach for them, and the schema arrives with the
/// first search. The rest stay in the prompt, above all those a harness has a
/// lookalike of (`delegate`, `send_message`), which a model that cannot see
/// ours reaches for instead.
pub fn on_demand(name: &str) -> bool {
    const LOADED: &[&str] = &[
        "list_peers",
        "send_message",
        "delegate",
        "start_session",
        "read_session",
        "stop_session",
        "update_description",
        "rules",
    ];
    !LOADED.contains(&name)
}

/// The two words models have mixed up before, said the same way wherever a
/// model reads them: here, in `instructions()`, and in the session tools.
pub const GLOSSARY: &str = "A bot is a persistent identity Crew keeps: a name, a mailbox and a history; send_message reaches it. A session is one provider CLI (claude, codex, opencode, cursor, grok) running a conversation; a bot outlives its sessions, and a session can be thrown away. A subagent is a session started with delegate to do one job for the session that started it, with any provider: nested under its parent, reporting to it, disposable. A session of the user's, an independent one, is started with start_session: it shows in the sidebar like one the user opened, starts on the prompt it was given and reports to nobody. A message is a letter written with send_message; it arrives as a turn, in an envelope that names who wrote it. A report is a subagent's last message of a turn its parent started; it needs no tool. A subagent works for the session that started it; a session works for the user.";

/// Every tool a caller of this kind is listed once every family is
/// registered, as the daemon has them.
#[cfg(test)]
pub(crate) fn all_visible_names(kind: CallerKind) -> Vec<&'static str> {
    every_tool().into_iter().filter(|tool| tool.audience.admits(kind)).map(|tool| tool.name).collect()
}

/// A family that only lists, for a test that needs a toolbox to name tools
/// it never runs.
#[cfg(test)]
pub(crate) struct CatalogOnly(pub fn() -> Vec<Tool>);

#[cfg(test)]
impl ToolFamily for CatalogOnly {
    fn catalog(&self) -> Vec<Tool> {
        (self.0)()
    }
    fn run(&self, _: &Caller, _: &str, _: &Value) -> Result<ToolOutput, String> {
        Err("not here".into())
    }
}

/// Tool names that are gone, for tests that check nothing still names them.
#[cfg(test)]
pub(crate) const REMOVED_TOOLS: &[&str] = &[
    "message_agent",
    "search_messages",
    "send_to_session",
    "wait_for_session",
    "respond_to_session",
    "create_worktree",
    "continue_after_turn",
    "list_agents",
    "list_sessions",
];

/// What `initialize` tells a model about Crew's tools, before it has listed
/// any. Every provider with MCP shows it to the model; for a terminal session
/// it is the only place this is said, because the prompt of a session the user
/// runs is theirs and Crew does not touch it.
pub fn instructions(toolbox: &Toolbox, caller: &Caller) -> String {
    let notes: String = toolbox.notes(caller).into_iter().map(|note| format!("\n{note}")).collect();
    // A terminal's prompt is the user's: this is all Crew tells it (plan §7.3).
    if let Caller::Terminal(session) = caller {
        let harness = crate::prompts::Harness::for_provider(&session.provider);
        return format!("{}{notes}", crate::prompts::terminal(&session.name, harness));
    }
    // A bot's and a subagent's prompt is Crew's, and says the words and the
    // tools already: this only adds who is calling and what is live.
    match caller {
        Caller::Bot(_) => format!("Crew is the app this runs in; your instructions describe its tools.{notes}"),
        Caller::Terminal(_) => unreachable!("answered above"),
        Caller::Child(session) => format!(
            "Crew is the app this runs in. You are the subagent \"{}\", started by {}: your final message of each turn it starts is your report to it. Text under a `## Message` header is from the session or bot it names, not from the user.{notes}",
            session.name,
            session.parent_id.as_deref().map(|id| format!("session {id}")).unwrap_or_else(|| "the user".into())
        ),
        Caller::User { .. } => format!(
            "Crew is the app this runs in: it holds a workspace of bots, and these tools reach them. You are calling as the user.\n\
             {GLOSSARY}{notes}"
        ),
    }
}

/// The bridge's methods, answered for `caller`, who the bridge has already
/// established. `handle` believes it: working out who is calling is the
/// bridge's job, from the token.
pub fn handle(host: &Host<'_>, caller: &Caller, method: &str, params: Value) -> Result<Value, String> {
    match method {
        "tools/list" => {
            let kind = caller.kind();
            Ok(json!({
                "tools": host.toolbox.visible(kind).iter().map(|entry| describe(&entry.tool, kind)).collect::<Vec<_>>()
            }))
        }
        "instructions" => Ok(json!({ "instructions": instructions(host.toolbox, caller) })),
        // Everything this caller may run, for a person reading the `crew`
        // commands. The same as `tools/list` today; kept apart because the
        // CLI's commands and a model's prompt need not stay the same list.
        "tools/catalog" => {
            let kind = caller.kind();
            Ok(json!({
                "tools": host.toolbox.visible(kind).iter().map(|entry| describe(&entry.tool, kind)).collect::<Vec<_>>()
            }))
        }
        "whoami" => whoami(host.store, caller),
        "tools/call" => {
            let name = params.get("name").and_then(Value::as_str).unwrap_or("");
            let args = params.get("arguments").cloned().unwrap_or(json!({}));
            let args = if args.is_object() { args } else { json!({}) };
            match run(host, caller, name, &args) {
                Ok(ToolOutput::Value(out)) => {
                    let body = match out {
                        Value::String(text) => text,
                        other => serde_json::to_string_pretty(&other).unwrap_or_else(|_| other.to_string()),
                    };
                    Ok(json!({ "content": [{ "type": "text", "text": body }] }))
                }
                Ok(ToolOutput::Content(blocks)) => Ok(json!({ "content": blocks })),
                // A refusal carries the arguments the tool wanted. A model
                // that guessed one field name has usually guessed the others,
                // and a round trip per field is a turn spent on paperwork.
                Err(error) => Ok(json!({
                    "content": [{ "type": "text", "text": with_arguments(host.toolbox, name, &error) }],
                    "isError": true
                })),
            }
        }
        _ => Err(format!("Unknown method {method}")),
    }
}

/// The bridge's methods for a call that came through opencode's shared
/// server, whose MCP server is one per folder and so cannot tell its sessions
/// apart by what it was started with.
///
/// `caller` is `None` for the host token alone, which the bridge lets ask for
/// the list and nothing else; it is the session an opencode session id was
/// bound to for a `tools/call`.
///
/// Every session in a folder is listed the same tools, so the list is the
/// union of what each kind of caller may call. The call is where it is held
/// to its own: a tool outside its kind is refused saying so, not hidden.
pub fn handle_opencode(host: &Host<'_>, caller: Option<&Caller>, method: &str, params: Value) -> Result<Value, String> {
    match (method, caller) {
        ("tools/list", _) => Ok(json!({
            "tools": host
                .toolbox
                .visible_to_any()
                .iter()
                .map(|(entry, kind)| describe(&entry.tool, *kind))
                .collect::<Vec<_>>()
        })),
        // Asked once for the whole folder, so it cannot name one session's
        // tools or notes the way `instructions` does for a caller.
        ("instructions", _) => Ok(json!({
            "instructions": format!(
                "Crew is the app this runs in: it holds a workspace of bots, and these tools reach them. \
                 Every session in this folder is listed the same tools, so some are not for every session: a call a session may not make is refused saying so.\n{GLOSSARY}"
            )
        })),
        ("tools/call", Some(caller)) => {
            let name = params.get("name").and_then(Value::as_str).unwrap_or("");
            let kind = caller.kind();
            let known = host.toolbox.entries().into_iter().find(|entry| entry.tool.name == name);
            if known.is_some_and(|entry| !entry.tool.audience.admits(kind)) {
                return Ok(json!({
                    "content": [{ "type": "text", "text": format!(
                        "This session cannot use {name}: it is not offered to a {} session.",
                        kind_name(kind)
                    ) }],
                    "isError": true
                }));
            }
            handle(host, caller, method, params)
        }
        _ => Err(format!("{method} is not available through opencode's shared server")),
    }
}

fn kind_name(kind: CallerKind) -> &'static str {
    match kind {
        CallerKind::Bot => "bot",
        CallerKind::Terminal => "terminal",
        CallerKind::Child => "child",
        CallerKind::User => "user",
    }
}

/// Who the bridge took this caller for and which workspace that put it in,
/// for `crew status`: a CLI that guessed the wrong identity or folder should
/// be able to see so before it acts.
fn whoami(store: &Store, caller: &Caller) -> Result<Value, String> {
    let kind = kind_name(caller.kind());
    let workspace = match caller.workspace_id() {
        Ok(id) => crate::workspace::get(store, id.to_string())?
            .map(|found| json!({ "id": found.id, "name": found.name, "path": found.path })),
        Err(_) => None,
    };
    Ok(json!({
        "kind": kind,
        "label": caller.label(),
        "sessionId": caller.session_id(),
        "workspace": workspace,
    }))
}

/// The tool's arguments, appended to whatever it said when it refused.
fn with_arguments(toolbox: &Toolbox, name: &str, error: &str) -> String {
    let Some(tool) = toolbox.entries().into_iter().map(|entry| entry.tool).find(|tool| tool.name == name) else {
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

fn run(host: &Host<'_>, caller: &Caller, name: &str, args: &Value) -> Result<ToolOutput, String> {
    let kind = caller.kind();
    let entry = host.toolbox.entries().into_iter().find(|entry| entry.tool.name == name);
    let Some(entry) = entry.filter(|entry| entry.tool.audience.admits(kind)) else {
        return Err(format!(
            "Unknown tool \"{name}\". One of: {}",
            host.toolbox.visible(kind).into_iter().map(|entry| entry.tool.name).collect::<Vec<_>>().join(", ")
        ));
    };
    match entry.family {
        Some(family) => family.run(caller, name, args),
        None => own(host, caller, name, args).map(Into::into),
    }
}

/// Crew's own tools. The audience was checked on the way in; the ones that
/// need a session or a bot still ask for it, so a tool moved to a wider
/// audience fails with a sentence rather than acting on nobody.
fn own(host: &Host<'_>, caller: &Caller, name: &str, args: &Value) -> Result<Value, String> {
    let store = host.store;
    match name {
        "create_bot" => create_bot(store, host.transcripts, host.on_created, caller, args),
        "update_description" => update_description(store, host.transcripts, bot(caller, name)?, args),
        "rules" => rules(store, host.transcripts, bot(caller, name)?, args),
        "list_routines" => list_routines(store, caller, args),
        "save_routine" => save_routine(store, host.transcripts, host.on_routines, caller, args),
        "delete_routine" => delete_routine(store, host.transcripts, host.on_routines, caller, args),
        _ => Err(format!("Unknown tool \"{name}\"")),
    }
}

/// The bot behind a call, for a tool that acts on its own turns or persona.
fn bot<'a>(caller: &'a Caller, tool: &str) -> Result<&'a Session, String> {
    match caller {
        Caller::Bot(session) => Ok(session),
        _ => Err(format!("{tool} is for bots: it acts on the caller's own turns.")),
    }
}

/// The most a bot may write into its own description. The user's own edit,
/// in the bot sheet, is not held to it.
pub const DESCRIPTION_CAP: usize = 2_000;

/// The standing instructions a bot is handed every turn, rewritten by the
/// bot itself. Whole, not patched: a description assembled from edits nobody
/// read end to end is one nobody can predict the next turn from.
fn update_description(store: &Store, transcripts: &TranscriptHub, caller: &Session, args: &Value) -> Result<Value, String> {
    let body = text(args.get("text")).ok_or_else(|| "text is required".to_string())?;
    let len = body.chars().count();
    if len > DESCRIPTION_CAP {
        return Err(format!(
            "Your description holds at most {} characters; this one is {}. It is who you are, your job and where you \
             work: shorten it and try again.",
            crate::rules::thousands(DESCRIPTION_CAP),
            crate::rules::thousands(len)
        ));
    }
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
    // The window's sheet and lists hold the row it loaded; this is what tells
    // them, on whichever machine the daemon runs, that it changed.
    store.session_changed(&caller.id);
    transcripts.append_system(&caller.id, "Description updated by itself");
    Ok(json!({
        "description": body,
        "note": "This is what you will be told you are at the top of your next turn."
    }))
}

/// `rules`: a bot's rules, written one at a time by id. The answer is one
/// line: tool results end up in the trail, and the rules themselves are at
/// the top of every turn already.
fn rules(store: &Store, transcripts: &TranscriptHub, caller: &Session, args: &Value) -> Result<Value, String> {
    use crate::rules::{self, label, Change, Done, Source};
    let content = args.get("content").and_then(Value::as_str).unwrap_or("").to_string();
    let id = || {
        match args.get("id") {
            Some(Value::Number(n)) => n.as_i64().filter(|id| *id > 0),
            Some(Value::String(text)) => rules::parse_label(text),
            _ => None,
        }
        .ok_or_else(|| "id is required: the rule's id, e.g. \"r3\".".to_string())
    };
    let change = match text(args.get("action")).as_deref() {
        Some("add") => {
            let from = match args.get("from") {
                Some(Value::Number(n)) => n.as_i64(),
                Some(Value::String(text)) => text.trim().trim_start_matches('#').parse().ok(),
                _ => None,
            }
            .ok_or_else(|| "from is required: the block number of the user's message that set this rule.".to_string())?;
            let message_id =
                transcripts.read(&caller.id, |blocks| rules::user_message(blocks, from).map(|block| block.id.clone()))?;
            Change::Add { body: content, message_id: Some(message_id), source: Source::Bot }
        }
        Some("edit") => Change::Edit { id: id()?, body: content },
        Some("remove") => Change::Remove(id()?),
        Some(other) => return Err(format!("Unknown action \"{other}\". One of: add, edit, remove")),
        None => return Err("action is required: add, edit or remove.".into()),
    };
    let done = rules::apply(store, &caller.id, vec![change])?.map_err(|refused| refused.say())?;
    // The chat says what changed, as it does for the description.
    let said = match done.first() {
        Some(Done::Added(rule)) => {
            transcripts.append_system(&caller.id, &format!("Rule added: \"{}\"", rule.body));
            format!("added {}", label(rule.id))
        }
        Some(Done::Repeated(rule)) => format!("already {}", label(rule.id)),
        Some(Done::Edited(rule)) => {
            transcripts.append_system(&caller.id, &format!("Rule edited: \"{}\"", rule.body));
            format!("edited {}", label(rule.id))
        }
        Some(Done::Removed(rule)) => {
            transcripts.append_system(&caller.id, &format!("Rule removed: \"{}\"", rule.body));
            format!("removed {}", label(rule.id))
        }
        None => String::new(),
    };
    Ok(Value::String(said))
}

fn create_bot(
    store: &Store,
    transcripts: &TranscriptHub,
    on_created: &dyn Fn(&Session),
    caller: &Caller,
    args: &Value,
) -> Result<Value, String> {
    let me = caller.session().ok_or_else(|| "create_bot needs a session to inherit from.".to_string())?;
    let name = text(args.get("name")).ok_or_else(|| "name is required".to_string())?;
    let description =
        text(args.get("description")).ok_or_else(|| "description is required: say what the bot is for".to_string())?;
    let provider = text(args.get("provider")).unwrap_or_else(|| me.provider.clone());
    let models = provider_models(&provider)
        .ok_or_else(|| format!("Unknown provider \"{provider}\". One of: {}", provider_names().join(", ")))?;
    let requested = text(args.get("model"));
    if let Some(requested) = &requested {
        if !models.contains(requested) {
            return Err(unknown_model(requested, &provider));
        }
    }
    let model = requested.unwrap_or_else(|| if provider == me.provider { me.model.clone() } else { unnamed_model(&provider) });
    // Inherited, never asked for. A session that has to stop at every command
    // could otherwise build one that does not, and then send it the command.
    let autonomy = me.autonomy.clone();
    // It works on the same checkout as whoever made it, so what the two of
    // them say about the files is about the same files.
    let session = session::create_in_worktree(
        store,
        me.workspace_id.clone(),
        "bot".into(),
        name.clone(),
        provider.clone(),
        model.clone(),
        description,
        autonomy.clone(),
        me.worktree.clone(),
    )?;
    on_created(&session);
    transcripts.append_system(&session.id, &format!("Created by {}", me.name));
    // The creator's own chat, so the roster growing is something the user reads
    // where they are, not something they find in the sidebar.
    if matches!(caller, Caller::Bot(_)) {
        transcripts.append_system(&me.id, &format!("Created bot {name} ({})", session.id));
    }
    Ok(json!({
        "id": session.id,
        "name": name,
        "provider": provider,
        "model": model,
        "autonomy": autonomy,
        "status": "idle"
    }))
}

fn list_routines(store: &Store, caller: &Caller, args: &Value) -> Result<Value, String> {
    let target = resolve_bot(store, caller, args.get("bot_id"))?;
    let rows = routine::list_for_session(store, target.id.clone())?;
    let listed: Vec<Value> = rows.into_iter().map(|row| describe_routine(&row, &target)).collect();
    Ok(Value::Array(listed))
}

/// How a routine's owner is told who changed it. The reader of that chat is
/// the user, so when the user did it, it was "you".
fn by(caller: &Caller) -> String {
    match caller.session() {
        Some(session) => session.name.clone(),
        None => "you".to_string(),
    }
}

fn save_routine(
    store: &Store,
    transcripts: &TranscriptHub,
    on_routines: &dyn Fn(),
    caller: &Caller,
    args: &Value,
) -> Result<Value, String> {
    let target = resolve_bot(store, caller, args.get("bot_id"))?;
    let id = text(args.get("routine_id"));
    let existing = if let Some(id) = &id {
        let found = routine::list_for_session(store, target.id.clone())?.into_iter().find(|row| row.id == *id);
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
    let given = args.get("schedule").filter(|v| !v.is_null());
    let schedule = if let Some(given) = given {
        validate_schedule(given)?
    } else if let Some(existing) = &existing {
        parse_schedule(&existing.schedule).ok_or_else(|| schedule_help().to_string())?
    } else {
        return Err(format!("schedule is required. {}", schedule_help()));
    };
    let now = now_millis();
    // A once routine given a new time is armed again, unless told otherwise.
    let rearmed = given.is_some() && matches!(schedule, Schedule::Once { .. });
    let enabled = args
        .get("enabled")
        .and_then(Value::as_bool)
        .unwrap_or_else(|| rearmed || existing.as_ref().map(|row| row.enabled).unwrap_or(true));
    if let Schedule::Once { at } = schedule {
        if at <= now && (enabled || given.is_some()) {
            return Err(format!(
                "at is in the past ({}); a once routine needs a time still to come. It is {} now.",
                local_time(at),
                local_time(now)
            ));
        }
    }
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
        caller.session_id().map(str::to_string),
    )?;
    if Some(target.id.as_str()) != caller.session_id() {
        let verb = if existing.is_some() { "updated" } else { "set up" };
        transcripts.append_system(&target.id, &format!("Routine · {name} {verb} by {}", by(caller)));
    }
    on_routines();
    Ok(describe_routine(&row, &target))
}

fn delete_routine(
    store: &Store,
    transcripts: &TranscriptHub,
    on_routines: &dyn Fn(),
    caller: &Caller,
    args: &Value,
) -> Result<Value, String> {
    let id = text(args.get("routine_id")).ok_or_else(|| "routine_id is required".to_string())?;
    let found = find_routine(store, caller, &id)?;
    routine::delete(store, id)?;
    if Some(found.0.id.as_str()) != caller.session_id() {
        transcripts.append_system(&found.0.id, &format!("Routine · {} removed by {}", found.1.name, by(caller)));
    }
    on_routines();
    Ok(Value::String(format!("Deleted \"{}\" from {}.", found.1.name, found.0.name)))
}

/// The bot a routine tool acts on: the one named, or the caller itself. Only
/// a bot is a "yourself" here; a routine wakes a bot with a turn, and a
/// terminal session or the user has none.
fn resolve_bot(store: &Store, caller: &Caller, bot_id: Option<&Value>) -> Result<Session, String> {
    let me = match caller {
        Caller::Bot(session) => Some(session),
        _ => None,
    };
    let Some(id) = text(bot_id) else {
        return me.cloned().ok_or_else(|| "bot_id is required: routines belong to a bot. Use list_peers for ids.".to_string());
    };
    if let Some(me) = me.filter(|me| me.id == id) {
        return Ok(me.clone());
    }
    let workspace_id = caller.workspace_id()?;
    let target = session::get(store, id.clone())?
        .filter(|session| session.kind == "bot" && session.workspace_id == workspace_id)
        .ok_or_else(|| format!("No bot {id} in this workspace. Use list_peers for ids."))?;
    Ok(target)
}

fn find_routine(store: &Store, caller: &Caller, id: &str) -> Result<(Session, Routine), String> {
    let bots = session::list(store, caller.workspace_id()?.to_string())?.into_iter().filter(|session| session.kind == "bot");
    for owner in bots {
        if let Some(routine) = routine::list_for_session(store, owner.id.clone())?.into_iter().find(|row| row.id == id) {
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
        "bot": owner.name,
        "bot_id": owner.id,
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
fn like(wanted: &str) -> Vec<(&'static str, String)> {
    let squash = |text: &str| text.chars().filter(|c| c.is_alphanumeric()).flat_map(char::to_lowercase).collect::<String>();
    let wanted = squash(wanted);
    if wanted.is_empty() {
        return Vec::new();
    }
    catalogue()
        .into_iter()
        .flat_map(|(provider, models)| models.into_iter().map(move |model| (provider, model)))
        .filter(|(_, model)| {
            let model = squash(model);
            model.contains(&wanted) || wanted.contains(&model)
        })
        .collect()
}

/// A refusal that ends the guessing: where the model actually is, or the whole
/// catalogue when it is nowhere. Paid once, on a miss.
pub(crate) fn unknown_model(wanted: &str, provider: &str) -> String {
    let found = like(wanted);
    if !found.is_empty() {
        let where_ =
            found.iter().map(|(provider, model)| format!("{model} (provider {provider})")).collect::<Vec<_>>().join(", ");
        return format!(
            "No model \"{wanted}\" under {provider}. Spelled this way it is: {where_}. \
             Pass provider and model together."
        );
    }
    // Crew's own lists: cursor-agent's runs to hundreds of variants.
    let mine = PROVIDERS.iter().find(|(name, _)| *name == provider).map(|(_, models)| models.join(", ")).unwrap_or_default();
    let mine = if mine.is_empty() { "whatever its CLI lists".to_string() } else { mine };
    format!(
        "No model \"{wanted}\" anywhere, under {provider} or elsewhere. {provider} has: {mine}.\n\
         Everything there is:\n{}",
        model_sheet()
    )
}

/// Every id the provider takes, its CLI's own listing included.
pub(crate) fn provider_models(id: &str) -> Option<Vec<String>> {
    PROVIDERS.iter().find(|(name, _)| *name == id).map(|(provider, models)| with_listed(provider, models))
}

pub(crate) fn text(value: Option<&Value>) -> Option<String> {
    value.and_then(Value::as_str).map(str::trim).filter(|s| !s.is_empty()).map(str::to_string)
}

fn when(ms: i64) -> String {
    local_time(ms)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn store() -> Store {
        let dir = std::env::temp_dir().join(format!("crew-tools-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).expect("dir");
        Store::open(dir.join("crew.sqlite3")).expect("store")
    }

    fn workspace(store: &Store) -> String {
        let root = std::env::temp_dir().join(uuid::Uuid::new_v4().to_string());
        std::fs::create_dir_all(&root).expect("root");
        crate::workspace::create(store, "w".into(), root.to_string_lossy().into()).expect("workspace").id
    }

    fn bot(store: &Store, workspace_id: &str, name: &str) -> Session {
        session::create(
            store,
            workspace_id.to_string(),
            "bot".into(),
            name.into(),
            "claude".into(),
            "claude-opus-5".into(),
            "".into(),
            "ask".into(),
        )
        .expect("bot")
    }

    /// A caller with no row behind it, for tools that never read the store.
    fn someone(kind: &str) -> Caller {
        Caller::from_session(Session {
            id: "s1".into(),
            workspace_id: "w1".into(),
            kind: kind.into(),
            name: "Someone".into(),
            provider: "claude".into(),
            model: String::new(),
            effort: String::new(),
            service_tier: String::new(),
            provider_session_id: None,
            description: String::new(),
            notifications: false,
            autonomy: "ask".into(),
            status: "idle".into(),
            worktree: None,
            created_at: 0,
            updated_at: 0,
            bot_id: None,
            parent_id: None,
            cursor: 0,
            launched_by: None,
            launched_by_name: None,
            auto_turns: 0,
            paused: false,
            parent_name: None,
            user_seen: 0,
            last_event: None,
        })
    }

    fn call(store: &Store, transcripts: &TranscriptHub, caller: &Session, name: &str, args: Value) -> Result<Value, String> {
        call_as(store, transcripts, &Caller::from_session(caller.clone()), name, args)
    }

    fn call_as(store: &Store, transcripts: &TranscriptHub, caller: &Caller, name: &str, args: Value) -> Result<Value, String> {
        let toolbox = Toolbox::default();
        let host = Host { store, transcripts, on_created: &|_| {}, on_routines: &|| {}, toolbox: &toolbox };
        handle(&host, caller, "tools/call", json!({ "name": name, "arguments": args }))
    }

    fn body(result: &Value) -> String {
        result["content"][0]["text"].as_str().unwrap_or_default().to_string()
    }

    fn is_error(result: &Value) -> bool {
        result["isError"].as_bool().unwrap_or(false)
    }

    fn listed(store: &Store, transcripts: &TranscriptHub, caller: &Session) -> Vec<String> {
        listed_as(store, transcripts, &Toolbox::default(), &Caller::from_session(caller.clone()))
    }

    fn listed_as(store: &Store, transcripts: &TranscriptHub, toolbox: &Toolbox, caller: &Caller) -> Vec<String> {
        let host = Host { store, transcripts, on_created: &|_| {}, on_routines: &|| {}, toolbox };
        let out = handle(&host, caller, "tools/list", json!({})).expect("list");
        out["tools"].as_array().expect("tools").iter().map(|tool| tool["name"].as_str().unwrap_or_default().to_string()).collect()
    }

    /// Every tool a bot may call is listed, schema and all: a tool it cannot
    /// see is one it reaches for a lookalike of (plan §3, principle 2).
    #[test]
    fn the_listing_is_every_tool_this_caller_may_call() {
        let store = store();
        let transcripts = TranscriptHub::new(store.clone());
        let ws = workspace(&store);
        let coder = bot(&store, &ws, "Coder");
        let names = listed(&store, &transcripts, &coder);
        assert_eq!(names, visible_names(CallerKind::Bot), "the sheet and the listing are one list");
        for name in ["create_bot", "update_description", "save_routine"] {
            assert!(names.iter().any(|listed| listed == name), "{name}: {names:?}");
        }
        for gone in ["find_tool", "call_tool"].iter().chain(REMOVED_TOOLS) {
            assert!(!names.iter().any(|listed| listed == gone), "{gone} is back: {names:?}");
        }

        let toolbox = Toolbox::default();
        let host = Host { store: &store, transcripts: &transcripts, on_created: &|_| {}, on_routines: &|| {}, toolbox: &toolbox };
        let out = handle(&host, &Caller::from_session(coder), "tools/list", json!({})).expect("list");
        let upsert = out["tools"].as_array().unwrap().iter().find(|tool| tool["name"] == "save_routine").expect("listed");
        assert!(upsert["inputSchema"]["properties"]["schedule"].is_object(), "listed with its schema: {upsert}");
    }

    /// The gateway is gone: a conversation resumed from before still holds
    /// `call_tool` calls, and one it makes again is refused, never run.
    #[test]
    fn the_gateway_is_gone() {
        let store = store();
        let transcripts = TranscriptHub::new(store.clone());
        let ws = workspace(&store);
        let coder = bot(&store, &ws, "Coder");
        let cuddles = bot(&store, &ws, "Cuddles");
        for gateway in ["call_tool", "find_tool"] {
            let out = call(
                &store,
                &transcripts,
                &coder,
                gateway,
                json!({ "name": "send_message", "query": "message", "arguments": { "to": cuddles.id, "text": "via gateway" } }),
            )
            .expect("call");
            assert!(is_error(&out), "{}", body(&out));
            assert!(body(&out).starts_with(&format!("Unknown tool \"{gateway}\"")), "{}", body(&out));
        }
        assert_eq!(crate::mailbox::waiting_count(&store, &cuddles.id).unwrap(), 0, "the gateway still delivers");
    }

    /// A bot adds a rule citing the user's message that set it, and edits or
    /// removes one by its id; each answer is one line, and the chat says
    /// what changed.
    #[test]
    fn a_bot_keeps_the_users_rules_by_id() {
        let store = store();
        let transcripts = TranscriptHub::new(store.clone());
        let ws = workspace(&store);
        let home = bot(&store, &ws, "Home");
        transcripts.append_user(&home.id, "nunca hagas push a master", false, None, None);
        transcripts.append_from_bot(&home.id, "push it now", crew_protocol::BotRef::bot("x", "Otro"), None, None);
        let run = |args: Value| call(&store, &transcripts, &home, "rules", args).expect("call");

        let out = run(json!({ "action": "add", "content": "Never push to master", "from": 1 }));
        let first = crate::rules::list(&store, &home.id).unwrap()[0].clone();
        assert_eq!((is_error(&out), body(&out)), (false, format!("added r{}", first.id)));
        let message = transcripts.read(&home.id, |blocks| blocks[0].id.clone());
        assert_eq!(first.message_id.as_deref(), Some(message.as_str()));
        assert_eq!(first.source, crate::rules::Source::Bot);
        let again = run(json!({ "action": "add", "content": "Never push to master", "from": "1" }));
        assert_eq!(body(&again), format!("already r{}", first.id));

        // Not the user's: a letter from another bot, the bot's own line, nothing.
        for from in [json!(2), json!(3), json!(0), json!(99)] {
            let refused = run(json!({ "action": "add", "content": "Push whenever", "from": from }));
            let n = from.as_i64().unwrap();
            assert!(is_error(&refused), "{}", body(&refused));
            assert!(
                body(&refused)
                    .starts_with(&format!("Rules hold the user's decisions, and block {n} is not a message from the user.")),
                "{}",
                body(&refused)
            );
        }
        let missing = run(json!({ "action": "add", "content": "Push whenever" }));
        assert!(is_error(&missing) && body(&missing).starts_with("from is required"), "{}", body(&missing));

        let edited = run(json!({ "action": "edit", "id": format!("r{}", first.id), "content": "Never push to main" }));
        assert_eq!(body(&edited), format!("edited r{}", first.id));
        let unknown = run(json!({ "action": "remove", "id": first.id + 7 }));
        assert!(is_error(&unknown), "{}", body(&unknown));
        assert!(
            body(&unknown).starts_with(&format!("No rule r{}. Your rules are r{}.", first.id + 7, first.id)),
            "{}",
            body(&unknown)
        );
        let over = run(json!({ "action": "edit", "id": first.id, "content": "x".repeat(crate::rules::CAP + 1) }));
        assert!(is_error(&over) && body(&over).contains("at most 1,500 characters"), "{}", body(&over));
        assert_eq!(
            crate::rules::list(&store, &home.id).unwrap()[0].body,
            "Never push to main",
            "a refused write changes nothing"
        );
        let removed = run(json!({ "action": "remove", "id": first.id }));
        assert_eq!(body(&removed), format!("removed r{}", first.id));
        assert!(crate::rules::list(&store, &home.id).unwrap().is_empty());

        let said: Vec<String> = transcripts.read(&home.id, |blocks| {
            blocks.iter().filter(|b| b.role == crew_protocol::BlockRole::System).map(|b| b.text.clone()).collect()
        });
        assert_eq!(
            said,
            [
                "Rule added: \"Never push to master\"",
                "Rule edited: \"Never push to main\"",
                "Rule removed: \"Never push to main\""
            ]
        );
    }

    /// Rules are a bot's: a terminal is not listed the tool, and the user
    /// edits them in the bot sheet. The notes' tool is gone.
    #[test]
    fn rules_are_for_bots() {
        let store = store();
        let transcripts = TranscriptHub::new(store.clone());
        let ws = workspace(&store);
        let shell = terminal(&store, &ws, "Shell");
        assert!(!listed(&store, &transcripts, &shell).iter().any(|name| name == "rules"));
        assert!(!visible_names(CallerKind::User).contains(&"rules"));
        assert!(visible_names(CallerKind::Bot).contains(&"rules"));
        assert!(!visible_names(CallerKind::Bot).contains(&"memory"));
    }

    /// A bot's description is who it is, its job and where it works: one
    /// longer than that is refused, and the old one stays.
    #[test]
    fn a_bot_cannot_write_itself_a_description_past_the_cap() {
        let store = store();
        let transcripts = TranscriptHub::new(store.clone());
        let ws = workspace(&store);
        let coder = bot(&store, &ws, "Coder");
        let long = "x".repeat(DESCRIPTION_CAP + 1);
        let out = call(&store, &transcripts, &coder, "update_description", json!({ "text": long })).expect("call");
        assert!(is_error(&out), "{}", body(&out));
        assert!(body(&out).starts_with("Your description holds at most 2,000 characters; this one is 2,001."), "{}", body(&out));
        assert_eq!(session::get(&store, coder.id.clone()).unwrap().unwrap().description, "");
        let fits = "x".repeat(DESCRIPTION_CAP);
        assert!(!is_error(&call(&store, &transcripts, &coder, "update_description", json!({ "text": fits })).expect("call")));
        // The user's own edit is not held to it.
        let user = "y".repeat(DESCRIPTION_CAP * 2);
        session::update(
            &store,
            coder.id.clone(),
            "Coder".into(),
            "claude".into(),
            String::new(),
            user.clone(),
            true,
            "ask".into(),
        )
        .unwrap();
        assert_eq!(session::get(&store, coder.id.clone()).unwrap().unwrap().description, user);
    }

    /// A description written by another model is fine; one the bot cannot
    /// revise is a persona it is stuck with.
    #[test]
    fn a_bot_can_rewrite_what_it_is() {
        let store = store();
        let transcripts = TranscriptHub::new(store.clone());
        let ws = workspace(&store);
        let coder = bot(&store, &ws, "Coder");
        let out = call(&store, &transcripts, &coder, "update_description", json!({ "text": "You keep the release notes." }))
            .expect("call");
        assert!(!is_error(&out), "{}", body(&out));

        let after = session::get(&store, coder.id.clone()).expect("get").expect("bot");
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

    /// The window holds the row it loaded, here or on another machine; the
    /// store's change is what the daemon turns into `session-updated`.
    #[test]
    fn a_bot_rewriting_what_it_is_tells_the_window() {
        let store = store();
        let transcripts = TranscriptHub::new(store.clone());
        let ws = workspace(&store);
        let coder = bot(&store, &ws, "Coder");
        let heard = std::sync::Arc::new(std::sync::Mutex::new(Vec::<String>::new()));
        let log = heard.clone();
        store.set_listener(std::sync::Arc::new(move |what| {
            if let crate::store::Changed::Session(id) = what {
                log.lock().unwrap().push(id.to_string());
            }
        }));
        let out =
            call(&store, &transcripts, &coder, "update_description", json!({ "text": "You keep the notes." })).expect("call");
        assert!(!is_error(&out), "{}", body(&out));
        assert_eq!(*heard.lock().unwrap(), vec![coder.id.clone()]);
    }

    // ---------------------------------------------------------------
    // Adversarial review additions (tool gateway).
    // ---------------------------------------------------------------

    fn bot_with_provider(store: &Store, workspace_id: &str, name: &str, provider: &str) -> Session {
        session::create(
            store,
            workspace_id.to_string(),
            "bot".into(),
            name.into(),
            provider.into(),
            "".into(),
            "".into(),
            "ask".into(),
        )
        .expect("bot")
    }

    /// opencode shipped as a provider but never reached `PROVIDERS`, so an
    /// opencode bot inherits its own provider as the default and is told it
    /// does not exist. It cannot create any bot at all without naming someone
    /// else's provider, and nobody can create an opencode bot.
    /// The catalogue lives in one const and is read into the schema, so a model
    /// added to one cannot go missing from the other — which is how an agent
    /// ends up guessing a spelling.
    #[test]
    fn the_create_schema_names_every_model_there_is() {
        let tool = catalog().into_iter().find(|tool| tool.name == "create_bot").expect("create_bot");
        let schema = describe(&tool, CallerKind::Bot).to_string();
        for (provider, models) in PROVIDERS {
            assert!(schema.contains(provider), "{provider} is not in the schema");
            for model in *models {
                assert!(schema.contains(model), "{model} is not in the schema");
            }
        }
    }

    /// Measured, not guessed: a codex agent asked for "grok-4.6", `create_bot`
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
            "bot".into(),
            "Luna".into(),
            "codex".into(),
            "gpt-5.6-luna".into(),
            "".into(),
            "ask".into(),
        )
        .expect("bot");

        for asked in ["grok-4.6", "Grok 4.6", "grok_4_6"] {
            let out = call(
                &store,
                &transcripts,
                &luna,
                "create_bot",
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
        let coder = bot(&store, &ws, "Coder");

        let out = call(
            &store,
            &transcripts,
            &coder,
            "create_bot",
            json!({ "name": "X", "description": "You do X.", "model": "llama-9" }),
        )
        .expect("call");
        assert!(is_error(&out), "{}", body(&out));
        let said = body(&out);
        for provider in ["claude:", "cursor:", "codex:", "opencode:"] {
            assert!(said.contains(provider), "{provider} missing: {said}");
        }
        assert!(said.contains("grok takes every id"), "grok's pattern missing: {said}");
    }

    #[test]
    fn a_bot_cannot_create_one_that_is_allowed_more_than_it_is() {
        let store = store();
        let transcripts = TranscriptHub::new(store.clone());
        let ws = workspace(&store);
        let coder = bot(&store, &ws, "Coder");
        assert_eq!(coder.autonomy, "ask");

        let out = call(
            &store,
            &transcripts,
            &coder,
            "create_bot",
            // The old escape hatch, now not a field the schema has.
            json!({ "name": "Runner", "description": "You run things.", "autonomy": "full" }),
        )
        .expect("call");
        assert!(!is_error(&out), "{}", body(&out));

        let made =
            session::list(&store, ws.clone()).expect("list").into_iter().find(|row| row.name == "Runner").expect("the bot");
        assert_eq!(made.autonomy, "ask", "autonomy was granted, not inherited");

        // Both chats say it happened: the child's, and the one the user is in.
        let mine = transcripts.window(&coder.id, None, None).blocks;
        assert!(
            mine.iter().any(|block| block.text.contains(&format!("Created bot Runner ({})", made.id))),
            "the creator's chat does not say a new bot exists"
        );
        let theirs = transcripts.window(&made.id, None, None).blocks;
        assert!(theirs.iter().any(|block| block.text.contains("Created by Coder")), "{theirs:?}");
    }

    /// A helper made from inside a worktree works on that checkout, not on the
    /// main one next to it.
    #[test]
    fn a_bot_is_created_in_its_creators_worktree() {
        let store = store();
        let transcripts = TranscriptHub::new(store.clone());
        let ws = workspace(&store);
        let coder = session::create_in_worktree(
            &store,
            ws.clone(),
            "bot".into(),
            "Coder".into(),
            "claude".into(),
            "claude-opus-5".into(),
            "".into(),
            "ask".into(),
            Some("/wt/feat".into()),
        )
        .expect("coder");

        let out = call(&store, &transcripts, &coder, "create_bot", json!({ "name": "Helper", "description": "You help." }))
            .expect("call");
        assert!(!is_error(&out), "{}", body(&out));

        let made = session::list(&store, ws).expect("list").into_iter().find(|row| row.name == "Helper").expect("the bot");
        assert_eq!(made.worktree.as_deref(), Some("/wt/feat"));
    }

    #[test]
    fn review_an_opencode_bot_can_create_a_bot() {
        let store = store();
        let transcripts = TranscriptHub::new(store.clone());
        let ws = workspace(&store);
        let coder = bot_with_provider(&store, &ws, "Coder", "opencode");
        let out = call(&store, &transcripts, &coder, "create_bot", json!({ "name": "Helper", "description": "runs errands" }))
            .expect("call");
        assert!(!is_error(&out), "{}", body(&out));
    }

    /// An agent that guessed one field name has usually guessed the others.
    /// Answering "to is required" alone costs a round trip per field.
    #[test]
    fn a_refusal_says_what_the_tool_takes() {
        let store = store();
        let transcripts = TranscriptHub::new(store.clone());
        let ws = workspace(&store);
        let coder = bot(&store, &ws, "Coder");

        let answer = call(&store, &transcripts, &coder, "delete_routine", json!({ "id": "x" })).expect("handled");

        assert!(is_error(&answer), "{}", body(&answer));
        assert!(body(&answer).contains("delete_routine takes: routine_id."), "{}", body(&answer));
    }

    #[test]
    fn a_refusal_from_a_tool_nobody_has_stays_as_it_came() {
        let store = store();
        let transcripts = TranscriptHub::new(store.clone());
        let ws = workspace(&store);
        let coder = bot(&store, &ws, "Coder");

        let answer = call(&store, &transcripts, &coder, "no_such_tool", json!({})).expect("handled");

        assert!(body(&answer).starts_with("Unknown tool"), "{}", body(&answer));
        assert!(!body(&answer).contains("takes:"), "{}", body(&answer));
    }

    // ---------------------------------------------------------------
    // Who is calling.
    // ---------------------------------------------------------------

    fn terminal(store: &Store, workspace_id: &str, name: &str) -> Session {
        session::create(
            store,
            workspace_id.to_string(),
            "terminal".into(),
            name.into(),
            "claude".into(),
            "".into(),
            "".into(),
            "ask".into(),
        )
        .expect("terminal")
    }

    fn user(workspace_id: Option<&str>) -> Caller {
        Caller::User { workspace_id: workspace_id.map(str::to_string) }
    }

    /// A terminal session has no turns: nothing that leaves a note for the
    /// next one.
    #[test]
    fn a_terminal_is_listed_what_it_can_use() {
        let store = store();
        let transcripts = TranscriptHub::new(store.clone());
        let ws = workspace(&store);
        let shell = terminal(&store, &ws, "Shell");
        let names = listed(&store, &transcripts, &shell);
        assert_eq!(names, visible_names(CallerKind::Terminal));
        assert!(names.iter().any(|name| name == "create_bot"), "{names:?}");
        assert!(!names.iter().any(|name| name == "update_description"), "{names:?}");
    }

    #[test]
    fn the_user_is_listed_what_a_person_at_the_command_line_can_use() {
        let store = store();
        let transcripts = TranscriptHub::new(store.clone());
        let ws = workspace(&store);
        let names = listed_as(&store, &transcripts, &Toolbox::default(), &user(Some(&ws)));
        assert_eq!(names, visible_names(CallerKind::User));
        assert!(names.iter().any(|name| name == "list_routines"), "{names:?}");
        for none in ["create_bot", "update_description"] {
            assert!(!names.iter().any(|name| name == none), "{none}: {names:?}");
        }
    }

    #[test]
    fn a_tool_hidden_from_a_caller_is_neither_listed_nor_run() {
        let store = store();
        let transcripts = TranscriptHub::new(store.clone());
        let ws = workspace(&store);
        let shell = terminal(&store, &ws, "Shell");

        assert!(!listed(&store, &transcripts, &shell).iter().any(|name| name == "update_description"));
        let out = call(&store, &transcripts, &shell, "update_description", json!({ "text": "x" })).expect("call");
        assert!(is_error(&out), "{}", body(&out));
        assert!(body(&out).starts_with("Unknown tool"), "{}", body(&out));
        assert_eq!(session::get(&store, shell.id.clone()).unwrap().unwrap().description, "");
    }

    #[test]
    fn the_user_without_a_workspace_is_told_how_to_name_one() {
        let store = store();
        let transcripts = TranscriptHub::new(store.clone());
        let out = call_as(&store, &transcripts, &user(None), "list_routines", json!({ "bot_id": "x" })).expect("call");
        assert!(is_error(&out));
        assert!(body(&out).contains("--workspace"), "{}", body(&out));
    }

    /// A routine belongs to a bot; only a bot is a "yourself".
    #[test]
    fn the_user_names_whose_routines() {
        let store = store();
        let transcripts = TranscriptHub::new(store.clone());
        let ws = workspace(&store);
        let coder = bot(&store, &ws, "Coder");
        let out = call_as(&store, &transcripts, &user(Some(&ws)), "list_routines", json!({})).expect("call");
        assert!(is_error(&out));
        assert!(body(&out).contains("bot_id is required"), "{}", body(&out));
        let out = call_as(&store, &transcripts, &user(Some(&ws)), "list_routines", json!({ "bot_id": coder.id })).expect("call");
        assert!(!is_error(&out), "{}", body(&out));
    }

    /// "Check back in ten minutes" is a routine that fires once. A time
    /// already gone is refused, said in the user's clock.
    #[test]
    fn save_routine_takes_a_once_schedule_in_the_future() {
        let store = store();
        let transcripts = TranscriptHub::new(store.clone());
        let ws = workspace(&store);
        let coder = bot(&store, &ws, "Coder");
        let at = now_millis() + 600_000;
        let saved = call(
            &store,
            &transcripts,
            &coder,
            "save_routine",
            json!({
                "name": "Check back", "prompt": "did CI pass?", "schedule": { "kind": "once", "at": at }
            }),
        )
        .expect("call");
        assert!(!is_error(&saved), "{}", body(&saved));
        let row: Value = serde_json::from_str(&body(&saved)).expect("json");
        assert!(row["schedule"].as_str().unwrap().starts_with("Once · "), "{row}");
        assert_eq!(row["next_run"], json!(when(at)));
        let stored = routine::list_for_session(&store, coder.id.clone()).expect("list");
        assert_eq!(stored[0].next_run_at, Some(at));
        assert_eq!(parse_schedule(&stored[0].schedule), Some(Schedule::Once { at }));

        let past = call(
            &store,
            &transcripts,
            &coder,
            "save_routine",
            json!({
                "name": "Too late", "prompt": "x", "schedule": { "kind": "once", "at": "2020-01-01T09:00" }
            }),
        )
        .expect("call");
        assert!(is_error(&past));
        assert!(body(&past).contains("at is in the past (Jan 1, 2020, 9:00 AM)"), "{}", body(&past));

        // Fired and switched off, it can still be renamed; given a new time, it is armed again.
        let id = stored[0].id.clone();
        routine::disable(&store, &id).expect("disable");
        let renamed =
            call(&store, &transcripts, &coder, "save_routine", json!({ "routine_id": id, "name": "Checked" })).expect("call");
        assert!(!is_error(&renamed), "{}", body(&renamed));
        let again = call(
            &store,
            &transcripts,
            &coder,
            "save_routine",
            json!({
                "routine_id": id, "schedule": { "kind": "once", "at": at + 60_000 }
            }),
        )
        .expect("call");
        assert!(!is_error(&again), "{}", body(&again));
        let stored = routine::list_for_session(&store, coder.id.clone()).expect("list");
        assert!(stored[0].enabled && stored[0].next_run_at == Some(at + 60_000), "{:?}", stored[0]);
    }

    /// Stands in for a family like processes or the browser.
    struct Kettle;

    impl ToolFamily for Kettle {
        fn catalog(&self) -> Vec<Tool> {
            vec![
                Tool {
                    name: "list_kettles",
                    description: "List the kettles.",
                    schema: json!({ "type": "object", "properties": {} }),
                    cli: vec![],
                    audience: Audience::EVERYONE,
                },
                Tool {
                    name: "boil_kettle",
                    description: "Boil a kettle and wait for it.",
                    schema: json!({ "type": "object", "properties": { "kettle": { "type": "string" } }, "required": ["kettle"] }),
                    cli: vec![],
                    audience: Audience::SESSIONS,
                },
            ]
        }

        fn run(&self, caller: &Caller, name: &str, args: &Value) -> Result<ToolOutput, String> {
            match name {
                "list_kettles" => Ok(json!(["blue"]).into()),
                "boil_kettle" => {
                    let kettle = text(args.get("kettle")).ok_or("kettle is required")?;
                    Ok(ToolOutput::Content(vec![
                        json!({ "type": "text", "text": format!("{kettle} boiled by {}", caller.label()) }),
                    ]))
                }
                _ => Err("no".into()),
            }
        }
    }

    #[test]
    fn a_family_is_listed_and_run_like_crews_own() {
        let store = store();
        let transcripts = TranscriptHub::new(store.clone());
        let ws = workspace(&store);
        let coder = bot(&store, &ws, "Coder");
        let toolbox = Toolbox::default();
        toolbox.register(Arc::new(Kettle));
        let me = Caller::from_session(coder.clone());

        let names = listed_as(&store, &transcripts, &toolbox, &me);
        assert!(names.contains(&"list_kettles".to_string()) && names.contains(&"boil_kettle".to_string()), "{names:?}");
        assert!(toolbox.visible_names(CallerKind::Bot).contains(&"boil_kettle"));
        assert!(!toolbox.visible_names(CallerKind::User).contains(&"boil_kettle"));
        assert!(!listed_as(&store, &transcripts, &toolbox, &user(Some(&ws))).contains(&"boil_kettle".to_string()));

        let host = Host { store: &store, transcripts: &transcripts, on_created: &|_| {}, on_routines: &|| {}, toolbox: &toolbox };
        let out =
            handle(&host, &me, "tools/call", json!({ "name": "boil_kettle", "arguments": { "kettle": "blue" } })).expect("call");
        assert_eq!(body(&out), format!("blue boiled by Coder (bot {})", coder.id));
        // Its refusals carry its arguments, like Crew's own.
        let out = handle(&host, &me, "tools/call", json!({ "name": "boil_kettle", "arguments": {} })).expect("call");
        assert!(body(&out).contains("boil_kettle takes: kettle."), "{}", body(&out));
        // And its audience holds.
        let out =
            handle(&host, &user(Some(&ws)), "tools/call", json!({ "name": "boil_kettle", "arguments": { "kettle": "blue" } }))
                .expect("call");
        assert!(is_error(&out), "{}", body(&out));
    }

    fn child(store: &Store, workspace_id: &str) -> Session {
        session::create_child(store, workspace_id.to_string(), "Kid".into(), "claude".into(), "".into(), "ask".into(), None, None)
            .expect("child")
    }

    /// The tools of the sessions family, listed and refused the way the
    /// daemon has them, without the turn host that would run them.
    fn session_family() -> Toolbox {
        let toolbox = Toolbox::default();
        toolbox.register(Arc::new(CatalogOnly(crate::session_tools::catalog)));
        toolbox.register(Arc::new(Kettle));
        toolbox
    }

    /// Every session in an opencode folder is shown one list, so it has to
    /// hold what any kind of caller may call, and nothing else.
    #[test]
    fn opencodes_shared_list_is_the_union_of_what_each_kind_may_call() {
        let store = store();
        let transcripts = TranscriptHub::new(store.clone());
        let toolbox = session_family();
        let host = Host { store: &store, transcripts: &transcripts, on_created: &|_| {}, on_routines: &|| {}, toolbox: &toolbox };
        let out = handle_opencode(&host, None, "tools/list", json!({})).expect("list");
        let listed: Vec<&str> = out["tools"].as_array().expect("tools").iter().filter_map(|t| t["name"].as_str()).collect();

        let mut union: Vec<&str> = Vec::new();
        for kind in [CallerKind::Bot, CallerKind::Terminal, CallerKind::Child, CallerKind::User] {
            for name in toolbox.visible_names(kind) {
                if !union.contains(&name) {
                    union.push(name);
                }
            }
        }
        let mut sorted_listed = listed.clone();
        sorted_listed.sort_unstable();
        union.sort_unstable();
        assert_eq!(sorted_listed, union);
        // What only a bot may call, and what only a parent may, are both there.
        assert!(listed.contains(&"update_description") && listed.contains(&"start_session"), "{listed:?}");
        let again: std::collections::HashSet<&&str> = listed.iter().collect();
        assert_eq!(again.len(), listed.len(), "a tool listed twice");
    }

    #[test]
    fn a_tool_outside_the_calling_sessions_kind_is_refused_saying_so() {
        let store = store();
        let transcripts = TranscriptHub::new(store.clone());
        let ws = workspace(&store);
        let toolbox = session_family();
        let host = Host { store: &store, transcripts: &transcripts, on_created: &|_| {}, on_routines: &|| {}, toolbox: &toolbox };
        let call = |caller: &Caller, name: &str| {
            handle_opencode(&host, Some(caller), "tools/call", json!({ "name": name, "arguments": {} })).expect("call")
        };

        let kid = Caller::from_session(child(&store, &ws));
        let refused = call(&kid, "read_session");
        assert!(is_error(&refused), "{}", body(&refused));
        assert_eq!(body(&refused), "This session cannot use read_session: it is not offered to a child session.");

        // A bot passes the check and gets what the tool itself says.
        let me = Caller::from_session(bot(&store, &ws, "Coder"));
        assert!(!body(&call(&me, "read_session")).contains("cannot use"), "{}", body(&call(&me, "read_session")));
        // A terminal has no turns, so the bot-only tools are not its.
        let shell = Caller::from_session(terminal(&store, &ws, "Shell"));
        assert!(body(&call(&shell, "update_description")).starts_with("This session cannot use update_description"));
        // A name nobody has is unknown, not "not yours".
        assert!(body(&call(&kid, "make_tea")).starts_with("Unknown tool \"make_tea\""), "{}", body(&call(&kid, "make_tea")));
        // And the host token alone has no calls, whatever it names.
        let alone = handle_opencode(&host, None, "tools/call", json!({ "name": "list_peers" }));
        assert!(alone.is_err());
    }

    /// The catalog lists every tool this caller may run, and only those.
    #[test]
    fn the_catalog_is_every_tool_the_caller_may_run() {
        let store = store();
        let transcripts = TranscriptHub::new(store.clone());
        let ws = workspace(&store);
        let toolbox = Toolbox::default();
        toolbox.register(Arc::new(Kettle));
        let host = Host { store: &store, transcripts: &transcripts, on_created: &|_| {}, on_routines: &|| {}, toolbox: &toolbox };
        let out = handle(&host, &user(Some(&ws)), "tools/catalog", json!({})).expect("catalog");
        let tools = out["tools"].as_array().expect("tools");
        let named = |name: &str| tools.iter().find(|tool| tool["name"] == name);
        assert!(named("list_routines").is_some() && named("save_routine").is_some());
        assert!(named("list_kettles").is_some());
        assert!(named("boil_kettle").is_none(), "not the user's");
        assert!(named("create_bot").is_none(), "not the user's");
        assert!(named("find_tool").is_none() && named("call_tool").is_none(), "there is no gateway");
    }

    #[test]
    fn whoami_says_who_the_bridge_took_the_caller_for() {
        let store = store();
        let transcripts = TranscriptHub::new(store.clone());
        let ws = workspace(&store);
        let coder = bot(&store, &ws, "Coder");
        let toolbox = Toolbox::default();
        let host = Host { store: &store, transcripts: &transcripts, on_created: &|_| {}, on_routines: &|| {}, toolbox: &toolbox };
        let me = handle(&host, &Caller::from_session(coder.clone()), "whoami", json!({})).expect("whoami");
        assert_eq!(me["kind"], "bot");
        assert_eq!(me["sessionId"], coder.id);
        assert_eq!(me["workspace"]["id"], ws);
        let nobody = handle(&host, &user(None), "whoami", json!({})).expect("whoami");
        assert_eq!(nobody["kind"], "user");
        assert!(nobody["workspace"].is_null() && nobody["sessionId"].is_null(), "{nobody}");
    }

    /// Claude keeps a tool behind its tool search when the listing says so:
    /// the ones a harness has a lookalike of stay in the prompt, the rest
    /// arrive with the first search.
    #[test]
    fn the_listing_marks_the_tools_claude_loads_on_demand() {
        let store = store();
        let transcripts = TranscriptHub::new(store.clone());
        let ws = workspace(&store);
        let coder = Caller::from_session(bot(&store, &ws, "Coder"));
        let toolbox = Toolbox::default();
        toolbox.register(Arc::new(CatalogOnly(crate::session_tools::catalog)));
        toolbox.register(Arc::new(CatalogOnly(crate::browser_tools::catalog)));
        let host = Host { store: &store, transcripts: &transcripts, on_created: &|_| {}, on_routines: &|| {}, toolbox: &toolbox };
        let out = handle(&host, &coder, "tools/list", json!({})).expect("list");
        let tool = |name: &str| out["tools"].as_array().unwrap().iter().find(|tool| tool["name"] == name).cloned().expect(name);
        for loaded in ["delegate", "send_message", "list_peers", "start_session", "read_session"] {
            assert!(tool(loaded).get("_meta").is_none(), "{loaded}");
        }
        for deferred in ["browser_act", "save_routine", "create_bot", "start_sessions"] {
            assert_eq!(tool(deferred)["_meta"]["anthropic/alwaysLoad"], false, "{deferred}");
        }
    }

    #[test]
    fn the_instructions_say_who_is_calling_and_no_gateway() {
        let toolbox = Toolbox::default();
        let bot = instructions(&toolbox, &someone("bot"));
        // A bot's prompt says the words; the user, calling from outside, hears them here.
        assert!(bot.starts_with("Crew is the app this runs in") && !bot.contains(GLOSSARY), "{bot}");
        assert!(instructions(&toolbox, &user(None)).contains(GLOSSARY));
        let shell = instructions(&toolbox, &someone("terminal"));
        assert!(shell.contains("which Crew drives in the chat") && !shell.contains("cannot write back"), "{shell}");
        for text in [&bot, &shell] {
            for gone in ["find_tool", "call_tool", "not listed"] {
                assert!(!text.contains(gone), "{gone}: {text}");
            }
        }
    }
}

#[cfg(test)]
mod effort_env_tests {
    use super::effort_from_env;

    /// `CREW_DEFAULT_EFFORT` reaches the providers that take an effort, and
    /// only when it says something.
    #[test]
    fn the_environments_effort_is_for_claude_and_codex_only() {
        let low = || Some(" low ".to_string());
        assert_eq!(effort_from_env("claude", low()).as_deref(), Some("low"));
        assert_eq!(effort_from_env("codex", low()).as_deref(), Some("low"));
        assert_eq!(effort_from_env("opencode", low()), None);
        assert_eq!(effort_from_env("cursor", low()), None);
        assert_eq!(effort_from_env("claude", Some(String::new())), None);
        assert_eq!(effort_from_env("claude", None), None);
    }
}
