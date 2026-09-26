//! `crew open` and `crew status`: the app, and whether the daemon behind it
//! answers.

use std::path::{Path, PathBuf};
use std::process::ExitCode;

use crew_protocol::DaemonFile;
use serde_json::{json, Value};

use crate::client::Client;
use crate::identity::{self, Identity, Source};
use crate::output;
use crate::{CliError, Ctx};

const CLI_VERSION: &str = env!("CARGO_PKG_VERSION");

/// `open -a Crew`. A folder is handed along, but the app does not act on one
/// yet, so a refusal to take it still brings the app up without it.
pub fn open(path: Option<&Path>) -> Result<ExitCode, CliError> {
    if !cfg!(target_os = "macos") {
        return Err(CliError::Failed("crew open needs macOS; start Crew yourself.".into()));
    }
    let launch = |path: Option<&Path>| {
        let mut command = std::process::Command::new("open");
        command.args(["-a", "Crew"]);
        if let Some(path) = path {
            command.arg(path);
        }
        command.status().map(|status| status.success()).unwrap_or(false)
    };
    let path = path.map(|path| std::fs::canonicalize(path).unwrap_or_else(|_| path.to_path_buf()));
    if launch(path.as_deref()) {
        return Ok(ExitCode::SUCCESS);
    }
    if path.is_some() && launch(None) {
        eprintln!("crew: Crew opened, but did not take the folder");
        return Ok(ExitCode::SUCCESS);
    }
    Err(CliError::Failed("Couldn't open Crew. Is Crew.app in /Applications?".into()))
}

/// Everything `crew status` and `crew daemon status` report.
pub(crate) struct Status {
    pub data_dir: Option<PathBuf>,
    pub session: bool,
    pub daemon: Option<DaemonFile>,
    /// What the daemon said about the caller; `None` when it did not answer.
    pub caller: Option<Value>,
    pub running: bool,
    /// Why it is not running, or why the caller could not be asked about.
    pub problem: Option<String>,
}

impl Status {
    pub fn gather(ctx: &Ctx) -> Status {
        let source = identity::choose(&ctx.global, &ctx.env);
        let mut status = Status {
            data_dir: match &source {
                Ok(Source::User { data_dir }) => Some(data_dir.clone()),
                Ok(Source::Session { socket, .. }) => Path::new(socket).parent().map(Path::to_path_buf),
                Err(_) => None,
            },
            session: matches!(source, Ok(Source::Session { .. })),
            daemon: None,
            caller: None,
            running: false,
            problem: None,
        };
        // The file is read for the version and pid even in a session, where
        // it is not how the CLI gets in.
        status.daemon = status.data_dir.as_deref().and_then(|dir| identity::read_daemon_file(dir).ok());
        let client = match Identity::resolve(&ctx.global, &ctx.env) {
            Ok(identity) => Client::new(identity),
            Err(error) => {
                status.problem = Some(error.message().to_string());
                return status;
            }
        };
        match client.call("whoami", json!({})) {
            Ok(caller) => {
                status.running = true;
                status.caller = Some(caller);
            }
            Err(CliError::NotRunning(message)) => status.problem = Some(message),
            // A daemon that answers, even to say no, is running.
            Err(error) => {
                status.running = true;
                status.problem = Some(error.message().to_string());
            }
        }
        status
    }

    pub fn json(&self) -> Value {
        json!({
            "running": self.running,
            "cli": CLI_VERSION,
            "version": self.daemon.as_ref().map(|file| file.version.clone()),
            "pid": self.daemon.as_ref().and_then(|file| file.pid),
            "dataDir": self.data_dir,
            "socket": self.daemon.as_ref().map(|file| file.socket.clone()),
            "caller": self.caller,
            "error": self.problem,
        })
    }

    pub fn rows(&self) -> Vec<(&'static str, String)> {
        let mut rows = vec![("crew", CLI_VERSION.to_string())];
        rows.push((
            "daemon",
            if self.running {
                let mut line = "running".to_string();
                if let Some(file) = &self.daemon {
                    line.push_str(&format!(" · crewd {}", file.version));
                    if file.version != CLI_VERSION {
                        line.push_str(&format!(" (this crew is {CLI_VERSION})"));
                    }
                    if let Some(pid) = file.pid {
                        line.push_str(&format!(" · pid {pid}"));
                    }
                }
                line
            } else {
                "not running — open Crew or run `crew open`".to_string()
            },
        ));
        if let Some(dir) = &self.data_dir {
            rows.push(("data dir", dir.display().to_string()));
        }
        if let Some(file) = &self.daemon {
            rows.push(("socket", file.socket.clone()));
        }
        if self.running {
            rows.extend(self.caller_rows());
        }
        rows
    }

    fn caller_rows(&self) -> Vec<(&'static str, String)> {
        let Some(caller) = &self.caller else {
            let why = self.problem.clone().unwrap_or_default();
            return vec![("caller", format!("unknown ({why})"))];
        };
        let label = caller.get("label").and_then(Value::as_str).unwrap_or("?").to_string();
        let how = if self.session { "a Crew session's CREW_TOKEN" } else { "daemon.json" };
        let workspace = match caller.get("workspace").filter(|found| !found.is_null()) {
            Some(found) => {
                let field = |key: &str| found.get(key).and_then(Value::as_str).unwrap_or("").to_string();
                format!("{}  {}  ({})", field("name"), field("path"), field("id"))
            }
            None => "none here — cd into a workspace's folder, or pass --workspace".to_string(),
        };
        vec![("caller", format!("{label}, from {how}")), ("workspace", workspace)]
    }
}

pub fn status(ctx: &Ctx) -> Result<ExitCode, CliError> {
    let status = Status::gather(ctx);
    if ctx.global.json {
        output::say_json(&status.json());
    } else {
        output::say(&output::pairs(&status.rows()));
    }
    Ok(if status.running { ExitCode::SUCCESS } else { ExitCode::from(3) })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn file(version: &str) -> DaemonFile {
        DaemonFile {
            url: "ws://127.0.0.1:1".into(),
            token: "secret-ws".into(),
            socket: "/d/crew.sock".into(),
            user_token: "secret-user".into(),
            version: version.into(),
            pid: Some(42),
        }
    }

    #[test]
    fn a_running_daemon_reports_its_version_and_who_you_are() {
        let status = Status {
            data_dir: Some("/d".into()),
            session: false,
            daemon: Some(file(CLI_VERSION)),
            caller: Some(json!({ "kind": "user", "label": "the user", "workspace": { "id": "w1", "name": "crew", "path": "/code/crew" } })),
            running: true,
            problem: None,
        };
        let text = output::pairs(&status.rows());
        assert!(text.contains(&format!("daemon     running · crewd {CLI_VERSION} · pid 42")), "{text}");
        assert!(text.contains("caller     the user, from daemon.json"), "{text}");
        assert!(text.contains("workspace  crew  /code/crew  (w1)"), "{text}");
        // The tokens never leave the file.
        let json = status.json().to_string();
        assert!(!json.contains("secret") && !text.contains("secret"), "{json}");
    }

    #[test]
    fn a_version_mismatch_is_pointed_out() {
        let status = Status {
            data_dir: None,
            session: true,
            daemon: Some(file("0.0.1")),
            caller: Some(json!({ "label": "Coder (agent a1)", "workspace": null })),
            running: true,
            problem: None,
        };
        let text = output::pairs(&status.rows());
        assert!(text.contains(&format!("crewd 0.0.1 (this crew is {CLI_VERSION})")), "{text}");
        assert!(text.contains("from a Crew session's CREW_TOKEN"), "{text}");
        assert!(text.contains("none here"), "{text}");
    }

    #[test]
    fn a_stopped_daemon_says_how_to_start_it() {
        let status = Status { data_dir: Some("/d".into()), session: false, daemon: None, caller: None, running: false, problem: None };
        let text = output::pairs(&status.rows());
        assert!(text.contains("not running — open Crew or run `crew open`"), "{text}");
        assert!(!text.contains("caller"), "{text}");
    }
}
