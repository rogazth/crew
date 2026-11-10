//! A bot's episode as its turns run it: the start of a turn carries the
//! episode on or cuts it ([`crate::bot_episode::decide`]), the drivers report
//! what each model request read from the cache, and the end of the turn
//! writes the episode down for the next one.

use std::time::Duration;

use serde_json::{Map, Value};

use super::{TurnHost, TurnOutcome};
use crate::bot_episode::{self, Cut, Decision, Episode, Next};
use crate::prompts::Harness;
use crate::session::{self, Session};

/// What one model request read, as its provider reports it.
#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub(crate) struct CacheRead {
    /// Input the cache did not serve and nothing was written for.
    pub fresh: u64,
    pub read: u64,
    pub written: u64,
    /// The lifetime the provider gave what it wrote (Claude only).
    pub ttl_ms: Option<i64>,
    /// The model calls it sums: one, but for a provider that reports a turn's
    /// calls together (Grok), whose first call's cache is then not known.
    pub calls: u64,
}

impl CacheRead {
    /// The share of its input the cache served.
    pub fn share(&self) -> Option<f64> {
        let total = self.fresh + self.read + self.written;
        (total > 0).then(|| self.read as f64 / total as f64)
    }
}

/// A bot's turn while it runs: what its episode started under, and what its
/// requests read.
#[derive(Clone, Debug, Default)]
pub(crate) struct EpisodeTurn {
    persona: String,
    cwd: String,
    /// The episode carried on, and `(idle_ms, window_ms)` it was carried at.
    carried: Option<(Episode, i64, i64)>,
    /// The first request's reading: whether the cache was still there.
    first: Option<CacheRead>,
    /// The last lifetime a request's write was given.
    ttl_ms: Option<i64>,
    last_request_at: Option<i64>,
    /// The last reading: the context, for a provider that does not say it.
    last: Option<CacheRead>,
    /// Readings already counted, for a provider that says one twice.
    seen: Vec<String>,
}

impl TurnHost {
    /// Before a bot's turn: carry on its episode, or cut it. A cut lets go of
    /// the provider session and its process, so the turn starts a clean one
    /// with the tail. Returns the session as the turn is to run it.
    pub(super) fn bot_episode_start(&self, mut session: Session, cwd: &str) -> (Session, Option<Cut>) {
        let now = crate::store::now_millis();
        let harness = Harness::for_provider(&session.provider);
        let persona = bot_episode::digest(&self.persona(&session, harness, self.mcp().is_some(), cwd).unwrap_or_default());
        let episode = bot_episode::get(&self.store, &session.id).ok().flatten();
        let window = episode.as_ref().map_or(0, |episode| self.cache_window(&session, episode.cache_ttl_ms));
        let next = Next {
            conversation: session.provider_session_id.as_deref(),
            provider: &session.provider,
            model: &session.model,
            effort: &session.effort,
            cwd,
            persona: &persona,
            at: now,
        };
        let mut decision = bot_episode::decide(episode.as_ref(), &next, window);
        // Claude resumes from its own file: one that is gone cannot be carried on.
        if let (Decision::Carry { .. }, Some(id)) = (&decision, session.provider_session_id.as_deref()) {
            let up = self.agents.running().iter().any(|running| running == &session.id);
            if session.provider == "claude" && !up && !self.claude_holds(cwd, id) {
                decision = Decision::Cut(Cut::Lost);
            }
        }
        let (carried, cut) = match decision {
            Decision::Carry { idle_ms, window_ms } => (episode.map(|episode| (episode, idle_ms, window_ms)), None),
            Decision::Cut(cut) => (None, Some(cut)),
        };
        match (&carried, &cut) {
            (Some((episode, idle_ms, window_ms)), _) => tracing::info!(
                session_id = %session.id,
                idle_ms,
                window_ms,
                warm = idle_ms < window_ms,
                used = episode.context_used.unwrap_or(0),
                turns = episode.turns,
                "bot.episode_carried"
            ),
            (None, Some(cut)) => tracing::info!(session_id = %session.id, reason = cut.reason(), "bot.episode_cut"),
            (None, None) => {}
        }
        if cut.is_some() {
            if self.lock().contains_key(&session.id) {
                self.release(&session.id);
            }
            if let (Some(oc), "opencode") = (session.provider_session_id.as_deref(), session.provider.as_str()) {
                self.opencode_drop(&session.id, oc);
            }
            let _ = session::clear_provider_session(&self.store, &session.id);
            session.provider_session_id = None;
            let _ = bot_episode::clear(&self.store, &session.id);
            self.contexts.lock().unwrap_or_else(|e| e.into_inner()).remove(&session.id);
            self.bot_windows.lock().unwrap_or_else(|e| e.into_inner()).remove(&session.id);
        }
        self.episode_turns
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .insert(session.id.clone(), EpisodeTurn { persona, cwd: cwd.to_string(), carried, ..EpisodeTurn::default() });
        (session, cut)
    }

    /// A model request of a bot's turn, as its driver read it.
    pub(crate) fn cache_request(&self, session_id: &str, read: CacheRead) {
        self.cache_request_once(session_id, None, read);
    }

    /// [`TurnHost::cache_request`] for a reading the provider may say more
    /// than once: one with a `key` already counted this turn is not counted again.
    pub(crate) fn cache_request_once(&self, session_id: &str, key: Option<&str>, read: CacheRead) {
        let mut turns = self.episode_turns.lock().unwrap_or_else(|e| e.into_inner());
        let Some(turn) = turns.get_mut(session_id) else {
            return;
        };
        if let Some(key) = key {
            if turn.seen.iter().any(|seen| seen == key) {
                return;
            }
            turn.seen.push(key.to_string());
        }
        if turn.first.is_none() && read.share().is_some() {
            turn.first = Some(read);
        }
        if read.ttl_ms.is_some() {
            turn.ttl_ms = read.ttl_ms;
        }
        turn.last = Some(read);
        turn.last_request_at = Some(crate::store::now_millis());
    }

    /// After a bot's turn: the episode as it stands now, for the next turn to
    /// decide on, and what the turn taught of the provider's cache.
    pub(super) fn bot_episode_end(&self, row: &Session, outcome: &TurnOutcome) {
        let Some(turn) = self.episode_turns.lock().unwrap_or_else(|e| e.into_inner()).remove(&row.id) else {
            return;
        };
        let now = crate::store::now_millis();
        let conversation = session::get(&self.store, row.id.clone())
            .ok()
            .flatten()
            .and_then(|session| session.provider_session_id)
            .filter(|id| !id.is_empty());
        if conversation.is_none() {
            let _ = bot_episode::clear(&self.store, &row.id);
            return;
        }
        let previous = turn.carried.as_ref().map(|(episode, _, _)| episode);
        let reading = self.contexts.lock().unwrap_or_else(|e| e.into_inner()).get(&row.id).cloned();
        let window = reading.as_ref().and_then(|reading| reading.window);
        let reading = reading.map(|reading| reading.used);
        // A provider that says nothing of its context: its last request's
        // input is the context, or, for calls reported together, at least
        // their mean and what the conversation held before.
        let used = reading.or_else(|| {
            turn.last.map(|last| {
                let mean = (last.fresh + last.read + last.written) / last.calls.max(1);
                match last.calls {
                    0 | 1 => mean,
                    _ => mean.max(previous.and_then(|episode| episode.context_used).unwrap_or(0)),
                }
            })
        });
        let episode = Episode {
            session_id: row.id.clone(),
            provider: row.provider.clone(),
            model: row.model.clone(),
            effort: row.effort.clone(),
            cwd: turn.cwd.clone(),
            persona: turn.persona.clone(),
            started_at: previous.map_or(now, |episode| episode.started_at),
            last_request_at: turn.last_request_at.unwrap_or(now),
            context_used: used.or_else(|| previous.and_then(|episode| episode.context_used)),
            context_window: window.or_else(|| previous.and_then(|episode| episode.context_window)),
            base_read: match previous {
                Some(episode) => episode.base_read,
                None => Some(turn.first.filter(|read| read.calls <= 1).map_or(0, |read| read.read)),
            },
            cache_ttl_ms: turn.ttl_ms.or_else(|| previous.and_then(|episode| episode.cache_ttl_ms)),
            turns: previous.map_or(1, |episode| episode.turns + 1),
            failed: matches!(outcome, TurnOutcome::Failed(_)),
        };
        if let Err(error) = bot_episode::put(&self.store, &episode) {
            tracing::warn!(session_id = %row.id, error = %crate::trace::error_text(&error), "bot.episode_unsaved");
        }
        let cache_window = self.cache_window(row, episode.cache_ttl_ms);
        self.bot_windows
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .insert(row.id.clone(), Duration::from_millis(cache_window.max(0) as u64));
        self.learn_cache(row, &turn);
    }

    /// What a turn's first request read, and for a carried turn what that
    /// says of the window it was carried under.
    fn learn_cache(&self, row: &Session, turn: &EpisodeTurn) {
        let Some(first) = turn.first else {
            return;
        };
        let Some((previous, idle_ms, window_ms)) = &turn.carried else {
            tracing::info!(session_id = %row.id, provider = %row.provider, read = first.read, fresh = first.fresh,
                written = first.written, calls = first.calls, "bot.cache_read");
            return;
        };
        let base = previous.base_read.unwrap_or(0);
        let before = previous.context_used.unwrap_or(0);
        let warm = match first.calls {
            0 | 1 => bot_episode::found_warm(first.read, base, before),
            _ => bot_episode::found_warm_summed(first.fresh + first.written, base, before),
        };
        tracing::info!(session_id = %row.id, provider = %row.provider, idle_ms, window_ms, read = first.read,
            fresh = first.fresh, written = first.written, base, before, calls = first.calls, warm, "bot.cache_read");
        let Some(warm) = warm else {
            return;
        };
        if bot_episode::learns(&row.provider) {
            if let Some(next) = bot_episode::learned_from(*window_ms, *idle_ms, warm) {
                let _ = bot_episode::set_learned(&self.store, &row.provider, &row.model, next);
                tracing::info!(provider = %row.provider, model = %row.model, window_ms = next, "bot.cache_window_learned");
            }
        } else if !warm && idle_ms < window_ms {
            tracing::warn!(session_id = %row.id, provider = %row.provider, idle_ms, window_ms, read = first.read, base, before,
                "bot.cache_missed");
        }
    }

    /// How long `session`'s cache stays warm after its last request.
    pub(super) fn cache_window(&self, session: &Session, ttl_ms: Option<i64>) -> i64 {
        let learned = bot_episode::learns(&session.provider)
            .then(|| bot_episode::learned(&self.store, &session.provider, &session.model))
            .flatten();
        bot_episode::window_ms(&session.provider, &session.model, ttl_ms, learned)
    }

    /// How long a session's idle process is kept: a bot's, while its cache is
    /// warm; any other's, `limit`.
    pub(crate) fn idle_limit(&self, session_id: &str, limit: Duration) -> Duration {
        match self.bot_windows.lock().unwrap_or_else(|e| e.into_inner()).get(session_id) {
            Some(window) => (*window).min(limit),
            None => limit,
        }
    }
}

/// What a bot's turn is handed of its conversation.
#[derive(Clone, Debug, PartialEq)]
pub(crate) struct Memory {
    /// For a new provider session: the tail of the conversation and this
    /// turn's header.
    pub trail: String,
    /// For one that carries on: this turn's header alone, which names the
    /// blocks its message took.
    pub header: String,
}

impl Memory {
    /// What goes ahead of the turn's message.
    pub fn for_turn(&self, carries: bool) -> &str {
        if carries {
            &self.header
        } else {
            &self.trail
        }
    }

    /// `text` under this turn's header, for a turn that carries on.
    pub fn headed(&self, text: &str) -> String {
        format!("{}\n\n{text}", self.header)
    }
}

/// A Claude request, from its assistant frame's usage. A write to both
/// lifetimes keeps the shorter: the conversation is what must stay cached.
pub(crate) fn claude_request(rec: &Map<String, Value>) -> Option<CacheRead> {
    let usage = rec.get("message")?.get("usage")?;
    let count = |key: &str| usage.get(key).and_then(Value::as_u64).unwrap_or(0);
    let creation = usage.get("cache_creation");
    let bucket = |key: &str| creation.and_then(|creation| creation.get(key)).and_then(Value::as_u64).unwrap_or(0);
    let ttl_ms = if bucket("ephemeral_5m_input_tokens") > 0 {
        Some(5 * 60_000)
    } else if bucket("ephemeral_1h_input_tokens") > 0 {
        Some(60 * 60_000)
    } else {
        None
    };
    let read = CacheRead {
        fresh: count("input_tokens"),
        read: count("cache_read_input_tokens"),
        written: count("cache_creation_input_tokens"),
        ttl_ms,
        calls: 1,
    };
    read.share().map(|_| read)
}

/// A Codex response, from `thread/tokenUsage/updated`: OpenAI counts the
/// cached tokens inside the input.
pub(crate) fn codex_request(params: &Value) -> Option<CacheRead> {
    let last = params.get("tokenUsage")?.get("last")?;
    let input = last.get("inputTokens").and_then(Value::as_u64)?;
    let cached = last.get("cachedInputTokens").and_then(Value::as_u64).unwrap_or(0).min(input);
    let read = CacheRead { fresh: input - cached, read: cached, calls: 1, ..CacheRead::default() };
    read.share().map(|_| read)
}

/// An opencode step, from its `tokens`: the cache is counted apart from the input.
pub(crate) fn opencode_step(step: &Value) -> Option<CacheRead> {
    let tokens = step.get("tokens")?;
    let count = |value: Option<&Value>, key: &str| value.and_then(|v| v.get(key)).and_then(Value::as_u64).unwrap_or(0);
    let cache = tokens.get("cache");
    let read = CacheRead {
        fresh: count(Some(tokens), "input"),
        read: count(cache, "read"),
        written: count(cache, "write"),
        ttl_ms: None,
        calls: 1,
    };
    read.share().map(|_| read)
}

/// A Grok turn, from the usage its `turn_completed` or its prompt's answer
/// (`_meta.usage`) carries: the sum of its model calls, whose input counts
/// what the cache served.
pub(crate) fn grok_turn(usage: &Value) -> Option<CacheRead> {
    let count = |key: &str| usage.get(key).and_then(Value::as_u64).unwrap_or(0);
    let read = count("cachedReadTokens");
    let written = count("cacheCreationTokens");
    let input = count("inputTokens");
    let calls = count("modelCalls").max(1);
    let read = CacheRead { fresh: input.saturating_sub(read + written), read, written, ttl_ms: None, calls };
    read.share().map(|_| read)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn a_claude_request_says_its_cache_and_the_lifetime_of_what_it_wrote() {
        let rec = json!({"type": "assistant", "message": {"id": "m", "usage": {
            "input_tokens": 2, "cache_read_input_tokens": 900, "cache_creation_input_tokens": 98,
            "cache_creation": {"ephemeral_5m_input_tokens": 0, "ephemeral_1h_input_tokens": 98}}}});
        let read = claude_request(rec.as_object().unwrap()).unwrap();
        assert_eq!(read, CacheRead { fresh: 2, read: 900, written: 98, ttl_ms: Some(3_600_000), calls: 1 });
        assert_eq!(read.share(), Some(0.9));
        let both = json!({"message": {"usage": {"input_tokens": 1, "cache_creation_input_tokens": 2,
            "cache_creation": {"ephemeral_5m_input_tokens": 1, "ephemeral_1h_input_tokens": 1}}}});
        assert_eq!(claude_request(both.as_object().unwrap()).unwrap().ttl_ms, Some(300_000));
        let none = json!({"message": {"usage": {"input_tokens": 0, "output_tokens": 3}}});
        assert_eq!(claude_request(none.as_object().unwrap()), None);
    }

    #[test]
    fn codex_counts_the_cache_inside_the_input() {
        let params = json!({"tokenUsage": {"last": {"totalTokens": 1010, "inputTokens": 1000, "cachedInputTokens": 750, "outputTokens": 10}}});
        assert_eq!(codex_request(&params), Some(CacheRead { fresh: 250, read: 750, written: 0, ttl_ms: None, calls: 1 }));
    }

    #[test]
    fn opencode_counts_the_cache_apart() {
        let step = json!({"tokens": {"input": 596, "output": 218, "reasoning": 137, "cache": {"write": 0, "read": 47985}}});
        assert_eq!(opencode_step(&step), Some(CacheRead { fresh: 596, read: 47985, written: 0, ttl_ms: None, calls: 1 }));
    }

    #[test]
    fn grok_sums_its_calls_and_counts_the_cache_inside_the_input() {
        let update = json!({"sessionUpdate": "turn_completed", "usage": {"inputTokens": 424782, "cachedReadTokens": 406656, "cacheCreationTokens": 0, "modelCalls": 8}});
        assert_eq!(
            grok_turn(&update["usage"]),
            Some(CacheRead { fresh: 18126, read: 406656, written: 0, ttl_ms: None, calls: 8 })
        );
        assert_eq!(grok_turn(&json!({})), None);
    }

    #[test]
    fn a_memory_hands_a_new_session_the_tail_and_one_that_carries_on_the_header() {
        let memory = Memory { trail: "tail\n\n## This turn (block 9)".into(), header: "## This turn (block 9)".into() };
        assert_eq!(memory.for_turn(false), "tail\n\n## This turn (block 9)");
        assert_eq!(memory.for_turn(true), "## This turn (block 9)");
        assert_eq!(memory.headed("hola"), "## This turn (block 9)\n\nhola");
    }
}
