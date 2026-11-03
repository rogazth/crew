//! Grok's side of its servers: how each stands, and its sign-in.
//!
//! `grok mcp list` says nothing of how a server stands, so a remote one that
//! is on is checked with `grok mcp doctor <name> --json`. Grok signs in to a
//! server only from its TUI (`/mcps`, then `i`), or over ACP with
//! `_x.ai/mcp/auth_trigger`, which opens the system browser and returns no
//! page. So Crew signs in itself, in its own window, as it does for a
//! connector, and hands the grant to Grok: one entry in Grok's credential
//! store, `<grok home>/mcp_credentials.json`, keyed `<name>:<url>`, holding
//! rmcp's `StoredCredentials` (measured on grok 1.0.70 against the fake
//! server: Grok uses the entry and refreshes it with the client in it). Crew
//! keeps no copy.

use std::future::Future;
use std::io::Write;
use std::os::unix::fs::OpenOptionsExt;
use std::os::unix::io::AsRawFd;
use std::path::Path;

use crew_protocol::{McpState, ProviderServer};
use serde_json::{json, Map, Value};

use crate::connectors::oauth::{self, Client, Discovery, Pkce, Tokens};
use crate::store::now_millis;

use super::clip;

/// How long one server's check may take: an unreachable host takes a while to say so.
pub(super) const DOCTOR_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(20);

/// Sets a server's state from `grok mcp doctor --json`: healthy is
/// Connected, an `Auth required` handshake waits on a sign-in, anything else
/// failed. A report without the server leaves it as it was.
pub fn apply_doctor(server: &mut ProviderServer, report: &Value) {
    let Some(row) =
        report.get("servers").and_then(Value::as_array).and_then(|rows| rows.iter().find(|r| r["name"] == server.name.as_str()))
    else {
        return;
    };
    let checks = row.get("checks").and_then(Value::as_array).map(Vec::as_slice).unwrap_or_default();
    if row.get("healthy") == Some(&Value::Bool(true)) {
        server.state = McpState::Connected;
        server.error = None;
        // "2 tools discovered".
        server.tools = checks
            .iter()
            .filter_map(|c| c.get("label").and_then(Value::as_str))
            .find_map(|label| label.strip_suffix(" tools discovered").or(label.strip_suffix(" tool discovered")))
            .and_then(|n| n.trim().parse().ok());
        return;
    }
    let detail = checks
        .iter()
        .find(|c| c.get("passed") == Some(&Value::Bool(false)))
        .and_then(|c| c.get("detail"))
        .and_then(Value::as_str)
        .unwrap_or_default();
    if detail.contains("Auth required") {
        server.state = McpState::NeedsAuth;
        server.error = None;
    } else {
        server.state = McpState::Failed;
        server.error = Some(clip(short_error(detail)));
    }
}

/// rmcp's error without its transport's type: what comes after `error: `,
/// up to `, when`.
fn short_error(detail: &str) -> &str {
    let tail = detail.rsplit_once("] error: ").map_or(detail, |(_, tail)| tail);
    let tail = tail.split_once(", when ").map_or(tail, |(head, _)| head);
    if tail.trim().is_empty() {
        "It didn’t start."
    } else {
        tail
    }
}

/// Runs `work` on a runtime of its own, on a thread of its own, so it can be
/// waited on from a thread that is already inside one (the daemon's blocking
/// pool) or from none.
pub(super) fn on_runtime<T: Send + 'static>(work: impl Future<Output = T> + Send + 'static) -> Result<T, String> {
    std::thread::spawn(move || {
        tokio::runtime::Builder::new_current_thread().enable_all().build().map(|runtime| runtime.block_on(work))
    })
    .join()
    .map_err(|_| "The sign-in stopped.".to_string())?
    .map_err(|e| format!("The sign-in could not start: {e}"))
}

/// The first half of a sign-in: where the server signs in, Crew's
/// registration there, and the page for Crew's window.
pub struct Start {
    pub discovery: Discovery,
    pub client: Client,
    pub pkce: Pkce,
    pub auth_url: String,
}

pub async fn start(url: &str, redirect_uri: &str) -> Result<Start, String> {
    let discovery = oauth::discover(url).await.map_err(|e| e.to_string())?;
    let client = oauth::register(&discovery, redirect_uri).await.map_err(|e| e.to_string())?;
    // Grok's entry has room for a client id only: a registration with a
    // secret could sign in once and never refresh.
    if client.secret.is_some() {
        return Err("This server gives its clients a secret, which Grok has nowhere to keep.".into());
    }
    let pkce = Pkce::new();
    let auth_url = oauth::authorize_url(&discovery, &client.id, redirect_uri, &pkce).map_err(|e| e.to_string())?;
    Ok(Start { discovery, client, pkce, auth_url })
}

/// rmcp's `StoredCredentials` for a grant, as Grok writes them.
pub fn stored_credentials(client: &Client, discovery: &Discovery, tokens: &Tokens, now_ms: i64) -> Value {
    let mut response = Map::new();
    response.insert("access_token".into(), json!(tokens.access_token));
    response.insert("token_type".into(), json!("bearer"));
    if let Some(at) = tokens.expires_at {
        response.insert("expires_in".into(), json!(((at - now_ms) / 1000).max(0)));
    }
    if let Some(refresh) = &tokens.refresh_token {
        response.insert("refresh_token".into(), json!(refresh));
    }
    if let Some(scope) = &tokens.scope {
        response.insert("scope".into(), json!(scope));
    }
    let granted: Vec<&str> = match &tokens.scope {
        Some(scope) => scope.split_whitespace().collect(),
        None => discovery.scopes.iter().map(String::as_str).collect(),
    };
    json!({
        "client_id": client.id,
        "token_response": Value::Object(response),
        "granted_scopes": granted,
        "token_received_at": now_ms / 1000,
        "issuer": discovery.issuer,
    })
}

/// The second half: the caught redirect into tokens, and the tokens into
/// Grok's credential store under `<name>:<url>`.
pub async fn finish(
    start: &Start,
    redirect_uri: &str,
    callback_url: &str,
    grok_home: &Path,
    name: &str,
    url: &str,
) -> Result<(), String> {
    let tokens = oauth::exchange(&start.discovery, &start.client, redirect_uri, &start.pkce, callback_url)
        .await
        .map_err(|e| e.to_string())?;
    let entry = stored_credentials(&start.client, &start.discovery, &tokens, now_millis());
    write_entry(grok_home, &format!("{name}:{url}"), entry)
}

/// Puts one entry in Grok's credential store, keeping the others: under
/// Grok's own lock file, written beside it and renamed over, owner-only.
pub fn write_entry(grok_home: &Path, key: &str, entry: Value) -> Result<(), String> {
    std::fs::create_dir_all(grok_home).map_err(|e| format!("Grok's folder could not be made: {e}"))?;
    let lock = std::fs::OpenOptions::new()
        .create(true)
        .truncate(false)
        .write(true)
        .open(grok_home.join("mcp_credentials.lock"))
        .map_err(|e| format!("Grok's credentials could not be locked: {e}"))?;
    // SAFETY: flock on a file this function holds open; released when it closes.
    if unsafe { libc::flock(lock.as_raw_fd(), libc::LOCK_EX) } != 0 {
        return Err("Grok's credentials could not be locked.".into());
    }
    let file = grok_home.join("mcp_credentials.json");
    let mut store: Map<String, Value> = match std::fs::read_to_string(&file) {
        Ok(text) if text.trim().is_empty() => Map::new(),
        Ok(text) => serde_json::from_str(&text).map_err(|_| "Grok's credentials file could not be read.".to_string())?,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Map::new(),
        Err(_) => return Err("Grok's credentials file could not be read.".into()),
    };
    store.insert(key.to_string(), entry);
    let text =
        serde_json::to_string_pretty(&Value::Object(store)).map_err(|_| "The credentials could not be written.".to_string())?;
    let temp = file.with_extension(format!("crew-{}", std::process::id()));
    let mut out = std::fs::OpenOptions::new()
        .create(true)
        .truncate(true)
        .write(true)
        .mode(0o600)
        .open(&temp)
        .map_err(|e| format!("Grok's credentials could not be written: {e}"))?;
    out.write_all(text.as_bytes()).map_err(|e| format!("Grok's credentials could not be written: {e}"))?;
    drop(out);
    std::fs::rename(&temp, &file).map_err(|e| {
        let _ = std::fs::remove_file(&temp);
        format!("Grok's credentials could not be written: {e}")
    })
}
