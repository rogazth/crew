//! Google's apps as built-in connectors (plan `2026-10-28-google-and-figma.md`):
//! Gmail, Drive, Calendar, Docs and Sheets, each its own connector, over one
//! sign-in per Google account.
//!
//! - **The client** is Crew's own, a "Desktop app" with PKCE and the loopback
//!   redirect, set at build time (`CREW_GOOGLE_CLIENT_ID` and
//!   `CREW_GOOGLE_CLIENT_SECRET`) or, for a dev build, in the daemon's
//!   environment. Its secret is not one: Google says so for installed apps.
//!   A build without one lists the apps but can't install them.
//! - **One grant per Google account**, in the vault under `google:<email>`.
//!   Each app is a set of scopes on it: a second app asks Google for its own
//!   scopes alone (`include_granted_scopes`), and the grant's refresh token
//!   then covers both. Google can't take back one scope, so removing an app
//!   keeps the grant while another app of that account is installed, and
//!   revokes it with the last one.
//! - **The tools** are served by `crewd` and run `gws` with the access token
//!   (`gws.rs`); nothing else ever sees the token.

use serde_json::{json, Value};

use super::oauth::{self, Client, ClientAuth, Discovery, Pkce};

/// Where Google signs in. Tests point these at the fake server.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Endpoints {
    pub issuer: String,
    pub authorize: String,
    pub token: String,
    pub revoke: String,
}

impl Default for Endpoints {
    fn default() -> Self {
        Endpoints {
            issuer: "https://accounts.google.com".into(),
            authorize: "https://accounts.google.com/o/oauth2/v2/auth".into(),
            token: "https://oauth2.googleapis.com/token".into(),
            revoke: "https://oauth2.googleapis.com/revoke".into(),
        }
    }
}

/// What the sign-in always asks for besides an app's scopes: who signed in.
const IDENTITY_SCOPES: [&str; 2] = ["openid", "email"];

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum App {
    Gmail,
    Drive,
    Calendar,
    Docs,
    Sheets,
}

pub const APPS: [App; 5] = [App::Gmail, App::Drive, App::Calendar, App::Docs, App::Sheets];

impl App {
    pub fn id(self) -> &'static str {
        match self {
            App::Gmail => "google.gmail",
            App::Drive => "google.drive",
            App::Calendar => "google.calendar",
            App::Docs => "google.docs",
            App::Sheets => "google.sheets",
        }
    }

    pub fn name(self) -> &'static str {
        match self {
            App::Gmail => "Gmail",
            App::Drive => "Google Drive",
            App::Calendar => "Google Calendar",
            App::Docs => "Google Docs",
            App::Sheets => "Google Sheets",
        }
    }

    pub fn description(self) -> &'static str {
        match self {
            App::Gmail => "Search and read mail, draft and send messages, and sort threads with labels.",
            App::Drive => "Search, read and upload files, make folders, and share or trash files.",
            App::Calendar => "List events, find free time, and create, change or delete events.",
            App::Docs => "Read documents, create new ones, and edit their text.",
            App::Sheets => "Read and write ranges, list a spreadsheet's sheets, and create spreadsheets.",
        }
    }

    /// The API it calls, shown as its server.
    pub fn server(self) -> &'static str {
        match self {
            App::Gmail => "gmail.googleapis.com",
            App::Drive => "www.googleapis.com/drive",
            App::Calendar => "www.googleapis.com/calendar",
            App::Docs => "docs.googleapis.com",
            App::Sheets => "sheets.googleapis.com",
        }
    }

    pub fn icon_url(self) -> &'static str {
        match self {
            App::Gmail => "https://ssl.gstatic.com/images/branding/product/2x/gmail_2020q4_48dp.png",
            App::Drive => "https://ssl.gstatic.com/images/branding/product/2x/drive_2020q4_48dp.png",
            App::Calendar => "https://ssl.gstatic.com/images/branding/product/2x/calendar_2020q4_48dp.png",
            App::Docs => "https://ssl.gstatic.com/images/branding/product/2x/docs_2020q4_48dp.png",
            App::Sheets => "https://ssl.gstatic.com/images/branding/product/2x/sheets_2020q4_48dp.png",
        }
    }

    /// What the app asks Google for. Gmail's and Drive's are restricted
    /// scopes; Calendar's, Docs' and Sheets' only sensitive.
    pub fn scopes(self) -> &'static [&'static str] {
        match self {
            App::Gmail => &["https://www.googleapis.com/auth/gmail.modify"],
            App::Drive => &["https://www.googleapis.com/auth/drive"],
            App::Calendar => &["https://www.googleapis.com/auth/calendar"],
            App::Docs => &["https://www.googleapis.com/auth/documents"],
            App::Sheets => &["https://www.googleapis.com/auth/spreadsheets"],
        }
    }
}

/* ── The client ───────────────────────────────────────────────────────── */

const UNSET: &str = "Google's sign-in isn't set up in this build of Crew yet";

/// Crew's client: the daemon's environment first (a dev build), then what the
/// build was made with.
pub fn client() -> Option<Client> {
    let id = std::env::var("CREW_GOOGLE_CLIENT_ID")
        .ok()
        .or_else(|| option_env!("CREW_GOOGLE_CLIENT_ID").map(str::to_string))
        .filter(|id| !id.trim().is_empty())?;
    let secret = std::env::var("CREW_GOOGLE_CLIENT_SECRET")
        .ok()
        .or_else(|| option_env!("CREW_GOOGLE_CLIENT_SECRET").map(str::to_string))
        .filter(|s| !s.trim().is_empty());
    // A Desktop app client is given a secret, and Google asks for it with the code.
    let auth = if secret.is_some() { ClientAuth::Post } else { ClientAuth::None };
    Some(Client { id: id.trim().to_string(), secret: secret.map(|s| s.trim().to_string()), auth })
}

/// Why the apps can't be installed in this build, when they can't.
pub fn unavailable() -> Option<String> {
    client().is_none().then(|| UNSET.to_string())
}

pub fn require_client() -> Result<Client, String> {
    client().ok_or_else(|| format!("{UNSET}."))
}

/* ── Signing in ───────────────────────────────────────────────────────── */

/// An app's sign-in, as the generic OAuth code takes it. Google takes no
/// `resource`, so it has none.
pub fn discovery(app: App, at: &Endpoints, client: &Client) -> Discovery {
    Discovery {
        resource: String::new(),
        issuer: at.issuer.clone(),
        authorization_endpoint: at.authorize.clone(),
        token_endpoint: at.token.clone(),
        registration_endpoint: None,
        revocation_endpoint: Some(at.revoke.clone()),
        userinfo_endpoint: None,
        scopes: IDENTITY_SCOPES.iter().chain(app.scopes()).map(|s| s.to_string()).collect(),
        // Google sends `iss` with its answer; it is checked when it comes.
        iss_parameter_supported: false,
        client_auth: client.auth,
    }
}

/// The page the sign-in opens: a refresh token always (`access_type`,
/// `prompt=consent`), the scopes granted before kept (`include_granted_scopes`),
/// and the account already signed in offered first when there is one.
pub fn authorize_url(d: &Discovery, client: &Client, redirect_uri: &str, pkce: &Pkce, login_hint: Option<&str>) -> Result<String, String> {
    let url = oauth::authorize_url(d, &client.id, redirect_uri, pkce).map_err(|e| e.to_string())?;
    let mut url = url::Url::parse(&url).map_err(|e| e.to_string())?;
    {
        let mut q = url.query_pairs_mut();
        q.append_pair("access_type", "offline").append_pair("include_granted_scopes", "true");
        match login_hint {
            Some(hint) => q.append_pair("login_hint", hint).append_pair("prompt", "consent"),
            None => q.append_pair("prompt", "select_account consent"),
        };
    }
    Ok(url.into())
}

/// Where an account's grant is kept: one per Google account, shared by its apps.
pub fn grant_key(identity: &str) -> String {
    format!("google:{}", identity.trim().to_lowercase())
}

/// The scopes two answers granted, together, each once.
pub fn scope_union(a: Option<&str>, b: Option<&str>) -> Option<String> {
    let mut all: Vec<&str> = Vec::new();
    for scope in a.into_iter().chain(b).flat_map(str::split_whitespace) {
        if !all.contains(&scope) {
            all.push(scope);
        }
    }
    (!all.is_empty()).then(|| all.join(" "))
}

/// Whether a grant's scopes cover an app's: one signed in before an app was
/// added for it needs that app's consent first.
pub fn covers(scope: Option<&str>, app: App) -> bool {
    let granted: Vec<&str> = scope.unwrap_or_default().split_whitespace().collect();
    app.scopes().iter().all(|s| granted.contains(s))
}

/* ── Tools ────────────────────────────────────────────────────────────── */

/// The app's tools, as an MCP server would list them.
pub fn tool_defs(app: App) -> Vec<Value> {
    super::gws::tools(app)
        .iter()
        .map(|t| {
            json!({
                "name": t.name,
                "title": t.title,
                "description": t.description,
                "inputSchema": (t.schema)(),
                "annotations": {
                    "title": t.title,
                    "readOnlyHint": t.read_only,
                    "destructiveHint": t.destructive,
                    "openWorldHint": true,
                },
            })
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_second_app_asks_for_its_own_scopes_on_the_account_signed_in() {
        let client = Client::public("crew");
        let d = discovery(App::Drive, &Endpoints::default(), &client);
        assert!(d.resource.is_empty());
        assert_eq!(d.scopes, ["openid", "email", "https://www.googleapis.com/auth/drive"]);
        let url = authorize_url(&d, &client, "http://127.0.0.1:1/callback", &Pkce::new(), Some("ada@example.com")).unwrap();
        let q: std::collections::HashMap<String, String> = url::Url::parse(&url).unwrap().query_pairs().into_owned().collect();
        assert_eq!(q["include_granted_scopes"], "true");
        assert_eq!(q["access_type"], "offline");
        assert_eq!(q["login_hint"], "ada@example.com");
        assert!(!q.contains_key("resource"), "Google takes no resource");
        let fresh = authorize_url(&d, &client, "http://127.0.0.1:1/callback", &Pkce::new(), None).unwrap();
        assert!(fresh.contains("prompt=select_account+consent"));
    }

    #[test]
    fn scopes_join_once_and_an_app_is_covered_only_by_its_own() {
        let both = scope_union(Some("openid https://www.googleapis.com/auth/gmail.modify"), Some("openid https://www.googleapis.com/auth/drive"));
        assert_eq!(both.as_deref(), Some("openid https://www.googleapis.com/auth/gmail.modify https://www.googleapis.com/auth/drive"));
        assert!(covers(both.as_deref(), App::Gmail));
        assert!(covers(both.as_deref(), App::Drive));
        assert!(!covers(both.as_deref(), App::Sheets));
        assert_eq!(grant_key(" Ada@Example.com "), "google:ada@example.com");
    }
}
