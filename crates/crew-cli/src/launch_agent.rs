//! The LaunchAgent that runs crewd on its own, from login to logout, so the
//! processes and agents it holds outlive the window. The packaged app
//! installs it by running `crew daemon install` from its bundle, which makes
//! this the one place the plist is written and read back.

use std::path::{Path, PathBuf};
use std::process::Command;
use std::time::{Duration, Instant};

/// The app's bundle id (`build.appId` in package.json) plus `.crewd`.
/// `electron/daemon-agent-plan.ts` names it too; a test on each side holds
/// both to package.json.
pub const LABEL: &str = "rogazth.crew.crewd";
/// In the data dir, beside daemon.json. crewd empties it when it grows too big.
pub const LOG: &str = "crewd.log";

const LAUNCHCTL: &str = "/bin/launchctl";
/// crewd gives its processes one 5 s stop grace and its PTYs one more second
/// before it exits; launchd waits for that before a bootout returns for good.
const GONE_WAIT: Duration = Duration::from_secs(10);
const POLL: Duration = Duration::from_millis(200);

/// What the plist runs: which crewd, for which data dir.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Agent {
    pub program: PathBuf,
    pub data_dir: PathBuf,
}

impl Agent {
    pub fn arguments(&self) -> Vec<String> {
        vec![
            self.program.to_string_lossy().into_owned(),
            "--data-dir".into(),
            self.data_dir.to_string_lossy().into_owned(),
            "--supervised-by".into(),
            "launchd".into(),
        ]
    }

    pub fn log(&self) -> PathBuf {
        self.data_dir.join(LOG)
    }

    /// `KeepAlive { SuccessfulExit: false }` is the whole stop story: a crash
    /// or a kill is not a successful exit, so launchd starts crewd again; a
    /// clean stop (a signal, `daemon_shutdown`, "Quit Crew and Stop
    /// Everything") exits 0 and stays down until Crew opens or the user logs
    /// in again. `RunAtLoad` is the login part.
    ///
    /// `ProcessType Interactive`: left unset, launchd throttles an agent's CPU
    /// and I/O, and this one runs the user's dev servers and builds.
    pub fn plist(&self) -> String {
        let arguments: String = self
            .arguments()
            .iter()
            .map(|arg| format!("\t\t<string>{}</string>\n", escape(arg)))
            .collect();
        let log = escape(&self.log().to_string_lossy());
        format!(
            r#"<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
	<key>Label</key>
	<string>{LABEL}</string>
	<key>ProgramArguments</key>
	<array>
{arguments}	</array>
	<key>RunAtLoad</key>
	<true/>
	<key>KeepAlive</key>
	<dict>
		<key>SuccessfulExit</key>
		<false/>
	</dict>
	<key>ProcessType</key>
	<string>Interactive</string>
	<key>StandardOutPath</key>
	<string>{log}</string>
	<key>StandardErrorPath</key>
	<string>{log}</string>
</dict>
</plist>
"#
        )
    }

    /// The program and data dir of a plist, ours or one `plutil` rewrote. Only
    /// `ProgramArguments` is read: it is what the app compares against its own
    /// bundle to tell a moved or replaced app.
    pub fn from_plist(xml: &str) -> Option<Agent> {
        let after_key = &xml[xml.find("<key>ProgramArguments</key>")? + "<key>ProgramArguments</key>".len()..];
        let body = after_key.trim_start().strip_prefix("<array>")?;
        let body = &body[..body.find("</array>")?];
        let mut arguments = Vec::new();
        let mut rest = body;
        while let Some(start) = rest.find("<string>") {
            let from = start + "<string>".len();
            let end = from + rest[from..].find("</string>")?;
            arguments.push(unescape(&rest[from..end]));
            rest = &rest[end + "</string>".len()..];
        }
        let program = PathBuf::from(arguments.first()?);
        let data_dir = arguments.iter().position(|arg| arg == "--data-dir").and_then(|at| arguments.get(at + 1))?;
        Some(Agent { program, data_dir: PathBuf::from(data_dir) })
    }

    /// Whether this agent is the one for `dir`. Compared canonically too, so
    /// a path spelled through a symlink still counts.
    pub fn serves(&self, dir: &Path) -> bool {
        if self.data_dir == dir {
            return true;
        }
        match (std::fs::canonicalize(&self.data_dir), std::fs::canonicalize(dir)) {
            (Ok(a), Ok(b)) => a == b,
            _ => false,
        }
    }
}

fn escape(text: &str) -> String {
    text.replace('&', "&amp;").replace('<', "&lt;").replace('>', "&gt;")
}

fn unescape(text: &str) -> String {
    text.replace("&lt;", "<")
        .replace("&gt;", ">")
        .replace("&quot;", "\"")
        .replace("&apos;", "'")
        .replace("&amp;", "&")
}

pub fn plist_path(home: &Path) -> PathBuf {
    home.join("Library/LaunchAgents").join(format!("{LABEL}.plist"))
}

/// The agent the plist on disk describes, if there is one and it reads.
pub fn installed(home: &Path) -> Option<Agent> {
    std::fs::read_to_string(plist_path(home)).ok().and_then(|xml| Agent::from_plist(&xml))
}

/// What `launchctl print` says about a loaded service.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Loaded {
    /// `running`, `not running`, …
    pub state: Option<String>,
    pub pid: Option<u32>,
}

/// The first `state =` and `pid =` lines are the service's own; nested
/// blocks further down have states of their own.
pub fn parse_print(out: &str) -> Loaded {
    let field = |name: &str| {
        out.lines()
            .map(str::trim)
            .find_map(|line| line.strip_prefix(name).and_then(|rest| rest.strip_prefix(" = ")))
            .map(str::to_string)
    };
    Loaded { state: field("state"), pid: field("pid").and_then(|pid| pid.parse().ok()) }
}

fn domain() -> String {
    format!("gui/{}", unsafe { libc::getuid() })
}

fn service() -> String {
    format!("{}/{LABEL}", domain())
}

fn launchctl(args: &[&str]) -> Result<String, String> {
    let out = Command::new(LAUNCHCTL).args(args).output().map_err(|e| format!("launchctl: {e}"))?;
    if out.status.success() {
        return Ok(String::from_utf8_lossy(&out.stdout).into_owned());
    }
    let said = String::from_utf8_lossy(&out.stderr);
    let said = if said.trim().is_empty() { String::from_utf8_lossy(&out.stdout) } else { said };
    Err(format!("launchctl {}: {}", args.join(" "), said.trim()))
}

/// `None` when launchd has not loaded the service (never bootstrapped, or
/// booted out).
pub fn loaded() -> Option<Loaded> {
    launchctl(&["print", &service()]).ok().map(|out| parse_print(&out))
}

/// Load the plist; with `RunAtLoad` that starts crewd. A bootout that just
/// returned may still be letting go of the label, so a refusal is retried
/// for a few seconds.
pub fn bootstrap(plist: &Path) -> Result<(), String> {
    let plist = plist.to_string_lossy();
    let deadline = Instant::now() + GONE_WAIT;
    loop {
        match launchctl(&["bootstrap", &domain(), &plist]) {
            Ok(_) => return Ok(()),
            Err(error) if Instant::now() >= deadline => return Err(error),
            Err(_) => std::thread::sleep(POLL),
        }
    }
}

/// Unload the service. launchd sends crewd SIGTERM, so it stops its
/// processes the way it always does; this waits until it is gone.
pub fn bootout() -> Result<(), String> {
    launchctl(&["bootout", &service()])?;
    let deadline = Instant::now() + GONE_WAIT;
    while loaded().is_some() {
        if Instant::now() >= deadline {
            return Err(format!("{LABEL} is still loaded {} s after bootout", GONE_WAIT.as_secs()));
        }
        std::thread::sleep(POLL);
    }
    Ok(())
}

/// Start it now; with `kill`, stop the running one first (SIGTERM, so as
/// gracefully as any other stop).
pub fn kickstart(kill: bool) -> Result<(), String> {
    let service = service();
    let mut args = vec!["kickstart"];
    if kill {
        args.push("-k");
    }
    args.push(&service);
    launchctl(&args).map(|_| ())
}

/// SIGTERM through launchd: a clean exit, so it stays down.
pub fn terminate() -> Result<(), String> {
    launchctl(&["kill", "SIGTERM", &service()]).map(|_| ())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn agent() -> Agent {
        Agent {
            program: "/Applications/Crew & Co.app/Contents/Resources/crewd".into(),
            data_dir: "/Users/me/Library/Application Support/Crew".into(),
        }
    }

    #[test]
    fn the_plist_runs_crewd_under_launchd_for_its_data_dir() {
        let xml = agent().plist();
        assert!(xml.contains(&format!("<string>{LABEL}</string>")), "{xml}");
        assert!(xml.contains("<string>/Applications/Crew &amp; Co.app/Contents/Resources/crewd</string>"), "{xml}");
        assert!(xml.contains("<string>--supervised-by</string>\n\t\t<string>launchd</string>"), "{xml}");
        assert!(xml.contains("<key>RunAtLoad</key>\n\t<true/>"), "{xml}");
        assert!(
            xml.contains("<key>KeepAlive</key>\n\t<dict>\n\t\t<key>SuccessfulExit</key>\n\t\t<false/>"),
            "a clean stop must stay down and a crash come back: {xml}"
        );
        assert!(xml.contains("<string>Interactive</string>"), "{xml}");
        assert_eq!(xml.matches("<string>/Users/me/Library/Application Support/Crew/crewd.log</string>").count(), 2, "{xml}");
    }

    #[test]
    fn a_plist_reads_back_as_the_agent_it_was_written_for() {
        assert_eq!(Agent::from_plist(&agent().plist()), Some(agent()));
    }

    /// `plutil -convert xml1` and hand edits indent differently and may put
    /// other keys first; the arguments are what matter.
    #[test]
    fn a_rewritten_plist_still_reads() {
        let xml = r#"<?xml version="1.0" encoding="UTF-8"?>
<plist version="1.0"><dict><key>KeepAlive</key><true/><key>ProgramArguments</key>
  <array>
      <string>/opt/crewd</string><string>--supervised-by</string><string>launchd</string>
      <string>--data-dir</string><string>/d/Crew &lt;dev&gt;</string>
  </array><key>Label</key><string>rogazth.crew.crewd</string></dict></plist>"#;
        assert_eq!(
            Agent::from_plist(xml),
            Some(Agent { program: "/opt/crewd".into(), data_dir: "/d/Crew <dev>".into() })
        );
        assert_eq!(Agent::from_plist("<plist><dict></dict></plist>"), None);
        assert_eq!(Agent::from_plist(r"<key>ProgramArguments</key><array><string>/opt/crewd</string></array>"), None, "no data dir");
    }

    #[test]
    fn the_label_is_the_apps_bundle_id() {
        let package: serde_json::Value = serde_json::from_str(include_str!("../../../package.json")).expect("package.json");
        let app_id = package["build"]["appId"].as_str().expect("build.appId");
        assert_eq!(LABEL, format!("{app_id}.crewd"));
    }

    #[test]
    fn launchctl_print_says_whether_it_runs_and_as_which_pid() {
        let running = "gui/501/rogazth.crew.crewd = {\n\tactive count = 1\n\tpath = /Users/me/Library/LaunchAgents/rogazth.crew.crewd.plist\n\ttype = LaunchAgent\n\tstate = running\n\n\tprogram = /Applications/Crew.app/Contents/Resources/crewd\n\tpid = 4242\n\tendpoints = {\n\t\tstate = active\n\t}\n}\n";
        assert_eq!(parse_print(running), Loaded { state: Some("running".into()), pid: Some(4242) });
        let stopped = "gui/501/rogazth.crew.crewd = {\n\tstate = not running\n\tlast exit code = 0\n}\n";
        assert_eq!(parse_print(stopped), Loaded { state: Some("not running".into()), pid: None });
    }

    #[test]
    fn an_agent_serves_its_own_data_dir_however_it_is_spelled() {
        let dir = std::env::temp_dir().join(format!("crew-la-{}", std::process::id()));
        std::fs::create_dir_all(dir.join("real")).expect("dir");
        let link = dir.join("link");
        let _ = std::fs::remove_file(&link);
        std::os::unix::fs::symlink(dir.join("real"), &link).expect("symlink");
        let agent = Agent { program: "/crewd".into(), data_dir: dir.join("real") };
        assert!(agent.serves(&dir.join("real")));
        assert!(agent.serves(&link));
        assert!(!agent.serves(&dir));
    }
}
