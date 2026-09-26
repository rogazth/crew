//! `crew daemon`: the process behind the app.
//!
//! Today the app starts crewd as its child and restarts it once when it dies,
//! so stopping it from here is best effort: the app may bring it straight
//! back. Once crewd runs as a LaunchAgent (`docs/plans/2026-09-25-processes-browser-cli.md`,
//! phase 5) that becomes a second [`Supervisor`], which is where `install`
//! and `uninstall` belong.

use std::path::{Path, PathBuf};
use std::process::ExitCode;
use std::time::{Duration, Instant};

use crew_core::mcp::Link;
use crew_protocol::DaemonFile;
use serde_json::Value;

use crate::app::Status;
use crate::args::DaemonCommand;
use crate::identity::{self, Source};
use crate::output;
use crate::{CliError, Ctx};

/// crewd has 5 s to stop its PTYs and agents after SIGTERM; a little more here.
const STOP_WAIT: Duration = Duration::from_secs(7);
/// How long a restart waits for the app to bring a new daemon up.
const START_WAIT: Duration = Duration::from_secs(15);
/// How long a stop watches for the app starting another in its place.
const RESPAWN_WATCH: Duration = Duration::from_secs(3);
const POLL: Duration = Duration::from_millis(200);

/// What keeps crewd alive.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Supervisor {
    /// The window's child: it lives and dies with the app.
    App,
}

impl Supervisor {
    fn current() -> Self {
        Supervisor::App
    }

    fn describe(self) -> &'static str {
        match self {
            Supervisor::App => "the Crew app, as its child; it stops when the app quits",
        }
    }

    fn install(self) -> Result<ExitCode, CliError> {
        match self {
            Supervisor::App => Err(not_yet("install")),
        }
    }

    fn uninstall(self) -> Result<ExitCode, CliError> {
        match self {
            Supervisor::App => Err(not_yet("uninstall")),
        }
    }
}

fn not_yet(verb: &str) -> CliError {
    CliError::Failed(format!(
        "`crew daemon {verb}` is not available yet: crewd still runs as part of the Crew app, \
         and there is no LaunchAgent to {verb} until it can outlive the window."
    ))
}

pub fn run(ctx: &Ctx, command: DaemonCommand) -> Result<ExitCode, CliError> {
    let supervisor = Supervisor::current();
    match command {
        DaemonCommand::Status => status(ctx, supervisor),
        DaemonCommand::Stop => stop(ctx),
        DaemonCommand::Restart => restart(ctx),
        DaemonCommand::Install => supervisor.install(),
        DaemonCommand::Uninstall => supervisor.uninstall(),
    }
}

fn status(ctx: &Ctx, supervisor: Supervisor) -> Result<ExitCode, CliError> {
    let status = Status::gather(ctx);
    if ctx.global.json {
        let mut report = status.json();
        report["supervisor"] = serde_json::json!(format!("{supervisor:?}").to_lowercase());
        output::say_json(&report);
    } else {
        let mut rows = status.rows();
        rows.push(("run by", supervisor.describe().to_string()));
        output::say(&output::pairs(&rows));
    }
    Ok(if status.running { ExitCode::SUCCESS } else { ExitCode::from(3) })
}

/// The data dir whichever identity this run has reaches.
fn data_dir(ctx: &Ctx) -> Result<PathBuf, CliError> {
    match identity::choose(&ctx.global, &ctx.env)? {
        Source::User { data_dir } => Ok(data_dir),
        Source::Session { socket, .. } => Path::new(&socket)
            .parent()
            .map(Path::to_path_buf)
            .ok_or_else(|| CliError::Failed(format!("No data dir beside {socket}"))),
    }
}

/// The daemon daemon.json names, if it answers on its socket. A file whose
/// daemon died is not proof of anything, least of all that its pid is still
/// crewd's.
fn live_daemon(dir: &Path) -> Result<DaemonFile, CliError> {
    let file = identity::read_daemon_file(dir)?;
    Link::new(file.socket.clone(), file.user_token.clone(), None)
        .call("tools/list", Value::Null)
        .map_err(CliError::from_bridge)?;
    Ok(file)
}

fn stop(ctx: &Ctx) -> Result<ExitCode, CliError> {
    let dir = data_dir(ctx)?;
    let old = stop_daemon(&dir)?;
    match wait_for_new(&dir, &old, RESPAWN_WATCH) {
        Some(new) => output::say(&format!(
            "Stopped crewd (pid {}). The Crew app started a new one (pid {}); quit Crew to stop it for good.",
            pid_text(&old),
            pid_text(&new)
        )),
        None => output::say(&format!("Stopped crewd (pid {}).", pid_text(&old))),
    }
    Ok(ExitCode::SUCCESS)
}

fn restart(ctx: &Ctx) -> Result<ExitCode, CliError> {
    let dir = data_dir(ctx)?;
    let old = stop_daemon(&dir)?;
    match wait_for_new(&dir, &old, START_WAIT) {
        Some(new) => {
            output::say(&format!("Restarted crewd: pid {} → {}.", pid_text(&old), pid_text(&new)));
            Ok(ExitCode::SUCCESS)
        }
        None => Err(CliError::NotRunning(
            "crewd stopped and nothing started it again. Open Crew (`crew open`) to start it.".into(),
        )),
    }
}

fn pid_text(file: &DaemonFile) -> String {
    file.pid.map_or_else(|| "?".into(), |pid| pid.to_string())
}

/// SIGTERM, the way the app stops it, then wait for it to be gone.
fn stop_daemon(dir: &Path) -> Result<DaemonFile, CliError> {
    let file = live_daemon(dir)?;
    let pid = file.pid.ok_or_else(|| {
        CliError::Failed("This crewd does not say its pid (it is older than `crew daemon`); quit Crew to stop it.".into())
    })?;
    if !is_crewd(pid) {
        return Err(CliError::Failed(format!("pid {pid} in daemon.json is not crewd; leaving it alone.")));
    }
    if unsafe { libc::kill(pid as libc::pid_t, libc::SIGTERM) } != 0 {
        return Err(CliError::Failed(format!("Couldn't signal crewd (pid {pid}): {}", std::io::Error::last_os_error())));
    }
    let deadline = Instant::now() + STOP_WAIT;
    while alive(pid) {
        if Instant::now() >= deadline {
            return Err(CliError::Failed(format!("crewd (pid {pid}) is still running {} s after SIGTERM.", STOP_WAIT.as_secs())));
        }
        std::thread::sleep(POLL);
    }
    Ok(file)
}

/// A daemon other than `old` answering in `dir` within `wait`.
fn wait_for_new(dir: &Path, old: &DaemonFile, wait: Duration) -> Option<DaemonFile> {
    let deadline = Instant::now() + wait;
    loop {
        if let Ok(file) = live_daemon(dir) {
            if file.url != old.url || file.pid != old.pid {
                return Some(file);
            }
        }
        if Instant::now() >= deadline {
            return None;
        }
        std::thread::sleep(POLL);
    }
}

fn alive(pid: u32) -> bool {
    // Signal 0 checks without sending; EPERM still means someone has the pid.
    let sent = unsafe { libc::kill(pid as libc::pid_t, 0) };
    sent == 0 || std::io::Error::last_os_error().raw_os_error() == Some(libc::EPERM)
}

/// A pid is recycled once its process is gone, so it is checked by name.
fn is_crewd(pid: u32) -> bool {
    std::process::Command::new("ps")
        .args(["-p", &pid.to_string(), "-o", "comm="])
        .output()
        .map(|out| String::from_utf8_lossy(&out.stdout).trim().ends_with("crewd"))
        .unwrap_or(false)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn install_and_uninstall_say_they_are_not_there_yet() {
        for result in [Supervisor::App.install(), Supervisor::App.uninstall()] {
            let Err(CliError::Failed(message)) = result else { panic!("not refused") };
            assert!(message.contains("not available yet"), "{message}");
        }
    }

    #[test]
    fn this_process_is_alive_and_not_crewd() {
        let me = std::process::id();
        assert!(alive(me));
        assert!(!is_crewd(me));
    }

    #[test]
    fn stopping_with_no_daemon_says_crew_is_not_running() {
        let dir = std::env::temp_dir().join(format!("crew-cli-daemon-{}", std::process::id()));
        std::fs::create_dir_all(&dir).expect("dir");
        assert!(matches!(stop_daemon(&dir), Err(CliError::NotRunning(_))));
    }
}
