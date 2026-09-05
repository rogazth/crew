use std::io::{self, Read, Write};
use std::path::PathBuf;
use std::process::ExitCode;
use std::sync::mpsc;
use std::thread;

use crew_core::agent::AgentHost;
use crew_core::bridge::Bridge;
use crew_core::pty::PtyHost;
use crew_core::store::Store;
use crew_protocol::DaemonInfo;
use crewd::{serve, Config};

fn main() -> ExitCode {
    let args: Vec<String> = std::env::args().skip(1).collect();
    match args.first().map(String::as_str) {
        Some("--mcp") => crew_core::mcp::serve_stdio(),
        Some("call") => crew_core::mcp::call(&args[1..]),
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
    let pty = PtyHost::new();
    let agents = AgentHost::new();
    let bridge = Bridge::start(dir.clone())?;
    let handle = serve(Config {
        pty: pty.clone(),
        store: Store::open(dir.join("crew.sqlite3"))?,
        agents: agents.clone(),
        bridge: bridge.clone(),
    })?;

    let info = DaemonInfo {
        url: handle.url().to_string(),
        token: handle.token().to_string(),
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
