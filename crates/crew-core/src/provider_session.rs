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
    fn chat_ids_are_plain_tokens() {
        assert!(is_chat_id("5e047119-f117-40d3-9552-3c77cfffe071"));
        assert!(!is_chat_id(""));
        assert!(!is_chat_id("Error: not logged in"));
    }
}
