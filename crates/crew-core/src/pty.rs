use std::collections::HashMap;
use std::io::{Read, Write};
use std::os::unix::io::AsRawFd;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
use std::sync::{Arc, Condvar, Mutex};
use std::thread;
use std::time::{Duration, Instant};

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
const RING_CAP: usize = FLOW_HIGH as usize;

pub trait PtyEvents: Send + Sync {
    fn data(&self, stream_id: u32, bytes: &[u8]);
    fn exit(&self, id: &str, code: Option<i32>);
}

struct LivePty {
    writer: Mutex<Box<dyn Write + Send>>,
    master_fd: i32,
    pid: u32,
    stream_id: u32,
    /// Set once the child is reaped; from then on the pid may belong to someone else.
    exited: AtomicBool,
    state: Mutex<PtyState>,
    credit: Condvar,
}

struct PtyState {
    ring: Ring,
    emitted: u64,
    acked: u64,
}

pub struct PtyAttached {
    pub start: u64,
    pub emitted: u64,
}

#[derive(Default)]
struct Ring {
    start: u64,
    buf: Vec<u8>,
}

impl Ring {
    fn push(&mut self, bytes: &[u8]) {
        if bytes.is_empty() {
            return;
        }
        self.buf.extend_from_slice(bytes);
        if self.buf.len() > RING_CAP {
            let drop = self.buf.len() - RING_CAP;
            self.buf.drain(..drop);
            self.start += drop as u64;
        }
    }
}

impl LivePty {
    fn new(writer: Box<dyn Write + Send>, master_fd: i32, pid: u32, stream_id: u32) -> Self {
        Self {
            writer: Mutex::new(writer),
            master_fd,
            pid,
            stream_id,
            exited: AtomicBool::new(false),
            state: Mutex::new(PtyState {
                ring: Ring::default(),
                emitted: 0,
                acked: 0,
            }),
            credit: Condvar::new(),
        }
    }

    #[cfg(test)]
    fn emit(&self, bytes: usize) {
        self.state.lock().unwrap_or_else(|e| e.into_inner()).emitted += bytes as u64;
    }

    fn ack(&self, processed: u64) {
        let mut state = self.state.lock().unwrap_or_else(|e| e.into_inner());
        state.acked = state.acked.max(processed.min(state.emitted));
        self.credit.notify_all();
    }

    /// Blocks while the renderer is behind. Returns false once the child is gone.
    fn wait_for_credit(&self) -> bool {
        let mut state = self.state.lock().unwrap_or_else(|e| e.into_inner());
        if in_flight(&state) < FLOW_HIGH {
            return true;
        }
        while in_flight(&state) >= FLOW_LOW {
            if self.exited.load(Ordering::Acquire) {
                return false;
            }
            state = self
                .credit
                .wait_timeout(state, FLOW_POLL)
                .unwrap_or_else(|e| e.into_inner())
                .0;
        }
        true
    }
}

fn in_flight(state: &PtyState) -> u64 {
    state.emitted.saturating_sub(state.acked)
}

struct Inner {
    sessions: Mutex<HashMap<String, Arc<LivePty>>>,
    streams: Mutex<HashMap<u32, String>>,
    next_stream: AtomicU32,
    events: Mutex<Option<Arc<dyn PtyEvents>>>,
}

#[derive(Clone)]
pub struct PtyHost {
    inner: Arc<Inner>,
}

impl Default for PtyHost {
    fn default() -> Self {
        Self::new()
    }
}

impl PtyHost {
    pub fn new() -> Self {
        Self {
            inner: Arc::new(Inner {
                sessions: Mutex::new(HashMap::new()),
                streams: Mutex::new(HashMap::new()),
                next_stream: AtomicU32::new(1),
                events: Mutex::new(None),
            }),
        }
    }

    pub fn set_events(&self, events: Arc<dyn PtyEvents>) {
        *self.inner.events.lock().unwrap_or_else(|e| e.into_inner()) = Some(events);
    }

    fn events(&self) -> Option<Arc<dyn PtyEvents>> {
        self.inner.events.lock().unwrap_or_else(|e| e.into_inner()).clone()
    }

    fn insert(&self, id: String, live: Arc<LivePty>) {
        let stream_id = live.stream_id;
        self.inner
            .sessions
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .insert(id.clone(), live);
        self.inner
            .streams
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .insert(stream_id, id);
    }

    fn get(&self, id: &str) -> Option<Arc<LivePty>> {
        self.inner
            .sessions
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .get(id)
            .cloned()
    }

    fn get_stream(&self, stream_id: u32) -> Option<Arc<LivePty>> {
        let id = self
            .inner
            .streams
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .get(&stream_id)
            .cloned()?;
        self.get(&id)
    }

    fn remove(&self, id: &str) -> Option<Arc<LivePty>> {
        let live = self
            .inner
            .sessions
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .remove(id)?;
        self.inner
            .streams
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .remove(&live.stream_id);
        Some(live)
    }

    fn remove_if_pid(&self, id: &str, pid: u32) -> Option<Arc<LivePty>> {
        let mut sessions = self.inner.sessions.lock().unwrap_or_else(|e| e.into_inner());
        if sessions.get(id).map(|live| live.pid) != Some(pid) {
            return None;
        }
        let live = sessions.remove(id)?;
        drop(sessions);
        self.inner
            .streams
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .remove(&live.stream_id);
        Some(live)
    }

    pub fn kill_all(&self) {
        let kids: Vec<Arc<LivePty>> = {
            let mut map = self.inner.sessions.lock().unwrap_or_else(|e| e.into_inner());
            map.drain().map(|(_, live)| live).collect()
        };
        self.inner.streams.lock().unwrap_or_else(|e| e.into_inner()).clear();
        for live in kids {
            terminate(&live);
            close_fd(live.master_fd);
        }
    }

    /// `command` empty spawns the login shell; otherwise argv[0] is resolved on PATH.
    pub fn spawn(
        &self,
        id: String,
        cwd: String,
        command: Vec<String>,
        cols: u16,
        rows: u16,
    ) -> Result<u32, String> {
        if let Some(prev) = self.remove(&id) {
            terminate(&prev);
            close_fd(prev.master_fd);
        }
        spawn_unix(self, id, cwd, command, cols.max(2), rows.max(2))
    }

    pub fn write(&self, id: &str, data: &[u8]) -> Result<(), String> {
        let live = self
            .get(id)
            .ok_or_else(|| "Terminal is not running".to_string())?;
        write_live(&live, data)
    }

    pub fn write_stream(&self, stream_id: u32, data: &[u8]) -> Result<(), String> {
        let live = self
            .get_stream(stream_id)
            .ok_or_else(|| "Terminal is not running".to_string())?;
        write_live(&live, data)
    }

    pub fn session_of_stream(&self, stream_id: u32) -> Option<String> {
        self.inner
            .streams
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .get(&stream_id)
            .cloned()
    }

    pub fn resize(&self, id: &str, cols: u16, rows: u16) -> Result<(), String> {
        let live = self
            .get(id)
            .ok_or_else(|| "Terminal is not running".to_string())?;
        resize_fd(live.master_fd, cols.max(2), rows.max(2))
    }

    /// Cumulative bytes xterm has parsed for this terminal.
    pub fn ack(&self, id: &str, processed: u64) {
        if let Some(live) = self.get(id) {
            live.ack(processed);
        }
    }

    pub fn attach<F>(&self, id: &str, from: u64, send: F) -> Result<PtyAttached, String>
    where
        F: FnOnce(&PtyAttached, u32, &[u8]),
    {
        let live = self
            .get(id)
            .ok_or_else(|| "Terminal is not running".to_string())?;
        let mut state = live.state.lock().unwrap_or_else(|e| e.into_inner());
        if from < state.ring.start {
            state.acked = state.acked.max(state.ring.start);
            live.credit.notify_all();
        }
        let start = from.max(state.ring.start);
        let skip = start.saturating_sub(state.ring.start).min(state.ring.buf.len() as u64) as usize;
        let attached = PtyAttached {
            start,
            emitted: state.emitted,
        };
        send(&attached, live.stream_id, &state.ring.buf[skip..]);
        Ok(attached)
    }

    pub fn kill(&self, id: &str) {
        if let Some(live) = self.remove(id) {
            terminate(&live);
            close_fd(live.master_fd);
        }
    }
}

impl Drop for PtyHost {
    fn drop(&mut self) {
        if Arc::strong_count(&self.inner) == 1 {
            self.kill_all();
        }
    }
}

fn write_live(live: &LivePty, data: &[u8]) -> Result<(), String> {
    let mut writer = live.writer.lock().unwrap_or_else(|e| e.into_inner());
    writer
        .write_all(data)
        .and_then(|_| writer.flush())
        .map_err(|e| format!("Failed to write to terminal: {e}"))
}

fn spawn_unix(
    host: &PtyHost,
    id: String,
    cwd: String,
    command: Vec<String>,
    cols: u16,
    rows: u16,
) -> Result<u32, String> {
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
    if std::env::var_os("LANG").is_none_or(|lang| lang.is_empty()) {
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

    let stream_id = host.inner.next_stream.fetch_add(1, Ordering::Relaxed);
    let live = Arc::new(LivePty::new(Box::new(writer), master, pid, stream_id));
    host.insert(id.clone(), live.clone());

    let data_host = host.clone();
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
                emit_data(&data_host, stream_id, &acc);
                acc.clear();
                last_emit = Instant::now();
            } else {
                match file.read(&mut buf) {
                    Ok(0) | Err(_) => break,
                    Ok(n) => acc.extend_from_slice(&buf[..n]),
                }
            }
        }
        emit_data(&data_host, stream_id, &acc);
    });

    let wait_host = host.clone();
    thread::spawn(move || {
        let code = child.wait().ok().and_then(|status| status.code());
        live.exited.store(true, Ordering::Release);
        live.credit.notify_all();
        // A respawn reuses the id; a stale wait thread must not evict the new
        // PTY from the host or paint its exit onto it.
        if wait_host.remove_if_pid(&id, pid).is_some() {
            close_fd(live.master_fd);
            if let Some(events) = wait_host.events() {
                events.exit(&id, code);
            }
        }
    });

    Ok(stream_id)
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

fn emit_data(host: &PtyHost, stream_id: u32, bytes: &[u8]) {
    if bytes.is_empty() {
        return;
    }
    if let Some(live) = host.get_stream(stream_id) {
        let mut state = live.state.lock().unwrap_or_else(|e| e.into_inner());
        state.ring.push(bytes);
        state.emitted += bytes.len() as u64;
        if let Some(events) = host.events() {
            events.data(stream_id, bytes);
        }
        return;
    }
    if let Some(events) = host.events() {
        events.data(stream_id, bytes);
    }
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
        let live = LivePty::new(Box::new(std::io::sink()), -1, 42, 1);
        live.emit(FLOW_HIGH as usize);
        live.ack(FLOW_HIGH - FLOW_LOW);
        assert!(live.wait_for_credit());
        live.emit(FLOW_HIGH as usize);
        live.exited.store(true, Ordering::Release);
        assert!(!live.wait_for_credit());
    }

    #[test]
    fn ack_ignores_processed_past_emitted() {
        let live = LivePty::new(Box::new(std::io::sink()), -1, 1, 1);
        live.emit(50);
        live.ack(1000);
        assert_eq!(live.state.lock().unwrap_or_else(|e| e.into_inner()).acked, 50);
    }

    #[test]
    fn attach_replays_from_the_ring_without_resetting_offsets() {
        let host = PtyHost::new();
        let live = Arc::new(LivePty::new(Box::new(std::io::sink()), -1, 1, 7));
        {
            let mut state = live.state.lock().unwrap_or_else(|e| e.into_inner());
            state.ring.push(&[7; 64]);
            state.emitted = 64;
            state.acked = 10;
        }
        host.insert("t".into(), live.clone());
        let mut replay = Vec::new();
        let attached = host
            .attach("t", 0, |_, _, tail| replay.extend_from_slice(tail))
            .unwrap();
        assert_eq!(attached.start, 0);
        assert_eq!(attached.emitted, 64);
        assert_eq!(replay.as_slice(), &[7; 64]);
        let state = live.state.lock().unwrap_or_else(|e| e.into_inner());
        assert_eq!(state.acked, 10);
        assert_eq!(state.emitted, 64);
    }

    #[test]
    fn attach_advances_acked_over_a_wrapped_gap() {
        let host = PtyHost::new();
        let live = Arc::new(LivePty::new(Box::new(std::io::sink()), -1, 1, 7));
        {
            let mut state = live.state.lock().unwrap_or_else(|e| e.into_inner());
            state.ring.start = 100;
            state.ring.buf.extend_from_slice(&[7; 64]);
            state.emitted = 164;
            state.acked = 0;
        }
        host.insert("t".into(), live.clone());
        let mut replay = Vec::new();
        let attached = host
            .attach("t", 0, |_, _, tail| replay.extend_from_slice(tail))
            .unwrap();
        assert_eq!(attached.start, 100);
        assert_eq!(attached.emitted, 164);
        assert_eq!(replay.len(), 64);
        assert_eq!(live.state.lock().unwrap_or_else(|e| e.into_inner()).acked, 100);
    }

    #[test]
    fn remove_if_pid_ignores_a_replaced_session() {
        let host = PtyHost::new();
        host.insert(
            "term".into(),
            Arc::new(LivePty::new(Box::new(std::io::sink()), -1, 42, 1)),
        );
        assert!(host.remove_if_pid("term", 7).is_none());
        assert!(host.get("term").is_some());
        assert!(host.remove_if_pid("term", 42).is_some());
        assert!(host.get("term").is_none());
    }
}
