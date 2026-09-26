//! Who the CLI speaks as, and where it finds the daemon.
//!
//! Inside an agent or a terminal session Crew put `CREW_SOCKET` and
//! `CREW_TOKEN` in the environment, and those are the session: the CLI acts as
//! it, in its workspace. Anywhere else it is the user, and the way in is
//! `<data-dir>/daemon.json`, which only the user can read.

use std::path::{Path, PathBuf};

use crew_core::mcp::Link;
use crew_protocol::DaemonFile;

use crate::args::Global;
use crate::CliError;

/// The environment the choice depends on, read once so tests can hand in
/// their own.
#[derive(Clone, Debug, Default)]
pub struct Env {
    pub token: Option<String>,
    pub socket: Option<String>,
    pub data_dir: Option<String>,
    pub home: Option<String>,
    pub xdg_config_home: Option<String>,
}

impl Env {
    pub fn from_process() -> Self {
        let var = |key: &str| std::env::var(key).ok().filter(|value| !value.is_empty());
        Self {
            token: var("CREW_TOKEN"),
            socket: var("CREW_SOCKET"),
            data_dir: var("CREW_DATA_DIR"),
            home: var("HOME"),
            xdg_config_home: var("XDG_CONFIG_HOME"),
        }
    }
}

/// Where the link comes from, before anything is read from disk.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Source {
    Session { socket: String, token: String },
    User { data_dir: PathBuf },
}

/// A session's own environment wins, because a shell inside a session that
/// acted as the user would reach past what the session was allowed. Naming a
/// data dir is the one way out: it points at a daemon, and possibly another
/// one than the session's. `CREW_DATA_DIR` is not that: the dev app exports it
/// and its sessions inherit it.
pub fn choose(global: &Global, env: &Env) -> Result<Source, CliError> {
    if global.data_dir.is_none() {
        if let (Some(socket), Some(token)) = (&env.socket, &env.token) {
            return Ok(Source::Session { socket: socket.clone(), token: token.clone() });
        }
    }
    Ok(Source::User { data_dir: data_dir(global.data_dir.as_deref(), env)? })
}

/// `--data-dir`, else `$CREW_DATA_DIR`, else the installed app's. A dev build
/// keeps its own (`Crew Dev`, or `.crew-dev` inside a worktree) and is reached
/// by naming it; `scripts/crew-dev cli` does.
pub fn data_dir(flag: Option<&Path>, env: &Env) -> Result<PathBuf, CliError> {
    if let Some(dir) = flag {
        return Ok(dir.to_path_buf());
    }
    if let Some(dir) = &env.data_dir {
        return Ok(PathBuf::from(dir));
    }
    default_data_dir(env)
}

/// Electron's `userData` for an app named Crew.
pub fn default_data_dir(env: &Env) -> Result<PathBuf, CliError> {
    let home = env
        .home
        .as_deref()
        .ok_or_else(|| CliError::Failed("HOME is not set; name the data directory with --data-dir".into()))?;
    if cfg!(target_os = "macos") {
        return Ok(Path::new(home).join("Library/Application Support/Crew"));
    }
    let config = env.xdg_config_home.clone().map(PathBuf::from).unwrap_or_else(|| Path::new(home).join(".config"));
    Ok(config.join("Crew"))
}

pub fn daemon_file_path(data_dir: &Path) -> PathBuf {
    data_dir.join("daemon.json")
}

/// The file the daemon writes when it is up and removes when it stops. No
/// file is no daemon; a file left behind by one that died is caught when its
/// socket does not answer.
pub fn read_daemon_file(data_dir: &Path) -> Result<DaemonFile, CliError> {
    let path = daemon_file_path(data_dir);
    let bytes = match std::fs::read(&path) {
        Ok(bytes) => bytes,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            return Err(CliError::NotRunning(format!(
                "Crew isn't running — open it or run `crew open` (no daemon.json in {})",
                data_dir.display()
            )))
        }
        Err(error) => return Err(CliError::Failed(format!("{}: {error}", path.display()))),
    };
    serde_json::from_slice(&bytes).map_err(|e| CliError::Failed(format!("{}: {e}", path.display())))
}

/// What a user's call names as its workspace. A path that exists is sent
/// absolute, because the daemon does not share this shell's directory; an id
/// is sent as it is. No flag is the current directory.
pub fn workspace_arg(flag: Option<&str>, cwd: &Path) -> String {
    match flag {
        Some(named) => {
            let path = cwd.join(named);
            if path.exists() {
                path.to_string_lossy().into_owned()
            } else {
                named.to_string()
            }
        }
        None => cwd.to_string_lossy().into_owned(),
    }
}

/// Who this run speaks as, with the link to speak through.
#[derive(Clone, Debug)]
pub enum Identity {
    Session { link: Link },
    User { link: Link },
}

impl Identity {
    pub fn resolve(global: &Global, env: &Env) -> Result<Self, CliError> {
        match choose(global, env)? {
            Source::Session { socket, token } => {
                if global.workspace.is_some() {
                    eprintln!("crew: --workspace is ignored inside a Crew session, which acts in its own workspace");
                }
                Ok(Identity::Session { link: Link::new(socket, token, None) })
            }
            Source::User { data_dir } => {
                let daemon = read_daemon_file(&data_dir)?;
                let cwd = std::env::current_dir().map_err(|e| CliError::Failed(format!("current directory: {e}")))?;
                let workspace = workspace_arg(global.workspace.as_deref(), &cwd);
                Ok(Identity::User { link: Link::new(daemon.socket, daemon.user_token, Some(workspace)) })
            }
        }
    }

    pub fn link(&self) -> &Link {
        match self {
            Identity::Session { link } | Identity::User { link } => link,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("crew-cli-id-{name}-{}", std::process::id()));
        std::fs::create_dir_all(&dir).expect("dir");
        dir
    }

    fn session_env() -> Env {
        Env {
            token: Some("t".into()),
            socket: Some("/data/crew.sock".into()),
            data_dir: Some("/dev-data".into()),
            home: Some("/Users/me".into()),
            xdg_config_home: None,
        }
    }

    #[test]
    fn a_session_speaks_as_itself() {
        let source = choose(&Global::default(), &session_env()).expect("choose");
        assert_eq!(source, Source::Session { socket: "/data/crew.sock".into(), token: "t".into() });
    }

    /// The dev app exports CREW_DATA_DIR and its sessions inherit it; that
    /// alone must not turn a session into the user.
    #[test]
    fn the_data_dir_env_does_not_override_a_session() {
        let env = session_env();
        assert!(matches!(choose(&Global::default(), &env).expect("choose"), Source::Session { .. }));
    }

    #[test]
    fn naming_a_data_dir_speaks_as_the_user_even_in_a_session() {
        let global = Global { data_dir: Some("/other".into()), ..Global::default() };
        assert_eq!(choose(&global, &session_env()).expect("choose"), Source::User { data_dir: "/other".into() });
    }

    #[test]
    fn half_a_session_is_no_session() {
        let env = Env { token: Some("t".into()), home: Some("/Users/me".into()), ..Env::default() };
        assert!(matches!(choose(&Global::default(), &env).expect("choose"), Source::User { .. }));
    }

    #[test]
    fn the_data_dir_is_the_flag_then_the_env_then_the_app() {
        let env = Env { data_dir: Some("/env".into()), home: Some("/Users/me".into()), ..Env::default() };
        assert_eq!(data_dir(Some(Path::new("/flag")), &env).expect("dir"), PathBuf::from("/flag"));
        assert_eq!(data_dir(None, &env).expect("dir"), PathBuf::from("/env"));
        let env = Env { home: Some("/Users/me".into()), ..Env::default() };
        let default = data_dir(None, &env).expect("dir");
        if cfg!(target_os = "macos") {
            assert_eq!(default, PathBuf::from("/Users/me/Library/Application Support/Crew"));
        } else {
            assert_eq!(default, PathBuf::from("/Users/me/.config/Crew"));
        }
        assert!(data_dir(None, &Env::default()).is_err(), "no HOME, no default");
    }

    #[test]
    fn no_daemon_json_means_crew_is_not_running() {
        let dir = temp("missing");
        let _ = std::fs::remove_file(daemon_file_path(&dir));
        match read_daemon_file(&dir) {
            Err(CliError::NotRunning(message)) => assert!(message.contains("crew open"), "{message}"),
            other => panic!("{other:?}"),
        }
    }

    #[test]
    fn daemon_json_is_read_with_or_without_a_pid() {
        let dir = temp("read");
        std::fs::write(
            daemon_file_path(&dir),
            r#"{"url":"ws://127.0.0.1:1","token":"w","socket":"/s","userToken":"u","version":"0.1.7"}"#,
        )
        .expect("write");
        let file = read_daemon_file(&dir).expect("read");
        assert_eq!((file.user_token.as_str(), file.socket.as_str(), file.pid), ("u", "/s", None));
        std::fs::write(daemon_file_path(&dir), "{").expect("write");
        assert!(matches!(read_daemon_file(&dir), Err(CliError::Failed(_))));
    }

    #[test]
    fn a_user_call_names_its_workspace_by_an_absolute_path_or_an_id() {
        let cwd = temp("ws");
        std::fs::create_dir_all(cwd.join("sub")).expect("sub");
        assert_eq!(workspace_arg(None, &cwd), cwd.to_string_lossy());
        assert_eq!(workspace_arg(Some("sub"), &cwd), cwd.join("sub").to_string_lossy());
        assert_eq!(workspace_arg(Some("/"), &cwd), "/");
        assert_eq!(workspace_arg(Some("3f2a-not-a-path"), &cwd), "3f2a-not-a-path");
    }

    #[test]
    fn the_user_speaks_with_the_user_token_in_the_workspace_it_names() {
        let dir = temp("user");
        std::fs::write(
            daemon_file_path(&dir),
            r#"{"url":"ws://127.0.0.1:1","token":"w","socket":"/d/crew.sock","userToken":"u","version":"0","pid":9}"#,
        )
        .expect("write");
        let global = Global { data_dir: Some(dir.clone()), workspace: Some("ws-id".into()), json: false };
        let Identity::User { link } = Identity::resolve(&global, &session_env()).expect("resolve") else {
            panic!("not the user");
        };
        assert_eq!(link, Link::new("/d/crew.sock", "u", Some("ws-id".into())));
        let Identity::Session { link } = Identity::resolve(&Global::default(), &session_env()).expect("resolve") else {
            panic!("not the session");
        };
        assert_eq!(link, Link::new("/data/crew.sock", "t", None));
    }
}
