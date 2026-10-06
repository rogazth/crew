//! Terminal output as an agent should read it. The log keeps the escapes so a
//! terminal can repaint from it; a model only pays tokens for them.

use std::sync::LazyLock;

use regex::Regex;

const ESC: u8 = 0x1b;
const BEL: u8 = 0x07;

/// `bytes` without escape sequences or control characters, with carriage
/// returns resolved the way a terminal would: a progress bar that redraws its
/// line a hundred times reads as its last state.
pub fn clean(bytes: &[u8]) -> String {
    let mut out: Vec<u8> = Vec::with_capacity(bytes.len());
    let mut line_start = 0;
    let mut i = 0;
    while i < bytes.len() {
        let byte = bytes[i];
        match byte {
            ESC => {
                i = skip_escape(bytes, i + 1);
                continue;
            }
            b'\n' => {
                out.push(b'\n');
                line_start = out.len();
            }
            b'\r' => {
                // CRLF is a newline, and so is a CR that ends the input: a
                // line handed over without its \n. A CR with more after it
                // starts the line over.
                if i + 1 < bytes.len() && bytes[i + 1] != b'\n' {
                    out.truncate(line_start);
                }
            }
            b'\t' => out.push(b'\t'),
            0x08 => {
                // Back over a whole character, not half of one.
                while out.len() > line_start {
                    let Some(gone) = out.pop() else { break };
                    if gone & 0xC0 != 0x80 {
                        break;
                    }
                }
            }
            0x00..=0x1f | 0x7f => {}
            _ => out.push(byte),
        }
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

/// A web address: its host, port and path, for `local_url` to judge.
static URL: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r#"(?i)\bhttps?://([a-z0-9.-]+|\[[0-9a-f:]*\])(?::\d+)?(?:[/?#][^\s"'<>`]*)?"#).expect("a valid pattern")
});

fn is_local(host: &str) -> bool {
    let host = host.trim_end_matches('.').to_ascii_lowercase();
    matches!(host.as_str(), "localhost" | "127.0.0.1" | "0.0.0.0" | "[::]" | "[::1]") || host.ends_with(".localhost")
}

/// The first address on this machine in a cleaned line, the way dev servers
/// announce themselves, made one a browser can open: a server bound to every
/// interface is reached on localhost. Addresses elsewhere are left alone: a
/// log links to docs and issues too, and what a run serves is the one worth a
/// button.
pub fn local_url(line: &str) -> Option<String> {
    let found = URL.captures_iter(line).find(|caps| is_local(&caps[1]))?;
    let url = found[0].trim_end_matches(['.', ',', ';', ':', ')', ']', '\'', '"']);
    Some(url.replacen("://0.0.0.0", "://localhost", 1).replacen("://[::]", "://localhost", 1))
}

/// Where the escape that began before `i` ends.
fn skip_escape(bytes: &[u8], mut i: usize) -> usize {
    let Some(&kind) = bytes.get(i) else {
        return i;
    };
    i += 1;
    match kind {
        // CSI: parameters and intermediates, then one final byte.
        b'[' => {
            while let Some(&b) = bytes.get(i) {
                i += 1;
                if (0x40..=0x7e).contains(&b) {
                    break;
                }
            }
            i
        }
        // OSC, DCS, SOS, PM, APC: a string ended by BEL or ST.
        b']' | b'P' | b'X' | b'^' | b'_' => {
            while let Some(&b) = bytes.get(i) {
                if b == BEL {
                    return i + 1;
                }
                if b == ESC && bytes.get(i + 1) == Some(&b'\\') {
                    return i + 2;
                }
                i += 1;
            }
            i
        }
        // Charset designations carry one more byte.
        b'(' | b')' | b'*' | b'+' | b'-' | b'.' | b'/' | b'#' | b'%' => (i + 1).min(bytes.len()),
        _ => i,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn colours_cursor_moves_and_titles_go() {
        let raw = b"\x1b[1;32m  VITE\x1b[0m ready \x1b]0;title\x07in \x1b[2K\x1b[1Gms\x1b(B";
        assert_eq!(clean(raw), "  VITE ready in ms");
    }

    #[test]
    fn a_redrawn_line_reads_as_its_last_state() {
        assert_eq!(clean(b"10%\r50%\r100%\r\ndone\r\n"), "100%\ndone\n");
        // One line cut from a CRLF stream keeps its text.
        assert_eq!(clean(b"ERROR 1\r"), "ERROR 1");
    }

    #[test]
    fn osc_ended_by_st_and_backspace_over_utf8() {
        assert_eq!(clean(b"\x1b]8;;http://x\x1b\\link\x1b]8;;\x1b\\ caf\xc3\xa9\x08e"), "link cafe");
    }

    #[test]
    fn a_local_address_is_found_and_made_openable() {
        let vite = clean(b"  \x1b[32m\xe2\x9e\x9c\x1b[39m  \x1b[1mLocal\x1b[22m:   \x1b[36mhttp://localhost:\x1b[1m5173\x1b[22m/\x1b[39m\r\n");
        assert_eq!(local_url(&vite).as_deref(), Some("http://localhost:5173/"));
        assert_eq!(local_url("Listening on http://0.0.0.0:3000.").as_deref(), Some("http://localhost:3000"));
        assert_eq!(local_url("ready at https://app.localhost:8443/admin").as_deref(), Some("https://app.localhost:8443/admin"));
        assert_eq!(local_url("(http://127.0.0.1:8000)").as_deref(), Some("http://127.0.0.1:8000"));
        assert_eq!(local_url("see https://vitejs.dev/config for more"), None);
        assert_eq!(local_url("http://localhostile.com"), None);
    }

    #[test]
    fn a_cut_escape_at_the_end_is_dropped() {
        assert_eq!(clean(b"ok\x1b[3"), "ok");
        assert_eq!(clean(b"ok\x1b"), "ok");
    }
}
