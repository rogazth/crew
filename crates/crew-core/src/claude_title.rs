use serde_json::Value;
use std::fs::File;
use std::io::{Read, Seek, SeekFrom};

/// Claude Code rewrites the name on every turn, and across 399 transcripts the
/// newest pair never sat more than 32 KB from the end.
const TAIL_BYTES: u64 = 256 * 1024;

/// The name Claude Code gave a session, read off the transcript it keeps under
/// ~/.claude/projects. A `/rename` (`custom-title`) outranks the model's own
/// `ai-title` however late the model revised it.
pub fn read(path: &str) -> Option<String> {
    let mut file = File::open(path).ok()?;
    let len = file.metadata().ok()?.len();
    let clipped = len > TAIL_BYTES;
    if clipped {
        file.seek(SeekFrom::Start(len - TAIL_BYTES)).ok()?;
    }
    let mut bytes = Vec::new();
    file.read_to_end(&mut bytes).ok()?;
    Some(scan(&String::from_utf8_lossy(&bytes), clipped)).flatten()
}

/// Where Claude Code keeps a conversation, observed from ~/.claude/projects.
/// Claude is JavaScript and replaces each UTF-16 unit, so a character outside
/// the BMP becomes two dashes.
pub fn transcript_path(cwd: &str, session_id: &str) -> Option<String> {
    let home = std::env::var("HOME").ok().filter(|h| !h.is_empty())?;
    let mut slug = String::with_capacity(cwd.len());
    for c in cwd.chars() {
        if c.is_ascii_alphanumeric() {
            slug.push(c);
        } else {
            slug.extend(std::iter::repeat_n('-', c.len_utf16()));
        }
    }
    Some(format!("{}/.claude/projects/{slug}/{session_id}.jsonl", home.trim_end_matches('/')))
}

fn scan(tail: &str, clipped: bool) -> Option<String> {
    let mut lines = tail.lines();
    // The seek lands inside a record, and half a line is not parseable JSON.
    if clipped {
        lines.next();
    }
    let mut custom = None;
    let mut generated = None;
    for line in lines {
        if !line.contains("-title") {
            continue;
        }
        let Ok(record) = serde_json::from_str::<Value>(line) else {
            continue;
        };
        match record.get("type").and_then(Value::as_str) {
            Some("custom-title") => custom = text(&record, "customTitle").or(custom),
            Some("ai-title") => generated = text(&record, "aiTitle").or(generated),
            _ => {}
        }
    }
    custom.or(generated)
}

fn text(record: &Value, key: &str) -> Option<String> {
    let value = record.get(key)?.as_str()?.trim();
    (!value.is_empty()).then(|| value.to_string())
}

#[cfg(test)]
mod tests {
    use super::{read, scan, transcript_path, TAIL_BYTES};
    use crate::test_support::temp_dir;

    #[test]
    fn transcript_slug_matches_claude() {
        let path = transcript_path("/Users/me/my repo.v2", "abc").unwrap();
        assert!(path.ends_with("/.claude/projects/-Users-me-my-repo-v2/abc.jsonl"), "{path}");
        let emoji = transcript_path("/a😀", "abc").unwrap();
        assert!(emoji.ends_with("/-a--/abc.jsonl"), "{emoji}");
    }

    #[test]
    fn a_rename_outranks_the_generated_name() {
        let tail = r#"{"type":"ai-title","aiTitle":"Generated"}
{"type":"custom-title","customTitle":"Mine"}
{"type":"ai-title","aiTitle":"Revised"}"#;
        assert_eq!(scan(tail, false).as_deref(), Some("Mine"));
    }

    #[test]
    fn the_newest_generated_name_wins() {
        let tail = r#"{"type":"user","message":{"role":"user"}}
{"type":"ai-title","aiTitle":"First"}
{"type":"ai-title","aiTitle":"Second"}"#;
        assert_eq!(scan(tail, false).as_deref(), Some("Second"));
    }

    #[test]
    fn an_empty_name_is_not_a_name() {
        let tail = r#"{"type":"ai-title","aiTitle":"Kept"}
{"type":"custom-title","customTitle":"   "}"#;
        assert_eq!(scan(tail, false).as_deref(), Some("Kept"));
    }

    #[test]
    fn the_clipped_first_line_is_dropped() {
        let tail = r#"aiTitle":"Half a record"}
{"type":"ai-title","aiTitle":"Whole"}"#;
        assert_eq!(scan(tail, true).as_deref(), Some("Whole"));
    }

    #[test]
    fn a_transcript_without_a_name_has_none() {
        assert_eq!(scan(r#"{"type":"user","message":{}}"#, false), None);
    }

    #[test]
    fn the_name_is_read_off_the_transcript_file() {
        let dir = temp_dir();
        let path = dir.path().join("s.jsonl");
        std::fs::write(
            &path,
            [
                r#"{"type":"user","message":{"content":"rename the page-title"}}"#,
                r#"{"type":"ai-title","aiTitle":"  Page titles  "}"#,
                r#"{"type":"assistant","message":{"content":"done"}}"#,
            ]
            .join("\n"),
        )
        .unwrap();
        assert_eq!(read(path.to_str().unwrap()).as_deref(), Some("Page titles"));
    }

    #[test]
    fn a_missing_transcript_has_no_name() {
        let dir = temp_dir();
        assert_eq!(read(dir.path().join("nope.jsonl").to_str().unwrap()), None);
    }

    #[test]
    fn a_record_cut_off_mid_write_is_skipped() {
        let dir = temp_dir();
        let path = dir.path().join("s.jsonl");
        std::fs::write(
            &path,
            "{\"type\":\"ai-title\",\"aiTitle\":\"Settled\"}\n{\"type\":\"custom-title\",\"customTitle\":\"Half",
        )
        .unwrap();
        assert_eq!(read(path.to_str().unwrap()).as_deref(), Some("Settled"));
    }

    #[test]
    fn only_the_tail_of_a_long_transcript_is_read() {
        let dir = temp_dir();
        let path = dir.path().join("s.jsonl");
        let filler = format!("{{\"type\":\"user\",\"message\":\"{}\"}}\n", "x".repeat(1000));
        let mut text = String::from("{\"type\":\"custom-title\",\"customTitle\":\"Too far back\"}\n");
        while (text.len() as u64) < TAIL_BYTES + 4096 {
            text.push_str(&filler);
        }
        text.push_str("{\"type\":\"ai-title\",\"aiTitle\":\"Recent\"}\n");
        std::fs::write(&path, &text).unwrap();
        // The rename would outrank this name if the whole file were read.
        assert_eq!(read(path.to_str().unwrap()).as_deref(), Some("Recent"));
    }
}
