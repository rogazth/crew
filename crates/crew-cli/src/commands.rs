//! The tool commands, `crew <group> <verb>`: one for each tool Crew has.
//!
//! Most are built from the tool's own schema, so an argument added to a tool
//! reaches the CLI with it and `--help` says what the tool says. A few read
//! better written by hand (`processes logs` follows and greps, `agents send`
//! takes a name), and those take their flags from `args`.

use std::process::ExitCode;

use clap::{builder::PossibleValuesParser, value_parser, Arg, ArgAction, ArgMatches, Args, Command, FromArgMatches};
use serde_json::{json, Map, Value};

use crew_core::tools::{every_tool, Tool};

use crate::args::{LogsArgs, ProcAdd, ProcEdit, SendArgs};
use crate::output;
use crate::{agents, processes, read_stdin, CliError, Ctx};

pub struct Group {
    pub name: &'static str,
    pub about: &'static str,
    pub aliases: &'static [&'static str],
    pub verbs: &'static [Verb],
}

pub struct Verb {
    pub name: &'static str,
    pub tool: &'static str,
    /// Schema properties taken by position, in this order.
    pub positional: &'static [&'static str],
    /// The last positional takes every word left, joined with spaces, and
    /// `-` reads it from stdin.
    pub rest: bool,
    pub aliases: &'static [&'static str],
    pub examples: &'static str,
    pub shape: Shape,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Shape {
    /// Built from the schema, answered as the tool answers.
    Schema,
    /// Built from the schema, answered with the process in one line.
    Process,
    ListAgents,
    Send,
    ListProcesses,
    AddProcess,
    EditProcess,
    Logs,
    ListTabs,
}

const fn verb(name: &'static str, tool: &'static str) -> Verb {
    Verb { name, tool, positional: &[], rest: false, aliases: &[], examples: "", shape: Shape::Schema }
}

impl Verb {
    const fn pos(self, positional: &'static [&'static str]) -> Self {
        Self { positional, ..self }
    }
    const fn rest(self, positional: &'static [&'static str]) -> Self {
        Self { positional, rest: true, ..self }
    }
    const fn alias(self, aliases: &'static [&'static str]) -> Self {
        Self { aliases, ..self }
    }
    const fn shape(self, shape: Shape) -> Self {
        Self { shape, ..self }
    }
    const fn eg(self, examples: &'static str) -> Self {
        Self { examples, ..self }
    }
}

pub const GROUPS: &[Group] = &[
    Group {
        name: "agents",
        about: "The workspace's agents: list them, write to them, make new ones",
        aliases: &["agent"],
        verbs: &[
            verb("list", "list_agents").alias(&["ls"]).shape(Shape::ListAgents).eg("crew agents list\n  crew agents list --json | jq '.[].id'"),
            verb("send", "message_agent").shape(Shape::Send).eg(
                "crew agents send Reviewer \"look at the diff on main\"\n  crew agents send 3f2a… run the tests and fix what fails\n  git diff | crew agents send Reviewer -",
            ),
            verb("create", "create_agent").pos(&["name"]).eg("crew agents create Reviewer --description \"Review every diff on main\""),
            verb("continue", "continue_after_turn").rest(&["text"]).eg("crew agents continue \"run the e2e next and fix what fails\""),
            verb("set-description", "update_description").rest(&["text"]).eg("crew agents set-description \"You review diffs on main.\""),
        ],
    },
    Group {
        name: "worktrees",
        about: "Hand work to a new session on a branch of its own",
        aliases: &["worktree", "wt"],
        verbs: &[verb("new", "create_worktree").pos(&["branch"]).eg(
            "crew worktrees new feat/login --task \"Build the login form; the API is in server/auth.rs\"",
        )],
    },
    Group {
        name: "messages",
        about: "A conversation in Crew: search what was said",
        aliases: &["message"],
        verbs: &[verb("search", "search_messages").rest(&["query"]).eg("crew messages search deploy key --days 7")],
    },
    Group {
        name: "routines",
        about: "Standing orders that wake an agent on a schedule",
        aliases: &["routine"],
        verbs: &[
            verb("list", "list_routines").alias(&["ls"]).eg("crew routines list --agent-id 3f2a…"),
            verb("set", "upsert_routine").eg(
                "crew routines set --agent-id 3f2a… --name standup --prompt \"Sum up yesterday\" \\\n      --schedule '{\"kind\": \"daily\", \"hour\": 9, \"minute\": 0}'",
            ),
            verb("rm", "delete_routine").pos(&["routine_id"]).eg("crew routines rm 7c1e…"),
        ],
    },
    Group {
        name: "processes",
        about: "The workspace's dev servers, watchers and workers, and their logs",
        aliases: &["process", "proc"],
        verbs: &[
            verb("list", "list_processes").alias(&["ls"]).shape(Shape::ListProcesses).eg("crew processes list\n  crew processes list --json | jq '.[].name'"),
            verb("start", "start_process").pos(&["process"]).shape(Shape::Process).eg("crew processes start web\n  crew processes start web --worktree ../app-feat --env PORT=3001"),
            verb("stop", "stop_process").pos(&["process"]).shape(Shape::Process).eg("crew processes stop web"),
            verb("restart", "restart_process").pos(&["process"]).shape(Shape::Process).eg("crew processes restart web"),
            verb("pause", "pause_process").pos(&["process"]).shape(Shape::Process).eg("crew processes pause worker"),
            verb("resume", "resume_process").pos(&["process"]).shape(Shape::Process).eg("crew processes resume worker"),
            verb("logs", "read_logs").shape(Shape::Logs).eg(
                "crew processes logs web                 the last lines\n  crew processes logs web -n 500\n  crew processes logs web -f              follow, like tail -f\n  crew processes logs web --grep 'error|panic' -C 2\n  crew processes logs web -f --grep ready print each matching line as it arrives",
            ),
            verb("wait", "wait_for_log").pos(&["process", "pattern"]).eg("crew processes wait web 'ready|listening' --timeout-s 30"),
            verb("input", "send_input").rest(&["process", "text"]).eg("crew processes input web r\n  printf 'y\\r' | crew processes input setup -"),
            verb("add", "create_process").shape(Shape::AddProcess).eg(
                "crew processes add web npm run dev\n  crew processes add api --cwd server --env PORT=4000 --auto-restart -- cargo run",
            ),
            verb("edit", "update_process").shape(Shape::EditProcess).eg(
                "crew processes edit web --command 'npm run dev -- --port 3001'\n  crew processes edit web --auto-restart true",
            ),
            verb("rm", "delete_process").pos(&["process"]).eg("crew processes rm web"),
        ],
    },
    Group {
        name: "tabs",
        about: "The workspace's browser tabs: open them, read them, drive them",
        aliases: &["tab"],
        verbs: &[
            verb("list", "list_tabs").alias(&["ls"]).shape(Shape::ListTabs).eg("crew tabs list"),
            verb("open", "open_tab").pos(&["url"]).eg("crew tabs open http://localhost:5173"),
            verb("claim", "claim_tab").pos(&["tab"]).eg("crew tabs claim 12"),
            verb("release", "release_tab").eg("crew tabs release --tab 12"),
            verb("navigate", "browser_navigate").pos(&["url"]).alias(&["go"]).eg("crew tabs navigate http://localhost:5173/login\n  crew tabs navigate --action back"),
            verb("snapshot", "browser_snapshot").eg("crew tabs snapshot --tab 12"),
            verb("click", "browser_click").pos(&["uid"]).eg("crew tabs click 4_17"),
            verb("hover", "browser_hover").pos(&["uid"]).eg("crew tabs hover 4_17"),
            verb("fill", "browser_fill").rest(&["uid", "value"]).eg("crew tabs fill 4_9 ada@example.com"),
            verb("type", "browser_type").rest(&["text"]).eg("crew tabs type hello world"),
            verb("press", "browser_press").pos(&["key"]).eg("crew tabs press Enter\n  crew tabs press Meta+A"),
            verb("screenshot", "browser_screenshot").eg("crew tabs screenshot --full-page"),
            verb("wait", "browser_wait_for").rest(&["text"]).eg("crew tabs wait Signed in --timeout-s 20"),
            verb("console", "browser_console").eg("crew tabs console"),
            verb("network", "browser_network").eg("crew tabs network --json"),
            verb("eval", "browser_evaluate").rest(&["expression"]).eg("crew tabs eval document.title"),
        ],
    },
];

/// Each group as a clap command, for the root to take.
pub fn subcommands() -> Vec<Command> {
    let tools = every_tool();
    GROUPS.iter().enumerate().map(|(order, group)| build_group(group, &tools).display_order(order)).collect()
}

fn build_group(group: &Group, tools: &[Tool]) -> Command {
    let mut command = Command::new(group.name)
        .about(group.about)
        .visible_aliases(group.aliases.iter().copied())
        .subcommand_required(true)
        .arg_required_else_help(true);
    for verb in group.verbs {
        let tool = tool(tools, verb.tool);
        command = command.subcommand(build_verb(group, verb, tool));
    }
    command
}

fn tool<'a>(tools: &'a [Tool], name: &str) -> &'a Tool {
    tools.iter().find(|tool| tool.name == name).unwrap_or_else(|| panic!("no tool {name}: the CLI names a tool that is gone"))
}

fn build_verb(group: &Group, verb: &Verb, tool: &Tool) -> Command {
    let description = tool.description;
    let mut about = first_sentence(description);
    if !tool.audience.user {
        about.push_str(" From a Crew session only.");
    }
    let command = Command::new(verb.name);
    // The hand-written flags come with their struct's doc as the about, which
    // is for this file's reader; the tool's words are set over it.
    let command = match verb.shape {
        Shape::Logs => LogsArgs::augment_args(command),
        Shape::Send => SendArgs::augment_args(command),
        Shape::AddProcess => ProcAdd::augment_args(command),
        Shape::EditProcess => ProcEdit::augment_args(command),
        _ => schema_args(command, tool, verb, group),
    };
    let mut command = command
        .about(format!("{about} ({})", tool.name))
        .long_about(format!("{description}\n\nRuns the {} tool.", tool.name))
        .visible_aliases(verb.aliases.iter().copied());
    if !verb.examples.is_empty() {
        command = command.after_help(format!("Examples:\n  {}", verb.examples));
    }
    command
}

/// Up to the first full stop, for the one-line list under a group.
fn first_sentence(text: &str) -> String {
    let line = text.lines().next().unwrap_or("");
    match line.find(". ") {
        Some(end) => line[..=end].to_string(),
        None => line.to_string(),
    }
}

fn properties(tool: &Tool) -> Map<String, Value> {
    tool.schema.get("properties").and_then(Value::as_object).cloned().unwrap_or_default()
}

fn required(tool: &Tool) -> Vec<String> {
    tool.schema
        .get("required")
        .and_then(Value::as_array)
        .map(|names| names.iter().filter_map(Value::as_str).map(str::to_string).collect())
        .unwrap_or_default()
}

/// What a property is, for its flag's parser and for reading it back.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Kind {
    Text,
    Integer,
    Number,
    Boolean,
    /// A list, each item given as its own flag.
    List,
    /// `KEY=VALUE`, repeated: an object of strings like a process's env.
    Pairs,
    /// An object with fields of its own, given as JSON.
    Json,
}

fn kind(spec: &Value) -> Kind {
    match spec.get("type").and_then(Value::as_str) {
        Some("integer") => Kind::Integer,
        Some("number") => Kind::Number,
        Some("boolean") => Kind::Boolean,
        Some("array") => Kind::List,
        Some("object") if spec.get("properties").is_some() => Kind::Json,
        Some("object") => Kind::Pairs,
        _ => Kind::Text,
    }
}

fn help(spec: &Value) -> String {
    let mut help = spec.get("description").and_then(Value::as_str).unwrap_or("").to_string();
    // A schedule's help is a page of its own; its first line is enough here.
    if kind(spec) == Kind::Json {
        help = help.lines().next().unwrap_or("").to_string();
    }
    let range = match (spec.get("minimum").and_then(Value::as_i64), spec.get("maximum").and_then(Value::as_i64)) {
        (Some(low), Some(high)) => format!("{low}–{high}"),
        (Some(low), None) => format!("≥{low}"),
        (None, Some(high)) => format!("≤{high}"),
        (None, None) => String::new(),
    };
    if !range.is_empty() {
        help = if help.is_empty() { range } else { format!("{help} [{range}]") };
    }
    help
}

fn schema_args(mut command: Command, tool: &Tool, verb: &Verb, group: &Group) -> Command {
    let properties = properties(tool);
    let required = required(tool);
    for (index, name) in verb.positional.iter().enumerate() {
        let spec = properties
            .get(*name)
            .unwrap_or_else(|| panic!("crew {} {}: {} takes no {name}", group.name, verb.name, tool.name));
        let last = index + 1 == verb.positional.len();
        let mut arg = Arg::new(*name)
            .value_name(name.to_uppercase())
            .help(help(spec))
            .required(required.iter().any(|field| field == name))
            .index(index + 1);
        if last && verb.rest {
            arg = arg.num_args(1..).trailing_var_arg(true).allow_hyphen_values(true);
        } else {
            arg = typed(arg, spec);
        }
        command = command.arg(arg);
    }
    // Required flags first, then the rest by name.
    let mut flags: Vec<(&String, &Value)> = properties.iter().filter(|(name, _)| !verb.positional.contains(&name.as_str())).collect();
    flags.sort_by_key(|(name, _)| !required.contains(name));
    for (name, spec) in flags {
        let arg = Arg::new(name.clone())
            .long(name.replace('_', "-"))
            .help(help(spec))
            .required(required.contains(name));
        command = command.arg(typed(arg, spec));
    }
    command
}

fn typed(arg: Arg, spec: &Value) -> Arg {
    match kind(spec) {
        Kind::Integer => arg.value_parser(value_parser!(i64)).value_name("N"),
        Kind::Number => arg.value_parser(value_parser!(f64)).value_name("N"),
        // `--full-page` alone is true; `--auto-restart=false` says no.
        Kind::Boolean => arg
            .value_parser(value_parser!(bool))
            .num_args(0..=1)
            .require_equals(true)
            .default_missing_value("true")
            .value_name("true|false"),
        Kind::List => arg.action(ArgAction::Append).value_name("ITEM"),
        Kind::Pairs => arg.action(ArgAction::Append).value_name("KEY=VALUE"),
        Kind::Json => arg.value_name("JSON"),
        Kind::Text => match spec.get("enum").and_then(Value::as_array) {
            Some(options) => {
                let options: Vec<String> = options.iter().filter_map(Value::as_str).map(str::to_string).collect();
                arg.value_parser(PossibleValuesParser::new(options))
            }
            None => {
                let value_name = arg.get_id().as_str().to_uppercase();
                arg.value_name(value_name)
            }
        },
    }
}

/// The tool's arguments, read back from what clap parsed.
fn arguments(matches: &ArgMatches, tool: &Tool, verb: &Verb) -> Result<Value, CliError> {
    let mut out = Map::new();
    for (name, spec) in properties(tool) {
        let rest = verb.rest && verb.positional.last() == Some(&name.as_str());
        if rest {
            if let Some(words) = matches.get_many::<String>(&name) {
                let words: Vec<&String> = words.collect();
                let text = if words.len() == 1 && words[0] == "-" {
                    read_stdin()?
                } else {
                    words.iter().map(|word| word.as_str()).collect::<Vec<_>>().join(" ")
                };
                out.insert(name, json!(text));
            }
            continue;
        }
        let value = match kind(&spec) {
            Kind::Integer => matches.get_one::<i64>(&name).map(|n| json!(n)),
            Kind::Number => matches.get_one::<f64>(&name).map(|n| json!(n)),
            Kind::Boolean => matches.get_one::<bool>(&name).map(|b| json!(b)),
            Kind::List => matches.get_many::<String>(&name).map(|items| {
                let item_kind = spec.get("items").map(kind).unwrap_or(Kind::Text);
                Value::Array(
                    items
                        .map(|item| match item_kind {
                            Kind::Integer | Kind::Number => serde_json::from_str(item).unwrap_or_else(|_| json!(item)),
                            _ => json!(item),
                        })
                        .collect(),
                )
            }),
            Kind::Pairs => match matches.get_many::<String>(&name) {
                Some(pairs) => Some(json!(processes::parse_env(&pairs.cloned().collect::<Vec<_>>())?)),
                None => None,
            },
            Kind::Json => match matches.get_one::<String>(&name) {
                Some(text) => Some(
                    serde_json::from_str::<Value>(text)
                        .map_err(|e| CliError::Usage(format!("--{} takes JSON: {e}", name.replace('_', "-"))))?,
                ),
                None => None,
            },
            Kind::Text => matches.get_one::<String>(&name).map(|text| json!(text)),
        };
        if let Some(value) = value {
            out.insert(name, value);
        }
    }
    Ok(Value::Object(out))
}

/// `crew <group> <verb> …`, once clap has matched a group.
pub fn run(ctx: &Ctx, group: &str, matches: &ArgMatches) -> Result<ExitCode, CliError> {
    let group = GROUPS.iter().find(|candidate| candidate.name == group).ok_or_else(|| CliError::Usage(format!("No group {group}")))?;
    let Some((name, matches)) = matches.subcommand() else {
        return Err(CliError::Usage(format!("crew {} needs a command: `crew {} --help`", group.name, group.name)));
    };
    let verb = group.verbs.iter().find(|verb| verb.name == name).ok_or_else(|| CliError::Usage(format!("No command {name}")))?;
    let parsed = |error: clap::Error| CliError::Usage(error.to_string());
    match verb.shape {
        Shape::ListAgents => agents::list(ctx),
        Shape::ListTabs => agents::tabs(ctx),
        Shape::ListProcesses => processes::ps(ctx),
        Shape::Send => agents::send(ctx, &SendArgs::from_arg_matches(matches).map_err(parsed)?),
        Shape::Logs => processes::logs(ctx, &LogsArgs::from_arg_matches(matches).map_err(parsed)?),
        Shape::AddProcess => processes::add(ctx, ProcAdd::from_arg_matches(matches).map_err(parsed)?),
        Shape::EditProcess => processes::edit(ctx, ProcEdit::from_arg_matches(matches).map_err(parsed)?),
        Shape::Schema | Shape::Process => {
            let tools = every_tool();
            let tool = tool(&tools, verb.tool);
            let arguments = arguments(matches, tool, verb)?;
            let reply = ctx.client()?.tool(tool.name, arguments)?;
            if reply.is_error {
                return Err(CliError::Failed(reply.text()));
            }
            if ctx.global.json {
                output::say_json(&reply.value());
            } else if verb.shape == Shape::Process {
                ctx.show(&reply, processes::summary);
            } else {
                for line in output::content(&reply.content, &output::image_dir(), &output::image_stem(tool.name)) {
                    output::say(&line);
                }
            }
            Ok(ExitCode::SUCCESS)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn root() -> Command {
        crate::args::command()
    }

    fn parse(args: &[&str]) -> (String, String, ArgMatches) {
        let matches = root().try_get_matches_from(std::iter::once("crew").chain(args.iter().copied())).expect("parse");
        let (group, matches) = matches.subcommand().expect("group");
        let (verb, matches) = matches.subcommand().expect("verb");
        (group.to_string(), verb.to_string(), matches.clone())
    }

    fn find(group: &str, verb: &str) -> (&'static Verb, Tool) {
        let group = GROUPS.iter().find(|candidate| candidate.name == group).expect("group");
        let verb = group.verbs.iter().find(|candidate| candidate.name == verb).expect("verb");
        let tool = every_tool().into_iter().find(|tool| tool.name == verb.tool).expect("tool");
        (verb, tool)
    }

    /// Every tool a caller can reach has a command, and the gateway, which
    /// is how a model reaches the rest, has none: here the rest are commands.
    #[test]
    fn every_tool_has_a_command() {
        let named: Vec<&str> = GROUPS.iter().flat_map(|group| group.verbs.iter().map(|verb| verb.tool)).collect();
        let hand = ["grep_logs", "wait_for_log"];
        for tool in every_tool() {
            assert!(named.contains(&tool.name) || hand.contains(&tool.name), "{} has no command", tool.name);
        }
        for gateway in ["find_tool", "call_tool"] {
            assert!(!named.contains(&gateway), "{gateway} is a model's, not a person's");
        }
    }

    #[test]
    fn the_tree_is_consistent() {
        root().debug_assert();
    }

    #[test]
    fn a_rest_positional_joins_its_words() {
        let (group, verb, matches) = parse(&["agents", "continue", "run", "the", "-e2e"]);
        assert_eq!((group.as_str(), verb.as_str()), ("agents", "continue"));
        let (verb, tool) = find("agents", "continue");
        assert_eq!(arguments(&matches, &tool, verb).expect("args"), json!({ "text": "run the -e2e" }));
    }

    #[test]
    fn flags_come_from_the_schema_with_their_types() {
        let (_, _, matches) = parse(&["processes", "wait", "web", "ready|up", "--timeout-s", "30", "--since", "12"]);
        let (verb, tool) = find("processes", "wait");
        assert_eq!(
            arguments(&matches, &tool, verb).expect("args"),
            json!({ "process": "web", "pattern": "ready|up", "timeout_s": 30, "since": 12 })
        );
        assert!(root().try_get_matches_from(["crew", "processes", "wait", "web", "x", "--timeout-s", "soon"]).is_err());
        assert!(root().try_get_matches_from(["crew", "processes", "wait", "web", "x"]).is_err(), "timeout_s is required");

        let (_, _, matches) = parse(&["tabs", "screenshot", "--full-page", "--tab", "12"]);
        let (verb, tool) = find("tabs", "screenshot");
        assert_eq!(arguments(&matches, &tool, verb).expect("args"), json!({ "full_page": true, "tab": "12" }));
        let (_, _, matches) = parse(&["tabs", "screenshot", "--full-page=false"]);
        assert_eq!(arguments(&matches, &tool, verb).expect("args"), json!({ "full_page": false }));

        let (_, _, matches) = parse(&["tabs", "navigate", "--action", "back"]);
        let (verb, tool) = find("tabs", "navigate");
        assert_eq!(arguments(&matches, &tool, verb).expect("args"), json!({ "action": "back" }));
        assert!(root().try_get_matches_from(["crew", "tabs", "navigate", "--action", "sideways"]).is_err());
    }

    #[test]
    fn an_object_with_fields_is_json() {
        let (_, _, matches) = parse(&["routines", "set", "--name", "standup", "--schedule", r#"{"kind":"daily","hour":9}"#, "--enabled"]);
        let (verb, tool) = find("routines", "set");
        assert_eq!(
            arguments(&matches, &tool, verb).expect("args"),
            json!({ "name": "standup", "schedule": { "kind": "daily", "hour": 9 }, "enabled": true })
        );
        let (_, _, matches) = parse(&["routines", "set", "--schedule", "daily"]);
        assert!(matches!(arguments(&matches, &tool, verb), Err(CliError::Usage(_))));
    }

    #[test]
    fn groups_and_verbs_answer_to_their_aliases() {
        let (group, verb, _) = parse(&["proc", "ls"]);
        assert_eq!((group.as_str(), verb.as_str()), ("processes", "list"));
        let (group, verb, _) = parse(&["tab", "go", "http://x"]);
        assert_eq!((group.as_str(), verb.as_str()), ("tabs", "navigate"));
    }

    #[test]
    fn a_tool_only_a_session_can_run_says_so() {
        let help = root().find_subcommand_mut("agents").expect("agents").find_subcommand_mut("continue").expect("continue").render_help().to_string();
        assert!(help.contains("From a Crew session only."), "{help}");
        let help = root().find_subcommand_mut("agents").expect("agents").find_subcommand_mut("send").expect("send").render_help().to_string();
        assert!(!help.contains("session only"), "{help}");
    }
}
