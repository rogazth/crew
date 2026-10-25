//! A fake remote MCP server, for tests and e2e: its own OAuth authorization
//! server, protected resource metadata, and a streamable HTTP endpoint, on
//! `http://127.0.0.1` with a port of its own. It needs the connectors'
//! insecure flag (`net::allow_insecure_for_tests`, or
//! `CREW_CONNECTORS_INSECURE=1` for a daemon).
//!
//! It does what the real servers were measured to do, strictly, so the
//! client is held to the spec: PKCE S256 and `resource` are checked,
//! `/authorize` answers at once with a redirect carrying `iss` (no page),
//! refresh tokens rotate, and reusing a rotated one revokes the whole grant
//! (RFC 9700 §4.14.2).
//!
//! HTTP/1.1 by hand, one request per connection: it only has to understand
//! reqwest.

use std::collections::{HashMap, HashSet};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use base64::engine::general_purpose::STANDARD;
use base64::Engine as _;
use serde_json::{json, Value};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};

use super::oauth::s256;

#[derive(Clone, Debug)]
pub struct Options {
    /// How long an access token lasts.
    pub access_ttl: Duration,
    /// Answer `tools/list` as an event stream instead of JSON.
    pub sse: bool,
    /// Publish no registration endpoint, as GitHub does.
    pub refuse_dcr: bool,
    /// Take only clients with a secret, sent as HTTP Basic, as Supabase does.
    pub confidential: bool,
}

impl Default for Options {
    fn default() -> Self {
        Options { access_ttl: Duration::from_secs(3600), sse: false, refuse_dcr: false, confidential: false }
    }
}

/// One request the server took, as it came.
#[derive(Clone, Debug)]
pub struct Recorded {
    pub method: String,
    /// With its query.
    pub path: String,
    pub headers: Vec<(String, String)>,
    pub body: String,
}

impl Recorded {
    pub fn header(&self, name: &str) -> Option<&str> {
        self.headers.iter().find(|(k, _)| k.eq_ignore_ascii_case(name)).map(|(_, v)| v.as_str())
    }
}

/// The running server; it stops when dropped.
pub struct FakeServer {
    /// `http://127.0.0.1:<port>`, the issuer.
    pub url: String,
    /// The MCP endpoint, `<url>/mcp`, which is also the `resource`.
    pub mcp_url: String,
    state: Arc<Mutex<State>>,
    task: tokio::task::JoinHandle<()>,
}

impl Drop for FakeServer {
    fn drop(&mut self) {
        self.task.abort();
    }
}

impl FakeServer {
    pub fn requests(&self) -> Vec<Recorded> {
        self.lock().log.clone()
    }

    pub fn last_request(&self) -> Option<Recorded> {
        self.lock().log.last().cloned()
    }

    /// Switches how `tools/list` answers.
    pub fn set_sse(&self, sse: bool) {
        self.lock().opts.sse = sse;
    }

    /// Forgets every MCP session, as a server that restarted would: the next
    /// call with an old session id gets 404.
    pub fn expire_sessions(&self) {
        self.lock().sessions.clear();
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, State> {
        self.state.lock().unwrap_or_else(|e| e.into_inner())
    }
}

pub async fn start(opts: Options) -> FakeServer {
    let listener = TcpListener::bind("127.0.0.1:0").await.expect("bind the fake server");
    let url = format!("http://{}", listener.local_addr().expect("its address"));
    let state = Arc::new(Mutex::new(State { url: url.clone(), opts, ..State::default() }));
    let shared = state.clone();
    let task = tokio::spawn(async move {
        while let Ok((stream, _)) = listener.accept().await {
            let state = shared.clone();
            tokio::spawn(async move {
                let _ = serve(stream, state).await;
            });
        }
    });
    FakeServer { mcp_url: format!("{url}/mcp"), url, state, task }
}

#[derive(Default)]
struct State {
    url: String,
    opts: Options,
    /// client id → its redirect URI.
    clients: HashMap<String, String>,
    codes: HashMap<String, Code>,
    /// access token → (grant, expiry).
    access: HashMap<String, (u64, Instant)>,
    /// refresh token → (grant, still the current one).
    refresh: HashMap<String, (u64, bool)>,
    revoked: HashSet<u64>,
    next_grant: u64,
    sessions: HashSet<String>,
    log: Vec<Recorded>,
}

struct Code {
    client_id: String,
    redirect_uri: String,
    challenge: String,
    resource: String,
}

struct Reply {
    status: u16,
    headers: Vec<(String, String)>,
    body: String,
}

fn reply(status: u16, body: Value) -> Reply {
    Reply { status, headers: vec![("Content-Type".into(), "application/json".into())], body: body.to_string() }
}

fn oauth_error(error: &str) -> Reply {
    reply(400, json!({ "error": error }))
}

async fn serve(mut stream: TcpStream, state: Arc<Mutex<State>>) -> std::io::Result<()> {
    let Some(request) = read_request(&mut stream).await? else { return Ok(()) };
    let reply = {
        let mut state = state.lock().unwrap_or_else(|e| e.into_inner());
        state.log.push(request.clone());
        handle(&mut state, &request)
    };
    let mut head = format!("HTTP/1.1 {} X\r\nContent-Length: {}\r\nConnection: close\r\n", reply.status, reply.body.len());
    for (k, v) in &reply.headers {
        head.push_str(&format!("{k}: {v}\r\n"));
    }
    head.push_str("\r\n");
    stream.write_all(head.as_bytes()).await?;
    stream.write_all(reply.body.as_bytes()).await?;
    stream.shutdown().await
}

async fn read_request(stream: &mut TcpStream) -> std::io::Result<Option<Recorded>> {
    let mut buf = Vec::new();
    let mut chunk = [0u8; 8192];
    let head_end = loop {
        if let Some(at) = buf.windows(4).position(|w| w == b"\r\n\r\n") {
            break at;
        }
        let n = stream.read(&mut chunk).await?;
        if n == 0 || buf.len() > 1 << 20 {
            return Ok(None);
        }
        buf.extend_from_slice(&chunk[..n]);
    };
    let head = String::from_utf8_lossy(&buf[..head_end]).into_owned();
    let mut lines = head.split("\r\n");
    let mut first = lines.next().unwrap_or_default().split(' ');
    let (method, path) = (first.next().unwrap_or_default().to_string(), first.next().unwrap_or_default().to_string());
    let headers: Vec<(String, String)> =
        lines.filter_map(|l| l.split_once(':')).map(|(k, v)| (k.trim().to_string(), v.trim().to_string())).collect();
    let length: usize = headers
        .iter()
        .find(|(k, _)| k.eq_ignore_ascii_case("content-length"))
        .and_then(|(_, v)| v.parse().ok())
        .unwrap_or(0);
    let mut body = buf[head_end + 4..].to_vec();
    while body.len() < length {
        let n = stream.read(&mut chunk).await?;
        if n == 0 {
            break;
        }
        body.extend_from_slice(&chunk[..n]);
    }
    Ok(Some(Recorded { method, path, headers, body: String::from_utf8_lossy(&body).into_owned() }))
}

fn handle(state: &mut State, req: &Recorded) -> Reply {
    let (path, query) = req.path.split_once('?').unwrap_or((&req.path, ""));
    let base = state.url.clone();
    match (req.method.as_str(), path) {
        ("GET", "/.well-known/oauth-protected-resource/mcp") => reply(
            200,
            json!({ "resource": format!("{base}/mcp"), "authorization_servers": [base], "scopes_supported": ["read"] }),
        ),
        ("GET", "/.well-known/oauth-authorization-server") => {
            let mut meta = json!({
                "issuer": base,
                "authorization_endpoint": format!("{base}/authorize"),
                "token_endpoint": format!("{base}/token"),
                "registration_endpoint": format!("{base}/register"),
                "revocation_endpoint": format!("{base}/revoke"),
                "userinfo_endpoint": format!("{base}/userinfo"),
                "code_challenge_methods_supported": ["S256"],
                "token_endpoint_auth_methods_supported": ["none"],
                "authorization_response_iss_parameter_supported": true,
            });
            if state.opts.refuse_dcr {
                meta.as_object_mut().map(|m| m.remove("registration_endpoint"));
            }
            if state.opts.confidential {
                meta["token_endpoint_auth_methods_supported"] = json!(["client_secret_basic", "client_secret_post"]);
            }
            reply(200, meta)
        }
        ("POST", "/register") => register(state, req),
        ("GET", "/authorize") => authorize(state, query),
        ("POST", "/token") => match client_of(state, req) {
            Some(client) => token(state, &client, &form(&req.body)),
            None => reply(401, json!({ "error": "invalid_client" })),
        },
        ("POST", "/revoke") => {
            let form = form(&req.body);
            let token = form.get("token").cloned().unwrap_or_default();
            if let Some((grant, _)) = state.refresh.get(&token) {
                state.revoked.insert(*grant);
            }
            state.access.remove(&token);
            reply(200, json!({}))
        }
        ("GET", "/userinfo") => match bearer(state, req) {
            true => reply(200, json!({ "sub": "1", "email": "ada@example.com", "name": "Ada Lovelace" })),
            false => reply(401, json!({ "error": "invalid_token" })),
        },
        ("POST", "/mcp") => mcp(state, req),
        _ => reply(404, json!({ "error": "not_found" })),
    }
}

fn form(body: &str) -> HashMap<String, String> {
    url::form_urlencoded::parse(body.as_bytes()).into_owned().collect()
}

fn register(state: &mut State, req: &Recorded) -> Reply {
    if state.opts.refuse_dcr {
        return reply(403, json!({ "error": "access_denied" }));
    }
    let meta: Value = serde_json::from_str(&req.body).unwrap_or_default();
    let Some(redirect) = meta["redirect_uris"][0].as_str() else { return oauth_error("invalid_redirect_uri") };
    let method = if state.opts.confidential { "client_secret_basic" } else { "none" };
    if meta["token_endpoint_auth_method"] != method {
        return oauth_error("invalid_client_metadata");
    }
    let id = format!("client-{}", state.clients.len() + 1);
    state.clients.insert(id.clone(), redirect.to_string());
    match state.opts.confidential {
        // Supabase's answer: a secret, and no method named.
        true => reply(201, json!({ "client_id": id, "client_secret": format!("secret-{id}"), "redirect_uris": [redirect] })),
        false => reply(201, json!({ "client_id": id, "redirect_uris": [redirect], "token_endpoint_auth_method": "none" })),
    }
}

/// The client a token request proves itself as: its Basic credentials when
/// the server takes only those, else the `client_id` it names.
fn client_of(state: &State, req: &Recorded) -> Option<String> {
    if !state.opts.confidential {
        return Some(form(&req.body).get("client_id").cloned().unwrap_or_default());
    }
    let header = req.headers.iter().find(|(k, _)| k.eq_ignore_ascii_case("authorization"))?;
    let decoded = STANDARD.decode(header.1.strip_prefix("Basic ")?).ok()?;
    let (id, secret) = std::str::from_utf8(&decoded).ok()?.split_once(':')?;
    (state.clients.contains_key(id) && secret == format!("secret-{id}")).then(|| id.to_string())
}

fn authorize(state: &mut State, query: &str) -> Reply {
    let q = form(query);
    let get = |k: &str| q.get(k).cloned().unwrap_or_default();
    let client_id = get("client_id");
    if state.clients.get(&client_id) != Some(&get("redirect_uri")) {
        return oauth_error("invalid_client");
    }
    if get("code_challenge_method") != "S256" || get("code_challenge").is_empty() || get("response_type") != "code" {
        return oauth_error("invalid_request");
    }
    let code = format!("code-{}", uuid::Uuid::new_v4());
    state.codes.insert(
        code.clone(),
        Code { client_id, redirect_uri: get("redirect_uri"), challenge: get("code_challenge"), resource: get("resource") },
    );
    let location = url::Url::parse_with_params(&get("redirect_uri"), [("code", code.as_str()), ("state", &get("state")), ("iss", &state.url)])
        .map(String::from)
        .unwrap_or_default();
    Reply { status: 302, headers: vec![("Location".into(), location)], body: String::new() }
}

fn token(state: &mut State, client_id: &str, form: &HashMap<String, String>) -> Reply {
    let get = |k: &str| form.get(k).cloned().unwrap_or_default();
    let resource = format!("{}/mcp", state.url);
    let grant = match get("grant_type").as_str() {
        "authorization_code" => {
            let Some(code) = state.codes.remove(&get("code")) else { return oauth_error("invalid_grant") };
            if code.client_id != client_id || code.redirect_uri != get("redirect_uri") || code.challenge != s256(&get("code_verifier")) {
                return oauth_error("invalid_grant");
            }
            if code.resource != resource || get("resource") != resource {
                return oauth_error("invalid_target");
            }
            state.next_grant += 1;
            state.next_grant
        }
        "refresh_token" => {
            let Some(&(grant, current)) = state.refresh.get(&get("refresh_token")) else { return oauth_error("invalid_grant") };
            if !current {
                // A rotated token used again: someone holds a copy. Revoke it all.
                state.revoked.insert(grant);
            }
            if state.revoked.contains(&grant) {
                return oauth_error("invalid_grant");
            }
            if get("resource") != resource {
                return oauth_error("invalid_target");
            }
            state.refresh.insert(get("refresh_token"), (grant, false));
            grant
        }
        _ => return oauth_error("unsupported_grant_type"),
    };
    let access = format!("at-{}", uuid::Uuid::new_v4());
    let refresh = format!("rt-{}", uuid::Uuid::new_v4());
    state.access.insert(access.clone(), (grant, Instant::now() + state.opts.access_ttl));
    state.refresh.insert(refresh.clone(), (grant, true));
    reply(
        200,
        json!({
            "access_token": access, "token_type": "Bearer", "expires_in": state.opts.access_ttl.as_secs(),
            "refresh_token": refresh, "scope": "read",
        }),
    )
}

fn bearer(state: &State, req: &Recorded) -> bool {
    let token = req.header("authorization").and_then(|h| h.strip_prefix("Bearer ")).unwrap_or_default();
    state.access.get(token).is_some_and(|(grant, until)| Instant::now() < *until && !state.revoked.contains(grant))
}

fn mcp(state: &mut State, req: &Recorded) -> Reply {
    if !bearer(state, req) {
        let challenge = format!(r#"Bearer resource_metadata="{}/.well-known/oauth-protected-resource/mcp", scope="read""#, state.url);
        return Reply { status: 401, headers: vec![("WWW-Authenticate".into(), challenge)], body: String::new() };
    }
    let message: Value = serde_json::from_str(&req.body).unwrap_or_default();
    let method = message["method"].as_str().unwrap_or_default();
    let id = message["id"].clone();
    if method == "initialize" {
        let session = uuid::Uuid::new_v4().to_string();
        state.sessions.insert(session.clone());
        let mut r = reply(
            200,
            json!({ "jsonrpc": "2.0", "id": id, "result": {
                "protocolVersion": "2025-06-18",
                "capabilities": { "tools": { "listChanged": true } },
                "serverInfo": { "name": "fake", "version": "1" },
            }}),
        );
        r.headers.push(("Mcp-Session-Id".into(), session));
        return r;
    }
    match req.header("mcp-session-id") {
        None => return reply(400, json!({ "error": "no session" })),
        Some(s) if !state.sessions.contains(s) => return reply(404, json!({ "error": "no such session" })),
        _ => {}
    }
    if req.header("mcp-protocol-version") != Some("2025-06-18") {
        return reply(400, json!({ "error": "no protocol version" }));
    }
    if id.is_null() {
        return Reply { status: 202, headers: Vec::new(), body: String::new() };
    }
    let answer = |result: Value| json!({ "jsonrpc": "2.0", "id": id, "result": result });
    match method {
        "tools/list" => {
            let page = match message["params"]["cursor"].as_str() {
                None => json!({ "tools": [tool("search", json!({ "readOnlyHint": true })), tool("create_page", json!({ "destructiveHint": false }))], "nextCursor": "page-2" }),
                Some("page-2") => json!({ "tools": [tool("delete_page", json!({ "destructiveHint": true }))] }),
                Some(_) => return reply(200, json!({ "jsonrpc": "2.0", "id": id, "error": { "code": -32602, "message": "bad cursor" } })),
            };
            if !state.opts.sse {
                return reply(200, answer(page));
            }
            let note = json!({ "jsonrpc": "2.0", "method": "notifications/tools/list_changed" });
            let body = format!(": hello\n\nevent: message\ndata: {note}\n\nid: 1\ndata: {}\n\n", answer(page));
            Reply { status: 200, headers: vec![("Content-Type".into(), "text/event-stream".into())], body }
        }
        "tools/call" => {
            let params = &message["params"];
            reply(
                200,
                answer(json!({
                    "content": [{ "type": "text", "text": params["arguments"].to_string() }],
                    "structuredContent": { "name": params["name"], "arguments": params["arguments"], "meta": params["_meta"] },
                    "isError": false,
                })),
            )
        }
        _ => reply(200, json!({ "jsonrpc": "2.0", "id": id, "error": { "code": -32601, "message": "Method not found" } })),
    }
}

fn tool(name: &str, annotations: Value) -> Value {
    json!({
        "name": name,
        "description": format!("The fake's {name}"),
        "inputSchema": { "type": "object", "properties": { "text": { "type": "string" } } },
        "annotations": annotations,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::connectors::oauth::{self, OAuthError, Pkce};
    use crate::connectors::remote::{RemoteClient, RemoteError};
    use crate::connectors::net;

    const REDIRECT: &str = "http://127.0.0.1:9/callback";

    /// Discovery to tokens, the way the vault signs an account in.
    async fn sign_in(server: &FakeServer) -> (oauth::Discovery, oauth::Client, oauth::Tokens) {
        let d = oauth::discover(&server.mcp_url).await.expect("discover");
        let client = oauth::register(&d, REDIRECT).await.expect("register");
        let pkce = Pkce::new();
        let page = oauth::authorize_url(&d, &client.id, REDIRECT, &pkce).unwrap();
        // What the sign-in tab catches: the redirect, never followed.
        let res = net::client().get(&page).send().await.unwrap();
        assert_eq!(res.status(), 302);
        let callback = res.headers()["location"].to_str().unwrap().to_string();
        let tokens = oauth::exchange(&d, &client, REDIRECT, &pkce, &callback).await.expect("exchange");
        (d, client, tokens)
    }

    #[tokio::test]
    async fn an_account_signs_in_lists_and_calls_tools_rotates_and_is_revoked() {
        net::allow_insecure_for_tests();
        let server = start(Options::default()).await;
        let (d, client, tokens) = sign_in(&server).await;
        assert_eq!(d.resource, server.mcp_url);
        assert_eq!(d.issuer, server.url);
        assert_eq!(d.scopes, ["read"], "the 401's scope is asked for");
        assert!(d.iss_parameter_supported);
        assert_eq!(oauth::identity(&d, &tokens).await.as_deref(), Some("ada@example.com"));

        let remote = RemoteClient::new(&server.mcp_url).unwrap();
        let names = |tools: Vec<Value>| tools.iter().map(|t| t["name"].as_str().unwrap().to_string()).collect::<Vec<_>>();
        let listed = remote.list_tools(&tokens.access_token).await.unwrap();
        assert_eq!(names(listed), ["search", "create_page", "delete_page"]);
        assert!(!remote.take_list_changed());
        server.set_sse(true);
        let listed = remote.list_tools(&tokens.access_token).await.unwrap();
        assert_eq!(names(listed), ["search", "create_page", "delete_page"], "the same list, from an event stream");
        assert!(remote.take_list_changed(), "the stream's tools change is noted");

        let result = remote
            .call_tool(&tokens.access_token, "search", json!({ "text": "hi" }), Some(json!({ "progressToken": 1 })))
            .await
            .unwrap();
        assert_eq!(result["structuredContent"], json!({ "name": "search", "arguments": { "text": "hi" }, "meta": { "progressToken": 1 } }));
        let initializes = server.requests().iter().filter(|r| r.body.contains(r#""method":"initialize""#)).count();
        assert_eq!(initializes, 2, "discovery's probe and the client's one handshake");

        let old = tokens.refresh_token.clone().unwrap();
        let fresh = oauth::refresh(&d.token_endpoint, &client, &d.resource, &old).await.unwrap();
        assert_ne!(fresh.refresh_token.as_deref(), Some(old.as_str()), "the refresh token rotates");
        assert!(remote.list_tools(&fresh.access_token).await.is_ok());
        assert_eq!(oauth::refresh(&d.token_endpoint, &client, &d.resource, &old).await, Err(OAuthError::InvalidGrant));
        assert!(
            matches!(remote.list_tools(&fresh.access_token).await, Err(RemoteError::Unauthorized { www_authenticate: Some(_) })),
            "reusing the old one revoked the whole grant"
        );

        let (_, _, tokens) = sign_in(&server).await;
        let revocation = d.revocation_endpoint.as_deref().unwrap();
        oauth::revoke(revocation, &client, tokens.refresh_token.as_deref().unwrap(), "refresh_token").await.unwrap();
        let refreshed = oauth::refresh(&d.token_endpoint, &client, &d.resource, tokens.refresh_token.as_deref().unwrap()).await;
        assert_eq!(refreshed, Err(OAuthError::InvalidGrant));

        let leaked = server.requests().iter().any(|r| r.path.contains("token=") || r.path.contains("verifier"));
        assert!(!leaked, "no token or verifier travels in a URL");
    }

    #[tokio::test]
    async fn an_expired_session_is_initialized_again_once() {
        net::allow_insecure_for_tests();
        let server = start(Options::default()).await;
        let (_, _, tokens) = sign_in(&server).await;
        let remote = RemoteClient::new(&server.mcp_url).unwrap();
        remote.call_tool(&tokens.access_token, "search", json!({}), None).await.unwrap();
        server.expire_sessions();
        remote.call_tool(&tokens.access_token, "search", json!({}), None).await.unwrap();
        let initializes = server.requests().iter().filter(|r| r.body.contains(r#""method":"initialize""#)).count();
        assert_eq!(initializes, 3, "discovery's probe, the first handshake and one after the 404");
        let last = server.last_request().unwrap();
        assert!(last.header("mcp-session-id").is_some() && last.header("mcp-protocol-version") == Some("2025-06-18"));
    }

    #[tokio::test]
    async fn an_expired_access_token_is_unauthorized() {
        net::allow_insecure_for_tests();
        let server = start(Options { access_ttl: Duration::ZERO, ..Options::default() }).await;
        let (_, _, tokens) = sign_in(&server).await;
        let remote = RemoteClient::new(&server.mcp_url).unwrap();
        assert!(matches!(remote.list_tools(&tokens.access_token).await, Err(RemoteError::Unauthorized { .. })));
    }

    #[tokio::test]
    async fn a_server_without_registration_is_refused_at_discovery() {
        net::allow_insecure_for_tests();
        let server = start(Options { refuse_dcr: true, ..Options::default() }).await;
        assert!(matches!(oauth::discover(&server.mcp_url).await, Err(OAuthError::Refused(_))));
    }
}
