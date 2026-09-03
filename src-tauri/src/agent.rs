use std::collections::HashMap;
use std::io::{BufRead, BufReader, Write};
use std::os::unix::fs::PermissionsExt;
use std::path::{Path, PathBuf};
use std::process::{ChildStdin, Command, Stdio};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::Duration;

use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager, State};

const STDOUT_EVENT: &str = "agent-stdout";
const STDERR_EVENT: &str = "agent-stderr";
const EXIT_EVENT: &str = "agent-exit";
const KILL_ESCALATE: Duration = Duration::from_secs(2);
const SPAWN_CANCELLED: &str = "Agent start was cancelled";

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct AgentLine {
    session_id: String,
    line: String,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct AgentExit {
    session_id: String,
    code: Option<i32>,
    pid: u32,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentBinary {
    pub path: String,
}

struct LiveChild {
    stdin: Mutex<ChildStdin>,
    pid: u32,
}

struct Inner {
    children: HashMap<String, Arc<LiveChild>>,
    epochs: HashMap<String, u64>,
}

pub struct AgentHost {
    inner: Mutex<Inner>,
    kill_all_gen: AtomicU64,
}

impl AgentHost {
    pub fn new() -> Self {
        Self {
            inner: Mutex::new(Inner {
                children: HashMap::new(),
                epochs: HashMap::new(),
            }),
            kill_all_gen: AtomicU64::new(0),
        }
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, Inner> {
        self.inner.lock().unwrap_or_else(|e| e.into_inner())
    }

    fn get(&self, session_id: &str) -> Option<Arc<LiveChild>> {
        self.lock().children.get(session_id).cloned()
    }

    fn begin_spawn(&self, session_id: &str) -> (u64, u64, Option<Arc<LiveChild>>) {
        let mut inner = self.lock();
        let kill_all = self.kill_all_gen.load(Ordering::SeqCst);
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
        if self.kill_all_gen.load(Ordering::SeqCst) != kill_all {
            return Some(live);
        }
        if inner.epochs.get(&session_id) != Some(&epoch) {
            return Some(live);
        }
        if let Some(prev) = inner.children.insert(session_id, live) {
            terminate(prev.pid);
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

    pub fn kill_all(&self) {
        let kids: Vec<Arc<LiveChild>> = {
            let mut inner = self.lock();
            self.kill_all_gen.fetch_add(1, Ordering::SeqCst);
            inner.children.drain().map(|(_, child)| child).collect()
        };
        for live in kids {
            terminate(live.pid);
        }
    }
}

impl Drop for AgentHost {
    fn drop(&mut self) {
        self.kill_all();
    }
}

/// Resolve `claude` the way a terminal would. Finder-launched apps inherit
/// launchd's PATH, so Homebrew / `~/.local/bin` would otherwise look missing.
#[tauri::command(async)]
pub fn agent_resolve_claude() -> Result<AgentBinary, String> {
    resolve_claude()
        .map(|path| AgentBinary {
            path: path.to_string_lossy().into_owned(),
        })
        .ok_or_else(|| {
            "Claude Code CLI not found. Install it from https://claude.com/product/claude-code and run `claude auth login`."
                .into()
        })
}

#[tauri::command(async)]
pub fn agent_spawn(
    app: AppHandle,
    host: State<'_, AgentHost>,
    session_id: String,
    command: String,
    args: Vec<String>,
    cwd: String,
) -> Result<u32, String> {
    let (epoch, kill_all, prev) = host.begin_spawn(&session_id);
    if let Some(prev) = prev {
        terminate(prev.pid);
    }

    let workdir = PathBuf::from(&cwd);
    if !workdir.is_dir() {
        return Err(format!("Working directory does not exist: {cwd}"));
    }

    let mut cmd = Command::new(&command);
    cmd.args(&args)
        .current_dir(&workdir)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    prepare_child(&mut cmd);

    let mut child = cmd
        .spawn()
        .map_err(|e| format!("Failed to start {command}: {e}"))?;
    let pid = child.id();

    let stdin = child
        .stdin
        .take()
        .ok_or_else(|| "Failed to open agent stdin".to_string())?;
    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| "Failed to open agent stdout".to_string())?;
    let stderr = child
        .stderr
        .take()
        .ok_or_else(|| "Failed to open agent stderr".to_string())?;

    let live = Arc::new(LiveChild {
        stdin: Mutex::new(stdin),
        pid,
    });
    if let Some(rejected) = host.install_spawn(session_id.clone(), epoch, kill_all, live) {
        terminate(rejected.pid);
        thread::spawn(move || {
            let _ = child.wait();
        });
        return Err(SPAWN_CANCELLED.to_string());
    }

    let stdout_app = app.clone();
    let stdout_id = session_id.clone();
    thread::spawn(move || {
        for line in BufReader::new(stdout).lines() {
            let Ok(line) = line else { break };
            let _ = stdout_app.emit(
                STDOUT_EVENT,
                AgentLine {
                    session_id: stdout_id.clone(),
                    line,
                },
            );
        }
    });

    let stderr_app = app.clone();
    let stderr_id = session_id.clone();
    thread::spawn(move || {
        for line in BufReader::new(stderr).lines() {
            let Ok(line) = line else { break };
            let _ = stderr_app.emit(
                STDERR_EVENT,
                AgentLine {
                    session_id: stderr_id.clone(),
                    line,
                },
            );
        }
    });

    let wait_app = app.clone();
    let wait_id = session_id;
    thread::spawn(move || {
        let code = child.wait().ok().and_then(|status| status.code());
        if let Some(host) = wait_app.try_state::<AgentHost>() {
            host.remove_if_pid(&wait_id, pid);
        }
        let _ = wait_app.emit(
            EXIT_EVENT,
            AgentExit {
                session_id: wait_id,
                code,
                pid,
            },
        );
    });

    Ok(pid)
}

#[tauri::command]
pub fn agent_write(
    host: State<AgentHost>,
    session_id: String,
    line: String,
) -> Result<(), String> {
    let live = host
        .get(&session_id)
        .ok_or_else(|| "Agent process is not running".to_string())?;
    let mut stdin = live.stdin.lock().unwrap_or_else(|e| e.into_inner());
    stdin
        .write_all(line.as_bytes())
        .and_then(|_| stdin.write_all(b"\n"))
        .and_then(|_| stdin.flush())
        .map_err(|e| format!("Failed to write to agent: {e}"))
}

#[tauri::command]
pub fn agent_kill(host: State<AgentHost>, session_id: String) -> Result<(), String> {
    if let Some(live) = host.kill_session(&session_id) {
        terminate(live.pid);
    }
    Ok(())
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
    let mut parts: Vec<String> = Vec::new();
    if let Some(home) = home_dir() {
        parts.push(format!("{home}/.local/bin"));
        parts.push(format!("{home}/.claude/local"));
        parts.push(format!("{home}/.cargo/bin"));
        parts.push(format!("{home}/.npm-global/bin"));
    }
    parts.push("/opt/homebrew/bin".into());
    parts.push("/usr/local/bin".into());
    parts.push("/usr/bin".into());
    parts.push("/bin".into());
    if let Ok(existing) = std::env::var("PATH") {
        parts.push(existing);
    }
    cmd.env("PATH", parts.join(":"));
}

fn resolve_claude() -> Option<PathBuf> {
    let home = home_dir().map(PathBuf::from);
    let mut candidates: Vec<PathBuf> = Vec::new();
    if let Some(home) = &home {
        candidates.push(home.join(".local/bin/claude"));
        candidates.push(home.join(".claude/local/claude"));
        candidates.push(home.join(".npm-global/bin/claude"));
    }
    candidates.push(PathBuf::from("/opt/homebrew/bin/claude"));
    candidates.push(PathBuf::from("/usr/local/bin/claude"));
    if let Ok(path) = std::env::var("PATH") {
        for dir in path.split(':').filter(|dir| !dir.is_empty()) {
            candidates.push(Path::new(dir).join("claude"));
        }
    }
    candidates.into_iter().find(|path| is_executable(path))
}

fn is_executable(path: &Path) -> bool {
    std::fs::metadata(path)
        .map(|meta| meta.is_file() && meta.permissions().mode() & 0o111 != 0)
        .unwrap_or(false)
}

fn home_dir() -> Option<String> {
    std::env::var("HOME").ok().filter(|home| !home.is_empty())
}

fn terminate(pid: u32) {
    if pid <= 1 {
        return;
    }
    let ipid = pid as i32;
    unsafe {
        libc::kill(-ipid, libc::SIGTERM);
        libc::kill(ipid, libc::SIGTERM);
    }
    thread::spawn(move || {
        thread::sleep(KILL_ESCALATE);
        if unsafe { libc::kill(ipid, 0) == 0 || libc::kill(-ipid, 0) == 0 } {
            unsafe {
                libc::kill(-ipid, libc::SIGKILL);
                libc::kill(ipid, libc::SIGKILL);
            }
        }
    });
}
