use std::collections::HashMap;
use std::io::{BufRead, BufReader, Read, Write};
use std::path::PathBuf;
use std::process::{ChildStdin, Command, Stdio};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{mpsc, Arc, Mutex};
use std::thread;
use std::time::Duration;

use serde::Serialize;

use crate::shell_path;

const STDOUT_EVENT: &str = "agent-stdout";
const STDERR_EVENT: &str = "agent-stderr";
const KILL_ESCALATE: Duration = Duration::from_secs(2);
/// How long the emitter waits for the next line before sending what it has.
const COALESCE: Duration = Duration::from_millis(8);
const SPAWN_CANCELLED: &str = "Agent start was cancelled";
/// Caps one IPC payload; a runaway `cat` of a big file still streams in pieces.
const MAX_BATCH: usize = 256;
const MAX_BATCH_BYTES: usize = 64 * 1024;

pub trait AgentEvents: Send + Sync {
    fn lines(&self, event: &str, session_id: &str, lines: Vec<String>);
    fn exit(&self, session_id: &str, code: Option<i32>, pid: u32);
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentBinary {
    pub path: String,
}

struct LiveChild {
    /// `None` once closed: CLIs that read the prompt from stdin need the EOF.
    stdin: Mutex<Option<ChildStdin>>,
    pid: u32,
    /// Set once `wait` reaped it. The pid may belong to someone else after that.
    exited: AtomicBool,
}

struct Inner {
    children: HashMap<String, Arc<LiveChild>>,
    epochs: HashMap<String, u64>,
}

struct Shared {
    inner: Mutex<Inner>,
    kill_all_gen: AtomicU64,
    events: Mutex<Option<Arc<dyn AgentEvents>>>,
}

#[derive(Clone)]
pub struct AgentHost {
    shared: Arc<Shared>,
}

impl Default for AgentHost {
    fn default() -> Self {
        Self::new()
    }
}

impl AgentHost {
    pub fn new() -> Self {
        Self {
            shared: Arc::new(Shared {
                inner: Mutex::new(Inner {
                    children: HashMap::new(),
                    epochs: HashMap::new(),
                }),
                kill_all_gen: AtomicU64::new(0),
                events: Mutex::new(None),
            }),
        }
    }

    pub fn set_events(&self, events: Arc<dyn AgentEvents>) {
        *self.shared.events.lock().unwrap_or_else(|e| e.into_inner()) = Some(events);
    }

    fn events(&self) -> Option<Arc<dyn AgentEvents>> {
        self.shared.events.lock().unwrap_or_else(|e| e.into_inner()).clone()
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, Inner> {
        self.shared.inner.lock().unwrap_or_else(|e| e.into_inner())
    }

    fn get(&self, session_id: &str) -> Option<Arc<LiveChild>> {
        self.lock().children.get(session_id).cloned()
    }

    fn begin_spawn(&self, session_id: &str) -> (u64, u64, Option<Arc<LiveChild>>) {
        let mut inner = self.lock();
        let kill_all = self.shared.kill_all_gen.load(Ordering::SeqCst);
        let epoch = inner.epochs.entry(session_id.to_string()).or_insert(0);
        *epoch += 1;
        let epoch = *epoch;
        let prev = inner.children.remove(session_id);
        (epoch, kill_all, prev)
    }

    fn install_spawn(
        &self,
        session_id: String,
        epoch: u64,
        kill_all: u64,
        live: Arc<LiveChild>,
    ) -> Option<Arc<LiveChild>> {
        let mut inner = self.lock();
        if self.shared.kill_all_gen.load(Ordering::SeqCst) != kill_all {
            return Some(live);
        }
        if inner.epochs.get(&session_id) != Some(&epoch) {
            return Some(live);
        }
        if let Some(prev) = inner.children.insert(session_id, live) {
            let _ = terminate(&prev);
        }
        None
    }

    fn kill_session(&self, session_id: &str) -> Option<Arc<LiveChild>> {
        let mut inner = self.lock();
        *inner.epochs.entry(session_id.to_string()).or_insert(0) += 1;
        inner.children.remove(session_id)
    }

    fn remove_if_pid(&self, session_id: &str, pid: u32) -> Option<Arc<LiveChild>> {
        let mut inner = self.lock();
        if inner.children.get(session_id).map(|live| live.pid) != Some(pid) {
            return None;
        }
        inner.children.remove(session_id)
    }

    fn current_epoch(&self, session_id: &str, epoch: u64) -> bool {
        self.lock().epochs.get(session_id) == Some(&epoch)
    }

    pub fn running(&self) -> Vec<String> {
        self.lock().children.keys().cloned().collect()
    }

    /// The webview reloaded without the app restarting: every child is now an
    /// orphan nobody parses, so the runtime clears the slate before it starts.
    pub fn kill_all(&self) {
        let kids: Vec<Arc<LiveChild>> = {
            let mut inner = self.lock();
            self.shared.kill_all_gen.fetch_add(1, Ordering::SeqCst);
            inner.children.drain().map(|(_, child)| child).collect()
        };
        let waits: Vec<_> = kids.iter().filter_map(terminate).collect();
        for wait in waits {
            let _ = wait.join();
        }
    }

    /// Resolve `claude` the way a terminal would. Finder-launched apps inherit
    /// launchd's PATH, so Homebrew / `~/.local/bin` would otherwise look missing.
    pub fn resolve_claude() -> Result<AgentBinary, String> {
        shell_path::resolve("claude")
            .map(|path| AgentBinary {
                path: path.to_string_lossy().into_owned(),
            })
            .ok_or_else(|| {
                "Claude Code CLI not found. Install it from https://claude.com/product/claude-code and run `claude auth login`."
                    .into()
            })
    }

    pub fn resolve(name: &str) -> Result<AgentBinary, String> {
        if name.is_empty() || name.contains('/') {
            return Err(format!("Not a binary name: {name}"));
        }
        shell_path::resolve(name)
            .map(|path| AgentBinary {
                path: path.to_string_lossy().into_owned(),
            })
            .ok_or_else(|| format!("`{name}` was not found on your PATH."))
    }

    /// The names found on the search path. A filesystem probe, so it is cheap
    /// enough to ask again and pick up a CLI installed mid-session.
    pub fn installed(names: Vec<String>) -> Vec<String> {
        names
            .into_iter()
            .filter(|name| !name.contains('/') && shell_path::resolve(name).is_some())
            .collect()
    }

    pub fn spawn(
        &self,
        session_id: String,
        command: String,
        args: Vec<String>,
        cwd: String,
        env: Option<HashMap<String, String>>,
    ) -> Result<u32, String> {
        let workdir = PathBuf::from(&cwd);
        if !workdir.is_dir() {
            return Err(format!("Working directory does not exist: {cwd}"));
        }

        let (epoch, kill_all, prev) = self.begin_spawn(&session_id);
        if let Some(prev) = prev {
            let _ = terminate(&prev);
        }

        let mut cmd = Command::new(&command);
        cmd.args(&args)
            .envs(env.unwrap_or_default())
            .current_dir(&workdir)
            // current_dir moves the process, but PWD is inherited from us, and
            // tools that trust PWD over getcwd() then write into the daemon's
            // directory instead of the agent's.
            .env("PWD", &workdir)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        prepare_child(&mut cmd);

        let mut child = cmd
            .spawn()
            .map_err(|e| format!("Failed to start {command}: {e}"))?;
        let pid = child.id();

        let (stdin, stdout, stderr) = match (child.stdin.take(), child.stdout.take(), child.stderr.take()) {
            (Some(stdin), Some(stdout), Some(stderr)) => (stdin, stdout, stderr),
            _ => {
                kill_group(pid);
                let _ = child.wait();
                return Err("Failed to open the agent's pipes".into());
            }
        };

        let live = Arc::new(LiveChild {
            stdin: Mutex::new(Some(stdin)),
            pid,
            exited: AtomicBool::new(false),
        });
        if let Some(rejected) = self.install_spawn(session_id.clone(), epoch, kill_all, live.clone()) {
            let _ = terminate(&rejected);
            thread::spawn(move || {
                let _ = child.wait();
                rejected.exited.store(true, Ordering::Release);
            });
            return Err(SPAWN_CANCELLED.to_string());
        }

        let gate = Arc::new(Gate {
            session_id: session_id.clone(),
            epoch,
        });
        let (pumps_done, pumps) = mpsc::channel();
        pump(self.clone(), STDOUT_EVENT, gate.clone(), stdout, pumps_done.clone());
        pump(self.clone(), STDERR_EVENT, gate, stderr, pumps_done);

        let wait_host = self.clone();
        let wait_id = session_id;
        thread::spawn(move || {
            let code = child.wait().ok().and_then(|status| status.code());
            live.exited.store(true, Ordering::Release);
            let _ = pumps.recv();
            let _ = pumps.recv();
            // Only the child that still owns the slot may report; a replaced one
            // would otherwise end the turn of its successor.
            if wait_host.remove_if_pid(&wait_id, pid).is_some() {
                if let Some(events) = wait_host.events() {
                    events.exit(&wait_id, code, pid);
                }
            }
        });

        Ok(pid)
    }

    pub fn write(&self, session_id: &str, line: &str) -> Result<(), String> {
        let live = self
            .get(session_id)
            .ok_or_else(|| "Agent process is not running".to_string())?;
        let mut slot = live.stdin.lock().unwrap_or_else(|e| e.into_inner());
        let stdin = slot
            .as_mut()
            .ok_or_else(|| "Agent stdin is closed".to_string())?;
        stdin
            .write_all(line.as_bytes())
            .and_then(|_| stdin.write_all(b"\n"))
            .and_then(|_| stdin.flush())
            .map_err(|e| format!("Failed to write to agent: {e}"))
    }

    pub fn close_stdin(&self, session_id: &str) {
        if let Some(live) = self.get(session_id) {
            live.stdin.lock().unwrap_or_else(|e| e.into_inner()).take();
        }
    }

    pub fn kill(&self, session_id: &str) {
        if let Some(live) = self.kill_session(session_id) {
            let _ = terminate(&live);
        }
    }
}

impl Drop for AgentHost {
    fn drop(&mut self) {
        if Arc::strong_count(&self.shared) == 1 {
            self.kill_all();
        }
    }
}

/// Which spawn a reader belongs to. Lines from a child that was replaced or
/// killed are dropped instead of being parsed as the new session's output.
struct Gate {
    session_id: String,
    epoch: u64,
}

/// One reader thread feeds a channel; the emitter waits a beat for the rest of
/// the burst and sends it as one event. With partial messages on, claude writes
/// a line per token, and each event is a JSON round-trip into the webview.
fn pump(
    host: AgentHost,
    event: &'static str,
    gate: Arc<Gate>,
    reader: impl Read + Send + 'static,
    done: mpsc::Sender<()>,
) {
    let (tx, rx) = mpsc::channel::<String>();
    thread::spawn(move || {
        for line in BufReader::new(reader).lines() {
            let Ok(line) = line else { break };
            if tx.send(line).is_err() {
                break;
            }
        }
    });
    thread::spawn(move || {
        while let Ok(first) = rx.recv() {
            let mut lines = vec![first];
            let mut bytes = lines[0].len();
            while lines.len() < MAX_BATCH && bytes < MAX_BATCH_BYTES {
                match rx.recv_timeout(COALESCE) {
                    Ok(line) => {
                        bytes += line.len();
                        lines.push(line);
                    }
                    Err(_) => break,
                }
            }
            if !host.current_epoch(&gate.session_id, gate.epoch) {
                continue;
            }
            if let Some(events) = host.events() {
                events.lines(event, &gate.session_id, lines);
            }
        }
        let _ = done.send(());
    });
}

fn prepare_child(cmd: &mut Command) {
    apply_path(cmd);
    if let Some(home) = home_dir() {
        cmd.env("HOME", &home);
    }
    for (key, _) in std::env::vars_os() {
        let key = key.to_string_lossy();
        if key == "CLAUDECODE" || key.starts_with("CLAUDE_CODE_") {
            cmd.env_remove(key.as_ref());
        }
    }
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        cmd.process_group(0);
    }
}

fn apply_path(cmd: &mut Command) {
    cmd.env("PATH", shell_path::joined());
}

fn home_dir() -> Option<String> {
    std::env::var("HOME").ok().filter(|home| !home.is_empty())
}

/// SIGTERM the group, then SIGKILL it if the child is still ours two seconds
/// later. `exited` is the guard: once reaped, the pid can be anyone's.
fn terminate(live: &Arc<LiveChild>) -> Option<thread::JoinHandle<()>> {
    if live.pid <= 1 || live.exited.load(Ordering::Acquire) {
        return None;
    }
    let ipid = live.pid as i32;
    unsafe {
        libc::kill(-ipid, libc::SIGTERM);
    }
    let live = live.clone();
    Some(thread::spawn(move || {
        thread::sleep(KILL_ESCALATE);
        if live.exited.load(Ordering::Acquire) {
            return;
        }
        unsafe {
            libc::kill(-ipid, libc::SIGKILL);
        }
    }))
}

fn kill_group(pid: u32) {
    if pid <= 1 {
        return;
    }
    unsafe {
        libc::kill(-(pid as i32), libc::SIGKILL);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::os::unix::fs::PermissionsExt;

    struct Collect(Mutex<Vec<String>>);

    impl AgentEvents for Collect {
        fn lines(&self, event: &str, _session_id: &str, lines: Vec<String>) {
            if event == STDOUT_EVENT {
                self.0.lock().unwrap_or_else(|e| e.into_inner()).extend(lines);
            }
        }
        fn exit(&self, _session_id: &str, _code: Option<i32>, _pid: u32) {}
    }

    #[test]
    fn an_agent_runs_where_it_was_told_to() {
        let dir = std::env::temp_dir().join(format!("crew-cwd-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).expect("dir");
        let script = dir.join("say-where");
        // Both answers matter: a tool may ask the kernel or trust the variable.
        std::fs::write(&script, "#!/bin/sh\npwd\necho \"$PWD\"\n").expect("script");
        std::fs::set_permissions(&script, std::fs::Permissions::from_mode(0o755)).expect("chmod");

        let host = AgentHost::new();
        let collected = Arc::new(Collect(Mutex::new(Vec::new())));
        host.set_events(collected.clone());
        host.spawn(
            "s1".into(),
            script.to_string_lossy().into_owned(),
            Vec::new(),
            dir.to_string_lossy().into_owned(),
            None,
        )
        .expect("spawn");

        let want = std::fs::canonicalize(&dir).expect("canonical");
        for _ in 0..100 {
            let lines = collected.0.lock().unwrap_or_else(|e| e.into_inner()).clone();
            if lines.len() >= 2 {
                for line in lines {
                    // The shell reports the logical path it was handed; the
                    // same directory under /var and /private/var is the same
                    // directory, and this test is about which one it is.
                    let got = std::fs::canonicalize(line.trim())
                        .unwrap_or_else(|_| std::path::PathBuf::from(line.trim()));
                    assert_eq!(got, want, "the agent was left in the daemon's directory");
                }
                return;
            }
            thread::sleep(Duration::from_millis(20));
        }
        panic!("the script never answered");
    }
}
