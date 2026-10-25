//! The vault: where Crew's grants live on the machine that holds them.
//!
//! A grant is an account's refresh token and the access token it last
//! bought, with what it takes to refresh it without discovering the server
//! again. Only the vault refreshes: a rotating refresh token can have one
//! holder, and a copy that refreshes invalidates the others.
//!
//! Behind a trait so the keychain can take the file's place on macOS. The
//! file is `<data>/vault.json`, mode 0600, written whole through a temporary
//! file. It is not encrypted at rest: the key would sit on the same disk.

use std::collections::HashMap;
use std::fmt;
use std::io::Write;
use std::os::unix::fs::OpenOptionsExt;
use std::path::PathBuf;
use std::sync::Mutex;

use serde::{Deserialize, Serialize};

use super::oauth::{Client, ClientAuth};

/// One account's grant.
#[derive(Serialize, Deserialize, Clone, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Grant {
    pub issuer: String,
    pub token_endpoint: String,
    pub revocation_endpoint: Option<String>,
    /// The protected resource every token request names (RFC 8707).
    pub resource: String,
    pub client_id: String,
    /// The secret this install's registration was given, for a server that
    /// takes no public client.
    #[serde(default)]
    pub client_secret: Option<String>,
    #[serde(default)]
    pub client_auth: ClientAuth,
    pub refresh_token: Option<String>,
    pub access_token: String,
    /// Unix milliseconds; `None` when the server did not say.
    pub expires_at: Option<i64>,
    pub scope: Option<String>,
}

impl Grant {
    pub fn client(&self) -> Client {
        Client { id: self.client_id.clone(), secret: self.client_secret.clone(), auth: self.client_auth }
    }
}

/// Never prints a token, whoever formats it.
impl fmt::Debug for Grant {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("Grant")
            .field("issuer", &self.issuer)
            .field("resource", &self.resource)
            .field("client_id", &self.client_id)
            .field("refresh_token", &self.refresh_token.as_ref().map(|_| "…"))
            .field("expires_at", &self.expires_at)
            .finish_non_exhaustive()
    }
}

pub trait VaultStore: Send + Sync {
    fn get(&self, account_id: &str) -> Result<Option<Grant>, String>;
    fn put(&self, account_id: &str, grant: &Grant) -> Result<(), String>;
    fn delete(&self, account_id: &str) -> Result<(), String>;
}

#[derive(Serialize, Deserialize, Default)]
struct FileBody {
    version: u32,
    grants: HashMap<String, Grant>,
}

/// The 0600 file.
pub struct FileVault {
    path: PathBuf,
    /// Read once, then kept: the daemon is the file's only writer.
    body: Mutex<Option<FileBody>>,
}

impl FileVault {
    pub fn new(path: PathBuf) -> Self {
        Self { path, body: Mutex::new(None) }
    }

    fn with<T>(&self, f: impl FnOnce(&mut FileBody) -> (T, bool)) -> Result<T, String> {
        let mut guard = self.body.lock().unwrap_or_else(|e| e.into_inner());
        if guard.is_none() {
            *guard = Some(self.read()?);
        }
        let body = guard.as_mut().expect("read above");
        let (out, changed) = f(body);
        if changed {
            self.write(body)?;
        }
        Ok(out)
    }

    fn read(&self) -> Result<FileBody, String> {
        match std::fs::read(&self.path) {
            Ok(bytes) => serde_json::from_slice(&bytes).map_err(|_| format!("{} is not a vault Crew can read", self.path.display())),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(FileBody { version: 1, grants: HashMap::new() }),
            Err(e) => Err(format!("Couldn't read the vault: {e}")),
        }
    }

    fn write(&self, body: &FileBody) -> Result<(), String> {
        let bytes = serde_json::to_vec(body).map_err(|e| e.to_string())?;
        let tmp = self.path.with_extension(format!("json.{}", std::process::id()));
        let written = (|| {
            let mut file = std::fs::OpenOptions::new().write(true).create(true).truncate(true).mode(0o600).open(&tmp)?;
            file.write_all(&bytes)?;
            file.sync_all()?;
            std::fs::rename(&tmp, &self.path)
        })();
        if written.is_err() {
            let _ = std::fs::remove_file(&tmp);
        }
        written.map_err(|e| format!("Couldn't write the vault: {e}"))
    }
}

impl VaultStore for FileVault {
    fn get(&self, account_id: &str) -> Result<Option<Grant>, String> {
        self.with(|body| (body.grants.get(account_id).cloned(), false))
    }

    fn put(&self, account_id: &str, grant: &Grant) -> Result<(), String> {
        self.with(|body| {
            body.version = 1;
            body.grants.insert(account_id.to_string(), grant.clone());
            ((), true)
        })
    }

    fn delete(&self, account_id: &str) -> Result<(), String> {
        self.with(|body| ((), body.grants.remove(account_id).is_some()))
    }
}

/// Grants that last as long as the daemon: for tests, and a daemon given no
/// data dir.
#[derive(Default)]
pub struct MemoryVault {
    grants: Mutex<HashMap<String, Grant>>,
}

impl VaultStore for MemoryVault {
    fn get(&self, account_id: &str) -> Result<Option<Grant>, String> {
        Ok(self.grants.lock().unwrap_or_else(|e| e.into_inner()).get(account_id).cloned())
    }

    fn put(&self, account_id: &str, grant: &Grant) -> Result<(), String> {
        self.grants.lock().unwrap_or_else(|e| e.into_inner()).insert(account_id.to_string(), grant.clone());
        Ok(())
    }

    fn delete(&self, account_id: &str) -> Result<(), String> {
        self.grants.lock().unwrap_or_else(|e| e.into_inner()).remove(account_id);
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::os::unix::fs::PermissionsExt;

    fn grant(refresh: &str) -> Grant {
        Grant {
            issuer: "https://auth.example.com".into(),
            token_endpoint: "https://auth.example.com/token".into(),
            revocation_endpoint: None,
            resource: "https://mcp.example.com/mcp".into(),
            client_id: "c1".into(),
            client_secret: Some("cs-secret".into()),
            client_auth: ClientAuth::Basic,
            refresh_token: Some(refresh.into()),
            access_token: "at-secret".into(),
            expires_at: Some(1),
            scope: None,
        }
    }

    #[test]
    fn grants_survive_a_restart_in_a_file_only_the_user_can_read() {
        let dir = std::env::temp_dir().join(format!("cv-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("vault.json");
        FileVault::new(path.clone()).put("a1", &grant("rt-1")).unwrap();
        assert_eq!(std::fs::metadata(&path).unwrap().permissions().mode() & 0o777, 0o600);
        let again = FileVault::new(path.clone());
        assert_eq!(again.get("a1").unwrap(), Some(grant("rt-1")));
        again.delete("a1").unwrap();
        assert_eq!(FileVault::new(path).get("a1").unwrap(), None);
    }

    #[test]
    fn a_grant_prints_no_token() {
        let text = format!("{:?}", grant("rt-secret"));
        assert!(!text.contains("secret"), "{text}");
    }
}
