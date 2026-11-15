//! A turn that stopped because the provider's CLI is signed out, and the
//! login that answers it. The window runs the login in a terminal tab; its
//! clean exit restarts the session's CLI, and the session picks up what the
//! login interrupted, as if the user had sent it again.

use crew_protocol::{AttachedFile, Block, BlockRole, TurnStart};

use super::{driven, Driven, TurnHost};
use crate::session;

/// The note a login leaves when there is nothing to pick up; the client
/// matches it to retire the sign-in prompt above.
pub(super) const SIGNED_IN_NOTE: &str = "Signed in. Send a message to continue.";
/// The note a login leaves when the session picks up where it stopped; the
/// client matches it too.
pub(super) const RESUMED_NOTE: &str = "Signed in. Continuing.";
/// How far back another session's failure may be for this login to pick it
/// up: an older one is not a turn the user still waits on.
const ELSEWHERE_WINDOW_MS: i64 = 24 * 60 * 60 * 1000;
/// What a turn that had already worked is told when it goes on.
const CARRY_ON: &str =
    "Your last turn stopped because the CLI was signed out. It is signed in again: carry on where you left off.";

/// Whether a turn's failure is the CLI asking for a login. The same words the
/// window's `isAuthFailure` (src/lib/auth.ts) reads; the two change together.
pub(crate) fn is_auth_failure(text: &str) -> bool {
    let lower = text.to_lowercase();
    let after = |first: &str, then: &[&str]| {
        lower.find(first).is_some_and(|at| then.iter().any(|word| lower[at + first.len()..].contains(word)))
    };
    [
        "failed to authenticate",
        "oauth session expired",
        "could not be refreshed",
        "not logged in",
        "please run /login",
        "login expired",
        // Codex: its token could not be refreshed, whatever the reason that follows.
        "sign in again",
        "codex login",
        // Cursor: ACP's auth-required error, and the handshake's own line.
        "authentication required",
        "could not log in",
        "cursor-agent login",
        // Grok: its rejected sign-in, and a refresh it could not make.
        "grok login",
        "sign-in was rejected",
        "auth refresh failed",
    ]
    .iter()
    .any(|phrase| lower.contains(phrase))
        || after("oauth token", &["expired", "revoked"])
        || after("refresh token", &["expired", "rejected", "revoked", "already used"])
}

/// What a turn that stopped on a login leaves to do once signed in.
#[derive(Debug, PartialEq)]
pub(super) enum Pending {
    /// Nothing ran: the user's own messages go again, as they were sent.
    Again { text: String, files: Vec<AttachedFile> },
    /// Only letters of other sessions: they went back to the box, and waking
    /// the session hands them over again.
    Letters,
    /// The turn had worked before the login lapsed: it is told to go on.
    CarryOn,
}

/// What the transcript's last turn left to do, when that turn stopped on a
/// login and nothing came after it. None when the session is not waiting on
/// one, or the user has moved on.
pub(super) fn pending(blocks: &[Block]) -> Option<Pending> {
    let shown = |block: &&Block| block.hidden != Some(true);
    let last = blocks.iter().rposition(|block| shown(&block))?;
    let failure = &blocks[last];
    if failure.role != BlockRole::System || !is_auth_failure(&failure.text) {
        return None;
    }
    let mut said: Vec<&Block> = Vec::new();
    let mut letters = false;
    let mut worked = false;
    for block in blocks[..last].iter().rev() {
        match block.role {
            // A resume that failed again is hidden, and still the message.
            BlockRole::User if block.from_bot.is_none() => said.push(block),
            BlockRole::User => letters = true,
            // Above the turn's own messages is the turn before it.
            _ if !said.is_empty() || letters => break,
            BlockRole::System => {}
            _ if shown(&block) => worked = true,
            _ => {}
        }
    }
    if worked {
        return Some(Pending::CarryOn);
    }
    if said.is_empty() {
        return letters.then_some(Pending::Letters);
    }
    said.reverse();
    Some(Pending::Again {
        text: said.iter().map(|block| block.text.as_str()).collect::<Vec<_>>().join("\n\n"),
        files: said.iter().flat_map(|block| block.files.clone().unwrap_or_default()).collect(),
    })
}

impl TurnHost {
    /// The restart a provider's login asks for: the CLI lets go of the
    /// credentials it failed to refresh, and a turn that stopped on the login
    /// goes again, without the user sending it twice. The login is the
    /// machine's, so every other session it stopped goes on too.
    pub fn session_signed_in(&self, session_id: &str) -> Result<(), String> {
        let pending = self.transcripts.read(session_id, pending);
        let note = if pending.is_some() { RESUMED_NOTE } else { SIGNED_IN_NOTE };
        self.restart(session_id, false, Some(note))?;
        if let Some(pending) = pending {
            self.pick_up(session_id, pending)?;
        }
        self.signed_in_elsewhere(session_id);
        Ok(())
    }

    /// Every other session of the same provider whose last turn stopped on
    /// the login, recently, goes on as this one did. One that cannot let go
    /// of its CLI (work still runs in its background) keeps its prompt.
    fn signed_in_elsewhere(&self, session_id: &str) {
        let Ok(Some(signed)) = session::get(&self.store, session_id.to_string()) else {
            return;
        };
        let Ok(sessions) = session::list_all(&self.store) else {
            return;
        };
        let since = crate::store::now_millis() - ELSEWHERE_WINDOW_MS;
        for other in sessions {
            let candidate = other.id != signed.id
                && other.provider == signed.provider
                && driven(&other).is_some()
                && other.updated_at >= since
                && matches!(other.status.as_str(), "idle" | "done" | "error")
                && !self.is_running(&other.id);
            if !candidate {
                continue;
            }
            let Some(waiting) = self.transcripts.read(&other.id, pending) else {
                continue;
            };
            if self.restart(&other.id, false, Some(RESUMED_NOTE)).is_ok() {
                let _ = self.pick_up(&other.id, waiting);
            }
        }
    }

    /// Starts what a login interrupted. The user's messages are already on
    /// screen, so the turn's own copy of them is hidden.
    fn pick_up(&self, session_id: &str, pending: Pending) -> Result<(), String> {
        let session = session::get(&self.store, session_id.to_string())?.ok_or("No such session")?;
        // Signing in is the user saying go on: what a failure held waits no more.
        self.user_wrote(session_id);
        let (text, files) = match pending {
            Pending::Letters => {
                self.wake(session_id);
                return Ok(());
            }
            Pending::Again { text, files } => (text, files),
            Pending::CarryOn => (CARRY_ON.to_string(), Vec::new()),
        };
        let cwd = session::cwd(&self.store, &session).unwrap_or_default();
        self.begin(
            TurnStart {
                session_id: session_id.to_string(),
                cwd,
                text,
                files: Some(files).filter(|files| !files.is_empty()),
                mentions: None,
                hidden: Some(true),
                from_bot: None,
                sent_at: None,
                nonce: None,
                letter_id: None,
                mode: None,
                command: None,
                skills: None,
            },
            Vec::new(),
        )?;
        // A hidden turn reads as nobody's, and a subagent would report it to
        // its parent; this one is the user's, as the turn it repeats was.
        if driven(&session) == Some(Driven::Child) {
            self.user_started.lock().unwrap_or_else(|e| e.into_inner()).insert(session_id.to_string());
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crew_protocol::BotRef;

    fn block(role: BlockRole, text: &str) -> Block {
        Block {
            id: text.into(),
            role,
            text: text.into(),
            at: None,
            hidden: None,
            streaming: None,
            files: None,
            tool: None,
            approval: None,
            question: None,
            usage: None,
            from_bot: None,
            letter_id: None,
            letter_kind: None,
        }
    }

    fn hidden(mut block: Block) -> Block {
        block.hidden = Some(true);
        block
    }

    const EXPIRED: &str = "Failed to authenticate: OAuth session expired and could not be refreshed";

    #[test]
    fn knows_each_cli_asking_for_a_login() {
        for text in [
            EXPIRED,
            "Not logged in",
            "Login expired · Please run /login",
            "OAuth token has been revoked",
            "Your access token could not be refreshed because your refresh token has expired. Please log out and sign in again.",
            "OAuth refresh token was rejected: invalid_grant",
            "Cursor Agent could not log in (run `cursor-agent login` in a terminal): Authentication required",
            "Authentication required: token expired",
            "Your team sign-in was rejected. It may have expired or lack access. Run `grok login` to sign in again.",
            "Grok did not start: auth refresh failed",
        ] {
            assert!(is_auth_failure(text), "{text}");
        }
        assert!(!is_auth_failure("Claude exited with code 1."));
        assert!(!is_auth_failure("boom"));
        assert!(!is_auth_failure("the token expired before the oauth step"));
    }

    #[test]
    fn a_message_that_never_ran_goes_again_with_its_files() {
        let mut asked = block(BlockRole::User, "fix the build");
        asked.files = Some(vec![AttachedFile { name: "a.png".into(), path: "/tmp/a.png".into(), kind: None, size: None }]);
        let blocks = vec![
            block(BlockRole::User, "earlier"),
            block(BlockRole::Assistant, "done"),
            asked,
            block(BlockRole::User, "and the tests"),
            hidden(block(BlockRole::Assistant, EXPIRED)),
            block(BlockRole::System, EXPIRED),
        ];
        let Some(Pending::Again { text, files }) = pending(&blocks) else { panic!("{:?}", pending(&blocks)) };
        assert_eq!(text, "fix the build\n\nand the tests");
        assert_eq!(files.len(), 1);
    }

    #[test]
    fn a_resume_that_failed_again_goes_again() {
        let blocks = vec![
            block(BlockRole::User, "fix the build"),
            block(BlockRole::System, EXPIRED),
            block(BlockRole::System, RESUMED_NOTE),
            hidden(block(BlockRole::User, "fix the build")),
            block(BlockRole::System, EXPIRED),
        ];
        assert_eq!(pending(&blocks), Some(Pending::Again { text: "fix the build".into(), files: Vec::new() }));
    }

    #[test]
    fn a_turn_that_had_worked_carries_on() {
        let blocks = vec![
            block(BlockRole::User, "fix the build"),
            block(BlockRole::Tool, "Read Cargo.toml"),
            block(BlockRole::System, EXPIRED),
        ];
        assert_eq!(pending(&blocks), Some(Pending::CarryOn));
    }

    #[test]
    fn letters_of_other_sessions_are_handed_over_again() {
        let mut letter = block(BlockRole::User, "report");
        letter.from_bot = Some(BotRef { id: "s1".into(), name: "helper".into(), kind: Some("child".into()) });
        let blocks = vec![letter, block(BlockRole::System, EXPIRED)];
        assert_eq!(pending(&blocks), Some(Pending::Letters));
    }

    #[test]
    fn nothing_waits_once_the_user_moved_on_or_the_failure_was_another() {
        let answered =
            vec![block(BlockRole::User, "fix"), block(BlockRole::System, EXPIRED), block(BlockRole::System, SIGNED_IN_NOTE)];
        assert_eq!(pending(&answered), None);
        let other = vec![block(BlockRole::User, "fix"), block(BlockRole::System, "Claude exited with code 1.")];
        assert_eq!(pending(&other), None);
        assert_eq!(pending(&[]), None);
    }
}
