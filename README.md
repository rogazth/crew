# Crew

A desktop app for the coding agent CLIs you already pay for: Claude Code, Codex, Cursor, and opencode.

You run a roster of agents, each with its own chat. They can message each other and keep working on a schedule.

Everything runs on your machine. A Rust daemon holds the agents, the transcripts, and a SQLite store; the Electron app is a client over it. No account, no sync, no keys of ours. You bring the CLIs; they stay logged in the way you already use them.

A workspace can also live on another Linux machine on your Tailscale network. Settings › Environments installs `crewd` there over SSH, and ⌘O opens a folder on it. The window stays on this Mac and talks to that daemon directly. Agent CLIs have to be logged in on the machine that runs them. Ubuntu, with Tailscale, is the supported remote. Windows is not.

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

`npm run app` builds `crewd` and `crew`, starts Vite and opens the window. The daemon is spawned by the app and its data lives in the Electron user-data directory; closing the app stops it and kills every child process it started.

Use `npm run app` while developing. `open -a Crew` and Spotlight go through LaunchServices, which may open a stale `release/` build or an old Tauri bundle instead of this checkout.

To build the app itself (macOS arm64):

```bash
npm run app:build        # → release/, unpacked and fast
```

## Releasing

Releases are built by GitHub Actions on a macOS runner, so any machine with node, git and push access can cut one:

```bash
npm run release -- patch    # or minor, major, or an exact version like 0.2.0
```

That bumps the version in `package.json`, `package-lock.json`, `Cargo.toml` and `Cargo.lock`, commits `chore: bump the version to X`, tags `vX` and pushes master and the tag together. It refuses on a dirty tree, off master, or behind origin.

The tag starts [`.github/workflows/release.yml`](.github/workflows/release.yml), which runs `scripts/release-publish.mjs`: it builds `Crew-<version>-arm64.zip` and a `latest.json` next to it (version, download url, sha256) and publishes both to the GitHub release. Pushes to master never run it. To retry a tag whose publish failed, run the workflow by hand: `gh workflow run release.yml -f tag=vX`; it replaces the release's files.

## Install and update

Install by unzipping the release zip into `/Applications`:

```bash
ditto -x -k Crew-0.1.0-arm64.zip /Applications
```

From there Crew updates itself. It reads `latest.json` from the newest release fifteen seconds after launch and every six hours, and asks in a dialog; `Crew › Check for Updates…` asks on demand. The zip is checked against the manifest's sha256 before anything touches the disk, the bundle is swapped by a detached shell once the app has exited, and the app reopens. A checkout build never updates itself.

The bundle is ad-hoc signed (`identity: "-"`): that is what arm64 needs to launch at all, and it keeps the updater free of Apple's signing requirements. It is not notarized, so anyone who downloads the zip in a browser has to clear Gatekeeper by hand.

## The `crew` command

The app ships a CLI. **Crew › Install `crew` Command…** links it into `~/.local/bin` when your shell looks there, or into `/usr/local/bin` with your password.

```bash
crew status                        # is Crew running, and who does it take you for
crew agents list                   # the agents of the workspace you are in
crew agents send Reviewer "look at the diff on main"
crew processes list                # and start, stop, restart, logs -f, add, edit…
crew tabs snapshot                 # the browser: open, navigate, click, fill, screenshot…
crew --help                        # every group; `crew <group> --help` for its commands
crew completions zsh > ~/.zfunc/_crew
```

From your own shell it speaks as you, in the workspace that holds the current directory (`--workspace` names another). Inside a Crew session it speaks as that session. `--json` prints what the tool answered with. `crew mcp` serves the same tools to an MCP client.

For a checkout, `scripts/crew-dev dev` runs the app from source, `scripts/crew-dev build` builds the bundle, and `scripts/crew-dev cli …` runs the checkout's `crew` against the dev app.

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
npm run app:design                  # the app on a seeded profile of its own (port 1421)
npm run app:design -- --reseed      # wipe that profile and seed it again
```

`npm run app:design` runs next to a regular `npm run app`: it keeps its data in `~/Library/Application Support/Crew Design` and seeds it on first run with five workspaces (git repos, worktrees with diffs, a non-git folder, an empty one), agents and sessions on every provider and in every status, transcripts, routines with run history and open tabs. Statuses stay as seeded (`CREW_KEEP_STATUS`), so a working or waiting agent can be looked at without a live turn.

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
