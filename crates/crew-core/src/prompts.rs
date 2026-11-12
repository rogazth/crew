//! What Crew tells the models it runs, in one place to read (plan §6, §7,
//! §7.3, as settled in §7e.4b).
//!
//! Three readers:
//! - a bot, at the start of each of its sessions (see [`crate::bot_episode`]):
//!   who it is, how its memory works, who wrote this turn, how to hand off work, and Crew's tools;
//! - a subagent a caller started with `delegate` (a child), on its first turn:
//!   who started it, where its final message goes, and Crew's tools. Nothing
//!   about how to do its job: Crew adds context and tools, it does not change
//!   how the harness behaves;
//! - a session of the user's (its chat): only the MCP
//!   server's `instructions()`, since its prompt is the user's.
//!
//! The texts are templates with `{placeholders}`, and name Crew's tools bare,
//! in backticks (`` `send_message` ``). [`spell`] turns each into the name the
//! reader's harness lists it under: a model told a bare name goes looking for
//! that name, and Claude Code has a `SendMessage` of its own that writes to
//! another machine entirely (measured in `scripts/drive.mjs`).

/// How a provider's harness shows the model one of Crew's tools.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Harness {
    /// Claude and Codex namespace an MCP server's tools under its name:
    /// `mcp__crew__send_message`.
    Mcp,
    /// opencode flattens them onto the server name: `crew_send_message`.
    Opencode,
    /// Cursor lists a server's tools under the server and calls them by their
    /// own name: `send_message` on the MCP server `crew`.
    Cursor,
    /// Grok reaches an MCP tool through `use_tool`, with `tool_name`
    /// `crew__send_message` and the arguments in `tool_input`.
    Grok,
}

impl Harness {
    pub fn for_provider(provider: &str) -> Self {
        match provider {
            "opencode" => Harness::Opencode,
            "cursor" => Harness::Cursor,
            "grok" => Harness::Grok,
            _ => Harness::Mcp,
        }
    }

    /// One tool, as this harness lists it.
    pub fn spell(self, tool: &str) -> String {
        match self {
            Harness::Mcp => format!("`mcp__crew__{tool}`"),
            Harness::Opencode => format!("`crew_{tool}`"),
            Harness::Cursor => format!("`{tool}`"),
            Harness::Grok => format!("`crew__{tool}`"),
        }
    }

    /// Where the tools are, said once before they are named.
    fn source(self) -> &'static str {
        match self {
            Harness::Mcp => "Crew's tools come from its `crew` MCP server, and your harness lists them as `mcp__crew__<name>`.",
            Harness::Opencode => "Crew's tools come from its `crew` MCP server, and your harness lists them as `crew_<name>`.",
            Harness::Cursor => "Crew's tools are the tools of the MCP server `crew`, called by their own names.",
            Harness::Grok => {
                "Crew's tools come from its `crew` MCP server. Call one with `use_tool`: `tool_name` is `crew__<name>` \
                 and `tool_input` is the arguments."
            }
        }
    }
}

impl Harness {
    /// What a reader is told of tools listed by name only. Claude Code keeps
    /// the tools Crew marks on demand behind its tool search (`tools::on_demand`),
    /// and calling one before it is loaded fails; Codex has a tool search of
    /// its own. opencode and Cursor list every tool whole.
    fn deferred(self) -> &'static str {
        match self {
            Harness::Mcp => {
                "Some of them, such as the process, browser and routine tools, are listed by name only until you load \
                 them with your tool search: search for one before calling it, and before deciding it is unavailable."
            }
            Harness::Opencode | Harness::Cursor | Harness::Grok => "",
        }
    }
}

/// Where a turn runs and when.
pub struct Place<'a> {
    pub date: &'a str,
    pub cwd: &'a str,
    pub branch: Option<&'a str>,
}

impl Place<'_> {
    fn line(&self) -> String {
        match self.branch.filter(|branch| !branch.is_empty()) {
            Some(branch) => format!("Today is {}. You work in {}, on branch {branch}.", self.date, self.cwd),
            None => format!("Today is {}. You work in {}.", self.date, self.cwd),
        }
    }
}

// ---- the bot ---------------------------------------------------------------

const BOT: &str = "## Crew bot

You are {name}, a bot in Crew, a desktop app that runs coding agents side by side. Your id is {id}. {place}{folder}
{description}{workspace}
### Your memory

Crew carries your session on from one turn to the next while that is cheap, and starts a new one when it is not; a \
new one opens with the latest part of this conversation. The rest is still there: `read_session` with `query` \
searches it, with `around` reads it. Look there before asking the user something they \
may have said. What other bots know, ask them.

### Your rules

The user's decisions about how you work. Add one with `rules` when the user makes one; edit or remove it by its id \
when they change their mind. Yours win over the workspace's when the two disagree. Your description above is who you \
are and your job: change it with `update_description` only when that changes.

{rules}

### Who wrote this turn

A turn with no header is from the user. A turn under a `## ` header (Message, Report, Question, Approval, Routine) \
comes from another bot, a session or Crew, not from the user, and says how to answer it. What you write in the chat \
reaches only the user.

### Handing off work

Crew gives you:
- `delegate`: a subagent that works for you, on any provider or model, in its own worktree if you want, followed and \
steered by the user in Crew. Its report wakes you when it is done.
- `start_session`: a session for the user, in their sidebar, reporting to nobody. Use it when the user wants one they \
can see and talk to, not because they said \"subagent\". `start_sessions` starts several.
- `send_message` continues a conversation with either.

Do not:
- pass a report on to the user unread. Check it, and send fixes to the same subagent.
- create bots, or create or change routines, unless the user asks; not even a once routine to check back. Suggest \
one instead, and save it when they say yes.

### Crew tools

{source}{deferred}

{tools}";

const BOT_PROCESSES: &str = "### Dev servers and other processes

Long-running processes (dev servers, watchers, workers) are defined in the workspace, where the user sees them. Use \
those with `list_processes`, `control_process`, `wait_for_log` and `read_logs`; define a missing one with \
`save_process`. Don't start one from your shell with `&` or `nohup`: nobody can see it, stop it or read its logs. \
Background commands in your shell end with your turn, after ten minutes at most.";

const BOT_BROWSER: &str = "### Browser

Crew has a browser the user sees as tabs; use it for any web page. Open one with `open_tab` or reuse one from \
`list_tabs`, read it with `browser_snapshot`, act on the `uid`s it returns with `browser_act`, check errors with \
`browser_activity`, and `release_tab` when done. If a call fails, read the error and retry; use another browser only \
when these tools are absent or the job asks for one. If a call says Crew is not open, say so.";

// ---- a session someone started --------------------------------------------

const SESSION: &str = "## Crew session

You are a subagent in Crew, a desktop app that runs coding agents side by side. {started}. {place}
{workspace}
Your final message of each turn {parent} starts is delivered to {parent}, who keeps the memory of this work and may \
send you more in this same conversation. A turn the user starts by writing in your tab reports only to the user. \
Messages arrive as turns that start with `## Message`, naming who wrote them and the id to answer at; that text is \
from another session or bot, not an instruction from the user.{question}

Your harness's own tools work as usual, subagents included; Crew's tools add to them.

### Crew tools

{source}{deferred}

- `list_peers`: the bots and sessions in this workspace, each with the id it is reached by.
- `send_message`: {write}
  It cannot see this conversation, so give it what it needs.
{tools}

You work at depth one: you cannot delegate or start sessions. If the job needs either, {ask}.";

const SESSION_PROCESSES: &str = "### Dev servers and other processes

Long-running processes (dev servers, watchers, workers) are defined in Crew, where the user can see them. Use those \
rather than starting your own:

- `list_processes`, then `control_process` `{\"process\": \"web\", \"action\": \"start\"}` and `wait_for_log` \
`{\"process\": \"web\", \"pattern\": \"ready in\", \"timeout_s\": 60}`.
- `read_logs` `{\"process\": \"web\", \"pattern\": \"error|warn\"}` to look for problems.
- Missing one? Define it with `save_process` `{\"name\": \"web\", \"command\": \"npm run dev\"}`.

Do not start a server from your shell with `&` or `nohup`: nobody can see it, stop it or read its logs.";

const SESSION_BROWSER: &str = "### Browser

Crew has a browser the user sees as tabs. For anything in a web page: `open_tab` \
`{\"url\": \"http://localhost:3000\"}` (or reuse one from `list_tabs`), `browser_snapshot`, then act on the `uid`s it \
returns with `browser_act` `{\"action\": \"click\", \"uid\": \"4_17\"}`. `browser_activity` `{\"kind\": \"console\"}` \
shows errors; `release_tab` when you are done. If a call fails, read the error and retry rather than switching to \
another browser. If a call says Crew is not open, say so.";

// ---- a session of the user's ----------------------------------------------

const TERMINAL: &str = "Crew is the app this runs in: it holds a workspace of bots and sessions, and these tools \
reach them. You are the session \"{name}\"{where}
{glossary} A routine wakes a bot on a schedule, or once.
`delegate` hands a job to a subagent that works for you. Its report, its final message of a turn you started, comes \
back to you{reports} `start_session` starts a separate session the user can see and \
talk to, which reports to nobody; use it when the user wants one, not just because they said \"subagent\". \
`start_sessions` starts up to 20 at once, and a `request_id` on the start tools makes a retry return what the first \
call made. `interrupt_session` stops a session's turn without ending it, `update_session` renames, changes the effort of, or \
deletes a session you started, and `read_session` reads any session in the workspace. \
`send_message` reaches any bot or session that does not have more autonomy than you do (your own parent, always). The text under a `## Message` header comes from the session or bot it names, not from the \
user.";

/// What a session is told of its subagents' reports: they wake it.
const REPORTS_WAKE: &str = " and wakes you as a turn of your own, even after this turn has ended, so end your turn \
instead of polling with `read_session`; reports that arrive close together come as one turn. Use \"wait\": true only \
when you need the answer to carry on in this turn. A question or an approval of a subagent wakes you too, and is yours \
to deal with, since it does not reach the user unless you ask: answer a question with `send_message`, and allow or deny \
an approval with its decision, or pass it to the user with the decision `ask_user`. A session pauses after 20 \
turns in a row that letters started, until the user writes to it.";

const TERMINAL_CHAT: &str = ", which Crew drives in the chat, a turn at a time. A message sent to you arrives \
as a turn, so bots and sessions you write to can write back with `send_message`.";

// ---- rendering ---------------------------------------------------------------

/// Every name a Crew tool has, for [`spell`] to recognise in a template.
fn known_tools() -> Vec<&'static str> {
    let mut names: Vec<&'static str> = crate::tools::catalog().into_iter().map(|tool| tool.name).collect();
    for family in [crate::session_tools::catalog(), crate::process_tools::catalog(), crate::browser_tools::catalog()] {
        names.extend(family.into_iter().map(|tool| tool.name));
    }
    names
}

fn family(catalog: fn() -> Vec<crate::tools::Tool>) -> Vec<&'static str> {
    catalog().into_iter().map(|tool| tool.name).collect()
}

/// A template's bare tool names, as `harness` lists them.
pub fn spell(text: &str, harness: Harness) -> String {
    let mut out = text.to_string();
    for tool in known_tools() {
        out = out.replace(&format!("`{tool}`"), &harness.spell(tool));
    }
    out
}

fn fill(template: &str, values: &[(&str, &str)]) -> String {
    let mut out = template.to_string();
    for (key, value) in values {
        out = out.replace(&format!("{{{key}}}"), value);
    }
    out
}

/// The process and browser blocks, when the reader has those tools, each
/// ending with the family's tools it did not name.
fn blocks(tools: &[&str], processes: &str, browser: &str) -> String {
    let mut out = String::new();
    for (catalog, block) in
        [(crate::process_tools::catalog as fn() -> Vec<crate::tools::Tool>, processes), (crate::browser_tools::catalog, browser)]
    {
        let mine: Vec<&str> = family(catalog).into_iter().filter(|name| tools.contains(name)).collect();
        if mine.is_empty() {
            continue;
        }
        out.push_str("\n\n");
        out.push_str(block);
        let unnamed: Vec<&str> = mine.into_iter().filter(|name| !block.contains(&format!("`{name}`"))).collect();
        if !unnamed.is_empty() {
            out.push_str(&format!("\n\nAlso: {}.", listed(&unnamed)));
        }
    }
    out
}

/// The tools a reader has beyond the process and browser families, which
/// their own blocks name.
fn others<'a>(tools: &[&'a str]) -> Vec<&'a str> {
    let process = family(crate::process_tools::catalog);
    let browser = family(crate::browser_tools::catalog);
    tools.iter().copied().filter(|name| !process.contains(name) && !browser.contains(name)).collect()
}

/// A sentence that follows another, or nothing.
fn with_space(text: &str) -> String {
    if text.is_empty() {
        String::new()
    } else {
        format!(" {text}")
    }
}

fn listed(tools: &[&str]) -> String {
    tools.iter().map(|tool| format!("`{tool}`")).collect::<Vec<_>>().join(", ")
}

/// A bot, as Crew starts each of its sessions.
pub struct Bot<'a> {
    pub name: &'a str,
    pub id: &'a str,
    pub description: &'a str,
    pub place: Place<'a>,
    pub harness: Harness,
    /// What `tools/list` answers it with; empty when Crew's server is not
    /// there, and then nothing about tools is said.
    pub tools: &'a [&'a str],
    /// Its rules, oldest first (`crate::rules`).
    pub rules: &'a [crate::rules::Rule],
    /// The workspace it works in, when the user wrote about it.
    pub workspace: Option<&'a Workspace>,
    /// Its folder, for anything it wants to keep (`crate::bot_folder`).
    pub folder: Option<&'a str>,
}

/// A workspace as every session and bot in it is told: what the user wrote
/// about it and its rules. They are the user's alone to write.
#[derive(Clone, Debug, Default)]
pub struct Workspace {
    pub name: String,
    pub id: String,
    pub description: String,
    pub rules: Vec<crate::rules::Rule>,
}

impl Workspace {
    /// The workspace as the store has it; None when there is no such workspace.
    pub fn read(store: &crate::store::Store, id: &str) -> Option<Workspace> {
        let row = crate::workspace::get(store, id.to_string()).ok().flatten()?;
        Some(Workspace {
            description: crate::workspace::description(store, id).unwrap_or_default(),
            rules: crate::rules::list(store, crate::rules::Owner::Workspace(id)).unwrap_or_default(),
            name: row.name,
            id: row.id,
        })
    }
}

/// The workspace's section, from its heading on and ending in a newline; empty
/// when the user wrote nothing about it.
pub fn workspace(workspace: Option<&Workspace>) -> String {
    let Some(workspace) = workspace else { return String::new() };
    let description = workspace.description.trim();
    if description.is_empty() && workspace.rules.is_empty() {
        return String::new();
    }
    let mut out = format!("\n### Workspace {}\n", workspace.name.trim());
    if !description.is_empty() {
        out.push_str(&format!("\n{description}\n"));
    }
    if !workspace.rules.is_empty() {
        let lines = crate::rules::lines(crate::rules::Owner::Workspace(&workspace.id), &workspace.rules);
        out.push_str(&format!("\nRules for everyone who works here:\n\n{lines}\n"));
    }
    out
}

/// What a session of the user's is told in its system prompt: the same
/// workspace section a bot and a subagent get, and nothing else, since the
/// rest of its prompt is the user's CLI's. None when the user wrote nothing
/// about the workspace.
pub fn user_session(workspace: Option<&Workspace>) -> Option<String> {
    let section = self::workspace(workspace);
    let section = section.trim();
    (!section.is_empty()).then(|| section.to_string())
}

pub fn bot(bot: &Bot) -> String {
    let name = match bot.name.trim() {
        "" => "the user's bot",
        named => named,
    };
    let description = match bot.description.trim() {
        "" => String::new(),
        job => format!("\n{job}\n"),
    };
    let harness_deferred = with_space(bot.harness.deferred());
    let folder = match bot.folder {
        Some(folder) => format!("\nYour folder, for anything you want to keep: {folder}"),
        None => String::new(),
    };
    let mut text = fill(
        BOT,
        &[
            ("folder", &folder),
            ("name", name),
            ("id", bot.id),
            ("place", &bot.place.line()),
            ("source", bot.harness.source()),
            ("deferred", &harness_deferred),
            ("tools", &format!("Yours, besides the process and browser tools below: {}.", listed(&others(bot.tools)))),
            // Last: they are the user's and the bot's text, and may hold anything.
            ("workspace", &workspace(bot.workspace)),
            ("rules", &crate::rules::lines(crate::rules::Owner::Bot(bot.id), bot.rules)),
            ("description", &description),
        ],
    );
    if bot.tools.is_empty() {
        // No server: the sections that name its tools go.
        text = text.split("\n### Crew tools").next().unwrap_or_default().trim_end().to_string();
    }
    text.push_str(&blocks(bot.tools, BOT_PROCESSES, BOT_BROWSER));
    spell(&text, bot.harness)
}

/// Who started a session.
pub enum Parent<'a> {
    Bot {
        name: &'a str,
        id: &'a str,
    },
    Terminal {
        name: &'a str,
        id: &'a str,
    },
    /// The user, from the `crew` command line.
    User,
}

/// A session a caller started, on its first turn.
pub struct Session<'a> {
    pub parent: Parent<'a>,
    pub place: Place<'a>,
    pub harness: Harness,
    pub tools: &'a [&'a str],
    /// Its harness has a question tool Crew carries to the parent.
    pub question_tool: bool,
    /// The workspace it works in, when the user wrote about it.
    pub workspace: Option<&'a Workspace>,
}

pub fn session(session: &Session) -> String {
    let (started, parent, write, ask) = match session.parent {
        Parent::Bot { name, id } | Parent::Terminal { name, id } => (
            format!(
                "{name}, {} (id {id}), started you",
                if matches!(session.parent, Parent::Bot { .. }) { "a bot" } else { "a session of the user's" }
            ),
            name.to_string(),
            format!(
                "write to {name} or to a bot at any time, without ending your turn (your final message reaches {name} \
                 anyway; this is for what cannot wait for it):\n  `{{\"to\": \"{id}\", \"text\": \"…\"}}`"
            ),
            format!("ask {name} with `send_message`"),
        ),
        Parent::User => (
            "The user started you, from the crew command line".to_string(),
            "the user".to_string(),
            "write to a bot at any time, without ending your turn:\n  `{\"to\": \"<bot id>\", \"text\": \"…\"}`".to_string(),
            "say so in your final message".to_string(),
        ),
    };
    let question = if session.question_tool {
        format!(" If you need to ask something, your question tool reaches {parent}, who answers it; the user can answer it in Crew too.")
    } else {
        String::new()
    };
    let named = ["list_peers", "send_message"];
    let rest: Vec<&str> = others(session.tools).into_iter().filter(|tool| !named.contains(tool)).collect();
    let tools = if rest.is_empty() { String::new() } else { format!("\n- Also yours: {}.", listed(&rest)) };
    let harness_deferred = with_space(session.harness.deferred());
    let mut text = fill(
        SESSION,
        &[
            ("started", &started),
            ("place", &session.place.line()),
            ("parent", &parent),
            ("question", &question),
            ("source", session.harness.source()),
            ("deferred", &harness_deferred),
            ("write", &write),
            ("ask", &ask),
            ("tools", &tools),
            // Last: the user's text, which may hold anything.
            ("workspace", &workspace(session.workspace)),
        ],
    );
    if session.tools.is_empty() {
        text = text.split("\n### Crew tools").next().unwrap_or_default().trim_end().to_string();
    }
    text.push_str(&blocks(session.tools, SESSION_PROCESSES, SESSION_BROWSER));
    spell(&text, session.harness)
}

/// What a session of the user's is told, in `instructions()`: all Crew says
/// to a CLI whose prompt is the user's.
pub fn terminal(name: &str, harness: Harness) -> String {
    let place = TERMINAL_CHAT;
    let reports = REPORTS_WAKE;
    spell(
        &fill(TERMINAL, &[("glossary", crate::tools::GLOSSARY), ("name", name), ("where", place), ("reports", reports)]),
        harness,
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::caller::CallerKind;

    const PLACE: Place<'static> = Place { date: "Monday, 5 October 2026", cwd: "/work/app", branch: Some("main") };

    fn every(kind: CallerKind) -> Vec<&'static str> {
        crate::tools::all_visible_names(kind)
    }

    fn render_bot(harness: Harness, tools: &[&str]) -> String {
        bot(&Bot {
            name: "Lead",
            id: "b0b",
            description: "You keep the roadmap.",
            place: PLACE,
            harness,
            tools,
            rules: &[],
            workspace: None,
            folder: None,
        })
    }

    fn render_session(harness: Harness, parent: Parent, question_tool: bool, tools: &[&str]) -> String {
        session(&Session { parent, place: PLACE, harness, tools, question_tool, workspace: None })
    }

    const HARNESSES: [Harness; 4] = [Harness::Mcp, Harness::Opencode, Harness::Cursor, Harness::Grok];

    /// Each reader is told every tool `tools/list` gives it, spelled the way
    /// its harness lists them, and none it does not have.
    #[test]
    fn every_prompt_names_the_tools_its_reader_has_as_its_harness_spells_them() {
        let bot_tools = every(CallerKind::Bot);
        let child_tools = every(CallerKind::Child);
        for harness in HARNESSES {
            let text = render_bot(harness, &bot_tools);
            for tool in &bot_tools {
                assert!(text.contains(&harness.spell(tool)), "{harness:?} bot is not told {tool}:\n{text}");
            }
            let text = render_session(harness, Parent::Bot { name: "Lead", id: "b0b" }, true, &child_tools);
            for tool in &child_tools {
                assert!(text.contains(&harness.spell(tool)), "{harness:?} session is not told {tool}:\n{text}");
            }
            for tool in bot_tools.iter().filter(|tool| !child_tools.contains(tool)) {
                assert!(!text.contains(&format!("{tool}`")), "{harness:?} session is told {tool}:\n{text}");
            }
            if harness != Harness::Cursor {
                for text in [render_bot(harness, &bot_tools), text] {
                    for tool in known_tools() {
                        assert!(!text.contains(&format!("`{tool}`")), "a bare {tool}:\n{text}");
                    }
                }
            }
        }
    }

    /// Nothing a model reads names a tool that is gone, or the gateway.
    #[test]
    fn no_prompt_names_a_tool_that_is_gone() {
        let texts = [
            render_bot(Harness::Mcp, &every(CallerKind::Bot)),
            render_session(Harness::Mcp, Parent::Bot { name: "Lead", id: "b0b" }, true, &every(CallerKind::Child)),
            terminal("shell", Harness::Mcp),
        ];
        for text in texts {
            for gone in crate::tools::REMOVED_TOOLS.iter().chain(&["find_tool", "call_tool"]) {
                assert!(!text.contains(gone), "{gone}:\n{text}");
            }
        }
    }

    /// The bot hears the headers a turn can open with, the tools to hand off
    /// work, and what is not for it to do; the rest each tool says itself.
    #[test]
    fn the_bot_prompt_says_who_wrote_the_turn_and_how_to_hand_off() {
        let text = render_bot(Harness::Mcp, &every(CallerKind::Bot));
        assert!(text.starts_with("## Crew bot\n\nYou are Lead, a bot in Crew"), "{text}");
        assert!(text.contains("Your id is b0b. Today is Monday, 5 October 2026. You work in /work/app, on branch main.\n\nYou keep the roadmap.\n\n### Your memory"), "{text}");
        assert!(text.contains("(Message, Report, Question, Approval, Routine)"), "{text}");
        assert!(text.contains("not from the user, and says how to answer it"), "{text}");
        assert!(text.contains("`mcp__crew__read_session` with `query` searches it, with `around` reads it."), "{text}");
        let memory = text.split("### Your memory").nth(1).and_then(|rest| rest.split("###").next()).unwrap_or_default();
        assert!(!memory.contains("update_description"), "the description is not a notebook:\n{memory}");
        assert!(text.contains("Background commands in your shell end with your turn"), "{text}");
        assert!(text.contains("If a call says Crew is not open, say so."), "{text}");
        assert!(text.contains(Harness::Mcp.deferred()), "{text}");
        assert!(text.contains("Crew gives you:\n- `mcp__crew__delegate`: a subagent that works for you"), "{text}");
        assert!(text.contains("not because they said \"subagent\""), "{text}");
        // Not for the prompt: how to write a reply, which subagents come first, how to treat other bots.
        for gone in ["leading with the result", "harness's own subagents", "give orders", "request_id", "whether it may commit"] {
            assert!(!text.contains(gone), "{gone}:\n{text}");
        }
    }

    fn rule(id: i64, body: &str) -> crate::rules::Rule {
        crate::rules::Rule { id, body: body.into(), created_at: 1_792_000_000_000, updated_at: 1_792_000_000_000 }
    }

    /// The rules are in every turn, with their ids; the description is offered for who the bot is, not as a notebook.
    #[test]
    fn the_bot_is_handed_its_rules() {
        let rules = vec![rule(1, "Never push to master."), rule(4, "Run the tests before pushing.")];
        let tools = every(CallerKind::Bot);
        let text = bot(&Bot {
            name: "Home",
            id: "b0b",
            description: "You run the house.",
            place: PLACE,
            harness: Harness::Mcp,
            tools: &tools,
            rules: &rules,
            workspace: None,
            folder: None,
        });
        assert!(
            text.contains(
                "### Your rules\n\nThe user's decisions about how you work. Add one with `mcp__crew__rules` when the user \
                 makes one; edit or remove it by its id when they change their mind. Yours win over the workspace's when \
                 the two disagree. Your description above is who you are and your job: change it with \
                 `mcp__crew__update_description` only when that changes.\n\n"
            ),
            "{text}"
        );
        assert!(
            text.contains("\n\n[r1] Never push to master.\n[r4] Run the tests before pushing.\n\n### Who wrote this turn"),
            "{text}"
        );
        assert!(!text.contains("### Your notes") && !text.contains("memory`"), "{text}");
        let empty = render_bot(Harness::Mcp, &tools);
        assert!(empty.contains("\n\nNone yet.\n\n"), "{empty}");
    }

    /// The workspace's description and rules sit under the bot's own
    /// description, and a subagent hears them too; a workspace the user wrote
    /// nothing about adds nothing.
    #[test]
    fn the_workspace_is_told_to_its_bots_and_subagents() {
        let place = Workspace {
            name: "crew".into(),
            id: "w0".into(),
            description: "A desktop app.".into(),
            rules: vec![rule(1, "Commits in English."), rule(3, "Never push.")],
        };
        let text = bot(&Bot {
            name: "Home",
            id: "b0b",
            description: "You run the house.",
            place: PLACE,
            harness: Harness::Mcp,
            tools: &[],
            rules: &[],
            workspace: Some(&place),
            folder: None,
        });
        assert!(
            text.contains(
                "You run the house.\n\n### Workspace crew\n\nA desktop app.\n\nRules for everyone who works here:\n\n\
                 [w1] Commits in English.\n[w3] Never push.\n\n### Your memory"
            ),
            "{text}"
        );
        let child = session(&Session {
            parent: Parent::User,
            place: PLACE,
            harness: Harness::Mcp,
            tools: &[],
            question_tool: false,
            workspace: Some(&place),
        });
        assert!(child.contains("on branch main.\n\n### Workspace crew\n\nA desktop app.\n"), "{child}");
        assert!(child.contains("[w3] Never push.\n\nYour final message"), "{child}");
        let blank = Workspace { name: "crew".into(), ..Workspace::default() };
        assert_eq!(workspace(Some(&blank)), "");
        let rules_only = Workspace { rules: vec![rule(1, "Never push.")], ..blank };
        assert_eq!(
            workspace(Some(&rules_only)),
            "\n### Workspace crew\n\nRules for everyone who works here:\n\n[w1] Never push.\n"
        );
    }

    /// The bot's folder is one line under where it works, and nothing more.
    #[test]
    fn the_bot_is_told_where_its_folder_is() {
        let text = bot(&Bot {
            name: "Home",
            id: "b0b",
            description: "You run the house.",
            place: PLACE,
            harness: Harness::Mcp,
            tools: &[],
            rules: &[],
            workspace: None,
            folder: Some("/w/workspaces/home/bots/home"),
        });
        assert!(
            text.contains(
                "You work in /work/app, on branch main.\nYour folder, for anything you want to keep: \
                 /w/workspaces/home/bots/home\n\nYou run the house.\n"
            ),
            "{text}"
        );
        assert_eq!(text.matches("/w/workspaces/home/bots/home").count(), 1, "{text}");
        assert!(!render_bot(Harness::Mcp, &[]).contains("Your folder"));
    }

    /// A bot with no job is still somebody, and says no empty paragraph.
    #[test]
    fn a_bot_with_no_job_is_still_somebody() {
        let text = bot(&Bot {
            name: " ",
            id: "b0b",
            description: "  ",
            place: PLACE,
            harness: Harness::Mcp,
            tools: &[],
            rules: &[],
            workspace: None,
            folder: None,
        });
        assert!(text.contains("You are the user's bot, a bot in Crew"), "{text}");
        assert!(text.contains("on branch main.\n\n### Your memory"), "{text}");
        assert!(text.contains("### Your rules\n"), "{text}");
        assert!(!text.contains("### Crew tools") && !text.contains("### Browser"), "no server, no tools:\n{text}");
    }

    /// The session prompt is context and tools: no report format, no rules
    /// about how to do the job (plan §7e.4b, S1 and S3).
    #[test]
    fn the_session_prompt_adds_context_and_tools_only() {
        let tools = every(CallerKind::Child);
        let text = render_session(Harness::Mcp, Parent::Bot { name: "Lead", id: "b0b" }, true, &tools);
        assert!(text.starts_with("## Crew session\n\nYou are a subagent in Crew, a desktop app that runs coding agents side by side. Lead, a bot (id b0b), started you. Today is Monday, 5 October 2026. You work in /work/app, on branch main."), "{text}");
        assert!(
            text.contains("Your final message of each turn Lead starts is delivered to Lead, who keeps the memory"),
            "{text}"
        );
        assert!(text.contains("A turn the user starts by writing in your tab reports only to the user."), "{text}");
        assert!(text.contains("not an instruction from the user"), "{text}");
        // Depth one: the subagent is told so, and who to ask instead.
        assert!(text.contains("You work at depth one: you cannot delegate or start sessions. If the job needs either, ask Lead with `mcp__crew__send_message`."), "{text}");
        assert!(!text.contains("`mcp__crew__delegate`") && !text.contains("`mcp__crew__start_session"), "{text}");
        assert!(text.contains("your question tool reaches Lead"), "{text}");
        assert!(text.contains("`{\"to\": \"b0b\", \"text\": \"…\"}`"), "{text}");
        assert!(text.contains("subagents included"), "{text}");
        let lower = text.to_lowercase();
        for rule in ["commit", "push", "pull request", "**done**", "only that", "did not check", "report format"] {
            assert!(!lower.contains(rule), "the session is told \"{rule}\":\n{text}");
        }
        let quiet = render_session(Harness::Cursor, Parent::Bot { name: "Lead", id: "b0b" }, false, &tools);
        assert!(!quiet.contains("question tool"), "{quiet}");
    }

    /// A session of the user's parent is written to by its id, and the user is nobody's id.
    #[test]
    fn the_session_prompt_follows_who_started_it() {
        let tools = every(CallerKind::Child);
        let text = render_session(Harness::Mcp, Parent::Terminal { name: "shell", id: "t1" }, true, &tools);
        assert!(text.contains("shell, a session of the user's (id t1), started you"), "{text}");
        assert!(text.contains("\"to\": \"t1\""), "{text}");
        let text = render_session(Harness::Mcp, Parent::User, false, &tools);
        assert!(
            text.contains("The user started you, from the crew command line.") && text.contains("delivered to the user"),
            "{text}"
        );
        assert!(text.contains("If the job needs either, say so in your final message."), "{text}");
    }

    /// A session of the user's hears the words, the tools, that a report wakes it
    /// and where its subagents' questions and approvals go, and that a message
    /// arrives as a turn.
    #[test]
    fn a_session_of_the_users_is_told_how_it_works() {
        let chat = terminal("shell", Harness::Mcp);
        for said in [
            "A routine wakes a bot",
            "A subagent is a session started with delegate",
            "reports to nobody",
            "`mcp__crew__delegate`",
            "`mcp__crew__start_session`",
            "`mcp__crew__start_sessions`",
            "`mcp__crew__interrupt_session`",
            "`mcp__crew__update_session`",
            "\"wait\": true",
            "not just because they said \"subagent\"",
            "not have more autonomy than you do",
            "not from the user",
            "`mcp__crew__read_session`",
            "Crew drives in the chat",
            "arrives as a turn",
            "wakes you as a turn of your own",
            "end your turn instead of polling",
            "one turn",
            "pauses after 20",
        ] {
            assert!(chat.contains(said), "{said}:\n{chat}");
        }
        assert!(
            !chat.contains("owner") && !chat.contains("nothing can write to you") && !chat.contains("does not wake you"),
            "{chat}"
        );
        assert!(terminal("shell", Harness::Opencode).contains("`crew_start_session`"));
    }
}
