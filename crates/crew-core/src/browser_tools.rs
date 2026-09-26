//! The browser tools, one function each: who is calling (their workspace and
//! a [`Holder`]) and the tool's arguments in, an array of MCP content blocks
//! out. As a [`ToolFamily`] they sit behind `find_tool`/`call_tool` for every
//! kind of caller.
//!
//! What is decided here: which tab a call is about, whether the caller may
//! touch it (its own workspace only), and the lease. What a tool does to the
//! page happens in Electron main, which this reaches through the relay.

use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use crew_protocol::BrowserPageRef;
use serde_json::{json, Value};

use crate::browser::{self, OpenPage};
use crate::browser_leases::{Holder, Leases};
use crate::browser_relay::{BrowserRelay, NO_HOST};
use crate::caller::Caller;
use crate::store::{now_millis, Store};
use crate::tools::{Audience, Tool, ToolFamily, ToolOutput};

/// Mounting a cold tab can take 15 s before the tool even starts.
const CALL_TIMEOUT: Duration = Duration::from_secs(35);
/// A mount, then up to 30 s for the page to load (main's `LOAD_WAIT_MS`).
const LOAD_TIMEOUT: Duration = Duration::from_secs(55);
/// `browser_wait_for` waits this long by default, and never longer than the cap.
const WAIT_DEFAULT_S: u64 = 10;
const WAIT_MAX_S: u64 = 50;
/// A tab `open_tab` made is known before the window has saved its strip.
const OPENED_GRACE_MS: i64 = 30_000;

/// Said to a caller without full autonomy. It runs whatever script it is
/// given, in pages that may be signed in with cookies imported from the
/// user's own browser; the rest of the tools only do what a person could.
pub const EVALUATE_NEEDS_FULL: &str = "browser_evaluate runs any script in the page, which may be signed in with the user's own accounts, so it is only for sessions with full autonomy. Ask the user to raise your autonomy to full if you need it; the other browser tools work as they are.";

/// How long crewd waits on the window for `tool`, or `None` when it is not a
/// browser tool. Whoever waits on crewd (the MCP shim, `crew call`) goes by
/// this too, plus a margin, so crewd's own answer, a timeout included, always
/// reaches them before they give up.
pub fn budget(tool: &str, args: &Value) -> Option<Duration> {
    match tool {
        "open_tab" | "browser_navigate" => Some(LOAD_TIMEOUT),
        "browser_wait_for" => Some(CALL_TIMEOUT + Duration::from_secs(wait_secs(args))),
        _ if is_browser_tool(tool) => Some(CALL_TIMEOUT),
        _ => None,
    }
}

fn wait_secs(args: &Value) -> u64 {
    args.get("timeout_s")
        .and_then(Value::as_u64)
        .unwrap_or(WAIT_DEFAULT_S)
        .clamp(1, WAIT_MAX_S)
}

fn tab_prop() -> Value {
    json!({ "type": "string", "description": "A tab id from list_tabs. Defaults to the last tab you used." })
}

fn with_tab(mut properties: Value, required: &[&str]) -> Value {
    properties["tab"] = tab_prop();
    json!({ "type": "object", "properties": properties, "required": required })
}

/// Every browser tool, for agents, terminals and the user alike. None is
/// core: a turn that never opens a page should not pay for sixteen schemas.
pub fn catalog() -> Vec<Tool> {
    [
        Tool {
            name: "list_tabs",
            description: "List the browser tabs in this workspace: id, title, URL, and who is using each one.",
            schema: json!({ "type": "object", "properties": {} }),
            keywords: &["browser", "tabs", "pages", "web"],
            core: false,
            audience: Audience::EVERYONE,
        },
        Tool {
            name: "open_tab",
            description: "Open a new browser tab in Crew at a URL. It shows in the user's tab strip and is yours to drive.",
            schema: json!({
                "type": "object",
                "properties": { "url": { "type": "string", "description": "http(s) URL." } },
                "required": ["url"]
            }),
            keywords: &["browser", "open", "new", "page", "web", "url", "visit"],
            core: false,
            audience: Audience::EVERYONE,
        },
        Tool {
            name: "claim_tab",
            description: "Take a browser tab so nobody else drives it while you do. Any browser tool takes it too; this is for holding it ahead of time.",
            schema: with_tab(json!({}), &["tab"]),
            keywords: &["browser", "lease", "lock", "take"],
            core: false,
            audience: Audience::EVERYONE,
        },
        Tool {
            name: "release_tab",
            description: "Let go of a browser tab you hold, so another agent can use it. Tabs you stop using free themselves after two minutes.",
            schema: with_tab(json!({}), &[]),
            keywords: &["browser", "lease", "free", "unlock"],
            core: false,
            audience: Audience::EVERYONE,
        },
        Tool {
            name: "browser_navigate",
            description: "Load a URL in the tab, or go back, forward, or reload.",
            schema: with_tab(
                json!({
                    "url": { "type": "string" },
                    "action": { "type": "string", "enum": ["back", "forward", "reload"] }
                }),
                &[],
            ),
            keywords: &["browser", "go", "url", "load", "back", "forward", "reload", "visit"],
            core: false,
            audience: Audience::EVERYONE,
        },
        Tool {
            name: "browser_snapshot",
            description: "Read the page as an accessibility tree: roles, names and values, with a uid on each element you can act on. Take one before clicking or filling; uids last until the next snapshot of the tab.",
            schema: with_tab(json!({}), &[]),
            keywords: &["browser", "page", "read", "dom", "elements", "accessibility", "see"],
            core: false,
            audience: Audience::EVERYONE,
        },
        Tool {
            name: "browser_click",
            description: "Click an element from the last snapshot.",
            schema: with_tab(json!({ "uid": { "type": "string" } }), &["uid"]),
            keywords: &["browser", "press", "button", "link", "tap"],
            core: false,
            audience: Audience::EVERYONE,
        },
        Tool {
            name: "browser_hover",
            description: "Move the mouse over an element from the last snapshot.",
            schema: with_tab(json!({ "uid": { "type": "string" } }), &["uid"]),
            keywords: &["browser", "mouse", "tooltip", "menu"],
            core: false,
            audience: Audience::EVERYONE,
        },
        Tool {
            name: "browser_fill",
            description: "Replace the value of a text field, text area or select from the last snapshot.",
            schema: with_tab(
                json!({ "uid": { "type": "string" }, "value": { "type": "string" } }),
                &["uid", "value"],
            ),
            keywords: &["browser", "input", "form", "field", "enter", "select", "write"],
            core: false,
            audience: Audience::EVERYONE,
        },
        Tool {
            name: "browser_type",
            description: "Type text into whatever has focus in the page, key by key.",
            schema: with_tab(json!({ "text": { "type": "string" } }), &["text"]),
            keywords: &["browser", "keyboard", "input", "write"],
            core: false,
            audience: Audience::EVERYONE,
        },
        Tool {
            name: "browser_press",
            description: "Press a key or a chord: Enter, Tab, Escape, ArrowDown, Backspace, Meta+A, Control+Shift+K.",
            schema: with_tab(json!({ "key": { "type": "string" } }), &["key"]),
            keywords: &["browser", "keyboard", "key", "shortcut", "enter", "escape"],
            core: false,
            audience: Audience::EVERYONE,
        },
        Tool {
            name: "browser_screenshot",
            description: "A PNG of the tab: what is in view, or the whole page.",
            schema: with_tab(json!({ "full_page": { "type": "boolean" } }), &[]),
            keywords: &["browser", "image", "picture", "capture", "see", "look"],
            core: false,
            audience: Audience::EVERYONE,
        },
        Tool {
            name: "browser_wait_for",
            description: "Wait until some text shows up in the page.",
            schema: with_tab(
                json!({
                    "text": { "type": "string" },
                    "timeout_s": { "type": "integer", "minimum": 1, "maximum": WAIT_MAX_S }
                }),
                &["text"],
            ),
            keywords: &["browser", "wait", "until", "appear", "load"],
            core: false,
            audience: Audience::EVERYONE,
        },
        Tool {
            name: "browser_console",
            description: "The tab's console messages and uncaught errors since you started driving it.",
            schema: with_tab(json!({}), &[]),
            keywords: &["browser", "log", "errors", "console", "debug"],
            core: false,
            audience: Audience::EVERYONE,
        },
        Tool {
            name: "browser_network",
            description: "The tab's network requests since you started driving it: method, status and URL.",
            schema: with_tab(json!({}), &[]),
            keywords: &["browser", "requests", "http", "fetch", "xhr", "api", "debug"],
            core: false,
            audience: Audience::EVERYONE,
        },
        Tool {
            name: "browser_evaluate",
            description: "Run a JavaScript expression in the page and get its value back as JSON. Promises are awaited.",
            schema: with_tab(json!({ "expression": { "type": "string" } }), &["expression"]),
            keywords: &["browser", "javascript", "js", "script", "run", "eval"],
            core: false,
            audience: Audience::EVERYONE,
        },
    ]
    .into()
}

pub fn is_browser_tool(name: &str) -> bool {
    catalog().iter().any(|tool| tool.name == name)
}

fn text(body: impl Into<String>) -> Value {
    json!([{ "type": "text", "text": body.into() }])
}

fn arg<'a>(args: &'a Value, name: &str) -> Option<&'a str> {
    args.get(name).and_then(Value::as_str).map(str::trim).filter(|s| !s.is_empty())
}

fn web_url(url: &str) -> bool {
    let lower = url.to_ascii_lowercase();
    lower.starts_with("http://") || lower.starts_with("https://")
}

#[derive(Clone)]
pub struct BrowserTools {
    store: Store,
    relay: BrowserRelay,
    leases: Leases,
    /// Tabs `open_tab` made, until the window's strip has them.
    opened: Arc<Mutex<HashMap<String, (OpenPage, i64)>>>,
}

impl BrowserTools {
    pub fn new(store: Store, relay: BrowserRelay, leases: Leases) -> Self {
        Self {
            store,
            relay,
            leases,
            opened: Arc::new(Mutex::new(HashMap::new())),
        }
    }

    pub fn relay(&self) -> &BrowserRelay {
        &self.relay
    }

    pub fn leases(&self) -> &Leases {
        &self.leases
    }

    /// Who a caller is to a tab's lease: a session by its id and name, or the user.
    pub fn holder(caller: &Caller) -> Holder {
        match caller.session() {
            Some(session) => Holder::session(&session.id, &session.name),
            None => Holder::user(),
        }
    }

    /// Any browser tool by name, for a gateway that dispatches on it.
    pub fn call(&self, workspace_id: &str, holder: &Holder, tool: &str, args: &Value) -> Result<Value, String> {
        match tool {
            "list_tabs" => self.list_tabs(workspace_id, holder, args),
            "open_tab" => self.open_tab(workspace_id, holder, args),
            "claim_tab" => self.claim_tab(workspace_id, holder, args),
            "release_tab" => self.release_tab(workspace_id, holder, args),
            "browser_navigate" => self.navigate(workspace_id, holder, args),
            "browser_wait_for" => self.wait_for(workspace_id, holder, args),
            "browser_snapshot" | "browser_click" | "browser_hover" | "browser_fill" | "browser_type"
            | "browser_press" | "browser_screenshot" | "browser_console" | "browser_network"
            | "browser_evaluate" => self.drive(workspace_id, holder, tool, args),
            _ => Err(format!("Unknown browser tool \"{tool}\"")),
        }
    }

    pub fn list_tabs(&self, workspace_id: &str, holder: &Holder, _args: &Value) -> Result<Value, String> {
        let now = now_millis();
        let pages = self.pages_of(workspace_id, now)?;
        if pages.is_empty() {
            return Ok(text("No browser tabs in this workspace. open_tab makes one."));
        }
        let default = self.leases.last_tab(&holder.key);
        let lines: Vec<String> = pages
            .iter()
            .map(|page| {
                let title = if page.title.is_empty() { "(untitled)" } else { page.title.as_str() };
                let url = if page.url.is_empty() { "about:blank" } else { page.url.as_str() };
                let who = match self.leases.holder_of(&page.page_id, now) {
                    Some(lease) if lease.session_id.as_deref() == holder.session_id.as_deref()
                        && lease.holder == holder.label =>
                    {
                        format!("yours for ~{} s", secs(lease.until - now))
                    }
                    Some(lease) => format!("in use by {}, free in ~{} s", lease.holder, secs(lease.until - now)),
                    None => "free".into(),
                };
                let mark = if default.as_deref() == Some(page.page_id.as_str()) { " (default)" } else { "" };
                format!("{}{mark}  \"{title}\"  {url}  [{who}]", page.page_id)
            })
            .collect();
        Ok(text(lines.join("\n")))
    }

    pub fn open_tab(&self, workspace_id: &str, holder: &Holder, args: &Value) -> Result<Value, String> {
        let url = arg(args, "url").ok_or("url is required")?;
        if !web_url(url) {
            return Err(format!("Only http(s) pages open in Crew's browser, not {url}"));
        }
        let now = now_millis();
        let tab = format!("browser:{}", uuid::Uuid::new_v4());
        let page = OpenPage {
            page_id: tab.clone(),
            context: workspace_id.to_string(),
            workspace_id: workspace_id.to_string(),
            url: url.to_string(),
            title: String::new(),
        };
        // Taken before it exists, so the window pins it from the first moment.
        self.leases.claim(&tab, workspace_id, holder, now)?;
        self.opened().insert(tab.clone(), (page.clone(), now));
        match self.relay.call(&tab, "open_tab", json!({ "url": url }), Some(page_ref(&page)), LOAD_TIMEOUT) {
            Ok(out) => Ok(out),
            // No window heard of it, so there is no tab.
            Err(error) if error == NO_HOST => {
                self.tab_closed(&tab);
                Err(error)
            }
            // The window may have made the tab anyway, or be making it still:
            // it stays the caller's, and is named, so no tab is left open that
            // the agent never heard of.
            Err(error) => Err(format!(
                "{error} The tab is {tab} and it is yours; it may still come up: list_tabs shows whether it did."
            )),
        }
    }

    /// The window closed `tab`: its lease goes, nobody's calls default to it
    /// any more, and a tab `open_tab` made is no longer taken on trust, so
    /// the agent's next call does not bring it back.
    pub fn tab_closed(&self, tab: &str) {
        self.opened().remove(tab);
        self.leases.forget_tab(tab, now_millis());
    }

    pub fn claim_tab(&self, workspace_id: &str, holder: &Holder, args: &Value) -> Result<Value, String> {
        if arg(args, "tab").is_none() {
            return Err("tab is required: list_tabs shows this workspace's tabs".into());
        }
        self.drive(workspace_id, holder, "claim_tab", args)
    }

    pub fn release_tab(&self, workspace_id: &str, holder: &Holder, args: &Value) -> Result<Value, String> {
        let tab = self.tab_for(holder, args)?;
        self.page(workspace_id, &tab, now_millis())?;
        if self.leases.release(&tab, holder, now_millis()) {
            Ok(text(format!("Released {tab}.")))
        } else {
            Ok(text(format!("You were not holding {tab}.")))
        }
    }

    pub fn navigate(&self, workspace_id: &str, holder: &Holder, args: &Value) -> Result<Value, String> {
        match (arg(args, "url"), arg(args, "action")) {
            (Some(url), _) if !web_url(url) => Err(format!("Only http(s) pages open in Crew's browser, not {url}")),
            (Some(_), _) | (None, Some("back" | "forward" | "reload")) => {
                self.drive(workspace_id, holder, "browser_navigate", args)
            }
            (None, Some(other)) => Err(format!("action is back, forward or reload, not {other}")),
            (None, None) => Err("Give a url, or an action: back, forward or reload".into()),
        }
    }

    pub fn wait_for(&self, workspace_id: &str, holder: &Holder, args: &Value) -> Result<Value, String> {
        if arg(args, "text").is_none() {
            return Err("text is required".into());
        }
        let mut args = args.clone();
        args["timeout_s"] = json!(wait_secs(&args));
        self.drive(workspace_id, holder, "browser_wait_for", &args)
    }

    pub fn snapshot(&self, workspace_id: &str, holder: &Holder, args: &Value) -> Result<Value, String> {
        self.drive(workspace_id, holder, "browser_snapshot", args)
    }

    pub fn click(&self, workspace_id: &str, holder: &Holder, args: &Value) -> Result<Value, String> {
        self.drive(workspace_id, holder, "browser_click", args)
    }

    pub fn hover(&self, workspace_id: &str, holder: &Holder, args: &Value) -> Result<Value, String> {
        self.drive(workspace_id, holder, "browser_hover", args)
    }

    pub fn fill(&self, workspace_id: &str, holder: &Holder, args: &Value) -> Result<Value, String> {
        self.drive(workspace_id, holder, "browser_fill", args)
    }

    pub fn type_text(&self, workspace_id: &str, holder: &Holder, args: &Value) -> Result<Value, String> {
        self.drive(workspace_id, holder, "browser_type", args)
    }

    pub fn press(&self, workspace_id: &str, holder: &Holder, args: &Value) -> Result<Value, String> {
        self.drive(workspace_id, holder, "browser_press", args)
    }

    pub fn screenshot(&self, workspace_id: &str, holder: &Holder, args: &Value) -> Result<Value, String> {
        self.drive(workspace_id, holder, "browser_screenshot", args)
    }

    pub fn console(&self, workspace_id: &str, holder: &Holder, args: &Value) -> Result<Value, String> {
        self.drive(workspace_id, holder, "browser_console", args)
    }

    pub fn network(&self, workspace_id: &str, holder: &Holder, args: &Value) -> Result<Value, String> {
        self.drive(workspace_id, holder, "browser_network", args)
    }

    pub fn evaluate(&self, workspace_id: &str, holder: &Holder, args: &Value) -> Result<Value, String> {
        self.drive(workspace_id, holder, "browser_evaluate", args)
    }

    /// Resolves the tab, checks it is the caller's to touch, takes or renews
    /// the lease, and hands the call to the window for as long as its budget.
    fn drive(&self, workspace_id: &str, holder: &Holder, tool: &str, args: &Value) -> Result<Value, String> {
        let now = now_millis();
        let tab = self.tab_for(holder, args)?;
        let page = self.page(workspace_id, &tab, now)?;
        self.leases.claim(&tab, workspace_id, holder, now)?;
        let timeout = budget(tool, args).unwrap_or(CALL_TIMEOUT);
        self.relay.call(&tab, tool, args.clone(), Some(page_ref(&page)), timeout)
    }

    fn tab_for(&self, holder: &Holder, args: &Value) -> Result<String, String> {
        arg(args, "tab")
            .map(str::to_string)
            .or_else(|| self.leases.last_tab(&holder.key))
            .ok_or_else(|| "Name a tab: list_tabs shows this workspace's tabs, and open_tab makes one.".into())
    }

    /// The page, if it is in the caller's workspace. A page elsewhere reads the
    /// same as one that does not exist: its URL is none of this caller's business.
    fn page(&self, workspace_id: &str, tab: &str, now: i64) -> Result<OpenPage, String> {
        let found = match browser::find_page(&self.store, tab)? {
            // The strip has it now, and is the word on it from here: once the
            // user closes it there, it is gone.
            Some(page) => {
                self.opened().remove(tab);
                Some(page)
            }
            None => self.fresh_opened(now).remove(tab),
        };
        match found {
            Some(page) if page.workspace_id == workspace_id => Ok(page),
            _ => Err(format!("There is no tab {tab} in this workspace. list_tabs shows the ones there are.")),
        }
    }

    fn pages_of(&self, workspace_id: &str, now: i64) -> Result<Vec<OpenPage>, String> {
        let mut pages = browser::workspace_pages(&self.store, workspace_id)?;
        self.opened().retain(|id, _| !pages.iter().any(|known| &known.page_id == id));
        for (id, page) in self.fresh_opened(now) {
            if page.workspace_id == workspace_id && !pages.iter().any(|known| known.page_id == id) {
                pages.push(page);
            }
        }
        Ok(pages)
    }

    /// The tabs `open_tab` made recently enough that the window may not have
    /// saved them yet; older ones are dropped, since a strip that still lacks
    /// them has closed them.
    fn fresh_opened(&self, now: i64) -> HashMap<String, OpenPage> {
        let mut opened = self.opened();
        opened.retain(|_, (_, at)| now - *at < OPENED_GRACE_MS);
        opened.iter().map(|(id, (page, _))| (id.clone(), page.clone())).collect()
    }

    fn opened(&self) -> std::sync::MutexGuard<'_, HashMap<String, (OpenPage, i64)>> {
        self.opened.lock().unwrap_or_else(|e| e.into_inner())
    }
}

impl ToolFamily for BrowserTools {
    fn catalog(&self) -> Vec<Tool> {
        catalog()
    }

    /// Scoped to the caller's workspace; the answer goes out as the blocks
    /// the page gave, so a screenshot reaches the model as an image.
    fn run(&self, caller: &Caller, name: &str, args: &Value) -> Result<ToolOutput, String> {
        // Navigating and opening tabs stay open to everyone: they go where a
        // person could click to, while a script reads and does anything the
        // signed-in page can.
        if name == "browser_evaluate" && !caller.full_autonomy() {
            return Err(EVALUATE_NEEDS_FULL.into());
        }
        let workspace_id = caller.workspace_id()?;
        let out = self.call(workspace_id, &Self::holder(caller), name, args)?;
        Ok(ToolOutput::Content(match out {
            Value::Array(blocks) => blocks,
            other => vec![json!({ "type": "text", "text": other.to_string() })],
        }))
    }
}

fn page_ref(page: &OpenPage) -> BrowserPageRef {
    BrowserPageRef {
        context: page.context.clone(),
        url: page.url.clone(),
        title: page.title.clone(),
    }
}

fn secs(ms: i64) -> i64 {
    (ms.max(0) + 999) / 1000
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::mpsc;
    use std::thread;

    fn store() -> Store {
        let dir = std::env::temp_dir().join(format!("crew-browser-tools-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).expect("dir");
        Store::open(dir.join("crew.sqlite3")).expect("store")
    }

    fn strip(store: &Store, context: &str, ids: &[&str]) {
        let tabs: Vec<Value> = ids
            .iter()
            .map(|id| json!({ "id": id, "kind": "browser", "url": "http://localhost:5173/", "title": "App" }))
            .collect();
        crate::store::set(store, format!("tabs:{context}"), json!({ "tabs": tabs, "activeId": null }).to_string())
            .expect("strip");
    }

    /// Tools over a relay whose host answers every call with the tool's name,
    /// and a log of the calls it saw.
    fn tools(store: Store) -> (BrowserTools, mpsc::Receiver<Value>) {
        answering(store, |payload| Ok(json!([{ "type": "text", "text": payload["tool"] }])))
    }

    /// Tools over a relay whose host answers every call with `outcome`.
    fn answering(
        store: Store,
        outcome: impl Fn(&Value) -> Result<Value, String> + Send + Sync + 'static,
    ) -> (BrowserTools, mpsc::Receiver<Value>) {
        let relay = BrowserRelay::new();
        let (seen_tx, seen) = mpsc::channel();
        let answer = relay.clone();
        let seen_tx = Mutex::new(seen_tx);
        let outcome = Arc::new(outcome);
        relay.set_sender(Arc::new(move |client, _event, payload| {
            let _ = seen_tx.lock().unwrap().send(payload.clone());
            let answer = answer.clone();
            let outcome = outcome.clone();
            thread::spawn(move || {
                let id = payload["callId"].as_u64().unwrap();
                answer.resolve(client, id, outcome(&payload)).unwrap();
            });
            true
        }));
        relay.register_host(1);
        (BrowserTools::new(store, relay, Leases::new()), seen)
    }

    fn session(workspace_id: &str, autonomy: &str) -> Caller {
        Caller::Agent(crate::session::Session {
            id: format!("s-{autonomy}"),
            workspace_id: workspace_id.into(),
            kind: "agent".into(),
            name: "Ada".into(),
            provider: "claude".into(),
            model: String::new(),
            provider_session_id: None,
            description: String::new(),
            notifications: false,
            autonomy: autonomy.into(),
            status: "idle".into(),
            worktree: None,
            created_at: 0,
            updated_at: 0,
        })
    }

    fn body(out: &Value) -> &str {
        out[0]["text"].as_str().unwrap_or_default()
    }

    #[test]
    fn a_caller_drives_only_its_own_workspace_tabs() {
        let store = store();
        strip(&store, "w1", &["browser:mine"]);
        strip(&store, "w2", &["browser:theirs"]);
        let (tools, _) = tools(store);
        let ada = Holder::session("s-ada", "Ada");
        let out = tools.snapshot("w1", &ada, &json!({ "tab": "browser:mine" })).expect("own tab");
        assert_eq!(body(&out), "browser_snapshot");
        let error = tools.snapshot("w1", &ada, &json!({ "tab": "browser:theirs" })).expect_err("elsewhere");
        assert!(error.contains("no tab browser:theirs in this workspace"), "{error}");
    }

    #[test]
    fn a_worktree_strip_belongs_to_its_workspace() {
        let store = store();
        strip(&store, "w1@/tmp/feat", &["browser:tree"]);
        let (tools, seen) = tools(store);
        tools.snapshot("w1", &Holder::user(), &json!({ "tab": "browser:tree" })).expect("same workspace");
        assert_eq!(seen.recv().unwrap()["page"]["context"], "w1@/tmp/feat");
    }

    #[test]
    fn the_last_tab_used_is_the_default() {
        let store = store();
        strip(&store, "w1", &["browser:a", "browser:b"]);
        let (tools, seen) = tools(store);
        let ada = Holder::session("s-ada", "Ada");
        assert!(tools.snapshot("w1", &ada, &json!({})).expect_err("no tab yet").contains("list_tabs"));
        tools.snapshot("w1", &ada, &json!({ "tab": "browser:b" })).expect("b");
        tools.click("w1", &ada, &json!({ "uid": "1_2" })).expect("defaults to b");
        let calls: Vec<Value> = seen.try_iter().collect();
        assert_eq!(calls[1]["tab"], "browser:b");
        assert_eq!(calls[1]["tool"], "browser_click");
    }

    #[test]
    fn a_tab_in_use_is_refused_until_released() {
        let store = store();
        strip(&store, "w1", &["browser:a"]);
        let (tools, _) = tools(store);
        let ada = Holder::session("s-ada", "Ada");
        let bob = Holder::session("s-bob", "Bob");
        tools.snapshot("w1", &ada, &json!({ "tab": "browser:a" })).expect("ada takes it");
        let error = tools.snapshot("w1", &bob, &json!({ "tab": "browser:a" })).expect_err("taken");
        assert!(error.starts_with("Tab browser:a is in use by Ada"), "{error}");
        let listed = tools.list_tabs("w1", &bob, &json!({})).expect("list");
        assert!(body(&listed).contains("in use by Ada"), "{}", body(&listed));
        tools.release_tab("w1", &ada, &json!({})).expect("release the default");
        tools.snapshot("w1", &bob, &json!({ "tab": "browser:a" })).expect("free now");
    }

    #[test]
    fn open_tab_is_known_before_the_window_saves_it() {
        let (tools, seen) = tools(store());
        let ada = Holder::session("s-ada", "Ada");
        assert!(tools.open_tab("w1", &ada, &json!({ "url": "file:///etc/passwd" })).is_err());
        tools.open_tab("w1", &ada, &json!({ "url": "http://localhost:3000/" })).expect("opened");
        let opened = seen.recv().unwrap();
        assert_eq!(opened["tool"], "open_tab");
        assert_eq!(opened["page"]["context"], "w1");
        let tab = opened["tab"].as_str().unwrap().to_string();
        // The next call needs no tab: the new one is the default, and it is found.
        tools.snapshot("w1", &ada, &json!({})).expect("drives the new tab");
        assert_eq!(seen.recv().unwrap()["tab"], tab.as_str());
        assert!(body(&tools.list_tabs("w1", &ada, &json!({})).unwrap()).contains(&tab));
        // Not from another workspace.
        assert!(tools.snapshot("w2", &ada, &json!({ "tab": tab })).is_err());
    }

    /// A tab the window may have made is never left open without the agent
    /// knowing its id: the error names it, and it stays the agent's.
    #[test]
    fn an_open_tab_that_fails_in_the_window_still_names_the_tab() {
        let (tools, seen) = answering(store(), |_| Err("Tab did not come up within 15 s; try again.".into()));
        let ada = Holder::session("s-ada", "Ada");
        let error = tools.open_tab("w1", &ada, &json!({ "url": "http://localhost:3000/" })).expect_err("failed");
        let tab = seen.recv().unwrap()["tab"].as_str().unwrap().to_string();
        assert!(error.contains(&format!("The tab is {tab}")), "{error}");
        assert!(body(&tools.list_tabs("w1", &ada, &json!({})).unwrap()).contains(&tab));
        assert_eq!(tools.leases().last_tab("s-ada"), Some(tab));
    }

    #[test]
    fn an_open_tab_no_window_heard_of_is_forgotten() {
        let tools = BrowserTools::new(store(), BrowserRelay::new(), Leases::new());
        let ada = Holder::session("s-ada", "Ada");
        let error = tools.open_tab("w1", &ada, &json!({ "url": "http://localhost:3000/" })).expect_err("no host");
        assert_eq!(error, crate::browser_relay::NO_HOST);
        assert!(body(&tools.list_tabs("w1", &ada, &json!({})).unwrap()).starts_with("No browser tabs"));
        assert_eq!(tools.leases().last_tab("s-ada"), None);
    }

    /// The user closing a tab the agent opened a moment ago is final: the
    /// agent's next call, with or without the tab's id, does not bring it back.
    #[test]
    fn a_tab_the_user_closed_does_not_come_back() {
        let store = store();
        let (tools, seen) = tools(store.clone());
        let ada = Holder::session("s-ada", "Ada");
        tools.open_tab("w1", &ada, &json!({ "url": "http://localhost:3000/" })).expect("opened");
        let tab = seen.recv().unwrap()["tab"].as_str().unwrap().to_string();
        tools.tab_closed(&tab);
        assert!(tools.snapshot("w1", &ada, &json!({})).expect_err("no default").contains("Name a tab"));
        assert!(tools.snapshot("w1", &ada, &json!({ "tab": tab })).expect_err("closed").contains("no tab"));
        assert!(tools.leases().list(now_millis()).leases.is_empty());

        // Closed in a strip that had it, before any notice arrived: the strip says so.
        tools.open_tab("w1", &ada, &json!({ "url": "http://localhost:3000/" })).expect("opened");
        let tab = seen.recv().unwrap()["tab"].as_str().unwrap().to_string();
        strip(&store, "w1", &[&tab]);
        tools.snapshot("w1", &ada, &json!({})).expect("in the strip");
        strip(&store, "w1", &[]);
        assert!(tools.snapshot("w1", &ada, &json!({ "tab": tab })).expect_err("closed").contains("no tab"));
    }

    #[test]
    fn evaluate_needs_full_autonomy_and_the_rest_do_not() {
        let store = store();
        strip(&store, "w1", &["browser:a"]);
        let (tools, _) = tools(store);
        let ask = session("w1", "ask");
        let run = |caller: &Caller, name: &str, args: Value| ToolFamily::run(&tools, caller, name, &args).map(|_| ());
        let error = run(&ask, "browser_evaluate", json!({ "tab": "browser:a", "expression": "document.cookie" }))
            .expect_err("ask");
        assert_eq!(error, EVALUATE_NEEDS_FULL);
        run(&ask, "browser_navigate", json!({ "tab": "browser:a", "url": "https://example.com" })).expect("navigates");
        run(&ask, "open_tab", json!({ "url": "https://example.com" })).expect("opens");
        tools.leases().release_all("s-ask", now_millis());
        run(&session("w1", "full"), "browser_evaluate", json!({ "tab": "browser:a", "expression": "1" }))
            .expect("full autonomy");
        tools.leases().release_all("s-full", now_millis());
        let me = Caller::User { workspace_id: Some("w1".into()) };
        run(&me, "browser_evaluate", json!({ "tab": "browser:a", "expression": "1" })).expect("the user");
    }

    /// The window may take a mount and a page load on one call; crewd waits
    /// longer than that, and the wait a model asked for on top.
    #[test]
    fn every_browser_tool_has_a_budget_that_covers_the_window() {
        let mount_and_load = Duration::from_secs(15 + 30);
        assert!(budget("open_tab", &json!({})).unwrap() > mount_and_load);
        assert!(budget("browser_navigate", &json!({})).unwrap() > mount_and_load);
        assert_eq!(budget("browser_wait_for", &json!({ "timeout_s": 50 })), Some(Duration::from_secs(85)));
        assert_eq!(budget("browser_wait_for", &json!({ "timeout_s": 900 })), Some(Duration::from_secs(85)));
        assert!(catalog().iter().all(|tool| budget(tool.name, &json!({})).is_some()));
        assert_eq!(budget("wait_for_log", &json!({ "timeout_s": 5 })), None);
    }

    #[test]
    fn without_the_window_the_call_says_to_open_crew() {
        let store = store();
        strip(&store, "w1", &["browser:a"]);
        let tools = BrowserTools::new(store, BrowserRelay::new(), Leases::new());
        let error = tools.snapshot("w1", &Holder::user(), &json!({ "tab": "browser:a" })).expect_err("no host");
        assert_eq!(error, crate::browser_relay::NO_HOST);
    }

    #[test]
    fn navigate_takes_a_web_url_or_a_history_step() {
        let store = store();
        strip(&store, "w1", &["browser:a"]);
        let (tools, _) = tools(store);
        let me = Holder::user();
        assert!(tools.navigate("w1", &me, &json!({ "tab": "browser:a", "url": "javascript:alert(1)" })).is_err());
        assert!(tools.navigate("w1", &me, &json!({ "tab": "browser:a", "action": "sideways" })).is_err());
        assert!(tools.navigate("w1", &me, &json!({ "tab": "browser:a", "action": "back" })).is_ok());
        assert!(tools.navigate("w1", &me, &json!({ "tab": "browser:a", "url": "https://example.com" })).is_ok());
    }

    #[test]
    fn every_tool_in_the_catalog_dispatches() {
        let store = store();
        strip(&store, "w1", &["browser:a"]);
        let (tools, _) = tools(store);
        let me = Holder::user();
        for spec in catalog() {
            let args = json!({ "tab": "browser:a", "url": "https://example.com", "text": "x", "uid": "1_1",
                "value": "v", "key": "Enter", "expression": "1" });
            let out = tools.call("w1", &me, spec.name, &args);
            assert!(out.is_ok(), "{}: {out:?}", spec.name);
        }
        assert!(tools.call("w1", &me, "browser_teleport", &json!({})).is_err());
    }

    #[test]
    fn the_family_lists_every_browser_tool_for_everyone_and_none_as_core() {
        let (tools, _) = tools(store());
        let names: Vec<&str> = ToolFamily::catalog(&tools).iter().map(|tool| tool.name).collect();
        assert_eq!(
            names,
            [
                "list_tabs", "open_tab", "claim_tab", "release_tab", "browser_navigate", "browser_snapshot",
                "browser_click", "browser_hover", "browser_fill", "browser_type", "browser_press",
                "browser_screenshot", "browser_wait_for", "browser_console", "browser_network", "browser_evaluate",
            ]
        );
        assert!(catalog().iter().all(|tool| !tool.core && tool.audience == Audience::EVERYONE));
    }

    #[test]
    fn the_user_without_a_workspace_is_told_to_name_one() {
        let (tools, _) = tools(store());
        let error = ToolFamily::run(&tools, &Caller::User { workspace_id: None }, "list_tabs", &json!({}))
            .err()
            .expect("no workspace");
        assert!(error.starts_with("No workspace"), "{error}");
    }

    #[test]
    fn a_screenshot_goes_out_as_an_image_block_not_as_text() {
        let store = store();
        strip(&store, "w1", &["browser:a"]);
        let relay = BrowserRelay::new();
        let answer = relay.clone();
        relay.set_sender(Arc::new(move |client, _event, payload| {
            let answer = answer.clone();
            thread::spawn(move || {
                let id = payload["callId"].as_u64().unwrap();
                let image = json!([{ "type": "image", "data": "iVBORw0KGgo=", "mimeType": "image/png" }]);
                answer.resolve(client, id, Ok(image)).unwrap();
            });
            true
        }));
        relay.register_host(1);
        let family = BrowserTools::new(store.clone(), relay, Leases::new());
        let toolbox = crate::tools::Toolbox::default();
        toolbox.register(Arc::new(family));
        let transcripts = crate::transcript::TranscriptHub::new(store.clone());
        let deliver = |_: &crate::session::Session| false;
        let host = crate::tools::Host {
            store: &store,
            transcripts: &transcripts,
            on_created: &|_| {},
            on_routines: &|| {},
            deliver: &deliver,
            toolbox: &toolbox,
        };
        let me = Caller::User { workspace_id: Some("w1".into()) };
        let call = json!({ "name": "call_tool", "arguments": { "name": "browser_screenshot", "arguments": { "tab": "browser:a" } } });
        let out = crate::tools::handle(&host, &me, "tools/call", call).expect("call");
        assert_eq!(out["content"], json!([{ "type": "image", "data": "iVBORw0KGgo=", "mimeType": "image/png" }]));
        assert!(out.get("isError").is_none());
    }
}
