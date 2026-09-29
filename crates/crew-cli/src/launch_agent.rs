//! The LaunchAgent that runs crewd on its own, so the processes and agents it
//! holds outlive the window. The packaged app installs it by running `crew
//! daemon install` from its bundle, which makes this the one place the plist
//! is written and read back.
//!
//! The plist lives in the data dir, not in `~/Library/LaunchAgents`, so
//! launchd never loads it at login: crewd runs only once Crew (or `crew
//! daemon install|restart`) bootstraps and kickstarts it, and nothing brings
//! it back after a logout or a reboot until Crew opens again.

use std::path::{Path, PathBuf};
use std::process::Command;
use std::time::{Duration, Instant};

/// The app's bundle id (`build.appId` in package.json) plus `.crewd`: the
/// installed app's label. `electron/daemon-agent-plan.ts` names it too; a
/// test on each side holds both to package.json.
pub const LABEL: &str = "rogazth.crew.crewd";
/// In the data dir, beside daemon.json. crewd empties it when it grows too big.
pub const LOG: &str = "crewd.log";
/// Where the released app keeps its data. Every other data dir is a local or
/// dev build's.
const RELEASE_DIR: &str = "Library/Application Support/Crew";

/// The label for the crewd of `data_dir`. One label is one launchd service, so
/// a local build sharing the release's would boot the release's crewd out,
/// and every process it runs with it. The release keeps the label it always
/// had; any other data dir gets its own, from its name and a hash of its path.
/// `agentLabel` in `electron/daemon-agent-plan.ts` is the same function; a
/// test on each side holds them to the same answers.
pub fn label(data_dir: &Path) -> String {
    let path = data_dir.to_string_lossy();
    if path.trim_end_matches('/').ends_with(RELEASE_DIR) {
        return LABEL.to_string();
    }
    let name = data_dir.file_name().map(|name| name.to_string_lossy().to_lowercase()).unwrap_or_default();
    let slug: Vec<&str> = name.split(|c: char| !c.is_ascii_alphanumeric()).filter(|part| !part.is_empty()).collect();
    format!("{LABEL}.{}-{:08x}", slug.join("-"), fnv1a(path.as_bytes()))
}

/// 32-bit FNV-1a: short, and simple enough to write the same in TypeScript.
fn fnv1a(bytes: &[u8]) -> u32 {
    bytes.iter().fold(0x811c_9dc5_u32, |hash, byte| (hash ^ u32::from(*byte)).wrapping_mul(0x0100_0193))
}

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
    /// Everything") exits 0 and stays down until Crew starts it.
    ///
    /// No `RunAtLoad`. launchd.plist(5) says `SuccessfulExit` implies it
    /// anyway, which is why the plist is kept out of `~/Library/LaunchAgents`
    /// (see the module docs); every start still kickstarts after bootstrap
    /// rather than count on it.
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
        let label = label(&self.data_dir);
        format!(
            r#"<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
	<key>Label</key>
	<string>{label}</string>
	<key>ProgramArguments</key>
	<array>
{arguments}	</array>
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

pub fn plist_path(data_dir: &Path) -> PathBuf {
    data_dir.join(format!("{}.plist", label(data_dir)))
}

/// The agent the plist in `data_dir` describes, if there is one and it reads.
pub fn installed(data_dir: &Path) -> Option<Agent> {
    std::fs::read_to_string(plist_path(data_dir)).ok().and_then(|xml| Agent::from_plist(&xml))
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

fn service(label: &str) -> String {
    format!("{}/{label}", domain())
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
pub fn loaded(label: &str) -> Option<Loaded> {
    launchctl(&["print", &service(label)]).ok().map(|out| parse_print(&out))
}

/// Load the plist. A bootout that just returned may still be letting go of
/// the label, so a refusal is retried for a few seconds.
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
pub fn bootout(label: &str) -> Result<(), String> {
    launchctl(&["bootout", &service(label)])?;
    let deadline = Instant::now() + GONE_WAIT;
    while loaded(label).is_some() {
        if Instant::now() >= deadline {
            return Err(format!("{label} is still loaded {} s after bootout", GONE_WAIT.as_secs()));
        }
        std::thread::sleep(POLL);
    }
    Ok(())
}

/// Start it now; with `kill`, stop the running one first (SIGTERM, so as
/// gracefully as any other stop).
pub fn kickstart(label: &str, kill: bool) -> Result<(), String> {
    let service = service(label);
    let mut args = vec!["kickstart"];
    if kill {
        args.push("-k");
    }
    args.push(&service);
    launchctl(&args).map(|_| ())
}

/// Running, whatever the state: loaded first if it is not, then kickstarted.
/// With `kill`, a running one is stopped and started again; one that was
/// just loaded is left alone.
pub fn start(label: &str, plist: &Path, kill: bool) -> Result<(), String> {
    if loaded(label).is_none() {
        bootstrap(plist)?;
        return kickstart(label, false);
    }
    kickstart(label, kill)
}

/// SIGTERM through launchd: a clean exit, so it stays down.
pub fn terminate(label: &str) -> Result<(), String> {
    launchctl(&["kill", "SIGTERM", &service(label)]).map(|_| ())
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
        assert!(!xml.contains("RunAtLoad"), "crewd starts when Crew starts it, not at load: {xml}");
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

    /// Out of ~/Library/LaunchAgents, so login never loads it.
    #[test]
    fn the_plist_lives_in_the_data_dir() {
        let dir = Path::new("/Users/me/Library/Application Support/Crew");
        assert_eq!(plist_path(dir), dir.join(format!("{LABEL}.plist")));
    }

    /// Only the released app's data dir has the bundle id's label; a local or
    /// dev build's is another service, so installing it never boots the
    /// release's crewd out. The same answers are held in
    /// electron/daemon-agent-plan.test.ts.
    #[test]
    fn each_data_dir_has_a_label_of_its_own() {
        assert_eq!(label(Path::new("/Users/me/Library/Application Support/Crew")), LABEL);
        assert_eq!(label(Path::new("/Users/me/Library/Application Support/Crew Local")), "rogazth.crew.crewd.crew-local-e1e2ad52");
        assert_eq!(label(Path::new("/tmp/app data")), "rogazth.crew.crewd.app-data-bb444e4d");
        let dir = Path::new("/Users/me/Library/Application Support/Crew Dev");
        assert_eq!(plist_path(dir), dir.join(format!("{}.plist", label(dir))));
        assert!(Agent { program: "/crewd".into(), data_dir: dir.into() }.plist().contains(&format!("<string>{}</string>", label(dir))));
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
