# Canvas — token spec

Every value the prototype paints with lives in `src/styles/tokens.css`. Components name
tokens; they never name values. This file is the contract: copy `tokens.css` into the
app, keep these rules, and the rest is mechanical.

Tailwind v4 exposes the tokens as utilities through `@theme inline` in
`src/styles/index.css`, so `bg-raised`, `text-ink-52`, `rounded-card`, `shadow-e2` and
`el-2` are all the same six values seen from different angles.

---

## 1. Surfaces

Depth only reads if the thing casting the shadow is sitting on something. Canvas uses
real surface steps, not tone tricks on one flat colour.

| Token | Light | Dark | Used for |
| --- | --- | --- | --- |
| `--base` | `oklch(0.975 0.004 85)` | `oklch(0.185 0.006 265)` | the page under everything |
| `--base-sunken` | `oklch(0.952 0.005 85)` | `oklch(0.162 0.006 265)` | sidebar, tab strip, code wells, segmented tracks |
| `--raised` | `oklch(1 0 0)` | `oklch(0.215 0.007 265)` | cards, bubbles, controls, rows at rest |
| `--raised-2` | `oklch(0.993 0.002 85)` | `oklch(0.232 0.007 265)` | a raised thing hovered |
| `--overlay` | `oklch(1 0 0)` | `oklch(0.245 0.008 265)` | menus, popovers, dialogs, the drawer |
| `--scrim` | ink at 32% | ink at 55% | behind a dialog or the drawer |

Light is **warm** (hue 85 at very low chroma); dark is **cool** (hue 265). That is
deliberate: a warm paper white makes shadows read as ink rather than grime, and a cool
dark keeps a bright accent from turning muddy.

## 2. Ink

One ink colour, four steps, expressed as alpha so it composites correctly on any
surface.

| Token | Alpha | Used for |
| --- | --- | --- |
| `--ink-100` | 1 | body copy, titles, the thing you are reading |
| `--ink-70` | 0.70 | secondary copy, control labels, tool lines |
| `--ink-52` | 0.52 | metadata, captions, section descriptions |
| `--ink-38` | 0.38 | timestamps, gutters, placeholders, disabled glyphs |

`--ink-on-accent` is the only other text colour: what sits on a filled accent surface.

## 3. Lines

```
--line        ink 10% (light) / 12% (dark)   the edge of a card under its shadow
--line-soft   ink  6% /  7%                  a hairline between rows inside one card
--line-strong ink 16% / 20%                  a pressed control, a scrollbar thumb
```

A border here is not a box. It exists so a shadowed card still has a defined edge on a
white page, and so rows inside a card separate without gaps. If a border is doing the
work a shadow should do, the elevation is wrong.

## 4. Accent — one hue, used with intent

```
--accent-h: 265
--accent       oklch(0.55 0.17 265)   light      oklch(0.74 0.14 265)   dark
--accent-soft  the same hue at 10%    /  16%     tints: selected row, user bubble
--accent-line  the same hue at 28%    /  34%     focus outlines, quote rails
--accent-text  oklch(0.47 0.16 265)   /  0.82    accent-coloured text
--ring         the same hue at 45%    /  55%     the focus ring
```

265 is chosen, not inherited. Two reasons: against a warm neutral base (hue 85) it sits
almost opposite on the wheel, so a single accent element separates from the page without
raising the page's own chroma; and it is far from all four status hues (amber 72,
red 25, green 150) so "this is selected" never reads as "this is a warning".

**The accent is allowed in exactly six places:** the primary button, the selected
sidebar row, the active tab's left mark, the focus ring, the unread dot, and the user's
own bubble. Everything else earns its colour from status or from an agent's hue.

## 5. Agent hues are generated

`identityFor(name).hue` from `@crew/fixtures` is the only input. One name always yields
one hue, and that hue drives three things: the avatar's palette, the 2px rail down the
left of the agent's turn, and the agent's edge in the network graph.

```ts
agentTint(seed, dark)  // oklch(0.58 0.15 H) light, oklch(0.74 0.13 H) dark
agentWash(seed, dark)  // the same at 10% / 14%
avatarPalette(seed, dark)  // five fills, two ramps
```

Nobody picks a colour for an agent, so a twelve-agent workspace stays readable and a
four-hundred-agent one does not need a palette at all. Lightness and chroma are pinned
per theme, which is what keeps a generated hue from ever being unreadable.

## 6. Status

```
--status-working    oklch(0.72 0.16 72)    a rotating arc around the avatar
--status-attention  oklch(0.72 0.16 72)    a solid ring plus a badge
--status-unread     = --accent             a dot on the avatar's corner
--status-error      oklch(0.58 0.2 25)     a solid red ring
idle                — nothing at all
```

`working` and `needs-input` share a hue and differ in **shape** — one rotates, one is
solid with a badge — because they are the same urgency at different distances, and
colour-blind users should not have to tell two ambers apart.

There are no spinners. `working` is the avatar's own ring; a blocked surface uses
`<Pulse>`, three dots that breathe. A spinner says "this page has not loaded", which is
never what an agent mid-turn is doing.

## 7. Elevation — the ladder everything obeys

```
--e0   none                                                     the page
--e1   0 1px 2px ink/5%,  + 1px line                            resting card, bubble, chip, row hover
--e2   0 2px 4px ink/6% + 0 1px 2px ink/4%, + 1px line          button, input, tab, active tab, panel
--e3   0 8px 20px ink/10% + 0 2px 6px ink/6%                    popover, menu, tooltip, select
--e4   0 24px 56px ink/16% + 0 4px 12px ink/8%                  dialog, palette, drawer
```

Rules that make it a system and not decoration:

1. **A control at rest is `e2`.** On hover it rises half a step (`--e2-hover`: bigger
   blur, same offset). On press it drops to `--e2-press` and translates 1px down. That
   press behaviour is the relief the user liked in Kumo's buttons — here every control
   has it, from the primary button to a sidebar row, and it comes from one class
   (`.rise`, or `.rise-1` for things that rest at `e1`).
2. **Nothing stacks two levels.** A card at `e1` containing a button at `e2` is correct.
   A card at `e3` inside a popup at `e3` is not: the inner thing uses a tone step
   instead.
3. **Transitions touch shadow, background and transform only** — 120ms, `--ease-out`.
   Never layout. No hover may move a neighbour.
4. **Dark mode weakens the shadow and adds a top inset highlight**
   (`inset 0 1px 0 white/6%`). A black shadow on a black surface does nothing; the lit
   top edge is what separates the card.

What earns which rung, in one line each: `e1` rests, `e2` is pressable, `e3` floats over
the page and dismisses on outside click, `e4` takes the whole window's attention.

## 8. Radius

```
--r-chip     6px    tool chips, keycaps, badges, small controls
--r-control 10px    buttons, inputs, rows, tabs, menu items
--r-card    14px    cards, bubbles, breakout widgets
--r-panel   20px    dialogs, the composer, the palette, the drawer
full                avatars, pills, the agent-thread row
```

Radius tracks size, so a chip inside a card inside a panel keeps its corners visually
parallel.

## 9. Type

Body is `14px / 21px`. The app is not a spreadsheet.

| Token | Size / line | Used for |
| --- | --- | --- |
| `--text-2xs` | 10 / 14 | count badges on an avatar |
| `--text-xs` | 11 / 16 | timestamps, group headers, keycaps, metadata |
| `--text-sm` | 12 / 18 | secondary rows, tool chips, tab titles |
| `--text-base` | 14 / 21 | body, messages, controls, everything by default |
| `--text-md` | 16 / 24 | card titles, section headings, palette input |
| `--text-lg` | 18 / 26 | empty-state titles |
| `--text-xl` | 24 / 30 | page titles |
| `--text-code` | 13 / 20 | mono: code, paths, terminal, diffs |

Weights are 400 / 500 / 600 — no 700 anywhere. Headings carry `-0.015em` tracking; body
carries none. Uppercase group headers add `0.06em`.

Mono (`--font-mono`) is for code, file paths, commands and the terminal. A tool chip
that names a *file* is mono; one that names an *action* ("Created reviewer") is not.
That is how you tell a quotation from a sentence at a glance.

## 10. Spacing

`4 8 12 16 20 24 32 40 48`, via Tailwind's default scale. Rows are 44px in the sidebar,
40/44px in chrome strips, 36px for a control row, 28px for a chip row.

Transcript spacing comes from `gapBefore()` in the fixtures and is a rule, not a
judgement: same speaker 6px, change of speaker 20px, meta 12px, and a turn footer hugs
its reply at 6px.

## 11. Icons — one set, one weight

`lucide-react`, `size=16`, `strokeWidth=1.75`, and **only** through `src/ui/Icon.tsx`.
A glyph that is not in that map does not get drawn. The app's problem was two icon sets
at different weights in the same row; a single exported map makes that impossible rather
than merely discouraged.

Sizes in practice: 11–13px inside chips and metadata, 15–16px in chrome, 18–22px in
empty states. Provider marks go through `ProviderIcon`, which is the same map with a
lookup table, so a provider never brings its own drawing.

## 12. Motion

```
--ease-out    cubic-bezier(0.2, 0.9, 0.3, 1)
--dur-hover   120ms   shadow / background / colour
--dur-enter   180ms   popovers, menus, cards (scale from 0.98)
--dur-drawer  280ms   the right-hand drawer
```

Streaming text fades in per word over `120–420ms`, scaled to how fast tokens are
actually arriving. Every animation is inside `prefers-reduced-motion`'s reach: the block
at the bottom of `index.css` reduces durations to nothing, replaces the rotating ring
with a solid one, and turns the shimmer into plain dim text.

## 13. Syntax

Seven tokens, low chroma, tuned to sit on `--code-bg` in both themes:
`--syn-keyword` 300, `--syn-string` 150, `--syn-number` 50, `--syn-type` 230,
`--syn-fn` 265, `--syn-comment` neutral, `--syn-punct` neutral. Diff add/remove use
`--added-bg / --added-ink` and `--removed-bg / --removed-ink`, which are the same green
and red as `ok` and `error` at tint strength — a diff should not introduce a new palette.

## 14. What this replaces

| Kumo did | Canvas does |
| --- | --- |
| embossed buttons, flat sidebar | one ladder, `e1`–`e4`, every control presses |
| a spinner for `working` | a rotating arc on the agent's own face |
| a component library's colours | six surface tokens and one accent you choose once |
| two icon sets at two weights | one map, one weight, enforced by the import |
| no type scale | eight steps, `14/21` body |
