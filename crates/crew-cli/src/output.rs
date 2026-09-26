//! How answers are printed for a person: compact aligned tables, and tool
//! content as it came, with images put in files since a terminal cannot show
//! them. `--json` skips all of this.

use std::io::IsTerminal;
use std::path::{Path, PathBuf};

use base64::Engine;
use serde_json::Value;

/// One line (or several) to stdout. A reader that went away — `crew logs -f |
/// head` — ends the run quietly instead of panicking the way `println!` does.
pub fn say(text: &str) {
    use std::io::Write;
    let mut out = std::io::stdout().lock();
    if writeln!(out, "{text}").and_then(|_| out.flush()).is_err() {
        std::process::exit(0);
    }
}

/// Pretty JSON to stdout, for `--json`.
pub fn say_json(value: &Value) {
    say(&serde_json::to_string_pretty(value).unwrap_or_else(|_| value.to_string()));
}

/// Bold headers only for a person at a terminal that has not asked for none.
pub fn styled() -> bool {
    std::io::stdout().is_terminal() && std::env::var_os("NO_COLOR").is_none()
}

pub struct Table {
    pub headers: Vec<String>,
    pub rows: Vec<Vec<String>>,
}

impl Table {
    /// Columns two spaces apart, the last one not padded so a long command or
    /// URL does not drag trailing blanks behind it.
    pub fn render(&self, styled: bool) -> String {
        let columns = self.headers.len();
        let mut widths: Vec<usize> = self.headers.iter().map(|header| width(header)).collect();
        for row in &self.rows {
            for (index, cell) in row.iter().enumerate().take(columns) {
                widths[index] = widths[index].max(width(cell));
            }
        }
        let line = |cells: &[String]| {
            let mut out = String::new();
            for (index, cell) in cells.iter().enumerate().take(columns) {
                out.push_str(cell);
                if index + 1 < columns {
                    out.push_str(&" ".repeat(widths[index] - width(cell) + 2));
                }
            }
            out.trim_end().to_string()
        };
        let mut out = Vec::with_capacity(self.rows.len() + 1);
        let header = line(&self.headers);
        out.push(if styled { format!("\x1b[1m{header}\x1b[0m") } else { header });
        out.extend(self.rows.iter().map(|row| line(row)));
        out.join("\n")
    }
}

fn width(text: &str) -> usize {
    text.chars().count()
}

/// A column of a table built from JSON rows: the first key a row has wins, so
/// one table reads a field under either of the names it has gone by.
pub struct Column {
    pub header: &'static str,
    pub keys: &'static [&'static str],
    pub format: fn(&Value) -> String,
}

impl Column {
    pub const fn new(header: &'static str, keys: &'static [&'static str]) -> Self {
        Self { header, keys, format: cell }
    }

    pub const fn with(header: &'static str, keys: &'static [&'static str], format: fn(&Value) -> String) -> Self {
        Self { header, keys, format }
    }

    fn value<'a>(&self, row: &'a Value) -> Option<&'a Value> {
        self.keys.iter().find_map(|key| row.get(*key)).filter(|value| !value.is_null())
    }
}

/// Only the columns some row has a value for: a tool that does not report
/// ports yet gets no empty PORTS column.
pub fn table(rows: &[Value], columns: &[Column]) -> Table {
    let shown: Vec<&Column> = columns.iter().filter(|column| rows.iter().any(|row| column.value(row).is_some())).collect();
    Table {
        headers: shown.iter().map(|column| column.header.to_string()).collect(),
        rows: rows
            .iter()
            .map(|row| shown.iter().map(|column| column.value(row).map_or_else(|| "-".to_string(), column.format)).collect())
            .collect(),
    }
}

/// The rows of a listing, whether a tool answers with the array itself or
/// wraps it in an object under one of `keys`.
pub fn rows<'a>(value: &'a Value, keys: &[&str]) -> Option<&'a Vec<Value>> {
    value.as_array().or_else(|| keys.iter().find_map(|key| value.get(*key).and_then(Value::as_array)))
}

pub fn cell(value: &Value) -> String {
    match value {
        Value::Null => "-".into(),
        Value::String(text) => one_line(text),
        Value::Bool(true) => "yes".into(),
        Value::Bool(false) => "no".into(),
        Value::Array(items) if items.is_empty() => "-".into(),
        Value::Array(items) => items.iter().map(cell).collect::<Vec<_>>().join(", "),
        other => other.to_string(),
    }
}

/// A table cell is one line; a description with paragraphs is cut at the first.
fn one_line(text: &str) -> String {
    let first = text.lines().next().unwrap_or("");
    if text.lines().nth(1).is_some() {
        format!("{first} …")
    } else {
        first.to_string()
    }
}

/// `42s`, `5m`, `2h10m`, `3d4h`: an uptime read at a glance.
pub fn duration(secs: u64) -> String {
    match secs {
        0..=59 => format!("{secs}s"),
        60..=3599 => format!("{}m", secs / 60),
        3600..=86_399 => match (secs % 3600) / 60 {
            0 => format!("{}h", secs / 3600),
            minutes => format!("{}h{minutes}m", secs / 3600),
        },
        _ => match (secs % 86_400) / 3600 {
            0 => format!("{}d", secs / 86_400),
            hours => format!("{}d{hours}h", secs / 86_400),
        },
    }
}

/// Key and value, aligned, for a status report.
pub fn pairs(rows: &[(&str, String)]) -> String {
    let wide = rows.iter().map(|(key, _)| width(key)).max().unwrap_or(0);
    rows.iter()
        .map(|(key, value)| format!("{key}{}  {value}", " ".repeat(wide - width(key))).trim_end().to_string())
        .collect::<Vec<_>>()
        .join("\n")
}

/// Tool content as a person reads it: text as it is, an image as the path of
/// the file it was saved to. Anything else is shown as the JSON it was, rather
/// than dropped.
pub fn content(blocks: &[Value], images: &Path, stem: &str) -> Vec<String> {
    let mut out = Vec::new();
    let mut saved = 0;
    for block in blocks {
        match block.get("type").and_then(Value::as_str) {
            Some("text") => out.push(block.get("text").and_then(Value::as_str).unwrap_or("").to_string()),
            Some("image") => {
                saved += 1;
                out.push(match save_image(images, block, &format!("{stem}-{saved}")) {
                    Ok(path) => path.to_string_lossy().into_owned(),
                    Err(error) => format!("(image not saved: {error})"),
                });
            }
            Some("resource") => match block.pointer("/resource/text").and_then(Value::as_str) {
                Some(text) => out.push(text.to_string()),
                None => out.push(block.to_string()),
            },
            _ => out.push(block.to_string()),
        }
    }
    out
}

/// Where images from tool calls go: the temp dir, which on macOS is the
/// user's own and is cleared by the system.
pub fn image_dir() -> PathBuf {
    std::env::temp_dir().join("crew-images")
}

/// Decoded into `dir` under `stem` with the extension its type says.
pub fn save_image(dir: &Path, block: &Value, stem: &str) -> Result<PathBuf, String> {
    let data = block.get("data").and_then(Value::as_str).ok_or("no data")?;
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(data.trim())
        .map_err(|e| format!("bad base64: {e}"))?;
    let mime = block.get("mimeType").and_then(Value::as_str).unwrap_or("");
    let extension = match mime {
        "image/png" => "png",
        "image/jpeg" | "image/jpg" => "jpg",
        "image/gif" => "gif",
        "image/webp" => "webp",
        "image/svg+xml" => "svg",
        _ => "bin",
    };
    std::fs::create_dir_all(dir).map_err(|e| format!("{}: {e}", dir.display()))?;
    let path = dir.join(format!("{stem}.{extension}"));
    std::fs::write(&path, bytes).map_err(|e| format!("{}: {e}", path.display()))?;
    Ok(path)
}

/// A name no other call's images share: the tool, then the time.
pub fn image_stem(tool: &str) -> String {
    let millis = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|elapsed| elapsed.as_millis())
        .unwrap_or(0);
    let tool: String = tool.chars().map(|c| if c.is_ascii_alphanumeric() || c == '_' { c } else { '-' }).collect();
    format!("{tool}-{millis}-{}", std::process::id())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn a_table_aligns_its_columns_and_leaves_the_last_unpadded() {
        let table = Table {
            headers: vec!["NAME".into(), "STATE".into(), "COMMAND".into()],
            rows: vec![
                vec!["web".into(), "running".into(), "npm run dev".into()],
                vec!["database".into(), "-".into(), "".into()],
            ],
        };
        assert_eq!(
            table.render(false),
            "NAME      STATE    COMMAND\nweb       running  npm run dev\ndatabase  -"
        );
        assert!(table.render(true).starts_with("\x1b[1mNAME"));
    }

    #[test]
    fn a_table_from_rows_drops_the_columns_nobody_has() {
        let rows = vec![
            json!({ "name": "web", "state": "running", "pid": 42, "ports": [3000, 3001] }),
            json!({ "name": "db", "status": "stopped", "pid": null }),
        ];
        let columns = [
            Column::new("NAME", &["name"]),
            Column::new("STATE", &["state", "status"]),
            Column::new("PID", &["pid"]),
            Column::new("PORTS", &["ports"]),
            Column::new("UPTIME", &["uptime"]),
        ];
        let table = table(&rows, &columns);
        assert_eq!(table.headers, ["NAME", "STATE", "PID", "PORTS"]);
        assert_eq!(table.rows[0], ["web", "running", "42", "3000, 3001"]);
        assert_eq!(table.rows[1], ["db", "stopped", "-", "-"]);
    }

    #[test]
    fn rows_come_bare_or_wrapped() {
        let bare = json!([{ "a": 1 }]);
        let wrapped = json!({ "processes": [{ "a": 1 }] });
        assert_eq!(rows(&bare, &["processes"]).map(Vec::len), Some(1));
        assert_eq!(rows(&wrapped, &["processes"]).map(Vec::len), Some(1));
        assert!(rows(&json!({ "text": "x" }), &["processes"]).is_none());
    }

    #[test]
    fn cells_are_one_line() {
        assert_eq!(cell(&json!("first\nsecond")), "first …");
        assert_eq!(cell(&json!(true)), "yes");
        assert_eq!(cell(&json!([])), "-");
        assert_eq!(cell(&json!(null)), "-");
    }

    #[test]
    fn durations_read_at_a_glance() {
        assert_eq!(duration(42), "42s");
        assert_eq!(duration(300), "5m");
        assert_eq!(duration(7200), "2h");
        assert_eq!(duration(7800), "2h10m");
        assert_eq!(duration(86_400 * 3 + 3600 * 4), "3d4h");
    }

    #[test]
    fn pairs_align_their_keys() {
        assert_eq!(pairs(&[("daemon", "running".into()), ("data dir", "/d".into())]), "daemon    running\ndata dir  /d");
    }

    #[test]
    fn images_are_saved_and_their_path_printed_where_they_were() {
        let dir = std::env::temp_dir().join(format!("crew-cli-img-{}", std::process::id()));
        let png = base64::engine::general_purpose::STANDARD.encode(b"\x89PNG fake");
        let blocks = vec![
            json!({ "type": "text", "text": "before" }),
            json!({ "type": "image", "data": png, "mimeType": "image/png" }),
            json!({ "type": "image", "data": "!!", "mimeType": "image/png" }),
            json!({ "type": "text", "text": "after" }),
        ];
        let out = content(&blocks, &dir, "shot");
        assert_eq!(out[0], "before");
        let path = PathBuf::from(&out[1]);
        assert_eq!(path, dir.join("shot-1.png"));
        assert_eq!(std::fs::read(&path).expect("saved"), b"\x89PNG fake");
        assert!(out[2].starts_with("(image not saved: bad base64"), "{}", out[2]);
        assert_eq!(out[3], "after");
    }

    #[test]
    fn an_image_takes_the_extension_of_its_type() {
        let dir = std::env::temp_dir().join(format!("crew-cli-ext-{}", std::process::id()));
        let data = base64::engine::general_purpose::STANDARD.encode(b"x");
        let jpeg = save_image(&dir, &json!({ "data": data, "mimeType": "image/jpeg" }), "a").expect("jpeg");
        assert_eq!(jpeg.extension().and_then(|e| e.to_str()), Some("jpg"));
        let odd = save_image(&dir, &json!({ "data": data, "mimeType": "application/x-thing" }), "b").expect("odd");
        assert_eq!(odd.extension().and_then(|e| e.to_str()), Some("bin"));
        assert!(save_image(&dir, &json!({ "mimeType": "image/png" }), "c").is_err());
    }

    #[test]
    fn other_blocks_are_shown_not_dropped() {
        let dir = std::env::temp_dir();
        let out = content(
            &[json!({ "type": "resource", "resource": { "uri": "x", "text": "body" } }), json!({ "type": "audio" })],
            &dir,
            "s",
        );
        assert_eq!(out, ["body".to_string(), r#"{"type":"audio"}"#.to_string()]);
    }

    #[test]
    fn image_stems_are_safe_file_names() {
        let stem = image_stem("browser/screenshot");
        assert!(stem.starts_with("browser-screenshot-"), "{stem}");
    }
}
