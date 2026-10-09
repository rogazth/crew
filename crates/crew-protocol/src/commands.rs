//! The `/` menu: the commands, skills and Crew actions a session offers after
//! a slash, as the daemon read them from the provider's CLI.

use serde::{Deserialize, Serialize};
use ts_rs::TS;

/// One entry of the `/` menu.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../../src/lib/protocol.ts", rename_all = "camelCase")]
pub struct CommandEntry {
    /// What the user types after the slash, without it.
    pub name: String,
    pub description: String,
    /// What the command takes after its name, shown as a hint: `<file>`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub argument_hint: Option<String>,
    /// Other names that run the same entry.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub aliases: Option<Vec<String>>,
    /// `command` (a provider's own), `skill` (one the model can invoke), or
    /// `crew` (an action Crew performs itself, so no provider sees it).
    #[ts(type = "\"command\" | \"skill\" | \"crew\"")]
    pub kind: String,
    /// Where a skill is defined on disk. Codex needs it to name the skill as
    /// an input item, so it is kept for every skill the catalog reads.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub path: Option<String>,
}

/// A session's `/` menu as it stood when it was read.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../../src/lib/protocol.ts", rename_all = "camelCase")]
pub struct CommandCatalog {
    pub entries: Vec<CommandEntry>,
    /// When it was read, in milliseconds. A menu read before the last reload
    /// may be out of date, and the time is how the reader can tell.
    #[ts(type = "number")]
    pub at: i64,
}

/// Asks for a session's catalog. Answered from the cache, without a reload.
#[derive(Serialize, Deserialize, Clone, Debug, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../../src/lib/protocol.ts", rename_all = "camelCase")]
pub struct CommandsList {
    pub session_id: String,
}

/// Asks the provider to read its commands and skills again, for files that
/// changed on disk since the session started.
#[derive(Serialize, Deserialize, Clone, Debug, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../../src/lib/protocol.ts", rename_all = "camelCase")]
pub struct CommandsReload {
    pub session_id: String,
}

/// Ends a session's CLI process so the next message starts it again. The
/// conversation is kept: the next turn resumes it by its provider id. Refused
/// while a turn runs; and while background work runs, unless `force` says it
/// may stop with the process.
#[derive(Serialize, Deserialize, Clone, Debug, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../../src/lib/protocol.ts", rename_all = "camelCase")]
pub struct SessionRestart {
    pub session_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub force: Option<bool>,
}

/// Pushed as `commands-changed` when a session's catalog changes. It carries
/// the whole catalog, so the client replaces its copy rather than merging.
#[derive(Serialize, Deserialize, Clone, Debug, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../../src/lib/protocol.ts", rename_all = "camelCase")]
pub struct CommandsChanged {
    pub session_id: String,
    pub catalog: CommandCatalog,
}

#[cfg(test)]
mod tests {
    use super::*;

    /// An entry from a daemon that wrote no hint, aliases or path reads them
    /// as absent, and writes none of them back.
    #[test]
    fn a_command_entry_without_its_optional_fields_reads_them_as_absent() {
        let raw = r#"{"name":"compact","description":"Compact the conversation","kind":"command"}"#;
        let entry: CommandEntry = serde_json::from_str(raw).expect("entry");
        assert_eq!(serde_json::to_string(&entry).expect("json"), raw);
        assert_eq!((entry.argument_hint, entry.aliases, entry.path), (None, None, None));
    }

    /// A skill with every field set goes on the wire under camel-case names
    /// and reads back unchanged.
    #[test]
    fn a_skill_entry_round_trips_with_its_hint_aliases_and_path() {
        let entry = CommandEntry {
            name: "review".into(),
            description: "Review a change".into(),
            argument_hint: Some("<branch>".into()),
            aliases: Some(vec!["rv".into()]),
            kind: "skill".into(),
            path: Some("/repo/.claude/skills/review/SKILL.md".into()),
        };
        let wire = serde_json::to_value(&entry).expect("json");
        assert_eq!(
            wire,
            serde_json::json!({
                "name": "review",
                "description": "Review a change",
                "argumentHint": "<branch>",
                "aliases": ["rv"],
                "kind": "skill",
                "path": "/repo/.claude/skills/review/SKILL.md"
            })
        );
        assert_eq!(serde_json::from_value::<CommandEntry>(wire).expect("entry"), entry);
    }

    /// A catalog names its entries and the time it was read, in milliseconds.
    #[test]
    fn a_catalog_carries_its_entries_and_the_time_it_was_read() {
        let catalog = CommandCatalog { entries: Vec::new(), at: 1_700_000_000_000 };
        assert_eq!(
            serde_json::to_value(&catalog).expect("json"),
            serde_json::json!({ "entries": [], "at": 1_700_000_000_000_i64 })
        );
    }

    /// The push names its session and carries the catalog it replaces.
    #[test]
    fn a_commands_changed_push_names_its_session_and_catalog() {
        let push = CommandsChanged {
            session_id: "s1".into(),
            catalog: CommandCatalog { entries: Vec::new(), at: 5 },
        };
        assert_eq!(
            serde_json::to_value(&push).expect("json"),
            serde_json::json!({ "sessionId": "s1", "catalog": { "entries": [], "at": 5 } })
        );
    }
}
