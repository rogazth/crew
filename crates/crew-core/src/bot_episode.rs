//! A bot's episode: the one provider session its turns carry on while that
//! costs less than starting another.
//!
//! A provider caches the prompt it was sent, and a request that starts with
//! what an earlier one sent reads that part at about a tenth of the price. A
//! bot whose next message comes while its cache is warm carries on the same
//! provider session, and everything it read and did is still there, cheaply.
//! Once the cache has gone cold, carrying on writes the whole conversation
//! again (1.25× to 2× the price of input), so a large one is cut: the next
//! turn starts a new session with the tail Crew hands it, as every turn of a
//! bot once did. A small one carries on even cold, since writing it again
//! costs about what a new session's prefix costs, and nothing is lost.
//!
//! Crew never lets the provider compact a bot's conversation: past
//! [`CONTEXT_CAP`] the episode is cut instead.
//!
//! How long a cache stays warm is the provider's to say. Claude says it with
//! every request it writes (`ephemeral_5m`, `ephemeral_1h`). OpenAI documents
//! at least 30 minutes for GPT-5.6 and later. xAI and the models behind
//! opencode publish nothing, so their window is learned (see [`learned_from`]).
//! Cursor reports no cache at all, so its window is the one its model's maker
//! documents.

use rusqlite::{params, OptionalExtension};
use sha2::{Digest, Sha256};

use crate::store::Store;

pub const MIGRATION_V53: &str = "
CREATE TABLE IF NOT EXISTS bot_episodes (
  session_id      TEXT PRIMARY KEY REFERENCES sessions(id) ON DELETE CASCADE,
  provider        TEXT NOT NULL,
  model           TEXT NOT NULL,
  effort          TEXT NOT NULL,
  cwd             TEXT NOT NULL,
  persona         TEXT NOT NULL,
  started_at      INTEGER NOT NULL,
  last_request_at INTEGER NOT NULL,
  context_used    INTEGER,
  context_window  INTEGER,
  base_read       INTEGER,
  cache_ttl_ms    INTEGER,
  turns           INTEGER NOT NULL,
  failed          INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS cache_windows (
  provider   TEXT NOT NULL,
  model      TEXT NOT NULL,
  window_ms  INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (provider, model)
);";

/// Past this much context an episode ends, warm or not. Every request of a
/// turn reads the whole context again, at a tenth of the price when cached:
/// a turn of thirty tool calls on 500k tokens reads 15M.
pub const CONTEXT_CAP: u64 = 150_000;
/// The share of a smaller model's window an episode may fill: the providers
/// compact past 80 to 90% of it, and a turn's own growth must fit under that.
pub const WINDOW_SHARE: (u64, u64) = (3, 5);
/// Under this much context an episode carries on with its cache cold:
/// writing it again costs about what a new session's own prefix (the
/// harness's prompt and tools) costs, and nothing of the conversation is lost.
pub const COLD_CARRY_UNDER: u64 = 50_000;
/// Taken off a cache's lifetime: the provider's clock starts at its last
/// request, a little before Crew hears the turn end.
pub const MARGIN_MS: i64 = 60_000;
/// A five-minute cache, less the margin: Anthropic's default, and the guess
/// for a model nobody says anything of.
pub const SHORT_WINDOW_MS: i64 = 5 * 60_000 - MARGIN_MS;
/// OpenAI keeps a prefix at least 30 minutes from its last read on GPT-5.6
/// and later, less a margin of its own: entries live on single machines.
pub const OPENAI_WINDOW_MS: i64 = 25 * 60_000;
/// The bounds a learned window stays within.
pub const LEARNED_FLOOR_MS: i64 = 60_000;
pub const LEARNED_CEILING_MS: i64 = 60 * 60_000;
/// A carried turn's first request found the cache warm when it read at least
/// this part of the conversation's own context (past the prefix every session
/// of the provider shares) from it. Not all of it: the last answer and this
/// turn's message were never sent as input, so never cached.
pub const WARM_PART: f64 = 0.7;
/// Below this much context of its own, a conversation says nothing of its
/// cache: the prefix every session shares is most of what it reads.
pub const MIN_SIGNAL: u64 = 2_000;

/// A bot's episode as its last turn left it.
#[derive(Clone, Debug, PartialEq)]
pub struct Episode {
    pub session_id: String,
    pub provider: String,
    pub model: String,
    pub effort: String,
    pub cwd: String,
    /// A digest of the persona the episode started under: its system prompt,
    /// or its first message, is that text and no other.
    pub persona: String,
    pub started_at: i64,
    /// When its last request went out, as near as Crew can tell: the cache's
    /// lifetime runs from there.
    pub last_request_at: i64,
    pub context_used: Option<u64>,
    pub context_window: Option<u64>,
    /// What the episode's first request read from the cache: the prefix every
    /// session of the provider shares, which says nothing of this one's.
    pub base_read: Option<u64>,
    /// The lifetime the provider said its last write has (Claude only).
    pub cache_ttl_ms: Option<i64>,
    pub turns: i64,
    /// Its last turn failed: the provider session is in a state nobody vouches for.
    pub failed: bool,
}

/// What the turn about to start runs as.
#[derive(Clone, Debug, PartialEq)]
pub struct Next<'a> {
    /// The provider session the bot holds, if any.
    pub conversation: Option<&'a str>,
    pub provider: &'a str,
    pub model: &'a str,
    pub effort: &'a str,
    pub cwd: &'a str,
    pub persona: &'a str,
    pub at: i64,
}

/// Why an episode ends before a turn.
#[derive(Clone, Debug, PartialEq)]
pub enum Cut {
    /// No episode to carry on: the bot's first turn, or one after a restart
    /// that kept none.
    First,
    /// The provider no longer holds the conversation.
    Lost,
    Failed,
    Persona,
    Model,
    Moved,
    Full {
        used: u64,
    },
    Cold {
        idle_ms: i64,
        window_ms: i64,
        used: u64,
    },
}

impl Cut {
    pub fn reason(&self) -> &'static str {
        match self {
            Cut::First => "first",
            Cut::Lost => "lost",
            Cut::Failed => "failed",
            Cut::Persona => "persona",
            Cut::Model => "model",
            Cut::Moved => "moved",
            Cut::Full { .. } => "full",
            Cut::Cold { .. } => "cold",
        }
    }

    /// What the chat says of it; nothing for a first turn, which cuts nothing.
    pub fn note(&self) -> Option<String> {
        Some(match self {
            Cut::First => return None,
            Cut::Lost => "New session: the provider no longer has the last one.".into(),
            Cut::Failed => "New session: the last turn failed.".into(),
            Cut::Persona => "New session: the bot's instructions changed.".into(),
            Cut::Model => "New session: the model changed.".into(),
            Cut::Moved => "New session: the bot works in another folder now.".into(),
            Cut::Full { used } => format!("New session: the last one held {}.", tokens(*used)),
            Cut::Cold { idle_ms, used: 0, .. } => format!("New session: the cache went cold after {} idle.", minutes(*idle_ms)),
            Cut::Cold { idle_ms, used, .. } => {
                format!(
                    "New session: the cache went cold after {} idle, with {} to write again.",
                    minutes(*idle_ms),
                    tokens(*used)
                )
            }
        })
    }
}

fn tokens(n: u64) -> String {
    format!("{}k tokens", n.div_ceil(1000))
}

fn minutes(ms: i64) -> String {
    match ms / 60_000 {
        0 => "under a minute".into(),
        1 => "1 minute".into(),
        n if n < 120 => format!("{n} minutes"),
        n => format!("{} hours", n / 60),
    }
}

#[derive(Clone, Debug, PartialEq)]
pub enum Decision {
    /// Carry on the provider session: `idle_ms` since its last request, which
    /// `window_ms` says is warm or not.
    Carry {
        idle_ms: i64,
        window_ms: i64,
    },
    Cut(Cut),
}

impl Decision {
    pub fn warm(&self) -> bool {
        matches!(self, Decision::Carry { idle_ms, window_ms } if idle_ms < window_ms)
    }
}

/// Carry on or cut, before a turn. `window_ms` is how long the episode's
/// cache stays warm (see [`window_ms`]).
pub fn decide(episode: Option<&Episode>, next: &Next, window_ms: i64) -> Decision {
    let (Some(episode), Some(_)) = (episode, next.conversation.filter(|id| !id.is_empty())) else {
        return Decision::Cut(Cut::First);
    };
    if episode.failed {
        return Decision::Cut(Cut::Failed);
    }
    if episode.provider != next.provider || episode.model != next.model || episode.effort != next.effort {
        return Decision::Cut(Cut::Model);
    }
    if episode.cwd != next.cwd {
        return Decision::Cut(Cut::Moved);
    }
    if episode.persona != next.persona {
        return Decision::Cut(Cut::Persona);
    }
    if let Some(used) = episode.context_used.filter(|used| *used >= cap(episode.context_window)) {
        return Decision::Cut(Cut::Full { used });
    }
    let idle_ms = (next.at - episode.last_request_at).max(0);
    // A context nobody measured is not known to be small.
    let small = episode.context_used.is_some_and(|used| used < COLD_CARRY_UNDER);
    if idle_ms < window_ms || small {
        return Decision::Carry { idle_ms, window_ms };
    }
    Decision::Cut(Cut::Cold { idle_ms, window_ms, used: episode.context_used.unwrap_or(0) })
}

/// The most context an episode carries on with, for a model of `window`.
pub fn cap(window: Option<u64>) -> u64 {
    match window {
        Some(window) if window > 0 => CONTEXT_CAP.min(window * WINDOW_SHARE.0 / WINDOW_SHARE.1),
        _ => CONTEXT_CAP,
    }
}

/// How long a provider's cache stays warm after its last request, less the
/// margin. `ttl_ms` is what the provider said of its last write; `learned`
/// is what Crew has seen of this provider and model (see [`learned_from`]).
pub fn window_ms(provider: &str, model: &str, ttl_ms: Option<i64>, learned: Option<i64>) -> i64 {
    match provider {
        "claude" => ttl_ms.map(|ttl| (ttl - MARGIN_MS).max(0)).unwrap_or(SHORT_WINDOW_MS),
        // No cache readings to learn from: what the model's maker documents.
        "cursor" => documented(model),
        _ => learned.unwrap_or_else(|| documented(model)),
    }
}

/// What the maker of the model behind `model` documents of its cache: OpenAI
/// at least 30 minutes for GPT-5.6 and later, Anthropic five minutes, and
/// five minutes for anyone who says nothing.
pub fn documented(model: &str) -> i64 {
    match gpt_version(model) {
        Some(version) if version >= (5, 6) => OPENAI_WINDOW_MS,
        _ => SHORT_WINDOW_MS,
    }
}

/// `(5, 6)` of `gpt-5.6-sol`, `openai/gpt-5.6`, `gpt-5.6-sol-medium`; `(6, 0)` of `gpt-6-astra`.
fn gpt_version(model: &str) -> Option<(u32, u32)> {
    let model = model.rsplit('/').next().unwrap_or(model).to_ascii_lowercase();
    let rest = model.strip_prefix("gpt-")?;
    let number: String = rest.chars().take_while(|c| c.is_ascii_digit() || *c == '.').collect();
    let mut parts = number.split('.').filter(|part| !part.is_empty());
    let major = parts.next()?.parse().ok()?;
    let minor = parts.next().and_then(|part| part.parse().ok()).unwrap_or(0);
    Some((major, minor))
}

/// Whether Crew learns the window of `provider` from its cache readings: one
/// that says how long its cache lives (Claude, OpenAI's Codex), or reports
/// none (Cursor), is not learned.
pub fn learns(provider: &str) -> bool {
    matches!(provider, "grok" | "opencode")
}

/// Whether a carried turn's first request found the cache warm: it `read`
/// that much, the episode's first request `base`, and the conversation held
/// `previous` tokens. `None` when the conversation is too small to tell.
pub fn found_warm(read: u64, base: u64, previous: u64) -> Option<bool> {
    let own = previous.saturating_sub(base);
    (own >= MIN_SIGNAL).then(|| read.saturating_sub(base) as f64 >= WARM_PART * own as f64)
}

/// [`found_warm`] for a provider that reports a turn's calls summed (Grok):
/// the first call read the conversation from the cache or not, and the calls
/// after it read what the first wrote, so only what the turn read past the
/// cache tells. Reading its own context past it again is cold, reading little
/// is warm; in between, a turn whose calls added that much says nothing.
pub fn found_warm_summed(fresh: u64, base: u64, previous: u64) -> Option<bool> {
    let own = previous.saturating_sub(base);
    if own < MIN_SIGNAL {
        return None;
    }
    let part = fresh as f64 / own as f64;
    if part >= WARM_PART {
        Some(false)
    } else if part <= 1.0 - WARM_PART {
        Some(true)
    } else {
        None
    }
}

/// What a carried turn found of the cache (see [`found_warm`]) after the
/// episode carried on `idle_ms` past its last request, with `window_ms` the
/// window it was carried under. Returns the window to keep, if it changes.
///
/// A window only grows from a carry past it, and those are the small
/// conversations carried on cold anyway: one that finds the cache still warm
/// says it lasts at least that long. A carry within the window that finds it
/// cold says it lasts less.
pub fn learned_from(window_ms: i64, idle_ms: i64, warm: bool) -> Option<i64> {
    let next = if warm && idle_ms > window_ms {
        idle_ms.min(LEARNED_CEILING_MS)
    } else if !warm && idle_ms < window_ms {
        idle_ms.max(LEARNED_FLOOR_MS)
    } else {
        return None;
    };
    (next != window_ms).then_some(next)
}

/// A digest of a persona, to tell when it changes.
pub fn digest(persona: &str) -> String {
    let digest = Sha256::digest(persona.as_bytes());
    digest.iter().take(12).map(|byte| format!("{byte:02x}")).collect()
}

pub fn get(store: &Store, session_id: &str) -> Result<Option<Episode>, String> {
    store.with(|conn| {
        conn.query_row(
            "SELECT session_id, provider, model, effort, cwd, persona, started_at, last_request_at, context_used,
                    context_window, base_read, cache_ttl_ms, turns, failed
             FROM bot_episodes WHERE session_id = ?1",
            params![session_id],
            |row| {
                Ok(Episode {
                    session_id: row.get(0)?,
                    provider: row.get(1)?,
                    model: row.get(2)?,
                    effort: row.get(3)?,
                    cwd: row.get(4)?,
                    persona: row.get(5)?,
                    started_at: row.get(6)?,
                    last_request_at: row.get(7)?,
                    context_used: row.get::<_, Option<i64>>(8)?.map(|n| n.max(0) as u64),
                    context_window: row.get::<_, Option<i64>>(9)?.map(|n| n.max(0) as u64),
                    base_read: row.get::<_, Option<i64>>(10)?.map(|n| n.max(0) as u64),
                    cache_ttl_ms: row.get(11)?,
                    turns: row.get(12)?,
                    failed: row.get::<_, i64>(13)? != 0,
                })
            },
        )
        .optional()
    })
}

pub fn put(store: &Store, episode: &Episode) -> Result<(), String> {
    store.with(|conn| {
        conn.execute(
            "INSERT INTO bot_episodes (session_id, provider, model, effort, cwd, persona, started_at, last_request_at,
                                       context_used, context_window, base_read, cache_ttl_ms, turns, failed)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14)
             ON CONFLICT (session_id) DO UPDATE SET
               provider = ?2, model = ?3, effort = ?4, cwd = ?5, persona = ?6, started_at = ?7, last_request_at = ?8,
               context_used = ?9, context_window = ?10, base_read = ?11, cache_ttl_ms = ?12, turns = ?13, failed = ?14",
            params![
                episode.session_id,
                episode.provider,
                episode.model,
                episode.effort,
                episode.cwd,
                episode.persona,
                episode.started_at,
                episode.last_request_at,
                episode.context_used.map(|n| n as i64),
                episode.context_window.map(|n| n as i64),
                episode.base_read.map(|n| n as i64),
                episode.cache_ttl_ms,
                episode.turns,
                episode.failed as i64,
            ],
        )
        .map(|_| ())
    })
}

pub fn clear(store: &Store, session_id: &str) -> Result<(), String> {
    store.with(|conn| conn.execute("DELETE FROM bot_episodes WHERE session_id = ?1", params![session_id]).map(|_| ()))
}

pub fn learned(store: &Store, provider: &str, model: &str) -> Option<i64> {
    store
        .with(|conn| {
            conn.query_row(
                "SELECT window_ms FROM cache_windows WHERE provider = ?1 AND model = ?2",
                params![provider, model],
                |row| row.get(0),
            )
            .optional()
        })
        .ok()
        .flatten()
}

pub fn set_learned(store: &Store, provider: &str, model: &str, window_ms: i64) -> Result<(), String> {
    store.with(|conn| {
        conn.execute(
            "INSERT INTO cache_windows (provider, model, window_ms, updated_at) VALUES (?1, ?2, ?3, ?4)
             ON CONFLICT (provider, model) DO UPDATE SET window_ms = ?3, updated_at = ?4",
            params![provider, model, window_ms, crate::store::now_millis()],
        )
        .map(|_| ())
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn episode() -> Episode {
        Episode {
            session_id: "b".into(),
            provider: "claude".into(),
            model: "opus".into(),
            effort: "high".into(),
            cwd: "/w".into(),
            persona: "p1".into(),
            started_at: 0,
            last_request_at: 1_000_000,
            context_used: Some(80_000),
            context_window: Some(1_000_000),
            base_read: Some(0),
            cache_ttl_ms: Some(3_600_000),
            turns: 3,
            failed: false,
        }
    }

    fn next(at: i64) -> Next<'static> {
        Next { conversation: Some("conv"), provider: "claude", model: "opus", effort: "high", cwd: "/w", persona: "p1", at }
    }

    const HOUR: i64 = 3_600_000;

    #[test]
    fn a_warm_episode_carries_on() {
        let decision = decide(Some(&episode()), &next(1_000_000 + 10 * 60_000), HOUR - MARGIN_MS);
        assert_eq!(decision, Decision::Carry { idle_ms: 10 * 60_000, window_ms: HOUR - MARGIN_MS });
        assert!(decision.warm());
    }

    #[test]
    fn a_cold_large_episode_is_cut_and_a_cold_small_one_carries_on() {
        let late = next(1_000_000 + 2 * HOUR);
        assert_eq!(
            decide(Some(&episode()), &late, HOUR - MARGIN_MS),
            Decision::Cut(Cut::Cold { idle_ms: 2 * HOUR, window_ms: HOUR - MARGIN_MS, used: 80_000 })
        );
        let small = Episode { context_used: Some(30_000), ..episode() };
        let decision = decide(Some(&small), &late, HOUR - MARGIN_MS);
        assert_eq!(decision, Decision::Carry { idle_ms: 2 * HOUR, window_ms: HOUR - MARGIN_MS });
        assert!(!decision.warm());
        // Unmeasured, it is not known to be small: cut when cold, carried on when warm.
        let unknown = Episode { context_used: None, ..episode() };
        assert_eq!(
            decide(Some(&unknown), &late, HOUR - MARGIN_MS),
            Decision::Cut(Cut::Cold { idle_ms: 2 * HOUR, window_ms: HOUR - MARGIN_MS, used: 0 })
        );
        assert!(decide(Some(&unknown), &next(1_000_001), HOUR).warm());
    }

    #[test]
    fn a_full_episode_is_cut_however_warm() {
        let full = Episode { context_used: Some(CONTEXT_CAP), ..episode() };
        assert_eq!(decide(Some(&full), &next(1_000_001), HOUR), Decision::Cut(Cut::Full { used: CONTEXT_CAP }));
        // A small model's window caps it sooner.
        let small = Episode { context_used: Some(80_000), context_window: Some(128_000), ..episode() };
        assert_eq!(decide(Some(&small), &next(1_000_001), HOUR), Decision::Cut(Cut::Full { used: 80_000 }));
        assert_eq!(cap(Some(200_000)), 120_000);
        assert_eq!(cap(None), CONTEXT_CAP);
    }

    #[test]
    fn what_the_episode_started_under_must_still_hold() {
        let at = 1_000_001;
        assert_eq!(decide(None, &next(at), HOUR), Decision::Cut(Cut::First));
        assert_eq!(decide(Some(&episode()), &Next { conversation: None, ..next(at) }, HOUR), Decision::Cut(Cut::First));
        let failed = Episode { failed: true, ..episode() };
        assert_eq!(decide(Some(&failed), &next(at), HOUR), Decision::Cut(Cut::Failed));
        assert_eq!(decide(Some(&episode()), &Next { model: "sonnet", ..next(at) }, HOUR), Decision::Cut(Cut::Model));
        assert_eq!(decide(Some(&episode()), &Next { effort: "low", ..next(at) }, HOUR), Decision::Cut(Cut::Model));
        assert_eq!(decide(Some(&episode()), &Next { cwd: "/other", ..next(at) }, HOUR), Decision::Cut(Cut::Moved));
        assert_eq!(decide(Some(&episode()), &Next { persona: "p2", ..next(at) }, HOUR), Decision::Cut(Cut::Persona));
    }

    #[test]
    fn the_window_is_the_providers_word_or_the_makers() {
        assert_eq!(window_ms("claude", "opus", Some(HOUR), None), HOUR - MARGIN_MS);
        assert_eq!(window_ms("claude", "opus", Some(300_000), None), SHORT_WINDOW_MS);
        assert_eq!(window_ms("claude", "opus", None, None), SHORT_WINDOW_MS);
        assert_eq!(window_ms("codex", "gpt-5.6-sol", None, None), OPENAI_WINDOW_MS);
        assert_eq!(window_ms("codex", "gpt-6-astra", None, None), OPENAI_WINDOW_MS);
        assert_eq!(window_ms("codex", "gpt-5.5", None, None), SHORT_WINDOW_MS);
        assert_eq!(window_ms("codex", "gpt-5.6-sol", None, Some(40 * 60_000)), 40 * 60_000);
        assert_eq!(window_ms("cursor", "gpt-5.6-sol-medium", None, Some(1)), OPENAI_WINDOW_MS);
        assert_eq!(window_ms("cursor", "claude-opus-5-5-high", None, None), SHORT_WINDOW_MS);
        assert_eq!(window_ms("opencode", "openai/gpt-5.6", None, None), OPENAI_WINDOW_MS);
        assert_eq!(window_ms("grok", "grok-4.7-build", None, None), SHORT_WINDOW_MS);
        assert_eq!(window_ms("grok", "grok-4.7-build", None, Some(9 * 60_000)), 9 * 60_000);
    }

    #[test]
    fn a_window_grows_from_a_warm_carry_past_it_and_shrinks_from_a_cold_one_within() {
        let window = SHORT_WINDOW_MS;
        assert_eq!(learned_from(window, 20 * 60_000, true), Some(20 * 60_000));
        assert_eq!(learned_from(window, 5 * HOUR, true), Some(LEARNED_CEILING_MS));
        assert_eq!(learned_from(window, 2 * 60_000, false), Some(2 * 60_000));
        assert_eq!(learned_from(window, 10_000, false), Some(LEARNED_FLOOR_MS));
        // What agrees with the window changes nothing.
        assert_eq!(learned_from(window, 2 * 60_000, true), None);
        assert_eq!(learned_from(window, 20 * 60_000, false), None);
    }

    #[test]
    fn warmth_is_what_the_conversation_itself_read_from_the_cache() {
        // 75% of the input, but nearly all the conversation had: warm.
        assert_eq!(found_warm(16_600, 0, 17_400), Some(true));
        // The shared prefix alone: cold, however large a share of the input that is.
        assert_eq!(found_warm(12_000, 12_000, 40_000), Some(false));
        assert_eq!(found_warm(36_000, 12_000, 40_000), Some(true));
        // Too little of its own to say.
        assert_eq!(found_warm(12_000, 12_000, 13_000), None);
        // Calls summed: what the turn read past the cache.
        assert_eq!(found_warm_summed(19_667, 0, 21_000), Some(false));
        assert_eq!(found_warm_summed(2_000, 0, 21_000), Some(true));
        assert_eq!(found_warm_summed(10_000, 0, 21_000), None);
    }

    #[test]
    fn an_episode_and_a_learned_window_are_kept() {
        let dir = std::env::temp_dir().join(format!("crew-episode-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).expect("dir");
        let store = Store::open(dir.join("crew.sqlite3")).expect("store");
        let workspace = crate::workspace::create(&store, "w".into(), dir.to_string_lossy().into()).expect("workspace");
        let id = crate::session::create(
            &store,
            workspace.id,
            "bot".into(),
            "Ana".into(),
            "claude".into(),
            "opus".into(),
            "".into(),
            "ask".into(),
        )
        .expect("session")
        .id;
        let kept = Episode { session_id: id.clone(), ..episode() };
        put(&store, &kept).unwrap();
        assert_eq!(get(&store, &id).unwrap(), Some(kept.clone()));
        put(&store, &Episode { turns: 4, failed: true, ..kept.clone() }).unwrap();
        assert_eq!(get(&store, &id).unwrap().map(|e| (e.turns, e.failed)), Some((4, true)));
        clear(&store, &id).unwrap();
        assert_eq!(get(&store, &id).unwrap(), None);
        assert_eq!(learned(&store, "grok", "g"), None);
        set_learned(&store, "grok", "g", 600_000).unwrap();
        set_learned(&store, "grok", "g", 700_000).unwrap();
        assert_eq!(learned(&store, "grok", "g"), Some(700_000));
    }

    #[test]
    fn notes_say_why_in_a_line() {
        assert_eq!(Cut::First.note(), None);
        assert_eq!(
            Cut::Cold { idle_ms: 75 * 60_000, window_ms: 0, used: 80_123 }.note().unwrap(),
            "New session: the cache went cold after 75 minutes idle, with 81k tokens to write again."
        );
        assert_eq!(Cut::Full { used: 150_000 }.note().unwrap(), "New session: the last one held 150k tokens.");
        assert_eq!(
            Cut::Cold { idle_ms: 600_000, window_ms: 0, used: 0 }.note().unwrap(),
            "New session: the cache went cold after 10 minutes idle."
        );
    }
}
