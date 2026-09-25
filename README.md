# Crew

A desktop app for the coding agent CLIs you already pay for: Claude Code, Codex, Cursor, and opencode.

You run a roster of agents, each with its own chat. They can message each other and keep working on a schedule.

Everything runs on your machine. A Rust daemon holds the agents, the transcripts, and a SQLite store; the Electron app is a client over it. No account, no sync, no keys of ours. You bring the CLIs; they stay logged in the way you already use them.

## Install and run

You need [Node](https://nodejs.org) 20+, [Rust](https://rustup.rs), and at least one provider CLI on your `PATH`:

| Provider | Binary |
| --- | --- |
| Claude | `claude` |
| Codex | `codex` |
| Cursor | `cursor-agent` |
| opencode | `opencode` |

Then:

```bash
npm install
npm run app
```

`npm run app` builds `crewd`, starts Vite and opens the window. The daemon is spawned by the app and its data lives in the Electron user-data directory; closing the app stops it and kills every child process it started.

Use `npm run app` while developing. `open -a Crew` and Spotlight go through LaunchServices, which may open a stale `release/` build or an old Tauri bundle instead of this checkout.

To build the app itself (macOS arm64):

```bash
npm run app:build        # → release/, unpacked and fast
npm run release          # → tags, builds the zip, publishes the GitHub release
```

## Install and update

`npm run release` builds `Crew-<version>-arm64.zip` and a `latest.json` next to it — version, download url, sha256 — and publishes both to a GitHub release. Install by unzipping into `/Applications`:

```bash
ditto -x -k release/Crew-0.1.0-arm64.zip /Applications
```

From there Crew updates itself. It reads `latest.json` from the newest release fifteen seconds after launch and every six hours, and asks in a dialog; `Crew › Check for Updates…` asks on demand. The zip is checked against the manifest's sha256 before anything touches the disk, the bundle is swapped by a detached shell once the app has exited, and the app reopens. A checkout build never updates itself.

Releasing needs `gh` logged in, a clean working tree, and the same version in `package.json` and `Cargo.toml` — the script refuses otherwise.

The bundle is ad-hoc signed (`identity: "-"`): that is what arm64 needs to launch at all, and it keeps the updater free of Apple's signing requirements. It is not notarized, so anyone who downloads the zip in a browser has to clear Gatekeeper by hand.

## Development

```bash
npm run check                       # eslint + tsc + vitest + react-doctor
cargo test --workspace

node scripts/drive.mjs              # two agents and a message between them, headless
SCENARIO=code node scripts/drive.mjs
SCENARIO=loop node scripts/drive.mjs
SCENARIO=routine node scripts/drive.mjs
node scripts/sessions.mjs           # claude, opencode and cursor tabs: status and title, end to end
node scripts/shot.mjs               # a screenshot of the chat against the mock
```

`scripts/drive.mjs` defaults to opencode's free models, which need no credentials, so it runs on a machine with nothing logged in.

Protocol types live in `crates/crew-protocol` and generate `src/lib/protocol.ts`, so a message is defined once. `npm run protocol` regenerates them.

## Docs

[Architecture](docs/ARCHITECTURE.md) — how the window, the daemon, and the CLIs fit together.

## Guidelines

Convention over configuration. One process, one repo, one way. A majestic monolith.

- Name things after the product (`Agent`, `Turn`, `Memory`), not after patterns (`AgentService`).
- Prefer many small files over a catch-all `services/` folder.
- Extract a layer when it hurts, not on day one.
- A new feature copies an existing one. If you have to invent a folder, the feature is not shaped yet.
- Every behaviour gets a test. `lib/` in TypeScript, `#[cfg(test)]` in Rust.

## License

[MIT](LICENSE)
