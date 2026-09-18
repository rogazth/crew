# Direction B — **Console**

> The settings page is the best screen in the app because it reads like a terminal.
> Console asks: what if the whole app did?

The user said the settings content layout works because it is "simple, like a terminal".
Console takes that as the thesis for the entire window: dense, aligned, keyboard-first,
monospace where monospace means something, and **zero decoration**. Not a retro ANSI
skin — a modern developer console that happens to be extremely legible.

Nearest spirit: a well-configured tmux + helix + lazygit, rendered by a designer.

---

## Colour — near-monochrome, hue is data

```
light:  bg 0.985  ·  raised 0.965  ·  sunken 0.945  ·  rule 0.90  ·  ink 0.22
dark:   bg 0.17   ·  raised 0.205  ·  sunken 0.145  ·  rule 0.30  ·  ink 0.92
```

Text: `ink` at 100 / 68 / 46 / 32 percent. Four steps, no more.

**Hue is reserved for meaning.** The greys carry the whole interface; colour appears
only where it is information:

| Hue | Means |
| --- | --- |
| amber | working, needs input |
| red | error, failed, removed lines |
| green | ok, added lines |
| blue | the one accent: focus, selection, links |
| syntax palette | code only |

A button is grey. A tab is grey. The sidebar is grey. If you are reaching for colour to
make something *look* better, you are reaching wrong.

## Type — mono is a first-class role

Two families, and the split is semantic, not aesthetic:

- **Sans** (system UI, 13/18): prose. Agent replies, descriptions, empty states.
- **Mono** (`ui-monospace`, 12.5/18): **everything structural** — paths, commands, keys,
  identifiers, numbers, timestamps, tool lines, sidebar metadata, table cells, column
  headers, the status line, tab labels.

That split is the whole typographic system. Tabular figures always. Sizes: `11/15`,
`12.5/18`, `13/18`, `15/22`, `18/24`. One weight step only: 400 and 600.

## Density

A density token (`comfortable` / `compact`) that changes one variable, `--row-h`
(28px / 22px), and the paddings derived from it. Ship a toggle in Appearance settings.
Compact should fit ~45 sidebar rows on a 900px-tall window.

## Space, radius, elevation

Spacing is a 4px grid: `4 8 12 16 24 32`. **Radius is 3px, everywhere, or 0.** A
rounded corner is not a design decision you get to make per component here.

**Elevation is zero.** Separation comes from three tools only:
1. a 1px rule (`--rule`),
2. a tone step between adjacent surfaces,
3. the gap.

The only exceptions: a floating layer (menu, palette, dialog) gets `0 0 0 1px rule` plus
`0 4px 16px black/12%` — enough to say "this is above", not enough to look glossy.

## Layout — the status line is real chrome

```
┌────────────────────────────────────────────────────────────┐
│  workspace ▸ crew                              ⌘K  ⌘P  ⌘,  │   header, 28px
├───────────────┬────────────────────────────────────────────┤
│ 1 harness   ● │ [1 harness] [2 Relay] [3 tabs.ts] [4 ⌨] │   tab strip, 26px
│ 2 Relay  ◐ ├────────────────────────────────────────────┤
│ 3 renderer    │                                            │
│ 4 daemon      │  surface                                   │
│ ─ sessions ── │                                            │
│ 5 build     ● │                                            │
├───────────────┴────────────────────────────────────────────┤
│ NORMAL  s-harness  claude/opus-5  working  ⏎ send  ⌘K menu │   status line, 22px
└────────────────────────────────────────────────────────────┘
```

- **Tabs are a numbered strip**, not pills: `[1 harness]`, `[2 Relay]`. The number is
  the binding. Active tab is inverted (ink background, bg text) or underlined — pick one
  and hold it. No close button until hover; middle-click always works.
- **The sidebar is an indexed list**, not cards. Each row: index, name, right-aligned
  mono meta. Groups are a dim rule with a label sitting on it (`── sessions ──────`).
- **A permanent status line** across the bottom, showing: the active session, its
  provider/model, its state, and the two or three chords that matter *right now*
  (context-sensitive — it changes in the terminal, in the editor, in the palette).
  This replaces scattered hint text.

## Chat — a log, not a chat app

**No bubbles.** The transcript is a two-column log:

```
 you    5:41 PM │ Tomemos el seam multi-provider en serio.
                │
 ···            │ Thought for 4s
 grep           │ ToolDetail::                              34 matches
 read           │ crates/crew-core/src/providers/mod.rs       1–42
 edit           │ src/lib/toolDetail.ts                      +6 −2
                │
 opus-5 5:42 PM │ El tipo ya existe en Rust y en TS, pero sólo el
                │ adaptador de Claude lo llena.
                │
                │ 1. providers/mod.rs — una función normalise(raw)
                │ 2. providers/codex.rs — mapear exec_command
                │
                │ 18.4k in · 620 out · $0.09 · 21s
```

- Left gutter, fixed width, mono, dim: **who** and **when** for messages, **the verb**
  for tool rows (`grep`, `read`, `edit`, `run`, `fetch`, `msg`). A vertical rule
  separates gutter from content.
- Tool rows are one line: verb, target, right-aligned result (`34 matches`, `+6 −2`,
  `exit 1`, `1–42`). The right alignment is what makes a run scannable.
- A phase folds into `read ▸ 12 files` and opens in place, indented under a rail.
- Reasoning is `···` in the gutter and dim italic-free text in the column.
- Turn footer is one dim mono line, no tooltip needed — the numbers fit.
- Markdown still renders fully (tables, lists, fences) but sits in the content column
  at full width. Code fences get no chrome beyond a top rule and a right-aligned
  language tag.

## Status — no spinners, no dots that just sit there

Use glyph + motion sparingly:
- `working`: a **three-cell braille/bar cycle** in the gutter — `▁▃▅` marching, 500ms
  per step. It reads as activity at a glance and as texture from far away.
- `needs-input`: `●` amber, still, plus the row gets a left border.
- `error`: `✕` red. `done`: `●` dim blue. `idle`: nothing.
- The sidebar "loading" is a **1px underline that fills left-to-right and resets** on
  the row — a progress rule, not a spinner.

## Keyboard is the primary interface

- Every actionable row shows its chord, right-aligned, in a dim keycap.
- `?` opens a full shortcut sheet.
- The palette supports `>` for actions, `@` for agents, `#` for messages, `:` for line
  numbers in a file — prefix routing, vim/VS Code style.
- Arrow keys move focus in the sidebar; `Enter` opens, `Space` previews, `d d` deletes
  with a confirm.
- Focus is a 1px accent ring at radius 3 with a 1px offset — visible on grey, never
  glowing.

## Icons — barely any

Prefer a **letter, a number, or a keycap** over a glyph. Where an icon is genuinely
needed, use `lucide-react` at `strokeWidth 1.25`, size 14, and never next to text that
already says the same thing. Provider "icons" are mono monograms: `cl`, `cx`, `cd`,
`oc` in a 14px tinted box.

## Agent-to-agent messages

They are routed log lines. Inbound and outbound share a gutter verb, `msg`:

```
 msg  ← relay │ 2 messages                                  ▸
 msg  → scribe   │ Borrá `hidden` de los bloques de tool…
```

Expanding a group indents a two-column exchange under it, keeping the same gutter, with
`←` / `→` marking direction. The peer's name is a link to its tab. No avatars in the
log itself — but the **expanded thread header** carries one, because that is where
identity matters.

## What Console must prove

That density and restraint beat decoration for a tool someone stares at all day — and
that a transcript reads better as an aligned log than as a stack of bubbles.
