# Crew

A desktop app for the coding agent CLIs you already pay for (Claude Code, Codex, Cursor, opencode) — a roster of agents with a chat each, that message each other and keep working on a schedule.

Everything runs on your machine. A Rust daemon holds the agents, the transcripts and a SQLite store; the Electron app is a client over it. No account, no sync, no keys of ours — you bring the CLIs and they stay logged in the way you already logged them in.

## Install and run

You need [Node](https://nodejs.org) 20+, [Rust](https://rustup.rs), and at least one provider CLI on your `PATH`:

| Provider | Binary | Install |
| --- | --- | --- |
| Claude | `claude` | [claude.com/product/claude-code](https://claude.com/product/claude-code) |
| Codex | `codex` | [github.com/openai/codex](https://github.com/openai/codex) |
| Cursor | `cursor-agent` | [cursor.com/cli](https://cursor.com/cli) |
| opencode | `opencode` | [opencode.ai](https://opencode.ai) — free models, no credentials |

Then:

```bash
npm install
npm run app
```

`npm run app` builds `crewd`, starts Vite and opens the window. The daemon is spawned by the app and its data lives in the Electron user-data directory; closing the app stops it and kills every child process it started.

To build the app itself (macOS arm64):

```bash
npm run app:build        # → release/
```

## Day to day

Open a workspace — a folder on disk — and add agents to it. Each agent names a provider and a model, gets a description that is its standing instructions, and works in that folder.

- **A chat per agent**, with what it did on the line: the command and its exit code, the file and the window it read, the diff tally, the message it sent. Folded to one line, open to the output.
- **Agents that write to each other.** `message_agent` drops a letter in the target's box and returns immediately; it arrives as a turn with the sender on it. A busy agent reads it when its turn ends.
- **Routines** — standing orders that wake an agent on a schedule. The daemon fires them, so the window does not have to be open.
- **Search over every message**, `⌘⇧F`: full-text, date range, per-agent, best-match or newest.
- **Terminals**, for when you want the CLI yourself.
- **Autonomy per agent**: `ask` stops at every command for an Allow, `full` runs unattended.

Agents are disposable. A turn ends and the CLI process goes; what persists is the transcript. Nothing is resumed — the next turn opens a clean provider session and Crew hands it the conversation back.

## Development

```bash
npm run check                       # eslint + tsc + vitest + react-doctor
cargo test --workspace

node scripts/drive.mjs              # two agents and a message between them, headless
SCENARIO=code node scripts/drive.mjs
SCENARIO=loop node scripts/drive.mjs
SCENARIO=routine node scripts/drive.mjs
node scripts/shot.mjs               # a screenshot of the chat against the mock
```

`scripts/drive.mjs` defaults to opencode's free models, which need no credentials, so it runs on a machine with nothing logged in.

Protocol types live in `crates/crew-protocol` and generate `src/lib/protocol.ts`, so a message is defined once. `npm run protocol` regenerates them.

## Docs

| | |
| --- | --- |
| [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) | the stack, the data model, the hard limits, and why each one |
| [`docs/plans/`](docs/plans) | what is being built, dated, one file per round |
| [`docs/demo.md`](docs/demo.md) | five minutes of Crew, in the order that makes the point |
| [`docs/protocols/`](docs/protocols) | captured stdout from the four provider CLIs, cited by the parsers |

## Philosophy

Convention over configuration. One process, one repo, one way.

- Name things after the product (`Agent`, `Turn`, `Memory`), not after patterns (`AgentService`).
- Many small files is fine. A junk drawer named `services/` is not.
- Extract a layer when it hurts, not on day one.
- A new feature copies an existing one. If you have to invent a folder, the feature is not shaped yet.
- Every behaviour gets a test. `lib/` in TypeScript, `#[cfg(test)]` in Rust.

This is a majestic monolith. Not Nest modules, not hexagonal ports, not Effect event-sourcing.
