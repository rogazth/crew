# Test coverage plan

**In progress.** The status table at the end is the record.

## Goal

Every function in Crew today runs under a test that checks what it does.
The suite stays fast, parallel and deterministic, so it can run on every
commit.

Out of scope, decided: end-to-end runs of the app, visual or screenshot
tests, markup snapshots, smoke/sanity checks, regression suites.

## Baseline (2026-09-23, `fa723b8`)

| Part | Tests | Lines covered |
|---|---|---|
| Rust workspace | ~300 | 83.6% (59 functions never run) |
| `src/lib` | 224 | 54% |
| `src/hooks`, `src/chrome`, `src/surfaces`, `electron/` | 0 | 0% |
| Frontend total | | 15.5% |

The frontend gap is structural. Vitest only collects `src/lib/**/*.test.ts`
and runs in `node`, so no hook, component or main-process code can be tested
today.

Rust gaps, by module: the MCP shim (11%), file helpers (44%), workspace CRUD
(66%), schedule validation (72%), store migrations (74%), the turn runner
(75%, ~650 lines), and the daemon's RPC dispatch (163 of 277 lines unrun).

## Principles

1. **Behavior, not markup.** Assert return values, state, emitted events, and
   calls made across a boundary. Never assert class names, styles, DOM
   structure or rendered text layout.
2. **No wall clock.** TS uses fake timers (`vi.useFakeTimers`,
   `advanceTimersByTimeAsync`). Tokio code uses `#[tokio::test(start_paused =
   true)]`. A test that has to sleep in order to pass is wrong. The one
   exception is a real OS process (PTY, signal, process group), and then the
   wait is bounded.
3. **Every wait is bounded.** `vi.waitFor` in TS. In Rust,
   `tokio::time::timeout(…).await.expect("… in time")` around any stream or
   channel read. A hang fails in seconds; it never stalls the run.
4. **Fakes at the boundary, never around the unit.** Stand-ins replace the
   WebSocket, the `electron` module, `window.crewHost`, provider CLIs (shell
   scripts that print scripted JSONL), and the bridge socket. The module under
   test is never mocked.
5. **Each test owns its state.** Tempdirs, fresh module instances
   (`vi.resetModules` for module-level state), in-memory or temp SQLite. A
   test that mutates the process environment lives in its own
   `crates/*/tests/*.rs` binary.
6. **Colocated and named for the behavior.** `x.ts` gets `x.test.ts` next to
   it. Rust keeps unit tests in the inline `mod tests`, and puts
   cross-process scenarios in `crates/*/tests/`. Test names state the
   behavior (`closing the last tab selects none`), not the function.
7. **Per-module checklist:** the happy path, each error branch,
   empty/boundary input, ordering, dedupe, cleanup (unsubscribe, kill,
   close), corrupt persisted state, cancellation, timers.
8. **Source changes only to make behavior reachable.** Allowed: exporting a
   pure helper, moving pure logic out of a component into `src/lib`, passing
   `now` or a path in instead of reading it globally. Behavior does not
   change, except to fix a bug found along the way. Each fix is listed under
   *Found*.

## Infrastructure

### TypeScript

- Vitest collects `src/**/*.test.{ts,tsx}` and `electron/**/*.test.ts`, with
  `environment: "node"` as the default. A file that needs a DOM opts in with a
  `// @vitest-environment happy-dom` first line, so pure tests don't pay for
  a DOM.
- Dev dependencies: `happy-dom` and `@vitest/coverage-v8`. No Testing
  Library. Hooks and components mount through `react-dom/client` +
  `act`.
- Shared helpers in `src/test/`:
  - `renderHook.ts`: a probe component that mounts a hook and exposes
    `result.current`, `rerender` and `unmount`.
  - `deferred.ts`: a promise the test resolves or rejects, for ordering and
    race tests.
  - `fakeClient.ts`: a stand-in for `lib/client`. It records requests, lets
    the test answer or fail them, and emits daemon events.
  - `fakeSocket.ts`: a `WebSocket` stand-in with `open`, `close`, `message`
    and binary `frame` for transport tests.
  - `dom.ts`: key, click and pointer event helpers for interaction tests.
- `npm run coverage`: v8 coverage with thresholds on the logic directories.
  `npm test` stays coverage-free and fast.

### Rust

- Dev dependencies: `tempfile` (crew-core, crewd), and tokio `test-util`
  (crew-core) for paused time.
- `crew_core::test_support` (`cfg(test)`): `temp_dir`, `temp_store`,
  `fake_cli` (an executable `#!/bin/sh` script standing in for a provider),
  `within` (await with a deadline), and `eventually` (poll a condition with a
  deadline). `crewd` keeps its own server helpers in its test module.
- The four `#[ignore]` tests in `transcript.rs` and `messages.rs` are cost
  probes that are run by hand. They stay ignored.
- `npm run coverage:rust` runs `cargo llvm-cov` for anyone who has it
  installed.

## Workstreams

Each workstream owns its files; two workstreams never edit the same file.
Rust workstreams each run in their own worktree, so one crate's half-written
test module never breaks another's build.

| ID | Scope | Key behaviors |
|---|---|---|
| **T1** | `src/lib` modules with no tests: terminal helpers, `time`, `selection`, `status`, `settings`, `hotkey`, `menu`, `highlighting`, `composedRanges`, `dropTargets`, `fonts`, `agentTheme`, `timing`, `attachments`, `workspaces`, `commands`, `sidebarPrefs`, `claudeStorage`, `notify`, `external`, `shiki`, `scheduler` | key encoding, path and link detection, prefs round-trip and corrupt storage, clamping, formatting |
| **T2** | `src/lib` with I/O or state: `host`, `api`, `pty`, `client/transport`, `agentRuntime`, and the partial files (`blocks`, `mentions`, `providers`, `routines`, `tabs`, `toolDetail`, `transcript`, `activity`, `cron`, `transcriptRows`, `sessionCommand`, `fuzzy`) | request correlation, reconnect and replay hooks, stream buffering cap, write queue cap, host fallbacks, the URL allow-list |
| **T3** | Hooks, part 1: `useSessions`, `useTabs`, `useWorkspaces`, `useNavigation`, `useLaunch`, `useCommand`, `useAppCommands`, `usePages`, `useRoutines`, `useThread`, `useSessionActivity`, `useSessionTitle`, `useConfirmations` | load/merge ordering, event patches, retry after failure, unsubscribe on unmount |
| **T4** | Hooks, part 2: `useAgentSheet`, `useAgentTheme`, `useDefaultAgent`, `useFileDrop`, `useImageSrc`, `useInstalledProviders`, `useProjectFiles`, `useSelectAllScope`, `useSidebarPrefs`, `useSidebarWidth`, `useTabOverflow`, `useTerminalPrefs`, `useTerminalSearch` | persistence, clamping, observer cleanup, stale-response drop |
| **T5** | `electron/`: `main`, `update`, `menu`, `preload`, `build-info` | daemon handshake parsing, crash recovery, navigation and URL policy, CSP, IPC handlers, manifest validation, version compare, checksum, the update schedule |
| **T6** | Logic inside `src/chrome/*` (not `TabBar`, `TabLauncher`) | palette ranking and grouping, sidebar click modifiers, picker filtering, rename commit/cancel, keyboard contracts |
| **T7** | Logic inside `src/surfaces/**` (not `WorkspacePanes`) and `App.tsx` | composer submit/newline/mentions/attachments, question and approval answers, transcript windowing, terminal palette and search, routine editor validation |
| **R1** | `crewd` server: `crates/crewd/src/lib.rs` tests | every RPC method in `dispatch`, send-wait, broadcast, PTY input queue and error, provider-session bind/rebind, routine and mailbox events |
| **R2** | `crewd` process and MCP shim: `crates/crewd/src/main.rs`, `crates/crewd/tests/`, `crates/crew-core/src/{mcp,bridge}.rs` | signal and stdin exit, data dir, the MCP `initialize`/`tools/list`/`tools/call` round-trip against a real bridge, `crew call`, token revoke |
| **R3** | Turn runner: `crates/crew-core/src/turns.rs` | each provider's run and line handling fed by fake CLIs, the claude control channel, cancel, silence watchdog, mailbox drain, exit messages |
| **R4** | Parsers: `providers/*`, `working_set`, `blocks`, `crew-protocol/src/blocks.rs` | table-driven lines for each provider, tool label and detail for each tool, malformed input |
| **R5** | Persistence: `store`, `workspace`, `session`, `messages`, `mailbox`, `transcript` | each migration step from a seeded old schema, reopen idempotency, CRUD and ordering, FTS search filters, nonce dedupe, flush and debounce |
| **R6** | Scheduling and tools: `routine`, `schedule`, `scheduler`, `cron`, `tools` | schedule validation errors, next run, fire/await, every routine tool, argument errors |
| **R7** | Processes and files: `agent`, `pty`, `files`, `provider_session`, `claude_title`, `shell_path` | spawn/kill process groups with real children, PTY flow control, file listing limits and skipped dirs, temp writes, provider session discovery |

## Done when

- **TS:** 100% of functions and ≥ 95% of lines in `src/lib`, `src/hooks`,
  `electron/`, and every module extracted from a component. Component files
  are held to their interactive contracts, not to a line number.
- **Rust:** no function that tests never run, and ≥ 92% of lines
  workspace-wide.
- **Speed:** `npm test` finishes in under 15 s wall-clock. `cargo test
  --workspace` finishes in under 20 s once built. No TS test takes over 1 s,
  and no Rust test over 3 s unless a real process forces it. Each exception
  is listed here.
- `npm run check` and `cargo test --workspace` pass.

## Found

- `crewd` printed its handshake line before it installed its SIGTERM/SIGINT/
  SIGHUP handlers. A SIGTERM in that window killed it without
  `pty.kill_all()`, `agents.kill_all()` or `bridge.shutdown()`, leaving
  orphaned PTYs and agents. The handlers are now installed first (R2).
- `client/transport.ts`: fixed three bugs (T2).
  - A text frame that wasn't JSON, or was `null` or a number, threw inside the
    socket's message handler.
  - A single binary chunk over the 256 KiB buffer cap emptied the stream's
    buffer without updating its byte count. Later chunks that would fit were
    then dropped.
  - `on()` started a connection without catching its rejection.
- `host.ts`: the browser folder-pick fallback returned the parent of the
  picked folder. Fixed (T2).
- `useSelectAllScope`: the hook cleared the selection before reading the
  region it falls back to, so Cmd/Ctrl+A in the transcript, which can't take
  focus, selected nothing. Fixed (T4).
- **Latent, not reached today:**
  - `transport.ts`: closing an old handle for a stream id after it was
    reopened silences the new handler.
  - `pty.ts`: two terminals subscribed to the same session at once would
    close each other's stream on unsubscribe.
  - `routines.ts`: `parseSchedule` accepts a weekday such as 9, which then
    renders blank.
  - `useTerminalSearch` re-runs forever if `dark` is a new function on every
    render. The app passes a stable one.
- **Open, small:**
  - `useAgentTheme` and `useTerminalPrefs`: a change made before the saved
    value loads is overwritten when it lands.
  - `useSidebarWidth` drops the save still pending at unmount, so the last
    200 ms of a drag can be lost.
  - `electron/update.ts` leaves its `crew-update-*` temp folder behind when
    an install fails.
  - `electron/main.ts` accepts a handshake URL with any scheme. Quitting
    while crewd is still starting waits for the handshake or the 10 s
    timeout before sending SIGTERM, and still creates the window.
  - `electron/` isn't type-checked. Under the repo's strict options it has
    three type errors (the handle's stderr type under `stdio: "inherit"`,
    readonly dialog `properties`, a `ReadableStream` cast). None of them
    matters at runtime.
- **Open:** `useTabs` reads `tabs:<workspace>` once. If that read fails, it
  falls back to no tabs and never retries, so the next save writes the empty
  list over the saved tabs. A daemon hiccup at startup can wipe a workspace's
  tabs. Fixing it means choosing between retrying the read and holding writes
  until a read succeeds. That is a design decision, left for a follow-up.

## Status

| ID | Status |
|---|---|
| Infra | done |
| T1 | done |
| T2 | done |
| T3 | done |
| T4 | done |
| T5 | done |
| T6 | pending |
| T7 | pending |
| R1 | pending |
| R2 | pending |
| R3 | pending |
| R4 | pending |
| R5 | pending |
| R6 | pending |
| R7 | pending |
