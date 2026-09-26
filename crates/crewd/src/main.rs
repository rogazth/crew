use std::io::{self, Read, Write};
use std::path::PathBuf;
use std::process::ExitCode;
use std::sync::mpsc;
use std::thread;

use crew_core::agent::AgentHost;
use crew_core::bridge::Bridge;
use crew_core::process::ProcessHost;
use crew_core::pty::PtyHost;
use crew_core::store::Store;
use crew_protocol::{DaemonFile, DaemonInfo};
use crewd::{remove_daemon_file, serve, write_daemon_file, Config};

const USAGE: &str = "\
usage: crewd --data-dir <dir>   run the daemon (the Crew app does this)

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
        _ => match run(&args) {
            Ok(()) => ExitCode::SUCCESS,
            Err(error) => {
                eprintln!("{error}");
                ExitCode::FAILURE
            }
        },
    }
}

fn run(args: &[String]) -> Result<(), String> {
    let dir = data_dir(args);
    // Set before any thread starts; every terminal inherits it.
    let bind = dir.join("claude-bind");
    std::fs::create_dir_all(&bind).map_err(|e| format!("{}: {e}", bind.display()))?;
    std::env::set_var(crew_core::provider_session::CLAUDE_BIND_ENV, &bind);
    crew_core::shell_path::prewarm();
    let pty = PtyHost::new();
    let agents = AgentHost::new();
    let bridge = Bridge::start(dir.clone())?;
    let store = Store::open(dir.join("crew.sqlite3"))?;
    let processes = ProcessHost::new(store.clone(), pty.clone(), &dir);
    let handle = serve(Config {
        pty: pty.clone(),
        store,
        processes: processes.clone(),
        agents: agents.clone(),
        bridge: bridge.clone(),
    })?;

    let info = DaemonInfo {
        url: handle.url().to_string(),
        token: handle.token().to_string(),
    };
    // Before the handshake line, so whoever waits on that line can rely on the
    // file. A daemon that cannot write it still serves the window.
    if let Err(error) = write_daemon_file(
        &dir,
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
    let mut stdout = io::stdout();
    writeln!(
        stdout,
        "{}",
        serde_json::to_string(&info).map_err(|e| e.to_string())?
    )
    .map_err(|e| e.to_string())?;
    stdout.flush().map_err(|e| e.to_string())?;

    wait_for_exit();

    remove_daemon_file(&dir, &info.url);
    // First, so a process killed below is not restarted on its way out, and
    // so supervised ones get their stop grace before the PTY host's one second.
    processes.shutdown();
    pty.kill_all();
    agents.kill_all();
    bridge.shutdown();
    handle.shutdown();
    Ok(())
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

fn wait_for_exit() {
    let (tx, rx) = mpsc::channel();

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
                    tokio::select! {
                        _ = sigterm.recv() => {}
                        _ = sigint.recv() => {}
                        _ = sighup.recv() => {}
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

    let _ = rx.recv();
}
