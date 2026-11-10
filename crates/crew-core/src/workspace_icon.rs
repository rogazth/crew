//! A workspace's icon: an image its repo offers (a favicon, a logo, an app's
//! icon), one the user uploaded, or none, for its initials. What the user
//! chose is kept on the workspace's row (`icon`, `icon_path`, `icon_upload`);
//! an upload is a file in Crew's data dir (`workspace-icons/`), never in the
//! repo. The repo is looked at by the daemon that holds the workspace, in a
//! walk kept short: a few levels deep, past the folders that only hold builds,
//! dependencies and tests.

use std::cmp::Reverse;
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::{Duration, Instant};

use base64::Engine;
use rusqlite::{params, Connection, OptionalExtension};

use crate::store::Store;

/// What the user chose: `Auto` is the best image the repo offers, else the initials.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Choice {
    Auto,
    Repo,
    Upload,
    Initials,
}

impl Choice {
    pub fn as_str(self) -> &'static str {
        match self {
            Choice::Auto => "auto",
            Choice::Repo => "repo",
            Choice::Upload => "upload",
            Choice::Initials => "initials",
        }
    }

    /// Anything it does not know is `Auto`.
    pub fn parse(text: &str) -> Choice {
        match text {
            "repo" => Choice::Repo,
            "upload" => Choice::Upload,
            "initials" => Choice::Initials,
            _ => Choice::Auto,
        }
    }
}

/// The choice as the workspace's row keeps it: the repo's file it names
/// (relative to the workspace), and the uploaded file's name in the data dir.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Kept {
    pub choice: Choice,
    pub path: String,
    pub upload: String,
}

/// An image the repo offers: its path relative to the workspace and its size
/// in pixels (an SVG's from its view box; 0 when it does not say).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Found {
    pub path: String,
    pub width: u32,
    pub height: u32,
}

/// The kinds of image it shows.
const KINDS: &[&str] = &["svg", "png", "webp", "jpg", "jpeg", "ico"];
/// What a file is called when it is a project's icon: the name alone, or the
/// name and a size or variant (`logo512.png`, `favicon-32x32.png`).
const NAMES: &[&str] = &["favicon", "apple-touch-icon", "app-icon", "app_icon", "appicon", "icon", "logo"];
/// Folders never looked in: builds, dependencies, and tests and docs, whose images are not the project's face.
const SKIP: &[&str] = &[
    "node_modules",
    "target",
    "dist",
    "out",
    "vendor",
    "pods",
    "deriveddata",
    "coverage",
    "e2e",
    "test",
    "tests",
    "__tests__",
    "fixtures",
    "docs",
    "doc",
    "examples",
];
const MAX_DEPTH: usize = 5;
/// Entries read before the walk gives up: a monorepo is not read through.
const MAX_ENTRIES: usize = 20_000;
/// Matching files weighed; the rest of a folder of icons adds nothing.
const MAX_MATCHES: usize = 64;
/// Images offered to pick from, best first.
const MAX_FOUND: usize = 8;
/// A repo's image bigger than this is no icon.
const MAX_BYTES: u64 = 1 << 20;
/// The largest upload kept.
pub const MAX_UPLOAD: usize = 2 << 20;
/// A repo's icon rarely changes: looking again sooner than this is wasted.
pub const LOOK_AGAIN_AFTER: Duration = Duration::from_secs(5 * 60);

pub(crate) fn migrate_v52(conn: &Connection) -> rusqlite::Result<()> {
    for (column, alter) in [
        ("icon", "ALTER TABLE workspaces ADD COLUMN icon TEXT NOT NULL DEFAULT 'auto';"),
        ("icon_path", "ALTER TABLE workspaces ADD COLUMN icon_path TEXT NOT NULL DEFAULT '';"),
        ("icon_upload", "ALTER TABLE workspaces ADD COLUMN icon_upload TEXT NOT NULL DEFAULT '';"),
    ] {
        if !crate::store::has_column(conn, "workspaces", column)? {
            conn.execute_batch(alter)?;
        }
    }
    Ok(())
}

/* ── What the user chose ─────────────────────────────────────────────── */

pub fn kept(store: &Store, id: &str) -> Result<Kept, String> {
    store
        .with(|conn| {
            conn.query_row("SELECT icon, icon_path, icon_upload FROM workspaces WHERE id = ?1", params![id], |row| {
                Ok(Kept { choice: Choice::parse(&row.get::<_, String>(0)?), path: row.get(1)?, upload: row.get(2)? })
            })
            .optional()
        })?
        .ok_or_else(|| format!("No workspace {id}"))
}

/// Keeps the user's choice. `Repo` names a file in the repo, relative to the
/// workspace; `Upload` is the image uploaded last, which must be there.
pub fn choose(store: &Store, id: &str, choice: Choice, path: Option<&str>) -> Result<(), String> {
    kept(store, id)?;
    let path = match choice {
        Choice::Repo => path.map(str::trim).filter(|path| safe_relative(path)).ok_or("Pick an image in the repo")?.to_string(),
        _ => String::new(),
    };
    if choice == Choice::Upload && upload_file(store, id).is_none() {
        return Err("No image has been uploaded".into());
    }
    store.with(|conn| {
        conn.execute("UPDATE workspaces SET icon = ?2, icon_path = ?3 WHERE id = ?1", params![id, choice.as_str(), path])
    })?;
    Ok(())
}

/// Keeps an uploaded image in the data dir, in place of the one before, and
/// chooses it.
pub fn upload(store: &Store, id: &str, mime: &str, bytes: &[u8]) -> Result<(), String> {
    let ext = ext_of_mime(mime).ok_or("Use a PNG, SVG, WebP, JPEG or ICO image")?;
    if bytes.len() > MAX_UPLOAD {
        return Err("The image is over 2 MB".into());
    }
    if !looks_like(bytes, ext) {
        return Err(format!("That file is not a {} image", ext.to_uppercase()));
    }
    kept(store, id)?;
    let dir = icons_dir(store)?;
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    forget_upload(store, id);
    let name = format!("{}.{ext}", file_stem(id));
    let partial = dir.join(format!("{name}.partial"));
    std::fs::write(&partial, bytes).map_err(|e| e.to_string())?;
    std::fs::rename(&partial, dir.join(&name)).map_err(|e| e.to_string())?;
    store
        .with(|conn| conn.execute("UPDATE workspaces SET icon = 'upload', icon_upload = ?2 WHERE id = ?1", params![id, name]))?;
    Ok(())
}

/// An upload's bytes, as the window sends them: base64.
pub fn decode(data: &str) -> Result<Vec<u8>, String> {
    base64::engine::general_purpose::STANDARD.decode(data.trim()).map_err(|_| "The image could not be read".to_string())
}

/// The image uploaded for the workspace, when it is still there.
pub fn upload_file(store: &Store, id: &str) -> Option<PathBuf> {
    let kept = kept(store, id).ok()?;
    if kept.upload.is_empty() {
        return None;
    }
    let path = icons_dir(store).ok()?.join(&kept.upload);
    path.is_file().then_some(path)
}

/// Removes what was uploaded for the workspace: before another upload, and
/// when the workspace goes. By name, so it works once the row is gone.
pub fn forget_upload(store: &Store, id: &str) {
    let Ok(dir) = icons_dir(store) else { return };
    let stem = file_stem(id);
    for ext in ["svg", "png", "webp", "jpg", "ico"] {
        let _ = std::fs::remove_file(dir.join(format!("{stem}.{ext}")));
    }
}

/// The file the workspace shows, or none for its initials. A chosen file
/// that is gone falls back to the best the repo offers.
pub fn shown(store: &Store, id: &str, root: &Path, found: &[Found]) -> Result<Option<PathBuf>, String> {
    let kept = kept(store, id)?;
    let best = || found.first().map(|found| root.join(&found.path));
    Ok(match kept.choice {
        Choice::Initials => None,
        Choice::Upload => upload_file(store, id).or_else(best),
        Choice::Repo => Some(root.join(&kept.path)).filter(|path| inside(root, path)).or_else(best),
        Choice::Auto => best(),
    })
}

/// Whether the workspace's choice needs the repo looked at to be shown.
pub fn wants_repo(kept: &Kept) -> bool {
    matches!(kept.choice, Choice::Auto | Choice::Repo)
}

fn icons_dir(store: &Store) -> Result<PathBuf, String> {
    store.dir().map(|dir| dir.join("workspace-icons")).ok_or_else(|| "Crew has no data folder to keep it in".to_string())
}

/// The workspace's id as a file name: ids are UUIDs, but nothing else gets through.
fn file_stem(id: &str) -> String {
    id.chars().map(|c| if c.is_ascii_alphanumeric() || c == '-' || c == '_' { c } else { '_' }).collect()
}

fn ext_of_mime(mime: &str) -> Option<&'static str> {
    match mime.trim().to_ascii_lowercase().as_str() {
        "image/png" => Some("png"),
        "image/svg+xml" => Some("svg"),
        "image/webp" => Some("webp"),
        "image/jpeg" | "image/jpg" => Some("jpg"),
        "image/x-icon" | "image/vnd.microsoft.icon" | "image/ico" => Some("ico"),
        _ => None,
    }
}

fn mime_of_ext(ext: &str) -> &'static str {
    match ext {
        "svg" => "image/svg+xml",
        "png" => "image/png",
        "webp" => "image/webp",
        "jpg" | "jpeg" => "image/jpeg",
        _ => "image/x-icon",
    }
}

/// An SVG says so; any other image is one whose size can be read.
fn looks_like(bytes: &[u8], ext: &str) -> bool {
    if ext == "svg" {
        return String::from_utf8_lossy(bytes).contains("<svg");
    }
    dimensions(bytes, ext).is_some()
}

/// A path inside the repo, relative, that names an image: no way out of it.
fn safe_relative(path: &str) -> bool {
    !path.is_empty()
        && !path.starts_with('/')
        && !path.contains('\\')
        && path.split('/').all(|part| !part.is_empty() && part != "." && part != "..")
        && KINDS.contains(&ext_of(path).as_str())
}

/// A file in the repo, its links followed, still in the repo.
fn inside(root: &Path, path: &Path) -> bool {
    match (root.canonicalize(), path.canonicalize()) {
        (Ok(root), Ok(path)) => path.starts_with(root) && path.is_file(),
        _ => false,
    }
}

fn ext_of(path: &str) -> String {
    path.rsplit_once('.').map(|(_, ext)| ext.to_ascii_lowercase()).unwrap_or_default()
}

/// The image as a data URL, for the window to draw; none when it is too big or unreadable.
pub fn data_url(path: &Path) -> Option<String> {
    let size = std::fs::metadata(path).ok()?.len();
    if size > MAX_UPLOAD as u64 {
        return None;
    }
    let bytes = std::fs::read(path).ok()?;
    let ext = ext_of(&path.to_string_lossy());
    Some(format!("data:{};base64,{}", mime_of_ext(&ext), base64::engine::general_purpose::STANDARD.encode(bytes)))
}

/* ── What the repo offers ────────────────────────────────────────────── */

/// The images in the repo that could be its icon, best first: square-ish
/// before not, SVG, PNG and WebP before JPEG before ICO, then the largest.
pub fn detect(root: &Path) -> Vec<Found> {
    let mut matched = Vec::new();
    let mut seen = 0;
    walk(root, root, 0, &mut seen, &mut matched);
    let mut found: Vec<Found> = matched
        .into_iter()
        .filter_map(|relative| {
            let path = root.join(&relative);
            if std::fs::metadata(&path).ok()?.len() > MAX_BYTES {
                return None;
            }
            let bytes = std::fs::read(&path).ok()?;
            let ext = ext_of(&relative);
            // A raster image whose size cannot be read is not the image its name says.
            let (width, height) = match dimensions(&bytes, &ext) {
                Some(size) => size,
                None if ext == "svg" && looks_like(&bytes, "svg") => (0, 0),
                None => return None,
            };
            Some(Found { path: relative, width, height })
        })
        .collect();
    found.sort_by_key(rank);
    found.truncate(MAX_FOUND);
    found
}

fn walk(dir: &Path, root: &Path, depth: usize, seen: &mut usize, out: &mut Vec<String>) {
    if depth > MAX_DEPTH || *seen >= MAX_ENTRIES || out.len() >= MAX_MATCHES {
        return;
    }
    let Ok(entries) = std::fs::read_dir(dir) else { return };
    let mut entries: Vec<_> = entries.flatten().collect();
    entries.sort_by_key(|entry| entry.file_name());
    for entry in entries {
        *seen += 1;
        if *seen >= MAX_ENTRIES || out.len() >= MAX_MATCHES {
            return;
        }
        // Not through links: they lead out of the repo, or round in circles.
        let Ok(kind) = entry.file_type() else { continue };
        let name = entry.file_name().to_string_lossy().to_string();
        let path = entry.path();
        if kind.is_dir() {
            if !name.starts_with('.') && !SKIP.contains(&name.to_ascii_lowercase().as_str()) {
                walk(&path, root, depth + 1, seen, out);
            }
        } else if kind.is_file() {
            let Ok(relative) = path.strip_prefix(root) else { continue };
            let relative = relative.components().map(|part| part.as_os_str().to_string_lossy()).collect::<Vec<_>>().join("/");
            if is_candidate(&relative) {
                out.push(relative);
            }
        }
    }
}

/// Whether a file, by its path in the repo, is one of its icons: named as
/// one, or in a folder that only holds them (a favicon folder, Tauri's
/// icons, an iOS app icon set).
pub fn is_candidate(relative: &str) -> bool {
    let lower = relative.to_ascii_lowercase();
    let ext = ext_of(&lower);
    if !KINDS.contains(&ext.as_str()) {
        return false;
    }
    let parts: Vec<&str> = lower.split('/').collect();
    let file = parts.last().copied().unwrap_or_default();
    let stem = &file[..file.len() - ext.len() - 1];
    let parent = if parts.len() > 1 { parts[parts.len() - 2] } else { "" };
    if parent.ends_with(".appiconset") || parent == "favicon" || parent == "favicons" || lower.starts_with("src-tauri/icons/") {
        return true;
    }
    NAMES.iter().any(|name| {
        stem == *name
            || stem
                .strip_prefix(name)
                .and_then(|rest| rest.chars().next())
                .is_some_and(|next| matches!(next, '-' | '_' | '.' | '@') || next.is_ascii_digit())
    })
}

/// Lower is better: square-ish, then the kind, then the size (an SVG is any size), then nearer the root.
fn rank(found: &Found) -> (u8, u8, Reverse<u32>, usize, String) {
    let ext = ext_of(&found.path);
    let (long, short) = (found.width.max(found.height), found.width.min(found.height));
    let square = if short > 0 && long * 4 <= short * 5 { 0 } else { 1 };
    let kind = match ext.as_str() {
        "svg" | "png" | "webp" => 0,
        "jpg" | "jpeg" => 1,
        _ => 2,
    };
    let size = if ext == "svg" && short > 0 { u32::MAX } else { short };
    (square, kind, Reverse(size), found.path.matches('/').count(), found.path.clone())
}

/// What the repo offered when each workspace was last looked at: looked at
/// again once it is old (LOOK_AGAIN_AFTER), or when asked.
#[derive(Default)]
pub struct Looks {
    last: Mutex<HashMap<String, Look>>,
}

struct Look {
    root: PathBuf,
    at: Instant,
    found: Vec<Found>,
}

impl Looks {
    pub fn found(&self, id: &str, root: &Path, now: bool) -> Vec<Found> {
        if !now {
            let last = self.last.lock().unwrap_or_else(|e| e.into_inner());
            if let Some(look) = last.get(id).filter(|look| look.root == root && look.at.elapsed() < LOOK_AGAIN_AFTER) {
                return look.found.clone();
            }
        }
        // Looked at without the lock held: another workspace's answer does not wait on this walk.
        let found = detect(root);
        let look = Look { root: root.to_path_buf(), at: Instant::now(), found: found.clone() };
        self.last.lock().unwrap_or_else(|e| e.into_inner()).insert(id.to_string(), look);
        found
    }
}

/* ── An image's size, from its header ────────────────────────────────── */

/// Width and height in pixels: the largest image in an ICO, an SVG's view box
/// (else its width and height). None when the bytes are not that kind of image.
pub fn dimensions(bytes: &[u8], ext: &str) -> Option<(u32, u32)> {
    let size = match ext {
        "png" => png_size(bytes),
        "ico" => ico_size(bytes),
        "svg" => svg_size(bytes),
        "webp" => webp_size(bytes),
        "jpg" | "jpeg" => jpeg_size(bytes),
        _ => None,
    }?;
    (size.0 > 0 && size.1 > 0).then_some(size)
}

fn be16(b: &[u8], at: usize) -> u32 {
    u32::from(b[at]) << 8 | u32::from(b[at + 1])
}

fn le16(b: &[u8], at: usize) -> u32 {
    u32::from(b[at]) | u32::from(b[at + 1]) << 8
}

fn le24(b: &[u8], at: usize) -> u32 {
    le16(b, at) | u32::from(b[at + 2]) << 16
}

fn png_size(b: &[u8]) -> Option<(u32, u32)> {
    if b.len() < 24 || b[..8] != [0x89, b'P', b'N', b'G', 0x0D, 0x0A, 0x1A, 0x0A] || &b[12..16] != b"IHDR" {
        return None;
    }
    let read = |at: usize| u32::from_be_bytes([b[at], b[at + 1], b[at + 2], b[at + 3]]);
    Some((read(16), read(20)))
}

fn ico_size(b: &[u8]) -> Option<(u32, u32)> {
    if b.len() < 6 || b[..4] != [0, 0, 1, 0] {
        return None;
    }
    let count = le16(b, 4) as usize;
    (0..count)
        .map(|i| 6 + 16 * i)
        .take_while(|at| at + 16 <= b.len())
        // 0 is 256.
        .map(|at| (if b[at] == 0 { 256 } else { u32::from(b[at]) }, if b[at + 1] == 0 { 256 } else { u32::from(b[at + 1]) }))
        .max_by_key(|(w, h)| w * h)
}

fn webp_size(b: &[u8]) -> Option<(u32, u32)> {
    if b.len() < 30 || &b[..4] != b"RIFF" || &b[8..12] != b"WEBP" {
        return None;
    }
    match &b[12..16] {
        b"VP8X" => Some((1 + le24(b, 24), 1 + le24(b, 27))),
        b"VP8 " => Some((le16(b, 26) & 0x3fff, le16(b, 28) & 0x3fff)),
        b"VP8L" => {
            let (b1, b2, b3, b4) = (u32::from(b[21]), u32::from(b[22]), u32::from(b[23]), u32::from(b[24]));
            Some((1 + (b1 | (b2 & 0x3f) << 8), 1 + (b2 >> 6 | b3 << 2 | (b4 & 0x0f) << 10)))
        }
        _ => None,
    }
}

fn jpeg_size(b: &[u8]) -> Option<(u32, u32)> {
    if b.len() < 4 || b[..2] != [0xFF, 0xD8] {
        return None;
    }
    let mut at = 2;
    while at + 9 < b.len() {
        if b[at] != 0xFF {
            at += 1;
            continue;
        }
        let marker = b[at + 1];
        if marker == 0xFF {
            at += 1;
            continue;
        }
        if marker == 0x01 || (0xD0..=0xD8).contains(&marker) {
            at += 2;
            continue;
        }
        // A frame's start carries the size; DHT, JPG and DAC share the range and do not.
        if (0xC0..=0xCF).contains(&marker) && !matches!(marker, 0xC4 | 0xC8 | 0xCC) {
            return Some((be16(b, at + 7), be16(b, at + 5)));
        }
        at += 2 + be16(b, at + 2) as usize;
    }
    None
}

fn svg_size(b: &[u8]) -> Option<(u32, u32)> {
    let text = String::from_utf8_lossy(b);
    let start = text.find("<svg")?;
    let end = text[start..].find('>')?;
    let tag = text[start..start + end].replace(['\n', '\r', '\t'], " ");
    let px = |value: f64| (value > 0.0).then(|| value.round().max(1.0) as u32);
    if let Some(view) = attr(&tag, "viewBox") {
        let numbers: Vec<f64> = view
            .split(|c: char| c.is_whitespace() || c == ',')
            .filter(|n| !n.is_empty())
            .filter_map(|n| n.parse().ok())
            .collect();
        if let [_, _, width, height] = numbers[..] {
            if let (Some(width), Some(height)) = (px(width), px(height)) {
                return Some((width, height));
            }
        }
    }
    let length = |name: &str| attr(&tag, name).and_then(|v| v.trim().trim_end_matches("px").parse::<f64>().ok()).and_then(px);
    Some((length("width")?, length("height")?))
}

/// An attribute's value in a tag, quoted either way.
fn attr(tag: &str, name: &str) -> Option<String> {
    ['"', '\''].into_iter().find_map(|quote| {
        let open = format!(" {name}={quote}");
        let from = tag.find(&open)? + open.len();
        let to = tag[from..].find(quote)?;
        Some(tag[from..from + to].to_string())
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::workspace;

    fn temp(prefix: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("{prefix}-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).expect("dir");
        dir
    }

    fn png(width: u32, height: u32) -> Vec<u8> {
        let mut b = vec![0x89, b'P', b'N', b'G', 0x0D, 0x0A, 0x1A, 0x0A, 0, 0, 0, 13];
        b.extend_from_slice(b"IHDR");
        b.extend_from_slice(&width.to_be_bytes());
        b.extend_from_slice(&height.to_be_bytes());
        b.extend_from_slice(&[8, 6, 0, 0, 0]);
        b
    }

    fn ico(sizes: &[u8]) -> Vec<u8> {
        let mut b = vec![0, 0, 1, 0, sizes.len() as u8, 0];
        for size in sizes {
            b.extend_from_slice(&[*size, *size, 0, 0, 1, 0, 32, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
        }
        b
    }

    fn svg(view: &str) -> Vec<u8> {
        format!(r#"<?xml version="1.0"?><svg xmlns="http://www.w3.org/2000/svg" viewBox="{view}"><rect/></svg>"#).into_bytes()
    }

    fn write(root: &Path, relative: &str, bytes: &[u8]) {
        let path = root.join(relative);
        std::fs::create_dir_all(path.parent().unwrap()).expect("dir");
        std::fs::write(path, bytes).expect("write");
    }

    #[test]
    fn names_its_icons_and_nothing_that_only_sounds_like_one() {
        for path in [
            "favicon.ico",
            "public/favicon-32x32.png",
            "public/logo512.png",
            "public/apple-touch-icon.png",
            "build/icon.png",
            "static/favicons/brand.png",
            "src-tauri/icons/128x128.png",
            "ios/Runner/Assets.xcassets/AppIcon.appiconset/Icon-1024.png",
            "assets/logo.svg",
            "assets/Logo@2x.PNG",
        ] {
            assert!(is_candidate(path), "{path} is an icon");
        }
        for path in ["src/logout.svg", "public/iconography.png", "README.md", "public/favicon.txt", "src/icons.ts"] {
            assert!(!is_candidate(path), "{path} is no icon");
        }
    }

    #[test]
    fn reads_each_kind_of_image_size() {
        assert_eq!(dimensions(&png(512, 256), "png"), Some((512, 256)));
        assert_eq!(dimensions(&ico(&[16, 0, 48]), "ico"), Some((256, 256)));
        assert_eq!(dimensions(&svg("0 0 400 100"), "svg"), Some((400, 100)));
        assert_eq!(dimensions(br#"<svg width="64px" height='32' xmlns="x">"#, "svg"), Some((64, 32)));
        assert_eq!(dimensions(b"<svg xmlns='x'></svg>", "svg"), None);
        let mut webp = b"RIFF\0\0\0\0WEBPVP8X".to_vec();
        webp.extend_from_slice(&[0; 8]);
        webp.extend_from_slice(&[0xFF, 0x01, 0, 0x7F, 0, 0]);
        assert_eq!(dimensions(&webp, "webp"), Some((512, 128)));
        let jpeg = [0xFF, 0xD8, 0xFF, 0xE0, 0, 4, 0, 0, 0xFF, 0xC0, 0, 11, 8, 0, 200, 1, 44, 3, 0, 0, 0];
        assert_eq!(dimensions(&jpeg, "jpg"), Some((300, 200)));
        assert_eq!(dimensions(b"not a png at all, not at all", "png"), None);
    }

    #[test]
    fn ranks_square_then_kind_then_largest_and_skips_builds_and_dependencies() {
        let root = temp("crew-icon-rank");
        write(&root, "public/favicon.ico", &ico(&[32]));
        write(&root, "public/logo192.png", &png(192, 192));
        write(&root, "public/logo512.png", &png(512, 512));
        write(&root, "public/logo-wide.svg", &svg("0 0 400 100"));
        write(&root, "public/icon.svg", &svg("0 0 64 64"));
        write(&root, "src/logout.svg", &svg("0 0 24 24"));
        write(&root, "node_modules/pkg/favicon.png", &png(1024, 1024));
        write(&root, "dist/favicon.svg", &svg("0 0 32 32"));
        write(&root, ".git/logo.png", &png(1024, 1024));
        write(&root, "e2e/fixtures/logo.png", &png(1024, 1024));
        write(&root, "public/logo-broken.png", b"not really a png");
        let found: Vec<String> = detect(&root).into_iter().map(|f| f.path).collect();
        assert_eq!(
            found,
            ["public/icon.svg", "public/logo512.png", "public/logo192.png", "public/favicon.ico", "public/logo-wide.svg"]
        );
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn looks_again_only_when_asked_or_old() {
        let root = temp("crew-icon-looks");
        write(&root, "favicon.ico", &ico(&[32]));
        let looks = Looks::default();
        assert_eq!(looks.found("w", &root, false).len(), 1);
        write(&root, "public/logo.png", &png(256, 256));
        assert_eq!(looks.found("w", &root, false).len(), 1, "what it found a moment ago");
        let again: Vec<String> = looks.found("w", &root, true).into_iter().map(|f| f.path).collect();
        assert_eq!(again, ["public/logo.png", "favicon.ico"]);
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn keeps_the_choice_and_the_upload_across_a_reopen_and_forgets_them_with_the_workspace() {
        let data = temp("crew-icon-data");
        let repo = temp("crew-icon-repo");
        write(&repo, "public/logo.png", &png(128, 128));
        write(&repo, "favicon.ico", &ico(&[48]));
        let db = data.join("crew.sqlite3");
        let store = Store::open(db.clone()).expect("store");
        let ws = workspace::create(&store, "app".into(), repo.to_string_lossy().into_owned()).expect("workspace");
        assert_eq!(kept(&store, &ws.id).unwrap().choice, Choice::Auto);
        let found = detect(&repo);
        assert_eq!(shown(&store, &ws.id, &repo, &found).unwrap(), Some(repo.join("public/logo.png")));

        choose(&store, &ws.id, Choice::Repo, Some("favicon.ico")).expect("repo");
        assert_eq!(shown(&store, &ws.id, &repo, &found).unwrap(), Some(repo.join("favicon.ico")));
        assert!(choose(&store, &ws.id, Choice::Repo, Some("../secret.png")).is_err(), "nothing out of the repo");
        assert!(choose(&store, &ws.id, Choice::Repo, Some("README.md")).is_err(), "only an image");
        assert!(choose(&store, &ws.id, Choice::Upload, None).is_err(), "nothing uploaded yet");

        assert!(upload(&store, &ws.id, "image/png", b"plain text").is_err(), "not a PNG");
        assert!(upload(&store, &ws.id, "text/plain", &png(64, 64)).is_err(), "not an image kind");
        upload(&store, &ws.id, "image/png", &png(64, 64)).expect("upload");
        let file = data.join("workspace-icons").join(format!("{}.png", ws.id));
        assert!(file.is_file(), "kept in the data dir");
        assert!(!repo.join(format!("{}.png", ws.id)).exists(), "never in the repo");
        drop(store);

        let store = Store::open(db).expect("reopen");
        let after = kept(&store, &ws.id).unwrap();
        assert_eq!(after.choice, Choice::Upload);
        assert_eq!(shown(&store, &ws.id, &repo, &found).unwrap(), Some(file.clone()));
        assert!(data_url(&file).unwrap().starts_with("data:image/png;base64,"));

        // Another upload, of another kind, takes its place.
        upload(&store, &ws.id, "image/svg+xml", &svg("0 0 10 10")).expect("svg");
        assert!(!file.exists());
        choose(&store, &ws.id, Choice::Initials, None).expect("initials");
        assert_eq!(shown(&store, &ws.id, &repo, &found).unwrap(), None);
        assert!(upload_file(&store, &ws.id).is_some(), "the upload stays to go back to");

        workspace::delete(&store, ws.id.clone()).expect("delete");
        assert!(!data.join("workspace-icons").join(format!("{}.svg", ws.id)).exists(), "it goes with the workspace");
        let _ = std::fs::remove_dir_all(data);
        let _ = std::fs::remove_dir_all(repo);
    }
}
