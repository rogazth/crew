//! A fake remote MCP server with its own OAuth, on 127.0.0.1, for trying
//! connectors and the vault by hand: `cargo run -p crewd --example
//! fake_connector`. It prints its MCP URL; a daemon needs
//! `CREW_CONNECTORS_INSECURE=1` to sign in to it.

use crew_core::connectors::fake_server::{self, Options};

#[tokio::main]
async fn main() {
    let server = fake_server::start(Options::default()).await;
    println!("{}", server.mcp_url);
    tokio::signal::ctrl_c().await.ok();
}
