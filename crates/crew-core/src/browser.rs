//! What the embedded browser remembers: the places visited, and the
//! back/forward stack of each tab.
//!
//! History is global, like the browser's session: one row per normalized URL,
//! whatever workspace it was visited from. `workspace_id` only records where
//! the latest visit came from, so a filter can use it later.
//!
//! The renderer reports every navigation it sees and this module decides what
//! counts. Only http(s) does; everything else is dropped without an error.

use std::sync::atomic::{AtomicUsize, Ordering};

use crew_protocol::{HistoryEntry, PageSnapshot};
use rusqlite::{params, Connection, OptionalExtension};

use crate::store::Store;

pub const MIGRATION_V15: &str = r#"
CREATE TABLE IF NOT EXISTS browser_history (
  url_key         TEXT PRIMARY KEY,
  url             TEXT NOT NULL,
  host            TEXT NOT NULL,
  title           TEXT NOT NULL DEFAULT '',
  visit_count     INTEGER NOT NULL DEFAULT 1,
  last_visited_at INTEGER NOT NULL,
  -- No foreign key: history outlives a removed workspace.
  workspace_id    TEXT
);
CREATE INDEX IF NOT EXISTS browser_history_recent_idx ON browser_history (last_visited_at DESC);
CREATE INDEX IF NOT EXISTS browser_history_host_idx   ON browser_history (host);
"#;

pub const MIGRATION_V16: &str = r#"
CREATE TABLE IF NOT EXISTS browser_pages (
  page_id      TEXT PRIMARY KEY,
  entries_json TEXT NOT NULL,
  active_index INTEGER NOT NULL,
  updated_at   INTEGER NOT NULL
);
"#;

const DAY_MS: i64 = 86_400_000;

/// Retention is whichever of the two limits comes first.
pub const HISTORY_MAX_AGE_MS: i64 = 90 * DAY_MS;
pub const HISTORY_MAX_ROWS: i64 = 10_000;

/// Pruning walks the recency index; doing it on every visit would be waste.
const PRUNE_EVERY: usize = 100;
static VISITS: AtomicUsize = AtomicUsize::new(0);

const SUGGEST_MAX: u32 = 50;
const LIST_MAX: u32 = 500;

/// The renderer trims a stack well under this before saving; this is the
/// backstop against a row that would bloat every read of the table.
pub const PAGE_MAX_BYTES: usize = 512 * 1024;
/// Losing an old stack breaks nothing: the tab still has its URL.
pub const PAGE_MAX_AGE_MS: i64 = 30 * DAY_MS;

/// A URL the way history files it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Normalized {
    /// Identifies the row: two URLs that are the same place share it.
    pub key: String,
    /// What opening the row navigates to: the visited URL as it was.
    pub url: String,
    /// What typing matches against.
    pub host: String,
}

/// Longer URLs are not recorded.
pub const MAX_URL: usize = 8 * 1024;

/// Credentials are dropped from both the key and the stored URL, so a
/// `user:pass@` never reaches the disk. The fragment goes too: it is a place
/// inside a page, not another page.
pub fn normalize(url: &str) -> Option<Normalized> {
    let url = url.trim();
    // A data-stuffed URL is not a page anyone will type back; it would only bloat every scan.
    if url.len() > MAX_URL {
        return None;
    }
    let (raw_scheme, rest) = url.split_once("://")?;
    let scheme = raw_scheme.to_ascii_lowercase();
    let default_port = match scheme.as_str() {
        "http" => 80,
        "https" => 443,
        _ => return None,
    };
    let rest = rest.split_once('#').map_or(rest, |(before, _)| before);
    let (authority, tail) = rest.split_at(rest.find(['/', '?']).unwrap_or(rest.len()));
    // The last `@`: a password may contain one, a host never does.
    let hostport = authority.rsplit_once('@').map_or(authority, |(_, after)| after);
    let (host, port) = split_host_port(hostport)?;
    let host = host.to_lowercase();

    let (path, query) = tail.split_at(tail.find('?').unwrap_or(tail.len()));
    let path = match path {
        "/" | "" if query.is_empty() => "",
        // `a.com?q` and `a.com/?q` are the same request.
        "" => "/",
        path => path,
    };
    let port = port
        .filter(|&port| port != default_port)
        .map(|port| format!(":{port}"))
        .unwrap_or_default();
    let bare = host.strip_prefix("www.").filter(|rest| !rest.is_empty()).unwrap_or(&host);
    Some(Normalized {
        key: format!("{scheme}://{host}{port}{path}{query}"),
        url: format!("{raw_scheme}://{hostport}{tail}"),
        host: bare.to_string(),
    })
}

/// `host[:port]` or `[v6][:port]`. The port is parsed, so `:0443` is `:443`.
fn split_host_port(hostport: &str) -> Option<(&str, Option<u16>)> {
    let (host, port) = match hostport.strip_prefix('[') {
        Some(v6) => {
            let close = v6.find(']')?;
            let inner = &v6[..close];
            if inner.is_empty() || !inner.chars().all(|c| c.is_ascii_hexdigit() || c == ':' || c == '.') {
                return None;
            }
            let port = match &v6[close + 1..] {
                "" => None,
                after => Some(after.strip_prefix(':')?),
            };
            (&hostport[..close + 2], port)
        }
        None => match hostport.rsplit_once(':') {
            Some((host, port)) => (host, Some(port)),
            None => (hostport, None),
        },
    };
    let port = match port {
        None | Some("") => None,
        Some(port) if port.bytes().all(|b| b.is_ascii_digit()) => Some(port.parse().ok()?),
        Some(_) => return None,
    };
    let bad = |c: char| c.is_whitespace() || c.is_control() || (!host.starts_with('[') && matches!(c, ':' | '[' | ']'));
    if host.is_empty() || host.chars().any(bad) {
        return None;
    }
    Some((host, port))
}

/// Count a visit. A title that is still empty keeps the one the row had: a
/// page commits before it sets its title.
pub fn visit(
    store: &Store,
    url: &str,
    title: &str,
    workspace_id: Option<&str>,
    now: i64,
) -> Result<(), String> {
    let Some(normal) = normalize(url) else {
        return Ok(());
    };
    // The first visit after a start prunes as well, so a daemon that never
    // sees a hundred visits still prunes once.
    let prune_now = VISITS.fetch_add(1, Ordering::Relaxed).is_multiple_of(PRUNE_EVERY);
    store.with(|conn| {
        let tx = conn.unchecked_transaction()?;
        tx.prepare_cached(
            "INSERT INTO browser_history (url_key, url, host, title, visit_count, last_visited_at, workspace_id)
             VALUES (?1, ?2, ?3, ?4, 1, ?5, ?6)
             ON CONFLICT(url_key) DO UPDATE SET
               url             = excluded.url,
               visit_count     = visit_count + 1,
               last_visited_at = excluded.last_visited_at,
               workspace_id    = excluded.workspace_id,
               title           = CASE WHEN excluded.title = '' THEN title ELSE excluded.title END",
        )?
        .execute(params![normal.key, normal.url, normal.host, title.trim(), now, workspace_id])?;
        if prune_now {
            prune_in(&tx, now)?;
        }
        tx.commit()
    })
}

/// A title that arrived after its visit was counted. It never inserts: a
/// title for a page history does not have is not a visit.
pub fn set_title(store: &Store, url: &str, title: &str) -> Result<(), String> {
    let title = title.trim();
    let Some(normal) = normalize(url).filter(|_| !title.is_empty()) else {
        return Ok(());
    };
    store.with(|conn| {
        conn.prepare_cached("UPDATE browser_history SET title = ?2 WHERE url_key = ?1")?
            .execute(params![normal.key, title])
    })?;
    Ok(())
}

pub fn prune(store: &Store, now: i64) -> Result<(), String> {
    store.with(|conn| {
        let tx = conn.unchecked_transaction()?;
        prune_in(&tx, now)?;
        tx.commit()
    })
}

fn prune_in(conn: &Connection, now: i64) -> rusqlite::Result<()> {
    conn.prepare_cached("DELETE FROM browser_history WHERE last_visited_at < ?1")?
        .execute(params![now - HISTORY_MAX_AGE_MS])?;
    conn.prepare_cached(
        "DELETE FROM browser_history WHERE url_key IN (
           SELECT url_key FROM browser_history
           ORDER BY last_visited_at DESC LIMIT -1 OFFSET ?1
         )",
    )?
    .execute(params![HISTORY_MAX_ROWS])?;
    Ok(())
}

const COLUMNS: &str = "url_key, url, host, title, visit_count, last_visited_at, workspace_id";

fn row_to_entry(row: &rusqlite::Row) -> rusqlite::Result<HistoryEntry> {
    Ok(HistoryEntry {
        url_key: row.get(0)?,
        url: row.get(1)?,
        host: row.get(2)?,
        title: row.get(3)?,
        visit_count: row.get(4)?,
        last_visited_at: row.get(5)?,
        workspace_id: row.get(6)?,
    })
}

/// What the address bar offers while typing. A host that starts with the
/// text beats one that contains it, which beats a title, which beats the rest
/// of the URL; inside a tier, often and lately visited comes first.
pub fn suggest(store: &Store, text: &str, limit: u32, now: i64) -> Result<Vec<HistoryEntry>, String> {
    let limit = limit.min(SUGGEST_MAX);
    let text = text.trim().to_lowercase();
    if text.is_empty() {
        return store.with(|conn| {
            let mut stmt = conn.prepare_cached(&format!(
                "SELECT {COLUMNS} FROM browser_history ORDER BY last_visited_at DESC LIMIT ?1"
            ))?;
            let rows = stmt.query_map(params![limit], row_to_entry)?;
            rows.collect()
        });
    }
    // Someone typing a URL types the scheme and `www.`; the host has neither.
    let host = text.strip_prefix("https://").or_else(|| text.strip_prefix("http://")).unwrap_or(&text);
    let host = host.strip_prefix("www.").unwrap_or(host);
    // Nothing left would match every host; NULL makes the host tiers miss.
    let host = (!host.is_empty()).then_some(host);
    let within = format!("%{}%", escape_like(&text));
    // Every row is scanned, so the per-row cost is what counts. `host` is
    // stored lowercase, so one instr() finds both host tiers, position 1
    // being a prefix, and has no wildcards to escape. The WHERE alone decides
    // whether a row matches, so the tier never repeats the URL test.
    store.with(|conn| {
        let mut stmt = conn.prepare_cached(&format!(
            r#"SELECT {COLUMNS},
                 CASE coalesce(instr(host, ?1), 0)
                   WHEN 1 THEN 0
                   WHEN 0 THEN CASE WHEN title LIKE ?2 ESCAPE '\' THEN 2 ELSE 3 END
                   ELSE 1
                 END AS tier,
                 visit_count * CASE
                   WHEN last_visited_at > ?3 THEN 1.0
                   WHEN last_visited_at > ?4 THEN 0.7
                   WHEN last_visited_at > ?5 THEN 0.5
                   WHEN last_visited_at > ?6 THEN 0.3
                   ELSE 0.1
                 END AS frecency
               FROM browser_history
               WHERE instr(host, ?1) > 0 OR url LIKE ?2 ESCAPE '\' OR title LIKE ?2 ESCAPE '\'
               ORDER BY tier ASC, frecency DESC, last_visited_at DESC
               LIMIT ?7"#
        ))?;
        let recency = [4, 14, 31, 90].map(|days| now - days * DAY_MS);
        let rows = stmt.query_map(
            params![host, within, recency[0], recency[1], recency[2], recency[3], limit],
            row_to_entry,
        )?;
        rows.collect()
    })
}

/// The History page: newest first, a page at a time. `before` is the
/// `last_visited_at` of the last row already shown.
pub fn list(
    store: &Store,
    text: Option<&str>,
    before: Option<i64>,
    limit: u32,
) -> Result<Vec<HistoryEntry>, String> {
    let limit = limit.min(LIST_MAX);
    let within = text
        .map(|text| text.trim().to_lowercase())
        .filter(|text| !text.is_empty())
        .map(|text| format!("%{}%", escape_like(&text)));
    store.with(|conn| {
        let mut stmt = conn.prepare_cached(&format!(
            r#"SELECT {COLUMNS} FROM browser_history
               WHERE (?1 IS NULL OR last_visited_at < ?1)
                 AND (?2 IS NULL
                      OR title LIKE ?2 ESCAPE '\'
                      OR url   LIKE ?2 ESCAPE '\'
                      OR host  LIKE ?2 ESCAPE '\')
               ORDER BY last_visited_at DESC
               LIMIT ?3"#
        ))?;
        let rows = stmt.query_map(params![before, within, limit], row_to_entry)?;
        rows.collect()
    })
}

pub fn delete(store: &Store, url_key: &str) -> Result<(), String> {
    store.with(|conn| {
        conn.prepare_cached("DELETE FROM browser_history WHERE url_key = ?1")?
            .execute(params![url_key])
    })?;
    Ok(())
}

/// `since` clears from that moment on ("the last hour"); `None` clears it all.
pub fn clear(store: &Store, since: Option<i64>) -> Result<(), String> {
    store.with(|conn| match since {
        Some(since) => conn
            .prepare_cached("DELETE FROM browser_history WHERE last_visited_at >= ?1")?
            .execute(params![since]),
        None => conn.prepare_cached("DELETE FROM browser_history")?.execute([]),
    })?;
    Ok(())
}

/// Text typed by a person, matched as a substring: `%`, `_` and `\` in it are
/// literal characters, not LIKE wildcards.
fn escape_like(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    for c in text.chars() {
        if matches!(c, '%' | '_' | '\\') {
            out.push('\\');
        }
        out.push(c);
    }
    out
}

pub fn page_save(
    store: &Store,
    page_id: &str,
    entries_json: &str,
    active_index: i64,
    now: i64,
) -> Result<(), String> {
    if entries_json.len() > PAGE_MAX_BYTES {
        return Err(format!(
            "Page history is {} bytes; the limit is {PAGE_MAX_BYTES}",
            entries_json.len()
        ));
    }
    store.with(|conn| {
        let tx = conn.unchecked_transaction()?;
        tx.prepare_cached(
            "INSERT INTO browser_pages (page_id, entries_json, active_index, updated_at)
             VALUES (?1, ?2, ?3, ?4)
             ON CONFLICT(page_id) DO UPDATE SET
               entries_json = excluded.entries_json,
               active_index = excluded.active_index,
               updated_at   = excluded.updated_at",
        )?
        .execute(params![page_id, entries_json, active_index, now])?;
        // Riding on the save keeps the table bounded without a timer of its own.
        tx.prepare_cached("DELETE FROM browser_pages WHERE updated_at < ?1")?
            .execute(params![now - PAGE_MAX_AGE_MS])?;
        tx.commit()
    })
}

pub fn page_get(store: &Store, page_id: &str) -> Result<Option<PageSnapshot>, String> {
    store.with(|conn| {
        conn.prepare_cached(
            "SELECT page_id, entries_json, active_index, updated_at FROM browser_pages WHERE page_id = ?1",
        )?
        .query_row(params![page_id], |row| {
            Ok(PageSnapshot {
                page_id: row.get(0)?,
                entries_json: row.get(1)?,
                active_index: row.get(2)?,
                updated_at: row.get(3)?,
            })
        })
        .optional()
    })
}

pub fn page_delete(store: &Store, page_id: &str) -> Result<(), String> {
    store.with(|conn| {
        conn.prepare_cached("DELETE FROM browser_pages WHERE page_id = ?1")?
            .execute(params![page_id])
    })?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A fixed clock, so recency weights do not drift with the day the suite runs.
    const NOW: i64 = 1_800_000_000_000;

    #[test]
    fn refuses_urls_past_the_cap() {
        let path = "a".repeat(MAX_URL);
        assert!(normalize(&format!("https://a.com/{}", &path[..MAX_URL - 20])).is_some());
        assert!(normalize(&format!("https://a.com/{path}")).is_none());
    }

    fn store() -> Store {
        let dir = std::env::temp_dir().join(format!("crew-browser-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).expect("dir");
        Store::open(dir.join("crew.sqlite3")).expect("store")
    }

    /// Rows written straight to the table, so a test controls the count and
    /// the age without going through `visit` and its pruning.
    fn seed(store: &Store, rows: &[(&str, &str, i64, i64)]) {
        store
            .with(|conn| {
                let tx = conn.unchecked_transaction()?;
                for &(url, title, visits, at) in rows {
                    let normal = normalize(url).expect("an http url");
                    tx.prepare_cached(
                        "INSERT INTO browser_history (url_key, url, host, title, visit_count, last_visited_at)
                         VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
                    )?
                    .execute(params![normal.key, normal.url, normal.host, title, visits, at])?;
                }
                tx.commit()
            })
            .expect("seed");
    }

    fn row(store: &Store, url: &str) -> Option<HistoryEntry> {
        let key = normalize(url).expect("an http url").key;
        store
            .with(|conn| {
                conn.query_row(
                    &format!("SELECT {COLUMNS} FROM browser_history WHERE url_key = ?1"),
                    params![key],
                    row_to_entry,
                )
                .optional()
            })
            .expect("row")
    }

    fn count(store: &Store) -> i64 {
        store
            .with(|conn| conn.query_row("SELECT COUNT(*) FROM browser_history", [], |row| row.get(0)))
            .expect("count")
    }

    fn keys(entries: &[HistoryEntry]) -> Vec<&str> {
        entries.iter().map(|entry| entry.url_key.as_str()).collect()
    }

    fn key(url: &str) -> String {
        normalize(url).expect("an http url").key
    }

    #[test]
    fn the_root_path_and_the_host_case_do_not_make_another_place() {
        assert_eq!(key("https://a.com/"), "https://a.com");
        assert_eq!(key("https://A.com"), "https://a.com");
        let mixed = normalize("HTTPS://GitHub.COM/Rust-Lang/Rust?Tab=Readme").expect("url");
        assert_eq!(mixed.key, "https://github.com/Rust-Lang/Rust?Tab=Readme");
        assert_eq!(mixed.url, "HTTPS://GitHub.COM/Rust-Lang/Rust?Tab=Readme");
        assert_eq!(mixed.host, "github.com");
    }

    #[test]
    fn a_default_port_is_dropped_and_any_other_is_kept() {
        assert_eq!(key("http://a.com:80/x"), "http://a.com/x");
        assert_eq!(key("https://a.com:443/"), "https://a.com");
        assert_eq!(key("https://a.com:0443/"), "https://a.com");
        assert_eq!(key("http://a.com:443/"), "http://a.com:443");
        assert_eq!(key("https://a.com:80"), "https://a.com:80");
        let local = normalize("http://localhost:3000/").expect("url");
        assert_eq!(local.key, "http://localhost:3000");
        assert_eq!(local.host, "localhost");
        assert_eq!(key("http://a.com:/x"), "http://a.com/x");
    }

    #[test]
    fn credentials_never_reach_the_key_or_the_stored_url() {
        let normal = normalize("https://user:hunter2@a.com/inbox#top").expect("url");
        assert_eq!(normal.key, "https://a.com/inbox");
        assert_eq!(normal.url, "https://a.com/inbox");
        assert_eq!(key("https://user@A.com:443/"), "https://a.com");
        // A password can hold an `@`; the host starts after the last one.
        let tricky = normalize("https://me:p@ss@b.com/x").expect("url");
        assert_eq!(tricky.key, "https://b.com/x");
        assert!(!tricky.url.contains("ss@"), "{}", tricky.url);
    }

    #[test]
    fn urls_that_differ_only_in_the_fragment_are_one_row() {
        assert_eq!(key("https://a.com/doc#one"), key("https://a.com/doc#two"));
        assert_eq!(key("https://a.com/#top"), "https://a.com");
        assert_eq!(normalize("https://a.com/doc#one").expect("url").url, "https://a.com/doc");
        assert_eq!(key("https://a.com?q=1#x"), "https://a.com/?q=1");
    }

    #[test]
    fn a_non_root_trailing_slash_and_the_query_are_kept() {
        assert_eq!(key("https://a.com/docs/"), "https://a.com/docs/");
        assert_ne!(key("https://a.com/docs/"), key("https://a.com/docs"));
        assert_eq!(key("https://a.com/?q=Rust"), "https://a.com/?q=Rust");
        assert_eq!(key("https://a.com?q=Rust"), "https://a.com/?q=Rust");
        assert_eq!(normalize("https://a.com?q=Rust").expect("url").url, "https://a.com?q=Rust");
    }

    #[test]
    fn the_host_drops_www_but_the_key_keeps_it() {
        let normal = normalize("https://www.Example.com/").expect("url");
        assert_eq!(normal.host, "example.com");
        assert_eq!(normal.key, "https://www.example.com");
        assert_eq!(normalize("https://www./").expect("url").host, "www.");
    }

    #[test]
    fn ipv6_hosts_keep_their_brackets() {
        let normal = normalize("http://[::1]:3000/app").expect("url");
        assert_eq!(normal.key, "http://[::1]:3000/app");
        assert_eq!(normal.host, "[::1]");
        assert_eq!(key("http://[::1]:80/"), "http://[::1]");
        assert_eq!(key("https://[FE80::1]/x"), "https://[fe80::1]/x");
    }

    #[test]
    fn anything_but_http_is_rejected() {
        for url in [
            "ftp://a.com/file",
            "file:///etc/passwd",
            "javascript:alert('http://a.com')",
            "data:text/html,<a href='https://a.com'>",
            "about:blank",
            "chrome://settings",
            "not a url",
            "",
            "https://",
            "https:///path",
            "https://user@/x",
            "http://a b.com/",
            "http://a.com:99999/",
            "http://a.com:8o/",
            "http://[::1/",
            "http://[]/",
            "http://[::1]x/",
            "http://::1:3000/",
        ] {
            assert_eq!(normalize(url), None, "{url}");
        }
    }

    #[test]
    fn visiting_again_counts_and_takes_the_latest_url_title_and_workspace() {
        let store = store();
        visit(&store, "https://a.com/x#intro", "First", Some("w1"), NOW - 10).expect("visit");
        let first = row(&store, "https://a.com/x").expect("row");
        assert_eq!(first.visit_count, 1);
        assert_eq!(first.url, "https://a.com/x");
        assert_eq!(first.title, "First");

        visit(&store, "HTTPS://A.com/x", "", Some("w2"), NOW).expect("visit");
        let second = row(&store, "https://a.com/x").expect("row");
        assert_eq!(second.visit_count, 2);
        assert_eq!(second.last_visited_at, NOW);
        assert_eq!(second.url, "HTTPS://A.com/x");
        assert_eq!(second.title, "First", "an empty title keeps the old one");
        assert_eq!(second.workspace_id.as_deref(), Some("w2"));

        visit(&store, "https://a.com/x", "Second", None, NOW + 10).expect("visit");
        let third = row(&store, "https://a.com/x").expect("row");
        assert_eq!(third.visit_count, 3);
        assert_eq!(third.title, "Second");
        assert_eq!(third.workspace_id, None);
        assert_eq!(count(&store), 1);
    }

    #[test]
    fn a_visit_that_is_not_http_is_a_silent_no_op() {
        let store = store();
        visit(&store, "about:blank", "", None, NOW).expect("no error");
        visit(&store, "file:///tmp/x.html", "x", None, NOW).expect("no error");
        assert_eq!(count(&store), 0);
    }

    #[test]
    fn a_late_title_updates_the_row_but_is_not_a_visit() {
        let store = store();
        visit(&store, "https://a.com/", "", None, NOW).expect("visit");
        set_title(&store, "https://A.com", "Home").expect("title");
        set_title(&store, "https://a.com", "  ").expect("empty title");
        let entry = row(&store, "https://a.com").expect("row");
        assert_eq!(entry.title, "Home");
        assert_eq!(entry.visit_count, 1);
    }

    #[test]
    fn a_title_for_a_page_never_visited_inserts_nothing() {
        let store = store();
        set_title(&store, "https://a.com/", "Home").expect("title");
        set_title(&store, "about:blank", "Blank").expect("title");
        assert_eq!(count(&store), 0);
    }

    #[test]
    fn suggestions_rank_host_prefix_then_host_then_title_then_url() {
        let store = store();
        seed(
            &store,
            &[
                // The URL-only match is the most visited, so frecency alone
                // would put it first.
                ("https://b.com/?q=git", "Search", 90, NOW),
                ("https://a.com/", "Legit news", 40, NOW),
                ("https://www.digit.com/", "Digits", 20, NOW),
                ("https://github.com/", "GitHub", 1, NOW - 60 * DAY_MS),
                ("https://c.com/", "Nothing here", 99, NOW),
            ],
        );
        let found = suggest(&store, "Git", 10, NOW).expect("suggest");
        assert_eq!(
            keys(&found),
            ["https://github.com", "https://www.digit.com", "https://a.com", "https://b.com/?q=git"]
        );
        let typed = suggest(&store, "  HTTPS://www.GitH ", 10, NOW).expect("suggest");
        assert_eq!(keys(&typed).first(), Some(&"https://github.com"));
        // Nothing left for the host: every row is a URL match, by frecency.
        let scheme = suggest(&store, "https://", 10, NOW).expect("suggest");
        assert_eq!(
            keys(&scheme),
            ["https://c.com", "https://b.com/?q=git", "https://a.com", "https://www.digit.com", "https://github.com"]
        );
    }

    #[test]
    fn inside_a_tier_frequent_and_recent_visits_come_first() {
        let store = store();
        seed(
            &store,
            &[
                ("https://a1.com/", "", 10, NOW - 100 * DAY_MS), // 10 × 0.1 = 1.0
                ("https://a2.com/", "", 2, NOW - DAY_MS),        //  2 × 1.0 = 2.0
                ("https://a3.com/", "", 5, NOW - 20 * DAY_MS),   //  5 × 0.5 = 2.5
                ("https://a4.com/", "", 3, NOW - 10 * DAY_MS),   //  3 × 0.7 = 2.1
                ("https://a5.com/", "", 4, NOW - 60 * DAY_MS),   //  4 × 0.3 = 1.2
                // Same frecency as a1; the more recent visit wins the tie.
                ("https://a6.com/", "", 1, NOW - 2 * DAY_MS), //  1 × 1.0 = 1.0
            ],
        );
        let found = suggest(&store, "a", 10, NOW).expect("suggest");
        assert_eq!(
            keys(&found),
            [
                "https://a3.com",
                "https://a4.com",
                "https://a2.com",
                "https://a5.com",
                "https://a6.com",
                "https://a1.com"
            ]
        );
    }

    #[test]
    fn empty_text_suggests_the_most_recent_and_the_limit_is_capped() {
        let store = store();
        let urls: Vec<String> = (0..60).map(|n| format!("https://s{n}.com/")).collect();
        let rows: Vec<(&str, &str, i64, i64)> =
            urls.iter().enumerate().map(|(n, url)| (url.as_str(), "", 1, NOW - n as i64)).collect();
        seed(&store, &rows);
        let recent = suggest(&store, "   ", 3, NOW).expect("suggest");
        assert_eq!(keys(&recent), ["https://s0.com", "https://s1.com", "https://s2.com"]);
        assert_eq!(suggest(&store, "", 1000, NOW).expect("suggest").len(), SUGGEST_MAX as usize);
        assert_eq!(suggest(&store, "s", 1000, NOW).expect("suggest").len(), SUGGEST_MAX as usize);
        assert!(suggest(&store, "nowhere", 10, NOW).expect("suggest").is_empty());
    }

    #[test]
    fn like_wildcards_in_the_text_are_literal() {
        let store = store();
        seed(
            &store,
            &[
                ("https://x.com/", "100% free", 1, NOW),
                ("https://y.com/", "1000 free", 1, NOW),
                ("https://z.com/", "snake_case", 1, NOW),
                ("https://w.com/", "snakeXcase", 1, NOW),
                ("https://v.com/", r"C:\dir", 1, NOW),
                ("https://u.com/", "C:dir", 1, NOW),
            ],
        );
        assert_eq!(keys(&suggest(&store, "100%", 10, NOW).expect("suggest")), ["https://x.com"]);
        assert_eq!(keys(&suggest(&store, "e_c", 10, NOW).expect("suggest")), ["https://z.com"]);
        assert_eq!(keys(&suggest(&store, r":\d", 10, NOW).expect("suggest")), ["https://v.com"]);
        assert_eq!(keys(&list(&store, Some("_"), None, 10).expect("list")), ["https://z.com"]);
        assert_eq!(keys(&list(&store, Some("%"), None, 10).expect("list")), ["https://x.com"]);
    }

    #[test]
    fn the_history_list_pages_backwards_and_filters() {
        let store = store();
        seed(
            &store,
            &[
                ("https://one.com/", "One", 1, NOW - 5),
                ("https://two.com/", "Rust book", 1, NOW - 4),
                ("https://three.com/", "Three", 1, NOW - 3),
                ("https://four.com/rust", "Four", 1, NOW - 2),
                ("https://rust-lang.org/", "Home", 1, NOW - 1),
            ],
        );
        let first = list(&store, None, None, 2).expect("list");
        assert_eq!(keys(&first), ["https://rust-lang.org", "https://four.com/rust"]);
        let before = first.last().expect("row").last_visited_at;
        let second = list(&store, None, Some(before), 2).expect("list");
        assert_eq!(keys(&second), ["https://three.com", "https://two.com"]);
        let third = list(&store, None, Some(second[1].last_visited_at), 2).expect("list");
        assert_eq!(keys(&third), ["https://one.com"]);

        let rust = list(&store, Some(" RUST "), None, 10).expect("list");
        assert_eq!(keys(&rust), ["https://rust-lang.org", "https://four.com/rust", "https://two.com"]);
        let older = list(&store, Some("rust"), Some(NOW - 1), 10).expect("list");
        assert_eq!(keys(&older), ["https://four.com/rust", "https://two.com"]);
        assert_eq!(list(&store, Some(""), None, 10).expect("list").len(), 5);
        assert_eq!(list(&store, None, None, 0).expect("list").len(), 0);
    }

    #[test]
    fn delete_removes_one_row() {
        let store = store();
        visit(&store, "https://a.com/", "", None, NOW).expect("visit");
        visit(&store, "https://b.com/", "", None, NOW).expect("visit");
        delete(&store, "https://a.com").expect("delete");
        assert!(row(&store, "https://a.com").is_none());
        assert!(row(&store, "https://b.com").is_some());
    }

    #[test]
    fn clear_since_keeps_what_came_before() {
        let store = store();
        seed(
            &store,
            &[
                ("https://old.com/", "", 1, NOW - 3_600_001),
                ("https://edge.com/", "", 1, NOW - 3_600_000),
                ("https://new.com/", "", 1, NOW),
            ],
        );
        clear(&store, Some(NOW - 3_600_000)).expect("clear");
        assert_eq!(keys(&list(&store, None, None, 10).expect("list")), ["https://old.com"]);
        clear(&store, None).expect("clear");
        assert_eq!(count(&store), 0);
    }

    #[test]
    fn prune_drops_rows_older_than_ninety_days() {
        let store = store();
        seed(
            &store,
            &[
                ("https://stale.com/", "", 50, NOW - HISTORY_MAX_AGE_MS - 1),
                ("https://edge.com/", "", 1, NOW - HISTORY_MAX_AGE_MS),
                ("https://fresh.com/", "", 1, NOW - DAY_MS),
            ],
        );
        prune(&store, NOW).expect("prune");
        assert_eq!(keys(&list(&store, None, None, 10).expect("list")), ["https://fresh.com", "https://edge.com"]);
    }

    #[test]
    fn prune_keeps_only_the_newest_rows_over_the_cap() {
        let store = store();
        let extra = 5;
        let urls: Vec<String> =
            (0..HISTORY_MAX_ROWS + extra).map(|n| format!("https://h{n}.com/")).collect();
        let rows: Vec<(&str, &str, i64, i64)> =
            urls.iter().enumerate().map(|(n, url)| (url.as_str(), "", 1, NOW - DAY_MS + n as i64)).collect();
        seed(&store, &rows);
        prune(&store, NOW).expect("prune");
        assert_eq!(count(&store), HISTORY_MAX_ROWS);
        for n in 0..extra {
            assert!(row(&store, &format!("https://h{n}.com/")).is_none(), "h{n} is among the oldest");
        }
        assert!(row(&store, &format!("https://h{extra}.com/")).is_some());
    }

    #[test]
    fn a_page_snapshot_round_trips_and_is_replaced_on_save() {
        let store = store();
        assert_eq!(page_get(&store, "browser:1").expect("get"), None);
        page_save(&store, "browser:1", r#"[{"url":"https://a.com"}]"#, 0, NOW - 10).expect("save");
        page_save(&store, "browser:1", r#"[{"url":"https://a.com"},{"url":"https://b.com"}]"#, 1, NOW)
            .expect("save");
        let snapshot = page_get(&store, "browser:1").expect("get").expect("snapshot");
        assert_eq!(
            snapshot,
            PageSnapshot {
                page_id: "browser:1".into(),
                entries_json: r#"[{"url":"https://a.com"},{"url":"https://b.com"}]"#.into(),
                active_index: 1,
                updated_at: NOW,
            }
        );
        page_delete(&store, "browser:1").expect("delete");
        assert_eq!(page_get(&store, "browser:1").expect("get"), None);
    }

    #[test]
    fn a_page_snapshot_over_the_cap_is_refused() {
        let store = store();
        let too_big = "x".repeat(PAGE_MAX_BYTES + 1);
        assert!(page_save(&store, "browser:1", &too_big, 0, NOW).is_err());
        assert_eq!(page_get(&store, "browser:1").expect("get"), None);
        page_save(&store, "browser:1", &too_big[1..], 0, NOW).expect("exactly the cap fits");
    }

    #[test]
    fn saving_a_page_prunes_stacks_untouched_for_thirty_days() {
        let store = store();
        page_save(&store, "stale", "[]", 0, NOW - PAGE_MAX_AGE_MS - 1).expect("save");
        page_save(&store, "edge", "[]", 0, NOW - PAGE_MAX_AGE_MS).expect("save");
        page_save(&store, "fresh", "[]", 0, NOW).expect("save");
        assert_eq!(page_get(&store, "stale").expect("get"), None);
        assert!(page_get(&store, "edge").expect("get").is_some());
        assert!(page_get(&store, "fresh").expect("get").is_some());
    }

    fn versions(store: &Store) -> Vec<i64> {
        store
            .with(|conn| {
                let mut stmt = conn.prepare("SELECT version FROM schema_migrations WHERE version >= 15 ORDER BY version")?;
                let rows = stmt.query_map([], |row| row.get(0))?;
                rows.collect()
            })
            .expect("versions")
    }

    fn has_table(store: &Store, name: &str) -> bool {
        store
            .with(|conn| {
                conn.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?1")?
                    .exists(params![name])
            })
            .expect("table")
    }

    #[test]
    fn a_fresh_database_gets_both_tables() {
        let store = store();
        assert!(has_table(&store, "browser_history"));
        assert!(has_table(&store, "browser_pages"));
        assert_eq!(&versions(&store)[..2], [15, 16]);
    }

    /// A database file the way a v14 build left it: a fresh one, wound back.
    fn database_at_v14() -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!("crew-browser-v14-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).expect("dir");
        let path = dir.join("crew.sqlite3");
        let store = Store::open(path.clone()).expect("store");
        store
            .with(|conn| {
                conn.execute_batch(
                    "DROP TABLE browser_history;
                     DROP TABLE browser_pages;
                     DELETE FROM schema_migrations WHERE version >= 15;",
                )
            })
            .expect("rewind");
        assert!(!has_table(&store, "browser_history"));
        path
    }

    #[test]
    fn a_database_at_v14_migrates_to_both_tables() {
        let store = Store::open(database_at_v14()).expect("reopen");
        assert!(has_table(&store, "browser_history"));
        assert!(has_table(&store, "browser_pages"));
        assert_eq!(&versions(&store)[..2], [15, 16]);
        visit(&store, "https://a.com/", "A", None, NOW).expect("visit");
        page_save(&store, "p", "[]", 0, NOW).expect("save");
        assert_eq!(count(&store), 1);
    }

    /// What a crash between v15's DDL and its version row would have left
    /// without the transaction. The next open has to get past it.
    #[test]
    fn a_step_applied_but_not_recorded_runs_again() {
        let path = database_at_v14();
        rusqlite::Connection::open(&path)
            .expect("open")
            .execute_batch(MIGRATION_V15)
            .expect("ddl without its version row");
        let store = Store::open(path).expect("reopen");
        assert!(has_table(&store, "browser_history"));
        assert!(has_table(&store, "browser_pages"));
        assert_eq!(&versions(&store)[..2], [15, 16]);
    }

    /// The DDL and the version row commit together: when the row cannot be
    /// written, the table the step created goes with it.
    #[test]
    fn a_step_that_cannot_be_recorded_leaves_nothing_behind() {
        let path = database_at_v14();
        rusqlite::Connection::open(&path)
            .expect("open")
            .execute_batch(
                "CREATE TRIGGER refuse_v15 BEFORE INSERT ON schema_migrations
                 WHEN NEW.version = 15 BEGIN SELECT RAISE(ABORT, 'refused'); END;",
            )
            .expect("trigger");
        assert!(Store::open(path.clone()).is_err());
        let conn = rusqlite::Connection::open(&path).expect("open");
        let created = conn
            .prepare("SELECT 1 FROM sqlite_master WHERE name = 'browser_history'")
            .and_then(|mut stmt| stmt.exists([]))
            .expect("query");
        assert!(!created, "v15's table outlived its failed step");
    }

    /// `cargo test -p crew-core --release -- --ignored browser`
    #[test]
    #[ignore]
    fn browser_suggest_stays_fast_on_a_full_history() {
        let store = store();
        let words = [
            "rust", "react", "sqlite", "async", "tokio", "hooks", "review", "deploy", "issue", "docs", "parser",
            "layout", "cache", "stream", "router", "schema", "tabs", "terminal", "webview", "history",
        ];
        // A small LCG: varied rows, the same ones on every run.
        let mut state: u64 = 42;
        let mut pick = |n: usize| {
            state = state.wrapping_mul(6_364_136_223_846_793_005).wrapping_add(1_442_695_040_888_963_407);
            (state >> 33) as usize % n
        };
        // Shapes and lengths like a real history: long search URLs, long titles.
        let mut seeds = Vec::new();
        for n in 0..HISTORY_MAX_ROWS {
            let (a, b) = (words[pick(words.len())], words[pick(words.len())]);
            let (url, title) = match pick(8) {
                0 => (
                    format!("https://github.com/crew-dev/{a}-{b}/pull/{n}"),
                    format!("Fix {a} when {b} is empty · Pull Request #{n} · crew-dev/{a}-{b}"),
                ),
                1 => (
                    format!("https://www.google.com/search?q={a}+{b}+{n}&sourceid=chrome&ie=UTF-8&oq={a}+{b}&gs_lcrp=EgZjaHJvbWUyBggAEEUYOTIGCAEQRRhA0gEIMzIxMmowajeoAgCwAgA"),
                    format!("{a} {b} {n} - Google Search"),
                ),
                2 => (format!("https://docs.rs/{a}/latest/{a}/struct.{b}{n}.html"), format!("{b}{n} in {a} - Rust")),
                3 => (
                    format!("https://stackoverflow.com/questions/{n}/how-to-{a}-a-{b}-without-blocking"),
                    format!("How to {a} a {b} without blocking? - Stack Overflow"),
                ),
                4 => (
                    format!("https://www.youtube.com/watch?v={n:011x}&t={}s", n % 600),
                    format!("{a} and {b} explained in ten minutes - YouTube"),
                ),
                5 => (format!("http://localhost:5173/{a}/{b}?tab={n}"), format!("Crew - {a} {b}")),
                6 => (format!("https://en.wikipedia.org/wiki/{a}_{b}_{n}"), format!("{a} {b} {n} - Wikipedia")),
                _ => (
                    format!("https://news.ycombinator.com/item?id={}", 40_000_000 + n),
                    format!("Show HN: A {a} for {b} ({n})"),
                ),
            };
            let at = NOW - pick(120) as i64 * DAY_MS - pick(DAY_MS as usize) as i64;
            seeds.push((url, title, 1 + pick(20) as i64, at));
        }
        let rows: Vec<(&str, &str, i64, i64)> =
            seeds.iter().map(|(url, title, visits, at)| (url.as_str(), title.as_str(), *visits, *at)).collect();
        seed(&store, &rows);
        assert_eq!(count(&store), HISTORY_MAX_ROWS);

        // Typing, a keystroke at a time, plus words, digits, misses and wildcards.
        let texts = [
            "g", "gi", "git", "github", "github.com/crew", "d", "do", "docs.rs", "s", "st", "stack", "y", "you",
            "youtube", "l", "local", "localhost:5173", "w", "wiki", "n", "news", "https://www.goo", "www.", "http://",
            "rust", "react hooks", "tokio", "sqlite cache", "webview", "pull request", "show hn", "12345", "zzzz",
            "q", "_", "100%", "e", "o", "a", "h",
        ];
        let mut times = Vec::new();
        for round in 0..200 {
            let text = texts[round % texts.len()];
            let start = std::time::Instant::now();
            let found = suggest(&store, text, 8, NOW).expect("suggest");
            times.push(start.elapsed());
            assert!(found.len() <= 8);
        }
        times.sort();
        let p50 = times[times.len() / 2];
        let p95 = times[times.len() * 95 / 100];
        println!("browser suggest over {HISTORY_MAX_ROWS} rows: p50 {p50:?}, p95 {p95:?}");
        assert!(p95 < std::time::Duration::from_millis(5), "p95 {p95:?}");
    }
}
