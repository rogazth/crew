# Canvas — notes

What I decided, what I faked, and what I would do next. Read `TOKENS.md` for the token
contract; this file is the argument behind it.

---

## 1. The thesis

The complaint was "Kumo's buttons have a kind of relief, but the sidebar is flat". Ink
answers by removing the relief. Canvas answers by giving relief to **everything**, from
one five-rung ladder, and by treating the agents as people in the room rather than rows
in a list.

Two claims to judge it on:

1. **Systematic depth reads as craft, not clutter.** Every surface says what it is by
   how far it floats: `e1` rests, `e2` presses, `e3` floats and dismisses, `e4` owns the
   window. Nothing invents a sixth level and nothing stacks two.
2. **Faces make a multi-agent workspace legible.** Every agent has a generated avatar,
   in the sidebar, the tab, the transcript rail, the palette, the graph. Once you know a
   face you can find that agent in a 400-row list without reading.

## 2. Avatars — why `boring-avatars`

I tried all three.

| | bundle | licence | at 16px | dark mode |
| --- | --- | --- | --- | --- |
| `boring-avatars` | ~4 kB of the 80 kB package, one component, tree-shakes | MIT, no attribution | **reads** — `beam` is a face: two eyes, a mouth, a ground | controllable: I pass the palette |
| `@dicebear/core` + `@dicebear/collection` | 150 kB+ for core and the style you use; returns an SVG **string** | per-style, and several of the good styles are CC BY 4.0 — attribution in a desktop app | detailed styles turn to mush; `shapes`/`identicon` survive | it takes `backgroundColor` as **hex arrays**, which fights a token system |
| fixtures' `avatarSvg` | zero | ours | a dot with two eyes; distinguishable but not memorable | fine (it is already `oklch`) |

**Chosen: `boring-avatars`, variant `beam`.** Three reasons, in order:

- It takes a `colors` array, so the avatar is drawn from `identityFor(name).hues` through
  `avatarPalette(seed, dark)` — the faces sit inside the app's palette instead of beside
  it, and I ship a separate ramp for dark so nothing goes muddy. DiceBear wanted hex.
- MIT with no attribution clause. DiceBear's per-style licences are a real footgun for a
  shipped desktop app; the styles that are unambiguously free are also the least
  face-like.
- At 16px `beam` still reads as a face, which is the size that matters most: inline in a
  tool chip, in a tab, in a palette row.

It is behind `src/ui/Avatar.tsx`. Swapping generator is one file — `Avatar` also owns
the status ring, the mailbox badge and the size scale, and nothing else imports the
library.

## 3. What Canvas does that the current app does not

- **The status ring.** `working` is a gradient arc rotating on the agent's own face,
  once every two seconds. There is exactly one moving thing per busy agent and there are
  no spinners anywhere in the prototype. `needs-input` is a solid ring plus a badge —
  same hue, different shape, so it survives colour blindness and peripheral vision.
- **The sidebar's busy line.** Instead of a spinner, the row's own second line shimmers
  and reads `working…`. The row tells you, not an ornament next to it.
- **Agent-to-agent as a thread.** A run of letters folds into one avatar-led pill
  ("3 messages with scribe"); clicking opens the right drawer with *only* that
  two-agent conversation, their letters left and ours right, each one marked
  `delivered` or `waiting in the box`. The model is `conversationBetween()` from
  `@crew/fixtures` — the prototype does not scan blocks itself, so the sender's outbound
  tool call and the receiver's inbound turn are one letter, counted once.
- **The mailbox, shown.** `mailbox(roster, id)` puts a count badge on the agent's face
  in the sidebar, a `2 waiting` chip in the chat header, and a dashed edge in the
  network graph. An agent with three letters queued behind a long turn was invisible
  before; it is now the loudest thing about that agent.
- **Created-by as chrome.** The daemon writes the attribution as a grey system note at
  the top of a spawned agent's transcript. Canvas promotes it to a band under the
  header — both faces, who made whom, when, and a link to their thread — and filters
  that note out of the transcript so it is not said twice. Provider warnings stay notes.
- **The agent-network page** (`#/agents`): a directed graph with edge weight by letter
  count and dashed amber edges where something is queued, then the conversation list,
  then the lineage tree. Four levels deep in the fixtures.
- **Crew tools read as what they did.** The captured opencode run sends
  `crew_call_tool` with a JSON blob; `toolLine(block, resolveAgentName)` decodes it, and
  Canvas puts the *new agent's face* on the chip and a link to its tab next to it. A
  phase of Crew calls says "Created reviewer, wrote to reviewer" rather than
  "Ran 4 tools" (see §6).

## 4. Layout decisions worth naming

- **The drawer is chrome, not a feature.** One component, three contents — agent thread,
  agent sheet, diff preview — one 280ms slide, one backdrop, one Escape. Adding a fourth
  is a switch case.
- **Pages cover the surface, not the tab strip.** The inventory says pages cover the
  main area over the tabs. I kept the tab strip reachable above the page, because a
  demo where the tabs are unreachable while Settings is open feels like a trap. Tabs
  stay mounted underneath; clicking one leaves the page.
- **Bubbles both sides, widgets outside.** An assistant turn is a rail in the agent's
  hue with the avatar at its head. Prose runs are bubbles inside the rail; code fences,
  tables, blockquotes and diffs break out to the full column as cards at `e1`, and the
  rail continues past them so the turn still reads as one unit. The split is done in
  `lib/mdSegments.ts` by splitting the markdown source, not in CSS.
- **Tabs carry faces.** Avatar, name, and one fixed trailing slot holding three mutually
  exclusive things — status dot, close button, hotkey hint — stacked so nothing resizes
  on hover.

## 5. What I faked

- **No backend.** Everything is `@crew/fixtures`. Streaming, approvals, questions and
  inbound letters are real `HarnessEvent`s from `sessionRuntime()`; the Demo menu is the
  only way to raise some of them.
- **The terminal** is a static buffer with a fake cursor. It is windowed, searchable,
  zoomable and its paths open files, but nothing is running.
- **The file editor** is a transparent `<textarea>` over a highlighted, windowed `<pre>`.
  Editing and dirty tracking are real and in-memory; saving updates a map.
- **Workspace create/rename/delete and agent create/edit** mutate React state. New
  sessions get an empty transcript, which is honest — it is the empty state.
- **Routine "Run now"** appends a `running` row and settles it two seconds later.
- **Attachments** are metadata only: the paperclip and paste/drop paths produce
  plausible `AttachedFile`s without reading bytes.
- **The lineage tree and the graph** are derived from fixture data, so they are as real
  as the fixtures.

## 6. Where I overrode the shared helpers

Everything in `@crew/fixtures` is used as given — `groupRows`, `buildActivity`,
`phaseLabel`, `activityDigest`, `toolLine`, `searchMessages`, `rankBy`, `matchesChord`,
`conversationBetween`, `graph`, `lineage`, `attribution`, `describeSchedule` — with one
deliberate exception:

**`lib/crewPhase.ts` relabels phases made entirely of Crew tools.** Shared's
`phaseKind()` normalises every Crew call to `other`, so a run that created an agent and
sent it a letter folds into "Ran 4 tools". Canvas splits those lines into *events* (a
line that names another agent: `create_agent`, `message_agent`) and *plumbing*
(`list_agents`, `find_tool`), and labels the phase with the events. If the phase has no
events it falls back to the shared label. Same for the digest and the glyph. This is a
presentation choice, not a semantic one: the underlying decoding is all
`crewToolLine()`.

I also chose **not** to use `shiki`, though it is installed — see §7.

## 7. Performance

- **No async highlighter.** Shiki resolves a theme asynchronously, so the transcript
  would paint plain text and then re-paint coloured text, moving every line below the
  change. A stick-to-bottom scroller with a 16px threshold cannot survive that.
  `lib/highlight.tsx` is a ~120-line synchronous tokeniser for TS/Rust/CSS/JSON/bash. It
  is less accurate than Shiki and it never moves a line.
- **Streaming is not markdown.** While a reply streams it renders as word spans in a
  `<p>`; the moment it settles it becomes memoised markdown. Settled paragraphs never
  re-parse and never re-animate — each word span animates once on mount and the
  element persists.
- **The transcript pages.** It mounts the last 30 rows and prefetches 30 more when the
  reader gets within 600px of the top, with scroll compensation so the line you are
  reading does not move.
- **Both long surfaces are windowed**: the file editor and the terminal render only the
  visible line range plus overscan.
- Measured against `stressWorld("heavy")` (Demo → Stress): 400 sessions, 20k files,
  5000-block transcripts, a 50k-line terminal. Loading the world takes ~1.6s (almost all
  of it generating fixtures). Scrolling the 314-row sidebar ran 40 frames in 655ms —
  ~16ms a frame, so depth at that row count is not the bottleneck I expected it to be.
  Shadows are cheap; it is `box-shadow` **transitions** on scroll that would not be, and
  the hover transitions only touch shadow, background and transform.

## 8. What I would do differently with more time

1. **Virtualise the sidebar.** 400 rows is fine; 1200 (`stressWorld("absurd")`) is not,
   and the fix is the same windowing the terminal already has.
2. **Make the drawer addressable by hash** — `#/session/s-harness/thread/s-relay`.
   The shared route contract does not have a slot for it, so the drawer is currently
   state-only and a screenshot of it cannot be scripted.
3. **The graph layout is a circle.** A force layout, or at least grouping by lineage,
   would carry more information at twenty agents. At eight, a circle is honest.
4. **Reorder in the sidebar is drag-and-drop with no drop indicator between rows** — it
   highlights the target row instead. A real insertion line is better.
5. **Keybinding capture is naive**: it takes the next chord without checking for
   conflicts. It should refuse a chord another command owns, and offer to steal it.
6. **The composer's mention overlay** re-implements the textarea's wrapping in a mirror
   div. It is correct for the cases I tried and it is the one place where a font change
   could desynchronise the highlight from the text.
7. **`prefers-reduced-motion` is handled globally** by killing durations. The rotating
   status ring becomes a solid ring and the shimmer becomes dim text, which is right,
   but a reduced-motion user loses the "something is happening" signal in the sidebar —
   it should become an explicit word instead.

## 9. Things I would ask `design/shared` for

- `phaseKind()` could split Crew tools into their own kind (`crew`), so every prototype
  does not have to relabel them the way `lib/crewPhase.ts` does.
- `Letter` carries `sentBlockId`/`receivedBlockId` but not the *session* each came from,
  so the thread drawer cannot jump to the exact block in the peer's transcript. One more
  field would make "open this letter where it was written" a one-liner.
