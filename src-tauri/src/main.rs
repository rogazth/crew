#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::process::ExitCode;

/// The same binary serves the app and, inside an agent's process tree, the
/// MCP server or CLI that talks back to it.
fn main() -> ExitCode {
    let args: Vec<String> = std::env::args().skip(1).collect();
    match args.first().map(String::as_str) {
        Some("--mcp") => crew_core::mcp::serve_stdio(),
        Some("call") => crew_core::mcp::call(&args[1..]),
        _ => {
            crew_lib::run();
            ExitCode::SUCCESS
        }
    }
}
