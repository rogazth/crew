//! Connectors Crew builds in, for services with no MCP server of their own
//! (plan `2026-10-28-google-and-figma.md`). Each is a connector like any
//! other: accounts, bindings, tool switches and the shim. What differs is
//! that `crewd` serves its tools itself, and that it signs in with Crew's own
//! OAuth client for the service instead of one registered with a server.
//!
//! A built-in's connector id is `builtin:<its id>` (`builtin:google.gmail`),
//! so a connector says it is one by its id alone.

use crew_protocol::{BuiltinConnector, Connector};

use super::google::{self, App};
use super::NewConnector;
use crate::store::Store;

const PREFIX: &str = "builtin:";

/// The built-ins there are. Only Google's apps for now; each family shares a
/// sign-in among its members.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Builtin {
    Google(App),
}

impl Builtin {
    pub fn all() -> impl Iterator<Item = Builtin> {
        google::APPS.into_iter().map(Builtin::Google)
    }

    pub fn get(id: &str) -> Option<Builtin> {
        Builtin::all().find(|b| b.id() == id)
    }

    /// The built-in a connector is, from its id.
    pub fn of(connector: &Connector) -> Option<Builtin> {
        id_of(&connector.id).and_then(Builtin::get)
    }

    pub fn id(self) -> &'static str {
        match self {
            Builtin::Google(app) => app.id(),
        }
    }

    pub fn family(self) -> &'static str {
        match self {
            Builtin::Google(_) => "google",
        }
    }

    pub fn connector_id(self) -> String {
        format!("{PREFIX}{}", self.id())
    }

    /// The tools' definitions, as an MCP server would list them.
    pub fn tool_defs(self) -> Vec<serde_json::Value> {
        match self {
            Builtin::Google(app) => google::tool_defs(app),
        }
    }

    /// As Browse lists it, before it is installed.
    pub fn listing(self) -> BuiltinConnector {
        match self {
            Builtin::Google(app) => BuiltinConnector {
                id: app.id().into(),
                name: app.name().into(),
                description: app.description().into(),
                server: app.server().into(),
                icon_url: Some(app.icon_url().into()),
                family: self.family().into(),
                unavailable: google::unavailable(),
                tools: self.tool_defs().iter().filter_map(super::to_tool).collect(),
            },
        }
    }
}

/// The built-in's id in a connector id: `google.gmail` in `builtin:google.gmail`.
pub fn id_of(connector_id: &str) -> Option<&str> {
    connector_id.strip_prefix(PREFIX)
}

/// Installs a built-in, or answers it when it is installed.
pub fn install(store: &Store, id: &str) -> Result<Connector, String> {
    let builtin = Builtin::get(id).ok_or_else(|| format!("Crew has no built-in connector {id}"))?;
    let Builtin::Google(app) = builtin;
    super::add_as(
        store,
        builtin.connector_id(),
        NewConnector {
            name: app.name().into(),
            registry_name: None,
            url: format!("https://{}", app.server()),
            icon_url: Some(app.icon_url().into()),
            description: app.description().into(),
            publisher: "Built in".into(),
        },
    )
}
