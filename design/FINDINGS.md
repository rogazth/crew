# Findings from running the real thing

Not opinions. Everything below was measured by booting `crates/crewd`, talking to
it over its own WebSocket, and driving a real provider through a real turn.

Reproduce with:

```bash
node design/tools/daemon-probe.mjs          # every method the UI calls
node design/tools/agent-probe.mjs --raw     # a real turn that creates an agent
```

---

## 1. The backend is reachable from a plain browser page

`crewd` binds `127.0.0.1` on a random port, prints `{"url","token"}` on stdout, and
authenticates with that token as the socket's first message. There is no origin check
and no Electron dependency in the protocol.

**Result: 15 of 15 methods the UI depends on answered from a plain WebSocket client.**

```
✓ workspace_list        ✓ session_create      ✓ routine_upsert
✓ workspace_create      ✓ transcript_tail     ✓ routine_list
✓ workspace_delete      ✓ session_rename      ✓ messages_search
✓ session_list          ✓ session_set_status  ✓ list_project_files
✓ session_delete        ✓ state_set/get       ✓ read_text_file
```

So a prototype can run against live data without Electron and without touching `src/`.
`design/shared/src/live/` is that client, and `design/tools/vite-crewd.ts` is the dev
server plugin that starts the daemon and hands the page its url and token.

**Gotcha worth keeping:** `crewd` treats EOF on stdin as "my parent is gone" and exits.
Spawn it with `stdio: ["pipe", …]` and hold the pipe open, or it dies a millisecond
after the handshake. `stdio: "ignore"` looks correct and is not.

## 2. Every Crew tool renders badly, and the fix is already on the wire

This is the `{` the user complained about, in its real form.

`crew_tool_detail` in `crates/crew-core/src/providers/mod.rs` normalises exactly one
Crew tool — `message_agent` — and only when the provider calls it directly. Everything
else arrives as `ToolDetail::Output` carrying the raw JSON result.

Captured from a real opencode turn:

| Row's `name` | `detail.kind` | What the row showed |
| --- | --- | --- |
| `crew_list_agents` | `output` | a JSON array of the roster |
| `crew_find_tool` | `output` | a JSON tool schema |
| `crew_call_tool` | `output` | `{"id":"600cbf85…","name":"reviewer",…}` |
| `crew_call_tool` | `output` | `{"delivered":true,"to":"reviewer","waiting":0}` |

Four rows; the two that matter are *an agent being created* and *a letter being sent*,
and both read as JSON.

**The good news:** the result JSON contains everything a good row needs, and more than
the arguments would.

- `create_agent` answers with `{id, name, provider, model, autonomy, status}` — enough
  for "Created reviewer · opencode Ling 3.0 Flash" **and** a link to the new agent.
- `message_agent` answers with `{delivered, to, waiting}` — `waiting` is the depth of
  the target's mailbox, which the UI has never shown and obviously should.

`design/shared/src/crewTools.ts` parses that, and the same four rows now read:

```
Crew list agents             → Looked at the roster
Crew find tool create agent  → Looked for a tool
Crew call tool create_agent  → Created reviewer   [opencode ling-3.0-flash]
Crew call tool message_agent → Wrote to reviewer  [→ reviewer]
```

No daemon change required. A daemon change would still be better — see §3.

## 3. A letter routed through `call_tool` loses its identity

`crew_tool_detail` matches on the **outer** tool name. When a provider reaches
`message_agent` through the gateway — which opencode does, and which the gateway exists
to encourage — the outer name is `call_tool`, the match fails, and the call never
becomes `ToolDetail::Message`.

Consequence: **the sender's half of an agent conversation disappears** whenever the
provider uses the gateway. The receiver still gets its `fromAgent` turn, so the
conversation exists in one transcript and not the other.

The renderer can recover it from the result (and `crewTools.ts` does), but the honest
fix is four lines of Rust:

```rust
pub fn crew_tool_detail(name: &str, input: &Map<String, Value>) -> Option<ToolDetail> {
    let verb = crew_tool(name)?;
    // `call_tool` is a gateway, not a tool: the row must read as what it ran.
    let (verb, input) = if verb == "call_tool" {
        let inner = input.get("name")?.as_str()?;
        let args = input.get("arguments").and_then(Value::as_object);
        (inner, args.unwrap_or(input))
    } else {
        (verb, input)
    };
    match verb {
        "message_agent" => Some(ToolDetail::Message { … }),
        "create_agent"  => Some(ToolDetail::Agent { … }),   // new variant
        _ => None,
    }
}
```

## 3b. `Session` carries no `created_by` on the wire

Measured with `tools/crew-test.mjs`: a lead agent created three agents in 26 seconds,
`session-created` fired for each, and each child's transcript opened with
`Created by lead`. Then `session_list` came back and **every one of them was a root**:

```
— sessions —
  lead       16 blocks  done   (root)
  frontend    3 blocks  done   (root)     ← created by lead, 12 seconds earlier
  backend     3 blocks  done   (root)
  tests       3 blocks  done   (root)
```

`crew_protocol::Session` has `id, workspace_id, kind, name, provider, model,
provider_session_id, description, notifications, autonomy, status, created_at,
updated_at` — and no `created_by`. The store records the relationship; the wire type
drops it.

So the renderer *cannot* draw the lineage, cannot put "created by X" in a header, and
cannot group a sidebar by who spawned whom. The only trace that survives is a sentence
in the child's transcript, which is exactly why the feature reads as a patch — it is
one, and it is a patch around a missing field rather than around a missing design.

One field on the wire type unlocks all of it. `design/shared/src/types.ts` carries it as
`createdBy?: AgentRef | null` and `lineage()` builds the tree from it.

## 3c. `full` autonomy is not confined to the workspace

Worth knowing before anyone leans on it. The first team run was given an open-ended
brief and `autonomy: "full"`, with `cwd` pointing at an empty temp directory. The agents
left it: they read the host repository, walked `crates/` and `src/`, ran
`npm run test` and `cargo test --workspace`, and wrote a whole TypeScript service into
another temp directory.

Nothing was damaged — the repo's working tree was untouched, and the second run with a
scoped brief stayed put — but `full` autonomy means "runs tools without asking", not
"runs tools inside this folder". That is a product decision worth making explicitly, and
worth saying in the agent sheet where the switch lives: today its description reads
"Tools run without asking. Off means every edit and command waits for Allow", which does
not hint that the blast radius is the machine.

## 4. "Created by" is a system note, not a field

When an agent creates another, the child's transcript opens with:

```
system   Created by lead
user     [from lead] Welcome! Your first task is to review…
system   opencode decides its own permissions: it has no way to ask Crew, so it
         runs under your own autonomy setting.
```

So the attribution the user called "a patch" really is one: it is a grey line of prose
in the transcript, indistinguishable from any other note, and it is the **first thing**
anyone sees when opening a spawned agent.

All three prototypes should promote it to a real header — who made this agent, when, and
a link to them — and keep the provider's own warnings as notes.

## 5. The event stream is complete and ordered

One real turn emitted, in order:

```
user.message · session.started · session.providerBound · tool.started ·
tool.updated · system.message · message.delta · message.completed · turn.completed
```

plus `session-created` when the agent made another one, and `session-status`
(`working → done`). `transcript-apply` carries a monotonic `seq` alongside
`transcript_tail`'s own `seq`, which is what lets a client apply live events on top of a
page that was in flight. `design/shared/src/live/source.ts` does exactly that.

Turn latency on a free opencode model, for a turn that made two tool calls: **10s**.

## 5b. The agent-network model holds up on real data

`tools/crew-test.mjs` runs a real team and then feeds every transcript the daemon
produced through `rosterFrom` / `letters` / `mailbox` / `graph` / `lineage` — the same
functions the prototypes render. On a clean run:

```
— letters (3) —
  lead → frontend   delivered   You own all frontend work. When blocked, ask the lead…
  lead → backend    delivered   You own all backend work. When blocked, ask the lead…
  lead → tests      delivered   You own all testing work. When blocked, ask the lead…

— graph —
  lead → frontend: 1 (waiting 0)
  lead → backend: 1 (waiting 0)
  lead → tests: 1 (waiting 0)

— every tool row, as a prototype would show it —
  ✓ lead  crew_list_agents   Looked at the roster
  ✓ lead  crew_find_tool     Looked for a tool
  ✓ lead  crew_call_tool     Created frontend  [opencode Ling 3.0 Flash]
  ✓ lead  crew_call_tool     Created backend   [opencode Ling 3.0 Flash]
  ✓ lead  crew_call_tool     Created tests     [opencode Ling 3.0 Flash]
```

Every letter paired to its delivery, every row a sentence. The one thing it gets wrong
is the lineage, and only because §3b means the data never arrives.

Three agents, created and briefed, in 26 seconds on a free model.

## 6. Agent spawning works, and nothing in the UI shows the shape it makes

The run produced a two-level tree in one turn. The store records `created_by`, the
daemon emits `session-created`, and the sidebar renders a flat list either way.

`design/shared/src/agents.ts` builds the model the UI is missing:

- `lineage()` — the creation tree. The demo fixtures now go four levels deep.
- `letters()` — every message, counted once, by pairing the sender's outbound call with
  the receiver's inbound turn.
- `mailbox()` — what is still queued for a busy agent, which is the daemon's own
  `waiting()` and has never had a pixel in the UI.
- `graph()` — who writes to whom, how often, and how much is stuck.

---

## What each prototype must do with this

1. Render `#/session/s-lead` and `#/session/s-reviewer`. Those two fixtures are the
   captured run, unedited. If they read badly, the design has not solved the real case.
2. Use `toolLine(block, resolveAgentName)` — the second argument turns agent ids into
   names.
3. Show `mailbox()` somewhere. An agent with three letters queued behind a long turn is
   the most common confusing state in a multi-agent workspace.
4. Promote "Created by X" out of the notes and into the chrome.
