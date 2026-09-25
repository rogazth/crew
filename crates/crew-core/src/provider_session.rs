use std::io::{BufRead, BufReader, Read};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::thread;
use std::time::{Duration, Instant, UNIX_EPOCH};

use rusqlite::{params, Connection, OpenFlags};

use crate::shell_path;

const CREATE_TIMEOUT: Duration = Duration::from_secs(15);
/// The CLI stamps its own clock a beat after the terminal starts; a session
/// begun this long before `since` still counts as the one we launched.
const CLOCK_SLACK_MS: i64 = 2_000;
/// Day folders to look through: today's, plus yesterday's across midnight.
const CODEX_DAYS: usize = 2;

/// A chat cursor-agent can `--resume` before anything was said in it, so the
/// id is known before the terminal starts.
pub fn cursor_create_chat() -> Result<String, String> {
    let binary = shell_path::resolve("cursor-agent")
        .ok_or_else(|| "`cursor-agent` was not found on your PATH.".to_string())?;
    let mut child = Command::new(binary)
        .arg("create-chat")
        .env("PATH", shell_path::joined())
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| format!("cursor-agent create-chat: {e}"))?;
    let deadline = Instant::now() + CREATE_TIMEOUT;
    let status = loop {
        match child.try_wait().map_err(|e| e.to_string())? {
            Some(status) => break status,
            None if Instant::now() < deadline => thread::sleep(Duration::from_millis(50)),
            None => {
                let _ = child.kill();
                let _ = child.wait();
                return Err("cursor-agent create-chat did not answer".into());
            }
        }
    };
    let mut out = String::new();
    if let Some(mut stdout) = child.stdout.take() {
        let _ = stdout.read_to_string(&mut out);
    }
    let id = out.trim();
    if !status.success() || !is_chat_id(id) {
        let mut err = String::new();
        if let Some(mut stderr) = child.stderr.take() {
            let _ = stderr.read_to_string(&mut err);
        }
        return Err(format!("cursor-agent create-chat failed: {}", err.trim()));
    }
    Ok(id.to_string())
}

fn is_chat_id(id: &str) -> bool {
    !id.is_empty() && id.len() <= 64 && id.chars().all(|c| c.is_ascii_alphanumeric() || c == '-')
}

/// Claude starts a new session on `/clear` without a word to its terminal. The
/// SessionStart hook Crew passes it drops the hook's stdin in this folder, one
/// file per Crew session, and that record is the only place the new id shows.
pub const CLAUDE_BIND_ENV: &str = "CREW_CLAUDE_BIND_DIR";

/// The Claude session the hook last reported for Crew session `crew_id`.
pub fn claude_bound(crew_id: &str) -> Option<String> {
    if !is_chat_id(crew_id) {
        return None;
    }
    let dir = PathBuf::from(std::env::var_os(CLAUDE_BIND_ENV)?);
    parse_claude_bind(&std::fs::read_to_string(dir.join(format!("{crew_id}.json"))).ok()?)
}

/// The prompt Claude raised for Crew session `crew_id` since the last look: a
/// permission to grant, a form to fill. Claude says so only through its
/// Notification hook, which drops the record here; reading it takes it.
pub fn claude_attention(crew_id: &str) -> Option<String> {
    if !is_chat_id(crew_id) {
        return None;
    }
    let path = PathBuf::from(std::env::var_os(CLAUDE_BIND_ENV)?).join(format!("{crew_id}.attention"));
    let record = std::fs::read_to_string(&path).ok()?;
    let _ = std::fs::remove_file(&path);
    Some(parse_claude_attention(&record))
}

fn parse_claude_attention(record: &str) -> String {
    serde_json::from_str::<serde_json::Value>(record)
        .ok()
        .and_then(|value| value.get("message")?.as_str().map(str::to_string))
        .filter(|message| !message.trim().is_empty())
        .unwrap_or_else(|| "Needs your input".to_string())
}

fn parse_claude_bind(record: &str) -> Option<String> {
    let value: serde_json::Value = serde_json::from_str(record).ok()?;
    let id = value.get("session_id")?.as_str()?;
    is_chat_id(id).then(|| id.to_string())
}

/// The session a CLI that names its own sessions started in `cwd` at or after
/// `since_ms`, skipping ids another Crew session already holds. Codex and
/// opencode only write a session once the first message is sent, so callers
/// ask again until one shows up.
pub fn discover(provider: &str, cwd: &str, since_ms: i64, claimed: &[String]) -> Option<String> {
    let cwd = canonical(cwd);
    let since = since_ms - CLOCK_SLACK_MS;
    let found = match provider {
        "codex" => codex_sessions(&codex_home()?, since),
        "opencode" => opencode_sessions(&opencode_db()?, since),
        _ => return None,
    };
    found
        .into_iter()
        .filter(|s| canonical(&s.cwd) == cwd && !claimed.contains(&s.id))
        .min_by_key(|s| s.created_ms)
        .map(|s| s.id)
}

/// The name the CLI gave a session once the first exchange settles it; the
/// placeholder each one shows before that is not a name.
pub fn title(provider: &str, id: &str) -> Option<String> {
    let title = match provider {
        "codex" => codex_title(&codex_home()?.join("session_index.jsonl"), id),
        "cursor" => cursor_title(&home()?.join(".cursor/chats"), id),
        "opencode" => opencode_title(&opencode_db()?, id),
        _ => None,
    }?;
    let title = title.trim();
    (!title.is_empty()).then(|| title.to_string())
}

/// Whether anything was said in the terminal session `crew_id` of `provider`,
/// run in `cwd`. A provider Crew cannot read counts as having spoken, so its
/// sessions are never taken for empty.
pub fn has_conversation(provider: &str, crew_id: &str, bound: Option<&str>, cwd: &str) -> bool {
    let Some(home) = home() else { return true };
    match provider {
        "claude" => claude_has_turn(&claude_transcript(&home, cwd, crew_id)),
        "cursor" => bound.is_some_and(|id| cursor_has_conversation(&home.join(".cursor/chats"), id)),
        "codex" | "opencode" => bound.is_some(),
        _ => true,
    }
}

fn claude_transcript(home: &Path, cwd: &str, id: &str) -> PathBuf {
    let slug: String = cwd.chars().map(|c| if c.is_ascii_alphanumeric() { c } else { '-' }).collect();
    home.join(".claude/projects").join(slug).join(format!("{id}.jsonl"))
}

/// Claude writes titles and remote-control records before the first prompt, so
/// a transcript on disk is not yet a conversation.
fn claude_has_turn(transcript: &Path) -> bool {
    let Ok(file) = std::fs::File::open(transcript) else { return false };
    BufReader::new(file)
        .lines()
        .map_while(Result::ok)
        .filter(|line| line.contains("\"user\""))
        .filter_map(|line| serde_json::from_str::<serde_json::Value>(&line).ok())
        .any(|record| record.get("type").and_then(|t| t.as_str()) == Some("user"))
}

/// `create-chat` writes nothing; the TUI writes `hasConversation: false` on
/// open and flips it with the first message.
fn cursor_has_conversation(chats: &Path, id: &str) -> bool {
    if !is_chat_id(id) {
        return false;
    }
    sorted_dirs(chats).into_iter().any(|folder| {
        std::fs::read_to_string(folder.join(id).join("meta.json"))
            .ok()
            .and_then(|meta| serde_json::from_str::<serde_json::Value>(&meta).ok())
            .and_then(|meta| meta.get("hasConversation")?.as_bool())
            .unwrap_or(false)
    })
}

/// Append-only: a `/rename` lands as a later line for the same id.
fn codex_title(index: &Path, id: &str) -> Option<String> {
    let text = std::fs::read_to_string(index).ok()?;
    text.lines()
        .rev()
        .filter(|line| line.contains(id))
        .filter_map(|line| serde_json::from_str::<serde_json::Value>(line).ok())
        .find(|entry| entry.get("id").and_then(|v| v.as_str()) == Some(id))
        .and_then(|entry| entry.get("thread_name")?.as_str().map(str::to_string))
}

/// Chats sit under a folder hashed from the cwd, so the id alone finds them.
fn cursor_title(chats: &Path, id: &str) -> Option<String> {
    if !is_chat_id(id) {
        return None;
    }
    sorted_dirs(chats).into_iter().find_map(|folder| {
        let meta = std::fs::read_to_string(folder.join(id).join("meta.json")).ok()?;
        let value: serde_json::Value = serde_json::from_str(&meta).ok()?;
        value.get("title")?.as_str().map(str::to_string)
    })
}

fn opencode_title(db: &Path, id: &str) -> Option<String> {
    if !db.exists() {
        return None;
    }
    let conn = Connection::open_with_flags(db, OpenFlags::SQLITE_OPEN_READ_ONLY).ok()?;
    conn.busy_timeout(Duration::from_millis(500)).ok()?;
    let title: String = conn
        .query_row("SELECT title FROM session WHERE id = ?1", params![id], |row| row.get(0))
        .ok()?;
    (!title.starts_with("New session - ")).then_some(title)
}

#[derive(Debug)]
struct Found {
    id: String,
    cwd: String,
    created_ms: i64,
}

fn canonical(path: &str) -> PathBuf {
    std::fs::canonicalize(path).unwrap_or_else(|_| PathBuf::from(path))
}

fn home() -> Option<PathBuf> {
    std::env::var("HOME").ok().filter(|h| !h.is_empty()).map(PathBuf::from)
}

fn codex_home() -> Option<PathBuf> {
    match std::env::var("CODEX_HOME") {
        Ok(dir) if !dir.is_empty() => Some(PathBuf::from(dir)),
        _ => home().map(|h| h.join(".codex")),
    }
}

fn opencode_db() -> Option<PathBuf> {
    let data = match std::env::var("XDG_DATA_HOME") {
        Ok(dir) if !dir.is_empty() => PathBuf::from(dir),
        _ => home()?.join(".local/share"),
    };
    Some(data.join("opencode/opencode.db"))
}

/// Rollouts live at `sessions/YYYY/MM/DD/rollout-*.jsonl`, and the first line
/// is the session's meta. Only interactive ones count: Crew's own agent turns
/// run `codex exec` in the same folders.
fn codex_sessions(codex_home: &Path, since_ms: i64) -> Vec<Found> {
    let mut found = Vec::new();
    for day in latest_day_dirs(&codex_home.join("sessions")) {
        let Ok(entries) = std::fs::read_dir(&day) else { continue };
        for entry in entries.flatten() {
            let path = entry.path();
            if path.extension().and_then(|e| e.to_str()) != Some("jsonl") {
                continue;
            }
            let Some(created_ms) = born_ms(&path) else { continue };
            if created_ms < since_ms {
                continue;
            }
            if let Some(meta) = codex_meta(&path) {
                found.push(Found { created_ms, ..meta });
            }
        }
    }
    found
}

fn latest_day_dirs(root: &Path) -> Vec<PathBuf> {
    let mut days = Vec::new();
    for year in sorted_dirs(root) {
        for month in sorted_dirs(&year) {
            days.extend(sorted_dirs(&month));
        }
    }
    days.into_iter().rev().take(CODEX_DAYS).collect()
}

fn sorted_dirs(dir: &Path) -> Vec<PathBuf> {
    let mut dirs: Vec<PathBuf> = std::fs::read_dir(dir)
        .map(|entries| entries.flatten().map(|e| e.path()).filter(|p| p.is_dir()).collect())
        .unwrap_or_default();
    dirs.sort();
    dirs
}

fn born_ms(path: &Path) -> Option<i64> {
    let meta = std::fs::metadata(path).ok()?;
    let at = meta.created().or_else(|_| meta.modified()).ok()?;
    Some(at.duration_since(UNIX_EPOCH).ok()?.as_millis() as i64)
}

fn codex_meta(path: &Path) -> Option<Found> {
    let mut line = String::new();
    BufReader::new(std::fs::File::open(path).ok()?).read_line(&mut line).ok()?;
    parse_codex_meta(&line)
}

fn parse_codex_meta(line: &str) -> Option<Found> {
    let value: serde_json::Value = serde_json::from_str(line).ok()?;
    if value.get("type")?.as_str()? != "session_meta" {
        return None;
    }
    let payload = value.get("payload")?;
    if payload.get("source").and_then(|s| s.as_str()) != Some("cli") {
        return None;
    }
    Some(Found {
        id: payload.get("id")?.as_str()?.to_string(),
        cwd: payload.get("cwd")?.as_str()?.to_string(),
        created_ms: 0,
    })
}

fn opencode_sessions(db: &Path, since_ms: i64) -> Vec<Found> {
    let query = || -> rusqlite::Result<Vec<Found>> {
        let conn = Connection::open_with_flags(db, OpenFlags::SQLITE_OPEN_READ_ONLY)?;
        conn.busy_timeout(Duration::from_millis(500))?;
        let mut stmt = conn.prepare(
            "SELECT id, directory, time_created FROM session
             WHERE parent_id IS NULL AND time_created >= ?1",
        )?;
        let rows = stmt.query_map(params![since_ms], |row| {
            Ok(Found {
                id: row.get(0)?,
                cwd: row.get(1)?,
                created_ms: row.get(2)?,
            })
        })?;
        rows.collect()
    };
    if !db.exists() {
        return Vec::new();
    }
    query().unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_dir(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("crew-provider-session-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn codex_meta_keeps_interactive_sessions_only() {
        let tui = r#"{"type":"session_meta","payload":{"id":"a","cwd":"/w","source":"cli"}}"#;
        let exec = r#"{"type":"session_meta","payload":{"id":"b","cwd":"/w","source":"exec"}}"#;
        assert_eq!(parse_codex_meta(tui).map(|f| f.id).as_deref(), Some("a"));
        assert!(parse_codex_meta(exec).is_none());
        assert!(parse_codex_meta(r#"{"type":"event"}"#).is_none());
    }

    #[test]
    fn codex_discovery_skips_claimed_and_other_folders() {
        let root = temp_dir("codex");
        let work = root.join("work");
        std::fs::create_dir_all(&work).unwrap();
        let day = root.join("sessions/2026/09/22");
        std::fs::create_dir_all(&day).unwrap();
        let write = |file: &str, id: &str, cwd: &Path| {
            let meta = serde_json::json!({
                "type": "session_meta",
                "payload": { "id": id, "cwd": cwd, "source": "cli" }
            });
            std::fs::write(day.join(file), format!("{meta}\n")).unwrap();
        };
        write("rollout-1.jsonl", "taken", &work);
        write("rollout-2.jsonl", "elsewhere", &root);
        write("rollout-3.jsonl", "mine", &work);

        let found = codex_sessions(&root, 0);
        let pick = found
            .into_iter()
            .filter(|s| canonical(&s.cwd) == canonical(work.to_str().unwrap()))
            .filter(|s| s.id != "taken")
            .map(|s| s.id)
            .collect::<Vec<_>>();
        assert_eq!(pick, vec!["mine".to_string()]);
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn opencode_discovery_reads_root_sessions_since() {
        let root = temp_dir("opencode");
        let db = root.join("opencode.db");
        let conn = Connection::open(&db).unwrap();
        conn.execute_batch(
            "CREATE TABLE session (id TEXT, parent_id TEXT, directory TEXT, time_created INTEGER);
             INSERT INTO session VALUES ('old', NULL, '/w', 10);
             INSERT INTO session VALUES ('child', 'new', '/w', 30);
             INSERT INTO session VALUES ('new', NULL, '/w', 20);",
        )
        .unwrap();
        drop(conn);
        let ids: Vec<String> = opencode_sessions(&db, 15).into_iter().map(|s| s.id).collect();
        assert_eq!(ids, vec!["new".to_string()]);
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn codex_title_takes_the_latest_name_for_the_id() {
        let root = temp_dir("codex-title");
        let index = root.join("session_index.jsonl");
        std::fs::write(
            &index,
            [
                r#"{"id":"a","thread_name":"First"}"#,
                r#"{"id":"b","thread_name":"Other"}"#,
                r#"{"id":"a","thread_name":"Renamed"}"#,
            ]
            .join("\n"),
        )
        .unwrap();
        assert_eq!(codex_title(&index, "a").as_deref(), Some("Renamed"));
        assert_eq!(codex_title(&index, "missing"), None);
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn cursor_title_finds_the_chat_in_any_folder() {
        let root = temp_dir("cursor-title");
        let chat = root.join("0eaad84c/5e047119-f117");
        std::fs::create_dir_all(&chat).unwrap();
        std::fs::write(chat.join("meta.json"), r#"{"title":"Spanish Project"}"#).unwrap();
        std::fs::create_dir_all(root.join("0eaad84c/untitled")).unwrap();
        std::fs::write(root.join("0eaad84c/untitled/meta.json"), r#"{"hasConversation":false}"#).unwrap();
        assert_eq!(cursor_title(&root, "5e047119-f117").as_deref(), Some("Spanish Project"));
        assert_eq!(cursor_title(&root, "untitled"), None);
        assert_eq!(cursor_title(&root, "../escape"), None);
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn opencode_title_skips_the_placeholder() {
        let root = temp_dir("opencode-title");
        let db = root.join("opencode.db");
        let conn = Connection::open(&db).unwrap();
        conn.execute_batch(
            "CREATE TABLE session (id TEXT, title TEXT);
             INSERT INTO session VALUES ('named', 'Friendly greeting');
             INSERT INTO session VALUES ('fresh', 'New session - 2026-09-17T17:59:15.722Z');",
        )
        .unwrap();
        drop(conn);
        assert_eq!(opencode_title(&db, "named").as_deref(), Some("Friendly greeting"));
        assert_eq!(opencode_title(&db, "fresh"), None);
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn a_claude_transcript_of_records_alone_is_no_conversation() {
        let root = temp_dir("claude-turn");
        let transcript = claude_transcript(&root, "/Users/me/my.app", "s");
        assert!(transcript.ends_with(".claude/projects/-Users-me-my-app/s.jsonl"));
        assert!(!claude_has_turn(&transcript));
        std::fs::create_dir_all(transcript.parent().unwrap()).unwrap();
        std::fs::write(
            &transcript,
            [
                r#"{"type":"bridge-session","sessionId":"s"}"#,
                r#"{"type":"ai-title","aiTitle":"About the \"user\" table"}"#,
            ]
            .join("\n"),
        )
        .unwrap();
        assert!(!claude_has_turn(&transcript));
        let mut text = std::fs::read_to_string(&transcript).unwrap();
        text.push_str("\n{\"type\":\"user\",\"message\":{\"role\":\"user\",\"content\":\"hi\"}}\n");
        std::fs::write(&transcript, text).unwrap();
        assert!(claude_has_turn(&transcript));
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn a_cursor_chat_counts_once_its_meta_says_so() {
        let root = temp_dir("cursor-conversation");
        let write = |id: &str, meta: &str| {
            let chat = root.join("0eaad84c").join(id);
            std::fs::create_dir_all(&chat).unwrap();
            std::fs::write(chat.join("meta.json"), meta).unwrap();
        };
        write("spoken", r#"{"hasConversation":true}"#);
        write("opened", r#"{"hasConversation":false}"#);
        assert!(cursor_has_conversation(&root, "spoken"));
        assert!(!cursor_has_conversation(&root, "opened"));
        assert!(!cursor_has_conversation(&root, "reserved"));
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn claude_bind_reads_the_hook_payload() {
        let payload = r#"{"session_id":"60eb4dd5-1c2a","transcript_path":"/t.jsonl","source":"clear"}"#;
        assert_eq!(parse_claude_bind(payload).as_deref(), Some("60eb4dd5-1c2a"));
        assert_eq!(parse_claude_bind(r#"{"session_id":"../x"}"#), None);
        assert_eq!(parse_claude_bind(r#"{"session_id":"60eb"#), None);
    }

    #[test]
    fn claude_attention_reads_the_hook_message() {
        let payload = r#"{"hook_event_name":"Notification","message":"Claude needs your permission","notification_type":"permission_prompt"}"#;
        assert_eq!(parse_claude_attention(payload), "Claude needs your permission");
        assert_eq!(parse_claude_attention(r#"{"message":"  "}"#), "Needs your input");
        assert_eq!(parse_claude_attention("{\"mess"), "Needs your input");
    }

    #[test]
    fn chat_ids_are_plain_tokens() {
        assert!(is_chat_id("5e047119-f117-40d3-9552-3c77cfffe071"));
        assert!(!is_chat_id(""));
        assert!(!is_chat_id("Error: not logged in"));
    }
}
