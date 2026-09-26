//! Reads the `processes` of a `solo.yml`. Only the shape Solo documents, not
//! YAML at large: a map of names to maps of scalars, `env` a map below that.
//! Enough to bring a project's commands over without a YAML dependency.

use std::collections::BTreeMap;

#[derive(Debug, Clone, PartialEq)]
pub struct SoloProcess {
    pub name: String,
    pub command: String,
    pub working_dir: String,
    pub auto_start: bool,
    pub auto_restart: bool,
    pub env: BTreeMap<String, String>,
}

struct Line<'a> {
    indent: usize,
    text: &'a str,
}

pub fn parse(source: &str) -> Result<Vec<SoloProcess>, String> {
    let lines: Vec<Line> = source
        .lines()
        .filter_map(|raw| {
            let text = raw.trim_end();
            let body = text.trim_start();
            if body.is_empty() || body.starts_with('#') {
                return None;
            }
            Some(Line {
                indent: text.len() - body.len(),
                text: body,
            })
        })
        .collect();

    let Some(root) = lines.iter().position(|line| line.indent == 0 && key_of(line.text).0 == "processes") else {
        return Ok(Vec::new());
    };
    let mut out = Vec::new();
    let mut i = root + 1;
    let Some(name_indent) = lines.get(i).map(|line| line.indent).filter(|indent| *indent > 0) else {
        return Ok(out);
    };
    while i < lines.len() && lines[i].indent >= name_indent {
        let line = &lines[i];
        if line.indent != name_indent {
            return Err(format!("solo.yml: unexpected indentation at \"{}\"", line.text));
        }
        let (name, _) = key_of(line.text);
        let mut process = SoloProcess {
            name: name.to_string(),
            command: String::new(),
            working_dir: String::new(),
            // Solo's defaults.
            auto_start: true,
            auto_restart: false,
            env: BTreeMap::new(),
        };
        i += 1;
        while i < lines.len() && lines[i].indent > name_indent {
            let field_indent = lines[i].indent;
            let (key, value) = key_of(lines[i].text);
            i += 1;
            // Whatever sits deeper than the field belongs to it.
            let mut nested = Vec::new();
            while i < lines.len() && lines[i].indent > field_indent {
                nested.push(&lines[i]);
                i += 1;
            }
            match key {
                "command" => process.command = block_or_scalar(value, &nested),
                "working_dir" => process.working_dir = scalar(value),
                "auto_start" => process.auto_start = boolean(value, true),
                "auto_restart" => process.auto_restart = boolean(value, false),
                "env" => {
                    for entry in nested {
                        let (k, v) = key_of(entry.text);
                        process.env.insert(k.to_string(), scalar(v));
                    }
                }
                _ => {}
            }
        }
        if process.command.trim().is_empty() {
            return Err(format!("solo.yml: \"{}\" has no command", process.name));
        }
        out.push(process);
    }
    Ok(out)
}

/// `key: value`, the key unquoted. The value comes back raw.
fn key_of(text: &str) -> (&str, &str) {
    for quote in ['"', '\''] {
        if let Some(rest) = text.strip_prefix(quote) {
            if let Some(end) = rest.find(quote) {
                let after = rest[end + 1..].trim_start();
                return (&rest[..end], after.strip_prefix(':').unwrap_or(after).trim());
            }
        }
    }
    match text.find(": ") {
        Some(at) => (text[..at].trim(), text[at + 2..].trim()),
        None => (text.strip_suffix(':').unwrap_or(text).trim(), ""),
    }
}

fn scalar(value: &str) -> String {
    let value = value.trim();
    if let Some(quoted) = quoted(value) {
        return quoted;
    }
    let value = strip_comment(value).trim_end();
    if value == "~" || value == "null" {
        return String::new();
    }
    value.to_string()
}

/// A value that is one quoted string, up to its closing quote: YAML's
/// escapes in double quotes, `''` for a quote in single ones. What follows
/// the closing quote is a comment at most. `None` when it is not quoted, or
/// the quote never closes.
fn quoted(value: &str) -> Option<String> {
    let mut chars = value.chars();
    let quote = chars.next().filter(|c| *c == '"' || *c == '\'')?;
    let mut out = String::new();
    while let Some(c) = chars.next() {
        match (quote, c) {
            ('\'', '\'') if chars.clone().next() == Some('\'') => {
                chars.next();
                out.push('\'');
            }
            ('"', '\\') => match chars.next()? {
                'n' => out.push('\n'),
                't' => out.push('\t'),
                other => out.push(other),
            },
            _ if c == quote => return Some(out),
            _ => out.push(c),
        }
    }
    None
}

/// An unquoted value up to its comment. As in YAML, only a `#` after a
/// space starts one, so a URL's `#fragment` stays; and a shell command's
/// own quotes are respected, so `echo "a # b"` stays whole.
fn strip_comment(value: &str) -> &str {
    let mut quote: Option<char> = None;
    let mut after_space = true;
    for (at, c) in value.char_indices() {
        match quote {
            Some(open) if c == open => quote = None,
            Some(_) => {}
            None if c == '"' || c == '\'' => quote = Some(c),
            None if c == '#' && after_space => return &value[..at],
            None => {}
        }
        after_space = c.is_whitespace();
    }
    value
}

fn block_or_scalar(value: &str, nested: &[&Line]) -> String {
    let marker = value.trim();
    if marker.starts_with('|') || marker.starts_with('>') {
        let joiner = if marker.starts_with('|') { "\n" } else { " " };
        return nested.iter().map(|line| line.text).collect::<Vec<_>>().join(joiner);
    }
    scalar(value)
}

fn boolean(value: &str, default: bool) -> bool {
    match scalar(value).to_ascii_lowercase().as_str() {
        "true" | "yes" | "on" => true,
        "false" | "no" | "off" => false,
        _ => default,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_the_documented_shape() {
        let source = r#"
name: My Project
icon: assets/icon.png
processes:
  Dev server:
    command: npm run dev   # the vite one
    working_dir: ./frontend
    auto_start: true
    auto_restart: false
    restart_when_changed:
      - src/**/*.ts
    env:
      NODE_ENV: development
      QUOTED: "a # b"
  "worker: jobs":
    command: |
      cargo run
      --release
"#;
        let parsed = parse(source).unwrap();
        assert_eq!(parsed.len(), 2);
        assert_eq!(parsed[0].name, "Dev server");
        assert_eq!(parsed[0].command, "npm run dev");
        assert_eq!(parsed[0].working_dir, "./frontend");
        assert!(parsed[0].auto_start && !parsed[0].auto_restart);
        assert_eq!(parsed[0].env.get("NODE_ENV").map(String::as_str), Some("development"));
        assert_eq!(parsed[0].env.get("QUOTED").map(String::as_str), Some("a # b"));
        assert_eq!(parsed[1].name, "worker: jobs");
        assert_eq!(parsed[1].command, "cargo run\n--release");
        // Solo starts a process unless told otherwise.
        assert!(parsed[1].auto_start);
    }

    #[test]
    fn the_repo_example_and_empty_files() {
        let parsed = parse("name: Crew\nprocesses:\n  app:\n    command: npm run app\n    auto_start: true\n    auto_restart: true\n").unwrap();
        assert_eq!(parsed.len(), 1);
        assert!(parsed[0].auto_restart);
        assert!(parse("name: x\n").unwrap().is_empty());
        assert!(parse("processes:\n").unwrap().is_empty());
        assert!(parse("processes:\n  broken:\n    auto_start: true\n").is_err());
    }

    #[test]
    fn a_hash_starts_a_comment_only_after_a_space_and_outside_quotes() {
        let source = r#"
processes:
  quoted-in-command:
    command: echo "a # b" # says a # b
  single:
    command: echo 'x #y' && echo done
  url:
    command: open http://localhost:5173/#/settings
  comment:
    command: npm start # the server
  quoted:
    command: "it's \"fine\" # really" # not this
  bare:
    command: make # comment
    working_dir: # nothing
"#;
        let parsed = parse(source).unwrap();
        let commands: Vec<&str> = parsed.iter().map(|p| p.command.as_str()).collect();
        assert_eq!(
            commands,
            vec![
                r#"echo "a # b""#,
                "echo 'x #y' && echo done",
                "open http://localhost:5173/#/settings",
                "npm start",
                r#"it's "fine" # really"#,
                "make",
            ]
        );
        assert_eq!(parsed[5].working_dir, "");
        assert_eq!(scalar("'it''s'"), "it's");
    }
}
