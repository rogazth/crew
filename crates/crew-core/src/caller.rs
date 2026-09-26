//! Who is calling a tool. The bridge works it out from the token and nothing
//! else; every tool is handed the answer and decides what that caller may see
//! and do.
//!
//! Three kinds, because they differ in what a tool can promise them:
//! - an agent has turns, so it can be written back to and can carry on after
//!   this one;
//! - a terminal session runs a CLI Crew does not drive: it has no turns, so a
//!   reply to it would reach nobody;
//! - the user, from the `crew` command line, is no session at all and names
//!   its workspace on each call.

use crew_protocol::AgentRef;

use crate::bridge::Bearer;
use crate::session::{self, Session};
use crate::store::Store;

#[derive(Clone, Debug)]
pub enum Caller {
    Agent(Session),
    Terminal(Session),
    /// `None` when the call named no workspace, or one that resolved to none.
    /// Tools that need one say so through [`Caller::workspace_id`].
    User { workspace_id: Option<String> },
}

/// The kind alone, for deciding which tools a caller is shown.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum CallerKind {
    Agent,
    Terminal,
    User,
}

impl Caller {
    /// Who a bridge bearer is now, read from the store. A session re-read on
    /// every call, so a rename or a new autonomy applies to its next call; the
    /// user in whatever workspace `workspace` names, an id or a path inside
    /// one, or in none.
    pub fn resolve(store: &Store, bearer: &Bearer, workspace: Option<&str>) -> Result<Self, String> {
        match bearer {
            Bearer::Session(id) => session::get(store, id.clone())?
                .map(Caller::from_session)
                .ok_or_else(|| "This session no longer exists in Crew".to_string()),
            Bearer::User => Ok(Caller::User {
                workspace_id: match workspace {
                    Some(needle) => crate::workspace::resolve(store, needle)?,
                    None => None,
                },
            }),
        }
    }

    /// A session, as the kind its row says it is. A terminal session is one the
    /// user runs a CLI in; everything else Crew drives turn by turn.
    pub fn from_session(session: Session) -> Self {
        if session.kind == "terminal" {
            Caller::Terminal(session)
        } else {
            Caller::Agent(session)
        }
    }

    pub fn kind(&self) -> CallerKind {
        match self {
            Caller::Agent(_) => CallerKind::Agent,
            Caller::Terminal(_) => CallerKind::Terminal,
            Caller::User { .. } => CallerKind::User,
        }
    }

    /// The session behind the call; the user has none.
    pub fn session(&self) -> Option<&Session> {
        match self {
            Caller::Agent(session) | Caller::Terminal(session) => Some(session),
            Caller::User { .. } => None,
        }
    }

    pub fn session_id(&self) -> Option<&str> {
        self.session().map(|session| session.id.as_str())
    }

    /// The workspace everything this caller reaches lives in. A session always
    /// has one; the user has one only when the call named it.
    pub fn workspace_id(&self) -> Result<&str, String> {
        match self {
            Caller::Agent(session) | Caller::Terminal(session) => Ok(&session.workspace_id),
            Caller::User { workspace_id: Some(id) } => Ok(id),
            Caller::User { workspace_id: None } => Err(
                "No workspace: run this from inside a workspace's folder, or name one with --workspace (an id or a path)."
                    .to_string(),
            ),
        }
    }

    /// The git worktree a session runs in; `None` is the workspace folder.
    pub fn worktree(&self) -> Option<&str> {
        self.session().and_then(|session| session.worktree.as_deref())
    }

    /// How this caller is named to somebody else: "tab in use by …", "created
    /// by …". Names are the user's and change, so the id rides along.
    pub fn label(&self) -> String {
        match self {
            Caller::Agent(session) => format!("{} (agent {})", session.name, session.id),
            Caller::Terminal(session) => format!("{} (terminal {})", session.name, session.id),
            Caller::User { .. } => "the user".to_string(),
        }
    }

    /// `"full"` runs unattended, anything else asks first. The user is the one
    /// who would be asked, so the user has full autonomy.
    pub fn autonomy(&self) -> &str {
        match self {
            Caller::Agent(session) | Caller::Terminal(session) => &session.autonomy,
            Caller::User { .. } => "full",
        }
    }

    pub fn full_autonomy(&self) -> bool {
        self.autonomy() == "full"
    }

    /// What goes on a letter this caller sends. `kind` is what lets the
    /// envelope tell the reader whether a reply can reach the sender.
    pub fn sender(&self) -> AgentRef {
        match self {
            Caller::Agent(session) => AgentRef::agent(session.id.clone(), session.name.clone()),
            Caller::Terminal(session) => AgentRef {
                id: session.id.clone(),
                name: session.name.clone(),
                kind: Some("terminal".into()),
            },
            Caller::User { .. } => AgentRef {
                id: String::new(),
                name: "You".into(),
                kind: Some("user".into()),
            },
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn store() -> (Store, std::path::PathBuf) {
        let dir = std::env::temp_dir().join(format!("crew-caller-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).expect("dir");
        (Store::open(dir.join("crew.sqlite3")).expect("store"), dir)
    }

    fn user_in(store: &Store, workspace: Option<&str>) -> Option<String> {
        match Caller::resolve(store, &Bearer::User, workspace).expect("resolve") {
            Caller::User { workspace_id } => workspace_id,
            other => panic!("not the user: {other:?}"),
        }
    }

    #[test]
    fn the_user_names_a_workspace_by_id_or_by_a_path_inside_it() {
        let (store, dir) = store();
        let root = dir.join("repo");
        std::fs::create_dir_all(root.join("src/deep")).expect("root");
        let ws = crate::workspace::create(&store, "w".into(), root.to_string_lossy().into()).expect("ws");

        assert_eq!(user_in(&store, Some(&ws.id)), Some(ws.id.clone()));
        assert_eq!(user_in(&store, Some(&root.to_string_lossy())), Some(ws.id.clone()));
        assert_eq!(user_in(&store, Some(&root.join("src/deep").to_string_lossy())), Some(ws.id.clone()));
        assert_eq!(user_in(&store, Some(&dir.to_string_lossy())), None);
        assert_eq!(user_in(&store, Some("nope")), None);
        assert_eq!(user_in(&store, None), None);
    }

    /// A worktree outside the repo, where Crew keeps them, is still the
    /// workspace of the session that runs in it.
    #[test]
    fn a_path_in_a_sessions_worktree_is_that_sessions_workspace() {
        let (store, dir) = store();
        let root = dir.join("repo");
        let tree = dir.join("worktrees/feat");
        std::fs::create_dir_all(&root).expect("root");
        std::fs::create_dir_all(&tree).expect("tree");
        let ws = crate::workspace::create(&store, "w".into(), root.to_string_lossy().into()).expect("ws");
        crate::session::create_in_worktree(
            &store,
            ws.id.clone(),
            "agent".into(),
            "A".into(),
            "claude".into(),
            "".into(),
            "".into(),
            "ask".into(),
            Some(tree.to_string_lossy().into()),
        )
        .expect("session");
        assert_eq!(user_in(&store, Some(&tree.to_string_lossy())), Some(ws.id));
    }

    #[test]
    fn a_session_is_the_kind_its_row_says() {
        let (store, dir) = store();
        let ws = crate::workspace::create(&store, "w".into(), dir.to_string_lossy().into()).expect("ws");
        let make = |kind: &str| {
            crate::session::create(&store, ws.id.clone(), kind.into(), "S".into(), "claude".into(), "".into(), "".into(), "ask".into())
                .expect("session")
                .id
        };
        let agent = Caller::resolve(&store, &Bearer::Session(make("agent")), None).expect("agent");
        let shell = Caller::resolve(&store, &Bearer::Session(make("terminal")), Some("elsewhere")).expect("terminal");
        assert_eq!(agent.kind(), CallerKind::Agent);
        assert_eq!(shell.kind(), CallerKind::Terminal);
        // A session's workspace is its own, whatever the call named.
        assert_eq!(shell.workspace_id(), Ok(ws.id.as_str()));
        assert!(Caller::resolve(&store, &Bearer::Session("gone".into()), None).is_err());
        assert!(Caller::User { workspace_id: None }.full_autonomy());
    }
}
