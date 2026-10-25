//! The vault at work: signing accounts in, keeping their access tokens
//! fresh, and calling their servers for the sessions they are bound to.
//!
//! One `Connectors` per daemon. Only it touches the grants: it refreshes an
//! account's access token when it is near its end, one refresh at a time per
//! account, so two calls that need a token at once share one refresh and a
//! rotating refresh token is never spent twice.

use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use crew_protocol::{AccountState, ConnectorAccount, ConnectorConnect, SignIn};
use rusqlite::{params, OptionalExtension};
use serde_json::{json, Value};

use super::oauth::{self, Client, ClientAuth, Discovery, OAuthError, Pkce, Tokens};
use super::remote::{RemoteClient, RemoteError};
use super::vault::{Grant, VaultStore};
use crate::store::{now_millis, Store};

/// Where every sign-in is sent back. Nothing listens there: Crew's browser
/// catches the navigation and hands the URL to `callback`.
pub const REDIRECT_URI: &str = "http://127.0.0.1:17899/callback";

/// How long a sign-in the user started may take to come back.
const FLOW_TTL_MS: i64 = 15 * 60 * 1000;
/// A token this close to its end is refreshed before it is used.
const REFRESH_MARGIN_MS: i64 = 60 * 1000;
/// The tools are listed again when the cache is older than this.
pub const TOOLS_TTL: Duration = Duration::from_secs(60 * 60);

struct PendingFlow {
    account_id: String,
    /// The account was made for this sign-in, so giving up on it removes it.
    new_account: bool,
    discovery: Discovery,
    client: Client,
    pkce: Pkce,
    started_at: i64,
}

/// What went wrong with an account, as a tool call tells the model.
pub struct Unavailable(pub String);

pub struct Connectors {
    store: Store,
    vault: Arc<dyn VaultStore>,
    flows: Mutex<HashMap<String, PendingFlow>>,
    /// One lock per account, held across a refresh.
    refreshing: Mutex<HashMap<String, Arc<tokio::sync::Mutex<()>>>>,
    remotes: Mutex<HashMap<String, RemoteClient>>,
    on_change: Arc<dyn Fn() + Send + Sync>,
    /// Its own: the bridge's calls come in on plain threads, and the window's
    /// on the daemon's runtime; both wait here for the network.
    runtime: Option<tokio::runtime::Runtime>,
}

/// Let go without waiting: the last handle may go on another runtime, where
/// a runtime can't be dropped by blocking.
impl Drop for Connectors {
    fn drop(&mut self) {
        if let Some(runtime) = self.runtime.take() {
            runtime.shutdown_background();
        }
    }
}

impl Connectors {
    pub fn new(store: Store, vault: Arc<dyn VaultStore>, on_change: Arc<dyn Fn() + Send + Sync>) -> Result<Arc<Self>, String> {
        let runtime = tokio::runtime::Builder::new_multi_thread()
            .worker_threads(2)
            .thread_name("connectors")
            .enable_all()
            .build()
            .map_err(|e| e.to_string())?;
        Ok(Arc::new(Self {
            store,
            vault,
            flows: Mutex::new(HashMap::new()),
            refreshing: Mutex::new(HashMap::new()),
            remotes: Mutex::new(HashMap::new()),
            on_change,
            runtime: Some(runtime),
        }))
    }

    /// Runs `work` on the connectors' runtime and waits for it, from a
    /// thread that is on no runtime (the bridge's).
    pub fn block_on<T>(&self, work: impl std::future::Future<Output = T>) -> T {
        self.runtime().block_on(work)
    }

    /// Runs `work` on the connectors' runtime, for a caller on another one.
    pub async fn run<T, Fut>(self: &Arc<Self>, work: impl FnOnce(Arc<Self>) -> Fut) -> Result<T, String>
    where
        T: Send + 'static,
        Fut: std::future::Future<Output = Result<T, String>> + Send + 'static,
    {
        self.runtime().spawn(work(self.clone())).await.map_err(|e| e.to_string())?
    }

    fn runtime(&self) -> &tokio::runtime::Runtime {
        self.runtime.as_ref().expect("held until drop")
    }

    fn changed(&self) {
        (self.on_change)();
    }

    /// Tells every window, after a change made outside this type.
    pub fn notify(&self) {
        self.changed();
    }

    pub fn account(&self, account_id: &str) -> Result<ConnectorAccount, String> {
        super::account(&self.store, account_id)?.ok_or_else(|| "That account is gone".into())
    }

    /* ── Signing in ───────────────────────────────────────────────────── */

    /// Starts a sign-in: discovers the server, registers Crew once per
    /// authorization server, and answers the URL for the window to open.
    pub async fn connect(&self, req: ConnectorConnect) -> Result<SignIn, String> {
        let connector = super::get(&self.store, &req.connector_id)?.ok_or("That connector is not installed")?;
        let found = match oauth::discover(&connector.url).await {
            Ok(discovery) => self.client_for(&discovery).await.map(|client| (discovery, client)),
            Err(e) => Err(e),
        };
        let (discovery, client) = match found {
            Ok(found) => found,
            Err(OAuthError::Refused(why)) => {
                // Kept on the connector: it won't change on the next try.
                super::set_refused(&self.store, &connector.id, Some(&why))?;
                self.changed();
                return Err(sign_in_error(&connector.name, OAuthError::Refused(why)));
            }
            Err(e) => return Err(sign_in_error(&connector.name, e)),
        };
        if connector.refused.is_some() {
            super::set_refused(&self.store, &connector.id, None)?;
        }
        let (account, new_account) = match &req.account_id {
            Some(id) => (super::account(&self.store, id)?.ok_or("That account is gone")?, false),
            None => (super::add_account(&self.store, &connector.id, req.label.as_deref())?, true),
        };
        // Another account of this connector is signed in to the browser's
        // shared session, and would answer for this one.
        let incognito = connector.accounts.iter().any(|other| other.id != account.id && other.state != AccountState::Pending);
        let pkce = oauth::Pkce::new();
        let auth_url = oauth::authorize_url(&discovery, &client.id, REDIRECT_URI, &pkce).map_err(|e| sign_in_error(&connector.name, e))?;
        let state = pkce.state.clone();
        let mut flows = self.flows.lock().unwrap_or_else(|e| e.into_inner());
        let now = now_millis();
        flows.retain(|_, flow| now - flow.started_at < FLOW_TTL_MS);
        flows.insert(
            state.clone(),
            PendingFlow { account_id: account.id.clone(), new_account, discovery, client, pkce, started_at: now },
        );
        drop(flows);
        if new_account {
            self.changed();
        }
        Ok(SignIn { state, auth_url, redirect_uri: REDIRECT_URI.into(), account_id: account.id, incognito })
    }

    /// The redirect the window caught: redeem the code, keep the grant, and
    /// list the tools.
    pub async fn callback(&self, state: &str, url: &str) -> Result<ConnectorAccount, String> {
        let flow = self.flows.lock().unwrap_or_else(|e| e.into_inner()).remove(state);
        let flow = flow.filter(|flow| now_millis() - flow.started_at < FLOW_TTL_MS).ok_or("This sign-in ran out. Try again.")?;
        let tokens = match oauth::exchange(&flow.discovery, &flow.client, REDIRECT_URI, &flow.pkce, url).await {
            Ok(tokens) => tokens,
            Err(e) => {
                self.give_up(&flow);
                return Err(e.to_string());
            }
        };
        let grant = grant_from(&flow.discovery, &flow.client, &tokens, None);
        self.vault.put(&flow.account_id, &grant)?;
        let identity = oauth::identity(&flow.discovery, &tokens).await;
        super::set_identity(&self.store, &flow.account_id, identity.as_deref())?;
        super::set_state(&self.store, &flow.account_id, AccountState::Connected, None)?;
        self.remotes.lock().unwrap_or_else(|e| e.into_inner()).remove(&flow.account_id);
        // A sign-in that landed is connected even when the listing fails;
        // the account then shows why.
        let _ = self.list_tools(&flow.account_id).await;
        self.changed();
        super::account(&self.store, &flow.account_id)?.ok_or_else(|| "The account is gone".into())
    }

    /// The window closed the tab before the redirect.
    pub fn cancel(&self, state: &str) {
        let flow = self.flows.lock().unwrap_or_else(|e| e.into_inner()).remove(state);
        if let Some(flow) = flow {
            self.give_up(&flow);
        }
    }

    fn give_up(&self, flow: &PendingFlow) {
        if flow.new_account {
            let _ = super::remove_account(&self.store, &flow.account_id);
            self.changed();
        }
    }

    /// A public client is registered once per authorization server and
    /// kept in the store. One with a secret is registered for each sign-in,
    /// and its secret goes only to the vault, with the grant.
    async fn client_for(&self, d: &Discovery) -> Result<Client, OAuthError> {
        if d.client_auth != ClientAuth::None {
            return oauth::register(d, REDIRECT_URI).await;
        }
        let known: Option<String> = self
            .store
            .with(|conn| {
                conn.query_row(
                    "SELECT client_id FROM oauth_clients WHERE issuer = ?1 AND redirect_uri = ?2",
                    params![d.issuer, REDIRECT_URI],
                    |row| row.get(0),
                )
                .optional()
            })
            .map_err(OAuthError::Protocol)?;
        if let Some(id) = known {
            return Ok(Client::public(&id));
        }
        let client = oauth::register(d, REDIRECT_URI).await?;
        // Registered as public, answered with a secret: kept like one.
        if client.auth != ClientAuth::None {
            return Ok(client);
        }
        self.store
            .with(|conn| {
                conn.execute(
                    "INSERT OR REPLACE INTO oauth_clients (issuer, redirect_uri, client_id, registered_at) VALUES (?1, ?2, ?3, ?4)",
                    params![d.issuer, REDIRECT_URI, client.id, now_millis()],
                )
            })
            .map_err(OAuthError::Protocol)?;
        Ok(client)
    }

    /* ── Removing ─────────────────────────────────────────────────────── */

    /// Revokes the grant at the service, then forgets it. A service that
    /// can't be reached doesn't keep the account: the user asked it gone.
    pub async fn remove_account(&self, account_id: &str) -> Result<(), String> {
        if let Some(grant) = self.vault.get(account_id)? {
            if let Some(endpoint) = &grant.revocation_endpoint {
                let client = grant.client();
                if let Some(refresh) = &grant.refresh_token {
                    let _ = oauth::revoke(endpoint, &client, refresh, "refresh_token").await;
                }
                let _ = oauth::revoke(endpoint, &client, &grant.access_token, "access_token").await;
            }
            self.vault.delete(account_id)?;
        }
        self.remotes.lock().unwrap_or_else(|e| e.into_inner()).remove(account_id);
        super::remove_account(&self.store, account_id)?;
        self.changed();
        Ok(())
    }

    pub async fn remove_connector(&self, connector_id: &str) -> Result<(), String> {
        let connector = super::get(&self.store, connector_id)?.ok_or("That connector is not installed")?;
        for account in &connector.accounts {
            self.remove_account(&account.id).await?;
        }
        super::remove(&self.store, connector_id)?;
        self.changed();
        Ok(())
    }

    /* ── Tokens ───────────────────────────────────────────────────────── */

    /// A live access token for an account, refreshed first when it is near
    /// its end, or when `stale` is the one a server just refused.
    async fn access_token(&self, account_id: &str, stale: Option<&str>) -> Result<String, Unavailable> {
        let lock = {
            let mut map = self.refreshing.lock().unwrap_or_else(|e| e.into_inner());
            map.entry(account_id.to_string()).or_default().clone()
        };
        let _held = lock.lock().await;
        let grant = self.vault.get(account_id).map_err(Unavailable)?.ok_or_else(|| self.expired(account_id))?;
        let fresh = grant.expires_at.is_none_or(|at| at - now_millis() > REFRESH_MARGIN_MS);
        // Someone refreshed while this waited for the lock: the token it holds now is new.
        if fresh && stale != Some(grant.access_token.as_str()) {
            return Ok(grant.access_token);
        }
        let Some(refresh_token) = grant.refresh_token.clone() else {
            return Err(self.expired(account_id));
        };
        match oauth::refresh(&grant.token_endpoint, &grant.client(), &grant.resource, &refresh_token).await {
            Ok(tokens) => {
                let next = Grant {
                    access_token: tokens.access_token.clone(),
                    refresh_token: tokens.refresh_token.clone().or(grant.refresh_token.clone()),
                    expires_at: tokens.expires_at,
                    scope: tokens.scope.clone().or(grant.scope.clone()),
                    ..grant
                };
                self.vault.put(account_id, &next).map_err(Unavailable)?;
                Ok(next.access_token)
            }
            Err(OAuthError::InvalidGrant) => {
                let _ = self.vault.delete(account_id);
                Err(self.expired(account_id))
            }
            Err(e) => Err(Unavailable(format!("{}: couldn't refresh its sign-in ({e})", self.label(account_id)))),
        }
    }

    fn expired(&self, account_id: &str) -> Unavailable {
        self.mark(account_id, AccountState::Expired, Some("Its sign-in ran out"));
        Unavailable(format!("{} needs a sign-in again: Settings › Integrations › Reconnect.", self.label(account_id)))
    }

    fn mark(&self, account_id: &str, state: AccountState, error: Option<&str>) {
        let before = super::account(&self.store, account_id).ok().flatten();
        if before.as_ref().is_some_and(|a| a.state != state || a.error.as_deref() != error) {
            let _ = super::set_state(&self.store, account_id, state, error);
            self.changed();
        }
    }

    /// "Notion · Work", for the lines a model reads.
    fn label(&self, account_id: &str) -> String {
        let account = super::account(&self.store, account_id).ok().flatten();
        let connector = super::connector_of(&self.store, account_id).ok().flatten();
        match (connector, account) {
            (Some(c), Some(a)) => format!("{} · {}", c.name, a.label),
            _ => "This connector".into(),
        }
    }

    fn remote(&self, account_id: &str) -> Result<RemoteClient, Unavailable> {
        let mut remotes = self.remotes.lock().unwrap_or_else(|e| e.into_inner());
        if let Some(remote) = remotes.get(account_id) {
            return Ok(remote.clone());
        }
        let connector =
            super::connector_of(&self.store, account_id).ok().flatten().ok_or_else(|| Unavailable("That account is gone".into()))?;
        let remote = RemoteClient::new(&connector.url).map_err(|e| Unavailable(e.to_string()))?;
        remotes.insert(account_id.to_string(), remote.clone());
        Ok(remote)
    }

    /// Runs `call` with a token, and once more with a refreshed one when the
    /// server refuses the first.
    async fn with_token<T, F, Fut>(&self, account_id: &str, call: F) -> Result<T, Unavailable>
    where
        F: Fn(RemoteClient, String) -> Fut,
        Fut: std::future::Future<Output = Result<T, RemoteError>>,
    {
        let remote = self.remote(account_id)?;
        let token = self.access_token(account_id, None).await?;
        let result = match call(remote.clone(), token.clone()).await {
            Err(RemoteError::Unauthorized { .. }) => {
                let token = self.access_token(account_id, Some(&token)).await?;
                call(remote, token).await
            }
            other => other,
        };
        match result {
            Ok(value) => {
                self.mark(account_id, AccountState::Connected, None);
                Ok(value)
            }
            Err(RemoteError::Unauthorized { .. }) => Err(self.expired(account_id)),
            Err(RemoteError::InsufficientScope { .. }) => {
                self.mark(account_id, AccountState::NeedsScope, Some("The service asks for more access"));
                Err(Unavailable(format!(
                    "{} needs more access for this: Settings › Integrations › Reconnect.",
                    self.label(account_id)
                )))
            }
            Err(e) => {
                let line = e.to_string();
                self.mark(account_id, AccountState::Failed, Some(&line));
                Err(Unavailable(format!("{}: {line}", self.label(account_id))))
            }
        }
    }

    /* ── Tools ────────────────────────────────────────────────────────── */

    /// Lists the server's tools now and keeps them.
    pub async fn list_tools(&self, account_id: &str) -> Result<(), String> {
        let listed = self
            .with_token(account_id, |remote, token| async move { remote.list_tools(&token).await })
            .await
            .map_err(|Unavailable(line)| line)?;
        super::set_raw_tools(&self.store, account_id, &listed)?;
        self.changed();
        Ok(())
    }

    /// The tools a session's shim lists: the cached ones, switched-off ones
    /// left out. A cache older than an hour is listed again first; when that
    /// fails, the old list still answers.
    pub async fn tools_for_shim(&self, account_id: &str) -> Result<Vec<Value>, String> {
        let at: Option<i64> = self.store.with(|conn| {
            conn.query_row("SELECT tools_at FROM connector_accounts WHERE id = ?1", [account_id], |row| row.get(0))
                .optional()
                .map(Option::flatten)
        })?;
        if at.is_none_or(|at| now_millis() - at > TOOLS_TTL.as_millis() as i64) {
            let _ = self.list_tools(account_id).await;
        }
        super::listed_tools(&self.store, account_id)
    }

    /// A tool call for a session. Failures are answers for the model.
    pub async fn call(&self, account_id: &str, name: &str, arguments: Value) -> Value {
        match super::tool_off(&self.store, account_id, name) {
            Ok(false) => {}
            Ok(true) => return tool_error(&format!("{name} is switched off for {} in Crew.", self.label(account_id))),
            Err(e) => return tool_error(&e),
        }
        let call = self
            .with_token(account_id, |remote, token| {
                let arguments = arguments.clone();
                async move { remote.call_tool(&token, name, arguments, None).await }
            })
            .await;
        call.unwrap_or_else(|Unavailable(line)| tool_error(&line))
    }
}

fn tool_error(line: &str) -> Value {
    json!({ "content": [{ "type": "text", "text": line }], "isError": true })
}

fn sign_in_error(name: &str, error: OAuthError) -> String {
    match error {
        OAuthError::Refused(why) => format!("{name} doesn't let Crew sign in: {why}. Use it through a CLI's own sign-in."),
        other => format!("Couldn't start the sign-in to {name}: {other}"),
    }
}

fn grant_from(d: &Discovery, client: &Client, tokens: &Tokens, old: Option<&Grant>) -> Grant {
    Grant {
        issuer: d.issuer.clone(),
        token_endpoint: d.token_endpoint.clone(),
        revocation_endpoint: d.revocation_endpoint.clone(),
        resource: d.resource.clone(),
        client_id: client.id.clone(),
        client_secret: client.secret.clone(),
        client_auth: client.auth,
        refresh_token: tokens.refresh_token.clone().or_else(|| old.and_then(|g| g.refresh_token.clone())),
        access_token: tokens.access_token.clone(),
        expires_at: tokens.expires_at,
        scope: tokens.scope.clone(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::connectors::fake_server::{self, FakeServer, Options};
    use crate::connectors::vault::MemoryVault;
    use crate::connectors::{net, NewConnector};

    fn signed_in(opts: Options) -> (Arc<Connectors>, Arc<MemoryVault>, FakeServer, String) {
        net::allow_insecure_for_tests();
        let dir = std::env::temp_dir().join(format!("cf-{}", uuid::Uuid::new_v4()));
        let store = Store::open(dir.join("crew.db")).expect("store");
        let vault = Arc::new(MemoryVault::default());
        let c = Connectors::new(store.clone(), vault.clone(), Arc::new(|| {})).expect("connectors");
        let fake = c.block_on(fake_server::start(opts));
        let connector = super::super::add(
            &store,
            NewConnector {
                name: "Fake".into(),
                registry_name: None,
                url: fake.mcp_url.clone(),
                icon_url: None,
                description: String::new(),
                publisher: "x".into(),
            },
        )
        .unwrap();
        let account = c.block_on(async {
            let sign_in = c.connect(ConnectorConnect { connector_id: connector.id, account_id: None, label: None }).await.unwrap();
            let answer = net::client().get(&sign_in.auth_url).send().await.unwrap();
            let caught = answer.headers()["location"].to_str().unwrap().to_string();
            c.callback(&sign_in.state, &caught).await.unwrap()
        });
        (c, vault, fake, account.id)
    }

    fn token_requests(fake: &FakeServer) -> usize {
        fake.requests().iter().filter(|r| r.path == "/token").count()
    }

    #[test]
    fn calls_that_need_a_new_token_at_once_share_one_refresh() {
        let (c, vault, fake, id) = signed_in(Options::default());
        let mut grant = vault.get(&id).unwrap().unwrap();
        grant.expires_at = Some(now_millis());
        vault.put(&id, &grant).unwrap();
        let before = token_requests(&fake);
        let answers = c.block_on(async {
            let one = c.call(&id, "search", json!({ "text": "a" }));
            let two = c.call(&id, "search", json!({ "text": "b" }));
            tokio::join!(one, two)
        });
        assert!(answers.0["isError"] != true && answers.1["isError"] != true, "{answers:?}");
        assert_eq!(token_requests(&fake) - before, 1);
        assert_ne!(vault.get(&id).unwrap().unwrap().refresh_token, grant.refresh_token, "the refresh token rotated");
    }

    /// A refresh token spent elsewhere is dead, and the service revokes the
    /// grant: the account then says it needs a sign-in, in the call and on
    /// its row.
    #[test]
    fn a_dead_grant_turns_the_account_expired_and_the_call_says_what_to_do() {
        let (c, vault, _fake, id) = signed_in(Options::default());
        let grant = vault.get(&id).unwrap().unwrap();
        c.block_on(oauth::refresh(&grant.token_endpoint, &grant.client(), &grant.resource, grant.refresh_token.as_deref().unwrap()))
            .unwrap();
        vault.put(&id, &Grant { expires_at: Some(0), ..grant }).unwrap();
        let answer = c.block_on(c.call(&id, "search", json!({})));
        assert_eq!(answer["isError"], true);
        assert!(answer["content"][0]["text"].as_str().unwrap().contains("needs a sign-in again"), "{answer}");
        assert_eq!(c.account(&id).unwrap().state, AccountState::Expired);
        assert!(vault.get(&id).unwrap().is_none(), "a dead grant is not kept");
    }

    /// Supabase's case: a registration with a secret, sent as HTTP Basic on
    /// every token request, kept in the vault and nowhere in the store.
    #[test]
    fn a_server_that_takes_only_clients_with_a_secret_signs_in_and_refreshes() {
        let (c, vault, fake, id) = signed_in(Options { confidential: true, ..Options::default() });
        let grant = vault.get(&id).unwrap().unwrap();
        assert_eq!(grant.client_auth, ClientAuth::Basic);
        assert!(grant.client_secret.is_some());
        vault.put(&id, &Grant { expires_at: Some(now_millis()), ..grant.clone() }).unwrap();
        let answer = c.block_on(c.call(&id, "search", json!({})));
        assert!(answer["isError"] != true, "{answer}");
        assert_ne!(vault.get(&id).unwrap().unwrap().access_token, grant.access_token, "refreshed with the secret");
        let kept: i64 = c.store.with(|conn| conn.query_row("SELECT COUNT(*) FROM oauth_clients", [], |r| r.get(0))).unwrap();
        assert_eq!(kept, 0, "a client with a secret isn't kept in the store");
        let secret = grant.client_secret.unwrap();
        assert!(!fake.requests().iter().any(|r| r.body.contains(&secret) && r.path == "/token"), "sent as Basic, not in the form");
    }

    #[test]
    fn a_sign_in_given_up_on_takes_its_new_account_with_it() {
        let (c, _vault, _fake, id) = signed_in(Options::default());
        let connector_id = c.account(&id).unwrap().connector_id;
        let sign_in = c
            .block_on(c.connect(ConnectorConnect { connector_id: connector_id.clone(), account_id: None, label: Some("Personal".into()) }))
            .unwrap();
        assert!(sign_in.incognito, "the signed-in account would answer for the new one");
        assert_eq!(super::super::get(&c.store, &connector_id).unwrap().unwrap().accounts.len(), 2);
        c.cancel(&sign_in.state);
        assert_eq!(super::super::get(&c.store, &connector_id).unwrap().unwrap().accounts.len(), 1);
    }
}

#[cfg(test)]
mod refused_tests {
    use super::*;
    use crate::connectors::fake_server::{self, Options};
    use crate::connectors::vault::MemoryVault;
    use crate::connectors::{net, NewConnector};

    /// GitHub's case: no registration endpoint. Nothing is left behind but
    /// the reason, kept on the connector for the page to show.
    #[test]
    fn a_server_that_takes_no_registration_is_refused_and_says_so_on_the_connector() {
        net::allow_insecure_for_tests();
        let dir = std::env::temp_dir().join(format!("cr-{}", uuid::Uuid::new_v4()));
        let store = Store::open(dir.join("crew.db")).expect("store");
        let c = Connectors::new(store.clone(), Arc::new(MemoryVault::default()), Arc::new(|| {})).expect("connectors");
        let fake = c.block_on(fake_server::start(Options { refuse_dcr: true, ..Options::default() }));
        let connector = super::super::add(
            &store,
            NewConnector {
                name: "Fake".into(),
                registry_name: None,
                url: fake.mcp_url.clone(),
                icon_url: None,
                description: String::new(),
                publisher: "x".into(),
            },
        )
        .unwrap();
        let error = c
            .block_on(c.connect(ConnectorConnect { connector_id: connector.id.clone(), account_id: None, label: None }))
            .unwrap_err();
        assert!(error.contains("doesn't let Crew sign in"), "{error}");
        let after = super::super::get(&store, &connector.id).unwrap().unwrap();
        assert!(after.refused.is_some() && after.accounts.is_empty(), "{after:?}");
    }
}
