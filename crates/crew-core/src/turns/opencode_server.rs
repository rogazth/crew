//! The one `opencode serve` a daemon runs for every opencode session.
//!
//! It starts on the first opencode need (a turn, a `/` menu), on a port the
//! system picks, with a password made for this run that travels in its
//! environment only, never on argv. It runs as an agent process under
//! [`SERVER_KEY`], so its process group is in the registry the startup sweep
//! reads, and it stops with the daemon like any agent. Its config is the 2.x
//! format with Crew's MCP server (`providers::opencode::server_config`), in a
//! file only the user can read that `OPENCODE_CONFIG` names: the server's
//! environment is every shell's it runs (measured on 2.0.26: a session shell
//! printed the server's whole `env`, `OPENCODE_CONFIG_CONTENT` included), and
//! the run's host token, in the MCP server's own environment there, must not
//! reach one. Each session's shell gets its own token instead
//! (`turns/opencode.rs`).
//!
//! Before it is used: its version is checked (refused below 2.0.4, a word
//! above the last tested one), and a 1.x database it is still moving to 2.x
//! is waited for, the progress said in the transcript of the session that
//! asked. One reader follows its event stream and hands each event to the
//! Crew session bound to the opencode session it names; a stream that drops
//! is opened again and the sessions mid-turn are read back, so a turn that
//! ended in the gap still ends. A server that dies takes the turns running on
//! it with it, and the next need starts another.

use std::collections::{HashMap, HashSet};
use std::sync::mpsc;
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant};

use crew_protocol::HarnessEvent;
use serde_json::Value;

use super::{Live, TurnHost, TurnOutcome};
use crate::http_local::{HttpError, LocalClient};
use crate::providers::opencode::{migration, server_config, version_check, Migration};

/// The agent key the server runs under: no session has it.
pub(crate) const SERVER_KEY: &str = "opencode:server";

/// How long `opencode serve` may take to say where it listens. 2.0.26 says
/// so in a third of a second.
const LISTEN_TIMEOUT: Duration = Duration::from_secs(if cfg!(test) { 10 } else { 30 });
/// How long the event stream may stay silent before it counts as dropped.
/// The server sends a heartbeat comment in between.
const STREAM_IDLE: Duration = Duration::from_secs(90);
/// How long a call to the server may take.
pub(super) const CALL_TIMEOUT: Duration = Duration::from_secs(30);
/// How long a 1.x database may take to move. A 264 MB one with 276 sessions
/// took 2.5 s on 2.0.26.
const MIGRATION_LIMIT: Duration = Duration::from_secs(30 * 60);
/// How often the migration's progress is said in the transcript.
const MIGRATION_NOTE_EVERY: Duration = Duration::from_secs(5);
/// How many lines of what the server printed are kept for an error.
const OUTPUT_TAIL: usize = 12;

/// One launch of the server, as the driver reaches it.
#[derive(Clone)]
pub(crate) struct Conn {
    pub port: u16,
    pub password: Arc<String>,
    pub version: String,
    /// Which launch: what was set on a session (its environment) is set
    /// again on a later one.
    pub epoch: u64,
    /// The bridge's name for this run, which its bindings are made under.
    pub run_id: String,
}

impl Conn {
    pub fn client(&self) -> LocalClient {
        LocalClient::new(self.port, &self.password).with_timeout(CALL_TIMEOUT)
    }
}

#[derive(Default)]
struct State {
    conn: Option<Conn>,
    epoch: u64,
    /// The launch the bridge knows, and the config file it reads, until it
    /// ends: a run that never came up ends as one that died.
    run: Option<(String, std::path::PathBuf)>,
    /// While a launch waits for the line that says where it listens.
    listening: Option<mpsc::Sender<u16>>,
    /// What it printed last, for the error when it does not come up or dies.
    output: Vec<String>,
    /// Crew's session for each opencode session bound to one.
    routes: HashMap<String, String>,
    /// Each model's window (`provider/id`), read from `/api/model`.
    windows: HashMap<String, u64>,
    /// Folders whose `/` menu is being read again, so a burst of
    /// `command.updated` reads it once.
    menu_reads: HashSet<String>,
}

/// The server's state, shared by every clone of the host.
#[derive(Clone, Default)]
pub(crate) struct OpencodeServer {
    state: Arc<Mutex<State>>,
    /// Held across a launch, so two needs at once start one server.
    starting: Arc<Mutex<()>>,
}

impl OpencodeServer {
    fn lock(&self) -> std::sync::MutexGuard<'_, State> {
        self.state.lock().unwrap_or_else(|e| e.into_inner())
    }

    fn current(&self, epoch: u64) -> bool {
        self.lock().conn.as_ref().is_some_and(|conn| conn.epoch == epoch)
    }

    /// The launch that is up, if one is: for a call made between turns
    /// (a reply, a reload) that must not start one.
    pub fn conn(&self) -> Option<Conn> {
        self.lock().conn.clone()
    }

    /// The Crew session an opencode session is bound to.
    pub fn route(&self, opencode_id: &str) -> Option<String> {
        self.lock().routes.get(opencode_id).cloned()
    }

    pub fn bind(&self, opencode_id: &str, crew_id: &str) {
        self.lock().routes.insert(opencode_id.to_string(), crew_id.to_string());
    }

    pub fn unbind(&self, opencode_id: &str) {
        self.lock().routes.remove(opencode_id);
    }

    /// A model's window, when it was read.
    pub fn window(&self, model: &str) -> Option<u64> {
        self.lock().windows.get(model).copied()
    }

    pub fn learn_window(&self, model: &str, window: u64) {
        self.lock().windows.insert(model.to_string(), window);
    }

    /// opencode's models changed (a provider signed in, models.dev read
    /// again): their windows are read again when next needed.
    pub fn forget_windows(&self) {
        self.lock().windows.clear();
    }

    /// Takes a folder's menu read, unless one is in flight already.
    pub fn begin_menu_read(&self, cwd: &str) -> bool {
        self.lock().menu_reads.insert(cwd.to_string())
    }

    pub fn end_menu_read(&self, cwd: &str) {
        self.lock().menu_reads.remove(cwd);
    }

    fn output(&self) -> String {
        self.lock().output.join("\n")
    }
}

/// The port of `server listening on http://127.0.0.1:<port>`.
fn listening_port(line: &str) -> Option<u16> {
    let rest = line.trim().strip_prefix("server listening on ")?;
    rest.rsplit(':').next()?.trim_end_matches('/').parse().ok()
}

/// A password for one run: two v4 UUIDs, 244 random bits.
fn password() -> String {
    format!("{}{}", uuid::Uuid::new_v4().simple(), uuid::Uuid::new_v4().simple())
}

impl TurnHost {
    /// The server, up and checked: the one running, or a new launch. `notes`
    /// is the session whose transcript hears what the launch has to say (a
    /// newer version than tested, a migration under way).
    pub(super) fn opencode_conn(&self, notes: Option<&str>) -> Result<Conn, String> {
        let alive = || self.agents.running().iter().any(|key| key == SERVER_KEY);
        if let Some(conn) = self.opencode.lock().conn.clone().filter(|_| alive()) {
            return Ok(conn);
        }
        let _starting = self.opencode.starting.lock().unwrap_or_else(|e| e.into_inner());
        if let Some(conn) = self.opencode.lock().conn.clone().filter(|_| alive()) {
            return Ok(conn);
        }
        self.opencode_launch(notes)
    }

    fn opencode_launch(&self, notes: Option<&str>) -> Result<Conn, String> {
        let path = self.resolve_bin("opencode")?;
        self.opencode_end_run();
        let password = password();
        // The MCP server alone holds Crew's socket and the run's host token,
        // and speaks for each session by the id opencode puts on every call.
        let run = self.bridge.opencode().start_run();
        let mut mcp_env = vec![("CREW_TOKEN".to_string(), run.host_token.clone())];
        if let Ok(info) = self.bridge.info() {
            mcp_env.push(("CREW_SOCKET".into(), info.socket_path));
        }
        let config = match write_config(&run.run_id, &server_config(self.mcp().as_ref(), &mcp_env)) {
            Ok(config) => config,
            Err(error) => {
                self.bridge.opencode().end_run(&run.run_id);
                return Err(format!("Crew could not write opencode's config: {error}"));
            }
        };
        // Both names: the server reads the first, `opencode attach` and the
        // TUI the second.
        let env = HashMap::from([
            ("OPENCODE_SERVER_PASSWORD".to_string(), password.clone()),
            ("OPENCODE_PASSWORD".to_string(), password.clone()),
            ("OPENCODE_CONFIG".to_string(), config.to_string_lossy().into_owned()),
        ]);
        let (tx, rx) = mpsc::channel();
        let epoch = {
            let mut state = self.opencode.lock();
            state.epoch += 1;
            state.conn = None;
            state.listening = Some(tx);
            state.output.clear();
            state.run = Some((run.run_id.clone(), config));
            state.epoch
        };
        let cwd = std::env::var("HOME")
            .ok()
            .filter(|home| std::path::Path::new(home).is_dir())
            .unwrap_or_else(|| std::env::temp_dir().to_string_lossy().into_owned());
        let args = ["serve", "--hostname", "127.0.0.1", "--port", "0"].map(str::to_string).to_vec();
        self.agents.spawn(SERVER_KEY.to_string(), path, args, cwd, Some(env))?;
        let fail = |host: &TurnHost, why: String| -> String {
            host.agents.kill(SERVER_KEY);
            let output = host.opencode.output();
            if output.trim().is_empty() {
                why
            } else {
                format!("{why}\n{}", output.trim())
            }
        };
        let port = match rx.recv_timeout(LISTEN_TIMEOUT) {
            Ok(port) => port,
            Err(_) => return Err(fail(self, "opencode serve did not start.".into())),
        };
        self.opencode.lock().listening = None;
        let mut conn = Conn { port, password: Arc::new(password), version: String::new(), epoch, run_id: run.run_id };
        let client = conn.client();
        // It says where it listens a moment before it answers there.
        let deadline = Instant::now() + LISTEN_TIMEOUT;
        let info = loop {
            match client.get_json("/api/info") {
                Ok(reply) if reply.status == 200 => break reply.body,
                Err(HttpError::Unreachable(_)) if Instant::now() < deadline => thread::sleep(Duration::from_millis(50)),
                Ok(reply) => return Err(fail(self, format!("opencode answered {} to /api/info.", reply.status))),
                Err(error) => return Err(fail(self, error.to_string())),
            }
        };
        conn.version = info.get("version").and_then(Value::as_str).unwrap_or_default().to_string();
        match version_check(&conn.version) {
            Err(why) => return Err(fail(self, why)),
            Ok(Some(word)) => self.opencode_note(notes, &word),
            Ok(None) => {}
        }
        self.opencode_migration(&client, notes)?;
        self.opencode.lock().conn = Some(conn.clone());
        // Events are read before anything is asked of it, so none is missed.
        let (ready_tx, ready_rx) = mpsc::channel();
        self.opencode_pump(conn.clone(), ready_tx);
        if ready_rx.recv_timeout(LISTEN_TIMEOUT).is_err() {
            return Err(fail(self, "opencode's event stream did not open.".into()));
        }
        Ok(conn)
    }

    /// Says something about the server in a session's transcript.
    fn opencode_note(&self, session_id: Option<&str>, message: &str) {
        match session_id {
            Some(id) => {
                self.transcripts.apply(id, HarnessEvent::SessionNote { message: message.to_string() });
            }
            None => eprintln!("[opencode] {message}"),
        }
    }

    /// Waits for opencode to move a 1.x database to 2.x, saying how far it
    /// got. A server that has no such route has nothing to move.
    fn opencode_migration(&self, client: &LocalClient, notes: Option<&str>) -> Result<(), String> {
        let started = Instant::now();
        let mut said: Option<Instant> = None;
        loop {
            let reply = match client.get_json("/api/experimental/migration/v1") {
                Ok(reply) if reply.status == 200 => reply.body,
                _ => return Ok(()),
            };
            match migration(&reply) {
                Migration::Done => {
                    if said.is_some() {
                        self.opencode_note(notes, "opencode finished moving its sessions to 2.x.");
                    }
                    return Ok(());
                }
                Migration::Failed(why) => {
                    self.opencode_note(notes, &format!("opencode could not move its 1.x sessions to 2.x: {why}"));
                    return Ok(());
                }
                Migration::Running { label, done, total } => {
                    if said.is_none_or(|at| at.elapsed() >= MIGRATION_NOTE_EVERY) {
                        self.opencode_note(
                            notes,
                            &format!("opencode is moving its sessions to 2.x, once ({label}: {done} of {total})."),
                        );
                        // A turn waiting on this is not a silent one.
                        if let Some(id) = notes {
                            if let Some(Live::Opencode(live)) = self.lock().get_mut(id) {
                                live.saw_output = true;
                            }
                        }
                        said = Some(Instant::now());
                    }
                    if started.elapsed() > MIGRATION_LIMIT {
                        return Err("opencode is still moving its sessions to 2.x. Try again in a while.".into());
                    }
                    thread::sleep(Duration::from_millis(500));
                }
            }
        }
    }

    /// The reader of the server's event stream, for as long as this launch is
    /// the current one. `ready` hears the first event (`server.connected`).
    fn opencode_pump(&self, conn: Conn, ready: mpsc::Sender<()>) {
        let host = self.clone();
        thread::spawn(move || {
            let client = LocalClient::new(conn.port, &conn.password).with_timeout(STREAM_IDLE);
            let mut ready = Some(ready);
            let mut dropped = false;
            while host.opencode.current(conn.epoch) {
                let stream = match client.open_events("/api/event") {
                    Ok(stream) => stream,
                    Err(_) => {
                        thread::sleep(Duration::from_millis(200));
                        continue;
                    }
                };
                for item in stream {
                    match item {
                        Ok(event) => {
                            if let Some(ready) = ready.take() {
                                let _ = ready.send(());
                            }
                            // Back after a drop: what ended in the gap is read
                            // back once the stream is open again.
                            if dropped {
                                dropped = false;
                                let host = host.clone();
                                let conn = conn.clone();
                                thread::spawn(move || host.opencode_resync(&conn));
                            }
                            host.opencode_event(&event);
                        }
                        // A frame that was not JSON; the next one starts clean.
                        Err(HttpError::Protocol(_)) => {}
                        Err(_) => break,
                    }
                }
                dropped = true;
                thread::sleep(Duration::from_millis(100));
            }
        });
    }

    /// Reads back each session mid-turn after the stream dropped: one whose
    /// turn ended while nobody was listening ends now, as opencode says it did.
    fn opencode_resync(&self, conn: &Conn) {
        let running: Vec<(String, String, i64)> = self
            .lock()
            .iter()
            .filter_map(|(id, live)| match live {
                Live::Opencode(live) if live.active && !live.settled => {
                    live.oc.clone().map(|oc| (id.clone(), oc, live.started_at))
                }
                _ => None,
            })
            .collect();
        for (id, oc, started_at) in running {
            let Ok(reply) = conn.client().get_json(&format!("/api/session/{oc}")) else {
                continue;
            };
            let data = &reply.body["data"];
            let idle = data.pointer("/time/idle").and_then(Value::as_i64).unwrap_or(0);
            if idle < started_at {
                continue;
            }
            let outcome = match data.get("outcome").and_then(Value::as_str) {
                Some("succeeded") => TurnOutcome::Completed,
                Some("interrupted") => TurnOutcome::Stopped,
                Some(_) => TurnOutcome::Failed("The turn failed while Crew was not listening to opencode.".into()),
                None => continue,
            };
            self.transcripts.apply(&id, HarnessEvent::MessageCompleted {});
            self.transcripts.apply(&id, HarnessEvent::TurnCompleted { usage: None });
            self.signal(&id, outcome);
        }
    }

    /// What the server printed: the line that says where it listens goes to
    /// the launch that waits for it; the rest is kept for an error.
    pub(super) fn on_opencode_server_lines(&self, lines: Vec<String>) {
        let mut state = self.opencode.lock();
        for line in lines {
            if let Some(port) = listening_port(&line) {
                if let Some(tx) = state.listening.take() {
                    let _ = tx.send(port);
                }
                continue;
            }
            state.output.push(line);
            if state.output.len() > OUTPUT_TAIL {
                state.output.remove(0);
            }
        }
    }

    /// The server is gone. The turns running on it end with it; the
    /// sessions keep their bindings, since their conversations are in
    /// opencode's database, and the next need starts another server.
    pub(super) fn on_opencode_server_exit(&self, code: Option<i32>) {
        let output = {
            let mut state = self.opencode.lock();
            state.conn = None;
            state.listening = None;
            state.output.join("\n")
        };
        self.opencode_end_run();
        let running: Vec<String> = self
            .lock()
            .iter_mut()
            .filter_map(|(id, live)| match live {
                Live::Opencode(live) => {
                    live.release_asks();
                    (live.active && !live.settled && !live.cancelled).then(|| id.clone())
                }
                _ => None,
            })
            .collect();
        let message = super::exit_message("opencode", code, &[output]);
        for id in running {
            self.transcripts.apply(&id, HarnessEvent::SessionEnded { code });
            self.signal(&id, TurnOutcome::Failed(message.clone()));
        }
    }

    /// The run is over: its host token and every binding's shell token stop
    /// working, and its config file goes.
    fn opencode_end_run(&self) {
        let run = self.opencode.lock().run.take();
        if let Some((run_id, config)) = run {
            self.bridge.opencode().end_run(&run_id);
            let _ = std::fs::remove_file(config);
        }
    }

    /// Tells the bridge that calls naming `opencode_id` on this run are
    /// `crew_id`'s, and routes its events there. Returns the token for that
    /// session's shell.
    pub(super) fn bind_opencode_session(&self, conn: &Conn, opencode_id: &str, crew_id: &str) -> Result<String, String> {
        let token = self.bridge.opencode().bind(&conn.run_id, opencode_id, crew_id)?;
        self.opencode.bind(opencode_id, crew_id);
        Ok(token)
    }

    /// Takes a binding back from the bridge and the event routes.
    pub(super) fn unbind_opencode_session(&self, opencode_id: &str) {
        self.opencode.unbind(opencode_id);
        let run = self.opencode.lock().run.as_ref().map(|(run_id, _)| run_id.clone());
        if let Some(run_id) = run {
            self.bridge.opencode().unbind(&run_id, opencode_id);
        }
    }
}

/// Writes the server's config where only the user can read it.
fn write_config(run_id: &str, config: &str) -> std::io::Result<std::path::PathBuf> {
    use std::io::Write as _;
    use std::os::unix::fs::{DirBuilderExt as _, OpenOptionsExt as _};
    let dir = std::env::temp_dir().join("crew-opencode");
    std::fs::DirBuilder::new().recursive(true).mode(0o700).create(&dir)?;
    let path = dir.join(format!("{run_id}.json"));
    let mut file = std::fs::OpenOptions::new().write(true).create(true).truncate(true).mode(0o600).open(&path)?;
    file.write_all(config.as_bytes())?;
    Ok(path)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_port_is_read_off_the_line_that_says_where_it_listens() {
        assert_eq!(listening_port("server listening on http://127.0.0.1:47613"), Some(47613));
        assert_eq!(listening_port("server listening on http://127.0.0.1:47613/\n"), Some(47613));
        assert_eq!(listening_port("server password 0fR6F7pN"), None);
        assert_eq!(listening_port("[17:32:00.355] INFO (#723): spawning process {"), None);
    }

    #[test]
    fn each_run_has_a_password_of_its_own() {
        let (one, two) = (password(), password());
        assert_ne!(one, two);
        assert_eq!(one.len(), 64);
    }
}
