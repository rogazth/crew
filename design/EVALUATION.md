# How to judge the three

A rubric, so the choice is made on evidence rather than on which screenshot happened to
be prettiest. Score each prototype 1–5 per row. The weights say what actually matters
for an app someone stares at for eight hours.

| # | Criterion | Weight | What a 5 looks like |
| --- | --- | --- | --- |
| 1 | **Coherence** | ×3 | Nothing in the window looks like it came from a different app. Every raised thing agrees about how raised it is. |
| 2 | **The transcript** | ×3 | A long run of tool calls is scannable in two seconds. A markdown answer with a table and a diff reads well. Nothing jitters while streaming. |
| 3 | **Agent-to-agent** | ×2 | Grouped, avatar-led, opens a real thread, and reads as a conversation rather than a folded tool call. |
| 4 | **Density vs air** | ×2 | The sidebar holds a real workspace's worth of sessions without becoming a wall, and the chat still breathes. |
| 5 | **Icons** | ×2 | One set, one weight, one grid. Never two sets in one row. |
| 6 | **Status & motion** | ×2 | You can tell at a glance which agents are busy, which want you, which are done. Exactly one thing moves per busy agent. No spinners. |
| 7 | **Keyboard** | ×2 | Every binding fires. Focus is always visible. The palette is as fast as the one we have. |
| 8 | **Dark mode** | ×1 | Not an inverted light mode. Shadows and hairlines still do their job. |
| 9 | **Token portability** | ×2 | `TOKENS.md` could be pasted into the app on Monday and the rules would survive contact with a new component. |
| 10 | **Settings & routines** | ×1 | The two screens the user already likes are at least as good as today. |

## Non-negotiables — a prototype that fails one of these is out

- No tool row that reads `{` or shows raw JSON.
- No spinner anywhere, including the sidebar.
- Light and dark both correct, with no hard-coded colours in components.
- The `s-daemon` thread (a 30-call run) stays smooth.
- Every surface in `INVENTORY.md` reachable.

## The three questions the prototypes exist to answer

1. **Flat or raised?** Ink says remove the relief; Canvas says give it to everything from
   one scale; Console says separation is a rule and a tone step, never a shadow. Only one
   of these should survive, and the choice decides half the remaining decisions.
2. **Bubbles or log?** Console's transcript is an aligned two-column log; Ink keeps a
   bubble for you and a bare rail for the agent; Canvas puts both sides in bubbles and
   breaks widgets out into cards. This is the single biggest read-experience fork.
3. **Are agents identities?** Canvas says yes — faces, hues, threads, a network page.
   Ink and Console treat them as rows. The answer changes the sidebar, the tab bar, the
   transcript and the messaging design at once.

A good outcome is not "pick one". It is: pick a spine from one, and name the two or
three things worth stealing from the others.

## Running the comparison

```bash
cd design/proto-ink && npm run dev      # 5181
cd design/proto-console && npm run dev  # 5182
cd design/proto-canvas && npm run dev   # 5183

node design/tools/shoot.mjs --all       # PNGs into each prototype's shots/
```

Open the same route in all three at once, in this order:

1. `#/session/s-harness` — the long conversation, every block kind, date breaks.
2. `#/session/s-daemon` — the 30-call run. Does folding hold up?
3. `#/session/s-relay` — agent-to-agent traffic.
4. `#/session/s-triage` — empty state, centred composer.
5. `#/session/s-scribe` — a failed run.
6. `⌘K` — the palette, against the one in the app today.
7. `#/settings/appearance` and `#/routines` — the two screens that already work.
8. Toggle dark on each, on the same route, without reloading.
