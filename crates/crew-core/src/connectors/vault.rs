//! The vault: where Crew's grants live on the machine that holds them.
//!
//! A grant is an account's refresh token and the access token it last
//! bought, with what it takes to refresh it without discovering the server
//! again. Only the vault refreshes: a rotating refresh token can have one
//! holder, and a copy that refreshes invalidates the others.
//!
//! Behind a trait, with two places to keep them (`open` picks one):
//!
//! - The login keychain on macOS: one item per build, service `Crew
//!   Connectors` and the data dir as its account. The item trusts the crewd
//!   that made it, and a signed update is the same app, so nothing prompts.
//!   A `vault.json` left from before is moved into it, then deleted.
//! - `<data>/vault.json`, mode 0600, written whole through a temporary file,
//!   everywhere else: Linux, a debug build (ad-hoc signed, so every rebuild
//!   would be a new app to the keychain and prompt), `crewd serve` (an SSH
//!   session's keychain may be locked) and the e2e sandbox. It is not
//!   encrypted at rest: the key would sit on the same disk.

use std::collections::HashMap;
use std::fmt;
use std::io::Write;
use std::os::unix::fs::OpenOptionsExt;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};

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

/// Where the grants are kept, as `crewd` asks for it.
pub struct VaultAt {
    /// `<data>/vault.json`: the vault itself, or the one to move into the keychain.
    pub file: PathBuf,
    /// The data dir, which names this build's keychain item; `None` keeps the file.
    pub keychain: Option<PathBuf>,
}

/// The vault `at` says, falling back to the file where there is no keychain.
pub fn open(at: VaultAt) -> Arc<dyn VaultStore> {
    #[cfg(target_os = "macos")]
    if let Some(dir) = at.keychain {
        return Arc::new(Cached::over(Keychain { account: dir.to_string_lossy().into_owned(), legacy: at.file }));
    }
    Arc::new(FileVault::new(at.file))
}

/// The whole vault: every account's grant.
#[derive(Serialize, Deserialize, Default)]
pub struct FileBody {
    version: u32,
    grants: HashMap<String, Grant>,
}

/// Where a cached vault reads its body from and writes it back to, whole.
pub trait Backing: Send + Sync {
    fn read(&self) -> Result<FileBody, String>;
    fn write(&self, body: &FileBody) -> Result<(), String>;
}

/// A vault read once, then kept: the daemon is its only writer.
pub struct Cached<B> {
    backing: B,
    body: Mutex<Option<FileBody>>,
}

impl<B: Backing> Cached<B> {
    fn over(backing: B) -> Self {
        Self { backing, body: Mutex::new(None) }
    }

    fn with<T>(&self, f: impl FnOnce(&mut FileBody) -> (T, bool)) -> Result<T, String> {
        let mut guard = self.body.lock().unwrap_or_else(|e| e.into_inner());
        if guard.is_none() {
            *guard = Some(self.backing.read()?);
        }
        let body = guard.as_mut().expect("read above");
        let (out, changed) = f(body);
        if changed {
            self.backing.write(body)?;
        }
        Ok(out)
    }
}

impl<B: Backing> VaultStore for Cached<B> {
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

/// The 0600 file.
pub type FileVault = Cached<File>;

pub struct File {
    path: PathBuf,
}

impl FileVault {
    pub fn new(path: PathBuf) -> Self {
        Cached::over(File { path })
    }
}

impl Backing for File {
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

/// The login keychain's item for this build.
#[cfg(target_os = "macos")]
pub struct Keychain {
    account: String,
    /// The file this build kept before, moved in on the first read.
    legacy: PathBuf,
}

#[cfg(target_os = "macos")]
const KEYCHAIN_SERVICE: &str = "Crew Connectors";

#[cfg(target_os = "macos")]
impl Keychain {
    fn stored(&self) -> Result<FileBody, String> {
        use security_framework::passwords::get_generic_password;
        // errSecItemNotFound: nothing kept yet.
        const NOT_FOUND: i32 = -25300;
        match get_generic_password(KEYCHAIN_SERVICE, &self.account) {
            Ok(bytes) => serde_json::from_slice(&bytes).map_err(|_| "The keychain's vault is not one Crew can read".to_string()),
            Err(e) if e.code() == NOT_FOUND => Ok(FileBody { version: 1, grants: HashMap::new() }),
            Err(e) => Err(format!("Couldn't read the vault from the keychain: {e}")),
        }
    }
}

#[cfg(target_os = "macos")]
impl Backing for Keychain {
    fn read(&self) -> Result<FileBody, String> {
        let mut body = self.stored()?;
        if !self.legacy.exists() {
            return Ok(body);
        }
        // What the keychain already holds is newer than the file.
        let file = File { path: self.legacy.clone() }.read()?;
        for (account, grant) in file.grants {
            body.grants.entry(account).or_insert(grant);
        }
        self.write(&body)?;
        std::fs::remove_file(&self.legacy).map_err(|e| format!("Couldn't remove {} after moving it into the keychain: {e}", self.legacy.display()))?;
        Ok(body)
    }

    fn write(&self, body: &FileBody) -> Result<(), String> {
        let bytes = serde_json::to_vec(body).map_err(|e| e.to_string())?;
        security_framework::passwords::set_generic_password(KEYCHAIN_SERVICE, &self.account, &bytes)
            .map_err(|e| format!("Couldn't write the vault to the keychain: {e}"))
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

    /// Run by hand, since it writes to the login keychain:
    /// `cargo test -p crew-core keychain -- --ignored`.
    #[cfg(target_os = "macos")]
    #[test]
    #[ignore = "writes to the login keychain"]
    fn the_keychain_takes_the_old_file_and_keeps_its_grants() {
        let dir = std::env::temp_dir().join(format!("cv-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let file = dir.join("vault.json");
        FileVault::new(file.clone()).put("old", &grant("rt-old")).unwrap();
        let at = || VaultAt { file: file.clone(), keychain: Some(dir.clone()) };
        let vault = open(at());
        assert_eq!(vault.get("old").unwrap(), Some(grant("rt-old")), "the file's grant moved in");
        assert!(!file.exists(), "and the file is gone");
        vault.put("new", &grant("rt-new")).unwrap();
        let again = open(at());
        assert_eq!(again.get("new").unwrap(), Some(grant("rt-new")), "a restart reads the keychain");
        again.delete("old").unwrap();
        again.delete("new").unwrap();
        assert_eq!(open(at()).get("new").unwrap(), None);
        security_framework::passwords::delete_generic_password(KEYCHAIN_SERVICE, &dir.to_string_lossy()).unwrap();
    }

    #[test]
    fn a_grant_prints_no_token() {
        let text = format!("{:?}", grant("rt-secret"));
        assert!(!text.contains("secret"), "{text}");
    }
}
