# Direction C — **Canvas**

> Ink solves the inconsistency by removing the relief. Canvas solves it by giving the
> relief to everything, on purpose, from one scale.

The complaint was "Kumo's buttons have a kind of relief, but the sidebar is flat".
There are two honest answers. Ink picks flat. Canvas picks depth — and then holds it
everywhere, so nothing reads as an accident. This is also the direction that takes the
multi-agent nature of Crew seriously: agents are *people* in this room, so they have
faces, and the conversations between them are conversations, not folded tool calls.

Nearest spirit: Linear's surfaces, Raycast's depth — with a roster, message
groups and a workbench underneath.

---

## Colour — warm neutrals, one accent, real surfaces

Surfaces are actual steps, not tone tricks, because shadow needs something to sit on.

```
light:  base 0.975 0.004 85   (warm)   raised 1.0    overlay 1.0
dark:   base 0.185 0.006 265  (cool)   raised 0.215  overlay 0.245
```

Text: `0.22 0.01 265` light / `0.96 0 0` dark, stepped 100 / 70 / 52 / 38.
Borders are `color-mix` of text at 10 / 6 percent — they exist to define a card's edge
under its shadow, not to draw boxes.

**Accent:** a single brand hue used with intent — primary button, selected row, focus
ring, active tab, the unread dot. Pick one and commit; `oklch(0.62 0.16 262)` light /
`oklch(0.72 0.14 262)` dark is a good start, but choose deliberately and say why in
`TOKENS.md`.

**Agent hues are generated, not chosen.** `identityFor(name).hue` from
`@crew/fixtures` gives every agent a stable hue used for its avatar, its rail in the
transcript, and its dot in the sidebar. That is how a twelve-agent workspace stays
readable.

## Type — roomier

`14px / 21px` body. The app is not a spreadsheet; give it air.
Scale: `11/16`, `12/18`, `14/21`, `16/24`, `18/26`, `24/30`.
Weights 400 / 500 / 600. Headings use `-0.015em` tracking; body uses `0`.
Mono (`ui-monospace`, 13/20) for code, paths and terminal only.

## Space, radius

Spacing: `4 8 12 16 20 24 32 40 48`. Generous.
Radius: `6` (chips, small controls), `10` (rows, buttons, inputs), `14` (cards,
bubbles), `20` (panels, sheets, palette), `full` (avatars, pills).

## Elevation — the scale everything obeys

```
--e0  none                                                  page background
--e1  0 1px 2px ink/5%, 0 0 0 1px border                    resting card, sidebar row hover
--e2  0 2px 4px ink/6%, 0 1px 2px ink/4%, 0 0 0 1px border  button, input, tab, chip
--e3  0 8px 20px ink/10%, 0 2px 6px ink/6%                  popover, menu, tooltip
--e4  0 24px 56px ink/16%, 0 4px 12px ink/8%                dialog, sheet, palette
```

Rules that make it a system rather than decoration:
- A control at rest is `e2`. On hover it **rises half a step** (larger blur, same
  offset). On press it **drops to e1** and translates 1px down. That press behaviour is
  the "relief" the user liked — now every control has it, not just Kumo's.
- Nothing stacks two levels. A card at `e1` containing a button at `e2` is correct; a
  card at `e3` containing a card at `e3` is not.
- In dark mode shadows get weaker and a top inset highlight
  (`inset 0 1px 0 white/6%`) replaces some of the separation, because black shadows on
  a black surface do nothing.

## Avatars — everywhere, and they mean something

Every agent has a face. Use `identityFor(seed)` for the hue and pick **one** generator —
try `boring-avatars` (`beam`/`marble`), `@dicebear/collection`, and the built-in
`avatarSvg` from fixtures, then commit to one and justify it in `NOTES.md`.

Sizes: 16 (inline in a message line), 20 (tab), 28 (sidebar row), 36 (thread header),
64 (agent sheet). Status is a ring around the avatar, not a separate dot, in the
sidebar and the tab strip.

## Layout

```
┌──────────────┬─────────────────────────────────────────────┐
│  workspace   │  (avatar) harness   (avatar) Relay   +   │  tab bar, 44px
│              ├─────────────────────────────────────────────┤
│  ◉ harness   │                                             │
│  ◉ Relay  │   conversation                              │
│  ◉ renderer  │                                             │
│              │                                             │
│  ▸ sessions  │                                    ┌────────┤
│              │                                    │ thread │  agent-thread drawer
│  settings    │  ┌──────── composer ────────┐      │ drawer │  slides from the right
└──────────────┴──┴───────────────────────────┴─────┴────────┘
```

- **Tabs carry avatars**, like a chat app's conversation switcher: avatar, name, status
  ring. Active tab is a raised card at `e2` sitting on the bar; inactive tabs are flat.
- The sidebar is a list of **rows with avatars**, 44px tall, with the name, a dim second
  line (provider · elapsed), and a status ring on the avatar.
- **A right-hand drawer** is first-class chrome, not a one-off: it hosts the agent
  thread view, the agent settings sheet, and the diff preview. One component, three
  contents, one animation.

## Chat — bubbles on both sides, widgets as cards

- **User**: right, accent-tinted bubble, radius 14, `e1`.
- **Assistant**: left, raised bubble at `e1` on the base surface, with the agent's
  avatar at the top-left of the first bubble in a run and a hue-tinted 2px rail down
  the left edge.
- **Widgets break out of the bubble** — the user already liked this split. Code fences,
  tables, diffs and tool cards render as full-width cards at `e1` *between* bubbles,
  with the agent's rail continuing past them so the turn still reads as one unit.
- **Tool calls are chips, then cards.** Folded: a small rounded chip with an icon, the
  verb and the target (`⌘ npm run test · 107 passed`). Expanded: a card with a header
  row and the output.
- A phase folds into one chip that says what it did; the digest chip carries a count
  badge.
- Approval and question cards are **full-width panels** at `e2` with clear primary
  actions and keycaps on the buttons.
- Tables scroll inside their card with a soft masked edge.

## Status

`working` is the avatar's ring **rotating a gradient arc** — slow, 2s, and only on the
avatar, so there is exactly one moving thing per busy agent. No standalone spinners.
`needs-input` is a solid amber ring plus a small badge on the avatar. `done` is an
accent dot on the avatar's corner. `error` a red ring. `idle` no ring.

The sidebar "loading" affordance is a **shimmer sweep across the row's second line**
while a turn runs — the row itself tells you something is happening.

## Agent-to-agent messages — the headline feature

This is where Canvas earns its keep. Grouped, avatar-led, and it opens a real thread.

In the transcript:

```
   ⟡  (avatar) 2 messages with Relay                    5:41 PM  ›
   ⟡  (avatar)(avatar) 3 messages with 2 agents            5:44 PM  ›
```

- A pill-shaped row, `e1`, with the peer avatar(s) stacked and overlapping when there
  are several.
- Clicking **opens the right drawer** with a dedicated two-agent thread: header with
  both avatars and a "open Relay" action, then the exchange as a normal chat —
  their letters left, ours right — with timestamps and the ability to scroll the
  whole history between those two agents.
- The drawer is addressable: opening it from the sidebar's "conversations" view shows
  the same thread. Build a small **agent-network view** (a page) listing every pair
  that has exchanged letters, with counts. That is a feature the app does not have and
  obviously wants.

## Motion

Springier than the other two, but still short. `--ease-out: cubic-bezier(0.2,0.9,0.3,1)`
at 180ms for enters; cards scale from `0.98`. The drawer slides 280ms. Hover
transitions are 120ms on shadow and background only — never on layout.

## What Canvas must prove

That deliberate, systematic depth reads as craft rather than clutter — and that
treating agents as identities with faces makes a multi-agent workspace legible in a way
a flat list never will.
