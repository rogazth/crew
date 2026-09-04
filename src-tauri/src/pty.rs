use std::collections::HashMap;
use std::io::{Read, Write};
use std::os::unix::io::AsRawFd;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Condvar, Mutex};
use std::thread;
use std::time::{Duration, Instant};

use base64::Engine as _;
use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager, State};

const DATA_EVENT: &str = "pty-data";
const EXIT_EVENT: &str = "pty-exit";
const READ_CHUNK: usize = 32 * 1024;
/// Each `emit` is a JS eval in the webview. A busy PTY read thousands of small
/// chunks per second and froze keyboard input until they were batched.
const PTY_COALESCE: Duration = Duration::from_millis(8);
const KILL_ESCALATE: Duration = Duration::from_secs(1);
/// Bytes emitted but not yet parsed by xterm. Past HIGH the reader stops
/// draining the master, so a flooding child blocks on write instead of
/// burying the webview; below LOW it drains again.
const FLOW_HIGH: u64 = 256 * 1024;
const FLOW_LOW: u64 = 32 * 1024;
const FLOW_POLL: Duration = Duration::from_millis(250);

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct PtyData {
    id: String,
    data: String,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct PtyExit {
    id: String,
    code: Option<i32>,
}

struct LivePty {
    writer: Mutex<Box<dyn Write + Send>>,
    master_fd: i32,
    pid: u32,
    /// Set once the child is reaped; from then on the pid may belong to someone else.
    exited: AtomicBool,
    flow: Mutex<Flow>,
    credit: Condvar,
}

#[derive(Default)]
struct Flow {
    sent: u64,
    acked: u64,
}

impl LivePty {
    fn new(writer: Box<dyn Write + Send>, master_fd: i32, pid: u32) -> Self {
        Self {
            writer: Mutex::new(writer),
            master_fd,
            pid,
            exited: AtomicBool::new(false),
            flow: Mutex::new(Flow::default()),
            credit: Condvar::new(),
        }
    }

    fn sent(&self, bytes: usize) {
        self.flow.lock().unwrap_or_else(|e| e.into_inner()).sent += bytes as u64;
    }

    fn ack(&self, processed: u64) {
        let mut flow = self.flow.lock().unwrap_or_else(|e| e.into_inner());
        flow.acked = flow.acked.max(processed);
        self.credit.notify_all();
    }

    /// Blocks while the renderer is behind. Returns false once the child is gone.
    fn wait_for_credit(&self) -> bool {
        let mut flow = self.flow.lock().unwrap_or_else(|e| e.into_inner());
        if in_flight(&flow) < FLOW_HIGH {
            return true;
        }
        while in_flight(&flow) >= FLOW_LOW {
            if self.exited.load(Ordering::Acquire) {
                return false;
            }
            flow = self
                .credit
                .wait_timeout(flow, FLOW_POLL)
                .unwrap_or_else(|e| e.into_inner())
                .0;
        }
        true
    }
}

fn in_flight(flow: &Flow) -> u64 {
    flow.sent.saturating_sub(flow.acked)
}

pub struct PtyHost {
    sessions: Mutex<HashMap<String, Arc<LivePty>>>,
}

impl PtyHost {
    pub fn new() -> Self {
        Self {
            sessions: Mutex::new(HashMap::new()),
        }
    }

    fn insert(&self, id: String, live: Arc<LivePty>) {
        self.sessions
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .insert(id, live);
    }

    fn get(&self, id: &str) -> Option<Arc<LivePty>> {
        self.sessions
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .get(id)
            .cloned()
    }

    fn remove(&self, id: &str) -> Option<Arc<LivePty>> {
        self.sessions
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .remove(id)
    }

    fn remove_if_pid(&self, id: &str, pid: u32) -> Option<Arc<LivePty>> {
        let mut sessions = self.sessions.lock().unwrap_or_else(|e| e.into_inner());
        if sessions.get(id).map(|live| live.pid) != Some(pid) {
            return None;
        }
        sessions.remove(id)
    }

    pub fn kill_all(&self) {
        let kids: Vec<Arc<LivePty>> = {
            let mut map = self.sessions.lock().unwrap_or_else(|e| e.into_inner());
            map.drain().map(|(_, live)| live).collect()
        };
        for live in kids {
            terminate(&live);
            close_fd(live.master_fd);
        }
    }
}

impl Drop for PtyHost {
    fn drop(&mut self) {
        self.kill_all();
    }
}

/// `command` empty spawns the login shell; otherwise argv[0] is resolved on PATH.
#[tauri::command(async)]
pub fn pty_spawn(
    app: AppHandle,
    host: State<PtyHost>,
    id: String,
    cwd: String,
    command: Vec<String>,
    cols: u16,
    rows: u16,
) -> Result<(), String> {
    if let Some(prev) = host.remove(&id) {
        terminate(&prev);
        close_fd(prev.master_fd);
    }
    spawn_unix(app, host, id, cwd, command, cols.max(2), rows.max(2))
}

#[tauri::command(async)]
pub fn pty_write(host: State<PtyHost>, id: String, data: String) -> Result<(), String> {
    let live = host
        .get(&id)
        .ok_or_else(|| "Terminal is not running".to_string())?;
    let mut writer = live.writer.lock().unwrap_or_else(|e| e.into_inner());
    writer
        .write_all(data.as_bytes())
        .and_then(|_| writer.flush())
        .map_err(|e| format!("Failed to write to terminal: {e}"))
}

#[tauri::command(async)]
pub fn pty_resize(host: State<PtyHost>, id: String, cols: u16, rows: u16) -> Result<(), String> {
    let live = host
        .get(&id)
        .ok_or_else(|| "Terminal is not running".to_string())?;
    resize_fd(live.master_fd, cols.max(2), rows.max(2))
}

/// Cumulative bytes xterm has parsed for this terminal.
#[tauri::command(async)]
pub fn pty_ack(host: State<PtyHost>, id: String, processed: u64) -> Result<(), String> {
    if let Some(live) = host.get(&id) {
        live.ack(processed);
    }
    Ok(())
}

#[tauri::command(async)]
pub fn pty_kill(host: State<PtyHost>, id: String) -> Result<(), String> {
    if let Some(live) = host.remove(&id) {
        terminate(&live);
        close_fd(live.master_fd);
    }
    Ok(())
}

fn spawn_unix(
    app: AppHandle,
    host: State<PtyHost>,
    id: String,
    cwd: String,
    command: Vec<String>,
    cols: u16,
    rows: u16,
) -> Result<(), String> {
    use std::fs::File;
    use std::os::unix::io::FromRawFd;
    use std::os::unix::process::CommandExt;
    use std::process::Command;

    let workdir = working_dir(&cwd);
    let (program, args) = match command.split_first() {
        Some((program, args)) => (program.clone(), args.to_vec()),
        None => default_shell(),
    };
    let (master, slave) = open_pty(cols, rows)?;

    let mut cmd = Command::new(&program);
    cmd.args(&args)
        .current_dir(&workdir)
        .stdin(dup_stdio(slave)?)
        .stdout(dup_stdio(slave)?)
        .stderr(dup_stdio(slave)?)
        .env("TERM", "xterm-256color")
        .env("COLORTERM", "truecolor")
        .env("TERM_PROGRAM", "Crew")
        .env("TERM_PROGRAM_VERSION", env!("CARGO_PKG_VERSION"))
        // supports-hyperlinks only knows a few TERM_PROGRAM values, so without
        // this CLIs print bare paths instead of the OSC 8 links xterm renders.
        .env("FORCE_HYPERLINK", "1")
        .env("PWD", &workdir);
    // A GUI app inherits no locale from launchd; without UTF-8 the box drawing
    // and emoji agents print come out as mojibake.
    if std::env::var_os("LANG").map_or(true, |lang| lang.is_empty()) {
        cmd.env("LANG", "en_US.UTF-8");
    }
    apply_path(&mut cmd);
    if let Some(home) = home_dir() {
        cmd.env("HOME", &home);
    }
    // Launched from inside a Claude Code session, the app would pass these on
    // and claude would treat the terminal as a child session with no transcript.
    for (key, _) in std::env::vars_os() {
        let key = key.to_string_lossy();
        if key == "CLAUDECODE" || key.starts_with("CLAUDE_CODE_") {
            cmd.env_remove(key.as_ref());
        }
    }
    // A parent that disabled colour for its own logs must not decide for the terminal.
    cmd.env_remove("NO_COLOR");
    for key in ["FORCE_COLOR", "CLICOLOR"] {
        if std::env::var_os(key).is_some_and(|value| value == "0") {
            cmd.env_remove(key);
        }
    }

    // setsid() fails with EPERM if the child is already a group leader, so no
    // process_group(0) before it.
    let slave_fd = slave;
    unsafe {
        cmd.pre_exec(move || {
            if libc::setsid() < 0 {
                return Err(std::io::Error::last_os_error());
            }
            let _ = libc::ioctl(0, libc::TIOCSCTTY as _, 0);
            if slave_fd > 2 {
                libc::close(slave_fd);
            }
            Ok(())
        });
    }

    let mut child = cmd.spawn().map_err(|e| {
        close_fd(master);
        close_fd(slave);
        format!("Failed to start {program}: {e}")
    })?;
    close_fd(slave);
    let pid = child.id();

    set_cloexec(master);
    let reader = unsafe { File::from_raw_fd(dup_fd(master)?) };
    let writer = unsafe { File::from_raw_fd(dup_fd(master)?) };

    let live = Arc::new(LivePty::new(Box::new(writer), master, pid));
    host.insert(id.clone(), live.clone());

    let data_app = app.clone();
    let data_id = id.clone();
    let data_live = live.clone();
    thread::spawn(move || {
        let mut file = reader;
        let fd = file.as_raw_fd();
        let mut buf = vec![0_u8; READ_CHUNK];
        let mut acc = Vec::with_capacity(READ_CHUNK);
        let mut last_emit = Instant::now();
        loop {
            if acc.is_empty() {
                if !data_live.wait_for_credit() {
                    break;
                }
                match file.read(&mut buf) {
                    Ok(0) | Err(_) => break,
                    Ok(n) => {
                        acc.extend_from_slice(&buf[..n]);
                        last_emit = Instant::now();
                    }
                }
            } else if should_flush(acc.len(), last_emit.elapsed())
                || !wait_readable(fd, PTY_COALESCE.saturating_sub(last_emit.elapsed()))
            {
                emit_data(&data_app, &data_id, &acc);
                data_live.sent(acc.len());
                acc.clear();
                last_emit = Instant::now();
            } else {
                match file.read(&mut buf) {
                    Ok(0) | Err(_) => break,
                    Ok(n) => acc.extend_from_slice(&buf[..n]),
                }
            }
        }
        emit_data(&data_app, &data_id, &acc);
    });

    thread::spawn(move || {
        let code = child.wait().ok().and_then(|status| status.code());
        live.exited.store(true, Ordering::Release);
        live.credit.notify_all();
        // A respawn reuses the id; a stale wait thread must not evict the new
        // PTY from the host or paint its exit onto it.
        let Some(host) = app.try_state::<PtyHost>() else {
            return;
        };
        if let Some(live) = host.remove_if_pid(&id, pid) {
            close_fd(live.master_fd);
            let _ = app.emit(EXIT_EVENT, PtyExit { id, code });
        }
    });

    Ok(())
}

fn home_dir() -> Option<String> {
    std::env::var("HOME").ok().filter(|home| !home.is_empty())
}

fn working_dir(cwd: &str) -> PathBuf {
    let path = PathBuf::from(cwd);
    if path.is_dir() {
        return path;
    }
    home_dir().map(PathBuf::from).unwrap_or(path)
}

fn default_shell() -> (String, Vec<String>) {
    let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/zsh".into());
    let login = matches!(
        std::path::Path::new(&shell)
            .file_name()
            .and_then(|name| name.to_str()),
        Some("zsh" | "bash" | "sh" | "fish")
    );
    let args = if login { vec!["-l".to_string()] } else { Vec::new() };
    (shell, args)
}

/// The app inherits launchd's PATH, not the user's shell PATH, so the places
/// agent CLIs install themselves go in front.
fn apply_path(cmd: &mut std::process::Command) {
    let mut parts: Vec<String> = Vec::new();
    if let Some(home) = home_dir() {
        parts.push(format!("{home}/.local/bin"));
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

/// The child was started with setsid(), so its pid is also its process group.
fn terminate(live: &Arc<LivePty>) {
    if live.pid <= 1 || live.exited.load(Ordering::Acquire) {
        return;
    }
    let ipid = live.pid as i32;
    unsafe {
        libc::kill(ipid, libc::SIGHUP);
        libc::kill(-ipid, libc::SIGHUP);
        libc::kill(ipid, libc::SIGTERM);
        libc::kill(-ipid, libc::SIGTERM);
    }
    let live = live.clone();
    thread::spawn(move || {
        thread::sleep(KILL_ESCALATE);
        // Once reaped the kernel may hand this pid to another process.
        if live.exited.load(Ordering::Acquire) {
            return;
        }
        unsafe {
            libc::kill(ipid, libc::SIGKILL);
            libc::kill(-ipid, libc::SIGKILL);
        }
    });
}

fn open_pty(cols: u16, rows: u16) -> Result<(i32, i32), String> {
    let master = unsafe { libc::posix_openpt(libc::O_RDWR | libc::O_NOCTTY) };
    if master < 0 {
        return Err(os_err("Failed to open terminal"));
    }
    if unsafe { libc::grantpt(master) } != 0 || unsafe { libc::unlockpt(master) } != 0 {
        close_fd(master);
        return Err(os_err("Failed to unlock terminal"));
    }
    let name = unsafe { libc::ptsname(master) };
    if name.is_null() {
        close_fd(master);
        return Err(os_err("Failed to resolve terminal name"));
    }
    let slave = unsafe { libc::open(name, libc::O_RDWR | libc::O_NOCTTY) };
    if slave < 0 {
        close_fd(master);
        return Err(os_err("Failed to open terminal slave"));
    }
    if let Err(err) = resize_fd(master, cols, rows) {
        close_fd(master);
        close_fd(slave);
        return Err(err);
    }
    Ok((master, slave))
}

fn resize_fd(fd: i32, cols: u16, rows: u16) -> Result<(), String> {
    let size = libc::winsize {
        ws_row: rows,
        ws_col: cols,
        ws_xpixel: 0,
        ws_ypixel: 0,
    };
    if unsafe { libc::ioctl(fd, libc::TIOCSWINSZ, &size) } != 0 {
        return Err(os_err("Failed to resize terminal"));
    }
    Ok(())
}

fn dup_fd(fd: i32) -> Result<i32, String> {
    let next = unsafe { libc::dup(fd) };
    if next < 0 {
        return Err(os_err("Failed to duplicate terminal"));
    }
    Ok(next)
}

fn dup_stdio(fd: i32) -> Result<std::process::Stdio, String> {
    use std::os::unix::io::FromRawFd;
    let next = dup_fd(fd)?;
    Ok(unsafe { std::process::Stdio::from_raw_fd(next) })
}

fn set_cloexec(fd: i32) {
    unsafe {
        let flags = libc::fcntl(fd, libc::F_GETFD);
        if flags >= 0 {
            libc::fcntl(fd, libc::F_SETFD, flags | libc::FD_CLOEXEC);
        }
    }
}

fn close_fd(fd: i32) {
    if fd >= 0 {
        unsafe {
            libc::close(fd);
        }
    }
}

fn os_err(ctx: &str) -> String {
    format!("{ctx}: {}", std::io::Error::last_os_error())
}

fn emit_data(app: &AppHandle, id: &str, bytes: &[u8]) {
    if bytes.is_empty() {
        return;
    }
    let data = base64::engine::general_purpose::STANDARD.encode(bytes);
    let _ = app.emit(
        DATA_EVENT,
        PtyData {
            id: id.to_string(),
            data,
        },
    );
}

fn should_flush(buffered: usize, since: Duration) -> bool {
    buffered >= READ_CHUNK || since >= PTY_COALESCE
}

fn wait_readable(fd: i32, timeout: Duration) -> bool {
    if timeout.is_zero() {
        return false;
    }
    let mut pollfd = libc::pollfd {
        fd,
        events: libc::POLLIN,
        revents: 0,
    };
    let ms = timeout.as_millis().min(i32::MAX as u128) as i32;
    unsafe { libc::poll(&mut pollfd, 1, ms) > 0 }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn flush_waits_for_a_full_chunk_or_the_coalesce_window() {
        assert!(!should_flush(1, Duration::from_millis(1)));
        assert!(should_flush(READ_CHUNK, Duration::from_millis(1)));
        assert!(should_flush(1, PTY_COALESCE));
    }

    #[test]
    fn credit_blocks_past_high_water_until_acked_below_low() {
        let live = LivePty::new(Box::new(std::io::sink()), -1, 42);
        live.sent(FLOW_HIGH as usize);
        live.ack(FLOW_HIGH - FLOW_LOW);
        assert!(live.wait_for_credit());
        live.sent(FLOW_HIGH as usize);
        live.exited.store(true, Ordering::Release);
        assert!(!live.wait_for_credit());
    }

    #[test]
    fn remove_if_pid_ignores_a_replaced_session() {
        let host = PtyHost::new();
        host.insert(
            "term".into(),
            Arc::new(LivePty::new(Box::new(std::io::sink()), -1, 42)),
        );
        assert!(host.remove_if_pid("term", 7).is_none());
        assert!(host.get("term").is_some());
        assert!(host.remove_if_pid("term", 42).is_some());
        assert!(host.get("term").is_none());
    }
}
