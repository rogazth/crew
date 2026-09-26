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
/// A supervised PTY's viewer may fall this far behind before its live frames
/// are dropped. Room for a full ring replay plus a window of live output, or
/// the replay that answers a resync would itself trip the next one.
const VIEWER_HIGH: u64 = RING_CAP as u64 + FLOW_HIGH;
/// How long a supervised exit waits for the reader to drain what the child
/// wrote last. A grandchild still holding the terminal can keep it open forever.
const DRAIN_ON_EXIT: Duration = Duration::from_secs(1);

/// What a spawn can carry beyond the argv. Grows by a field, so a new option
/// does not change every caller of `spawn`.
#[derive(Default)]
pub struct SpawnOptions {
    /// Set on the child after Crew's own terminal environment, so it wins.
    pub env: Vec<(String, String)>,
    /// Runs once this process is reaped, whatever replaced it since. The
    /// `exit` event is not that: a respawn on the same id takes the id over,
    /// and the old process's exit is not announced. Also runs, at once, when
    /// the spawn fails, so what it releases is never left held.
    pub on_exit: Option<Box<dyn FnOnce() + Send>>,
    /// Supervised: the reader never waits for credit. Every byte reaches the
    /// sink and the ring, and a viewer that falls behind is sent a resync
    /// instead of holding the child back. A server nobody is looking at must
    /// not block on write.
    pub supervised: Option<Arc<dyn PtySink>>,
}

pub trait PtyEvents: Send + Sync {
    fn data(&self, stream_id: u32, bytes: &[u8]);
    fn exit(&self, id: &str, code: Option<i32>);
    /// A supervised PTY dropped frames its viewer had no credit for; the
    /// viewer has to repaint from the ring with a fresh attach.
    fn resync(&self, _id: &str) {}
}

/// Where a supervised PTY's output goes whether or not anyone is watching.
pub trait PtySink: Send + Sync {
    fn output(&self, bytes: &[u8]);
    /// After the last output. `None` is a child ended by a signal.
    fn exit(&self, code: Option<i32>);
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
    supervised: Option<Arc<dyn PtySink>>,
}

struct PtyState {
    ring: Ring,
    emitted: u64,
    acked: u64,
    /// Supervised only: frames are dropped until the viewer attaches again.
    behind: bool,
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
                behind: false,
            }),
            credit: Condvar::new(),
            supervised: None,
        }
    }

    fn with_sink(mut self, sink: Option<Arc<dyn PtySink>>) -> Self {
        self.supervised = sink;
        self
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

#[derive(Debug, PartialEq)]
enum Forward {
    Send,
    /// Already behind; the resync that says so went out with the first drop.
    Drop,
    Resync,
}

/// What a supervised PTY does with a frame already in its ring, `emitted`
/// counting it. With nobody watching the first frame past the window trips
/// a resync nobody hears, and the rest drop until someone attaches.
fn forward(state: &mut PtyState) -> Forward {
    if state.behind {
        return Forward::Drop;
    }
    if in_flight(state) <= VIEWER_HIGH {
        return Forward::Send;
    }
    state.behind = true;
    Forward::Resync
}

struct Inner {
    /// Held across remove/spawn/insert. Every RPC lands on its own blocking
    /// thread, so without it two spawns for one id both find the map empty and
    /// the second insert drops a live child nothing can reach again.
    spawning: Mutex<()>,
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
                spawning: Mutex::new(()),
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
        let pid = live.pid;
        let replaced = self
            .inner
            .sessions
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .insert(id.clone(), live);
        if let Some(prev) = replaced {
            eprintln!("[pty] {id}: pid {pid} replaced live pid {}; terminating it", prev.pid);
            let _ = terminate(&prev);
            close_fd(prev.master_fd);
        }
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
        let _spawning = self.inner.spawning.lock().unwrap_or_else(|e| e.into_inner());
        let kids: Vec<Arc<LivePty>> = {
            let mut map = self.inner.sessions.lock().unwrap_or_else(|e| e.into_inner());
            map.drain().map(|(_, live)| live).collect()
        };
        self.inner.streams.lock().unwrap_or_else(|e| e.into_inner()).clear();
        let waits: Vec<_> = kids
            .into_iter()
            .filter_map(|live| {
                let wait = terminate(&live);
                close_fd(live.master_fd);
                wait
            })
            .collect();
        for wait in waits {
            let _ = wait.join();
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
        self.spawn_with(id, cwd, command, cols, rows, SpawnOptions::default())
    }

    pub fn spawn_with(
        &self,
        id: String,
        cwd: String,
        command: Vec<String>,
        cols: u16,
        rows: u16,
        mut options: SpawnOptions,
    ) -> Result<u32, String> {
        let _spawning = self.inner.spawning.lock().unwrap_or_else(|e| e.into_inner());
        if let Some(prev) = self.remove(&id) {
            eprintln!("[pty] {id}: respawn terminates pid {}", prev.pid);
            let _ = terminate(&prev);
            close_fd(prev.master_fd);
        }
        let on_exit = options.on_exit.take();
        let spawned = spawn_unix(
            self,
            id,
            cwd,
            command,
            cols.max(2),
            rows.max(2),
            options.env,
            on_exit,
            options.supervised,
        );
        match spawned {
            Ok(stream) => Ok(stream),
            Err((error, on_exit)) => {
                if let Some(on_exit) = on_exit {
                    on_exit();
                }
                Err(error)
            }
        }
    }

    /// Sends `signal` to the child's whole process group, so a server's
    /// workers stop and pause along with it.
    pub fn signal_group(&self, id: &str, signal: i32) -> Result<(), String> {
        let live = self
            .get(id)
            .ok_or_else(|| "Process is not running".to_string())?;
        // Once reaped the kernel may hand this pid to another process.
        if live.pid <= 1 || live.exited.load(Ordering::Acquire) {
            return Err("Process is not running".into());
        }
        if unsafe { libc::kill(-(live.pid as i32), signal) } != 0 {
            return Err(os_err("Failed to signal the process"));
        }
        Ok(())
    }

    pub fn pid(&self, id: &str) -> Option<u32> {
        self.get(id)
            .filter(|live| !live.exited.load(Ordering::Acquire))
            .map(|live| live.pid)
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
        let start = from.max(state.ring.start);
        if live.supervised.is_some() {
            // The replay is all this viewer has in flight: its credit starts
            // over from there, and live frames flow to it again.
            state.acked = start;
            state.behind = false;
        } else if from < state.ring.start {
            state.acked = state.acked.max(state.ring.start);
            live.credit.notify_all();
        }
        let skip = start.saturating_sub(state.ring.start).min(state.ring.buf.len() as u64) as usize;
        let attached = PtyAttached {
            start,
            emitted: state.emitted,
        };
        send(&attached, live.stream_id, &state.ring.buf[skip..]);
        Ok(attached)
    }

    pub fn kill(&self, id: &str) {
        let _spawning = self.inner.spawning.lock().unwrap_or_else(|e| e.into_inner());
        match self.remove(id) {
            Some(live) => {
                let _ = terminate(&live);
                close_fd(live.master_fd);
            }
            None => eprintln!("[pty] {id}: kill found nothing registered"),
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

type OnExit = Option<Box<dyn FnOnce() + Send>>;

/// On failure the `on_exit` comes back unrun, for the caller to run: there is
/// no process to wait for.
#[allow(clippy::too_many_arguments)]
fn spawn_unix(
    host: &PtyHost,
    id: String,
    cwd: String,
    command: Vec<String>,
    cols: u16,
    rows: u16,
    env: Vec<(String, String)>,
    on_exit: OnExit,
    sink: Option<Arc<dyn PtySink>>,
) -> Result<u32, (String, OnExit)> {
    use std::fs::File;
    use std::os::unix::io::FromRawFd;

    let workdir = working_dir(&cwd);
    let (program, args) = match command.split_first() {
        Some((program, args)) => (program.clone(), args.to_vec()),
        None => default_shell(),
    };
    let (master, slave) = match open_pty(cols, rows) {
        Ok(pair) => pair,
        Err(err) => return Err((err, on_exit)),
    };
    let mut cmd = match pty_command(&program, &args, &workdir, slave) {
        Ok(cmd) => cmd,
        Err(err) => {
            close_fd(master);
            close_fd(slave);
            return Err((err, on_exit));
        }
    };
    cmd.envs(env);

    let mut child = match cmd.spawn() {
        Ok(child) => child,
        Err(e) => {
            close_fd(master);
            close_fd(slave);
            return Err((format!("Failed to start {program}: {e}"), on_exit));
        }
    };
    close_fd(slave);
    let pid = child.id();

    // The child is running from here on, so what `on_exit` releases is the
    // wait thread's to release; a failure below leaves it to that thread.
    let dups = dup_fd(master).and_then(|reader| match dup_fd(master) {
        Ok(writer) => Ok((reader, writer)),
        Err(err) => {
            close_fd(reader);
            Err(err)
        }
    });
    let (reader, writer) = match dups {
        Ok(pair) => pair,
        Err(err) => {
            unsafe {
                libc::kill(-(pid as i32), libc::SIGKILL);
            }
            close_fd(master);
            thread::spawn(move || {
                let _ = child.wait();
                if let Some(on_exit) = on_exit {
                    on_exit();
                }
            });
            return Err((err, None));
        }
    };
    let reader = unsafe { File::from_raw_fd(reader) };
    let writer = unsafe { File::from_raw_fd(writer) };

    let stream_id = host.inner.next_stream.fetch_add(1, Ordering::Relaxed);
    let live = Arc::new(LivePty::new(Box::new(writer), master, pid, stream_id).with_sink(sink.clone()));
    host.insert(id.clone(), live.clone());

    let data_host = host.clone();
    let data_live = live.clone();
    let (drained_tx, drained_rx) = std::sync::mpsc::channel::<()>();
    thread::spawn(move || {
        // Dropped on every way out of the loop, which is what an exit waits on.
        let _drained = drained_tx;
        let supervised = data_live.supervised.is_some();
        let mut file = reader;
        let fd = file.as_raw_fd();
        let mut buf = vec![0_u8; READ_CHUNK];
        let mut acc = Vec::with_capacity(READ_CHUNK);
        let mut last_emit = Instant::now();
        loop {
            if acc.is_empty() {
                if !supervised && !data_live.wait_for_credit() {
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
                flush(&data_host, &data_live, stream_id, &acc);
                acc.clear();
                last_emit = Instant::now();
            } else {
                match file.read(&mut buf) {
                    Ok(0) | Err(_) => break,
                    Ok(n) => acc.extend_from_slice(&buf[..n]),
                }
            }
        }
        flush(&data_host, &data_live, stream_id, &acc);
    });

    let wait_host = host.clone();
    thread::spawn(move || {
        let code = child.wait().ok().and_then(|status| status.code());
        if sink.is_some() {
            // The child's last words are still in the master: the exit must
            // not reach the log, or a viewer, ahead of them.
            let _ = drained_rx.recv_timeout(DRAIN_ON_EXIT);
        }
        live.exited.store(true, Ordering::Release);
        live.credit.notify_all();
        if let Some(on_exit) = on_exit {
            on_exit();
        }
        // A respawn reuses the id; a stale wait thread must not evict the new
        // PTY from the host or paint its exit onto it.
        if wait_host.remove_if_pid(&id, pid).is_some() {
            close_fd(live.master_fd);
            if let Some(events) = wait_host.events() {
                events.exit(&id, code);
            }
        }
        // A replaced child reports too: the supervisor tells its runs apart.
        if let Some(sink) = sink {
            sink.exit(code);
        }
    });

    Ok(stream_id)
}

/// The command for `program` with the PTY slave as its terminal. Whatever
/// else crewd holds, other terminals' masters and what Electron handed it,
/// stays behind: a CLI holding a master never sees its terminal hang up when
/// crewd dies.
fn pty_command(
    program: &str,
    args: &[String],
    workdir: &std::path::Path,
    slave: i32,
) -> Result<std::process::Command, String> {
    use std::os::unix::process::CommandExt;
    use std::process::Command;

    let mut cmd = Command::new(program);
    cmd.args(args)
        .current_dir(workdir)
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
        .env("PWD", workdir);
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
    let fd_limit = fd_limit();
    unsafe {
        cmd.pre_exec(move || {
            if libc::setsid() < 0 {
                return Err(std::io::Error::last_os_error());
            }
            let _ = libc::ioctl(0, libc::TIOCSCTTY as _, 0);
            if slave_fd > 2 {
                libc::close(slave_fd);
            }
            // std dup2s the slave copies onto 0/1/2, which clears their
            // close-on-exec, except when a copy already sat on its target.
            for fd in 0..=2 {
                libc::fcntl(fd, libc::F_SETFD, 0);
            }
            cloexec_above_stderr(fd_limit);
            Ok(())
        });
    }
    Ok(cmd)
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

fn apply_path(cmd: &mut std::process::Command) {
    cmd.env("PATH", crate::shell_path::joined());
}

/// The child was started with setsid(), so its pid is also its process group.
fn terminate(live: &Arc<LivePty>) -> Option<thread::JoinHandle<()>> {
    if live.pid <= 1 || live.exited.load(Ordering::Acquire) {
        return None;
    }
    let ipid = live.pid as i32;
    unsafe {
        libc::kill(ipid, libc::SIGHUP);
        libc::kill(-ipid, libc::SIGHUP);
        libc::kill(ipid, libc::SIGTERM);
        libc::kill(-ipid, libc::SIGTERM);
    }
    let live = live.clone();
    Some(thread::spawn(move || {
        thread::sleep(KILL_ESCALATE);
        // Once reaped the kernel may hand this pid to another process.
        if live.exited.load(Ordering::Acquire) {
            return;
        }
        unsafe {
            libc::kill(ipid, libc::SIGKILL);
            libc::kill(-ipid, libc::SIGKILL);
        }
    }))
}

/// Both ends are close-on-exec from the start: another terminal spawning on
/// another thread must not carry this one's master into its CLI.
fn open_pty(cols: u16, rows: u16) -> Result<(i32, i32), String> {
    // glibc hands the flags to open(2); macOS rejects any beyond these two,
    // so there the flag goes on right after, a window only a fork on another
    // thread in those few instructions could hit, and pre_exec covers that.
    #[cfg(target_os = "linux")]
    let flags = libc::O_RDWR | libc::O_NOCTTY | libc::O_CLOEXEC;
    #[cfg(not(target_os = "linux"))]
    let flags = libc::O_RDWR | libc::O_NOCTTY;
    let master = unsafe { libc::posix_openpt(flags) };
    if master < 0 {
        return Err(os_err("Failed to open terminal"));
    }
    set_cloexec(master);
    if unsafe { libc::grantpt(master) } != 0 || unsafe { libc::unlockpt(master) } != 0 {
        close_fd(master);
        return Err(os_err("Failed to unlock terminal"));
    }
    let name = unsafe { libc::ptsname(master) };
    if name.is_null() {
        close_fd(master);
        return Err(os_err("Failed to resolve terminal name"));
    }
    let slave = unsafe { libc::open(name, libc::O_RDWR | libc::O_NOCTTY | libc::O_CLOEXEC) };
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
    let next = unsafe { libc::fcntl(fd, libc::F_DUPFD_CLOEXEC, 0) };
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

/// Where the child stops looking for descriptors to mark. Read before the
/// fork: nothing between fork and exec may allocate or take a lock.
fn fd_limit() -> i32 {
    const FLOOR: i32 = 1024;
    const CAP: i32 = 1 << 16;
    let mut limit = libc::rlimit { rlim_cur: 0, rlim_max: 0 };
    if unsafe { libc::getrlimit(libc::RLIMIT_NOFILE, &mut limit) } != 0 {
        return CAP;
    }
    i32::try_from(limit.rlim_cur).unwrap_or(CAP).clamp(FLOOR, CAP)
}

/// Marks every descriptor above stderr close-on-exec, in the forked child.
/// Marked rather than closed: std reports a failed exec through a pipe of its
/// own that has to stay open until the exec. Async-signal-safe, no allocation.
fn cloexec_above_stderr(limit: i32) {
    #[cfg(target_os = "linux")]
    unsafe {
        // Linux 5.11+. Older kernels answer ENOSYS or EINVAL and take the loop.
        let all = libc::syscall(
            libc::SYS_close_range,
            3 as libc::c_uint,
            libc::c_uint::MAX,
            libc::CLOSE_RANGE_CLOEXEC,
        );
        if all == 0 {
            return;
        }
    }
    // macOS has no close_range; F_SETFD on a closed descriptor is a cheap EBADF.
    for fd in 3..limit {
        unsafe {
            libc::fcntl(fd, libc::F_SETFD, libc::FD_CLOEXEC);
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

/// The sink goes first: it is the record, and must not wait on any viewer.
fn flush(host: &PtyHost, live: &LivePty, stream_id: u32, bytes: &[u8]) {
    if bytes.is_empty() {
        return;
    }
    if let Some(sink) = &live.supervised {
        sink.output(bytes);
    }
    emit_data(host, stream_id, bytes);
}

fn emit_data(host: &PtyHost, stream_id: u32, bytes: &[u8]) {
    if bytes.is_empty() {
        return;
    }
    if let Some(live) = host.get_stream(stream_id) {
        let mut state = live.state.lock().unwrap_or_else(|e| e.into_inner());
        state.ring.push(bytes);
        state.emitted += bytes.len() as u64;
        if live.supervised.is_some() {
            match forward(&mut state) {
                Forward::Send => {}
                Forward::Drop => return,
                Forward::Resync => {
                    // Under the state lock, like the frames: a viewer sees
                    // the resync after the last frame it was sent, never before.
                    let id = host.session_of_stream(stream_id);
                    if let (Some(events), Some(id)) = (host.events(), id) {
                        events.resync(&id);
                    }
                    return;
                }
            }
        }
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

    fn marker_children(marker: &str) -> usize {
        let out = std::process::Command::new("pgrep")
            .args(["-f", marker])
            .output()
            .expect("pgrep failed");
        String::from_utf8_lossy(&out.stdout).lines().filter(|l| !l.is_empty()).count()
    }

    #[test]
    fn concurrent_spawns_on_one_id_leave_a_single_child() {
        // A script named after the marker, rather than `exec -a`: that is a
        // bashism, and /bin/sh is dash on most Linux.
        let marker = format!("crew_pty_race_{}", std::process::id());
        let script = std::env::temp_dir().join(format!("{marker}.sh"));
        // No `exec`: the shell has to stay, because its command line is what
        // carries the marker that pgrep looks for.
        std::fs::write(&script, "sleep 30\n").expect("write marker script");
        let host = PtyHost::new();
        let id = "session:concurrent".to_string();
        let command = vec!["/bin/sh".to_string(), script.to_string_lossy().into_owned()];
        // Without the barrier the threads rarely overlap inside spawn, and the
        // overlap is exactly what this guards.
        let gate = Arc::new(std::sync::Barrier::new(2));
        let handles: Vec<_> = (0..2)
            .map(|_| {
                let host = host.clone();
                let id = id.clone();
                let command = command.clone();
                let gate = gate.clone();
                thread::spawn(move || {
                    gate.wait();
                    host.spawn(id, "/".to_string(), command, 80, 24)
                })
            })
            .collect();
        for handle in handles {
            handle.join().expect("spawn thread panicked").expect("spawn failed");
        }
        thread::sleep(Duration::from_millis(300));
        let spawned = marker_children(&marker);

        host.kill(&id);
        thread::sleep(KILL_ESCALATE + Duration::from_millis(700));
        let survivors = marker_children(&marker);
        let _ = std::process::Command::new("pkill").args(["-f", &marker]).status();
        let _ = std::fs::remove_file(&script);

        assert_eq!(spawned, 1, "two concurrent spawns left {spawned} children");
        assert_eq!(survivors, 0, "kill left {survivors} children running");
    }

    fn pty_child(script: &str) -> (i32, std::process::Child) {
        let (master, slave) = open_pty(80, 24).expect("open pty");
        let args = vec!["-c".to_string(), script.to_string()];
        let child = pty_command("/bin/sh", &args, std::path::Path::new("/"), slave)
            .expect("command")
            .spawn()
            .expect("spawn");
        close_fd(slave);
        (master, child)
    }

    fn exits_within(child: &mut std::process::Child, limit: Duration) -> bool {
        let deadline = Instant::now() + limit;
        while Instant::now() < deadline {
            if child.try_wait().expect("try_wait").is_some() {
                return true;
            }
            thread::sleep(Duration::from_millis(20));
        }
        let _ = child.kill();
        let _ = child.wait();
        false
    }

    #[test]
    fn a_pty_child_inherits_nothing_but_its_terminal() {
        // Stands in for what Electron hands crewd: open, and not close-on-exec.
        let inherited = unsafe { libc::open(c"/dev/null".as_ptr(), libc::O_RDONLY) };
        assert!(inherited > 2);
        // A second terminal open at the same time, as another tab's would be.
        let (other_master, mut other) = pty_child("exec sleep 30");
        let (master, mut child) = pty_child("exec ls /dev/fd");
        let mut out = Vec::new();
        let mut buf = [0_u8; 4096];
        loop {
            let n = unsafe { libc::read(master, buf.as_mut_ptr().cast(), buf.len()) };
            if n <= 0 {
                break;
            }
            out.extend_from_slice(&buf[..n as usize]);
        }
        let _ = child.wait();
        close_fd(master);
        close_fd(other_master);
        let _ = other.kill();
        let _ = other.wait();
        close_fd(inherited);

        let listing = String::from_utf8_lossy(&out).into_owned();
        let fds: Vec<i32> = listing.split_whitespace().filter_map(|fd| fd.parse().ok()).collect();
        assert!(fds.contains(&0) && fds.contains(&2), "no listing: {listing:?}");
        // 3 is the directory ls itself opened to list /dev/fd.
        assert!(fds.iter().all(|fd| *fd <= 3), "the child kept {fds:?}");
    }

    #[test]
    fn closing_its_master_hangs_up_the_child_while_other_terminals_live() {
        // Both masters are open while both children start, so each child
        // could inherit the other's master as well as its own.
        let (first_master, mut first) = pty_child("exec sleep 30");
        let (second_master, mut second) = pty_child("exec sleep 30");
        thread::sleep(Duration::from_millis(100));

        // What a crewd crash does to the first terminal: its master goes away.
        close_fd(first_master);
        let first_hung_up = exits_within(&mut first, Duration::from_secs(5));
        let second_alive = second.try_wait().expect("try_wait").is_none();
        close_fd(second_master);
        let second_hung_up = exits_within(&mut second, Duration::from_secs(5));

        assert!(first_hung_up, "the child outlived its terminal's master");
        assert!(second_alive, "closing one terminal hung up another");
        assert!(second_hung_up, "the second child outlived its master");
    }

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

    /// What the hub would have sent: frames per stream and resyncs per id.
    #[derive(Default)]
    struct Recorder {
        forwarded: std::sync::atomic::AtomicU64,
        resyncs: std::sync::atomic::AtomicU32,
    }

    impl PtyEvents for Recorder {
        fn data(&self, _stream_id: u32, bytes: &[u8]) {
            self.forwarded.fetch_add(bytes.len() as u64, Ordering::Relaxed);
        }
        fn exit(&self, _id: &str, _code: Option<i32>) {}
        fn resync(&self, _id: &str) {
            self.resyncs.fetch_add(1, Ordering::Relaxed);
        }
    }

    #[derive(Default)]
    struct Collect {
        bytes: std::sync::atomic::AtomicU64,
        exit: Mutex<Option<Option<i32>>>,
    }

    impl PtySink for Collect {
        fn output(&self, bytes: &[u8]) {
            self.bytes.fetch_add(bytes.len() as u64, Ordering::Relaxed);
        }
        fn exit(&self, code: Option<i32>) {
            *self.exit.lock().unwrap() = Some(code);
        }
    }

    fn emitted(host: &PtyHost, id: &str) -> u64 {
        host.get(id)
            .map(|live| live.state.lock().unwrap_or_else(|e| e.into_inner()).emitted)
            .unwrap_or(0)
    }

    fn flood(bytes: u64) -> Vec<String> {
        // `yes` never ends on its own; head closes the pipe once it has enough.
        vec!["/bin/sh".into(), "-c".into(), format!("yes 0123456789abcdef | head -c {bytes}")]
    }

    #[test]
    fn a_terminal_nobody_acks_stops_draining_at_the_high_water_mark() {
        let host = PtyHost::new();
        let recorder = Arc::new(Recorder::default());
        host.set_events(recorder.clone());
        host.spawn("t".into(), "/".into(), flood(20_000_000), 80, 24).expect("spawn");
        thread::sleep(Duration::from_millis(1500));
        let reached = emitted(&host, "t");
        host.kill("t");

        // One chunk may land past the check, and one more is being coalesced.
        assert!(reached >= FLOW_HIGH, "drained only {reached}");
        assert!(reached <= FLOW_HIGH + 2 * READ_CHUNK as u64, "drained {reached} with no credit");
        assert_eq!(recorder.resyncs.load(Ordering::Relaxed), 0);
    }

    #[test]
    fn a_supervised_pty_drains_everything_with_nobody_watching() {
        let host = PtyHost::new();
        let recorder = Arc::new(Recorder::default());
        host.set_events(recorder.clone());
        let sink = Arc::new(Collect::default());
        let options = SpawnOptions {
            supervised: Some(sink.clone()),
            ..SpawnOptions::default()
        };
        host.spawn_with("p".into(), "/".into(), flood(4_000_000), 80, 24, options)
            .expect("spawn");
        let deadline = Instant::now() + Duration::from_secs(20);
        while sink.exit.lock().unwrap().is_none() && Instant::now() < deadline {
            thread::sleep(Duration::from_millis(20));
        }

        assert_eq!(*sink.exit.lock().unwrap(), Some(Some(0)), "the flood never finished");
        // The terminal turns each \n into \r\n, so there is more than was written.
        assert!(sink.bytes.load(Ordering::Relaxed) >= 4_000_000);
        let forwarded = recorder.forwarded.load(Ordering::Relaxed);
        assert!(forwarded <= VIEWER_HIGH + READ_CHUNK as u64, "forwarded {forwarded} with no credit");
        assert_eq!(recorder.resyncs.load(Ordering::Relaxed), 1, "one resync per fall behind");
    }

    #[test]
    fn a_supervised_viewer_that_falls_behind_resyncs_once_and_attach_resumes_it() {
        let mut state = PtyState {
            ring: Ring::default(),
            emitted: VIEWER_HIGH,
            acked: 0,
            behind: false,
        };
        assert_eq!(forward(&mut state), Forward::Send);
        state.emitted += 1;
        assert_eq!(forward(&mut state), Forward::Resync);
        state.acked = state.emitted;
        assert_eq!(forward(&mut state), Forward::Drop, "only an attach clears it");

        let host = PtyHost::new();
        let live = Arc::new(
            LivePty::new(Box::new(std::io::sink()), -1, 1, 9)
                .with_sink(Some(Arc::new(Collect::default()))),
        );
        {
            let mut state = live.state.lock().unwrap_or_else(|e| e.into_inner());
            state.ring.push(&[1; 64]);
            state.ring.start = 5_000_000;
            state.emitted = 5_000_064;
            state.behind = true;
        }
        host.insert("p".into(), live.clone());
        let attached = host.attach("p", 0, |_, _, _| {}).unwrap();
        let mut state = live.state.lock().unwrap_or_else(|e| e.into_inner());
        assert_eq!(attached.start, 5_000_000);
        assert_eq!(state.acked, 5_000_000, "credit restarts at the replay");
        assert_eq!(forward(&mut state), Forward::Send);
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
