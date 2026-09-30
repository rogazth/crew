//! ⌘⇧F: text in the workspace's files, found the way ripgrep finds it, with
//! ripgrep's own searcher. It searches what ⌘P lists, so a folder git ignores
//! (`.ai/`) is searched when it is small and a build is not.

use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::{Arc, LazyLock, Mutex};

use crew_protocol::{FileMatches, FileSearchResult, LineMatch, SearchFiles};
use globset::{Glob, GlobSet, GlobSetBuilder};
use grep_matcher::Matcher;
use grep_regex::{RegexMatcher, RegexMatcherBuilder};
use grep_searcher::{sinks::Lossy, BinaryDetection, SearcherBuilder};

use crate::files::{self, ProjectFile};

/// Far more than a list can show; past it the answer says there are more.
const MAX_MATCHES: usize = 10_000;
/// ⌘P stops at 20k; a search goes through a monorepo.
const MAX_FILES: usize = 500_000;
/// Nothing this big opens in the editor either.
const MAX_FILE_BYTES: u64 = 8 * 1024 * 1024;
/// How much of a long line a result shows, and how much of it before the match.
const PREVIEW_CHARS: usize = 250;
const PREVIEW_LEAD: usize = 40;
const MAX_RANGES: usize = 50;

/// The search running in each folder. A new one flags the one before it,
/// which gives up: typing never queues searches behind each other.
static RUNNING: LazyLock<Mutex<HashMap<String, Arc<AtomicBool>>>> = LazyLock::new(Default::default);

pub fn search(request: &SearchFiles) -> Result<FileSearchResult, String> {
    let cancelled = Arc::new(AtomicBool::new(false));
    if let Some(previous) = RUNNING.lock().unwrap().insert(request.cwd.clone(), Arc::clone(&cancelled)) {
        previous.store(true, Ordering::Relaxed);
    }
    if request.query.is_empty() {
        return Ok(FileSearchResult::default());
    }
    let matcher = matcher(request)?;
    let include = globs(request.include.as_deref().unwrap_or(""))?;
    let exclude = globs(request.exclude.as_deref().unwrap_or(""))?;
    let files: Vec<ProjectFile> = files::list_capped(&request.cwd, MAX_FILES)?
        .into_iter()
        .filter(|file| include.as_ref().is_none_or(|set| set.is_match(&file.relative)))
        .filter(|file| exclude.as_ref().is_none_or(|set| !set.is_match(&file.relative)))
        .collect();
    let stale = || cancelled.load(Ordering::Relaxed);

    let next = AtomicUsize::new(0);
    let found = AtomicUsize::new(0);
    let full = AtomicBool::new(false);
    let results: Mutex<Vec<FileMatches>> = Mutex::new(Vec::new());
    // Past four, workers slow each other down: macOS serialises much of `open`,
    // and ripgrep with -j12 is slower than with -j4 on the same tree.
    let workers = std::thread::available_parallelism().map_or(4, |n| n.get()).min(4);
    std::thread::scope(|scope| {
        for _ in 0..workers {
            scope.spawn(|| {
                let mut searcher = SearcherBuilder::new()
                    .binary_detection(BinaryDetection::quit(0))
                    .line_number(true)
                    .build();
                loop {
                    let Some(file) = files.get(next.fetch_add(1, Ordering::Relaxed)) else { break };
                    if full.load(Ordering::Relaxed) || stale() {
                        break;
                    }
                    let Ok(handle) = std::fs::File::open(&file.path) else { continue };
                    if handle.metadata().map_or(true, |meta| !meta.is_file() || meta.len() > MAX_FILE_BYTES) {
                        continue;
                    }
                    let mut lines = Vec::new();
                    let _ = searcher.search_file(
                        &matcher,
                        &handle,
                        Lossy(|number, line| {
                            let hit = line_match(&matcher, number, line);
                            let count = hit.ranges.len();
                            lines.push(hit);
                            if found.fetch_add(count, Ordering::Relaxed) + count >= MAX_MATCHES {
                                full.store(true, Ordering::Relaxed);
                                return Ok(false);
                            }
                            Ok(true)
                        }),
                    );
                    if !lines.is_empty() {
                        let matches = FileMatches { path: file.path.clone(), relative: file.relative.clone(), lines };
                        results.lock().unwrap().push(matches);
                    }
                }
            });
        }
    });

    let mut files: Vec<FileMatches> = results.into_inner().unwrap();
    files.sort_by(|a, b| a.relative.cmp(&b.relative));
    let matches = files.iter().flat_map(|file| &file.lines).map(|line| line.ranges.len()).sum::<usize>();
    Ok(FileSearchResult {
        files,
        matches: matches as u32,
        truncated: full.load(Ordering::Relaxed),
        cancelled: stale(),
    })
}

fn matcher(request: &SearchFiles) -> Result<RegexMatcher, String> {
    let pattern = if request.regex.unwrap_or(false) {
        request.query.clone()
    } else {
        regex::escape(&request.query)
    };
    RegexMatcherBuilder::new()
        .case_insensitive(!request.case_sensitive.unwrap_or(false))
        .word(request.whole_word.unwrap_or(false))
        // A match never spans lines, so `\n` in a pattern can never be found.
        .line_terminator(Some(b'\n'))
        .build(&pattern)
        .map_err(|error| regex_problem(&error.to_string()))
}

/// The regex crate draws the pattern with a caret under the fault; a line in
/// a narrow panel only has room for what is wrong: "unclosed group".
fn regex_problem(message: &str) -> String {
    let last = message.lines().rev().find(|line| !line.trim().is_empty()).unwrap_or(message);
    let problem = last.trim().trim_start_matches("error:").trim();
    let mut chars = problem.chars();
    chars.next().map_or_else(String::new, |first| first.to_uppercase().chain(chars).collect())
}

/// VS Code's reading of a glob list: `*.ts` and `src` match at any depth, and a
/// folder stands for everything in it.
fn globs(list: &str) -> Result<Option<GlobSet>, String> {
    let mut builder = GlobSetBuilder::new();
    let mut any = false;
    for pattern in list.split(',').map(str::trim).filter(|pattern| !pattern.is_empty()) {
        let pattern = pattern.trim_start_matches("./").trim_start_matches('/').trim_end_matches('/');
        let rooted = if pattern.starts_with("**/") || pattern.contains('/') {
            pattern.to_string()
        } else {
            format!("**/{pattern}")
        };
        for glob in [rooted.clone(), format!("{rooted}/**")] {
            builder.add(Glob::new(&glob).map_err(|error| error.to_string())?);
        }
        any = true;
    }
    if !any {
        return Ok(None);
    }
    builder.build().map(Some).map_err(|error| error.to_string())
}

fn line_match(matcher: &RegexMatcher, number: u64, line: &str) -> LineMatch {
    let line = line.trim_end_matches(['\n', '\r']);
    let mut spans = Vec::new();
    let _ = matcher.find_iter(line.as_bytes(), |found| {
        spans.push((found.start(), found.end()));
        // An empty match (`^`, `x*`) highlights nothing, and is found once;
        // a minified line full of hits shows the first few.
        !found.is_empty() && spans.len() < MAX_RANGES
    });
    // The window starts a little before the first match, on a char boundary.
    let first = spans.first().map_or(0, |span| span.0);
    let lead = line[..first].char_indices().rev().nth(PREVIEW_LEAD - 1).map_or(0, |(at, _)| at);
    let start = (lead + (line[lead..].len() - line[lead..].trim_start().len())).min(first);
    let end = line[start..].char_indices().nth(PREVIEW_CHARS).map_or(line.len(), |(at, _)| start + at);
    // Byte offsets to UTF-16 ones in one pass: a minified line is megabytes long.
    let mut marks: Vec<usize> = spans.iter().flat_map(|&(from, to)| [from, to]).chain([start]).collect();
    marks.sort_unstable();
    marks.dedup();
    let mut units = HashMap::with_capacity(marks.len());
    let (mut at, mut count) = (0, 0u32);
    for mark in marks {
        count += utf16(&line[at..mark]);
        at = mark;
        units.insert(mark, count);
    }
    LineMatch {
        line: number as u32,
        preview: line[start..end].to_string(),
        preview_start: units[&start],
        ranges: spans.into_iter().map(|(from, to)| (units[&from], units[&to])).collect(),
    }
}

fn utf16(text: &str) -> u32 {
    text.encode_utf16().count() as u32
}

#[cfg(test)]
mod tests {
    use super::*;

    fn request(cwd: &std::path::Path, query: &str) -> SearchFiles {
        SearchFiles { cwd: cwd.to_string_lossy().into_owned(), query: query.into(), ..Default::default() }
    }

    fn scratch(files: &[(&str, &str)]) -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!("crew-search-{}", uuid::Uuid::new_v4()));
        for (name, text) in files {
            let path = dir.join(name);
            std::fs::create_dir_all(path.parent().unwrap()).unwrap();
            std::fs::write(path, text).unwrap();
        }
        dir
    }

    fn found(result: &FileSearchResult) -> Vec<(String, u32)> {
        result
            .files
            .iter()
            .flat_map(|file| file.lines.iter().map(|line| (file.relative.clone(), line.line)))
            .collect()
    }

    #[test]
    fn finds_text_in_order_and_skips_binaries() {
        let dir = scratch(&[
            ("b.ts", "one\nconst Deploy = 1;\n"),
            ("a/c.md", "deploy the app\n"),
            ("img.bin", "deploy\0binary"),
        ]);
        let result = search(&request(&dir, "deploy")).unwrap();
        assert_eq!(found(&result), [("a/c.md".into(), 1), ("b.ts".into(), 2)]);
        assert_eq!(result.matches, 2);
        assert!(!result.truncated && !result.cancelled);
    }

    #[test]
    fn options_narrow_the_search() {
        let dir = scratch(&[("src/a.ts", "Deploy deployer\n"), ("docs/a.md", "Deploy\n")]);
        let mut exact = request(&dir, "Deploy");
        exact.case_sensitive = Some(true);
        exact.whole_word = Some(true);
        exact.include = Some("src".into());
        assert_eq!(found(&search(&exact).unwrap()), [("src/a.ts".into(), 1)]);

        let mut regex = request(&dir, "dep.oy(er)?");
        regex.regex = Some(true);
        regex.exclude = Some("*.md".into());
        let result = search(&regex).unwrap();
        assert_eq!(result.files[0].lines[0].ranges, [(0, 6), (7, 15)]);
        assert_eq!(result.files.len(), 1);

        let mut broken = request(&dir, "needle(");
        broken.regex = Some(true);
        assert_eq!(search(&broken).unwrap_err(), "Unclosed group");
    }

    #[test]
    fn previews_count_utf16_and_trim_long_lines() {
        let dir = scratch(&[("a.txt", &format!("    ñ😀 {}needle tail\n", "x".repeat(300)))]);
        let result = search(&request(&dir, "needle")).unwrap();
        let line = &result.files[0].lines[0];
        // "    ñ😀 " is 4 + 1 + 2 + 1 UTF-16 units, then the 300 x's.
        assert_eq!(line.ranges, [(308, 314)]);
        assert_eq!(line.preview_start, 308 - PREVIEW_LEAD as u32);
        assert!(line.preview.starts_with(&"x".repeat(PREVIEW_LEAD)));
        assert!(line.preview.ends_with("needle tail"));

        let short = line_match(&matcher(&request(&dir, "b")).unwrap(), 3, "\t  a b\n");
        assert_eq!((short.preview.as_str(), short.preview_start, short.ranges), ("a b", 3, vec![(5, 6)]));
    }
}
