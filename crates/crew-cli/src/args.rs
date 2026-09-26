//! What `crew` takes on the command line. Every human command is a thin
//! wrapper over one tool, named in its help, so what the CLI does and what an
//! agent can do through MCP stay the same thing.

use std::path::PathBuf;

use clap::{ArgAction, Args, Parser, Subcommand, ValueEnum};

const EXAMPLES: &str = "\
Examples:
  crew status                     is Crew running, and who does it take you for
  crew ps                         the processes of the workspace you are in
  crew logs web -f                follow a process's output
  crew send Reviewer \"look at the diff on main\"
  crew call list_agents --json    any tool, as an agent would call it
  crew call --help                every tool you can call

Outside a Crew session the CLI speaks as you, in the workspace that holds the
current directory (or --workspace). Inside one it speaks as that session.

Exit status: 0 done, 1 the tool or command failed, 2 bad usage, 3 Crew isn't running.";

#[derive(Parser, Debug)]
#[command(
    name = "crew",
    version,
    about = "Drive Crew from a shell: its processes, agents, browser tabs, and every tool it gives its agents.",
    after_help = EXAMPLES,
    propagate_version = true,
    max_term_width = 100
)]
pub struct Cli {
    #[command(flatten)]
    pub global: Global,
    #[command(subcommand)]
    pub command: Command,
}

#[derive(Args, Debug, Clone, Default)]
pub struct Global {
    /// Print what the tool answered with as JSON instead of a table.
    #[arg(long, global = true)]
    pub json: bool,
    /// The workspace to act in: its id, or a path inside its folder.
    /// Defaults to the current directory. A Crew session always acts in its own.
    #[arg(long, short = 'w', global = true, value_name = "ID|PATH")]
    pub workspace: Option<String>,
    /// Crew's data directory, where daemon.json lives. Defaults to
    /// $CREW_DATA_DIR, else the installed app's. Naming one speaks as you even
    /// inside a session.
    #[arg(long, global = true, value_name = "DIR")]
    pub data_dir: Option<PathBuf>,
}

#[derive(Subcommand, Debug)]
pub enum Command {
    /// Open the Crew app.
    #[command(after_help = "Examples:\n  crew open\n  crew open ~/code/api")]
    Open {
        /// A folder to hand the app. Best effort: the app may only come to the front.
        path: Option<PathBuf>,
    },
    /// Whether Crew is running, its version, and who it takes you for.
    #[command(after_help = "Examples:\n  crew status\n  crew status --json\n  crew status -w ~/code/api")]
    Status,

    /// List the workspace's processes (list_processes).
    #[command(after_help = "Examples:\n  crew ps\n  crew ps --json | jq '.[].name'")]
    Ps,
    /// Start a process (start_process).
    #[command(after_help = "Examples:\n  crew start web")]
    Start(ProcessArg),
    /// Stop a process: SIGTERM to its group, SIGKILL if it lingers (stop_process).
    #[command(after_help = "Examples:\n  crew stop web")]
    Stop(ProcessArg),
    /// Stop a process and start it again (restart_process).
    #[command(after_help = "Examples:\n  crew restart web")]
    Restart(ProcessArg),
    /// Freeze a process with SIGSTOP (pause_process).
    #[command(after_help = "Examples:\n  crew pause worker")]
    Pause(ProcessArg),
    /// Let a paused process run again with SIGCONT (resume_process).
    #[command(after_help = "Examples:\n  crew resume worker")]
    Resume(ProcessArg),
    /// Print a process's output (read_logs, grep_logs, wait_for_log).
    #[command(after_help = "\
Examples:
  crew logs web                 the last lines
  crew logs web -n 500
  crew logs web -f              follow, like tail -f
  crew logs web --grep 'error|panic' -C 2
  crew logs web -f --grep ready print each matching line as it arrives")]
    Logs(LogsArgs),
    /// Add, change or remove a process definition.
    Proc {
        #[command(subcommand)]
        command: ProcCommand,
    },

    /// List the agents in the workspace (list_agents).
    #[command(after_help = "Examples:\n  crew agents\n  crew agents --json")]
    Agents,
    /// Send an agent a message, as you (message_agent).
    #[command(after_help = "\
Examples:
  crew send Reviewer \"look at the diff on main\"
  crew send 3f2a… run the tests and fix what fails
  git diff | crew send Reviewer -")]
    Send {
        /// The agent, by id or by name.
        agent: String,
        /// What to say. Several words are joined with spaces; `-` reads stdin.
        #[arg(required = true, num_args = 1.., trailing_var_arg = true)]
        text: Vec<String>,
    },

    /// List the browser tabs in the workspace (list_tabs).
    #[command(after_help = "Examples:\n  crew tabs")]
    Tabs,

    /// Call any tool by name, exactly as an agent would.
    #[command(disable_help_flag = true, after_help = "\
Examples:
  crew call --help                          every tool you can call
  crew call read_logs --help                what one takes
  crew call list_agents
  crew call read_logs '{\"process\": \"web\", \"tail\": 50}'
  echo '{\"process\": \"web\"}' | crew call start_process -")]
    Call(CallArgs),

    /// Serve Crew's tools over MCP on stdio, for an MCP client's config.
    #[command(after_help = "\
Example, in a client's MCP config:
  { \"command\": \"crew\", \"args\": [\"mcp\"] }

Inside a Crew session it speaks as that session; elsewhere as you, in the
workspace of the directory it starts in.")]
    Mcp,

    /// Print a shell completion script.
    #[command(after_help = "\
Examples:
  crew completions zsh > ~/.zfunc/_crew
  crew completions bash > /usr/local/etc/bash_completion.d/crew
  crew completions fish > ~/.config/fish/completions/crew.fish")]
    Completions {
        shell: CompletionShell,
    },

    /// The daemon behind the app: status, stop, restart, and running it on its own.
    Daemon {
        #[command(subcommand)]
        command: DaemonCommand,
    },
}

#[derive(Args, Debug, Clone)]
pub struct ProcessArg {
    /// The process, by name or id.
    pub process: String,
}

#[derive(Args, Debug, Clone)]
pub struct LogsArgs {
    /// The process, by name or id.
    pub process: String,
    /// Keep printing what it writes until interrupted.
    #[arg(short, long)]
    pub follow: bool,
    /// How many lines to print (with --grep, how many matches).
    #[arg(short = 'n', long = "lines", value_name = "N")]
    pub lines: Option<u32>,
    /// Only the lines matching this regular expression.
    #[arg(long, value_name = "PATTERN")]
    pub grep: Option<String>,
    /// Lines of context around each match.
    #[arg(short = 'C', long, value_name = "N", requires = "grep")]
    pub context: Option<u32>,
}

#[derive(Subcommand, Debug)]
pub enum ProcCommand {
    /// Define a new process (create_process).
    #[command(after_help = "\
Examples:
  crew proc add web npm run dev
  crew proc add api --cwd server --env PORT=4000 --auto-start -- cargo run")]
    Add {
        /// What to call it.
        name: String,
        /// The command line, run by your shell.
        #[arg(required = true, num_args = 1.., trailing_var_arg = true, allow_hyphen_values = true)]
        command: Vec<String>,
        /// Where it runs: relative to the workspace folder, or absolute.
        #[arg(long)]
        cwd: Option<String>,
        /// An environment variable, KEY=VALUE. Repeat for more.
        #[arg(long = "env", value_name = "KEY=VALUE")]
        env: Vec<String>,
        /// Start it whenever Crew starts.
        #[arg(long)]
        auto_start: bool,
        /// Start it again when it exits on its own.
        #[arg(long)]
        auto_restart: bool,
    },
    /// Change a process's definition; only what you name changes (update_process).
    #[command(after_help = "\
Examples:
  crew proc edit web --command 'npm run dev -- --port 3001'
  crew proc edit web --auto-restart true")]
    Edit {
        /// The process, by name or id.
        process: String,
        #[arg(long)]
        name: Option<String>,
        #[arg(long)]
        command: Option<String>,
        #[arg(long)]
        cwd: Option<String>,
        /// Replaces its environment: KEY=VALUE, repeated.
        #[arg(long = "env", value_name = "KEY=VALUE")]
        env: Vec<String>,
        #[arg(long, value_name = "true|false")]
        auto_start: Option<bool>,
        #[arg(long, value_name = "true|false")]
        auto_restart: Option<bool>,
    },
    /// Remove a process definition, stopping it first (delete_process).
    #[command(after_help = "Examples:\n  crew proc rm web")]
    Rm {
        /// The process, by name or id.
        process: String,
    },
}

/// `call` takes its own `--help`, because the answer depends on the tool and
/// on which tools the daemon has, which clap cannot know ahead of time.
#[derive(Args, Debug, Clone, Default)]
pub struct CallArgs {
    /// The tool to run. Leave it out to list them.
    pub tool: Option<String>,
    /// Its arguments, a JSON object. `-` reads them from stdin.
    pub arguments: Option<String>,
    /// Without a tool, list every tool; with one, say what it takes.
    #[arg(short = 'h', long, action = ArgAction::SetTrue)]
    pub help: bool,
}

#[derive(Subcommand, Debug)]
pub enum DaemonCommand {
    /// Whether crewd is running, its pid and version, and what keeps it alive.
    Status,
    /// Stop crewd. While the app is open, it starts it again.
    Stop,
    /// Stop crewd and wait for a new one to come up.
    Restart,
    /// Run crewd as a LaunchAgent: from login, and past quitting Crew. The app does this itself.
    #[command(after_help = "\
Examples:
  crew daemon install
  crew daemon install --crewd /Applications/Crew.app/Contents/Resources/crewd")]
    Install {
        /// The crewd to run. Defaults to the one beside this `crew`, as in the app's bundle.
        #[arg(long, value_name = "PATH")]
        crewd: Option<PathBuf>,
    },
    /// Stop crewd and remove its LaunchAgent. The packaged app puts it back when it opens.
    Uninstall,
}

#[derive(ValueEnum, Clone, Copy, Debug, PartialEq, Eq)]
pub enum CompletionShell {
    Zsh,
    Bash,
    Fish,
}

impl From<CompletionShell> for clap_complete::Shell {
    fn from(shell: CompletionShell) -> Self {
        match shell {
            CompletionShell::Zsh => clap_complete::Shell::Zsh,
            CompletionShell::Bash => clap_complete::Shell::Bash,
            CompletionShell::Fish => clap_complete::Shell::Fish,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use clap::CommandFactory;

    fn parse(args: &[&str]) -> Cli {
        Cli::try_parse_from(std::iter::once("crew").chain(args.iter().copied())).expect("parse")
    }

    #[test]
    fn the_definition_is_consistent() {
        Cli::command().debug_assert();
    }

    #[test]
    fn global_flags_go_anywhere() {
        let cli = parse(&["agents", "--json", "-w", "/tmp/x", "--data-dir", "/d"]);
        assert!(cli.global.json);
        assert_eq!(cli.global.workspace.as_deref(), Some("/tmp/x"));
        assert_eq!(cli.global.data_dir, Some(PathBuf::from("/d")));
        assert!(matches!(cli.command, Command::Agents));
        let cli = parse(&["--json", "ps"]);
        assert!(cli.global.json && matches!(cli.command, Command::Ps));
    }

    #[test]
    fn logs_takes_follow_lines_and_a_pattern() {
        let Command::Logs(logs) = parse(&["logs", "web", "-f", "-n", "20", "--grep", "err", "-C", "2"]).command else {
            panic!("not logs");
        };
        assert_eq!(logs.process, "web");
        assert!(logs.follow);
        assert_eq!(logs.lines, Some(20));
        assert_eq!(logs.grep.as_deref(), Some("err"));
        assert_eq!(logs.context, Some(2));
        // Context without a pattern means nothing.
        assert!(Cli::try_parse_from(["crew", "logs", "web", "-C", "2"]).is_err());
    }

    #[test]
    fn send_joins_the_words_after_the_agent() {
        let Command::Send { agent, text } = parse(&["send", "Reviewer", "look", "at", "-this"]).command else {
            panic!("not send");
        };
        assert_eq!(agent, "Reviewer");
        assert_eq!(text, ["look", "at", "-this"]);
        assert!(Cli::try_parse_from(["crew", "send", "Reviewer"]).is_err(), "nothing to say");
    }

    #[test]
    fn call_owns_its_help() {
        let Command::Call(call) = parse(&["call", "--help"]).command else { panic!("not call") };
        assert!(call.help && call.tool.is_none());
        let Command::Call(call) = parse(&["call", "read_logs", "--help"]).command else { panic!("not call") };
        assert!(call.help);
        assert_eq!(call.tool.as_deref(), Some("read_logs"));
        let Command::Call(call) = parse(&["call", "read_logs", r#"{"process":"web"}"#, "--json"]).command else {
            panic!("not call")
        };
        assert_eq!(call.arguments.as_deref(), Some(r#"{"process":"web"}"#));
    }

    #[test]
    fn proc_add_keeps_the_command_whole() {
        let Command::Proc { command: ProcCommand::Add { name, command, env, auto_start, .. } } =
            parse(&["proc", "add", "api", "--env", "PORT=4000", "--auto-start", "--", "cargo", "run", "--release"]).command
        else {
            panic!("not proc add");
        };
        assert_eq!(name, "api");
        assert_eq!(command, ["cargo", "run", "--release"]);
        assert_eq!(env, ["PORT=4000"]);
        assert!(auto_start);
    }

    #[test]
    fn daemon_install_takes_the_crewd_to_run() {
        let Command::Daemon { command: DaemonCommand::Install { crewd } } =
            parse(&["daemon", "install", "--crewd", "/b/crewd", "--data-dir", "/d"]).command
        else {
            panic!("not daemon install");
        };
        assert_eq!(crewd, Some(PathBuf::from("/b/crewd")));
        assert!(matches!(parse(&["daemon", "install"]).command, Command::Daemon { command: DaemonCommand::Install { crewd: None } }));
    }

    #[test]
    fn completions_are_for_three_shells() {
        assert!(matches!(parse(&["completions", "zsh"]).command, Command::Completions { shell: CompletionShell::Zsh }));
        assert!(Cli::try_parse_from(["crew", "completions", "powershell"]).is_err());
    }
}
