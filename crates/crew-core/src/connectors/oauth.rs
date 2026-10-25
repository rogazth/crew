//! The OAuth 2.1 client the vault signs accounts in with, as the MCP
//! authorization spec (2025-06-18) has it: protected resource metadata
//! (RFC 9728), authorization server metadata (RFC 8414, or OpenID's), dynamic
//! client registration (RFC 7591), PKCE S256 (RFC 7636), `resource` on every
//! request (RFC 8707), the callback's `iss` (RFC 9207) and revocation
//! (RFC 7009).
//!
//! Crew registers as a public client (`token_endpoint_auth_method: none`)
//! where the server takes one. Where it only takes clients with a secret
//! (Supabase), the registration hands this install its own secret, which is
//! kept with the grant in the vault and never shipped with Crew. A server
//! that takes no registration (GitHub), or turns Crew's away (Figma), cannot
//! be connected from Crew, and says so in one line (`Refused`).
//!
//! Discovery covers what real servers were measured to do (plan, "Server
//! facts"): a 401 that names its metadata, one that does not (Atlassian),
//! metadata at the root for a server with a path (Figma), and an
//! authorization server with a path (Stripe, GitHub).
//!
//! Nothing here logs, and no error carries a token, a code or a body.

use std::collections::HashMap;
use std::fmt;

use base64::engine::general_purpose::{STANDARD, URL_SAFE_NO_PAD};
use base64::Engine as _;
use reqwest::header::{ACCEPT, AUTHORIZATION, CONTENT_TYPE, WWW_AUTHENTICATE};
use reqwest::{Method, StatusCode};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use url::Url;

use super::net;
use crate::store::now_millis;

/// Where and how a server signs in, from its metadata. Nothing in it is a
/// secret, so the flow may keep it with the connector.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Discovery {
    /// The `resource` every request names: the protected resource metadata's,
    /// else the server URL.
    pub resource: String,
    pub issuer: String,
    pub authorization_endpoint: String,
    pub token_endpoint: String,
    pub registration_endpoint: Option<String>,
    pub revocation_endpoint: Option<String>,
    pub userinfo_endpoint: Option<String>,
    /// What to ask for: the 401's `scope`, else the resource's
    /// `scopes_supported`. Empty asks for the server's default.
    pub scopes: Vec<String>,
    pub iss_parameter_supported: bool,
    /// How Crew will prove it is the client, from the methods the server
    /// takes.
    #[serde(default)]
    pub client_auth: ClientAuth,
}

/// How a client proves itself at the token endpoint (RFC 7591's
/// `token_endpoint_auth_method`).
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub enum ClientAuth {
    #[default]
    #[serde(rename = "none")]
    None,
    #[serde(rename = "client_secret_basic")]
    Basic,
    #[serde(rename = "client_secret_post")]
    Post,
}

impl ClientAuth {
    pub fn as_str(self) -> &'static str {
        match self {
            ClientAuth::None => "none",
            ClientAuth::Basic => "client_secret_basic",
            ClientAuth::Post => "client_secret_post",
        }
    }
}

/// Crew's registration with one authorization server and redirect.
#[derive(Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Client {
    pub id: String,
    /// Only a client the server made confidential has one.
    pub secret: Option<String>,
    pub auth: ClientAuth,
}

impl Client {
    pub fn public(id: &str) -> Self {
        Client { id: id.to_string(), secret: None, auth: ClientAuth::None }
    }

    /// The form fields and header a token or revocation request proves the
    /// client with.
    fn credentials(&self) -> (Vec<(&'static str, &str)>, Option<String>) {
        let id = ("client_id", self.id.as_str());
        match (self.auth, self.secret.as_deref()) {
            (ClientAuth::Basic, Some(secret)) => {
                let enc = |s: &str| url::form_urlencoded::byte_serialize(s.as_bytes()).collect::<String>();
                let pair = format!("{}:{}", enc(&self.id), enc(secret));
                (vec![], Some(format!("Basic {}", STANDARD.encode(pair))))
            }
            (ClientAuth::Post, Some(secret)) => (vec![id, ("client_secret", secret)], None),
            _ => (vec![id], None),
        }
    }
}

impl fmt::Debug for Client {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("Client")
            .field("id", &self.id)
            .field("secret", &self.secret.as_ref().map(|_| "…"))
            .field("auth", &self.auth)
            .finish()
    }
}

/// One sign-in's PKCE verifier and state. The verifier is what makes a
/// caught code worth anything, so it never leaves the daemon that made it.
#[derive(Clone)]
pub struct Pkce {
    pub verifier: String,
    pub challenge: String,
    pub state: String,
}

impl Pkce {
    pub fn new() -> Self {
        let verifier = random_token();
        let challenge = s256(&verifier);
        Pkce { verifier, challenge, state: random_token() }
    }
}

impl Default for Pkce {
    fn default() -> Self {
        Self::new()
    }
}

impl fmt::Debug for Pkce {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("Pkce").field("verifier", &"…").field("challenge", &self.challenge).field("state", &"…").finish()
    }
}

/// A grant's tokens, as the token endpoint answered them.
#[derive(Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Tokens {
    pub access_token: String,
    pub refresh_token: Option<String>,
    /// Unix milliseconds, when the server said.
    pub expires_at: Option<i64>,
    pub scope: Option<String>,
    pub id_token: Option<String>,
}

impl fmt::Debug for Tokens {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("Tokens")
            .field("access_token", &"…")
            .field("refresh_token", &self.refresh_token.as_ref().map(|_| "…"))
            .field("expires_at", &self.expires_at)
            .field("scope", &self.scope)
            .field("id_token", &self.id_token.as_ref().map(|_| "…"))
            .finish()
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum OAuthError {
    /// The server cannot take Crew's client (no registration, a
    /// registration turned away, no S256), with a line the page can show.
    Refused(String),
    /// The person, or the service, declined the sign-in.
    Denied(String),
    /// The grant is gone (a dead refresh token, a used code): the account
    /// needs a new sign-in.
    InvalidGrant,
    Network(String),
    Protocol(String),
}

impl fmt::Display for OAuthError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            OAuthError::Refused(m) | OAuthError::Network(m) | OAuthError::Protocol(m) => f.write_str(m),
            OAuthError::Denied(m) => write!(f, "The sign-in was declined: {m}"),
            OAuthError::InvalidGrant => f.write_str("The sign-in has expired; sign in again"),
        }
    }
}

impl std::error::Error for OAuthError {}

/* ── Discovery ────────────────────────────────────────────────────────── */

pub async fn discover(server_url: &str) -> Result<Discovery, OAuthError> {
    let server = net::check_url(server_url).map_err(OAuthError::Protocol)?;
    let (metadata_url, challenge_scope) = probe(&server).await?;

    let mut resource = server.as_str().to_string();
    let mut issuer = server.origin().ascii_serialization();
    let mut scopes = Vec::new();
    if let Some(prm) = protected_resource(&server, metadata_url.as_deref()).await? {
        if let Some(named) = prm["resource"].as_str() {
            let same = Url::parse(named).map(|u| u.origin() == server.origin()).unwrap_or(false);
            if !same {
                return Err(OAuthError::Protocol(format!(
                    "{} names another site as its resource ({})",
                    host_of(&server),
                    net::shorten(named, 80)
                )));
            }
            resource = named.to_string();
        }
        issuer = prm["authorization_servers"][0].as_str().unwrap_or_default().to_string();
        scopes = strings(&prm["scopes_supported"]);
    }
    if let Some(scope) = challenge_scope {
        scopes = scope.split_whitespace().map(str::to_string).collect();
    }

    let issuer_url = net::check_url(&issuer).map_err(|e| OAuthError::Protocol(format!("The sign-in server: {e}")))?;
    let host = host_of(&issuer_url);
    let meta = authorization_server(&issuer_url)
        .await?
        .ok_or_else(|| OAuthError::Protocol(format!("{host} publishes no sign-in metadata")))?;
    if !same_issuer(meta["issuer"].as_str().unwrap_or_default(), &issuer) {
        return Err(OAuthError::Protocol(format!("{host}'s sign-in metadata names another issuer")));
    }

    let registration_endpoint = endpoint(&meta, "registration_endpoint")?;
    if registration_endpoint.is_none() {
        return Err(OAuthError::Refused(format!("{host} does not let apps register themselves")));
    }
    let client_auth = client_auth_for(&meta).ok_or_else(|| {
        OAuthError::Refused(format!("{host} only signs in apps in ways Crew doesn't speak"))
    })?;
    if meta.get("code_challenge_methods_supported").is_some()
        && !strings(&meta["code_challenge_methods_supported"]).iter().any(|m| m == "S256")
    {
        return Err(OAuthError::Refused(format!("{host} does not support PKCE with S256, which Crew requires")));
    }

    let required = |key: &str| {
        endpoint(&meta, key)?.ok_or_else(|| OAuthError::Protocol(format!("{host}'s sign-in metadata has no {key}")))
    };
    Ok(Discovery {
        resource,
        issuer,
        authorization_endpoint: required("authorization_endpoint")?,
        token_endpoint: required("token_endpoint")?,
        registration_endpoint,
        revocation_endpoint: endpoint(&meta, "revocation_endpoint")?,
        userinfo_endpoint: endpoint(&meta, "userinfo_endpoint")?,
        scopes,
        iss_parameter_supported: meta["authorization_response_iss_parameter_supported"].as_bool().unwrap_or(false),
        client_auth,
    })
}

/// A public client where the server takes one, else one with a secret.
/// Metadata that names no methods is taken to take a public client: the
/// registration answer says otherwise when it doesn't.
fn client_auth_for(meta: &Value) -> Option<ClientAuth> {
    if meta.get("token_endpoint_auth_methods_supported").is_none() {
        return Some(ClientAuth::None);
    }
    let methods = strings(&meta["token_endpoint_auth_methods_supported"]);
    [ClientAuth::None, ClientAuth::Basic, ClientAuth::Post].into_iter().find(|a| methods.iter().any(|m| m == a.as_str()))
}

/// Asks the server without a token, to read its 401's `resource_metadata`
/// and `scope`. Any other answer leaves discovery to the well-known URIs.
async fn probe(server: &Url) -> Result<(Option<String>, Option<String>), OAuthError> {
    let body = json!({
        "jsonrpc": "2.0", "id": 1, "method": "initialize",
        "params": { "protocolVersion": super::remote::PROTOCOL_VERSION, "capabilities": {},
                    "clientInfo": { "name": "Crew", "version": env!("CARGO_PKG_VERSION") } },
    });
    let res = net::request(Method::POST, server.as_str())
        .map_err(OAuthError::Protocol)?
        .header(ACCEPT, "application/json, text/event-stream")
        .json(&body)
        .send()
        .await
        .map_err(|e| OAuthError::Network(net::describe(e)))?;
    if res.status() != StatusCode::UNAUTHORIZED {
        return Ok((None, None));
    }
    let header = res.headers().get(WWW_AUTHENTICATE).and_then(|v| v.to_str().ok()).unwrap_or_default();
    Ok((auth_param(header, "resource_metadata"), auth_param(header, "scope")))
}

/// The first protected resource metadata that names an authorization
/// server, or `None` when there is none (then the server's origin is taken
/// as its own authorization server).
async fn protected_resource(server: &Url, from_header: Option<&str>) -> Result<Option<Value>, OAuthError> {
    for candidate in resource_candidates(server, from_header) {
        // A header naming a URL the guard refuses is skipped, not followed.
        if net::check_url(&candidate).is_err() {
            continue;
        }
        let found = net::get_json(&candidate).await.map_err(OAuthError::Network)?;
        if let Some(prm) = found.filter(|m| m["authorization_servers"][0].is_string()) {
            return Ok(Some(prm));
        }
    }
    Ok(None)
}

fn resource_candidates(server: &Url, from_header: Option<&str>) -> Vec<String> {
    let origin = server.origin().ascii_serialization();
    let mut out: Vec<String> = from_header.map(str::to_string).into_iter().collect();
    if server.path() != "/" && !server.path().is_empty() {
        out.push(format!("{origin}/.well-known/oauth-protected-resource{}", server.path()));
    }
    out.push(format!("{origin}/.well-known/oauth-protected-resource"));
    out.dedup();
    out
}

async fn authorization_server(issuer: &Url) -> Result<Option<Value>, OAuthError> {
    for candidate in issuer_candidates(issuer) {
        let found = net::get_json(&candidate).await.map_err(OAuthError::Network)?;
        if let Some(meta) = found.filter(|m| m["authorization_endpoint"].is_string() && m["token_endpoint"].is_string()) {
            return Ok(Some(meta));
        }
    }
    Ok(None)
}

/// RFC 8414 inserts the well-known part before an issuer's path; OpenID
/// appends it, and some servers (GitHub) only answer that way.
fn issuer_candidates(issuer: &Url) -> Vec<String> {
    let origin = issuer.origin().ascii_serialization();
    let path = issuer.path().trim_end_matches('/');
    if path.is_empty() {
        return vec![
            format!("{origin}/.well-known/oauth-authorization-server"),
            format!("{origin}/.well-known/openid-configuration"),
        ];
    }
    vec![
        format!("{origin}/.well-known/oauth-authorization-server{path}"),
        format!("{origin}/.well-known/openid-configuration{path}"),
        format!("{origin}{path}/.well-known/openid-configuration"),
    ]
}

/// A metadata endpoint, which must pass the same guard as the server.
fn endpoint(meta: &Value, key: &str) -> Result<Option<String>, OAuthError> {
    match meta[key].as_str() {
        None => Ok(None),
        Some(url) => net::check_url(url)
            .map(|_| Some(url.to_string()))
            .map_err(|e| OAuthError::Protocol(format!("The sign-in metadata's {key}: {e}"))),
    }
}

/* ── Registration and the authorization request ───────────────────────── */

pub async fn register(d: &Discovery, redirect_uri: &str) -> Result<Client, OAuthError> {
    let endpoint = d.registration_endpoint.as_deref().ok_or_else(|| {
        OAuthError::Refused(format!("{} does not let Crew register as an app", host_text(&d.issuer)))
    })?;
    let body = json!({
        "client_name": "Crew",
        "redirect_uris": [redirect_uri],
        "grant_types": ["authorization_code", "refresh_token"],
        "response_types": ["code"],
        "token_endpoint_auth_method": d.client_auth.as_str(),
    });
    let res = net::request(Method::POST, endpoint)
        .map_err(OAuthError::Protocol)?
        .header(ACCEPT, "application/json")
        .json(&body)
        .send()
        .await
        .map_err(|e| OAuthError::Network(net::describe(e)))?;
    let status = res.status();
    let answer = read_json(res).await?;
    if !status.is_success() {
        let (error, description) = oauth_error(&answer);
        return Err(match status.is_client_error() {
            // Figma: only the apps it approved may register.
            true if description.is_none() && matches!(status, StatusCode::UNAUTHORIZED | StatusCode::FORBIDDEN) => {
                OAuthError::Refused(format!("{} only lets apps it approved register", host_text(&d.issuer)))
            }
            true => OAuthError::Refused(format!(
                "{} refused Crew's registration: {}",
                host_text(&d.issuer),
                description.unwrap_or(error.unwrap_or_else(|| status.to_string()))
            )),
            false => OAuthError::Network(format!("{} answered {status} to the registration", host_text(&d.issuer))),
        });
    }
    let id = answer["client_id"]
        .as_str()
        .filter(|id| !id.is_empty())
        .ok_or_else(|| OAuthError::Protocol("The registration answer has no client id".to_string()))?;
    let secret = answer["client_secret"].as_str().filter(|s| !s.is_empty()).map(str::to_string);
    // The answer's method wins; one that names none keeps what was asked.
    let auth = match answer["token_endpoint_auth_method"].as_str() {
        None => d.client_auth,
        Some(m) => [ClientAuth::None, ClientAuth::Basic, ClientAuth::Post]
            .into_iter()
            .find(|a| a.as_str() == m)
            .ok_or_else(|| OAuthError::Refused(format!("{} registered Crew to sign in with {m}", host_text(&d.issuer))))?,
    };
    if auth != ClientAuth::None && secret.is_none() {
        return Err(OAuthError::Protocol("The registration answer has no client secret".to_string()));
    }
    Ok(Client { id: id.to_string(), secret, auth })
}

/// The page the sign-in tab opens.
pub fn authorize_url(d: &Discovery, client_id: &str, redirect_uri: &str, pkce: &Pkce) -> Result<String, OAuthError> {
    let mut url = Url::parse(&d.authorization_endpoint)
        .map_err(|_| OAuthError::Protocol("The authorization endpoint is not a URL".to_string()))?;
    {
        let mut q = url.query_pairs_mut();
        q.append_pair("response_type", "code")
            .append_pair("client_id", client_id)
            .append_pair("redirect_uri", redirect_uri)
            .append_pair("code_challenge", &pkce.challenge)
            .append_pair("code_challenge_method", "S256")
            .append_pair("state", &pkce.state)
            .append_pair("resource", &d.resource);
        if !d.scopes.is_empty() {
            q.append_pair("scope", &d.scopes.join(" "));
        }
    }
    Ok(url.into())
}

/// Turns the caught callback URL into tokens.
pub async fn exchange(
    d: &Discovery,
    client: &Client,
    redirect_uri: &str,
    pkce: &Pkce,
    callback_url: &str,
) -> Result<Tokens, OAuthError> {
    let code = read_callback(d, redirect_uri, pkce, callback_url)?;
    token_request(
        &d.token_endpoint,
        client,
        &[
            ("grant_type", "authorization_code"),
            ("code", &code),
            ("redirect_uri", redirect_uri),
            ("code_verifier", &pkce.verifier),
            ("resource", &d.resource),
        ],
    )
    .await
}

/// The code in a callback, once it is shown to answer this flow: sent to our
/// redirect, with our state, from our issuer (RFC 9207, against a mix-up
/// with another server's flow).
fn read_callback(d: &Discovery, redirect_uri: &str, pkce: &Pkce, callback_url: &str) -> Result<String, OAuthError> {
    let protocol = |m: &str| OAuthError::Protocol(m.to_string());
    let callback = Url::parse(callback_url).map_err(|_| protocol("The sign-in answer is not a URL"))?;
    let expected = Url::parse(redirect_uri).map_err(|_| protocol("The redirect URI is not a URL"))?;
    let same_place = callback.scheme() == expected.scheme()
        && callback.host_str() == expected.host_str()
        && callback.port_or_known_default() == expected.port_or_known_default()
        && callback.path() == expected.path();
    if !same_place {
        return Err(protocol("The sign-in answer went to another address"));
    }
    let params: HashMap<String, String> = callback.query_pairs().into_owned().collect();
    if params.get("state") != Some(&pkce.state) {
        return Err(protocol("The sign-in answer is not for this sign-in"));
    }
    match params.get("iss") {
        Some(iss) if !same_issuer(iss, &d.issuer) => return Err(protocol("The sign-in answer came from another server")),
        None if d.iss_parameter_supported => return Err(protocol("The sign-in answer does not name its server")),
        _ => {}
    }
    if let Some(error) = params.get("error") {
        let reason = params.get("error_description").unwrap_or(error);
        return Err(OAuthError::Denied(net::shorten(reason, 200)));
    }
    params.get("code").filter(|c| !c.is_empty()).cloned().ok_or_else(|| protocol("The sign-in answer has no code"))
}

/* ── Tokens ───────────────────────────────────────────────────────────── */

/// A new access token. A server that rotates answers a new refresh token
/// too; one that does not keeps the old one, which is kept here.
pub async fn refresh(token_endpoint: &str, client: &Client, resource: &str, refresh_token: &str) -> Result<Tokens, OAuthError> {
    let mut tokens = token_request(
        token_endpoint,
        client,
        &[("grant_type", "refresh_token"), ("refresh_token", refresh_token), ("resource", resource)],
    )
    .await?;
    if tokens.refresh_token.is_none() {
        tokens.refresh_token = Some(refresh_token.to_string());
    }
    Ok(tokens)
}

/// Revokes a token at the service (RFC 7009), before Disconnect deletes it.
pub async fn revoke(revocation_endpoint: &str, client: &Client, token: &str, hint: &str) -> Result<(), OAuthError> {
    let res = form_post(revocation_endpoint, client, &[("token", token), ("token_type_hint", hint)]).await?;
    let status = res.status();
    if status.is_success() {
        return Ok(());
    }
    let answer = read_json(res).await.unwrap_or(Value::Null);
    let (error, _) = oauth_error(&answer);
    Err(OAuthError::Protocol(format!("The revocation failed: {}", error.unwrap_or_else(|| status.to_string()))))
}

async fn token_request(endpoint: &str, client: &Client, form: &[(&str, &str)]) -> Result<Tokens, OAuthError> {
    let res = form_post(endpoint, client, form).await?;
    let status = res.status();
    let answer = read_json(res).await?;
    if !status.is_success() {
        let (error, description) = oauth_error(&answer);
        if error.as_deref() == Some("invalid_grant") {
            return Err(OAuthError::InvalidGrant);
        }
        let reason = match (error, description) {
            (Some(e), Some(d)) => format!("{e}: {d}"),
            (Some(e), None) => e,
            _ => status.to_string(),
        };
        return Err(OAuthError::Protocol(format!("The token request failed: {reason}")));
    }
    parse_tokens(&answer)
}

async fn form_post(endpoint: &str, client: &Client, form: &[(&str, &str)]) -> Result<reqwest::Response, OAuthError> {
    let (fields, authorization) = client.credentials();
    let body = url::form_urlencoded::Serializer::new(String::new()).extend_pairs(form).extend_pairs(fields).finish();
    let mut req = net::request(Method::POST, endpoint).map_err(OAuthError::Protocol)?;
    if let Some(value) = authorization {
        req = req.header(AUTHORIZATION, value);
    }
    req.header(ACCEPT, "application/json")
        .header(CONTENT_TYPE, "application/x-www-form-urlencoded")
        .body(body)
        .send()
        .await
        .map_err(|e| OAuthError::Network(net::describe(e)))
}

fn parse_tokens(answer: &Value) -> Result<Tokens, OAuthError> {
    let access_token = answer["access_token"]
        .as_str()
        .filter(|t| !t.is_empty())
        .ok_or_else(|| OAuthError::Protocol("The token answer has no access token".to_string()))?;
    if answer["token_type"].as_str().is_some_and(|t| !t.eq_ignore_ascii_case("bearer")) {
        return Err(OAuthError::Protocol("The token answer is not a bearer token".to_string()));
    }
    let expires_in = answer["expires_in"].as_f64().or_else(|| answer["expires_in"].as_str().and_then(|s| s.parse().ok()));
    let text = |key: &str| answer[key].as_str().filter(|s| !s.is_empty()).map(str::to_string);
    Ok(Tokens {
        access_token: access_token.to_string(),
        refresh_token: text("refresh_token"),
        expires_at: expires_in.map(|secs| now_millis() + (secs * 1000.0) as i64),
        scope: text("scope"),
        id_token: text("id_token"),
    })
}

/* ── Identity ─────────────────────────────────────────────────────────── */

/// A label for the account (an email, else a name), from the `id_token` when
/// there is one, else from userinfo. The `id_token` is only decoded, not
/// verified: the label is shown, never trusted.
pub async fn identity(d: &Discovery, tokens: &Tokens) -> Option<String> {
    if let Some(label) = tokens.id_token.as_deref().and_then(jwt_payload).as_ref().and_then(label_of) {
        return Some(label);
    }
    // The access token goes only to a userinfo on the issuer's or the
    // resource's own site.
    let endpoint = d.userinfo_endpoint.as_deref()?;
    let origin = Url::parse(endpoint).ok()?.origin();
    let ours = [&d.issuer, &d.resource].iter().any(|u| Url::parse(u).is_ok_and(|u| u.origin() == origin));
    if !ours {
        return None;
    }
    let res = net::request(Method::GET, endpoint)
        .ok()?
        .header(ACCEPT, "application/json")
        .header(AUTHORIZATION, format!("Bearer {}", tokens.access_token))
        .send()
        .await
        .ok()?;
    if !res.status().is_success() {
        return None;
    }
    label_of(&read_json(res).await.ok()?)
}

fn jwt_payload(jwt: &str) -> Option<Value> {
    let payload = jwt.split('.').nth(1)?;
    let bytes = URL_SAFE_NO_PAD.decode(payload.trim_end_matches('=')).ok()?;
    serde_json::from_slice(&bytes).ok()
}

fn label_of(claims: &Value) -> Option<String> {
    ["email", "name", "preferred_username"]
        .iter()
        .find_map(|k| claims[k].as_str().map(str::trim).filter(|s| !s.is_empty()))
        .map(|s| net::shorten(s, 120))
}

/* ── Helpers ──────────────────────────────────────────────────────────── */

/// One parameter of a `WWW-Authenticate: Bearer …` challenge. Quoted or
/// bare, with or without a space after each comma (Figma has none).
pub fn auth_param(header: &str, name: &str) -> Option<String> {
    let rest = header.trim_start();
    let rest = rest.get(..6).filter(|s| s.eq_ignore_ascii_case("bearer")).map(|_| &rest[6..])?;
    let mut chars = rest.chars().peekable();
    loop {
        while chars.peek().is_some_and(|c| c.is_whitespace() || *c == ',') {
            chars.next();
        }
        chars.peek()?;
        let key: String = chars.by_ref().take_while(|c| *c != '=').collect();
        let mut value = String::new();
        if chars.peek() == Some(&'"') {
            chars.next();
            while let Some(c) = chars.next() {
                match c {
                    '\\' => value.extend(chars.next()),
                    '"' => break,
                    c => value.push(c),
                }
            }
        } else {
            value = chars.by_ref().take_while(|c| *c != ',' && !c.is_whitespace()).collect();
        }
        if key.trim().eq_ignore_ascii_case(name) {
            return Some(value);
        }
    }
}

async fn read_json(res: reqwest::Response) -> Result<Value, OAuthError> {
    let body = net::read_body(res, net::SMALL_BODY).await.map_err(OAuthError::Network)?;
    Ok(serde_json::from_slice(&body).unwrap_or(Value::Null))
}

/// An OAuth error answer's `error` and `error_description`.
fn oauth_error(answer: &Value) -> (Option<String>, Option<String>) {
    let text = |k: &str| answer[k].as_str().map(|s| net::shorten(s, 200));
    (text("error"), text("error_description"))
}

fn same_issuer(a: &str, b: &str) -> bool {
    !a.is_empty() && a.trim_end_matches('/') == b.trim_end_matches('/')
}

fn strings(value: &Value) -> Vec<String> {
    value.as_array().into_iter().flatten().filter_map(|v| v.as_str().map(str::to_string)).collect()
}

fn host_of(url: &Url) -> String {
    url.host_str().unwrap_or("The server").to_string()
}

fn host_text(url: &str) -> String {
    Url::parse(url).map(|u| host_of(&u)).unwrap_or_else(|_| "The server".to_string())
}

/// 32 random bytes, base64url: a PKCE verifier (43 characters) or a state.
fn random_token() -> String {
    URL_SAFE_NO_PAD.encode(rand::random::<[u8; 32]>())
}

pub(crate) fn s256(verifier: &str) -> String {
    URL_SAFE_NO_PAD.encode(Sha256::digest(verifier.as_bytes()))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn discovery(iss_supported: bool) -> Discovery {
        Discovery {
            resource: "https://mcp.example.com/mcp".into(),
            issuer: "https://auth.example.com".into(),
            authorization_endpoint: "https://auth.example.com/authorize?tenant=a".into(),
            token_endpoint: "https://auth.example.com/token".into(),
            registration_endpoint: Some("https://auth.example.com/register".into()),
            revocation_endpoint: None,
            userinfo_endpoint: None,
            scopes: vec!["read".into(), "write".into()],
            iss_parameter_supported: iss_supported,
            client_auth: ClientAuth::None,
        }
    }

    const REDIRECT: &str = "http://127.0.0.1:7777/callback";

    #[test]
    fn a_challenge_is_read_with_or_without_spaces_and_quotes() {
        let figma = r#"Bearer resource_metadata="https://mcp.figma.com/.well-known/oauth-protected-resource",scope="mcp:connect",authorization_uri="https://api.figma.com/x""#;
        assert_eq!(auth_param(figma, "scope").as_deref(), Some("mcp:connect"));
        assert_eq!(
            auth_param(figma, "resource_metadata").as_deref(),
            Some("https://mcp.figma.com/.well-known/oauth-protected-resource")
        );
        let linear = r#"Bearer realm="OAuth", resource_metadata="https://x/m", scope="read write""#;
        assert_eq!(auth_param(linear, "scope").as_deref(), Some("read write"));
        let bare = r#"bearer error=insufficient_scope, scope="a \"b\", c""#;
        assert_eq!(auth_param(bare, "error").as_deref(), Some("insufficient_scope"));
        assert_eq!(auth_param(bare, "scope").as_deref(), Some(r#"a "b", c"#));
        assert_eq!(auth_param(r#"Bearer realm="OAuth", error="invalid_token""#, "resource_metadata"), None);
        assert_eq!(auth_param(r#"Basic realm="x""#, "realm"), None);
    }

    #[test]
    fn resource_metadata_falls_back_from_the_header_to_the_path_and_then_the_root() {
        let atlassian = Url::parse("https://mcp.atlassian.com/v1/mcp").unwrap();
        assert_eq!(
            resource_candidates(&atlassian, None),
            [
                "https://mcp.atlassian.com/.well-known/oauth-protected-resource/v1/mcp",
                "https://mcp.atlassian.com/.well-known/oauth-protected-resource",
            ]
        );
        let stripe = Url::parse("https://mcp.stripe.com").unwrap();
        let header = "https://mcp.stripe.com/.well-known/oauth-protected-resource";
        assert_eq!(resource_candidates(&stripe, Some(header)), [header]);
    }

    #[test]
    fn an_issuer_with_a_path_is_looked_up_inserted_then_appended() {
        let github = Url::parse("https://github.com/login/oauth").unwrap();
        assert_eq!(
            issuer_candidates(&github),
            [
                "https://github.com/.well-known/oauth-authorization-server/login/oauth",
                "https://github.com/.well-known/openid-configuration/login/oauth",
                "https://github.com/login/oauth/.well-known/openid-configuration",
            ]
        );
        let notion = Url::parse("https://mcp.notion.com/").unwrap();
        assert_eq!(issuer_candidates(&notion)[0], "https://mcp.notion.com/.well-known/oauth-authorization-server");
    }

    #[test]
    fn a_public_client_is_preferred_and_a_secret_is_sent_as_the_client_registered() {
        assert_eq!(client_auth_for(&json!({})), Some(ClientAuth::None));
        let supabase = json!({ "token_endpoint_auth_methods_supported": ["client_secret_basic", "client_secret_post"] });
        assert_eq!(client_auth_for(&supabase), Some(ClientAuth::Basic));
        let both = json!({ "token_endpoint_auth_methods_supported": ["client_secret_post", "none"] });
        assert_eq!(client_auth_for(&both), Some(ClientAuth::None));
        assert_eq!(client_auth_for(&json!({ "token_endpoint_auth_methods_supported": ["private_key_jwt"] })), None);

        assert_eq!(Client::public("c1").credentials(), (vec![("client_id", "c1")], None));
        let basic = Client { id: "c 1".into(), secret: Some("s:2".into()), auth: ClientAuth::Basic };
        assert_eq!(basic.credentials(), (vec![], Some(format!("Basic {}", STANDARD.encode("c+1:s%3A2")))));
        let post = Client { id: "c1".into(), secret: Some("s2".into()), auth: ClientAuth::Post };
        assert_eq!(post.credentials(), (vec![("client_id", "c1"), ("client_secret", "s2")], None));
        assert!(!format!("{post:?}").contains("s2"));
    }

    #[test]
    fn the_authorize_url_keeps_the_endpoints_query_and_names_the_resource() {
        let pkce = Pkce::new();
        let url = Url::parse(&authorize_url(&discovery(false), "c1", REDIRECT, &pkce).unwrap()).unwrap();
        let q: HashMap<String, String> = url.query_pairs().into_owned().collect();
        assert_eq!(q["tenant"], "a");
        assert_eq!(q["code_challenge_method"], "S256");
        assert_eq!(q["code_challenge"], s256(&pkce.verifier));
        assert_eq!(q["resource"], "https://mcp.example.com/mcp");
        assert_eq!(q["scope"], "read write");
        assert_eq!(q["state"], pkce.state);
        assert_eq!(pkce.verifier.len(), 43);
    }

    #[test]
    fn a_callback_must_answer_this_flow_from_this_issuer() {
        let pkce = Pkce::new();
        let s = &pkce.state;
        let d = discovery(true);
        let ok = format!("{REDIRECT}?code=abc&state={s}&iss=https%3A%2F%2Fauth.example.com");
        assert_eq!(read_callback(&d, REDIRECT, &pkce, &ok).unwrap(), "abc");
        let wrong_state = format!("{REDIRECT}?code=abc&state=other&iss=https%3A%2F%2Fauth.example.com");
        assert!(matches!(read_callback(&d, REDIRECT, &pkce, &wrong_state), Err(OAuthError::Protocol(_))));
        let other_issuer = format!("{REDIRECT}?code=abc&state={s}&iss=https%3A%2F%2Fevil.example");
        assert!(matches!(read_callback(&d, REDIRECT, &pkce, &other_issuer), Err(OAuthError::Protocol(_))));
        let no_issuer = format!("{REDIRECT}?code=abc&state={s}");
        assert!(read_callback(&d, REDIRECT, &pkce, &no_issuer).is_err(), "iss is required when advertised");
        assert!(read_callback(&discovery(false), REDIRECT, &pkce, &no_issuer).is_ok());
        let denied = format!("{REDIRECT}?error=access_denied&state={s}&iss=https://auth.example.com");
        assert_eq!(read_callback(&d, REDIRECT, &pkce, &denied), Err(OAuthError::Denied("access_denied".into())));
        let elsewhere = format!("http://127.0.0.1:7778/callback?code=abc&state={s}");
        assert!(read_callback(&discovery(false), REDIRECT, &pkce, &elsewhere).is_err());
    }

    #[test]
    fn a_token_answer_is_read_and_its_debug_hides_the_tokens() {
        let t = parse_tokens(&json!({
            "access_token": "AT-secret", "token_type": "bearer", "expires_in": 3600,
            "refresh_token": "RT-secret", "scope": "read",
        }))
        .unwrap();
        assert_eq!(t.refresh_token.as_deref(), Some("RT-secret"));
        assert!(t.expires_at.unwrap() > now_millis() + 3_590_000);
        let shown = format!("{t:?} {:?}", Pkce::new());
        assert!(!shown.contains("secret"), "{shown}");
        assert!(parse_tokens(&json!({ "access_token": "x", "token_type": "mac" })).is_err());
        assert!(parse_tokens(&json!({ "error": "x" })).is_err());
    }

    #[test]
    fn the_label_comes_from_the_id_tokens_email_or_name() {
        let payload = URL_SAFE_NO_PAD.encode(r#"{"sub":"1","name":"Ada","email":"ada@example.com"}"#);
        let claims = jwt_payload(&format!("e30.{payload}.sig")).unwrap();
        assert_eq!(label_of(&claims).as_deref(), Some("ada@example.com"));
        assert_eq!(label_of(&json!({ "email": "", "preferred_username": "ada" })).as_deref(), Some("ada"));
        assert_eq!(label_of(&json!({ "sub": "1" })), None);
    }

    /// Run by hand: `cargo test -p crew-core real_servers -- --ignored`.
    #[tokio::test]
    #[ignore = "reaches the real servers"]
    async fn the_real_servers_are_taken_or_refused_as_measured() {
        for (url, takes) in [
            ("https://mcp.notion.com/mcp", true),
            ("https://mcp.linear.app/mcp", true),
            ("https://mcp.sentry.dev/mcp", true),
            ("https://mcp.atlassian.com/v1/mcp", true),
            ("https://mcp.stripe.com", true),
            ("https://mcp.figma.com/mcp", true),
            ("https://mcp.supabase.com/mcp", true),
            ("https://api.githubcopilot.com/mcp/", false),
        ] {
            let found = discover(url).await;
            eprintln!("{url}: {found:?}");
            match takes {
                true => assert!(found.is_ok(), "{url}: {found:?}"),
                false => assert!(matches!(found, Err(OAuthError::Refused(_))), "{url}: {found:?}"),
            }
        }
    }
}
