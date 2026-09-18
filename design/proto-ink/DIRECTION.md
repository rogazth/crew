# Direction A — **Ink**

> Discipline. One ink, three surfaces, four elevations, one icon set. The window stops
> arguing with itself.

The current app has two design languages in it: Kumo's, which ships embossed controls,
and the hand-written chrome, which is flat. Ink's thesis is that the inconsistency is
not a styling bug, it is the absence of a **system**. So: derive everything from a very
small number of decisions and let nothing opt out.

Closest reference: Cursor's workbench (`/home/agent/crew/reference/cursor/` — read
`README.md` and `tokens.light.css`, they are extracted from the live app). Do **not**
copy its values verbatim; rebuild the idea with our own numbers.

---

## Colour — one ink over transparent

Light mode is three numbers and a mixing rule. Everything else is derived.

```
ink        oklch(0.185 0.004 265)     the only dark value in the theme
elevated   oklch(0.992 0 0)           editor, popovers, the canvas
chrome     oklch(0.978 0 0)           tab strip, headers
recessed   oklch(0.962 0 0)           sidebar, rails
```

Every text, icon, stroke and fill is `color-mix(in oklch, var(--ink) N%, transparent)`:

| Role | % ink | Used for |
| --- | --- | --- |
| text-primary | 100 | body, active labels |
| text-secondary | 74 | supporting text |
| text-tertiary | 58 | meta, timestamps |
| text-quaternary | 36 | placeholders, disabled |
| icon-primary | 100 | active icons |
| icon-secondary | 64 | resting icons |
| icon-tertiary | 50 | decorative glyphs |
| stroke-primary | 20 | focused field edge |
| stroke-secondary | 12 | hairlines, card edges |
| stroke-tertiary | 8 | table rules, dividers |
| fill-primary | 20 | pressed |
| fill-secondary | 14 | selected |
| fill-tertiary | 8 | hover |
| fill-quaternary | 5 | resting card |

Dark mode inverts the mixing base (`--ink` becomes near-white, surfaces become near-
black) and keeps **the same percentages**. That is the point: one table, two themes.

**Hue budget.** Exactly one accent (`oklch(0.56 0.14 250)` light / `0.72 0.12 250`
dark) and three status hues (attention amber, danger red, success green). Nothing else
in the app carries hue except syntax highlighting and user content. The primary button
is ink, not accent.

## Type

System sans only. `13px / 18px`, `letter-spacing: -0.08px`, weight 420 (variable) — one
notch above regular, which is what stops 13px from looking thin. Scale: `11/14`,
`12/16`, `13/18`, `15/24`, `20/26`. Tabular numbers everywhere a number can change
(timestamps, token counts, durations, line numbers).

Mono only for content that *is* code: fences, diffs, terminal, tool command lines,
inline code. Not for labels.

## Space & radius

Spacing: `2 4 6 8 10 12 14 16 20 24 32`. Nothing between.
Radius: `2 4 8 12 14 9999`. Rows and tabs share `10`; cards and popovers share `12`;
the composer takes `14`.

## Elevation — four levels, and nothing outside them

This is the answer to "Kumo's buttons have relief and the sidebar is flat".

| Level | Shadow | What may use it |
| --- | --- | --- |
| 0 | none | rows, tabs, sidebar, list items, the canvas |
| 1 | `0 1px 2px ink/6%` + inset hairline | resting controls: button, input, chip |
| 2 | `0 8px 24px ink/10%, 0 1px 2px ink/6%` + inset hairline | popovers, menus, tooltips |
| 3 | `0 24px 64px ink/18%, 0 2px 8px ink/8%` | dialogs, sheets, the palette |

No gradients. No inner highlight. A control is raised by **one** level and never by a
border *and* a shadow — the hairline is drawn with `box-shadow: inset 0 0 0 1px` so it
composes with the elevation instead of eating a pixel of layout.

## Icons — one set, no exceptions

`lucide-react`, `size 16`, `strokeWidth 1.5`, `absoluteStrokeWidth`. A 14px icon uses
`strokeWidth 1.75` so the optical weight matches. Build a thin `<Icon name="…">`
wrapper so a future swap is one file. **No second icon set anywhere**, including
provider marks — draw those as small monograms from the provider's initial in a tinted
square.

## Motion

Durations `50 / 100 / 150 / 200ms`. Easing `cubic-bezier(0.16, 1, 0.3, 1)` for
anything entering, `ease-out` for anything leaving. A popover enters with
`opacity 0 → 1` + `translate3d(0, -2px, 0) scale(0.98)` over 100ms. Nothing spins.

## Layout

Keep the app's shape — sidebar, tab strip, surface — because it works. The win is
coherence, not novelty. Two deliberate changes:

- The tab strip and the sidebar are the **same recessed surface**, so the chrome reads
  as one L-shaped frame around a single elevated canvas.
- The sidebar rail carries a 2px selected marker at level 0 instead of a filled row,
  so selection does not compete with the canvas.

## Chat

- User: right-aligned bubble, `fill-secondary`, radius 12, max 78% column.
- Assistant: no bubble. Full column of markdown. The *only* thing marking it as the
  agent's is the left rail (1px stroke-tertiary) that runs the height of the turn.
- Activity rows hang off that same rail, one line each, 18px tall.
- Tool bodies open into a level-0 box with an inset hairline, never a shadowed card.
- Tables scroll inside their own box; the box gets an inset hairline and a masked edge
  when it overflows.

## Status — kill the spinner

`working` is a **slow breathing dot**: 8px, attention hue, `scale 1 → 1.18` over 1.8s,
plus a halo at 18% that expands and fades. `needs-input` is the same dot, still, with a
ring. `done` is a filled dot in accent. `error` is a filled dot in danger. `idle` draws
nothing. One component, four states, one animation in the entire app.

The sidebar row for a working session also gets a 1px progress hairline along its
bottom edge that sweeps — that is the "loading indicator" the user wanted instead of a
spinner.

## Agent-to-agent messages

A grouped meta row on the rail:

```
◗ 2 messages with (avatar) Relay                              5:41 PM
```

Click opens an **inline panel** below the row — not a modal, not a drawer — holding the
exchange as a two-sided mini-transcript: their letters on the left with their avatar,
ours on the right. A footer link opens their tab. Several peers in one run read
`3 messages with 2 agents` and the panel groups by peer with a hairline between.

## What Ink must prove

That a single derivation table plus a four-level elevation scale is enough to make
every surface agree — and that "flat" does not mean "undifferentiated".
