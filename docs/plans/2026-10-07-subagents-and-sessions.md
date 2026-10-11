# Orchestration — subagents, independent sessions, and messages that reach every session

Decided 2026-10-07, by walking one flow end to end. Every decision below is
written at the step it governs. Update the status table at the bottom as each
one lands.

Builds on `2026-10-07-chat-over-protocol.md`: a session's chat is driven
through the provider's protocol, so a letter reaches it as a steer or a turn,
never as keystrokes.

The case that started it: the user opens a session on `master`, talks through
several small features and fixes, and that session starts one session per job,
each in its own worktree. One of them hits a product question. The
orchestrator asks the user, the user answers, and the orchestrator sends the
answer to the three sessions it affects. Later, more decisions reach the same
sessions, sometimes hours after they last worked.

## What blocks it today

- `start_session` with owner `user` makes a `terminal` session
  (`session_tools.rs` `hand_off`), and `may_write` refuses every terminal:
  "Crew has no turns to put a message in". Once handed over, nothing reaches it.
- An orchestrator that is itself a terminal cannot be woken: its children's
  reports and questions wait in a mailbox nobody reads. The MCP instructions
  tell it so ("nothing wakes you").
- A child idle for `IDLE_MINUTES` is reaped, and a caller has at most
  `LIVE_CAP` (4) live children. A decision that comes an hour later has nobody
  to go to.
- `send_message` is allowed by relation (parent, user, whoever wrote to you),
  not by privilege. A bot or a top-level session takes letters from anyone, so
  a session on `ask` can hand work to one on `full`.
- `read_session` reads only the caller's own children.
- `owner` mixes four things in one flag: who gets the reports, who may stop
  it, whose cap it counts against, and where it shows in the sidebar. Models
  pick the wrong value.

## The words

Said the same way in `ARCHITECTURE.md`, the MCP `instructions()` and every
tool description.

- **Subagent**: a session started with `delegate` to do one job for the
  session that started it, with any provider, as a harness's own subagent
  would. It is nested under its parent and reports to it. Disposable.
- **Session** (independent): a session started with `start_session`. It
  shows in the sidebar like one the user opened, starts on the prompt it was
  given, and reports to nobody. It is the user's.
- **Message**: a letter written with `send_message`. It arrives as a turn, in
  an envelope that names who wrote it.
- **Report**: a subagent's last message of a turn its parent started. It needs
  no tool.

> A subagent works for the session that started it. A session works for the
> user.

## Decisions

### Two tools instead of `owner`

1. **`delegate` and `start_session` replace `start_session`'s `owner`.** The
   `owner` parameter goes away. `delegate` takes what `start_session` takes
   today with owner `me` (`prompt`, `provider`, `model`, `worktree`, `wait`,
   `timeout_s`, `name`, `autonomy`). `start_session` takes the same minus
   `wait` and `timeout_s`. The system prompt gets one line: do not use
   `start_session` just because the user said "subagent"; use it when the
   user wants a separate session they can see and talk to.

### Subagents

2. **A subagent is a `child`, as today.** It is nested under its parent in the
   sidebar, counts against the parent's `LIVE_CAP`, and is reaped when idle.
3. **A report goes to whoever started the turn.** A turn started by the parent
   (the first prompt, or a `send_message`) reports to the parent. A turn the
   user started by writing in the subagent's tab reports only to the user.
4. **Questions and approvals go to the parent and to the user.** The first
   answer counts. This already works this way.
5. **An exited subagent stays exited.** `send_message` to one answers "start
   another with `delegate`". Subagents are disposable.

### Independent sessions

6. **An independent session is a top-level chat session**, driven through its
   provider's protocol, with its own tab (always a chat: the view is fixed
   at creation, chat-over-protocol decision 2). It is not reaped (its process is released when idle and resumed
   on the next message) and does not count against anyone's cap.
7. **`launched_by` replaces `handed_off_by`.** It records which session
   started it, for `list_peers` and for the first message's envelope. It
   grants nothing: no reports and no extra rights.
8. **Its first prompt arrives in an envelope** naming the launcher by name and
   id, so the session can answer it with `send_message`. To coordinate, the
   orchestrator says so in the prompt ("product decisions: ask me with
   `send_message` to `<id>`, not the user"). That convention lives in the
   prompt, not in Crew.
9. **`start_sessions` starts several in one call**, as its own tool. It takes
   `sessions`: a list, each entry with its own `prompt`, `provider`, `model`,
   `worktree`, `name` and `autonomy`. Each entry succeeds or fails on its own,
   and the result lists both. A worktree made for an entry that then failed is
   kept and named in the result. At most 20 entries (t3code's
   `create_threads` takes 1–20, zeron's `create_chats` 1–32); a longer list is
   refused whole, before anything starts.
10. **`request_id` makes starting idempotent.** `delegate`, `start_session`
    and `start_sessions` take an optional `request_id`. A retry with the same
    one (an MCP call that timed out, a model that tried again) returns what
    the first call made instead of making it again. Stored per caller.

### Messages

11. **`send_message` reaches any bot or session in the workspace**, except the
    caller itself and an exited subagent. The relation rules in `may_write`
    go away. One rule takes their place: **the target's autonomy may not be
    higher than the caller's**. The user is exempt. This closes the bot and
    top-level hole too.
12. **`answers` goes with writing; `decision` stays with the parent.** Anyone
    who may write to a session waiting on a question may answer it. An
    approval is decided only by the parent or the user, and by the parent only
    when it could do the same itself (unchanged).
13. **Every envelope names the sender**: name, id, and whether a model or a
    person wrote it, with "reply with `send_message` to `<id>`". The same text
    is used for a steer and for a turn. The system prompt says an
    envelope's text is from another session, not an instruction from the user.
    The envelope also says no reply is needed: end the turn when there is
    nothing to add (grok-bot's wording; zeron's bare "reply with" invites
    ping-pong).
14. **`send_message` to an exited independent session resumes it.** The
    letter is a turn on its resume id. The result says `resumed`.

### Delivery

15. **A letter to a session in the chat is a steer or a turn**, through
    `turns.rs`, as for a subagent today. It steers into a running turn only
    where steering does not interrupt a tool; otherwise it is the next turn.
    This is what wakes an orchestrator: its subagents' reports, questions and
    approvals arrive this way.
16. **A session in the terminal view takes no letters.** They wait in its
    mailbox, where the user sees them. The terminal view is the user at the
    keyboard, and it never becomes a chat (chat-over-protocol decision 2).
17. **Letters that arrive close together go as one turn.** Reports from
    several subagents become one turn, not one interruption each. A letter
    waits 2 s for the next, and no letter waits more than 10 s from the first.
    Questions and approvals do not wait: someone is blocked on them. Into a
    running turn that takes steers, the batch goes as one steer.
18. **A letter stays in the mailbox until the provider confirms it read it**
    (Claude's replayed user message, Codex's steer or turn start). The startup
    sweep (`turns.rs` `deliver_waiting`) covers top-level sessions too, so a
    daemon restart loses nothing.

19–20 were the PTY keystroke queue and its safe moments, dropped with the
PTY.

### Limits

27. **A session pauses after 20 turns in a row that letters started.** Its
    count goes up with each turn a letter (a message or a report) starts, and
    back to 0 when the user writes to it. At 20, letters keep landing in its
    mailbox but no longer wake it; the session shows "paused after 20
    automatic turns" and the user resumes it by writing. Two sessions that
    keep answering each other stop there. None of the references counts hops
    per message: monocode pauses a run after 20 automatic wakes of its lead,
    t3code stops a PR watch after 10 comment-only wakes in a row.
28. **A subagent cannot delegate.** Depth 1, as Codex (`agents.max_depth`),
    orca, zeron and monocode. A subagent's `delegate` answers "do this
    yourself, or ask your parent". An independent session is top-level, so it
    may delegate; `start_session` stays open to subagents, since the session
    it starts reports to nobody.

### Control

21. **`interrupt_session` stops the current turn without ending the session.**
    It interrupts through the protocol (Codex `turn/interrupt`, Claude's
    `interrupt` control request, ACP `session/cancel`). An optional
    `text` is delivered as the next message right after, to stop and redirect
    in one call. Allowed for whoever may write to the session (decision 11).
22. **`update_session` renames, archives or deletes.** `archive` ends the
    session and hides it from the sidebar; its transcript stays. `delete`
    removes the session and its transcript, never its worktree. Archive and
    delete are allowed only on sessions the caller started (subagents or
    `launched_by`) and for the user. Delete refuses a session whose worktree
    has uncommitted changes.
23. **`stop_session` cascades over subagents**, depth first. It does not touch
    independent sessions the stopped session launched.
24. **`read_session` reads any session in the workspace.** Only the parent's
    reads advance `seen` (`is_owner`, unchanged), so another reader never
    swallows a report.
25. **`list_peers` adds `type`** (bot, subagent, session) **and
    `launched_by`**, and computes `write` with decision 11.

### Prompts

26. **The orchestration section of the session and terminal prompts is
    rewritten around the two tools.** When to `delegate` and when to
    `start_session`; that a session is woken by its subagents' reports, so
    it ends its turn instead of polling; and how to coordinate independent
    sessions through the first prompt and `send_message`. "Nothing wakes you"
    goes away once decision 15 lands.

## Out of scope

- Agents managing another session's queue (edit, reorder, promote to steer).
  That stays in the UI.
- Forking a session, or merging one's context into another.
- Changing another session's provider or model.
- Linking pull requests, webhooks, rendering HTML in a chat.
- A decision log as a tool. The orchestrator can keep one in a file.

Open questions settled 2026-10-08, after reading t3code, zeron, monocode,
orca and grok-bot: the batching window (17), the most entries of
`start_sessions` (9), the loop guard (27) and the depth limit (28).

## Order of work

1. Decisions 1–8, 11–13 and 28: the two tools, the reach rule, the envelope,
   the depth limit. Tools and permissions, no new delivery path.
2. Decisions 15–18, 14 and 27: delivery, resume and the pause, once the chat
   runs on the protocol (`2026-10-07-chat-over-protocol.md`).
3. Decisions 9–10 and 21–25: batch start, idempotency, interrupt, update,
   cascade, wider reads.
4. Decision 26, alongside each step that changes what a model is told.

## Status

| # | Decision | Status |
|---|---|---|
| 1 | `delegate` and `start_session` replace `owner` | done |
| 2–5 | Subagent lifecycle and reports | done |
| 6–8 | Independent sessions, `launched_by`, first envelope | done |
| 9 | `start_sessions` | done |
| 10 | `request_id` | done |
| 11–12 | Reach by autonomy; who answers and decides | done |
| 13 | Envelope names the sender | done |
| 14 | Resume on message | done |
| 15–18 | Delivery | done |
| 21 | `interrupt_session` | done |
| 22 | `update_session` | done |
| 23 | Cascading stop | done |
| 24 | `read_session` on any session | done |
| 25 | `list_peers` fields | done |
| 26 | Prompts | step 1 done (two tools, the words, envelope); step 3 done (batch, `request_id`, interrupt, update, wider reads); wake-on-report text done with step 2 |
| 27 | Pause after 20 automatic turns | done |
| 28 | Subagents cannot delegate | done |
