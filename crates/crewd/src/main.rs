use std::io::{self, Read, Write};
use std::path::{Path, PathBuf};
use std::process::ExitCode;
use std::sync::mpsc;
use std::thread;

use crew_core::agent::AgentHost;
use crew_core::bridge::Bridge;
use crew_core::pty::PtyHost;
use crew_core::store::Store;
use crew_protocol::DaemonInfo;
use crewd::{machine, serve_on, Config, Handle, Listen};

fn main() -> ExitCode {
    let args: Vec<String> = std::env::args().skip(1).collect();
    match args.first().map(String::as_str) {
        Some("--mcp") => crew_core::mcp::serve_stdio(),
        Some("call") => crew_core::mcp::call(&args[1..]),
        Some("serve") => match run_serve(&args[1..]) {
            Ok(()) => ExitCode::SUCCESS,
            Err(error) => {
                eprintln!("{error}");
                ExitCode::FAILURE
            }
        },
        _ => match run(&args) {
            Ok(()) => ExitCode::SUCCESS,
            Err(error) => {
                eprintln!("{error}");
                ExitCode::FAILURE
            }
        },
    }
}

struct Daemon {
    pty: PtyHost,
    agents: AgentHost,
    bridge: Bridge,
    handle: Handle,
}

impl Daemon {
    fn start(dir: &Path, listen: Listen) -> Result<Self, String> {
        // Set before any thread starts; every terminal inherits it.
        let bind = dir.join("claude-bind");
        std::fs::create_dir_all(&bind).map_err(|e| format!("{}: {e}", bind.display()))?;
        std::env::set_var(crew_core::provider_session::CLAUDE_BIND_ENV, &bind);
        crew_core::shell_path::prewarm();
        let pty = PtyHost::new();
        let agents = AgentHost::new();
        let bridge = Bridge::start(dir.to_path_buf())?;
        let handle = serve_on(
            Config {
                pty: pty.clone(),
                store: Store::open(dir.join("crew.sqlite3"))?,
                agents: agents.clone(),
                bridge: bridge.clone(),
            },
            listen,
        )?;
        Ok(Self { pty, agents, bridge, handle })
    }

    fn stop(self) {
        self.pty.kill_all();
        self.agents.kill_all();
        self.bridge.shutdown();
        self.handle.shutdown();
    }
}

fn run(args: &[String]) -> Result<(), String> {
    let dir = data_dir(args);
    let daemon = Daemon::start(&dir, Listen::local())?;

    let info = DaemonInfo {
        url: daemon.handle.url().to_string(),
        token: daemon.handle.token().to_string(),
    };
    let mut stdout = io::stdout();
    writeln!(
        stdout,
        "{}",
        serde_json::to_string(&info).map_err(|e| e.to_string())?
    )
    .map_err(|e| e.to_string())?;
    stdout.flush().map_err(|e| e.to_string())?;

    wait_for_exit();

    daemon.stop();
    Ok(())
}

/// A daemon that outlives its clients, for a machine the window reaches over
/// the network: it listens where it is told, keeps its token across restarts
/// and stops only on SIGTERM or SIGINT.
fn run_serve(args: &[String]) -> Result<(), String> {
    let addr = flag(args, "--listen").ok_or("crewd serve: --listen <host:port> is required")?;
    let dir = match flag(args, "--data-dir") {
        Some(dir) => PathBuf::from(dir),
        None => std::env::var_os("HOME")
            .map(|home| PathBuf::from(home).join(".crew/data"))
            .ok_or("crewd serve: --data-dir is required when HOME is not set")?,
    };
    std::fs::create_dir_all(&dir).map_err(|e| format!("{}: {e}", dir.display()))?;
    let token = machine::persistent_token(&dir, crewd::random_token)?;
    let daemon = Daemon::start(
        &dir,
        Listen {
            addr,
            token,
            wait_for_addr: true,
        },
    )?;

    // The port, for whoever started it on port 0. The token stays in its file.
    // Best effort: a service whose stdout went away keeps serving.
    let url = daemon.handle.url().to_string();
    let mut stdout = io::stdout();
    let _ = writeln!(stdout, "{}", serde_json::json!({ "url": url }));
    let _ = stdout.flush();
    eprintln!("[crewd] {} serving {url} from {}", env!("CARGO_PKG_VERSION"), dir.display());

    wait_for_signal();

    daemon.stop();
    Ok(())
}

fn flag(args: &[String], name: &str) -> Option<String> {
    let mut args = args.iter();
    while let Some(arg) = args.next() {
        if let Some(value) = arg.strip_prefix(name).and_then(|rest| rest.strip_prefix('=')) {
            return Some(value.to_string());
        }
        if arg == name {
            return args.next().cloned();
        }
    }
    None
}

fn data_dir(args: &[String]) -> PathBuf {
    flag(args, "--data-dir")
        .map(PathBuf::from)
        .unwrap_or_else(|| std::env::temp_dir().join(format!("crewd-{}", std::process::id())))
}

fn wait_for_exit() {
    let (tx, rx) = mpsc::channel();
    watch_signals(tx.clone(), true);

    thread::Builder::new()
        .name("crewd-stdin".into())
        .spawn({
            let tx = tx.clone();
            move || {
                let mut stdin = io::stdin();
                let mut buf = [0u8; 64];
                loop {
                    match stdin.read(&mut buf) {
                        Ok(0) | Err(_) => {
                            let _ = tx.send(());
                            return;
                        }
                        Ok(_) => {}
                    }
                }
            }
        })
        .expect("stdin watcher");

    let _ = rx.recv();
}

fn wait_for_signal() {
    let (tx, rx) = mpsc::channel();
    watch_signals(tx, false);
    let _ = rx.recv();
}

/// Sends once SIGTERM or SIGINT arrives, or SIGHUP when `hangup` holds. A
/// served daemon ignores SIGHUP: the SSH session that started it may close.
fn watch_signals(tx: mpsc::Sender<()>, hangup: bool) {
    thread::Builder::new()
        .name("crewd-signal".into())
        .spawn(move || {
            let Ok(runtime) = tokio::runtime::Builder::new_current_thread().enable_all().build() else {
                return;
            };
            runtime.block_on(async {
                #[cfg(unix)]
                {
                    let Ok(mut sigterm) =
                        tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate())
                    else {
                        return;
                    };
                    let Ok(mut sigint) =
                        tokio::signal::unix::signal(tokio::signal::unix::SignalKind::interrupt())
                    else {
                        return;
                    };
                    let Ok(mut sighup) =
                        tokio::signal::unix::signal(tokio::signal::unix::SignalKind::hangup())
                    else {
                        return;
                    };
                    loop {
                        tokio::select! {
                            _ = sigterm.recv() => break,
                            _ = sigint.recv() => break,
                            _ = sighup.recv() => if hangup { break },
                        }
                    }
                }
                #[cfg(not(unix))]
                {
                    let _ = tokio::signal::ctrl_c().await;
                }
            });
            let _ = tx.send(());
        })
        .expect("signal watcher");
}
