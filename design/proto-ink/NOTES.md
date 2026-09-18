# Ink — notes

What I decided, what I faked, and what I would change with more time.

---

## 1. The thesis, and whether it held

Ink's claim is that the window's inconsistency is not a styling bug but the absence of
a system, and that **one derivation table plus a four-level elevation scale** is enough
to make every surface agree.

It held, and the place it showed most was the parts I did not write. Four surfaces
(Settings, Routines, Terminal + Search, File editor + Diff) were built in parallel by
other agents against `TOKENS.md`, `src/styles/tokens.css` and `src/ui/` and nothing
else. They came back looking like the same app. That is the actual result: the system
is portable enough that four people who never spoke produced one design.

The two rules that did the most work:

- **Elevation never encodes state.** Hover and selection change *fill*; only the
  resting role of a control decides its shadow. This is what killed the "Kumo buttons
  are embossed, the sidebar is flat" problem, and it also means nothing in the window
  moves under the cursor.
- **The primary button is ink, not accent.** Accent means "you are here" — the selected
  sidebar row's 2px marker, the palette cursor, the focus ring, a checked control, a
  link. Once accent stopped being decoration, the eye had exactly one thing to find on
  any screen. I removed the `accent` button tone from `Button.tsx` after catching
  myself using it for "New routine"; there is a comment in the file so the next person
  does not re-add it.

## 2. Decisions worth arguing with

**The tab strip and the sidebar share one recessed surface.** The canvas is a single
elevated plane inside an L-shaped frame. It means the active tab pill (level 1, on the
canvas colour) reads as *part of the canvas*, which is what a tab is. The cost is that
the strip is quieter than in the current app; on a 400-tab day that might be wrong.

**Selection is a 2px rail marker, not a filled row.** A filled sidebar row competes
with the transcript for attention, and the transcript is what you are reading. The row
still takes `fill-tertiary`, but the accent is a hairline on the rail. On a narrow
sidebar this is subtle; I think that is correct and I would test it before shipping.

**No spinner, one animation.** `working` is a breathing dot with a halo, `needs-input`
is the same hue held still inside a ring. A working sidebar row also gets a sweeping
hairline along its bottom edge — that is the "loading indicator" the spinner was doing
badly. Everything else in the window is static. There is exactly one `@keyframes` loop
in the stylesheet that is not a one-shot, and it drives all of it.

**I wrote my own syntax highlighter** (`src/lib/highlight.ts`) instead of using the
Shiki that was installed. Two reasons, and the first is the real one: Shiki paints with
baked hex values from a theme JSON, which would have put ~200 hard-coded colours into a
prototype whose whole argument is that colour comes from tokens. The second is that it
resolves asynchronously, and code that re-paints after layout moves the line a reader
is on. Mine is a sticky-regex tokenizer over seven languages, synchronous, and every
token lands on a `--syn-*` custom property, so highlighting flips with the theme. It is
less accurate than Shiki on edge cases (nested template literals, JSX attribute
values); I would keep the architecture and improve the grammars rather than go back.

**The transcript pages instead of virtualising.** It paints the last 60 rows and pulls
60 more when the reader gets within 600px of the top, with an explicit scroll anchor so
growing the list upward does not move the line under the reader. Rows memoise on their
block, and settled markdown is parsed once. With `stressThread({blocks: 5000})` loaded
from the Demo menu, first paint stays under a frame and scrolling stays smooth — a row
window beats a virtualiser here because transcript rows have wildly different heights
and a virtualiser has to measure them all.

## 3. Agent-to-agent messaging — the part I most want judged

The brief called this a patch to redesign. The honest version turned out to be a
*model* problem, not a rendering problem: a letter exists as an outbound tool call in
one transcript and an inbound turn in another, and nothing joined them.

What Ink does:

- **One meta row on the agent's own rail**: `✉ 2 messages with Relay`, with the
  peers' avatars, the time, and — when the daemon has not delivered them yet — a
  `2 waiting` chip in the attention tint. Several peers read `3 messages with 2 agents`.
- **Clicking opens an inline panel**, not a modal and not a generic collapsible: a
  two-sided mini-transcript, their letters left with their avatar, ours right, grouped
  by peer with a hairline between and a footer link that opens their tab.
- **The sender's half is recovered.** A letter routed through the tool gateway loses
  its `message` detail *and its body* on the way out — only the receiver's copy has the
  text (see `FINDINGS.md` §3). `useLetterIndex` pairs both halves with the fixtures'
  `letters()` and hands the sender's row the text from the receiver's copy, then
  synthesises the `message` detail so `groupRows` joins them. Without that,
  `#/session/s-lead` shows "Crew call tool message_agent" and the conversation only
  exists in one of the two transcripts.
- **The mailbox is visible in two places**: a count chip on the sidebar row of any
  agent with queued letters, and an expandable strip above the composer —
  "2 letters waiting · delivered to harness when this turn ends" — listing who wrote
  and what they said. This is the state `FINDINGS.md` calls the most common confusing
  one in a multi-agent workspace, and it previously had no pixels at all.

**Created-by is chrome now.** The daemon writes it as a system note, which is why it
felt like a patch. Ink promotes it to a 28px strip under the chat header — avatar, who,
when, and a link — and filters the note out of the transcript so it is not said twice.

## 4. Tool rows

The `{` bug is fixed twice over. `toolLine(block, resolveAgentName)` from the fixtures
guarantees a sentence, and Ink passes the resolver everywhere so a row says `Relay`
rather than a uuid. On top of that:

- **Crew's own tools get their own glyph and their own phase label.** `phaseLabel` folds
  a run of them to "Ran 4 tools", which is the least informative line available for the
  most consequential calls an agent makes. `phaseLabelOf` says "Wrote 3 letters" or
  "Worked on the roster" instead.
- **Consequential rows do not fold by default.** A phase containing `create_agent` or
  `message_agent` opens itself; the reader can still fold it, but the transcript will
  not fold it for her. Burying "Created reviewer" behind "Ran 4 tools" was the failure
  mode `FINDINGS.md` asked me to check, and this is the fix.
- `create_agent` used to answer with a raw model id, so a row read
  "opencode opencode/ling-3.0-flash-fin-free". I fixed that locally, reported it, and
  deleted my fix when `crewToolLine` took it — the suffix now reads "opencode Ling 3.0
  Flash" for all three prototypes.

## 5. What I faked, and where

- **The approval card's patch for two files.** The fixtures ship three real diffs but
  no patch for the two files the approval requests name (`src/index.css`,
  `providers/opencode.rs`). An approval card whose whole job is "show what it will do"
  should not shrug, so `LOCAL_PATCHES` in `src/lib/files.ts` holds two stand-ins. Every
  other diff in the app is from `diffs`.
- **One synthetic large file.** No fixture file is long enough to exercise the editor's
  windowing or its "plain text" fallback, so `crates/crew-core/src/harness.rs` is
  generated at load (≈2,600 lines) in `src/lib/files.ts`. Every other body is verbatim.
- **Links show a globe, not a favicon.** A real favicon is a network request and the
  brief forbids those. Same signal, offline.
- **Keybinding capture is display-only.** The Keybindings page really captures a chord
  and really stores it, but the shell keeps firing the default — rebinding the live
  handler was not worth the budget against a fixed `COMMANDS` table. The page says so
  in UI copy, not just in a comment.
- **Saving a file is state-only**, the terminal's Clear/Restart reset local state, and
  the Providers page's "Configure" items are inert. All three are labelled where they
  appear.
- **Stress fixtures are swapped in through the store**, not through the runtime —
  `MockSession` has no way to replace its blocks, so the Demo menu puts an oversized
  transcript in `state.stress` and `Chat` prefers it until you send a message. It is a
  dev path and it is the only one in the app.

## 6. Things I wanted from `design/shared/` and did not take

- I narrowed my `tsconfig.json` `include` from `["src", "vite.config.ts",
  "../shared/src"]` to `["src", "vite.config.ts"]`. Files I import are still fully
  typechecked; this only stops orphaned shared modules from failing my build while the
  fixture set is being written. `design/shared` typechecks and tests itself.
- `schedule.ts` landed after the routine editor was finished, so the editor keeps its
  own `scheduleLabel`/`cronError` rather than `describeSchedule`/`isValidCron`. Same
  semantics, duplicated. I would delete mine and take the shared ones.
- `fixtureSource()` / the `DataSource` interface is not wired. Ink reads the fixtures
  directly. Moving to it is a real refactor of `useThread` and the store's session
  list, and it is round 3's job, not this one's.

## 7. What I would do with another day

1. **Density.** The Appearance page writes `data-density`, and only the transcript's
   leading reads it. A real compact mode wants row heights and paddings on tokens too,
   which is a token-naming exercise I did not want to rush.
2. **The agent graph.** `graph(roster)` is built and only its `waiting` counts are
   drawn. A small "who writes to whom" panel on the Routines page, or a lineage tree in
   the sidebar for `createdBy`, is maybe forty lines and would make a nine-agent
   workspace legible. `lineage()` is four levels deep in the fixtures and the sidebar
   still draws a flat list.
3. **Drag-reorder of sidebar rows is HTML5 drag-and-drop**, which is the one place in
   the app where the pointer and the render disagree. A pointer-events implementation
   with a real placeholder would fix it.
4. **Split diff needs a synchronised horizontal scroll** between its two panes; today
   each pane scrolls alone.
5. **The transcript's Cmd+A** selects the conversation, and `ink-noselect` keeps rails,
   timestamps and fold lines out of a drag-selection. It does not yet strip them from
   the *copied* text — a `copy` handler that rewrites the clipboard payload is the
   honest finish.
6. **Bundle.** 880 kB before gzip, most of it `react-markdown` + `remark-gfm`. Lazy
   loading the markdown pipeline behind the first assistant message would halve first
   paint. Not a design question, but it is the kind of thing that decides whether the
   window feels fast.

## 8. Conventions a reader of the code should know

- `src/lib/icon.tsx` is a name→component map and the only file that imports
  `lucide-react`. Swapping icon sets is that file.
- `src/lib/store.tsx` is one `useState` + a frozen actions object, not a reducer. Every
  mutation is a named method, so grepping `actions.` finds every write in the app.
- `src/lib/bus.ts` carries exactly three messages — find-in-terminal, save-file, and
  open-workspace — because those belong to a surface rather than to the shell, and
  putting transient intent in persistent state is how stores rot.
- `src/surfaces/chat/context.ts` decides which open card owns `Enter` and `Escape`.
  "Newest" is a property of the whole transcript, so it is computed once above rather
  than by every card racing for the key handler.
- Hash routes are read on boot and written with `replaceState`; the screenshot harness
  navigates by hash without reloading, so `hashchange` is handled too.
