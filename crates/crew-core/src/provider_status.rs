//! What this machine's agent CLIs are: where they sit, which version, whether
//! a newer one exists and who they are signed in as. Every daemon answers for
//! its own machine, so a remote's CLIs are reported by the remote.
//!
//! Each lookup runs on its own thread with a timeout, and none of them fails
//! the whole answer: a CLI that hangs, or no network, leaves that field out.

use std::collections::HashMap;
use std::io::Read;
use std::os::unix::process::CommandExt;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::Mutex;
use std::thread;
use std::time::{Duration, Instant};

use crew_protocol::{ProviderAccount, ProviderStatus};
use serde_json::Value;

use crate::shell_path;

const LOOKUP_TIMEOUT: Duration = Duration::from_secs(5);
/// cursor-agent's `about` and `status` measured 7 to 24 seconds.
const CURSOR_TIMEOUT: Duration = Duration::from_secs(30);
/// `grok models` and `grok update --check` measured under a second; a cold
/// catalog fetch can take longer.
const GROK_TIMEOUT: Duration = Duration::from_secs(15);
const POLL: Duration = Duration::from_millis(20);
/// The newest release changes rarely, and asking costs a network round trip.
const LATEST_TTL: Duration = Duration::from_secs(60 * 60);
/// Short enough that a sign-in shows soon; long enough for a page that polls.
const ACCOUNT_TTL: Duration = Duration::from_secs(30);

/// One CLI Crew knows how to drive.
pub(crate) struct Spec {
    pub(crate) id: &'static str,
    pub(crate) binary: &'static str,
    /// The npm package that carries releases; None where the CLI says itself.
    /// opencode's is `@opencode/cli`: `opencode-ai`'s `latest` is still 1.x, which Crew does not run.
    pub(crate) npm: Option<&'static str>,
}

pub(crate) const SPECS: &[Spec] = &[
    Spec { id: "claude", binary: "claude", npm: Some("@anthropic-ai/claude-code") },
    Spec { id: "codex", binary: "codex", npm: Some("@openai/codex") },
    Spec { id: "cursor", binary: "cursor-agent", npm: None },
    Spec { id: "opencode", binary: "opencode", npm: Some("@opencode/cli") },
    Spec { id: "grok", binary: "grok", npm: None },
];

#[derive(Default)]
struct Cached {
    latest: Option<(Instant, Option<String>)>,
    account: Option<(Instant, ProviderAccount)>,
}

static CACHE: Mutex<Option<HashMap<&'static str, Cached>>> = Mutex::new(None);

fn with_cache<R>(id: &'static str, f: impl FnOnce(&mut Cached) -> R) -> R {
    let mut guard = CACHE.lock().unwrap_or_else(|e| e.into_inner());
    f(guard.get_or_insert_with(HashMap::new).entry(id).or_default())
}

/// The CLIs, looked up concurrently. `refresh` skips the caches.
pub fn all(refresh: bool) -> Vec<ProviderStatus> {
    thread::scope(|scope| {
        let handles: Vec<_> = SPECS.iter().map(|spec| scope.spawn(move || one(spec, refresh))).collect();
        handles.into_iter().zip(SPECS).map(|(handle, spec)| handle.join().unwrap_or_else(|_| bare(spec))).collect()
    })
}

/// Forgets the cached latest versions and accounts, so the next lookup asks the
/// CLIs again: after a job changed what is installed or who is signed in.
pub fn invalidate() {
    let mut guard = CACHE.lock().unwrap_or_else(|e| e.into_inner());
    *guard = None;
}

fn bare(spec: &Spec) -> ProviderStatus {
    ProviderStatus { id: spec.id.into(), binary: spec.binary.into(), ..Default::default() }
}

fn one(spec: &Spec, refresh: bool) -> ProviderStatus {
    let mut status = bare(spec);
    match resolve(spec) {
        Ok(Some(path)) => {
            status.installed = true;
            status.path = Some(path.to_string_lossy().into_owned());
            status.methods = crate::provider_job::available_methods(spec.id);
            fill(spec, &path, refresh, &mut status);
        }
        Ok(None) => {}
        Err(why) => status.note = Some(why),
    }
    status
}

/// Ok(None) is "not there"; Err is "there, but not one Crew runs".
fn resolve(spec: &Spec) -> Result<Option<PathBuf>, String> {
    // A dev build can be told some CLIs are missing; see `AgentHost::installed`.
    if cfg!(debug_assertions) {
        let missing = std::env::var("CREW_MISSING_PROVIDERS").unwrap_or_default();
        if missing.split(',').any(|gone| gone.trim() == spec.binary) {
            return Ok(None);
        }
    }
    if spec.binary == "opencode" {
        return shell_path::resolve_opencode().map(Some).or_else(|why| {
            // Nothing at all is plain "not installed"; a 1.x install gets the note.
            if why.contains("(found ") {
                Err(why)
            } else {
                Ok(None)
            }
        });
    }
    Ok(shell_path::resolve(spec.binary))
}

fn fill(spec: &Spec, path: &Path, refresh: bool, status: &mut ProviderStatus) {
    let cached_latest = with_cache(spec.id, |c| match (&c.latest, refresh) {
        (Some((at, latest)), false) if at.elapsed() < LATEST_TTL => Some(latest.clone()),
        _ => None,
    });
    let cached_account = with_cache(spec.id, |c| match (&c.account, refresh) {
        (Some((at, account)), false) if at.elapsed() < ACCOUNT_TTL => Some(account.clone()),
        _ => None,
    });
    // Cursor reports its newest release and plan in one call. Grok's updater
    // says whether a newer build exists (`grok update --check --json`).
    let cursor = spec.id == "cursor";
    let want_about = cursor && (cached_latest.is_none() || cached_account.is_none());
    let want_grok_latest = spec.id == "grok" && cached_latest.is_none();

    let (version, npm, about, grok_latest, account) = thread::scope(|scope| {
        let version = scope.spawn(|| run(path, &["--version"], LOOKUP_TIMEOUT).and_then(|out| parse_version(&out)));
        let about = want_about.then(|| scope.spawn(|| run(path, &["about", "--format", "json"], CURSOR_TIMEOUT)));
        let grok_latest = want_grok_latest.then(|| {
            scope.spawn(|| run(path, &["update", "--check", "--json"], GROK_TIMEOUT).and_then(|out| parse_grok_update(&out)))
        });
        let npm = match (&cached_latest, spec.npm) {
            (None, Some(pkg)) => Some(scope.spawn(move || npm_latest(pkg))),
            _ => None,
        };
        // The account lookup runs here while the others run on their threads.
        let account = match &cached_account {
            Some(account) => Some(account.clone()),
            None => account_of(spec.id, path),
        };
        (
            version.join().ok().flatten(),
            npm.and_then(|handle| handle.join().ok().flatten()),
            about.and_then(|handle| handle.join().ok().flatten()).as_deref().map(parse_cursor_about),
            grok_latest.and_then(|handle| handle.join().ok().flatten()),
            account,
        )
    });

    let latest = match cached_latest {
        Some(latest) => latest,
        None => {
            let latest = npm.or_else(|| about.as_ref().and_then(|(latest, _)| latest.clone())).or(grok_latest);
            // Offline leaves it unknown; cache that too, so a page that polls does not ask every time.
            // A lookup that timed out or failed is not an answer, though: ask again next time.
            let failed = (want_about && about.is_none()) || (want_grok_latest && latest.is_none());
            if latest.is_some() || !failed {
                with_cache(spec.id, |c| c.latest = Some((Instant::now(), latest.clone())));
            }
            latest
        }
    };
    let mut account = account;
    if let (Some(account), Some((_, Some(plan)))) = (account.as_mut(), &about) {
        account.plan.get_or_insert_with(|| plan.clone());
    }
    if cached_account.is_none() {
        if let Some(account) = &account {
            with_cache(spec.id, |c| c.account = Some((Instant::now(), account.clone())));
        }
    }
    status.update_available = match (&version, &latest) {
        (Some(version), Some(latest)) => is_newer(latest, version),
        _ => false,
    };
    status.version = version;
    status.latest = latest;
    status.account = account;
}

fn account_of(id: &str, path: &Path) -> Option<ProviderAccount> {
    Some(match id {
        "claude" => parse_claude_auth(&run(path, &["auth", "status"], LOOKUP_TIMEOUT)?),
        // The app-server knows the email and plan; its sentence only says whether.
        "codex" => match crate::usage::codex::read_account(&path.to_string_lossy()) {
            Some(result) => parse_codex_account(&result),
            None => parse_codex_login(&run(path, &["login", "status"], LOOKUP_TIMEOUT)?),
        },
        "cursor" => parse_cursor_status(&run(path, &["status", "--format", "json"], CURSOR_TIMEOUT)?),
        "opencode" => parse_opencode_auth(&run(path, &["auth", "list"], LOOKUP_TIMEOUT)?),
        // `grok models` exits 0 signed in or out, so the line is the signal.
        // A key in the environment is a login of its own; the value stays put.
        "grok" => {
            if api_key_present(std::env::var("XAI_API_KEY").ok().as_deref()) {
                ProviderAccount { signed_in: Some(true), ..Default::default() }
            } else {
                parse_grok_login(&run(path, &["models"], GROK_TIMEOUT)?)
            }
        }
        _ => return None,
    })
}

fn npm_latest(package: &str) -> Option<String> {
    // The e2e harness must never reach the network.
    if std::env::var_os("CREW_SANDBOX").is_some_and(|value| !value.is_empty()) {
        return None;
    }
    let url = format!("https://registry.npmjs.org/{package}/latest");
    let out = run(Path::new("curl"), &["-fsS", "-m", "5", "-H", "accept: application/json", &url], LOOKUP_TIMEOUT)?;
    parse_npm_latest(&out)
}

/// stdout of `path args`, or stderr when stdout is empty (some CLIs print
/// their status there). The exit code is ignored: a signed-out CLI says so and
/// exits 1. None when it does not start or does not answer in time.
fn run(path: &Path, args: &[&str], timeout: Duration) -> Option<String> {
    let mut command = Command::new(path);
    command
        .args(args)
        .env("PATH", shell_path::joined())
        .env("NO_COLOR", "1")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .process_group(0);
    if path.file_name().and_then(|name| name.to_str()) == Some("grok") {
        command.envs(crate::providers::grok::isolation_env());
    }
    let mut child = command.spawn().ok()?;
    fn drain(mut pipe: impl Read + Send + 'static) -> thread::JoinHandle<String> {
        thread::spawn(move || {
            let mut text = String::new();
            let _ = pipe.read_to_string(&mut text);
            text
        })
    }
    let stdout = drain(child.stdout.take()?);
    let stderr = drain(child.stderr.take()?);
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
    let out = stdout.join().unwrap_or_default();
    let err = stderr.join().unwrap_or_default();
    let text = if out.trim().is_empty() { err } else { out };
    Some(text).filter(|text| !text.trim().is_empty())
}

/// `2.1.299 (Claude Code)`, `codex-cli 0.160.0`, `opencode v2.0.27`,
/// `2026.10.01-14929f9` and `grok 1.0.62 (hash) [stable]` all answer with the
/// number they carry.
pub fn parse_version(text: &str) -> Option<String> {
    let line = text.lines().map(str::trim).find(|line| !line.is_empty())?;
    let re = regex::Regex::new(r"\d+(?:\.\d+)+(?:-[0-9A-Za-z.]+)?").ok()?;
    Some(re.find(line).map_or_else(|| line.to_string(), |found| found.as_str().to_string()))
}

pub fn parse_npm_latest(json: &str) -> Option<String> {
    let value: Value = serde_json::from_str(json).ok()?;
    value.get("version")?.as_str().map(str::to_string).filter(|v| !v.is_empty())
}

/// Whether `latest` is a later release than `version`, by the numbers before
/// any `-` suffix (Cursor's `2026.10.19-6bbf2c4` has a hash there). Unreadable
/// versions are never reported as updates.
pub fn is_newer(latest: &str, version: &str) -> bool {
    fn numbers(text: &str) -> Option<Vec<u64>> {
        let head = text.trim().trim_start_matches('v').split(['-', '+']).next()?;
        head.split('.').map(|part| part.parse().ok()).collect()
    }
    match (numbers(latest), numbers(version)) {
        (Some(latest), Some(version)) if !latest.is_empty() && !version.is_empty() => latest > version,
        _ => false,
    }
}

pub fn parse_claude_auth(json: &str) -> ProviderAccount {
    let Ok(value) = serde_json::from_str::<Value>(json) else { return ProviderAccount::default() };
    ProviderAccount {
        signed_in: value.get("loggedIn").and_then(Value::as_bool),
        email: string(&value, "email"),
        plan: string(&value, "subscriptionType"),
    }
}

/// An `account/read` result: `{ account: { type, email, planType } | null, requiresOpenaiAuth }`.
/// No account while sign-in is required is signed out; an API key has no email or plan.
pub fn parse_codex_account(result: &Value) -> ProviderAccount {
    match result.get("account") {
        Some(account) if account.is_object() => {
            ProviderAccount { signed_in: Some(true), email: string(account, "email"), plan: string(account, "planType") }
        }
        Some(Value::Null) if result.get("requiresOpenaiAuth").and_then(Value::as_bool) != Some(false) => {
            ProviderAccount { signed_in: Some(false), ..Default::default() }
        }
        // Signed out, but Codex does not need OpenAI (a custom provider): nothing to say.
        _ => ProviderAccount::default(),
    }
}

/// `Logged in using ChatGPT`, `Logged in using an API key`, `Not logged in`.
pub fn parse_codex_login(text: &str) -> ProviderAccount {
    let line = text.lines().map(str::trim).find(|line| !line.is_empty()).unwrap_or("");
    let lower = line.to_lowercase();
    if lower.contains("not logged in") {
        return ProviderAccount { signed_in: Some(false), ..Default::default() };
    }
    if !lower.contains("logged in") {
        return ProviderAccount::default();
    }
    // It only says how the login was made (ChatGPT, an API key), not the plan.
    ProviderAccount { signed_in: Some(true), email: None, plan: None }
}

pub fn parse_cursor_status(json: &str) -> ProviderAccount {
    let Ok(value) = serde_json::from_str::<Value>(json) else { return ProviderAccount::default() };
    let signed_in = value
        .get("isAuthenticated")
        .and_then(Value::as_bool)
        .or_else(|| value.get("status").and_then(Value::as_str).map(|status| status == "authenticated"));
    let email = value.get("userInfo").and_then(|user| string(user, "email")).or_else(|| string(&value, "email"));
    ProviderAccount { signed_in, email, plan: None }
}

/// The newest release and the plan, from `cursor-agent about --format json`.
pub fn parse_cursor_about(json: &str) -> (Option<String>, Option<String>) {
    let Ok(value) = serde_json::from_str::<Value>(json) else { return (None, None) };
    (string(&value, "latestVersion"), string(&value, "subscriptionTier"))
}

/// `You are logged in with grok.com.` or `You are not authenticated.` The line
/// says whether, not who: no address and no token comes out of it. A non-zero
/// `grok models` never reaches here.
pub fn parse_grok_login(text: &str) -> ProviderAccount {
    let lower = text.to_lowercase();
    if lower.contains("not authenticated") || lower.contains("not logged in") {
        return ProviderAccount { signed_in: Some(false), ..Default::default() };
    }
    if lower.contains("logged in") {
        return ProviderAccount { signed_in: Some(true), ..Default::default() };
    }
    ProviderAccount::default()
}

fn api_key_present(key: Option<&str>) -> bool {
    key.is_some_and(|key| !key.trim().is_empty())
}

/// `latestVersion` from `grok update --check --json`. Unpinned: whatever the CLI calls latest.
pub fn parse_grok_update(json: &str) -> Option<String> {
    let value: Value = serde_json::from_str(json).ok()?;
    value.get("latestVersion")?.as_str().map(str::to_string).filter(|version| !version.is_empty())
}

/// One row per stored credential (`OpenAI  OAuth  stored`), or a count line;
/// no row at all is signed out. Anything that is not rows says nothing.
pub fn parse_opencode_auth(text: &str) -> ProviderAccount {
    let plain = strip_ansi(text);
    let rows = plain
        .lines()
        .map(|line| line.trim_matches(|c: char| c.is_whitespace() || "│┌└├─◇●".contains(c)))
        .filter(|line| !line.is_empty())
        .filter(|line| !line.to_lowercase().contains("credentials") && !line.to_lowercase().contains("environment"))
        .count();
    let lower = plain.to_lowercase();
    if rows > 0 && !lower.contains("error") {
        return ProviderAccount { signed_in: Some(true), ..Default::default() };
    }
    if lower.contains("0 credentials") || lower.contains("no credentials") || rows == 0 && !lower.trim().is_empty() {
        return ProviderAccount { signed_in: Some(false), ..Default::default() };
    }
    ProviderAccount::default()
}

pub(crate) fn strip_ansi(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut chars = text.chars().peekable();
    while let Some(c) = chars.next() {
        if c == '\u{1b}' {
            if chars.peek() == Some(&'[') {
                chars.next();
                for end in chars.by_ref() {
                    if end.is_ascii_alphabetic() {
                        break;
                    }
                }
            }
        } else {
            out.push(c);
        }
    }
    out
}

fn string(value: &Value, key: &str) -> Option<String> {
    value.get(key)?.as_str().map(str::to_string).filter(|text| !text.is_empty())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn versions_are_the_number_each_cli_prints() {
        assert_eq!(parse_version("2.1.299 (Claude Code)\n").as_deref(), Some("2.1.299"));
        assert_eq!(parse_version("codex-cli 0.160.0").as_deref(), Some("0.160.0"));
        assert_eq!(parse_version("opencode v2.0.27").as_deref(), Some("2.0.27"));
        assert_eq!(parse_version("2026.10.01-14929f9").as_deref(), Some("2026.10.01-14929f9"));
        assert_eq!(parse_version("grok 1.0.62 (1474f9cbdd91) [stable]\n").as_deref(), Some("1.0.62"));
        assert_eq!(parse_version("dev build").as_deref(), Some("dev build"));
        assert_eq!(parse_version("  \n"), None);
    }

    #[test]
    fn npm_latest_reads_the_version_field() {
        assert_eq!(parse_npm_latest(r#"{"name":"@openai/codex","version":"0.161.0"}"#).as_deref(), Some("0.161.0"));
        assert_eq!(parse_npm_latest("not json"), None);
        assert_eq!(parse_npm_latest(r#"{"version":""}"#), None);
    }

    #[test]
    fn newer_compares_numbers_not_text() {
        assert!(is_newer("2.1.300", "2.1.299"));
        assert!(is_newer("0.161.0", "0.160.0"));
        assert!(is_newer("2.10.0", "2.9.9"));
        assert!(!is_newer("2.1.299", "2.1.299"));
        assert!(!is_newer("2.1.298", "2.1.299"));
        assert!(is_newer("2026.10.19-6bbf2c4", "2026.10.01-14929f9"));
        assert!(!is_newer("2026.10.01-aaaaaaa", "2026.10.01-14929f9"));
        assert!(!is_newer("dev build", "2.0.0"));
    }

    #[test]
    fn claude_auth_reads_login_email_and_plan() {
        let signed = r#"{"loggedIn":true,"authMethod":"claude.ai","email":"a@b.c","subscriptionType":"max"}"#;
        assert_eq!(
            parse_claude_auth(signed),
            ProviderAccount { signed_in: Some(true), email: Some("a@b.c".into()), plan: Some("max".into()) }
        );
        assert_eq!(parse_claude_auth(r#"{"loggedIn":false}"#).signed_in, Some(false));
        assert_eq!(parse_claude_auth("garbage"), ProviderAccount::default());
    }

    #[test]
    fn codex_account_gives_email_and_plan() {
        let chatgpt = json!({"account":{"type":"chatgpt","email":"a@b.dev","planType":"plus"},"requiresOpenaiAuth":true});
        assert_eq!(
            parse_codex_account(&chatgpt),
            ProviderAccount { signed_in: Some(true), email: Some("a@b.dev".into()), plan: Some("plus".into()) }
        );
        let key = json!({"account":{"type":"apiKey"},"requiresOpenaiAuth":true});
        assert_eq!(parse_codex_account(&key), ProviderAccount { signed_in: Some(true), email: None, plan: None });
        let out = json!({"account":null,"requiresOpenaiAuth":true});
        assert_eq!(parse_codex_account(&out).signed_in, Some(false));
        assert_eq!(parse_codex_account(&json!({"account":null,"requiresOpenaiAuth":false})).signed_in, None);
        assert_eq!(parse_codex_account(&json!({})).signed_in, None);
    }

    #[test]
    fn codex_login_reads_the_sentence() {
        let chatgpt = parse_codex_login("Logged in using ChatGPT\n");
        assert_eq!((chatgpt.signed_in, chatgpt.plan.as_deref()), (Some(true), None));
        let key = parse_codex_login("Logged in using an API key - sk-***\n");
        assert_eq!((key.signed_in, key.plan.as_deref()), (Some(true), None));
        assert_eq!(parse_codex_login("Not logged in").signed_in, Some(false));
        assert_eq!(parse_codex_login("something else").signed_in, None);
        assert_eq!(parse_codex_login("").signed_in, None);
    }

    #[test]
    fn cursor_status_and_about_read_their_json() {
        let status = r#"{"status":"authenticated","isAuthenticated":true,"userInfo":{"email":"a@b.c","userId":1}}"#;
        assert_eq!(
            parse_cursor_status(status),
            ProviderAccount { signed_in: Some(true), email: Some("a@b.c".into()), plan: None }
        );
        assert_eq!(parse_cursor_status(r#"{"isAuthenticated":false}"#).signed_in, Some(false));
        assert_eq!(parse_cursor_status(r#"{"status":"authenticated"}"#).signed_in, Some(true));
        assert_eq!(parse_cursor_status("Not logged in").signed_in, None);
        let about = r#"{"cliVersion":"2026.10.01-14929f9","latestVersion":"2026.10.19-6bbf2c4","subscriptionTier":"Free"}"#;
        assert_eq!(parse_cursor_about(about), (Some("2026.10.19-6bbf2c4".into()), Some("Free".into())));
        assert_eq!(parse_cursor_about("nope"), (None, None));
    }

    #[test]
    fn grok_login_reads_the_models_line_and_the_updater_says_what_is_current() {
        let signed = parse_grok_login(include_str!("../tests/fixtures/grok/models-text.txt"));
        assert_eq!((signed.signed_in, signed.email.as_deref(), signed.plan.as_deref()), (Some(true), None, None));
        let out = parse_grok_login(include_str!("../tests/fixtures/grok/models-signed-out.txt"));
        assert_eq!(out.signed_in, Some(false));
        assert_eq!(parse_grok_login("something else").signed_in, None);
        let check = r#"{"currentVersion":"1.0.62","latestVersion":"1.0.63","updateAvailable":true,"installer":"internal","channel":"stable","autoUpdate":true,"error":null}"#;
        assert_eq!(parse_grok_update(check).as_deref(), Some("1.0.63"));
        assert_eq!(parse_grok_update(r#"{"latestVersion":""}"#), None);
        assert_eq!(parse_grok_update("not json"), None);
        assert!(api_key_present(Some("present")));
        assert!(!api_key_present(Some("  ")));
        assert!(!api_key_present(None));
    }

    #[test]
    fn opencode_auth_counts_stored_credentials() {
        assert_eq!(parse_opencode_auth("OpenAI  OAuth                       stored\n").signed_in, Some(true));
        let framed = "\u{1b}[0m┌  Credentials ~/.local/share/opencode/auth.json\n│\n●  OpenAI \u{1b}[90moauth\u{1b}[0m\n│\n└  1 credentials\n";
        assert_eq!(parse_opencode_auth(framed).signed_in, Some(true));
        let none = "┌  Credentials ~/.local/share/opencode/auth.json\n│\n└  0 credentials\n";
        assert_eq!(parse_opencode_auth(none).signed_in, Some(false));
        assert_eq!(parse_opencode_auth("").signed_in, None);
    }

    #[test]
    fn a_lookup_reads_stdout_and_falls_back_to_stderr() {
        let dir = std::env::temp_dir().join(format!("crew-provider-status-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).expect("folder");
        let quick = crate::fakes::install(&dir, "quick", "#!/bin/sh\necho \"codex-cli 9.9.9\"\n");
        assert_eq!(run(&quick, &["--version"], LOOKUP_TIMEOUT).and_then(|out| parse_version(&out)).as_deref(), Some("9.9.9"));
        let quiet = crate::fakes::install(&dir, "quiet", "#!/bin/sh\necho 'Not logged in' >&2\nexit 1\n");
        assert_eq!(
            parse_codex_login(&run(&quiet, &["login", "status"], LOOKUP_TIMEOUT).unwrap_or_default()).signed_in,
            Some(false)
        );
    }
}
