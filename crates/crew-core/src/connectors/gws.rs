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

use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::time::Duration;

use base64::engine::general_purpose::URL_SAFE;
use base64::Engine as _;
use serde_json::{json, Map, Value};
use sha2::{Digest, Sha256};

use super::google::App;

/// The `gws` Crew runs, and each platform's archive with its sha256.
pub const VERSION: &str = "0.22.5";
const ASSETS: &[(&str, &str, &str, &str)] = &[
    ("macos", "aarch64", "google-workspace-cli-aarch64-apple-darwin.tar.gz", "1d2a9ffd5bc9b2c2c4b48630daf082fad13d9e57d741988a2c248eed562f7dac"),
    ("macos", "x86_64", "google-workspace-cli-x86_64-apple-darwin.tar.gz", "51f9bd731404d4bba26c36e2e30dd68c56dccd1f834c01252cb0b14d6a6544b2"),
    ("linux", "x86_64", "google-workspace-cli-x86_64-unknown-linux-gnu.tar.gz", "de78ecdbd2f1a84cca0063a7ecbc440240fc14b6ebccbb17f4646b792a8c5c1f"),
    ("linux", "aarch64", "google-workspace-cli-aarch64-unknown-linux-gnu.tar.gz", "94490295d9580e1e88574e715a0a162991747d12d62f8c7b8dcc8268b6c1cea0"),
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
        let ok = std::process::Command::new("tar")
            .arg("-xzf")
            .arg(&archive)
            .arg("-C")
            .arg(&work)
            .arg("gws")
            .status()
            .is_ok_and(|s| s.success());
        if !ok {
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

/// Runs a tool of `app` for a session, with `token`. Its answer is MCP's.
pub async fn call(gws: &Gws, app: App, name: &str, args: &Value, token: &str) -> Result<Value, GwsError> {
    let tool = tools(app).iter().find(|t| t.name == name).ok_or_else(|| GwsError::Call(format!("{name} is not a tool of {}", app.name())))?;
    let bin = gws.binary().await?;
    let config = gws.config_dir();
    let folder = std::env::temp_dir().join(format!("crew-gws-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&folder).map_err(|e| GwsError::Setup(e.to_string()))?;
    std::fs::create_dir_all(&config).map_err(|e| GwsError::Setup(e.to_string()))?;
    let run = Run { bin, config, folder: folder.clone(), token };
    let args = args.as_object().cloned().unwrap_or_default();
    let result = run_tool(&run, tool.name, &args).await;
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

const fn tool(name: &'static str, title: &'static str, description: &'static str, read_only: bool, destructive: bool, schema: fn() -> Value) -> Tool {
    Tool { name, title, description, read_only, destructive, schema }
}

/// An object schema: its properties and which are required.
fn object(properties: Value, required: &[&str]) -> Value {
    json!({ "type": "object", "properties": properties, "required": required, "additionalProperties": false })
}

pub fn tools(app: App) -> &'static [Tool] {
    match app {
        App::Gmail => GMAIL,
        App::Drive => DRIVE,
        App::Calendar => CALENDAR,
        App::Docs => DOCS,
        App::Sheets => SHEETS,
    }
}

const GMAIL: &[Tool] = &[
    tool("search_threads", "Search threads", "Search the mailbox with Gmail's search syntax (from:, to:, subject:, is:unread, newer_than:7d, label:…). Answers each thread's id and snippet.", true, false, || {
        object(json!({
            "query": { "type": "string", "description": "Gmail search, as in Gmail's search box. Empty lists the latest threads." },
            "max_results": { "type": "integer", "minimum": 1, "maximum": 50, "default": 20 },
            "page_token": { "type": "string", "description": "The nextPageToken of the previous answer." }
        }), &[])
    }),
    tool("read_thread", "Read thread", "Read a thread's messages: sender, recipients, subject, date, labels and the text of each.", true, false, || {
        object(json!({ "thread_id": { "type": "string" } }), &["thread_id"])
    }),
    tool("list_labels", "List labels", "List the mailbox's labels, with their ids, for modify_labels and search.", true, false, || object(json!({}), &[])),
    tool("create_draft", "Create draft", "Write a draft, new or as a reply to a message, without sending it.", false, false, || {
        object(json!({
            "to": { "type": "string", "description": "Comma-separated addresses. For a reply, defaults to the sender." },
            "subject": { "type": "string" },
            "body": { "type": "string", "description": "Plain text." },
            "cc": { "type": "string" },
            "bcc": { "type": "string" },
            "reply_to_message_id": { "type": "string", "description": "A message id from read_thread, to reply in its thread." }
        }), &["body"])
    }),
    tool("send_message", "Send message", "Send an email, new or as a reply to a message.", false, true, || {
        object(json!({
            "to": { "type": "string", "description": "Comma-separated addresses. For a reply, defaults to the sender." },
            "subject": { "type": "string" },
            "body": { "type": "string", "description": "Plain text." },
            "cc": { "type": "string" },
            "bcc": { "type": "string" },
            "reply_to_message_id": { "type": "string", "description": "A message id from read_thread, to reply in its thread." }
        }), &["body"])
    }),
    tool("modify_labels", "Change labels", "Add or remove labels on a thread: archive (remove INBOX), mark read (remove UNREAD), star (add STARRED), or a label of list_labels.", false, false, || {
        object(json!({
            "thread_id": { "type": "string" },
            "add": { "type": "array", "items": { "type": "string" }, "description": "Label ids to add." },
            "remove": { "type": "array", "items": { "type": "string" }, "description": "Label ids to remove." }
        }), &["thread_id"])
    }),
    tool("trash_thread", "Trash thread", "Move a thread to the trash.", false, true, || object(json!({ "thread_id": { "type": "string" } }), &["thread_id"])),
];

const DRIVE: &[Tool] = &[
    tool("search_files", "Search files", "Search Drive with its query syntax (name contains 'x', fullText contains 'y', mimeType = '…', modifiedTime > '2026-01-01'). Answers each file's id, name, type, link and when it changed.", true, false, || {
        object(json!({
            "query": { "type": "string", "description": "A Drive query. Trashed files are left out." },
            "max_results": { "type": "integer", "minimum": 1, "maximum": 100, "default": 25 },
            "page_token": { "type": "string" }
        }), &["query"])
    }),
    tool("read_file", "Read file", "Read a file's text: a Google Doc as Markdown, a Sheet as CSV, a Slides deck as text, or a text file as it is.", true, false, || {
        object(json!({ "file_id": { "type": "string" } }), &["file_id"])
    }),
    tool("list_folder", "List folder", "List what a folder holds; without a folder, My Drive's top.", true, false, || {
        object(json!({
            "folder_id": { "type": "string", "default": "root" },
            "max_results": { "type": "integer", "minimum": 1, "maximum": 100, "default": 50 },
            "page_token": { "type": "string" }
        }), &[])
    }),
    tool("upload_file", "Upload file", "Make a file in Drive from text.", false, false, || {
        object(json!({
            "name": { "type": "string" },
            "content": { "type": "string", "description": "The file's text." },
            "mime_type": { "type": "string", "default": "text/plain" },
            "folder_id": { "type": "string" }
        }), &["name", "content"])
    }),
    tool("create_folder", "Create folder", "Make a folder.", false, false, || {
        object(json!({ "name": { "type": "string" }, "parent_id": { "type": "string" } }), &["name"])
    }),
    tool("share_file", "Share file", "Share a file with someone, as reader, commenter or writer.", false, true, || {
        object(json!({
            "file_id": { "type": "string" },
            "email": { "type": "string" },
            "role": { "type": "string", "enum": ["reader", "commenter", "writer"] },
            "notify": { "type": "boolean", "default": true, "description": "Email them about it." }
        }), &["file_id", "email", "role"])
    }),
    tool("trash_file", "Trash file", "Move a file or folder to the trash.", false, true, || object(json!({ "file_id": { "type": "string" } }), &["file_id"])),
];

/// A time in RFC 3339 (`2026-10-28T15:00:00-03:00`), or a date for an all-day event.
fn when() -> Value {
    json!({ "type": "string", "description": "RFC 3339 date-time, like 2026-10-28T15:00:00-03:00; a date (2026-10-28) for an all-day event." })
}

const CALENDAR: &[Tool] = &[
    tool("list_events", "List events", "List a calendar's events in a range, soonest first; from now on when no range is given.", true, false, || {
        object(json!({
            "calendar_id": { "type": "string", "default": "primary" },
            "time_min": { "type": "string", "description": "RFC 3339; now by default." },
            "time_max": { "type": "string", "description": "RFC 3339." },
            "query": { "type": "string", "description": "Words to find in the events." },
            "max_results": { "type": "integer", "minimum": 1, "maximum": 250, "default": 25 }
        }), &[])
    }),
    tool("find_free_time", "Find free time", "Answer the busy blocks of one or more calendars in a range; the time between them is free.", true, false, || {
        object(json!({
            "time_min": { "type": "string", "description": "RFC 3339." },
            "time_max": { "type": "string", "description": "RFC 3339." },
            "calendars": { "type": "array", "items": { "type": "string" }, "description": "Calendar ids or people's addresses; primary by default." },
            "time_zone": { "type": "string", "description": "IANA zone for the answer, like America/Santiago." }
        }), &["time_min", "time_max"])
    }),
    tool("create_event", "Create event", "Add an event. Attendees are emailed only when notify is on.", false, false, || {
        object(json!({
            "summary": { "type": "string" },
            "start": when(),
            "end": when(),
            "time_zone": { "type": "string", "description": "IANA zone, like America/Santiago." },
            "description": { "type": "string" },
            "location": { "type": "string" },
            "attendees": { "type": "array", "items": { "type": "string" } },
            "calendar_id": { "type": "string", "default": "primary" },
            "notify": { "type": "boolean", "default": false }
        }), &["summary", "start", "end"])
    }),
    tool("update_event", "Update event", "Change an event: only the fields given change.", false, false, || {
        object(json!({
            "event_id": { "type": "string" },
            "calendar_id": { "type": "string", "default": "primary" },
            "summary": { "type": "string" },
            "start": when(),
            "end": when(),
            "time_zone": { "type": "string" },
            "description": { "type": "string" },
            "location": { "type": "string" },
            "attendees": { "type": "array", "items": { "type": "string" }, "description": "The whole new list." },
            "notify": { "type": "boolean", "default": false }
        }), &["event_id"])
    }),
    tool("delete_event", "Delete event", "Delete an event.", false, true, || {
        object(json!({
            "event_id": { "type": "string" },
            "calendar_id": { "type": "string", "default": "primary" },
            "notify": { "type": "boolean", "default": false }
        }), &["event_id"])
    }),
];

const DOCS: &[Tool] = &[
    tool("read_document", "Read document", "Read a document's title and text.", true, false, || object(json!({ "document_id": { "type": "string" } }), &["document_id"])),
    tool("create_document", "Create document", "Make a document, with text when given.", false, false, || {
        object(json!({ "title": { "type": "string" }, "text": { "type": "string" } }), &["title"])
    }),
    tool("edit_document", "Edit document", "Replace text throughout a document, and add text at its end.", false, false, || {
        object(json!({
            "document_id": { "type": "string" },
            "replace": {
                "type": "array",
                "items": object(json!({ "find": { "type": "string" }, "with": { "type": "string" }, "match_case": { "type": "boolean", "default": true } }), &["find", "with"]),
            },
            "append": { "type": "string", "description": "Text to add at the end." }
        }), &["document_id"])
    }),
];

/// A range in A1 notation.
fn range() -> Value {
    json!({ "type": "string", "description": "A1 notation, like Sheet1!A1:D20." })
}

const SHEETS: &[Tool] = &[
    tool("read_range", "Read range", "Read a range's values.", true, false, || object(json!({ "spreadsheet_id": { "type": "string" }, "range": range() }), &["spreadsheet_id", "range"])),
    tool("list_sheets", "List sheets", "List a spreadsheet's title and sheets, with each one's size.", true, false, || object(json!({ "spreadsheet_id": { "type": "string" } }), &["spreadsheet_id"])),
    tool("create_spreadsheet", "Create spreadsheet", "Make a spreadsheet, with sheets named as given.", false, false, || {
        object(json!({ "title": { "type": "string" }, "sheets": { "type": "array", "items": { "type": "string" } } }), &["title"])
    }),
    tool("write_range", "Write range", "Write rows of values to a range. Formulas and dates are read as typed, unless raw is on.", false, false, || {
        object(json!({
            "spreadsheet_id": { "type": "string" },
            "range": range(),
            "values": { "type": "array", "items": { "type": "array", "items": {} } },
            "raw": { "type": "boolean", "default": false }
        }), &["spreadsheet_id", "range", "values"])
    }),
    tool("clear_range", "Clear range", "Clear a range's values.", false, true, || object(json!({ "spreadsheet_id": { "type": "string" }, "range": range() }), &["spreadsheet_id", "range"])),
];

/* ── What each tool runs ──────────────────────────────────────────────── */

type Args = Map<String, Value>;

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
    args.get(key).and_then(Value::as_array).into_iter().flatten().filter_map(Value::as_str).map(str::to_string).collect()
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

/// An event's start or end: a date for an all-day one.
fn time_of(at: &str, zone: Option<&str>) -> Value {
    if at.len() == 10 && !at.contains('T') {
        json!({ "date": at })
    } else {
        let mut v = json!({ "dateTime": at });
        if let Some(zone) = zone {
            v["timeZone"] = json!(zone);
        }
        v
    }
}

fn updates(args: &Args) -> &'static str {
    if flag(args, "notify", false) {
        "all"
    } else {
        "none"
    }
}

async fn run_tool(run: &Run<'_>, name: &str, args: &Args) -> Result<Value, GwsError> {
    match name {
        /* Gmail */
        "search_threads" => {
            let p = params(json!({
                "userId": "me", "q": text(args, "query"), "maxResults": number(args, "max_results", 20, 50), "pageToken": text(args, "page_token"),
            }));
            run.json(&["gmail", "users", "threads", "list", "--params", &p]).await
        }
        "read_thread" => {
            let p = params(json!({ "userId": "me", "id": need(args, "thread_id")?, "format": "full" }));
            let thread = run.json(&["gmail", "users", "threads", "get", "--params", &p]).await?;
            Ok(readable_thread(&thread))
        }
        "list_labels" => {
            let labels = run.json(&["gmail", "users", "labels", "list", "--params", r#"{"userId":"me"}"#]).await?;
            Ok(json!(labels["labels"].as_array().into_iter().flatten().map(|l| json!({ "id": l["id"], "name": l["name"], "type": l["type"] })).collect::<Vec<_>>()))
        }
        "create_draft" | "send_message" => {
            let body = need(args, "body")?;
            let mut argv: Vec<String> = vec!["gmail".into()];
            match text(args, "reply_to_message_id") {
                Some(id) => argv.extend(["+reply".into(), "--message-id".into(), id.into()]),
                None => {
                    argv.extend(["+send".into(), "--to".into(), need(args, "to")?.into()]);
                    argv.extend(["--subject".into(), text(args, "subject").unwrap_or_default().into()]);
                }
            }
            if let (Some(to), Some(_)) = (text(args, "to"), text(args, "reply_to_message_id")) {
                argv.extend(["--to".into(), to.into()]);
            }
            argv.extend(["--body".into(), body.into()]);
            for key in ["cc", "bcc"] {
                if let Some(v) = text(args, key) {
                    argv.extend([format!("--{key}"), v.into()]);
                }
            }
            if name == "create_draft" {
                argv.push("--draft".into());
            }
            let argv: Vec<&str> = argv.iter().map(String::as_str).collect();
            run.json(&argv).await
        }
        "modify_labels" => {
            let p = params(json!({ "userId": "me", "id": need(args, "thread_id")? }));
            let body = json!({ "addLabelIds": strings(args, "add"), "removeLabelIds": strings(args, "remove") }).to_string();
            let thread = run.json(&["gmail", "users", "threads", "modify", "--params", &p, "--json", &body]).await?;
            Ok(json!({ "id": thread["id"], "done": true }))
        }
        "trash_thread" => {
            let p = params(json!({ "userId": "me", "id": need(args, "thread_id")? }));
            run.json(&["gmail", "users", "threads", "trash", "--params", &p]).await?;
            Ok(json!({ "trashed": true }))
        }

        /* Drive */
        "search_files" | "list_folder" => {
            let q = match name {
                "search_files" => format!("({}) and trashed = false", need(args, "query")?),
                _ => format!("'{}' in parents and trashed = false", quoted(text(args, "folder_id").unwrap_or("root"))),
            };
            let p = params(json!({
                "q": q,
                "pageSize": number(args, "max_results", if name == "search_files" { 25 } else { 50 }, 100),
                "pageToken": text(args, "page_token"),
                "fields": "nextPageToken,files(id,name,mimeType,modifiedTime,size,webViewLink,parents)",
                "supportsAllDrives": true,
                "includeItemsFromAllDrives": true,
            }));
            run.json(&["drive", "files", "list", "--params", &p]).await
        }
        "read_file" => read_file(run, need(args, "file_id")?).await,
        "upload_file" => {
            let content = args.get("content").and_then(Value::as_str).ok_or_else(|| GwsError::Call("content is required".into()))?;
            std::fs::write(run.file("upload"), content).map_err(|e| GwsError::Setup(e.to_string()))?;
            let mut meta = json!({ "name": need(args, "name")? });
            if let Some(folder) = text(args, "folder_id") {
                meta["parents"] = json!([folder]);
            }
            let p = params(json!({ "fields": "id,name,mimeType,webViewLink", "supportsAllDrives": true }));
            let mime = text(args, "mime_type").unwrap_or("text/plain");
            run.json(&["drive", "files", "create", "--params", &p, "--json", &meta.to_string(), "--upload", "upload", "--upload-content-type", mime]).await
        }
        "create_folder" => {
            let mut meta = json!({ "name": need(args, "name")?, "mimeType": "application/vnd.google-apps.folder" });
            if let Some(parent) = text(args, "parent_id") {
                meta["parents"] = json!([parent]);
            }
            let p = params(json!({ "fields": "id,name,webViewLink", "supportsAllDrives": true }));
            run.json(&["drive", "files", "create", "--params", &p, "--json", &meta.to_string()]).await
        }
        "share_file" => {
            let role = need(args, "role")?;
            if !["reader", "commenter", "writer"].contains(&role) {
                return Err(GwsError::Call("role is reader, commenter or writer".into()));
            }
            let p = params(json!({ "fileId": need(args, "file_id")?, "sendNotificationEmail": flag(args, "notify", true), "supportsAllDrives": true }));
            let body = json!({ "type": "user", "role": role, "emailAddress": need(args, "email")? }).to_string();
            run.json(&["drive", "permissions", "create", "--params", &p, "--json", &body]).await
        }
        "trash_file" => {
            let p = params(json!({ "fileId": need(args, "file_id")?, "supportsAllDrives": true, "fields": "id,name,trashed" }));
            run.json(&["drive", "files", "update", "--params", &p, "--json", r#"{"trashed":true}"#]).await
        }

        /* Calendar */
        "list_events" => {
            let now = crate::store::now_millis();
            let p = params(json!({
                "calendarId": text(args, "calendar_id").unwrap_or("primary"),
                "timeMin": text(args, "time_min").map(str::to_string).unwrap_or_else(|| rfc3339(now)),
                "timeMax": text(args, "time_max"),
                "q": text(args, "query"),
                "maxResults": number(args, "max_results", 25, 250),
                "singleEvents": true,
                "orderBy": "startTime",
            }));
            let events = run.json(&["calendar", "events", "list", "--params", &p]).await?;
            Ok(json!({
                "timeZone": events["timeZone"],
                "events": events["items"].as_array().into_iter().flatten().map(|e| json!({
                    "id": e["id"], "summary": e["summary"], "start": e["start"], "end": e["end"], "location": e["location"],
                    "attendees": e["attendees"].as_array().map(|a| a.iter().map(|p| p["email"].clone()).collect::<Vec<_>>()),
                    "link": e["htmlLink"], "status": e["status"],
                })).collect::<Vec<_>>(),
                "nextPageToken": events["nextPageToken"],
            }))
        }
        "find_free_time" => {
            let mut calendars = strings(args, "calendars");
            if calendars.is_empty() {
                calendars.push("primary".into());
            }
            let mut body = json!({
                "timeMin": need(args, "time_min")?, "timeMax": need(args, "time_max")?,
                "items": calendars.iter().map(|id| json!({ "id": id })).collect::<Vec<_>>(),
            });
            if let Some(zone) = text(args, "time_zone") {
                body["timeZone"] = json!(zone);
            }
            let busy = run.json(&["calendar", "freebusy", "query", "--json", &body.to_string()]).await?;
            Ok(busy["calendars"].clone())
        }
        "create_event" | "update_event" => {
            let zone = text(args, "time_zone");
            let mut event = Map::new();
            for (key, field) in [("summary", "summary"), ("description", "description"), ("location", "location")] {
                if let Some(v) = text(args, key) {
                    event.insert(field.into(), json!(v));
                }
            }
            for key in ["start", "end"] {
                if let Some(at) = text(args, key) {
                    event.insert(key.into(), time_of(at, zone));
                }
            }
            if args.contains_key("attendees") {
                event.insert("attendees".into(), json!(strings(args, "attendees").iter().map(|e| json!({ "email": e })).collect::<Vec<_>>()));
            }
            let calendar = text(args, "calendar_id").unwrap_or("primary");
            let body = Value::Object(event).to_string();
            let made = if name == "create_event" {
                need(args, "summary")?;
                need(args, "start")?;
                need(args, "end")?;
                let p = params(json!({ "calendarId": calendar, "sendUpdates": updates(args) }));
                run.json(&["calendar", "events", "insert", "--params", &p, "--json", &body]).await?
            } else {
                let p = params(json!({ "calendarId": calendar, "eventId": need(args, "event_id")?, "sendUpdates": updates(args) }));
                run.json(&["calendar", "events", "patch", "--params", &p, "--json", &body]).await?
            };
            Ok(json!({ "id": made["id"], "summary": made["summary"], "start": made["start"], "end": made["end"], "link": made["htmlLink"] }))
        }
        "delete_event" => {
            let p = params(json!({
                "calendarId": text(args, "calendar_id").unwrap_or("primary"), "eventId": need(args, "event_id")?, "sendUpdates": updates(args),
            }));
            run.json(&["calendar", "events", "delete", "--params", &p]).await?;
            Ok(json!({ "deleted": true }))
        }

        /* Docs */
        "read_document" => {
            let p = params(json!({ "documentId": need(args, "document_id")? }));
            let doc = run.json(&["docs", "documents", "get", "--params", &p]).await?;
            Ok(json!({ "title": doc["title"], "text": clip(&document_text(&doc["body"]["content"])) }))
        }
        "create_document" => {
            let doc = run.json(&["docs", "documents", "create", "--json", &json!({ "title": need(args, "title")? }).to_string()]).await?;
            let id = doc["documentId"].as_str().unwrap_or_default().to_string();
            if let Some(body) = args.get("text").and_then(Value::as_str).filter(|t| !t.is_empty()) {
                let requests = json!({ "requests": [{ "insertText": { "location": { "index": 1 }, "text": body } }] }).to_string();
                run.json(&["docs", "documents", "batchUpdate", "--params", &params(json!({ "documentId": id })), "--json", &requests]).await?;
            }
            Ok(json!({ "documentId": id, "title": doc["title"], "link": format!("https://docs.google.com/document/d/{id}/edit") }))
        }
        "edit_document" => {
            let id = need(args, "document_id")?;
            let mut requests: Vec<Value> = args
                .get("replace")
                .and_then(Value::as_array)
                .into_iter()
                .flatten()
                .filter_map(|r| {
                    let find = r["find"].as_str().filter(|f| !f.is_empty())?;
                    Some(json!({ "replaceAllText": {
                        "containsText": { "text": find, "matchCase": r["match_case"].as_bool().unwrap_or(true) },
                        "replaceText": r["with"].as_str().unwrap_or_default(),
                    }}))
                })
                .collect();
            if let Some(append) = args.get("append").and_then(Value::as_str).filter(|t| !t.is_empty()) {
                requests.push(json!({ "insertText": { "endOfSegmentLocation": {}, "text": append } }));
            }
            if requests.is_empty() {
                return Err(GwsError::Call("Give replace or append".into()));
            }
            let done = run
                .json(&["docs", "documents", "batchUpdate", "--params", &params(json!({ "documentId": id })), "--json", &json!({ "requests": requests }).to_string()])
                .await?;
            let replaced: Vec<Value> = done["replies"]
                .as_array()
                .into_iter()
                .flatten()
                .filter_map(|r| r["replaceAllText"]["occurrencesChanged"].as_u64().map(|n| json!(n)))
                .collect();
            Ok(json!({ "documentId": id, "replaced": replaced, "appended": args.contains_key("append") }))
        }

        /* Sheets */
        "read_range" => {
            let p = params(json!({ "spreadsheetId": need(args, "spreadsheet_id")?, "range": need(args, "range")? }));
            run.json(&["sheets", "spreadsheets", "values", "get", "--params", &p]).await
        }
        "list_sheets" => {
            let p = params(json!({ "spreadsheetId": need(args, "spreadsheet_id")?, "fields": "properties.title,sheets.properties(sheetId,title,gridProperties)" }));
            run.json(&["sheets", "spreadsheets", "get", "--params", &p]).await
        }
        "create_spreadsheet" => {
            let sheets: Vec<Value> = strings(args, "sheets").iter().map(|t| json!({ "properties": { "title": t } })).collect();
            let mut body = json!({ "properties": { "title": need(args, "title")? } });
            if !sheets.is_empty() {
                body["sheets"] = json!(sheets);
            }
            let made = run.json(&["sheets", "spreadsheets", "create", "--json", &body.to_string()]).await?;
            Ok(json!({ "spreadsheetId": made["spreadsheetId"], "link": made["spreadsheetUrl"] }))
        }
        "write_range" => {
            let values = args.get("values").filter(|v| v.is_array()).ok_or_else(|| GwsError::Call("values is required".into()))?;
            let input = if flag(args, "raw", false) { "RAW" } else { "USER_ENTERED" };
            let p = params(json!({ "spreadsheetId": need(args, "spreadsheet_id")?, "range": need(args, "range")?, "valueInputOption": input }));
            run.json(&["sheets", "spreadsheets", "values", "update", "--params", &p, "--json", &json!({ "values": values }).to_string()]).await
        }
        "clear_range" => {
            let p = params(json!({ "spreadsheetId": need(args, "spreadsheet_id")?, "range": need(args, "range")? }));
            run.json(&["sheets", "spreadsheets", "values", "clear", "--params", &p]).await
        }
        other => Err(GwsError::Call(format!("{other} is not a tool"))),
    }
}

/// A file's text: Google's own formats exported, anything else read when it is text.
async fn read_file(run: &Run<'_>, id: &str) -> Result<Value, GwsError> {
    let p = params(json!({ "fileId": id, "fields": "id,name,mimeType,size,webViewLink", "supportsAllDrives": true }));
    let meta = run.json(&["drive", "files", "get", "--params", &p]).await?;
    let mime = meta["mimeType"].as_str().unwrap_or_default();
    let export = match mime {
        "application/vnd.google-apps.document" => Some("text/markdown"),
        "application/vnd.google-apps.spreadsheet" => Some("text/csv"),
        "application/vnd.google-apps.presentation" => Some("text/plain"),
        _ => None,
    };
    let textual = mime.starts_with("text/") || ["application/json", "application/xml", "application/javascript"].contains(&mime);
    if export.is_none() && !textual {
        return Ok(json!({ "file": meta, "text": null, "note": "This file isn't text; open its link to see it." }));
    }
    let p = match export {
        Some(as_mime) => params(json!({ "fileId": id, "mimeType": as_mime })),
        None => params(json!({ "fileId": id, "alt": "media", "supportsAllDrives": true })),
    };
    let method = if export.is_some() { "export" } else { "get" };
    run.raw(&["drive", "files", method, "--params", &p, "--output", "content"]).await?;
    let bytes = std::fs::read(run.file("content")).map_err(|e| GwsError::Call(format!("The file didn't download: {e}")))?;
    Ok(json!({ "file": meta, "text": clip(&String::from_utf8_lossy(&bytes)) }))
}

fn clip(text: &str) -> String {
    if text.len() <= MAX_TEXT {
        return text.to_string();
    }
    let mut end = MAX_TEXT;
    while !text.is_char_boundary(end) {
        end -= 1;
    }
    format!("{}\n… (cut at {MAX_TEXT} bytes of {})", &text[..end], text.len())
}

/// A thread as a model reads it: each message's headers and its text.
fn readable_thread(thread: &Value) -> Value {
    let messages: Vec<Value> = thread["messages"]
        .as_array()
        .into_iter()
        .flatten()
        .map(|m| {
            let headers = m["payload"]["headers"].as_array().cloned().unwrap_or_default();
            let header = |name: &str| {
                headers.iter().find(|h| h["name"].as_str().is_some_and(|n| n.eq_ignore_ascii_case(name))).and_then(|h| h["value"].as_str()).map(str::to_string)
            };
            let body = part_text(&m["payload"], "text/plain").or_else(|| part_text(&m["payload"], "text/html").map(|h| strip_html(&h)));
            json!({
                "id": m["id"], "from": header("From"), "to": header("To"), "cc": header("Cc"), "subject": header("Subject"),
                "date": header("Date"), "labels": m["labelIds"], "text": body.map(|b| clip(&b)).unwrap_or_else(|| m["snippet"].as_str().unwrap_or_default().to_string()),
                "attachments": attachments(&m["payload"]),
            })
        })
        .collect();
    json!({ "id": thread["id"], "messages": messages })
}

/// The first part of a MIME type in a message, decoded.
fn part_text(part: &Value, mime: &str) -> Option<String> {
    if part["mimeType"].as_str() == Some(mime) {
        if let Some(data) = part["body"]["data"].as_str() {
            let bytes = URL_SAFE.decode(data.trim_end_matches('=')).or_else(|_| URL_SAFE.decode(data)).ok()?;
            return Some(String::from_utf8_lossy(&bytes).into_owned());
        }
    }
    part["parts"].as_array().into_iter().flatten().find_map(|p| part_text(p, mime))
}

fn attachments(part: &Value) -> Vec<Value> {
    let mut out = Vec::new();
    if let Some(name) = part["filename"].as_str().filter(|n| !n.is_empty()) {
        out.push(json!({ "name": name, "mimeType": part["mimeType"], "size": part["body"]["size"] }));
    }
    for p in part["parts"].as_array().into_iter().flatten() {
        out.extend(attachments(p));
    }
    out
}

/// HTML's text, roughly: tags out, a line per block, entities for the common few.
fn strip_html(html: &str) -> String {
    let mut out = String::with_capacity(html.len() / 2);
    let mut in_tag = false;
    let mut tag = String::new();
    for c in html.chars() {
        match c {
            '<' => {
                in_tag = true;
                tag.clear();
            }
            '>' if in_tag => {
                in_tag = false;
                let name = tag.trim_start_matches('/').split(|c: char| c.is_whitespace() || c == '/').next().unwrap_or_default().to_ascii_lowercase();
                if ["br", "p", "div", "tr", "li", "h1", "h2", "h3"].contains(&name.as_str()) {
                    out.push('\n');
                }
            }
            c if in_tag => tag.push(c),
            c => out.push(c),
        }
    }
    let out = out.replace("&nbsp;", " ").replace("&amp;", "&").replace("&lt;", "<").replace("&gt;", ">").replace("&quot;", "\"").replace("&#39;", "'");
    out.lines().map(str::trim_end).filter(|l| !l.trim().is_empty()).collect::<Vec<_>>().join("\n")
}

/// A document's text, from its structure: paragraphs' runs and tables' cells.
fn document_text(content: &Value) -> String {
    let mut out = String::new();
    for element in content.as_array().into_iter().flatten() {
        for run in element["paragraph"]["elements"].as_array().into_iter().flatten() {
            if let Some(text) = run["textRun"]["content"].as_str() {
                out.push_str(text);
            }
        }
        for row in element["table"]["tableRows"].as_array().into_iter().flatten() {
            let cells: Vec<String> = row["tableCells"].as_array().into_iter().flatten().map(|c| document_text(&c["content"]).trim().replace('\n', " ")).collect();
            out.push_str(&format!("| {} |\n", cells.join(" | ")));
        }
    }
    out
}

/// Unix milliseconds as RFC 3339 in UTC.
fn rfc3339(ms: i64) -> String {
    let secs = ms.div_euclid(1000);
    let (days, rem) = (secs.div_euclid(86_400), secs.rem_euclid(86_400));
    // Days to a civil date (Howard Hinnant's algorithm).
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let day = doy - (153 * mp + 2) / 5 + 1;
    let month = if mp < 10 { mp + 3 } else { mp - 9 };
    let year = yoe + era * 400 + i64::from(month <= 2);
    format!("{year:04}-{month:02}-{day:02}T{:02}:{:02}:{:02}Z", rem / 3600, rem % 3600 / 60, rem % 60)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::os::unix::fs::PermissionsExt;

    /// A fake `gws` that logs its arguments and environment and answers what the test says.
    fn fake(dir: &Path, answer: &str, code: i32) -> Gws {
        let script = dir.join("gws");
        std::fs::write(
            &script,
            format!(
                "#!/bin/sh\nprintf '%s\\n' \"$@\" > \"{log}/args\"\nenv > \"{log}/env\"\npwd > \"{log}/pwd\"\ncat <<'EOF'\n{answer}\nEOF\nexit {code}\n",
                log = dir.display()
            ),
        )
        .unwrap();
        std::fs::set_permissions(&script, std::fs::Permissions::from_mode(0o755)).unwrap();
        Gws::at(script)
    }

    fn scratch() -> PathBuf {
        let dir = std::env::temp_dir().join(format!("crew-gws-test-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[tokio::test]
    async fn a_tool_runs_gws_with_the_token_and_nothing_of_the_persons() {
        let dir = scratch();
        let gws = fake(&dir, r#"{"threads":[{"id":"t1","snippet":"hi"}]}"#, 0);
        let answer = call(&gws, App::Gmail, "search_threads", &json!({ "query": "is:unread", "max_results": 500 }), "at-1").await.unwrap();
        assert!(answer["content"][0]["text"].as_str().unwrap().contains("t1"));
        let args = std::fs::read_to_string(dir.join("args")).unwrap();
        let lines: Vec<&str> = args.lines().collect();
        assert_eq!(lines[..5], ["gmail", "users", "threads", "list", "--params"]);
        let p: Value = serde_json::from_str(lines[5]).unwrap();
        assert_eq!(p, json!({ "userId": "me", "q": "is:unread", "maxResults": 50 }));
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
        let gws = fake(&dir, r#"{"error":{"code":401,"message":"Request had invalid authentication credentials.","reason":"authError"}}"#, 1);
        assert_eq!(call(&gws, App::Drive, "trash_file", &json!({ "file_id": "f" }), "x").await, Err(GwsError::Unauthorized));
        let gws = fake(&dir, r#"{"error":{"code":403,"message":"Insufficient Permission","reason":"insufficientPermissions"}}"#, 1);
        assert_eq!(
            call(&gws, App::Drive, "trash_file", &json!({ "file_id": "f" }), "x").await,
            Err(GwsError::Forbidden("Google refused: Insufficient Permission".into()))
        );
        assert!(matches!(call(&gws, App::Drive, "nope", &json!({}), "x").await, Err(GwsError::Call(_))));
        let _ = std::fs::remove_dir_all(dir);
    }

    #[tokio::test]
    async fn a_reply_and_a_draft_go_through_gws_helpers() {
        let dir = scratch();
        let gws = fake(&dir, "{}", 0);
        call(&gws, App::Gmail, "create_draft", &json!({ "reply_to_message_id": "m1", "body": "Thanks", "cc": "b@x.dev" }), "t").await.unwrap();
        let args = std::fs::read_to_string(dir.join("args")).unwrap();
        assert_eq!(args.lines().collect::<Vec<_>>(), ["gmail", "+reply", "--message-id", "m1", "--body", "Thanks", "--cc", "b@x.dev", "--draft"]);
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn a_thread_reads_as_text_with_its_headers() {
        let data = URL_SAFE.encode("Hello Ada,\nsee you.");
        let html = URL_SAFE.encode("<p>Hi&nbsp;there</p><br>Bye &amp; thanks");
        let thread = json!({ "id": "t", "messages": [
            { "id": "m1", "labelIds": ["INBOX"], "payload": { "headers": [{ "name": "From", "value": "b@x.dev" }, { "name": "Subject", "value": "Hi" }],
              "mimeType": "multipart/mixed", "parts": [
                { "mimeType": "multipart/alternative", "parts": [{ "mimeType": "text/plain", "body": { "data": data } }] },
                { "mimeType": "application/pdf", "filename": "a.pdf", "body": { "size": 10 } } ] } },
            { "id": "m2", "payload": { "headers": [], "mimeType": "text/html", "body": { "data": html } } },
        ]});
        let read = readable_thread(&thread);
        assert_eq!(read["messages"][0]["text"], "Hello Ada,\nsee you.");
        assert_eq!(read["messages"][0]["from"], "b@x.dev");
        assert_eq!(read["messages"][0]["attachments"][0]["name"], "a.pdf");
        assert_eq!(read["messages"][1]["text"], "Hi there\nBye & thanks");
    }

    #[test]
    fn a_documents_text_and_utc_times_read_plainly() {
        let content = json!([
            { "paragraph": { "elements": [{ "textRun": { "content": "Title\n" } }] } },
            { "table": { "tableRows": [{ "tableCells": [
                { "content": [{ "paragraph": { "elements": [{ "textRun": { "content": "a\n" } }] } }] },
                { "content": [{ "paragraph": { "elements": [{ "textRun": { "content": "b\n" } }] } }] } ] }] } },
        ]);
        assert_eq!(document_text(&content), "Title\n| a | b |\n");
        assert_eq!(rfc3339(0), "1970-01-01T00:00:00Z");
        assert_eq!(rfc3339(1_792_457_829_939), "2026-10-20T00:57:09Z");
    }

    #[test]
    fn every_tool_has_an_object_schema_and_a_known_platform_has_a_pinned_archive() {
        for app in super::super::google::APPS {
            for t in tools(app) {
                assert_eq!((t.schema)()["type"], "object", "{}", t.name);
                assert!(!(t.read_only && t.destructive), "{}", t.name);
            }
        }
        assert!(ASSETS.iter().all(|(_, _, _, sha)| sha.len() == 64));
    }
}
