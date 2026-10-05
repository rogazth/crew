//! What `crew` takes on the command line: `crew <group> <verb>`, one command
//! per tool, named in its help, so what the CLI does and what an agent can do
//! through MCP stay the same thing. The groups are built in `commands`; here
//! are the commands that are not tools, and the flags of the tool commands
//! written by hand.

use std::path::PathBuf;

use clap::{Args, CommandFactory, Parser, Subcommand, ValueEnum};

const EXAMPLES: &str = "\
Examples:
  crew status                         is Crew running, and who does it take you for
  crew processes list                 the processes of the workspace you are in
  crew processes logs web -f          follow a process's output
  crew bots send Reviewer \"look at the diff on main\"
  crew tabs snapshot --json
  crew <group> --help                 what a group's commands do

Outside a Crew session the CLI speaks as you, in the workspace that holds the
current directory (or --workspace). Inside one it speaks as that session, and
only --as-user, meant for a human typing at a Crew terminal, makes it you.

Exit status: 0 done, 1 the tool or command failed, 2 bad usage, 3 Crew isn't running.";

#[derive(Parser, Debug)]
#[command(
    name = "crew",
    version,
    about = "Drive Crew from a shell: its bots, processes, browser tabs and routines.",
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
    #[arg(long, global = true, help_heading = "Global options")]
    pub json: bool,
    /// The workspace to act in: its id, or a path inside its folder.
    /// Defaults to the current directory. A Crew session always acts in its own.
    #[arg(long, short = 'w', global = true, value_name = "ID|PATH", help_heading = "Global options")]
    pub workspace: Option<String>,
    /// Crew's data directory, where daemon.json lives. Defaults to
    /// $CREW_DATA_DIR, else the installed app's. Inside a Crew session it is
    /// ignored unless --as-user is given too.
    #[arg(long, global = true, value_name = "DIR", help_heading = "Global options")]
    pub data_dir: Option<PathBuf>,
    /// For a human at a Crew terminal: speak as you, through daemon.json,
    /// instead of as the session. Not for agents: Crew takes it at its word.
    #[arg(long, global = true, help_heading = "Global options")]
    pub as_user: bool,
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
    /// Refused inside a Crew session, unless --as-user.
    Daemon {
        #[command(subcommand)]
        command: DaemonCommand,
    },
}

/// The flags of `processes logs`, which reads, follows and greps with the
/// three log tools.
#[derive(Args, Debug, Clone)]
pub struct LogsArgs {
    /// The process, by name or id.
    pub process: String,
    /// The worktree whose run to read, by path; the main checkout if not given.
    #[arg(long, value_name = "PATH")]
    pub worktree: Option<String>,
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

/// `bots send`: a bot by id or by name, and the words to send it.
#[derive(Args, Debug, Clone)]
pub struct SendArgs {
    /// The bot, by id or by name.
    pub bot: String,
    /// What to say. Several words are joined with spaces; `-` reads stdin.
    #[arg(required = true, num_args = 1.., trailing_var_arg = true, allow_hyphen_values = true)]
    pub text: Vec<String>,
}

/// `processes add`: the command line taken whole, after its name.
#[derive(Args, Debug, Clone)]
pub struct ProcAdd {
    /// What to call it.
    pub name: String,
    /// The command line, run by your shell.
    #[arg(required = true, num_args = 1.., trailing_var_arg = true, allow_hyphen_values = true)]
    pub command: Vec<String>,
    /// Where it runs: relative to the workspace folder, or absolute.
    #[arg(long)]
    pub cwd: Option<String>,
    /// An environment variable, KEY=VALUE. Repeat for more.
    #[arg(long = "env", value_name = "KEY=VALUE")]
    pub env: Vec<String>,
    /// Start it again when it exits on its own.
    #[arg(long)]
    pub auto_restart: bool,
}

/// `processes edit`: only what is named changes.
#[derive(Args, Debug, Clone)]
pub struct ProcEdit {
    /// The process, by name or id.
    pub process: String,
    #[arg(long)]
    pub name: Option<String>,
    #[arg(long)]
    pub command: Option<String>,
    #[arg(long)]
    pub cwd: Option<String>,
    /// Replaces its environment: KEY=VALUE, repeated.
    #[arg(long = "env", value_name = "KEY=VALUE")]
    pub env: Vec<String>,
    #[arg(long, value_name = "true|false")]
    pub auto_restart: Option<bool>,
}

/// The whole tree: the commands above, and a group per kind of tool.
pub fn command() -> clap::Command {
    let mut command = Cli::command();
    // The groups first: they are what the CLI is for.
    for (order, name) in ["status", "open", "mcp", "completions", "daemon"].into_iter().enumerate() {
        command = command.mut_subcommand(name, |sub| sub.display_order(100 + order));
    }
    command.subcommands(crate::commands::subcommands())
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
    use clap::FromArgMatches;

    fn matches(args: &[&str]) -> clap::ArgMatches {
        command().try_get_matches_from(std::iter::once("crew").chain(args.iter().copied())).expect("parse")
    }

    fn verb<T: FromArgMatches>(args: &[&str]) -> T {
        let root = matches(args);
        let (_, group) = root.subcommand().expect("group");
        let (_, verb) = group.subcommand().expect("verb");
        T::from_arg_matches(verb).expect("args")
    }

    #[test]
    fn the_definition_is_consistent() {
        command().debug_assert();
    }

    #[test]
    fn global_flags_go_anywhere() {
        let root = matches(&["bots", "list", "--json", "-w", "/tmp/x", "--data-dir", "/d"]);
        let global = Global::from_arg_matches(&root).expect("global");
        assert!(global.json);
        assert_eq!(global.workspace.as_deref(), Some("/tmp/x"));
        assert_eq!(global.data_dir, Some(PathBuf::from("/d")));
        assert!(!global.as_user);
        let global = Global::from_arg_matches(&matches(&["--json", "processes", "list", "--as-user"])).expect("global");
        assert!(global.json && global.as_user);
    }

    #[test]
    fn logs_takes_follow_lines_and_a_pattern() {
        let logs: LogsArgs = verb(&["processes", "logs", "web", "-f", "-n", "20", "--grep", "err", "-C", "2"]);
        assert_eq!(logs.process, "web");
        assert!(logs.follow);
        assert_eq!(logs.lines, Some(20));
        assert_eq!(logs.grep.as_deref(), Some("err"));
        assert_eq!(logs.context, Some(2));
        // Context without a pattern means nothing.
        assert!(command().try_get_matches_from(["crew", "processes", "logs", "web", "-C", "2"]).is_err());
    }

    #[test]
    fn send_joins_the_words_after_the_bot() {
        let send: SendArgs = verb(&["bots", "send", "Reviewer", "look", "at", "-this"]);
        assert_eq!(send.bot, "Reviewer");
        assert_eq!(send.text, ["look", "at", "-this"]);
        assert!(command().try_get_matches_from(["crew", "bots", "send", "Reviewer"]).is_err(), "nothing to say");
    }

    #[test]
    fn processes_add_keeps_the_command_whole() {
        let add: ProcAdd = verb(&["processes", "add", "api", "--env", "PORT=4000", "--auto-restart", "--", "cargo", "run", "--release"]);
        assert_eq!(add.name, "api");
        assert_eq!(add.command, ["cargo", "run", "--release"]);
        assert_eq!(add.env, ["PORT=4000"]);
        assert!(add.auto_restart);
    }

    #[test]
    fn daemon_install_takes_the_crewd_to_run() {
        let cli = Cli::from_arg_matches(&matches(&["daemon", "install", "--crewd", "/b/crewd", "--data-dir", "/d"])).expect("cli");
        let Command::Daemon { command: DaemonCommand::Install { crewd } } = cli.command else {
            panic!("not daemon install");
        };
        assert_eq!(crewd, Some(PathBuf::from("/b/crewd")));
    }

    #[test]
    fn completions_are_for_three_shells() {
        let cli = Cli::from_arg_matches(&matches(&["completions", "zsh"])).expect("cli");
        assert!(matches!(cli.command, Command::Completions { shell: CompletionShell::Zsh }));
        assert!(command().try_get_matches_from(["crew", "completions", "powershell"]).is_err());
    }

    /// The tool commands live in groups now; the old top-level ones are gone.
    #[test]
    fn there_is_no_call_and_no_top_level_tool_command() {
        for old in ["call", "ps", "send", "logs", "start", "stop"] {
            let error = command().try_get_matches_from(["crew", old]).expect_err(old);
            assert_eq!(error.kind(), clap::error::ErrorKind::InvalidSubcommand, "{old}");
        }
    }
}
