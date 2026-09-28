# Session chat — a chat view over the live CLI

**Status:** planned 2026-09-28, being built (see §9). The plan stands on its own: a
fresh session can carry it out without the thread it was decided in. Each phase
ends with the app working and tests green, and gets a line in §9.

## 0. What is wanted

Crew has two kinds of conversation, and this feature touches only one of them.

- An **agent** (`kind: "agent"`) has a permanent history kept by Crew, its own
  persona and model, and can switch providers. Each turn opens a fresh provider
  session (`turns.rs`, `docs/plans/2026-09-17-agent-model.md`). It already
  renders in the chat. **Nothing here changes agents.**
- A **session** (`kind: "terminal"`) is a plain provider session: Claude Code,
  Codex, opencode or Cursor, running its own CLI in a terminal tab. It is clean:
  no persona, no Crew tools, no mailbox.

The feature is a setting in **Settings › Appearance**: *Sessions open in:
Terminal | Chat*. It is global and live, so it can be flipped at any time, and
every session shows its **full history** in either view. Agents and sessions
share the same chat UI (`DefaultChatSurface`), so there is one surface to
maintain.

### What went wrong first

Commit `f984ec8` ("add a setting to run new agents in the chat or in the
provider's terminal") got it backwards. It made **New Agent** create a
`kind: "terminal"` session when the setting said Terminal, and it did nothing
for sessions. It shipped in **v0.1.16**. Phase 1 reverts it.

## 1. The design: the chat is a view over the running CLI

The CLI in the terminal stays the **only** process talking to the provider,
and the chat is drawn over it:

- **Reading.** crewd reads the provider's own session history (Claude's session
  file, Codex's session log, opencode's database) and turns it into the same
  blocks the agent chat renders. The provider's history is the only history:
  Crew keeps no copy of its own for sessions, so there is nothing to sync.
- **Sending.** What the user types in the chat composer goes into the terminal
  as keystrokes.
- **Live state.** Working/idle, permission requests and questions come from the
  provider's hooks, with the title and activity detection Crew already has
  (`src/lib/terminalStatus.ts`) as fallback.
- **Answering.** Approval and question cards answer by typing the keys the CLI
  expects.

Why this shape: there is only ever one writer, so the toggle is instant and
needs no handoff. The terminal stays mounted under the chat and is never
restarted.

What it costs, accepted:

- **No word-by-word streaming.** Claude writes one complete message at a time to
  its session file, so replies appear message by message.
- **Delivery is inferred, not confirmed.** A sent message shows as a "queued"
  bubble until the matching user turn appears in the history.
- **Keystroke timing.** Answers rely on delays tuned per CLI.
- **Approvals are Allow / Deny**, plus whatever other options the CLI's own
  prompt proves to have (to verify in phase 3).

### Per provider

| Provider | View | History source | Live state | Notes |
| --- | --- | --- | --- | --- |
| Claude | Terminal or chat | `~/.claude/projects/<slug>/<id>.jsonl` | Hooks passed on each launch through `--settings`, as Crew already does | Phase 3 |
| Codex | Terminal or chat | `~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl` | Hooks if they can be passed on each launch (to verify), else title and activity | Phase 4 |
| opencode | Terminal or chat | `message` / `part` tables in `opencode.db` | Title and activity; no hooks | Phase 5 |
| Cursor | **Terminal only, permanently** | — | — | See below |

**Why Cursor stays in the terminal** (decided 2026-09-28):

- Cursor's hooks are read from `hooks.json` files, a global one and one per
  project. Crew would have to merge its hooks into files the user may already
  have built on, keep them from being overwritten, and clean up after a crash.
- Cursor's headless mode, `cursor-agent acp`, keeps a separate chat store. This was checked on cursor-agent 2026.09.26:
  - ACP chats live in `~/.cursor/acp-sessions/<id>/`, CLI chats in
    `~/.cursor/chats/<md5 of cwd>/<id>/`.
  - ACP `session/load` of a CLI chat answers "not found".
  - `cursor-agent --resume` of an ACP chat silently starts a new conversation
    under the same id.

  So the two views could never show the same conversation.
- The CLI's `store.db` *can* be decoded (meta key `0` → `latestRootBlobId` →
  protobuf field 1 lists the message blob hashes in order → each blob is JSON
  `{role, content}`). It is undocumented, though, and a chat without live state
  or approvals is not worth it. Revisit only if Cursor ships hooks passed on
  each launch or a history export.

The Settings description says so: *Cursor sessions always open in the
terminal.*

## 2. What to get right

These are the details that make or break the chat-over-CLI approach.

- **Sending:**
  1. Ctrl+U (`\x15`) clears the CLI's input line.
  2. The body is written, as a bracketed paste (`\x1b[200~…\x1b[201~`) when it
     has more than one line.
  3. `\r` follows as a **separate write ~500 ms later**. A `\r` inside the same
     write as the paste is taken as part of the paste.

  Each terminal has one send queue, and a send cancelled after the body landed
  clears the line again.
- **Images** are file paths pasted one by one, with a 300 ms settle before the
  text.
- **Codex slash commands** are typed one key at a time, 16 ms apart, or its
  command menu never opens.
- **Stop** writes ESC.
- **Reading the history:**
  - Watch the **parent folder**, so the watch survives the file being replaced.
  - Debounce 40 ms with a 250 ms ceiling, plus a 1 s check of the file's size
    and time as backstop.
  - Read by byte offset, reset if the file shrinks, and carry a half-written
    last line over to the next read.
  - Skip records over 2 MiB. Open on the last 300 messages and load earlier
    ones on scroll.
  - A new session file can take from ~3 s to minutes to appear, so keep looking
    for it with backoff and show a pending state.
- **Claude records to skip:** `isMeta`, `isSynthetic` and `isCompactSummary`,
  except tool results, and `isSidechain`.
- **Hooks:** hooks decide working/stopped, and the history's turn markers only
  clear a stuck spinner. SessionStart with source `clear` or `resume` re-points
  the chat to the new session id.
- **Approval and question cards** come from the hook payload, with a fallback
  to the newest question tool call that has no result. Claude and Codex ignore
  pasted labels, so answers are keystrokes, stepped 1 s apart:
  - Claude: the option's digit, the "Type something" row, `\x1b[C` to the next
    question.
  - Codex: arrow keys, Tab, `\x7f`.

  Approvals are `1` for Allow and ESC for Deny.
- **A history that decodes to nothing is an error**, not an empty chat. Never
  fall back to another account's home.
- **Trust prompts:** before launch, the trust record the CLI would write when
  the user clicks Trust can be written ahead of time. For Codex that is
  `[projects."<path>"] trust_level = "trusted"` in `config.toml`, with a
  worktree trusted by its main repo's path after checking the backlink. Claude
  keeps trust in `~/.claude.json`, which it rewrites constantly, so Claude is
  **not** pre-trusted; its prompt becomes a card instead.
- **Other blocking screens** are recognized by their text: update notices,
  "hooks need review", login, "do you trust".
- **Claude hooks** are passed on each launch through `--settings`
  (`src/lib/sessionCommand.ts`), never written into `~/.claude/settings.json`.
- **Reading and decoding run in crewd**, so remote machines get the feature
  too: their crewd reads their own files.

## 3. Phases

### Phase 1 — revert `f984ec8`

- Delete `src/lib/agentMode.ts`, `src/lib/agentMode.test.ts` and
  `src/hooks/useAgentMode.ts`.
- `src/hooks/useAgentSheet.ts`: `create("agent", …)` again, and drop `mode`.
- `src/surfaces/SettingsView.tsx`: remove the "Agents › New agents run in" row
  from `General`.
- `src/surfaces/Terminals.tsx` `launchCommand`: drop the
  `session.autonomy === 'full'` bypass. Terminal sessions are always created
  with `autonomy: "ask"`, so it only served the fake agents.
- The saved `agents:mode` value is simply ignored from now on.
- Test: creating an agent always yields `kind: "agent"`. This is the regression
  test for the bug.

This can ship on its own.

### Phase 2 — the setting and the overlay

- **The setting.** `src/lib/sessionView.ts` holds `SessionView = "terminal" | "chat"`,
  default `terminal`, stored under `sessions:view`. A `useSessionView` hook
  follows the pattern of `useColorMode` / `useAgentAvatar`.
- **Settings row.** A **Sessions** section in `Appearance()`
  (`SettingsView.tsx:138`), with the copy: "Chat shows a session's conversation
  in Crew's chat while its CLI keeps running underneath. Cursor sessions always
  open in the terminal."
- **Which view a session uses.** One helper, `sessionSurface(session, view)`:
  - agents → the agent chat;
  - sessions of a provider with a history reader → chat when the setting says
    chat;
  - everything else → terminal.

  Use it where a check means *which view* rather than *which kind*:
  `isTerminalTab` (`lib/tabs.ts:307`, used by the `App.tsx:177` zoom and
  `Terminals.tsx:50`), and whatever decides where focus goes. Checks that mean
  *is this an agent* stay on `kind`: `isAgentTab`, the Edit option in the tab
  menu, faces, sidebar groups, tools, the mailbox.
- **The overlay.** The xterm always mounts, exactly as today. A `SessionChat`
  component renders inside the same `Pane` in `Terminals.tsx`, positioned over
  it (`absolute inset-0` above the xterm), when the view is chat.
  - Flipping the setting mounts or unmounts it. The process, the xterm and its
    scrollback are untouched.
  - Focus goes to the composer when the chat is shown, and to the xterm when it
    isn't.
  - The chat draft is kept per session and is never copied into the CLI.
- **"Show terminal".** A button in the chat header reveals this one tab's
  terminal, with a way back to the chat. The state is per tab and in memory
  only; it never changes the setting.
- **Blocked screens.** Read the xterm's visible screen for known blocking
  screens: Claude's folder trust, login, update notices, Codex's "hooks need
  review". When one is showing, the chat says
  what it is and offers "Show terminal". Claude's trust prompt gets its own
  card in phase 3.
- The chat shows no history yet; phase 3 adds it.

### Phase 3 — Claude

- **Reading the history** in crewd, in a new module
  `crates/crew-core/src/session_history/`:
  - `mod.rs` holds the reader: parent-folder watch, byte offsets, half-written
    last line, record size cap, reading back from the end.
  - `claude.rs` is the decoder.
- **One decoder for both.** The records in Claude's session file have the same
  message shapes as its stream-json output, so turn them into `HarnessEvent`s
  with the mapping in `turns.rs` (`claude_assistant` and friends) and build
  blocks with `blocks::apply_event`. The chat then renders session history
  exactly as it renders agent turns.
  - Skip `isMeta`, `isSynthetic`, `isCompactSummary` (except tool results) and
    `isSidechain`.
  - Take timestamps from the records.
- **Which file.** The file is found from the bound provider session id: Crew's
  own id until a `/clear`, after which `rebind_claude_session` (`crates/crewd/src/lib.rs:833`) supplies the new
  one (`provider_session.rs:65-180`). The chat follows the id the CLI moved to.
- **Daemon API.** `session_history_window(id, before?)` returns blocks, and a
  `session-history-appended` event pushes new ones while a chat is open. The
  reader runs only while a chat for that session is on screen.
- **Hooks.** Extend `bindHooks` in `sessionCommand.ts` with UserPromptSubmit,
  Stop, PreToolUse and PostToolUse, and replace the Notification hook with the
  permission-request one if the installed Claude has it (verify against
  2.1.283).
  - Transport: keep the drop folder (`CREW_CLAUDE_BIND_DIR`), but have crewd
    **watch** it and push events, instead of the app polling it
    (`DISCOVER_MS`, `ATTENTION_MS` in `Terminals.tsx`).
  - This gives terminal sessions no bridge token and no Crew tools. They stay
    clean.
- **Sending.** Build `src/lib/ptySend.ts` with the choreography in §2: Ctrl+U, the
  body (bracketed paste when multi-line), and `\r` in a separate write after
  500 ms, with one queue per terminal. It writes through `api.writePty`, and the
  timing takes an injected clock so it can be tested.
  - Images and attachments are pasted as paths.
  - Stop writes ESC.
  - Sent messages show as queued bubbles until a matching user turn appears in
    the history.
- **Cards.**
  - Approvals from the permission-request payload (tool and input): Allow
    writes `1`, Deny writes ESC. Check whether "Yes, and don't ask again" is
    `2` and offer it if so.
  - Questions (`AskUserQuestion`, from PreToolUse) use the Claude key
    sequence in §2.
  - The trust prompt shows "Claude asks whether you trust this folder" with
    Trust and Exit. Verify the keys on 2.1.283.
- **Status.** Hooks decide working and stopped. Title and activity detection
  stays as fallback. Extend `agentRuntime.ts:209` (resync filters on
  `kind === "agent"`) or give sessions their own status path; do not reuse the
  agent turn runtime.
- **A new session in chat view.** The CLI starts underneath and the chat shows
  the empty state. The composer is disabled until the CLI is ready: for Claude,
  the SessionStart hook has fired and no blocking screen is showing.

### Phase 4 — Codex

- **Decoder** for Codex's session logs (`session_history/codex.rs`). The records
  are `response_item` entries (message, function_call, function_call_output,
  reasoning) and `event_msg` entries.
  - Drop the user message Codex records twice, once as a `response_item` and
    once as an `event_msg`.
  - These records are **not** the shape of `codex exec --json`, so this decoder
    has its own mapping to `HarnessEvent`s.
- **Which file.** The session is found from the bound id Crew already
  discovers (`provider_session::discover`, `codex_sessions`).
- **Hooks.** Check whether Codex 0.154 accepts hooks through `-c` on the command
  line. If it only reads them from `~/.codex/config.toml`, **don't** write
  there: it's the same problem that ruled out Cursor. Use the task-started and
  task-complete records in the session log plus title and activity for status,
  and "Show terminal" for approvals.
- **Trust.** First check whether
  `-c 'projects."<root>".trust_level="trusted"'` on the command line skips the
  prompt. If it does, add it in `sessionCommand` and touch no file. If not,
  write the trust entry to `config.toml`:
  - write atomically;
  - refuse to write if the file doesn't parse;
  - use the main repo's path for a worktree, after checking the backlink;
  - never let a failure block the launch.
- **Slash commands** are typed one key at a time, 16 ms apart.
- Answer keys for Codex questions, if hooks make the cards possible, follow
  the Codex sequence in §2.

### Phase 5 — opencode

- **Decoder** over `opencode.db` (`session_history/opencode.rs`): `message` and
  `part` rows for the bound session. The parts have the same shape as
  `opencode run --format json` events, so reuse the mapping in `turns.rs`.
  - Open the database read-only with a busy timeout, as `opencode_title`
    already does (`provider_session.rs:303`).
  - Poll `time_updated` while a chat is open.
- **Live state.** No hooks exist, so status comes from title and activity.
  opencode's permission prompts need "Show terminal".

## 4. Out of scope

- **Agents.** Nothing about how they run or render changes.
- **Cursor in chat** (§1).
- **A structured mode:** an SDK or app-server process owned by Crew, with
  word-by-word streaming and confirmed delivery. Worth considering only if the
  chat-over-CLI trade-offs in §1 turn out to hurt.
- **Crew tools inside sessions.** Sessions stay clean.
- **Copying the chat draft into the CLI's input line.**

## 5. Risks

| Risk | Mitigation |
| --- | --- |
| A CLI update changes its history format | Test files recorded from the installed versions (Claude 2.1.283, Codex 0.154.0, opencode 1.18.31). A history that should have messages but decodes to none shows an error with "Show terminal", never an empty chat |
| Keystroke timing differs by machine or remote latency | Delays are constants per provider, in one place. The queue waits for each send's Enter before the next |
| The user types in the terminal, then sends from the chat | Ctrl+U clears the CLI's line first. Accepted |
| The history file appears late | Keep looking with backoff; show a pending state after 1.5 s |
| Large histories | Open on the last 300 messages; load earlier ones on scroll; cap record size at 2 MiB; read only while a chat is on screen |
| Writing to the user's config | Only the Codex trust entry, and only if `-c` can't do it |

## 6. How to verify each phase

- **Unit tests (Rust):**
  - Decoders against recorded files, including `/clear`, compaction, subagent
    side-threads, a half-written last line and oversized records.
  - The reader: a file replaced, a file shrinking, a file appearing late.
- **Unit tests (TS):** `sessionSurface`, the send choreography with a fake
  clock (order of writes, Enter as a separate write, cancel mid-send), and the
  answer keys.
- **E2e** (the suites are wanted): a fake CLI script that appends to a
  Claude-shaped session file and runs the hooks. Check that:
  - flipping the setting keeps the same process id and shows the same history
    in both views;
  - a message sent from the chat lands in the terminal;
  - an approval card answers the CLI;
  - New Agent under either setting makes an agent.
- **By hand, against the real CLIs, on this machine and a remote one:** each
  provider through the whole flow, plus Claude's `/clear` and a trust prompt in
  a fresh folder.

## 7. Conventions

- Rust decoders live in crew-core; the app only renders blocks. Remote machines
  get the feature for free because their crewd reads their own files.
- Setting keys use the `sessions:` prefix, like `sessions:bypass-permissions`
  (`src/lib/permissions.ts`).
- Visual decisions stay with the main session (cards, queued bubbles, the
  blocked-screen notice, "Show terminal"). Subagents implement against explicit
  file lists.

## 8. Open questions to settle while building

- Claude 2.1.283: the name of the permission-request hook event and its payload,
  whether option `2` is "don't ask again", and the trust prompt's keys.
- Codex 0.154: hooks through `-c`? Trust through `-c`?
- opencode: does it ever show a trust or first-run screen in a new folder?
- Codex slash commands and image paste in the current TUI.

## 9. Status

| Phase | Status |
| --- | --- |
| Design | Done 2026-09-28 |
| 1 · Revert `f984ec8` | Done 2026-09-28: reverted; `e2e/new-agent.test.ts` makes an agent with `agents:mode=terminal` saved |
| 2 · Setting and overlay | Done 2026-09-28 (one commit with phase 3) |
| 3 · Claude | Done 2026-09-28: run by hand against Claude Code 2.1.284, both renderers; see §10 |
| 4 · Codex | Pending |
| 5 · opencode | Pending |

## 10. What building it settled

Measured against the installed CLIs while building phases 2 and 3.

**Claude Code 2.1.283 → 2.1.284** (it updated itself mid-way; both were run):

- The permission hook is `PermissionRequest`, with `tool_name`, `tool_input`
  and `permission_suggestions`. Questions arrive through it too, as
  `tool_name: "AskUserQuestion"`, bypass mode or not. PreToolUse is not needed.
- Approval keys: `1` Yes, `2` "Yes, and don't ask again" (offered when the
  payload has suggestions), Esc No. Esc runs no Stop hook and no PostToolUse:
  the turn ends in the history (`[Request interrupted by user for tool use]`
  and a `turn_duration` record), which crewd reads as the end of the turn.
- Esc before the model answered ends the turn with no hook and nothing in the
  history, and Claude puts the message back on its input line. The chat's Stop
  therefore ends the turn in crewd itself (`session_live_stopped`), drops the
  queued bubbles, and the chat only shows a turn running while Claude's title
  spins too, which covers Esc typed in the terminal.
- Question keys: a digit picks and moves on (and submits a lone single-select
  question); a multi-select toggles digits and `→` moves on; "Type something"
  is the row after the options, then the text and Enter; several questions or
  any multi-select end on a review screen answered with `1`.
- Trust prompt: "No, exit" is preselected and digits do nothing; Trust is `↓`
  then Enter, Exit is Esc. SessionStart runs before the prompt, so the composer
  also waits for no blocking screen.
- 2.1.284 shows "Try the new fullscreen renderer?" right after the trust
  prompt. It is recognised by its text, and any other modal prompt of Claude's
  by "Enter to confirm · Esc to cancel". The chat works under both renderers.
- **Deviation from §2:** the text is always sent as a bracketed paste, not only
  when it has several lines. Typed that fast, a file name in it (`hello.txt`)
  was taken for one to complete and the Enter picked the completion: every
  other such message was lost. Pasted, 6 of 6 arrived. A pasted `/clear` still
  runs.
- An image path pasted before the text becomes `[Image #1]`.
- `/compact` keeps the session id (SessionStart `source: "compact"`); `/clear`
  runs SessionEnd then SessionStart `source: "clear"` with the new id and
  transcript path. Subagents write to a folder of their own, never to the
  main file.

**Codex 0.154.0:** `-c 'projects."<path>".trust_level="trusted"'` skips the
trust prompt without touching `config.toml`. Its update offer ("Update
available! … Update now … Skip") is a blocking screen. Hooks: to settle in
phase 4.

**opencode 1.18.31** shows no trust or first-run screen in a new folder.

**Status and hooks in the app.** Hooks reach the window as `session-live`
events: crewd watches the bind folder (`notify`, 40 ms quiet / 250 ms ceiling,
1 s backstop) instead of the window polling it, follows a `/clear` itself, and
marks a session's CLI gone when its terminal's process exits. The Notification
hook and `session_claude_attention` are gone.

**e2e.** `e2e/session-chat.test.ts` drives the fake claude, which now writes
Claude-shaped records (tool_use, tool_result, `turn_duration`, the interrupt
marker) and runs the hooks above. Four specs fail the same way on the commit
before this work (A1, K1, M2, cookies), and T1 fails there too when run alone
(its clicks outlast the 8 s turn). The `remote-*` specs cannot run on this
machine: pairing a machine needs the keychain, and its Xvfb session has none.
