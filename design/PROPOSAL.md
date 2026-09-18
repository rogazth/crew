# What to change in the app

Derived from `FINDINGS.md`, which was measured against a real `crewd` — not from
taste. Everything here is independent of which design direction wins, and every item
was implemented and verified in `design/shared` first.

Ordered by ratio of effect to cost.

---

## 1. Unwrap `call_tool` before deciding what a row is — 5 lines of Rust

**The bug.** `crew_tool_detail` in `crates/crew-core/src/providers/mod.rs` matches on the
outer tool name. A provider that reaches `message_agent` through the gateway — opencode
does, and the gateway exists to encourage that — presents the outer name as `call_tool`,
the match fails, and the call never becomes `ToolDetail::Message`.

**The effect.** The sender's half of an agent conversation disappears from the sender's
transcript. The receiver still gets its `fromAgent` turn, so the same conversation exists
in one place and not the other, and nothing joins them.

```rust
pub fn crew_tool_detail(name: &str, input: &Map<String, Value>) -> Option<ToolDetail> {
    let verb = crew_tool(name)?;
    // `call_tool` is a gateway, not a tool: the row must read as what it ran, or
    // a letter sent through the gateway is a letter nobody can see they sent.
    let (verb, input) = match verb {
        "call_tool" => (
            input.get("name")?.as_str()?,
            input.get("arguments").and_then(Value::as_object).unwrap_or(input),
        ),
        other => (other, input),
    };
    match verb {
        "message_agent" => Some(ToolDetail::Message {
            to: string_field(Some(input), "to")?,
            text: string_field(Some(input), "text").unwrap_or_default(),
        }),
        _ => None,
    }
}
```

Add a test alongside the existing prefix test: a `crew_call_tool` call whose
`arguments.to` is set must produce `ToolDetail::Message`.

## 2. Give Crew's own tools a detail — one new variant

There are eleven Crew tools. One of them normalises. The other ten are the most
interesting calls an agent makes — creating an agent, scheduling one, rewriting its own
standing orders — and all ten render as a JSON blob.

Add one variant to `ToolDetail` in `crates/crew-protocol/src/blocks.rs`:

```rust
/// A Crew tool acting on the workspace itself: an agent created, a routine
/// saved, a description rewritten. The provider's tools describe the repo; these
/// describe the crew, and a transcript that cannot tell them apart shows the
/// second as a blob of result JSON.
Crew {
    /// The bare Crew verb: `create_agent`, `upsert_routine`, …
    verb: String,
    /// What it acted on, when that is an agent: its id, so the row can link.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    subject_id: Option<String>,
    /// What it acted on, as a name the reader knows.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    subject: Option<String>,
    /// One line of specifics: `opencode ling-3.0-flash`, `every hour`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    note: Option<String>,
}
```

The daemon already has everything needed at the point where it returns the result — it
*is* the thing that created the agent. Filling this in is a match arm per verb in
`crew_tool_detail`, reading the tool's own return value.

**If you do not want a protocol change:** the result JSON is already sufficient, and
`design/shared/src/crewTools.ts` parses it today. It turns

```
Crew call tool create_agent   →  Created reviewer · opencode ling-3.0-flash
Crew call tool message_agent  →  Wrote to reviewer · 2 ahead
Crew list agents              →  Looked at the roster
```

with zero daemon changes. Port that file and the worst rows in the app become the best
ones this afternoon. The protocol change is still worth doing afterwards, because
parsing a result blob in the renderer is a workaround, not a design.

## 3. Never let a tool row print raw input

Whatever else happens, `toolLine` must not fall through to the provider's raw title:

```ts
const raw = (block.tool?.title ?? block.text).trim();
const readable = raw && !raw.startsWith("{") && !raw.startsWith("[") ? raw : null;
if (!detail) {
  return { text: readable ?? `Used ${humanName(block.tool?.name ?? "")}`, mono: false, failed };
}
```

Three lines. It is the difference between a row that says `{` and a row that says
"Used message agent". `design/shared/src/toolDetail.ts` has the full version.

## 4. Show the mailbox

The daemon has had a `mailbox` table with a `delivered_at` column since migration 11,
and `message_agent` already answers with `{"delivered": true, "to": …, "waiting": 0}`.
The renderer has never shown any of it.

The single most confusing state in a multi-agent workspace is "I told three agents to do
things and one of them is stuck behind a long turn". Today that is invisible. Surface it
in three places:

- The sidebar row for a busy agent: `2 queued`.
- The transcript of the sender: the letter row says how many were ahead of it.
- The receiving agent's header, when it opens: what is waiting to be handed to it.

`design/shared/src/agents.ts` has `mailbox(roster, sessionId)` built from the same data.

## 5. Put `created_by` on the wire, then promote it out of the transcript

**This one is blocking, and it is one field.** `sessions.created_by` is a column in the
store, but `crew_protocol::Session` does not carry it — so the renderer never receives
it. Measured: a lead agent created three agents, and `session_list` returned all four as
roots.

```rust
pub struct Session {
    // …
    /// The agent that created this one, when one did. Without it the renderer
    /// cannot say who made an agent except by reading a note out of its
    /// transcript, which is why the attribution reads as a patch today.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub created_by: Option<AgentRef>,
}
```

Then put it in the chrome rather than the transcript: the agent's header, its sidebar
row, its entry in the agent sheet. The system note can go.

`lineage(sessions)` in `design/shared/src/agents.ts` builds the creation tree from that
one field. A workspace where agents spawn agents is a tree rendered as a flat list
today; the fixtures go four levels deep to make the point.

## 5b. Say what `full` autonomy actually means

The switch in the agent sheet reads "Tools run without asking. Off means every edit and
command waits for Allow." Measured: an agent with `full` and a `cwd` pointing at an empty
temp directory read the whole host repository, ran its test suite, and wrote files
elsewhere on the machine.

That may be the intended behaviour — but the copy implies a permission model and says
nothing about a blast radius. Either confine tools to the workspace path, or say
plainly that `full` means the machine, not the folder. Right now a reader would guess
the first and get the second.

## 6. One icon set

`src/chrome/icons.tsx` (local SVGs, stroke 1.75, 24px grid) and `@phosphor-icons/react`
(its own weights and grid) are both in use, sometimes in the same row. That is the
"los iconos no me gustan nada" in one sentence: it is not that either set is bad, it is
that there are two.

Pick one, wrap it in a single `<Icon>` component, and delete the other. Each prototype's
`TOKENS.md` names its choice and its stroke weight.

## 7. Kill the spinner

`CircleNotchIcon … animate-spin` appears in `StatusDot`, `Activity` (three times),
`RoutineEditor` and `ThinkingLine`. A spinner means "this page has not finished
loading", which is not what an agent mid-turn is doing, and it is the one affordance the
user named as dated.

All three prototypes replace it, in three different ways — a breathing dot, a marching
bar in the gutter, a rotating ring on the avatar. Whichever wins, the rule is the same:
**exactly one thing moves per busy agent, and nothing else in the app spins.**

---

## What does not need to change

The daemon protocol is in good shape. Fifteen of fifteen methods answered from a plain
browser WebSocket, the event stream is ordered and complete, `transcript-apply` carries
a `seq` that composes correctly with `transcript_tail`, and a full turn against a free
model took ten seconds. None of the design work needed a protocol workaround except the
two items above.

The command palette, the settings content layout and the routine forms are the parts the
user already likes; all three prototypes keep their shape and change only their skin.
