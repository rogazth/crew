# Common brief — all three prototypes

Read `INVENTORY.md` first. It is the functional contract. This file is the shared
engineering contract. Your prototype's own `DIRECTION.md` is the design contract.

---

## Hard rules

1. **Never touch `/home/agent/crew/src`, `/home/agent/crew/crates`, `electron/`, or the
   root `package.json`.** You work only inside your own `design/proto-*/` directory.
2. **Never touch the other two prototypes.** They are being built in parallel.
3. **`design/shared/` is read-only for you.** If you genuinely need something added
   there, add it to `NOTES.md` in your prototype instead and work around it locally.
4. **No backend.** No `fetch`, no WebSocket, no IPC, no `localhost`. Everything comes
   from `@crew/fixtures`. `localStorage` is fine for preferences.
5. **No Kumo, no `@cloudflare/*`.** That dependency is the problem we are escaping.
6. `npm run check` (tsc) and `npm run build` must both pass when you stop.

## What you were given

- `@crew/fixtures` — already wired through a Vite alias and a tsconfig path. Contains:
  - types mirroring the wire protocol (`Block`, `Session`, `ToolDetail`, …)
  - `workspaces`, `sessions`, `projectFiles`, `routines`, `threads`, `terminalBuffers`,
    `FILE_CONTENTS`, `diffs`
  - `groupRows()` / `buildActivity()` / `phaseLabel()` / `activityDigest()` — the
    transcript grouping semantics, including **agent-message grouping**
  - `toolLine()` — with the `{` bug already fixed
  - `searchMessages()` — a real local full-text search over the fixtures
  - `fuzzyMatch()` / `rankBy()` — for the palette
  - `COMMANDS`, `matchesChord()`, `commandKeys()` — the binding table
  - `MockSession` / `sessionRuntime()` — a fake daemon that replays scripted turns as
    real `HarnessEvent`s, so streaming, tool calls, approvals and questions are live
  - `identityFor()` / `avatarDataUri()` — deterministic avatar seeds
- Dependencies already installed: `@base-ui/react`, `lucide-react`,
  `@phosphor-icons/react`, `boring-avatars`, `@dicebear/core` + `@dicebear/collection`,
  `react-markdown` + `remark-gfm`, `shiki`, `clsx`, Tailwind v4.

Use the grouping helpers rather than re-deriving them — spend your budget on design.
You may override any of them locally if your direction needs different semantics; say
so in `NOTES.md`.

## Required structure

```
proto-<name>/
  DIRECTION.md        given to you — the design contract
  NOTES.md            you write — decisions, trade-offs, what you'd change
  TOKENS.md           you write — the token spec, ready to port to the app
  src/
    styles/
      tokens.css      every token, light + dark, as CSS custom properties
      index.css       @import "tailwindcss" + tokens + component layer
    ui/               primitives: Button, Input, Select, Menu, Dialog, Popover,
                      Tooltip, Switch, Checkbox, Radio, Tabs, Badge, Kbd, Avatar,
                      Spinner-replacement, Field, Segmented, ScrollArea
    chrome/           shell: Sidebar, TabBar, CommandPalette, StatusDot, WorkspacePicker,
                      ActionMenu, AgentSheet, ConfirmDialog, SettingsSidebar
    surfaces/         Chat, Terminal, FileEditor, DiffView, Search, Routines, Settings
    lib/              local helpers only
    app/App.tsx       the shell
```

## The demo requirement — this is what gets judged

The user will open your prototype and click through it with no backend. Everything in
`INVENTORY.md` must be reachable. In particular they asked to see:

- **A long conversation** — open `s-harness` (3 days, date breaks, every block kind).
- **A short conversation** — `s-renderer`.
- **An empty conversation** — `s-triage` (centred composer).
- **A huge tool run** — `s-daemon` (12 reads, 4 edits, folding under pressure).
- **A failed run** — `s-scribe` (failed tool, session note, error recovery).
- **Agent-to-agent messaging** — `s-relay` has inbound letters from three agents and
  outbound `message` tool calls. This is the feature to get right.
- **Every response variant** — streaming text, markdown kitchen sink (tables with
  internal scroll, nested lists, task lists, blockquotes, footnotes, code fences, a
  ```diff fence), reasoning, tool phases, approval card, question card, attachments,
  turn footers with usage.
- **Live streaming** — the composer must actually send and stream a scripted reply via
  `sessionRuntime(id).send(text)`. Also wire `sendAndAskApproval` and `sendAndAsk` to
  something (a dev menu is fine) so the approval and question cards can be demoed live.

Add a small **"Demo" menu** in the chrome (a dev affordance, clearly marked) that can:
trigger a streaming reply, raise an approval, raise a question, receive a letter from
another agent, flip every session status, and toggle light/dark. It is the difference
between a mockup and something the user can evaluate.

## Hash routes — the same in all three

So the prototypes can be screenshotted and compared on identical surfaces, each one
reads `location.hash` on boot and writes it back on navigation (`history.replaceState`,
so the back stack stays usable). A `useHashRoute()` hook is enough; no router library.

```
#/session/<sessionId>       #/session/s-harness · s-relay · s-renderer · s-triage
                            · s-scribe · s-daemon · t-build · t-server
#/file/<relativePath>       #/file/src/lib/tabs.ts
#/search
#/routines
#/routines/<routineId>      the editor — #/routines/r-triage
#/settings/<sectionId>      #/settings/appearance · keybindings · terminal
#/                          default surface
```

An unknown hash, or one naming something that does not exist, falls back to the default
surface. Never render an error screen for a bad hash.

`design/tools/shoot.mjs` drives these routes headlessly:

```bash
node design/tools/shoot.mjs proto-ink          # both themes, every route
node design/tools/shoot.mjs --all --light
```

## Two more switches, also the same in all three

```
?stress=light|medium|heavy|absurd     the big fixtures instead of the demo ones
?source=live                          a real crewd instead of any fixtures
```

Both compose with the hash: `?stress=heavy#/session/stress-s-0` is a 5000-block thread,
`?source=live#/search` searches a real index.

One call reads both:

```ts
import { sourceFromLocation, liveSource } from "@crew/fixtures";
const source = sourceFromLocation(location.search, () => liveSource());
```

- `?stress=heavy` → 400 sessions, three 5000-block transcripts (`stress-s-0..2`), 20k
  project files, 40 workspaces, a 50k-line terminal. Deterministic. Routes the stress
  world does not hold fall back to the demo ones, so every route in this brief still
  resolves.
- `?source=live` → the real daemon. Add `crewd()` from `design/tools/vite-crewd.ts` to
  your `plugins`; it starts `crewd` lazily on first request, so fixture mode never
  spawns one. Needs `cargo build -p crewd` once.

Put a source badge in the chrome: `source.label`, plus `source.onConnectionChange` for a
connected dot. A live daemon starts with an empty store, so your empty states matter.

**One trap.** `thread().subscribe(listener)` calls the listener **synchronously before
it returns**, so the unsubscribe function does not exist yet inside that first call.
Hold it in a mutable box.

## Quality bar

- Light and dark both correct. No hard-coded hex in components — tokens only.
- Every interactive element has a visible focus state and works from the keyboard.
- No layout shift on hover/focus/state change.
- `prefers-reduced-motion` respected.
- 60fps while a turn streams: memoise settled rows, don't re-parse settled markdown.
- The transcript must stay smooth with the `s-daemon` thread open.
- Comments only where they earn it: a non-local consequence, an API quirk, an invariant
  the code does not check. Never narrate the line below.

## Definition of done

1. `npm run check` clean, `npm run build` clean.
2. `npm run dev` serves a shell where every surface in the inventory is reachable.
3. `TOKENS.md` documents the whole token set and the rules for using it (what earns
   elevation, what earns colour, the type scale, the icon rule).
4. `NOTES.md` says what you decided and why, what you'd do differently with more time,
   and anything you faked.
5. Take screenshots into `shots/` if you can (headless Chrome via
   `npx vite preview` + a script is fine, but do not block on it).
