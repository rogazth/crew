# Crew

A personal team of agents you message. Each agent has a provider CLI, a place to work, and the tools Crew gives it. You bring the subscriptions and the machine.

Built for one person first. Later, anyone can run the same setup on a VPS with their own keys and CLIs.

## Why

Coding harnesses give you one agent and a repo. R3 gives you a roster, DMs and a computer — closed, tied to one stack, and it only works if you have time to chat with it.

Crew is the roster product, self-hosted, and it is not a chat companion: it is a control surface over the CLIs you already run. You message an agent, it does the work with its tools, and it reaches you and the other agents without a conversation.

## What it is today

- **A roster of agents.** Each one names a provider and a model: `claude`, `codex`, `cursor` or `opencode`. Adding a provider is a file in `crates/crew-core/src/providers/` and a row in `src/lib/providers.ts`.
- **A chat per agent**, with what the agent did on the line: the command it ran and its exit code, the file it read and the window, the diff tally, the message it sent — folded to one line, open to the output.
- **Agents that write to each other.** `message_agent` drops a letter in the target's box; it arrives as a turn with the sender's name on it. Nothing blocks; a busy agent reads it when its turn ends.
- **Agents that carry on.** Writing to itself is how an agent keeps working past the end of a turn. Twenty-five laps with nobody else speaking stops it.
- **Search over every message**, ⌘⇧F: FTS5, date range, per-agent filter, best-match or newest.
- **Routines**: standing orders that wake an agent on a schedule.
- **Terminals**, for the times you want the CLI yourself.

Agents are disposable. A turn ends and the CLI goes; what persists is the transcript and the provider's own resume token.

## Running it

```bash
npm install
cargo build -p crewd      # the daemon
npm run app               # the desktop app

npm run check             # lint + tsc + vitest + react-doctor
cargo test --workspace

node scripts/drive.mjs              # two agents, a message between them, headless
SCENARIO=code node scripts/drive.mjs
SCENARIO=loop node scripts/drive.mjs
node scripts/shot.mjs               # a screenshot of the chat against the mock
```

`scripts/drive.mjs` defaults to opencode's free models, which need no credentials, so it runs on a machine with nothing logged in.

## How context works

Three stores, never one blob:

| Store | Role | In the model? |
| --- | --- | --- |
| **Transcript** | The chat you scroll. Rows in `messages`, indexed with FTS5. | The tail of the current episode |
| **Working set** | This turn: persona, the last K messages, this turn's tools | Yes, budgeted |
| **Memory** | Durable facts (“ignore Icebox”, “standup at 8”) | A capped slice, always |

Live systems (Jira, Gmail) are queried, not memorized. Compact is an emergency valve on a fat episode, not the architecture.

## The tools an agent gets

Five are listed on every turn — `list_agents`, `message_agent`, `search_messages`, `find_tool`, `call_tool`. Everything else is found with `find_tool`, which ranks the catalogue and answers with a schema ready to call. A hundred tools would cost more prompt than the conversation, and most turns need none of them.

## Stack

Rust daemon (`crewd`: PTYs, provider processes, transcripts, SQLite), Electron shell, React + Vite renderer. The protocol types live in `crates/crew-protocol` and generate `src/lib/protocol.ts`, so a message is defined once.

See `ARCHITECTURE.md` for the decisions and `notes/harness-plan.md` for what is being built now.

## Philosophy

Convention over configuration. One process, one repo, one way.

- Name things after the product (`Agent`, `Turn`, `Memory`), not after patterns (`AgentService`).
- Many small files is fine. A junk drawer named `services/` is not.
- Extract a layer when it hurts, not on day one.
- A new feature copies an existing one. If you have to invent a folder, the feature isn’t shaped yet.
- Every behaviour gets a test. `lib/` in TypeScript, `#[cfg(test)]` in Rust.

This is a majestic monolith. Not Nest modules, not hexagonal ports, not Effect event-sourcing.
