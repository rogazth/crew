//! A vault on one machine, and the others leasing from it (plan
//! `2026-10-23-integrations.md`, phase 3).
//!
//! - **Machines** the vault knows each lease with a token of their own,
//!   minted by the vault for that machine and revocable on its own. The vault
//!   keeps only its hash. Such a token reads the connectors and leases access
//!   tokens; it can do nothing else (`crewd`'s lease connections).
//! - **The config** (connectors, accounts, bindings, tool switches and the
//!   tools' definitions) is the vault's; every other machine keeps a copy,
//!   replaced whole each time the vault's changes (`snapshot`, `import`), and
//!   spawns from it. No grant is in it.
//! - **A lease** is an access token, its end and its scopes. The machine keeps
//!   it in memory only, asks again at 80% of its life or after a 401, and
//!   keeps using it while the vault is offline until it runs out.

use std::collections::HashMap;
use std::sync::Mutex;

use crew_protocol::{Connector, VaultMachine};
use rusqlite::{params, OptionalExtension};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use crate::store::{now_millis, Store};

pub const MIGRATION_V45: &str = r#"
-- The machines leasing from this vault: each one's token, hashed.
CREATE TABLE IF NOT EXISTS vault_machines (
  id         TEXT PRIMARY KEY,
  name       TEXT NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,
  created_at INTEGER NOT NULL,
  last_lease INTEGER
);
"#;

fn hash(token: &str) -> String {
    Sha256::digest(token.as_bytes()).iter().map(|b| format!("{b:02x}")).collect()
}

/// A new machine's token, shown once: the vault keeps only its hash.
pub fn mint(store: &Store, name: &str) -> Result<(VaultMachine, String), String> {
    let id = uuid::Uuid::new_v4().to_string();
    let token = format!("lease-{}", super::oauth::random_token());
    let now = now_millis();
    store.with(|conn| {
        conn.execute(
            "INSERT INTO vault_machines (id, name, token_hash, created_at) VALUES (?1, ?2, ?3, ?4)",
            params![id, name, hash(&token), now],
        )
        .map(drop)
    })?;
    Ok((VaultMachine { id, name: name.to_string(), created_at: now, last_lease: None }, token))
}

pub fn machines(store: &Store) -> Result<Vec<VaultMachine>, String> {
    store.with(|conn| {
        conn.prepare("SELECT id, name, created_at, last_lease FROM vault_machines ORDER BY created_at")?
            .query_map([], |row| Ok(VaultMachine { id: row.get(0)?, name: row.get(1)?, created_at: row.get(2)?, last_lease: row.get(3)? }))?
            .collect()
    })
}

pub fn revoke(store: &Store, id: &str) -> Result<(), String> {
    store.with(|conn| conn.execute("DELETE FROM vault_machines WHERE id = ?1", [id]).map(drop))
}

/// Forgets every machine: a vault that moved leases to none.
pub fn revoke_all(store: &Store) -> Result<(), String> {
    store.with(|conn| conn.execute("DELETE FROM vault_machines", []).map(drop))
}

/// The machine a lease token is, if any.
pub fn machine_of(store: &Store, token: &str) -> Result<Option<VaultMachine>, String> {
    if !token.starts_with("lease-") {
        return Ok(None);
    }
    store.with(|conn| {
        conn.query_row(
            "SELECT id, name, created_at, last_lease FROM vault_machines WHERE token_hash = ?1",
            [hash(token)],
            |row| Ok(VaultMachine { id: row.get(0)?, name: row.get(1)?, created_at: row.get(2)?, last_lease: row.get(3)? }),
        )
        .optional()
    })
}

pub fn leased(store: &Store, id: &str) -> Result<(), String> {
    store.with(|conn| conn.execute("UPDATE vault_machines SET last_lease = ?2 WHERE id = ?1", params![id, now_millis()]).map(drop))
}

/// How often one machine may lease: enough for every account's token at 80%
/// of an hour and the retries after a 401, not a loop that drains the vault.
pub struct RateLimit {
    per_minute: usize,
    seen: Mutex<HashMap<String, Vec<i64>>>,
}

impl RateLimit {
    pub fn new(per_minute: usize) -> Self {
        RateLimit { per_minute, seen: Mutex::new(HashMap::new()) }
    }

    pub fn allow(&self, machine: &str) -> bool {
        let now = now_millis();
        let mut seen = self.seen.lock().unwrap_or_else(|e| e.into_inner());
        let times = seen.entry(machine.to_string()).or_default();
        times.retain(|t| now - t < 60_000);
        if times.len() >= self.per_minute {
            return false;
        }
        times.push(now);
        true
    }
}

/* ── Leases ───────────────────────────────────────────────────────────── */

/// An access token the vault lent: kept in memory only.
#[derive(Serialize, Deserialize, Clone, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Lease {
    pub access_token: String,
    /// Unix milliseconds; `None` when the service did not say.
    pub expires_at: Option<i64>,
    pub scope: Option<String>,
}

impl std::fmt::Debug for Lease {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Lease").field("expires_at", &self.expires_at).field("scope", &self.scope).finish_non_exhaustive()
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum LeaseError {
    /// The vault can't be reached.
    Offline,
    /// The vault answered no, in a line for the model (the account needs a sign-in).
    Refused(String),
}

/// How a machine that is not the vault reaches it (`crewd`'s link).
pub trait Leaser: Send + Sync {
    /// An access token for the account; `stale` is the one a service just refused.
    fn lease<'a>(
        &'a self,
        account_id: &'a str,
        stale: Option<&'a str>,
    ) -> std::pin::Pin<Box<dyn std::future::Future<Output = Result<Lease, LeaseError>> + Send + 'a>>;
    /// The vault's machine, for the lines a model reads: "devbox".
    fn vault_name(&self) -> String;
    /// Since when the vault can't be reached, while it can't.
    fn offline_since(&self) -> Option<i64>;
}

/// A lease kept, and when it came: asked again at 80% of its life.
#[derive(Clone)]
pub(crate) struct Held {
    pub lease: Lease,
    pub at: i64,
}

impl Held {
    pub fn fresh(&self, now: i64) -> bool {
        self.lease.expires_at.is_none_or(|end| now < self.at + (end - self.at) * 4 / 5)
    }

    pub fn alive(&self, now: i64) -> bool {
        self.lease.expires_at.is_none_or(|end| now < end)
    }
}

/// "14:02", for "offline since".
pub fn clock(ms: i64) -> String {
    let secs = ms.div_euclid(1000);
    let local = unsafe {
        let t = secs as libc::time_t;
        let mut tm: libc::tm = std::mem::zeroed();
        libc::localtime_r(&t, &mut tm);
        tm
    };
    format!("{:02}:{:02}", local.tm_hour, local.tm_min)
}

/* ── The config every machine keeps a copy of ────────────────────────── */

/// The vault's connectors whole, as a machine replaces its copy with them.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Snapshot {
    pub connectors: Vec<Connector>,
    /// Each account's tools as the server listed them, for the shim.
    pub tools_raw: HashMap<String, String>,
}

pub fn snapshot(store: &Store) -> Result<Snapshot, String> {
    let connectors = super::list(store)?;
    let tools_raw = store.with(|conn| {
        conn.prepare("SELECT account_id, tools_raw FROM connector_tools_raw")?
            .query_map([], |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?)))?
            .collect::<rusqlite::Result<HashMap<_, _>>>()
    })?;
    Ok(Snapshot { connectors, tools_raw })
}

/// Replaces this machine's copy of the config with the vault's.
pub fn import(store: &Store, snap: &Snapshot) -> Result<(), String> {
    store.with(|conn| {
        let tx = conn.unchecked_transaction()?;
        tx.execute("DELETE FROM connectors", [])?;
        for c in &snap.connectors {
            tx.execute(
                "INSERT INTO connectors (id, name, registry_name, url, icon_url, description, publisher, refused, created_at)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
                params![c.id, c.name, c.registry_name, c.url, c.icon_url, c.description, c.publisher, c.refused, c.created_at],
            )?;
            for a in &c.accounts {
                tx.execute(
                    "INSERT INTO connector_accounts (id, connector_id, label, identity, state, error, tools_json, tools_off_json, created_at)
                     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
                    params![
                        a.id,
                        c.id,
                        a.label,
                        a.identity,
                        super::state_text(a.state),
                        a.error,
                        serde_json::to_string(&a.tools).unwrap_or_default(),
                        serde_json::to_string(&a.tools_off).unwrap_or_default(),
                        a.created_at
                    ],
                )?;
                super::write_workspaces(&tx, &a.id, a.workspaces.as_deref())?;
                if let Some(raw) = snap.tools_raw.get(&a.id) {
                    tx.execute("INSERT INTO connector_tools_raw (account_id, tools_raw) VALUES (?1, ?2)", params![a.id, raw])?;
                }
            }
        }
        tx.commit()
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::connectors::{self, NewConnector};
    use crew_protocol::AccountState;

    fn store() -> Store {
        Store::open(std::env::temp_dir().join(format!("lease-{}", uuid::Uuid::new_v4())).join("crew.db")).unwrap()
    }

    #[test]
    fn a_machine_leases_with_its_own_token_until_it_is_revoked() {
        let s = store();
        let (devbox, token) = mint(&s, "devbox").unwrap();
        assert_eq!(machine_of(&s, &token).unwrap().unwrap().id, devbox.id);
        assert!(machine_of(&s, "lease-guess").unwrap().is_none());
        assert!(machine_of(&s, "the daemon's own token").unwrap().is_none());
        let stored: String = s.with(|c| c.query_row("SELECT token_hash FROM vault_machines", [], |r| r.get(0))).unwrap();
        assert_ne!(stored, token, "only the hash is kept");
        revoke(&s, &devbox.id).unwrap();
        assert!(machine_of(&s, &token).unwrap().is_none());
    }

    #[test]
    fn a_copy_of_the_config_is_the_vaults_whole() {
        let vault = store();
        let c = connectors::add(
            &vault,
            NewConnector { name: "Notion".into(), registry_name: Some("com.notion/mcp".into()), url: "https://mcp.notion.com/mcp".into(), icon_url: None, description: String::new(), publisher: "notion.com".into() },
        )
        .unwrap();
        let a = connectors::add_account(&vault, &c.id, None, None).unwrap();
        connectors::set_state(&vault, &a.id, AccountState::Connected, None).unwrap();
        connectors::set_workspaces(&vault, &a.id, Some(&["w1".into()])).unwrap();
        connectors::set_raw_tools(&vault, &a.id, &[serde_json::json!({ "name": "search", "annotations": { "readOnlyHint": true } })]).unwrap();
        let copy = store();
        connectors::add(&copy, NewConnector { name: "Stale".into(), registry_name: None, url: "https://x.dev/mcp".into(), icon_url: None, description: String::new(), publisher: "x.dev".into() }).unwrap();
        let snap = snapshot(&vault).unwrap();
        import(&copy, &snap).unwrap();
        assert_eq!(snapshot(&copy).unwrap(), snap);
        assert_eq!(connectors::listed_tools(&copy, &a.id).unwrap().len(), 1);
    }

    #[test]
    fn a_machine_that_leases_too_often_is_held_back() {
        let limit = RateLimit::new(3);
        assert!((0..3).all(|_| limit.allow("m")));
        assert!(!limit.allow("m"));
        assert!(limit.allow("other"));
    }
}
