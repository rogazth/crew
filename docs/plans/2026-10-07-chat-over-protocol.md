# Chat over the provider's protocol

Decided 2026-10-07. The chat view of a session stops typing into a PTY and
drives the provider the way Crew already drives bots and subagents: through
its own protocol. This replaces the chat-over-CLI design of
`2026-09-28-session-chat.md` §1 and is what the orchestration plan
(`2026-10-07-subagents-and-sessions.md`) builds on. Update the status table at
the bottom as each decision lands.

## Why

- The chat over the PTY infers delivery, depends on keystroke timings measured
  per CLI, has no word-by-word streaming, and must guess when typing is safe
  (drafts, open forms). Orchestration needs to put a message into a session
  and know it arrived; a PTY cannot promise that.
- Crew already speaks each protocol, for bots and subagents: Claude
  stream-json (`providers/claude.rs`), `codex app-server`
  (`providers/codex.rs`), `cursor-agent acp` (`turns/cursor.rs`). `turns.rs`
  already steers a running turn and puts back a steer the turn never read.
- The references that drive several providers (t3code, zeron, monocode) all
  do it this way, with one live process per conversation. Orca keeps a PTY by
  default and hands a conversation between its structured chat and the real
  CLI.

## Decisions

### One writer, one view

1. **Every provider session is a chat, driven by Crew through the provider's
   protocol.** There is no terminal view: Crew never runs a provider CLI in a
   PTY for a session. (Decided 2026-10-07 as two views; the terminal view was
   removed on 2026-10-12, when the app had become practically all chat UI.)
2. **There is no view to choose.** The "New sessions open in" setting and
   `sessions.view` are gone, and with them the window's terminal for a session.
   A shell tab, a Crew process and a login the chat opens (`claude mcp login`)
   are PTYs that run a shell or a command, not a session. Migration 38 moves
   every session that was in the terminal view into the chat: Claude, Codex
   and opencode resume the conversation they had over the protocol (their
   provider id is kept), and a Cursor one starts a new conversation with a note,
   since a chat made by `cursor-agent create-chat` cannot be loaded over ACP.
   (Migration 30, the earlier move of a setting's worth of sessions, stands
   as it was.)
3. **Per provider.** Claude, Codex, opencode and Cursor are each driven over
   their own protocol from the first message: stream-json, `codex app-server`,
   `opencode serve` and ACP.

### Process lifetime

4. **One live process per session, across turns.** Claude keeps stdin open on
   stream-json, Codex runs turns on one app-server thread, opencode talks to
   `opencode serve`, Cursor sends `session/prompt` on one ACP session. A
   second message no longer restarts the CLI, its MCP servers and plugins.
5. **Released after 30 minutes idle**, unless the session has live subagents
   or background work (t3code pins up to 4 h, zeron stretches 8×). The next
   message resumes it by its provider id.
6. **Model, effort and autonomy change in place** where the protocol allows
   it (Claude `set_model` and permission mode; Codex per-turn parameters);
   otherwise the process restarts on the same resume id.
7. **Subagents move to the same lifetime.** Bots keep one process per turn:
   each bot turn starts a clean provider session with the tail Crew hands it.

### Setting sources

8. **Claude's setting sources follow the kind of session.** A bot gets
   `project,local` and no auto memory, as today, so a machine's
   `~/.claude/CLAUDE.md`, skills and plugins never leak into its persona.
   Sessions and subagents get every source (`user,project,local`): the user's
   skills, plugins, commands and `CLAUDE.md`, as in their own CLI. Today
   `build_claude_spawn_args` passes `project,local` to everyone.

### opencode

9. **opencode moves from `opencode run` to `opencode serve`.** One server per
   daemon on 127.0.0.1, on a free port, with a password Crew makes per run
   (set in `OPENCODE_PASSWORD` and `OPENCODE_SERVER_PASSWORD`). Zeron dropped
   `opencode acp` because a prompt settles on the first `idle`, uncorrelated
   with the turn sent.
   - **Crew supports opencode 2.x only** (`@opencode/cli`), minimum 2.0.4,
     tested against 2.0.24. It is where steering, the inbox and real
     end-of-turn events are. A 1.x install (`opencode-ai`) is told to move
     to 2.x; `opencode upgrade` does not cross packages.
   - **Version.** `opencode --version` prints `opencode v2.x.y` on 2.x; the
     running server confirms it with JSON from `/api/info`. Both versions
     serve their web UI as HTML on the other's path, so only JSON counts.
   - **The API:** `POST /api/session` (`location.directory`, `model`,
     `agent`); `POST /api/session/:id/prompt` with `delivery: "steer" |
     "queue"` (always async); `/api/session/:id/inbox` to list or cancel
     waiting input; `POST /api/session/:id/interrupt`; `POST
     /api/session/:id/command` (`name`, `text`); `POST
     /api/session/:id/compact`; permissions answered with `decision`
     (`once | always | reject`); forms instead of questions
     (`/api/session/:id/form`); one event stream at `/api/event`, with
     `session.execution.started|succeeded|failed|interrupted` ending a turn.
     Auth is always on: Basic `opencode:<password>`.
   - **The API still moves between patch releases** (2.0.4 renamed
     `reply` → `decision` and `command` → `name`). Crew pins the range it
     was tested on and says so when the installed version is newer.
   - **2.x migrates `opencode.db` once, on its first start.** 1.x sessions
     come along; anything 1.x writes afterwards does not.

### Commands and skills

10. **The `/` menu lists what the provider reports** for the session's folder,
    cached per workspace and provider and refreshed on a reload:
    - Claude: the `initialize` control request's `commands` (no model turn),
      kept current by `system/commands_changed`. It already leaves out the
      commands that need the TUI (`/plugin`, `/permissions`, `/hooks`,
      `/memory`, `/login`, `/resume`).
    - Codex: `skills/list`, plus the commands Crew maps to methods (13).
    - opencode: `GET /command` and `GET /skill`.
    - Cursor: ACP `available_commands_update`.
11. **The menu opens wherever a `/` starts a word**, not only at the start of
    the message. The chosen entry becomes a chip. What it offers depends on
    where: at the start of the message, everything; anywhere else, only
    skills and Crew's own actions. A provider command (`/compact`, `/review`,
    `/goal`) is expanded only when it opens the message; anywhere else it
    reaches the agent as literal text, so it is not offered there (t3code
    `composerSlashCommandSearch.ts`; zeron, monocode and orca treat a
    mid-message command as text too). Crew's own actions (`/model` opens the
    picker) run when picked, wherever they are, and their token goes.
12. **Claude: one invocation per message, moved to the end.** Stream-json
    expands only a `/name` that opens the message's last text block, and only
    one per message (t3code `ClaudeSkillDispatch.ts`, verified against the
    CLI; anthropics/claude-code#87113). Crew sends the text before the chip
    as its own block and `/name` plus the rest as the last block. Other chips
    stay inline as `/name`; the model starts them with its Skill tool.
13. **Codex: skills inline, commands as methods.** A skill chip is `$name` in
    the text plus a `{type: "skill", name, path}` input item, anywhere in the
    message. Commands map to methods: `/compact` → `thread/compact/start`,
    `/goal` → `thread/goal/set|get|clear`, `/review` → `review/start`,
    `/mcp` → `mcpServerStatus/list`, reload → `skills/list` with
    `forceReload` and `config/mcpServer/reload`.
14. **opencode and Cursor.** opencode runs a command chip through
    `session.command` and compacts with `summarize`. Cursor takes its
    commands and skills as prompt text; it has no `/compact`, `/clear` or
    reload headless.
15. **Reload.** Claude's `/reload-plugins` and `/reload-skills` work as typed
    (verified on 2.1.293), as does the `reload_plugins` control request.
    Every provider also gets **Restart session**: stop the process and resume
    it, which rereads skills, plugins and MCP config.

### Fast mode

16. **Crew checks fast mode in the background and hides the toggle when the
    account cannot use it.** Headless Claude needs the opt-in
    `--settings '{"fastMode":true}'`; without it every account reads
    `sdk_opt_in_required`. With it, the `initialize` control request (no
    model turn, no cost) answers `fast_mode_disabled_reason` (verified
    2.1.293: `extra_usage_disabled` on an account without extra usage).
    - The check runs when Crew opens and once a day, and every `system/init`
      and `result` of a real session refreshes it: both carry
      `fast_mode_state` and `fast_mode_disabled_reason`.
    - `free`, `preference`, `extra_usage_disabled`, `not_first_party`,
      `disabled_by_env` and `model_not_allowed` hide the toggle.
      `network_error`, `pending` and `unknown` keep the last value.
    - `fast_mode_state: "cooldown"` (after a rate limit) is shown, not hidden.

### Cursor plugins

17. **Crew loads Cursor plugin skills itself.** `cursor-agent acp` loads no
    plugins: its skills come from the filesystem only, its MCP from
    `.cursor/mcp.json`, and it ignores `--plugin-dir` (2026.10.01, read in the
    bundle and run). Interactive `cursor-agent` loads them from
    `~/.cursor/plugins/cache/`. Crew reads
    `.cloud-plugin-manifest.json` there, takes each enabled plugin's newest
    `cursor-public/<name>/<sha>/…/skills/*/SKILL.md`, lists them next to
    `available_commands_update`, and puts the SKILL.md body into the prompt
    when one is picked. The user's Cursor config is never changed. Re-run the
    probe after each `cursor-agent` update: once ACP loads plugins, this
    goes.

### MCP

18. **The user's MCP servers stay in each provider's own config.** Crew does
    not read and re-inject them (no reference does). A session gets them by
    loading every setting source (decision 8); a bot does not.
19. **Crew's own server stays stdio**, with its tool timeout raised past the
    longest blocking tool (`delegate` with `wait`). t3code raised Claude's to
    65 minutes for the same reason.
20. **MCP status per session.** The chat shows which servers are connected,
    failed or need a login, from the provider: Claude `mcp_status` (and
    `mcp_reconnect`, `mcp_toggle`), Codex `mcpServerStatus/list` and its
    startup notifications, opencode `GET /api/mcp` and its `mcp.status.changed`
    events. A server that needs OAuth says so instead of its tools silently
    missing. Signing in goes through the provider's own login (Codex
    `mcpServer/oauth/login`, opencode's `integration/{id}/connect/oauth`, the
    CLI's `mcp login` in a terminal), so tokens stay where the provider keeps
    them.
21. **Cursor ACP takes injected HTTP and SSE servers** (2026.10.01, verified:
    `session/new` `mcpServers` with `type: "http" | "sse"` and `headers`
    connected without a prompt; the model listed and called their tools).
    The comment in `providers/cursor.rs` saying ACP agents drop them is
    wrong for Cursor and goes. Cursor plugin MCP servers would need Crew to
    hold their OAuth tokens, since cursor-agent keys stored tokens by a hash
    of project and server and keeps none for Sentry.

### Cursor and process hygiene

22. **Cursor stays on ACP.** Benchmarked against `@cursor/sdk` 1.0.32 on
    2026-10-07 (scratch POC, 5 fresh processes each, medians): ACP reaches
    the first token from spawn in 5.9 s against the SDK's 10.3 s, and a warm
    turn costs the same on both (~2 s). The SDK needs its own API key, is
    gated by plan, has no approval or question API, ships weekly, and after
    its process is killed mid-turn every send fails with "already has active
    run" until forced. What the SDK does better (real steer, reopening in
    ms, one process) does not outweigh that.
23. **`cursor-agent acp` runs with `--disable-codebase-ref`.** Without it,
    `session/new` starts an `index.js worker-server` per git root (so per
    worktree) with a TypeScript language server under it, ~350–400 MB, that
    outlives acp by 5 idle minutes and keeps acp from exiting when its stdin
    closes. With the flag there is no worker, acp exits on EOF, and the
    tree drops from 692 MB in 4 processes to 297 MB in 1. The cost is two
    tools, by the flag's own description: `SemanticSearch` (search by meaning
    over Cursor's index) and `ReadLints` (diagnostics from a language
    server). The agent keeps grep, glob, reading files and the shell, as
    Claude and Codex have.
24. **Every provider process Crew starts dies with its group.** Crew already
    starts each one in its own process group (`agent.rs`, `process_group(0)`)
    but `terminate()` skips the group once the leader has exited, which is
    how a helper the leader left behind survives. The group is killed when
    the leader is reaped, not only on stop: SIGTERM, then SIGKILL after 2 s.
25. **A sweep at startup.** Crew keeps the process groups it started in a
    list on disk and kills what is left of them when `crewd` starts, so a
    crash or a SIGKILL of the daemon leaves nothing behind. Verified with
    acp (idle and mid-turn, parent SIGKILLed): zero processes left. An
    environment marker alone does not find them: `npm exec` rewrites its
    command line and hides its environment from `ps`.

### What stays

26. **Reading the provider's own history went with the terminal view.** In the
    chat, the driver's events are the live source, so replies stream word by
    word, and Crew's transcript is the history. `session_history`, the hooks
    Crew passed to a CLI in a PTY and `src/lib/ptySend.ts` are gone.
27. **A session that was a terminal view has no transcript in Crew** (its
    conversation lived in the provider's files), so its chat opens empty and
    its next message resumes the provider's conversation. That is the cost of
    removing the reader; it is not imported.

### Context meter

28. **The chat shows how full the agent's context window is, live.** A
    `context.updated { used, window, auto_compact_at? }` event, kept apart
    from `TurnUsage` (which is billing, per turn). The newest reading
    replaces the last; a reading without a window keeps the last window.
    `used` counts input, cache and output on every provider.
    - **Claude:** each top-level `assistant` message's `usage` (input +
      `cache_read` + `cache_creation` + output), once per `message.id`,
      skipping subagents (`parent_tool_use_id`). The window and the
      auto-compact point come from the `get_context_usage` control request
      (`maxTokens`, `autoCompactThreshold`; covers `[1m]`, verified with no
      turn), sent at spawn, after each `result` and after
      `compact_boundary`. `result.modelUsage[model].contextWindow` is the
      fallback.
    - **Codex:** `thread/tokenUsage/updated`: `last.totalTokens` over
      `modelContextWindow` (already Codex's usable 95%). Never `total`,
      which is cumulative. A resumed thread is seeded from the rollout's
      last `token_count`.
    - **opencode 2.x:** the last step's tokens (`session.step.ended`), not
      their sum, over `limit.context` from `/api/model`. After a compaction
      there is no reading until the next step: the meter shows the old one
      as stale.
    - **Cursor:** ACP sends no usage. Crew reads `token_details`
      (`used_tokens`, `max_tokens`) from the session's `store.db`, decoding
      the root blob, when the file changes. Inferred from a CLI chat's
      store; one Cursor turn confirms the ACP store writes it the same way.
      If Cursor starts sending ACP `usage_update`, that wins.
29. **Updated mid-turn.** Claude, Codex and opencode report once per model
    request, so the meter moves while the agent works, not only at the end.

### Sending while the agent works

30. **Enter never interrupts.** A message sent while a turn runs is taken by
    the agent when it fits, and the turn goes on. Stopping is its own act:
    the stop button or Esc.
31. **Steer where the provider reads it at its next step; queue elsewhere.**
    Claude (a stream-json user message, confirmed by its echo), Codex
    (`turn/steer`) and opencode 2.x (`delivery: "steer"`) take it into the
    running turn. Cursor cannot (a second prompt cancels the first), so its
    message waits and goes as the next turn.
32. **The queue is visible and editable.** Waiting messages show above the
    composer: edit, delete, reorder, or "send now", which interrupts and
    sends (t3code, zeron). A steer the turn ended before reading goes back
    to the queue, as `turns.rs` does today. One key flips a message between
    steer and queue (t3code: ⌘Enter). Crew does not reshape what the
    provider does with a steer; what waits goes as one turn when the
    running one ends (decided 2026-10-09, as Claude Code and decision 17 of
    the orchestration plan).

### Background work: subagents and commands

33. **One panel lists everything a session has running beside its turn**:
    the provider's own subagents (Claude's Task and background agents,
    Codex's agent threads, opencode's child sessions), Crew subagents
    (`delegate`), background shells and monitors, and Crew processes the
    session started. It builds on the existing tray
    (`src/surfaces/chat/Background.tsx`), which already lists commands,
    subagents and monitors and stops them.
34. **Every entry can be opened, read live and stopped**, as in Claude
    Code. A subagent opens on its own transcript: Claude's messages carrying
    its `parent_tool_use_id`, a Codex agent thread, an opencode child
    session, or the Crew session. Today the tray marks subagents as not
    readable ("its report lands in the transcript"); that goes.
34b. **Each subagent says how many tokens it has used**, and how full its
    context is where the provider says. Claude: `task_progress.usage`
    (`total_tokens`, live, runs a little high) and `totalTokens` at the end
    (exact), or the subagent's own transcript for an exact live figure; the
    window comes from `resolvedModel`. Codex: the child thread's
    `thread/tokenUsage/updated` (exact, with its window). opencode 2.x: the
    child session's `session.step.ended`. A Crew subagent is a session, so it
    has the context meter of decision 28. Cursor's ACP sends none: it shows
    no number. None of the references shows this.
34c. **The Codex driver routes every notification by `threadId`.** With
    multi-agent, child threads' notifications arrive on the parent's
    app-server connection, and `codex_notification` (`turns/codex.rs`)
    matches on the method only: a subagent's `item/agentMessage/delta` and
    `item/*` land in the parent's message, and a child's `turn/started` while
    the parent has no turn id makes the parent adopt the child's turn, so the
    parent's own `turn/completed` is then ignored. The fix: compare
    `params.threadId` with `live.thread_id` first; the parent's go on as
    today, a child's go to that subagent (its transcript, its tokens from
    `thread/tokenUsage/updated`, its state in the background panel), and its
    approvals and questions surface as the subagent's. A notification without
    `threadId` stays the parent's. A test drives the fake app-server with a
    child thread's deltas between the parent's and checks the parent's
    message is untouched.
35. **Stop per entry, through the provider.** Claude `stop_task` (monocode
    uses it per background task); Codex `turn/interrupt` on the agent's
    thread; opencode interrupt on the child session; Crew `stop_session`;
    background shells through their own kill. An entry the provider cannot
    stop on its own says so instead of showing a dead button.
    Measured on Claude 2.1.295: `stop_task` takes a subagent the turn waits
    on as well as a background one: it ends `stopped` at once, the Agent call
    answers "rejected", and the model's turn ends with it. So every Claude
    entry is stoppable; `stop_note` ("stops with the turn") stays for a kind
    that proves otherwise. `initialize` with `forwardSubagentText` is
    accepted and puts the subagent's words among its steps; `task_progress`
    and `task_notification` carry `usage.total_tokens`, and the Agent call's
    answer `totalTokens` and `resolvedModel`.
36. **Entries do not disappear.** A subagent or command stays listed, with
    its state (running, done, failed, stopped) and its output, until the
    session ends or the user clears it. Its state comes from the protocol's
    events (Claude `task_*` system messages, Codex item and thread events),
    not from the end of the call that started it: a background subagent
    outlives that call (`SubagentState`, `blocks.rs`).

Settled 2026-10-09 for decisions 33–36: Esc stops the turn only; what runs in
the background goes on and is stopped from the panel. A Claude chat with
background work ends its turn at the answer and keeps its process, and the
CLI's own follow-up turn is taken as a turn nobody sent. Entries outlive a
restart of Crew, marked stopped, until "Clear finished" or the session goes.
A Crew subagent opens over the chat, with its own composer.

## Effect on the orchestration plan

- Its decisions 15–20 (PTY delivery) go. A letter to a session is a steer or
  a queued turn through `turns.rs`, as for a subagent today.
- A letter steers into a running turn only where steering does not interrupt
  a tool; otherwise it is the next turn (t3code's rule).
- Its decision 14 (resume on message) is a turn on the resume id.
- Its decision 6: an independent session is a chat session, and stays one.

## Out of scope

- Cursor through `@cursor/sdk` instead of ACP (t3code and zeron use it).
- Attaching the Codex TUI to the live app-server (`codex resume --remote`)
  instead of stopping it to switch.
- Carrying a conversation across providers.

## Open questions

- How Codex's app-server, opencode and Cursor isolate a bot from the machine's
  global instructions (`~/.codex/AGENTS.md`, opencode's global config), the
  way `project,local` does for Claude. A short probe per provider; without a
  flag, the bot runs on a home of Crew's own (`CODEX_HOME`, opencode's config
  dir) that links only the credentials. A provider that allows neither is a
  known leak, written down.
- Which native subagents each provider can stop on their own: Claude's
  foreground Task subagent (only background tasks are known to take
  `stop_task`), Codex agent threads, opencode child sessions, Cursor tasks
  over ACP. Measured with the background panel (33–36); one that cannot be
  stopped says "stops with the turn".
- Whether the model sees plugin skills Crew injects (decision 17): to verify
  on a free Cursor account (auto model).

Settled 2026-10-08: a built-in command away from the start of the message is
text (decision 11). Cursor plugin MCP servers that need OAuth stay out: Crew
does not hold provider tokens (decision 20); MCP status says so and points to
a shell tab.

## Order of work

1. Decisions 8 and 23–25: setting sources by kind, and no orphan processes.
   Small and on their own.
2. Decisions 4–7: the live process for Claude and Codex; subagents use it.
   Decision 16 with it, before the fast toggle drives a chat.
3. Decisions 1–3 and 26–27: every session a chat on the driver (the terminal
   view removed 2026-10-12).
4. Decisions 10–15: the `/` menu, autocomplete anywhere, dispatch per
   provider.
5. Decision 9 (opencode 2.x), Cursor as chat-only, and decision 17.
6. Decisions 18–21: MCP status and sign-in.
   Decisions 28–29, the context meter, alongside steps 2 and 5.
   Decisions 30–32, sending while the agent works, with step 3.
   Decisions 33–36, background work, after step 3.
7. The orchestration plan, on top.

## Status

| # | Decision | Status |
|---|---|---|
| 1–3 | One writer, one view: the terminal view is removed | done (migration 38) |
| 4–7 | Live process per session | done for Claude, Codex and opencode subagents and chat sessions (opencode on one shared server), and Cursor on one ACP process |
| 8 | Setting sources by kind | done |
| 9 | opencode on `serve` | done (2.x only; checked live on 2.0.26) |
| 10–11 | `/` menu from the provider, anywhere in the message | done for Claude, Codex, Cursor and opencode (`GET /command`, `GET /skill`) |
| 12–14 | Dispatch per provider | done for Claude, Codex, Cursor and opencode (`session.command`, `compact`) |
| 15 | Reload and Restart session | done |
| 16 | Fast mode check and toggle | done |
| 17 | Cursor plugin skills | done (read from the plugin cache; its body goes in the prompt) |
| 18–21 | MCP: native config, status, sign-in, Cursor HTTP | done for Claude, Codex, Cursor and opencode (status from `GET /api/mcp` and `mcp.status.changed`; sign-in is opencode's OAuth attempt, its page opened in the browser; reconnect is `experimental/mcp/{name}/connect`; checked live on 2.0.26 with an OAuth stand-in server) |
| 22 | Cursor stays on ACP | done (no change) |
| 23–25 | `--disable-codebase-ref`, group kill on reap, startup sweep | done |
| 26–27 | History reading and `ptySend.ts` | gone with the terminal view |
| 28–29 | Context meter | Claude, Codex and opencode (`session.step.ended` over the model's window) emit it, and Cursor reads it from its session store; shown under the composer |
| 30–32 | Enter never interrupts; steer or queue | done |
| 33–36 | Background panel: subagents and commands (34b tokens, 34c Codex threadId) | done |
