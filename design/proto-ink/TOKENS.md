# Ink — the token spec

Everything the prototype paints comes from this file's list. It is written to be
copied into the real app: `src/styles/tokens.css` is the implementation, this is the
contract and the rules for using it.

The whole system is **four decisions plus one table**. Change the four numbers and you
have a new theme; change the table and you have a new design.

---

## 1. The four decisions

```css
--ink               /* the only dark value in a light theme            */
--surface-canvas    /* the editor, the transcript, popovers            */
--surface-chrome    /* headers, composer, cards, the tab pill          */
--surface-recessed  /* sidebar, tab strip — the L-shaped frame         */
--surface-sunken    /* behind everything; the window frame             */
```

| Token | Light | Dark |
| --- | --- | --- |
| `--ink` | `oklch(0.185 0.004 265)` | `oklch(0.965 0.003 265)` |
| `--surface-canvas` | `oklch(0.992 0 0)` | `oklch(0.214 0.005 265)` |
| `--surface-chrome` | `oklch(0.978 0 0)` | `oklch(0.192 0.005 265)` |
| `--surface-recessed` | `oklch(0.962 0 0)` | `oklch(0.172 0.005 265)` |
| `--surface-sunken` | `oklch(0.945 0 0)` | `oklch(0.14 0.005 265)` |

Dark mode inverts the mixing base and keeps every percentage below identical. That is
the point of the system: **one table, two themes.** There is no second set of colour
values to keep in sync, so the two themes cannot drift.

## 2. The derivation table

Every text, icon, stroke and fill in the app is
`color-mix(in oklch, var(--ink) N%, transparent)`.

| Token | % ink | Used for |
| --- | --- | --- |
| `--text-primary` | 100 | body copy, active labels, code |
| `--text-secondary` | 74 | supporting text, assistant prose |
| `--text-tertiary` | 58 | meta, tool lines, descriptions |
| `--text-quaternary` | 36 | placeholders, timestamps, disabled |
| `--icon-primary` | 100 | active icons |
| `--icon-secondary` | 64 | resting icons |
| `--icon-tertiary` | 50 | decorative glyphs, tool-row glyphs |
| `--stroke-primary` | 20 | focused field edge, scrollbar thumb |
| `--stroke-secondary` | 12 | hairlines, card edges |
| `--stroke-tertiary` | 8 | table rules, dividers, the turn rail |
| `--fill-primary` | 20 | pressed |
| `--fill-secondary` | 14 | selected, the user bubble |
| `--fill-tertiary` | 8 | hover |
| `--fill-quaternary` | 5 | resting card, current-line band |

Tailwind aliases (via `@theme inline`, so a theme flip is one attribute and no
rebuild): `text-primary/secondary/tertiary/quaternary`, `text-icon`,
`text-icon-strong`, `text-icon-faint`, `border-line`, `border-line-soft`,
`bg-fill-1..4`, `bg-canvas`, `bg-chrome`, `bg-recessed`, `bg-sunken`.

**Rule:** a component never writes a colour. It picks a row from this table. If a
component needs a colour that is not here, either the table is wrong or the component
is.

## 3. The hue budget

Exactly four hues exist outside syntax highlighting and user content.

| Token | Light | Dark | Means |
| --- | --- | --- | --- |
| `--accent` | `oklch(0.56 0.14 250)` | `oklch(0.72 0.12 250)` | "this is the thing you are on" |
| `--status-attention` | `oklch(0.72 0.15 72)` | `oklch(0.79 0.14 76)` | working / needs you |
| `--status-danger` | `oklch(0.56 0.2 26)` | `oklch(0.7 0.17 26)` | failed / destructive |
| `--status-success` | `oklch(0.58 0.13 150)` | `oklch(0.74 0.13 152)` | added lines, healthy |

Each has a derived fill and stroke at fixed strengths, so a tinted surface is never
hand-mixed at the call site:

```
--accent-fill      accent  14%    --accent-stroke   accent  34%
--danger-fill      danger  12%    --danger-stroke   danger  30%
--attention-fill   attention 16%  --attention-stroke attention 34%
--success-fill     success 14%
--focus-ring       accent  58%
--mark-fill        attention 34%   /* search hits */
```

**What earns hue**

- `--accent`: the selected sidebar marker, the palette cursor, links, the focus ring,
  the `done` status dot, a checked control. Nothing else. **The primary button is ink,
  not accent** — accent means "you are here", and a button is not a place.
- `--status-attention`: the `working` and `needs-input` dots, the sidebar sweep, the
  hot approval and question cards, the unsaved dot, a search mark.
- `--status-danger`: a failed tool line, a denied approval, a destructive action.
- `--status-success`: added diff lines, a healthy run, a "Ready" badge.
- Everything else in the window is ink over a surface.

Agent identity is the one sanctioned exception: an avatar's hue comes from
`identityFor(seed).hue`, held at a fixed lightness and chroma so every mark in the
window agrees:

```
--avatar-l: 0.56 / 0.76   --avatar-c: 0.13 / 0.12
tile background  color-mix(in oklch, var(--tint) 20%, var(--surface-canvas))
tile ink         color-mix(in oklch, var(--tint) 88%, var(--ink))
```

Provider marks deliberately carry **no** hue: they are the provider's initial on
`--fill-tertiary`. One icon set means no second icon set, and a wordmark is a second
icon set wearing a hat.

## 4. Elevation — four levels, and nothing outside them

This is the answer to "Kumo's buttons have relief and the sidebar is flat".

| Level | Class | Shadow | What may use it |
| --- | --- | --- | --- |
| 0 | — | none | rows, tabs, sidebar, list items, the canvas, tool bodies, segmented tracks |
| 1 | `e1` | `0 1px 2px ink/6%` + inset hairline | resting controls: button, input, chip, the composer, the active tab pill |
| 2 | `e2` | `0 8px 24px ink/10%, 0 1px 2px ink/6%` + inset hairline | popovers, menus, tooltips, the mention picker, the terminal find bar |
| 3 | `e3` | `0 24px 64px ink/18%, 0 2px 8px ink/8%` | dialogs, the agent sheet, the command palette |

Plus two hairline-only helpers for level-0 boxes that still need an edge:

```
--hairline        inset 0 0 0 1px var(--stroke-secondary)   .hairline
--hairline-soft   inset 0 0 0 1px var(--stroke-tertiary)    .hairline-soft
```

**Rules**

1. A control is raised by **one** level, never by a border *and* a shadow.
2. The hairline is drawn with `box-shadow: inset 0 0 0 1px`, so it composes with the
   elevation instead of eating a pixel of layout. Nothing in Ink uses `border` except
   the 1px section rules that are genuinely structural (a card's row divider, a header's
   bottom edge).
3. Elevation never encodes state. Hover and selection change **fill**, not shadow — a
   control that lifts on hover moves the text under the reader's cursor.
4. No gradients, no inner highlight, no ring-plus-shadow.

## 5. Type

System sans only. `13px / 18px`, `letter-spacing: -0.08px`, weight **420** — one notch
above regular, which is what stops 13px from looking thin.

| Token | Size / line | Used for |
| --- | --- | --- |
| `--text-micro` | 11 / 14 | timestamps, keycaps, group headers, meta |
| `--text-small` | 12 / 16 | tool lines, descriptions, table cells, code |
| `--text-body` | 13 / 18 | the default: labels, rows, buttons, inputs |
| `--text-prose` | 15 / 24 | transcript messages, both sides |
| `--text-title` | 20 / 26 | page titles |

Weights: `--weight-normal: 420`, `--weight-medium: 520`, `--weight-strong: 620`.

**Tabular numbers everywhere a number can change** — timestamps, token counts,
durations, line numbers, match counts, font sizes. The `tnum` class and the `time`
element both set `font-variant-numeric: tabular-nums`; a number that reflows as it
counts is a number that drags the eye.

**Mono only for content that *is* code**: fences, diffs, the terminal, tool command
lines, inline code, file paths. Never for labels, never for "technical" flavour.
`--font-mono` with `font-variant-ligatures: none`.

## 6. Space & radius

Spacing ladder, and nothing between: `2 4 6 8 10 12 14 16 20 24 32`.

| Token | Value | Used for |
| --- | --- | --- |
| `--radius-xs` | 2 | keycaps, marks, the smallest chips |
| `--radius-sm` | 4 | inline chips, tab hotkeys, segmented thumbs |
| `--radius-md` | 8 | buttons, inputs, menu items, tool bodies |
| `--radius-row` | 10 | sidebar rows and tab pills (they share it on purpose) |
| `--radius-card` | 12 | cards, popovers, dialogs, message bubbles |
| `--radius-composer` | 14 | the composer, and only the composer |
| `--radius-full` | 9999 | dots, switches, the send button |

Shell metrics: `--tabstrip-h: 40px`, `--traffic-reserve: 78px`,
`--sidebar-min: 200px`, `--sidebar-max: 560px`.

## 7. Motion

Durations `--dur-1: 50ms`, `--dur-2: 100ms`, `--dur-3: 150ms`, `--dur-4: 200ms`.
Easing `--ease-enter: cubic-bezier(0.16, 1, 0.3, 1)` for anything entering,
`--ease-leave: ease-out` for anything leaving.

- A popover enters with `opacity 0 → 1` + `translate3d(0, -2px, 0) scale(0.98)` over
  100ms (`.ink-pop`).
- A dialog backdrop fades over 150ms (`.ink-backdrop`); the sheet slides 12px
  (`.ink-sheet`).
- **Nothing spins.** There is no spinner token because there is no spinner.
- There is exactly **one** looping animation in the app: `ink-breathe` (the status
  dot, `scale 1 → 1.18` over 1.8s) and its paired `ink-halo`. The sidebar's busy
  signal, `ink-sweep`, is the same idea as a hairline along the row's bottom edge.
- Streaming text uses `ink-fade` with a `--fade-dur` the caller sets from the observed
  token rate (120–420ms).
- `prefers-reduced-motion` kills every animation and transition globally; so does
  `:root[data-motion="reduced"]`, which the Appearance settings write.

## 8. Status

One component, four states, one animation.

| Status | Shape | Colour |
| --- | --- | --- |
| `idle` | nothing drawn | — |
| `working` | 8px dot, breathing, with an 18% halo | `--status-attention` |
| `needs-input` | 5px dot held still inside a 1.5px ring | `--status-attention` |
| `done` | 8px filled dot | `--accent` |
| `error` | 8px filled dot | `--status-danger` |

`working` and `needs-input` share a colour and differ in shape, so they read as one
family at a glance and still resolve on a second look. A sidebar row whose session is
`working` also carries the `ink-sweep` hairline along its bottom edge — that is the
loading indicator, and it replaced a spinner.

## 9. Syntax and diff

Highlighting is the one place hue is free, but it still lands on tokens so the theme
owns it: `--syn-keyword`, `--syn-string`, `--syn-number`, `--syn-comment`,
`--syn-function`, `--syn-type`, `--syn-variable`, `--syn-property`, `--syn-tag`,
`--syn-attribute`, `--syn-punctuation`, `--syn-regexp`. Each has a `.tok-*` class.

Diffs: `--diff-add-bg` / `--diff-add-gutter` / `--diff-del-bg` / `--diff-del-gutter`
derive from the success and danger hues at 10–34%, and `--diff-hunk-fg` borrows
`--syn-function`.

Terminal tones map the fixture's semantic `Tone` to `--term-default`, `--term-dim`,
`--term-prompt`, `--term-path`, `--term-ok`, `--term-warn`, `--term-error`,
`--term-accent`, `--term-added`, `--term-removed` — so a buffer is painted by the
theme, not by ANSI escape codes.

## 10. Icons

`lucide-react`, size 16, `strokeWidth 1.5`, `absoluteStrokeWidth`. A 14px icon uses
`strokeWidth 1.75` so the optical weight matches; a 12px icon in a tool row uses the
same rule.

Every icon in the app goes through `src/lib/icon.tsx`, which is a name → component map
and a single `<Icon name size />` wrapper. **There is no second icon set anywhere**,
including provider marks. Swapping icon libraries is one file.

## 11. Porting checklist

1. Copy `src/styles/tokens.css` verbatim. It has no Tailwind dependency.
2. Copy the `@theme inline` block from `src/styles/index.css` — that is what makes
   `bg-canvas`, `text-tertiary`, `rounded-row` and friends exist.
3. Copy the `@layer components` block: `.e1/.e2/.e3`, `.hairline`, `.ink-pop`,
   `.ink-backdrop`, `.ink-sheet`, `.ink-dot*`, `.ink-sweep`, `.ink-fade-in`,
   `.ink-caret`, `.ink-flash`, `.ink-scroll`, `.ink-mask-x`, `.ink-mono`, `.tok-*`.
4. Delete `@cloudflare/kumo`. Every Kumo control has a level in the table above; none
   of them needs a second opinion about elevation.
5. Grep the app for `#`, `rgb(`, `rgba(` and bare `oklch(` under `src/` — in Ink the
   only legal matches are inside `tokens.css`.
