//! The tool commands, `crew <group> <verb>` and a few of their own
//! (`crew send`, `crew peers`): one for each verb a tool declares in its own
//! definition ([`crew_core::tools::CliVerb`]), so a tool added, renamed or
//! merged takes its command with it.
//!
//! Most are built from the tool's own schema, so an argument added to a tool
//! reaches the CLI with it and `--help` says what the tool says. A few read
//! better written by hand (`processes logs` follows and greps, `send` takes a
//! name), and those take their flags from `args`; [`shape`] names them.

use std::process::ExitCode;

use clap::{builder::PossibleValuesParser, value_parser, Arg, ArgAction, ArgMatches, Args, Command, FromArgMatches};
use serde_json::{json, Map, Value};

use crew_core::tools::{every_tool, CliVerb, Tool};

use crate::args::{LogsArgs, ProcAdd, ProcEdit, SendArgs};
use crate::output;
use crate::{bots, processes, read_stdin, CliError, Ctx};

/// A group of commands. Its verbs come from the tools that name it.
pub struct Group {
    pub name: &'static str,
    pub about: &'static str,
    pub aliases: &'static [&'static str],
}

pub const GROUPS: &[Group] = &[
    Group { name: "bots", about: "The workspace's bots: make new ones, rewrite your own instructions", aliases: &["bot"] },
    Group {
        name: "sessions",
        about: "Provider CLIs you start on a job, or hand to the user: start one, read it, stop it",
        aliases: &["session"],
    },
    Group { name: "messages", about: "A conversation in Crew: search what was said", aliases: &["message"] },
    Group { name: "routines", about: "Standing orders that wake a bot on a schedule, or once", aliases: &["routine"] },
    Group {
        name: "processes",
        about: "The workspace's dev servers, watchers and workers, and their logs",
        aliases: &["process", "proc"],
    },
    Group { name: "tabs", about: "The workspace's browser tabs: open them, read them, drive them", aliases: &["tab"] },
];

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Shape {
    /// Built from the schema, answered as the tool answers.
    Schema,
    /// Built from the schema, answered with the process in one line.
    Process,
    ListPeers,
    Send,
    ListProcesses,
    AddProcess,
    EditProcess,
    Logs,
    ListTabs,
}

/// The commands written by hand, by group and verb; the rest are `Schema`.
const HAND: &[(&str, &str, Shape)] = &[
    ("peers", "", Shape::ListPeers),
    ("send", "", Shape::Send),
    ("processes", "list", Shape::ListProcesses),
    ("processes", "add", Shape::AddProcess),
    ("processes", "edit", Shape::EditProcess),
    ("processes", "logs", Shape::Logs),
    ("tabs", "list", Shape::ListTabs),
];

fn shape(tool: &Tool, verb: &CliVerb) -> Shape {
    if let Some((_, _, shape)) = HAND.iter().find(|(group, name, _)| *group == verb.group && *name == verb.verb) {
        return *shape;
    }
    if tool.name == "control_process" {
        return Shape::Process;
    }
    Shape::Schema
}

/// Every command of a group, in the order the tools are listed.
fn verbs_of(tools: &[Tool], group: &str) -> Vec<(usize, CliVerb)> {
    tools
        .iter()
        .enumerate()
        .flat_map(|(index, tool)| {
            tool.cli.iter().filter(|verb| verb.group == group && !verb.verb.is_empty()).map(move |verb| (index, verb.clone()))
        })
        .collect()
}

/// The commands of their own, `crew <name>`, in no group.
fn top_level(tools: &[Tool]) -> Vec<(usize, CliVerb)> {
    tools
        .iter()
        .enumerate()
        .flat_map(|(index, tool)| tool.cli.iter().filter(|verb| verb.verb.is_empty()).map(move |verb| (index, verb.clone())))
        .collect()
}

/// Whether `crew <name>` is one of the commands of their own.
pub fn is_top_level(name: &str) -> bool {
    top_level(&every_tool()).iter().any(|(_, verb)| verb.group == name)
}

/// The tool behind `crew <group> <verb>`, and the verb as the tool declared it.
fn find<'a>(tools: &'a [Tool], group: &str, verb: &str) -> Option<(&'a Tool, &'a CliVerb)> {
    tools.iter().find_map(|tool| tool.cli.iter().find(|cli| cli.group == group && cli.verb == verb).map(|cli| (tool, cli)))
}

/// The commands of their own, then each group, as clap commands for the root
/// to take.
pub fn subcommands() -> Vec<Command> {
    let tools = every_tool();
    let top = top_level(&tools);
    let mut commands: Vec<Command> = top
        .iter()
        .enumerate()
        .map(|(order, (index, verb))| build_verb(verb, &tools[*index]).display_order(order))
        .collect();
    commands.extend(
        GROUPS.iter().enumerate().map(|(order, group)| build_group(group, &tools).display_order(top.len() + order)),
    );
    commands
}

fn build_group(group: &Group, tools: &[Tool]) -> Command {
    let mut command = Command::new(group.name)
        .about(group.about)
        .visible_aliases(group.aliases.iter().copied())
        .subcommand_required(true)
        .arg_required_else_help(true);
    for (index, verb) in verbs_of(tools, group.name) {
        command = command.subcommand(build_verb(&verb, &tools[index]));
    }
    command
}

fn build_verb(verb: &CliVerb, tool: &Tool) -> Command {
    let description = tool.description;
    let mut about = if verb.about.is_empty() { first_sentence(description) } else { verb.about.to_string() };
    if !tool.audience.user {
        about.push_str(" From a Crew session only.");
    }
    // A command of its own is named by its group.
    let command = Command::new(if verb.verb.is_empty() { verb.group } else { verb.verb });
    // The hand-written flags come with their struct's doc as the about, which
    // is for this file's reader; the tool's words are set over it.
    let command = match shape(tool, verb) {
        Shape::Logs => LogsArgs::augment_args(command),
        Shape::Send => SendArgs::augment_args(command),
        Shape::AddProcess => ProcAdd::augment_args(command),
        Shape::EditProcess => ProcEdit::augment_args(command),
        _ => schema_args(command, tool, verb),
    };
    let runs = match verb.sets {
        Some((name, value)) => format!("{} {name} {value}", tool.name),
        None => tool.name.to_string(),
    };
    let mut command = command
        .about(format!("{about} ({runs})"))
        .long_about(format!("{description}\n\nRuns the {runs} tool."))
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

/// The schema properties a verb takes: its positionals and its flags, never
/// the one it sets.
fn taken(tool: &Tool, verb: &CliVerb) -> Vec<(String, Value)> {
    properties(tool)
        .into_iter()
        .filter(|(name, _)| verb.sets.is_none_or(|(set, _)| set != name))
        .filter(|(name, _)| {
            verb.positional.contains(&name.as_str()) || verb.flags.is_none_or(|flags| flags.contains(&name.as_str()))
        })
        .collect()
}

fn schema_args(mut command: Command, tool: &Tool, verb: &CliVerb) -> Command {
    let properties = properties(tool);
    let required = required(tool);
    for (index, name) in verb.positional.iter().enumerate() {
        let spec = properties
            .get(*name)
            .unwrap_or_else(|| panic!("crew {} {}: {} takes no {name}", verb.group, verb.verb, tool.name));
        let last = index + 1 == verb.positional.len();
        let mut arg = Arg::new(*name)
            .value_name(name.to_uppercase())
            .help(help(spec))
            // A merged tool's own checks say what an action needs; for the
            // command, its positionals are what it is for.
            .required(required.iter().any(|field| field == name) || verb.sets.is_some())
            .index(index + 1);
        if last && verb.rest {
            arg = arg.num_args(1..).trailing_var_arg(true).allow_hyphen_values(true);
        } else {
            arg = typed(arg, spec);
        }
        command = command.arg(arg);
    }
    // Required flags first, then the rest by name.
    let mut flags: Vec<(String, Value)> =
        taken(tool, verb).into_iter().filter(|(name, _)| !verb.positional.contains(&name.as_str())).collect();
    flags.sort_by_key(|(name, _)| !required.contains(name));
    for (name, spec) in flags {
        let arg = Arg::new(name.clone())
            .long(name.replace('_', "-"))
            .help(help(&spec))
            .required(required.contains(&name));
        command = command.arg(typed(arg, &spec));
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
fn arguments(matches: &ArgMatches, tool: &Tool, verb: &CliVerb) -> Result<Value, CliError> {
    let mut out = Map::new();
    if let Some((name, value)) = verb.sets {
        out.insert(name.to_string(), json!(value));
    }
    for (name, spec) in taken(tool, verb) {
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

/// `crew <name> …`, a command of its own.
pub fn run_top(ctx: &Ctx, name: &str, matches: &ArgMatches) -> Result<ExitCode, CliError> {
    run_verb(ctx, name, "", matches)
}

/// `crew <group> <verb> …`, once clap has matched a group.
pub fn run(ctx: &Ctx, group: &str, matches: &ArgMatches) -> Result<ExitCode, CliError> {
    let Some((name, matches)) = matches.subcommand() else {
        return Err(CliError::Usage(format!("crew {group} needs a command: `crew {group} --help`")));
    };
    run_verb(ctx, group, name, matches)
}

fn run_verb(ctx: &Ctx, group: &str, name: &str, matches: &ArgMatches) -> Result<ExitCode, CliError> {
    let tools = every_tool();
    let (tool, verb) = find(&tools, group, name).ok_or_else(|| CliError::Usage(format!("No command {group} {name}")))?;
    let parsed = |error: clap::Error| CliError::Usage(error.to_string());
    let shape = shape(tool, verb);
    match shape {
        Shape::ListPeers => bots::peers(ctx),
        Shape::ListTabs => bots::tabs(ctx),
        Shape::ListProcesses => processes::ps(ctx),
        Shape::Send => bots::send(ctx, &SendArgs::from_arg_matches(matches).map_err(parsed)?),
        Shape::Logs => processes::logs(ctx, &LogsArgs::from_arg_matches(matches).map_err(parsed)?),
        Shape::AddProcess => processes::add(ctx, ProcAdd::from_arg_matches(matches).map_err(parsed)?),
        Shape::EditProcess => processes::edit(ctx, ProcEdit::from_arg_matches(matches).map_err(parsed)?),
        Shape::Schema | Shape::Process => {
            let arguments = arguments(matches, tool, verb)?;
            let reply = ctx.client()?.tool(tool.name, arguments)?;
            if reply.is_error {
                return Err(CliError::Failed(reply.text()));
            }
            if ctx.global.json {
                output::say_json(&reply.value());
            } else if shape == Shape::Process {
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

    fn find(group: &str, verb: &str) -> (CliVerb, Tool) {
        let tools = every_tool();
        let (tool, verb) = super::find(&tools, group, verb).expect("command");
        let verb = verb.clone();
        let tool = every_tool().into_iter().find(|candidate| candidate.name == tool.name).expect("tool");
        (verb, tool)
    }

    /// Every tool has a command, declared with it, in a group there is; no
    /// two commands share a name; every hand-written one still has its tool.
    #[test]
    fn every_tool_has_a_command() {
        let tools = every_tool();
        let mut seen = Vec::new();
        for tool in &tools {
            assert!(!tool.cli.is_empty(), "{} has no command: give it a cli verb", tool.name);
            for verb in &tool.cli {
                assert!(
                    verb.verb.is_empty() || GROUPS.iter().any(|group| group.name == verb.group),
                    "{}: no group {}",
                    tool.name,
                    verb.group
                );
                assert!(
                    !verb.verb.is_empty() || !GROUPS.iter().any(|group| group.name == verb.group),
                    "crew {} is a group and a command of its own",
                    verb.group
                );
                assert!(!seen.contains(&(verb.group, verb.verb)), "crew {} {} is taken twice", verb.group, verb.verb);
                seen.push((verb.group, verb.verb));
                if let Some((name, value)) = verb.sets {
                    let spec = &tool.schema["properties"][name];
                    let allowed = spec["enum"].as_array().is_some_and(|values| values.contains(&json!(value)));
                    assert!(allowed, "crew {} {} sets {name} {value}, which {} does not take", verb.group, verb.verb, tool.name);
                }
            }
        }
        for (group, verb, _) in HAND {
            assert!(seen.contains(&(*group, *verb)), "crew {group} {verb} is written by hand for a tool that is gone");
        }
        // Each action of a merged tool is a command of its own.
        for action in ["start", "stop", "restart", "pause", "resume"] {
            assert_eq!(find("processes", action).1.name, "control_process");
        }
        for action in ["click", "hover", "fill", "type", "press"] {
            assert_eq!(find("tabs", action).1.name, "browser_act");
        }
        assert_eq!((find("processes", "add").1.name, find("processes", "edit").1.name), ("save_process", "save_process"));
        assert_eq!((find("tabs", "console").1.name, find("tabs", "network").1.name), ("browser_activity", "browser_activity"));
        assert_eq!((find("send", "").1.name, find("peers", "").1.name), ("send_message", "list_peers"));
        for gone in ["worktrees"] {
            assert!(!GROUPS.iter().any(|group| group.name == gone), "{gone}");
        }
    }

    /// A merged tool's verb sends the action it stands for, and offers only
    /// the flags that action takes.
    #[test]
    fn a_verb_of_a_merged_tool_sets_its_action() {
        let (_, _, matches) = parse(&["processes", "start", "web", "--env", "PORT=3001"]);
        let (verb, tool) = find("processes", "start");
        assert_eq!(
            arguments(&matches, &tool, &verb).expect("args"),
            json!({ "action": "start", "process": "web", "env": { "PORT": "3001" } })
        );
        assert!(root().try_get_matches_from(["crew", "processes", "stop", "web", "--env", "PORT=1"]).is_err(), "stop takes no env");
        assert!(root().try_get_matches_from(["crew", "processes", "start", "web", "--action", "stop"]).is_err());

        let (_, _, matches) = parse(&["tabs", "fill", "--tab", "12", "4_9", "ada@example.com"]);
        let (verb, tool) = find("tabs", "fill");
        assert_eq!(
            arguments(&matches, &tool, &verb).expect("args"),
            json!({ "action": "fill", "uid": "4_9", "value": "ada@example.com", "tab": "12" })
        );
        assert!(root().try_get_matches_from(["crew", "tabs", "click", "4_9", "--key", "Enter"]).is_err());
        assert!(root().try_get_matches_from(["crew", "tabs", "click"]).is_err(), "click needs its uid");

        let (_, _, matches) = parse(&["tabs", "network"]);
        let (verb, tool) = find("tabs", "network");
        assert_eq!(arguments(&matches, &tool, &verb).expect("args"), json!({ "kind": "network" }));
    }

    #[test]
    fn the_tree_is_consistent() {
        root().debug_assert();
    }

    #[test]
    fn a_rest_positional_joins_its_words() {
        let (group, verb, matches) = parse(&["sessions", "start", "--provider", "codex", "run", "the", "-e2e"]);
        assert_eq!((group.as_str(), verb.as_str()), ("sessions", "start"));
        let (verb, tool) = find("sessions", "start");
        assert_eq!(arguments(&matches, &tool, &verb).expect("args"), json!({ "prompt": "run the -e2e", "provider": "codex" }));
        let (_, _, matches) = parse(&["sessions", "start", "--wait", "--owner", "user", "--", "go"]);
        assert_eq!(arguments(&matches, &tool, &verb).expect("args"), json!({ "prompt": "go", "wait": true, "owner": "user" }));
    }

    /// `crew send` and `crew peers` are commands of their own, beside the groups.
    #[test]
    fn send_and_peers_are_commands_of_their_own() {
        let matches = root().try_get_matches_from(["crew", "peers", "--json"]).expect("peers");
        assert_eq!(matches.subcommand_name(), Some("peers"));
        let matches = root().try_get_matches_from(["crew", "send", "Reviewer", "hi"]).expect("send");
        assert_eq!(matches.subcommand_name(), Some("send"));
        assert!(is_top_level("send") && is_top_level("peers") && !is_top_level("sessions"));
        for gone in [&["bots", "continue"][..], &["bots", "send"], &["bots", "list"], &["sessions", "wait"], &["sessions", "list"], &["worktrees", "new"]] {
            let args = std::iter::once("crew").chain(gone.iter().copied()).chain(["x"]);
            assert!(root().try_get_matches_from(args).is_err(), "crew {gone:?} is still there");
        }
    }

    #[test]
    fn flags_come_from_the_schema_with_their_types() {
        let (_, _, matches) = parse(&["processes", "wait", "web", "ready|up", "--timeout-s", "30", "--since", "12"]);
        let (verb, tool) = find("processes", "wait");
        assert_eq!(
            arguments(&matches, &tool, &verb).expect("args"),
            json!({ "process": "web", "pattern": "ready|up", "timeout_s": 30, "since": 12 })
        );
        assert!(root().try_get_matches_from(["crew", "processes", "wait", "web", "x", "--timeout-s", "soon"]).is_err());
        assert!(root().try_get_matches_from(["crew", "processes", "wait", "web", "x"]).is_err(), "timeout_s is required");

        let (_, _, matches) = parse(&["tabs", "screenshot", "--full-page", "--tab", "12"]);
        let (verb, tool) = find("tabs", "screenshot");
        assert_eq!(arguments(&matches, &tool, &verb).expect("args"), json!({ "full_page": true, "tab": "12" }));
        let (_, _, matches) = parse(&["tabs", "screenshot", "--full-page=false"]);
        assert_eq!(arguments(&matches, &tool, &verb).expect("args"), json!({ "full_page": false }));

        let (_, _, matches) = parse(&["tabs", "navigate", "--action", "back"]);
        let (verb, tool) = find("tabs", "navigate");
        assert_eq!(arguments(&matches, &tool, &verb).expect("args"), json!({ "action": "back" }));
        assert!(root().try_get_matches_from(["crew", "tabs", "navigate", "--action", "sideways"]).is_err());
    }

    #[test]
    fn an_object_with_fields_is_json() {
        let (_, _, matches) = parse(&["routines", "set", "--name", "standup", "--schedule", r#"{"kind":"daily","hour":9}"#, "--enabled"]);
        let (verb, tool) = find("routines", "set");
        assert_eq!(
            arguments(&matches, &tool, &verb).expect("args"),
            json!({ "name": "standup", "schedule": { "kind": "daily", "hour": 9 }, "enabled": true })
        );
        let (_, _, matches) = parse(&["routines", "set", "--schedule", "daily"]);
        assert!(matches!(arguments(&matches, &tool, &verb), Err(CliError::Usage(_))));
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
        let help = root().find_subcommand_mut("bots").expect("bots").find_subcommand_mut("create").expect("create").render_help().to_string();
        assert!(help.contains("From a Crew session only."), "{help}");
        let help = root().find_subcommand_mut("send").expect("send").render_help().to_string();
        assert!(!help.contains("session only"), "{help}");
    }
}
