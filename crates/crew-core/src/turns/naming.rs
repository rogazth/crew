//! Session names. Crew asks the providers that leave their sessions unnamed
//! under it (Claude, Codex), and adopts the name any provider holds when a
//! turn that could change it ends. Nothing polls: a name comes with a turn,
//! so each end of one is followed by a few looks, and an idle session costs
//! nothing.

use std::collections::HashMap;
use std::sync::{Arc, Condvar, Mutex, OnceLock};
use std::thread;
use std::time::{Duration, Instant};

use crew_protocol::{BlockRole, TurnStart};
use serde_json::Value;

use super::{Live, TurnHost};
use crate::session::{self, Session};
use crate::titles;

/// When the name is looked for, counted from the end of a turn. A provider
/// writes it beside the turn: Claude's answer comes in seconds, Codex's is a
/// model run of its own, and opencode and Grok name theirs once the turn
/// settles.
const LOOKS: [Duration; 4] = [Duration::from_secs(1), Duration::from_secs(5), Duration::from_secs(20), Duration::from_secs(60)];
/// How often a session is asked for a name the provider did not give: each
/// time with more said in it, since a first message like "hi" names nothing.
const MAX_ASKS: u8 = 3;
/// What the user said first says what a conversation is about.
const DESCRIPTION_CHARS: usize = 2000;
/// How long the looking thread waits with nothing due before it checks
/// whether its host is still there.
const IDLE_WAIT: Duration = Duration::from_secs(30);

/// What the host keeps to name its sessions.
#[derive(Default)]
pub(crate) struct Naming {
    asked: Mutex<HashMap<String, Asked>>,
    /// One name asked at a time: a CLI resumed to be asked is a process.
    gate: Mutex<()>,
    /// The sessions whose name is being looked for: the end of their last
    /// turn, and how many looks it has had.
    due: Mutex<HashMap<String, (Instant, usize)>>,
    wake: Condvar,
    /// The looking thread, started by the first turn that ends.
    started: OnceLock<()>,
}

/// A session's asks since the daemon started.
#[derive(Clone, Copy, Default)]
struct Asked {
    /// How many messages the user had written at the last ask.
    said: usize,
    times: u8,
    /// The provider answered with a name: it is not asked again.
    named: bool,
}

impl Naming {
    /// Whether to ask now, with `said` messages written: never twice for the
    /// same ones, never once named, and at most [`MAX_ASKS`] times.
    fn claim(&self, id: &str, said: usize) -> bool {
        let mut asked = self.asked.lock().unwrap_or_else(|e| e.into_inner());
        let entry = asked.entry(id.to_string()).or_default();
        if entry.named || said <= entry.said || entry.times >= MAX_ASKS {
            return false;
        }
        entry.said = said;
        entry.times += 1;
        true
    }

    fn answered(&self, id: &str, named: bool) {
        if named {
            self.asked.lock().unwrap_or_else(|e| e.into_inner()).entry(id.to_string()).or_default().named = true;
        }
    }

    /// Looks for `id`'s name again from now, from the first look.
    fn schedule(&self, id: &str) {
        self.due.lock().unwrap_or_else(|e| e.into_inner()).insert(id.to_string(), (Instant::now(), 0));
        self.wake.notify_one();
    }

    /// The sessions due a look, once some are; each moves on to its next look
    /// or out. None after [`IDLE_WAIT`] with nothing due.
    fn next_due(&self) -> Vec<String> {
        let mut due = self.due.lock().unwrap_or_else(|e| e.into_inner());
        loop {
            let now = Instant::now();
            let mut ready = Vec::new();
            due.retain(|id, (ended, look)| {
                if *ended + LOOKS[*look] > now {
                    return true;
                }
                ready.push(id.clone());
                *look += 1;
                *look < LOOKS.len()
            });
            if !ready.is_empty() {
                return ready;
            }
            let wait = due
                .values()
                .map(|(ended, look)| (*ended + LOOKS[*look]).saturating_duration_since(now))
                .min()
                .unwrap_or(IDLE_WAIT)
                .min(IDLE_WAIT);
            let (held, timeout) = self.wake.wait_timeout(due, wait).unwrap_or_else(|e| e.into_inner());
            due = held;
            if timeout.timed_out() && due.is_empty() {
                return Vec::new();
            }
        }
    }
}

/// Whether a provider's answer to a name request holds a name.
fn names(answer: &Result<Value, String>) -> bool {
    answer.as_ref().ok().and_then(|value| value.get("title")?.as_str()).is_some_and(|title| !title.trim().is_empty())
}

impl TurnHost {
    /// The name the session's provider holds, adopted when it is new and
    /// every window told; with none, the provider is asked for one. Returns
    /// the adopted name.
    pub fn adopt_title(&self, session_id: &str) -> Result<Option<String>, String> {
        let name = self.sync_title(session_id)?;
        if name.is_some() {
            self.store.session_changed(session_id);
        } else {
            self.name_untitled(session_id);
        }
        Ok(name)
    }

    fn sync_title(&self, session_id: &str) -> Result<Option<String>, String> {
        session::sync_title_in(&self.store, session_id.to_string(), self.claude_home_dir().as_deref())
    }

    /// Adopts every name a provider gave while the daemon was down, or that
    /// changed outside Crew. Asks for none: that waits for a turn.
    pub fn adopt_titles(&self) {
        let host = self.clone();
        thread::spawn(move || {
            let Ok(all) = session::list_all(&host.store) else { return };
            for row in all.into_iter().filter(|row| row.kind == "terminal") {
                if let Ok(Some(_)) = host.sync_title(&row.id) {
                    host.store.session_changed(&row.id);
                }
            }
        });
    }

    /// The end of a turn of a user's session, which may have named it: the
    /// name is looked for a few times in the minute that follows.
    pub(super) fn watch_title(&self, row: &Session) {
        if row.kind != "terminal" {
            return;
        }
        self.naming.schedule(&row.id);
        self.naming.started.get_or_init(|| {
            let host = self.clone();
            let _ = thread::Builder::new().name("titles".into()).spawn(move || host.look_for_titles());
        });
    }

    fn look_for_titles(&self) {
        loop {
            let ready = self.naming.next_due();
            // Only this thread holds the host: it has gone.
            if ready.is_empty() && Arc::strong_count(&self.naming) == 1 {
                return;
            }
            for id in ready {
                let _ = self.adopt_title(&id);
            }
        }
    }

    /// What the user has written in the session, as one description, and
    /// how many messages that is. `now` is the message a turn is starting
    /// on, which the transcript may not hold yet.
    fn said(&self, session_id: &str, now: Option<&str>) -> (usize, String) {
        let mut texts: Vec<String> = self.transcripts.read(session_id, |blocks| {
            blocks
                .iter()
                .filter(|block| block.role == BlockRole::User && block.hidden != Some(true) && block.from_bot.is_none())
                .map(|block| block.text.trim().to_string())
                .filter(|text| !text.is_empty())
                .collect()
        });
        if let Some(now) = now.map(str::trim).filter(|text| !text.is_empty()) {
            if texts.last().map(String::as_str) != Some(now) {
                texts.push(now.to_string());
            }
        }
        (texts.len(), texts.join("\n\n").chars().take(DESCRIPTION_CHARS).collect())
    }

    /// In stream-json the CLI names a conversation only when asked, as its
    /// terminal does on the first message. With `persist` the name goes into
    /// its transcript as an `ai-title`, adopted as soon as it answers. A
    /// session left unnamed is asked again on a later message, with what was
    /// said so far.
    pub(super) fn ask_claude_title(&self, session: &Session, params: &TurnStart) {
        if session.kind != "terminal" || params.command.is_some() || params.text.trim().is_empty() {
            return;
        }
        if session::provider_title_of(&self.store, &session.id).ok().flatten().is_some() {
            return;
        }
        let epoch = match self.lock().get(&session.id) {
            Some(Live::Claude(live)) => live.epoch,
            _ => return,
        };
        let (said, description) = self.said(&session.id, Some(&params.text));
        if !self.naming.claim(&session.id, said) {
            return;
        }
        let host = self.clone();
        let id = session.id.clone();
        thread::spawn(move || {
            let answer = host.claude_control_on(&id, Some(epoch), titles::claude_request(&description));
            host.naming.answered(&id, names(&answer));
            if names(&answer) {
                let _ = host.sync_title(&id).map(|name| name.map(|_| host.store.session_changed(&id)));
            }
        });
    }

    /// Asks the provider of a user's session it has not named for a name:
    /// Claude on its live process if it has one, and otherwise on one resumed
    /// only to be asked; Codex's cheapest model in a run of its own. Neither
    /// conversation gains a message. A session with nothing said in it, or
    /// nothing new since the last ask, is left for a later turn.
    pub fn name_untitled(&self, session_id: &str) {
        let Ok(Some(session)) = session::get(&self.store, session_id.to_string()) else {
            return;
        };
        if session.kind != "terminal"
            || !matches!(session.provider.as_str(), "claude" | "codex")
            || !session::is_placeholder_name(&session.name, &session.provider)
            || session::provider_title_of(&self.store, session_id).ok().flatten().is_some()
            || !self.can_name(&session)
        {
            return;
        }
        let (said, description) = self.said(session_id, None);
        if said == 0 || !self.naming.claim(session_id, said) {
            return;
        }
        let host = self.clone();
        thread::spawn(move || {
            let _one = host.naming.gate.lock().unwrap_or_else(|e| e.into_inner());
            match host.name_now(&session, &description) {
                Ok(named) => {
                    host.naming.answered(&session.id, named);
                    if named {
                        let _ = host.sync_title(&session.id).map(|name| name.map(|_| host.store.session_changed(&session.id)));
                    }
                }
                // The CLI answered without a name, which it does for a greeting: not a fault.
                Err(error) if error.ends_with("no name") => {
                    tracing::debug!(session_id = %session.id, error = %crate::trace::error_text(&error), "title.unnamed")
                }
                Err(error) => tracing::warn!(session_id = %session.id, error = %crate::trace::error_text(&error), "title.failed"),
            }
        });
    }

    /// Whether the provider holds the conversation to name: Claude's
    /// transcript or live process, Codex's rollout.
    fn can_name(&self, session: &Session) -> bool {
        match session.provider.as_str() {
            "claude" => {
                if matches!(self.lock().get(&session.id), Some(Live::Claude(live)) if live.initialized) {
                    return true;
                }
                let (Ok(cwd), Some(home)) = (session::cwd(&self.store, session), self.claude_home_dir()) else { return false };
                let id = session.provider_session_id.as_deref().unwrap_or(&session.id);
                crate::provider_session::claude_transcript(&home, &cwd, id).is_file()
            }
            "codex" => session.provider_session_id.is_some(),
            _ => false,
        }
    }

    /// Asks for the name; whether one came.
    fn name_now(&self, session: &Session, description: &str) -> Result<bool, String> {
        match session.provider.as_str() {
            "claude" => {
                let live = matches!(self.lock().get(&session.id), Some(Live::Claude(live)) if live.initialized);
                if live {
                    return Ok(names(&self.claude_control(&session.id, titles::claude_request(description))));
                }
                let cwd = session::cwd(&self.store, session)?;
                let id = session.provider_session_id.clone().unwrap_or_else(|| session.id.clone());
                titles::name_claude(
                    std::path::Path::new(&self.resolve_bin("claude")?),
                    std::path::Path::new(&cwd),
                    &id,
                    description,
                )
                .map(|_| true)
            }
            "codex" => {
                let thread = session.provider_session_id.as_deref().ok_or("codex title: no thread")?;
                let home = crate::provider_session::codex_home().ok_or("no Codex home")?;
                let name = titles::codex_name(std::path::Path::new(&self.resolve_bin("codex")?), description)?;
                titles::name_codex(&home.join("session_index.jsonl"), thread, &name).map(|_| true)
            }
            _ => Ok(false),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_session_is_asked_again_only_with_more_said_and_never_once_named() {
        let naming = Naming::default();
        assert!(naming.claim("s", 1));
        assert!(!naming.claim("s", 1), "the same messages are not asked twice");
        assert!(naming.claim("s", 2), "a greeting left it unnamed: asked again with more");
        naming.answered("s", true);
        assert!(!naming.claim("s", 3), "named");
    }

    #[test]
    fn a_session_that_never_gets_a_name_stops_being_asked() {
        let naming = Naming::default();
        for said in 1..=MAX_ASKS as usize {
            assert!(naming.claim("s", said));
        }
        assert!(!naming.claim("s", MAX_ASKS as usize + 1));
    }

    #[test]
    fn a_turns_end_is_looked_at_each_look_then_dropped() {
        let naming = Naming::default();
        let ended = Instant::now() - LOOKS[LOOKS.len() - 1] - Duration::from_secs(1);
        naming.due.lock().unwrap().insert("s".into(), (ended, 0));
        for _ in 0..LOOKS.len() {
            assert_eq!(naming.next_due(), ["s"]);
        }
        assert!(naming.due.lock().unwrap().is_empty());
    }

    #[test]
    fn a_new_turn_starts_the_looks_over() {
        let naming = Naming::default();
        naming.schedule("s");
        let (ended, look) = naming.due.lock().unwrap()["s"];
        assert_eq!(look, 0);
        assert!(ended.elapsed() < Duration::from_secs(1));
    }

    #[test]
    fn only_a_named_answer_names() {
        assert!(names(&Ok(serde_json::json!({ "title": "Sidebar" }))));
        assert!(!names(&Ok(serde_json::json!({}))));
        assert!(!names(&Ok(serde_json::json!({ "title": "  " }))));
        assert!(!names(&Err("no answer".into())));
    }
}
