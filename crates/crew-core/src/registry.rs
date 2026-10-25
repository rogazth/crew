//! The daemon's copy of the official MCP Registry (registry.modelcontextprotocol.io),
//! for Integrations to browse and search.
//!
//! The window cannot read the registry itself: it sends no CORS headers, and it
//! holds some 49k servers, 32k of them remote, too many to page through on
//! every open. So the Mac's daemon keeps the remote ones in SQLite with a full
//! text index. It starts as the daemon does: the featured servers first, one
//! request each, so the page has them within seconds; then every page of the
//! registry, once, resuming where it stopped; then, every six hours, only what
//! changed since. Until the first full pass is done a search also asks the
//! registry live.
//!
//! Anyone can publish to the registry, so nothing here is trusted: it is text
//! to show, and a URL to connect to later.

use std::collections::HashMap;
use std::path::Path;
use std::sync::atomic::{AtomicBool, Ordering};
use std::thread;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use crew_protocol::{RegistryServer, RegistryStatus};
use rusqlite::{params, Connection, OptionalExtension};
use serde::Deserialize;
use serde_json::Value;

use crate::http_local::encode_uri_component;
use crate::store::{now_millis, read_state, write_state, Store};

pub const MIGRATION_V43: &str = r#"
CREATE TABLE IF NOT EXISTS registry_servers (
  name        TEXT PRIMARY KEY,
  title       TEXT,
  description TEXT NOT NULL DEFAULT '',
  publisher   TEXT NOT NULL,
  remote_url  TEXT NOT NULL,
  icon_url    TEXT,
  first_party INTEGER NOT NULL,
  updated_at  TEXT NOT NULL
);

CREATE VIRTUAL TABLE IF NOT EXISTS registry_fts
  USING fts5(name, title, description, publisher, content='registry_servers', content_rowid='rowid');

CREATE TRIGGER IF NOT EXISTS registry_ai AFTER INSERT ON registry_servers BEGIN
  INSERT INTO registry_fts (rowid, name, title, description, publisher)
  VALUES (new.rowid, new.name, new.title, new.description, new.publisher);
END;

CREATE TRIGGER IF NOT EXISTS registry_ad AFTER DELETE ON registry_servers BEGIN
  INSERT INTO registry_fts (registry_fts, rowid, name, title, description, publisher)
  VALUES ('delete', old.rowid, old.name, old.title, old.description, old.publisher);
END;

CREATE TRIGGER IF NOT EXISTS registry_au AFTER UPDATE ON registry_servers BEGIN
  INSERT INTO registry_fts (registry_fts, rowid, name, title, description, publisher)
  VALUES ('delete', old.rowid, old.name, old.title, old.description, old.publisher);
  INSERT INTO registry_fts (rowid, name, title, description, publisher)
  VALUES (new.rowid, new.name, new.title, new.description, new.publisher);
END;
"#;

const BASE: &str = "https://registry.modelcontextprotocol.io/v0.1/servers";

/// Vendors' own servers, in the order the browse list shows them.
pub const FEATURED: [&str; 22] = [
    "com.notion/mcp",
    "app.linear/linear",
    "io.github.github/github-mcp-server",
    "com.atlassian/atlassian-mcp-server",
    "io.github.getsentry/sentry-mcp",
    "com.figma.mcp/mcp",
    "com.stripe/mcp",
    "com.supabase/mcp",
    "com.vercel/vercel-mcp",
    "com.cloudflare.mcp/mcp",
    "com.gitlab/mcp",
    "com.neon/mcp",
    "com.airtable/mcp",
    "com.monday/monday.com",
    "com.canva.mcp/mcp",
    "com.webflow/mcp",
    "com.zapier/mcp",
    "com.paypal.mcp/mcp",
    "co.huggingface/hf-mcp-server",
    "ai.exa/exa",
    "io.github.upstash/context7",
    "com.wix/mcp",
];

/// When the last full or incremental pass finished, in millis.
const SYNCED_AT: &str = "registry:synced-at";
/// When that pass started: the next one asks for what changed since.
const STARTED_AT: &str = "registry:started-at";
/// Set once every page has been read.
const FULL: &str = "registry:full";
/// Where an unfinished full pass stopped.
const CURSOR: &str = "registry:cursor";

const EVERY: Duration = Duration::from_secs(6 * 3600);
const RETRY: Duration = Duration::from_secs(10 * 60);
const PAGE: u32 = 100;
const FETCH_TIMEOUT: Duration = Duration::from_secs(30);
/// A change the registry wrote late still lands in the next window.
const OVERLAP_MS: i64 = 3_600_000;
const SEARCH_MAX: u32 = 600;

static SYNCING: AtomicBool = AtomicBool::new(false);

/* ── The registry's JSON ─────────────────────────────────────────────── */

#[derive(Deserialize)]
struct Entry {
    server: Server,
    #[serde(rename = "_meta", default)]
    meta: Value,
}

#[derive(Deserialize)]
struct Server {
    name: String,
    #[serde(default)]
    title: Option<String>,
    #[serde(default)]
    description: Option<String>,
    #[serde(default)]
    icons: Vec<Icon>,
    #[serde(default)]
    remotes: Vec<Remote>,
}

#[derive(Deserialize)]
struct Icon {
    src: String,
    #[serde(rename = "mimeType", default)]
    mime_type: Option<String>,
    #[serde(default)]
    sizes: Vec<String>,
}

#[derive(Deserialize)]
struct Remote {
    #[serde(rename = "type", default)]
    kind: String,
    url: String,
}

/// One page: the servers that parsed (a bad one is skipped, not the page), and the next cursor.
fn parse_page(text: &str) -> Option<(Vec<Entry>, Option<String>)> {
    let page: Value = serde_json::from_str(text).ok()?;
    let entries =
        page.get("servers")?.as_array()?.iter().filter_map(|entry| serde_json::from_value(entry.clone()).ok()).collect();
    let cursor = page.pointer("/metadata/nextCursor").and_then(Value::as_str).filter(|c| !c.is_empty()).map(str::to_string);
    Some((entries, cursor))
}

/// What a registry entry becomes here; `None` for one Crew cannot connect (no remote) or one withdrawn.
fn to_row(entry: &Entry) -> Option<RegistryServer> {
    let official = entry.meta.get("io.modelcontextprotocol.registry/official");
    let status = official.and_then(|o| o.get("status")).and_then(Value::as_str).unwrap_or("active");
    if status != "active" {
        return None;
    }
    let server = &entry.server;
    // Streamable HTTP is the transport MCP keeps; SSE is the one it retired.
    let remote = server.remotes.iter().find(|r| r.kind == "streamable-http").or(server.remotes.first())?;
    let publisher = publisher_of(&server.name, &remote.url);
    Some(RegistryServer {
        name: server.name.clone(),
        title: server.title.clone().filter(|t| !t.trim().is_empty()),
        description: server.description.clone().unwrap_or_default(),
        first_party: first_party(&server.name, &remote.url, &publisher),
        publisher,
        remote_url: remote.url.clone(),
        icon_url: icon_of(&server.icons),
        updated_at: official.and_then(|o| o.get("updatedAt")).and_then(Value::as_str).unwrap_or_default().to_string(),
    })
}

fn host_of(url: &str) -> String {
    let rest = url.split_once("://").map_or(url, |(_, rest)| rest);
    let authority = rest.split(['/', '?', '#']).next().unwrap_or_default();
    let host = authority.rsplit_once('@').map_or(authority, |(_, host)| host);
    host.split(':').next().unwrap_or_default().to_ascii_lowercase()
}

/// The last two labels: `mcp.notion.com` is notion.com.
fn registrable(host: &str) -> String {
    let labels: Vec<&str> = host.split('.').filter(|l| !l.is_empty()).collect();
    labels[labels.len().saturating_sub(2)..].join(".")
}

/// `com.cloudflare.mcp/mcp` is cloudflare.com. A GitHub namespace names a
/// person or an org, not a domain, so its server's host does.
fn publisher_of(name: &str, remote_url: &str) -> String {
    let namespace = name.split('/').next().unwrap_or_default();
    if namespace.starts_with("io.github.") {
        let host = host_of(remote_url);
        return if host.is_empty() { "github.com".into() } else { registrable(&host) };
    }
    let labels: Vec<&str> = namespace.split('.').collect();
    match labels.as_slice() {
        [tld, domain, ..] => format!("{domain}.{tld}"),
        _ => namespace.to_string(),
    }
}

/// Served by whoever publishes it. A domain namespace is proven, so its server
/// must be on that domain. A GitHub one names only an owner: its host must
/// carry that owner's name (getsentry on sentry.dev, github on
/// githubcopilot.com), else anyone could wrap anything under their account.
fn first_party(name: &str, remote_url: &str, publisher: &str) -> bool {
    let host = registrable(&host_of(remote_url));
    let Some(owner) = name.split('/').next().and_then(|ns| ns.strip_prefix("io.github.")) else {
        return host == publisher;
    };
    let owner = owner.to_ascii_lowercase();
    let label = host.split('.').next().unwrap_or_default();
    label.len() >= 3 && (owner.contains(label) || label.contains(owner.as_str()))
}

/// An SVG scales to any tile; else a PNG big enough not to blur; else whatever there is.
fn icon_of(icons: &[Icon]) -> Option<String> {
    let big = |icon: &&Icon| {
        icon.sizes.iter().any(|size| size.split('x').next().and_then(|n| n.parse::<u32>().ok()).is_some_and(|n| n >= 64))
    };
    icons
        .iter()
        .find(|i| i.mime_type.as_deref() == Some("image/svg+xml"))
        .or_else(|| icons.iter().find(|i| i.mime_type.as_deref() == Some("image/png") && big(i)))
        .or(icons.first())
        .map(|i| i.src.clone())
}

/* ── The copy ────────────────────────────────────────────────────────── */

fn upsert(conn: &Connection, rows: &[RegistryServer]) -> rusqlite::Result<()> {
    let tx = conn.unchecked_transaction()?;
    {
        let mut put = tx.prepare_cached(
            "INSERT INTO registry_servers (name, title, description, publisher, remote_url, icon_url, first_party, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)
             ON CONFLICT(name) DO UPDATE SET
               title = excluded.title, description = excluded.description, publisher = excluded.publisher,
               remote_url = excluded.remote_url, icon_url = excluded.icon_url,
               first_party = excluded.first_party, updated_at = excluded.updated_at",
        )?;
        for row in rows {
            put.execute(params![
                row.name,
                row.title,
                row.description,
                row.publisher,
                row.remote_url,
                row.icon_url,
                row.first_party,
                row.updated_at
            ])?;
        }
    }
    tx.commit()
}

fn remove(conn: &Connection, names: &[String]) -> rusqlite::Result<()> {
    let mut gone = conn.prepare_cached("DELETE FROM registry_servers WHERE name = ?1")?;
    for name in names {
        gone.execute(params![name])?;
    }
    Ok(())
}

/// A page into the copy: what Crew can connect is kept, what it can't (or no longer exists) goes.
fn store_page(store: &Store, entries: &[Entry]) -> Result<usize, String> {
    let mut rows = Vec::new();
    let mut gone = Vec::new();
    for entry in entries {
        match to_row(entry) {
            Some(row) => rows.push(row),
            None => gone.push(entry.server.name.clone()),
        }
    }
    store.with(|conn| {
        upsert(conn, &rows)?;
        remove(conn, &gone)
    })?;
    Ok(rows.len())
}

const COLUMNS: &str = "s.name, s.title, s.description, s.publisher, s.remote_url, s.icon_url, s.first_party, s.updated_at";

fn read_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<RegistryServer> {
    Ok(RegistryServer {
        name: row.get(0)?,
        title: row.get(1)?,
        description: row.get(2)?,
        publisher: row.get(3)?,
        remote_url: row.get(4)?,
        icon_url: row.get(5)?,
        first_party: row.get(6)?,
        updated_at: row.get(7)?,
    })
}

/// The words typed, as an FTS5 query: each one quoted, all required, the last a prefix.
pub(crate) fn fts_query(text: &str) -> Option<String> {
    let words: Vec<String> = text
        .split(|c: char| !c.is_alphanumeric())
        .filter(|w| !w.is_empty())
        .map(|w| format!("\"{}\"", w.to_lowercase()))
        .collect();
    let (last, rest) = words.split_last()?;
    Some(rest.iter().cloned().chain([format!("{last}*")]).collect::<Vec<_>>().join(" "))
}

fn featured_local(store: &Store) -> Result<Vec<RegistryServer>, String> {
    let rows = store.with(|conn| {
        let mut list = Vec::new();
        let mut get = conn.prepare_cached(&format!("SELECT {COLUMNS} FROM registry_servers s WHERE s.name = ?1"))?;
        for name in FEATURED {
            if let Some(row) = get.query_map(params![name], read_row)?.next() {
                list.push(row?);
            }
        }
        Ok(list)
    })?;
    Ok(rows)
}

fn featured(name: &str) -> bool {
    FEATURED.contains(&name)
}

/// One publisher's dozen near-identical servers would fill the page: a few each.
const PER_PUBLISHER: usize = 2;

fn varied(list: Vec<RegistryServer>, limit: u32) -> Vec<RegistryServer> {
    let mut seen: HashMap<String, usize> = HashMap::new();
    list.into_iter()
        .filter(|row| {
            let count = seen.entry(row.publisher.clone()).or_default();
            *count += 1;
            *count <= PER_PUBLISHER
        })
        .take(limit as usize)
        .collect()
}

fn search_local(store: &Store, query: &str, limit: u32) -> Result<Vec<RegistryServer>, String> {
    // The vendors the browse list features rank above everyone, then servers on their publisher's own domain.
    let featured = FEATURED.iter().map(|name| format!("'{name}'")).collect::<Vec<_>>().join(", ");
    store.with(|conn| {
        conn.prepare_cached(&format!(
            "SELECT {COLUMNS} FROM registry_fts f JOIN registry_servers s ON s.rowid = f.rowid
              WHERE registry_fts MATCH ?1
              ORDER BY s.name IN ({featured}) DESC, s.first_party DESC, bm25(registry_fts, 6.0, 8.0, 1.0, 4.0)
              LIMIT ?2"
        ))?
        .query_map(params![query, limit], read_row)?
        .collect()
    })
}

/// What the browse list shows: the featured servers for no text, the matches for some.
pub fn search(store: &Store, text: &str, limit: u32) -> Result<Vec<RegistryServer>, String> {
    let limit = limit.clamp(1, SEARCH_MAX);
    let text = text.trim();
    if text.is_empty() {
        let mut list = featured_local(store)?;
        // The first open, before the startup fetch landed: ask now rather than show nothing.
        if list.is_empty() && fetch_featured(store) > 0 {
            list = featured_local(store)?;
        }
        list.truncate(limit as usize);
        return Ok(list);
    }
    let Some(query) = fts_query(text) else { return Ok(Vec::new()) };
    // Fetched deep enough that capping each publisher still fills the page.
    let mut list = search_local(store, &query, limit * 4)?;
    // Until every page is in, the copy may not have it yet: the registry's own
    // search (on names) fills in, and what it finds is kept.
    if !full(store) {
        let found = search_live(store, text);
        let extra: Vec<RegistryServer> = found.into_iter().filter(|row| !list.iter().any(|have| have.name == row.name)).collect();
        list.extend(extra);
        // Featured, then first party, each group in the order it came.
        list.sort_by_key(|row| (!featured(&row.name), !row.first_party));
    }
    Ok(varied(list, limit))
}

/// The registry server each URL is: the one at that very URL, else the one
/// on its host (a CLI may name an older path, `/v1/mcp` for `/v2/mcp`), the
/// featured and first-party ones first. A URL nothing matches is left out.
pub fn match_urls(store: &Store, urls: &[String]) -> Result<Vec<(String, RegistryServer)>, String> {
    let featured = FEATURED.iter().map(|name| format!("'{name}'")).collect::<Vec<_>>().join(", ");
    store.with(|conn| {
        let mut out = Vec::new();
        for url in urls {
            let Some((exact, origin)) = url_keys(url) else { continue };
            let found = conn
                .prepare_cached(&format!(
                    "SELECT {COLUMNS} FROM registry_servers s
                      WHERE rtrim(lower(s.remote_url), '/') = ?1
                         OR lower(s.remote_url) = ?2 OR lower(s.remote_url) LIKE ?2 || '/%'
                      ORDER BY rtrim(lower(s.remote_url), '/') = ?1 DESC, s.name IN ({featured}) DESC,
                               s.first_party DESC, s.updated_at DESC
                      LIMIT 1"
                ))?
                .query_row(params![exact, origin], read_row)
                .optional()?;
            if let Some(server) = found {
                out.push((url.clone(), server));
            }
        }
        Ok(out)
    })
}

/// `https://mcp.notion.com/mcp/` → (`https://mcp.notion.com/mcp`, `https://mcp.notion.com`), lowercased, query dropped.
fn url_keys(url: &str) -> Option<(String, String)> {
    let lower = url.trim().to_ascii_lowercase();
    let rest = lower.strip_prefix("https://").or_else(|| lower.strip_prefix("http://"))?;
    let scheme = &lower[..lower.len() - rest.len()];
    let no_query = rest.split(['?', '#']).next().unwrap_or(rest);
    let host = no_query.split('/').next().filter(|h| !h.is_empty())?;
    Some((format!("{scheme}{}", no_query.trim_end_matches('/')), format!("{scheme}{host}")))
}

/// One server by its name, as the copy has it: what a connector is installed from.
pub fn server(store: &Store, name: &str) -> Result<Option<RegistryServer>, String> {
    store.with(|conn| {
        conn.query_row(&format!("SELECT {COLUMNS} FROM registry_servers s WHERE s.name = ?1"), [name], read_row)
            .optional()
    })
}

pub fn status(store: &Store) -> Result<RegistryStatus, String> {
    store.with(|conn| {
        let servers: u32 = conn.query_row("SELECT COUNT(*) FROM registry_servers", [], |row| row.get(0))?;
        let synced_at = read_state(conn, SYNCED_AT)?.and_then(|v| v.parse().ok());
        Ok(RegistryStatus { servers, synced_at, syncing: SYNCING.load(Ordering::Relaxed) })
    })
}

fn full(store: &Store) -> bool {
    store.with(|conn| read_state(conn, FULL)).ok().flatten().is_some()
}

/* ── The network ─────────────────────────────────────────────────────── */

fn sandboxed() -> bool {
    std::env::var_os("CREW_SANDBOX").is_some_and(|value| !value.is_empty())
}

fn get(url: &str) -> Option<String> {
    if sandboxed() {
        return None;
    }
    let timeout = FETCH_TIMEOUT.as_secs().to_string();
    crate::provider_status::run(
        Path::new("curl"),
        &["-fsS", "-m", &timeout, "-H", "accept: application/json", url],
        FETCH_TIMEOUT + Duration::from_secs(5),
    )
}

/// The featured servers, all at once. How many landed.
fn fetch_featured(store: &Store) -> usize {
    let handles: Vec<_> = FEATURED
        .iter()
        .map(|name| {
            let url = format!("{BASE}/{}/versions/latest", encode_uri_component(name));
            thread::spawn(move || get(&url).and_then(|text| serde_json::from_str::<Entry>(&text).ok()))
        })
        .collect();
    let entries: Vec<Entry> = handles.into_iter().filter_map(|h| h.join().ok().flatten()).collect();
    store_page(store, &entries).unwrap_or(0)
}

fn search_live(store: &Store, text: &str) -> Vec<RegistryServer> {
    let url = format!("{BASE}?search={}&version=latest&limit={PAGE}", encode_uri_component(text));
    let Some((entries, _)) = get(&url).as_deref().and_then(parse_page) else { return Vec::new() };
    let _ = store_page(store, &entries);
    entries.iter().filter_map(to_row).collect()
}

/// Every page from `cursor` on (or, with `since`, every page of what changed since then).
/// `false` when a page failed: the pass stops there, and a full one resumes from it.
fn pages(store: &Store, since: Option<&str>, mut cursor: Option<String>) -> bool {
    let mut seen = 0usize;
    loop {
        let mut url = format!("{BASE}?version=latest&limit={PAGE}");
        if let Some(since) = since {
            url.push_str(&format!("&updated_since={}", encode_uri_component(since)));
        }
        if let Some(cursor) = &cursor {
            url.push_str(&format!("&cursor={}", encode_uri_component(cursor)));
        }
        let Some((entries, next)) = get(&url).as_deref().and_then(parse_page) else {
            eprintln!("[crewd] registry: a page failed after {seen} servers; trying again later");
            return false;
        };
        seen += entries.len();
        if store_page(store, &entries).is_err() {
            return false;
        }
        if since.is_none() {
            let _ = store.with(|conn| write_state(conn, CURSOR, next.as_deref()));
        }
        match next {
            Some(next) => cursor = Some(next),
            None => return true,
        }
    }
}

fn rfc3339(millis: i64) -> String {
    crate::titles::rfc3339(UNIX_EPOCH + Duration::from_millis(millis.max(0) as u64))
}

/// One pass: every page the first time (resuming an unfinished one), what changed since after.
fn pass(store: &Store) -> bool {
    let started = now_millis();
    let (done_full, previous, cursor) = store
        .with(|conn| {
            Ok((
                read_state(conn, FULL)?.is_some(),
                read_state(conn, STARTED_AT)?.and_then(|v| v.parse::<i64>().ok()),
                read_state(conn, CURSOR)?,
            ))
        })
        .unwrap_or((false, None, None));
    let ok = match (done_full, previous) {
        (true, Some(previous)) => pages(store, Some(&rfc3339(previous - OVERLAP_MS)), None),
        _ => {
            if cursor.is_none() {
                eprintln!("[crewd] registry: reading every page, once");
            }
            pages(store, None, cursor)
        }
    };
    if ok {
        let _ = store.with(|conn| {
            write_state(conn, FULL, Some("1"))?;
            write_state(conn, STARTED_AT, Some(&started.to_string()))?;
            write_state(conn, SYNCED_AT, Some(&now_millis().to_string()))
        });
    }
    ok
}

/// Keeps the copy current for as long as the daemon runs: the featured servers
/// now, then a pass, then one every six hours. A failed pass tries again sooner.
pub fn start_sync(store: Store) {
    if sandboxed() {
        return;
    }
    let _ = thread::Builder::new().name("crewd-registry".into()).spawn(move || {
        SYNCING.store(true, Ordering::Relaxed);
        let landed = fetch_featured(&store);
        if landed == 0 {
            eprintln!("[crewd] registry: unreachable");
        }
        loop {
            SYNCING.store(true, Ordering::Relaxed);
            let begun = SystemTime::now();
            let ok = pass(&store);
            SYNCING.store(false, Ordering::Relaxed);
            if ok {
                let servers = status(&store).map(|s| s.servers).unwrap_or(0);
                eprintln!(
                    "[crewd] registry: {servers} servers, synced in {}s",
                    begun.elapsed().map(|d| d.as_secs()).unwrap_or(0)
                );
            }
            thread::sleep(if ok { EVERY } else { RETRY });
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    fn store() -> Store {
        let dir = std::env::temp_dir().join(format!("crew-registry-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).expect("dir");
        Store::open(dir.join("crew.sqlite3")).expect("store")
    }

    fn entry(json: Value) -> Entry {
        serde_json::from_value(json).expect("entry")
    }

    #[test]
    fn a_namespace_names_its_publisher() {
        assert_eq!(publisher_of("com.cloudflare.mcp/mcp", "https://docs.mcp.cloudflare.com/mcp"), "cloudflare.com");
        assert_eq!(publisher_of("app.linear/linear", "https://mcp.linear.app/mcp"), "linear.app");
        assert_eq!(publisher_of("co.huggingface/hf-mcp-server", "https://huggingface.co/mcp?login"), "huggingface.co");
        // A GitHub namespace is a person or an org: the server's host says who publishes it.
        assert_eq!(publisher_of("io.github.getsentry/sentry-mcp", "https://mcp.sentry.dev/mcp"), "sentry.dev");
        assert_eq!(publisher_of("io.github.someone/thing", ""), "github.com");
    }

    #[test]
    fn first_party_is_served_from_the_publishers_domain() {
        let own = to_row(&entry(serde_json::json!({
            "server": { "name": "com.stripe/mcp", "remotes": [{ "type": "streamable-http", "url": "https://mcp.stripe.com" }] }
        })))
        .expect("row");
        assert!(own.first_party);
        let wrapper = to_row(&entry(serde_json::json!({
            "server": { "name": "com.insightfulpipe/stripe", "remotes": [{ "type": "streamable-http", "url": "https://stripe.insightfulmcp.com/" }] }
        })))
        .expect("row");
        assert!(!wrapper.first_party);
    }

    #[test]
    fn a_github_owner_must_be_in_its_servers_host() {
        assert!(first_party("io.github.getsentry/sentry-mcp", "https://mcp.sentry.dev/mcp", "sentry.dev"));
        assert!(first_party("io.github.github/github-mcp-server", "https://api.githubcopilot.com/mcp/", "githubcopilot.com"));
        assert!(!first_party("io.github.sadri-dridi/jira-key-shape", "https://named.example.dev/mcp", "example.dev"));
    }

    #[test]
    fn only_active_remote_servers_are_kept() {
        let local = entry(serde_json::json!({ "server": { "name": "io.github.a/b", "packages": [{}] } }));
        assert!(to_row(&local).is_none());
        let gone = entry(serde_json::json!({
            "server": { "name": "com.a/b", "remotes": [{ "type": "sse", "url": "https://a.com/sse" }] },
            "_meta": { "io.modelcontextprotocol.registry/official": { "status": "deleted" } }
        }));
        assert!(to_row(&gone).is_none());
    }

    #[test]
    fn streamable_http_wins_over_sse() {
        let row = to_row(&entry(serde_json::json!({
            "server": { "name": "com.notion/mcp", "remotes": [
                { "type": "sse", "url": "https://mcp.notion.com/sse" },
                { "type": "streamable-http", "url": "https://mcp.notion.com/mcp" }
            ] }
        })))
        .expect("row");
        assert_eq!(row.remote_url, "https://mcp.notion.com/mcp");
    }

    #[test]
    fn an_svg_icon_wins_then_a_big_png() {
        let icon =
            |src: &str, mime: &str, size: &str| Icon { src: src.into(), mime_type: Some(mime.into()), sizes: vec![size.into()] };
        assert_eq!(
            icon_of(&[icon("a.png", "image/png", "256x256"), icon("a.svg", "image/svg+xml", "any")]).as_deref(),
            Some("a.svg")
        );
        assert_eq!(
            icon_of(&[icon("s.png", "image/png", "32x32"), icon("b.png", "image/png", "128x128")]).as_deref(),
            Some("b.png")
        );
        assert_eq!(icon_of(&[icon("s.png", "image/png", "32x32")]).as_deref(), Some("s.png"));
        assert_eq!(icon_of(&[]), None);
    }

    #[test]
    fn the_last_word_is_a_prefix() {
        assert_eq!(fts_query("jir").as_deref(), Some("\"jir\"*"));
        assert_eq!(fts_query("  Google  drive ").as_deref(), Some("\"google\" \"drive\"*"));
        // Quotes and FTS operators typed by the user are only separators.
        assert_eq!(fts_query("a\"b OR c*").as_deref(), Some("\"a\" \"b\" \"or\" \"c\"*"));
        assert_eq!(fts_query(" -/ "), None);
    }

    #[test]
    fn a_page_skips_what_does_not_parse() {
        let (entries, cursor) = parse_page(
            r#"{"servers":[{"server":{"name":"com.a/b","remotes":[{"type":"streamable-http","url":"https://mcp.a.com"}]}},{"server":{"title":"no name"}}],
               "metadata":{"nextCursor":"com.a/b:1.0.0","count":2}}"#,
        )
        .expect("page");
        assert_eq!(entries.len(), 1);
        assert_eq!(cursor.as_deref(), Some("com.a/b:1.0.0"));
    }

    #[test]
    fn search_finds_by_description_with_first_party_first() {
        let store = store();
        let rows: Vec<Entry> = [
            ("com.insightfulpipe/jira", "Jira MCP by InsightfulPipe", "https://jira.insightfulmcp.com/", "Jira issues"),
            ("com.atlassian/atlassian-mcp-server", "Atlassian Rovo MCP Server", "https://mcp.atlassian.com/v2/mcp", "Connect to Atlassian Jira, Confluence"),
            ("com.notion/mcp", "", "https://mcp.notion.com/mcp", "Official Notion MCP server"),
        ]
        .iter()
        .map(|(name, title, url, description)| {
            entry(serde_json::json!({ "server": { "name": name, "title": title, "description": description, "remotes": [{ "type": "streamable-http", "url": url }] } }))
        })
        .collect();
        store_page(&store, &rows).expect("store");
        // A full pass is recorded so the search stays local.
        store.with(|conn| write_state(conn, FULL, Some("1"))).expect("full");
        let found = search(&store, "jir", 10).expect("search");
        let names: Vec<&str> = found.iter().map(|r| r.name.as_str()).collect();
        assert_eq!(names, ["com.atlassian/atlassian-mcp-server", "com.insightfulpipe/jira"]);
        // An update replaces the row and its index entry.
        let renamed = entry(
            serde_json::json!({ "server": { "name": "com.notion/mcp", "description": "Pages and databases", "remotes": [{ "type": "streamable-http", "url": "https://mcp.notion.com/mcp" }] } }),
        );
        store_page(&store, &[renamed]).expect("update");
        assert!(search(&store, "official", 10).expect("old words").is_empty());
        assert_eq!(search(&store, "databases", 10).expect("new words").len(), 1);
        let check = store.with(|conn| conn.execute_batch("INSERT INTO registry_fts (registry_fts) VALUES ('integrity-check')"));
        assert!(check.is_ok(), "fts5 integrity-check failed: {:?}", check.err());
    }

    #[test]
    fn a_publisher_gets_a_few_places_and_the_rest_go_to_others() {
        let row = |name: &str, publisher: &str| RegistryServer {
            name: name.into(),
            title: None,
            description: String::new(),
            publisher: publisher.into(),
            remote_url: String::new(),
            icon_url: None,
            first_party: false,
            updated_at: String::new(),
        };
        let list = vec![row("a/1", "a.com"), row("a/2", "a.com"), row("a/3", "a.com"), row("b/1", "b.com"), row("a/4", "a.com"), row("c/1", "c.com")];
        let names: Vec<String> = varied(list, 3).into_iter().map(|r| r.name).collect();
        assert_eq!(names, ["a/1", "a/2", "b/1"]);
    }

    /// Against the live registry: `cargo test -p crew-core registry::tests::live -- --ignored --nocapture`.
    #[test]
    #[ignore]
    fn live() {
        let store = store();
        let started = std::time::Instant::now();
        let landed = fetch_featured(&store);
        println!("featured: {landed} in {:?}", started.elapsed());
        assert!(landed >= 15, "only {landed} featured servers landed");
        let featured = search(&store, "", 50).expect("featured");
        assert_eq!(featured.first().map(|r| r.name.as_str()), Some("com.notion/mcp"));
        // Not fully synced: the live search fills in.
        let jira = search(&store, "atlassian", 20).expect("search");
        println!("atlassian: {:?}", jira.iter().map(|r| &r.name).collect::<Vec<_>>());
        assert!(jira.iter().any(|r| r.name == "com.atlassian/atlassian-mcp-server"));
        let jira = search(&store, "jira", 20).expect("search");
        println!("jira: {:?}", jira.iter().map(|r| (&r.name, r.first_party)).collect::<Vec<_>>());
        assert!(jira.iter().any(|r| r.name == "com.atlassian/atlassian-mcp-server"), "jira does not find Atlassian");
        // A few pages of the full pass, to see it parse.
        let mut cursor: Option<String> = None;
        for _ in 0..3 {
            let mut url = format!("{BASE}?version=latest&limit={PAGE}");
            if let Some(c) = &cursor {
                url.push_str(&format!("&cursor={}", encode_uri_component(c)));
            }
            let (entries, next) = get(&url).as_deref().and_then(parse_page).expect("page");
            println!("page: {} entries, {} kept", entries.len(), store_page(&store, &entries).expect("store"));
            cursor = next;
        }
        println!("{:?}", status(&store).expect("status"));
    }

    #[test]
    fn a_url_finds_its_server_by_path_then_by_host() {
        assert_eq!(
            url_keys("https://MCP.notion.com/mcp/?x=1"),
            Some(("https://mcp.notion.com/mcp".into(), "https://mcp.notion.com".into()))
        );
        assert_eq!(url_keys("npx thing"), None);
    }
}
