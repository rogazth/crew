//! Crew writes its own files only where its environment's layout says
//! (`crew_core::paths`, docs/plans/2026-10-15-environments.md). Reading `HOME`
//! or the system temp dir anywhere else is how a build ends up writing into
//! another build's folders, so outside tests it is allowed only in the files
//! below, each for a reason that is not Crew's own state.

use std::path::{Path, PathBuf};

const PATTERNS: [&str; 3] = ["temp_dir()", "var(\"HOME\")", "var_os(\"HOME\")"];

const ALLOWED: [(&str, &str); 17] = [
    ("crew-core/src/paths.rs", "the layout itself, and the folder a process without one gets"),
    ("crew-core/src/history_import.rs", "the provider CLIs' own transcripts"),
    ("crew-core/src/claude_title.rs", "Claude's own session files"),
    ("crew-core/src/provider_session.rs", "the provider CLIs' own state"),
    ("crew-core/src/shell_path.rs", "where the user installed their CLIs"),
    ("crew-core/src/cookie_import.rs", "the other browsers' profiles"),
    ("crew-core/src/pty.rs", "the HOME a terminal's shell starts with"),
    ("crew-core/src/turns/opencode_server.rs", "the folder opencode's server starts in"),
    ("crewd/src/main.rs", "the data dir `crewd serve` defaults to, and a daemon given none"),
    ("crewd/src/machine.rs", "`~` in a path a window names on the machine"),
    ("crew-cli/src/identity.rs", "where the installed app keeps the daemon the CLI reaches"),
    ("crew-cli/src/output.rs", "images the CLI shows, outside any daemon's environment"),
    ("crew-core/src/agent.rs", "the HOME an agent's CLI starts with"),
    ("crew-core/src/turns.rs", "Claude's own folder"),
    ("crew-core/src/turns/cursor.rs", "Cursor's own plugins and sessions"),
    ("crew-core/src/usage/cursor.rs", "the token `cursor-agent login` stored"),
    ("crew-core/src/usage/grok.rs", "the email `grok login` kept"),
];

fn crates_dir() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).parent().expect("crates").to_path_buf()
}

fn sources(dir: &Path, out: &mut Vec<PathBuf>) {
    for entry in std::fs::read_dir(dir).expect("read dir").flatten() {
        let path = entry.path();
        let name = entry.file_name().to_string_lossy().into_owned();
        if path.is_dir() {
            if name != "tests" && name != "target" {
                sources(&path, out);
            }
        } else if name.ends_with(".rs") && name != "tests.rs" && name != "fakes.rs" {
            out.push(path);
        }
    }
}

/// The file up to its test module: `#[cfg(test)]` on the line before `mod`.
fn production(text: &str) -> &str {
    let mut at = 0;
    while let Some(found) = text[at..].find("#[cfg(test)]\nmod ") {
        let start = at + found;
        if start == 0 || text.as_bytes()[start - 1] == b'\n' {
            return &text[..start];
        }
        at = start + 1;
    }
    text
}

fn uses(root: &Path) -> Vec<(String, usize)> {
    let mut files = Vec::new();
    for krate in std::fs::read_dir(root).expect("crates").flatten() {
        let src = krate.path().join("src");
        if src.is_dir() {
            sources(&src, &mut files);
        }
    }
    let mut found = Vec::new();
    for file in files {
        let text = std::fs::read_to_string(&file).expect("read");
        let count = production(&text).lines().filter(|line| PATTERNS.iter().any(|p| line.contains(p))).count();
        if count > 0 {
            let relative = file.strip_prefix(root).expect("under crates").to_string_lossy().into_owned();
            found.push((relative, count));
        }
    }
    found.sort();
    found
}

#[test]
fn only_the_listed_files_read_home_or_the_system_temp_dir() {
    let found = uses(&crates_dir());
    let stray: Vec<_> = found.iter().filter(|(file, _)| !ALLOWED.iter().any(|(allowed, _)| allowed == file)).collect();
    assert!(
        stray.is_empty(),
        "these read HOME or the temp dir for files Crew writes; put them under crew_core::paths, \
         or list them here with the reason: {stray:?}"
    );
}

#[test]
fn every_listed_file_still_needs_to_be() {
    let found = uses(&crates_dir());
    let unused: Vec<_> = ALLOWED.iter().filter(|(allowed, _)| !found.iter().any(|(file, _)| file == allowed)).collect();
    assert!(unused.is_empty(), "no longer read HOME or the temp dir; take them off the list: {unused:?}");
}

#[test]
fn test_code_is_not_counted() {
    let text = "fn real() {}\n#[cfg(test)]\nmod tests {\n    fn t() { std::env::temp_dir(); }\n}\n";
    assert!(!production(text).contains("temp_dir"));
    let gated = "#[cfg(test)]\nfn helper() {}\nfn real() { std::env::temp_dir(); }\n";
    assert!(production(gated).contains("temp_dir"), "a gated item is not the test module");
}
