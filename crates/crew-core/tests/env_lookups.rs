//! Behavior that reads the process environment: HOME, PATH, SHELL, the locale
//! and colour variables, and the providers' own. Each test rewrites the
//! environment, so they live in their own binary and take turns on it.

use std::os::unix::fs::PermissionsExt;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, MutexGuard};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use crew_core::agent::{AgentEvents, AgentHost};
use crew_core::pty::{PtyEvents, PtyHost};
use crew_core::{provider_session, shell_path};
use rusqlite::Connection;

static ENV: Mutex<()> = Mutex::new(());

/// The environment for one test: HOME and PATH point into a fresh directory,
/// and nothing else a lookup reads is set. SHELL goes too, so the search path
/// never asks the machine's login shell.
struct Sandbox {
    root: tempfile::TempDir,
    _turn: MutexGuard<'static, ()>,
}

impl Sandbox {
    fn new() -> Self {
        let turn = ENV.lock().unwrap_or_else(|e| e.into_inner());
        let root = tempfile::Builder::new()
            .prefix("c")
            .tempdir_in("/tmp")
            .expect("temp dir");
        std::fs::create_dir_all(root.path().join("home")).unwrap();
        std::fs::create_dir_all(root.path().join("bin")).unwrap();
        std::env::set_var("HOME", root.path().join("home"));
        std::env::set_var("PATH", root.path().join("bin"));
        for key in [
            "SHELL",
            "CODEX_HOME",
            "XDG_DATA_HOME",
            provider_session::CLAUDE_BIND_ENV,
            "LANG",
            "FORCE_COLOR",
            "NO_COLOR",
            "CLICOLOR",
        ] {
            std::env::remove_var(key);
        }
        // The suite itself may run inside a Claude Code session.
        for (key, _) in std::env::vars_os() {
            let key = key.to_string_lossy().into_owned();
            if key == "CLAUDECODE" || key.starts_with("CLAUDE_CODE_") {
                std::env::remove_var(key);
            }
        }
        // Settles the login-shell part of the search path while SHELL is unset,
        // so no test's fake shell is ever asked for it.
        shell_path::joined();
        Self { root, _turn: turn }
    }

    fn home(&self, relative: &str) -> PathBuf {
        self.root.path().join("home").join(relative)
    }

    fn at(&self, relative: &str) -> PathBuf {
        let path = self.root.path().join(relative);
        std::fs::create_dir_all(&path).unwrap();
        path
    }
}

fn executable(path: &Path, body: &str) -> PathBuf {
    std::fs::create_dir_all(path.parent().unwrap()).unwrap();
    std::fs::write(path, format!("#!/bin/sh\n{body}\n")).unwrap();
    std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o755)).unwrap();
    path.to_path_buf()
}

fn text(path: &Path) -> String {
    path.to_string_lossy().into_owned()
}

fn eventually(what: &str, mut check: impl FnMut() -> bool) {
    let start = Instant::now();
    while !check() {
        assert!(start.elapsed() < Duration::from_secs(10), "{what} did not happen in time");
        std::thread::sleep(Duration::from_millis(5));
    }
}

#[derive(Default)]
struct Screen(Mutex<Vec<u8>>);

impl PtyEvents for Screen {
    fn data(&self, _stream_id: u32, bytes: &[u8]) {
        self.0.lock().unwrap_or_else(|e| e.into_inner()).extend_from_slice(bytes);
    }
    fn exit(&self, _id: &str, _code: Option<i32>) {}
}

/// What a terminal with no command prints, given a fake shell that reports
/// its arguments, directory and the variables Crew sets or clears.
fn bare_terminal(env: &Sandbox, shell_name: &str) -> String {
    let shell = executable(
        &env.at("shells").join(shell_name),
        r#"printf 'args=%s|pwd=%s|lang=%s|force=%s|no=%s|cli=%s|done\n' "$*" "$(pwd)" "$LANG" "${FORCE_COLOR-unset}" "${NO_COLOR-unset}" "${CLICOLOR-unset}""#,
    );
    std::env::set_var("SHELL", &shell);
    let host = PtyHost::new();
    let screen = Arc::new(Screen::default());
    host.set_events(screen.clone());
    host.spawn("t".into(), "/nonexistent/dir".into(), Vec::new(), 80, 24).unwrap();
    let text = || String::from_utf8_lossy(&screen.0.lock().unwrap_or_else(|e| e.into_inner())).into_owned();
    eventually("the shell's report", || text().contains("|done"));
    host.kill("t");
    text().trim().to_string()
}

fn now_ms() -> i64 {
    SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_millis() as i64
}

fn rollout(codex_home: &Path, file: &str, id: &str, cwd: &Path) {
    let day = codex_home.join("sessions/2026/09/22");
    std::fs::create_dir_all(&day).unwrap();
    let meta = serde_json::json!({
        "type": "session_meta",
        "payload": { "id": id, "cwd": cwd, "source": "cli" }
    });
    std::fs::write(day.join(file), format!("{meta}\n")).unwrap();
}

fn opencode_db(db: &Path, rows: &[(&str, Option<&str>, &Path, i64, &str)]) {
    std::fs::create_dir_all(db.parent().unwrap()).unwrap();
    let conn = Connection::open(db).unwrap();
    conn.execute_batch(
        "CREATE TABLE session (id TEXT, parent_id TEXT, directory TEXT, time_created INTEGER, title TEXT);",
    )
    .unwrap();
    for (id, parent, dir, created, title) in rows {
        conn.execute(
            "INSERT INTO session VALUES (?1, ?2, ?3, ?4, ?5)",
            rusqlite::params![id, parent, text(dir), created, title],
        )
        .unwrap();
    }
}

#[test]
fn a_cli_in_the_home_install_dirs_wins_over_path() {
    let env = Sandbox::new();
    let local = executable(&env.home(".local/bin/crew-fake-cli"), "exit 0");
    let on_path = executable(&env.at("bin").join("crew-fake-cli"), "exit 0");

    assert_eq!(shell_path::resolve("crew-fake-cli"), Some(local.clone()));
    assert_eq!(AgentHost::resolve("crew-fake-cli").map(|b| b.path), Ok(text(&local)));

    std::fs::set_permissions(&local, std::fs::Permissions::from_mode(0o644)).unwrap();
    assert_eq!(shell_path::resolve("crew-fake-cli"), Some(on_path));
}

#[test]
fn a_cli_nowhere_on_the_search_path_is_reported_missing() {
    let _env = Sandbox::new();
    assert_eq!(shell_path::resolve("crew-no-such-cli"), None);
    assert_eq!(
        AgentHost::resolve("crew-no-such-cli").map(|b| b.path),
        Err("`crew-no-such-cli` was not found on your PATH.".to_string())
    );
}

#[test]
fn claude_is_found_where_its_installer_puts_it() {
    let env = Sandbox::new();
    let claude = executable(&env.home(".local/bin/claude"), "exit 0");
    assert_eq!(AgentHost::resolve_claude().map(|b| b.path), Ok(text(&claude)));
}

#[test]
fn installed_keeps_only_the_names_found_on_the_search_path() {
    let env = Sandbox::new();
    executable(&env.at("bin").join("crew-fake-codex"), "exit 0");
    executable(&env.home(".cargo/bin/crew-fake-opencode"), "exit 0");
    let names = [
        "crew-fake-codex",
        "crew-no-such-cli",
        "crew-fake-opencode",
        "bin/crew-fake-codex",
    ];
    assert_eq!(
        AgentHost::installed(names.iter().map(|n| n.to_string()).collect()),
        ["crew-fake-codex", "crew-fake-opencode"]
    );
}

#[test]
fn codex_sessions_are_found_under_codex_home() {
    let env = Sandbox::new();
    let work = env.at("work");
    let codex = env.at("codex");
    std::env::set_var("CODEX_HOME", &codex);
    rollout(&codex, "rollout-1.jsonl", "taken", &work);
    rollout(&codex, "rollout-2.jsonl", "mine", &work);
    rollout(&codex, "rollout-3.jsonl", "elsewhere", &env.at("other"));

    let claimed = ["taken".to_string()];
    assert_eq!(
        provider_session::discover("codex", &text(&work), 0, &claimed).as_deref(),
        Some("mine")
    );
    assert_eq!(
        provider_session::discover("codex", &text(&work), now_ms() + 60_000, &[]),
        None
    );
}

#[test]
fn codex_falls_back_to_the_home_folder_for_sessions_and_titles() {
    let env = Sandbox::new();
    std::env::set_var("CODEX_HOME", "");
    let work = env.at("work");
    let codex = env.home(".codex");
    rollout(&codex, "rollout-1.jsonl", "mine", &work);
    std::fs::write(
        codex.join("session_index.jsonl"),
        "{\"id\":\"mine\",\"thread_name\":\"  Fix the build  \"}\n{\"id\":\"blank\",\"thread_name\":\"   \"}\n",
    )
    .unwrap();

    assert_eq!(
        provider_session::discover("codex", &text(&work), 0, &[]).as_deref(),
        Some("mine")
    );
    assert_eq!(
        provider_session::title("codex", "mine").as_deref(),
        Some("Fix the build")
    );
    assert_eq!(provider_session::title("codex", "blank"), None);
    assert_eq!(provider_session::title("codex", "unknown"), None);
}

#[test]
fn opencode_sessions_are_read_from_the_xdg_data_dir() {
    let env = Sandbox::new();
    let data = env.at("xdg");
    std::env::set_var("XDG_DATA_HOME", &data);
    let work = env.at("work");
    let now = now_ms();
    opencode_db(
        &data.join("opencode/opencode.db"),
        &[
            ("ses_old", None, &work, now - 3_600_000, "Old"),
            ("ses_new", None, &work, now, "Friendly greeting"),
            ("ses_child", Some("ses_new"), &work, now, "Subagent"),
            (
                "ses_fresh",
                None,
                &env.at("other"),
                now,
                "New session - 2026-09-17T17:59:15.722Z",
            ),
        ],
    );

    assert_eq!(
        provider_session::discover("opencode", &text(&work), now, &[]).as_deref(),
        Some("ses_new")
    );
    assert_eq!(
        provider_session::title("opencode", "ses_new").as_deref(),
        Some("Friendly greeting")
    );
    assert_eq!(provider_session::title("opencode", "ses_fresh"), None);
}

#[test]
fn opencode_falls_back_to_the_home_data_dir() {
    let env = Sandbox::new();
    std::env::set_var("XDG_DATA_HOME", "");
    let work = env.at("work");
    opencode_db(
        &env.home(".local/share/opencode/opencode.db"),
        &[("ses_home", None, &work, now_ms(), "From home")],
    );
    assert_eq!(
        provider_session::discover("opencode", &text(&work), 0, &[]).as_deref(),
        Some("ses_home")
    );
    assert_eq!(
        provider_session::title("opencode", "ses_home").as_deref(),
        Some("From home")
    );
}

#[test]
fn cursor_titles_are_read_from_its_chat_store() {
    let env = Sandbox::new();
    let chat = env.home(".cursor/chats/0eaad84c/5e047119-f117");
    std::fs::create_dir_all(&chat).unwrap();
    std::fs::write(chat.join("meta.json"), r#"{"title":" Spanish Project "}"#).unwrap();
    assert_eq!(
        provider_session::title("cursor", "5e047119-f117").as_deref(),
        Some("Spanish Project")
    );
    assert_eq!(provider_session::title("cursor", "missing"), None);
}

#[test]
fn a_provider_crew_cannot_read_has_no_session_or_title() {
    let env = Sandbox::new();
    let work = env.at("work");
    assert_eq!(provider_session::discover("claude", &text(&work), 0, &[]), None);
    assert_eq!(provider_session::title("claude", "any"), None);
}

#[test]
fn without_a_home_nothing_is_found() {
    let env = Sandbox::new();
    std::env::remove_var("HOME");
    let work = env.at("work");
    assert_eq!(provider_session::discover("codex", &text(&work), 0, &[]), None);
    assert_eq!(provider_session::discover("opencode", &text(&work), 0, &[]), None);
    assert_eq!(provider_session::title("cursor", "5e047119-f117"), None);
}

#[test]
fn the_claude_bind_hook_record_names_the_new_session() {
    let env = Sandbox::new();
    assert_eq!(provider_session::claude_bound("crew-1"), None);

    let bind = env.at("bind");
    std::env::set_var(provider_session::CLAUDE_BIND_ENV, &bind);
    std::fs::write(
        bind.join("crew-1.json"),
        r#"{"session_id":"60eb4dd5-1c2a","source":"clear"}"#,
    )
    .unwrap();
    assert_eq!(
        provider_session::claude_bound("crew-1").as_deref(),
        Some("60eb4dd5-1c2a")
    );
    assert_eq!(provider_session::claude_bound("crew-2"), None);
    assert_eq!(provider_session::claude_bound("../bind/crew-1"), None);
}

#[test]
fn a_cursor_chat_is_created_with_the_cli_on_the_search_path() {
    let env = Sandbox::new();
    executable(
        &env.home(".local/bin/cursor-agent"),
        "[ \"$1\" = create-chat ] || exit 3\necho 5e047119-f117",
    );
    assert_eq!(provider_session::cursor_create_chat().as_deref(), Ok("5e047119-f117"));
}

#[test]
fn a_bare_terminal_runs_the_login_shell_at_home_with_colour_and_a_locale() {
    let env = Sandbox::new();
    std::env::set_var("FORCE_COLOR", "0");
    std::env::set_var("NO_COLOR", "1");
    std::env::set_var("CLICOLOR", "0");
    assert_eq!(
        bare_terminal(&env, "zsh"),
        format!(
            "args=-l|pwd={}|lang=en_US.UTF-8|force=unset|no=unset|cli=unset|done",
            env.home("").display().to_string().trim_end_matches('/')
        )
    );
}

#[test]
fn a_shell_crew_does_not_know_gets_no_login_flag_and_keeps_its_settings() {
    let env = Sandbox::new();
    std::env::set_var("LANG", "fr_FR.UTF-8");
    std::env::set_var("FORCE_COLOR", "1");
    let report = bare_terminal(&env, "nu");
    assert!(
        report.starts_with("args=|") && report.contains("|lang=fr_FR.UTF-8|force=1|"),
        "{report}"
    );
}


/// What Claude Code sets in its own children, and what a parent that turned
/// colour off for its logs sets, plus one variable that is nobody's business.
fn inherit_claude_and_colour() {
    std::env::set_var("CLAUDECODE", "1");
    std::env::set_var("CLAUDE_CODE_ENTRYPOINT", "cli");
    std::env::set_var("CLAUDE_CODE_SSE_PORT", "4242");
    std::env::set_var("CLAUDE_CONFIG_DIR", "/tmp/claude-config");
    std::env::set_var("NO_COLOR", "1");
    std::env::set_var("FORCE_COLOR", "0");
    std::env::set_var("CREW_TEST_KEEP", "kept");
}

fn names(env_lines: &str) -> Vec<String> {
    env_lines
        .lines()
        .filter_map(|line| line.trim_end_matches('\r').split_once('='))
        .map(|(name, _)| name.to_string())
        .collect()
}

#[test]
fn a_terminal_does_not_inherit_the_claude_session_or_the_colour_switches() {
    let _env = Sandbox::new();
    inherit_claude_and_colour();
    let host = PtyHost::new();
    let screen = Arc::new(Screen::default());
    host.set_events(screen.clone());
    host.spawn(
        "t".into(),
        "/".into(),
        vec!["/bin/sh".into(), "-c".into(), "/usr/bin/env; echo END-OF-ENV".into()],
        80,
        24,
    )
    .unwrap();
    let text = || String::from_utf8_lossy(&screen.0.lock().unwrap_or_else(|e| e.into_inner())).into_owned();
    eventually("the child's environment", || text().contains("END-OF-ENV"));
    host.kill("t");

    let seen = names(&text());
    for gone in ["CLAUDECODE", "CLAUDE_CODE_ENTRYPOINT", "CLAUDE_CODE_SSE_PORT", "NO_COLOR", "FORCE_COLOR"] {
        assert!(!seen.iter().any(|name| name == gone), "{gone} reached the terminal: {seen:?}");
    }
    for kept in ["CREW_TEST_KEEP", "CLAUDE_CONFIG_DIR"] {
        assert!(seen.iter().any(|name| name == kept), "{kept} was dropped: {seen:?}");
    }
}

#[derive(Default)]
struct Output {
    lines: Mutex<Vec<String>>,
    exited: Mutex<bool>,
}

impl AgentEvents for Output {
    fn lines(&self, _event: &str, _session_id: &str, lines: Vec<String>) {
        self.lines.lock().unwrap_or_else(|e| e.into_inner()).extend(lines);
    }
    fn exit(&self, _session_id: &str, _code: Option<i32>, _pid: u32) {
        *self.exited.lock().unwrap_or_else(|e| e.into_inner()) = true;
    }
}

#[test]
fn an_agent_does_not_inherit_the_claude_session_it_was_launched_from() {
    let _env = Sandbox::new();
    inherit_claude_and_colour();
    let host = AgentHost::new();
    let output = Arc::new(Output::default());
    host.set_events(output.clone());
    let given = std::collections::HashMap::from([("CREW_TOKEN".to_string(), "t".to_string())]);
    host.spawn("a".into(), "/usr/bin/env".into(), Vec::new(), "/".into(), Some(given)).unwrap();
    eventually("the agent to exit", || *output.exited.lock().unwrap_or_else(|e| e.into_inner()));
    // Its stdout reader may still be handing over the last batch.
    eventually("the agent's output", || {
        output.lines.lock().unwrap_or_else(|e| e.into_inner()).iter().any(|l| l.starts_with("CREW_TEST_KEEP="))
    });

    let seen = names(&output.lines.lock().unwrap_or_else(|e| e.into_inner()).join("\n"));
    for gone in ["CLAUDECODE", "CLAUDE_CODE_ENTRYPOINT", "CLAUDE_CODE_SSE_PORT"] {
        assert!(!seen.iter().any(|name| name == gone), "{gone} reached the agent: {seen:?}");
    }
    for kept in ["CREW_TEST_KEEP", "CLAUDE_CONFIG_DIR", "CREW_TOKEN"] {
        assert!(seen.iter().any(|name| name == kept), "{kept} was dropped: {seen:?}");
    }
}
