use std::io::Read;
use std::os::unix::fs::PermissionsExt;
use std::os::unix::process::CommandExt;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::OnceLock;
use std::thread;
use std::time::{Duration, Instant};

const MARKER: &str = "__CREW_PATH__";
/// A slow `.zshrc` delays the first spawn by this much at worst, once.
const LOGIN_TIMEOUT: Duration = Duration::from_secs(5);
const LOGIN_POLL: Duration = Duration::from_millis(20);

static LOGIN_PATH: OnceLock<Option<String>> = OnceLock::new();

/// Starts reading the login shell's PATH off the caller's thread, so the first
/// spawn finds it ready.
pub fn prewarm() {
    thread::spawn(login_path);
}

/// Where a CLI named on its own is looked for: the usual install dirs, then the
/// user's shell PATH, then whatever the app inherited.
pub fn search_dirs() -> Vec<PathBuf> {
    let mut dirs: Vec<PathBuf> = Vec::new();
    if let Some(home) = home_dir().map(PathBuf::from) {
        dirs.push(home.join(".local/bin"));
        dirs.push(home.join(".claude/local"));
        dirs.push(home.join(".opencode/bin"));
        dirs.push(home.join(".cargo/bin"));
        dirs.push(home.join(".npm-global/bin"));
    }
    dirs.push(PathBuf::from("/opt/homebrew/bin"));
    dirs.push(PathBuf::from("/usr/local/bin"));
    dirs.push(PathBuf::from("/usr/bin"));
    dirs.push(PathBuf::from("/bin"));
    let inherited = std::env::var("PATH").ok();
    for path in [login_path().as_deref(), inherited.as_deref()].into_iter().flatten() {
        dirs.extend(path.split(':').filter(|dir| !dir.is_empty()).map(PathBuf::from));
    }
    let mut seen = std::collections::HashSet::new();
    dirs.retain(|dir| seen.insert(dir.clone()));
    dirs
}

pub fn joined() -> String {
    search_dirs()
        .iter()
        .map(|dir| dir.to_string_lossy().into_owned())
        .collect::<Vec<_>>()
        .join(":")
}

pub fn resolve(name: &str) -> Option<PathBuf> {
    search_dirs()
        .into_iter()
        .map(|dir| dir.join(name))
        .find(|path| is_executable(path))
}

fn is_executable(path: &Path) -> bool {
    std::fs::metadata(path)
        .map(|meta| meta.is_file() && meta.permissions().mode() & 0o111 != 0)
        .unwrap_or(false)
}

fn home_dir() -> Option<String> {
    std::env::var("HOME").ok().filter(|home| !home.is_empty())
}

fn login_path() -> &'static Option<String> {
    LOGIN_PATH.get_or_init(read_login_path)
}

/// A GUI app inherits launchd's PATH, not the one the user's shell builds.
/// `-i` matters: zsh reads `.zshrc`, where fnm, nvm and mise hook in, only for
/// interactive shells. The markers skip whatever the rc files print.
fn read_login_path() -> Option<String> {
    let shell = std::env::var("SHELL").ok().filter(|shell| !shell.is_empty())?;
    login_shell_path(&shell, LOGIN_TIMEOUT)
}

fn login_shell_path(shell: &str, timeout: Duration) -> Option<String> {
    let script = format!("printf '{MARKER}%s{MARKER}' \"$PATH\"");
    let mut child = Command::new(shell)
        .args(["-ilc", &script])
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .process_group(0)
        .spawn()
        .ok()?;
    let deadline = Instant::now() + timeout;
    loop {
        match child.try_wait() {
            Ok(Some(_)) => break,
            Ok(None) if Instant::now() < deadline => thread::sleep(LOGIN_POLL),
            _ => {
                unsafe { libc::kill(-(child.id() as i32), libc::SIGKILL) };
                let _ = child.wait();
                eprintln!("[path] {shell} -ilc did not answer in {timeout:?}");
                return None;
            }
        }
    }
    let mut out = String::new();
    child.stdout.take()?.read_to_string(&mut out).ok()?;
    parse_marked(&out)
}

fn parse_marked(out: &str) -> Option<String> {
    let start = out.find(MARKER)? + MARKER.len();
    let len = out[start..].find(MARKER)?;
    Some(out[start..start + len].to_string()).filter(|path| !path.is_empty())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_support::{fake_cli, temp_dir};

    #[test]
    fn parse_marked_skips_rc_noise() {
        let out = format!("Using Node for alias default\n{MARKER}/a:/b{MARKER}\nbye");
        assert_eq!(parse_marked(&out).as_deref(), Some("/a:/b"));
    }

    #[test]
    fn parse_marked_rejects_missing_or_empty() {
        assert_eq!(parse_marked("no markers"), None);
        assert_eq!(parse_marked(&format!("{MARKER}{MARKER}")), None);
    }

    #[test]
    fn only_regular_files_with_an_exec_bit_are_executable() {
        let dir = temp_dir();
        let tool = fake_cli(dir.path(), "tool", "exit 0");
        let plain = dir.path().join("plain");
        std::fs::write(&plain, "#!/bin/sh\n").unwrap();
        std::fs::set_permissions(&plain, std::fs::Permissions::from_mode(0o644)).unwrap();
        let link = dir.path().join("link");
        std::os::unix::fs::symlink(&tool, &link).unwrap();
        let dangling = dir.path().join("dangling");
        std::os::unix::fs::symlink(dir.path().join("gone"), &dangling).unwrap();

        assert!(is_executable(&tool));
        assert!(is_executable(&link));
        assert!(!is_executable(&plain));
        assert!(!is_executable(dir.path()));
        assert!(!is_executable(&dangling));
        assert!(!is_executable(&dir.path().join("missing")));
    }

    #[test]
    fn the_login_shell_path_is_read_between_the_markers() {
        let dir = temp_dir();
        // Stands in for `zsh -ilc <script>`: rc noise first, then the script
        // run with the PATH the rc files built.
        let shell = fake_cli(
            dir.path(),
            "zsh",
            "echo 'Using Node for alias default'\nPATH=/from/login:/usr/bin exec /bin/sh -c \"$2\"",
        );
        let path = login_shell_path(shell.to_str().unwrap(), Duration::from_secs(2));
        assert_eq!(path.as_deref(), Some("/from/login:/usr/bin"));
    }

    #[test]
    fn a_login_shell_that_hangs_is_given_up_on() {
        let dir = temp_dir();
        let shell = fake_cli(dir.path(), "zsh", "sleep 5");
        let started = Instant::now();
        assert_eq!(
            login_shell_path(shell.to_str().unwrap(), Duration::from_millis(100)),
            None
        );
        assert!(started.elapsed() < Duration::from_secs(4), "it waited for the shell");
    }

    #[test]
    fn a_login_shell_that_cannot_start_gives_no_path() {
        assert_eq!(login_shell_path("/nonexistent/zsh", Duration::from_secs(1)), None);
    }

    #[test]
    fn prewarming_keeps_the_search_dirs_deduplicated() {
        prewarm();
        let dirs = search_dirs();
        assert!(dirs.contains(&PathBuf::from("/usr/bin")));
        let unique: std::collections::HashSet<_> = dirs.iter().collect();
        assert_eq!(unique.len(), dirs.len());
        assert_eq!(joined().split(':').count(), dirs.len());
    }
}
