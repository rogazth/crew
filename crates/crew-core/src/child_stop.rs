//! Ending a short-lived CLI that Crew started in a process group of its own.
//!
//! Claude Code rotates its OAuth refresh token when it renews a session: the
//! server answers with a new token and forgets the old one, and only then does
//! the CLI write the new one to disk. A SIGKILL in between leaves the old one
//! on disk, the next renewal presents it, and the server revokes the whole
//! sign-in. Asked with SIGTERM, Claude Code waits up to two seconds for a
//! renewal in flight before it exits, so a CLI is always asked first and only
//! killed when it does not go.

use std::process::Child;
use std::sync::{Mutex, MutexGuard};
use std::thread;
use std::time::{Duration, Instant};

/// How long a CLI has after SIGTERM before it is killed: Claude Code waits up
/// to two seconds for a token renewal, plus its own shutdown.
pub const TERM_GRACE: Duration = Duration::from_secs(5);
const POLL: Duration = Duration::from_millis(25);

/// Held while one of Crew's own short-lived Claude CLIs runs (the usage probe,
/// `claude auth status`): one at a time, so two never renew a sign-in together.
static CLAUDE_CLI: Mutex<()> = Mutex::new(());

/// Waits for, then holds, the turn to run a short-lived Claude CLI.
pub fn claude_turn() -> MutexGuard<'static, ()> {
    CLAUDE_CLI.lock().unwrap_or_else(|e| e.into_inner())
}

/// Waits up to `within` for `child` to exit on its own (its stdin closed, or
/// its work done), then ends its group: SIGTERM, [`TERM_GRACE`], SIGKILL.
/// The child is reaped either way.
pub fn stop(child: &mut Child, within: Duration) {
    if exited_within(child, within) {
        end_group(child);
        return;
    }
    let group = -(child.id() as i32);
    // SAFETY: the group is the child's own, and the child is not reaped yet,
    // so its id is still ours.
    unsafe { libc::kill(group, libc::SIGTERM) };
    if !exited_within(child, TERM_GRACE) {
        // SAFETY: as above.
        unsafe { libc::kill(group, libc::SIGKILL) };
        let _ = child.wait();
    }
    end_group(child);
}

/// Whether `child` exited within `within`, reaping it if so.
fn exited_within(child: &mut Child, within: Duration) -> bool {
    let deadline = Instant::now() + within;
    loop {
        match child.try_wait() {
            Ok(Some(_)) => return true,
            Ok(None) if Instant::now() < deadline => thread::sleep(POLL),
            Ok(None) => return false,
            Err(_) => return true,
        }
    }
}

/// A helper the leader left in its group, gone with it: asked to go, then
/// killed. A group id is not reused while any member lives, so it is still ours.
fn end_group(child: &Child) {
    let group = -(child.id() as i32);
    // SAFETY: signal 0 only asks whether anyone is left in the group.
    if unsafe { libc::kill(group, 0) } != 0 {
        return;
    }
    // SAFETY: see above.
    unsafe { libc::kill(group, libc::SIGTERM) };
    let deadline = Instant::now() + TERM_GRACE;
    // SAFETY: see above.
    while unsafe { libc::kill(group, 0) } == 0 {
        if Instant::now() >= deadline {
            // SAFETY: see above.
            unsafe { libc::kill(group, libc::SIGKILL) };
            return;
        }
        thread::sleep(POLL);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::os::unix::process::CommandExt;
    use std::process::{Command, Stdio};

    fn spawn(script: &str) -> Child {
        Command::new("sh").args(["-c", script]).stdin(Stdio::null()).process_group(0).spawn().expect("sh")
    }

    #[test]
    fn a_child_that_exits_on_its_own_is_not_signalled() {
        let mut child = spawn("sleep 0.2; exit 3");
        let started = Instant::now();
        stop(&mut child, Duration::from_secs(5));
        assert!(started.elapsed() < Duration::from_secs(2));
        assert_eq!(child.try_wait().unwrap().and_then(|s| s.code()), Some(3));
    }

    #[test]
    fn a_child_that_stays_is_asked_with_sigterm_before_any_kill() {
        // The trap answers SIGTERM by writing a mark and exiting 7: a SIGKILL
        // would leave no mark and no code.
        let dir = std::env::temp_dir().join(format!("crew-child-stop-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let mark = dir.join("term");
        let mut child = spawn(&format!("trap 'touch {}; exit 7' TERM; while :; do sleep 0.05; done", mark.display()));
        stop(&mut child, Duration::from_millis(200));
        assert!(mark.exists(), "the child never saw SIGTERM");
        assert_eq!(child.try_wait().unwrap().and_then(|s| s.code()), Some(7));
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn a_child_that_ignores_sigterm_is_killed_after_the_grace() {
        let mut child = spawn("trap '' TERM; while :; do sleep 0.05; done");
        let started = Instant::now();
        stop(&mut child, Duration::from_millis(100));
        assert!(started.elapsed() >= TERM_GRACE);
        assert!(child.try_wait().unwrap().is_some());
    }
}
