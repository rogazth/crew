//! What a terminal session's CLI needs to reach Crew's tools.
//!
//! The client builds the argv a terminal session starts with (the provider's
//! binary, resume flags, the model) and the daemon completes it here. The
//! client cannot: in remote mode the bridge's socket and the `crewd` binary are
//! the VM's, not the window's.
//!
//! Each provider takes the MCP server the way it does for a bot's turn,
//! with one difference for Claude: no `--strict-mcp-config`, so Crew is added
//! to the user's own servers instead of replacing them. Cursor has no MCP flag
//! and gets the environment alone, for `crew` from its shell.
//!
//! A session handed work by `create_worktree` starts on it: the task goes in
//! as the CLI's first prompt, the way each provider takes one on its command
//! line.

use std::path::Path;

use crate::providers::claude::claude_mcp_config;
use crate::providers::codex::codex_mcp_overrides;
use crate::providers::opencode::opencode_config;

/// How the child reaches the bridge.
pub struct BridgeLink<'a> {
    /// The `crewd` binary, which serves MCP with `--mcp`.
    pub exe: &'a str,
    pub socket: &'a str,
    /// Minted for this one process; see `Bridge::mint_process`.
    pub token: &'a str,
}

#[derive(Debug, PartialEq, Eq)]
pub struct Launch {
    pub argv: Vec<String>,
    pub env: Vec<(String, String)>,
    /// The opening prompt went on the command line. False when argv is not
    /// the provider's binary: a shell has no prompt to take, and the task
    /// waits for a launch that can.
    pub prompted: bool,
}

/// The argv and the environment a terminal session starts with.
///
/// The flags go on only when argv[0] is the provider's own binary: an empty
/// argv is the login shell, and a command the user changed is not one whose
/// flags Crew knows. The environment goes on regardless, so `crew` works
/// from any shell the session opens.
pub fn launch(provider: &str, mut argv: Vec<String>, opening: Option<&str>, link: &BridgeLink<'_>) -> Launch {
    // A first message the window wrote rides after `--`; a task then waits
    // for a launch that has no message of its own.
    let opening = opening.filter(|_| !argv.iter().any(|arg| arg == "--"));
    let mut env = vec![
        ("CREW_SOCKET".to_string(), link.socket.to_string()),
        ("CREW_TOKEN".to_string(), link.token.to_string()),
    ];
    let mcp_args = vec!["--mcp".to_string()];
    let binary = argv
        .first()
        .and_then(|program| Path::new(program).file_name())
        .and_then(|name| name.to_str())
        .unwrap_or("")
        .to_string();
    let mut prompted = opening.is_some();
    match (provider, binary.as_str()) {
        // Last, because `--mcp-config` takes every value up to the next flag;
        // the prompt goes before it, where nothing swallows it. A message
        // after `--` stays last, the flag before the separator.
        ("claude", "claude") => {
            let mcp = ["--mcp-config".to_string(), claude_mcp_config(link.exe, &mcp_args)];
            let at = argv.iter().position(|arg| arg == "--").unwrap_or(argv.len());
            argv.splice(at..at, opening.map(String::from).into_iter().chain(mcp));
        }
        // Right after the binary, on the root command: codex hands root `-c`
        // overrides to `resume` as well, and `resume <id>` wants its id next
        // to it. The prompt is the trailing positional of both.
        ("codex", "codex") => {
            let overrides = codex_mcp_overrides(link.exe, &mcp_args, &env);
            argv.splice(1..1, overrides);
            argv.extend(opening.map(String::from));
        }
        // Its positional is the project folder; the TUI takes a prompt by flag.
        ("opencode", "opencode") => {
            if let Some(config) = opencode_config(Some(&(link.exe.to_string(), mcp_args))) {
                env.push(("OPENCODE_CONFIG_CONTENT".into(), config));
            }
            if let Some(prompt) = opening {
                argv.extend(["--prompt".to_string(), prompt.to_string()]);
            }
        }
        ("cursor", "cursor-agent") => argv.extend(opening.map(String::from)),
        _ => prompted = false,
    }
    Launch { argv, env, prompted }
}

#[cfg(test)]
mod tests {
    use super::*;

    const LINK: BridgeLink<'static> = BridgeLink { exe: "/app/crewd", socket: "/data/crew.sock", token: "t-1" };

    fn argv(parts: &[&str]) -> Vec<String> {
        parts.iter().map(|part| part.to_string()).collect()
    }

    fn crew_env() -> Vec<(String, String)> {
        vec![
            ("CREW_SOCKET".into(), "/data/crew.sock".into()),
            ("CREW_TOKEN".into(), "t-1".into()),
        ]
    }

    const CLAUDE_MCP: &str = r#"{"mcpServers":{"crew":{"args":["--mcp"],"command":"/app/crewd"}}}"#;

    fn codex_mcp() -> Vec<String> {
        argv(&[
            "-c",
            r#"mcp_servers.crew.command="/app/crewd""#,
            "-c",
            r#"mcp_servers.crew.args=["--mcp"]"#,
            "-c",
            r#"mcp_servers.crew.env={CREW_SOCKET="/data/crew.sock",CREW_TOKEN="t-1"}"#,
        ])
    }

    #[test]
    fn claude_adds_crew_to_the_users_servers_on_a_new_session() {
        let out = launch("claude", argv(&["claude", "--settings", "{}", "--session-id", "s1", "--model", "m"]), None, &LINK);
        assert_eq!(
            out.argv,
            argv(&["claude", "--settings", "{}", "--session-id", "s1", "--model", "m", "--mcp-config", CLAUDE_MCP])
        );
        assert!(!out.argv.iter().any(|arg| arg == "--strict-mcp-config"), "the user's servers would be dropped");
        assert_eq!(out.env, crew_env());
    }

    #[test]
    fn claude_resumes_with_crew_after_the_resume_id() {
        let out = launch("claude", argv(&["claude", "--settings", "{}", "--resume", "s1"]), None, &LINK);
        assert_eq!(out.argv, argv(&["claude", "--settings", "{}", "--resume", "s1", "--mcp-config", CLAUDE_MCP]));
    }

    #[test]
    fn codex_takes_crew_on_the_root_command() {
        let out = launch("codex", argv(&["codex", "-m", "gpt-5.5"]), None, &LINK);
        let mut want = argv(&["codex"]);
        want.extend(codex_mcp());
        want.extend(argv(&["-m", "gpt-5.5"]));
        assert_eq!(out.argv, want);
        assert_eq!(out.env, crew_env());
    }

    /// `resume <id>` keeps its id next to it; the overrides go before the
    /// subcommand, where codex passes them on to it.
    #[test]
    fn codex_resumes_with_the_overrides_before_the_subcommand() {
        let out = launch("codex", argv(&["codex", "resume", "abc", "-m", "gpt-5.5"]), None, &LINK);
        let mut want = argv(&["codex"]);
        want.extend(codex_mcp());
        want.extend(argv(&["resume", "abc", "-m", "gpt-5.5"]));
        assert_eq!(out.argv, want);
    }

    #[test]
    fn opencode_takes_crew_on_its_config_env() {
        let out = launch("opencode", argv(&["opencode", "--session", "x"]), None, &LINK);
        assert_eq!(out.argv, argv(&["opencode", "--session", "x"]));
        let config = out
            .env
            .iter()
            .find(|(key, _)| key == "OPENCODE_CONFIG_CONTENT")
            .map(|(_, value)| value.clone())
            .expect("no config");
        let config: serde_json::Value = serde_json::from_str(&config).expect("json");
        assert_eq!(config["mcp"]["crew"]["command"], serde_json::json!(["/app/crewd", "--mcp"]));
        assert!(out.env.starts_with(&crew_env()));
    }

    /// Cursor has no MCP flag: it reaches the bridge with `crew`.
    #[test]
    fn cursor_gets_the_environment_alone() {
        let out = launch("cursor", argv(&["cursor-agent", "--resume", "c1", "--model", "auto"]), None, &LINK);
        assert_eq!(out.argv, argv(&["cursor-agent", "--resume", "c1", "--model", "auto"]));
        assert_eq!(out.env, crew_env());
    }

    /// The task a session was handed is its first prompt, where each CLI
    /// takes one: before Claude's variadic `--mcp-config`, last for codex and
    /// cursor, by flag for opencode, whose positional is a folder.
    #[test]
    fn a_handed_session_starts_on_its_task() {
        let task = Some("## Message\n\nBuild it.");
        let claude = launch("claude", argv(&["claude", "--session-id", "s1"]), task, &LINK);
        assert_eq!(claude.argv, argv(&["claude", "--session-id", "s1", "## Message\n\nBuild it.", "--mcp-config", CLAUDE_MCP]));
        let codex = launch("codex", argv(&["codex", "-m", "gpt-5.5"]), task, &LINK);
        assert_eq!(codex.argv.last().map(String::as_str), task);
        let cursor = launch("cursor", argv(&["cursor-agent", "--resume", "c1"]), task, &LINK);
        assert_eq!(cursor.argv, argv(&["cursor-agent", "--resume", "c1", "## Message\n\nBuild it."]));
        let opencode = launch("opencode", argv(&["opencode"]), task, &LINK);
        assert_eq!(opencode.argv, argv(&["opencode", "--prompt", "## Message\n\nBuild it."]));
        assert!([claude, codex, cursor, opencode].iter().all(|out| out.prompted));
    }

    /// The window's first message is after `--`: the MCP flag goes before it,
    /// where its variadic value cannot take the message, and a task waits.
    #[test]
    fn a_first_message_stays_after_the_separator() {
        let out = launch("claude", argv(&["claude", "--session-id", "s1", "--", "say hi"]), Some("Build it."), &LINK);
        assert_eq!(out.argv, argv(&["claude", "--session-id", "s1", "--mcp-config", CLAUDE_MCP, "--", "say hi"]));
        assert!(!out.prompted);
        let codex = launch("codex", argv(&["codex", "--", "say hi"]), Some("Build it."), &LINK);
        assert_eq!(codex.argv[codex.argv.len() - 2..], argv(&["--", "say hi"]));
        assert!(!codex.prompted);
    }

    /// A shell has nowhere to put a prompt: the task is not taken.
    #[test]
    fn a_shell_leaves_the_task_waiting() {
        let out = launch("claude", argv(&["/bin/zsh", "-l"]), Some("Build it."), &LINK);
        assert_eq!(out.argv, argv(&["/bin/zsh", "-l"]));
        assert!(!out.prompted);
    }

    /// The login shell a session falls back to, or a command that is not the
    /// provider's: no flags Crew cannot vouch for, but `crew` still works.
    #[test]
    fn anything_else_gets_the_environment_alone() {
        assert_eq!(launch("claude", Vec::new(), None, &LINK), Launch { argv: Vec::new(), env: crew_env(), prompted: false });
        let out = launch("claude", argv(&["/bin/zsh", "-l"]), None, &LINK);
        assert_eq!(out.argv, argv(&["/bin/zsh", "-l"]));
        assert_eq!(out.env, crew_env());
    }

    #[test]
    fn a_binary_named_by_its_path_is_still_the_provider() {
        let out = launch("claude", argv(&["/usr/local/bin/claude", "--resume", "s1"]), None, &LINK);
        assert_eq!(out.argv.last().map(String::as_str), Some(CLAUDE_MCP));
    }
}
