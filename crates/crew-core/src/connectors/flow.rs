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

use super::builtin::Builtin;
use super::google;
use super::gws::{self, Gws, GwsError};
use super::machines::{RelayError, VaultLink, MAX_RELAYED_BYTES};
use super::oauth::{self, Client, ClientAuth, Discovery, OAuthError, Pkce, Tokens};
use super::remote::{RemoteClient, RemoteError};
use super::vault::{Grant, VaultStore};
use crate::store::{now_millis, Store};

/// Where every sign-in is sent back. Crew's browser catches the navigation,
/// except Google's, which main's loopback listener receives. Either way the URL
/// comes to `callback`.
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
    /// A built-in's sign-in: Crew's own client, a grant shared by its family.
    builtin: Option<Builtin>,
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
    /// Where Google signs in, and with which client: Google's own and the
    /// build's, unless a test points them elsewhere.
    google: Mutex<(google::Endpoints, Option<Client>)>,
    /// The `gws` the Google apps' tools run.
    gws: Mutex<Gws>,
    /// Set on a machine that is not the vault: its calls run there.
    link: Mutex<Option<Arc<dyn VaultLink>>>,
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
            google: Mutex::new((google::Endpoints::default(), None)),
            gws: Mutex::new(Gws::default()),
            link: Mutex::new(None),
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

    /// Points Google's sign-in elsewhere, with another client: the fake server, in tests.
    pub fn set_google(&self, at: google::Endpoints, client: Client) {
        *self.google.lock().unwrap_or_else(|e| e.into_inner()) = (at, Some(client));
    }

    /// Where `gws` is kept, or which one to run.
    pub fn set_gws(&self, gws: Gws) {
        *self.gws.lock().unwrap_or_else(|e| e.into_inner()) = gws;
    }

    /// Sends its calls to a vault on another machine; `None` makes this one the vault again.
    pub fn set_link(&self, link: Option<Arc<dyn VaultLink>>) {
        *self.link.lock().unwrap_or_else(|e| e.into_inner()) = link;
    }

    fn link(&self) -> Option<Arc<dyn VaultLink>> {
        self.link.lock().unwrap_or_else(|e| e.into_inner()).clone()
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
        if let Some(builtin) = Builtin::of(&connector) {
            return self.connect_builtin(builtin, &connector, req);
        }
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
            None => (super::add_account(&self.store, &connector.id, req.label.as_deref(), req.workspaces.as_deref())?, true),
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
            PendingFlow { account_id: account.id.clone(), new_account, builtin: None, discovery, client, pkce, started_at: now },
        );
        drop(flows);
        if new_account {
            self.changed();
        }
        Ok(SignIn { state, auth_url, redirect_uri: REDIRECT_URI.into(), account_id: account.id, incognito })
    }

    /// A built-in's sign-in: Google's page, with Crew's client, for the
    /// app's scopes. "Continue as" names the account to offer first; Google's
    /// own picker shows the others, so it needs no private window.
    fn connect_builtin(&self, builtin: Builtin, connector: &crew_protocol::Connector, req: ConnectorConnect) -> Result<SignIn, String> {
        let Builtin::Google(app) = builtin;
        let (at, client) = self.google.lock().unwrap_or_else(|e| e.into_inner()).clone();
        let client = match client {
            Some(client) => client,
            None => google::require_client()?,
        };
        let discovery = google::discovery(app, &at, &client);
        let (account, new_account) = match &req.account_id {
            Some(id) => (super::account(&self.store, id)?.ok_or("That account is gone")?, false),
            None => (super::add_account(&self.store, &connector.id, req.label.as_deref(), req.workspaces.as_deref())?, true),
        };
        // Signing an account in again asks for the same Google account.
        let hint = req.login_hint.as_deref().or(account.identity.as_deref());
        let pkce = oauth::Pkce::new();
        let auth_url = google::authorize_url(&discovery, &client, REDIRECT_URI, &pkce, hint)
            .map_err(|e| format!("Couldn't start the sign-in to {}: {e}", connector.name))?;
        let state = pkce.state.clone();
        let mut flows = self.flows.lock().unwrap_or_else(|e| e.into_inner());
        let now = now_millis();
        flows.retain(|_, flow| now - flow.started_at < FLOW_TTL_MS);
        flows.insert(
            state.clone(),
            PendingFlow { account_id: account.id.clone(), new_account, builtin: Some(builtin), discovery, client, pkce, started_at: now },
        );
        drop(flows);
        if new_account {
            self.changed();
        }
        Ok(SignIn { state, auth_url, redirect_uri: REDIRECT_URI.into(), account_id: account.id, incognito: false })
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
        if let Some(builtin) = flow.builtin {
            return self.land_builtin(builtin, &flow, &tokens).await;
        }
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

    /// A built-in's sign-in landed: the grant joins the one its Google
    /// account has, if any, and the app's tools are its own list.
    async fn land_builtin(&self, builtin: Builtin, flow: &PendingFlow, tokens: &Tokens) -> Result<ConnectorAccount, String> {
        let Some(identity) = oauth::identity(&flow.discovery, tokens).await else {
            self.give_up(flow);
            return Err("Google didn't say which account signed in. Try again.".into());
        };
        let connector = super::connector_of(&self.store, &flow.account_id)?.ok_or("The connector is gone")?;
        let taken = connector.accounts.iter().any(|a| {
            a.id != flow.account_id && a.identity.as_deref().is_some_and(|other| other.eq_ignore_ascii_case(&identity))
        });
        if taken {
            self.give_up(flow);
            return Err(format!("{identity} is already added to {}.", connector.name));
        }
        let key = google::grant_key(&identity);
        let lock = self.refresh_lock(&key);
        let _held = lock.lock().await;
        let old = self.vault.get(&key)?;
        let mut grant = grant_from(&flow.discovery, &flow.client, tokens, old.as_ref());
        grant.scope = google::scope_union(old.as_ref().and_then(|g| g.scope.as_deref()), tokens.scope.as_deref());
        self.vault.put(&key, &grant)?;
        drop(_held);
        super::set_identity(&self.store, &flow.account_id, Some(&identity))?;
        super::set_state(&self.store, &flow.account_id, AccountState::Connected, None)?;
        super::set_raw_tools(&self.store, &flow.account_id, &builtin.tool_defs())?;
        // Another app of the same account may have waited on this consent.
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

    /* ── Changing the vault ───────────────────────────────────────────── */

    pub fn grant_count(&self) -> Result<usize, String> {
        Ok(self.vault.all()?.len())
    }

    /// This machine becomes the vault. No grant comes with it: tokens never
    /// cross between machines. `config` replaces its copy when the old vault
    /// could give one, and every account asks for a sign-in here.
    pub async fn start_empty(&self, config: Option<super::machines::Snapshot>) -> Result<(), String> {
        self.set_link(None);
        // Any it held of its own would be left behind by the config over them.
        self.retire_grants(true).await?;
        if let Some(config) = &config {
            super::machines::import(&self.store, config)?;
        }
        for account in super::list(&self.store)?.into_iter().flat_map(|c| c.accounts) {
            super::set_state(&self.store, &account.id, AccountState::Expired, Some("The vault changed; sign in again"))?;
        }
        self.changed();
        Ok(())
    }

    /// Deletes every grant here: this machine is no longer the vault, or was
    /// replaced while it was off. With `revoke`, each is first given back to
    /// its service. Not when an account may have signed in on the new vault by
    /// now: Google revokes a whole account's access to a client, so it would
    /// sign out the new vault too.
    pub async fn retire_grants(&self, revoke: bool) -> Result<usize, String> {
        let keys: Vec<String> = self.vault.all()?.into_keys().collect();
        let mut retired = 0;
        for key in keys {
            // Waits for a refresh running, so it can't save a grant after this.
            let lock = self.refresh_lock(&key);
            let _held = lock.lock().await;
            let Some(grant) = self.vault.get(&key)? else { continue };
            if revoke {
                revoke_at_service(&key, &grant).await;
            }
            self.vault.delete(&key)?;
            retired += 1;
        }
        self.remotes.lock().unwrap_or_else(|e| e.into_inner()).clear();
        Ok(retired)
    }

    /* ── Removing ─────────────────────────────────────────────────────── */

    /// Revokes the grant at the service, then forgets it. A service that
    /// can't be reached doesn't keep the account: the user asked it gone.
    pub async fn remove_account(&self, account_id: &str) -> Result<(), String> {
        // A Google account's grant stays while another of its apps is installed.
        let key = match self.grant_key(account_id)? {
            Some(key) if key != account_id && !self.google_siblings(account_id)?.is_empty() => None,
            key => key,
        };
        if let Some((key, grant)) = match &key {
            Some(key) => self.vault.get(key)?.map(|grant| (key.clone(), grant)),
            None => None,
        } {
            revoke_at_service(account_id, &grant).await;
            self.vault.delete(&key)?;
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

    /// Where an account's grant is kept: its own id, or for one of Google's
    /// apps, the Google account it signed in as (none before it signs in).
    fn grant_key(&self, account_id: &str) -> Result<Option<String>, String> {
        let connector = super::connector_of(&self.store, account_id)?;
        if connector.as_ref().and_then(Builtin::of).is_none_or(|b| b.family() != "google") {
            return Ok(Some(account_id.to_string()));
        }
        Ok(super::account(&self.store, account_id)?.and_then(|a| a.identity).map(|identity| google::grant_key(&identity)))
    }

    /// The other accounts of Google's apps signed in as the same Google account.
    fn google_siblings(&self, account_id: &str) -> Result<Vec<String>, String> {
        let Some(identity) = super::account(&self.store, account_id)?.and_then(|a| a.identity) else { return Ok(Vec::new()) };
        Ok(super::list(&self.store)?
            .into_iter()
            .filter(|c| Builtin::of(c).is_some_and(|b| b.family() == "google"))
            .flat_map(|c| c.accounts)
            .filter(|a| a.id != account_id && a.identity.as_deref().is_some_and(|i| i.eq_ignore_ascii_case(&identity)))
            .map(|a| a.id)
            .collect())
    }

    /// One lock per grant, held across a refresh.
    fn refresh_lock(&self, key: &str) -> Arc<tokio::sync::Mutex<()>> {
        let mut map = self.refreshing.lock().unwrap_or_else(|e| e.into_inner());
        map.entry(key.to_string()).or_default().clone()
    }

    /// A live access token for an account, refreshed first when it is near
    /// its end, or when `stale` is the one a server just refused.
    async fn access_token(&self, account_id: &str, stale: Option<&str>) -> Result<String, Unavailable> {
        Ok(self.token_and_scope(account_id, stale).await?.0)
    }

    /// The token, and the scopes its grant holds.
    async fn token_and_scope(&self, account_id: &str, stale: Option<&str>) -> Result<(String, Option<String>), Unavailable> {
        let token = self.vault_token(account_id, stale).await?;
        let key = self.grant_key(account_id).map_err(Unavailable)?.ok_or_else(|| self.expired(account_id))?;
        let scope = self.vault.get(&key).map_err(Unavailable)?.and_then(|g| g.scope);
        Ok((token, scope))
    }

    /// The vault's own token for an account, refreshed when it is near its end.
    async fn vault_token(&self, account_id: &str, stale: Option<&str>) -> Result<String, Unavailable> {
        let key = self.grant_key(account_id).map_err(Unavailable)?.ok_or_else(|| self.expired(account_id))?;
        let lock = self.refresh_lock(&key);
        let _held = lock.lock().await;
        let grant = self.vault.get(&key).map_err(Unavailable)?.ok_or_else(|| self.expired(account_id))?;
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
                self.vault.put(&key, &next).map_err(Unavailable)?;
                Ok(next.access_token)
            }
            Err(OAuthError::InvalidGrant) => {
                let _ = self.vault.delete(&key);
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

    /// Lists the server's tools now and keeps them. A built-in's are its own.
    pub async fn list_tools(&self, account_id: &str) -> Result<(), String> {
        if let Some(link) = self.link() {
            link.refresh_tools(account_id);
            return Ok(());
        }
        if let Some(builtin) = super::connector_of(&self.store, account_id)?.as_ref().and_then(Builtin::of) {
            super::set_raw_tools(&self.store, account_id, &builtin.tool_defs())?;
            self.changed();
            return Ok(());
        }
        let listed = self
            .with_token(account_id, |remote, token| async move { remote.list_tools(&token).await })
            .await
            .map_err(|Unavailable(line)| line)?;
        super::set_raw_tools(&self.store, account_id, &listed)?;
        self.changed();
        Ok(())
    }

    /// The tools a session's shim lists: the cached ones, switched-off ones
    /// left out. On the vault, a cache older than an hour is listed again
    /// first; when that fails, the old list still answers.
    pub async fn tools_for_shim(&self, account_id: &str) -> Result<Vec<Value>, String> {
        // A machine answers from its copy, so a spawn doesn't wait on the vault.
        if let Some(link) = self.link() {
            link.refresh_tools(account_id);
            return super::listed_tools(&self.store, account_id);
        }
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

    /// A tool call for a session. Failures are answers for the model. On a
    /// machine that is not the vault it runs on the vault, whose switches and
    /// scopes decide.
    pub async fn call(&self, account_id: &str, name: &str, arguments: Value) -> Value {
        if let Some(link) = self.link() {
            return self.forward(link.as_ref(), account_id, name, arguments).await;
        }
        match super::tool_off(&self.store, account_id, name) {
            Ok(false) => {}
            Ok(true) => return tool_error(&format!("{name} is switched off for {} in Crew.", self.label(account_id))),
            Err(e) => return tool_error(&e),
        }
        if let Some(Builtin::Google(app)) = super::connector_of(&self.store, account_id).ok().flatten().as_ref().and_then(Builtin::of) {
            return self.call_google(account_id, app, name, arguments).await.unwrap_or_else(|Unavailable(line)| tool_error(&line));
        }
        let call = self
            .with_token(account_id, |remote, token| {
                let arguments = arguments.clone();
                async move { remote.call_tool(&token, name, arguments, None).await }
            })
            .await;
        call.unwrap_or_else(|Unavailable(line)| tool_error(&line))
    }

    /// A call sent to the vault. It is never tried again: once sent, it may
    /// have run.
    async fn forward(&self, link: &dyn VaultLink, account_id: &str, name: &str, arguments: Value) -> Value {
        let label = self.label(account_id);
        let vault = link.vault_name();
        if arguments.to_string().len() > MAX_RELAYED_BYTES {
            return tool_error(&format!("{label}: the arguments of {name} are too large to send to the vault on {vault}."));
        }
        match link.call(account_id, name, arguments).await {
            Ok(answer) => answer,
            Err(RelayError::Offline) => {
                let since = link.offline_since().map(|t| format!(" since {}", super::machines::clock(t))).unwrap_or_default();
                tool_error(&format!("{label}: the vault on {vault} is offline{since}"))
            }
            Err(RelayError::Lost) => tool_error(&format!(
                "{label}: the connection to the vault on {vault} dropped during this call. {name} may have run; check before trying it again."
            )),
            Err(RelayError::Refused(line)) => tool_error(&line),
        }
    }

    /// A call another machine sent: its answer, unless it is too large to go back.
    pub async fn call_for_machine(&self, account_id: &str, name: &str, arguments: Value) -> Value {
        let answer = self.call(account_id, name, arguments).await;
        if answer.to_string().len() > MAX_RELAYED_BYTES {
            return tool_error(&format!("{}: the answer of {name} is too large to send to this machine.", self.label(account_id)));
        }
        answer
    }

    /// One of Google's apps' tools, run with `gws` and the account's token,
    /// and once more with a refreshed one when Google refuses the first.
    async fn call_google(&self, account_id: &str, app: google::App, name: &str, arguments: Value) -> Result<Value, Unavailable> {
        let (token, scope) = self.token_and_scope(account_id, None).await?;
        if !google::covers(scope.as_deref(), app) {
            self.mark(account_id, AccountState::NeedsScope, Some("Google hasn't allowed this app for the account yet"));
            return Err(Unavailable(format!("{} needs a sign-in to allow it: Settings › Integrations › Reconnect.", self.label(account_id))));
        }
        let gws = self.gws.lock().unwrap_or_else(|e| e.into_inner()).clone();
        let result = match gws::call(&gws, app, name, &arguments, &token).await {
            Err(GwsError::Unauthorized) => {
                let token = self.access_token(account_id, Some(&token)).await?;
                gws::call(&gws, app, name, &arguments, &token).await
            }
            other => other,
        };
        match result {
            Ok(value) => {
                self.mark(account_id, AccountState::Connected, None);
                Ok(value)
            }
            Err(GwsError::Unauthorized) => Err(self.expired(account_id)),
            Err(GwsError::Forbidden(line)) | Err(GwsError::Call(line)) => Ok(tool_error(&line)),
            Err(GwsError::Setup(line)) => {
                self.mark(account_id, AccountState::Failed, Some(&line));
                Err(Unavailable(format!("{}: {line}", self.label(account_id))))
            }
        }
    }
}

/// Gives a grant back to its service. Said in the log, since nothing else shows
/// whether the service took it. The answer never carries the token.
async fn revoke_at_service(name: &str, grant: &Grant) {
    let Some(endpoint) = &grant.revocation_endpoint else { return };
    let client = grant.client();
    let mut tokens = vec![(&grant.access_token, "access_token")];
    if let Some(refresh) = &grant.refresh_token {
        tokens.insert(0, (refresh, "refresh_token"));
    }
    for (token, hint) in tokens {
        match oauth::revoke(endpoint, &client, token, hint).await {
            Ok(()) => eprintln!("[crewd] {name}: the {hint} was revoked"),
            Err(error) => eprintln!("[crewd] {name}: the {hint} was not revoked: {error}"),
        }
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
            let sign_in = c.connect(ConnectorConnect { connector_id: connector.id, account_id: None, label: None, login_hint: None, workspaces: None }).await.unwrap();
            let answer = net::client().get(&sign_in.auth_url).send().await.unwrap();
            let caught = answer.headers()["location"].to_str().unwrap().to_string();
            c.callback(&sign_in.state, &caught).await.unwrap()
        });
        (c, vault, fake, account.id)
    }

    /// Gmail and Drive installed, over a fake Google signing in as Ada, and a
    /// fake `gws` that answers with the token it was given.
    fn google() -> (Arc<Connectors>, Arc<MemoryVault>, FakeServer, Store) {
        use std::os::unix::fs::PermissionsExt;
        net::allow_insecure_for_tests();
        let dir = std::env::temp_dir().join(format!("cf-{}", uuid::Uuid::new_v4()));
        let store = Store::open(dir.join("crew.db")).expect("store");
        let vault = Arc::new(MemoryVault::default());
        let c = Connectors::new(store.clone(), vault.clone(), Arc::new(|| {})).expect("connectors");
        let fake = c.block_on(fake_server::start(Options { google: Some("ada@example.com".into()), ..Options::default() }));
        let at = google::Endpoints {
            issuer: fake.url.clone(),
            authorize: format!("{}/authorize", fake.url),
            token: format!("{}/token", fake.url),
            revoke: format!("{}/revoke", fake.url),
        };
        let (id, secret) = fake_server::GOOGLE_CLIENT;
        c.set_google(at, Client { id: id.into(), secret: Some(secret.into()), auth: ClientAuth::Post });
        let script = dir.join("gws");
        std::fs::write(&script, "#!/bin/sh\nprintf '{\"token\":\"%s\",\"args\":\"%s\"}' \"$GOOGLE_WORKSPACE_CLI_TOKEN\" \"$1 $2 $3 $4\"\n").unwrap();
        std::fs::set_permissions(&script, std::fs::Permissions::from_mode(0o755)).unwrap();
        c.set_gws(Gws::at(script));
        for app in ["google.gmail", "google.drive"] {
            super::super::builtin::install(&store, app).unwrap();
        }
        (c, vault, fake, store)
    }

    fn sign_in_google(c: &Connectors, connector_id: &str, hint: Option<&str>) -> Result<ConnectorAccount, String> {
        c.block_on(async {
            let req = ConnectorConnect { connector_id: connector_id.into(), account_id: None, label: None, login_hint: hint.map(str::to_string), workspaces: None };
            let sign_in = c.connect(req).await?;
            assert!(!sign_in.incognito, "Google's own picker shows the other accounts");
            if let Some(hint) = hint {
                assert!(sign_in.auth_url.contains(&format!("login_hint={}", hint.replace('@', "%40"))), "{}", sign_in.auth_url);
            }
            let answer = net::client().get(&sign_in.auth_url).send().await.unwrap();
            let caught = answer.headers()["location"].to_str().unwrap().to_string();
            c.callback(&sign_in.state, &caught).await
        })
    }

    #[test]
    fn googles_apps_share_one_sign_in_and_the_last_one_removed_revokes_it() {
        let (c, vault, fake, _store) = google();
        let gmail = sign_in_google(&c, "builtin:google.gmail", None).unwrap();
        assert_eq!((gmail.state, gmail.label.as_str()), (AccountState::Connected, "ada@example.com"));
        assert!(gmail.tools.iter().any(|t| t.name == "search_threads"));
        assert!(gmail.tools_off.contains(&"send_message".to_string()), "what sends starts off");
        let first = vault.get("google:ada@example.com").unwrap().expect("one grant for the Google account");
        assert!(!first.scope.as_deref().unwrap().contains("auth/drive"));

        let drive = sign_in_google(&c, "builtin:google.drive", Some("ada@example.com")).unwrap();
        let grant = vault.get("google:ada@example.com").unwrap().unwrap();
        assert!(google::covers(grant.scope.as_deref(), google::App::Gmail) && google::covers(grant.scope.as_deref(), google::App::Drive));
        assert!(vault.get(&gmail.id).unwrap().is_none() && vault.get(&drive.id).unwrap().is_none(), "no grant per app");

        let answer = c.block_on(c.call(&gmail.id, "search_threads", json!({ "query": "is:unread" })));
        let text: Value = serde_json::from_str(answer["content"][0]["text"].as_str().unwrap()).unwrap_or_else(|_| panic!("{answer}"));
        assert_eq!(text["token"], grant.access_token.as_str());
        assert!(text["args"].as_str().unwrap().starts_with("gmail users threads list"));

        let again = sign_in_google(&c, "builtin:google.gmail", Some("ada@example.com"));
        assert_eq!(again.unwrap_err(), "ada@example.com is already added to Gmail.");
        assert_eq!(c.account(&gmail.id).unwrap().state, AccountState::Connected);

        let refresh = grant.refresh_token.clone().unwrap();
        c.block_on(c.remove_account(&gmail.id)).unwrap();
        assert!(vault.get("google:ada@example.com").unwrap().is_some(), "Drive still uses it");
        assert!(!fake.is_revoked(&refresh));
        c.block_on(c.remove_account(&drive.id)).unwrap();
        assert!(vault.get("google:ada@example.com").unwrap().is_none());
        assert!(fake.is_revoked(&refresh), "the last app gives the grant back");
    }

    #[test]
    fn a_google_app_without_its_consent_asks_for_a_sign_in() {
        let (c, vault, _fake, _store) = google();
        let gmail = sign_in_google(&c, "builtin:google.gmail", None).unwrap();
        let mut grant = vault.get("google:ada@example.com").unwrap().unwrap();
        grant.scope = Some("openid email".into());
        vault.put("google:ada@example.com", &grant).unwrap();
        let answer = c.block_on(c.call(&gmail.id, "list_labels", json!({})));
        assert_eq!(answer["isError"], true);
        assert_eq!(c.account(&gmail.id).unwrap().state, AccountState::NeedsScope);
    }

    /// How the vault answers another machine, in this process.
    #[derive(Clone, Copy, PartialEq)]
    enum Reach {
        Online,
        Offline,
        /// The call runs there and its answer is lost on the way back.
        LosesAnswers,
    }

    struct TestLink {
        vault: Arc<Connectors>,
        reach: Mutex<Reach>,
        refreshes: Mutex<Vec<String>>,
    }

    impl VaultLink for TestLink {
        fn call<'a>(
            &'a self,
            account_id: &'a str,
            tool: &'a str,
            arguments: Value,
        ) -> std::pin::Pin<Box<dyn std::future::Future<Output = Result<Value, RelayError>> + Send + 'a>> {
            Box::pin(async move {
                let reach = *self.reach.lock().unwrap();
                if reach == Reach::Offline {
                    return Err(RelayError::Offline);
                }
                let (id, tool) = (account_id.to_string(), tool.to_string());
                let answer = self.vault.run(move |c| async move { Ok(c.call_for_machine(&id, &tool, arguments).await) }).await.map_err(RelayError::Refused)?;
                if reach == Reach::LosesAnswers {
                    return Err(RelayError::Lost);
                }
                Ok(answer)
            })
        }
        fn refresh_tools(&self, account_id: &str) {
            self.refreshes.lock().unwrap().push(account_id.to_string());
        }
        fn vault_name(&self) -> String {
            "devbox".into()
        }
        fn offline_since(&self) -> Option<i64> {
            Some(0)
        }
    }

    /// A machine that is not the vault: a copy of the config, no grant, and a
    /// `gws` that can't run, so nothing of a call can run here.
    fn member_of(vault: &Arc<Connectors>) -> (Arc<Connectors>, Arc<TestLink>, Arc<MemoryVault>) {
        let dir = std::env::temp_dir().join(format!("cf-{}", uuid::Uuid::new_v4()));
        let store = Store::open(dir.join("crew.db")).unwrap();
        super::super::machines::import(&store, &super::super::machines::snapshot(&vault.store).unwrap()).unwrap();
        let grants = Arc::new(MemoryVault::default());
        let machine = Connectors::new(store, grants.clone(), Arc::new(|| {})).unwrap();
        machine.set_gws(Gws::at(dir.join("no-gws-here")));
        let link = Arc::new(TestLink { vault: vault.clone(), reach: Mutex::new(Reach::Online), refreshes: Mutex::new(Vec::new()) });
        machine.set_link(Some(link.clone()));
        (machine, link, grants)
    }

    fn tool_calls(fake: &FakeServer) -> usize {
        fake.requests().iter().filter(|r| r.body.contains("tools/call")).count()
    }

    fn line_of(answer: &Value) -> &str {
        answer["content"][0]["text"].as_str().unwrap_or_default()
    }

    #[test]
    fn a_machine_that_is_not_the_vault_runs_its_calls_there_and_holds_no_token() {
        let (vault, _grants, fake, id) = signed_in(Options::default());
        let (machine, link, grants) = member_of(&vault);

        let answer = machine.block_on(machine.call(&id, "search", json!({ "text": "a" })));
        assert_eq!(answer["structuredContent"]["arguments"]["text"], "a", "{answer}");
        assert_eq!(tool_calls(&fake), 1);
        assert_eq!(grants.all().unwrap().len(), 0, "the machine keeps no grant");

        // The vault away: the call says so at once, and nothing is sent.
        *link.reach.lock().unwrap() = Reach::Offline;
        let answer = machine.block_on(machine.call(&id, "search", json!({ "text": "b" })));
        assert!(line_of(&answer).contains("the vault on devbox is offline since"), "{answer}");
        assert_eq!(answer["isError"], true);
        assert_eq!(tool_calls(&fake), 1);

        // The answer lost on its way back: said so, and not tried again.
        *link.reach.lock().unwrap() = Reach::LosesAnswers;
        let answer = machine.block_on(machine.call(&id, "create_page", json!({ "text": "c" })));
        assert!(line_of(&answer).contains("create_page may have run"), "{answer}");
        assert_eq!(tool_calls(&fake), 2, "it ran once");
    }

    #[test]
    fn the_vaults_switches_decide_even_when_a_machines_copy_is_behind() {
        let (vault, _grants, fake, id) = signed_in(Options::default());
        let (machine, _link, _) = member_of(&vault);
        let tools: Vec<String> = vault.account(&id).unwrap().tools.iter().map(|t| t.name.clone()).collect();
        assert!(tools.contains(&"search".to_string()));
        super::super::set_tool(&vault.store, &id, "search", false).unwrap();
        assert!(!super::super::tool_off(&machine.store, &id, "search").unwrap(), "the copy hasn't heard");
        let answer = machine.block_on(machine.call(&id, "search", json!({})));
        assert!(line_of(&answer).contains("switched off"), "{answer}");
        assert_eq!(tool_calls(&fake), 0);
    }

    #[test]
    fn a_machine_lists_tools_from_its_copy_and_asks_the_vault_to_refresh() {
        let (vault, _grants, fake, id) = signed_in(Options::default());
        let (machine, link, _) = member_of(&vault);
        let before = fake.requests().len();
        let tools = machine.block_on(machine.tools_for_shim(&id)).unwrap();
        assert!(!tools.is_empty());
        assert_eq!(fake.requests().len(), before, "a spawn doesn't wait on the network");
        assert_eq!(*link.refreshes.lock().unwrap(), [id.clone()]);
        machine.block_on(machine.list_tools(&id)).unwrap();
        assert_eq!(link.refreshes.lock().unwrap().len(), 2);
        assert_eq!(machine.account(&id).unwrap().state, AccountState::Connected, "a machine marks nothing itself");
    }

    #[test]
    fn a_google_call_runs_gws_on_the_vault_only() {
        let (vault, _grants, _fake, _store) = google();
        let gmail = sign_in_google(&vault, "builtin:google.gmail", None).unwrap();
        let (machine, _link, _) = member_of(&vault);
        let answer = machine.block_on(machine.call(&gmail.id, "list_labels", json!({})));
        assert!(answer["isError"] != true, "the machine has no gws, the vault does: {answer}");
    }

    #[test]
    fn a_call_too_large_for_the_connection_is_an_answer_and_not_a_dropped_link() {
        let (vault, _grants, fake, id) = signed_in(Options::default());
        let (machine, _link, _) = member_of(&vault);
        let answer = machine.block_on(machine.call(&id, "search", json!({ "text": "x".repeat(MAX_RELAYED_BYTES + 1) })));
        assert!(line_of(&answer).contains("arguments of search are too large"), "{answer}");
        assert_eq!(tool_calls(&fake), 0);
        let answer = machine.block_on(machine.call(&id, "search", json!({ "answerBytes": MAX_RELAYED_BYTES + 1 })));
        assert!(line_of(&answer).contains("answer of search is too large"), "{}", line_of(&answer).len());
    }

    /// The old vault gives its grants back and keeps nothing.
    #[test]
    fn a_retired_vault_revokes_its_grants_and_keeps_none() {
        let (c, vault, fake, id) = signed_in(Options::default());
        let refresh = vault.get(&id).unwrap().unwrap().refresh_token.unwrap();
        assert_eq!(c.block_on(c.retire_grants(true)).unwrap(), 1);
        assert_eq!(c.grant_count().unwrap(), 0);
        assert!(fake.is_revoked(&refresh));
        let answer = c.block_on(c.call(&id, "search", json!({})));
        assert!(line_of(&answer).contains("needs a sign-in again"), "{answer}");
    }

    /// One replaced while it was off: an account may have signed in on the new
    /// vault by now, and giving the old grant back could sign that out too.
    #[test]
    fn a_vault_replaced_while_off_deletes_its_grants_without_revoking() {
        let (c, vault, fake, id) = signed_in(Options::default());
        let refresh = vault.get(&id).unwrap().unwrap().refresh_token.unwrap();
        c.block_on(c.retire_grants(false)).unwrap();
        assert_eq!(c.grant_count().unwrap(), 0);
        assert!(!fake.is_revoked(&refresh));
    }

    #[test]
    fn a_refresh_running_as_a_vault_retires_doesnt_bring_its_grant_back() {
        let (c, vault, _fake, id) = signed_in(Options::default());
        let mut grant = vault.get(&id).unwrap().unwrap();
        grant.expires_at = Some(now_millis());
        vault.put(&id, &grant).unwrap();
        c.block_on(async {
            let call = c.call(&id, "search", json!({}));
            let retire = c.retire_grants(true);
            let _ = tokio::join!(call, retire);
        });
        assert_eq!(c.grant_count().unwrap(), 0);
    }

    /// The new vault takes the config, no grant, and every account asks for a sign-in.
    #[test]
    fn a_new_vault_starts_with_the_config_and_no_sign_in() {
        let (old, _grants, fake, id) = signed_in(Options::default());
        let config = crate::connectors::machines::snapshot(&old.store).unwrap();
        let dir = std::env::temp_dir().join(format!("cf-{}", uuid::Uuid::new_v4()));
        let store = Store::open(dir.join("crew.db")).unwrap();
        let grants = Arc::new(MemoryVault::default());
        let new = Connectors::new(store, grants.clone(), Arc::new(|| {})).unwrap();
        new.block_on(new.start_empty(Some(config))).unwrap();
        assert_eq!(grants.all().unwrap().len(), 0);
        let account = new.account(&id).unwrap();
        assert_eq!(account.state, AccountState::Expired);
        assert!(account.error.unwrap().contains("sign in again"));
        let before = tool_calls(&fake);
        let answer = new.block_on(new.call(&id, "search", json!({})));
        assert!(line_of(&answer).contains("needs a sign-in again"), "{answer}");
        assert_eq!(tool_calls(&fake), before);
    }

    /// A machine holding its own grants when it becomes the vault gives them back too.
    #[test]
    fn a_machine_that_becomes_the_vault_gives_back_what_it_held() {
        let (c, vault, fake, id) = signed_in(Options::default());
        let refresh = vault.get(&id).unwrap().unwrap().refresh_token.unwrap();
        c.block_on(c.start_empty(None)).unwrap();
        assert_eq!(c.grant_count().unwrap(), 0);
        assert!(fake.is_revoked(&refresh));
        assert_eq!(c.account(&id).unwrap().state, AccountState::Expired, "its own config stays, asking for a sign-in");
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
            .block_on(c.connect(ConnectorConnect { connector_id: connector_id.clone(), account_id: None, label: Some("Personal".into()), login_hint: None, workspaces: None }))
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
            .block_on(c.connect(ConnectorConnect { connector_id: connector.id.clone(), account_id: None, label: None, login_hint: None, workspaces: None }))
            .unwrap_err();
        assert!(error.contains("doesn't let Crew sign in"), "{error}");
        let after = super::super::get(&store, &connector.id).unwrap().unwrap();
        assert!(after.refused.is_some() && after.accounts.is_empty(), "{after:?}");
    }
}
