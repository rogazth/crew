# Test coverage plan

**Shipped.** Every workstream landed; the status table at the end is the
record. Kept for the reasoning and the findings, some of which are still
open.

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

## Result

| Part | Tests | Lines | Functions |
|---|---|---|---|
| Rust workspace | 838 | 97.6% | none never run |
| `src/lib` | | 100% | 100% |
| `src/hooks` | | 100% | 100% |
| `electron/` | | 100% | 100% |
| `src/chrome`, `src/surfaces` | | 80% / 59–79% | contracts, not a number |
| Frontend total | 1912 | 85.3% | 93.2% |

`npm test` runs in about 16 s on this machine while other work shares the
CPU. `cargo test --workspace` takes about 11 s once built; its largest
binary, crew-core's lib tests, takes about 6.5 s. `npm run coverage` fails
if logic in `src/lib`, `src/hooks` or `electron/` drops below 100% of
functions or 95% of lines.

What remains uncovered is presentation (icons, layout, badges), OS failures
a test can't cause, and races between two statements. Each workstream's
report lists its lines and the reason.

The frontend gap was structural. Vitest only collects `src/lib/**/*.test.ts`
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
- The Rust sources are not rustfmt-formatted, so new test code matches the
  file around it by hand. Running `cargo fmt` would rewrite whole files.

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
- `mcp.rs`: `initialize` echoed back any `protocolVersion` a client sent,
  including versions the shim doesn't know. It now answers with a version it
  supports (2024-11-05, 2025-03-26 or 2025-06-18), as MCP requires. A client
  that asks for a newer revision gets 2025-06-18 and decides whether to
  continue (R2).
- `useSelectAllScope`: the hook cleared the selection before reading the
  region it falls back to, so Cmd/Ctrl+A in the transcript, which can't take
  focus, selected nothing. Fixed (T4).
- `turns.rs` (R3), six ways a turn could get stuck:
  - A codex, cursor or opencode CLI that couldn't start, or an opencode
    prompt that couldn't be sent, left the turn marked running for
    2 minutes.
  - A Claude message that couldn't be written did the same, until a
    restart.
  - A Claude CLI that never answered `initialize` was left running.
  - The kill a stop schedules 1.5 s later hit whichever turn was running by
    then.
  - A stop during a pending approval was undone by the refusal that
    followed it.
  - A stop that landed before a codex, cursor or opencode runner started
    was lost.
- `pty.rs`: a spawn that failed to duplicate the slave fd leaked both PTY
  descriptors (R7).
- `cron.rs`: in the repeated hour when summer time ends, `next_cron` could
  return a time in the past, so a routine refired every second (R6).
- `routine.rs`: saving a routine with a different agent silently kept the
  old agent (R6).
- `tools.rs`: `search_messages` overflowed on a huge `days` (R6).
- `Composer`: the `@` file picker never closed on Escape or blur, and
  Escape's keyup reopened it (T7).
- `CommandPalette` and `WorkspacePicker`: ArrowDown on an empty list left the
  cursor at -1, so Enter did nothing once results arrived (T6).
- Fixed after the workstreams (F2):
  - `useAgentTheme` and `useTerminalPrefs` no longer let a late load
    overwrite a change made before it.
  - `useSidebarWidth` saves at unmount instead of dropping the pending save.
  - `electron/update.ts` removes its temp folder when an install fails, and
    waits for the swap shell to start before quitting.
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
  - `src/lib/cron.ts` has the same repeated-hour issue as the Rust parser
    had. It also accepts crons the daemon rejects (`-5 * * * *`, `0x1f`,
    `1e1`), so a routine saved with one fires once, then falls back to daily
    09:00.
  - `RoutineEditor` `save()` swallows a rejected save into an unhandled
    rejection, and `FileEditor` replaces the editor with the error after a
    failed write, so there is no way to retry. Both need a decision on how
    to show the error.
  - When a turn refuses to start, the "Routine · name" note is already in
    the chat.
  - Both cron parsers reject 7 as Sunday in the day-of-week field.
  - The pty spawn path leaks the child if `dup_fd(master)` fails after a
    successful spawn. A test can't reach this.
  - `electron/main.ts` accepts a handshake URL with any scheme. Quitting
    while crewd is still starting waits for the handshake or the 10 s
    timeout before sending SIGTERM, and still creates the window.
  - `electron/` isn't type-checked. Under the repo's strict options it has
    three type errors (the handle's stderr type under `stdio: "inherit"`,
    readonly dialog `properties`, a `ReadableStream` cast). None of them
    matters at runtime.
- **Open, serious:** in `store.rs` `migrate()`, steps 3, 4, 5, 6, 9 and 14
  add a column and record the version as two statements with no transaction.
  A crash, or a failed version write, between them makes every later open fail
  with "duplicate column name", and the database never opens again. Only
  step 13 is atomic. The fix is to wrap each step in a transaction, or to
  guard each ADD COLUMN with `has_column`. `migrate()` is being edited on the
  `browser` branch, so the fix lands there or right after it merges (R5).
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
| T6 | done |
| T7 | done |
| R1 | done |
| R2 | done |
| R3 | done |
| R4 | done |
| R5 | done |
| R6 | done |
| R7 | done |
