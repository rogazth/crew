//! Signing in. Every CLI signs in through a terminal tab: [`command`] says
//! what to type. Codex also has a device-code flow the daemon can host
//! itself: it keeps a `codex app-server` alive while the user approves the
//! code in a browser, and says how it ended.

use std::collections::HashMap;
use std::sync::mpsc::{self, Receiver, Sender, TryRecvError};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant};

use crew_protocol::{ProviderLoginCommand, ProviderLoginEvent, ProviderLoginFlow, ProviderLoginPhase};
use serde_json::{json, Value};

use crate::provider_status;
use crate::shell_path;
use crate::usage::codex::AppServer;

/// How long the code is waited for; the server's own code expires about then.
const FLOW_TIMEOUT: Duration = Duration::from_secs(15 * 60);
const START_TIMEOUT: Duration = Duration::from_secs(20);
const TICK: Duration = Duration::from_millis(250);

/// The commands to sign in and out of `provider` by hand in a terminal.
pub fn command(provider: &str) -> Result<ProviderLoginCommand, String> {
    let (login, logout) = match provider {
        "claude" => ("claude auth login", "claude auth logout"),
        "codex" => ("codex login", "codex logout"),
        "cursor" => ("cursor-agent login", "cursor-agent logout"),
        "opencode" => ("opencode auth login", "opencode auth logout"),
        other => return Err(format!("unknown provider `{other}`")),
    };
    Ok(ProviderLoginCommand { provider: provider.into(), login: login.into(), logout: logout.into() })
}

/// The device code out of a `account/login/start` result.
pub fn parse_flow(result: &Value) -> Option<ProviderLoginFlow> {
    let text = |key: &str| result.get(key).and_then(Value::as_str).filter(|v| !v.is_empty()).map(str::to_string);
    Some(ProviderLoginFlow {
        provider: "codex".into(),
        login_id: text("loginId")?,
        user_code: text("userCode")?,
        verification_url: text("verificationUrl")?,
    })
}

/// How an `account/login/completed` notification ended the flow `login_id`;
/// None when it is about another login or is not that notification.
pub fn parse_completed(message: &Value, login_id: &str) -> Option<ProviderLoginEvent> {
    if message.get("method").and_then(Value::as_str) != Some("account/login/completed") {
        return None;
    }
    let params = message.get("params")?;
    match params.get("loginId").and_then(Value::as_str) {
        Some(other) if other != login_id => return None,
        _ => {}
    }
    let ok = params.get("success").and_then(Value::as_bool).unwrap_or(false);
    let error = params.get("error").and_then(Value::as_str).filter(|e| !e.is_empty()).map(str::to_string);
    Some(ProviderLoginEvent {
        provider: "codex".into(),
        login_id: login_id.into(),
        phase: if ok { ProviderLoginPhase::Done } else { ProviderLoginPhase::Failed },
        error: if ok { None } else { Some(error.unwrap_or_else(|| "Codex did not sign in".into())) },
    })
}

pub type Listener = Arc<dyn Fn(&ProviderLoginEvent) + Send + Sync>;

#[derive(Clone, Default)]
pub struct ProviderLogins {
    /// The flows waiting on a browser, by login id: how to stop each.
    active: Arc<Mutex<HashMap<String, Sender<()>>>>,
    listener: Arc<Mutex<Option<Listener>>>,
}

impl ProviderLogins {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn set_listener(&self, listener: Listener) {
        *self.listener.lock().unwrap_or_else(|e| e.into_inner()) = Some(listener);
    }

    fn emit(&self, event: &ProviderLoginEvent) {
        let listener = self.listener.lock().unwrap_or_else(|e| e.into_inner()).clone();
        if let Some(listener) = listener {
            listener(event);
        }
    }

    /// Starts Codex's device-code sign-in. Another flow still waiting is cancelled first.
    pub fn start_codex(&self) -> Result<ProviderLoginFlow, String> {
        let bin = shell_path::resolve("codex").ok_or("codex is not installed")?;
        let mut server = AppServer::start(&bin.to_string_lossy()).ok_or("could not start `codex app-server`")?;
        let result = server
            .call("account/login/start", Some(json!({ "type": "chatgptDeviceCode" })), START_TIMEOUT)
            .ok_or("Codex did not answer the sign-in request")?;
        let flow = parse_flow(&result).ok_or("Codex did not give a sign-in code")?;
        for id in self.active_ids() {
            self.cancel(&id);
        }
        let (stop, stopped) = mpsc::channel();
        self.active.lock().unwrap_or_else(|e| e.into_inner()).insert(flow.login_id.clone(), stop);
        let host = self.clone();
        let login_id = flow.login_id.clone();
        thread::spawn(move || host.wait(server, &login_id, stopped));
        Ok(flow)
    }

    fn active_ids(&self) -> Vec<String> {
        self.active.lock().unwrap_or_else(|e| e.into_inner()).keys().cloned().collect()
    }

    /// Stops waiting for `login_id`; the app-server goes with it.
    pub fn cancel(&self, login_id: &str) -> bool {
        let stop = self.active.lock().unwrap_or_else(|e| e.into_inner()).remove(login_id);
        match stop {
            Some(stop) => {
                let _ = stop.send(());
                true
            }
            None => false,
        }
    }

    /// Holds the app-server until the sign-in completes, is cancelled or times out.
    fn wait(&self, server: AppServer, login_id: &str, stopped: Receiver<()>) {
        let deadline = Instant::now() + FLOW_TIMEOUT;
        let event = |phase, error: Option<&str>| ProviderLoginEvent {
            provider: "codex".into(),
            login_id: login_id.into(),
            phase,
            error: error.map(str::to_string),
        };
        let ended = loop {
            if !matches!(stopped.try_recv(), Err(TryRecvError::Empty)) {
                break event(ProviderLoginPhase::Cancelled, None);
            }
            if Instant::now() > deadline {
                break event(ProviderLoginPhase::Failed, Some("The sign-in code expired"));
            }
            match server.rx.recv_timeout(TICK) {
                Ok(message) => {
                    if let Some(done) = parse_completed(&message, login_id) {
                        break done;
                    }
                }
                Err(mpsc::RecvTimeoutError::Timeout) => {}
                Err(mpsc::RecvTimeoutError::Disconnected) => break event(ProviderLoginPhase::Failed, Some("Codex stopped before the sign-in finished")),
            }
        };
        drop(server);
        self.active.lock().unwrap_or_else(|e| e.into_inner()).remove(login_id);
        // The account the next lookup sees is a different one.
        provider_status::invalidate();
        self.emit(&ended);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn each_cli_has_a_login_and_logout_to_type() {
        let claude = command("claude").unwrap();
        assert_eq!((claude.login.as_str(), claude.logout.as_str()), ("claude auth login", "claude auth logout"));
        assert_eq!(command("codex").unwrap().login, "codex login");
        assert_eq!(command("cursor").unwrap().logout, "cursor-agent logout");
        assert_eq!(command("opencode").unwrap().login, "opencode auth login");
        assert!(command("gemini").is_err());
    }

    #[test]
    fn a_device_code_comes_out_of_the_start_result() {
        let result = json!({ "type": "chatgptDeviceCode", "loginId": "L1", "userCode": "ABCD-1234", "verificationUrl": "https://auth.openai.com/codex/device" });
        let flow = parse_flow(&result).unwrap();
        assert_eq!((flow.login_id.as_str(), flow.user_code.as_str(), flow.verification_url.as_str()), ("L1", "ABCD-1234", "https://auth.openai.com/codex/device"));
        assert!(parse_flow(&json!({ "type": "chatgpt", "loginId": "L1", "authUrl": "https://x" })).is_none());
        assert!(parse_flow(&Value::Null).is_none());
    }

    #[test]
    fn the_completed_notification_ends_only_its_own_flow() {
        let done = json!({ "method": "account/login/completed", "params": { "loginId": "L1", "success": true, "error": null } });
        let event = parse_completed(&done, "L1").unwrap();
        assert_eq!((event.phase, event.error), (ProviderLoginPhase::Done, None));
        assert!(parse_completed(&done, "L2").is_none());
        let bad = json!({ "method": "account/login/completed", "params": { "loginId": null, "success": false, "error": "denied" } });
        let event = parse_completed(&bad, "L1").unwrap();
        assert_eq!((event.phase, event.error.as_deref()), (ProviderLoginPhase::Failed, Some("denied")));
        assert!(parse_completed(&json!({ "method": "account/updated", "params": {} }), "L1").is_none());
        assert!(parse_completed(&json!({ "id": 3, "result": {} }), "L1").is_none());
    }
}
