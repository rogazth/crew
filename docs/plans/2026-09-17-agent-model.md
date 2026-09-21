# Agent model — creation, addressing, the turn prompt

Decided 2026-09-17, by walking one flow end to end: an agent creates another
agent and hands it work. Every decision below is written at the step it governs.
Update the status table at the bottom as each one lands.

The three failures that started it, from a real run:

1. An agent wrote to itself when it meant to write to the agent it had just
   created, and nobody could tell the two apart — `to` took either.
2. The agent that was given the work answered in its own chat. The sender never
   heard back and had no way to know it was still waiting.
3. Poked about it, the sender went looking with `Bash`, found `crew.sqlite3`
   and read the other agent's transcript row by row.

## The shape of it

The turn is uniform. Every turn opens a clean provider session, so it needs the
same context whoever wrote it — what was said recently, and what tools reach
the other agents. A letter from an agent and a message from the user differ by
one field inside that prompt, not by the prompt's shape.

Nothing forces a reply. An agent may write to another and expect nothing back,
and the one who reads it may decide there is nothing to answer. The prompt
gives it enough to decide; it does not give it orders. Where a rule would only
make the common case tidier, the rule loses.

---

## The flow

### 1 · The user writes

`TurnHost::start` opens a fresh provider session. The persona goes on
`--append-system-prompt`, the transcript tail goes in the prompt, the CLI dies
when the turn ends. Nothing here changes.

### 2 · An agent calls `create_agent`

Anyone may create agents. No depth cap, no count cap — revisit once the core is
firm, not before.

**`autonomy` leaves the schema. The child inherits the caller's**
(`tools.rs:526` reads `caller.autonomy` instead of the argument). Autonomy
belongs to the agent, never to whoever called it: an `ask` agent can only
produce `ask` agents. Without this, an agent that may not run a command without
asking can build itself one that may.

The `description` is written by another model, and that is fine — see step 7
for the tool that lets an agent rewrite its own.

Creation leaves a trace on both sides:

| | creator's chat | child's chat |
| --- | --- | --- |
| `create_agent` | `Created agent Scout (7b2e…)` — new | `Created by Crew` — exists, `tools.rs:542` |

### 3 · It hands over the work

Two tools, because there are two intentions and one of them is not addressed
to anybody:

- **`message_agent { to, text }`** — `to` is a **session uuid**
  (`session.rs:118`), never a name. Names belong to the UI and change when the
  user renames an agent; ids do not. `find_agent` stops matching on name
  (`tools.rs:394`), and `to == caller.id` is refused, pointing at the other tool.
- **`continue_after_turn { text }`** — no recipient, so it cannot be aimed
  wrong. Same mailbox underneath, same `drain_mailbox`, same 25-lap cap
  (`turns.rs:58`).

`list_agents` stays the way to discover ids; it already answers with both
(`tools.rs:374`).

### 4 · The sender's turn ends

`set_status(done)` → flush → `drain_mailbox`. **No `awaiting` state.** A message
that needed no reply leaves nothing hanging, and a sender is reactivated by the
letter coming back, not by a flag. A new status to set, clear, expire and paint
buys nothing the letter does not already do.

### 5 · The other agent wakes

The prompt has the same shape whoever wrote it:

```
persona     who it is, today's date, the tools it has
tail        one chronological stream, every line stamped:
            [2026-09-16 14:32 · Crew 4a1f2b8c-…]
            [2026-09-17 09:10 · user]
            [· you]
message     From: <name> (<uuid>) · <time> · body
```

The full date, not just the time: the persona already says what day it is
(`providers/mod.rs:42`), so "yesterday" resolves against it and turns into
`search_messages { days: 2 }`. Stamped flat per line rather than grouped under
a day heading, because `render()` walks backwards and drops whole blocks
(`working_set.rs:27`) — a heading would be orphaned by the truncation.

A sender that has since been deleted reads `(agent, no longer exists)` with no
id (`mailbox.rs:92`, `ON DELETE SET NULL`). That letter is not one you answer.

### 6 · It works

A turn born from a letter runs with **its own** autonomy, never the sender's.
Under `ask`, every command raises an approval that waits on the user in the
child's chat with `needs-input` (`turns.rs:1290`). Approvals are never routed
to the sender: an agent approving another agent's commands is how autonomy
stops meaning anything.

Status dots stop overloading one colour:

```
working      amber spinner    unchanged
needs-input  amber dot        was blue
done         blue dot         unchanged
error        red dot          unchanged
idle         nothing          unchanged
```

`working` and `needs-input` share the hue and differ in shape: both mean
something is happening here, and the still one is the one waiting on you.

### 7 · It finishes

Nothing routes the reply and nothing checks for one. The agent decides.

An agent may rewrite its own persona with **`update_description { text }`**,
which is what step 5 will read next turn (`providers/mod.rs:47`). Description
only: `name`, `model` and `autonomy` stay the user's, because autonomy is not
self-granted. It leaves `Description updated by itself` in the chat.

### 8 · The letter comes back

The sender is `done`, not `working`, so `start` takes it (`turns.rs:294`). It
wakes with the letter and, this time, with a tail. Nothing to decide.

### 9 · If it never came

`search_messages` searches **only the caller's own transcript**. `agent_id`
leaves the schema. The transcript is the only memory an agent has
(`working_set.rs:3`) and the mailbox is the only channel between agents; a
workspace-wide search is a second channel, silent and read-only, that shows up
in no chat. What another agent knows is asked for, not looked up.

No fence around the data directory. While the app's data lives on the same disk
as the model, an agent with a shell can read it; `search_messages` competes by
being the shortest path, not by being the only one. A deny rule on that path
would cost a permissions system before the core is firm, and would not hold
under `--dangerously-skip-permissions` anyway (`providers/claude.rs:35`).

The desirable path when the user asks "did it answer you?" is that the agent
messages it again for an update. If it decides otherwise, that is a next
iteration, not a rule.

### 10 · One token per session

`CREW_TOKEN` is one token for the whole daemon, handed to every agent process
(`turns.rs:536`), and the caller identity is whatever session id arrives on the
request (`tools.rs:1301`). So any agent's shell can act as any session.

With step 2 in place that is an escalation, not just impersonation: a `full`
agent's id named on the wire makes `create_agent` mint a `full` child, and the
caller messages it to run what it could not run itself.

**A token per session, minted when the turn starts.** The bridge maps token →
session id and ignores the id on the request. This is also what makes the
shell path honest for Cursor, which has no MCP and reaches the bridge through
`crew call`.

---

## Decisions

| # | Step | Decision |
| --- | --- | --- |
| 1 | create | Anyone creates. No depth or count cap yet. |
| 2 | create | `autonomy` out of the schema; the child inherits the caller's. |
| 3 | create | A trace in the creator's chat too. |
| 4 | address | `message_agent.to` is a session uuid. Names no longer resolve. |
| 5 | address | `continue_after_turn { text }` replaces writing to yourself. |
| 6 | address | The envelope and the tail carry the sender's uuid. |
| 7 | wait | No `awaiting` state. |
| 8 | prompt | One turn shape for every sender. |
| 9 | prompt | Every tail line stamped with date and time. |
| 10 | approve | Approvals belong to the agent's own autonomy, and to the user. |
| 11 | ui | `needs-input` gets its own colour. |
| 12 | reply | Nothing forces a reply. |
| 13 | persona | `update_description { text }`, self only, traced. |
| 14 | search | `search_messages` covers the caller's transcript only. |
| 15 | fence | No fence around the data directory. |
| 16 | identity | One token per session, minted per turn. |

## The work

| Area | Files |
| --- | --- |
| Tools 2, 5, 13, 14 | `crates/crew-core/src/tools.rs` — catalogue, `create_agent`, `message_agent`, `search_messages`, two new handlers |
| Addressing 4, 6 | `tools.rs` (`find_agent`), `crates/crew-core/src/mailbox.rs` (`envelope`) |
| Prompt 8, 9 | `crates/crew-core/src/working_set.rs` (`line`), `crates/crew-core/src/providers/mod.rs` |
| Tool sheet 12 | `crates/crew-core/src/turns.rs` (`tools_hint`) — three of its claims are now false |
| Traces 3, 13 | `tools.rs`, `crates/crew-core/src/transcript.rs` |
| UI 11 | `src/chrome/StatusDot.tsx` |
| Identity 16 | `crates/crew-core/src/bridge.rs`, `turns.rs` (`agent_env`), `crates/crew-core/src/mcp.rs` |

`tools_hint` (`turns.rs:69`) has to be rewritten whatever else happens: it still
tells an agent that writing to itself is how it carries on, that a letter is
answered at the **name** on that line, and that `search_messages` reaches what
anyone said. All three are now wrong, and an agent that follows it spends a call
on a refusal.

## Open

- **Roster visibility.** `list_agents` still answers with every agent's name,
  description, model and status. Decision 14 fenced message content but not the
  roster; nobody has argued either way.
- **Caps on creation.** Deferred at step 2, not dismissed.

Settled while building: the tool sheet is one line per tool, not a paragraph.
The paragraph was what got skimmed.

## Status

All sixteen landed on 2026-09-17.

| # | Decision | Where |
| --- | --- | --- |
| 1–3 | creation: no caps, inherited autonomy, creator trace | `tools.rs` |
| 4–6 | addressing by uuid, `continue_after_turn`, id in the envelope | `tools.rs`, `mailbox.rs` |
| 7 | no `awaiting` | nothing to build |
| 8–9 | uniform turn prompt, stamped tail | `working_set.rs`, `store.rs`, `TurnStart.sent_at` |
| 10 | approvals unchanged | nothing to build |
| 11 | `needs-input` dot | `StatusDot.tsx` |
| 12 | no forced reply; the tool sheet rewritten | `turns.rs` |
| 13 | `update_description` | `tools.rs` |
| 14 | `search_messages` scoped to self | `tools.rs` |
| 15 | no fence | nothing to build |
| 16 | token per session | `bridge.rs`, `mcp.rs`, `turns.rs` |

Seen working, not only tested: `PROVIDER=claude node scripts/drive.mjs` has the
agent call `list_agents`, address the id it finds, and the letter arrive with
the sender on it; `SCENARIO=loop` has it leave itself a note and pick the work
back up in a second turn.

Two things the build turned up that the walk had not:

- `bridge_info` was an RPC nobody called whose only payload was the
  daemon-wide token. Removed with it.
- A session that is deleted has its token revoked, or its process keeps a
  working credential for an agent that no longer exists.
