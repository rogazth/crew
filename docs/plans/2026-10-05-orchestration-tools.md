# Orchestration tools — what a model is handed, and what it is told

Decided 2026-10-05, in a conversation that started from reviewing T3 Code's new
orchestrator (`reference/t3code`, commit `de34391`, "feat(orchestrator):
introduce new orchestrator", 2026-10-02) against Crew. Nothing here is
implemented yet. The session prompt (§6) is a draft being polished with the
user; the rest is agreed unless marked open. §7e (review of the plan against
the code and the references, round 3) amends §1, §4, §7b and the UI
decisions; where they disagree, §7e wins.

## 1. The problem that started it

- The user has to tell models explicitly to delegate through Crew instead of
  their harness's own subagents. Crew's tools are invisible to the model:
  everything but a few sits behind `find_tool` / `call_tool`, and nothing in
  the system prompt says when Crew is the better choice.
- Observed live (Manager agent `e38362a3…`, child session `c2d534ab…` "KH etapa
  1 + mentores + programas"): Manager started a session, then called
  `continue_after_turn` with "Esperar con wait_for_session a la sesión …" and
  looped on `wait_for_session` (its transcript, pos 56–64).
  *Corrected 2026-10-05 (§7e):* a wake did exist. Since `ff12421` (v0.2.0)
  `report_to_parent` (`turns.rs` ~919) enqueues the child's report in the
  agent parent's mailbox. Manager polled because the tool texts and the
  report envelope tell it to use `wait_for_session`, and each
  `wait_for_session` / `read_session` ran `mailbox::take_back`, which
  deleted the queued report, so the wake never fired.
- The UI then rendered that self-note as "Manager wrote to you"
  (`src/surfaces/chat/Message.tsx:73`), because `continue_after_turn`
  (`crates/crew-core/src/tools.rs` `fn continue_after_turn`) enqueues a mailbox
  letter from the agent to itself, and the model reads it as
  `## Message / From: yourself, to continue` (`mailbox.rs` `envelope`).

## 2. What T3 Code does (reference)

Docs: `reference/t3code/docs/orchestration-v2/` (start with `README.md` and
`orchestrator-mcp-server.md`). Prompt text:
`reference/t3code/apps/server/src/provider/T3OrchestrationInstructions.ts`.

- **App-owned MCP** (`t3-code`, HTTP, per-provider-session bearer token revoked
  when the session closes). Tools are listed directly, no meta-tool; Claude gets
  `allowedTools: ["mcp__t3-code__*"]`.
- **Tools**: `orchestrator_capabilities`, `delegate_task` (child thread, prompt
  only, no parent history; `mode: async|wait`), `task_status`, `task_cancel`,
  `create_threads`, `t3_thread_launch` (top-level thread with an explicit
  `workspaceStrategy`), `t3_thread_list`, `t3_thread_read`, `t3_thread_update`,
  `t3_thread_send` (`auto|queue|steer|restart`), `t3_thread_wait`,
  `t3_thread_interrupt`, plus `schedule_task`, `t3_worktree_*`, `preview_*`,
  `device_*`.
- **Instructions injected per provider**: Claude `systemPrompt.append`
  (`ClaudeAdapterV2.ts:909`), Codex developer instructions
  (`CodexDeveloperInstructions.ts`), OpenCode system prompt, Cursor/ACP wrapped
  in the first user prompt. Blocks are conditional: the browser and device
  blocks are omitted entirely when those tools are not attached ("describing
  tools that aren't in the tool list would be worse than saying nothing").
- **Native subagents are not blocked.** The rule: "Prefer native subagent tools
  for same-provider work only when they support the chosen model. Use
  `delegate_task` … when native tools cannot … Also for cross-provider or
  explicitly T3-owned child tasks." Native subagents are observed and projected
  as child nodes in T3's execution graph.
- **Completion wakes the parent.** An async child's terminal state is steered
  into the parent's active turn or queued as a new run ("Delegated task X
  reached a terminal state. Use task_status…"), batched per cohort, with
  delivery states `pending/claimed/delivered/disposed` so a blocking wait and
  the wake never both deliver (`Orchestrator.ts`, `completionDelivery`,
  `completionWake: always|settled_only`). The tool description says "end the
  turn instead of polling".
- **Policy**: a child never gets broader runtime/interaction mode than its
  parent; `clientRequestId` makes retries idempotent; review rounds are a new
  `delegate_task` each, never a send to `childThreadId`.
- **Guardrails + examples** in the prompt: what not to do, and literal JSON for
  tool calls. Also a fallback line for harnesses that load MCP lazily: "if the
  tools are not in the catalog, make one bounded direct attempt by name before
  concluding they are unavailable."

## 3. Principles agreed

1. **Crew extends the harness; it does not replace it.** Native subagents stay
   untouched and valid. The prompt describes what Crew adds and lets the model
   choose. It never names a provider's own subagent tool (they differ per
   provider).
2. **Crew's tools are injected directly.** No `find_tool` / `call_tool`.
   Pre-approve `mcp__crew__*` for sessions Crew launches.
3. **Messaging is for talking to someone else.** Nothing writes to itself.
4. **A child's report wakes its parent.** When the result is needed inside
   the same turn, `start_session` takes `wait: true` (§7b.2).
5. **Prompts are built from conditional blocks**, per caller kind and per
   attached tool family (orchestration, processes, browser).
6. **Agent = persistent memory, long-lived work. Session = one job,
   disposable.**

## 4. Decisions

1. **Wake on report.** When a child session ends a turn, Crew enqueues its
   report in the parent agent's mailbox, which starts a turn opening with
   `## Report from session <name> (<id>)`. If the parent is blocked in
   `start_session` with `wait: true` and receives the report there, it is not
   also enqueued. Reports finishing while the parent is busy are batched into
   one turn. Terminals cannot be woken; they check with `read_session`.
   Only `owner: "me"` sessions report (§7b.1). *Amended (§7e.1):* this
   exists already; the work is fixing it (letter kinds, batching, seen
   marks, crash safety), and a wake is always queued, never steered.
2. **One send tool**: `send_message({to, text, steer?})` (was `mode`, see
   §7b.2) replaces `message_agent` and `send_to_session`. Same delivery for
   any target: idle → starts a turn, busy → waits, `steer` → into the running
   turn where the CLI supports it, refused otherwise. One envelope:
   `## Message / From: Manager (agent e383…) / Reply with send_message to e383…`.
   Allowed: agent→agent; anyone→a session it started; child→its parent or any
   agent. Refused: session→someone else's session (one driver), anyone→itself,
   anyone→terminal (no turns to inject; the error says so).
   Naming risk (`turns.rs` tools_hint comment): an agent told `message_agent`
   once used Claude Code's own `SendMessage`. Direct injection shows
   `mcp__crew__send_message`, which disambiguates by namespace.
   *Amended (§7e.3):* a `steer` the target cannot take is queued, not
   refused, and the result says how it was delivered
   (`delivery: started|queued|steered|answered`). A send to a session with a
   pending question answers it (§7e.4).
3. **One directory**: `list_peers` replaces `list_agents` + `list_sessions`
   (kind, status, parent, worktree, id).
4. **`start_session` absorbs `create_worktree`**: `owner: "me"` (default; a
   child that reports and wakes you) or `owner: "user"` (top-level, nobody's
   child, no report — "open it on a branch and I'll take it from there").
   Worktree is orthogonal (`current|new|<branch>|<path>`). Terminal vs headless
   chat is Crew's choice, not the model's.
5. **Remove `respond_to_session`.** ~~Disable the interactive-question tool
   in children so questions come back in the report.~~ *Replaced (§7e.4):*
   children keep their question tool; a question wakes the parent, which
   answers it with `send_message` (the user may answer it too, first answer
   wins). Approvals of an ask-autonomy child still go only to the user in
   Crew, and a child never gets more autonomy than its parent. To cut a child
   short: `send_message` steer or `stop_session`.
6. **Remove `continue_after_turn`.** Waiting on a child is the wake; waiting on
   another agent is its reply; long work is the CLI's own compaction; "check
   back in 10 minutes" becomes a one-off routine: `save_routine` gains
   `schedule: {kind: "once", at}`. This also removes `MAX_SELF_TURNS`, the
   self-addressed envelope, and the "wrote to you" bug.
7. **Merge by verb to keep the injected list small**: `control_process`
   (`action: start|stop|restart|pause|resume`), `save_process`
   (create+update), `read_logs` with `pattern` (absorbs `grep_logs`),
   `browser_act` (`action: click|hover|fill|type|press`), `browser_activity`
   (`kind: console|network`); drop `claim_tab` (every browser tool claims).
   This is our call, not T3's (T3 keeps many focused `preview_*` tools).
8. ~~**Idempotency**: `clientRequestId` on `start_session` and
   `send_message`.~~ *Dropped (§7e.8):* over local stdio a lost response is
   rare, and the realistic duplicate (the model calling twice) is not
   prevented by it.
9. **Deferred-tool fallback line** in every prompt (Claude Code may still defer
   MCP tools behind its own tool search; the names are visible, which is what
   `find_tool` hid).
10. ~~**Cursor** has no MCP and keeps the `crew` CLI.~~ *Replaced (§7e.6):*
    `cursor-agent` has MCP. Crew moves Cursor to `cursor-agent acp` and hands
    `crewd --mcp` (stdio) in `session/new`, so Cursor gets the same tools and
    prompts as everyone else. The `crew` CLI stays for people, renamed to
    match (`crew send`, `crew peers`, …).

## 5. Final tool inventory (28)

Caller kinds: B bot, T terminal, H child session (renamed per §7d).

| Tool | Who | Purpose |
|---|---|---|
| `list_peers` | B T H | Who I can write to: bots and sessions, with kind, status, parent, worktree |
| `send_message` | B T H | Write to a bot, a session I started, or my parent; `steer` goes into its running turn; to a session with a pending question, answers it |
| `start_session` | B T | Start a session for one job: `owner` me (child, wakes me; `wait` blocks for its report) or user (handoff, no report) |
| `read_session` | B T | Read what a child did, incrementally |
| `stop_session` | B T | End a child |
| `update_description` | B | Rewrite my standing instructions |
| `search_messages` | B | Search my own history |
| `create_bot` | B T | Create a persistent identity, only when the user asks |
| `list_routines` | B T H | A routine is any time-based wake |
| `save_routine` | B T H | Create/update; adds `once` |
| `delete_routine` | B T H | |
| `list_processes` | B T H | Dev servers, watchers, workers and where they run |
| `control_process` | B T H | start/stop/restart/pause/resume |
| `save_process` | B T H | Define or change a process (proposal under ask) |
| `delete_process` | B T H | |
| `read_logs` | B T H | Tail, cursor, or `pattern` search |
| `wait_for_log` | B T H | Block until a line matches, the process exits, or timeout |
| `send_input` | B T H | Type into a process's terminal |
| `list_tabs` | B T H | |
| `open_tab` | B T H | |
| `release_tab` | B T H | |
| `browser_navigate` | B T H | |
| `browser_snapshot` | B T H | Accessibility tree with uids |
| `browser_act` | B T H | click/hover/fill/type/press |
| `browser_screenshot` | B T H | |
| `browser_wait_for` | B T H | |
| `browser_activity` | B T H | console/network |
| `browser_evaluate` | B T H | |

Removed: `find_tool`, `call_tool`, `message_agent`, `send_to_session`, `wait_for_session`,
`list_agents`, `list_sessions`, `create_agent` (→ `create_bot`), `create_worktree`, `respond_to_session`,
`continue_after_turn`, `upsert_routine`, `grep_logs`, `claim_tab`,
`start/stop/restart/pause/resume_process`, `create/update_process`,
`browser_click/hover/fill/type/press/console/network`.

The model in three lines: a bot is a persistent identity, reached with
`send_message`; a session is one job, made with `start_session`, and if it is
yours it wakes you when done; a routine is any wake by time.

## 6. Session prompt — draft v2 (being polished)

Replaces `child_persona` (`crates/crew-core/src/providers/mod.rs`) and the
child tools hint (`turns.rs`). Placeholders: `{parent}` (name and kind, e.g.
"Manager (bot)"), `{parent_id}`, `{date}`, `{cwd}`, `{branch}`. Style taken
from T3: guardrails (what not to do) and literal tool call examples. Only
sessions started with `owner: "me"` get this prompt; a handoff (`owner:
"user"`) is the user's session and gets the terminal note (§7.3).

### Base block (always)

```markdown
## Crew session

You are a session in Crew, a desktop app that runs coding agents side by side.
{parent} started you for one job: the first message below. Today is {date}.
You work in {cwd}, on branch {branch}.

A session is disposable. When the job is done this conversation is over, and
nothing in it is remembered except your report and what you leave in the
repository. {parent} keeps the memory, and may hand you more work in this same
conversation.

Your harness's own tools work as usual, subagents included. Crew's tools add
to them; they replace none of them.

### The job

- Do the job you were given, and only that. If you notice something else worth
  doing, mention it in your report; do not do it.
- If the job needs a decision that only {parent} or the user can make, do not
  guess. Ask it with your question tool if you have one ({parent} answers
  it), or stop and ask in your report.
- Stay in {cwd}. Do not create worktrees, switch branches or cd into another
  checkout unless the job says so.
- Do not commit unless the job asks for it. Do not push, open pull requests or
  deploy unless the job explicitly asks for that step.

### Your report

Your final message of each turn is your report. Crew delivers it to {parent}
when your turn ends and wakes it, so write it for {parent}, not for the user:

  **Done**: what changed, with file paths.
  **Checked**: how you know it works, meaning the commands you ran and what they
  showed. Say plainly what you did not check.
  **Left**: what is unfinished or out of scope.
  **Questions**: decisions you need, each answerable in one line.

Leave out any section that is empty. Do not:
- send {parent} progress updates with send_message; the report already reaches it.
- end a turn without a report, or with one that only says "done".
- say something works when you did not run it.

Messages from {parent} or from a bot arrive in this conversation as a turn
that starts with `## Message`, naming who wrote it.

### Crew tools

Crew's tools come from its `crew` MCP server. Your harness may show them with a
prefix, such as `mcp__crew__send_message`; they are the same tools. If you do
not see them in your tool list, call one by name once before deciding they are
unavailable.

- `list_peers`: the bots and sessions in this workspace, each with the id it
  is reached by.
- `send_message`: write to a bot other than {parent}, about something that
  belongs to its job:
  `{"to": "a1b2…", "text": "Which Stripe account does staging use? I need the key name, not the value."}`
  It cannot see this conversation, so give it everything it needs. Its answer
  arrives as a turn of its own.

You cannot start sessions. If the job needs more hands than yours, say so in
your report. Do not use send_message to reach the user; the user reads your
report in Crew.
```

### Processes block (when the process tools are attached; bots get it too)

```markdown
### Dev servers and other processes

The workspace defines its long-running processes (dev servers, watchers,
workers) in Crew, where the user can see them. Use those; do not start your own:

- `list_processes`: what exists and where it runs.
- Start one and wait until it is up:
  `control_process` `{"process": "web", "action": "start"}`, then
  `wait_for_log` `{"process": "web", "pattern": "ready in", "timeout_s": 60}`
- Look for problems: `read_logs` `{"process": "web", "pattern": "error|warn"}`

Do not start a server from your shell with `&` or `nohup`. Nobody can see it,
stop it or read its logs, and it outlives you. If the process you need is not
defined, ask for it in your report.
```

### Browser block (when the browser tools are attached; bots get it too)

```markdown
### Browser

Crew has a browser that the user sees as tabs. Use it for anything in a web page:

- `open_tab` `{"url": "http://localhost:3000"}`, or reuse one from `list_tabs`.
- `browser_snapshot` before acting, then act on the `uid`s it returns:
  `browser_act` `{"action": "click", "uid": "e12"}`
- `browser_activity` `{"kind": "console"}` to see errors after an action.
- `release_tab` when you are done.

Do not switch to Playwright, Chrome or any other browser because a first call
failed. Read the error and retry with corrected arguments. Use another browser
only when these tools are absent or the job asks for one.
```

### Open points on the session prompt

1. Commit vs push/PR/deploy split as written above (recommended: commit only
   when asked; outward steps only when explicitly asked). *Pending.*
2. May a disposable session define processes (`save_process`), or only ask in
   its report?
3. Fixed four-section report (Done / Checked / Left / Questions) — helps the
   parent review, may be rigid for research jobs.
4. `send_message` to the parent mid-turn: forbid entirely, or allow for urgent
   blockers without ending the turn?
5. `{parent}` as name and kind only, or with id? The id matters only if point 4
   allows writing to it.

## 7. Bot prompt — draft v1

Replaces `persona_prompt` + `tools_hint` / `mcp_tools_hint` /
`shell_tools_hint`. Every bot turn is a fresh CLI process (`turns.rs:147`), so
this is sent every turn. Placeholders: `{name}`, `{bot_id}`, `{description}`,
`{date}`, `{cwd}`, `{branch}`. Must not name provider-specific subagent tools.

### 7.1 Base block (always)

```markdown
## Crew bot

You are {name}, a bot in Crew, a desktop app that runs coding agents side by
side. Today is {date}. You work in {cwd}, on branch {branch}.

{description}

### Your memory

Every turn starts fresh. You know only what Crew hands you here: the
instructions above, the tail of this conversation, and the message that
started this turn. To keep something for later turns, rewrite your
instructions with `update_description`. To find something older, use
`search_messages`. What other bots know, ask them.

### Who wrote this turn

- No header: the user, reading your reply in a chat window. Do the work
  first, then say what happened.
- `## Message`, from a bot or a session: reply with `send_message` to the id
  it names. What you write in the chat reaches only the user.
- `## Report from session <name> (<id>)`: a session you started finished a
  turn. Several reports may arrive together.
- `## Question from session <name> (<id>)`: a session you started is
  waiting on a question. Answer it with `send_message` to that id; if the
  decision belongs to the user, say so in your reply and the user answers it
  in Crew.
- `## Routine <name>`: a routine woke you.

### Handing off work

Two ways to hand off work, both valid. Your harness's own subagents are the
default for work that fits it. A Crew session adds what the harness cannot
give: another provider or model, its own worktree, work the user can follow
and steer in Crew, a conversation you can come back to with `send_message`,
and a report that wakes you when it is done, even after this turn has ended.
Pick by what the job needs.

- Delegate, and get woken by the report:
  `start_session` `{"prompt": "Implement the plan below in a new worktree…", "worktree": "new"}`
- Need the answer to keep going in this turn:
  `start_session` `{"prompt": "Find which Stripe API version billing uses.", "wait": true}`
- The user wants to carry on there themselves (a handoff): no report, not
  yours to drive:
  `start_session` `{"prompt": "…", "worktree": "new", "owner": "user"}`

A session sees nothing of this conversation. Put everything it needs in the
prompt: the goal, the files, the constraints, what done looks like, and
whether it may commit.

Do not:
- poll a session with `read_session` in a loop. End your turn; its report
  wakes you.
- pass a report on to the user unread. Check it; send fixes to the same
  session with `send_message`.
- interrupt a running session (`"steer": true`) except to correct its course.
- create bots unless the user asks for one.
- give orders to other bots. They are peers with their own jobs: ask.
- write to yourself. To come back later, `save_routine` with
  `{"schedule": {"kind": "once", "at": "…"}}`.

### Crew tools

(Same fallback paragraph as the session prompt.) Plus: `list_peers`,
`send_message`, `start_session`, `read_session`, `stop_session`,
`create_bot`, `update_description`, `search_messages`, routines.
```

Then the processes and browser blocks from §6, unchanged.

### 7.2 Open points on the bot prompt

1. Persistent goal (objective, done criterion, current state) handed every
   turn, or `update_description` is enough? (§7b.6)
2. How much of the conversation tail to hand each turn, and whether the
   prompt should say it is a tail.

### 7.3 Terminal note

A terminal is a CLI the user runs; Crew does not touch its prompt. All it gets
is the MCP server `instructions()`: the vocabulary (bot, session, routine),
`start_session` with `owner` and `wait`, and that a terminal cannot be woken,
so it checks its sessions with `read_session` or waits with `"wait": true`.

## 7b. How it should work (round 2, 2026-10-05)

Restated by the user, from the desired behaviour rather than the bugs:

1. **Plan anywhere, execute in a worktree.** An agent or session on master
   plans; execution goes to `start_session` with a new worktree. Agents are
   created only when explicitly asked. `create_agent` stays a separate tool
   (the earlier merge was `start_session` + `hand_off` + `create_worktree`, not
   `create_agent`). *Agreed.*
   `start_session` keeps `owner`, which is T3's `delegate_task` vs
   `t3_thread_launch` folded into one tool:
   - `owner: "me"` (default): delegate. A child that reports and wakes the
     caller. In the UI it lives inside the caller's chat, not in the session
     list (T3: child threads are in the parent's "Agents" surface,
     `Sidebar.tsx:2707`). This fixes the KnowHub case where the agent's child
     sat at the top of the list.
   - `owner: "user"`: handoff. A top-level session, nobody's child, no report;
     the user continues the work there ("plan on master, carry on in the
     worktree"). The prompt says: only when the user asks for a separate
     session or to continue somewhere else.
   - No lock/release. Revisit §4.2: T3 lets anyone send to a top-level
     thread; only someone else's child stays off-limits.
   - Handoff pitfall: a new worktree does not carry uncommitted files (a plan
     written on master and not committed is not there). The handoff prompt
     must carry the plan. *Decided: no file copy for now; the prompt
     carries the plan.*
2. **Reports are automatic.** Crew delivers the child's final message at every
   turn end; the child never calls a tool to report. *Agreed:*
   - `start_session({…, wait?})`: `wait: true` blocks until the child's turn
     ends and returns the report (T3 `delegate_task` `mode: wait`); on timeout
     it returns "still running" and the report wakes the caller later.
     *Amended (§7e.2):* default 10 min, max 60; it also returns when the
     child asks a question.
     Refused with `owner: "user"` (no report to wait for).
   - `send_message({to, text, steer?})`: `steer: true` goes into the
     recipient's running turn (correct course now); default queues it after
     the current turn (follow-up). Replaces `mode: auto|queue|steer`: in our
     design `auto` and `queue` were the same, and interrupting must be
     explicit (unlike T3's `auto`, which steers when it can). No `wait`: a
     follow-up's report wakes the sender.
   - `wait_for_session` is removed (T3 keeps `t3_thread_wait`). Cost: a
     terminal, which cannot be woken, checks on children with
     `read_session`.
3. **Native subagents and background commands** must be visible in the UI
   (today the tab sits on "loading" with no reason shown). *Prototyped; see
   "UI decisions" below.*
4. **Inter-agent messages live in threads, one per pair.** The main chat
   shows a checkpoint at each point a message was sent or received, saying
   only who wrote to whom ("Lead → Auth refactor"), no summary and no
   new-turn/mid-turn/report marking; clicking it opens that pair's thread at
   that message. *Agreed (changed from one-per-chat after trying it in the
   prototype).* The chat bar has a "Conversations" menu listing the chat's
   pairs (opens directly when there is only one, hidden when none).
5. **Nobody messages itself.** *Agreed* (already §4.2).
6. **`continue_after_turn` goes.** Long work is one long CLI turn; large work is
   delegate → end turn → woken by reports; waits on time are `once` routines.
   *Agreed* (already §4.6). Open follow-up: a persistent goal (objective, done
   criterion, current state) handed to each fresh agent turn, since agent turns
   never resume (`turns.rs:147`).

## 7c. Bug: pasted messages stay "Queued" forever

Seen in this very conversation (terminal session "Orchestration tools:
prompts", Claude Code, Crew 0.2.7 installed at `/Applications/Crew.app`).

- **Symptom**: a message sent from Crew's chat composer reaches the CLI and is
  answered, but its bubble keeps the "Queued" label and dimmed style
  (`src/surfaces/chat/Message.tsx:47`).
- **Which ones**: exactly the messages the CLI received as a paste. In the
  session transcript the four stuck ones are recorded as
  `"\n\n<pasted_content id=\"8be6\">\n…\n</pasted_content id=\"8be6\">\n"`; the
  one typed short ("Excelente, me parece bien…") is plain text and cleared.
- **Cause**: `delivered()` (`src/lib/sessionChat.ts:23`) clears a queued
  bubble when a later user turn's text ends with what was sent. The history
  decoder passed the CLI's `<pasted_content>` wrapper through, so the turn
  ended with `</pasted_content id="8be6">` and never matched.
- **Status**: fixed on master by `da9f755` (strips the wrapper in
  `crates/crew-core/src/session_history/claude.rs`, regex `PASTED`), committed
  after 0.2.7 was tagged; the installed `crewd` has no `pasted_content` string
  in it. Needs a release; nothing for this plan to build. To verify after the
  release: paste a multi-line message while the session is working; the
  bubble must lose "Queued" when the turn starts.
- **Gap to keep in mind**: matching by text is fragile to anything else a CLI
  wraps around input. The `send_message` path (§4.2) should match by an id
  Crew controls, not by text.

## 7c-2. Bug: "Working for 20m" right after sending

Seen in the same conversation: a new message shows the working line with the
time of an earlier turn (over 20 minutes).

- **Cause (from the code, consistent with the symptom)**: `turnStart()`
  (`src/surfaces/chat/Transcript.tsx:38`) takes the `at` of the *last* user
  block in the list it is given. `SessionChat` builds that list as
  `[...history.blocks, ...waiting.map(queuedBlock)]`
  (`src/surfaces/SessionChat.tsx:102`), so queued bubbles always sit at the
  end, whatever their time. The pasted messages stuck in "Queued" (§7c) never
  leave `waiting`; once the new message is matched and leaves, the last block
  is a stale queued bubble from 20+ minutes ago, and the timer counts from it.
- **Fixing §7c removes the trigger, not the fragility.** Any bubble that never
  matches (a CLI wrapper we do not know yet, a message the CLI dropped) brings
  it back. The turn start should come from the history (the newest user turn
  by `at`), with a queued bubble's send time used only while the history has
  no user turn newer than the last turn end. And a queued bubble that has
  been waiting longer than the turn it was sent into should be dropped, not
  kept forever.
- **To verify**: after the next release, paste a long message, wait for the
  reply, send a short one; the timer must start at 0.

## 7c-3. Bug: replies to a wake fold out of sight

Seen in the session "Orchestration tools plan 2026-10-05" (Claude Code
session `dd78902d`, Crew 0.2.7). The user asked a question, the model sent
two `Explore` subagents and ended its turn; when they reported, the model
answered in new turns the CLI started by itself. The chat never showed those
answers: the user saw only the last reply and a "Worked for 1m 51s" line.

- **Reproduced**: the session file run through `ClaudeDecoder` yields every
  reply, so nothing is lost in the backend. Running those blocks through
  `groupRows` + `foldTurns` (`src/lib/transcriptRows.ts`) gives:

  ```
  USER: Dale, tambien pideles que hagan pull de la ultima version…
  ▸ Worked for 111s (collapsed) {
      [activity x6]
      ASSISTANT: Ya volvió el análisis de las otras referencias; falta t3code…
      [activity x3]
      ASSISTANT: Hay tres hallazgos que cambian el plan: Cursor sí soporta MCP…   ← the recommendations
      [footer 110739ms]
      ASSISTANT: Terminó la revisión de t3code… Suma dos datos…                   ← wake turn 1
      [footer 4953ms]
  }
  ASSISTANT: El reporte de las otras referencias… confirma…                       ← wake turn 2, the only one shown
  ```

  The first question of the session hides the same way: "El análisis del
  backend ya volvió… la premisa del §1 es incorrecta" (a wake turn) sits in
  the fold under "Worked for 36s".
- **Cause**: `foldTurns` takes a turn to be "a user row up to the next user
  row", and keeps only the last assistant reply outside the fold. A turn the
  CLI starts by itself has no user row: the decoder drops the
  `<task-notification>` that opened it (`session_history/claude.rs`,
  `user_text` and `INJECTED`). So every wake turn joins the turn of the last
  question, and every reply but the very last one is folded as "work".
- **Made worse by**:
  - `working` (`SessionChat.tsx:82`) is false while only background tasks
    run, so the fold closes between wakes: the user sees a reply, then it
    jumps into the fold when the next wake answers.
  - The fold label takes the *first* footer it finds (`foldTurn`), so it
    says "36s" over four minutes of work and several answers.
  - Nothing says why the model spoke again: the reply appears with no
    question and no sign of the report that woke it.
- **Why it matters for this plan**: wake on report (§4.1) makes this the
  normal flow, not an edge case. Any wake with no visible user row hits it:
  Claude's own subagents and `run_in_background` commands
  (`<task-notification>`), routine runs (`scheduler.rs`, `hidden: Some(true)`),
  and Crew's report envelope if it is sent hidden. A Crew letter with
  `fromAgent` starts a new turn today only because it is a `user` row.
- **Fix**:
  1. A turn ends at its footer (`turn_duration` / `TurnCompleted`), not at the
     next user row. `foldTurns` folds each turn on its own; a wake turn's
     reply stands outside the fold like any other answer.
  2. A wake turn gets a marker row where its user row would be. The decoder
     turns `<task-notification>` into a note from its `<summary>` ("Agent
     'T3 Code: waits, queue…' finished", "Command finished"); a routine run
     shows its routine's name; a Crew report shows as the child's letter
     (§7b). Several reports in one wake are one marker.
  3. The fold's duration is its own turn's footer.
  4. Test in `transcriptRows.test.ts` with this shape: question → turn with
     tools and a reply → wake → reply → wake → reply. All three replies must
     be visible rows.
- **To verify**: in a Claude terminal session, ask for two background
  `Explore` agents and end the turn; each report's reply must stay visible
  under a "finished" marker, with its own "Worked for" line.

## 7e. Review against the code and the references (round 3, 2026-10-05)

The plan checked against Crew's code and against the references, pulled to
their latest commits on 2026-10-05 (`t3code` `3e6b45028c`, `zeron`
`c8eb7524`, `monocode` `98da85a`, `opencodex` `93cdffd6a`). *All agreed
with the user.* Where this section disagrees with an earlier one, this wins.

### 7e.1 Wake on report: fix it, don't build it

The wake exists (§1, corrected). What breaks it, and the fix:

- **No letter kinds.** The `mailbox` table cannot tell a report from a
  message, so `take_back` (`mailbox.rs` ~186), which matches on
  `from_session` only, also deletes a message the child sent its parent.
  *Fix:* `mailbox.kind` (`message | report | question`) in the v26 migration.
  The envelope depends on the kind (`## Report from session…`,
  `## Question from session…`, `## Message`).
- **No batching.** `drain_mailbox` claims one letter per turn (`turns.rs`
  ~774), so N reports are N turns. *Fix:* claim every pending letter for the
  recipient into one turn, each under its own header, capped at about 20k
  characters; the rest go to the next turn.
- **Double delivery the other way.** A report delivered by the mailbox never
  runs `mark_seen`, so a later `read_session` hands it out again. *Fix:* a
  report letter stores the `session_events` cursor it reports; delivering it
  marks seen up to that cursor; `take_back` drops only report letters at or
  below what the caller has seen.
- **Crash windows.** Recording the event (`turns.rs` ~899) and enqueueing the
  report (~956) are two writes; a claimed letter whose bot turn dies is never
  redelivered. *Fix:* one SQLite transaction for both writes; split
  `claimed_at` from `delivered_at` (T3's pending, claimed, delivered,
  disposed); at startup, release letters claimed but not delivered.
- **Keep every letter.** Mark letters `disposed` instead of deleting them.
  The mailbox becomes the store of the pair threads (§7e.9).
- **Wakes are queued, never steered.** A Claude steer interrupts the tools in
  flight; T3 stopped steering Claude wakes for that reason (`1beb0355d0`,
  `activeSteeringInterruptsTools`). `steer` is only for an explicit
  `send_message` with `steer: true`.
- **Stale tool advice.** The report envelope and the tool texts point to
  `wait_for_session` and `respond_to_session` (`mailbox.rs` ~75,
  `turns.rs` ~943, `session_tools.rs` ~303). They go with those tools.
- The wake replies must stay visible in the chat: §7c-3 ships with this.

### 7e.2 Long work and `wait: true`

References: T3 waits 10 min by default and 60 at most; on timeout the child
keeps running and its completion wakes the parent; it sets Claude's MCP
server `timeout` to 65 min because Claude Code otherwise aborts a call after
60 s. zeron's `wait_for_turn` has the same 600 s / 3600 s. Orca and grok-bot
tell the model to treat a timeout as a checkpoint. All of them say the same
for work that takes hours: delegate, end the turn, get woken.

Decision:
- `wait: true` waits 10 min by default, 60 at most (`timeout_s`). Today's
  cap is 60 s (`WAIT_MAX_S`, `session_tools.rs` ~36); the shim's timeout
  (`mcp.rs` ~103) becomes the wait plus a margin.
- On timeout it returns `{status: "running"}` with "its report will wake
  you" (bot) or "check it with `read_session`" (terminal). The child is
  never stopped.
- It returns early when the child asks a question (`{status: "question"}`).
- Raise the client's MCP tool timeout for sessions Crew launches: Claude's
  per-server `timeout` in `--mcp-config` (to check that it applies to stdio
  servers), Codex `tool_timeout_sec` in its `mcp_servers.crew` config.
- The prompts say: for work that takes more than a few minutes, do not wait;
  end the turn.

### 7e.3 Sending to someone busy: Crew owns the queue

References: T3 owns its queue ("app-owned queued turns"), zeron and monocode
keep an app-side queue for what the CLI cannot take mid-turn. T3 falls back
from steer to interrupt-and-restart; nobody else restarts.

Decision:
- The mailbox is the queue; the CLI's own queue is not used.
- `steer: true` goes into the running turn where the provider can take it:
  Claude over stream-json, Codex with `turn/steer` (needs app-server,
  §7e.7), OpenCode by prompting the busy session, Cursor with ACP
  `session/steer` if `cursor-agent` has it (monocode uses it; to check).
- Where it cannot, the letter is queued, never refused and never restarted
  (a restart loses work). The result says what happened:
  `delivery: started | queued | steered | answered`.
- Claude bots get `--replay-user-messages` like children (today only
  children, `turns.rs` ~1244); without it a steer to a bot is delivered
  twice.

### 7e.4 Questions are answered by the parent; approvals by the user

References: T3 sends approvals to the user and lets a parent answer
questions (`t3_pending_request_respond`), never approvals; it keeps a
child's mode at or below its parent's. monocode's lead answers its workers
and escalates to the user only "when the call is genuinely theirs". zeron's
parent answers with `respond_to_input`.

Decision (the user's call, replacing §4.5's "disable `AskUserQuestion`"):
- Children keep their question tool (Claude `AskUserQuestion`, Codex
  app-server user-input requests, ACP equivalents).
- A child's question becomes a `question` letter that wakes the parent:
  `## Question from session <name> (<id>)`, each question with its options.
  A terminal parent cannot be woken; it sees it in `list_peers`,
  `read_session`, or as `wait: true`'s early return.
- The parent answers with `send_message({to: child, text})`. If the child
  has a pending question, the message answers it (`delivery: "answered"`)
  instead of queuing. With several questions, `answers: [...]` gives one
  answer per question in order; `text` alone answers a single question. A
  free-text answer is fine (`AskUserQuestion` accepts one).
- The user can answer the same question in the child's card in Crew. First
  answer wins; the other gets "already answered".
- If the decision is the user's, the parent says so in its reply (bot) and
  does not answer.
- Approvals of an ask-autonomy child go only to the user. They do not wake
  the parent; `list_peers` and `read_session` show the child as
  `waiting_for_user`.
- A child never runs with more autonomy than its parent (`start_session`
  refuses an escalation).
- `respond_to_session` still goes; `send_message` absorbs its question half.

### 7e.5 Crew's tools are pre-approved

Every `mcp__crew__*` tool is pre-approved for bots and children:
`permissions.allow: ["mcp__crew__*"]` in the `--settings` JSON Crew already
passes Claude (`claude.rs` ~46). Today they run with
`--setting-sources=project,local`, so every Crew call goes through
`can_use_tool` and becomes an approval in Crew. Terminals follow the user's
own settings (Crew does not edit their argv: `--mcp-config` and
`--allowedTools` take several values and can swallow what follows). Codex
app-server and ACP get the same: Crew's server approved by default.

### 7e.6 Cursor moves to ACP

`cursor-agent` has MCP (`2026.10.01`: `agent mcp list|enable`,
`.cursor/mcp.json`, `--approve-mcps`). In ACP mode, `session/new` takes
`mcpServers`; T3 hands its server over stdio there because ACP agents drop
injected HTTP servers (`AcpAdapterV2.ts` ~683). zeron's ACP harness does the
same; zeron and T3 run Cursor through `@cursor/sdk` instead (inline
`mcpServers`, leaving out the `project` setting source because the SDK skips
MCP approval).

Decision: run Cursor as `cursor-agent acp`, with `crewd --mcp` and its env
(`CREW_SOCKET`, `CREW_TOKEN`) in `session/new` `mcpServers`. No Node
dependency, no `.cursor/mcp.json` written into the repo or the user's home.
What it brings: the same tools and prompts as the other providers (no second
rendering in `crew` CLI syntax), permission requests over ACP, and steer if
supported. The prompt still goes in the first user message (T3 and monocode
do the same). To check first: stdio MCP over ACP with `cursor-agent`,
`session/steer`, and session resume (`session/load`).

### 7e.7 Codex moves to app-server

T3 runs `codex app-server`; zeron and opencodex too. Against `codex exec` it
gives:
- MCP per thread in `thread/start` `config.mcp_servers.crew`
  (`command`, `args`, `env`, `tool_timeout_sec`).
- Instructions per turn. T3 puts its orchestration text in `turn/start`
  `additionalContext`, not in `developer_instructions`, because newer model
  catalogs override that (`CodexDeveloperInstructions.ts` ~190-222).
- Steer with `turn/steer {expectedTurnId}`, falling back to queue when it is
  rejected.
- User-input requests and approvals as requests (the questions of §7e.4).
- Background terminals: `thread/backgroundTerminals/list` and `/terminate`
  (§7e.10).
Also check how Codex names Crew's tools: `turns.rs` ~113 says
`mcp__crew__x`, `providers/mod.rs` ~144 parses `crew.x`.

### 7e.8 Smaller decisions

- **Prompt blocks vary by caller kind only.** The browser and process
  families are always registered (`crewd/src/lib.rs` ~586) and the server
  does not announce `listChanged`, so "when attached" cannot change mid
  session. Both blocks are always in the prompt; the browser block adds:
  "if a call says Crew is not open, say so". The tool list in a prompt is
  built from `visible(kind)`, the same source as `tools/list` (today
  `hidden_tools()` always uses `CallerKind::Agent`, `turns.rs` ~356).
- **Instructions per provider:** Claude `--append-system-prompt`; Codex
  `additionalContext` (§7e.7); OpenCode the per-prompt `system` field or
  session instructions (T3), or the inline config, to check; Cursor the first
  user message.
- **`crew` CLI:** each tool declares its CLI group and verb, and `GROUPS` is
  built from that (today `crew-cli/src/commands.rs` panics on a tool it
  names that no longer exists, ~204). Renamed in the same step as the verb
  merges.
- **`clientRequestId`:** dropped (§4.8).
- **Removals the plan missed:** the `loops` map, the `to_self` flag in
  `envelope` and `start`, `crew agents continue`, and their tests
  (`crewd/src/lib.rs` ~2625, `crewd/tests/cli.rs` ~156).

### 7e.9 Data the UI needs

The prototype shows things the backend does not have:

| UI | Backend needed |
|---|---|
| Handoff "Handed off by Lead · yours" | `sessions.handed_off_by` (nullable), v26. "Mine" stays `parent_id`. |
| Child chip status (reported, failed) | Derived from `session_events`, sent on the wire; no new column. |
| Unread dot on a finished handoff | `sessions.user_seen` cursor, like `seen`. |
| Checkpoints and pair threads | Every `send_message` and `start_session` makes a letter with an id; the sender's tool block and the receiver's block both carry `letter_id`; a pair thread is a query on `(from, to)` over the mailbox. The same id replaces the text matching of §7c. Refused sends show only in the sender's transcript, as the tool's error. |
| Queued group in a bot's chat | An RPC listing the bot's pending letters. |
| Questions in the parent's chat | The `question` letter, shown like a report, with the child's card one click away. |

### 7e.10 Background commands and native subagents

Background commands are managed, not only shown:
- **Claude sessions Crew drives** (bots, children): the list comes from the
  `background_tasks_changed` event (full set, replace semantics), output
  from the `get_task_output {task_id}` control request (last 8 KiB), Stop
  from `stop_task {task_id}`. Found in Claude Code 2.1.289; monocode already
  sends `stop_task` per task, then `interrupt`, so a stopped task does not
  "finish later and wake Claude up again". This goes further than T3, which
  only stops everything by closing the process.
- **Codex:** `thread/backgroundTerminals/list|terminate` (§7e.7).
- **Terminals the user runs (PTY):** shown from hook data, read-only; no
  Stop.
- **Bots:** a bot's background commands end with its turn. The turn kills
  its Claude process (`turns.rs` ~1143) as today, and the turn does not wait
  for them. Anything that must outlive the turn is a Crew process
  (`control_process`, `wait_for_log`, `read_logs`). *Decided by the user.*
  The bot prompt's processes block adds: "Commands you leave running in the
  background end with your turn; for anything that must keep running, use a
  process." The tray still shows a bot's commands while its turn runs.

Native subagents: first a collapsible block with what exists today
(`ToolDetail::Agent`: description, prompt, final output). Live steps need
frames with `parent_tool_use_id` (today dropped, `turns.rs` ~2367) or the
subagent's own `.jsonl`; T3 routes them per subagent from `task_started`
(`ClaudeAdapterV2.ts` ~5843). Second phase.

### 7e.11 Prototype

Commit it on this branch now (`chore: add orchestration prototype`) so it is
not lost; delete it in the last commit before merging: `src/prototype/`,
`prototype.html`, the `prototype` script in `package.json`. When porting,
apply its changes to the real components (`SessionSidebar.tsx`,
`TabBar.tsx`, `Rows.tsx`); do not carry over its forks (`ProtoSidebar`,
`ProtoTabs`, `ProtoRows`).

## 7d. Vocabulary: "agent" becomes "bot"

Industry usage: an agent is a model plus a harness (Claude Code, Codex). In
Crew that is a **session**. What Crew calls an agent (persistent identity:
name, standing instructions, mailbox, history, routines) is renamed **bot**.

| Word | Means | User says | Model does |
|---|---|---|---|
| bot | Persistent identity, long-lived work | "create a bot that watches deploys" | `create_bot` |
| session | One coding agent (provider CLI) on one job, disposable | "hand this to an agent in a new worktree" | `start_session` (`owner: "user"` for a handoff) |
| agent | Not a Crew noun; in prompts, a synonym for session | | |

Rejected: `teammate` (Claude Code's agent teams use it: the same collision
again), `member` (reads as a human user), `persona` (sounds like just a
prompt), `worker` (fits sessions better than identities), `assistant`
(the model's chat role).

Inventory (~2,800 hits; about a quarter are other meanings and stay):

- **DB, migration v25** (`store.rs` `migrate()`, one transaction, version
  row inside it, `has_column` guards like v15+):
  - table `agents` → `bots`, index `agents_workspace_idx` → `bots_workspace_idx`
  - `sessions.agent_id` → `bot_id` (FK to `bots`)
  - `sessions.kind = 'agent'` → `'bot'` (kinds: `bot | terminal | child`)
  - `messages.extra_json.from_agent` → `from_bot` (rewrite with `json_set`/`json_remove`)
  - `app_state`: `agent:faces` → `bot:faces`, `agent:avatar` → `bot:avatar`,
    `sidebar:prefs.hiddenKinds` value `"agent"` → `"bot"`
  - SQL strings in `session.rs` (`SESSIONS` join and 5 more), `routine.rs`;
    `scripts/migrate-check.mjs`
  - Not a rename, so in its own migration, v26, with phase 2 (§7e): `mailbox.kind`
    (`message | report | question`), `mailbox.event_cursor`,
    `mailbox.claimed_at` (beside `delivered_at`) and a `disposed_at` in place
    of deletes; `sessions.handed_off_by`, `sessions.user_seen`.
- **Wire** (UI ↔ `crewd`), renamed outright: `AgentRef` →
  `BotRef`, `fromAgent` → `fromBot`, `Session.agentId` → `botId`,
  `SessionKind`, `session_create` `kind`, `whoami.kind`, tool result keys
  (`agent`, `agent_id`). `MachineInfo.agentsRunning` stays (harness sense).
- **MCP**: `list_agents` and `message_agent` are already gone in this plan
  (`list_peers`, `send_message`); `create_agent` → `create_bot`; routines'
  `agent_id` → `bot_id`; `CallerKind::Agent`, `Audience::AGENTS`, caller
  label "(bot …)". Transcript parsers keep recognising the old tool names
  (`providers/mod.rs:187`, `claude.rs:762`, `cursor.rs:433`,
  `working_set.rs:323`): old transcripts keep them forever.
- **CLI**: `crew bots …`; routines' `--agent-id` → `--bot-id`.
- **Prompts**: written with the new words directly (§6, §7 are being rewritten
  anyway), including the MCP `instructions()` glossary.
- **UI**: `AgentSheet`, `AgentAvatar`, `useAgent*`, `agentNames`, user strings
  ("New Agent Here" → "New Bot Here", "Agent Settings…", notification
  "Agent message", getting-started step), command id `new-agent` → `new-bot`
  (check whether keymap overrides persist command ids). Mixed-meaning
  surfaces (`Agents.tsx`, `AgentChat.tsx`, `agentRuntime.ts`, `isAgentTab`,
  `SessionSurface "agent"`) mean "a Crew-driven chat" and are renamed to that,
  not to bot. "Default agent" in settings is the harness sense and stays.
- **Do not touch**: launchd LaunchAgent (`launch_agent.rs`, `daemon-agent*.ts`,
  `CREW_E2E_AGENT`), the CLI host (`agent.rs` `AgentHost`/`AgentBinary`,
  `agent_resolve*`/`agent_installed` RPCs, `AGENT_CLIS`), `cursor-agent`,
  provider vocabulary (`ToolDetail::Agent`, subagents, Codex `agent_message`,
  `AGENTS.md`), electron browser `agent-tools` (means any driving session),
  user-agent strings, provider test fixtures. No blind search-and-replace.

*Agreed (2026-10-05):* full rename, no compatibility. The user is the only
user, so no wire aliases for old `crewd` versions, no old CLI spellings, no
serde aliases; the v25 migration rewrites the stored data. It is part of this
plan, not a separate PR. Transcript parsers still recognise the old tool names,
because that is reading history, not compatibility.

### UI decisions (from the prototype)

Prototype: `src/prototype/orchestration/` (`npm run prototype`, then
`http://127.0.0.1:1431/prototype.html`, any state with `?state=…`). React,
real Crew components, fake state in `store.ts`, state switcher bottom-left.
Not committed; only `package.json` gained the `prototype` script.

Agreed:

1. **Children live in their parent.** `owner: "me"` sessions are not in the
   sidebar; they are chips in a Sessions strip in the bot's chat bar, with
   status (working, reported, failed). Reported ones fold into "N done". A
   handoff (`owner: "user"`) is a normal top-level session ("Handed off by
   Lead · yours") with an unread dot when it finishes. No "1/2 sessions" on
   the bot's sidebar row.
2. **Checkpoints** in the transcript say only who → whom and the time, one
   arrow, no summary, no new-turn / mid-turn / report labels. They stay
   visible when the turn around them is folded.
3. **Threads, one per pair** (Lead ⇄ Auth refactor, Lead ⇄ Reviewer…), the
   same thread from both sides. A two-party conversation: pair header
   (A ⇄ B), sender name and avatar per message, grey bubbles, the chat's
   markdown; built for long reports. Opens over the transcript in the same
   reading column, already positioned (no jump, no highlight effect); "Show in
   chat" goes back. Entry points: a checkpoint (opens at that message) and a
   **Conversations** menu in the chat bar next to the session chips (pairs
   with last message and unread dot; opens directly when there is one pair,
   hidden when none). No Messages button in the top bar.
4. **Native subagents** render as a nested collapsible block with live steps.
   *Amended (§7e.10):* first without live steps; those come in a second
   phase.
5. **Background commands** have a tray above the composer, **collapsed by
   default** ("Background · 2 running"), expandable to the list: click a
   command to see its output (tail view over the transcript), Stop to end it.
   The transcript keeps a minimal clickable marker, no underline. The tab
   shows a count only after the turn ended with commands still running. The
   sidebar shows nothing about them. *Amended (§7e.10):* output and Stop per
   command for Claude sessions Crew drives and for Codex; read-only for
   terminals the user runs.
6. **Queued messages** are grouped under one label ("Queued" / "2 queued").
7. The user may write to a bot's child directly; the parent sees
   "You → Auth refactor" in that pair's thread.
8. Rejected sends (to self, to someone else's child, to a terminal) show the
   reason in the row.

Open:

1. A failed child: badge on the parent bot's sidebar row?
2. Thread layout: the chat owner's bubbles on the right, like the user's own
   messages? (Recommended: yes.)
3. Background tray with only finished commands: hide when the next turn
   starts (recommended) or when the last command ends?

## 8. Next (resume here)

The design is reviewed against the code and the references (§7e); nothing
is implemented. Still open: the prompt points (session S1–S5 in §6, bot
B1–B2 in §7.2), P1 (anyone may write to a top-level session; relaxes §4.2),
and the three UI points above. None of them blocks phases 1–4.

Implementation order:

1. **Rename** agent → bot (§7d), with the v25 migration (rename only). Its
   own commit.
2. **Mailbox and wake** (§7e.1): letter kinds, batching, seen marks, one
   transaction, claimed/delivered, no deletes, wakes always queued; the new
   columns of §7e in migration v26 (a dev database that already ran v25 would
   not rerun an edited v25). With the
   chat fix for wake replies (§7c-3). Together with removing
   `continue_after_turn` (step 5) this alone fixes the Manager case (§1).
3. **Providers**: Codex on `codex app-server` (§7e.7), Cursor on
   `cursor-agent acp` (§7e.6). Each starts with a spike on what is marked
   "to check".
4. **Tool injection**: tools listed directly, no `find_tool` / `call_tool`;
   pre-approval (§7e.5); visibility and prompt tool lists by caller kind;
   MCP tool timeouts per provider (§7e.2); instructions per provider
   (§7e.8).
5. **Tools**: `send_message` (`steer`, `delivery`, answers questions),
   `list_peers`, `start_session` (`owner`, `wait`, `worktree`, autonomy
   ceiling); questions to the parent (§7e.4); removals
   (`continue_after_turn`, `MAX_SELF_TURNS`, `loops`, `to_self`, the self
   envelope, `respond_to_session`, `create_worktree`, `wait_for_session`,
   `crew agents continue`); `once` routines; verb merges; the `crew` CLI
   built from tool metadata.
6. **Prompts**: §6, §7, the terminal `instructions()`.
7. **UI** as prototyped, with the data of §7e.9.
8. **Background commands and native subagents** (§7e.10), as their own
   phase: Claude first, then Codex; live subagent steps last.
9. **Chat bugs**: §7c-2 turn start; §7c needs only a release.
10. **Cleanup**: delete the prototype (§7e.11).

## Status

| # | Item | State |
|---|---|---|
| §1 | Premise "nothing wakes a parent" | corrected: the wake exists and is broken (§7e.1) |
| §4 | Decisions 1–10 (amended by §7b, §7e) | agreed, not built |
| §5 | Inventory, 28 tools | agreed |
| §6 | Session prompt | draft v2, open S1–S5 |
| §7 | Bot prompt | draft v1, open B1–B2 |
| §7b | Workflow round 2 | agreed; P1 (relax §4.2) open |
| §7c | Pasted messages stay "Queued" | fixed on master (`da9f755`), needs release |
| §7c-2 | "Working for" counts from a stale queued bubble | cause found, to fix |
| §7c-3 | Replies to a wake fold out of sight | reproduced, cause found, to fix (phase 2) |
| §7d | agent → bot rename | agreed: full, no compat, part of this plan |
| §7e | Review round 3: wake fixes, waits, queue, questions to the parent, Codex app-server, Cursor ACP, background commands | agreed |
| UI | Prototype + decisions | agreed except 3 open points |
