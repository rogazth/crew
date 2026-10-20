//! Install, update, reinstall, uninstall and sign out of the agent CLIs, run
//! by the daemon of the machine that has them. A job is a few shell commands
//! run in the login shell's PATH, one process group each, whose output tail is
//! kept and pushed to the listener as it grows. One job per provider at a time.
//!
//! Nothing here decides for the user: the commands are built from the method
//! asked for (or the one the installed CLI came with) and a failure reports
//! the command that failed and the tail of its output as it was.

use std::collections::VecDeque;
use std::io::Read;
use std::os::unix::process::CommandExt;
use std::path::Path;
use std::process::{Command, Stdio};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant};

use crew_protocol::{ProviderJob, ProviderJobAction, ProviderJobMethod, ProviderJobPhase, ProviderJobStart};

use crate::provider_status::{self, strip_ansi, Spec, SPECS};
use crate::shell_path;
use crate::store::now_millis;

/// Lines of output a job keeps.
const TAIL_LINES: usize = 30;
const LINE_CHARS: usize = 400;
/// How often a chatty command's progress is pushed.
const EMIT_EVERY: Duration = Duration::from_millis(150);
/// How long a cancelled job's process group gets to leave before it is killed.
const KILL_AFTER: Duration = Duration::from_secs(3);
/// Finished jobs remembered for `list`.
const KEEP_FINISHED: usize = 20;

pub type Listener = Arc<dyn Fn(&ProviderJob) + Send + Sync>;

/// One shell command of a job and what to call it while it runs.
#[derive(Clone, Debug, PartialEq)]
pub struct Step {
    pub label: &'static str,
    pub command: String,
}

#[derive(Clone, Debug, PartialEq)]
pub struct Plan {
    pub method: Option<ProviderJobMethod>,
    pub steps: Vec<Step>,
}

fn spec(provider: &str) -> Result<&'static Spec, String> {
    SPECS.iter().find(|spec| spec.id == provider).ok_or_else(|| format!("unknown provider `{provider}`"))
}

/// What a first install uses when the caller does not choose.
fn default_install(provider: &str) -> ProviderJobMethod {
    match provider {
        "codex" => ProviderJobMethod::Npm,
        _ => ProviderJobMethod::Script,
    }
}

/// `(cask, name)` of the Homebrew package, where there is one.
fn brew_package(provider: &str) -> Option<(bool, &'static str)> {
    match provider {
        "claude" => Some((true, "claude-code")),
        "codex" => Some((false, "codex")),
        // opencode 2.x; the `opencode` formula is 1.x and conflicts with it.
        "opencode" => Some((false, "anomalyco/tap/opencode-v2")),
        _ => None,
    }
}

fn install_script(provider: &str) -> Option<&'static str> {
    match provider {
        "claude" => Some("curl -fsSL https://claude.ai/install.sh | bash"),
        "cursor" => Some("curl https://cursor.com/install -fsS | bash"),
        "opencode" => Some("curl -fsSL https://opencode.ai/install | bash"),
        _ => None,
    }
}

fn native_update(spec: &Spec) -> String {
    match spec.id {
        "opencode" => "opencode upgrade".into(),
        _ => format!("{} update", spec.binary),
    }
}

/// The ways this machine can install a CLI: those the CLI ships through whose
/// tool is on the PATH.
pub fn available_methods(provider: &str) -> Vec<ProviderJobMethod> {
    let Ok(spec) = spec(provider) else { return Vec::new() };
    let mut methods = Vec::new();
    if install_script(provider).is_some() && shell_path::resolve("curl").is_some() {
        methods.push(ProviderJobMethod::Script);
    }
    if spec.npm.is_some() && shell_path::resolve("npm").is_some() {
        methods.push(ProviderJobMethod::Npm);
    }
    if brew_package(provider).is_some() && shell_path::resolve("brew").is_some() {
        methods.push(ProviderJobMethod::Brew);
    }
    methods
}

/// How an installed binary got there, read from where it sits.
pub fn detect_method(path: &Path) -> ProviderJobMethod {
    let canonical = std::fs::canonicalize(path).unwrap_or_else(|_| path.to_path_buf());
    for text in [canonical.to_string_lossy(), path.to_string_lossy()] {
        if text.contains("/Cellar/") || text.contains("/Caskroom/") || text.starts_with("/opt/homebrew/") || text.starts_with("/home/linuxbrew/") {
            return ProviderJobMethod::Brew;
        }
        if text.contains("/node_modules/") {
            return ProviderJobMethod::Npm;
        }
    }
    ProviderJobMethod::Script
}

fn quote(text: &str) -> String {
    format!("'{}'", text.replace('\'', r"'\''"))
}

fn install_command(spec: &Spec, method: ProviderJobMethod) -> Result<String, String> {
    match method {
        ProviderJobMethod::Npm => {
            spec.npm.map(|pkg| format!("npm install -g {pkg}")).ok_or_else(|| format!("{} has no npm package", spec.binary))
        }
        ProviderJobMethod::Brew => brew_package(spec.id)
            .map(|(cask, name)| format!("brew install {}{name}", if cask { "--cask " } else { "" }))
            .ok_or_else(|| format!("{} is not in Homebrew", spec.binary)),
        ProviderJobMethod::Script => {
            install_script(spec.id).map(str::to_string).ok_or_else(|| format!("{} has no install script", spec.binary))
        }
        ProviderJobMethod::Native => Err("the CLI's own updater cannot install it".into()),
    }
}

fn update_command(spec: &Spec, method: ProviderJobMethod) -> Result<String, String> {
    match method {
        ProviderJobMethod::Native => Ok(native_update(spec)),
        ProviderJobMethod::Npm => {
            spec.npm.map(|pkg| format!("npm install -g {pkg}@latest")).ok_or_else(|| format!("{} has no npm package", spec.binary))
        }
        ProviderJobMethod::Brew => brew_package(spec.id)
            .map(|(cask, name)| format!("brew upgrade {}{name}", if cask { "--cask " } else { "" }))
            .ok_or_else(|| format!("{} is not in Homebrew", spec.binary)),
        ProviderJobMethod::Script => install_command(spec, method),
    }
}

/// `home` is where a script install may be removed from: a binary outside it
/// is left to the user.
fn uninstall_command(spec: &Spec, method: ProviderJobMethod, path: &Path, home: Option<&str>) -> Result<String, String> {
    match method {
        ProviderJobMethod::Npm => {
            spec.npm.map(|pkg| format!("npm rm -g {pkg}")).ok_or_else(|| format!("{} has no npm package", spec.binary))
        }
        ProviderJobMethod::Brew => brew_package(spec.id)
            .map(|(cask, name)| {
                let name = name.rsplit('/').next().unwrap_or(name);
                format!("brew uninstall {}{name}", if cask { "--cask " } else { "" })
            })
            .ok_or_else(|| format!("{} is not in Homebrew", spec.binary)),
        ProviderJobMethod::Script | ProviderJobMethod::Native => {
            if spec.id == "opencode" {
                return Ok("opencode uninstall --force".into());
            }
            let home = home.filter(|home| !home.is_empty());
            let inside = home.is_some_and(|home| path.starts_with(home));
            if !inside {
                return Err(format!("{} is installed outside your home folder; remove {} by hand", spec.binary, path.display()));
            }
            let data = match spec.id {
                "claude" => "$HOME/.local/share/claude",
                _ => "$HOME/.local/share/cursor-agent",
            };
            let extra = if spec.id == "cursor" { " \"$HOME/.local/bin/agent\"" } else { "" };
            Ok(format!("rm -f {}{extra} && rm -rf \"{data}\"", quote(&path.to_string_lossy())))
        }
    }
}

fn logout_command(spec: &Spec) -> Result<String, String> {
    match spec.id {
        "claude" => Ok("claude auth logout".into()),
        "codex" => Ok("codex logout".into()),
        "cursor" => Ok("cursor-agent logout".into()),
        // `opencode auth logout` opens an account picker; it needs a terminal.
        _ => Err("opencode asks which account to sign out of; run `opencode auth logout` in a terminal".into()),
    }
}

/// The commands for `action`. `installed` is the resolved binary, when there is one.
pub fn plan(
    provider: &str,
    action: ProviderJobAction,
    method: Option<ProviderJobMethod>,
    installed: Option<&Path>,
    home: Option<&str>,
) -> Result<Plan, String> {
    let spec = spec(provider)?;
    if action == ProviderJobAction::Install {
        let method = method.unwrap_or_else(|| default_install(provider));
        let command = install_command(spec, method)?;
        return Ok(Plan { method: Some(method), steps: vec![Step { label: "Installing", command }] });
    }
    let Some(path) = installed else { return Err(format!("{} is not installed", spec.binary)) };
    // How it got there, unless the caller says; never the CLI's own updater for the rest.
    let from_path = || match detect_method(path) {
        ProviderJobMethod::Native => default_install(provider),
        found => found,
    };
    match action {
        ProviderJobAction::Logout => {
            Ok(Plan { method: None, steps: vec![Step { label: "Signing out", command: logout_command(spec)? }] })
        }
        ProviderJobAction::Update => {
            let method = method.unwrap_or(ProviderJobMethod::Native);
            Ok(Plan { method: Some(method), steps: vec![Step { label: "Updating", command: update_command(spec, method)? }] })
        }
        ProviderJobAction::Uninstall => {
            let method = method.unwrap_or_else(from_path);
            let command = uninstall_command(spec, method, path, home)?;
            Ok(Plan { method: Some(method), steps: vec![Step { label: "Uninstalling", command }] })
        }
        ProviderJobAction::Reinstall => {
            let method = match method.unwrap_or_else(from_path) {
                ProviderJobMethod::Native => default_install(provider),
                chosen => chosen,
            };
            let remove = uninstall_command(spec, method, path, home)?;
            let add = install_command(spec, method)?;
            Ok(Plan {
                method: Some(method),
                steps: vec![Step { label: "Uninstalling", command: remove }, Step { label: "Installing", command: add }],
            })
        }
        ProviderJobAction::Install => unreachable!("handled above"),
    }
}

/// The last lines a command printed. A carriage return starts the line over
/// (progress bars), a newline ends it.
#[derive(Default)]
pub struct Tail {
    done: VecDeque<String>,
    current: Vec<u8>,
    returned: bool,
}

impl Tail {
    pub fn push(&mut self, bytes: &[u8]) {
        for &byte in bytes {
            match byte {
                b'\r' => self.returned = true,
                b'\n' => {
                    self.commit();
                    self.returned = false;
                }
                _ => {
                    if self.returned {
                        self.current.clear();
                        self.returned = false;
                    }
                    self.current.push(byte);
                }
            }
        }
    }

    fn commit(&mut self) {
        let line = Self::clean(&std::mem::take(&mut self.current));
        if line.is_empty() {
            return;
        }
        if self.done.len() == TAIL_LINES {
            self.done.pop_front();
        }
        self.done.push_back(line);
    }

    fn clean(bytes: &[u8]) -> String {
        let text = strip_ansi(&String::from_utf8_lossy(bytes));
        let text = text.trim();
        match text.char_indices().nth(LINE_CHARS) {
            Some((end, _)) => format!("{}...", &text[..end]),
            None => text.to_string(),
        }
    }

    /// The finished lines and the one being written, oldest first.
    pub fn lines(&self) -> Vec<String> {
        let mut lines: Vec<String> = self.done.iter().cloned().collect();
        let current = Self::clean(&self.current);
        if !current.is_empty() {
            lines.push(current);
            if lines.len() > TAIL_LINES {
                lines.remove(0);
            }
        }
        lines
    }
}

struct Entry {
    job: ProviderJob,
    pid: Option<i32>,
    cancelled: bool,
}

#[derive(Default)]
struct State {
    jobs: Vec<Entry>,
}

#[derive(Clone, Default)]
pub struct ProviderJobs {
    state: Arc<Mutex<State>>,
    listener: Arc<Mutex<Option<Listener>>>,
}

impl ProviderJobs {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn set_listener(&self, listener: Listener) {
        *self.listener.lock().unwrap_or_else(|e| e.into_inner()) = Some(listener);
    }

    fn emit(&self, job: &ProviderJob) {
        let listener = self.listener.lock().unwrap_or_else(|e| e.into_inner()).clone();
        if let Some(listener) = listener {
            listener(job);
        }
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, State> {
        self.state.lock().unwrap_or_else(|e| e.into_inner())
    }

    /// Running jobs and the last few finished, oldest first.
    pub fn list(&self) -> Vec<ProviderJob> {
        self.lock().jobs.iter().map(|entry| entry.job.clone()).collect()
    }

    pub fn start(&self, request: ProviderJobStart) -> Result<ProviderJob, String> {
        let spec = spec(&request.provider)?;
        let installed = if spec.binary == "opencode" { shell_path::resolve_opencode().ok() } else { shell_path::resolve(spec.binary) };
        let home = shell_path::home_dir();
        let plan = plan(&request.provider, request.action, request.method, installed.as_deref(), home.as_deref())?;
        self.start_plan(&request.provider, request.action, plan)
    }

    /// Registers the job and runs `plan` on a thread of its own.
    pub fn start_plan(&self, provider: &str, action: ProviderJobAction, plan: Plan) -> Result<ProviderJob, String> {
        let job = {
            let mut state = self.lock();
            if state.jobs.iter().any(|entry| entry.job.provider == provider && entry.job.phase == ProviderJobPhase::Running) {
                return Err(format!("a job is already running for {provider}"));
            }
            let job = ProviderJob {
                id: uuid::Uuid::new_v4().to_string(),
                provider: provider.into(),
                action,
                method: plan.method,
                phase: ProviderJobPhase::Running,
                step: plan.steps.first().map(|step| step.label.to_string()),
                command: plan.steps.first().map(|step| step.command.clone()),
                last_lines: Vec::new(),
                error: None,
                started_at: now_millis(),
            };
            state.jobs.push(Entry { job: job.clone(), pid: None, cancelled: false });
            let finished = state.jobs.iter().filter(|entry| entry.job.phase != ProviderJobPhase::Running).count();
            for _ in KEEP_FINISHED..finished {
                if let Some(at) = state.jobs.iter().position(|entry| entry.job.phase != ProviderJobPhase::Running) {
                    state.jobs.remove(at);
                }
            }
            job
        };
        self.emit(&job);
        let host = self.clone();
        let id = job.id.clone();
        thread::spawn(move || host.run(&id, plan));
        Ok(job)
    }

    /// Ends a running job: its process group is told to stop, then killed.
    pub fn cancel(&self, id: &str) -> Result<(), String> {
        let pid = {
            let mut state = self.lock();
            let entry = state.jobs.iter_mut().find(|entry| entry.job.id == id).ok_or_else(|| format!("no job {id}"))?;
            if entry.job.phase != ProviderJobPhase::Running {
                return Ok(());
            }
            entry.cancelled = true;
            entry.pid
        };
        if let Some(pid) = pid {
            unsafe { libc::kill(-pid, libc::SIGTERM) };
            let host = self.clone();
            thread::spawn(move || {
                thread::sleep(KILL_AFTER);
                let still = host.lock().jobs.iter().any(|entry| entry.pid == Some(pid));
                if still {
                    unsafe { libc::kill(-pid, libc::SIGKILL) };
                }
            });
        }
        Ok(())
    }

    /// Changes the job and tells the listener, with the lock released.
    fn update(&self, id: &str, change: impl FnOnce(&mut Entry)) {
        let job = {
            let mut state = self.lock();
            let Some(entry) = state.jobs.iter_mut().find(|entry| entry.job.id == id) else { return };
            change(entry);
            entry.job.clone()
        };
        self.emit(&job);
    }

    fn cancelled(&self, id: &str) -> bool {
        self.lock().jobs.iter().any(|entry| entry.job.id == id && entry.cancelled)
    }

    fn run(&self, id: &str, plan: Plan) {
        let mut lines: Vec<String> = Vec::new();
        for step in &plan.steps {
            if self.cancelled(id) {
                break;
            }
            self.update(id, |entry| {
                entry.job.step = Some(step.label.to_string());
                entry.job.command = Some(step.command.clone());
            });
            let outcome = self.run_step(id, step, &mut lines);
            if self.cancelled(id) {
                break;
            }
            if let Err(why) = outcome {
                self.finish(id, ProviderJobPhase::Failed, Some(why), lines);
                return;
            }
        }
        let phase = if self.cancelled(id) { ProviderJobPhase::Cancelled } else { ProviderJobPhase::Done };
        self.finish(id, phase, None, lines);
    }

    fn finish(&self, id: &str, phase: ProviderJobPhase, error: Option<String>, lines: Vec<String>) {
        // What is installed or who is signed in may have changed, whichever way it ended.
        provider_status::invalidate();
        self.update(id, |entry| {
            entry.pid = None;
            entry.job.phase = phase;
            entry.job.error = error;
            entry.job.last_lines = lines;
            if phase == ProviderJobPhase::Done {
                entry.job.step = None;
            }
        });
    }

    /// One command to its end; `lines` is its output tail afterwards.
    fn run_step(&self, id: &str, step: &Step, lines: &mut Vec<String>) -> Result<(), String> {
        let shell = if Path::new("/bin/bash").exists() { "/bin/bash" } else { "/bin/sh" };
        // stderr into stdout, and a failed `curl` in a pipe fails the pipe.
        let script = format!("exec 2>&1; {}{}", if shell == "/bin/bash" { "set -o pipefail; " } else { "" }, step.command);
        let mut child = Command::new(shell)
            .arg("-c")
            .arg(script)
            .env("PATH", shell_path::joined())
            .env("NO_COLOR", "1")
            .env("TERM", "dumb")
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .process_group(0)
            .spawn()
            .map_err(|why| format!("could not start `{}`: {why}", step.command))?;
        let pid = child.id() as i32;
        self.update(id, |entry| entry.pid = Some(pid));
        let mut tail = Tail::default();
        if let Some(mut out) = child.stdout.take() {
            let mut buffer = [0u8; 4096];
            let mut last = Instant::now();
            while let Ok(read) = out.read(&mut buffer) {
                if read == 0 {
                    break;
                }
                tail.push(&buffer[..read]);
                if last.elapsed() >= EMIT_EVERY {
                    last = Instant::now();
                    let shown = tail.lines();
                    self.update(id, |entry| entry.job.last_lines = shown);
                }
            }
        }
        let status = child.wait().map_err(|why| format!("`{}` did not finish: {why}", step.command))?;
        *lines = tail.lines();
        self.update(id, |entry| {
            entry.pid = None;
            entry.job.last_lines = lines.clone();
        });
        if status.success() {
            return Ok(());
        }
        let how = match (status.code(), std::os::unix::process::ExitStatusExt::signal(&status)) {
            (Some(code), _) => format!("exited with status {code}"),
            (None, Some(signal)) => format!("was stopped by signal {signal}"),
            _ => "failed".into(),
        };
        Err(format!("`{}` {how}", step.command))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn start(provider: &str, action: ProviderJobAction, method: Option<ProviderJobMethod>, path: Option<&str>) -> Result<Plan, String> {
        plan(provider, action, method, path.map(Path::new), Some("/Users/me"))
    }
    fn commands(plan: &Plan) -> Vec<&str> {
        plan.steps.iter().map(|step| step.command.as_str()).collect()
    }

    #[test]
    fn a_first_install_uses_the_vendor_script_or_npm_for_codex() {
        use ProviderJobAction::Install;
        let claude = start("claude", Install, None, None).unwrap();
        assert_eq!(commands(&claude), ["curl -fsSL https://claude.ai/install.sh | bash"]);
        assert_eq!(commands(&start("cursor", Install, None, None).unwrap()), ["curl https://cursor.com/install -fsS | bash"]);
        assert_eq!(commands(&start("opencode", Install, None, None).unwrap()), ["curl -fsSL https://opencode.ai/install | bash"]);
        assert_eq!(commands(&start("codex", Install, None, None).unwrap()), ["npm install -g @openai/codex"]);
    }

    #[test]
    fn install_follows_the_method_asked_for() {
        use ProviderJobAction::Install;
        use ProviderJobMethod::*;
        assert_eq!(commands(&start("claude", Install, Some(Npm), None).unwrap()), ["npm install -g @anthropic-ai/claude-code"]);
        assert_eq!(commands(&start("opencode", Install, Some(Npm), None).unwrap()), ["npm install -g @opencode/cli"]);
        assert_eq!(commands(&start("claude", Install, Some(Brew), None).unwrap()), ["brew install --cask claude-code"]);
        assert_eq!(commands(&start("opencode", Install, Some(Brew), None).unwrap()), ["brew install anomalyco/tap/opencode-v2"]);
        assert!(start("cursor", Install, Some(Npm), None).is_err());
        assert!(start("cursor", Install, Some(Brew), None).is_err());
        assert!(start("codex", Install, Some(Script), None).is_err());
        assert!(start("codex", Install, Some(Native), None).is_err());
        assert!(start("nope", Install, None, None).is_err());
    }

    #[test]
    fn an_update_runs_the_cli_own_updater_unless_told_otherwise() {
        use ProviderJobAction::Update;
        use ProviderJobMethod::*;
        let at = Some("/usr/local/bin/x");
        assert_eq!(commands(&start("claude", Update, None, at).unwrap()), ["claude update"]);
        assert_eq!(commands(&start("codex", Update, None, at).unwrap()), ["codex update"]);
        assert_eq!(commands(&start("cursor", Update, None, at).unwrap()), ["cursor-agent update"]);
        assert_eq!(commands(&start("opencode", Update, None, at).unwrap()), ["opencode upgrade"]);
        assert_eq!(commands(&start("codex", Update, Some(Npm), at).unwrap()), ["npm install -g @openai/codex@latest"]);
        assert_eq!(commands(&start("codex", Update, Some(Brew), at).unwrap()), ["brew upgrade codex"]);
        assert_eq!(commands(&start("claude", Update, Some(Brew), at).unwrap()), ["brew upgrade --cask claude-code"]);
        assert_eq!(commands(&start("cursor", Update, Some(Script), at).unwrap()), ["curl https://cursor.com/install -fsS | bash"]);
        assert_eq!(start("claude", Update, None, None).unwrap_err(), "claude is not installed");
    }

    #[test]
    fn uninstall_and_reinstall_follow_how_the_binary_got_there() {
        use ProviderJobAction::{Reinstall, Uninstall};
        let brew = Some("/opt/homebrew/bin/opencode");
        assert_eq!(commands(&start("opencode", Uninstall, None, brew).unwrap()), ["brew uninstall opencode-v2"]);
        let cask = Some("/opt/homebrew/bin/claude");
        assert_eq!(commands(&start("claude", Uninstall, None, cask).unwrap()), ["brew uninstall --cask claude-code"]);
        let npm = Some("/Users/me/.nvm/versions/node/v22/lib/node_modules/@openai/codex/bin/codex");
        assert_eq!(commands(&start("codex", Uninstall, None, npm).unwrap()), ["npm rm -g @openai/codex"]);
        let script = Some("/Users/me/.local/bin/claude");
        assert_eq!(
            commands(&start("claude", Uninstall, None, script).unwrap()),
            ["rm -f '/Users/me/.local/bin/claude' && rm -rf \"$HOME/.local/share/claude\""]
        );
        assert_eq!(
            commands(&start("cursor", Uninstall, None, Some("/Users/me/.local/bin/cursor-agent")).unwrap()),
            ["rm -f '/Users/me/.local/bin/cursor-agent' \"$HOME/.local/bin/agent\" && rm -rf \"$HOME/.local/share/cursor-agent\""]
        );
        assert_eq!(commands(&start("opencode", Uninstall, Some(ProviderJobMethod::Script), script).unwrap()), ["opencode uninstall --force"]);
        let again = start("claude", Reinstall, None, script).unwrap();
        assert_eq!(again.method, Some(ProviderJobMethod::Script));
        assert_eq!(
            commands(&again),
            ["rm -f '/Users/me/.local/bin/claude' && rm -rf \"$HOME/.local/share/claude\"", "curl -fsSL https://claude.ai/install.sh | bash"]
        );
        assert_eq!(again.steps.iter().map(|s| s.label).collect::<Vec<_>>(), ["Uninstalling", "Installing"]);
        let swap = start("codex", Reinstall, Some(ProviderJobMethod::Brew), npm).unwrap();
        assert_eq!(commands(&swap), ["brew uninstall codex", "brew install codex"]);
    }

    #[test]
    fn a_script_install_outside_home_is_left_alone_and_a_path_is_quoted() {
        use ProviderJobAction::Uninstall;
        let err = start("claude", Uninstall, Some(ProviderJobMethod::Script), Some("/usr/local/bin/claude")).unwrap_err();
        assert!(err.contains("outside your home folder") && err.contains("/usr/local/bin/claude"), "{err}");
        let odd = start("claude", Uninstall, Some(ProviderJobMethod::Script), Some("/Users/me/it's/claude")).unwrap();
        assert!(odd.steps[0].command.starts_with(r"rm -f '/Users/me/it'\''s/claude'"));
    }

    #[test]
    fn sign_out_runs_each_cli_logout_and_opencode_needs_a_terminal() {
        use ProviderJobAction::Logout;
        let at = Some("/x/bin/y");
        assert_eq!(commands(&start("claude", Logout, None, at).unwrap()), ["claude auth logout"]);
        assert_eq!(commands(&start("codex", Logout, None, at).unwrap()), ["codex logout"]);
        assert_eq!(commands(&start("cursor", Logout, None, at).unwrap()), ["cursor-agent logout"]);
        assert!(start("opencode", Logout, None, at).unwrap_err().contains("opencode auth logout"));
    }

    #[test]
    fn the_method_is_read_from_where_the_binary_sits() {
        assert_eq!(detect_method(Path::new("/opt/homebrew/bin/codex")), ProviderJobMethod::Brew);
        assert_eq!(detect_method(Path::new("/usr/local/Cellar/codex/1/bin/codex")), ProviderJobMethod::Brew);
        assert_eq!(detect_method(Path::new("/x/lib/node_modules/@openai/codex/bin/codex")), ProviderJobMethod::Npm);
        assert_eq!(detect_method(Path::new("/Users/me/.local/bin/claude")), ProviderJobMethod::Script);
    }

    #[test]
    fn the_tail_keeps_the_last_lines_and_lets_a_progress_bar_overwrite_itself() {
        let mut tail = Tail::default();
        tail.push(b"one\ntw");
        tail.push(b"o\r\nthree\n\n   \n");
        assert_eq!(tail.lines(), ["one", "two", "three"]);
        tail.push(b"10%\r50%\r100%");
        assert_eq!(tail.lines(), ["one", "two", "three", "100%"]);
        tail.push(b"\n");
        assert_eq!(tail.lines().last().map(String::as_str), Some("100%"));

        let mut many = Tail::default();
        for n in 0..100 {
            many.push(format!("line {n}\n").as_bytes());
        }
        let lines = many.lines();
        assert_eq!((lines.len(), lines[0].as_str(), lines[TAIL_LINES - 1].as_str()), (TAIL_LINES, "line 70", "line 99"));
        many.push(b"partial");
        assert_eq!(many.lines().len(), TAIL_LINES);
        assert_eq!(many.lines().last().map(String::as_str), Some("partial"));
    }

    #[test]
    fn the_tail_strips_colors_and_cuts_long_lines() {
        let mut tail = Tail::default();
        tail.push(b"\x1b[32mgreen\x1b[0m\n");
        tail.push("é".repeat(LINE_CHARS + 50).as_bytes());
        tail.push(b"\n");
        let lines = tail.lines();
        assert_eq!(lines[0], "green");
        assert_eq!(lines[1].chars().count(), LINE_CHARS + 3);
        assert!(lines[1].ends_with("..."));
    }

    fn wait_for(jobs: &ProviderJobs, id: &str) -> ProviderJob {
        let deadline = Instant::now() + Duration::from_secs(20);
        loop {
            let job = jobs.list().into_iter().find(|job| job.id == id).expect("job");
            if job.phase != ProviderJobPhase::Running || Instant::now() > deadline {
                return job;
            }
            thread::sleep(Duration::from_millis(20));
        }
    }

    fn plan_of(commands: &[(&'static str, &str)]) -> Plan {
        Plan { method: None, steps: commands.iter().map(|(label, command)| Step { label, command: command.to_string() }).collect() }
    }

    #[test]
    fn a_job_runs_its_steps_keeps_the_output_and_reports_a_failure_with_its_command() {
        let jobs = ProviderJobs::new();
        let seen: Arc<Mutex<Vec<ProviderJobPhase>>> = Arc::default();
        let log = seen.clone();
        jobs.set_listener(Arc::new(move |job| log.lock().unwrap().push(job.phase)));

        let ok = jobs.start_plan("claude", ProviderJobAction::Reinstall, plan_of(&[("Uninstalling", "echo gone"), ("Installing", "echo fresh >&2")])).unwrap();
        assert_eq!(ok.phase, ProviderJobPhase::Running);
        let done = wait_for(&jobs, &ok.id);
        assert_eq!((done.phase, done.error.clone(), done.step.clone()), (ProviderJobPhase::Done, None, None));
        assert_eq!(done.last_lines, ["fresh"]);
        assert_eq!(seen.lock().unwrap().last(), Some(&ProviderJobPhase::Done));

        let bad = jobs.start_plan("claude", ProviderJobAction::Update, plan_of(&[("Updating", "echo no network; exit 3"), ("Installing", "echo never")])).unwrap();
        let failed = wait_for(&jobs, &bad.id);
        assert_eq!(failed.phase, ProviderJobPhase::Failed);
        assert_eq!(failed.error.as_deref(), Some("`echo no network; exit 3` exited with status 3"));
        assert_eq!((failed.last_lines.clone(), failed.step.as_deref()), (vec!["no network".to_string()], Some("Updating")));
    }

    #[test]
    fn a_pipe_that_fails_fails_the_job() {
        let jobs = ProviderJobs::new();
        let job = jobs.start_plan("codex", ProviderJobAction::Install, plan_of(&[("Installing", "false | cat")])).unwrap();
        assert_eq!(wait_for(&jobs, &job.id).phase, ProviderJobPhase::Failed);
    }

    #[test]
    fn one_job_per_provider_and_cancel_ends_the_process_group() {
        let jobs = ProviderJobs::new();
        let first = jobs.start_plan("cursor", ProviderJobAction::Update, plan_of(&[("Updating", "echo started; sleep 30")])).unwrap();
        let err = jobs.start_plan("cursor", ProviderJobAction::Update, plan_of(&[("Updating", "echo no")])).unwrap_err();
        assert!(err.contains("already running"), "{err}");
        // Another provider is not blocked.
        let other = jobs.start_plan("opencode", ProviderJobAction::Update, plan_of(&[("Updating", "true")])).unwrap();
        assert_eq!(wait_for(&jobs, &other.id).phase, ProviderJobPhase::Done);
        // Let the first one print, then stop it.
        let deadline = Instant::now() + Duration::from_secs(10);
        while jobs.list().iter().find(|job| job.id == first.id).is_some_and(|job| job.last_lines.is_empty()) && Instant::now() < deadline {
            thread::sleep(Duration::from_millis(20));
        }
        let started = Instant::now();
        jobs.cancel(&first.id).unwrap();
        let stopped = wait_for(&jobs, &first.id);
        assert_eq!((stopped.phase, stopped.error), (ProviderJobPhase::Cancelled, None));
        assert!(started.elapsed() < Duration::from_secs(10));
        assert!(jobs.cancel("missing").is_err());
        // It can run again.
        assert!(jobs.start_plan("cursor", ProviderJobAction::Update, plan_of(&[("Updating", "true")])).is_ok());
    }
}
