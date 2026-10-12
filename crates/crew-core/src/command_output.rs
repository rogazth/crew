//! What a command the CLI ran itself printed, as a note for the chat.

/// What a live `local_command_output` line says: the output of a command the
/// CLI ran itself (`/context`, `/cost`), as a note. The line carries the text
/// bare, or wrapped in `<local-command-stdout>`; colours are dropped, and a
/// command that printed nothing says nothing.
pub fn local_command_output(content: &str) -> Option<String> {
    let trimmed = content.trim();
    let tagged = [tag(trimmed, "local-command-stdout"), tag(trimmed, "local-command-stderr")];
    let parts = if tagged.iter().any(Option::is_some) { tagged } else { [Some(trimmed), None] };
    let text = parts
        .iter()
        .flatten()
        .map(|part| strip_ansi(part).trim().to_string())
        .filter(|part| !part.is_empty())
        .collect::<Vec<_>>()
        .join("\n");
    (!text.is_empty()).then_some(text)
}

/// The inside of the first `<name>…</name>` in `text`.
fn tag<'a>(text: &'a str, name: &str) -> Option<&'a str> {
    let open = format!("<{name}>");
    let close = format!("</{name}>");
    let start = text.find(&open)? + open.len();
    let end = text[start..].find(&close)? + start;
    Some(&text[start..end])
}

fn strip_ansi(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut chars = text.chars().peekable();
    while let Some(c) = chars.next() {
        if c != '\u{1b}' {
            out.push(c);
            continue;
        }
        match chars.peek() {
            // CSI: parameters, then one final byte in `@`..=`~`.
            Some('[') => {
                chars.next();
                for c in chars.by_ref() {
                    if ('@'..='~').contains(&c) {
                        break;
                    }
                }
            }
            // OSC: up to BEL or ESC \.
            Some(']') => {
                chars.next();
                while let Some(c) = chars.next() {
                    if c == '\u{7}' {
                        break;
                    }
                    if c == '\u{1b}' && chars.peek() == Some(&'\\') {
                        chars.next();
                        break;
                    }
                }
            }
            _ => {
                chars.next();
            }
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A live command's output reads the same bare or in the transcript's
    /// tags: colours dropped, and nothing when it printed nothing.
    #[test]
    fn a_live_commands_output_is_a_note_bare_or_tagged_and_nothing_when_empty() {
        assert_eq!(local_command_output("\u{1b}[1mContext\u{1b}[22m\n12k / 200k\n").as_deref(), Some("Context\n12k / 200k"));
        assert_eq!(local_command_output("<local-command-stdout>Set model to opus</local-command-stdout>").as_deref(), Some("Set model to opus"));
        assert_eq!(
            local_command_output("<local-command-stdout>out</local-command-stdout><local-command-stderr>oops</local-command-stderr>").as_deref(),
            Some("out\noops")
        );
        assert_eq!(local_command_output("<local-command-stdout></local-command-stdout>"), None);
        assert_eq!(local_command_output("  \n"), None);
    }
}
