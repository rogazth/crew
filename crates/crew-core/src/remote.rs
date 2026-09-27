//! Machines the window keeps. A remote daemon holds its own workspaces; this
//! table is only the address book, and it never stores the token.

use crew_protocol::RemoteEnv;
use rusqlite::{params, OptionalExtension};

use crate::store::{now_millis, Store};

pub fn list(store: &Store) -> Result<Vec<RemoteEnv>, String> {
    store.with(|conn| {
        let mut stmt = conn.prepare_cached(
            "SELECT id, name, host, port, user, ssh FROM remotes ORDER BY created_at ASC, name ASC",
        )?;
        let rows = stmt.query_map([], |row| {
            Ok(RemoteEnv {
                id: row.get(0)?,
                name: row.get(1)?,
                host: row.get(2)?,
                port: row.get::<_, i64>(3)? as u16,
                user: row.get(4)?,
                ssh: row.get(5)?,
            })
        })?;
        rows.collect()
    })
}

pub fn upsert(store: &Store, mut env: RemoteEnv) -> Result<RemoteEnv, String> {
    env.name = env.name.trim().to_string();
    env.host = env.host.trim().to_string();
    env.user = env.user.trim().to_string();
    env.ssh = env.ssh.trim().to_string();
    if env.name.is_empty() {
        return Err("A machine needs a name".into());
    }
    if env.host.is_empty() || env.host.contains([' ', '/']) {
        return Err("Host must be a hostname or an IP".into());
    }
    if env.port == 0 {
        return Err("Port must be between 1 and 65535".into());
    }
    if env.id.trim().is_empty() {
        env.id = uuid::Uuid::new_v4().to_string();
    } else {
        env.id = env.id.trim().to_string();
    }

    let taken: Option<String> = store.with(|conn| {
        conn.query_row(
            "SELECT id FROM remotes WHERE host = ?1 AND port = ?2 AND id != ?3",
            params![env.host, env.port as i64, env.id],
            |row| row.get(0),
        )
        .optional()
    })?;
    if taken.is_some() {
        return Err(format!("{}:{} is already in Crew", env.host, env.port));
    }

    store.with(|conn| {
        conn.execute(
            "INSERT INTO remotes (id, name, host, port, user, ssh, created_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
             ON CONFLICT(id) DO UPDATE SET
               name = excluded.name,
               host = excluded.host,
               port = excluded.port,
               user = excluded.user,
               ssh = excluded.ssh",
            params![env.id, env.name, env.host, env.port as i64, env.user, env.ssh, now_millis()],
        )
    })?;
    Ok(env)
}

pub fn delete(store: &Store, id: &str) -> Result<(), String> {
    store.with(|conn| {
        conn.execute("DELETE FROM remotes WHERE id = ?1", params![id])?;
        Ok(())
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn store() -> Store {
        let dir = std::env::temp_dir().join(format!("crew-remote-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).expect("dir");
        Store::open(dir.join("crew.sqlite3")).expect("store")
    }

    fn env(host: &str) -> RemoteEnv {
        RemoteEnv {
            id: String::new(),
            name: "VPS".into(),
            host: host.into(),
            port: 7777,
            user: "agent".into(),
            ssh: String::new(),
        }
    }

    #[test]
    fn a_machine_is_kept_and_named() {
        let store = store();
        assert!(list(&store).unwrap().is_empty());
        let saved = upsert(&store, env("100.1.1.1")).unwrap();
        assert!(!saved.id.is_empty());
        let again = upsert(
            &store,
            RemoteEnv {
                name: "  Falcon  ".into(),
                ..saved.clone()
            },
        )
        .unwrap();
        assert_eq!(again.name, "Falcon");
        let aliased = upsert(&store, RemoteEnv { ssh: " falcon-public ".into(), user: String::new(), ..again.clone() }).unwrap();
        assert_eq!(list(&store).unwrap()[0].ssh, "falcon-public");
        assert_eq!(aliased.user, "");
        assert_eq!(list(&store).unwrap().len(), 1);
        delete(&store, &again.id).unwrap();
        assert!(list(&store).unwrap().is_empty());
    }

    #[test]
    fn the_same_address_cannot_be_added_twice() {
        let store = store();
        upsert(&store, env("100.1.1.1")).unwrap();
        let again = upsert(&store, env("100.1.1.1"));
        assert!(again.as_ref().is_err_and(|e| e.contains("already in Crew")), "{again:?}");
    }

    #[test]
    fn a_blank_name_or_host_is_refused() {
        let store = store();
        assert!(upsert(&store, RemoteEnv { name: "  ".into(), ..env("100.1.1.1") }).is_err());
        assert!(upsert(&store, env(" ")).is_err());
        assert!(upsert(&store, RemoteEnv { port: 0, ..env("100.1.1.1") }).is_err());
    }
}
