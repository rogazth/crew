//! The MCP servers each provider CLI already has on this machine (plan
//! `2026-10-23-integrations.md`, phase 1): their inventory, signing in to
//! them through the CLI, and Off in Crew.
//!
//! The CLI owns its servers. Crew reads them from the CLI's own words, never
//! keeps a header or an environment value (they can be secrets), and leaves a
//! server the user turned off in Crew out of its own spawns:
//!
//! - Claude: `deniedMcpServers` in the `--settings` Crew already passes.
//! - Codex: `mcp_servers.<name>.enabled = false` on `thread/start`, only for a
//!   name Codex has: an override of a name it does not have is a server with
//!   no transport, and Codex refuses the whole config (measured on 0.163.0).
//! - opencode: a disabled stub of the name in the shared server's config,
//!   which reaches it on its next launch. A partial entry is dropped, so the
//!   stub is a whole local entry (measured on 2.1.2, with the user's config in
//!   the old format and in the new one).
//! - Cursor and Grok have no per-spawn way: Off in Crew is the CLI's own
//!   `mcp disable`, so it is off outside Crew too. Grok's is the user's
//!   config; Cursor's is per project, so it is run in each folder Crew's
//!   Cursor sessions work in.
//!
//! Signing in runs through the CLI on this machine, so its credential stays
//! in the CLI's store. Claude takes Crew's redirect and is handed the caught
//! URL; Codex, opencode and Cursor listen on their own loopback, which the
//! caught URL is sent to from here. A URL that carries a code is never logged.

use std::collections::{BTreeMap, BTreeSet, HashMap};
use std::io::{BufRead, BufReader, Write};
use std::net::{SocketAddr, TcpStream};
use std::os::unix::process::CommandExt;
use std::path::{Path, PathBuf};
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::{mpsc, Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant};

use crew_protocol::{McpState, ProviderInventory, ProviderServer, ProviderSignIn};
use serde_json::{json, Map, Value};

use crate::providers::claude::{build_control_request, parse_control_response};
use crate::providers::{as_record, string_field};
use crate::store::{now_millis, Store};

/// Every provider whose servers Crew lists, in the page's order.
pub const PROVIDERS: [&str; 5] = ["claude", "codex", "opencode", "cursor", "grok"];

/// Where a Claude sign-in sends the browser: the redirect Crew's sign-in
/// window catches. Claude falls back to its own loopback for a server with a
/// fixed client, and the page's own `redirect_uri` is what the flow keeps.
pub use crate::connectors::flow::REDIRECT_URI;

/// How long a sign-in waits for its redirect before its process is ended.
const FLOW_TTL: Duration = Duration::from_secs(if cfg!(test) { 20 } else { 15 * 60 });
/// How long a CLI is given to list its servers.
const LIST_TIMEOUT: Duration = Duration::from_secs(30);
/// How long Claude's servers are given to settle: a server takes a few
/// seconds to come up, and nothing says when it has.
const SETTLE: Duration = Duration::from_secs(if cfg!(test) { 3 } else { 15 });
const SETTLE_POLL: Duration = Duration::from_millis(if cfg!(test) { 100 } else { 1500 });
/// How long a CLI is given to start a sign-in, and to finish it once the
/// redirect is in (Claude exchanges the code before it answers).
const SIGN_IN_TIMEOUT: Duration = Duration::from_secs(60);
const FINISH_TIMEOUT: Duration = Duration::from_secs(90);
/// How long `mcp disable` and `mcp enable` may take.
const TOGGLE_TIMEOUT: Duration = Duration::from_secs(20);

/// The `app_state` key, before a provider, of the names off in Crew.
const OFF_KEY: &str = "provider_servers:off:";
/// The folders a Cursor server was disabled in by Crew, by name: turning it
/// back on enables it in each.
const CURSOR_DIRS_KEY: &str = "provider_servers:cursor_dirs";

pub type Listener = Arc<dyn Fn(Vec<ProviderInventory>) + Send + Sync>;

/* ── Off in Crew ─────────────────────────────────────────────────────── */

/// The names the user turned off in Crew for `provider` on this machine.
pub fn off_names(store: &Store, provider: &str) -> BTreeSet<String> {
    crate::store::get(store, format!("{OFF_KEY}{provider}"))
        .ok()
        .flatten()
        .and_then(|raw| serde_json::from_str::<BTreeSet<String>>(&raw).ok())
        .unwrap_or_default()
}

fn write_off(store: &Store, provider: &str, names: &BTreeSet<String>) -> Result<(), String> {
    let key = format!("{OFF_KEY}{provider}");
    if names.is_empty() {
        crate::store::delete(store, key)
    } else {
        crate::store::set(store, key, serde_json::to_string(names).map_err(|e| e.to_string())?)
    }
}

/// What a spawn leaves out: the names off in Crew, but never Crew's own server
/// or a connector's, which `keep` names. They are Crew's, not the CLI's.
pub fn spawn_off(store: &Store, provider: &str, keep: &[String]) -> Vec<String> {
    off_names(store, provider).into_iter().filter(|name| name != "crew" && !keep.contains(name)).collect()
}

/// Claude's `deniedMcpServers`, as `--settings` takes it.
pub fn claude_denied(names: &[String]) -> Value {
    Value::Array(names.iter().map(|name| json!({ "serverName": name })).collect())
}

/// The entry that turns one of the user's servers off in opencode's config:
/// a whole local entry that is never started, since a partial one is
/// dropped. Nothing of the user's entry is copied.
pub fn opencode_off_entry() -> Value {
    json!({ "type": "local", "command": ["true"], "disabled": true })
}

/* ── Parsers ─────────────────────────────────────────────────────────── */

fn server(provider: &str, name: String) -> ProviderServer {
    ProviderServer {
        provider: provider.into(),
        name,
        transport: String::new(),
        target: String::new(),
        scope: None,
        state: McpState::Unknown,
        error: None,
        tools: None,
        off_in_crew: false,
        can_sign_in: false,
        can_remove: false,
    }
}

/// A command line as the row shows it: the program and its arguments, never
/// its environment.
fn command_line(command: Option<&str>, args: Option<&Value>) -> String {
    let mut parts: Vec<String> = command.into_iter().map(str::to_string).collect();
    if let Some(args) = args.and_then(Value::as_array) {
        parts.extend(args.iter().filter_map(Value::as_str).map(str::to_string));
    }
    parts.join(" ")
}

fn count(value: Option<&Value>) -> Option<u32> {
    match value? {
        Value::Array(list) => Some(list.len() as u32),
        Value::Object(map) => Some(map.len() as u32),
        Value::Number(n) => n.as_u64().map(|n| n as u32),
        _ => None,
    }
}

fn clip(error: &str) -> String {
    crate::mcp_status::clip(error)
}

fn claude_state(status: &str) -> McpState {
    match status {
        "connected" => McpState::Connected,
        "pending" => McpState::Pending,
        "failed" => McpState::Failed,
        "needs-auth" => McpState::NeedsAuth,
        "disabled" => McpState::Disabled,
        _ => McpState::Unknown,
    }
}

/// Claude's `mcp_status` answer (`mcpServers`): each server's name, status,
/// scope, config and tools. Its headers and env are read past.
pub fn parse_claude(list: &Value) -> Vec<ProviderServer> {
    list.as_array()
        .map(Vec::as_slice)
        .unwrap_or_default()
        .iter()
        .filter_map(|row| {
            let row = as_record(row)?;
            let name = string_field(Some(row), "name")?;
            let config = row.get("config").and_then(as_record);
            let kind = string_field(config, "type").unwrap_or_else(|| "stdio".into());
            let mut out = server("claude", name);
            out.state = claude_state(&string_field(Some(row), "status").unwrap_or_default());
            out.transport = match kind.as_str() {
                "claudeai-proxy" => "claude.ai".into(),
                other => other.to_string(),
            };
            out.target = match string_field(config, "url") {
                Some(url) => url,
                None => command_line(string_field(config, "command").as_deref(), config.and_then(|c| c.get("args"))),
            };
            out.scope = if out.name.starts_with("plugin:") {
                Some("plugin".into())
            } else {
                match string_field(Some(row), "scope").as_deref() {
                    Some("claudeai") => Some("claude.ai".into()),
                    Some(scope @ ("user" | "project" | "local" | "plugin" | "enterprise")) => Some(scope.to_string()),
                    _ => None,
                }
            };
            out.error = string_field(Some(row), "error").filter(|_| out.state == McpState::Failed).map(|e| clip(&e));
            out.tools = count(row.get("tools")).filter(|_| out.state == McpState::Connected);
            // A claude.ai connector is signed in at claude.ai, not here.
            out.can_sign_in = matches!(out.transport.as_str(), "http" | "sse") && out.scope.as_deref() != Some("claude.ai");
            // `claude mcp remove -s <scope>` in the folder the list is read in.
            // A project's `.mcp.json` is a repository's file, left alone.
            out.can_remove = matches!(out.scope.as_deref(), Some("user" | "local"));
            Some(out)
        })
        .collect()
}

/// `codex mcp list --json`: each server's name, whether it is on, its
/// transport and its login. A server's env and headers are read past.
pub fn parse_codex_list(list: &Value) -> Vec<ProviderServer> {
    list.as_array()
        .map(Vec::as_slice)
        .unwrap_or_default()
        .iter()
        .filter_map(|row| {
            let row = as_record(row)?;
            let name = string_field(Some(row), "name")?;
            let transport = row.get("transport").and_then(as_record);
            let mut out = server("codex", name);
            out.transport = match string_field(transport, "type").as_deref() {
                Some("streamable_http") => "http".into(),
                Some(other) => other.to_string(),
                None => "stdio".into(),
            };
            out.target = match string_field(transport, "url") {
                Some(url) => url,
                None => command_line(string_field(transport, "command").as_deref(), transport.and_then(|t| t.get("args"))),
            };
            if bundled(transport) {
                out.scope = Some("bundled".into());
            }
            out.can_remove = out.scope.is_none();
            out.state = if row.get("enabled") == Some(&Value::Bool(false)) { McpState::Disabled } else { McpState::Unknown };
            let auth = string_field(Some(row), "auth_status").unwrap_or_default();
            out.can_sign_in = out.transport == "http" && matches!(auth.as_str(), "not_logged_in" | "o_auth");
            if auth == "not_logged_in" && out.state == McpState::Unknown {
                out.state = McpState::NeedsAuth;
            }
            Some(out)
        })
        .collect()
}

/// A server the ChatGPT or Codex app installed for itself, not the user: its
/// command or folder is in the app's bundled plugins, or inside an app.
fn bundled(transport: Option<&Map<String, Value>>) -> bool {
    ["command", "cwd"]
        .iter()
        .filter_map(|key| string_field(transport, key))
        .any(|path| path.contains("plugins/cache/openai-bundled/") || path.contains(".app/Contents/"))
}

/// How each server of `servers` stands, from an app-server's
/// `mcpServerStatus/list`: connected once it gave its tools, failed with the
/// error it gave, waiting for a login when it has none. A server the list
/// does not name, or one that is off, keeps what `mcp list` said.
pub fn apply_codex_status(servers: &mut [ProviderServer], status: &Value) {
    let rows = status.get("data").and_then(Value::as_array).map(Vec::as_slice).unwrap_or_default();
    for row in rows.iter().filter_map(as_record) {
        let Some(name) = string_field(Some(row), "name") else { continue };
        let Some(out) = servers.iter_mut().find(|s| s.name == name) else { continue };
        if out.state == McpState::Disabled {
            continue;
        }
        if row.get("pluginId").is_some_and(|id| id.is_string()) && out.scope.is_none() {
            out.scope = Some("plugin".into());
            out.can_remove = false;
        }
        let error = string_field(Some(row), "toolsError").filter(|e| !e.trim().is_empty());
        let auth = string_field(Some(row), "authStatus").unwrap_or_default();
        let answered = row.get("serverInfo").is_some_and(|info| !info.is_null());
        out.state = match string_field(Some(row), "runtimeStatus").as_deref() {
            Some("connected") => McpState::Connected,
            Some("notStarted" | "starting") => McpState::Pending,
            Some("authenticationRequired") => McpState::NeedsAuth,
            Some("failed" | "cancelled") => McpState::Failed,
            Some("disabled") => McpState::Disabled,
            _ if error.is_some() => McpState::Failed,
            _ if answered => McpState::Connected,
            _ if auth == "notLoggedIn" => McpState::NeedsAuth,
            _ => McpState::Unknown,
        };
        out.error = error.filter(|_| out.state == McpState::Failed).map(|e| clip(&e));
        out.tools = count(row.get("tools")).filter(|_| out.state == McpState::Connected);
    }
}

fn opencode_state(status: &str) -> McpState {
    match status {
        "connected" => McpState::Connected,
        "pending" => McpState::Pending,
        "failed" => McpState::Failed,
        "needs_auth" | "needs_client_registration" => McpState::NeedsAuth,
        "disabled" => McpState::Disabled,
        _ => McpState::Unknown,
    }
}

/// opencode's servers: its config's documents (`GET /api/config`, each
/// `{type: document, path, info: {mcp: {servers}}}`, later ones over earlier
/// ones) for what each is, and `GET /api/mcp` for how each stands. A
/// document under the user's own config folder is the user's scope.
pub fn parse_opencode(sources: &Value, status: &Value, home: &str) -> Vec<ProviderServer> {
    let mut configured: BTreeMap<String, (Map<String, Value>, Option<String>)> = BTreeMap::new();
    let mut order: Vec<String> = Vec::new();
    for document in sources.as_array().map(Vec::as_slice).unwrap_or_default().iter().filter_map(as_record) {
        if string_field(Some(document), "type").as_deref() != Some("document") {
            continue;
        }
        let path = string_field(Some(document), "path").unwrap_or_default();
        let user =
            [format!("{home}/.config/opencode"), format!("{home}/.opencode")].iter().any(|dir| path.starts_with(dir.as_str()));
        let scope = if user { "user" } else { "project" };
        let mcp = document.get("info").and_then(|info| info.get("mcp"));
        // The new format keeps them under `servers`; the old one, beside it.
        let servers = mcp.and_then(|mcp| mcp.get("servers")).and_then(as_record).or_else(|| mcp.and_then(as_record));
        for (name, entry) in servers.into_iter().flatten() {
            let Some(entry) = as_record(entry) else { continue };
            configured.insert(name.clone(), (entry.clone(), Some(scope.to_string())));
        }
    }
    // In the order opencode lists them, then any it did not list.
    let rows: Vec<&Map<String, Value>> = status
        .get("data")
        .and_then(Value::as_array)
        .map(Vec::as_slice)
        .unwrap_or_default()
        .iter()
        .filter_map(as_record)
        .collect();
    for name in rows.iter().filter_map(|row| string_field(Some(*row), "name")).chain(configured.keys().cloned()) {
        if !order.contains(&name) {
            order.push(name);
        }
    }
    order
        .into_iter()
        .map(|name| {
            let mut out = server("opencode", name.clone());
            if let Some((entry, scope)) = configured.get(&name) {
                let remote = string_field(Some(entry), "type").as_deref() == Some("remote");
                out.transport = if remote { "http".into() } else { "stdio".into() };
                out.target = match string_field(Some(entry), "url") {
                    Some(url) => url,
                    None => match entry.get("command") {
                        Some(Value::Array(_)) => command_line(None, entry.get("command")),
                        _ => command_line(string_field(Some(entry), "command").as_deref(), entry.get("args")),
                    },
                };
                out.scope = scope.clone();
                let off = entry.get("disabled") == Some(&Value::Bool(true)) || entry.get("enabled") == Some(&Value::Bool(false));
                if off {
                    out.state = McpState::Disabled;
                }
                out.can_sign_in = remote;
            }
            if let Some(row) = rows.iter().find(|row| string_field(Some(**row), "name").as_deref() == Some(name.as_str())) {
                let status = row.get("status").and_then(as_record);
                out.state = opencode_state(&string_field(status, "status").unwrap_or_default());
                out.error = string_field(status, "error")
                    .filter(|_| matches!(out.state, McpState::Failed | McpState::NeedsAuth))
                    .map(|e| clip(&e));
                if string_field(Some(row), "integrationID").is_some() {
                    out.can_sign_in = true;
                }
            }
            out
        })
        .collect()
}

/// `cursor-agent mcp list`, one `name: status` line each, and what
/// `~/.cursor/mcp.json` says each is. Cursor counts no tools here.
pub fn parse_cursor(text: &str, config: Option<&Value>) -> Vec<ProviderServer> {
    let entries = config.and_then(|c| c.get("mcpServers")).and_then(as_record);
    text.lines()
        .map(strip_ansi)
        .filter_map(|line| {
            let (name, status) = line.trim().split_once(": ")?;
            let name = name.trim();
            if name.is_empty() || name.contains(' ') {
                return None;
            }
            let mut out = server("cursor", name.to_string());
            let status = status.trim();
            out.state = match status {
                "ready" => McpState::Connected,
                "requires_authentication" => McpState::NeedsAuth,
                "loading" => McpState::Pending,
                "disabled" => McpState::Disabled,
                _ if status.starts_with("not loaded") => McpState::Unknown,
                _ => McpState::Failed,
            };
            if out.state == McpState::Failed {
                out.error = Some(clip(status.strip_prefix("Error: ").unwrap_or(status)));
            } else if out.state == McpState::Unknown {
                out.error = Some("Waiting for its approval in Cursor.".into());
            }
            match entries.and_then(|e| e.get(name)).and_then(as_record) {
                Some(entry) => {
                    out.scope = Some("user".into());
                    out.can_remove = true;
                    match string_field(Some(entry), "url") {
                        Some(url) => {
                            out.transport = if string_field(Some(entry), "type").as_deref() == Some("sse") {
                                "sse".into()
                            } else {
                                "http".into()
                            };
                            out.target = url;
                        }
                        None => {
                            out.transport = "stdio".into();
                            out.target = command_line(string_field(Some(entry), "command").as_deref(), entry.get("args"));
                        }
                    }
                }
                None => out.scope = Some("project".into()),
            }
            out.can_sign_in = out.transport == "http" || out.transport == "sse" || out.state == McpState::NeedsAuth;
            Some(out)
        })
        .collect()
}

fn strip_ansi(line: &str) -> String {
    let mut out = String::with_capacity(line.len());
    let mut chars = line.chars().peekable();
    while let Some(c) = chars.next() {
        if c == '\u{1b}' {
            if chars.peek() == Some(&'[') {
                chars.next();
                for c in chars.by_ref() {
                    if c.is_ascii_alphabetic() {
                        break;
                    }
                }
            }
            continue;
        }
        out.push(c);
    }
    out
}

/// `grok mcp list --json`: each `{name, url | command, args, enabled, scope}`.
/// Grok says nothing of how a server stands, so one that is on is Unknown.
pub fn parse_grok(list: &Value) -> Vec<ProviderServer> {
    list.as_array()
        .map(Vec::as_slice)
        .unwrap_or_default()
        .iter()
        .filter_map(|row| {
            let row = as_record(row)?;
            let name = string_field(Some(row), "name")?;
            let mut out = server("grok", name);
            match string_field(Some(row), "url") {
                Some(url) => {
                    out.transport =
                        if string_field(Some(row), "transport").as_deref() == Some("sse") { "sse".into() } else { "http".into() };
                    out.target = url;
                }
                None => {
                    out.transport = "stdio".into();
                    out.target = command_line(string_field(Some(row), "command").as_deref(), row.get("args"));
                }
            }
            out.scope = string_field(Some(row), "scope");
            out.can_remove = true;
            // Crew signs in for it and hands Grok the grant (`grok.rs`).
            out.can_sign_in = matches!(out.transport.as_str(), "http" | "sse");
            out.state = if row.get("enabled") == Some(&Value::Bool(false)) { McpState::Disabled } else { McpState::Unknown };
            Some(out)
        })
        .collect()
}

/* ── The redirect ────────────────────────────────────────────────────── */

fn query(url: &url::Url, key: &str) -> Option<String> {
    url.query_pairs().find(|(k, _)| k == key).map(|(_, v)| v.into_owned())
}

/// The `state` and `redirect_uri` an authorization page was started with.
pub fn auth_url_parts(auth_url: &str) -> Option<(String, String)> {
    let url = url::Url::parse(auth_url).ok()?;
    Some((query(&url, "state")?, query(&url, "redirect_uri")?))
}

fn same_endpoint(a: &url::Url, b: &url::Url) -> bool {
    a.scheme() == b.scheme()
        && a.host_str().map(str::to_ascii_lowercase) == b.host_str().map(str::to_ascii_lowercase)
        && a.port_or_known_default() == b.port_or_known_default()
        && a.path() == b.path()
}

fn loopback(url: &url::Url) -> bool {
    url.scheme() == "http" && matches!(url.host_str(), Some("127.0.0.1" | "localhost" | "[::1]"))
}

/// Whether a caught redirect is the one a flow waits for: the flow's redirect
/// URI, origin and path, carrying the flow's `state`. Says why not without
/// repeating the URL, which can carry a code.
pub fn check_callback(redirect_uri: &str, state: &str, url: &str) -> Result<(), String> {
    let expected = url::Url::parse(redirect_uri).map_err(|_| "The sign-in has no redirect to wait for.".to_string())?;
    let caught = url::Url::parse(url).map_err(|_| "That is not a sign-in redirect.".to_string())?;
    if !same_endpoint(&expected, &caught) {
        return Err("That redirect is not the one this sign-in waits for.".into());
    }
    if query(&caught, "state").as_deref() != Some(state) {
        return Err("That redirect belongs to another sign-in.".into());
    }
    Ok(())
}

/// Requests a caught redirect from the CLI's own listener on this machine, as
/// the browser would have. Only ever a loopback URL; the reply's body is not
/// read past its status line.
pub fn loopback_get(url: &str) -> Result<(), String> {
    let url = url::Url::parse(url).map_err(|_| "That is not a sign-in redirect.".to_string())?;
    if !loopback(&url) {
        return Err("Crew only hands a sign-in to a listener on this machine.".into());
    }
    let port = url.port_or_known_default().ok_or("The redirect names no port.")?;
    let addr: SocketAddr = match url.host_str() {
        Some("[::1]") => SocketAddr::from(([0, 0, 0, 0, 0, 0, 0, 1], port)),
        _ => SocketAddr::from(([127, 0, 0, 1], port)),
    };
    let mut target = url.path().to_string();
    if let Some(query) = url.query() {
        target.push('?');
        target.push_str(query);
    }
    let host = url.host_str().unwrap_or("127.0.0.1");
    let mut stream = TcpStream::connect_timeout(&addr, Duration::from_secs(5))
        .map_err(|_| "The CLI is no longer waiting for this sign-in.".to_string())?;
    stream.set_read_timeout(Some(Duration::from_secs(30))).ok();
    stream.set_write_timeout(Some(Duration::from_secs(5))).ok();
    // One write: a listener that reads its first packet sees the whole line.
    let request = format!("GET {target} HTTP/1.1\r\nHost: {host}:{port}\r\nConnection: close\r\nAccept: text/html\r\n\r\n");
    stream.write_all(request.as_bytes()).map_err(|_| "The CLI's listener closed.".to_string())?;
    let mut line = String::new();
    BufReader::new(stream).read_line(&mut line).map_err(|_| "The CLI's listener did not answer.".to_string())?;
    let status: u16 = line.split_whitespace().nth(1).and_then(|code| code.parse().ok()).unwrap_or(0);
    if (200..400).contains(&status) {
        Ok(())
    } else {
        Err(format!("The CLI's listener answered {status}."))
    }
}

/* ── Editing a config file ───────────────────────────────────────────── */

fn skip_ws(b: &[u8], mut i: usize) -> usize {
    while i < b.len() && b[i].is_ascii_whitespace() {
        i += 1;
    }
    i
}

/// Where the JSON value that starts at `i` ends.
fn skip_value(b: &[u8], i: usize) -> Option<usize> {
    match *b.get(i)? {
        b'"' => {
            let mut j = i + 1;
            while j < b.len() {
                match b[j] {
                    b'\\' => j += 2,
                    b'"' => return Some(j + 1),
                    _ => j += 1,
                }
            }
            None
        }
        b'{' | b'[' => {
            let (mut depth, mut j) = (0usize, i);
            while j < b.len() {
                match b[j] {
                    b'"' => {
                        j = skip_value(b, j)?;
                        continue;
                    }
                    b'{' | b'[' => depth += 1,
                    b'}' | b']' => {
                        depth -= 1;
                        if depth == 0 {
                            return Some(j + 1);
                        }
                    }
                    _ => {}
                }
                j += 1;
            }
            None
        }
        _ => {
            let mut j = i;
            while j < b.len() && !matches!(b[j], b',' | b'}' | b']') && !b[j].is_ascii_whitespace() {
                j += 1;
            }
            Some(j)
        }
    }
}

/// The members of the object that starts at `i`: each key, where its member
/// starts, and where its value starts and ends.
fn members(text: &str, i: usize) -> Option<Vec<(String, usize, usize, usize)>> {
    let b = text.as_bytes();
    if b.get(i) != Some(&b'{') {
        return None;
    }
    let mut out = Vec::new();
    let mut j = skip_ws(b, i + 1);
    while b.get(j) != Some(&b'}') {
        let key_end = skip_value(b, j)?;
        let key: String = serde_json::from_str(text.get(j..key_end)?).ok()?;
        let colon = skip_ws(b, key_end);
        if b.get(colon) != Some(&b':') {
            return None;
        }
        let value = skip_ws(b, colon + 1);
        let end = skip_value(b, value)?;
        out.push((key, j, value, end));
        j = skip_ws(b, end);
        if b.get(j) == Some(&b',') {
            j = skip_ws(b, j + 1);
        }
    }
    Some(out)
}

/// `text` with the member `name` taken out of the object at `path`, and
/// everything else as it was written: its order, its spacing. Refused for
/// anything that is not plain JSON (a comment, a trailing comma), and checked
/// against the same removal made on the parsed document.
pub fn remove_member(text: &str, path: &[&str], name: &str) -> Result<String, String> {
    let mut expected: Value =
        serde_json::from_str(text).map_err(|_| "The file is not plain JSON, so Crew leaves it alone.".to_string())?;
    let mut parent = &mut expected;
    for key in path {
        parent = parent.get_mut(*key).ok_or("The file does not have that server.")?;
    }
    parent.as_object_mut().and_then(|object| object.remove(name)).ok_or("The file does not have that server.")?;
    let mut at = skip_ws(text.as_bytes(), 0);
    for key in path {
        let (_, _, value, _) =
            members(text, at).and_then(|list| list.into_iter().find(|m| m.0 == *key)).ok_or("The file could not be read.")?;
        at = value;
    }
    let list = members(text, at).ok_or("The file could not be read.")?;
    let index = list.iter().position(|m| m.0 == name).ok_or("The file does not have that server.")?;
    let (start, end) = match (index.checked_sub(1).map(|i| &list[i]), list.get(index + 1)) {
        // Up to the next member: the comma after it goes too.
        (_, Some(next)) => (list[index].1, next.1),
        // The last one: the comma before it goes.
        (Some(previous), None) => (previous.3, list[index].3),
        (None, None) => (list[index].1, list[index].3),
    };
    let edited = format!("{}{}", &text[..start], &text[end..]);
    match serde_json::from_str::<Value>(&edited) {
        Ok(parsed) if parsed == expected => Ok(edited),
        _ => Err("The file could not be edited safely.".into()),
    }
}

/// Takes one server out of a JSON config file, in place: written beside it
/// and renamed over, with the file's own permissions.
pub fn remove_from_file(file: &Path, path: &[&str], name: &str) -> Result<(), String> {
    let text = std::fs::read_to_string(file).map_err(|_| "The config file could not be read.".to_string())?;
    let edited = remove_member(&text, path, name)?;
    let temp = file.with_extension(format!("crew-{}", std::process::id()));
    std::fs::write(&temp, edited).map_err(|e| format!("The config file could not be written: {e}"))?;
    if let Ok(meta) = std::fs::metadata(file) {
        let _ = std::fs::set_permissions(&temp, meta.permissions());
    }
    std::fs::rename(&temp, file).map_err(|e| {
        let _ = std::fs::remove_file(&temp);
        format!("The config file could not be written: {e}")
    })
}

/// The user's opencode file a server is in, and where in it, when Crew can
/// edit it: plain JSON (no comments) under the user's own config folder.
pub fn opencode_file(sources: &Value, name: &str, home: &str) -> Option<(PathBuf, Vec<&'static str>)> {
    let documents = sources.as_array()?;
    documents.iter().rev().filter_map(as_record).find_map(|document| {
        let path = string_field(Some(document), "path")?;
        let user =
            [format!("{home}/.config/opencode"), format!("{home}/.opencode")].iter().any(|dir| path.starts_with(dir.as_str()));
        if !user || string_field(Some(document), "type").as_deref() != Some("document") {
            return None;
        }
        let text = std::fs::read_to_string(&path).ok()?;
        let on_disk: Value = serde_json::from_str(&text).ok()?;
        let mcp = on_disk.get("mcp")?;
        let at: Vec<&'static str> = if mcp.get("servers").and_then(|servers| servers.get(name)).is_some() {
            vec!["mcp", "servers"]
        } else if mcp.get(name).is_some() {
            vec!["mcp"]
        } else {
            return None;
        };
        Some((PathBuf::from(path), at))
    })
}

/* ── A short-lived Claude Code ───────────────────────────────────────── */

/// A Claude Code that answers control requests and runs no turn: the
/// inventory asks it `mcp_status`, and a sign-in keeps it until its redirect
/// is in. It reads the user's settings, as a session of theirs does, and
/// writes no conversation.
struct ClaudeProbe {
    child: Child,
    stdin: ChildStdin,
    rx: mpsc::Receiver<Map<String, Value>>,
    next: u64,
}

impl ClaudeProbe {
    fn start(bin: &str, cwd: &Path) -> Result<Self, String> {
        let mut child = Command::new(bin)
            .args([
                "-p",
                "--input-format",
                "stream-json",
                "--output-format",
                "stream-json",
                "--verbose",
                "--no-session-persistence",
            ])
            .env("PATH", crate::shell_path::joined())
            .current_dir(cwd)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .process_group(0)
            .spawn()
            .map_err(|e| format!("Claude Code did not start: {e}"))?;
        let (Some(stdin), Some(stdout)) = (child.stdin.take(), child.stdout.take()) else {
            let _ = child.kill();
            return Err("Claude Code did not start.".into());
        };
        let (tx, rx) = mpsc::channel();
        thread::spawn(move || {
            for line in BufReader::new(stdout).lines().map_while(Result::ok) {
                if let Ok(Value::Object(record)) = serde_json::from_str::<Value>(&line) {
                    if tx.send(record).is_err() {
                        break;
                    }
                }
            }
        });
        let mut probe = Self { child, stdin, rx, next: 0 };
        probe.ask(json!({ "subtype": "initialize" }), LIST_TIMEOUT)?;
        Ok(probe)
    }

    fn ask(&mut self, request: Value, timeout: Duration) -> Result<Value, String> {
        self.next += 1;
        let id = format!("crew-{}", self.next);
        writeln!(self.stdin, "{}", build_control_request(&id, request))
            .and_then(|_| self.stdin.flush())
            .map_err(|_| "Claude Code is not running.".to_string())?;
        let deadline = Instant::now() + timeout;
        loop {
            let wait = deadline.checked_duration_since(Instant::now()).ok_or("Claude Code did not answer.")?;
            let record = self.rx.recv_timeout(wait).map_err(|_| "Claude Code did not answer.".to_string())?;
            if let Some((answered, result)) = parse_control_response(&record) {
                if answered == id {
                    return result;
                }
            }
        }
    }
}

impl Drop for ClaudeProbe {
    fn drop(&mut self) {
        unsafe { libc::kill(-(self.child.id() as i32), libc::SIGKILL) };
        let _ = self.child.wait();
    }
}

/* ── A Cursor login ──────────────────────────────────────────────────── */

/// `cursor-agent mcp login <name>` with no terminal, its output read line by
/// line. Dropped, its process group ends.
struct CursorLogin {
    child: Child,
    lines: mpsc::Receiver<String>,
    /// The last line it said that was not the page: why, when it fails.
    last: Option<String>,
}

impl CursorLogin {
    fn start(bin: &str, name: &str) -> Result<Self, String> {
        let shim = no_browser()?;
        let mut child = Command::new(bin)
            .args(["mcp", "login", name])
            .env("PATH", format!("{}:{}", shim.display(), crate::shell_path::joined()))
            .env("BROWSER", shim.join("open"))
            .current_dir(home())
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .process_group(0)
            .spawn()
            .map_err(|e| format!("Cursor did not start: {e}"))?;
        let Some(stdout) = child.stdout.take() else {
            let _ = child.kill();
            return Err("Cursor did not start.".into());
        };
        let (tx, lines) = mpsc::channel();
        thread::spawn(move || {
            for line in BufReader::new(stdout).lines().map_while(Result::ok) {
                if tx.send(line).is_err() {
                    break;
                }
            }
        });
        Ok(Self { child, lines, last: None })
    }

    /// Whether it exited signed in, once it has; `None` if it is still running.
    fn wait(&mut self, timeout: Duration) -> Option<bool> {
        let deadline = Instant::now() + timeout;
        loop {
            if let Ok(Some(status)) = self.child.try_wait() {
                return Some(status.success());
            }
            if Instant::now() >= deadline {
                return None;
            }
            thread::sleep(Duration::from_millis(100));
        }
    }
}

impl Drop for CursorLogin {
    fn drop(&mut self) {
        unsafe { libc::kill(-(self.child.id() as i32), libc::SIGKILL) };
        let _ = self.child.wait();
    }
}

/// A folder whose `open` and `xdg-open` do nothing, first on a login's PATH:
/// the page the CLI would open in the user's browser opens in Crew's window.
fn no_browser() -> Result<PathBuf, String> {
    use std::os::unix::fs::PermissionsExt;
    let dir = std::env::temp_dir().join("crew-no-browser");
    std::fs::create_dir_all(&dir).map_err(|e| format!("Crew could not prepare the sign-in: {e}"))?;
    for name in ["open", "xdg-open"] {
        let path = dir.join(name);
        std::fs::write(&path, "#!/bin/sh\nexit 0\n")
            .and_then(|()| std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o755)))
            .map_err(|e| format!("Crew could not prepare the sign-in: {e}"))?;
    }
    Ok(dir)
}

/* ── Readers ─────────────────────────────────────────────────────────── */

/// The folder the CLIs list their servers in: the user's home, whose project
/// config is their own.
pub(crate) fn home() -> PathBuf {
    std::env::var_os("HOME").map(PathBuf::from).filter(|home| home.is_dir()).unwrap_or_else(std::env::temp_dir)
}

fn sandboxed() -> bool {
    std::env::var_os("CREW_SANDBOX").is_some_and(|value| !value.is_empty())
}

fn run_json(bin: &str, args: &[&str], cwd: &Path, cli: &str) -> Result<Value, String> {
    let text = crate::provider_status::run_in(Path::new(bin), args, Some(cwd), LIST_TIMEOUT)
        .ok_or_else(|| format!("{cli} did not answer."))?;
    serde_json::from_str(text.trim()).map_err(|_| format!("{cli} said: {}", clip(text.trim())))
}

/// Claude's servers, from a process of its own: asked again while one is
/// still connecting, up to [`SETTLE`].
fn read_claude(bin: &str) -> Result<Vec<ProviderServer>, String> {
    let mut probe = ClaudeProbe::start(bin, &home())?;
    let started = Instant::now();
    loop {
        let answer = probe.ask(json!({ "subtype": "mcp_status" }), LIST_TIMEOUT)?;
        let servers = parse_claude(answer.get("mcpServers").unwrap_or(&Value::Null));
        if !servers.iter().any(|s| s.state == McpState::Pending) || started.elapsed() >= SETTLE {
            return Ok(servers);
        }
        thread::sleep(SETTLE_POLL);
    }
}

/// Codex's servers: `mcp list` for what each is, and an app-server for how
/// each stands. Without the app-server, the list alone.
fn read_codex(bin: &str) -> Result<Vec<ProviderServer>, String> {
    let mut servers = parse_codex_list(&run_json(bin, &["mcp", "list", "--json"], &home(), "Codex")?);
    if servers.iter().any(|s| s.state != McpState::Disabled) {
        if let Some(mut app) = crate::usage::codex::AppServer::start(bin) {
            if let Some(status) = app.call("mcpServerStatus/list", Some(json!({ "detail": "toolsAndAuthOnly" })), LIST_TIMEOUT) {
                apply_codex_status(&mut servers, &status);
            }
        }
    }
    Ok(servers)
}

/// opencode's servers, as its background service has them (`opencode api`):
/// asked again while one is still connecting, or while a service that just
/// started lists none of the ones its config has.
fn read_opencode(bin: &str) -> Result<Vec<ProviderServer>, String> {
    let cwd = home();
    let home_text = cwd.to_string_lossy().into_owned();
    let sources = run_json(bin, &["api", "GET", "/api/config"], &cwd, "opencode")?;
    let started = Instant::now();
    loop {
        let status = run_json(bin, &["api", "GET", "/api/mcp"], &cwd, "opencode")?;
        let mut servers = parse_opencode(&sources, &status, &home_text);
        for server in &mut servers {
            server.can_remove = opencode_file(&sources, &server.name, &home_text).is_some();
        }
        let listed = status.get("data").and_then(Value::as_array).is_some_and(|rows| !rows.is_empty());
        let settling = servers.iter().any(|s| s.state == McpState::Pending) || (!listed && !servers.is_empty());
        if !settling || started.elapsed() >= SETTLE {
            return Ok(servers);
        }
        thread::sleep(SETTLE_POLL);
    }
}

fn cursor_file() -> PathBuf {
    home().join(".cursor").join("mcp.json")
}

fn cursor_config() -> Option<Value> {
    let text = std::fs::read_to_string(cursor_file()).ok()?;
    serde_json::from_str(&text).ok()
}

fn read_cursor(bin: &str) -> Result<Vec<ProviderServer>, String> {
    let text = crate::provider_status::run_in(Path::new(bin), &["mcp", "list"], Some(&home()), LIST_TIMEOUT)
        .ok_or("Cursor did not answer.")?;
    if text.trim_start().starts_with("Failed to list") {
        return Err(clip(text.trim()));
    }
    Ok(parse_cursor(&text, cursor_config().as_ref()))
}

/// Grok's servers, each remote one that is on checked with `grok mcp
/// doctor`, all at once, since its list says nothing of how they stand. A
/// check that does not answer leaves its server Unknown.
fn read_grok(bin: &str) -> Result<Vec<ProviderServer>, String> {
    let mut servers = parse_grok(&run_json(bin, &["mcp", "list", "--json"], &home(), "Grok")?);
    let checks: Vec<_> = servers
        .iter()
        .enumerate()
        .filter(|(_, s)| s.state == McpState::Unknown && matches!(s.transport.as_str(), "http" | "sse"))
        .map(|(at, s)| {
            let (bin, name) = (bin.to_string(), s.name.clone());
            let check = thread::spawn(move || {
                crate::provider_status::run_in(
                    Path::new(&bin),
                    &["mcp", "doctor", &name, "--json"],
                    Some(&home()),
                    grok::DOCTOR_TIMEOUT,
                )
                .and_then(|text| serde_json::from_str::<Value>(text.trim()).ok())
            });
            (at, check)
        })
        .collect();
    for (at, check) in checks {
        if let Ok(Some(report)) = check.join() {
            grok::apply_doctor(&mut servers[at], &report);
        }
    }
    Ok(servers)
}

/// The binary a provider runs as.
pub fn binary_name(provider: &str) -> &str {
    match provider {
        "cursor" => "cursor-agent",
        other => other,
    }
}

/* ── Sign-in flows ───────────────────────────────────────────────────── */

enum FlowMsg {
    Callback { url: String, reply: mpsc::Sender<Result<(), String>> },
}

/// What answers a flow's redirect.
enum Answer {
    /// The thread that holds the CLI's process: Claude, to be handed the URL;
    /// Codex, whose loopback lives while its app-server does.
    Process(mpsc::Sender<FlowMsg>),
    /// A listener that lives without Crew holding anything: opencode's
    /// shared server.
    Loopback,
}

struct Flow {
    provider: String,
    redirect_uri: String,
    started: Instant,
    answer: Answer,
}

/* ── The host ────────────────────────────────────────────────────────── */

struct Inner {
    store: Store,
    /// Binaries a test put in place of the CLIs, shared with the turns.
    binaries: Arc<Mutex<HashMap<String, String>>>,
    lists: Mutex<Vec<ProviderInventory>>,
    /// Providers changed while a read of theirs was under way: that read is
    /// stale when it lands, so it reads again.
    again: Mutex<BTreeSet<String>>,
    flows: Mutex<HashMap<String, Flow>>,
    listener: Mutex<Option<Listener>>,
}

/// The inventory of every provider's servers on this machine, the sign-ins
/// under way, and who hears when either changes.
#[derive(Clone)]
pub struct ProviderServers {
    inner: Arc<Inner>,
}

fn lock<T>(mutex: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(|e| e.into_inner())
}

impl ProviderServers {
    pub fn new(store: Store, binaries: Arc<Mutex<HashMap<String, String>>>) -> Self {
        let lists = PROVIDERS
            .iter()
            .map(|provider| ProviderInventory {
                provider: provider.to_string(),
                installed: false,
                servers: Vec::new(),
                error: None,
                checked_at: None,
                checking: false,
            })
            .collect();
        Self {
            inner: Arc::new(Inner {
                store,
                binaries,
                lists: Mutex::new(lists),
                again: Mutex::new(BTreeSet::new()),
                flows: Mutex::new(HashMap::new()),
                listener: Mutex::new(None),
            }),
        }
    }

    pub fn set_listener(&self, listener: Listener) {
        *lock(&self.inner.listener) = Some(listener);
    }

    fn notify(&self) {
        let listener = lock(&self.inner.listener).clone();
        if let Some(listener) = listener {
            listener(self.list());
        }
    }

    /// The path of a provider's CLI, when it is on this machine.
    fn resolve(&self, provider: &str) -> Option<String> {
        let name = binary_name(provider);
        if let Some(path) = lock(&self.inner.binaries).get(name).cloned() {
            return Path::new(&path).is_file().then_some(path);
        }
        crate::agent::AgentHost::resolve(name).ok().map(|bin| bin.path)
    }

    /// Every provider's last list, with what is off in Crew as it stands now.
    pub fn list(&self) -> Vec<ProviderInventory> {
        let mut lists = lock(&self.inner.lists).clone();
        for inventory in &mut lists {
            let off = off_names(&self.inner.store, &inventory.provider);
            let cli_off = matches!(inventory.provider.as_str(), "cursor" | "grok");
            for server in &mut inventory.servers {
                server.off_in_crew = off.contains(&server.name) || (cli_off && server.state == McpState::Disabled);
            }
        }
        lists
    }

    fn inventory(&self, provider: &str) -> Option<ProviderInventory> {
        lock(&self.inner.lists).iter().find(|inventory| inventory.provider == provider).cloned()
    }

    /// Reads these providers' lists again, each on a thread of its own, and
    /// tells the windows as each lands. One already being read reads again
    /// once that read lands, since it may predate what changed.
    pub fn refresh(&self, providers: &[&str]) {
        let mut started = Vec::new();
        {
            let mut lists = lock(&self.inner.lists);
            for provider in providers {
                if let Some(inventory) = lists.iter_mut().find(|inventory| inventory.provider == *provider) {
                    if inventory.checking {
                        lock(&self.inner.again).insert(provider.to_string());
                    } else {
                        inventory.checking = true;
                        started.push(provider.to_string());
                    }
                }
            }
        }
        if started.is_empty() {
            return;
        }
        self.notify();
        for provider in started {
            let host = self.clone();
            thread::spawn(move || host.read(&provider));
        }
    }

    /// Every provider, read again.
    pub fn refresh_all(&self) {
        self.refresh(&PROVIDERS);
    }

    /// The first read, a moment after the daemon starts so it does not
    /// compete with the window's first calls.
    pub fn start(&self, delay: Duration) {
        if sandboxed() {
            return;
        }
        let host = self.clone();
        thread::spawn(move || {
            thread::sleep(delay);
            host.refresh_all();
        });
    }

    fn read(&self, provider: &str) {
        let bin = self.resolve(provider);
        let read = match &bin {
            None => Ok(Vec::new()),
            // The e2e harness runs no CLI of the user's.
            Some(_) if sandboxed() => Ok(Vec::new()),
            Some(bin) => match provider {
                "claude" => read_claude(bin),
                "codex" => read_codex(bin),
                "opencode" => read_opencode(bin),
                "cursor" => read_cursor(bin),
                "grok" => read_grok(bin),
                other => Err(format!("Crew does not list {other}'s servers.")),
            },
        };
        // The CLI's own disable is what off is for these two: what it says
        // is what is kept, whoever changed it.
        if let Ok(servers) = &read {
            if matches!(provider, "cursor" | "grok") && bin.is_some() {
                let disabled: BTreeSet<String> =
                    servers.iter().filter(|s| s.state == McpState::Disabled).map(|s| s.name.clone()).collect();
                if let Err(error) = write_off(&self.inner.store, provider, &disabled) {
                    eprintln!("[provider-servers] {provider}: what is off was not kept: {error}");
                }
            }
        }
        {
            let mut lists = lock(&self.inner.lists);
            // Changed while this read was under way: what it read may be stale.
            if lock(&self.inner.again).remove(provider) {
                drop(lists);
                return self.read(provider);
            }
            if let Some(inventory) = lists.iter_mut().find(|inventory| inventory.provider == provider) {
                inventory.installed = bin.is_some();
                inventory.checking = false;
                inventory.checked_at = Some(now_millis());
                match read {
                    Ok(servers) => {
                        inventory.servers = servers;
                        inventory.error = None;
                    }
                    // What was read last stays, under the error.
                    Err(error) => inventory.error = Some(error),
                }
            }
        }
        self.notify();
    }

    /// Waits until no read of these providers is under way, for a caller that
    /// needs the list it is about to answer with.
    pub fn settle(&self, providers: &[&str], timeout: Duration) -> bool {
        let deadline = Instant::now() + timeout;
        loop {
            let busy = lock(&self.inner.lists).iter().any(|i| i.checking && providers.contains(&i.provider.as_str()));
            if !busy {
                return true;
            }
            if Instant::now() >= deadline {
                return false;
            }
            thread::sleep(Duration::from_millis(20));
        }
    }

    /* ── Off in Crew ── */

    /// Turns a server off in Crew for its provider, or back on. Cursor and
    /// Grok have only their CLI's disable, which this runs; it holds outside
    /// Crew too. The others are left out of each spawn from now on.
    pub fn set_off(&self, provider: &str, name: &str, off: bool) -> Result<(), String> {
        if !PROVIDERS.contains(&provider) {
            return Err(format!("Crew does not know the provider {provider}."));
        }
        if name.trim().is_empty() || name == "crew" {
            return Err("That server is not one of the CLI's.".into());
        }
        match provider {
            "cursor" => self.cursor_toggle(name, off)?,
            "grok" => self.grok_toggle(name, off)?,
            _ => {}
        }
        let mut names = off_names(&self.inner.store, provider);
        if off {
            names.insert(name.to_string());
        } else {
            names.remove(name);
        }
        write_off(&self.inner.store, provider, &names)?;
        self.notify();
        if matches!(provider, "cursor" | "grok") {
            self.refresh(&[provider]);
        }
        Ok(())
    }

    fn grok_toggle(&self, name: &str, off: bool) -> Result<(), String> {
        let bin = self.resolve("grok").ok_or("Grok is not on this machine.")?;
        let verb = if off { "disable" } else { "enable" };
        let said = crate::provider_status::run_in(Path::new(&bin), &["mcp", verb, name], Some(&home()), TOGGLE_TIMEOUT)
            .ok_or("Grok did not answer.")?;
        if said.to_ascii_lowercase().contains(&format!("{verb}d mcp server")) {
            Ok(())
        } else {
            Err(clip(said.trim()))
        }
    }

    fn cursor_run(bin: &str, verb: &str, name: &str, dir: &Path) -> Result<(), String> {
        let said = crate::provider_status::run_in(Path::new(bin), &["mcp", verb, name], Some(dir), TOGGLE_TIMEOUT)
            .ok_or("Cursor did not answer.")?;
        if said.contains("Failed") || said.contains("not found") {
            Err(clip(said.trim()))
        } else {
            Ok(())
        }
    }

    fn cursor_dirs(&self) -> BTreeMap<String, BTreeSet<String>> {
        crate::store::get(&self.inner.store, CURSOR_DIRS_KEY.into())
            .ok()
            .flatten()
            .and_then(|raw| serde_json::from_str(&raw).ok())
            .unwrap_or_default()
    }

    fn write_cursor_dirs(&self, dirs: &BTreeMap<String, BTreeSet<String>>) {
        let dirs: BTreeMap<_, _> = dirs.iter().filter(|(_, set)| !set.is_empty()).collect();
        let _ = match dirs.is_empty() {
            true => crate::store::delete(&self.inner.store, CURSOR_DIRS_KEY.into()),
            false => {
                crate::store::set(&self.inner.store, CURSOR_DIRS_KEY.into(), serde_json::to_string(&dirs).unwrap_or_default())
            }
        };
    }

    /// Cursor keeps what is disabled per project: off runs its disable in the
    /// home folder the list is read in and in every workspace's folder, and
    /// on runs its enable wherever Crew disabled it.
    fn cursor_toggle(&self, name: &str, off: bool) -> Result<(), String> {
        let bin = self.resolve("cursor").ok_or("Cursor is not on this machine.")?;
        let home = home();
        let mut dirs = self.cursor_dirs();
        let mut places: BTreeSet<String> = dirs.get(name).cloned().unwrap_or_default();
        places.insert(home.to_string_lossy().into_owned());
        if off {
            for workspace in crate::workspace::list(&self.inner.store).unwrap_or_default() {
                if Path::new(&workspace.path).is_dir() {
                    places.insert(workspace.path);
                }
            }
        }
        let verb = if off { "disable" } else { "enable" };
        Self::cursor_run(&bin, verb, name, &home)?;
        let others: Vec<_> = places
            .iter()
            .filter(|dir| Path::new(dir.as_str()) != home)
            .map(|dir| {
                let (bin, verb, name, dir) = (bin.clone(), verb, name.to_string(), dir.clone());
                thread::spawn(move || (Self::cursor_run(&bin, verb, &name, Path::new(&dir)).is_ok(), dir))
            })
            .collect();
        let done: BTreeSet<String> =
            others.into_iter().filter_map(|t| t.join().ok()).filter(|(ok, _)| *ok).map(|(_, dir)| dir).collect();
        if off {
            let mut kept = done;
            kept.insert(home.to_string_lossy().into_owned());
            dirs.insert(name.to_string(), kept);
        } else {
            dirs.remove(name);
        }
        self.write_cursor_dirs(&dirs);
        Ok(())
    }

    /// Before a Cursor session starts in `cwd`: what is off is disabled there
    /// too, once per folder, since Cursor keeps it per project.
    pub fn cursor_prepare(&self, cwd: &str) {
        let off = off_names(&self.inner.store, "cursor");
        if off.is_empty() || cwd.is_empty() {
            return;
        }
        let Some(bin) = self.resolve("cursor") else { return };
        let mut dirs = self.cursor_dirs();
        let mut changed = false;
        for name in off {
            let places = dirs.entry(name.clone()).or_default();
            if places.contains(cwd) {
                continue;
            }
            match Self::cursor_run(&bin, "disable", &name, Path::new(cwd)) {
                Ok(()) => {
                    places.insert(cwd.to_string());
                    changed = true;
                }
                Err(error) => eprintln!("[provider-servers] cursor: {name} stays on in this folder: {error}"),
            }
        }
        if changed {
            self.write_cursor_dirs(&dirs);
        }
    }

    /// The names Codex has, for its overrides: the last list when there is
    /// one, or a fresh `mcp list`. None when neither can be read.
    fn codex_names(&self) -> Option<BTreeSet<String>> {
        if let Some(inventory) = self.inventory("codex").filter(|i| i.checked_at.is_some() && i.error.is_none()) {
            return Some(inventory.servers.into_iter().map(|s| s.name).collect());
        }
        let bin = self.resolve("codex")?;
        let list = run_json(&bin, &["mcp", "list", "--json"], &home(), "Codex").ok()?;
        Some(parse_codex_list(&list).into_iter().map(|s| s.name).collect())
    }

    /// What a Codex thread turns off: the names off in Crew that Codex has.
    pub fn codex_off(&self, keep: &[String]) -> Vec<String> {
        let off = spawn_off(&self.inner.store, "codex", keep);
        if off.is_empty() {
            return off;
        }
        match self.codex_names() {
            Some(known) => off.into_iter().filter(|name| known.contains(name)).collect(),
            None => Vec::new(),
        }
    }

    /// What opencode's shared server turns off. A name it does not have would
    /// be listed as a disabled server of its own, so the last list filters
    /// them when there is one.
    pub fn opencode_off(&self, keep: &[String]) -> Vec<String> {
        let off = spawn_off(&self.inner.store, "opencode", keep);
        match self.inventory("opencode").filter(|i| i.checked_at.is_some() && i.error.is_none()) {
            Some(inventory) => off.into_iter().filter(|name| inventory.servers.iter().any(|s| &s.name == name)).collect(),
            None => off,
        }
    }

    /* ── Removing ── */

    /// Removes a server from its CLI's config, through the CLI where it has a
    /// command for it (Claude, Codex, Grok), or from the one file it lives in
    /// (Cursor's `~/.cursor/mcp.json`, the user's opencode config). What is
    /// off in Crew forgets it too.
    pub fn remove(&self, provider: &str, name: &str) -> Result<(), String> {
        let server = self.server(provider, name).ok_or("Crew has not listed that server here; list again.")?;
        if !server.can_remove {
            return Err("Crew cannot remove this one from the CLI's config.".into());
        }
        let bin = self.resolve(provider).ok_or("Its CLI is not on this machine.")?;
        let cli = |args: &[&str]| -> Result<(), String> {
            match crate::provider_status::run_checked_in(Path::new(&bin), args, Some(&home()), TOGGLE_TIMEOUT) {
                Some((true, _)) => Ok(()),
                Some((false, said)) => Err(clip(said.trim())),
                None => Err("The CLI did not answer.".into()),
            }
        };
        match provider {
            "claude" => cli(&["mcp", "remove", name, "-s", server.scope.as_deref().unwrap_or("user")])?,
            "codex" => cli(&["mcp", "remove", name])?,
            "grok" => match server.scope.as_deref() {
                Some(scope @ ("user" | "project")) => cli(&["mcp", "remove", name, "-s", scope])?,
                _ => cli(&["mcp", "remove", name])?,
            },
            "cursor" => remove_from_file(&cursor_file(), &["mcpServers"], name)?,
            "opencode" => {
                let home = home();
                let sources = run_json(&bin, &["api", "GET", "/api/config"], &home, "opencode")?;
                let (file, at) = opencode_file(&sources, name, &home.to_string_lossy())
                    .ok_or("opencode's config is not a file Crew can edit.")?;
                remove_from_file(&file, &at, name)?;
                // Its background service reads its config again.
                let _ = crate::provider_status::run_in(Path::new(&bin), &["reload"], Some(&home), TOGGLE_TIMEOUT);
            }
            other => return Err(format!("Crew does not remove {other}'s servers.")),
        }
        let mut off = off_names(&self.inner.store, provider);
        if off.remove(name) {
            write_off(&self.inner.store, provider, &off)?;
        }
        if provider == "cursor" {
            let mut dirs = self.cursor_dirs();
            if dirs.remove(name).is_some() {
                self.write_cursor_dirs(&dirs);
            }
        }
        // Gone from the list now, not when the CLI is next read: a window that
        // lists before then must not get it back.
        if let Some(inventory) = lock(&self.inner.lists).iter_mut().find(|inventory| inventory.provider == provider) {
            inventory.servers.retain(|s| s.name != name);
        }
        self.refresh(&[provider]);
        Ok(())
    }

    /* ── Signing in ── */

    fn sweep_flows(&self) {
        lock(&self.inner.flows).retain(|_, flow| flow.started.elapsed() < FLOW_TTL);
    }

    fn server(&self, provider: &str, name: &str) -> Option<ProviderServer> {
        self.inventory(provider)?.servers.into_iter().find(|s| s.name == name)
    }

    /// Starts signing in to one of a CLI's servers. Claude, Codex and Cursor
    /// answer the page for Crew's sign-in window.
    /// opencode's is started by the turns, which hold its server
    /// ([`ProviderServers::loopback_flow`]).
    pub fn sign_in(&self, provider: &str, name: &str) -> Result<ProviderSignIn, String> {
        self.sweep_flows();
        match provider {
            "claude" => self.claude_sign_in(name),
            "codex" => self.codex_sign_in(name),
            "cursor" => self.cursor_sign_in(name),
            "grok" => self.grok_sign_in(name),
            other => Err(format!("Crew does not sign in to {other}'s servers.")),
        }
    }

    fn claude_sign_in(&self, name: &str) -> Result<ProviderSignIn, String> {
        if self.server("claude", name).is_some_and(|s| s.scope.as_deref() == Some("claude.ai")) {
            return Err("A claude.ai connector is signed in at claude.ai, not here.".into());
        }
        let bin = self.resolve("claude").ok_or("Claude Code is not on this machine.")?;
        let mut probe = ClaudeProbe::start(&bin, &home())?;
        let answer = probe
            .ask(json!({ "subtype": "mcp_authenticate", "serverName": name, "redirectUri": REDIRECT_URI }), SIGN_IN_TIMEOUT)?;
        if answer.get("requiresUserAction") == Some(&Value::Bool(false)) {
            self.refresh(&["claude"]);
            return Err(format!("Claude Code is already signed in to {name}."));
        }
        let auth_url = string_field(as_record(&answer), "authUrl").ok_or("Claude Code gave no page to sign in on.")?;
        if answer.get("callbackExpected") == Some(&Value::Bool(false)) {
            return Err(format!("{name} is signed in at claude.ai, not here."));
        }
        let (url_state, redirect_uri) = auth_url_parts(&auth_url).ok_or("Claude Code's sign-in page names no redirect.")?;
        let state = string_field(as_record(&answer), "state").unwrap_or(url_state);
        let (tx, rx) = mpsc::channel::<FlowMsg>();
        let server = name.to_string();
        let host = self.clone();
        let key = state.clone();
        thread::spawn(move || {
            // The process lives until its redirect is in, or the flow ends.
            if let Ok(FlowMsg::Callback { url, reply }) = rx.recv_timeout(FLOW_TTL) {
                let done = probe
                    .ask(json!({ "subtype": "mcp_oauth_callback_url", "serverName": server, "callbackUrl": url }), FINISH_TIMEOUT)
                    .map(|_| ());
                let _ = reply.send(done);
            }
            drop(probe);
            lock(&host.inner.flows).remove(&key);
        });
        self.add_flow(&state, "claude", &redirect_uri, Answer::Process(tx));
        Ok(ProviderSignIn::Browser { state, auth_url, redirect_uri })
    }

    fn codex_sign_in(&self, name: &str) -> Result<ProviderSignIn, String> {
        let bin = self.resolve("codex").ok_or("Codex is not on this machine.")?;
        let mut app = crate::usage::codex::AppServer::start(&bin).ok_or("Codex did not start.")?;
        let started = app
            .call("mcpServer/oauth/login", Some(json!({ "name": name })), SIGN_IN_TIMEOUT)
            .ok_or_else(|| format!("Codex did not start a sign-in for {name}."))?;
        let auth_url = crate::providers::codex::mcp_login_url(&started).ok_or("Codex gave no page to sign in on.")?;
        let (state, redirect_uri) = auth_url_parts(&auth_url).ok_or("Codex's sign-in page names no redirect.")?;
        let (tx, rx) = mpsc::channel::<FlowMsg>();
        let host = self.clone();
        let key = state.clone();
        let server = name.to_string();
        thread::spawn(move || {
            let deadline = Instant::now() + FLOW_TTL;
            // Codex's listener takes the redirect while its app-server lives.
            // The browser may also reach it on its own; its notice ends the
            // flow then too.
            let completed = |app: &crate::usage::codex::AppServer, wait: Duration| -> Option<Result<(), String>> {
                let until = Instant::now() + wait;
                while let Some(left) = until.checked_duration_since(Instant::now()) {
                    let Ok(message) = app.rx.recv_timeout(left) else { return None };
                    if message.get("method").and_then(Value::as_str) != Some("mcpServer/oauthLogin/completed") {
                        continue;
                    }
                    let params = message.get("params").cloned().unwrap_or(Value::Null);
                    if params.get("name").and_then(Value::as_str).is_some_and(|n| n != server) {
                        continue;
                    }
                    return Some(match params.get("success").and_then(Value::as_bool) {
                        Some(true) => Ok(()),
                        _ => Err(params
                            .get("error")
                            .and_then(Value::as_str)
                            .map(clip)
                            .unwrap_or_else(|| "The sign-in did not finish.".into())),
                    });
                }
                None
            };
            while Instant::now() < deadline {
                match rx.recv_timeout(Duration::from_millis(500)) {
                    Ok(FlowMsg::Callback { url, reply }) => {
                        let done = loopback_get(&url).and_then(|()| {
                            completed(&app, FINISH_TIMEOUT)
                                .unwrap_or_else(|| Err("Codex did not say the sign-in finished.".into()))
                        });
                        let _ = reply.send(done);
                        break;
                    }
                    Err(mpsc::RecvTimeoutError::Timeout) => {
                        if completed(&app, Duration::ZERO).is_some() {
                            host.refresh(&["codex"]);
                            break;
                        }
                    }
                    Err(mpsc::RecvTimeoutError::Disconnected) => break,
                }
            }
            drop(app);
            lock(&host.inner.flows).remove(&key);
        });
        self.add_flow(&state, "codex", &redirect_uri, Answer::Process(tx));
        Ok(ProviderSignIn::Browser { state, auth_url, redirect_uri })
    }

    /// Grok signs in only from its TUI, so Crew signs in itself, in its own
    /// window, and writes the grant into Grok's credential store, where Grok
    /// uses and refreshes it (`grok.rs`). A thread holds the flow until its
    /// redirect is in.
    fn grok_sign_in(&self, name: &str) -> Result<ProviderSignIn, String> {
        let server = self.server("grok", name).ok_or("Crew has not listed that server here; list again.")?;
        if !server.can_sign_in {
            return Err("Only a remote server signs in.".into());
        }
        let home = crate::provider_session::grok_home().ok_or("Grok's folder could not be found.")?;
        let url = server.target.clone();
        let redirect = crate::connectors::flow::REDIRECT_URI;
        let start = {
            let url = url.clone();
            grok::on_runtime(async move { grok::start(&url, redirect).await })??
        };
        let (state, auth_url) = (start.pkce.state.clone(), start.auth_url.clone());
        let (tx, rx) = mpsc::channel::<FlowMsg>();
        let host = self.clone();
        let key = state.clone();
        let server = name.to_string();
        thread::spawn(move || {
            if let Ok(FlowMsg::Callback { url: caught, reply }) = rx.recv_timeout(FLOW_TTL) {
                let done = grok::on_runtime(async move { grok::finish(&start, redirect, &caught, &home, &server, &url).await })
                    .and_then(|done| done);
                let _ = reply.send(done);
            }
            lock(&host.inner.flows).remove(&key);
        });
        self.add_flow(&state, "grok", redirect, Answer::Process(tx));
        Ok(ProviderSignIn::Browser { state, auth_url, redirect_uri: redirect.to_string() })
    }

    /// Cursor has no sign-in to ask for but `cursor-agent mcp login`, which
    /// needs no terminal: it prints the page, opens it with `open` (which Crew
    /// stands in for, so the page opens in Crew's window only), listens on its
    /// own loopback, and exits once the redirect is in.
    fn cursor_sign_in(&self, name: &str) -> Result<ProviderSignIn, String> {
        let bin = self.resolve("cursor").ok_or("Cursor is not on this machine.")?;
        let mut login = CursorLogin::start(&bin, name)?;
        let deadline = Instant::now() + SIGN_IN_TIMEOUT;
        let auth_url = loop {
            let wait = deadline.checked_duration_since(Instant::now()).ok_or("Cursor did not start a sign-in.")?;
            match login.lines.recv_timeout(wait) {
                Ok(line) => {
                    let line = line.trim();
                    if line.starts_with("https://") && auth_url_parts(line).is_some() {
                        break line.to_string();
                    }
                    login.last = Some(line.to_string()).filter(|l| !l.is_empty());
                }
                Err(mpsc::RecvTimeoutError::Timeout) => return Err("Cursor did not start a sign-in.".into()),
                Err(mpsc::RecvTimeoutError::Disconnected) => {
                    let ok = login.wait(FINISH_TIMEOUT).unwrap_or(false);
                    self.refresh(&["cursor"]);
                    return Err(match ok {
                        true => format!("Cursor is already signed in to {name}."),
                        false => login.last.as_deref().map(clip).unwrap_or_else(|| format!("Cursor did not sign in to {name}.")),
                    });
                }
            }
        };
        let (state, redirect_uri) = auth_url_parts(&auth_url).ok_or("Cursor's sign-in page names no redirect.")?;
        let parsed = url::Url::parse(&redirect_uri).map_err(|_| "Cursor's sign-in page names no redirect.".to_string())?;
        if !loopback(&parsed) {
            return Err("Cursor's sign-in redirects off this machine, which Crew cannot hand over.".into());
        }
        let (tx, rx) = mpsc::channel::<FlowMsg>();
        let host = self.clone();
        let key = state.clone();
        thread::spawn(move || {
            // The process lives until its redirect is in, or the flow ends.
            if let Ok(FlowMsg::Callback { url, reply }) = rx.recv_timeout(FLOW_TTL) {
                let done = loopback_get(&url).and_then(|()| {
                    let exited = login.wait(FINISH_TIMEOUT);
                    // Its last words say why, if it did not sign in.
                    for line in login.lines.try_iter() {
                        login.last = Some(line.trim().to_string()).filter(|l| !l.is_empty()).or(login.last.take());
                    }
                    match exited {
                        Some(true) => Ok(()),
                        Some(false) => Err(login.last.as_deref().map(clip).unwrap_or_else(|| "Cursor did not sign in.".into())),
                        None => Err("Cursor did not finish the sign-in.".into()),
                    }
                });
                let _ = reply.send(done);
            }
            drop(login);
            lock(&host.inner.flows).remove(&key);
        });
        self.add_flow(&state, "cursor", &redirect_uri, Answer::Process(tx));
        Ok(ProviderSignIn::Browser { state, auth_url, redirect_uri })
    }

    /// A sign-in whose CLI listens on its own loopback with nothing for Crew
    /// to hold (opencode's shared server): the caught redirect is requested
    /// there.
    pub fn loopback_flow(&self, provider: &str, auth_url: String) -> Result<ProviderSignIn, String> {
        self.sweep_flows();
        let (state, redirect_uri) = auth_url_parts(&auth_url).ok_or("The sign-in page names no redirect.")?;
        let parsed = url::Url::parse(&redirect_uri).map_err(|_| "The sign-in page names no redirect.".to_string())?;
        if !loopback(&parsed) {
            return Err("The sign-in redirects off this machine, which Crew cannot hand over.".into());
        }
        self.add_flow(&state, provider, &redirect_uri, Answer::Loopback);
        Ok(ProviderSignIn::Browser { state, auth_url, redirect_uri })
    }

    fn add_flow(&self, state: &str, provider: &str, redirect_uri: &str, answer: Answer) {
        lock(&self.inner.flows).insert(
            state.to_string(),
            Flow { provider: provider.to_string(), redirect_uri: redirect_uri.to_string(), started: Instant::now(), answer },
        );
    }

    /// Finishes a sign-in with the redirect Crew's window caught, then reads
    /// that provider's servers again. A redirect that is not the flow's is
    /// refused, and the flow keeps waiting for its own.
    pub fn callback(&self, state: &str, url: &str) -> Result<(), String> {
        self.sweep_flows();
        let flow = {
            let mut flows = lock(&self.inner.flows);
            let flow = flows.get(state).ok_or("No sign-in is waiting for that page.")?;
            check_callback(&flow.redirect_uri, state, url)?;
            flows.remove(state).ok_or("No sign-in is waiting for that page.")?
        };
        let done = match flow.answer {
            Answer::Process(tx) => {
                let (reply, answered) = mpsc::channel();
                tx.send(FlowMsg::Callback { url: url.to_string(), reply }).map_err(|_| "The sign-in ended.".to_string())?;
                answered
                    .recv_timeout(FINISH_TIMEOUT + Duration::from_secs(5))
                    .unwrap_or_else(|_| Err("The CLI did not finish the sign-in.".into()))
            }
            Answer::Loopback => loopback_get(url),
        };
        self.refresh(&[flow.provider.as_str()]);
        done
    }

    /// The user closed the sign-in: its process ends.
    pub fn cancel(&self, state: &str) {
        // Dropping the sender ends the thread that holds the process.
        lock(&self.inner.flows).remove(state);
    }

    /// Whether a sign-in waits on `state`.
    pub fn waiting(&self, state: &str) -> bool {
        lock(&self.inner.flows).contains_key(state)
    }
}

mod grok;

#[cfg(test)]
mod tests;
