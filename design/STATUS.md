# Where this got to

Written as the work happened. Newest first.

## The short version

Three prototypes exist, all three build clean and pass a browser walk of every surface
in both themes. Underneath them is a shared layer with 154 tests that also speaks the
real daemon — which I booted, drove with a real provider, and used to find four bugs in
the app that have nothing to do with which design wins.

Read `EVALUATION.md` for how to judge the three, `FINDINGS.md` for what the daemon
runs turned up, `PROPOSAL.md` for what to change in the app.

## Verified, not claimed

| Check | Result |
| --- | --- |
| `node tools/check-all.mjs --fast` | shared typecheck + 154 tests, and tsc + build for all three: clean |
| `node tools/smoke.mjs` | 13 routes × 2 themes × 3 prototypes: no console errors, no empty roots |
| `node tools/daemon-probe.mjs` | 15 of 15 daemon methods answer from a plain WebSocket |
| `node tools/agent-probe.mjs` | a real turn where an agent creates an agent and writes to it |
| `node tools/crew-test.mjs` | a real team of 3 built and briefed in 26s; every letter paired, every tool row a sentence |
| `design/live-check` | the live `DataSource` scores 10/10 in a browser against a real `crewd` |
| `node tools/live-smoke.mjs --all` | all three render real daemon data with `?source=live`, no console errors |
| `node tools/stress.mjs --all` | 400 sessions, 5000-block transcripts, 20k files: all three hold 60fps |

### The stress numbers, `--preset heavy`

A 5000-block transcript, a 400-row sidebar, a 20k-file palette.

| | scroll p50 / p95 | nodes on the 5000-block thread | peak heap | worst long task | warnings |
| --- | --- | --- | --- | --- | --- |
| **Canvas** | 17 / 18ms | **1 104** | 72 MB | 131ms | **none** |
| **Console** | 17 / 18ms | 4 763 | 56 MB | 313ms | 4 scenarios |
| **Ink** | 17 / 21ms | 5 837 | 116 MB | 264ms | 4 scenarios |

The surprise is that **the heaviest-looking design is the one that scales**. Canvas
virtualises its transcript and sidebar; the other two render everything. All three still
scroll at 60fps, so this is a memory and first-paint difference, not a jank one — but at
400 sessions Ink's heap is twice Console's and five times its own at rest.

### And the ceiling, `--preset absurd`

1200 sessions, a 20 000-block transcript, 60 000 files. Not a realistic workspace — the
point is to find where each one stops coping.

| | scroll p50 / p95 | nodes | peak heap | worst long task |
| --- | --- | --- | --- | --- |
| **Ink** (after the fix below) | 17 / 18ms | 1 420 – 2 965 | 91 MB | 218ms |
| **Canvas** | 17 / 20ms | 1 370 – 4 102 | 123 MB | 318ms |
| **Console** | 17 / 21ms | 4 321 – 4 628 | 69 MB | 490ms |

Console barely moves between `heavy` and `absurd` — 56 MB to 69 MB, node count *down* —
which is what a virtualised log looks like when you multiply its input by four. Canvas
holds too.

**Ink failed this run, and then stopped failing.** Measured first:

```
stress-thread   nodes 14342   heap 109MB   frame p50/p95 17/33ms   long 676ms
search          nodes 15103   heap 282MB
```

A p95 of 33ms is a visible stutter and 282 MB for a window is not shippable. The cause
was not the transcript — Ink already windows that at 60 rows — it was the sidebar
rendering all 1200 sessions. Its own idiom applied to its own list fixed it: an 80-row
window that grows as the reader scrolls, and a dim "N more — keep scrolling" line.
`src/chrome/SessionList.tsx`, about twenty lines. Nodes fell 5×, heap 3×, the jank went
away, and the smoke and live runs still pass.

Worth keeping as a finding rather than quietly fixing: the design arguing hardest for
discipline was the one rendering every row, and nothing in the demo data would ever have
shown it.

Bundles: Console 669 kB, Canvas 874 kB, Ink 894 kB.
At rest — boot long task: Console 100ms, Canvas 132ms, Ink 175ms.
At rest — DOM nodes on the long thread: Ink 591, Canvas 2015, Console 2844.

## What the prototypes have

All three: the shell, workspaces, the session list with its preferences and
multi-select, tabs with every binding, the chat surface in full, the command palette,
search, the file editor, diffs, a faked terminal with find and zoom, routines with the
trigger control and run history, the agent sheet, settings, dialogs and menus. Hash
routes so every surface is addressable. A Demo menu that triggers streaming, approvals,
questions and inbound letters live.

Beyond the brief, and worth looking at:

- **Ink** surfaces the mailbox as a bar above the composer —
  *"2 letters waiting · delivered to harness when this turn ends"*.
- **Ink**'s agent thread reads *"3 messages with 3 agents"* with stacked monograms, and
  expands into a per-peer thread with an "Open renderer" link on each.
- **Canvas** puts the waiting count on the agent's avatar, a *"4 peers"* stack in the
  header, and renders `"Wrote to 2 agents · 6"` as a pill.
- **Console** is 200 kB smaller than either and has the lowest boot cost, which is the
  best evidence so far that its restraint argument is not just talk.

## What the daemon runs found

Four things in the app, none of them design-dependent. `FINDINGS.md` has the measurements
and `PROPOSAL.md` has the patches.

1. **Every Crew tool renders as a JSON blob.** `crew_tool_detail` normalises exactly one
   of eleven. The row for *an agent being created* reads as `{"id":"600cbf85",…}`.
   The fix needs no protocol change: the result JSON already holds the name, the
   provider, the model and the target's mailbox depth.
2. **A letter sent through `call_tool` loses its identity**, because the match is on the
   outer tool name. The sender's half of an agent conversation disappears whenever a
   provider uses the gateway — and the gateway exists to be used.
3. **`Session` has no `created_by` on the wire.** The store records it; the wire type
   drops it. Three agents created by a lead all came back as roots. This is why
   "created by X" is a grey line of prose in the transcript: it is the only place the
   fact survives.
4. **`full` autonomy is not confined to the workspace.** An agent with `full` and a
   `cwd` in an empty temp directory read the host repository and ran its test suite.
   Possibly intended; the copy on the switch does not say so.

## What is still moving

The three build agents ran out of session quota (resets 5:30am) partway through round 3.
They stopped at safe points — everything typechecks and builds — and they had already
landed both switches, so round 3 is essentially done. Since then I have been finishing it
myself:

- Verified live mode end to end in all three. Ink had two Base UI warnings — its menu and
  popover triggers asserted a native `<button>` while rendering a `<span>` — which its
  own agent could not fix, so I did. All three are now clean.
- Made `stressWorld` lazy. It was building 20k paths and 15k blocks in one synchronous
  burst on first read, which a performance trace was blaming on whatever rendered next.
  That is what the re-measured numbers above are measured against.
- Re-shot `proto-console`, which an earlier run caught mid-write.

- Windowed Ink's sidebar, which was the one real performance defect in the set. Numbers
  above.
- Ran `?stress=absurd` against all three and recorded the ceiling.
- Re-shot everything, including two new routes — the captured real daemon run, and each
  design at 400 sessions — into `shots.html`.

Open, in order of value:

1. `NOTES.md` is missing from proto-console; the other two have theirs.
2. Nobody has run the three side by side against a live daemon with real agents in it.
   Every part works; the combination has not been sat with.
3. `pathologicalMarkdown()` — the 400-character unbreakable tokens and six-level nesting
   — is in the fixtures but no prototype routes to it yet.
