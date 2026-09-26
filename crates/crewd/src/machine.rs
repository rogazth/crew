//! What a client asks of a daemon on another machine: who it is, and which
//! folders it could open there.

use std::io::Write;
use std::path::{Path, PathBuf};

use crew_core::agent::AgentHost;
use crew_protocol::{DirEntry, DirListing, MachineInfo, PROTOCOL};

/// The agent CLIs Settings reports as found or missing.
const AGENT_CLIS: &[&str] = &["claude", "codex", "cursor-agent", "opencode"];

pub fn info(agents_running: u32) -> MachineInfo {
    let (memory_total, memory_available) = memory();
    MachineInfo {
        version: env!("CARGO_PKG_VERSION").to_string(),
        protocol: PROTOCOL,
        os: os_name(),
        arch: std::env::consts::ARCH.to_string(),
        hostname: hostname(),
        home: home().to_string_lossy().into_owned(),
        cpus: std::thread::available_parallelism().map_or(1, |n| n.get() as u32),
        load: load(),
        memory_total,
        memory_available,
        agents_running,
        installed: AgentHost::installed(AGENT_CLIS.iter().map(|name| name.to_string()).collect()),
    }
}

fn home() -> PathBuf {
    std::env::var_os("HOME").map_or_else(|| PathBuf::from("/"), PathBuf::from)
}

/// `~` and `~/…` against the daemon's home; anything else as given.
fn expand(path: &str) -> PathBuf {
    match path.strip_prefix('~') {
        Some("") => home(),
        Some(rest) if rest.starts_with('/') => home().join(rest.trim_start_matches('/')),
        _ => PathBuf::from(path),
    }
}

fn is_repo(dir: &Path) -> bool {
    // A worktree's `.git` is a file.
    dir.join(".git").exists()
}

pub fn dir_list(path: &str) -> Result<DirListing, String> {
    let dir = expand(path);
    if !dir.is_absolute() {
        return Err(format!("{path}: Not an absolute path"));
    }
    let read = std::fs::read_dir(&dir).map_err(|e| format!("{}: {e}", dir.display()))?;
    let mut entries: Vec<DirEntry> = read
        .filter_map(Result::ok)
        .filter_map(|entry| {
            let child = entry.path();
            // Followed through symlinks: a linked folder opens like any other.
            if !std::fs::metadata(&child).ok()?.is_dir() {
                return None;
            }
            Some(DirEntry {
                name: entry.file_name().to_string_lossy().into_owned(),
                repo: is_repo(&child),
                path: child.to_string_lossy().into_owned(),
            })
        })
        .collect();
    entries.sort_by(|a, b| a.name.to_lowercase().cmp(&b.name.to_lowercase()).then_with(|| a.name.cmp(&b.name)));
    Ok(DirListing {
        repo: is_repo(&dir),
        path: dir.to_string_lossy().into_owned(),
        entries,
    })
}

/// The token a daemon that outlives its clients keeps across restarts, so a
/// client paired once keeps working. Only the owner can read it.
pub fn persistent_token(dir: &Path, fresh: impl FnOnce() -> String) -> Result<String, String> {
    let file = dir.join("token");
    if let Ok(saved) = std::fs::read_to_string(&file) {
        let saved = saved.trim();
        if !saved.is_empty() {
            return Ok(saved.to_string());
        }
    }
    let token = fresh();
    let mut options = std::fs::OpenOptions::new();
    options.write(true).create(true).truncate(true);
    #[cfg(unix)]
    std::os::unix::fs::OpenOptionsExt::mode(&mut options, 0o600);
    let mut out = options.open(&file).map_err(|e| format!("{}: {e}", file.display()))?;
    // `mode` only applies to a file it creates; an empty one left behind keeps its own.
    #[cfg(unix)]
    std::fs::set_permissions(&file, std::os::unix::fs::PermissionsExt::from_mode(0o600))
        .map_err(|e| format!("{}: {e}", file.display()))?;
    writeln!(out, "{token}").map_err(|e| format!("{}: {e}", file.display()))?;
    Ok(token)
}

fn hostname() -> String {
    let mut buf = [0u8; 256];
    // SAFETY: the buffer outlives the call and its length is passed with it.
    let ok = unsafe { libc::gethostname(buf.as_mut_ptr().cast(), buf.len()) } == 0;
    if !ok {
        return String::new();
    }
    let end = buf.iter().position(|b| *b == 0).unwrap_or(buf.len());
    String::from_utf8_lossy(&buf[..end]).into_owned()
}

fn load() -> f64 {
    let mut loads = [0f64; 3];
    // SAFETY: asks for at most as many samples as the array holds.
    if unsafe { libc::getloadavg(loads.as_mut_ptr(), 1) } < 1 {
        return 0.0;
    }
    loads[0]
}

#[cfg(target_os = "linux")]
fn os_name() -> String {
    std::fs::read_to_string("/etc/os-release")
        .ok()
        .and_then(|release| {
            release.lines().find_map(|line| {
                let value = line.strip_prefix("PRETTY_NAME=")?;
                Some(value.trim_matches('"').to_string())
            })
        })
        .unwrap_or_else(|| "Linux".into())
}

#[cfg(target_os = "macos")]
fn os_name() -> String {
    std::process::Command::new("sw_vers")
        .arg("-productVersion")
        .output()
        .ok()
        .filter(|output| output.status.success())
        .map(|output| format!("macOS {}", String::from_utf8_lossy(&output.stdout).trim()))
        .unwrap_or_else(|| "macOS".into())
}

#[cfg(not(any(target_os = "linux", target_os = "macos")))]
fn os_name() -> String {
    std::env::consts::OS.into()
}

#[cfg(target_os = "linux")]
fn memory() -> (u64, Option<u64>) {
    let Ok(meminfo) = std::fs::read_to_string("/proc/meminfo") else {
        return (0, None);
    };
    let kib = |key: &str| {
        meminfo.lines().find_map(|line| {
            let rest = line.strip_prefix(key)?.strip_prefix(':')?;
            rest.split_whitespace().next()?.parse::<u64>().ok().map(|kib| kib * 1024)
        })
    };
    (kib("MemTotal").unwrap_or(0), kib("MemAvailable"))
}

#[cfg(not(target_os = "linux"))]
fn memory() -> (u64, Option<u64>) {
    // SAFETY: sysconf only reads configuration values.
    let (pages, size) = unsafe { (libc::sysconf(libc::_SC_PHYS_PAGES), libc::sysconf(libc::_SC_PAGESIZE)) };
    if pages <= 0 || size <= 0 {
        return (0, None);
    }
    (pages as u64 * size as u64, None)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("crewd-machine-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn expands_home_only_at_the_start() {
        assert_eq!(expand("~"), home());
        assert_eq!(expand("~/code"), home().join("code"));
        assert_eq!(expand("/srv/~x"), PathBuf::from("/srv/~x"));
        assert_eq!(expand("~other"), PathBuf::from("~other"));
    }

    #[test]
    fn a_relative_path_is_refused() {
        assert!(dir_list("code").is_err());
    }

    #[test]
    fn token_keeps_the_saved_one_and_is_owner_only() {
        let dir = temp("token");
        let first = persistent_token(&dir, || "aaaa".into()).unwrap();
        let second = persistent_token(&dir, || "bbbb".into()).unwrap();
        assert_eq!(first, "aaaa");
        assert_eq!(second, "aaaa");
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = std::fs::metadata(dir.join("token")).unwrap().permissions().mode();
            assert_eq!(mode & 0o777, 0o600);
        }
    }

    #[test]
    fn info_describes_this_machine() {
        let info = info(2);
        assert_eq!(info.protocol, PROTOCOL);
        assert_eq!(info.agents_running, 2);
        assert!(info.cpus >= 1);
        assert!(info.memory_total > 0);
        assert!(!info.hostname.is_empty());
        assert!(!info.os.is_empty());
    }
}
