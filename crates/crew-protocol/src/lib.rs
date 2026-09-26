use serde::{Deserialize, Serialize};
use serde_json::Value;
use ts_rs::TS;

mod blocks;
mod messages;
mod processes;
mod turns;
pub use blocks::*;
pub use messages::*;
pub use processes::*;
pub use turns::*;

#[derive(Serialize, Deserialize, Clone, Debug, TS)]
#[ts(export, export_to = "../../../src/lib/protocol.ts")]
pub struct Auth {
    pub auth: String,
}

#[derive(Serialize, Deserialize, Clone, Debug, TS)]
#[ts(export, export_to = "../../../src/lib/protocol.ts")]
pub struct Request {
    pub id: u32,
    pub method: String,
    #[ts(type = "unknown")]
    pub params: Value,
}

#[derive(Serialize, Deserialize, Clone, Debug, TS)]
#[ts(export, export_to = "../../../src/lib/protocol.ts")]
pub struct Response {
    pub id: u32,
    pub ok: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    #[ts(optional, type = "unknown")]
    pub result: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub error: Option<String>,
}

#[derive(Serialize, Deserialize, Clone, Debug, TS)]
#[ts(export, export_to = "../../../src/lib/protocol.ts")]
pub struct Event {
    pub event: String,
    #[ts(type = "unknown")]
    pub payload: Value,
}

#[derive(Serialize, Deserialize, Clone, Debug, TS)]
#[ts(export, export_to = "../../../src/lib/protocol.ts")]
pub struct DaemonInfo {
    pub url: String,
    pub token: String,
}

/// `<data-dir>/daemon.json`, mode 0600: how something that did not launch the
/// daemon finds it. `url` and `token` are the window's WebSocket, `socket` is
/// the tool bridge, and `userToken` speaks on that bridge as the user rather
/// than as a session. Written once the daemon is up, removed when it stops
/// cleanly, so a file left behind means one that died.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct DaemonFile {
    pub url: String,
    pub token: String,
    pub socket: String,
    pub user_token: String,
    pub version: String,
    /// The daemon's own process, for `crew daemon stop`. Optional so a file a
    /// daemon without it wrote still reads.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub pid: Option<u32>,
}

#[derive(Serialize, Deserialize, Clone, Debug, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../../src/lib/protocol.ts", rename_all = "camelCase")]
pub struct PtySpawn {
    pub id: String,
    pub cwd: String,
    pub command: Vec<String>,
    pub cols: u16,
    pub rows: u16,
    /// The terminal session this process runs. The daemon completes the argv
    /// and the environment so the CLI reaches Crew's tools: the client cannot,
    /// because in remote mode the bridge's socket and binary are not its own.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub session: Option<String>,
}

#[derive(Serialize, Deserialize, Clone, Debug, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../../src/lib/protocol.ts", rename_all = "camelCase")]
pub struct PtyWrite {
    pub id: String,
    pub data: String,
}

#[derive(Serialize, Deserialize, Clone, Debug, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../../src/lib/protocol.ts", rename_all = "camelCase")]
pub struct PtyResize {
    pub id: String,
    pub cols: u16,
    pub rows: u16,
}

#[derive(Serialize, Deserialize, Clone, Debug, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../../src/lib/protocol.ts", rename_all = "camelCase")]
pub struct PtyAck {
    pub id: String,
    #[ts(type = "number")]
    pub processed: u64,
}

#[derive(Serialize, Deserialize, Clone, Debug, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../../src/lib/protocol.ts", rename_all = "camelCase")]
pub struct PtyKill {
    pub id: String,
}

#[derive(Serialize, Deserialize, Clone, Debug, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../../src/lib/protocol.ts", rename_all = "camelCase")]
pub struct PtyAttach {
    pub id: String,
    #[ts(type = "number")]
    pub from: u64,
}

#[derive(Serialize, Deserialize, Clone, Debug, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../../src/lib/protocol.ts", rename_all = "camelCase")]
pub struct PtyAttached {
    #[ts(type = "number")]
    pub start: u64,
    #[ts(type = "number")]
    pub emitted: u64,
}

#[derive(Serialize, Deserialize, Clone, Debug, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../../src/lib/protocol.ts", rename_all = "camelCase")]
pub struct PtyExit {
    pub id: String,
    pub code: Option<i32>,
}

#[derive(Serialize, Deserialize, Clone, Debug, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../../src/lib/protocol.ts", rename_all = "camelCase")]
pub struct PtyError {
    pub id: String,
    pub error: String,
}

pub fn ok(id: u32, result: Value) -> Response {
    Response {
        id,
        ok: true,
        result: Some(result),
        error: None,
    }
}

pub fn err(id: u32, error: impl Into<String>) -> Response {
    Response {
        id,
        ok: false,
        result: None,
        error: Some(error.into()),
    }
}

#[derive(Serialize, Deserialize, Clone, Debug, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../../src/lib/protocol.ts", rename_all = "camelCase")]
pub struct ToolCall {
    #[ts(type = "number")]
    pub id: u64,
    pub session_id: String,
    pub method: String,
    #[ts(type = "unknown")]
    pub params: Value,
}

#[derive(Serialize, Deserialize, Clone, Debug, TS)]
#[ts(export, export_to = "../../../src/lib/protocol.ts")]
pub struct Id {
    pub id: String,
}

#[derive(Serialize, Deserialize, Clone, Debug, TS)]
#[ts(export, export_to = "../../../src/lib/protocol.ts")]
pub struct OptionalId {
    pub id: Option<String>,
}

#[derive(Serialize, Deserialize, Clone, Debug, TS)]
#[ts(export, export_to = "../../../src/lib/protocol.ts")]
pub struct Ids {
    pub ids: Vec<String>,
}

#[derive(Serialize, Deserialize, Clone, Debug, TS)]
#[ts(export, export_to = "../../../src/lib/protocol.ts")]
pub struct IdName {
    pub id: String,
    pub name: String,
}

#[derive(Serialize, Deserialize, Clone, Debug, TS)]
#[ts(export, export_to = "../../../src/lib/protocol.ts")]
pub struct NamePath {
    pub name: String,
    pub path: String,
}

#[derive(Serialize, Deserialize, Clone, Debug, TS)]
#[ts(export, export_to = "../../../src/lib/protocol.ts")]
pub struct Name {
    pub name: String,
}

#[derive(Serialize, Deserialize, Clone, Debug, TS)]
#[ts(export, export_to = "../../../src/lib/protocol.ts")]
pub struct Names {
    pub names: Vec<String>,
}

#[derive(Serialize, Deserialize, Clone, Debug, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../../src/lib/protocol.ts", rename_all = "camelCase")]
pub struct WorkspaceId {
    pub workspace_id: String,
}

#[derive(Serialize, Deserialize, Clone, Debug, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../../src/lib/protocol.ts", rename_all = "camelCase")]
pub struct SessionId {
    pub session_id: String,
}

#[derive(Serialize, Deserialize, Clone, Debug, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../../src/lib/protocol.ts", rename_all = "camelCase")]
pub struct SessionCreate {
    pub workspace_id: String,
    pub kind: String,
    pub name: String,
    pub provider: String,
    pub model: String,
    pub description: String,
    pub autonomy: String,
    /// The git worktree the session runs in; absent means the workspace folder.
    #[serde(default)]
    #[ts(optional = nullable)]
    pub worktree: Option<String>,
}

#[derive(Serialize, Deserialize, Clone, Debug, TS)]
#[ts(export, export_to = "../../../src/lib/protocol.ts")]
pub struct SessionUpdate {
    pub id: String,
    pub name: String,
    pub provider: String,
    pub model: String,
    pub description: String,
    pub notifications: bool,
    pub autonomy: String,
}

#[derive(Serialize, Deserialize, Clone, Debug, TS)]
#[ts(export, export_to = "../../../src/lib/protocol.ts")]
pub struct IdStatus {
    pub id: String,
    pub status: String,
}

#[derive(Serialize, Deserialize, Clone, Debug, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../../src/lib/protocol.ts", rename_all = "camelCase")]
pub struct IdBlocks {
    pub id: String,
    pub blocks_json: String,
}

/// Look for the provider session a terminal started in `cwd` since `since`.
#[derive(Serialize, Deserialize, Clone, Debug, TS)]
#[ts(export, export_to = "../../../src/lib/protocol.ts")]
pub struct ProviderDiscover {
    pub id: String,
    pub cwd: String,
    #[ts(type = "number")]
    pub since: i64,
}

#[derive(Serialize, Deserialize, Clone, Debug, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../../src/lib/protocol.ts", rename_all = "camelCase")]
pub struct IdProvider {
    pub id: String,
    pub provider_session_id: String,
}

#[derive(Serialize, Deserialize, Clone, Debug, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../../src/lib/protocol.ts", rename_all = "camelCase")]
pub struct RoutineUpsert {
    pub id: Option<String>,
    pub session_id: String,
    pub name: String,
    pub enabled: bool,
    pub prompt: String,
    pub schedule: String,
    #[ts(optional, type = "number")]
    pub next_run_at: Option<i64>,
    pub created_by: Option<String>,
}

#[derive(Serialize, Deserialize, Clone, Debug, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../../src/lib/protocol.ts", rename_all = "camelCase")]
pub struct RoutineRunNow {
    pub routine_id: String,
}

#[derive(Serialize, Deserialize, Clone, Debug, TS)]
#[ts(export, export_to = "../../../src/lib/protocol.ts")]
pub struct Key {
    pub key: String,
}

#[derive(Serialize, Deserialize, Clone, Debug, TS)]
#[ts(export, export_to = "../../../src/lib/protocol.ts")]
pub struct KeyValue {
    pub key: String,
    pub value: String,
}

#[derive(Serialize, Deserialize, Clone, Debug, TS)]
#[ts(export, export_to = "../../../src/lib/protocol.ts")]
pub struct ListProjectFiles {
    pub cwd: String,
    /// Folders indexed even when git ignores them or their name starts with a dot.
    #[serde(default)]
    pub include: Vec<String>,
}

#[derive(Serialize, Deserialize, Clone, Debug, TS)]
#[ts(export, export_to = "../../../src/lib/protocol.ts")]
pub struct PathArg {
    pub path: String,
}

/// A new worktree of the repo whose main checkout is `path`, on `branch`.
#[derive(Serialize, Deserialize, Clone, Debug, TS)]
#[ts(export, export_to = "../../../src/lib/protocol.ts")]
pub struct WorktreeAdd {
    pub path: String,
    pub branch: String,
}

#[derive(Serialize, Deserialize, Clone, Debug, TS)]
#[ts(export, export_to = "../../../src/lib/protocol.ts")]
pub struct WorktreeRemove {
    pub path: String,
    /// Discards uncommitted changes; without it a dirty worktree is refused.
    #[serde(default)]
    pub force: bool,
}

#[derive(Serialize, Deserialize, Clone, Debug, TS)]
#[ts(export, export_to = "../../../src/lib/protocol.ts")]
pub struct PathContents {
    pub path: String,
    pub contents: String,
}

#[derive(Serialize, Deserialize, Clone, Debug, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../../src/lib/protocol.ts", rename_all = "camelCase")]
pub struct TempFile {
    pub extension: String,
    pub base64_contents: String,
}

/// Bytes for a new file at `path`; the daemon never overwrites one that exists.
#[derive(Serialize, Deserialize, Clone, Debug, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../../src/lib/protocol.ts", rename_all = "camelCase")]
pub struct PathBytes {
    pub path: String,
    pub base64_contents: String,
}

#[derive(Serialize, Deserialize, Clone, Debug, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../../src/lib/protocol.ts", rename_all = "camelCase")]
pub struct SessionLine {
    pub session_id: String,
    pub line: String,
}

#[derive(Serialize, Deserialize, Clone, Debug, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../../src/lib/protocol.ts", rename_all = "camelCase")]
pub struct Workspace {
    pub id: String,
    pub name: String,
    pub path: String,
    #[ts(type = "number")]
    pub created_at: i64,
}

#[derive(Serialize, Deserialize, Clone, Debug, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../../src/lib/protocol.ts", rename_all = "camelCase")]
pub struct Session {
    pub id: String,
    pub workspace_id: String,
    pub kind: String,
    pub name: String,
    pub provider: String,
    pub model: String,
    pub provider_session_id: Option<String>,
    pub description: String,
    pub notifications: bool,
    pub autonomy: String,
    pub status: String,
    /// The git worktree it runs in; `None` is the workspace folder.
    pub worktree: Option<String>,
    #[ts(type = "number")]
    pub created_at: i64,
    #[ts(type = "number")]
    pub updated_at: i64,
}

#[derive(Serialize, Deserialize, Clone, Debug, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../../src/lib/protocol.ts", rename_all = "camelCase")]
pub struct Routine {
    pub id: String,
    pub session_id: String,
    pub name: String,
    pub enabled: bool,
    pub prompt: String,
    pub schedule: String,
    #[ts(optional, type = "number")]
    pub last_run_at: Option<i64>,
    #[ts(optional, type = "number")]
    pub next_run_at: Option<i64>,
    pub runs_json: String,
    pub created_by: Option<String>,
}

#[derive(Serialize, Deserialize, Clone, Debug, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../../src/lib/protocol.ts", rename_all = "camelCase")]
pub struct ScheduledRoutine {
    pub routine: Routine,
    pub session: Session,
    pub cwd: String,
}

#[derive(Serialize, Deserialize, Clone, Debug, TS)]
#[ts(export, export_to = "../../../src/lib/protocol.ts")]
pub struct AgentBinary {
    pub path: String,
}

#[derive(Serialize, Deserialize, Clone, Debug, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../../src/lib/protocol.ts", rename_all = "camelCase")]
pub struct ProjectFile {
    pub name: String,
    pub path: String,
    pub relative: String,
}

#[derive(Serialize, Deserialize, Clone, Debug, TS)]
#[ts(export, export_to = "../../../src/lib/protocol.ts")]
pub struct FileBytes {
    pub mime: String,
    pub data: String,
}

pub fn event(event: impl Into<String>, payload: impl Serialize) -> Result<Event, serde_json::Error> {
    Ok(Event {
        event: event.into(),
        payload: serde_json::to_value(payload)?,
    })
}

/// One row of browser history: every visit to the same normalized URL lands
/// here, with the exact URL of the latest one.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../../src/lib/protocol.ts", rename_all = "camelCase")]
pub struct HistoryEntry {
    pub url_key: String,
    pub url: String,
    /// Lowercase, without the port or a leading `www.`: what typing matches.
    pub host: String,
    pub title: String,
    #[ts(type = "number")]
    pub visit_count: i64,
    #[ts(type = "number")]
    pub last_visited_at: i64,
    /// The workspace of the latest visit. It may since have been removed.
    pub workspace_id: Option<String>,
}

/// A browser tab's back/forward stack, kept so a tab that was discarded or
/// closed comes back with more than its URL.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../../src/lib/protocol.ts", rename_all = "camelCase")]
pub struct PageSnapshot {
    pub page_id: String,
    /// The renderer's own JSON; the daemon only stores it.
    pub entries_json: String,
    #[ts(type = "number")]
    pub active_index: i64,
    #[ts(type = "number")]
    pub updated_at: i64,
}

#[derive(Serialize, Deserialize, Clone, Debug, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../../src/lib/protocol.ts", rename_all = "camelCase")]
pub struct HistoryVisit {
    pub url: String,
    pub title: String,
    #[serde(default)]
    #[ts(optional)]
    pub workspace_id: Option<String>,
}

#[derive(Serialize, Deserialize, Clone, Debug, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../../src/lib/protocol.ts", rename_all = "camelCase")]
pub struct HistoryTitle {
    pub url: String,
    pub title: String,
}

#[derive(Serialize, Deserialize, Clone, Debug, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../../src/lib/protocol.ts", rename_all = "camelCase")]
pub struct HistorySuggest {
    pub text: String,
    pub limit: u32,
}

#[derive(Serialize, Deserialize, Clone, Debug, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../../src/lib/protocol.ts", rename_all = "camelCase")]
pub struct HistoryList {
    #[serde(default)]
    #[ts(optional)]
    pub text: Option<String>,
    /// Page backwards: only rows visited strictly before this moment.
    #[serde(default)]
    #[ts(optional, type = "number")]
    pub before: Option<i64>,
    pub limit: u32,
}

#[derive(Serialize, Deserialize, Clone, Debug, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../../src/lib/protocol.ts", rename_all = "camelCase")]
pub struct UrlKey {
    pub url_key: String,
}

#[derive(Serialize, Deserialize, Clone, Debug, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../../src/lib/protocol.ts", rename_all = "camelCase")]
pub struct HistoryClear {
    /// Only what was visited from this moment on. Absent clears everything.
    #[serde(default)]
    #[ts(optional, type = "number")]
    pub since: Option<i64>,
}

#[derive(Serialize, Deserialize, Clone, Debug, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../../src/lib/protocol.ts", rename_all = "camelCase")]
pub struct PageSave {
    pub page_id: String,
    pub entries_json: String,
    #[ts(type = "number")]
    pub active_index: i64,
}

#[derive(Serialize, Deserialize, Clone, Debug, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../../src/lib/protocol.ts", rename_all = "camelCase")]
pub struct PageId {
    pub page_id: String,
}

/// A browser profile on this Mac whose cookies can be copied into Crew's pages.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../../src/lib/protocol.ts", rename_all = "camelCase")]
pub struct CookieSource {
    /// `<browser id>/<profile folder>`: what `browser_cookies_read` takes back.
    pub id: String,
    pub browser: String,
    pub profile: String,
}

#[derive(Serialize, Deserialize, Clone, Debug, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../../src/lib/protocol.ts", rename_all = "camelCase")]
pub struct CookieSourceId {
    pub source_id: String,
}

/// One decrypted cookie, in the shape Electron's `cookies.set` wants it.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../../src/lib/protocol.ts", rename_all = "camelCase")]
pub struct ImportedCookie {
    /// As the source stored it: a leading dot means the cookie also covers subdomains.
    pub host: String,
    pub name: String,
    pub value: String,
    pub path: String,
    pub secure: bool,
    pub http_only: bool,
    pub same_site: CookieSameSite,
    /// Seconds since the Unix epoch. Absent for a cookie that ends with the browser session.
    #[serde(default)]
    #[ts(optional, type = "number")]
    pub expires: Option<i64>,
}

#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq, TS)]
#[serde(rename_all = "snake_case")]
#[ts(export, export_to = "../../../src/lib/protocol.ts", rename_all = "snake_case")]
pub enum CookieSameSite {
    Unspecified,
    NoRestriction,
    Lax,
    Strict,
}

#[derive(Serialize, Deserialize, Clone, Debug, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../../src/lib/protocol.ts", rename_all = "camelCase")]
pub struct CookieRead {
    pub cookies: Vec<ImportedCookie>,
    /// Rows left out: expired, undecryptable, partitioned, or on a domain that must not move.
    pub skipped: u32,
}

/// Where a tab an agent drives sits, so the window can mount it when it is
/// cold or its workspace was never opened.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../../src/lib/protocol.ts", rename_all = "camelCase")]
pub struct BrowserPageRef {
    /// The tab strip: the workspace id, or `<workspace>@<worktree path>`.
    pub context: String,
    pub url: String,
    pub title: String,
}

/// crewd → the browser host (Electron main), as the `browser-call` event: run
/// one tool on one tab and answer with `browser_result`.
#[derive(Serialize, Deserialize, Clone, Debug, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../../src/lib/protocol.ts", rename_all = "camelCase")]
pub struct BrowserCall {
    #[ts(type = "number")]
    pub call_id: u64,
    pub tab: String,
    pub tool: String,
    #[ts(type = "unknown")]
    pub args: Value,
    #[serde(default)]
    #[ts(optional)]
    pub page: Option<BrowserPageRef>,
    /// Milliseconds since the epoch past which crewd has stopped waiting and
    /// told the caller the call failed. A call still queued behind the tab's
    /// earlier ones by then is skipped, not run late.
    #[ts(type = "number")]
    pub deadline: i64,
}

/// The host's answer to one `browser-call`. `result` is an array of MCP
/// content blocks (text or image).
#[derive(Serialize, Deserialize, Clone, Debug, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../../src/lib/protocol.ts", rename_all = "camelCase")]
pub struct BrowserResult {
    #[ts(type = "number")]
    pub call_id: u64,
    pub ok: bool,
    #[serde(default)]
    #[ts(optional, type = "unknown")]
    pub result: Option<Value>,
    #[serde(default)]
    #[ts(optional)]
    pub error: Option<String>,
}

/// Who is driving a tab, and until when unless they call again.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../../src/lib/protocol.ts", rename_all = "camelCase")]
pub struct BrowserLease {
    pub tab: String,
    pub workspace_id: String,
    /// What the holder is called: an agent's or a terminal's name, or "you".
    pub holder: String,
    /// The session behind it, for its face; none when it is the user.
    #[serde(default)]
    #[ts(optional)]
    pub session_id: Option<String>,
    /// Milliseconds since the epoch, as of the list it came in. Renewals are
    /// not announced, so this only says the lease lasts at least that long:
    /// a lease is over when a newer list leaves it out, not at `until`.
    #[ts(type = "number")]
    pub until: i64,
}

/// Every lease there is, as the `browser-leases` event and `browser_leases_list`.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../../src/lib/protocol.ts", rename_all = "camelCase")]
pub struct BrowserLeases {
    /// Higher is newer, across daemon restarts too. Lists can arrive out of
    /// order (an event overtaking a reply, two changes racing to the hub), so
    /// a client drops any list numbered below the newest it has kept.
    #[ts(type = "number")]
    pub seq: u64,
    pub leases: Vec<BrowserLease>,
}

#[derive(Serialize, Deserialize, Clone, Debug, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../../src/lib/protocol.ts", rename_all = "camelCase")]
pub struct BrowserTabArg {
    pub tab: String,
}

/// A browser tool run as the user, from the window or `crew`.
#[derive(Serialize, Deserialize, Clone, Debug, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../../src/lib/protocol.ts", rename_all = "camelCase")]
pub struct BrowserToolRun {
    pub workspace_id: String,
    pub tool: String,
    #[serde(default)]
    #[ts(type = "unknown")]
    pub args: Value,
}
