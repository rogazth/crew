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
/// A `--version` that has not answered by then is a hung binary, not a slow one.
const VERSION_TIMEOUT: Duration = Duration::from_secs(3);
const POLL: Duration = Duration::from_millis(20);
const OPENCODE_INSTALL: &str = "Crew needs opencode 2.x: npm i -g @opencode/cli";

static LOGIN_PATH: OnceLock<Option<String>> = OnceLock::new();

/// Starts reading the login shell's PATH off the caller's thread, so the first
/// spawn finds it ready.
pub fn prewarm() {
    thread::spawn(login_path);
}

/// Where a CLI named on its own is looked for: the usual install dirs, then the
/// user's shell PATH, then whatever the app inherited.
pub fn search_dirs() -> Vec<PathBuf> {
    ordered_dirs(false)
}

/// The same folders as `search_dirs`, with the shell PATH first when asked. The
/// usual install dirs can hold an older install that the shell's PATH has
/// already moved past: opencode 1.x sits in `~/.opencode/bin`, while the shell
/// finds 2.x through fnm.
fn ordered_dirs(login_first: bool) -> Vec<PathBuf> {
    let mut fixed: Vec<PathBuf> = Vec::new();
    if let Some(home) = home_dir().map(PathBuf::from) {
        fixed.push(home.join(".local/bin"));
        fixed.push(home.join(".claude/local"));
        fixed.push(home.join(".opencode/bin"));
        fixed.push(home.join(".cargo/bin"));
        fixed.push(home.join(".npm-global/bin"));
    }
    fixed.push(PathBuf::from("/opt/homebrew/bin"));
    fixed.push(PathBuf::from("/usr/local/bin"));
    fixed.push(PathBuf::from("/usr/bin"));
    fixed.push(PathBuf::from("/bin"));
    let login = login_path().as_deref().map(split_path).unwrap_or_default();
    let inherited = std::env::var("PATH").map(|path| split_path(&path)).unwrap_or_default();
    let mut dirs = if login_first { [login, fixed, inherited].concat() } else { [fixed, login, inherited].concat() };
    let mut seen = std::collections::HashSet::new();
    dirs.retain(|dir| seen.insert(dir.clone()));
    dirs
}

fn split_path(path: &str) -> Vec<PathBuf> {
    path.split(':').filter(|dir| !dir.is_empty()).map(PathBuf::from).collect()
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

/// The first executable called `name` that `accept` takes, the shell PATH
/// first. Nothing is remembered between calls: an install that changes is seen
/// on the next one.
pub fn resolve_matching(name: &str, accept: impl Fn(&Path) -> bool) -> Option<PathBuf> {
    find_in(&ordered_dirs(true), name, accept)
}

/// The opencode Crew runs, for a turn or a terminal: 2.x only, since 1.x has a
/// different CLI and config.
pub fn resolve_opencode() -> Result<PathBuf, String> {
    opencode_in(&ordered_dirs(true))
}

/// What Settings says of opencode: the version line of the one Crew runs, or
/// why it runs none, with the command that installs 2.x.
pub fn opencode_report() -> String {
    match resolve_opencode() {
        Ok(path) => version_line(&path).unwrap_or_else(|| format!("opencode at {}", path.display())),
        Err(why) => why,
    }
}

fn opencode_in(dirs: &[PathBuf]) -> Result<PathBuf, String> {
    let is_v2 = |path: &Path| version_line(path).is_some_and(|line| line.starts_with("opencode v2."));
    if let Some(path) = find_in(dirs, "opencode", is_v2) {
        return Ok(path);
    }
    // Only for the message: the first opencode that answers, whatever it is.
    let found = dirs
        .iter()
        .map(|dir| dir.join("opencode"))
        .filter(|path| is_executable(path))
        .find_map(|path| version_line(&path).map(|line| (line, path)));
    Err(match found {
        Some((line, path)) => format!("{OPENCODE_INSTALL} (found {line} at {})", path.display()),
        None => OPENCODE_INSTALL.to_string(),
    })
}

fn find_in(dirs: &[PathBuf], name: &str, accept: impl Fn(&Path) -> bool) -> Option<PathBuf> {
    dirs.iter()
        .map(|dir| dir.join(name))
        .find(|path| is_executable(path) && accept(path))
}

/// The first line `path --version` prints, or None when it does not answer in time.
fn version_line(path: &Path) -> Option<String> {
    version_line_within(path, VERSION_TIMEOUT)
}

fn version_line_within(path: &Path, timeout: Duration) -> Option<String> {
    let mut child = Command::new(path)
        .arg("--version")
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
            Ok(None) if Instant::now() < deadline => thread::sleep(POLL),
            _ => {
                unsafe { libc::kill(-(child.id() as i32), libc::SIGKILL) };
                let _ = child.wait();
                return None;
            }
        }
    }
    let mut out = String::new();
    child.stdout.take()?.read_to_string(&mut out).ok()?;
    out.lines().next().map(|line| line.trim().to_string()).filter(|line| !line.is_empty())
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
    let script = format!("printf '{MARKER}%s{MARKER}' \"$PATH\"");
    let mut child = Command::new(&shell)
        .args(["-ilc", &script])
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .process_group(0)
        .spawn()
        .ok()?;
    let deadline = Instant::now() + LOGIN_TIMEOUT;
    loop {
        match child.try_wait() {
            Ok(Some(_)) => break,
            Ok(None) if Instant::now() < deadline => thread::sleep(POLL),
            _ => {
                unsafe { libc::kill(-(child.id() as i32), libc::SIGKILL) };
                let _ = child.wait();
                eprintln!("[path] {shell} -ilc did not answer in {LOGIN_TIMEOUT:?}");
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

    /// A folder holding an `opencode` that prints `line` and nothing else.
    fn opencode_folder(line: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("crew-shell-path-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).expect("folder");
        crate::fakes::install(&dir, "opencode", &format!("#!/bin/sh\necho '{line}'\n"));
        dir
    }

    #[test]
    fn the_2x_opencode_is_chosen_whichever_folder_comes_first() {
        let old = opencode_folder("1.18.35");
        let new = opencode_folder("opencode v2.0.26");
        let want = new.join("opencode");
        assert_eq!(opencode_in(&[old.clone(), new.clone()]), Ok(want.clone()));
        assert_eq!(opencode_in(&[new, old]), Ok(want));
    }

    #[test]
    fn with_only_1x_the_error_names_the_version_found_and_the_install_command() {
        let old = opencode_folder("1.18.35");
        let err = opencode_in(std::slice::from_ref(&old)).unwrap_err();
        assert_eq!(err, format!("{OPENCODE_INSTALL} (found 1.18.35 at {})", old.join("opencode").display()));
        assert!(err.contains("npm i -g @opencode/cli"), "{err}");
    }

    #[test]
    fn with_no_opencode_the_error_gives_the_install_command() {
        let empty = std::env::temp_dir().join(format!("crew-shell-path-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&empty).expect("folder");
        assert_eq!(opencode_in(&[empty]).unwrap_err(), OPENCODE_INSTALL);
    }

    #[test]
    fn a_version_probe_gives_up_on_a_binary_that_hangs() {
        let dir = std::env::temp_dir().join(format!("crew-shell-path-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).expect("folder");
        let hung = crate::fakes::install(&dir, "opencode", "#!/bin/sh\nsleep 10\n");
        let started = Instant::now();
        assert_eq!(version_line_within(&hung, Duration::from_millis(300)), None);
        assert!(started.elapsed() < Duration::from_secs(5));
    }
}
