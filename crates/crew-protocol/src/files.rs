use serde::{Deserialize, Serialize};
use ts_rs::TS;

/// One entry of a folder, as the explorer shows it.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../../src/lib/protocol.ts", rename_all = "camelCase")]
pub struct FolderEntry {
    pub name: String,
    pub path: String,
    pub dir: bool,
    /// git ignores it: shown dimmed, still there to open.
    pub ignored: bool,
}

/// Text to find in the workspace's files. `include` and `exclude` are
/// comma-separated globs; a bare name matches at any depth, as in VS Code.
#[derive(Serialize, Deserialize, Clone, Debug, Default, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../../src/lib/protocol.ts", rename_all = "camelCase")]
pub struct SearchFiles {
    pub cwd: String,
    pub query: String,
    #[serde(default)]
    #[ts(optional)]
    pub regex: Option<bool>,
    #[serde(default)]
    #[ts(optional)]
    pub case_sensitive: Option<bool>,
    #[serde(default)]
    #[ts(optional)]
    pub whole_word: Option<bool>,
    #[serde(default)]
    #[ts(optional)]
    pub include: Option<String>,
    #[serde(default)]
    #[ts(optional)]
    pub exclude: Option<String>,
}

#[derive(Serialize, Deserialize, Clone, Debug, Default, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../../src/lib/protocol.ts", rename_all = "camelCase")]
pub struct FileSearchResult {
    pub files: Vec<FileMatches>,
    /// Every match found, across `files`.
    pub matches: u32,
    /// The search stopped at its cap: there are more.
    pub truncated: bool,
    /// A newer search took over before this one finished; its answer is partial.
    pub cancelled: bool,
}

#[derive(Serialize, Deserialize, Clone, Debug, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../../src/lib/protocol.ts", rename_all = "camelCase")]
pub struct FileMatches {
    pub path: String,
    pub relative: String,
    pub lines: Vec<LineMatch>,
}

/// Offsets count UTF-16 code units, as JavaScript strings do.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../../src/lib/protocol.ts", rename_all = "camelCase")]
pub struct LineMatch {
    /// One-based.
    pub line: u32,
    /// A window of the line around its first match, leading space trimmed.
    pub preview: String,
    /// Where `preview` starts in the line.
    pub preview_start: u32,
    /// `[start, end)` of each match in the whole line.
    pub ranges: Vec<(u32, u32)>,
}
