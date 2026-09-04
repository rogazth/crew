use crew_core::pty::PtyHost;
use crewd::{serve, Config};

fn main() {
    let handle = serve(Config {
        pty: PtyHost::new(),
    })
    .expect("crewd");
    println!("{}", handle.url());
    std::thread::park();
}
