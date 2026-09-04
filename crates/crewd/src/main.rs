use crew_core::agent::AgentHost;
use crew_core::bridge::Bridge;
use crew_core::pty::PtyHost;
use crew_core::store::Store;
use crewd::{serve, Config};

fn main() {
    let dir = std::env::temp_dir().join(format!("crewd-{}", std::process::id()));
    let handle = serve(Config {
        pty: PtyHost::new(),
        store: Store::open(dir.join("crew.sqlite3")).expect("store"),
        agents: AgentHost::new(),
        bridge: Bridge::start(dir).expect("bridge"),
    })
    .expect("crewd");
    println!("{}", handle.url());
    std::thread::park();
}
