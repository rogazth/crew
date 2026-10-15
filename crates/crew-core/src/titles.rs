//! Names for the sessions their provider leaves unnamed under Crew. Claude
//! names a conversation in stream-json only when asked, and Codex's
//! app-server never does: their terminals did, which Crew no longer runs.
//! Both are asked of the provider's cheapest model, outside the conversation,
//! which gains no message. The name lands where the provider keeps its own,
//! for `session::sync_title` to adopt like any other.

use std::fs::{File, OpenOptions};
use std::io::{BufRead, BufReader, Write};
use std::path::Path;
use std::process::{Child, Command, Stdio};
use std::thread;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use crew_protocol::HarnessEvent;
use serde_json::{json, Value};

use crate::providers::claude::{build_control_request, parse_control_response};
use crate::session_history::{Decoded, Decoder, MAX_RECORD_BYTES};
use crate::shell_path;

/// The model Codex names a thread with: its cheapest.
pub const CODEX_MODEL: &str = "gpt-6-luna";
/// The model a Claude CLI asked for a name runs on. The name itself comes
/// from the CLI's own small model; this keeps the process from loading more.
const CLAUDE_MODEL: &str = "haiku";
/// The start of the first message says what a conversation is about.
const DESCRIPTION_CHARS: usize = 2000;
const TIMEOUT: Duration = Duration::from_secs(60);
/// How long a CLI that answered gets to write what it holds and exit.
const EXIT_GRACE: Duration = Duration::from_secs(10);

/// What the user said first in a provider's session file, as the chat shows
/// it: what the provider injects is left out by the decoder.
pub fn first_message<D: Decoder + Default>(path: &Path) -> Option<String> {
    let mut decoder = D::default();
    for raw in BufReader::new(File::open(path).ok()?).split(b'\n') {
        let raw = raw.ok()?;
        if raw.len() > MAX_RECORD_BYTES {
            continue;
        }
        for decoded in decoder.decode(&String::from_utf8_lossy(&raw)) {
            if let Decoded::Event { event: HarnessEvent::UserMessage { text, hidden, .. }, .. } = decoded {
                let text = text.trim();
                if hidden != Some(true) && !text.is_empty() {
                    return Some(text.chars().take(DESCRIPTION_CHARS).collect());
                }
            }
        }
    }
    None
}

/// What asks a live Claude CLI to name its conversation after `description`.
/// With `persist` the name goes into its transcript as an `ai-title`.
pub fn claude_request(description: &str) -> Value {
    json!({ "subtype": "generate_session_title", "description": description, "persist": true })
}

/// Has a Claude CLI name conversation `id`, which it resumes in `cwd` only to
/// be asked: no message goes in, and it reads none of the user's settings or
/// MCP servers. Returns the name it wrote into the transcript.
pub fn name_claude(binary: &Path, cwd: &Path, id: &str, description: &str) -> Result<String, String> {
    let mut child = Command::new(binary)
        .args([
            "-p",
            "--input-format",
            "stream-json",
            "--output-format",
            "stream-json",
            "--verbose",
            "--resume",
            id,
            "--model",
            CLAUDE_MODEL,
            "--setting-sources",
            "",
            "--strict-mcp-config",
        ])
        .env("PATH", shell_path::joined())
        .current_dir(cwd)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .map_err(|e| format!("claude title: {e}"))?;
    let outcome = ask_claude(&mut child, description);
    // Its stdin closed, the CLI writes the name it holds and exits.
    drop(child.stdin.take());
    settle(&mut child, EXIT_GRACE);
    outcome
}

fn ask_claude(child: &mut Child, description: &str) -> Result<String, String> {
    let (Some(stdin), Some(stdout)) = (child.stdin.as_mut(), child.stdout.take()) else {
        return Err("claude title: no pipes".into());
    };
    for (id, request) in [("1", json!({ "subtype": "initialize" })), ("2", claude_request(description))] {
        writeln!(stdin, "{}", build_control_request(id, request))
            .and_then(|_| stdin.flush())
            .map_err(|e| format!("claude title: {e}"))?;
    }
    let (tx, rx) = std::sync::mpsc::channel();
    thread::spawn(move || {
        for line in BufReader::new(stdout).lines().map_while(Result::ok) {
            if tx.send(line).is_err() {
                break;
            }
        }
    });
    let deadline = Instant::now() + TIMEOUT;
    loop {
        let line = rx
            .recv_timeout(deadline.saturating_duration_since(Instant::now()))
            .map_err(|_| "claude title: no answer".to_string())?;
        let Ok(Value::Object(record)) = serde_json::from_str::<Value>(&line) else { continue };
        match parse_control_response(&record) {
            Some((id, answer)) if id == "2" => {
                return answer?
                    .get("title")
                    .and_then(Value::as_str)
                    .and_then(clean)
                    .ok_or_else(|| "claude title: no name".into())
            }
            _ => {}
        }
    }
}

/// Asks Codex's cheapest model for a name for a thread that opened with
/// `description`, in a run of its own that leaves no thread behind
/// (`--ephemeral`) and reads none of the user's config, rules or project docs.
/// Apps and plugins are on by default and bring tools of their own, which a
/// name needs none of. A `-c` Codex does not know is a warning, where
/// `--disable` of an unknown feature fails the run, so a version without
/// either still names.
pub fn codex_name(binary: &Path, description: &str) -> Result<String, String> {
    let dir = crate::paths::tmp("titles");
    std::fs::create_dir_all(&dir).map_err(|e| format!("codex title: {e}"))?;
    let instructions = dir.join("instructions.md");
    std::fs::write(&instructions, "You write short titles for chats.\n").map_err(|e| format!("codex title: {e}"))?;
    let instructions = serde_json::to_string(&instructions.to_string_lossy()).unwrap_or_default();
    let mut child = Command::new(binary)
        .args(["exec", "--ephemeral", "--skip-git-repo-check", "--ignore-user-config", "--ignore-rules"])
        .args(["-s", "read-only", "-m", CODEX_MODEL, "--json"])
        .args(["-c", "model_reasoning_effort=\"low\"", "-c", "tools.web_search=false", "-c", "project_doc_max_bytes=0"])
        .args(["-c", "features.apps=false", "-c", "features.plugins=false"])
        .args(["-c", &format!("model_instructions_file={instructions}")])
        .arg(title_prompt(description))
        .env("PATH", shell_path::joined())
        .current_dir(&dir)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .map_err(|e| format!("codex title: {e}"))?;
    let stdout = child.stdout.take().ok_or("codex title: no pipe")?;
    let reader = thread::spawn(move || BufReader::new(stdout).lines().map_while(Result::ok).collect::<Vec<_>>());
    if !settle(&mut child, TIMEOUT) {
        return Err("codex title: no answer".into());
    }
    let lines = reader.join().unwrap_or_default();
    codex_reply(&lines).ok_or_else(|| "codex title: no name".into())
}

/// Names what the chat is about, the way the user would look for it among
/// many: the thing built, fixed or asked, not how they asked for it.
fn title_prompt(description: &str) -> String {
    format!(
        "Name the chat that opens with the message below, so its user can pick it out of a long list later. \
         Say what it is about: the thing being built, fixed, decided or asked. Leave out how the user wants \
         the work done (tools, models, steps, output format). 2 to 6 words, under 40 characters, in the \
         message's language, no quotes and no final period. Reply with the name alone.\n\nMessage:\n{description}"
    )
}

/// The last thing the model said in a `codex exec --json` run.
fn codex_reply(lines: &[String]) -> Option<String> {
    lines
        .iter()
        .filter_map(|line| serde_json::from_str::<Value>(line).ok())
        .filter(|record| record.get("type").and_then(Value::as_str) == Some("item.completed"))
        .filter_map(|record| {
            let item = record.get("item")?;
            (item.get("type")?.as_str()? == "agent_message").then(|| item.get("text")?.as_str().map(str::to_string))?
        })
        .last()
        .and_then(|text| clean(&text))
}

/// Names Codex thread `id` the way its own `thread/name/set` does: a line in
/// `session_index.jsonl`, where the newest line for a thread is its name.
pub fn name_codex(index: &Path, id: &str, name: &str) -> Result<(), String> {
    let line = json!({ "id": id, "thread_name": name, "updated_at": rfc3339(SystemTime::now()) });
    let mut file = OpenOptions::new().create(true).append(true).open(index).map_err(|e| format!("codex title: {e}"))?;
    writeln!(file, "{line}").map_err(|e| format!("codex title: {e}"))
}

/// A name as a sidebar shows it: one line, without the quotes a model may
/// put around it.
fn clean(name: &str) -> Option<String> {
    let line = name.lines().map(str::trim).find(|line| !line.is_empty())?;
    let line = line.trim_matches(|c| matches!(c, '"' | '\'' | '`' | '*' | '#')).trim();
    (!line.is_empty()).then(|| line.chars().take(80).collect())
}

/// Whether the child exited within `limit`; one that did not is killed.
fn settle(child: &mut Child, limit: Duration) -> bool {
    let deadline = Instant::now() + limit;
    while Instant::now() < deadline {
        if let Ok(Some(_)) = child.try_wait() {
            return true;
        }
        thread::sleep(Duration::from_millis(100));
    }
    let _ = child.kill();
    let _ = child.wait();
    false
}

fn rfc3339(at: SystemTime) -> String {
    let secs = at.duration_since(UNIX_EPOCH).map(|d| d.as_secs() as i64).unwrap_or(0);
    let (days, rest) = (secs.div_euclid(86_400), secs.rem_euclid(86_400));
    // Howard Hinnant's days-to-civil.
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let day = doy - (153 * mp + 2) / 5 + 1;
    let month = if mp < 10 { mp + 3 } else { mp - 9 };
    let year = yoe + era * 400 + i64::from(month <= 2);
    format!("{year:04}-{month:02}-{day:02}T{:02}:{:02}:{:02}Z", rest / 3600, rest % 3600 / 60, rest % 60)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::session_history::{claude::ClaudeDecoder, codex::CodexDecoder};

    fn temp(name: &str, lines: &[Value]) -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!("crew-titles-{name}-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("session.jsonl");
        std::fs::write(&path, lines.iter().map(Value::to_string).collect::<Vec<_>>().join("\n")).unwrap();
        path
    }

    #[test]
    fn the_first_message_is_the_users_first_words() {
        let path = temp(
            "claude",
            &[
                json!({ "type": "queue-operation", "operation": "enqueue" }),
                json!({ "type": "user", "isMeta": true, "message": { "role": "user", "content": "<local-command-caveat>x</local-command-caveat>" } }),
                json!({ "type": "user", "message": { "role": "user", "content": [{ "type": "text", "text": "Fix the sidebar" }] } }),
                json!({ "type": "user", "message": { "role": "user", "content": "Later" } }),
            ],
        );
        assert_eq!(first_message::<ClaudeDecoder>(&path).as_deref(), Some("Fix the sidebar"));
        let empty = temp("empty", &[json!({ "type": "queue-operation" })]);
        assert_eq!(first_message::<ClaudeDecoder>(&empty), None);
    }

    #[test]
    fn a_codex_rollouts_first_message_skips_what_codex_injects() {
        let path = temp(
            "codex",
            &[
                json!({ "type": "event_msg", "payload": { "type": "user_message", "message": "<environment_context>cwd</environment_context>" } }),
                json!({ "type": "event_msg", "payload": { "type": "user_message", "message": "Arregla el sidebar" } }),
            ],
        );
        assert_eq!(first_message::<CodexDecoder>(&path).as_deref(), Some("Arregla el sidebar"));
    }

    #[test]
    fn codex_says_its_name_last() {
        let lines = [
            json!({ "type": "thread.started" }),
            json!({ "type": "item.completed", "item": { "type": "reasoning", "text": "thinking" } }),
            json!({ "type": "item.completed", "item": { "type": "agent_message", "text": "\"Arreglar títulos del sidebar\"" } }),
            json!({ "type": "turn.completed" }),
        ]
        .map(|line| line.to_string());
        assert_eq!(codex_reply(&lines).as_deref(), Some("Arreglar títulos del sidebar"));
        assert_eq!(codex_reply(&[]), None);
    }

    #[test]
    fn a_name_is_one_clean_line() {
        assert_eq!(clean("  **Sidebar titles**\nmore").as_deref(), Some("Sidebar titles"));
        assert_eq!(clean(" \n\"\""), None);
    }

    #[test]
    fn codex_reads_the_name_crew_writes() {
        let dir = std::env::temp_dir().join(format!("crew-titles-index-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let index = dir.join("session_index.jsonl");
        let _ = std::fs::remove_file(&index);
        name_codex(&index, "t1", "Sidebar titles").unwrap();
        assert_eq!(crate::provider_session::codex_title(&index, "t1").as_deref(), Some("Sidebar titles"));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn rfc3339_is_utc() {
        assert_eq!(rfc3339(UNIX_EPOCH), "1970-01-01T00:00:00Z");
        assert_eq!(rfc3339(UNIX_EPOCH + Duration::from_secs(1_791_995_400)), "2026-10-14T16:30:00Z");
    }
}
