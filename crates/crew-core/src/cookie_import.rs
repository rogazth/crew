//! Copies cookies out of a Chromium browser on this Mac so Crew's pages start
//! signed in where that browser is.
//!
//! This module only reads and decrypts; the window hands the result to main,
//! which writes it into the pages' session. The source database is copied
//! first: the browser keeps it locked while it runs.
//!
//! Chromium on macOS encrypts each value with AES-128-CBC under a key derived
//! from a password it keeps in the login keychain ("<Browser> Safe Storage").
//! Reading that password is what makes macOS ask the user.

use std::fs;
use std::path::{Path, PathBuf};

use crew_protocol::{CookieRead, CookieSameSite, CookieSource, ImportedCookie};
use rusqlite::{Connection, OpenFlags, OptionalExtension};

struct Browser {
    id: &'static str,
    label: &'static str,
    /// Under `~/Library/Application Support`.
    root: &'static str,
    keychain_service: &'static str,
}

const BROWSERS: &[Browser] = &[
    Browser { id: "chrome", label: "Chrome", root: "Google/Chrome", keychain_service: "Chrome Safe Storage" },
    Browser { id: "arc", label: "Arc", root: "Arc/User Data", keychain_service: "Arc Safe Storage" },
    Browser { id: "brave", label: "Brave", root: "BraveSoftware/Brave-Browser", keychain_service: "Brave Safe Storage" },
    Browser { id: "edge", label: "Edge", root: "Microsoft Edge", keychain_service: "Microsoft Edge Safe Storage" },
    Browser { id: "vivaldi", label: "Vivaldi", root: "Vivaldi", keychain_service: "Vivaldi Safe Storage" },
    Browser { id: "chromium", label: "Chromium", root: "Chromium", keychain_service: "Chromium Safe Storage" },
    Browser { id: "helium", label: "Helium", root: "net.imput.helium", keychain_service: "Helium Storage Key" },
];

/// Google ties its sign-in to the browser that made it; a copied session gets
/// the original signed out too.
const NON_TRANSFERABLE: &[&str] = &["google.com"];

/// Seconds between 1601-01-01 (Chromium's epoch) and 1970-01-01.
const CHROMIUM_EPOCH_OFFSET: i64 = 11_644_473_600;

/// From this database version on, the plaintext starts with SHA-256(host_key).
const HOST_DIGEST_VERSION: i64 = 24;

const SALT: &[u8] = b"saltysalt";
const ITERATIONS: u32 = 1003;

pub type Key = [u8; 16];

fn support_dir() -> Option<PathBuf> {
    std::env::var_os("HOME").map(|home| PathBuf::from(home).join("Library/Application Support"))
}

/// Every profile with a cookie database, browsers in a fixed order.
pub fn sources() -> Vec<CookieSource> {
    let Some(support) = support_dir() else { return Vec::new() };
    BROWSERS
        .iter()
        .flat_map(|browser| {
            profiles(&support.join(browser.root)).into_iter().map(|(folder, name)| CookieSource {
                id: format!("{}/{folder}", browser.id),
                browser: browser.label.to_string(),
                profile: name,
            })
        })
        .collect()
}

/// `(folder, display name)` for each profile under a browser's user-data folder.
fn profiles(root: &Path) -> Vec<(String, String)> {
    let Ok(entries) = fs::read_dir(root) else { return Vec::new() };
    let names = profile_names(root);
    let mut found: Vec<(String, String)> = entries
        .flatten()
        .filter_map(|entry| {
            let folder = entry.file_name().to_str()?.to_string();
            if folder != "Default" && !folder.starts_with("Profile ") {
                return None;
            }
            cookies_file(&entry.path())?;
            let name = names.get(&folder).cloned().unwrap_or_else(|| folder.clone());
            Some((folder, name))
        })
        .collect();
    // "Default" first, then "Profile 2" before "Profile 10".
    found.sort_by_key(|(folder, _)| folder.strip_prefix("Profile ").and_then(|n| n.parse::<u32>().ok()).unwrap_or(0));
    found
}

/// The names the user gave each profile, from the browser's `Local State`.
fn profile_names(root: &Path) -> std::collections::HashMap<String, String> {
    let parsed = fs::read_to_string(root.join("Local State"))
        .ok()
        .and_then(|text| serde_json::from_str::<serde_json::Value>(&text).ok());
    let Some(cache) = parsed.as_ref().and_then(|v| v.pointer("/profile/info_cache")).and_then(|v| v.as_object()) else {
        return Default::default();
    };
    cache
        .iter()
        .filter_map(|(folder, info)| Some((folder.clone(), info.get("name")?.as_str()?.to_string())))
        .collect()
}

/// Newer Chromium keeps the database under `Network/`; older, in the profile folder.
fn cookies_file(profile: &Path) -> Option<PathBuf> {
    [profile.join("Network/Cookies"), profile.join("Cookies")].into_iter().find(|path| path.is_file())
}

/// Resolves a source id to its browser and profile folder, refusing anything
/// that is not one of the known browsers and a plain profile folder name.
fn locate(source_id: &str) -> Result<(&'static Browser, PathBuf), String> {
    let (browser_id, folder) = source_id.split_once('/').ok_or("Unknown cookie source")?;
    let browser = BROWSERS.iter().find(|b| b.id == browser_id).ok_or("Unknown browser")?;
    if folder != "Default" && !folder.strip_prefix("Profile ").is_some_and(|n| n.parse::<u32>().is_ok()) {
        return Err("Unknown profile".into());
    }
    let support = support_dir().ok_or("No home folder")?;
    Ok((browser, support.join(browser.root).join(folder)))
}

/// Reads and decrypts one profile's cookies. Asks the keychain first, so
/// nothing is copied if the user declines.
pub fn read(source_id: &str) -> Result<CookieRead, String> {
    let (browser, profile) = locate(source_id)?;
    let db = cookies_file(&profile).ok_or("That profile has no cookies")?;
    let key = derive_key(&keychain_password(browser.keychain_service)?);
    let copy = Snapshot::take(&db)?;
    read_db(&copy.path, &key, now_secs())
}

fn now_secs() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

#[cfg(target_os = "macos")]
fn keychain_password(service: &str) -> Result<Vec<u8>, String> {
    use security_framework::item::{ItemClass, ItemSearchOptions, SearchResult};
    let results = ItemSearchOptions::new()
        .class(ItemClass::generic_password())
        .service(service)
        .load_data(true)
        .limit(1)
        .search()
        .map_err(|e| format!("Couldn't read the keychain: {e}"))?;
    results
        .into_iter()
        .find_map(|result| match result {
            SearchResult::Data(data) => Some(data),
            _ => None,
        })
        .ok_or_else(|| format!("No \"{service}\" in the keychain"))
}

#[cfg(not(target_os = "macos"))]
fn keychain_password(_service: &str) -> Result<Vec<u8>, String> {
    Err("Importing cookies is only supported on macOS".into())
}

pub fn derive_key(password: &[u8]) -> Key {
    let mut key = [0u8; 16];
    pbkdf2::pbkdf2_hmac::<sha1::Sha1>(password, SALT, ITERATIONS, &mut key);
    key
}

/// A private copy of the database and its journal, removed on drop.
struct Snapshot {
    dir: PathBuf,
    path: PathBuf,
}

impl Snapshot {
    fn take(db: &Path) -> Result<Self, String> {
        let dir = std::env::temp_dir().join(format!("crew-cookies-{}", uuid::Uuid::new_v4()));
        fs::create_dir(&dir).map_err(|e| e.to_string())?;
        let snapshot = Snapshot { path: dir.join("Cookies"), dir };
        fs::copy(db, &snapshot.path).map_err(|e| format!("Couldn't copy the cookie database: {e}"))?;
        for suffix in ["-wal", "-journal"] {
            let side = PathBuf::from(format!("{}{suffix}", db.display()));
            if side.is_file() {
                let _ = fs::copy(&side, format!("{}{suffix}", snapshot.path.display()));
            }
        }
        Ok(snapshot)
    }
}

impl Drop for Snapshot {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.dir);
    }
}

/// Every cookie in a Chromium database that can move: unexpired, decryptable,
/// unpartitioned, and not on a domain that must stay where it was made.
pub fn read_db(path: &Path, key: &Key, now: i64) -> Result<CookieRead, String> {
    // Read-write so a copied WAL is folded in; it is our own copy.
    let conn = Connection::open_with_flags(path, OpenFlags::SQLITE_OPEN_READ_WRITE | OpenFlags::SQLITE_OPEN_NO_MUTEX)
        .map_err(|e| format!("Couldn't open the cookie database: {e}"))?;
    let version: i64 = conn
        .query_row("SELECT value FROM meta WHERE key = 'version'", [], |row| row.get::<_, String>(0))
        .optional()
        .map_err(|e| e.to_string())?
        .and_then(|v| v.parse().ok())
        .unwrap_or(0);
    let partitioned = has_column(&conn, "cookies", "top_frame_site_key")?;
    let sql = format!(
        "SELECT host_key, name, value, encrypted_value, path, expires_utc, is_secure, is_httponly, samesite, {} FROM cookies",
        if partitioned { "top_frame_site_key" } else { "''" }
    );
    let mut stmt = conn.prepare(&sql).map_err(|e| e.to_string())?;
    let mut rows = stmt.query([]).map_err(|e| e.to_string())?;
    let mut cookies = Vec::new();
    let mut skipped = 0u32;
    while let Some(row) = rows.next().map_err(|e| e.to_string())? {
        let host: String = row.get(0).map_err(|e| e.to_string())?;
        let partition: String = row.get(9).unwrap_or_default();
        let expires = unix_expiry(row.get(5).unwrap_or(0));
        let movable = partition.is_empty() && transferable(&host) && expires.is_none_or(|at| at > now);
        let plain: String = row.get(2).unwrap_or_default();
        let encrypted: Vec<u8> = row.get(3).unwrap_or_default();
        let value = if !movable {
            None
        } else if encrypted.is_empty() {
            Some(plain)
        } else {
            decrypt(&encrypted, key, version, &host)
        };
        let Some(value) = value else {
            skipped += 1;
            continue;
        };
        cookies.push(ImportedCookie {
            host,
            name: row.get(1).map_err(|e| e.to_string())?,
            value,
            path: row.get(4).map_err(|e| e.to_string())?,
            secure: row.get::<_, i64>(6).unwrap_or(0) != 0,
            http_only: row.get::<_, i64>(7).unwrap_or(0) != 0,
            same_site: same_site(row.get(8).unwrap_or(-1)),
            expires,
        });
    }
    Ok(CookieRead { cookies, skipped })
}

fn has_column(conn: &Connection, table: &str, column: &str) -> Result<bool, String> {
    let mut stmt = conn.prepare(&format!("PRAGMA table_info({table})")).map_err(|e| e.to_string())?;
    let found = stmt
        .query_map([], |row| row.get::<_, String>(1))
        .map_err(|e| e.to_string())?
        .flatten()
        .any(|name| name == column);
    Ok(found)
}

fn transferable(host: &str) -> bool {
    let host = host.trim_start_matches('.').to_ascii_lowercase();
    !NON_TRANSFERABLE.iter().any(|domain| host == *domain || host.ends_with(&format!(".{domain}")))
}

/// Chromium counts microseconds since 1601; 0 means the cookie ends with the session.
fn unix_expiry(chromium: i64) -> Option<i64> {
    (chromium > 0).then(|| chromium / 1_000_000 - CHROMIUM_EPOCH_OFFSET)
}

fn same_site(value: i64) -> CookieSameSite {
    match value {
        0 => CookieSameSite::NoRestriction,
        1 => CookieSameSite::Lax,
        2 => CookieSameSite::Strict,
        _ => CookieSameSite::Unspecified,
    }
}

/// `v10` + AES-128-CBC with a 16-space IV. None for anything else, including
/// a value that isn't text after decrypting (a wrong key looks like that).
pub fn decrypt(encrypted: &[u8], key: &Key, version: i64, host: &str) -> Option<String> {
    use aes::cipher::{block_padding::Pkcs7, BlockDecryptMut, KeyIvInit};
    let ciphertext = encrypted.strip_prefix(b"v10")?;
    let mut buf = ciphertext.to_vec();
    let plain = cbc::Decryptor::<aes::Aes128>::new(key.into(), &[b' '; 16].into())
        .decrypt_padded_mut::<Pkcs7>(&mut buf)
        .ok()?;
    let plain = if version >= HOST_DIGEST_VERSION {
        let digest = plain.get(..32)?;
        if digest != host_digest(host) {
            return None;
        }
        &plain[32..]
    } else {
        plain
    };
    String::from_utf8(plain.to_vec()).ok()
}

fn host_digest(host: &str) -> [u8; 32] {
    use sha2::{Digest, Sha256};
    Sha256::digest(host.as_bytes()).into()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn encrypt(plain: &[u8], key: &Key) -> Vec<u8> {
        use aes::cipher::{block_padding::Pkcs7, BlockEncryptMut, KeyIvInit};
        let mut buf = vec![0u8; plain.len() + 16];
        let len = cbc::Encryptor::<aes::Aes128>::new(key.into(), &[b' '; 16].into())
            .encrypt_padded_b2b_mut::<Pkcs7>(plain, &mut buf)
            .unwrap()
            .len();
        buf.truncate(len);
        [b"v10".as_slice(), &buf].concat()
    }

    fn with_digest(host: &str, value: &str) -> Vec<u8> {
        [host_digest(host).as_slice(), value.as_bytes()].concat()
    }

    fn chromium_time(unix: i64) -> i64 {
        (unix + CHROMIUM_EPOCH_OFFSET) * 1_000_000
    }

    fn database(version: i64, partitioned: bool) -> (PathBuf, Connection) {
        let path = std::env::temp_dir().join(format!("crew-cookie-test-{}.db", uuid::Uuid::new_v4()));
        let conn = Connection::open(&path).unwrap();
        let partition_column = if partitioned { "top_frame_site_key TEXT NOT NULL DEFAULT ''," } else { "" };
        conn.execute_batch(&format!(
            "CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT);
             INSERT INTO meta VALUES ('version', '{version}');
             CREATE TABLE cookies (
               host_key TEXT, {partition_column} name TEXT, value TEXT, encrypted_value BLOB,
               path TEXT, expires_utc INTEGER, is_secure INTEGER, is_httponly INTEGER, samesite INTEGER
             );"
        ))
        .unwrap();
        (path, conn)
    }

    #[test]
    fn derives_the_chromium_key() {
        // PBKDF2-HMAC-SHA1("peanuts", "saltysalt", 1003, 16), checked against Python's hashlib.
        assert_eq!(
            derive_key(b"peanuts"),
            [0xd9, 0xa0, 0x9d, 0x49, 0x9b, 0x4e, 0x1b, 0x74, 0x61, 0xf2, 0x8e, 0x67, 0x97, 0x2c, 0x6d, 0xbd]
        );
    }

    #[test]
    fn decrypts_with_and_without_the_host_digest() {
        let key = derive_key(b"secret");
        assert_eq!(decrypt(&encrypt(b"abc", &key), &key, 23, ".x.com").as_deref(), Some("abc"));
        let digested = encrypt(&with_digest(".x.com", "abc"), &key);
        assert_eq!(decrypt(&digested, &key, 24, ".x.com").as_deref(), Some("abc"));
        assert_eq!(decrypt(&digested, &key, 24, ".y.com"), None);
    }

    #[test]
    fn a_wrong_key_or_unknown_prefix_gives_nothing() {
        let key = derive_key(b"secret");
        let other = derive_key(b"other");
        assert_eq!(decrypt(&encrypt(&with_digest("x.com", "abc"), &key), &other, 24, "x.com"), None);
        assert_eq!(decrypt(b"v20abcdefabcdefabcdef", &key, 24, "x.com"), None);
    }

    #[test]
    fn reads_movable_cookies_and_counts_the_rest() {
        let key = derive_key(b"secret");
        let now = 1_900_000_000;
        let (path, conn) = database(24, true);
        let rows: &[(&str, &str, &str, Vec<u8>, i64, i64)] = &[
            (".github.com", "", "user", encrypt(&with_digest(".github.com", "me"), &key), chromium_time(now + 60), 1),
            ("app.example.com", "", "sid", encrypt(&with_digest("app.example.com", "s"), &key), 0, 2),
            ("old.example.com", "", "gone", encrypt(&with_digest("old.example.com", "x"), &key), chromium_time(now - 60), 0),
            (".google.com", "", "SID", encrypt(&with_digest(".google.com", "g"), &key), 0, 0),
            ("embed.example.com", "https://site.com", "p", encrypt(&with_digest("embed.example.com", "p"), &key), 0, 0),
            ("broken.example.com", "", "b", b"v10garbagegarbage".to_vec(), 0, 0),
        ];
        for (host, partition, name, encrypted, expires, samesite) in rows {
            conn.execute(
                "INSERT INTO cookies VALUES (?1, ?2, ?3, '', ?4, '/', ?5, 1, 1, ?6)",
                rusqlite::params![host, partition, name, encrypted, expires, samesite],
            )
            .unwrap();
        }
        drop(conn);

        let read = read_db(&path, &key, now).unwrap();
        let _ = fs::remove_file(&path);
        assert_eq!(read.skipped, 4);
        assert_eq!(
            read.cookies,
            vec![
                ImportedCookie {
                    host: ".github.com".into(),
                    name: "user".into(),
                    value: "me".into(),
                    path: "/".into(),
                    secure: true,
                    http_only: true,
                    same_site: CookieSameSite::Lax,
                    expires: Some(now + 60),
                },
                ImportedCookie {
                    host: "app.example.com".into(),
                    name: "sid".into(),
                    value: "s".into(),
                    path: "/".into(),
                    secure: true,
                    http_only: true,
                    same_site: CookieSameSite::Strict,
                    expires: None,
                },
            ]
        );
    }

    #[test]
    fn reads_an_older_schema_with_plain_values() {
        let key = derive_key(b"secret");
        let (path, conn) = database(12, false);
        conn.execute("INSERT INTO cookies VALUES ('x.com', 'a', 'plain', x'', '/', 0, 0, 0, -1)", []).unwrap();
        drop(conn);
        let read = read_db(&path, &key, 0).unwrap();
        let _ = fs::remove_file(&path);
        assert_eq!(read.skipped, 0);
        assert_eq!(read.cookies[0].value, "plain");
        assert_eq!(read.cookies[0].same_site, CookieSameSite::Unspecified);
    }

    #[test]
    fn locate_refuses_paths_outside_a_profile() {
        assert!(locate("chrome/../../etc").is_err());
        assert!(locate("chrome/Profile 1/..").is_err());
        assert!(locate("safari/Default").is_err());
        assert!(locate("chrome/Profile 3").is_ok());
    }
}
