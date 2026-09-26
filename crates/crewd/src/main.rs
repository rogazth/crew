use std::io::{self, Read, Seek, Write};
use std::path::{Path, PathBuf};
use std::process::ExitCode;
use std::sync::mpsc;
use std::thread;
use std::time::Duration;

use crew_core::agent::AgentHost;
use crew_core::bridge::{Bridge, StartError};
use crew_core::process::ProcessHost;
use crew_core::pty::PtyHost;
use crew_core::store::Store;
use crew_protocol::{DaemonFile, DaemonInfo};
use crewd::{remove_daemon_file, serve, write_daemon_file, Config};

const USAGE: &str = "\
usage: crewd --data-dir <dir>   run the daemon (the Crew app does this)
       crewd --data-dir <dir> --supervised-by launchd
                                run it as the LaunchAgent `crew daemon install` writes

Kept for one version, for agents and configs that still name them:
  crewd --mcp                   now `crew mcp`
  crewd call <tool> [json]      now `crew call`";

fn main() -> ExitCode {
    let args: Vec<String> = std::env::args().skip(1).collect();
    match args.first().map(String::as_str) {
        // Only ever from a session's environment, as before: `crew mcp` also
        // falls back to daemon.json, which an old config naming crewd never
        // asked for.
        Some("--mcp") => crew_core::mcp::serve_stdio(),
        // The very command `crew call` is, so the alias cannot drift from it.
        Some("call") => crew_cli::run_from(std::iter::once("crew".to_string()).chain(args)),
        Some("-h" | "--help" | "help") => {
            println!("{USAGE}");
            ExitCode::SUCCESS
        }
        _ => daemon(&args),
    }
}

/// Who started this daemon, which decides how it hears it should stop.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Supervisor {
    /// The dev app's child: it reads the handshake line, and the end of stdin
    /// is the app going away, even when the app was killed and sent nothing.
    Parent,
    /// launchd, as the LaunchAgent: stdin is /dev/null and stdout a log file,
    /// so there is no handshake to print (the log would hold the token) and
    /// no EOF to wait for. A signal or `daemon_shutdown` stops it.
    Launchd,
}

fn supervisor(args: &[String]) -> Result<Supervisor, String> {
    let mut args = args.iter();
    while let Some(arg) = args.next() {
        let named = match arg.strip_prefix("--supervised-by=") {
            Some(name) => Some(name),
            None if arg == "--supervised-by" => args.next().map(String::as_str),
            None => continue,
        };
        return match named {
            Some("launchd") => Ok(Supervisor::Launchd),
            other => Err(format!("--supervised-by takes `launchd`, not {:?}", other.unwrap_or(""))),
        };
    }
    Ok(Supervisor::Parent)
}

/// Why a start did not get as far as serving.
#[derive(Debug)]
enum Failure {
    /// Fails the same way however often it is tried: a data dir it cannot
    /// use, a database it cannot open or migrate, another daemon already
    /// serving the data dir.
    Permanent(String),
    /// May pass: the WebSocket listener or the bridge not binding, a thread
    /// that did not spawn.
    Transient(String),
}

impl Failure {
    fn message(&self) -> &str {
        match self {
            Failure::Permanent(message) | Failure::Transient(message) => message,
        }
    }
}

/// Transient failures in a row, under launchd, before crewd takes one for
/// permanent after all. Counted in a file because each is a new process.
const TRANSIENT_TRIES: u32 = 5;
const FAILED_STARTS: &str = "crewd.failed-starts";

/// How a failed start exits decides what its supervisor does next. The app
/// reads a non-zero exit as "crewd failed" and says so. launchd reads it as a
/// crash and, through `KeepAlive { SuccessfulExit: false }`, starts crewd
/// again every ten seconds for as long as the user is logged in, Crew open or
/// not. So under launchd a permanent failure is logged and exits 0, which
/// leaves it down: the app sees no daemon come up, runs crewd as its child
/// instead, and that child fails the same way where the app shows it. A
/// transient one exits 1 for launchd to retry, a few times at most.
fn daemon(args: &[String]) -> ExitCode {
    let supervisor = match supervisor(args) {
        Ok(supervisor) => supervisor,
        Err(error) => {
            eprintln!("{error}");
            return ExitCode::FAILURE;
        }
    };
    let dir = data_dir(args);
    let failed_starts = dir.join(FAILED_STARTS);
    let failure = match run(&dir, supervisor) {
        Ok(()) => return ExitCode::SUCCESS,
        Err(failure) => failure,
    };
    if supervisor == Supervisor::Parent {
        eprintln!("{}", failure.message());
        return ExitCode::FAILURE;
    }
    let tries = match failure {
        Failure::Permanent(_) => TRANSIENT_TRIES,
        Failure::Transient(_) => {
            let before: u32 =
                std::fs::read_to_string(&failed_starts).ok().and_then(|text| text.trim().parse().ok()).unwrap_or(0);
            let _ = std::fs::write(&failed_starts, (before + 1).to_string());
            before + 1
        }
    };
    if tries < TRANSIENT_TRIES {
        eprintln!("[crewd] couldn't start ({tries} of {TRANSIENT_TRIES}), launchd will try again: {}", failure.message());
        return ExitCode::FAILURE;
    }
    let _ = std::fs::remove_file(&failed_starts);
    eprintln!("[crewd] couldn't start, and won't be restarted until Crew opens: {}", failure.message());
    ExitCode::SUCCESS
}

fn run(dir: &Path, supervisor: Supervisor) -> Result<(), Failure> {
    // First, before anything there is to clean up: a SIGTERM during startup
    // (launchd's bootout, the app quitting) is heard, and ends in the same
    // cleanup as any stop, instead of killing crewd half started.
    let (stop, stopped) = mpsc::channel();
    watch_signals(stop.clone()).map_err(Failure::Transient)?;
    if supervisor == Supervisor::Launchd {
        tidy_log_every(dir.join(crew_cli::launch_agent::LOG));
        eprintln!("[crewd] {} starting, pid {}", env!("CARGO_PKG_VERSION"), std::process::id());
    }
    // Set before any thread starts; every terminal inherits it.
    let bind = dir.join("claude-bind");
    std::fs::create_dir_all(&bind).map_err(|e| Failure::Permanent(format!("{}: {e}", bind.display())))?;
    std::env::set_var(crew_core::provider_session::CLAUDE_BIND_ENV, &bind);
    // Before anything else is opened: a daemon already serving this data dir
    // owns its database too.
    let bridge = Bridge::start(dir.to_path_buf()).map_err(|error| match error {
        StartError::Taken(_) => Failure::Permanent(error.to_string()),
        StartError::Failed(message) => Failure::Transient(format!("bridge: {message}")),
    })?;
    let started = start(dir, &bridge);
    let (pty, agents, processes, handle) = match started {
        Ok(started) => started,
        Err(failure) => {
            bridge.shutdown();
            return Err(failure);
        }
    };
    let _ = std::fs::remove_file(dir.join(FAILED_STARTS));

    let info = DaemonInfo {
        url: handle.url().to_string(),
        token: handle.token().to_string(),
    };
    // Asked to stop while it was starting: nobody is told it is up.
    let early = stopped.try_recv().is_ok();
    if !early {
        // Before the handshake line, so whoever waits on that line can rely on
        // the file. A daemon that cannot write it still serves the window.
        if let Err(error) = write_daemon_file(
            dir,
            &DaemonFile {
                url: info.url.clone(),
                token: info.token.clone(),
                socket: bridge.socket_path(),
                user_token: bridge.user_token(),
                version: env!("CARGO_PKG_VERSION").to_string(),
                pid: Some(std::process::id()),
            },
        ) {
            eprintln!("[crewd] daemon.json: {error}");
        }
        if supervisor == Supervisor::Parent {
            let mut stdout = io::stdout();
            let line = serde_json::to_string(&info).map_err(|e| Failure::Transient(e.to_string()))?;
            let _ = writeln!(stdout, "{line}").and_then(|_| stdout.flush());
        }
        wait_for_exit(stop, stopped, supervisor == Supervisor::Parent, handle.exit_requests());
    }
    if supervisor == Supervisor::Launchd {
        eprintln!("[crewd] stopping");
    }

    remove_daemon_file(dir, &info.url);
    // First, so a process killed below is not restarted on its way out, and
    // so supervised ones get their stop grace before the PTY host's one second.
    processes.shutdown();
    pty.kill_all();
    agents.kill_all();
    bridge.shutdown();
    handle.shutdown();
    Ok(())
}

/// Everything after the bridge: the hosts, the database, the WebSocket.
fn start(dir: &Path, bridge: &Bridge) -> Result<(PtyHost, AgentHost, ProcessHost, crewd::Handle), Failure> {
    crew_core::shell_path::prewarm();
    let pty = PtyHost::new();
    let agents = AgentHost::new();
    let store = Store::open(dir.join("crew.sqlite3")).map_err(|e| Failure::Permanent(format!("database: {e}")))?;
    let processes = ProcessHost::new(store.clone(), pty.clone(), dir);
    let handle = serve(Config {
        pty: pty.clone(),
        store,
        processes: processes.clone(),
        agents: agents.clone(),
        bridge: bridge.clone(),
    })
    .map_err(Failure::Transient)?;
    Ok((pty, agents, processes, handle))
}

fn data_dir(args: &[String]) -> PathBuf {
    let mut args = args.iter();
    while let Some(arg) = args.next() {
        if let Some(path) = arg.strip_prefix("--data-dir=") {
            return PathBuf::from(path);
        }
        if arg == "--data-dir" {
            if let Some(path) = args.next() {
                return PathBuf::from(path);
            }
            break;
        }
    }
    std::env::temp_dir().join(format!("crewd-{}", std::process::id()))
}

/// launchd never rotates what it appends to, and a daemon that runs from login
/// to logout for months would grow it without end.
const LOG_CAP: u64 = 10 * 1024 * 1024;
/// What is kept of a log that went past the cap, in `crewd.log.1`: the lines
/// just before it was emptied are the ones someone may be looking for.
const LOG_KEEP: u64 = 1024 * 1024;
/// Often enough that even a chatty process cannot put much past the cap.
const LOG_CHECK: Duration = Duration::from_secs(5 * 60);

/// Now and then, for as long as crewd runs: a cap checked only at startup
/// never applies to a daemon that stays up.
fn tidy_log_every(path: PathBuf) {
    tidy_log(&path, LOG_CAP, LOG_KEEP);
    let _ = thread::Builder::new().name("crewd-log".into()).spawn(move || loop {
        thread::sleep(LOG_CHECK);
        tidy_log(&path, LOG_CAP, LOG_KEEP);
    });
}

/// launchd opened the log before crewd ran, with the umask's mode, and the log
/// can hold what a turn printed; so it is made private. Past `cap` its tail is
/// copied aside and it is emptied in place. It cannot be renamed away:
/// launchd's descriptor (crewd's own stdout and stderr) would follow it. It is
/// opened for appending, though, so after the truncation the next line lands
/// at the start rather than past a hole.
fn tidy_log(path: &Path, cap: u64, keep: u64) {
    use std::os::unix::fs::{OpenOptionsExt, PermissionsExt};
    let private = std::fs::Permissions::from_mode(0o600);
    let Ok(meta) = std::fs::metadata(path) else { return };
    let _ = std::fs::set_permissions(path, private.clone());
    if meta.len() <= cap {
        return;
    }
    let old = path.with_extension("log.1");
    let tail = std::fs::File::open(path).and_then(|mut log| {
        log.seek(io::SeekFrom::Start(meta.len().saturating_sub(keep)))?;
        let mut tail = Vec::new();
        log.take(keep).read_to_end(&mut tail)?;
        Ok(tail)
    });
    if let Ok(tail) = tail {
        let _ = std::fs::OpenOptions::new()
            .write(true)
            .create(true)
            .truncate(true)
            .mode(0o600)
            .open(&old)
            .and_then(|mut out| out.write_all(&tail));
        let _ = std::fs::set_permissions(&old, private);
    }
    if let Ok(file) = std::fs::OpenOptions::new().write(true).open(path) {
        let _ = file.set_len(0);
    }
}

/// SIGTERM, SIGINT and SIGHUP, each a request to stop. The handlers are
/// registered here, on the caller's thread, so they are in place when this
/// returns; the thread it leaves behind only waits for one to arrive.
fn watch_signals(stop: mpsc::Sender<()>) -> Result<(), String> {
    use tokio::signal::unix::{signal, SignalKind};
    let runtime = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .map_err(|e| format!("signals: {e}"))?;
    let (mut term, mut int, mut hup) = {
        let _entered = runtime.enter();
        let listen = |kind| signal(kind).map_err(|e| format!("signals: {e}"));
        (listen(SignalKind::terminate())?, listen(SignalKind::interrupt())?, listen(SignalKind::hangup())?)
    };
    thread::Builder::new()
        .name("crewd-signal".into())
        .spawn(move || {
            runtime.block_on(async {
                tokio::select! {
                    _ = term.recv() => {}
                    _ = int.recv() => {}
                    _ = hup.recv() => {}
                }
            });
            let _ = stop.send(());
        })
        .map(|_| ())
        .map_err(|e| format!("signals: {e}"))
}

/// Blocks until something says stop: a signal (already watched), a
/// `daemon_shutdown`, or, for the app's child, the end of stdin.
fn wait_for_exit(
    stop: mpsc::Sender<()>,
    stopped: mpsc::Receiver<()>,
    watch_stdin: bool,
    requests: Option<mpsc::Receiver<()>>,
) {
    if watch_stdin {
        thread::Builder::new()
            .name("crewd-stdin".into())
            .spawn({
                let stop = stop.clone();
                move || {
                    let mut stdin = io::stdin();
                    let mut buf = [0u8; 64];
                    loop {
                        match stdin.read(&mut buf) {
                            Ok(0) | Err(_) => {
                                let _ = stop.send(());
                                return;
                            }
                            Ok(_) => {}
                        }
                    }
                }
            })
            .expect("stdin watcher");
    }

    if let Some(requests) = requests {
        thread::Builder::new()
            .name("crewd-exit".into())
            .spawn(move || {
                if requests.recv().is_ok() {
                    let _ = stop.send(());
                }
            })
            .expect("exit watcher");
    }

    let _ = stopped.recv();
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::os::unix::fs::{OpenOptionsExt, PermissionsExt};

    /// It used to be checked only at startup. What launchd holds is an
    /// appending descriptor, and it has to keep writing into the same, now
    /// short, file.
    #[test]
    fn a_log_past_the_cap_is_emptied_in_place_and_its_tail_kept_privately() {
        let dir = std::env::temp_dir().join(format!("crewd-log-{}", std::process::id()));
        std::fs::create_dir_all(&dir).expect("dir");
        let path = dir.join("crewd.log");
        let old = dir.join("crewd.log.1");
        let _ = std::fs::remove_file(&old);
        std::fs::write(&path, "").expect("log");
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o644)).expect("mode");
        let mut launchd = std::fs::OpenOptions::new().append(true).mode(0o644).open(&path).expect("open");
        launchd.write_all(&[b'a'; 100]).expect("write");
        launchd.write_all(b"the last line\n").expect("write");

        tidy_log(&path, 1000, 64);
        assert_eq!(std::fs::read(&path).expect("read").len(), 114, "under the cap it stays");
        assert_eq!(std::fs::metadata(&path).expect("meta").permissions().mode() & 0o777, 0o600);

        tidy_log(&path, 100, 20);
        assert_eq!(std::fs::read_to_string(&path).expect("read"), "");
        assert_eq!(std::fs::read_to_string(&old).expect("old"), "aaaaaathe last line\n");
        assert_eq!(std::fs::metadata(&old).expect("meta").permissions().mode() & 0o777, 0o600);
        launchd.write_all(b"next\n").expect("write");
        assert_eq!(std::fs::read_to_string(&path).expect("read"), "next\n", "written past a hole");
    }
}
