use std::io::{BufRead, BufReader, Read, Write};
use std::path::{Path, PathBuf};
use std::process::{ChildStdin, Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{mpsc, Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant, SystemTime};

use crew_protocol::{FastMode, FastModeAvailability, ListedModel, ListedTier};
use rusqlite::{params, Connection, OpenFlags};
use serde_json::{json, Value};

use crate::providers::claude::{build_control_request, parse_control_response};
use crate::shell_path;

const CHAT_ID_MAX: usize = 64;

fn is_chat_id(id: &str) -> bool {
    !id.is_empty() && id.len() <= CHAT_ID_MAX && id.chars().all(|c| c.is_ascii_alphanumeric() || c == '-')
}

const MODELS_TIMEOUT: Duration = Duration::from_secs(20);
/// Cursor adds models without a release of Crew; a new one shows up within this.
const MODELS_TTL: Duration = Duration::from_secs(10 * 60);

static CURSOR_MODELS: Mutex<Option<(Instant, Vec<ListedModel>)>> = Mutex::new(None);
/// Held while the CLI is asked, so callers that find nothing yet wait for
/// that one answer instead of asking again.
static CURSOR_LISTING: Mutex<()> = Mutex::new(());
static CURSOR_REFRESHING: AtomicBool = AtomicBool::new(false);

/// Lists cursor's models off the caller's thread when its CLI is installed,
/// so the first model picker opened already has them.
pub fn prewarm_cursor_models() {
    thread::spawn(|| {
        if shell_path::resolve("cursor-agent").is_some() {
            cursor_models();
        }
    });
}

/// Every model `cursor-agent models` lists for this account, each effort and
/// fast variant its own id (`grok-4.7-high-fast`). The CLI takes about a
/// second, so only the first call waits for it: past `MODELS_TTL` the last
/// answer is returned while a new one is read behind it. Empty when the CLI
/// is missing or fails, and then asked again next time.
pub fn cursor_models() -> Vec<ListedModel> {
    if let Some((at, models)) = cached_cursor_models() {
        if at.elapsed() >= MODELS_TTL && !CURSOR_REFRESHING.swap(true, Ordering::SeqCst) {
            thread::spawn(|| {
                refresh_cursor_models();
                CURSOR_REFRESHING.store(false, Ordering::SeqCst);
            });
        }
        return models;
    }
    let _listing = CURSOR_LISTING.lock().unwrap_or_else(|e| e.into_inner());
    match cached_cursor_models() {
        Some((_, models)) => models,
        None => refresh_cursor_models(),
    }
}

fn cached_cursor_models() -> Option<(Instant, Vec<ListedModel>)> {
    CURSOR_MODELS.lock().unwrap_or_else(|e| e.into_inner()).clone()
}

fn refresh_cursor_models() -> Vec<ListedModel> {
    let models = list_cursor_models().unwrap_or_else(|err| {
        eprintln!("[models] {err}");
        Vec::new()
    });
    if !models.is_empty() {
        *CURSOR_MODELS.lock().unwrap_or_else(|e| e.into_inner()) = Some((Instant::now(), models.clone()));
    }
    models
}

fn list_cursor_models() -> Result<Vec<ListedModel>, String> {
    let binary = shell_path::resolve("cursor-agent")
        .ok_or_else(|| "`cursor-agent` was not found on your PATH.".to_string())?;
    let mut child = Command::new(binary)
        .arg("models")
        .env("PATH", shell_path::joined())
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .map_err(|e| format!("cursor-agent models: {e}"))?;
    // Read while it runs: the list is bigger than a pipe holds on some systems.
    let mut stdout = child.stdout.take().ok_or("cursor-agent models: no stdout")?;
    let reader = thread::spawn(move || {
        let mut out = String::new();
        let _ = stdout.read_to_string(&mut out);
        out
    });
    let deadline = Instant::now() + MODELS_TIMEOUT;
    let status = loop {
        match child.try_wait().map_err(|e| e.to_string())? {
            Some(status) => break status,
            None if Instant::now() < deadline => thread::sleep(Duration::from_millis(50)),
            None => {
                let _ = child.kill();
                let _ = child.wait();
                return Err("cursor-agent models did not answer".into());
            }
        }
    };
    let out = reader.join().unwrap_or_default();
    if !status.success() {
        return Err(format!("cursor-agent models exited with {status}"));
    }
    Ok(parse_cursor_models(&out))
}

/// How cursor spells an effort on a variant id, longest suffix first, and the
/// token Crew compares. `extra-high` and `xhigh` are one effort.
const EFFORT_SUFFIXES: &[(&str, &str)] = &[
    ("extra-high", "xhigh"),
    ("xhigh", "xhigh"),
    ("minimal", "minimal"),
    ("medium", "medium"),
    ("none", "none"),
    ("high", "high"),
    ("low", "low"),
    ("max", "max"),
];

struct VariantParts {
    base: String,
    effort: Option<&'static str>,
    fast: bool,
}

/// `grok-4.7-xhigh-fast` is `grok-4.7` at extra high, fast. The same split
/// `splitVariant` does in `src/lib/providers.ts`.
fn split_variant(id: &str) -> VariantParts {
    let (rest, fast) = match id.strip_suffix("-fast") {
        Some(rest) => (rest, true),
        None => (id, false),
    };
    for (suffix, token) in EFFORT_SUFFIXES {
        if let Some(base) = rest.strip_suffix(&format!("-{suffix}")) {
            return VariantParts { base: base.to_string(), effort: Some(*token), fast };
        }
        if let Some(head) = rest.strip_suffix(&format!("-{suffix}-thinking")) {
            return VariantParts { base: format!("{head}-thinking"), effort: Some(*token), fast };
        }
    }
    VariantParts { base: rest.to_string(), effort: None, fast }
}

fn effort_token(value: &str) -> Option<&'static str> {
    match value {
        "xhigh" | "extra-high" | "extra_high" => Some("xhigh"),
        "max" => Some("max"),
        "high" => Some("high"),
        "medium" => Some("medium"),
        "low" => Some("low"),
        "minimal" => Some("minimal"),
        "none" => Some("none"),
        _ => None,
    }
}

fn is_auto_model(id: &str) -> bool {
    id.is_empty() || id == "auto" || id == "default"
}

fn param_string(value: &serde_json::Value) -> Option<String> {
    match value {
        serde_json::Value::String(text) => Some(text.clone()),
        serde_json::Value::Bool(on) => Some(on.to_string()),
        serde_json::Value::Number(number) => Some(number.to_string()),
        _ => None,
    }
}

fn parameters_of(value: Option<&serde_json::Value>) -> Vec<(String, String)> {
    value
        .and_then(|value| value.as_array())
        .map(|rows| {
            rows.iter()
                .filter_map(|row| {
                    let id = row.get("id").and_then(|id| id.as_str())?;
                    let value = param_string(row.get("value")?)?;
                    Some((id.to_string(), value))
                })
                .collect()
        })
        .unwrap_or_default()
}

/// `selectedModel` is what the terminal last picked. Older files only have
/// `model`, with the same parameters under `modelParameters`.
fn selection_of(value: &serde_json::Value) -> Option<(String, Vec<(String, String)>)> {
    if let Some(selected) = value.get("selectedModel").filter(|value| value.is_object()) {
        let id = selected.get("modelId").and_then(|id| id.as_str()).unwrap_or("");
        if !id.is_empty() {
            return Some((id.to_string(), parameters_of(selected.get("parameters"))));
        }
    }
    let id = value.get("model").and_then(|model| model.get("modelId")).and_then(|id| id.as_str())?;
    let params = value
        .get("modelParameters")
        .and_then(|all| all.get(id))
        .map(|rows| parameters_of(Some(rows)))
        .unwrap_or_default();
    Some((id.to_string(), params))
}

fn same_family(base: &str, model_id: &str) -> bool {
    if base == model_id || base.strip_suffix("-thinking") == Some(model_id) {
        return true;
    }
    let prefixed = format!("cursor-{model_id}");
    base == prefixed || base.strip_suffix("-thinking") == Some(prefixed.as_str())
}

/// The listed id for this selection: same family, same fast flag, and the
/// effort when one was saved. An effort the list does not have is left unmatched.
fn listed_variant<'a>(model_id: &str, effort: Option<&str>, fast: bool, listed: &'a [&'a str]) -> Option<&'a str> {
    let mut hits: Vec<&str> = listed
        .iter()
        .copied()
        .filter(|id| {
            let variant = split_variant(id);
            if !same_family(&variant.base, model_id) || variant.fast != fast {
                return false;
            }
            match effort {
                Some(wanted) => variant.effort == Some(wanted),
                None => true,
            }
        })
        .collect();
    if hits.is_empty() {
        return None;
    }
    hits.sort_by_key(|id| {
        let variant = split_variant(id);
        let exact = if variant.base == model_id { 0 } else { 1 };
        let rank = if effort.is_some() {
            0
        } else {
            match variant.effort {
                None => 0,
                Some("medium") => 1,
                Some(_) => 2,
            }
        };
        (exact, rank, id.len())
    });
    hits.first().copied()
}

fn synthesize_variant(model_id: &str, effort: Option<&str>, fast: bool) -> String {
    let mut id = match effort {
        Some(token) => format!("{model_id}-{token}"),
        None => model_id.to_string(),
    };
    if fast {
        id.push_str("-fast");
    }
    id
}

/// The `--model` id for what `cli-config.json` has selected. `auto` and the
/// CLI's own `default` are Crew's `auto`. A parameterized id (`grok-4.7`) with
/// its effort and fast flag becomes the variant `cursor-agent models` lists
/// (`grok-4.7-xhigh`). `listed` is those ids; without them the variant is spelled
/// from the parameters.
pub fn cursor_selection(config: &str, listed: &[&str]) -> Option<String> {
    let value: serde_json::Value = serde_json::from_str(config).ok()?;
    let (model_id, params) = selection_of(&value)?;
    if is_auto_model(&model_id) {
        return Some("auto".into());
    }
    let effort = params.iter().find_map(|(id, value)| {
        if id == "reasoning_effort" || id == "effort" || id == "reasoning" {
            effort_token(value)
        } else {
            None
        }
    });
    let fast = params.iter().any(|(id, value)| id == "fast" && value == "true");
    if let Some(id) = listed_variant(&model_id, effort, fast, listed) {
        return Some(id.to_string());
    }
    Some(synthesize_variant(&model_id, effort, fast))
}

struct ConfigCache {
    modified: SystemTime,
    model: String,
}

static CURSOR_CONFIG: Mutex<Option<ConfigCache>> = Mutex::new(None);

fn cached_listed_ids() -> Vec<String> {
    cached_cursor_models()
        .map(|(_, models)| models.into_iter().map(|model| model.id).collect())
        .unwrap_or_default()
}

/// The model cursor-agent has selected, as an id `--model` accepts. Missing
/// or unreadable config is `auto`, which is the CLI's own stand-in.
pub fn cursor_configured_model() -> String {
    let Some(path) = home().map(|dir| dir.join(".cursor/cli-config.json")) else {
        return "auto".into();
    };
    let Ok(modified) = std::fs::metadata(&path).and_then(|meta| meta.modified()) else {
        return "auto".into();
    };
    {
        let cache = CURSOR_CONFIG.lock().unwrap_or_else(|err| err.into_inner());
        if let Some(hit) = cache.as_ref() {
            if hit.modified == modified {
                return hit.model.clone();
            }
        }
    }
    let text = std::fs::read_to_string(&path).unwrap_or_default();
    let listed = cached_listed_ids();
    let refs: Vec<&str> = listed.iter().map(String::as_str).collect();
    let model = cursor_selection(&text, &refs).unwrap_or_else(|| "auto".into());
    *CURSOR_CONFIG.lock().unwrap_or_else(|err| err.into_inner()) = Some(ConfigCache { modified, model: model.clone() });
    model
}

/// Efforts Crew can hand Codex. Anything else (`ultra`, `persistent`) is left
/// blank so the caller uses Codex's own default instead of a flag it would drop.
const CODEX_EFFORTS: &[&str] = &["minimal", "low", "medium", "high", "xhigh", "max"];

/// A `key = "value"` before the first `[table]`. The model picker writes those
/// two keys at the top of `config.toml`; later tables are per-folder notes.
fn top_level_toml_string(text: &str, key: &str) -> Option<String> {
    for line in text.lines() {
        let trimmed = line.trim();
        if trimmed.is_empty() || trimmed.starts_with('#') {
            continue;
        }
        if trimmed.starts_with('[') {
            break;
        }
        let Some((found, rest)) = trimmed.split_once('=') else { continue };
        if found.trim() != key {
            continue;
        }
        return toml_string(rest.trim());
    }
    None
}

fn toml_string(raw: &str) -> Option<String> {
    let mut chars = raw.chars();
    let quote = chars.next()?;
    if quote != '"' && quote != '\'' {
        let word = raw.split_whitespace().next()?;
        return (!word.starts_with('#')).then(|| word.to_string());
    }
    let mut out = String::new();
    while let Some(ch) = chars.next() {
        if ch == '\\' && quote == '"' {
            out.push(chars.next()?);
            continue;
        }
        if ch == quote {
            return Some(out);
        }
        out.push(ch);
    }
    None
}

/// `priority` is the wire name of fast. Anything else Crew cannot pass is dropped.
fn normalize_service_tier(raw: &str) -> String {
    match raw {
        "priority" => "fast".into(),
        "default" | "fast" | "flex" | "ultrafast" => raw.into(),
        _ => String::new(),
    }
}

fn service_tier_label(id: &str) -> String {
    match id {
        "fast" => "Fast".into(),
        "flex" => "Flex".into(),
        "ultrafast" => "Ultrafast".into(),
        other => other.to_string(),
    }
}

/// `model`, `model_reasoning_effort` and `service_tier` from Codex's user
/// config. The effort is empty when the file names none Crew can pass, and so
/// is the tier. `None` is no model at all.
pub fn codex_selection(config: &str) -> Option<(String, String, String)> {
    let model = top_level_toml_string(config, "model")?;
    if model.is_empty() {
        return None;
    }
    let effort = top_level_toml_string(config, "model_reasoning_effort")
        .filter(|effort| CODEX_EFFORTS.contains(&effort.as_str()))
        .unwrap_or_default();
    let tier = top_level_toml_string(config, "service_tier")
        .map(|tier| normalize_service_tier(&tier))
        .unwrap_or_default();
    Some((model, effort, tier))
}

struct CodexCache {
    modified: SystemTime,
    model: String,
    effort: String,
    service_tier: String,
}

static CODEX_CONFIG: Mutex<Option<CodexCache>> = Mutex::new(None);

fn codex_fallback() -> (String, String) {
    (
        crate::tools::default_model("codex").to_string(),
        crate::tools::default_effort("codex").to_string(),
    )
}

fn codex_configured() -> (String, String, String) {
    let Some(path) = codex_home().map(|dir| dir.join("config.toml")) else {
        let (model, effort) = codex_fallback();
        return (model, effort, String::new());
    };
    let Ok(modified) = std::fs::metadata(&path).and_then(|meta| meta.modified()) else {
        let (model, effort) = codex_fallback();
        return (model, effort, String::new());
    };
    {
        let cache = CODEX_CONFIG.lock().unwrap_or_else(|err| err.into_inner());
        if let Some(hit) = cache.as_ref() {
            if hit.modified == modified {
                return (hit.model.clone(), hit.effort.clone(), hit.service_tier.clone());
            }
        }
    }
    let text = std::fs::read_to_string(&path).unwrap_or_default();
    let (model, effort, tier) = match codex_selection(&text) {
        Some((model, effort, tier)) => {
            let effort = if effort.is_empty() { crate::tools::default_effort("codex").to_string() } else { effort };
            (model, effort, tier)
        }
        None => {
            let (model, effort) = codex_fallback();
            (model, effort, String::new())
        }
    };
    *CODEX_CONFIG.lock().unwrap_or_else(|err| err.into_inner()) = Some(CodexCache {
        modified,
        model: model.clone(),
        effort: effort.clone(),
        service_tier: tier.clone(),
    });
    (model, effort, tier)
}

/// The model `~/.codex/config.toml` has selected. Missing config is Crew's stand-in.
pub fn codex_configured_model() -> String {
    codex_configured().0
}

/// `model_reasoning_effort` from the same file, or Codex's default when it names none.
pub fn codex_configured_effort() -> String {
    codex_configured().1
}

/// `service_tier` from the same file. Empty when it names none Crew can pass.
pub fn codex_configured_service_tier() -> String {
    codex_configured().2
}

static CODEX_MODELS: Mutex<Option<(Instant, Vec<ListedModel>)>> = Mutex::new(None);
static CODEX_LISTING: Mutex<()> = Mutex::new(());
static CODEX_REFRESHING: AtomicBool = AtomicBool::new(false);

/// Lists Codex's models off the caller's thread when its CLI is installed.
pub fn prewarm_codex_models() {
    thread::spawn(|| {
        if shell_path::resolve("codex").is_some() {
            codex_models();
        }
    });
}

/// Every model `codex debug models` lists for this account, hidden ones left
/// out. Each carries the service tiers it advertises, besides Standard.
/// Empty when the CLI is missing or fails, and then asked again next time.
pub fn codex_models() -> Vec<ListedModel> {
    if let Some((at, models)) = cached_codex_models() {
        if at.elapsed() >= MODELS_TTL && !CODEX_REFRESHING.swap(true, Ordering::SeqCst) {
            thread::spawn(|| {
                refresh_codex_models();
                CODEX_REFRESHING.store(false, Ordering::SeqCst);
            });
        }
        return models;
    }
    let _listing = CODEX_LISTING.lock().unwrap_or_else(|e| e.into_inner());
    match cached_codex_models() {
        Some((_, models)) => models,
        None => refresh_codex_models(),
    }
}

fn cached_codex_models() -> Option<(Instant, Vec<ListedModel>)> {
    CODEX_MODELS.lock().unwrap_or_else(|e| e.into_inner()).clone()
}

fn refresh_codex_models() -> Vec<ListedModel> {
    let models = list_codex_models().unwrap_or_else(|err| {
        eprintln!("[models] {err}");
        Vec::new()
    });
    if !models.is_empty() {
        *CODEX_MODELS.lock().unwrap_or_else(|e| e.into_inner()) = Some((Instant::now(), models.clone()));
    }
    models
}

fn list_codex_models() -> Result<Vec<ListedModel>, String> {
    let binary = shell_path::resolve("codex").ok_or_else(|| "`codex` was not found on your PATH.".to_string())?;
    let mut child = Command::new(binary)
        .args(["debug", "models"])
        .env("PATH", shell_path::joined())
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .map_err(|e| format!("codex debug models: {e}"))?;
    let mut stdout = child.stdout.take().ok_or("codex debug models: no stdout")?;
    let reader = thread::spawn(move || {
        let mut out = String::new();
        let _ = stdout.read_to_string(&mut out);
        out
    });
    let deadline = Instant::now() + MODELS_TIMEOUT;
    let status = loop {
        match child.try_wait().map_err(|e| e.to_string())? {
            Some(status) => break status,
            None if Instant::now() < deadline => thread::sleep(Duration::from_millis(50)),
            None => {
                let _ = child.kill();
                let _ = child.wait();
                return Err("codex debug models did not answer".into());
            }
        }
    };
    let out = reader.join().unwrap_or_default();
    if !status.success() {
        return Err(format!("codex debug models exited with {status}"));
    }
    Ok(parse_codex_models(&out))
}

/// The catalog is one JSON value, sometimes after a line of chatter. Models
/// sit under `models` or `data`, or are the value itself. `visibility` of
/// `hide` (and `hidden`) is left out. `priority` is fast.
fn parse_codex_models(out: &str) -> Vec<ListedModel> {
    let start = json_start(out);
    let value: serde_json::Value = serde_json::from_str(out[start..].trim()).unwrap_or(serde_json::Value::Null);
    let rows = value
        .as_array()
        .cloned()
        .or_else(|| value.get("models").and_then(|v| v.as_array()).cloned())
        .or_else(|| value.get("data").and_then(|v| v.as_array()).cloned())
        .unwrap_or_default();
    rows.iter().filter_map(listed_codex_model).collect()
}

fn json_start(out: &str) -> usize {
    match (out.find('{'), out.find('[')) {
        (Some(brace), Some(bracket)) => brace.min(bracket),
        (Some(brace), None) => brace,
        (None, Some(bracket)) => bracket,
        (None, None) => out.len(),
    }
}

fn listed_codex_model(row: &serde_json::Value) -> Option<ListedModel> {
    if row.get("hidden").and_then(|v| v.as_bool()) == Some(true) {
        return None;
    }
    if row.get("visibility").and_then(|v| v.as_str()) == Some("hide") {
        return None;
    }
    let id = ["slug", "model", "id"]
        .iter()
        .find_map(|key| row.get(*key).and_then(|v| v.as_str()).filter(|id| !id.is_empty()))?;
    let label = ["display_name", "displayName", "name"]
        .iter()
        .find_map(|key| {
            row.get(*key)
                .and_then(|v| v.as_str())
                .map(str::trim)
                .filter(|label| !label.is_empty())
        })
        .unwrap_or(id);
    Some(ListedModel {
        id: id.to_string(),
        label: label.to_string(),
        tiers: Some(codex_tiers(row)),
    })
}

fn codex_tiers(row: &serde_json::Value) -> Vec<ListedTier> {
    let mut tiers = Vec::new();
    let mut seen = std::collections::HashSet::new();
    for key in ["service_tiers", "serviceTiers", "additional_speed_tiers", "additionalSpeedTiers"] {
        let Some(list) = row.get(key).and_then(|value| value.as_array()) else { continue };
        for item in list {
            let (wire, name) = tier_of(item);
            let Some(wire) = wire else { continue };
            let id = normalize_service_tier(&wire);
            if id.is_empty() || id == "default" || !seen.insert(id.clone()) {
                continue;
            }
            let label = name.filter(|label| !label.is_empty()).unwrap_or_else(|| service_tier_label(&id));
            tiers.push(ListedTier { id, label });
        }
    }
    tiers
}

fn tier_of(item: &serde_json::Value) -> (Option<String>, Option<String>) {
    if let Some(id) = item.as_str() {
        return (Some(id.to_string()), None);
    }
    let id = ["id", "slug"]
        .iter()
        .find_map(|key| item.get(*key).and_then(|v| v.as_str()))
        .map(str::to_string);
    let name = ["name", "display_name", "displayName"]
        .iter()
        .find_map(|key| item.get(*key).and_then(|v| v.as_str()))
        .map(str::to_string);
    (id, name)
}

static CLAUDE_FAST_MODE: Mutex<Option<(Instant, FastMode)>> = Mutex::new(None);
static CLAUDE_FAST_MODE_REFRESHING: AtomicBool = AtomicBool::new(false);
static CLAUDE_FAST_MODE_LISTENER: Mutex<Option<Arc<dyn Fn(&FastMode) + Send + Sync>>> = Mutex::new(None);
/// An account's fast mode changes rarely; a reading is taken again after a day.
const FAST_MODE_TTL: Duration = Duration::from_secs(24 * 60 * 60);
/// Reasons that say the account cannot use fast mode at all.
const HIDING_REASONS: [&str; 6] =
    ["free", "preference", "extra_usage_disabled", "not_first_party", "disabled_by_env", "model_not_allowed"];

/// What to tell the user when Claude ran a turn asked to be fast at standard
/// speed, which it does without a word: `reason` is its
/// `fast_mode_disabled_reason`. None when the reason does not rule fast out.
pub fn claude_fast_refusal(reason: &str) -> Option<String> {
    if !HIDING_REASONS.contains(&reason) {
        return None;
    }
    let why = match reason {
        "extra_usage_disabled" => "it needs extra usage, which this account does not have turned on".to_string(),
        "free" => "this plan does not include it".to_string(),
        "not_first_party" => "it is only offered on Anthropic's own API".to_string(),
        "model_not_allowed" => "this model does not offer it".to_string(),
        other => format!("Claude Code turned it down ({other})"),
    };
    Some(format!("Fast mode is not available: {why}. The turn ran at standard speed."))
}

/// Asks Claude's CLI for the fast-mode state off the caller's thread when it is
/// installed, so the Fast toggle has its answer by the first composer.
pub fn prewarm_claude_fast_mode() {
    refresh_claude_fast_mode_in_background();
}

/// The account's fast mode as last read. Asks again in the background once the
/// reading is a day old, or when there is none yet; until then, Unknown.
pub fn claude_fast_mode() -> FastMode {
    let cached = CLAUDE_FAST_MODE.lock().unwrap_or_else(|e| e.into_inner()).clone();
    match cached {
        Some((at, mode)) => {
            if at.elapsed() >= FAST_MODE_TTL {
                refresh_claude_fast_mode_in_background();
            }
            mode
        }
        None => {
            refresh_claude_fast_mode_in_background();
            FastMode { availability: FastModeAvailability::Unknown, reason: None }
        }
    }
}

/// The reading as it stands, without asking again: for what only wants to
/// know whether the toggle shows, and would not start a CLI to find out.
pub fn claude_fast_mode_cached() -> Option<FastMode> {
    CLAUDE_FAST_MODE.lock().unwrap_or_else(|e| e.into_inner()).as_ref().map(|(_, mode)| mode.clone())
}

/// Feeds a reading Claude gave on a turn into the same cache. `state` and
/// `reason` are its `fast_mode_state` and `fast_mode_disabled_reason`.
pub fn note_claude_fast_mode(state: Option<&str>, reason: Option<&str>) {
    let (changed, mode) = {
        let mut cache = CLAUDE_FAST_MODE.lock().unwrap_or_else(|e| e.into_inner());
        let previous = cache.as_ref().map(|(_, mode)| mode.clone());
        let mode = fast_mode_from(state, reason, previous.as_ref());
        *cache = Some((Instant::now(), mode.clone()));
        (previous.as_ref() != Some(&mode), mode)
    };
    if changed {
        let listener = CLAUDE_FAST_MODE_LISTENER.lock().unwrap_or_else(|e| e.into_inner()).clone();
        if let Some(listener) = listener {
            listener(&mode);
        }
    }
}

/// Told each reading that changes the fast mode, so every window can be pushed it.
pub fn set_claude_fast_mode_listener(listener: impl Fn(&FastMode) + Send + Sync + 'static) {
    *CLAUDE_FAST_MODE_LISTENER.lock().unwrap_or_else(|e| e.into_inner()) = Some(Arc::new(listener));
}

/// One probe at a time: a caller that finds one running leaves it to answer.
fn refresh_claude_fast_mode_in_background() {
    if CLAUDE_FAST_MODE_REFRESHING.swap(true, Ordering::SeqCst) {
        return;
    }
    thread::spawn(|| {
        refresh_claude_fast_mode();
        CLAUDE_FAST_MODE_REFRESHING.store(false, Ordering::SeqCst);
    });
}

/// How many times the CLI is asked. It now and then answers `on` with no
/// reason for an account that cannot use fast mode (2.1.299: one in four), so
/// an `on` is only believed when every answer says so.
const FAST_MODE_PROBES: usize = 2;

fn refresh_claude_fast_mode() {
    let Some(binary) = shell_path::resolve("claude") else { return };
    let mut answers = Vec::new();
    for _ in 0..FAST_MODE_PROBES {
        match probe_claude_fast_mode(&binary) {
            Ok(answer) => answers.push(answer),
            Err(err) => eprintln!("[fast mode] {err}"),
        }
    }
    if let Some((state, reason)) = believed_fast_mode(answers) {
        note_claude_fast_mode(state.as_deref(), reason.as_deref());
    }
}

/// The answer that stands among several: one that rules fast out wins, then
/// one that gives any reason, then the first.
fn believed_fast_mode(answers: Vec<(Option<String>, Option<String>)>) -> Option<(Option<String>, Option<String>)> {
    let refused = |answer: &(Option<String>, Option<String>)| {
        answer.1.as_deref().is_some_and(|reason| HIDING_REASONS.contains(&reason))
    };
    let position = answers
        .iter()
        .position(refused)
        .or_else(|| answers.iter().position(|answer| answer.1.is_some()))
        .unwrap_or(0);
    answers.into_iter().nth(position)
}

/// Asks the CLI for the account's fast-mode state over its control channel: an
/// initialize request, which starts no turn and costs nothing. The CLI only
/// reports the state when fast mode is opted into, hence the setting. It is
/// stopped once it has answered.
fn probe_claude_fast_mode(binary: &Path) -> Result<(Option<String>, Option<String>), String> {
    let (mut child, mut stdin, lines) = spawn_claude_control(
        binary,
        &[
            "--output-format",
            "stream-json",
            "--verbose",
            "--input-format",
            "stream-json",
            "--setting-sources=project,local",
            "--strict-mcp-config",
            "--settings",
            r#"{"fastMode":true}"#,
        ],
        &home().unwrap_or_else(std::env::temp_dir),
        "claude fast mode",
    )?;
    let outcome = initialize_for_fast_mode(&mut stdin, &lines);
    let _ = child.kill();
    let _ = child.wait();
    outcome
}

fn initialize_for_fast_mode(
    stdin: &mut ChildStdin,
    lines: &mpsc::Receiver<String>,
) -> Result<(Option<String>, Option<String>), String> {
    let request = build_control_request("1", json!({ "subtype": "initialize" }));
    writeln!(stdin, "{request}").and_then(|_| stdin.flush()).map_err(|e| format!("claude fast mode: {e}"))?;
    let deadline = Instant::now() + MODELS_TIMEOUT;
    loop {
        let line = lines
            .recv_timeout(deadline.saturating_duration_since(Instant::now()))
            .map_err(|e| match e {
                mpsc::RecvTimeoutError::Timeout => "claude fast mode did not answer".to_string(),
                mpsc::RecvTimeoutError::Disconnected => "claude fast mode exited before answering".to_string(),
            })?;
        let Ok(Value::Object(record)) = serde_json::from_str::<Value>(&line) else { continue };
        let Some((id, answer)) = parse_control_response(&record) else { continue };
        if id != "1" {
            continue;
        }
        let response = answer?;
        let text = |key: &str| response.get(key).and_then(Value::as_str).map(str::to_string);
        return Ok((text("fast_mode_state"), text("fast_mode_disabled_reason")));
    }
}

/// A Claude CLI started to be asked over its control channel, with the lines
/// it prints coming through the receiver. The caller kills it.
fn spawn_claude_control(
    binary: &Path,
    args: &[&str],
    cwd: &Path,
    what: &str,
) -> Result<(std::process::Child, ChildStdin, mpsc::Receiver<String>), String> {
    let mut child = Command::new(binary)
        .args(args)
        .env("PATH", shell_path::joined())
        .current_dir(cwd)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .map_err(|e| format!("{what}: {e}"))?;
    let (Some(stdin), Some(stdout)) = (child.stdin.take(), child.stdout.take()) else {
        let _ = child.kill();
        let _ = child.wait();
        return Err(format!("{what}: no pipes"));
    };
    let (sender, lines) = mpsc::channel();
    thread::spawn(move || {
        for line in BufReader::new(stdout).lines().map_while(Result::ok) {
            if sender.send(line).is_err() {
                break;
            }
        }
    });
    Ok((child, stdin, lines))
}

/// What a Claude CLI lists for a folder: its commands, and the names among
/// them that are skills.
#[derive(Debug, PartialEq, Eq)]
pub struct ClaudeMenu {
    pub commands: Vec<crew_protocol::CommandEntry>,
    pub skills: std::collections::HashSet<String>,
}

/// Asks a Claude CLI for the `/` menu of `cwd` without a model turn: it is
/// started with the user's, the project's and the local settings the user's
/// sessions read and none of their MCP servers, sent `initialize` for the
/// commands and `reload_skills` for which of them are skills, and killed once
/// both have answered. A CLI too old to know `reload_skills` leaves the skills
/// out and the commands stand.
pub fn probe_claude_commands(binary: &Path, cwd: &Path) -> Result<ClaudeMenu, String> {
    let (mut child, mut stdin, lines) = spawn_claude_control(
        binary,
        &[
            "-p",
            "--output-format",
            "stream-json",
            "--verbose",
            "--input-format",
            "stream-json",
            "--setting-sources=user,project,local",
            "--strict-mcp-config",
        ],
        cwd,
        "claude commands",
    )?;
    let outcome = ask_claude_menu(&mut stdin, &lines);
    let _ = child.kill();
    let _ = child.wait();
    outcome
}

fn ask_claude_menu(stdin: &mut ChildStdin, lines: &mpsc::Receiver<String>) -> Result<ClaudeMenu, String> {
    for (id, subtype) in [("1", "initialize"), ("2", "reload_skills")] {
        let request = build_control_request(id, json!({ "subtype": subtype }));
        writeln!(stdin, "{request}").and_then(|_| stdin.flush()).map_err(|e| format!("claude commands: {e}"))?;
    }
    let deadline = Instant::now() + MODELS_TIMEOUT;
    let mut commands: Option<Vec<crew_protocol::CommandEntry>> = None;
    let mut skills: Option<std::collections::HashSet<String>> = None;
    while commands.is_none() || skills.is_none() {
        let line = lines
            .recv_timeout(deadline.saturating_duration_since(Instant::now()))
            .map_err(|e| match e {
                mpsc::RecvTimeoutError::Timeout => "claude commands did not answer".to_string(),
                mpsc::RecvTimeoutError::Disconnected => "claude commands exited before answering".to_string(),
            })?;
        let Ok(Value::Object(record)) = serde_json::from_str::<Value>(&line) else { continue };
        let Some((id, answer)) = parse_control_response(&record) else { continue };
        match id.as_str() {
            "1" => {
                let response = answer?;
                commands = Some(crate::commands::claude_entries(response.get("commands").unwrap_or(&Value::Null)));
            }
            "2" => {
                skills = Some(match answer {
                    Ok(response) => crate::commands::claude_skill_names(response.get("skills").unwrap_or(&Value::Null)),
                    Err(_) => Default::default(),
                });
            }
            _ => {}
        }
    }
    Ok(ClaudeMenu { commands: commands.unwrap_or_default(), skills: skills.unwrap_or_default() })
}

/// What Crew shows for a reading. A reason that rules the account out hides the
/// toggle; a cooldown after a rate limit shows it; any other reason (pending, a
/// network error, one Crew does not know) keeps the last reading, so an answer
/// that says nothing yet never flips the toggle. No reason means available, and
/// a reply with neither field keeps the last reading as well.
fn fast_mode_from(state: Option<&str>, reason: Option<&str>, last: Option<&FastMode>) -> FastMode {
    let keep = last.cloned().unwrap_or(FastMode { availability: FastModeAvailability::Unknown, reason: None });
    match (state, reason) {
        (_, Some(reason)) if HIDING_REASONS.contains(&reason) => {
            FastMode { availability: FastModeAvailability::Hidden, reason: Some(reason.to_string()) }
        }
        (Some("cooldown"), _) => FastMode { availability: FastModeAvailability::Cooldown, reason: None },
        (_, Some(_)) => keep,
        (Some(_), None) => FastMode { availability: FastModeAvailability::Available, reason: None },
        (None, None) => keep,
    }
}

fn opencode_config_file() -> Option<PathBuf> {
    let config = match std::env::var("XDG_CONFIG_HOME") {
        Ok(dir) if !dir.is_empty() => PathBuf::from(dir),
        _ => home()?.join(".config"),
    };
    Some(config.join("opencode/opencode.json"))
}

fn opencode_model_state() -> Option<PathBuf> {
    let state = match std::env::var("XDG_STATE_HOME") {
        Ok(dir) if !dir.is_empty() => PathBuf::from(dir),
        _ => home()?.join(".local/state"),
    };
    Some(state.join("opencode/model.json"))
}

/// The model a new `opencode` starts on. Config `model` wins; otherwise the
/// first named entry of `model.json`'s `recent` list, as `provider/model`.
pub fn opencode_selection(config: &str, state: &str) -> Option<String> {
    if let Ok(value) = serde_json::from_str::<serde_json::Value>(config) {
        if let Some(model) = value.get("model").and_then(|model| model.as_str()) {
            let model = model.trim();
            if !model.is_empty() {
                return Some(model.to_string());
            }
        }
    }
    let value: serde_json::Value = serde_json::from_str(state).ok()?;
    let recent = value.get("recent")?.as_array()?;
    for item in recent {
        let provider = item.get("providerID").and_then(|id| id.as_str()).unwrap_or("").trim();
        let model = item.get("modelID").and_then(|id| id.as_str()).unwrap_or("").trim();
        if provider.is_empty() || model.is_empty() || provider.contains('/') {
            continue;
        }
        return Some(format!("{provider}/{model}"));
    }
    None
}

struct OpencodeCache {
    config_modified: Option<SystemTime>,
    state_modified: Option<SystemTime>,
    model: String,
}

static OPENCODE_CONFIG: Mutex<Option<OpencodeCache>> = Mutex::new(None);

fn file_mtime(path: &Option<PathBuf>) -> Option<SystemTime> {
    path.as_ref().and_then(|path| std::fs::metadata(path).and_then(|meta| meta.modified()).ok())
}

/// The model opencode would start on, from its config or its last-used list.
/// Missing files are Crew's stand-in.
pub fn opencode_configured_model() -> String {
    let config_path = opencode_config_file();
    let state_path = opencode_model_state();
    if config_path.is_none() && state_path.is_none() {
        return crate::tools::default_model("opencode").to_string();
    }
    let config_modified = file_mtime(&config_path);
    let state_modified = file_mtime(&state_path);
    {
        let cache = OPENCODE_CONFIG.lock().unwrap_or_else(|err| err.into_inner());
        if let Some(hit) = cache.as_ref() {
            if hit.config_modified == config_modified && hit.state_modified == state_modified {
                return hit.model.clone();
            }
        }
    }
    let config = config_path.as_ref().and_then(|path| std::fs::read_to_string(path).ok()).unwrap_or_default();
    let state = state_path.as_ref().and_then(|path| std::fs::read_to_string(path).ok()).unwrap_or_default();
    let model = opencode_selection(&config, &state).unwrap_or_else(|| crate::tools::default_model("opencode").to_string());
    *OPENCODE_CONFIG.lock().unwrap_or_else(|err| err.into_inner()) =
        Some(OpencodeCache { config_modified, state_modified, model: model.clone() });
    model
}

/// `id - Label` lines between a heading and a tip. Labels carry zero-width
/// spaces and doubled spaces the terminal hides; they go.
fn parse_cursor_models(out: &str) -> Vec<ListedModel> {
    out.lines()
        .filter_map(|line| {
            let (id, label) = line.trim().split_once(" - ")?;
            if id.is_empty() || id.chars().any(char::is_whitespace) {
                return None;
            }
            let label = label
                .replace('\u{200b}', "")
                .split_whitespace()
                .collect::<Vec<_>>()
                .join(" ");
            Some(ListedModel { id: id.to_string(), label, tiers: Some(Vec::new()) })
        })
        .collect()
}

/// Where Claude keeps its transcripts: under `home`. Tests hand in their own.
#[derive(Clone, Debug, Default)]
pub struct ClaudeDirs {
    pub home: Option<PathBuf>,
}

impl ClaudeDirs {
    pub fn from_env() -> Self {
        Self { home: home() }
    }
}

/// The name the CLI gave a session once the first exchange settles it; the
/// placeholder each one shows before that is not a name.
pub fn title(provider: &str, id: &str) -> Option<String> {
    let title = match provider {
        "codex" => codex_title(&codex_home()?.join("session_index.jsonl"), id),
        "cursor" => cursor_title(&home()?.join(".cursor/chats"), id),
        "opencode" => opencode_title(&opencode_db()?, id),
        _ => None,
    }?;
    let title = title.trim();
    (!title.is_empty()).then(|| title.to_string())
}

/// Whether anything was said in the session `crew_id` of `provider`, run in
/// `cwd`, as its provider kept it. A provider Crew cannot read counts as having spoken, so
/// its sessions are never taken for empty.
pub fn has_conversation(
    home: Option<&Path>,
    provider: &str,
    crew_id: &str,
    bound: Option<&str>,
    cwd: &str,
) -> bool {
    let Some(home) = home else { return true };
    match provider {
        // Crew's id until a `/clear` moves Claude on.
        "claude" => claude_has_turn(&claude_transcript(home, cwd, bound.unwrap_or(crew_id))),
        "cursor" => bound.is_some_and(|id| cursor_has_conversation(&home.join(".cursor/chats"), id)),
        "codex" | "opencode" => bound.is_some(),
        _ => true,
    }
}

pub(crate) fn claude_transcript(home: &Path, cwd: &str, id: &str) -> PathBuf {
    home.join(".claude/projects").join(crate::claude_title::project_slug(cwd)).join(format!("{id}.jsonl"))
}

/// Claude writes titles and remote-control records before the first prompt, so
/// a transcript on disk is not yet a conversation.
fn claude_has_turn(transcript: &Path) -> bool {
    let Ok(file) = std::fs::File::open(transcript) else { return false };
    BufReader::new(file)
        .lines()
        .map_while(Result::ok)
        .filter(|line| line.contains("\"user\""))
        .filter_map(|line| serde_json::from_str::<serde_json::Value>(&line).ok())
        .any(|record| record.get("type").and_then(|t| t.as_str()) == Some("user"))
}

/// `create-chat` writes nothing; the TUI writes `hasConversation: false` on
/// open and flips it with the first message.
fn cursor_has_conversation(chats: &Path, id: &str) -> bool {
    if !is_chat_id(id) {
        return false;
    }
    sorted_dirs(chats).into_iter().any(|folder| {
        std::fs::read_to_string(folder.join(id).join("meta.json"))
            .ok()
            .and_then(|meta| serde_json::from_str::<serde_json::Value>(&meta).ok())
            .and_then(|meta| meta.get("hasConversation")?.as_bool())
            .unwrap_or(false)
    })
}

/// Append-only: a `/rename` lands as a later line for the same id.
fn codex_title(index: &Path, id: &str) -> Option<String> {
    let text = std::fs::read_to_string(index).ok()?;
    text.lines()
        .rev()
        .filter(|line| line.contains(id))
        .filter_map(|line| serde_json::from_str::<serde_json::Value>(line).ok())
        .find(|entry| entry.get("id").and_then(|v| v.as_str()) == Some(id))
        .and_then(|entry| entry.get("thread_name")?.as_str().map(str::to_string))
}

/// Chats sit under a folder hashed from the cwd, so the id alone finds them.
fn cursor_title(chats: &Path, id: &str) -> Option<String> {
    if !is_chat_id(id) {
        return None;
    }
    sorted_dirs(chats).into_iter().find_map(|folder| {
        let meta = std::fs::read_to_string(folder.join(id).join("meta.json")).ok()?;
        let value: serde_json::Value = serde_json::from_str(&meta).ok()?;
        value.get("title")?.as_str().map(str::to_string)
    })
}

fn opencode_title(db: &Path, id: &str) -> Option<String> {
    if !db.exists() {
        return None;
    }
    let conn = Connection::open_with_flags(db, OpenFlags::SQLITE_OPEN_READ_ONLY).ok()?;
    conn.busy_timeout(Duration::from_millis(500)).ok()?;
    let title: String = conn
        .query_row("SELECT title FROM session WHERE id = ?1", params![id], |row| row.get(0))
        .ok()?;
    (!title.starts_with("New session - ")).then_some(title)
}

fn home() -> Option<PathBuf> {
    std::env::var("HOME").ok().filter(|h| !h.is_empty()).map(PathBuf::from)
}

pub fn codex_home() -> Option<PathBuf> {
    match std::env::var("CODEX_HOME") {
        Ok(dir) if !dir.is_empty() => Some(PathBuf::from(dir)),
        _ => home().map(|h| h.join(".codex")),
    }
}

pub fn opencode_db() -> Option<PathBuf> {
    let data = match std::env::var("XDG_DATA_HOME") {
        Ok(dir) if !dir.is_empty() => PathBuf::from(dir),
        _ => home()?.join(".local/share"),
    };
    Some(data.join("opencode/opencode.db"))
}

/// Where cursor-agent wrote chat `id`'s transcript: under a folder hashed from
/// the cwd, so the id alone finds it.
pub fn cursor_transcript(id: &str) -> Option<PathBuf> {
    if !is_chat_id(id) {
        return None;
    }
    sorted_dirs(&home()?.join(".cursor/projects"))
        .into_iter()
        .map(|project| project.join("agent-transcripts").join(id).join(format!("{id}.jsonl")))
        .find(|path| path.is_file())
}

fn sorted_dirs(dir: &Path) -> Vec<PathBuf> {
    let mut dirs: Vec<PathBuf> = std::fs::read_dir(dir)
        .map(|entries| entries.flatten().map(|e| e.path()).filter(|p| p.is_dir()).collect())
        .unwrap_or_default();
    dirs.sort();
    dirs
}

#[cfg(test)]
mod tests {
    use super::*;
    use crew_protocol::{ListedModel, ListedTier};

    #[test]
    fn a_terminal_selection_becomes_the_variant_the_cli_lists() {
        let grok = r#"{"selectedModel":{"modelId":"grok-4.7","parameters":[
            {"id":"context","value":"256k"},
            {"id":"reasoning_effort","value":"xhigh"},
            {"id":"fast","value":"false"}
        ]}}"#;
        let listed = [
            "auto",
            "grok-4.7-high",
            "grok-4.7-xhigh",
            "grok-4.7-xhigh-fast",
            "cursor-grok-4.6-high",
            "gpt-5.5-high",
            "gpt-5.5-extra-high",
        ];
        assert_eq!(cursor_selection(grok, &listed).as_deref(), Some("grok-4.7-xhigh"));

        let fast = r#"{"selectedModel":{"modelId":"grok-4.7","parameters":[
            {"id":"reasoning_effort","value":"high"},
            {"id":"fast","value":"true"}
        ]}}"#;
        assert_eq!(cursor_selection(fast, &listed).as_deref(), Some("grok-4.7-high-fast"));

        // The parameterized id is `grok-4.6`; the listed one is prefixed.
        let older = r#"{"model":{"modelId":"grok-4.6"},"modelParameters":{"grok-4.6":[{"id":"effort","value":"high"}]}}"#;
        assert_eq!(cursor_selection(older, &listed).as_deref(), Some("cursor-grok-4.6-high"));

        // `extra-high` and `xhigh` are the same effort; the list says which spelling it uses.
        let sol = r#"{"selectedModel":{"modelId":"gpt-5.5","parameters":[{"id":"reasoning","value":"xhigh"}]}}"#;
        assert_eq!(cursor_selection(sol, &listed).as_deref(), Some("gpt-5.5-extra-high"));
    }

    #[test]
    fn auto_and_a_missing_list_still_name_a_model() {
        let auto = r#"{"selectedModel":{"modelId":"default","parameters":[]},"model":{"displayModelId":"auto"}}"#;
        assert_eq!(cursor_selection(auto, &[]).as_deref(), Some("auto"));
        let grok = r#"{"selectedModel":{"modelId":"grok-4.7","parameters":[{"id":"reasoning_effort","value":"xhigh"}]}}"#;
        assert_eq!(cursor_selection(grok, &[]).as_deref(), Some("grok-4.7-xhigh"));
        assert!(cursor_selection("not json", &[]).is_none());
    }

    #[test]
    fn codex_config_names_the_model_and_its_effort() {
        let config = "\
model = \"gpt-6-luna\"
model_reasoning_effort = \"medium\"
model_context_window = 1000000

[projects.\"/tmp\"]
model = \"gpt-5.5\"
";
        assert_eq!(codex_selection(config), Some(("gpt-6-luna".into(), "medium".into(), String::new())));
        assert_eq!(codex_selection("model = 'gpt-5.6-sol'\n"), Some(("gpt-5.6-sol".into(), String::new(), String::new())));
        // An effort Crew cannot pass is dropped; the model still stands.
        assert_eq!(
            codex_selection("model = \"gpt-6-luna\"\nmodel_reasoning_effort = \"ultra\"\n"),
            Some(("gpt-6-luna".into(), String::new(), String::new()))
        );
        assert_eq!(
            codex_selection("model = \"gpt-6-luna\"\nservice_tier = \"priority\"\n"),
            Some(("gpt-6-luna".into(), String::new(), "fast".into()))
        );
        assert_eq!(
            codex_selection("model = \"gpt-6-luna\"\nservice_tier = \"default\"\n"),
            Some(("gpt-6-luna".into(), String::new(), "default".into()))
        );
        assert_eq!(
            codex_selection("model = \"gpt-6-luna\"\nservice_tier = \"ultra\"\n"),
            Some(("gpt-6-luna".into(), String::new(), String::new()))
        );
        assert!(codex_selection("[tui]\nmodel = \"nope\"\n").is_none());
        assert!(codex_selection("not toml").is_none());
    }

    #[test]
    fn codex_models_keep_listed_ones_and_the_tiers_they_advertise() {
        let out = r#"
note
{"models":[
  {"slug":"gpt-6-luna","display_name":"GPT-6-Luna","visibility":"list","service_tiers":[{"id":"priority","name":"Fast"},{"id":"default","name":"Standard"}],"additional_speed_tiers":["fast","flex"]},
  {"slug":"gpt-reserve","display_name":"GPT-Reserve","visibility":"hide","service_tiers":[{"id":"fast","name":"Fast"}]},
  {"slug":"gpt-5.6-terra","display_name":"GPT-5.6-Terra","visibility":"list","service_tiers":[],"additional_speed_tiers":["ultrafast"]},
  {"model":"gpt-5.5","displayName":"GPT-5.5","hidden":true,"serviceTiers":[{"id":"flex","name":"Flex"}]}
]}"#;
        assert_eq!(
            parse_codex_models(out),
            vec![
                ListedModel {
                    id: "gpt-6-luna".into(),
                    label: "GPT-6-Luna".into(),
                    tiers: Some(vec![
                        ListedTier { id: "fast".into(), label: "Fast".into() },
                        ListedTier { id: "flex".into(), label: "Flex".into() },
                    ]),
                },
                ListedModel {
                    id: "gpt-5.6-terra".into(),
                    label: "GPT-5.6-Terra".into(),
                    tiers: Some(vec![ListedTier { id: "ultrafast".into(), label: "Ultrafast".into() }]),
                },
            ]
        );
        assert!(parse_codex_models("not json").is_empty());
    }

    #[test]
    fn opencode_prefers_the_config_model_then_the_last_used() {
        let state = r#"{"recent":[
            {"providerID":"opencode","modelID":"muse-spark-1.3-contributor-free"},
            {"providerID":"openai","modelID":"gpt-5.6-sol"}
        ]}"#;
        assert_eq!(opencode_selection(r#"{"model":"openai/gpt-5.6-sol"}"#, state).as_deref(), Some("openai/gpt-5.6-sol"));
        assert_eq!(
            opencode_selection(r#"{"mcp":{}}"#, state).as_deref(),
            Some("opencode/muse-spark-1.3-contributor-free")
        );
        assert_eq!(opencode_selection("not json", state).as_deref(), Some("opencode/muse-spark-1.3-contributor-free"));
        let skip = r#"{"recent":[{"providerID":""},{"modelID":"x"},{"providerID":"opencode","modelID":"mimo-v2.5-free"}]}"#;
        assert_eq!(opencode_selection("", skip).as_deref(), Some("opencode/mimo-v2.5-free"));
        assert!(opencode_selection("", "{}").is_none());
    }

    #[test]
    fn configured_cli_models_are_non_empty() {
        assert!(!codex_configured_model().is_empty());
        assert!(!codex_configured_effort().is_empty());
        assert!(!opencode_configured_model().is_empty());
    }

    #[test]
    fn cursor_models_are_read_from_the_listing_and_its_labels_cleaned() {
        let out = "Available models\n\nauto - Auto (default)\ngrok-4.7-low-fast - Grok 4.7  Low Fast\u{200b}\u{200b}\n\
                   claude-opus-5-5-medium - Claude Opus 5.5 1M\n\nTip: use --model <id> (or /model <id> in interactive mode) to switch.\n";
        let ids: Vec<(String, String)> = parse_cursor_models(out).into_iter().map(|m| (m.id, m.label)).collect();
        assert_eq!(
            ids,
            [
                ("auto".to_string(), "Auto (default)".to_string()),
                ("grok-4.7-low-fast".to_string(), "Grok 4.7 Low Fast".to_string()),
                ("claude-opus-5-5-medium".to_string(), "Claude Opus 5.5 1M".to_string()),
            ]
        );
    }

    /// The CLI's reasons, as Crew shows them: the ones that rule the account
    /// out hide the toggle, a cooldown is shown, and the rest keep the last.
    #[test]
    fn a_claude_fast_mode_reading_becomes_what_crew_shows() {
        let available = FastMode { availability: FastModeAvailability::Available, reason: None };
        let cooldown = FastMode { availability: FastModeAvailability::Cooldown, reason: None };
        let unknown = FastMode { availability: FastModeAvailability::Unknown, reason: None };
        let hidden = |reason: &str| FastMode { availability: FastModeAvailability::Hidden, reason: Some(reason.into()) };
        let rule_out = [
            "free",
            "preference",
            "extra_usage_disabled",
            "not_first_party",
            "disabled_by_env",
            "model_not_allowed",
        ];
        for reason in rule_out {
            assert_eq!(fast_mode_from(Some("off"), Some(reason), Some(&available)), hidden(reason), "{reason}");
        }
        assert_eq!(fast_mode_from(Some("off"), None, None), available);
        assert_eq!(fast_mode_from(Some("on"), None, Some(&hidden("free"))), available);
        assert_eq!(fast_mode_from(Some("cooldown"), None, Some(&available)), cooldown);
        assert_eq!(fast_mode_from(Some("cooldown"), None, None), cooldown);
        for reason in ["network_error", "pending", "unknown", "sdk_opt_in_required"] {
            assert_eq!(fast_mode_from(Some("off"), Some(reason), Some(&cooldown)), cooldown, "{reason}");
            assert_eq!(fast_mode_from(None, Some(reason), None), unknown, "{reason}");
        }
        assert_eq!(fast_mode_from(None, None, Some(&hidden("free"))), hidden("free"));
        assert_eq!(fast_mode_from(None, None, None), unknown);
    }

    /// An `on` the CLI gave by mistake does not outweigh a refusal.
    #[test]
    fn a_refusal_outweighs_a_stray_on() {
        let answer = |state: &str, reason: Option<&str>| (Some(state.to_string()), reason.map(str::to_string));
        let refused = answer("off", Some("extra_usage_disabled"));
        assert_eq!(believed_fast_mode(vec![answer("on", None), refused.clone()]), Some(refused.clone()));
        assert_eq!(believed_fast_mode(vec![refused.clone(), answer("on", None)]), Some(refused));
        assert_eq!(believed_fast_mode(vec![answer("on", None), answer("on", None)]), Some(answer("on", None)));
        assert_eq!(believed_fast_mode(Vec::new()), None);
    }

    /// A reason that rules fast out is told to the user; one that only says
    /// the reading is not in yet is not.
    #[test]
    fn a_refused_fast_turn_says_why() {
        let note = claude_fast_refusal("extra_usage_disabled").expect("a note");
        assert!(note.contains("extra usage") && note.contains("standard speed"), "{note}");
        assert!(claude_fast_refusal("preference").is_some());
        for reason in ["sdk_opt_in_required", "network_error", "pending"] {
            assert_eq!(claude_fast_refusal(reason), None, "{reason}");
        }
    }

    /// The state comes off the initialize answer, and the CLI is stopped after it.
    #[test]
    fn the_claude_probe_reads_the_fast_mode_its_initialize_answers() {
        use std::os::unix::fs::PermissionsExt;
        let dir = temp_dir("claude-fast-mode");
        let path = dir.join("fake-claude");
        std::fs::write(
            &path,
            r#"#!/usr/bin/env python3
import json, sys, time
request = json.loads(sys.stdin.readline())
print(json.dumps({"type": "system", "subtype": "init"}), flush=True)
print(json.dumps({"type": "control_response", "response": {"subtype": "success", "request_id": request["request_id"], "response": {"fast_mode_state": "off", "fast_mode_disabled_reason": "extra_usage_disabled"}}}), flush=True)
time.sleep(600)
"#,
        )
        .expect("write fake");
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o755)).expect("chmod");
        assert_eq!(probe_claude_fast_mode(&path), Ok((Some("off".into()), Some("extra_usage_disabled".into()))));
    }

    /// A Claude that answers `initialize` and then `reload_skills`, and writes
    /// down how it was started. `reload` is the line it answers the second with.
    fn fake_menu_claude(dir: &Path, reload: &str) -> PathBuf {
        use std::os::unix::fs::PermissionsExt;
        let path = dir.join("fake-claude");
        std::fs::write(
            &path,
            format!(
                r#"#!/usr/bin/env python3
import json, os, sys, time
open(os.path.join(os.path.dirname(os.path.abspath(__file__)), "seen.json"), "w").write(json.dumps({{"argv": sys.argv[1:], "cwd": os.getcwd()}}))
first = json.loads(sys.stdin.readline())
second = json.loads(sys.stdin.readline())
assert first["request"]["subtype"] == "initialize" and second["request"]["subtype"] == "reload_skills"
print(json.dumps({{"type": "system", "subtype": "hook_started"}}), flush=True)
print(json.dumps({{"type": "control_response", "response": {{"subtype": "success", "request_id": first["request_id"], "response": {{"commands": [
  {{"name": "prototype", "description": "Build a prototype", "argumentHint": ""}},
  {{"name": "compact", "description": "Free up context", "argumentHint": "<hint>", "builtin": True}}]}}}}}}), flush=True)
print({reload}, flush=True)
time.sleep(600)
"#
            ),
        )
        .expect("write fake");
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o755)).expect("chmod");
        path
    }

    /// The probe starts the CLI in the folder with the settings of a user's
    /// session and none of their servers, and reads the commands and which of
    /// them are skills off its two answers.
    #[test]
    fn the_claude_probe_reads_the_commands_and_skills_of_a_folder() {
        let dir = temp_dir("claude-commands");
        let work = dir.join("work");
        std::fs::create_dir_all(&work).unwrap();
        let reload = r#"json.dumps({"type": "control_response", "response": {"subtype": "success", "request_id": second["request_id"], "response": {"skills": [{"name": "prototype"}]}}})"#;
        let path = fake_menu_claude(&dir, reload);

        let menu = probe_claude_commands(&path, &work).expect("menu");
        let names: Vec<_> = menu.commands.iter().map(|entry| entry.name.as_str()).collect();
        assert_eq!(names, ["prototype", "compact"]);
        assert_eq!(menu.commands[1].argument_hint.as_deref(), Some("<hint>"));
        assert_eq!(menu.skills, std::collections::HashSet::from(["prototype".to_string()]));

        let seen: Value = serde_json::from_str(&std::fs::read_to_string(dir.join("seen.json")).unwrap()).unwrap();
        let argv: Vec<_> = seen["argv"].as_array().unwrap().iter().filter_map(Value::as_str).collect();
        assert!(argv.contains(&"--setting-sources=user,project,local"), "{argv:?}");
        assert!(argv.contains(&"--strict-mcp-config"), "{argv:?}");
        assert_eq!(
            std::fs::canonicalize(seen["cwd"].as_str().unwrap()).unwrap(),
            std::fs::canonicalize(&work).unwrap()
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// A CLI that refuses `reload_skills` still gives its commands; they are
    /// all commands then.
    #[test]
    fn the_claude_probe_keeps_the_commands_when_reload_skills_is_refused() {
        let dir = temp_dir("claude-commands-old");
        let reload = r#"json.dumps({"type": "control_response", "response": {"subtype": "error", "request_id": second["request_id"], "error": "Unsupported"}})"#;
        let path = fake_menu_claude(&dir, reload);
        let menu = probe_claude_commands(&path, &dir).expect("menu");
        assert_eq!(menu.commands.len(), 2);
        assert!(menu.skills.is_empty());
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// The installed Claude, asked with no model turn: it lists its own
    /// commands, the skills are among them, and `/login` is not.
    #[test]
    #[ignore = "starts the installed claude"]
    fn the_installed_claude_lists_its_commands_and_skills() {
        let binary = shell_path::resolve("claude").expect("claude on the PATH");
        let menu = probe_claude_commands(&binary, &std::env::current_dir().unwrap()).expect("menu");
        let names: Vec<_> = menu.commands.iter().map(|entry| entry.name.as_str()).collect();
        assert!(names.contains(&"compact") && names.contains(&"context"), "{names:?}");
        assert!(!names.contains(&"login"), "{names:?}");
        assert!(!menu.skills.is_empty() && !menu.skills.contains("compact"), "{:?}", menu.skills);
    }

    /// A CLI that is not there is an error to report, not a hang.
    #[test]
    fn the_claude_probe_reports_a_binary_that_is_not_there() {
        let dir = temp_dir("claude-commands-missing");
        let error = probe_claude_commands(&dir.join("absent"), &dir).expect_err("no binary");
        assert!(error.starts_with("claude commands:"), "{error}");
        let _ = std::fs::remove_dir_all(&dir);
    }

    fn temp_dir(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("crew-provider-session-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn codex_title_takes_the_latest_name_for_the_id() {
        let root = temp_dir("codex-title");
        let index = root.join("session_index.jsonl");
        std::fs::write(
            &index,
            [
                r#"{"id":"a","thread_name":"First"}"#,
                r#"{"id":"b","thread_name":"Other"}"#,
                r#"{"id":"a","thread_name":"Renamed"}"#,
            ]
            .join("\n"),
        )
        .unwrap();
        assert_eq!(codex_title(&index, "a").as_deref(), Some("Renamed"));
        assert_eq!(codex_title(&index, "missing"), None);
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn cursor_title_finds_the_chat_in_any_folder() {
        let root = temp_dir("cursor-title");
        let chat = root.join("0eaad84c/5e047119-f117");
        std::fs::create_dir_all(&chat).unwrap();
        std::fs::write(chat.join("meta.json"), r#"{"title":"Spanish Project"}"#).unwrap();
        std::fs::create_dir_all(root.join("0eaad84c/untitled")).unwrap();
        std::fs::write(root.join("0eaad84c/untitled/meta.json"), r#"{"hasConversation":false}"#).unwrap();
        assert_eq!(cursor_title(&root, "5e047119-f117").as_deref(), Some("Spanish Project"));
        assert_eq!(cursor_title(&root, "untitled"), None);
        assert_eq!(cursor_title(&root, "../escape"), None);
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn opencode_title_skips_the_placeholder() {
        let root = temp_dir("opencode-title");
        let db = root.join("opencode.db");
        let conn = Connection::open(&db).unwrap();
        conn.execute_batch(
            "CREATE TABLE session (id TEXT, title TEXT);
             INSERT INTO session VALUES ('named', 'Friendly greeting');
             INSERT INTO session VALUES ('fresh', 'New session - 2026-09-17T17:59:15.722Z');",
        )
        .unwrap();
        drop(conn);
        assert_eq!(opencode_title(&db, "named").as_deref(), Some("Friendly greeting"));
        assert_eq!(opencode_title(&db, "fresh"), None);
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn a_claude_transcript_of_records_alone_is_no_conversation() {
        let root = temp_dir("claude-turn");
        let transcript = claude_transcript(&root, "/Users/me/my.app", "s");
        assert!(transcript.ends_with(".claude/projects/-Users-me-my-app/s.jsonl"));
        assert!(!claude_has_turn(&transcript));
        std::fs::create_dir_all(transcript.parent().unwrap()).unwrap();
        std::fs::write(
            &transcript,
            [
                r#"{"type":"bridge-session","sessionId":"s"}"#,
                r#"{"type":"ai-title","aiTitle":"About the \"user\" table"}"#,
            ]
            .join("\n"),
        )
        .unwrap();
        assert!(!claude_has_turn(&transcript));
        let mut text = std::fs::read_to_string(&transcript).unwrap();
        text.push_str("\n{\"type\":\"user\",\"message\":{\"role\":\"user\",\"content\":\"hi\"}}\n");
        std::fs::write(&transcript, text).unwrap();
        assert!(claude_has_turn(&transcript));
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn a_claude_transcript_sits_where_the_title_is_read() {
        let root = temp_dir("claude-slug");
        let cwd = "/Users/me/a😀b";
        let transcript = claude_transcript(&root, cwd, "s");
        assert!(transcript.ends_with(".claude/projects/-Users-me-a--b/s.jsonl"), "{}", transcript.display());
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn a_cursor_chat_counts_once_its_meta_says_so() {
        let root = temp_dir("cursor-conversation");
        let write = |id: &str, meta: &str| {
            let chat = root.join("0eaad84c").join(id);
            std::fs::create_dir_all(&chat).unwrap();
            std::fs::write(chat.join("meta.json"), meta).unwrap();
        };
        write("spoken", r#"{"hasConversation":true}"#);
        write("opened", r#"{"hasConversation":false}"#);
        assert!(cursor_has_conversation(&root, "spoken"));
        assert!(!cursor_has_conversation(&root, "opened"));
        assert!(!cursor_has_conversation(&root, "reserved"));
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn a_claude_session_spoke_in_the_conversation_it_is_in() {
        let home = temp_dir("claude-spoke-home");
        let cwd = "/work/app";
        let write = |id: &str, text: &str| {
            let transcript = claude_transcript(&home, cwd, id);
            std::fs::create_dir_all(transcript.parent().unwrap()).unwrap();
            std::fs::write(transcript, text).unwrap();
        };
        write("crew-1", "{\"type\":\"user\",\"message\":{\"role\":\"user\",\"content\":\"hi\"}}\n");
        write("cleared", r#"{"type":"ai-title","aiTitle":"x"}"#);
        let spoke = |bound: Option<&str>| has_conversation(Some(&home), "claude", "crew-1", bound, cwd);
        assert!(spoke(None), "Crew's own id is the conversation until it is bound to another");
        assert!(!spoke(Some("cleared")), "the conversation it is in is the one that counts");
        assert!(has_conversation(None, "claude", "crew-1", Some("cleared"), cwd), "unreadable is spoken");
        let _ = std::fs::remove_dir_all(&home);
    }

    #[test]
    fn chat_ids_are_plain_tokens() {
        assert!(is_chat_id("5e047119-f117-40d3-9552-3c77cfffe071"));
        assert!(!is_chat_id(""));
        assert!(!is_chat_id("Error: not logged in"));
    }
}
