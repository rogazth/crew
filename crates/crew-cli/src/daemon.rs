//! `crew daemon`: the process behind the app.
//!
//! Two things can keep crewd alive, and stopping it means something different
//! under each. The dev app runs it as its child and starts it again when it
//! dies. The packaged app installs a LaunchAgent (`launch_agent.rs`) and
//! connects to it, so crewd runs past quitting Crew; launchd brings it back
//! after a crash and leaves it down after a clean stop.

use std::path::{Path, PathBuf};
use std::process::ExitCode;
use std::time::{Duration, Instant};

use crew_core::mcp::Link;
use crew_protocol::DaemonFile;
use serde_json::{json, Value};

use crate::app::Status;
use crate::args::DaemonCommand;
use crate::identity::{self, Source};
use crate::launch_agent::{self, Agent, LABEL};
use crate::output;
use crate::{CliError, Ctx};

/// crewd has 5 s to stop its PTYs and agents after SIGTERM; a little more here.
const STOP_WAIT: Duration = Duration::from_secs(7);
/// How long a restart waits for a new daemon to come up.
const START_WAIT: Duration = Duration::from_secs(15);
/// How long a stop watches for the app starting another in its place.
const RESPAWN_WATCH: Duration = Duration::from_secs(3);
const POLL: Duration = Duration::from_millis(200);

/// What keeps crewd alive.
#[derive(Clone, Debug, PartialEq, Eq)]
enum Supervisor {
    /// The window's child: it lives and dies with the app.
    App,
    /// launchd, from the plist `crew daemon install` wrote for this data dir.
    LaunchAgent(Agent),
}

impl Supervisor {
    /// The LaunchAgent when there is one for this very data dir. One for
    /// another (the installed app's, while this names a dev build's) says
    /// nothing about the daemon here.
    fn choose(installed: Option<Agent>, data_dir: &Path) -> Self {
        match installed {
            Some(agent) if agent.serves(data_dir) => Supervisor::LaunchAgent(agent),
            _ => Supervisor::App,
        }
    }

    fn current(data_dir: &Path) -> Self {
        if !cfg!(target_os = "macos") {
            return Supervisor::App;
        }
        Self::choose(launch_agent::installed(data_dir), data_dir)
    }

    fn name(&self) -> &'static str {
        match self {
            Supervisor::App => "app",
            Supervisor::LaunchAgent(_) => "launchagent",
        }
    }

    fn describe(&self, loaded: Option<&launch_agent::Loaded>) -> String {
        match self {
            Supervisor::App => "the Crew app, as its child; it stops when the app quits".into(),
            Supervisor::LaunchAgent(_) => {
                let state = match loaded {
                    None => "installed, not loaded".to_string(),
                    Some(loaded) => loaded.state.clone().unwrap_or_else(|| "loaded".into()),
                };
                format!("launchd, as {LABEL} ({state}); it keeps running when Crew quits")
            }
        }
    }
}

pub fn run(ctx: &Ctx, command: DaemonCommand) -> Result<ExitCode, CliError> {
    let supervised = |ctx: &Ctx| -> Result<(PathBuf, Supervisor), CliError> {
        let dir = data_dir(ctx)?;
        let supervisor = Supervisor::current(&dir);
        Ok((dir, supervisor))
    };
    match command {
        DaemonCommand::Install { crewd } => install(ctx, crewd.as_deref()),
        DaemonCommand::Uninstall => uninstall(ctx),
        DaemonCommand::Status => supervised(ctx).and_then(|(_, supervisor)| status(ctx, &supervisor)),
        DaemonCommand::Stop => supervised(ctx).and_then(|(dir, supervisor)| stop(&dir, &supervisor)),
        DaemonCommand::Restart => supervised(ctx).and_then(|(dir, supervisor)| restart(&dir, &supervisor)),
    }
}

fn status(ctx: &Ctx, supervisor: &Supervisor) -> Result<ExitCode, CliError> {
    let status = Status::gather(ctx);
    let loaded = match supervisor {
        Supervisor::LaunchAgent(_) => launch_agent::loaded(),
        Supervisor::App => None,
    };
    if ctx.global.json {
        let mut report = status.json();
        report["supervisor"] = json!(supervisor.name());
        if let Supervisor::LaunchAgent(agent) = supervisor {
            report["launchAgent"] = json!({
                "label": LABEL,
                "program": agent.program,
                "log": agent.log(),
                "loaded": loaded.is_some(),
                "state": loaded.as_ref().and_then(|loaded| loaded.state.clone()),
                "pid": loaded.as_ref().and_then(|loaded| loaded.pid),
            });
        }
        output::say_json(&report);
    } else {
        let mut rows = status.rows();
        rows.push(("run by", supervisor.describe(loaded.as_ref())));
        if let Supervisor::LaunchAgent(agent) = supervisor {
            rows.push(("crewd", agent.program.display().to_string()));
            rows.push(("log", agent.log().display().to_string()));
        }
        output::say(&output::pairs(&rows));
    }
    Ok(if status.running { ExitCode::SUCCESS } else { ExitCode::from(3) })
}

fn macos_only(verb: &str) -> Result<(), CliError> {
    if cfg!(target_os = "macos") {
        Ok(())
    } else {
        Err(CliError::Failed(format!("`crew daemon {verb}` writes a macOS LaunchAgent; there is none to {verb} here.")))
    }
}

/// `--crewd`, else the crewd beside this `crew`: in the bundle they sit side
/// by side, and a `crew` on the PATH is a link into it, resolved first.
fn crewd_path(flag: Option<&Path>) -> Result<PathBuf, CliError> {
    let named = match flag {
        Some(path) => path.to_path_buf(),
        None => std::env::current_exe()
            .and_then(std::fs::canonicalize)
            .map_err(|e| CliError::Failed(format!("Couldn't tell where this crew is ({e}); name crewd with --crewd.")))?
            .with_file_name("crewd"),
    };
    let path = std::fs::canonicalize(&named).map_err(|_| {
        CliError::Failed(format!("No crewd at {}; name the one to run with --crewd <path>.", named.display()))
    })?;
    if !path.is_file() {
        return Err(CliError::Failed(format!("{} is not a file; name crewd with --crewd <path>.", path.display())));
    }
    Ok(path)
}

fn install(ctx: &Ctx, crewd: Option<&Path>) -> Result<ExitCode, CliError> {
    macos_only("install")?;
    // Not the session's: installing is for a data dir, not for whoever asks.
    let dir = identity::data_dir(ctx.global.data_dir.as_deref(), &ctx.env)?;
    let agent = Agent { program: crewd_path(crewd)?, data_dir: dir.clone() };
    let plist = launch_agent::plist_path(&dir);
    if launch_agent::loaded().is_some() {
        // The one it replaces stops first, as gracefully as any other stop:
        // two crewds on one data dir would fight over its database.
        launch_agent::bootout().map_err(CliError::Failed)?;
    } else if let Ok(file) = live_daemon(&dir) {
        return Err(CliError::Failed(format!(
            "crewd (pid {}) is already running for {} as the Crew app's child. Quit Crew, then install.",
            pid_text(&file),
            dir.display()
        )));
    }
    std::fs::create_dir_all(&dir).map_err(|e| CliError::Failed(format!("{}: {e}", dir.display())))?;
    create_private(&agent.log())?;
    write_plist(&plist, &agent.plist())?;
    launch_agent::start(&plist, false).map_err(CliError::Failed)?;
    if ctx.global.json {
        output::say_json(&json!({
            "installed": true,
            "label": LABEL,
            "plist": plist,
            "program": agent.program,
            "dataDir": agent.data_dir,
            "log": agent.log(),
        }));
    } else {
        output::say(&format!(
            "Installed {LABEL}. crewd ({}) now runs for {} and keeps running when Crew quits, until you log out.\nLog: {}",
            agent.program.display(),
            dir.display(),
            agent.log().display()
        ));
    }
    Ok(ExitCode::SUCCESS)
}

fn uninstall(ctx: &Ctx) -> Result<ExitCode, CliError> {
    macos_only("uninstall")?;
    let plist = launch_agent::plist_path(&identity::data_dir(ctx.global.data_dir.as_deref(), &ctx.env)?);
    let was_loaded = launch_agent::loaded().is_some();
    if was_loaded {
        launch_agent::bootout().map_err(CliError::Failed)?;
    }
    let had_file = plist.exists();
    if had_file {
        std::fs::remove_file(&plist).map_err(|e| CliError::Failed(format!("{}: {e}", plist.display())))?;
    }
    if ctx.global.json {
        output::say_json(&json!({ "uninstalled": was_loaded || had_file, "label": LABEL, "plist": plist }));
    } else if was_loaded || had_file {
        output::say(&format!(
            "Removed {LABEL} and stopped crewd. The packaged Crew app installs it again the next time it opens."
        ));
    } else {
        output::say("No LaunchAgent for crewd is installed.");
    }
    Ok(ExitCode::SUCCESS)
}

/// Created 0600 before launchd opens it, which it would do with the umask's
/// mode: what agents and processes print ends up in it.
fn create_private(path: &Path) -> Result<(), CliError> {
    use std::os::unix::fs::{OpenOptionsExt, PermissionsExt};
    std::fs::OpenOptions::new()
        .append(true)
        .create(true)
        .mode(0o600)
        .open(path)
        .and_then(|_| std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600)))
        .map_err(|e| CliError::Failed(format!("{}: {e}", path.display())))
}

/// Beside it and renamed over, so launchd never reads half a plist.
fn write_plist(path: &Path, body: &str) -> Result<(), CliError> {
    let fail = |e: std::io::Error| CliError::Failed(format!("{}: {e}", path.display()));
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(fail)?;
    }
    let temp = path.with_extension(format!("plist.{}", std::process::id()));
    std::fs::write(&temp, body).and_then(|_| std::fs::rename(&temp, path)).map_err(|e| {
        let _ = std::fs::remove_file(&temp);
        fail(e)
    })
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

fn stop(dir: &Path, supervisor: &Supervisor) -> Result<ExitCode, CliError> {
    let old = match supervisor {
        Supervisor::App => stop_daemon(dir)?,
        Supervisor::LaunchAgent(_) => stop_agent(dir)?,
    };
    let quit = match supervisor {
        Supervisor::App => "quit Crew to stop it for good",
        Supervisor::LaunchAgent(_) => "use Crew › Quit Crew and Stop Everything to stop both",
    };
    match wait_for_new(dir, Some(&old), RESPAWN_WATCH) {
        Some(new) => output::say(&format!(
            "Stopped crewd (pid {}). The Crew app started a new one (pid {}); {quit}.",
            pid_text(&old),
            pid_text(&new)
        )),
        None => output::say(&format!("Stopped crewd (pid {}).", pid_text(&old))),
    }
    Ok(ExitCode::SUCCESS)
}

fn restart(dir: &Path, supervisor: &Supervisor) -> Result<ExitCode, CliError> {
    let old = match supervisor {
        Supervisor::App => Some(stop_daemon(dir)?),
        Supervisor::LaunchAgent(_) => {
            // Down, or not even loaded since a reboot: started either way.
            let old = identity::read_daemon_file(dir).ok();
            launch_agent::start(&launch_agent::plist_path(dir), true).map_err(CliError::Failed)?;
            old
        }
    };
    let was = old.as_ref().map_or_else(|| "stopped".into(), |old| format!("pid {}", pid_text(old)));
    match wait_for_new(dir, old.as_ref(), START_WAIT) {
        Some(new) => {
            output::say(&format!("Restarted crewd: {was} → pid {}.", pid_text(&new)));
            Ok(ExitCode::SUCCESS)
        }
        None => Err(CliError::NotRunning(match supervisor {
            Supervisor::App => "crewd stopped and nothing started it again. Open Crew (`crew open`) to start it.".into(),
            Supervisor::LaunchAgent(agent) => format!(
                "launchd did not bring crewd back within {} s. See {}.",
                START_WAIT.as_secs(),
                agent.log().display()
            ),
        })),
    }
}

/// Asked, then waited for. The daemon's own `daemon/shutdown` first; one
/// too old to know it gets SIGTERM through launchd. Either way it exits 0,
/// which launchd takes as "leave it down".
fn stop_agent(dir: &Path) -> Result<DaemonFile, CliError> {
    let file = live_daemon(dir)?;
    let asked = Link::new(file.socket.clone(), file.user_token.clone(), None).call("daemon/shutdown", Value::Null);
    if asked.is_err() {
        launch_agent::terminate().map_err(CliError::Failed)?;
    }
    let deadline = Instant::now() + STOP_WAIT;
    loop {
        let gone = match file.pid {
            Some(pid) => !alive(pid),
            None => launch_agent::loaded().is_none_or(|loaded| loaded.pid.is_none()),
        };
        if gone {
            return Ok(file);
        }
        if Instant::now() >= deadline {
            return Err(CliError::Failed(format!("crewd (pid {}) is still running {} s after it was asked to stop.", pid_text(&file), STOP_WAIT.as_secs())));
        }
        std::thread::sleep(POLL);
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
fn wait_for_new(dir: &Path, old: Option<&DaemonFile>, wait: Duration) -> Option<DaemonFile> {
    let deadline = Instant::now() + wait;
    loop {
        if let Ok(file) = live_daemon(dir) {
            if old.is_none_or(|old| file.url != old.url || file.pid != old.pid) {
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

    fn agent_for(dir: &str) -> Agent {
        Agent { program: "/Applications/Crew.app/Contents/Resources/crewd".into(), data_dir: dir.into() }
    }

    #[test]
    fn the_launch_agent_supervises_only_its_own_data_dir() {
        let app = "/Users/me/Library/Application Support/Crew";
        assert_eq!(Supervisor::choose(None, Path::new(app)), Supervisor::App);
        assert_eq!(Supervisor::choose(Some(agent_for(app)), Path::new(app)), Supervisor::LaunchAgent(agent_for(app)));
        // A dev build's data dir, while the installed app's agent is there.
        assert_eq!(Supervisor::choose(Some(agent_for(app)), Path::new("/code/crew/.crew-dev")), Supervisor::App);
    }

    #[test]
    fn status_says_what_keeps_crewd_alive() {
        assert!(Supervisor::App.describe(None).contains("stops when the app quits"));
        let agent = Supervisor::LaunchAgent(agent_for("/d"));
        let running = launch_agent::Loaded { state: Some("running".into()), pid: Some(7) };
        let text = agent.describe(Some(&running));
        assert!(text.contains(LABEL) && text.contains("(running)") && text.contains("keeps running when Crew quits"), "{text}");
        assert!(agent.describe(None).contains("installed, not loaded"));
    }

    #[test]
    fn install_finds_crewd_beside_it_or_where_it_is_told() {
        let dir = std::env::temp_dir().join(format!("crew-cli-crewd-{}", std::process::id()));
        std::fs::create_dir_all(&dir).expect("dir");
        let crewd = dir.join("crewd");
        std::fs::write(&crewd, "").expect("crewd");
        assert_eq!(crewd_path(Some(&crewd)).expect("found"), std::fs::canonicalize(&crewd).expect("canon"));
        let Err(CliError::Failed(message)) = crewd_path(Some(&dir.join("nope"))) else { panic!("found nothing") };
        assert!(message.contains("--crewd"), "{message}");
        assert!(crewd_path(Some(&dir)).is_err(), "a directory is not crewd");
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
