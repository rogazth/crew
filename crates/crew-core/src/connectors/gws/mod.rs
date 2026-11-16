//! Google's apps' tools, run with `gws` (googleworkspace/cli) and an access
//! token (plan `2026-10-28-google-and-figma.md`).
//!
//! - **Pinned.** `gws` is 0.x and "not an officially supported Google
//!   product", and it holds the token while it runs, so Crew runs one version,
//!   downloaded once into the vault's data folder and checked against its
//!   sha256 here. A Crew release bumps it. `CREW_GWS` names another binary,
//!   for tests and a dev build.
//! - **Shut in.** Each call runs in a folder of its own, with an environment
//!   that holds the token (`GOOGLE_WORKSPACE_CLI_TOKEN`) and nothing of the
//!   person's: no HOME to find gcloud's credentials or a quota project in, no
//!   `.env` above it. Files it writes (`--output`) and reads (`--upload`)
//!   must be inside that folder, as `gws` asks.
//! - **A tool is a short entry**: what it takes, and the `gws` calls it
//!   makes. Answers are trimmed to what a model reads (a thread's text, not
//!   its MIME parts).
//! - **Many at once.** A tool that works on messages or files takes a list of
//!   ids and answers which went through; files cross as base64, and Crew
//!   reads `path` and writes `save_to` in the session's folder (`files.rs`).

use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::time::Duration;

use base64::engine::general_purpose::URL_SAFE;
use base64::Engine as _;
use serde_json::{json, Map, Value};
use sha2::{Digest, Sha256};

use super::google::App;

mod calendar;
mod docs;
mod drive;
mod gmail;
#[cfg(test)]
mod live;
mod mime;
mod sheets;

/// The `gws` Crew runs, and each platform's archive with its sha256.
pub const VERSION: &str = "0.22.5";
const ASSETS: &[(&str, &str, &str, &str)] = &[
    (
        "macos",
        "aarch64",
        "google-workspace-cli-aarch64-apple-darwin.tar.gz",
        "1d2a9ffd5bc9b2c2c4b48630daf082fad13d9e57d741988a2c248eed562f7dac",
    ),
    (
        "macos",
        "x86_64",
        "google-workspace-cli-x86_64-apple-darwin.tar.gz",
        "51f9bd731404d4bba26c36e2e30dd68c56dccd1f834c01252cb0b14d6a6544b2",
    ),
    (
        "linux",
        "x86_64",
        "google-workspace-cli-x86_64-unknown-linux-gnu.tar.gz",
        "de78ecdbd2f1a84cca0063a7ecbc440240fc14b6ebccbb17f4646b792a8c5c1f",
    ),
    (
        "linux",
        "aarch64",
        "google-workspace-cli-aarch64-unknown-linux-gnu.tar.gz",
        "94490295d9580e1e88574e715a0a162991747d12d62f8c7b8dcc8268b6c1cea0",
    ),
];

/// One call may take this long: `gws` has a connect timeout but none overall.
const CALL_TIMEOUT: Duration = Duration::from_secs(120);
/// The most of a file's text a tool hands back.
const MAX_TEXT: usize = 200_000;

/// Which `gws` to run.
#[derive(Clone, Debug, Default)]
pub struct Gws {
    /// A binary to run as it is (`CREW_GWS`, a test's fake).
    path: Option<PathBuf>,
    /// Where the pinned one is kept, downloaded on first use.
    dir: Option<PathBuf>,
}

impl Gws {
    /// The pinned `gws`, kept in `dir`; `CREW_GWS` wins when it is set.
    pub fn kept_in(dir: PathBuf) -> Self {
        Gws { path: from_env(), dir: Some(dir) }
    }

    /// A binary to run as it is.
    pub fn at(path: PathBuf) -> Self {
        Gws { path: Some(path), dir: None }
    }

    /// The binary, downloaded and checked first when it is not there yet.
    async fn binary(&self) -> Result<PathBuf, GwsError> {
        if let Some(path) = self.path.clone().or_else(from_env) {
            return Ok(path);
        }
        let dir = self.dir.clone().ok_or_else(|| GwsError::Setup("Crew has no place to keep gws".into()))?;
        let bin = dir.join(format!("gws-{VERSION}")).join("gws");
        if bin.is_file() {
            return Ok(bin);
        }
        static FETCHING: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());
        let _one = FETCHING.lock().await;
        if bin.is_file() {
            return Ok(bin);
        }
        let to = bin.clone();
        tokio::task::spawn_blocking(move || fetch(&dir, &to)).await.map_err(|e| GwsError::Setup(e.to_string()))??;
        Ok(bin)
    }

    /// Where `gws` keeps the API descriptions it fetches: kept, so a call
    /// doesn't fetch them again; nothing of an account's goes there.
    fn config_dir(&self) -> PathBuf {
        match &self.dir {
            Some(dir) => dir.join("gws-config"),
            None => std::env::temp_dir().join("crew-gws-config"),
        }
    }
}

fn from_env() -> Option<PathBuf> {
    std::env::var_os("CREW_GWS").filter(|p| !p.is_empty()).map(PathBuf::from)
}

/// Downloads this platform's archive, checks it and unpacks `gws` to `bin`.
fn fetch(dir: &Path, bin: &Path) -> Result<(), GwsError> {
    let setup = |m: String| GwsError::Setup(m);
    let (_, _, asset, sha) = ASSETS
        .iter()
        .find(|(os, arch, _, _)| *os == std::env::consts::OS && *arch == std::env::consts::ARCH)
        .ok_or_else(|| setup(format!("Google's apps don't run on {} {} yet", std::env::consts::OS, std::env::consts::ARCH)))?;
    if std::env::var_os("CREW_SANDBOX").is_some_and(|v| !v.is_empty()) {
        return Err(setup("gws is not downloaded in the sandbox".into()));
    }
    let work = dir.join(format!(".gws-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&work).map_err(|e| setup(e.to_string()))?;
    let result = (|| {
        let archive = work.join(asset);
        let url = format!("https://github.com/googleworkspace/cli/releases/download/v{VERSION}/{asset}");
        let ok = std::process::Command::new("curl")
            .args(["-fsSL", "-m", "120", "-o"])
            .arg(&archive)
            .arg(&url)
            .status()
            .is_ok_and(|s| s.success());
        if !ok {
            return Err(setup(format!("Couldn't download gws {VERSION}")));
        }
        let bytes = std::fs::read(&archive).map_err(|e| setup(e.to_string()))?;
        let got = Sha256::digest(&bytes).iter().map(|b| format!("{b:02x}")).collect::<String>();
        if got != *sha {
            return Err(setup(format!("gws {VERSION} didn't match its checksum; it was not used")));
        }
        // The whole archive: its entries are `./gws` and the like, which GNU
        // tar doesn't match to a member named `gws` (bsdtar does).
        let ok =
            std::process::Command::new("tar").arg("-xzf").arg(&archive).arg("-C").arg(&work).status().is_ok_and(|s| s.success());
        if !ok || !work.join("gws").is_file() {
            return Err(setup(format!("Couldn't unpack gws {VERSION}")));
        }
        let parent = bin.parent().ok_or_else(|| setup("gws has no folder".into()))?;
        std::fs::create_dir_all(parent).map_err(|e| setup(e.to_string()))?;
        std::fs::rename(work.join("gws"), bin).map_err(|e| setup(e.to_string()))
    })();
    let _ = std::fs::remove_dir_all(&work);
    result
}

/* ── Running it ───────────────────────────────────────────────────────── */

#[derive(Debug, PartialEq, Eq)]
pub enum GwsError {
    /// Google refused the token: refresh it and try once more.
    Unauthorized,
    /// Google said no to this call (a permission, a scope): an answer for the model.
    Forbidden(String),
    /// The call failed: an answer for the model.
    Call(String),
    /// `gws` itself can't run: the account shows it.
    Setup(String),
}

/// One call's run: its own folder, the token, nothing of the person's.
struct Run<'a> {
    bin: PathBuf,
    config: PathBuf,
    folder: PathBuf,
    token: &'a str,
}

impl Run<'_> {
    /// `gws <args>`, answered as JSON.
    async fn json(&self, args: &[&str]) -> Result<Value, GwsError> {
        let out = self.raw(args).await?;
        if out.is_empty() {
            return Ok(Value::Null);
        }
        serde_json::from_slice(&out).map_err(|_| GwsError::Call("Google's answer was not JSON".into()))
    }

    async fn raw(&self, args: &[&str]) -> Result<Vec<u8>, GwsError> {
        let mut cmd = tokio::process::Command::new(&self.bin);
        cmd.args(args)
            .current_dir(&self.folder)
            .env_clear()
            .env("PATH", "/usr/bin:/bin")
            .env("HOME", &self.folder)
            .env("GOOGLE_WORKSPACE_CLI_TOKEN", self.token)
            .env("GOOGLE_WORKSPACE_CLI_CONFIG_DIR", &self.config)
            .env("GOOGLE_APPLICATION_CREDENTIALS", "/dev/null")
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .kill_on_drop(true);
        let child = cmd.spawn().map_err(|e| GwsError::Setup(format!("Couldn't run gws: {e}")))?;
        let out = tokio::time::timeout(CALL_TIMEOUT, child.wait_with_output())
            .await
            .map_err(|_| GwsError::Call("Google took too long to answer".into()))?
            .map_err(|e| GwsError::Setup(format!("gws stopped: {e}")))?;
        if out.status.success() {
            return Ok(out.stdout);
        }
        Err(error_of(out.status.code(), &out.stdout, &out.stderr))
    }

    fn file(&self, name: &str) -> PathBuf {
        self.folder.join(name)
    }
}

/// What a failed run means: `gws` prints Google's error as JSON on stdout,
/// and a line on stderr.
fn error_of(code: Option<i32>, stdout: &[u8], stderr: &[u8]) -> GwsError {
    let answer: Value = serde_json::from_slice(stdout).unwrap_or(Value::Null);
    let status = answer["error"]["code"].as_i64();
    let message = answer["error"]["message"]
        .as_str()
        .map(str::to_string)
        .or_else(|| String::from_utf8_lossy(stderr).lines().map(str::trim).find(|l| !l.is_empty()).map(str::to_string))
        .unwrap_or_else(|| "gws failed".into());
    let message = super::net::shorten(&message, 400);
    match (status, code) {
        (Some(401), _) | (None, Some(2)) => GwsError::Unauthorized,
        (Some(403), _) => GwsError::Forbidden(format!("Google refused: {message}")),
        (_, Some(4)) => GwsError::Call(format!("Couldn't reach Google's API description: {message}")),
        _ => GwsError::Call(message),
    }
}

/// Whether `gws` can run here: downloaded and checked first when it is not
/// there yet. An account's "Try now" asks, so a failed setup is tried again.
pub async fn ready(gws: &Gws) -> Result<(), GwsError> {
    gws.binary().await.map(|_| ())
}

/// Runs a tool of `app` for a session, with `token`. Its answer is MCP's.
pub async fn call(gws: &Gws, app: App, name: &str, args: &Value, token: &str) -> Result<Value, GwsError> {
    let tool = tools(app)
        .iter()
        .find(|t| t.name == name)
        .ok_or_else(|| GwsError::Call(format!("{name} is not a tool of {}", app.name())))?;
    let bin = gws.binary().await?;
    let config = gws.config_dir();
    let folder = std::env::temp_dir().join(format!("crew-gws-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&folder).map_err(|e| GwsError::Setup(e.to_string()))?;
    std::fs::create_dir_all(&config).map_err(|e| GwsError::Setup(e.to_string()))?;
    let run = Run { bin, config, folder: folder.clone(), token };
    let args = args.as_object().cloned().unwrap_or_default();
    let result = run_tool(&run, app, tool.name, &args).await;
    let _ = std::fs::remove_dir_all(&folder);
    result.map(|answer| {
        let text = match answer {
            Value::String(text) => text,
            other => other.to_string(),
        };
        json!({ "content": [{ "type": "text", "text": text }] })
    })
}

/* ── The tools ────────────────────────────────────────────────────────── */

pub struct Tool {
    pub name: &'static str,
    pub title: &'static str,
    pub description: &'static str,
    pub read_only: bool,
    /// Sends, shares or deletes: off until the person turns it on.
    pub destructive: bool,
    pub schema: fn() -> Value,
}

const fn tool(
    name: &'static str,
    title: &'static str,
    description: &'static str,
    read_only: bool,
    destructive: bool,
    schema: fn() -> Value,
) -> Tool {
    Tool { name, title, description, read_only, destructive, schema }
}

/// An object schema: its properties and which are required.
fn object(properties: Value, required: &[&str]) -> Value {
    json!({ "type": "object", "properties": properties, "required": required, "additionalProperties": false })
}

pub fn tools(app: App) -> &'static [Tool] {
    match app {
        App::Gmail => gmail::TOOLS,
        App::Drive => drive::TOOLS,
        App::Calendar => calendar::TOOLS,
        App::Docs => docs::TOOLS,
        App::Sheets => sheets::TOOLS,
    }
}

async fn run_tool(run: &Run<'_>, app: App, name: &str, args: &Args) -> Result<Value, GwsError> {
    match app {
        App::Gmail => gmail::run(run, name, args).await,
        App::Drive => drive::run(run, name, args).await,
        App::Calendar => calendar::run(run, name, args).await,
        App::Docs => docs::run(run, name, args).await,
        App::Sheets => sheets::run(run, name, args).await,
    }
}

/* ── What the tools share ─────────────────────────────────────────────── */

type Args = Map<String, Value>;

/// How many `gws` runs one tool keeps going at once, for a tool that works
/// on many messages or files.
const CONCURRENCY: usize = 8;
/// The most a tool sends or answers as one file's bytes, or as a message's
/// attachments together: Gmail's own limit.
const MAX_FILE: usize = 25 << 20;

fn text<'a>(args: &'a Args, key: &str) -> Option<&'a str> {
    args.get(key).and_then(Value::as_str).map(str::trim).filter(|s| !s.is_empty())
}

fn need<'a>(args: &'a Args, key: &str) -> Result<&'a str, GwsError> {
    text(args, key).ok_or_else(|| GwsError::Call(format!("{key} is required")))
}

fn number(args: &Args, key: &str, default: u64, max: u64) -> u64 {
    args.get(key).and_then(Value::as_u64).unwrap_or(default).clamp(1, max)
}

fn flag(args: &Args, key: &str, default: bool) -> bool {
    args.get(key).and_then(Value::as_bool).unwrap_or(default)
}

fn strings(args: &Args, key: &str) -> Vec<String> {
    args.get(key)
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(Value::as_str)
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_string)
        .collect()
}

/// The ids a tool works on: an array under `many`, or one under `one`.
fn ids(args: &Args, many: &str, one: &str) -> Vec<String> {
    let mut ids = strings(args, many);
    if let Some(id) = text(args, one) {
        ids.push(id.to_string());
    }
    ids.dedup();
    ids
}

/// Leaves out what is null, so a param not given isn't sent.
fn params(pairs: Value) -> String {
    let mut map = pairs.as_object().cloned().unwrap_or_default();
    map.retain(|_, v| !v.is_null());
    Value::Object(map).to_string()
}

/// A Drive query with an id quoted inside it.
fn quoted(id: &str) -> String {
    id.replace('\\', "\\\\").replace('\'', "\\'")
}

fn clip_to(text: &str, max: usize) -> String {
    if text.len() <= max {
        return text.to_string();
    }
    let mut end = max;
    while !text.is_char_boundary(end) {
        end -= 1;
    }
    format!("{}\n… (cut at {max} bytes of {})", &text[..end], text.len())
}

/// Bytes a model sent as base64, standard or URL-safe, padded or not.
fn decode64(data: &str) -> Option<Vec<u8>> {
    use base64::engine::general_purpose::{STANDARD, STANDARD_NO_PAD, URL_SAFE_NO_PAD};
    let data: String = data.chars().filter(|c| !c.is_whitespace()).collect();
    STANDARD
        .decode(&data)
        .or_else(|_| STANDARD_NO_PAD.decode(data.trim_end_matches('=')))
        .or_else(|_| URL_SAFE.decode(&data))
        .or_else(|_| URL_SAFE_NO_PAD.decode(data.trim_end_matches('=')))
        .ok()
}

fn encode64(bytes: &[u8]) -> String {
    base64::engine::general_purpose::STANDARD.encode(bytes)
}

/// What a tool that saves a file answers: `content_base64` is written to
/// `save_to` by Crew, in the session's folder, before the model reads it.
fn file_answer(name: &str, mime: &str, bytes: &[u8], save_to: &str) -> Value {
    json!({ "name": name, "mimeType": mime, "size": bytes.len(), "save_to": save_to, "content_base64": encode64(bytes) })
}

/// `f` on each item, `CONCURRENCY` at a time, answered in the items' order.
async fn each<T, R, F, Fut>(items: Vec<T>, f: F) -> Vec<R>
where
    F: Fn(T) -> Fut,
    Fut: std::future::Future<Output = R>,
{
    use futures_util::stream::{self, StreamExt};
    stream::iter(items.into_iter().map(f)).buffered(CONCURRENCY).collect().await
}

/// What a tool that works on many ids answers: how many went through, and
/// why each other one didn't. A refused token or a `gws` that can't run
/// fails the whole call, so the token is refreshed or the account shows it.
fn outcome(results: Vec<(String, Result<(), GwsError>)>) -> Result<Value, GwsError> {
    let mut done = Vec::new();
    let mut failed = Vec::new();
    for (id, result) in results {
        match result {
            Ok(()) => done.push(id),
            Err(GwsError::Unauthorized) => return Err(GwsError::Unauthorized),
            Err(GwsError::Setup(line)) => return Err(GwsError::Setup(line)),
            Err(GwsError::Forbidden(line) | GwsError::Call(line)) => failed.push(json!({ "id": id, "error": line })),
        }
    }
    let mut answer = json!({ "done": done.len() });
    if done.len() <= 50 {
        answer["ids"] = json!(done);
    }
    if !failed.is_empty() {
        answer["failed"] = json!(failed);
    }
    Ok(answer)
}

/// HTML's text, roughly: tags out, a line per block, entities for the common few.
fn strip_html(html: &str) -> String {
    let mut out = String::with_capacity(html.len() / 2);
    let mut in_tag = false;
    let mut tag = String::new();
    let mut skipping = false;
    for c in html.chars() {
        match c {
            '<' => {
                in_tag = true;
                tag.clear();
            }
            '>' if in_tag => {
                in_tag = false;
                let closing = tag.starts_with('/');
                let name = tag
                    .trim_start_matches('/')
                    .split(|c: char| c.is_whitespace() || c == '/')
                    .next()
                    .unwrap_or_default()
                    .to_ascii_lowercase();
                if ["style", "script", "head"].contains(&name.as_str()) {
                    skipping = !closing;
                }
                if ["br", "p", "div", "tr", "li", "h1", "h2", "h3", "h4", "table"].contains(&name.as_str()) {
                    out.push('\n');
                }
            }
            c if in_tag => tag.push(c),
            _ if skipping => {}
            c => out.push(c),
        }
    }
    let out = out
        .replace("&nbsp;", " ")
        .replace("&lt;", "<")
        .replace("&gt;", ">")
        .replace("&quot;", "\"")
        .replace("&#39;", "'")
        .replace("&amp;", "&");
    out.lines().map(str::trim_end).filter(|l| !l.trim().is_empty()).collect::<Vec<_>>().join("\n")
}

fn escape_html(text: &str) -> String {
    text.replace('&', "&amp;").replace('<', "&lt;").replace('>', "&gt;").replace('"', "&quot;")
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::os::unix::fs::PermissionsExt;

    /// A fake `gws` that logs its arguments and environment and answers what the test says.
    pub(super) fn fake(dir: &Path, answer: &str, code: i32) -> Gws {
        let script = dir.join("gws");
        std::fs::write(
            &script,
            format!(
                "#!/bin/sh\nrun=$(printf '%s\\n' \"$@\"; echo ---)\ncat >> \"{log}/args\" <<RUN\n$run\nRUN\nenv > \"{log}/env\"\npwd > \"{log}/pwd\"\ncat <<'EOF'\n{answer}\nEOF\nexit {code}\n",
                log = dir.display()
            ),
        )
        .unwrap();
        std::fs::set_permissions(&script, std::fs::Permissions::from_mode(0o755)).unwrap();
        Gws::at(script)
    }

    pub(super) fn scratch() -> PathBuf {
        let dir = std::env::temp_dir().join(format!("crew-gws-test-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    /// Each run's arguments, as the fake logged them (`cat` writes each run
    /// at once, so runs at the same time don't mix).
    pub(super) fn runs(dir: &Path) -> Vec<Vec<String>> {
        let log = std::fs::read_to_string(dir.join("args")).unwrap_or_default();
        log.split("---\n").filter(|r| !r.trim().is_empty()).map(|r| r.lines().map(str::to_string).collect()).collect()
    }

    #[tokio::test]
    async fn a_tool_runs_gws_with_the_token_and_nothing_of_the_persons() {
        let dir = scratch();
        let gws = fake(&dir, r#"{"messages":[{"id":"m1","threadId":"t1"}]}"#, 0);
        let answer = call(
            &gws,
            App::Gmail,
            "search_emails",
            &json!({ "query": "is:unread", "max_results": 5000, "ids_only": true }),
            "at-1",
        )
        .await
        .unwrap();
        assert!(answer["content"][0]["text"].as_str().unwrap().contains("m1"));
        let run = &runs(&dir)[0];
        assert_eq!(run[..5], ["gmail", "users", "messages", "list", "--params"]);
        let p: Value = serde_json::from_str(&run[5]).unwrap();
        assert_eq!(p, json!({ "userId": "me", "q": "is:unread", "maxResults": 500, "includeSpamTrash": false }));
        let env = std::fs::read_to_string(dir.join("env")).unwrap();
        assert!(env.contains("GOOGLE_WORKSPACE_CLI_TOKEN=at-1"));
        assert!(env.contains("GOOGLE_APPLICATION_CREDENTIALS=/dev/null"));
        let pwd = std::fs::read_to_string(dir.join("pwd")).unwrap();
        let folder = Path::new(pwd.trim()).file_name().unwrap().to_string_lossy().into_owned();
        let home = env.lines().find_map(|l| l.strip_prefix("HOME=")).unwrap();
        assert!(folder.starts_with("crew-gws-") && home.ends_with(&folder), "HOME is the call's own folder");
        assert!(!Path::new(pwd.trim()).exists(), "the call's folder is gone after it");
        let _ = std::fs::remove_dir_all(dir);
    }

    #[tokio::test]
    async fn googles_401_asks_for_a_new_token_and_a_403_is_an_answer() {
        let dir = scratch();
        let gws = fake(
            &dir,
            r#"{"error":{"code":401,"message":"Request had invalid authentication credentials.","reason":"authError"}}"#,
            1,
        );
        assert_eq!(
            call(&gws, App::Drive, "update_file", &json!({ "file_id": "f", "name": "x" }), "x").await,
            Err(GwsError::Unauthorized)
        );
        assert_eq!(call(&gws, App::Drive, "trash_files", &json!({ "file_ids": ["f"] }), "x").await, Err(GwsError::Unauthorized));
        let gws =
            fake(&dir, r#"{"error":{"code":403,"message":"Insufficient Permission","reason":"insufficientPermissions"}}"#, 1);
        assert_eq!(
            call(&gws, App::Drive, "update_file", &json!({ "file_id": "f", "name": "x" }), "x").await,
            Err(GwsError::Forbidden("Google refused: Insufficient Permission".into()))
        );
        let many = call(&gws, App::Drive, "trash_files", &json!({ "file_ids": ["a", "b"] }), "x").await.unwrap();
        let many: Value = serde_json::from_str(many["content"][0]["text"].as_str().unwrap()).unwrap();
        assert_eq!(many["done"], 0);
        assert_eq!(many["failed"][1], json!({ "id": "b", "error": "Google refused: Insufficient Permission" }));
        assert!(matches!(call(&gws, App::Drive, "nope", &json!({}), "x").await, Err(GwsError::Call(_))));
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn html_reads_as_text_and_base64_is_read_either_way() {
        assert_eq!(strip_html("<style>p{}</style><p>Hi&nbsp;there</p><br>Bye &amp; thanks"), "Hi there\nBye & thanks");
        assert_eq!(decode64("aGk=").unwrap(), b"hi");
        assert_eq!(decode64("aGk").unwrap(), b"hi");
        assert_eq!(decode64("_-8=").unwrap(), [0xff, 0xef]);
        assert!(decode64("not base64!").is_none());
        assert_eq!(clip_to("añb", 2), "a\n… (cut at 2 bytes of 4)");
    }

    #[test]
    fn every_tool_has_an_object_schema_and_a_known_platform_has_a_pinned_archive() {
        for app in super::super::google::APPS {
            let mut names = std::collections::HashSet::new();
            for t in tools(app) {
                assert_eq!((t.schema)()["type"], "object", "{}", t.name);
                assert!(!(t.read_only && t.destructive), "{}", t.name);
                assert!(names.insert(t.name), "{} twice", t.name);
            }
        }
        assert!(ASSETS.iter().all(|(_, _, _, sha)| sha.len() == 64));
    }
}
