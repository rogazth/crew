//! `crew`, the command line. A library so `crewd call` can be the very same
//! command for the version it is kept as an alias.

use std::ffi::OsString;
use std::process::ExitCode;

use clap::{CommandFactory, Parser};
use serde_json::Value;

pub mod args;
mod agents;
mod app;
mod call;
mod client;
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
    let cli = match Cli::try_parse_from(args) {
        Ok(cli) => cli,
        Err(error) => {
            let _ = error.print();
            return ExitCode::from(error.exit_code() as u8);
        }
    };
    let ctx = Ctx { global: cli.global, env: Env::from_process() };
    match dispatch(&ctx, cli.command) {
        Ok(code) => code,
        Err(error) => {
            if !error.message().is_empty() {
                eprintln!("crew: {}", error.message());
            }
            ExitCode::from(error.code())
        }
    }
}

fn dispatch(ctx: &Ctx, command: Command) -> Result<ExitCode, CliError> {
    match command {
        Command::Open { path } => app::open(path.as_deref()),
        Command::Status => app::status(ctx),
        Command::Ps => processes::ps(ctx),
        Command::Start(target) => processes::act(ctx, "start_process", &target.process),
        Command::Stop(target) => processes::act(ctx, "stop_process", &target.process),
        Command::Restart(target) => processes::act(ctx, "restart_process", &target.process),
        Command::Pause(target) => processes::act(ctx, "pause_process", &target.process),
        Command::Resume(target) => processes::act(ctx, "resume_process", &target.process),
        Command::Logs(logs) => processes::logs(ctx, &logs),
        Command::Proc { command } => processes::define(ctx, command),
        Command::Agents => agents::list(ctx),
        Command::Send { agent, text } => agents::send(ctx, &agent, &text),
        Command::Tabs => agents::tabs(ctx),
        Command::Call(call) => call::run(ctx, &call),
        Command::Mcp => {
            let identity = Identity::resolve(&ctx.global, &ctx.env)?;
            Ok(crew_core::mcp::serve_stdio_with(identity.link()))
        }
        Command::Completions { shell } => {
            let shell: clap_complete::Shell = shell.into();
            let mut script = Vec::new();
            clap_complete::generate(shell, &mut Cli::command(), "crew", &mut script);
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
        clap_complete::generate(clap_complete::Shell::Zsh, &mut Cli::command(), "crew", &mut script);
        let script = String::from_utf8(script).expect("utf8");
        for command in ["logs", "agents", "call", "daemon"] {
            assert!(script.contains(command), "{command} missing");
        }
    }
}
