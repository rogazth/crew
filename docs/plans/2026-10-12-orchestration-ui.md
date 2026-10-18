# Orchestration in the chat — one model for the work a session starts

Decided 2026-10-12, after the user's review of the chat-only build. Design
spec: what the user sees and how it behaves. Update the status table at the
bottom as each step lands.

Builds on `2026-10-07-chat-over-protocol.md` (decisions 28–36: context meter,
steer and queue, the background panel) and
`2026-10-07-subagents-and-sessions.md` (the words: subagent, session, message,
report). Every provider session is a chat; there is no terminal view and no
archive.

Reference: the throwaway prototype in the main checkout,
`src/prototype/chat-redesign/variants.tsx`. Variant E (the status line and its
sheet, the entry page over the chat) is the chat. Variant F
(`OrchestratorChat`, `ReceivingChat`) is how orchestration reads in a
transcript. The prototype is never committed.

## What is wrong today

- **Native subagents are a different thing from Crew subagents.** Claude's
  Task, Codex's agent threads and opencode's child sessions draw as a
  collapsible chip in the transcript (`SubagentRow`, `Activity.tsx`); Crew
  subagents draw as a letter checkpoint and a chip in the bar. Same job, two
  UIs.
- **The work a session started lives in two places.** The `Sessions` chip
  strip in `ChatBar` and the status line's work segment ("1 finished") list
  the same children. They disagree on how a child opens: the strip opens the
  child's chat in a new tab (`openSession`), the sheet opens it over the
  chat.
- **Opening a child stacks three headers.** The parent's `ChatBar` stays
  (with "Conversations 1"), `EntryView`'s header card ("Back to the chat
  esc") sits under it, and the nested `TurnChat` adds the child's own
  `ChatBar` ("Started by … · reports to it", and the same "Conversations 1").
  The parent's status line ("1 finished", its context ring) still shows.
  Nothing says where you are.
- **"Conversations" is used for sessions.** A pair thread (`Thread.tsx`)
  shows the letters between two parties as a chat. That suits two bots, which
  only ever talk in letters. Between a session and its subagent it hides the
  thing worth reading: the subagent's own transcript.
- **Orchestration tool calls are bare.** `delegate`, `start_session` and
  `send_message` are one-line checkpoints ("orchestrator → scout"); the
  words are a click away. `start_sessions`, `interrupt_session`,
  `read_session`, `list_peers`, `stop_session` and `update_session` are
  generic tool rows. A report reads like any letter.
- **A child's question can only be answered in the child.** The parent's
  chat shows that a letter came, not the question.
- **Independent sessions a session launched appear nowhere in its chat**
  (`panelEntries` takes owned children only), though they are the main work
  of an orchestrator.

## The words (UI)

- **Agent**: anything with its own transcript a session started: a native
  subagent, a Crew subagent, or an independent session.
- **Work**: everything a session started that runs beside its turn: agents,
  shells and monitors, Crew processes.
- **Thread**: one agent's full transcript, opened from the parent.
- **Conversation**: the letters between two bots, read as a chat. Only bots
  have conversations.

## Decisions

### One model for the work a session started

1. **One list, built in one place.** `panelEntries` (`src/lib/backgroundPanel.ts`)
   is the only source for everything a session started: native subagents
   (from its board), Crew subagents (owned children), independent sessions it
   launched (`launchedBy === session.id`, new), shells and monitors (board),
   and Crew process runs it started. The transcript rows, the status line and
   the sheet all read entries from it, so a state never disagrees between them.
2. **A native subagent and a Crew subagent are the same kind: `subagent`.**
   `PanelKind` becomes `subagent | session | shell | process`. An entry keeps
   `origin: "native" | "crew"` for what differs underneath (how it stops,
   whether it can be written to), never for how it looks. The icon is the
   provider's mark for every agent (a native subagent wears its parent's
   mark); `KIND_LABEL` says "Subagent", "Session", "Shell", "Process". "Crew
   subagent" goes.
3. **Each entry says whether the user may write to it**: `writable` is true
   for a Crew subagent that has not exited and for an independent session,
   false for a native subagent, an exited Crew subagent, a shell and a
   process. It decides the composer in the thread (decision 11).
4. **Attention comes first.** An agent waiting on a question or an approval
   is `state: "running"` with `attention: "question" | "approval"`. The sheet
   sorts attention, then running, then ended, newest first in each.

### Where it lives: the status line, only

5. **The status line under the composer is the one place.** The `Sessions`
   strip goes, and with it the whole `ChatBar` (decision 21). The work
   segment's text, in order of what matters:
   - attention: `⚠ scout asks` (one), `⚠ 2 waiting on you` (more), in
     `text-warning`, ahead of the rest;
   - running: `2 agents · 1 session · 1 shell` (agents are subagents;
     sessions are counted apart because they are the user's);
   - nothing running: `3 finished`, in `text-placeholder`, as today.
   Segments join with `·`, as variant E.
6. **The sheet is variant E's**, titled "Work": one row per entry, the mark
   with the state dot on its corner, the title, and a second line `Subagent ·
   1m 12s · 31k tokens · Editing policy.rs`. ↑↓ select, ↵ open, x stop, Esc
   close, "Clear finished" at the top right. An attention row's second line
   says the question's first line in `text-warning`. Clearing a finished
   session hides its row only: the session stays in the sidebar.
7. **Stop per kind.** A subagent stops through its provider (decision 35) or
   `stop_session`; a session's x interrupts its turn and never ends it (it is
   the user's); a shell is killed; a process stops. A kind that cannot stop
   alone says so in the row (`stopNote`), as today.
8. **Bot conversations are a second group in the same sheet.** When the chat
   has letters with bots, the status line adds `💬 2 conversations` (lucide
   `MessagesSquare`, muted) and the sheet shows a "Conversations" group under
   the work: the bot's face, its name, the last letter's first line and time.
   ↵ opens the conversation (decision 18). Sessions never appear there.
9. **Paused moves to the status line.** "Paused after 20 automatic turns" is
   a warning segment with the same tooltip; writing resumes it, as today.

### Opening an agent: always in place

10. **An agent's thread opens in the current tab, over the parent's chat.
    Never a new tab.** That holds from every entry point: the sheet, a
    transcript row, a report, a letter, a notification, the command palette.
    Processes keep their own tab (they are not agents); a shell opens in place
    like an agent, with its output instead of a transcript.
11. **The composer shows only when the user may write** (decision 3). A Crew
    subagent and an independent session get their own full composer: their
    model and effort chips, their own context meter, queue and work segments,
    their own MCP chip. A native subagent, an exited subagent and a shell get
    no composer; a one-line footer says why ("Read only · its report goes to
    orchestrator" / "Exited · start another with delegate" / "Output of a
    shell") with `esc back · x stop` on the right.
12. **One header, a breadcrumb.** The thread replaces the whole tab pane, the
    parent's status line and composer included; nothing of the parent shows.
    The parent stays mounted underneath (`inert`, hidden), so its scroll,
    draft and open sheet come back as they were. The header, in the reading
    column (max 760px), two lines:
    - line 1: `‹ [mark] orchestrator / [mark] scout` (the parent crumb is a
      ghost button that goes back; the current one is `font-medium`,
      15px), then on the right the facts as plain text (variant E): tokens,
      state dot + state word + elapsed; a hairline; Stop (`x`) when stoppable
      and there is no composer to stop it from; and `esc` as a `Kbd` hint,
      not a "Back to the chat" button.
    - line 2, 12px muted: `Subagent · Sonnet 5.5 · reports to orchestrator ·
      ⎇ feat/partial-refunds` for a subagent; `Session · yours · started by
      orchestrator · ⎇ …` for a session; `Shell · npm test` for a shell.
    The child's own bar ("Started by … · reports to it") is gone: line 2 says
    it once.
13. **Esc goes back one level, always.** In a thread, Esc never stops the
    child's turn (the composer's Stop button does, and the hint line says
    `esc back · ↵ add to its turn`). The thread's open sheet or picker takes
    Esc first, as the composer's sheets do today. Threads stack: an
    independent session opened in place may show its own subagents, and
    opening one makes the crumb `orchestrator / refunds-api / scout`; each
    crumb jumps back to its level.
14. **The body is the agent's thread.** A Crew subagent or a session: its
    transcript with the same rows as any chat (its approvals and questions
    answerable there). A native subagent: what it was asked as the first
    letter (`orchestrator asked`), then its steps as transcript rows
    (`SubagentBody`), then its answer as its report. A shell: today's
    `BackgroundOutputView` body.
15. **Opened at the point that was clicked.** From a report, a letter or a
    `send_message` row, the thread opens scrolled to the block carrying that
    letter id, lit as `focusId` lights a block today. From the sheet or a
    "Delegated to" row, it opens at its end, following a running agent.
16. **Opening marks it seen** (`useMarkSeen`), and the parent's attention
    segment updates when the child's question is answered.
17. **An owned subagent never has a tab.** A notification about it (its
    question, its failure, its report) opens its parent's tab with its thread
    open. A child tab restored from an older layout becomes its parent's tab
    with the thread open. An independent session still has its own sidebar
    row and tab; opened from its launcher it opens in place, opened from the
    sidebar it is its own tab, where its first letter says who started it.

### Bots and sessions

18. **A conversation view only between bots.** A pair thread (`Thread.tsx`)
    opens when the other party is a bot: a letter to or from a bot, a row of
    the sheet's Conversations group. It opens in place with the same header
    shape (`‹ [face] reviewer ⇄ [mark] orchestrator`, line 2 `Conversation ·
    12 letters`), no composer (the user writes to a bot in the bot's own
    chat). For a session the same click opens its thread (decision 10) at the
    letter (decision 15). "Conversations N" in the bar goes.

### The transcript

Rows follow variant F: a one-line tool row (`crew-node` icon, sentence in
13px, the tool's name as a muted aside on the right), and when there is more
to read, a card hanging under it (`ml-[26px] rounded-xl ring-1 ring-hairline`,
F's `Hang`). Names of agents and bots are `PeerName`s (mark or face + name, in
`text-text`) and each one opens that party (thread or conversation).

19. **A subagent call, native or Crew, is one row and one card.**
    - Row: `[Bot] Started a subagent [mark] scout` (aside `delegate`, or the
      provider's tool name: `Task`, `spawn_agent`, `task`).
    - Card: one line, `StateDot · what it was asked (first line) · 31k tokens
      · done after 48s`, or while it runs `· Editing policy.rs` from its
      activity. The whole card opens its thread. It reads from the panel entry
      (decision 1), so it shows the same state as the sheet.
    - No chevron, no inline steps: the inline collapsible `SubagentRow` goes.
20. **A report is a letter, said as one.** When the child's report reaches
    the parent (a native subagent's result, a Crew subagent's report letter),
    it draws where it arrived: `Report from [mark] scout` (12px muted) over
    a `bg-card` block with the text in `LongText` (folded at 7 lines, "Show
    all · N lines"). Clicking the label opens the thread at that turn. A
    native subagent's result is drawn this way at the point its call ended.
21. **Sessions started.**
    - `start_session`: `[MessagesSquare] Started a session [mark] billing-ui`,
      and a card with its line (decision 19's shape, with its branch).
    - `start_sessions`: `Started 3 sessions, one worktree each`, a muted note
      under it ("They're yours: in the sidebar, and in Work while they run"),
      and one card with one line per session, `divide-y divide-hairline`.
      An entry that failed is a line in `text-danger` with Crew's reason.
    - Each line opens that session in place. The prompt is not unfolded in the
      parent: it is the session's first letter, at the top of its thread.
22. **Messages out.** `send_message`: `[Send] Message to [mark] refunds-api
    and [mark] docs-sweep` (one row per call, recipients joined), aside
    `send_message`, and a card with the text in `LongText`. Its delivery is a
    muted suffix on the row: `· read mid-turn`, `· queued`, `· started a
    turn`, `· resumed it`, `· answered its question`. A refused send keeps
    `RefusedRow`.
23. **Messages in.** A letter from a session or a bot draws as F's `Letter`:
    the sender's mark or face (24px tile), `name` in `font-medium`, the
    envelope word muted (`wrote`, `asks`, `replied`, `started this session`)
    and a tag after a dot (`read mid-turn`, `waits on an answer`), the text
    under it in 14px. Not a bubble: the bubble is the user's. A long letter
    (a handoff) folds with `LongText`. This replaces `CheckpointRow`.
24. **Control rows are one line each, no card unless there is text.**
    - `interrupt_session`: `[Hand] Interrupted [billing-ui] and redirected
      it`, and the redirect text in a card when it has one; without text,
      `Interrupted [billing-ui]`.
    - `read_session`: `[Eye] Read [billing-ui]'s last 12 messages`.
    - `list_peers`: `[Users] Listed 7 peers · 3 sessions, 1 subagent, 3 bots`.
    - `stop_session`: `[CircleStop] Stopped [docs-sweep] and its 2 subagents`.
    - `update_session`: `[Pencil] Renamed [x] to y`, or `[Trash] Deleted
      [docs-sweep] · its worktree stays`.
    A failed call keeps the generic failed tool row with its error.
25. **A child's question or approval is answerable from the parent's chat.**
    The question letter (decision 23, tag `waits on an answer`) carries the
    child's open request under its text: a question's options as F's chips
    (or the full `QuestionCard` when it has several questions or free text),
    an approval's Allow / Deny as `ApprovalCard`'s buttons, with "You or
    orchestrator can answer" in placeholder ink. The first answer counts
    (decision 4 of the orchestration plan): answered anywhere, the chips
    disable and say "Answered by you" or "Answered by orchestrator". An
    approval is offered only when the user may decide it (always: the user is
    exempt). Opening the thread from the letter shows the same card in place.
    A native subagent's approval already arrives in the parent's stream: it
    keeps its card, and its headline names the subagent (`scout wants to
    run …`).

### What goes

26. Removed:
    - `ChatBar.tsx` whole: `SessionsStrip`, `ChildChip`, `Owner`,
      `Conversations`, the `bar` prop of `DefaultChatSurface` (Paused moves,
      decision 9).
    - `SubagentRow` and `SubagentLine` in `Activity.tsx` (the transcript's
      collapsible chip). `SubagentBody` stays, for the thread.
    - `CheckpointRow` and the `letter` row kind in `Rows.tsx` (replaced by
      decisions 21–23); `checkpointOf` stays only if a row still needs it.
    - `EntryView`'s "Back to the chat" button and its nesting of a full
      `TurnChat` inside the parent's surface overlay.
    - The pair `Thread` for any pair that is not two bots.
    - `openSession` for owned children from inside a chat; any child tab.
    - `KIND_LABEL`'s "Crew subagent"; `PanelKind` `agent` and `crew`.
    - F's `Archived` row (archiving is gone; `update_session` deletes).

### Design system

27. **Only the kit and the tokens.** Rows use `crew-node`, `ROW`, `bg-card`,
    `ring-hairline`, `rounded-xl` cards and `rounded-chrome` controls; text at
    11.5 (status line), 12–12.5 (meta), 13 (rows), 14 (letters and prose), 15
    (thread title). Buttons are `Button variant="ghost"` with `keys`; key
    hints are `Kbd`. Signals only from `--color-warning` (attention),
    `--color-danger` (failed, the Stop hover) and `--color-success` (done
    dot). No pills for facts (variant E: plain text, Linear style), no
    chevrons on chips, no monospace outside shell output and code. New shared
    pieces go in `src/surfaces/chat/Orchestration.tsx` (`ToolLine`, `Hang`,
    `PeerName`, `Letter`, `LongText`, `AgentLine`) so every row above and the
    thread header share them.

## Open questions

- **Can the user write to a native subagent?** Decided 2026-10-17: no, for
  any provider, now or later. A native subagent is its parent's to talk to;
  its thread has no composer.
- **Should a session's x in the sheet interrupt or stop it?** Decided
  2026-10-17: interrupt (decision 7). It is the user's session; ending its
  process is the sidebar's job. The sheet's Stop already sends `turn_stop`,
  the same stop `interrupt_session` makes; `e2e/background-panel.test.ts`
  holds it.
- **Does an independent session opened in place need "Open in its tab"?**
  The user said never a new tab. Recommendation: no button; the sidebar row
  is the way to its own tab, and it is one click away.

## Order of work

Each step is one agent's job (1–3 hours) and lands on its own. 1 and 2 have no
dependency and can run together; 3 needs 2; 4, 5, 6 and 8 need 3; 5 and 6 also
need 1; 7 needs 6. Screenshots are taken with `E2E_SHOTS=<dir>` through the
tests named, as `session-children.test.ts` does; each step attaches them to its
report, light and dark.

1. **Protocol: what the rows need from the daemon** (decisions 20–25).
   - Add `letterKind` (`message | report | question | approval | started`)
     to `user.message` letter blocks, from the mailbox letter's `kind`.
   - Add `ToolDetail::Crew { verb, targets: [{ id, name, provider }], text?,
     count?, note? }` for `start_sessions` (one target per entry, failed ones
     with `note`), `interrupt_session`, `read_session` (count),
     `list_peers` (counts per type in `note`), `stop_session` (subagents
     stopped in `count`), `update_session` (`rename` / `delete` in `note`).
   - Files: `crates/crew-protocol/src/blocks.rs`,
     `crates/crew-core/src/providers/mod.rs` (`crew_tool_detail`,
     `crew_result_detail`), the call sites in `providers/claude.rs`,
     `codex.rs` and opencode, `crates/crew-core/src/mailbox.rs`,
     `src/lib/protocol.ts` (regenerated), `src/lib/blocks.ts`.
   - Accept: `cargo test -p crew-core providers` covers each verb's detail
     from a call and its answer, with the `mcp__crew__` and `crew_`
     spellings; a report letter's block carries `letterKind: "report"`.
     `npm test` passes. No UI change.

2. **One work model** (decisions 1–4).
   - `PanelKind` → `subagent | session | shell | process`, with `origin`,
     `writable`, `attention`, and native subagents' `provider` set to the
     parent's. Independent sessions launched by the session become `session`
     entries. Sort attention, running, ended. `panelSummary` returns the
     attention text and `2 agents · 1 session · 1 shell`. A `botPairs`
     selector for the Conversations group (pairs whose other party is a bot).
   - Files: `src/lib/backgroundPanel.ts`, `src/hooks/useBackgroundPanel.ts`,
     `src/surfaces/chat/Panel.tsx` (icons and labels only),
     `src/lib/backgroundPanel.test.ts`.
   - Accept: vitest covers every kind, `writable` per kind and state, the sort,
     each summary text, and that a launched session is listed while a
     session launched by someone else is not. `background-panel.test.ts`
     passes with its labels updated. Screenshot: the sheet with a native
     subagent, a Crew subagent, a session and a shell (`work-sheet.png`).

3. **The thread view** (decisions 10–16).
   - New `src/surfaces/chat/AgentView.tsx` replacing `EntryView`: full-pane,
     a stack of opened entries, the two-line breadcrumb header, the body by
     kind, the composer when `writable` (the child's `TurnChat` rendered
     without its own header), the read-only footer otherwise, Esc pops one
     level, x stops. `TurnChat` keeps the parent mounted `inert` and hidden
     under it and exposes `openAgent(entryId | sessionId, { focus?:
     letterId })` through `useChatActions`; the sheet's ↵ calls it.
   - Files: `src/surfaces/TurnChat.tsx`, `src/surfaces/chat/EntryView.tsx`
     (removed), `AgentView.tsx`, `src/surfaces/chat/context.ts`,
     `src/surfaces/chat/Composer.tsx` (Esc in a thread goes back),
     `src/surfaces/chat/Background.tsx` (the shell body under the new
     header).
   - Accept: e2e in `background-panel.test.ts`: from "1 finished", ↵ opens a
     Crew subagent; exactly one header is in the pane (no parent status line,
     no second bar); the context meter (given a `data-session` hook) reads the child's id; its
     composer sends to the child; Esc returns to the parent with its draft
     intact and the sheet as it was. A native subagent opens with no
     composer and the read-only footer; x stops it. Screenshots:
     `thread-crew.png`, `thread-native.png`, `thread-shell.png`.

4. **The bar goes; the status line takes the rest** (decisions 5, 8, 9,
   18, 26).
   - Delete `ChatBar.tsx` and the `bar` prop. Paused as a status-line
     segment. The Conversations segment and group in the sheet, bot pairs
     only, opening `Thread.tsx` through the thread view's header shape.
   - Files: `src/surfaces/chat/ChatBar.tsx` (removed),
     `DefaultChatSurface.tsx`, `Composer.tsx`, `Panel.tsx`, `Thread.tsx`,
     `src/hooks/useLetters.ts`, `TurnChat.tsx`.
   - Accept: `session-children.test.ts` rewritten: a delegated child shows in
     the status line and the sheet, not as a chip, has no sidebar row, and
     opens in the same tab (the tab count does not change). A new e2e: two
     bots that wrote to each other show `1 conversation`, ↵ opens the pair
     thread with no composer. Screenshots: `status-line-running.png`,
     `status-line-attention.png`, `bot-conversation.png`.

5. **Subagent calls, reports and sessions started** (decisions 19–21).
   - `Orchestration.tsx` with the shared pieces (decision 27); rows for a
     native subagent call (Claude `Task`/`Agent`, Codex agent thread,
     opencode `task`), `delegate`, `start_session`, `start_sessions`, and
     the report letter. Remove `SubagentRow` from the transcript.
   - Files: `src/surfaces/chat/Orchestration.tsx` (new), `Rows.tsx`,
     `Activity.tsx`, `src/lib/blocks.ts` (row kinds), the row grouping in
     `Transcript.tsx`.
   - Accept: vitest for the row kinds a transcript groups into; e2e (fake
     Claude's subagent in `background-panel.test.ts`, the opencode child in
     `session-children.test.ts`): the call is one row and one card with the
     sheet's state, the card opens the thread in place, the report draws as
     `Report from …` and opens the thread at that turn. Screenshots:
     `transcript-subagents.png` (one native, one Crew, a report),
     `transcript-start-sessions.png`.

6. **Messages and control rows** (decisions 22–24, 15, 18).
   - `send_message` out with its card and delivery, letters in as `Letter`,
     and the `interrupt_session`, `read_session`, `list_peers`,
     `stop_session`, `update_session` rows. A click on a session's name or
     letter opens its thread at that letter; on a bot's, the conversation.
     Remove `CheckpointRow`.
   - Files: `Orchestration.tsx`, `Letters.tsx`, `Rows.tsx`,
     `src/lib/letters.ts` (+ test).
   - Accept: vitest for each verb's sentence from `ToolDetail::Crew`; e2e in
     `session-children.test.ts`: the parent's `send_message` to its child
     opens the child's thread scrolled to the letter, lit. Screenshot:
     `transcript-orchestrator.png`, a chat matching F's `OrchestratorChat`
     as closely as the fakes allow.

7. **Answer a child from the parent** (decision 25).
   - The question letter renders the child's open request: read from the
     child's thread (`useThread(child.id)`, subscribed only while the child's
     state is question or approval), answered with `answer` / `respond` on the
     child. Disabled with who answered once resolved.
   - Files: `Orchestration.tsx`, `src/surfaces/chat/QuestionCard.tsx`,
     `ApprovalCard.tsx`, a hook `src/hooks/useOpenAsk.ts`.
   - Accept: e2e with the fake opencode or Claude child asking a question:
     the parent's chat shows the options, a click answers the child, the
     child's turn goes on, and the chips say "Answered by you"; the attention
     segment clears. Screenshot: `answer-from-parent.png`.

8. **No tab for a subagent** (decision 17).
   - Notification clicks, `openSessionById`, the command palette and tab
     restore route an owned child to its parent's tab with the thread open.
     Opening an independent session from its launcher's chat stays in place.
   - Files: `src/hooks/useNavigation.ts`, `src/hooks/useTabs.ts`,
     `src/hooks/useNotificationTarget.ts`, `src/App.tsx`, `TurnChat.tsx`.
   - Accept: e2e in `tabs.test.ts` or `session-children.test.ts`: a saved
     layout with a child tab restores as the parent's tab with the thread
     open; a child's notification opens the parent's tab. vitest for the
     routing function.

9. **Words and status.** `ARCHITECTURE.md` gets "agent", "work", "thread",
   "conversation" (this plan's words); the background-panel decisions of
   the chat-over-protocol plan point here. After step 8, delete
   `src/prototype/chat-redesign` from the main checkout.

## Status

| # | Decision | Status |
|---|---|---|
| 1–4 | One work model | done (step 2): model, summary and `botPairs` in `backgroundPanel.ts`; sheet icons and labels only |
| 5–9 | The status line is the one place | done (step 4): `ChatBar` and the `bar` prop gone; the work segment carries attention, running work and `N conversations`; Paused is a warning segment; the sheet is titled "Work" with a Conversations group (bot pairs) |
| 10–16 | The thread, in place | done (step 3): `AgentView.tsx` replaces `EntryView`; stacked threads via `trail`; the sheet closes when it opens an entry, so it is not restored; `focus` scrolls to the letter and, since step 6, lights it |
| 17 | No tab for a subagent | done (step 8): `routeAgent` (`agentRoute.ts`) sends an owned child to its top owner; `openSession` opens that tab and queues a request `TurnChat` takes to open the thread; a restored child tab becomes its parent's (`childTabToParent`); a launched session keeps its tab |
| 18 | Conversations only between bots | done (step 4): the sheet group opens `Thread.tsx` in place under the thread header shape, no composer; a letter checkpoint to a non-bot pair still opens it until step 6 |
| 19–21 | Subagents, reports, sessions started | done (step 5): `Orchestration.tsx` (`ToolLine`, `Hang`, `PeerName`, `LongText`, `AgentLine`); native and Crew subagent calls share one row and card read from the work list (`WorkContext`, `PanelEntry.callId`); `SubagentRow` removed; a native report draws under its card only when the subagent is done; a start's note is dropped when its call row says it; no branch on cards yet; `Letter` is step 6 |
| 22–24 | Messages and control rows | done (step 6): `send_message` as a row with its card and a delivery suffix (`read mid-turn`, `queued`, `started a turn`, `answered its question`; no "resumed it", the protocol has no such delivery); a letter in is `Letter` (`envelopeOf`: wrote / asks / started this session, tag on a question); control verbs are `control` rows (`controlOf`); `CheckpointRow` removed; a session's name opens its thread at the letter and `focus` now lights it (`showLetter`); a bot's name opens the conversation; "You wrote to X" note is one line. A letter in has no `read mid-turn` tag (the receiving block does not carry its delivery) |
| 25 | Answer a child from the parent | done (step 7): a session's question or approval letter carries its open request (`ChildAsk` in `Orchestration.tsx`, read with `useOpenAsk` from the child's thread, mounted once the child is `needs-input`): one single-choice question as chips, a longer form as `QuestionCard`, an approval as `ApprovalCard`; answered with `answer`/`respond` on the child; settled it says `Answered by you · the first answer counts` (who else answered is not in the protocol, so it says `Answered`); the `waits on an answer` tag goes once settled. An approval letter exists only when the parent could decide it itself (daemon rule), so a parent on ask autonomy shows no card, the child's thread has it. Also: `PeerMark` no longer draws a bot face for a session whose CLI is unknown (neutral terminal mark) |
| 26 | Removals | with each step |
| 27 | Design system | with each step |
| 9 (step 9) | Words and status | done (step 9): `ARCHITECTURE.md` gets the window's words (agent, work, thread, conversation) and no longer describes the chat bar's Paused line, the subagent tab or the child's chat; the other docs under `docs/` that describe the old UI are dated plans and are left as records. Not done: deleting `src/prototype/chat-redesign`. It is the user's uncommitted work in the main checkout, so it stays until they decide |
