//! The `/` menu entries each provider reports, read from what its CLI sent:
//! Codex's `skills/list` answer and its fixed commands, and Cursor's ACP
//! `available_commands_update`. These are pure: the callers say where the
//! entries go.

use crew_protocol::CommandEntry;
use serde_json::Value;

/// A provider command: what the user types, and what it takes after it.
fn command(name: &str, description: &str, argument_hint: Option<&str>) -> CommandEntry {
    CommandEntry {
        name: name.into(),
        description: description.into(),
        argument_hint: argument_hint.map(str::to_string),
        aliases: None,
        kind: "command".into(),
        path: None,
    }
}

/// The skills of a `skills/list` answer that Codex has enabled. Each keeps
/// its file, because Codex names a skill by its path when a turn uses it.
pub fn codex_skills(response: &Value) -> Vec<CommandEntry> {
    response
        .get("data")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(|folder| folder.get("skills").and_then(Value::as_array))
        .flatten()
        .filter(|skill| skill.get("enabled").and_then(Value::as_bool) == Some(true))
        .filter_map(|skill| {
            Some(CommandEntry {
                name: skill.get("name")?.as_str()?.into(),
                description: skill_description(skill),
                argument_hint: None,
                aliases: None,
                kind: "skill".into(),
                path: Some(skill.get("path")?.as_str()?.into()),
            })
        })
        .collect()
}

/// The line the menu shows for a skill: the short one its author wrote, or
/// the description of the whole skill when there is none.
fn skill_description(skill: &Value) -> String {
    ["/interface/shortDescription", "/shortDescription", "/description"]
        .iter()
        .filter_map(|pointer| skill.pointer(pointer).and_then(Value::as_str))
        .map(str::trim)
        .find(|text| !text.is_empty())
        .unwrap_or_default()
        .to_string()
}

/// The commands Crew maps to Codex's own methods. Codex does not list them,
/// so the menu carries these.
pub fn codex_commands() -> Vec<CommandEntry> {
    vec![
        command("compact", "Compact the conversation into a summary", None),
        command("review", "Review the uncommitted changes in the working tree", None),
        command("goal", "Set the goal the thread works toward, or show it", Some("[objective]")),
        command("mcp", "List the MCP servers and their tools", None),
    ]
}

/// The commands of an ACP `available_commands_update`, which Cursor sends
/// when a session opens or loads. `input.hint` says what a command takes,
/// and it is null or absent for most.
pub fn cursor_commands(update: &Value) -> Vec<CommandEntry> {
    update
        .get("availableCommands")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(|command_| {
            let name = command_.get("name")?.as_str()?.trim();
            if name.is_empty() {
                return None;
            }
            Some(CommandEntry {
                name: name.into(),
                description: command_.get("description").and_then(Value::as_str).unwrap_or_default().into(),
                argument_hint: command_
                    .pointer("/input/hint")
                    .and_then(Value::as_str)
                    .map(str::trim)
                    .filter(|hint| !hint.is_empty())
                    .map(str::to_string),
                aliases: None,
                kind: "command".into(),
                path: None,
            })
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    /// A `skills/list` answer as the app server's schema gives it, for one
    /// folder: an enabled skill from the repo, one the user turned off, and
    /// one with only its full description.
    fn listed() -> Value {
        json!({
            "data": [{
                "cwd": "/work/crew",
                "errors": [],
                "skills": [
                    {
                        "name": "review-pr",
                        "description": "Reviews a pull request in depth, reading every changed file before it says anything about the change as a whole.",
                        "shortDescription": null,
                        "enabled": true,
                        "interface": { "displayName": "Review PR", "shortDescription": "Review a pull request", "brandColor": null, "defaultPrompt": null, "iconLarge": null, "iconLargeUrl": null, "iconSmall": null, "iconSmallUrl": null },
                        "path": "/work/crew/.agents/skills/review-pr/SKILL.md",
                        "scope": "repo",
                        "pluginId": null,
                        "dependencies": null
                    },
                    {
                        "name": "old-notes",
                        "description": "Notes from an older workflow.",
                        "shortDescription": null,
                        "enabled": false,
                        "interface": null,
                        "path": "/home/me/.codex/skills/old-notes/SKILL.md",
                        "scope": "user",
                        "pluginId": null,
                        "dependencies": null
                    },
                    {
                        "name": "release",
                        "description": "Cuts a release: bumps the version, tags it and writes the notes.\nIt never pushes.",
                        "shortDescription": "Cut a release",
                        "enabled": true,
                        "interface": null,
                        "path": "/work/crew/.agents/skills/release/SKILL.md",
                        "scope": "repo",
                        "pluginId": null,
                        "dependencies": null
                    }
                ]
            }]
        })
    }

    /// An enabled skill goes on the menu as a skill, with the short line its
    /// author wrote and the file Codex needs to name it.
    #[test]
    fn an_enabled_codex_skill_is_a_skill_with_its_short_line_and_its_file() {
        let skills = codex_skills(&listed());
        assert_eq!(
            skills[0],
            CommandEntry {
                name: "review-pr".into(),
                description: "Review a pull request".into(),
                argument_hint: None,
                aliases: None,
                kind: "skill".into(),
                path: Some("/work/crew/.agents/skills/review-pr/SKILL.md".into()),
            }
        );
    }

    /// A skill the user turned off is not offered.
    #[test]
    fn a_disabled_codex_skill_is_left_off_the_menu() {
        let names: Vec<String> = codex_skills(&listed()).into_iter().map(|skill| skill.name).collect();
        assert_eq!(names, ["review-pr", "release"]);
    }

    /// Without a short line, the description is the first line of the
    /// skill's own, not a block of it.
    #[test]
    fn a_codex_skill_with_no_short_line_uses_its_description() {
        let release = &codex_skills(&listed())[1];
        assert_eq!(release.description, "Cut a release");
        let mut bare = listed();
        bare["data"][0]["skills"][2]["shortDescription"] = Value::Null;
        let release = &codex_skills(&bare)[1];
        assert!(release.description.starts_with("Cuts a release: bumps the version"), "{release:?}");
    }

    /// An answer with no folders, or no skills, is an empty menu, not an error.
    #[test]
    fn an_empty_codex_answer_has_no_skills() {
        assert!(codex_skills(&json!({ "data": [] })).is_empty());
        assert!(codex_skills(&json!({ "data": [{ "cwd": "/w", "errors": [], "skills": [] }] })).is_empty());
        assert!(codex_skills(&json!({})).is_empty());
    }

    /// The four commands Codex is driven with, each a command and not a skill.
    #[test]
    fn codex_has_four_commands_of_its_own() {
        let commands = codex_commands();
        let names: Vec<&str> = commands.iter().map(|command| command.name.as_str()).collect();
        assert_eq!(names, ["compact", "review", "goal", "mcp"]);
        assert!(commands.iter().all(|command| command.kind == "command" && command.path.is_none()));
    }

    /// A Cursor command takes its input hint as its argument hint; one with
    /// no input, or a null one, takes nothing.
    #[test]
    fn a_cursor_command_takes_its_input_hint_as_its_argument_hint() {
        let update = json!({
            "sessionUpdate": "available_commands_update",
            "availableCommands": [
                { "name": "create_plan", "description": "Create a plan", "input": { "hint": "the goal" } },
                { "name": "copy-request-id", "description": "Copy the last request ID to clipboard", "input": null },
                { "name": "clear", "description": "Start over" }
            ]
        });
        let commands = cursor_commands(&update);
        assert_eq!(
            commands,
            vec![
                CommandEntry {
                    name: "create_plan".into(),
                    description: "Create a plan".into(),
                    argument_hint: Some("the goal".into()),
                    aliases: None,
                    kind: "command".into(),
                    path: None,
                },
                CommandEntry {
                    name: "copy-request-id".into(),
                    description: "Copy the last request ID to clipboard".into(),
                    argument_hint: None,
                    aliases: None,
                    kind: "command".into(),
                    path: None,
                },
                CommandEntry {
                    name: "clear".into(),
                    description: "Start over".into(),
                    argument_hint: None,
                    aliases: None,
                    kind: "command".into(),
                    path: None,
                },
            ]
        );
    }

    /// An update that lists no commands, or one with a blank name, yields
    /// none: a blank name is not something the user could type after a slash.
    #[test]
    fn a_cursor_update_with_no_usable_command_yields_none() {
        assert!(cursor_commands(&json!({ "sessionUpdate": "available_commands_update", "availableCommands": [] })).is_empty());
        assert!(cursor_commands(&json!({ "sessionUpdate": "available_commands_update" })).is_empty());
        let nameless = json!({ "availableCommands": [{ "name": " ", "description": "Nothing" }] });
        assert!(cursor_commands(&nameless).is_empty());
    }
}
