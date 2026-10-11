//! The `/` menu entries each provider reports, read from what its CLI sent:
//! Codex's `skills/list` answer and its fixed commands, and Cursor's ACP
//! `available_commands_update`. Cursor's plugin skills are read from its
//! plugin cache, as `cursor-agent acp` loads none. These are pure apart from
//! that read, which writes nothing: the callers say where the entries go.

use std::collections::HashSet;
use std::fs;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

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

/// The skills of the Cursor plugins the user has enabled, read from the
/// plugin cache under `cache` (`~/.cursor/plugins/cache`). `cursor-agent acp`
/// loads no plugin, so Crew lists them itself. Each enabled plugin contributes
/// the skills of one install (see [`install_of`]), and a name a plugin repeats
/// is taken once. The file is each skill's own, so a turn can read its body.
pub fn cursor_plugin_skills(cache: &Path) -> Vec<CommandEntry> {
    let Some(manifest) = fs::read_to_string(cache.join(".cloud-plugin-manifest.json"))
        .ok()
        .and_then(|text| serde_json::from_str::<Value>(&text).ok())
    else {
        return Vec::new();
    };
    let mut seen = HashSet::new();
    manifest
        .get("plugins")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter(|plugin| plugin.get("enabledCapabilities").and_then(Value::as_array).is_some_and(|caps| !caps.is_empty()))
        .filter_map(|plugin| install_of(cache, plugin))
        .flat_map(|root| skill_files(&root))
        .filter_map(|file| read_skill(&file))
        .filter(|skill| seen.insert(skill.name.clone()))
        .collect()
}

/// The folder of a plugin's newest install. Cursor keeps an install under the
/// plugin's name and under its id, as `<market>/<key>/<sha>`, and writes
/// `<sha>.installed` beside the ones it finished. The newest finished install
/// wins; with none finished, the newest of all. The plugin's `gitPath` (where
/// its files sit in the repository) is added to that folder.
fn install_of(cache: &Path, plugin: &Value) -> Option<PathBuf> {
    let market = cache.join(plugin.get("marketplaceSlug").and_then(Value::as_str).unwrap_or("cursor-public"));
    let mut installs: Vec<(bool, SystemTime, PathBuf)> = Vec::new();
    for key in ["name", "pluginId"].iter().filter_map(|field| plugin.get(*field).and_then(Value::as_str)) {
        let folder = market.join(key);
        for entry in sorted_dirs(&folder) {
            let sha = entry.file_name().unwrap_or_default().to_string_lossy().into_owned();
            let finished = folder.join(format!("{sha}.installed")).exists();
            let modified = fs::metadata(&entry).and_then(|meta| meta.modified()).unwrap_or(UNIX_EPOCH);
            installs.push((finished, modified, entry));
        }
    }
    let (_, _, sha_dir) = installs.into_iter().max_by(|a, b| (a.0, a.1).cmp(&(b.0, b.1)))?;
    let git_path = plugin.get("gitPath").and_then(Value::as_str).unwrap_or_default().trim_matches('/');
    Some(if git_path.is_empty() || git_path == "." { sha_dir } else { sha_dir.join(git_path) })
}

/// The `SKILL.md` files under an install's `skills` folder: one folder down,
/// or one more under a version folder (`skills/v1/<name>/SKILL.md`). The
/// shallower come first, so a version folder's repeat of a name is dropped.
fn skill_files(root: &Path) -> Vec<PathBuf> {
    let mut found = Vec::new();
    let mut folders = vec![root.join("skills")];
    for _ in 0..2 {
        let mut next = Vec::new();
        for folder in folders {
            for dir in sorted_dirs(&folder) {
                let file = dir.join("SKILL.md");
                if file.is_file() {
                    found.push(file);
                } else {
                    next.push(dir);
                }
            }
        }
        folders = next;
    }
    found
}

fn sorted_dirs(folder: &Path) -> Vec<PathBuf> {
    let mut dirs: Vec<PathBuf> = fs::read_dir(folder)
        .into_iter()
        .flatten()
        .flatten()
        .map(|entry| entry.path())
        .filter(|path| path.is_dir())
        .collect();
    dirs.sort();
    dirs
}

/// A skill from its `SKILL.md`: the name its frontmatter gives (the folder's
/// when there is none) and the description, as the menu's line.
fn read_skill(file: &Path) -> Option<CommandEntry> {
    let text = fs::read_to_string(file).ok()?;
    let folder = file.parent()?.file_name()?.to_string_lossy().into_owned();
    Some(CommandEntry {
        name: frontmatter_value(&text, "name").unwrap_or(folder),
        description: frontmatter_value(&text, "description").unwrap_or_default(),
        argument_hint: None,
        aliases: None,
        kind: "skill".into(),
        path: Some(file.to_string_lossy().into_owned()),
    })
}

/// The value of a top-level `key:` in a file's YAML frontmatter. Quotes come
/// off, and a block scalar (`>-`, `|`) is its indented lines run together.
fn frontmatter_value(text: &str, key: &str) -> Option<String> {
    let mut lines = text.lines();
    if lines.next()?.trim_end() != "---" {
        return None;
    }
    let block: Vec<&str> = lines.take_while(|line| line.trim_end() != "---").collect();
    let index = block.iter().position(|line| {
        !line.starts_with([' ', '\t']) && line.split_once(':').is_some_and(|(name, _)| name.trim() == key)
    })?;
    let rest = block[index].split_once(':')?.1.trim();
    let value = if rest.is_empty() || rest.starts_with(['>', '|']) {
        block[index + 1..]
            .iter()
            .take_while(|line| line.is_empty() || line.starts_with([' ', '\t']))
            .map(|line| line.trim())
            .filter(|line| !line.is_empty())
            .collect::<Vec<_>>()
            .join(" ")
    } else {
        rest.trim_matches(|c| c == '"' || c == '\'').to_string()
    };
    Some(value).filter(|value| !value.is_empty())
}

/// A `SKILL.md`'s instructions: the text after its frontmatter, or the whole
/// file when it has no closing `---`.
pub fn skill_body(text: &str) -> String {
    let lines: Vec<&str> = text.lines().collect();
    let body_from = if lines.first().is_some_and(|line| line.trim_end() == "---") {
        lines.iter().skip(1).position(|line| line.trim_end() == "---").map_or(0, |closing| closing + 2)
    } else {
        0
    };
    lines[body_from..].join("\n").trim().to_string()
}

/// The instructions of the Cursor plugin skills a message names, read now for
/// its prompt, in the order it names them. A name that is no plugin skill, or
/// a skill with no body, is left out.
pub fn cursor_skill_bodies(cache: &Path, names: &[String]) -> Vec<(String, String)> {
    if names.is_empty() {
        return Vec::new();
    }
    let skills = cursor_plugin_skills(cache);
    names
        .iter()
        .filter_map(|name| {
            let skill = skills.iter().find(|skill| &skill.name == name)?;
            let text = fs::read_to_string(skill.path.as_deref()?).ok()?;
            Some((name.clone(), skill_body(&text))).filter(|(_, body)| !body.is_empty())
        })
        .collect()
}

/// The text a Cursor turn sends when it names plugin skills: each skill's
/// instructions ahead of the message, as Codex loads its skills ahead of the
/// text. The message itself is last, and is left as it is with no skills.
pub fn with_skill_bodies(text: &str, skills: &[(String, String)]) -> String {
    if skills.is_empty() {
        return text.to_string();
    }
    let mut parts: Vec<String> = skills
        .iter()
        .map(|(name, body)| format!("The user invoked the skill `{name}`. Follow its instructions:\n\n{body}"))
        .collect();
    if !text.trim().is_empty() {
        parts.push(text.trim().to_string());
    }
    parts.join("\n\n---\n\n")
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

    /// A plugin cache in a temp folder, laid out as Cursor lays it out: an
    /// enabled plugin installed under its id and marked finished, a newer
    /// unmarked install under its name, a disabled plugin, and a plugin whose
    /// files sit under a `gitPath`.
    struct Cache(PathBuf);

    impl Cache {
        fn new() -> Self {
            let dir = std::env::temp_dir().join(format!("crew-plugins-{}", uuid::Uuid::new_v4()));
            let cache = Cache(dir);
            cache.write("cursor-public/101/aaa/skills/search/SKILL.md", "---\nname: search\ndescription: \"Search the workspace.\"\n---\n\nFind things.\n");
            cache.write("cursor-public/101/aaa/skills/v1/search/SKILL.md", "---\nname: search\ndescription: An old version.\n---\nOld.\n");
            cache.write("cursor-public/101/aaa.installed", "");
            cache.write("cursor-public/notes/bbb/skills/ghost/SKILL.md", "---\nname: ghost\ndescription: Unfinished.\n---\nNo.\n");
            cache.write("cursor-public/202/ccc/skills/hidden/SKILL.md", "---\nname: hidden\ndescription: Off.\n---\nNo.\n");
            cache.write("cursor-public/202/ccc.installed", "");
            cache.write("cursor-public/303/ddd.installed", "");
            cache.write(
                "cursor-public/303/ddd/third_party/x/skills/x-chat/SKILL.md",
                "---\ndescription: >-\n  Read the timeline\n  and post to it.\nlicense: MIT\n---\n\n# X chat\nPost things.\n",
            );
            cache.write(
                ".cloud-plugin-manifest.json",
                r#"{"manifestVersion":"1","plugins":[
                    {"name":"notes","pluginId":"101","marketplaceSlug":"cursor-public","enabledCapabilities":["static"],"gitPath":"","declaredCapabilityPaths":{"skill":[]}},
                    {"name":"docs","pluginId":"202","marketplaceSlug":"cursor-public","enabledCapabilities":[],"gitPath":"","declaredCapabilityPaths":{"skill":[]}},
                    {"name":"x","pluginId":"303","marketplaceSlug":"cursor-public","enabledCapabilities":["static"],"gitPath":"third_party/x","declaredCapabilityPaths":{"skill":[]}}
                ]}"#,
            );
            cache
        }

        fn write(&self, path: &str, text: &str) {
            let path = self.0.join(path);
            fs::create_dir_all(path.parent().expect("parent")).expect("dir");
            fs::write(path, text).expect("write");
        }
    }

    impl Drop for Cache {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    /// The enabled plugins' skills come from their finished install: a skill
    /// is named by its frontmatter, carries its file, and a `gitPath` is
    /// followed. The manifest is left as it was.
    #[test]
    fn an_enabled_plugins_skills_come_from_its_finished_install() {
        let cache = Cache::new();
        let manifest = fs::read(cache.0.join(".cloud-plugin-manifest.json")).expect("manifest");
        let skills = cursor_plugin_skills(&cache.0);
        let names: Vec<&str> = skills.iter().map(|skill| skill.name.as_str()).collect();
        assert_eq!(names, ["search", "x-chat"]);
        assert_eq!(
            skills[0],
            CommandEntry {
                name: "search".into(),
                description: "Search the workspace.".into(),
                argument_hint: None,
                aliases: None,
                kind: "skill".into(),
                path: Some(cache.0.join("cursor-public/101/aaa/skills/search/SKILL.md").to_string_lossy().into_owned()),
            }
        );
        assert_eq!(fs::read(cache.0.join(".cloud-plugin-manifest.json")).expect("manifest"), manifest);
    }

    /// A disabled plugin offers nothing, an unfinished install is not read
    /// over a finished one, and a version folder's repeat of a name is not
    /// taken over the top-level one.
    #[test]
    fn disabled_unfinished_and_repeated_skills_are_left_out() {
        let cache = Cache::new();
        let names: Vec<String> = cursor_plugin_skills(&cache.0).into_iter().map(|skill| skill.name).collect();
        assert!(!names.contains(&"hidden".to_string()));
        assert!(!names.contains(&"ghost".to_string()));
        let search = cursor_plugin_skills(&cache.0).into_iter().find(|skill| skill.name == "search").expect("search");
        assert_eq!(search.description, "Search the workspace.");
    }

    /// A skill with no name in its frontmatter is named by its folder, and a
    /// block-scalar description reads as one line.
    #[test]
    fn a_skill_takes_its_folder_name_and_a_block_description_as_one_line() {
        let cache = Cache::new();
        let chat = cursor_plugin_skills(&cache.0).into_iter().find(|skill| skill.name == "x-chat").expect("x-chat");
        assert_eq!(chat.description, "Read the timeline and post to it.");
    }

    /// No manifest, or no cache at all, is no skills rather than an error.
    #[test]
    fn a_missing_manifest_or_cache_has_no_skills() {
        let cache = Cache::new();
        assert!(cursor_plugin_skills(&cache.0.join("nowhere")).is_empty());
        fs::remove_file(cache.0.join(".cloud-plugin-manifest.json")).expect("remove");
        assert!(cursor_plugin_skills(&cache.0).is_empty());
    }

    /// The instructions of a skill are the text after its frontmatter; a file
    /// with no frontmatter, or no closing line, is read whole.
    #[test]
    fn a_skills_body_is_the_text_after_its_frontmatter() {
        assert_eq!(skill_body("---\nname: a\n---\n\nDo it.\n"), "Do it.");
        assert_eq!(skill_body("Plain text.\n"), "Plain text.");
        assert_eq!(skill_body("---\nname: a\nno close\n"), "---\nname: a\nno close");
    }

    /// Only the skills a message names are read, in the order it names them;
    /// a name that is no plugin skill is left out, and none names nothing.
    #[test]
    fn only_the_named_skills_are_read_for_a_prompt() {
        let cache = Cache::new();
        let names = ["x-chat".to_string(), "missing".to_string(), "search".to_string()];
        let bodies = cursor_skill_bodies(&cache.0, &names);
        let named: Vec<&str> = bodies.iter().map(|(name, _)| name.as_str()).collect();
        assert_eq!(named, ["x-chat", "search"]);
        assert_eq!(bodies[1].1, "Find things.");
        assert!(cursor_skill_bodies(&cache.0, &[]).is_empty());
    }

    /// With no skills a prompt is the text as it was; with some, each body
    /// comes first and the message last.
    #[test]
    fn the_skills_go_ahead_of_the_message_in_the_prompt() {
        assert_eq!(with_skill_bodies("hello", &[]), "hello");
        let skills = [("search".to_string(), "Find things.".to_string())];
        assert_eq!(
            with_skill_bodies(" look up crew ", &skills),
            "The user invoked the skill `search`. Follow its instructions:\n\nFind things.\n\n---\n\nlook up crew"
        );
        assert_eq!(with_skill_bodies("  ", &skills), "The user invoked the skill `search`. Follow its instructions:\n\nFind things.");
    }
}
