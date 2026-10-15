# Environments — every build keeps to its own space

Decided 2026-10-15, after e2e runs filled `npm run app` with empty workspaces
and left daemons and fakes running for days. Update the status table at the
bottom as each phase lands.

Crew is not one layer any more: an Electron app, a daemon under launchd or
systemd, a CLI, provider CLIs it hosts, processes it supervises, and remote
machines. Each of these resolved its own paths (`$HOME`, `temp_dir()`,
`appData`) and nothing made a process die with its owner. Isolation held only
where someone remembered it.

## What was wrong (2026-10-15 inventory)

- 192 `/tmp/ce-*` workspaces in "Crew Dev", from before `523938b`; nothing
  stopped it happening again but the harness's env.
- `~/.crew/worktrees` and `~/Crew` shared by the release, dev builds and
  cargo tests; on a remote, by every build.
- `$TMPDIR/crew*` (pastes, uploads, titles, opencode configs) shared by every
  local environment.
- `crew` in a dev app's terminal talks to the release's daemon: `child_env`
  strips `CREW_*` and nothing exports `CREW_DATA_DIR`.
- Release and dev share the keychain item ("Crew") and the `crew` link.
- Every e2e crewd runs the real `/opt/homebrew/bin/codex` (fixed dirs in
  `shell_path.rs`, `prewarm_codex_models`); e2e downloads land in the real
  `~/Downloads`.
- Remote ports: the release's SOCKS (17878) is the local build's WebSocket,
  local's SOCKS (17879) is dev's.
- Orphans: agent-mode e2e crewds (`detached` + `unref()`, stopped only if the
  test reaches `quit()`), Python fakes from cargo tests that miss stdin EOF,
  PTY jobs and title runs outside any registry.

## The rules

1. **The data dir is the environment.** Everything Crew writes for itself
   derives from it, through one module (`crew_core::paths`). No other code
   reads `HOME` or `temp_dir()` for Crew's own files.
2. **The launcher decides, once.** It writes `layout.json` (work dir, Home
   folder) when it makes the data dir. With no file, everything stays inside
   the data dir. Works the same for a child crewd, launchd and systemd,
   because crewd reads it, not its argv.
3. **Fail closed.** A test launch with no data dir of its own refuses to
   start; a layout that does not parse stops crewd. A process with no layout
   writes under a temp folder of its own, never a real environment's.
4. **Every process has an owner and dies with it.** A crewd is held by its
   parent's stdin, launchd, systemd, or a pid it was told to outlive no
   longer. Everything crewd spawns is in a process group it records, kills
   on exit and sweeps at the next start.
5. **Isolation is checked, not assumed.** An e2e run fails if it left files
   outside its sandbox or processes naming it.

## Layout

| Environment | Data dir | Work dir (worktrees, Home) |
|---|---|---|
| Release | `Application Support/Crew` | `~/.crew`, Home `~/Crew` |
| Dev / local | `Application Support/Crew Dev` / `Crew Local` | `~/.crew-dev` / `~/.crew-local` |
| Linked checkout | `<checkout>/.crew-dev` | `~/.crew-dev/checkouts/<name>` |
| e2e, seeded data | `CREW_USER_DATA` | `<data>/work` |
| cargo tests, CLI | — | `$TMPDIR/crew-unset-<pid>` |
| Remote | `~/.crew{,-local,-dev}/data` | `~/.crew{,-local,-dev}`, release Home `~/Crew` |

Under the data dir: `tmp/{files,titles,opencode,cookies}` now; next,
`workspaces/<id>/scratch/` and the bots' cwd, in the workspace scratch plan
that builds on this one.

## Phases

**1. Layout.** `crew_core::paths`; crewd reads `layout.json`; Electron and
the remote installer write it; e2e refuses to start without
`CREW_USER_DATA`; temp files, worktrees and Home move under the layout.
Existing worktrees stay where git has them, and an existing Home keeps its
folder (it is stored by id).

**2. Process ownership.**
- `crewd --exit-with-pid <pid>`: the e2e launchd stand-in and the harness's
  `crewd serve` pass the spec's pid; crewd stops when it is gone. The stop is
  sent before anything is logged: stderr is often a pipe to the dead owner,
  and `eprintln!` panics on a failed write (it kept the first version alive).
- The e2e app exits with the same pid (`CREW_E2E_OWNER_PID`).
- One registry of process groups for agents, terminals and supervised
  processes (`agent-groups.json`, shared by the hosts); swept at start.
- Python fakes written through `fakes::install` end when their parent is
  gone, not only on SIGTERM or stdin EOF.
- A sandbox names its spec (`owner.pid`); the next launch deletes the ones
  whose spec is gone.
- Verified: an agent-mode spec with a remote, SIGKILLed mid-test, leaves no
  process; the next run deletes its sandbox.
- Left: title runs (short, with a timeout) are not in the registry; crewd's
  other `eprintln!`s still panic on a closed stderr.

**3. Checks.**
- After each e2e run (`scripts/e2e.mjs`, `scripts/e2e-leaks.mjs`): the
  harness writes every sandbox it makes to `$CREW_E2E_RUN_LOG`; once the
  specs end, the run fails if a live process names one (killed), one is still
  on disk (deleted, unless `E2E_KEEP`), a real app's database has a workspace
  in one, or a real build's worktree folder has a worktree of one. Only this
  run's sandboxes count, so concurrent runs and the user's apps are never
  taken for leaks. Verified with a spec that leaves a process: it passes, the
  run fails, the process is killed.
- `crates/crew-core/tests/own_files.rs` and `electron/own-files.test.ts`
  fail on `temp_dir()`, `HOME`, `homedir()` or `tmpdir()` in production code
  outside a list that gives each file's reason (provider state, the user's
  install dirs, `~/.ssh/config`, …); a file that no longer needs its entry
  fails too. Verified by adding a `temp_dir()` and a `tmpdir()`: both fail.
- Not checked: `~/Downloads` and `$TMPDIR` (other activity on the machine
  writes there); phase 4 moves e2e downloads into the sandbox instead.

**4. Smaller leaks.**
- crewd exports `CREW_DATA_DIR` into every terminal and supervised process:
  `crew` typed in the dev app reaches the dev daemon. e2e `cli-command`
  checks it from a terminal with nothing set by hand (and fails without it).
- Each build its own name: app `Crew` / `Crew Local` / `Crew Dev` (the
  keychain item follows), `crew` / `crew-local` / `crew-dev` on the PATH
  (`electron/channel.ts`). A dev data dir's remote tokens, sealed under the
  old shared key, have to be paired again.
- Remote ports two apart: 17877, 17879, 17881 (a daemon's SOCKS listener is
  the port after it). Machines already set up keep their port until set up
  again.
- e2e: downloads under the sandbox's data dir; `CREW_SANDBOX` keeps crewd's
  CLI lookup to the sandbox's PATH (no Homebrew, no login shell).
- `<data>/tmp` swept at crewd start of what is over a week old.

## Status

| Phase | State |
|---|---|
| 1. Layout | done |
| 2. Process ownership | done |
| 3. Checks | done |
| 4. Smaller leaks | done |
