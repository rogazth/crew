//! What Crew tells the models it runs, in one place to read (plan §6, §7,
//! §7.3, as settled in §7e.4b).
//!
//! Three readers:
//! - a bot, every turn (each turn is a fresh CLI): who it is, how its memory
//!   works, who wrote this turn, how to hand off work, and Crew's tools;
//! - a session a caller started (a child), on its first turn: who started it,
//!   where its final message goes, and Crew's tools. Nothing about how to do
//!   its job: Crew adds context and tools, it does not change how the harness
//!   behaves;
//! - a terminal the user runs: only the MCP server's `instructions()`, since
//!   its prompt is the user's.
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
}

impl Harness {
    pub fn for_provider(provider: &str) -> Self {
        match provider {
            "opencode" => Harness::Opencode,
            "cursor" => Harness::Cursor,
            _ => Harness::Mcp,
        }
    }

    /// One tool, as this harness lists it.
    pub fn spell(self, tool: &str) -> String {
        match self {
            Harness::Mcp => format!("`mcp__crew__{tool}`"),
            Harness::Opencode => format!("`crew_{tool}`"),
            Harness::Cursor => format!("`{tool}`"),
        }
    }

    /// Where the tools are, said once before they are named.
    fn source(self) -> &'static str {
        match self {
            Harness::Mcp => "Crew's tools come from its `crew` MCP server, and your harness lists them as `mcp__crew__<name>`.",
            Harness::Opencode => "Crew's tools come from its `crew` MCP server, and your harness lists them as `crew_<name>`.",
            Harness::Cursor => "Crew's tools are the tools of the MCP server `crew`, called by their own names.",
        }
    }
}

/// Claude Code may still defer an MCP server's tools behind its own tool
/// search; their names are visible there, and one call by name loads them
/// (plan §4.9).
pub const DEFERRED_TOOLS: &str =
    "If you do not see them in your tool list, call one by name once before deciding they are unavailable.";

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

You are {name}, a bot in Crew, a desktop app that runs coding agents side by side. Your id is {id}. {place}
{description}
### Your memory

Every turn starts fresh. You know only what Crew hands you here: these instructions, the latest part of this \
conversation, and the message that started this turn. You see only the latest part of this conversation; find older \
messages with `search_messages`. To keep something for later turns, rewrite your instructions with \
`update_description`. What other bots know, ask them.

### Who wrote this turn

- No header: the user, reading your reply in a chat window. Do the work first, then say what happened.
- `## Message`, from a bot or a session: reply with `send_message` to the id it names. What you write in the chat \
reaches only the user.
- `## Report from session <name> (<id>)`: a session you started ended a turn; what follows is its final message. \
Several reports may arrive together.
- `## Question from session <name> (<id>)`: a session you started waits on a question. Answer it with \
`send_message` to that id. If the decision belongs to the user, ask the user (with your question tool if you have \
one, otherwise in your reply); the user can also answer it in Crew.
- `## Approval from session <name> (<id>)`: a session you started waits for approval to run a command, change a \
file or define a process. If you would do it yourself, decide it: `send_message` \
`{\"to\": \"<id>\", \"decision\": \"allow\"}`, or `\"deny\"`. If it is the user's call, ask the user first, as for a \
question. The user can also decide it in Crew; the first answer counts.
- `## Routine <name>`: a routine woke you.

### Handing off work

Two ways to hand off work, both valid. Your harness's own subagents are the default for work that fits it. A Crew \
session adds what the harness cannot give: another provider or model, its own worktree, work the user can follow and \
steer in Crew, a conversation you can come back to with `send_message`, and a report that wakes you when it is done, \
even after this turn has ended. Pick by what the job needs.

- Delegate, and get woken by the report:
  `start_session` `{\"prompt\": \"Implement the plan below in a new worktree…\", \"worktree\": \"new\"}`
- Need the answer to keep going in this turn:
  `start_session` `{\"prompt\": \"Find which Stripe API version billing uses.\", \"wait\": true}`
- The user wants to carry on there themselves (a handoff): no report, not yours to drive:
  `start_session` `{\"prompt\": \"…\", \"worktree\": \"new\", \"owner\": \"user\"}`

A session sees nothing of this conversation. Put everything it needs in the prompt: the goal, the files, the \
constraints, what done looks like, and whether it may commit.

Do not:
- poll a session with `read_session` in a loop. End your turn; its report wakes you.
- pass a report on to the user unread. Check it; send fixes to the same session with `send_message`.
- interrupt a running session (`\"steer\": true`) except to correct its course.
- create bots unless the user asks for one.
- give orders to other bots. They are peers with their own jobs: ask.
- write to yourself. To come back later, `save_routine` with `{\"schedule\": {\"kind\": \"once\", \"at\": \"…\"}}`.

### Crew tools

{source} {deferred}

{tools}";

const BOT_PROCESSES: &str = "### Dev servers and other processes

The workspace defines its long-running processes (dev servers, watchers, workers) in Crew, where the user can see \
them. Use those; do not start your own:

- `list_processes`: what exists and where it runs.
- Start one and wait until it is up:
  `control_process` `{\"process\": \"web\", \"action\": \"start\"}`, then
  `wait_for_log` `{\"process\": \"web\", \"pattern\": \"ready in\", \"timeout_s\": 60}`
- Look for problems: `read_logs` `{\"process\": \"web\", \"pattern\": \"error|warn\"}`
- The one you need is not there: define it with `save_process` `{\"name\": \"web\", \"command\": \"npm run dev\"}`.

Do not start a server from your shell with `&` or `nohup`: nobody can see it, stop it or read its logs. Commands you \
leave running in the background end with your turn; for anything that must keep running, use a process.";

const BOT_BROWSER: &str = "### Browser

Crew has a browser that the user sees as tabs. Use it for anything in a web page:

- `open_tab` `{\"url\": \"http://localhost:3000\"}`, or reuse one from `list_tabs`.
- `browser_snapshot` before acting, then act on the `uid`s it returns:
  `browser_act` `{\"action\": \"click\", \"uid\": \"4_17\"}`
- `browser_activity` `{\"kind\": \"console\"}` to see errors after an action.
- `release_tab` when you are done.

Do not switch to Playwright, Chrome or any other browser because a first call failed. Read the error and retry with \
corrected arguments. Use another browser only when these tools are absent or the job asks for one. If a call says \
Crew is not open, say so.";

// ---- a session someone started --------------------------------------------

const SESSION: &str = "## Crew session

You are a session in Crew, a desktop app that runs coding agents side by side. {started}. {place}

Your final message of each turn is delivered to {parent}, who keeps the memory of this work and may send you more in \
this same conversation. Messages arrive as turns that start with `## Message`, naming who wrote them.{question}

Your harness's own tools work as usual, subagents included; Crew's tools add to them.

### Crew tools

{source} {deferred}

- `list_peers`: the bots and sessions in this workspace, each with the id it is reached by.
- `send_message`: {write}
  It cannot see this conversation, so give it what it needs.{tools}";

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

// ---- a terminal the user runs ----------------------------------------------

const TERMINAL: &str = "Crew is the app this runs in: it holds a workspace of bots and sessions, and these tools \
reach them. You are the terminal session \"{name}\": the user runs your CLI, and Crew cannot start a turn in it, so \
nothing wakes you, and bots and sessions you write to cannot write back to you.
{glossary} A routine wakes a bot on a schedule, or once.
`start_session` hands a job to a new session. With owner \"me\" (the default) it is yours: its final message each turn \
is its report. With owner \"user\" it is handed to the user and reports to nobody. Nothing wakes you, so check a \
session you started with `read_session`, or start it with \"wait\": true to block until its turn ends (it returns \
early if it asks a question). Questions and approvals of your sessions come to the user in Crew; you may answer a \
question with `send_message`.";

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
    for (catalog, block) in [(crate::process_tools::catalog as fn() -> Vec<crate::tools::Tool>, processes), (crate::browser_tools::catalog, browser)] {
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

fn listed(tools: &[&str]) -> String {
    tools.iter().map(|tool| format!("`{tool}`")).collect::<Vec<_>>().join(", ")
}

/// A bot, as Crew runs it every turn.
pub struct Bot<'a> {
    pub name: &'a str,
    pub id: &'a str,
    pub description: &'a str,
    pub place: Place<'a>,
    pub harness: Harness,
    /// What `tools/list` answers it with; empty when Crew's server is not
    /// there, and then nothing about tools is said.
    pub tools: &'a [&'a str],
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
    let mut text = fill(
        BOT,
        &[
            ("name", name),
            ("id", bot.id),
            ("place", &bot.place.line()),
            ("source", bot.harness.source()),
            ("deferred", DEFERRED_TOOLS),
            ("tools", &format!("Yours, besides the process and browser tools below: {}.", listed(&others(bot.tools)))),
            // Last: it is the user's text, and may hold anything.
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
    Bot { name: &'a str, id: &'a str },
    Terminal { name: &'a str, id: &'a str },
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
}

pub fn session(session: &Session) -> String {
    let (started, parent, write) = match session.parent {
        Parent::Bot { name, id } => (
            format!("{name}, a bot (id {id}), started you"),
            name.to_string(),
            format!(
                "write to {name} or to a bot at any time, without ending your turn (your final message reaches {name} \
                 anyway; this is for what cannot wait for it):\n  `{{\"to\": \"{id}\", \"text\": \"…\"}}`"
            ),
        ),
        Parent::Terminal { name, id } => (
            format!("{name}, a terminal session the user runs (id {id}), started you"),
            name.to_string(),
            "write to a bot at any time, without ending your turn (a terminal cannot be written to):\n  \
             `{\"to\": \"<bot id>\", \"text\": \"…\"}`"
                .to_string(),
        ),
        Parent::User => (
            "The user started you, from the crew command line".to_string(),
            "the user".to_string(),
            "write to a bot at any time, without ending your turn:\n  `{\"to\": \"<bot id>\", \"text\": \"…\"}`".to_string(),
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
    let mut text = fill(
        SESSION,
        &[
            ("started", &started),
            ("place", &session.place.line()),
            ("parent", &parent),
            ("question", &question),
            ("source", session.harness.source()),
            ("deferred", DEFERRED_TOOLS),
            ("write", &write),
            ("tools", &tools),
        ],
    );
    if session.tools.is_empty() {
        text = text.split("\n### Crew tools").next().unwrap_or_default().trim_end().to_string();
    }
    text.push_str(&blocks(session.tools, SESSION_PROCESSES, SESSION_BROWSER));
    spell(&text, session.harness)
}

/// What a terminal is told, in `instructions()`: all Crew says to a CLI
/// whose prompt is the user's.
pub fn terminal(name: &str, harness: Harness) -> String {
    spell(&fill(TERMINAL, &[("glossary", crate::tools::GLOSSARY), ("name", name)]), harness)
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
        })
    }

    fn render_session(harness: Harness, parent: Parent, question_tool: bool, tools: &[&str]) -> String {
        session(&Session { parent, place: PLACE, harness, tools, question_tool })
    }

    const HARNESSES: [Harness; 3] = [Harness::Mcp, Harness::Opencode, Harness::Cursor];

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

    /// The bot hears every header a turn can open with, how to decide an
    /// approval, that it sees only the tail, and the line about background
    /// commands.
    #[test]
    fn the_bot_prompt_says_who_wrote_the_turn_and_how_to_answer() {
        let text = render_bot(Harness::Mcp, &every(CallerKind::Bot));
        assert!(text.starts_with("## Crew bot\n\nYou are Lead, a bot in Crew"), "{text}");
        assert!(text.contains("Your id is b0b. Today is Monday, 5 October 2026. You work in /work/app, on branch main.\n\nYou keep the roadmap.\n\n### Your memory"), "{text}");
        for header in ["## Message", "## Report from session", "## Question from session", "## Approval from session", "## Routine"] {
            assert!(text.contains(&format!("`{header}")), "{header}:\n{text}");
        }
        assert!(text.contains("`mcp__crew__send_message` `{\"to\": \"<id>\", \"decision\": \"allow\"}`"), "{text}");
        assert!(text.contains("You see only the latest part of this conversation; find older messages with `mcp__crew__search_messages`."), "{text}");
        assert!(text.contains("and whether it may commit."), "{text}");
        assert!(text.contains("Commands you leave running in the background end with your turn"), "{text}");
        assert!(text.contains("If a call says Crew is not open, say so."), "{text}");
        assert!(text.contains(DEFERRED_TOOLS), "{text}");
        assert_eq!(text.matches("`mcp__crew__start_session` `{").count(), 3, "{text}");
    }

    /// A bot with no job is still somebody, and says no empty paragraph.
    #[test]
    fn a_bot_with_no_job_is_still_somebody() {
        let text = bot(&Bot { name: " ", id: "b0b", description: "  ", place: PLACE, harness: Harness::Mcp, tools: &[] });
        assert!(text.contains("You are the user's bot, a bot in Crew"), "{text}");
        assert!(text.contains("on branch main.\n\n### Your memory"), "{text}");
        assert!(!text.contains("### Crew tools") && !text.contains("### Browser"), "no server, no tools:\n{text}");
    }

    /// The session prompt is context and tools: no report format, no rules
    /// about how to do the job (plan §7e.4b, S1 and S3).
    #[test]
    fn the_session_prompt_adds_context_and_tools_only() {
        let tools = every(CallerKind::Child);
        let text = render_session(Harness::Mcp, Parent::Bot { name: "Lead", id: "b0b" }, true, &tools);
        assert!(text.starts_with("## Crew session\n\nYou are a session in Crew, a desktop app that runs coding agents side by side. Lead, a bot (id b0b), started you. Today is Monday, 5 October 2026. You work in /work/app, on branch main."), "{text}");
        assert!(text.contains("Your final message of each turn is delivered to Lead, who keeps the memory"), "{text}");
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

    /// A terminal parent cannot be written to, and the user is nobody's id.
    #[test]
    fn the_session_prompt_follows_who_started_it() {
        let tools = every(CallerKind::Child);
        let text = render_session(Harness::Mcp, Parent::Terminal { name: "shell", id: "t1" }, true, &tools);
        assert!(text.contains("shell, a terminal session the user runs (id t1), started you"), "{text}");
        assert!(text.contains("a terminal cannot be written to") && !text.contains("\"to\": \"t1\""), "{text}");
        let text = render_session(Harness::Mcp, Parent::User, false, &tools);
        assert!(text.contains("The user started you, from the crew command line.") && text.contains("delivered to the user"), "{text}");
    }

    /// The terminal hears the words, start_session's owner and wait, that it
    /// cannot be woken, and where its sessions' questions and approvals go.
    #[test]
    fn the_terminal_is_told_how_it_differs() {
        let text = terminal("shell", Harness::Mcp);
        for said in ["A routine wakes a bot", "owner \"me\"", "owner \"user\"", "\"wait\": true", "nothing wakes you", "Questions and approvals of your sessions come to the user", "cannot write back", "`mcp__crew__read_session`"] {
            assert!(text.contains(said), "{said}:\n{text}");
        }
        assert!(terminal("shell", Harness::Opencode).contains("`crew_start_session`"));
    }
}

