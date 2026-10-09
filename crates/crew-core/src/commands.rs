//! The `/` menu's catalog: what each provider's CLI says it can run after a
//! slash, kept per provider and folder, with Crew's own actions merged in
//! when it is read.
//!
//! It is per folder and not per workspace because two worktrees on different
//! branches can hold different `.claude/skills`. What a live process says
//! keeps it current (`commands_changed`, the skills each turn names); a CLI
//! started for no other reason than to ask fills it when nothing is up.

use std::collections::{HashMap, HashSet};
use std::sync::{Arc, Mutex, MutexGuard};

use crew_protocol::{CommandCatalog, CommandEntry, CommandsChanged};
use serde_json::Value;

/// How long a catalog read by a probe is trusted before the next list asks
/// again. A live process keeps its own current, so this only bounds what a
/// folder's files can have changed since nothing was watching.
pub const MAX_AGE_MS: i64 = 10 * 60 * 1000;

pub type Listener = Arc<dyn Fn(CommandsChanged) + Send + Sync>;

/// What one provider reported for one folder. The kinds are not stored: a
/// provider lists commands and skills apart, or together with the skills named
/// on the side, and the kind is settled when the catalog is read.
#[derive(Default, Clone, PartialEq, Eq, Debug)]
struct Reported {
    entries: Vec<CommandEntry>,
    skills: HashSet<String>,
    at: i64,
}

/// Every (provider, folder)'s catalog, and who hears when one changes.
#[derive(Clone, Default)]
pub struct CommandsHost {
    inner: Arc<Mutex<HashMap<(String, String), Reported>>>,
    listener: Arc<Mutex<Option<Listener>>>,
    /// Held while a probe runs, so a second list that finds the catalog
    /// missing waits for the first one's answer instead of starting another
    /// CLI.
    probing: Arc<Mutex<()>>,
}

impl CommandsHost {
    pub fn set_listener(&self, listener: Listener) {
        *self.listener.lock().unwrap_or_else(|e| e.into_inner()) = Some(listener);
    }

    /// Tells the windows a session's catalog changed. The listener runs out of
    /// every lock here.
    pub fn notify(&self, change: CommandsChanged) {
        let listener = self.listener.lock().unwrap_or_else(|e| e.into_inner()).clone();
        if let Some(listener) = listener {
            listener(change);
        }
    }

    /// Taken around a probe; see the field.
    pub fn probe_lock(&self) -> MutexGuard<'_, ()> {
        self.probing.lock().unwrap_or_else(|e| e.into_inner())
    }

    /// Whether a catalog read at most [`MAX_AGE_MS`] before `now` is held.
    pub fn is_fresh(&self, provider: &str, cwd: &str, now: i64) -> bool {
        self.age(provider, cwd).is_some_and(|at| now - at <= MAX_AGE_MS)
    }

    /// Whether any catalog is held, however old.
    pub fn holds(&self, provider: &str, cwd: &str) -> bool {
        self.age(provider, cwd).is_some()
    }

    fn age(&self, provider: &str, cwd: &str) -> Option<i64> {
        let map = self.inner.lock().unwrap_or_else(|e| e.into_inner());
        map.get(&(provider.to_string(), cwd.to_string())).map(|reported| reported.at)
    }

    /// Keeps what a provider just said for a folder. `entries` replaces the
    /// list (the whole list, as the CLI always says it), `skills` the names
    /// that are skills; either left out keeps what was there. The time moves
    /// on whatever was said, because a read that found nothing new is still a
    /// read. Whether the catalog changed is what the caller pushes on.
    pub fn learn(
        &self,
        provider: &str,
        cwd: &str,
        entries: Option<Vec<CommandEntry>>,
        skills: Option<HashSet<String>>,
        now: i64,
    ) -> bool {
        let mut map = self.inner.lock().unwrap_or_else(|e| e.into_inner());
        let slot = map.entry((provider.to_string(), cwd.to_string())).or_default();
        let before = slot.clone();
        if let Some(entries) = entries {
            slot.entries = entries;
        }
        if let Some(skills) = skills {
            slot.skills = skills;
        }
        slot.at = now;
        Reported { at: before.at, ..slot.clone() } != before
    }

    /// `learn` for a session's own process, and when that changed what its
    /// windows see, a push to the session's windows. `actions` are Crew's own
    /// for the provider, as `catalog` merges them in.
    pub fn learn_for_session(
        &self,
        session_id: &str,
        provider: &str,
        cwd: &str,
        entries: Option<Vec<CommandEntry>>,
        skills: Option<HashSet<String>>,
        actions: Vec<CommandEntry>,
    ) {
        let now = crate::store::now_millis();
        if self.learn(provider, cwd, entries, skills, now) {
            let catalog = self.catalog(provider, cwd, actions, now);
            self.notify(CommandsChanged { session_id: session_id.to_string(), catalog });
        }
    }

    /// The catalog as a window shows it: the provider's entries, each a
    /// command or a skill, after Crew's `actions`. An entry that shares a name
    /// with an action is dropped, so `/model` is one thing: Crew changes the
    /// model, and the CLI's own never sees it.
    pub fn catalog(&self, provider: &str, cwd: &str, actions: Vec<CommandEntry>, now: i64) -> CommandCatalog {
        let reported = {
            let map = self.inner.lock().unwrap_or_else(|e| e.into_inner());
            map.get(&(provider.to_string(), cwd.to_string())).cloned().unwrap_or_default()
        };
        let named: HashSet<&str> = actions.iter().map(|action| action.name.as_str()).collect();
        let mut entries = actions.clone();
        entries.extend(
            reported
                .entries
                .iter()
                .filter(|entry| !named.contains(entry.name.as_str()))
                .map(|entry| {
                    let is_skill = reported.skills.contains(&entry.name)
                        || entry.aliases.iter().flatten().any(|alias| reported.skills.contains(alias));
                    CommandEntry { kind: if is_skill { "skill" } else { "command" }.into(), ..entry.clone() }
                }),
        );
        // A catalog nothing was read for says when it was asked, not zero: the
        // reader tells a stale menu by this time.
        CommandCatalog { entries, at: if reported.at == 0 { now } else { reported.at } }
    }
}

/// Crew's own actions, the same for every provider. `fast` is whether the
/// provider and account offer a fast mode at all: an action that would have
/// nothing to switch is not listed.
pub fn crew_actions(fast: bool) -> Vec<CommandEntry> {
    let action = |name: &str, description: &str| CommandEntry {
        name: name.into(),
        description: description.into(),
        argument_hint: None,
        aliases: None,
        kind: "crew".into(),
        path: None,
    };
    let mut actions = vec![
        action("model", "Change the model"),
        action("effort", "Change how hard it thinks"),
        action("access", "Change what it may do without asking"),
    ];
    if fast {
        actions.push(action("fast", "Turn fast mode on or off"));
    }
    actions.push(action("restart", "Restart its CLI; the conversation is kept"));
    actions.push(action("reload", "Read its commands, skills and servers again"));
    actions
}

/// The entries of a Claude `commands` array: the `initialize` answer's, the
/// `commands_changed` push's, and each item of `reload_skills`' `skills` have
/// the same shape. Names Claude keeps for its own plumbing (`__remote-workflow`)
/// are left out, and a hint or alias list that says nothing is absent.
pub fn claude_entries(list: &Value) -> Vec<CommandEntry> {
    let Some(list) = list.as_array() else { return Vec::new() };
    list.iter()
        .filter_map(|item| {
            let name = item.get("name").and_then(Value::as_str)?.trim();
            if name.is_empty() || name.starts_with("__") {
                return None;
            }
            let text = |key: &str| item.get(key).and_then(Value::as_str).map(str::trim).filter(|s| !s.is_empty());
            let aliases: Vec<String> = item
                .get("aliases")
                .and_then(Value::as_array)
                .map(|list| list.iter().filter_map(Value::as_str).map(str::to_string).collect())
                .unwrap_or_default();
            Some(CommandEntry {
                name: name.to_string(),
                description: text("description").unwrap_or_default().to_string(),
                argument_hint: text("argumentHint").map(str::to_string),
                aliases: Some(aliases).filter(|aliases| !aliases.is_empty()),
                kind: "command".into(),
                path: None,
            })
        })
        .collect()
}

/// The names in a list of Claude skills: `system/init`'s `skills` is plain
/// strings, `reload_skills` answers objects with a `name`.
pub fn claude_skill_names(list: &Value) -> HashSet<String> {
    list.as_array()
        .map(|list| {
            list.iter()
                .filter_map(|item| item.as_str().or_else(|| item.get("name").and_then(Value::as_str)))
                .map(str::to_string)
                .collect()
        })
        .unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    /// Claude 2.1.295's answers to `initialize` and then `reload_skills`, cut
    /// down to a few entries of each.
    const FIXTURE: &str = include_str!("../tests/fixtures/claude/claude-commands.jsonl");

    fn answers() -> (Value, Value) {
        let mut lines = FIXTURE.lines().map(|line| serde_json::from_str::<Value>(line).expect("fixture line"));
        let take = |line: Option<Value>| line.expect("line")["response"]["response"].clone();
        (take(lines.next()), take(lines.next()))
    }

    fn entry(name: &str, kind: &str) -> CommandEntry {
        CommandEntry {
            name: name.into(),
            description: String::new(),
            argument_hint: None,
            aliases: None,
            kind: kind.into(),
            path: None,
        }
    }

    /// The `commands` of the real `initialize` answer become entries, with
    /// an empty hint left out, aliases kept, and the CLI's own plumbing gone.
    #[test]
    fn the_initialize_answer_of_claude_becomes_entries() {
        let (init, _) = answers();
        let entries = claude_entries(&init["commands"]);
        let names: Vec<_> = entries.iter().map(|entry| entry.name.as_str()).collect();
        assert_eq!(
            names,
            ["cold-run", "prototype", "figma:figma-use", "loop", "compact", "context", "model", "effort"]
        );
        let get = |name: &str| entries.iter().find(|entry| entry.name == name).expect(name);
        assert_eq!(get("compact").argument_hint.as_deref(), Some("<optional custom summarization instructions>"));
        assert_eq!(get("context").argument_hint, None);
        assert_eq!(get("figma:figma-use").aliases, Some(vec!["figma-use".to_string()]));
        assert_eq!(get("cold-run").aliases, None);
    }

    /// Skills are told from commands by name: the `reload_skills` answer, or
    /// the plain strings of `system/init`, say which names are skills.
    #[test]
    fn a_skill_is_told_from_a_command_by_the_names_claude_lists_as_skills() {
        let (init, reload) = answers();
        let skills = claude_skill_names(&reload["skills"]);
        assert!(skills.contains("prototype") && skills.contains("keybindings-help"));
        assert_eq!(claude_skill_names(&json!(["prototype", "loop"])), HashSet::from(["prototype".into(), "loop".into()]));

        let host = CommandsHost::default();
        host.learn("claude", "/repo", Some(claude_entries(&init["commands"])), Some(skills), 5);
        let catalog = host.catalog("claude", "/repo", Vec::new(), 9);
        let kind = |name: &str| catalog.entries.iter().find(|entry| entry.name == name).expect(name).kind.clone();
        assert_eq!(kind("prototype"), "skill");
        assert_eq!(kind("loop"), "skill");
        assert_eq!(kind("figma:figma-use"), "skill");
        assert_eq!(kind("cold-run"), "command");
        assert_eq!(kind("compact"), "command");
        assert_eq!(catalog.at, 5);
    }

    /// A skill the list names by its short alias is still a skill.
    #[test]
    fn a_skill_named_by_an_alias_is_still_a_skill() {
        let host = CommandsHost::default();
        let mut plugin = entry("figma:figma-use", "command");
        plugin.aliases = Some(vec!["figma-use".into()]);
        host.learn("claude", "/repo", Some(vec![plugin]), Some(HashSet::from(["figma-use".to_string()])), 1);
        assert_eq!(host.catalog("claude", "/repo", Vec::new(), 2).entries[0].kind, "skill");
    }

    /// Crew's actions come first, and an entry of the provider that shares a
    /// name with one is dropped so `/model` is Crew's alone.
    #[test]
    fn crew_actions_are_merged_in_and_win_over_the_providers_entries_of_the_same_name() {
        let host = CommandsHost::default();
        host.learn("claude", "/repo", Some(vec![entry("model", "command"), entry("compact", "command")]), None, 1);
        let catalog = host.catalog("claude", "/repo", crew_actions(true), 2);
        let names: Vec<_> = catalog.entries.iter().map(|entry| (entry.name.as_str(), entry.kind.as_str())).collect();
        assert_eq!(
            names,
            [
                ("model", "crew"),
                ("effort", "crew"),
                ("access", "crew"),
                ("fast", "crew"),
                ("restart", "crew"),
                ("reload", "crew"),
                ("compact", "command"),
            ]
        );
    }

    /// Where there is no fast mode, there is no `/fast`.
    #[test]
    fn fast_is_not_an_action_where_there_is_no_fast_mode() {
        assert!(crew_actions(true).iter().any(|action| action.name == "fast"));
        assert!(!crew_actions(false).iter().any(|action| action.name == "fast"));
    }

    /// A folder nothing was read for still has the actions, dated now.
    #[test]
    fn a_folder_nothing_was_read_for_lists_the_actions_alone() {
        let catalog = CommandsHost::default().catalog("claude", "/nowhere", crew_actions(false), 42);
        assert_eq!(catalog.at, 42);
        assert!(catalog.entries.iter().all(|entry| entry.kind == "crew"));
    }

    /// The catalog is per provider and folder: another worktree's skills do
    /// not leak into this one's.
    #[test]
    fn each_provider_and_folder_has_its_own_catalog() {
        let host = CommandsHost::default();
        host.learn("claude", "/a", Some(vec![entry("one", "command")]), None, 1);
        host.learn("claude", "/b", Some(vec![entry("two", "command")]), None, 1);
        assert!(!host.holds("codex", "/a"));
        assert_eq!(host.catalog("claude", "/a", Vec::new(), 2).entries[0].name, "one");
        assert_eq!(host.catalog("claude", "/b", Vec::new(), 2).entries[0].name, "two");
    }

    /// A read that says the same thing again moves the time and nothing else,
    /// so it is not pushed; one that says something new is.
    #[test]
    fn learning_the_same_catalog_again_is_not_a_change() {
        let host = CommandsHost::default();
        let list = vec![entry("one", "command")];
        assert!(host.learn("claude", "/a", Some(list.clone()), None, 1));
        assert!(!host.learn("claude", "/a", Some(list.clone()), None, 2));
        assert!(host.learn("claude", "/a", None, Some(HashSet::from(["one".to_string()])), 3));
        assert!(host.learn("claude", "/a", Some(Vec::new()), None, 4));
        assert_eq!(host.catalog("claude", "/a", Vec::new(), 9).at, 4);
    }

    /// A catalog is trusted for ten minutes and no longer.
    #[test]
    fn a_catalog_is_fresh_for_ten_minutes() {
        let host = CommandsHost::default();
        assert!(!host.is_fresh("claude", "/a", 1_000));
        host.learn("claude", "/a", Some(Vec::new()), None, 1_000);
        assert!(host.is_fresh("claude", "/a", 1_000 + MAX_AGE_MS));
        assert!(!host.is_fresh("claude", "/a", 1_001 + MAX_AGE_MS));
        assert!(host.holds("claude", "/a"));
    }
}
