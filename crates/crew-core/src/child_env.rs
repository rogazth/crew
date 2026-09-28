//! What a terminal or an agent must not inherit from whoever started crewd.
//!
//! crewd may run inside another Crew's terminal or agent: a dev build started
//! from the installed app, a worktree's app from the main checkout's. That
//! parent's variables name its own daemon (`CREW_SOCKET`, `CREW_TOKEN`) and its
//! own data (`CREW_USER_DATA`, `CREW_PORT`), and a child that kept them would
//! reach the other app: its `crew call` into the wrong daemon, its `npm run app`
//! onto the wrong data. Claude Code's markers would make claude think it was a
//! child session with no transcript.

use std::ffi::OsStr;
use std::process::Command;

use crate::provider_session::CLAUDE_BIND_ENV;

fn inherited_from_parent(key: &str) -> bool {
    // crewd sets the bind folder to its own before any child starts.
    (key.starts_with("CREW_") && key != CLAUDE_BIND_ENV)
        || key == "CLAUDECODE"
        || key.starts_with("CLAUDE_CODE_")
}

/// Unsets those variables on `cmd`, except the ones it sets itself: an agent's
/// own `CREW_SOCKET` and `CREW_TOKEN` are this daemon's.
pub fn scrub(cmd: &mut Command) {
    let own: Vec<_> = cmd.get_envs().map(|(key, _)| key.to_os_string()).collect();
    for (key, _) in std::env::vars_os() {
        if own.iter().any(|set| set == &key) {
            continue;
        }
        if inherited_from_parent(&key.to_string_lossy()) {
            cmd.env_remove(OsStr::new(&key));
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn another_apps_variables_stay_behind_and_the_daemons_own_pass() {
        for key in ["CREW_SOCKET", "CREW_TOKEN", "CREW_USER_DATA", "CREW_PORT", "CLAUDECODE", "CLAUDE_CODE_ENTRYPOINT"] {
            assert!(inherited_from_parent(key), "{key}");
        }
        for key in [CLAUDE_BIND_ENV, "PATH", "HOME", "CLAUDE_CONFIG_DIR"] {
            assert!(!inherited_from_parent(key), "{key}");
        }
    }

    #[test]
    fn a_variable_the_command_sets_itself_is_kept() {
        // Unique names: the test process's env is shared with every other test.
        std::env::set_var("CREW_TEST_SCRUB_INHERITED", "parent");
        std::env::set_var("CREW_TEST_SCRUB_OWN", "parent");
        let mut cmd = Command::new("true");
        cmd.env("CREW_TEST_SCRUB_OWN", "daemon");
        scrub(&mut cmd);
        let envs: Vec<_> = cmd.get_envs().collect();
        assert!(envs.contains(&(OsStr::new("CREW_TEST_SCRUB_INHERITED"), None)));
        assert!(envs.contains(&(OsStr::new("CREW_TEST_SCRUB_OWN"), Some(OsStr::new("daemon")))));
    }
}
