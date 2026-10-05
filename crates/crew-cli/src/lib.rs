//! `crew`, the command line. A library so its tests, and `crewd`, can build
//! the same tree.

use std::ffi::OsString;
use std::process::ExitCode;

use clap::FromArgMatches;
use serde_json::Value;

pub mod args;
mod bots;
mod app;
mod client;
mod commands;
mod daemon;
mod identity;
pub mod launch_agent;
mod output;
mod processes;

use args::{Cli, Command, Global};
use client::{Client, Reply};
use identity::{Env, Identity};

/// Why a command did not do what it was asked, and the exit status that says so.
#[derive(Debug)]
pub enum CliError {
    /// Nothing answers: no daemon.json, or a socket nobody listens on. Exit 3,
    /// so a script can tell "start Crew" from "Crew said no".
    NotRunning(String),
    /// The tool refused, or the command failed. Exit 1.
    Failed(String),
    /// Asked wrong. Exit 2, like clap's own.
    Usage(String),
}

impl CliError {
    fn from_bridge(message: String) -> Self {
        if message.starts_with(crew_core::mcp::NOT_RUNNING) {
            CliError::NotRunning(message)
        } else {
            CliError::Failed(message)
        }
    }

    fn code(&self) -> u8 {
        match self {
            CliError::Failed(_) => 1,
            CliError::Usage(_) => 2,
            CliError::NotRunning(_) => 3,
        }
    }

    pub(crate) fn message(&self) -> &str {
        match self {
            CliError::NotRunning(message) | CliError::Failed(message) | CliError::Usage(message) => message,
        }
    }
}

/// What every command is handed: the global flags, and the environment the
/// identity is chosen from.
pub(crate) struct Ctx {
    pub global: Global,
    pub env: Env,
}

impl Ctx {
    pub fn client(&self) -> Result<Client, CliError> {
        Identity::resolve(&self.global, &self.env).map(Client::new)
    }

    /// A wrapper's answer: the data under `--json`, else what `human` makes of
    /// it, else the tool's own words.
    pub fn show(&self, reply: &Reply, human: impl FnOnce(&Value) -> Option<String>) {
        let value = reply.value();
        if self.global.json {
            output::say_json(&value);
            return;
        }
        match human(&value) {
            Some(text) => output::say(&text),
            None => output::say(&reply.text()),
        }
    }
}

pub fn main() -> ExitCode {
    run_from(std::env::args_os())
}

pub fn run_from<I, T>(args: I) -> ExitCode
where
    I: IntoIterator<Item = T>,
    T: Into<OsString> + Clone,
{
    let matches = match args::command().try_get_matches_from(args) {
        Ok(matches) => matches,
        Err(error) => {
            let _ = error.print();
            return ExitCode::from(error.exit_code() as u8);
        }
    };
    let global = match Global::from_arg_matches(&matches) {
        Ok(global) => global,
        Err(error) => {
            let _ = error.print();
            return ExitCode::from(2);
        }
    };
    let ctx = Ctx { global, env: Env::from_process() };
    let result = match matches.subcommand() {
        Some((group, sub)) if commands::GROUPS.iter().any(|candidate| candidate.name == group) => commands::run(&ctx, group, sub),
        _ => Cli::from_arg_matches(&matches)
            .map_err(|e| CliError::Usage(e.to_string()))
            .and_then(|cli| dispatch(&ctx, cli.command)),
    };
    result.unwrap_or_else(|error| report(&ctx, error))
}

/// Why it failed, where the one who ran it reads it. A session is a model
/// reading the command's output, and Cursor runs its commands with stderr
/// thrown away, so there a refusal goes to stdout; a person gets stderr.
fn report(ctx: &Ctx, error: CliError) -> ExitCode {
    if !error.message().is_empty() {
        let line = format!("crew: {}", error.message());
        if identity::in_session(&ctx.env) && !ctx.global.as_user {
            output::say(&line);
        } else {
            eprintln!("{line}");
        }
    }
    ExitCode::from(error.code())
}

fn dispatch(ctx: &Ctx, command: Command) -> Result<ExitCode, CliError> {
    match command {
        Command::Open { path } => app::open(path.as_deref()),
        Command::Status => app::status(ctx),
        Command::Mcp => {
            let identity = Identity::resolve(&ctx.global, &ctx.env)?;
            Ok(crew_core::mcp::serve_stdio_with(identity.link()))
        }
        Command::Completions { shell } => {
            let shell: clap_complete::Shell = shell.into();
            let mut script = Vec::new();
            clap_complete::generate(shell, &mut args::command(), "crew", &mut script);
            output::say(String::from_utf8_lossy(&script).trim_end());
            Ok(ExitCode::SUCCESS)
        }
        Command::Daemon { command } => daemon::run(ctx, command),
    }
}

/// Everything a command reads from stdin when it is handed `-`.
pub(crate) fn read_stdin() -> Result<String, CliError> {
    use std::io::Read;
    let mut text = String::new();
    std::io::stdin()
        .read_to_string(&mut text)
        .map_err(|e| CliError::Failed(format!("stdin: {e}")))?;
    Ok(text)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn exit_codes_tell_not_running_from_refused() {
        let gone = CliError::from_bridge(format!("{} (Connection refused)", crew_core::mcp::NOT_RUNNING));
        assert!(matches!(gone, CliError::NotRunning(_)));
        assert_eq!(gone.code(), 3);
        let refused = CliError::from_bridge("Bad token".into());
        assert_eq!(refused.code(), 1);
        assert_eq!(CliError::Usage(String::new()).code(), 2);
    }

    #[test]
    fn completions_name_the_commands() {
        let mut script = Vec::new();
        clap_complete::generate(clap_complete::Shell::Zsh, &mut args::command(), "crew", &mut script);
        let script = String::from_utf8(script).expect("utf8");
        for command in ["logs", "bots", "processes", "tabs", "snapshot", "daemon"] {
            assert!(script.contains(command), "{command} missing");
        }
    }
}
