use super::*;

// As Claude Code 2.1.310 answers `mcp_status` (trimmed: two tools each, the
// server infos cut, an API key's value replaced).
const CLAUDE_STATUS: &str = r#"[
  {"name":"context7","status":"connected","serverInfo":{"name":"Context7","version":"4.4.3"},
   "config":{"type":"http","url":"https://mcp.context7.com/mcp","headers":{"CONTEXT7_API_KEY":"ctx7sk-secret"}},
   "transport":"http","urlHost":"mcp.context7.com","scope":"user","source":"user",
   "tools":[{"name":"resolve-library-id","annotations":{}},{"name":"query-docs","annotations":{}}]},
  {"name":"chrome-devtools","status":"connected","serverInfo":{"name":"chrome_devtools","version":"1.12.0"},
   "config":{"type":"stdio","command":"npx","args":["chrome-devtools-mcp@latest","--browserUrl","http://127.0.0.1:9222"],"env":{"TOKEN":"env-secret"}},
   "transport":"stdio","scope":"user","source":"user","tools":[{"name":"click"},{"name":"drag"}]},
  {"name":"spendo","status":"disabled","config":{"type":"http","url":"https://spendo.example/api/mcp"},
   "transport":"http","scope":"local","source":"local","tools":[]},
  {"name":"claude.ai Notion","status":"connected","serverInfo":{"name":"Notion MCP","version":"1.0.0"},
   "config":{"type":"claudeai-proxy","url":"https://mcp.notion.com/mcp","id":"mcpsrv_01"},
   "transport":"claudeai-proxy","sessionProxied":true,"scope":"claudeai","source":"claudeai","tools":[{"name":"notion-search"}]},
  {"name":"plugin:figma:figma","status":"needs-auth","config":{"type":"http","url":"https://mcp.figma.com/mcp"},
   "scope":"dynamic","tools":[]},
  {"name":"broken","status":"failed","error":"spawn npx ENOENT\nat line 2","config":{"type":"stdio","command":"npx","args":["-y","x"]},"scope":"project"}
]"#;

// As Codex 0.163.0 answers `codex mcp list --json` (secrets replaced).
const CODEX_LIST: &str = r#"[
  {"name":"chrome-devtools","enabled":true,"disabled_reason":null,
   "transport":{"type":"stdio","command":"npx","args":["chrome-devtools-mcp@latest"],"env":{"KEY":"env-secret"},"env_vars":[],"cwd":null},
   "startup_timeout_sec":120.0,"tool_timeout_sec":null,"auth_status":"unsupported"},
  {"name":"computer-use","enabled":false,"disabled_reason":null,
   "transport":{"type":"stdio","command":"./Codex Computer Use.app/Contents/MacOS/Client","args":["mcp"],"env":null,"env_vars":[],"cwd":"."},
   "startup_timeout_sec":null,"tool_timeout_sec":null,"auth_status":"unsupported"},
  {"name":"codex_app","enabled":false,
   "transport":{"type":"stdio","command":"/Users/me/.codex/plugins/cache/openai-bundled/codex-app-tools/0.1.4/scripts/launch","args":["./server.mjs"],"env":{},"cwd":"/Users/me/.codex/plugins/cache/openai-bundled/codex-app-tools/0.1.4"},
   "auth_status":"unsupported"},
  {"name":"node_repl","enabled":true,
   "transport":{"type":"stdio","command":"/Applications/ChatGPT.app/Contents/Resources/cua_node/bin/node_repl","args":[],"env":{"K":"env-secret"},"cwd":null},
   "auth_status":"unsupported"},
  {"name":"context7","enabled":true,"disabled_reason":null,
   "transport":{"type":"streamable_http","url":"https://mcp.context7.com/mcp","bearer_token_env_var":null,"http_headers":{"CONTEXT7_API_KEY":"header-secret"}},
   "auth_status":"not_logged_in"},
  {"name":"figma","enabled":true,"disabled_reason":null,
   "transport":{"type":"streamable_http","url":"https://mcp.figma.com/mcp","http_headers":null},"auth_status":"o_auth"},
  {"name":"linear","enabled":true,"transport":{"type":"streamable_http","url":"https://mcp.linear.app/mcp"},"auth_status":"not_logged_in"}
]"#;

// As its app-server answers `mcpServerStatus/list {detail: toolsAndAuthOnly}`,
// with no thread: no runtime status, so whether a server gave its tools.
const CODEX_STATUS: &str = r#"{"data":[
  {"name":"chrome-devtools","runtimeStatus":null,"pluginId":null,"serverInfo":{"name":"chrome_devtools"},
   "tools":{"click":{},"drag":{},"fill":{}},"toolsError":null,"authStatus":"unsupported"},
  {"name":"codex_apps","runtimeStatus":null,"serverInfo":{"name":"plugin-runtime"},"tools":{"a":{}},"authStatus":"bearerToken"},
  {"name":"computer-use","runtimeStatus":null,"serverInfo":null,"tools":{},"authStatus":"unsupported"},
  {"name":"context7","runtimeStatus":null,"serverInfo":{"name":"Context7"},"tools":{"q":{},"r":{}},"authStatus":"notLoggedIn"},
  {"name":"figma","runtimeStatus":null,"pluginId":"figma@openai-curated","serverInfo":null,"tools":{},"toolsError":"401 Unauthorized","authStatus":"oAuth"},
  {"name":"linear","runtimeStatus":null,"serverInfo":null,"tools":{},"toolsError":null,"authStatus":"notLoggedIn"}
],"nextCursor":null}"#;

// As opencode 2.1.2 answers `opencode api GET /api/config` (one document,
// the old format normalised to `servers`) and `GET /api/mcp`.
const OPENCODE_CONFIG: &str = r#"[
  {"type":"document","path":"/Users/me/.config/opencode/opencode.json","info":{"$schema":"https://opencode.ai/config.json","mcp":{"servers":{
    "jira":{"type":"remote","url":"https://mcp.atlassian.com/v1/mcp","oauth":{},"headers":{"Authorization":"Bearer header-secret"}},
    "playwright":{"type":"local","command":["npx","@playwright/mcp@latest"],"disabled":false,"environment":{"KEY":"env-secret"}},
    "old":{"type":"local","command":["true"],"disabled":true}
  }}}},
  {"type":"directory","path":"/Users/me/.config/opencode"},
  {"type":"document","path":"/Users/me/repo/opencode.json","info":{"mcp":{"servers":{"repo-tool":{"type":"local","command":["./tool"]}}}}}
]"#;
const OPENCODE_MCP: &str = r#"{"location":{"directory":"/Users/me"},"data":[
  {"name":"jira","status":{"status":"needs_auth","error":"MCP server requires a login"},"integrationID":"mcp_10b5"},
  {"name":"playwright","status":{"status":"connected"}},
  {"name":"old","status":{"status":"disabled"}},
  {"name":"repo-tool","status":{"status":"failed","error":"Connection closed: exited with code 1"}}
]}"#;

// As cursor-agent 2026.10.19 prints `mcp list`, each status as its code writes it.
const CURSOR_LIST: &str = "context7: ready\nfigma: requires_authentication\nslow: loading\noff: disabled\nnew: not loaded (needs approval)\nbad: Error: Connection failed\n";
const CURSOR_CONFIG: &str = r#"{"mcpServers":{
  "context7":{"url":"https://mcp.context7.com/mcp","headers":{"CONTEXT7_API_KEY":"header-secret"}},
  "figma":{"url":"https://mcp.figma.com/mcp"},
  "off":{"command":"npx","args":["-y","off-mcp"],"env":{"KEY":"env-secret"}}
}}"#;

// As grok 1.0.70 answers `mcp list --json`.
const GROK_LIST: &str = r#"[
  {"url":"https://example.com/mcp","headers":{"Authorization":"Bearer header-secret"},"enabled":true,"name":"webby","scope":"project"},
  {"command":"npx","args":["-y","some-mcp","--flag"],"env":{"SECRET":"env-secret"},"enabled":false,"name":"locy","scope":"user"}
]"#;

fn value(text: &str) -> Value {
    serde_json::from_str(text).expect("fixture")
}

fn named<'a>(servers: &'a [ProviderServer], name: &str) -> &'a ProviderServer {
    servers.iter().find(|s| s.name == name).unwrap_or_else(|| panic!("no {name} in {servers:?}"))
}

/// Nothing a server's config keeps as a secret reaches a row.
fn no_secrets(servers: &[ProviderServer]) {
    let text = serde_json::to_string(servers).unwrap();
    for secret in ["secret", "CONTEXT7_API_KEY", "Authorization", "TOKEN"] {
        assert!(!text.contains(secret), "{secret} reached a row: {text}");
    }
}

#[test]
fn claudes_servers_are_read_with_their_scope_transport_and_tools() {
    let servers = parse_claude(&value(CLAUDE_STATUS));
    assert_eq!(servers.len(), 6);
    no_secrets(&servers);
    let context7 = named(&servers, "context7");
    assert_eq!(
        (context7.transport.as_str(), context7.target.as_str(), context7.scope.as_deref()),
        ("http", "https://mcp.context7.com/mcp", Some("user"))
    );
    assert_eq!((context7.state, context7.tools, context7.can_sign_in), (McpState::Connected, Some(2), true));
    let chrome = named(&servers, "chrome-devtools");
    assert_eq!(chrome.target, "npx chrome-devtools-mcp@latest --browserUrl http://127.0.0.1:9222");
    assert!(!chrome.can_sign_in, "a stdio server has no sign-in");
    let notion = named(&servers, "claude.ai Notion");
    assert_eq!((notion.transport.as_str(), notion.scope.as_deref()), ("claude.ai", Some("claude.ai")));
    assert!(!notion.can_sign_in, "claude.ai's connectors are signed in at claude.ai");
    let figma = named(&servers, "plugin:figma:figma");
    assert_eq!((figma.scope.as_deref(), figma.state, figma.tools), (Some("plugin"), McpState::NeedsAuth, None));
    assert!(figma.can_sign_in);
    assert_eq!(named(&servers, "spendo").state, McpState::Disabled);
    let broken = named(&servers, "broken");
    assert_eq!((broken.state, broken.error.as_deref()), (McpState::Failed, Some("spawn npx ENOENT")));
    assert!(servers.iter().all(|s| s.provider == "claude" && !s.off_in_crew));
    let removable: Vec<_> = servers.iter().filter(|s| s.can_remove).map(|s| s.name.as_str()).collect();
    assert_eq!(removable, ["context7", "chrome-devtools", "spendo"], "not claude.ai's, a plugin's or a project's");
}

#[test]
fn codexs_list_says_what_each_is_and_its_app_server_how_each_stands() {
    let mut servers = parse_codex_list(&value(CODEX_LIST));
    no_secrets(&servers);
    let context7 = named(&servers, "context7");
    assert_eq!((context7.transport.as_str(), context7.target.as_str()), ("http", "https://mcp.context7.com/mcp"));
    assert_eq!(named(&servers, "computer-use").state, McpState::Disabled);
    assert_eq!(named(&servers, "linear").state, McpState::NeedsAuth, "no login and nothing else said");
    apply_codex_status(&mut servers, &value(CODEX_STATUS));
    assert_eq!(servers.len(), 7, "a server only the app-server names (its own) is not the user's");
    // What the ChatGPT and Codex apps installed for themselves is bundled.
    let bundled: Vec<_> = servers.iter().filter(|s| s.scope.as_deref() == Some("bundled")).map(|s| s.name.as_str()).collect();
    assert_eq!(bundled, ["computer-use", "codex_app", "node_repl"]);
    assert!(servers.iter().all(|s| s.can_remove == (s.scope.is_none())), "neither an app's nor a plugin's is removed");
    let chrome = named(&servers, "chrome-devtools");
    assert_eq!(
        (chrome.state, chrome.tools, chrome.target.as_str()),
        (McpState::Connected, Some(3), "npx chrome-devtools-mcp@latest")
    );
    // A key in its headers answers for it: no OAuth login is not a login it needs.
    assert_eq!((named(&servers, "context7").state, named(&servers, "context7").tools), (McpState::Connected, Some(2)));
    let figma = named(&servers, "figma");
    assert_eq!(
        (figma.state, figma.error.as_deref(), figma.scope.as_deref()),
        (McpState::Failed, Some("401 Unauthorized"), Some("plugin"))
    );
    assert!(figma.can_sign_in && named(&servers, "linear").can_sign_in && !chrome.can_sign_in);
    assert_eq!(named(&servers, "linear").state, McpState::NeedsAuth);
    assert_eq!(named(&servers, "computer-use").state, McpState::Disabled, "off stays off");
}

#[test]
fn opencodes_servers_join_its_config_and_how_its_service_has_them() {
    let servers = parse_opencode(&value(OPENCODE_CONFIG), &value(OPENCODE_MCP), "/Users/me");
    no_secrets(&servers);
    let names: Vec<_> = servers.iter().map(|s| s.name.as_str()).collect();
    assert_eq!(names, ["jira", "playwright", "old", "repo-tool"]);
    let jira = named(&servers, "jira");
    assert_eq!(
        (jira.transport.as_str(), jira.target.as_str(), jira.scope.as_deref()),
        ("http", "https://mcp.atlassian.com/v1/mcp", Some("user"))
    );
    assert_eq!((jira.state, jira.can_sign_in), (McpState::NeedsAuth, true));
    let playwright = named(&servers, "playwright");
    assert_eq!((playwright.transport.as_str(), playwright.target.as_str()), ("stdio", "npx @playwright/mcp@latest"));
    assert_eq!(playwright.state, McpState::Connected);
    assert_eq!(named(&servers, "old").state, McpState::Disabled);
    let repo = named(&servers, "repo-tool");
    assert_eq!((repo.scope.as_deref(), repo.state), (Some("project"), McpState::Failed));
    assert_eq!(repo.error.as_deref(), Some("Connection closed: exited with code 1"));
}

#[test]
fn cursors_lines_are_read_with_its_config_beside_them() {
    let servers = parse_cursor(CURSOR_LIST, Some(&value(CURSOR_CONFIG)));
    no_secrets(&servers);
    let states: Vec<_> = servers.iter().map(|s| (s.name.as_str(), s.state)).collect();
    assert_eq!(
        states,
        [
            ("context7", McpState::Connected),
            ("figma", McpState::NeedsAuth),
            ("slow", McpState::Pending),
            ("off", McpState::Disabled),
            ("new", McpState::Unknown),
            ("bad", McpState::Failed),
        ]
    );
    assert_eq!(named(&servers, "bad").error.as_deref(), Some("Connection failed"));
    assert_eq!(named(&servers, "off").target, "npx -y off-mcp");
    assert_eq!((named(&servers, "figma").transport.as_str(), named(&servers, "figma").can_sign_in), ("http", true));
    assert_eq!(named(&servers, "slow").scope.as_deref(), Some("project"), "not in the user's file");
    assert!(named(&servers, "off").can_remove && !named(&servers, "slow").can_remove);
    assert!(parse_cursor("No MCP servers configured (expected in .cursor/mcp.json or ~/.cursor/mcp.json)", None).is_empty());
    assert_eq!(parse_cursor("\u{1b}[32mx: ready\u{1b}[39m", None)[0].state, McpState::Connected);
}

#[test]
/// The list says what is on, not how it stands (`grok mcp doctor` does);
/// a remote server is one Crew can sign in to for Grok.
fn groks_list_says_what_is_on_and_nothing_of_how_it_stands() {
    let servers = parse_grok(&value(GROK_LIST));
    no_secrets(&servers);
    let webby = named(&servers, "webby");
    assert_eq!((webby.transport.as_str(), webby.state, webby.scope.as_deref()), ("http", McpState::Unknown, Some("project")));
    assert!(webby.can_sign_in);
    let locy = named(&servers, "locy");
    assert_eq!((locy.target.as_str(), locy.state), ("npx -y some-mcp --flag", McpState::Disabled));
    assert!(!locy.can_sign_in, "a command has no sign-in");
}

#[test]
fn a_redirect_is_taken_only_at_the_flows_own_uri_with_its_state() {
    let redirect = "http://127.0.0.1:60694/callback";
    assert!(check_callback(redirect, "s1", "http://127.0.0.1:60694/callback?code=abc&state=s1").is_ok());
    for (url, why) in [
        ("http://127.0.0.1:60695/callback?code=abc&state=s1", "another port"),
        ("http://evil.example:60694/callback?code=abc&state=s1", "another host"),
        ("https://127.0.0.1:60694/callback?code=abc&state=s1", "another scheme"),
        ("http://127.0.0.1:60694/other?code=abc&state=s1", "another path"),
        ("http://127.0.0.1:60694/callback?code=abc&state=s2", "another state"),
        ("http://127.0.0.1:60694/callback?code=abc", "no state"),
        ("not a url", "no URL"),
    ] {
        let refused = check_callback(redirect, "s1", url).expect_err(why);
        assert!(!refused.contains("abc"), "the refusal repeats the code: {refused}");
    }
    assert!(check_callback(REDIRECT_URI, "s1", "http://127.0.0.1:17899/callback?state=s1&code=x").is_ok());
}

#[test]
fn a_caught_redirect_is_requested_only_from_this_machine() {
    assert!(loopback_get("https://example.com/callback?code=x").is_err());
    assert!(loopback_get("http://10.0.0.1:8080/callback?code=x").is_err());
    let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    let port = listener.local_addr().unwrap().port();
    let served = thread::spawn(move || {
        let (mut stream, _) = listener.accept().unwrap();
        let mut line = String::new();
        BufReader::new(stream.try_clone().unwrap()).read_line(&mut line).unwrap();
        stream.write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 2\r\n\r\nok").unwrap();
        line
    });
    loopback_get(&format!("http://127.0.0.1:{port}/callback?code=abc&state=s1")).expect("asked");
    assert_eq!(served.join().unwrap(), "GET /callback?code=abc&state=s1 HTTP/1.1\r\n");
}

fn store() -> Store {
    let dir = std::env::temp_dir().join(format!("crew-provider-servers-{}", uuid::Uuid::new_v4()));
    Store::open(dir.join("crew.sqlite3")).expect("store")
}

fn host(store: &Store, dir: &Path, fakes: &[(&str, &str)]) -> ProviderServers {
    let binaries: HashMap<String, String> =
        PROVIDERS
            .iter()
            .map(|provider| (binary_name(provider).to_string(), dir.join("missing").to_string_lossy().into_owned()))
            .chain(fakes.iter().map(|(name, script)| {
                (name.to_string(), crate::fakes::install(dir, name, script).to_string_lossy().into_owned())
            }))
            .collect();
    ProviderServers::new(store.clone(), Arc::new(Mutex::new(binaries)))
}

fn temp_dir() -> PathBuf {
    let dir = std::env::temp_dir().join(format!("crew-provider-fakes-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&dir).unwrap();
    dir
}

/// What is off in Crew is this machine's, per provider, and never Crew's own.
#[test]
fn what_is_off_is_kept_per_provider_and_never_leaves_out_crews_own() {
    let store = store();
    let servers = host(&store, &temp_dir(), &[]);
    servers.set_off("claude", "context7", true).unwrap();
    servers.set_off("claude", "notion", true).unwrap();
    servers.set_off("codex", "context7", true).unwrap();
    servers.set_off("claude", "notion", false).unwrap();
    assert_eq!(off_names(&store, "claude").into_iter().collect::<Vec<_>>(), ["context7"]);
    assert!(servers.set_off("claude", "crew", true).is_err());
    assert!(servers.set_off("nobody", "x", true).is_err());
    crate::store::set(&store, format!("{OFF_KEY}claude"), r#"["context7","crew","notion_work"]"#.into()).unwrap();
    assert_eq!(spawn_off(&store, "claude", &["crew".into(), "notion_work".into()]), ["context7"]);
}

/// The settings Claude is launched with deny what is off, by name.
#[test]
fn a_server_off_in_crew_is_denied_in_claudes_settings() {
    use crate::providers::claude::{build_claude_spawn_args, ClaudeSpawn};
    let spawn = ClaudeSpawn {
        model: None,
        effort: None,
        session_id: None,
        resume: None,
        replay_user_messages: false,
        asks_questions: false,
        system_prompt: None,
        autonomy: crate::providers::Autonomy::Ask,
        mcp_config: Some("{}".into()),
        user_settings: true,
        fast: false,
        add_dirs: Vec::new(),
        denied_mcp: vec!["context7".into(), "claude.ai Notion".into()],
    };
    let args = build_claude_spawn_args(&spawn);
    let settings: Value = serde_json::from_str(&args[args.iter().position(|a| a == "--settings").unwrap() + 1]).unwrap();
    assert_eq!(settings["deniedMcpServers"], json!([{ "serverName": "context7" }, { "serverName": "claude.ai Notion" }]));
    assert_eq!(settings["permissions"]["allow"], json!(["mcp__crew__*"]), "Crew's own rule stands");
    let none = build_claude_spawn_args(&ClaudeSpawn { denied_mcp: Vec::new(), ..spawn });
    let settings: Value = serde_json::from_str(&none[none.iter().position(|a| a == "--settings").unwrap() + 1]).unwrap();
    assert!(settings.get("deniedMcpServers").is_none(), "{settings}");
}

/// A Codex thread turns off what is off over the user's entry, beside Crew's.
#[test]
fn a_server_off_in_crew_is_disabled_on_codexs_thread_beside_crews() {
    use crate::providers::codex::{thread_request, CodexThread};
    let mut input = CodexThread {
        cwd: "/repo".into(),
        resume: None,
        model: None,
        effort: None,
        service_tier: None,
        autonomy: crate::providers::Autonomy::Ask,
        mcp: Some(("/bin/crewd".into(), vec!["--mcp".into()])),
        mcp_env: vec![("CREW_TOKEN".into(), "t".into())],
        connectors: Vec::new(),
        off: vec!["context7".into()],
        writable_roots: Vec::new(),
    };
    let (method, params) = thread_request(&input);
    assert_eq!(method, "thread/start");
    assert_eq!(params["config"]["mcp_servers"]["context7"], json!({ "enabled": false }));
    assert_eq!(params["config"]["mcp_servers"]["crew"]["args"], json!(["--mcp"]));
    assert_eq!(params["config"]["mcp_servers"]["crew"]["default_tools_approval_mode"], "approve");
    input.mcp = None;
    input.resume = Some("thr".into());
    let (method, params) = thread_request(&input);
    assert_eq!(method, "thread/resume");
    assert_eq!(params["config"]["mcp_servers"], json!({ "context7": { "enabled": false } }), "without Crew's server too");
}

/// opencode's shared server gets a disabled stub of each, and none of Crew's.
#[test]
fn a_server_off_in_crew_is_a_disabled_stub_in_opencodes_config() {
    use crate::providers::opencode::server_config;
    let crew = ("/bin/crewd".to_string(), vec!["--mcp".to_string()]);
    let config: Value = serde_json::from_str(&server_config(Some(&crew), &[], &[], &["jira".into()])).unwrap();
    assert_eq!(config["mcp"]["servers"]["jira"], json!({ "type": "local", "command": ["true"], "disabled": true }));
    assert_eq!(config["mcp"]["servers"]["crew"]["command"], json!(["/bin/crewd", "--mcp"]));
    let bare: Value = serde_json::from_str(&server_config(None, &[], &[], &["jira".into()])).unwrap();
    assert_eq!(bare["mcp"]["servers"].as_object().map(Map::len), Some(1), "{bare}");
}

/// A Codex thread is not given a name Codex does not have: Codex refuses the
/// whole config for it.
#[test]
fn codex_is_told_only_of_names_it_has() {
    let store = store();
    let dir = temp_dir();
    let list = r#"[{"name":"context7","enabled":true,"transport":{"type":"streamable_http","url":"https://x"},"auth_status":"unsupported"}]"#;
    let servers = host(&store, &dir, &[("codex", &format!("#!/bin/sh\necho '{list}'\n"))]);
    servers.set_off("codex", "context7", true).unwrap();
    servers.set_off("codex", "gone", true).unwrap();
    assert_eq!(servers.codex_off(&["crew".into()]), ["context7"]);
    assert!(servers.opencode_off(&[]).is_empty(), "nothing is off for opencode");
}

const FAKE_CLAUDE: &str = r#"#!/usr/bin/env python3
import json, sys
servers = [{"name": "lin", "status": "needs-auth", "scope": "user", "config": {"type": "http", "url": "https://mcp.linear.app/mcp"}},
           {"name": "claude.ai Notion", "status": "connected", "scope": "claudeai", "config": {"type": "claudeai-proxy", "url": "https://mcp.notion.com/mcp"}, "tools": [{"name": "a"}]}]
for line in sys.stdin:
    rec = json.loads(line)
    if rec.get("type") != "control_request":
        continue
    req, rid = rec["request"], rec["request_id"]
    def ok(body):
        print(json.dumps({"type": "control_response", "response": {"subtype": "success", "request_id": rid, "response": body}}), flush=True)
    sub = req["subtype"]
    if sub == "initialize":
        ok({})
    elif sub == "mcp_status":
        ok({"mcpServers": servers})
    elif sub == "mcp_authenticate":
        url = "https://linear.app/oauth/authorize?client_id=c&state=st-1&redirect_uri=" + req["redirectUri"].replace(":", "%3A").replace("/", "%2F")
        ok({"authUrl": url, "state": "st-1", "requiresUserAction": True, "callbackExpected": True, "redirectScheme": "custom"})
    elif sub == "mcp_oauth_callback_url":
        if "code=good" in req["callbackUrl"] and req["serverName"] == "lin":
            ok({})
        else:
            print(json.dumps({"type": "control_response", "response": {"subtype": "error", "request_id": rid, "error": "OAuth authentication failed"}}), flush=True)
"#;

/// Claude's servers are read from a process of its own, and a sign-in keeps
/// one until the caught redirect is handed to it.
#[test]
fn claudes_sign_in_hands_the_caught_redirect_to_the_process_that_started_it() {
    let store = store();
    let dir = temp_dir();
    let servers = host(&store, &dir, &[("claude", FAKE_CLAUDE)]);
    servers.refresh_all();
    assert!(servers.settle(&PROVIDERS, Duration::from_secs(20)));
    let claude = servers.list().into_iter().find(|i| i.provider == "claude").unwrap();
    assert!(claude.installed && claude.checked_at.is_some() && claude.error.is_none(), "{claude:?}");
    assert_eq!(claude.servers.len(), 2);
    let codex = servers.list().into_iter().find(|i| i.provider == "codex").unwrap();
    assert!(!codex.installed && codex.servers.is_empty(), "{codex:?}");

    assert!(servers.sign_in("claude", "claude.ai Notion").is_err());
    let ProviderSignIn::Browser { state, auth_url, redirect_uri } = servers.sign_in("claude", "lin").unwrap() else {
        panic!("not a page")
    };
    assert_eq!((state.as_str(), redirect_uri.as_str()), ("st-1", REDIRECT_URI));
    assert!(auth_url.starts_with("https://linear.app/oauth/authorize"));
    assert!(servers.callback(&state, "http://127.0.0.1:17899/callback?code=good&state=other").is_err());
    assert!(servers.waiting(&state), "a wrong redirect leaves the flow waiting for its own");
    servers.callback(&state, "http://127.0.0.1:17899/callback?code=good&state=st-1").expect("signed in");
    assert!(!servers.waiting(&state));
    assert!(servers.callback(&state, "http://127.0.0.1:17899/callback?code=good&state=st-1").is_err(), "once");

    let ProviderSignIn::Browser { state, .. } = servers.sign_in("claude", "lin").unwrap() else { panic!("not a page") };
    servers.cancel(&state);
    assert!(servers.callback(&state, "http://127.0.0.1:17899/callback?code=good&state=st-1").is_err());
}

const FAKE_CODEX: &str = r#"#!/usr/bin/env python3
import json, sys, socket, threading
if sys.argv[1:3] == ["mcp", "list"]:
    print(json.dumps([{"name": "lin", "enabled": True, "transport": {"type": "streamable_http", "url": "https://mcp.linear.app/mcp"}, "auth_status": "not_logged_in"}]))
    sys.exit(0)
listener = socket.socket()
listener.bind(("127.0.0.1", 0))
listener.listen(1)
port = listener.getsockname()[1]
def say(message):
    print(json.dumps(message), flush=True)
def serve():
    # Anything else that knocks (a port probe of another test) is not the browser.
    while True:
        conn, _ = listener.accept()
        request = b""
        while b"\r\n\r\n" not in request:
            chunk = conn.recv(4096)
            if not chunk:
                break
            request += chunk
        request = request.decode(errors="replace")
        if request.startswith("GET /callback"):
            break
        conn.close()
    conn.sendall(b"HTTP/1.1 200 OK\r\nContent-Length: 2\r\nConnection: close\r\n\r\nok")
    conn.close()
    good = "code=good" in request.split("\r\n")[0]
    say({"method": "mcpServer/oauthLogin/completed", "params": {"name": "lin", "success": good, "error": None if good else "bad code"}})
for line in sys.stdin:
    rec = json.loads(line)
    if "id" not in rec:
        continue
    if rec["method"] == "mcpServer/oauth/login":
        threading.Thread(target=serve, daemon=True).start()
        url = "https://linear.app/oauth/authorize?state=cx-1&redirect_uri=http%3A%2F%2F127.0.0.1%3A" + str(port) + "%2Fcallback"
        say({"id": rec["id"], "result": {"authorizationUrl": url, "loginId": "l1"}})
    else:
        say({"id": rec["id"], "result": {}})
"#;

/// Codex listens on its own loopback while its app-server lives: the caught
/// redirect is requested there, and its notice finishes the sign-in.
#[test]
fn codexs_sign_in_requests_the_caught_redirect_from_its_own_listener() {
    let store = store();
    let dir = temp_dir();
    let servers = host(&store, &dir, &[("codex", FAKE_CODEX)]);
    let ProviderSignIn::Browser { state, redirect_uri, .. } = servers.sign_in("codex", "lin").unwrap() else {
        panic!("not a page")
    };
    assert_eq!(state, "cx-1");
    assert!(redirect_uri.starts_with("http://127.0.0.1:") && redirect_uri.ends_with("/callback"), "{redirect_uri}");
    assert!(servers.callback(&state, "http://127.0.0.1:1/callback?code=good&state=cx-1").is_err(), "not its listener");
    servers.callback(&state, &format!("{redirect_uri}?code=good&state=cx-1")).expect("signed in");
}

// As cursor-agent 2026.10.19 says `mcp login` with no terminal: the page on a
// line of its own, `open` run on it, then its listener until the redirect.
const FAKE_CURSOR: &str = r#"#!/usr/bin/env python3
import os, shutil, socket, subprocess, sys
name = sys.argv[3]
here = os.path.dirname(os.path.abspath(sys.argv[0]))
print("MCP Login\nPreparing MCP login for %s..." % name, flush=True)
if name == "ready":
    print("✓ MCP login successful\nMCP 'ready' is ready.", flush=True)
    sys.exit(0)
if name == "nope":
    print("✗ MCP login failed\nFailed to load MCP 'nope': MCP client \"nope\" not found in config", flush=True)
    sys.exit(1)
listener = socket.socket()
listener.bind(("127.0.0.1", 0))
listener.listen(1)
port = listener.getsockname()[1]
url = "https://www.figma.com/oauth/mcp?state=cu-1&redirect_uri=http%3A%2F%2Flocalhost%3A" + str(port) + "%2Fcallback"
print("Opening your browser...\n" + url + "\n", flush=True)
# Which `open` the PATH finds: Crew's, which opens nothing.
open(os.path.join(here, "cursor-open"), "w").write(shutil.which("open") or "")
subprocess.run(["open", url])
print("Listening on http://localhost:%d/callback for the OAuth callback..." % port, flush=True)
while True:
    conn, _ = listener.accept()
    request = b""
    while b"\r\n\r\n" not in request:
        chunk = conn.recv(4096)
        if not chunk:
            break
        request += chunk
    request = request.decode(errors="replace")
    if request.startswith("GET /callback"):
        break
    conn.close()
conn.sendall(b"HTTP/1.1 200 OK\r\nContent-Length: 2\r\nConnection: close\r\n\r\nok")
conn.close()
if "code=good" in request.split("\r\n")[0]:
    print("✓ MCP login successful", flush=True)
    sys.exit(0)
print("✗ MCP login failed\nToken exchange failed: bad code", flush=True)
sys.exit(1)
"#;

/// Cursor signs in with `mcp login` and no terminal: the page it prints opens
/// in Crew's window, not the user's browser, and the caught redirect is
/// requested from its listener; its exit says how it went.
#[test]
fn cursors_login_runs_without_a_terminal_and_takes_the_redirect_on_its_listener() {
    let store = store();
    let dir = temp_dir();
    let servers = host(&store, &dir, &[("cursor-agent", FAKE_CURSOR)]);
    let ProviderSignIn::Browser { state, auth_url, redirect_uri } = servers.sign_in("cursor", "figma").unwrap() else {
        panic!("not a page")
    };
    assert_eq!(state, "cu-1");
    assert!(auth_url.starts_with("https://www.figma.com/oauth/mcp"));
    assert!(redirect_uri.starts_with("http://localhost:") && redirect_uri.ends_with("/callback"), "{redirect_uri}");
    servers.callback(&state, &format!("{redirect_uri}?code=good&state=cu-1")).expect("signed in");
    let opener = std::fs::read_to_string(dir.join("cursor-open")).unwrap();
    assert!(opener.ends_with("crew-no-browser/open"), "{opener}");

    let ProviderSignIn::Browser { state, redirect_uri, .. } = servers.sign_in("cursor", "figma").unwrap() else {
        panic!("not a page")
    };
    let failed = servers.callback(&state, &format!("{redirect_uri}?code=bad&state=cu-1")).unwrap_err();
    assert_eq!(failed, "Token exchange failed: bad code");

    assert_eq!(servers.sign_in("cursor", "ready").unwrap_err(), "Cursor is already signed in to ready.");
    assert!(servers.sign_in("cursor", "nope").unwrap_err().contains("not found in config"));
}

const FAKE_GROK: &str = r#"#!/usr/bin/env python3
import json, os, sys
state = os.path.join(os.path.dirname(os.path.abspath(sys.argv[0])), "grok-off")
off = open(state).read().split() if os.path.exists(state) else []
args = sys.argv[1:]
if args[:2] == ["mcp", "list"]:
    print(json.dumps([{"name": n, "command": "npx", "args": [n], "enabled": n not in off, "scope": "user"} for n in ["a", "b"]]))
elif args[:2] == ["mcp", "disable"]:
    open(state, "w").write(" ".join(sorted(set(off + [args[2]]))))
    print("Disabled MCP server '%s'." % args[2])
elif args[:2] == ["mcp", "enable"]:
    open(state, "w").write(" ".join(n for n in off if n != args[2]))
    print("Enabled MCP server '%s'." % args[2])
elif args[:2] == ["mcp", "remove"]:
    open(os.path.join(os.path.dirname(os.path.abspath(sys.argv[0])), "grok-removed"), "w").write(" ".join(args[2:]))
    print("Removed MCP server '%s'." % args[2])
"#;

/// Grok's off is its own disable, and what Grok says is what is kept.
#[test]
fn groks_off_is_its_own_disable_and_its_list_is_what_counts() {
    let store = store();
    let dir = temp_dir();
    let servers = host(&store, &dir, &[("grok", FAKE_GROK)]);
    servers.set_off("grok", "a", true).unwrap();
    assert!(servers.settle(&["grok"], Duration::from_secs(20)));
    let grok = servers.list().into_iter().find(|i| i.provider == "grok").unwrap();
    assert_eq!(grok.servers.iter().map(|s| (s.name.as_str(), s.off_in_crew)).collect::<Vec<_>>(), [("a", true), ("b", false)]);
    // Turned on outside Crew: the next list says so, and so does Crew.
    std::fs::write(dir.join("grok-off"), "b").unwrap();
    servers.refresh(&["grok"]);
    assert!(servers.settle(&["grok"], Duration::from_secs(20)));
    assert_eq!(off_names(&store, "grok").into_iter().collect::<Vec<_>>(), ["b"]);
    servers.set_off("grok", "b", false).unwrap();
    assert!(off_names(&store, "grok").is_empty());
    assert_eq!(std::fs::read_to_string(dir.join("grok-off")).unwrap().trim(), "");
}

/// A member comes out of the file as it was written, whatever its place, and
/// the rest keeps its order and spacing.
#[test]
fn a_server_is_taken_out_of_a_json_file_and_nothing_else_moves() {
    let text = "{\n  \"zeta\": 1,\n  \"mcpServers\": {\n    \"b\": { \"url\": \"https://b\" },\n    \"a\": { \"command\": \"npx\", \"args\": [\"-y\", \"}{\\\"\"] },\n    \"c\": {}\n  }\n}\n";
    assert_eq!(
        remove_member(text, &["mcpServers"], "a").unwrap(),
        "{\n  \"zeta\": 1,\n  \"mcpServers\": {\n    \"b\": { \"url\": \"https://b\" },\n    \"c\": {}\n  }\n}\n"
    );
    assert_eq!(
        remove_member(text, &["mcpServers"], "c").unwrap(),
        "{\n  \"zeta\": 1,\n  \"mcpServers\": {\n    \"b\": { \"url\": \"https://b\" },\n    \"a\": { \"command\": \"npx\", \"args\": [\"-y\", \"}{\\\"\"] }\n  }\n}\n"
    );
    let first = remove_member(text, &["mcpServers"], "b").unwrap();
    assert!(first.starts_with("{\n  \"zeta\": 1,\n  \"mcpServers\": {\n    \"a\""), "{first}");
    assert_eq!(
        remove_member("{\"mcp\":{\"servers\":{\"x\":{}}}}", &["mcp", "servers"], "x").unwrap(),
        "{\"mcp\":{\"servers\":{}}}"
    );
    assert!(remove_member(text, &["mcpServers"], "nobody").is_err());
    assert!(
        remove_member("{ // mine\n \"mcpServers\": {\"a\": {}} }", &["mcpServers"], "a").is_err(),
        "a comment is not plain JSON"
    );
    assert!(remove_member("{\"mcpServers\": {\"a\": {},}}", &["mcpServers"], "a").is_err(), "nor a trailing comma");
}

/// The file is replaced whole, keeping its mode; opencode's is found among
/// its documents only when it is the user's and plain JSON.
#[test]
fn a_config_file_is_edited_in_place_and_opencodes_only_when_it_is_plain_json() {
    use std::os::unix::fs::PermissionsExt;
    let home = temp_dir();
    let folder = home.join(".config").join("opencode");
    std::fs::create_dir_all(&folder).unwrap();
    let file = folder.join("opencode.json");
    std::fs::write(&file, "{\n  \"$schema\": \"https://opencode.ai/config.json\",\n  \"mcp\": {\n    \"jira\": { \"type\": \"remote\" },\n    \"pw\": { \"type\": \"local\" }\n  }\n}\n").unwrap();
    std::fs::set_permissions(&file, std::fs::Permissions::from_mode(0o600)).unwrap();
    let home_text = home.to_string_lossy().into_owned();
    let sources = json!([{ "type": "document", "path": file.to_string_lossy(), "info": {} }]);
    let (found, at) = opencode_file(&sources, "jira", &home_text).expect("its file");
    assert_eq!((found.as_path(), at.as_slice()), (file.as_path(), ["mcp"].as_slice()));
    assert!(opencode_file(&sources, "nobody", &home_text).is_none());
    remove_from_file(&found, &at, "jira").unwrap();
    assert_eq!(
        std::fs::read_to_string(&file).unwrap(),
        "{\n  \"$schema\": \"https://opencode.ai/config.json\",\n  \"mcp\": {\n    \"pw\": { \"type\": \"local\" }\n  }\n}\n"
    );
    assert_eq!(std::fs::metadata(&file).unwrap().permissions().mode() & 0o777, 0o600);
    assert_eq!(std::fs::read_dir(&folder).unwrap().count(), 1, "nothing is left beside it");
    std::fs::write(&file, "{ // mine\n \"mcp\": { \"pw\": {} } }").unwrap();
    assert!(opencode_file(&sources, "pw", &home_text).is_none(), "a file with comments is not Crew's to edit");
    let elsewhere = json!([{ "type": "document", "path": "/repo/opencode.json", "info": {} }]);
    assert!(opencode_file(&elsewhere, "pw", &home_text).is_none(), "a project's file is not the user's");
}

/// Removing goes through the CLI, and only for a server Crew may remove.
#[test]
fn a_server_is_removed_through_its_cli_and_forgotten_by_off_in_crew() {
    let store = store();
    let dir = temp_dir();
    let servers = host(&store, &dir, &[("grok", FAKE_GROK), ("claude", FAKE_CLAUDE)]);
    servers.refresh_all();
    assert!(servers.settle(&PROVIDERS, Duration::from_secs(20)));
    servers.set_off("grok", "a", true).unwrap();
    assert!(servers.settle(&["grok"], Duration::from_secs(20)));
    servers.remove("grok", "a").unwrap();
    assert_eq!(std::fs::read_to_string(dir.join("grok-removed")).unwrap(), "a -s user");
    assert!(!off_names(&store, "grok").contains("a"));
    let claude = servers.list().into_iter().find(|i| i.provider == "claude").unwrap();
    let notion = claude.servers.iter().find(|s| s.name == "claude.ai Notion").unwrap();
    assert!(!notion.can_remove && claude.servers.iter().find(|s| s.name == "lin").unwrap().can_remove);
    assert!(servers.remove("claude", "claude.ai Notion").is_err(), "claude.ai's are removed at claude.ai");
    assert!(servers.remove("claude", "nobody").is_err());
}

/* ── Grok ─────────────────────────────────────────────────────────────── */

/// As `grok mcp doctor <name> --json` answers on grok 1.0.70 (details cut).
const GROK_DOCTOR: &str = r#"{"servers":[
  {"name":"linear","transport":"http","target":"https://mcp.linear.app/mcp","checks":[
    {"label":"server started","passed":true,"detail":"0.1s"},
    {"label":"handshake failed","passed":false,"detail":"Send message error Transport [rmcp::transport::worker::WorkerTransport<X>] error: Auth required, when send initialize request","hint":"check server logs"}],"healthy":false},
  {"name":"context7","transport":"http","target":"https://mcp.context7.com/mcp","checks":[
    {"label":"server started","passed":true,"detail":"0.8s"},
    {"label":"handshake OK","passed":true,"detail":"protocol 2026-07-28"},
    {"label":"2 tools discovered","passed":true,"detail":""}],"healthy":true},
  {"name":"broken","transport":"http","target":"https://nonexistent.invalid/mcp","checks":[
    {"label":"server started","passed":true,"detail":"5.0s"},
    {"label":"handshake failed","passed":false,"detail":"Send message error Transport [rmcp::transport::worker::WorkerTransport<X>] error: Client error: error sending request for url (https://nonexistent.invalid/mcp), when send initialize request"}],"healthy":false}
]}"#;

#[test]
fn grok_doctor_says_how_each_server_stands() {
    let report: Value = serde_json::from_str(GROK_DOCTOR).unwrap();
    let mut servers = parse_grok(&json!([
        { "name": "linear", "url": "https://mcp.linear.app/mcp", "enabled": true, "scope": "user" },
        { "name": "context7", "url": "https://mcp.context7.com/mcp", "enabled": true, "scope": "user" },
        { "name": "broken", "url": "https://nonexistent.invalid/mcp", "enabled": true, "scope": "user" },
        { "name": "local", "command": "npx", "args": ["x"], "enabled": true }
    ]));
    for server in &mut servers {
        grok::apply_doctor(server, &report);
    }
    let by = |name: &str| servers.iter().find(|s| s.name == name).unwrap();
    assert_eq!(by("linear").state, McpState::NeedsAuth);
    assert!(by("linear").can_sign_in, "Crew signs in for a remote one");
    assert_eq!((by("context7").state, by("context7").tools), (McpState::Connected, Some(2)));
    assert_eq!(by("broken").state, McpState::Failed);
    assert_eq!(
        by("broken").error.as_deref(),
        Some("Client error: error sending request for url (https://nonexistent.invalid/mcp)")
    );
    assert_eq!((by("local").state, by("local").can_sign_in), (McpState::Unknown, false), "not in the report, as it was");
}

/// Crew's sign-in against the fake server, in its own window's place: the
/// grant lands in Grok's store as Grok writes one, beside what was there,
/// owner-only.
#[test]
fn a_grok_sign_in_writes_the_grant_where_grok_keeps_it() {
    use std::os::unix::fs::PermissionsExt;
    crate::connectors::net::allow_insecure_for_tests();
    let home = temp_dir();
    std::fs::write(home.join("mcp_credentials.json"), r#"{"other:https://x/mcp":{"client_id":"keep"}}"#).unwrap();
    let redirect = crate::connectors::flow::REDIRECT_URI;
    let runtime = tokio::runtime::Builder::new_current_thread().enable_all().build().unwrap();
    let fake = runtime.block_on(crate::connectors::fake_server::start(Default::default()));
    runtime.block_on(async {
        let start = grok::start(&fake.mcp_url, redirect).await.unwrap();
        let answer = crate::connectors::net::client().get(&start.auth_url).send().await.unwrap();
        let caught = answer.headers()["location"].to_str().unwrap().to_string();
        grok::finish(&start, redirect, &caught, &home, "fake", &fake.mcp_url).await.unwrap();
    });
    let file = home.join("mcp_credentials.json");
    assert_eq!(std::fs::metadata(&file).unwrap().permissions().mode() & 0o777, 0o600);
    let store: Value = serde_json::from_str(&std::fs::read_to_string(&file).unwrap()).unwrap();
    assert_eq!(store["other:https://x/mcp"]["client_id"], "keep", "the other entries stay");
    let entry = &store[format!("fake:{}", fake.mcp_url).as_str()];
    assert!(entry["client_id"].as_str().is_some_and(|id| !id.is_empty()), "{entry}");
    assert_eq!(entry["issuer"], fake.url.as_str());
    assert_eq!(entry["token_response"]["token_type"], "bearer");
    assert!(entry["token_response"]["access_token"].as_str().is_some());
    assert!(entry["token_response"]["refresh_token"].as_str().is_some());
    assert!(entry["token_response"]["expires_in"].as_i64().is_some_and(|s| s > 0));
    assert!(entry["token_received_at"].as_i64().is_some_and(|s| s > 1_700_000_000));
}
