# Console — the token spec

Everything in `src/styles/tokens.css`, plus the rules that decide which token a
component is allowed to reach for. Written to be portable: drop `tokens.css` into the
app, map the Tailwind theme (`src/styles/index.css`), and nothing else has to come with
it.

Four rules hold the whole system together.

1. **Greys carry the interface. Hue is data.** If you are reaching for colour to make
   something look better, you are reaching wrong.
2. **Four ink steps. Not five.**
3. **Radius is `3px` or `0`. There is no per-component radius decision.**
4. **Elevation is zero.** Separation comes from a 1px rule, a tone step, or a gap. One
   exception, below.

---

## 1. Surfaces

Four tones, one rule colour, and nothing in between. Light and dark are the same scale
inverted, not two palettes.

| Token | Light | Dark | Use |
| --- | --- | --- | --- |
| `--bg` | `oklch(0.985 0.002 250)` | `oklch(0.17 0.006 255)` | The window. Sidebar, tab strip, transcript, page. |
| `--raised` | `oklch(0.965 0.003 250)` | `oklch(0.205 0.007 255)` | One step up: a hovered row, a card, a user message, a table head, the status line. |
| `--sunken` | `oklch(0.945 0.004 250)` | `oklch(0.145 0.006 255)` | One step down: an input, a code box, a terminal body, a tool output. |
| `--rule` | `oklch(0.9 0.005 250)` | `oklch(0.3 0.008 255)` | Every hairline. The default `border-color` for the whole document. |
| `--rule-soft` | `oklch(0.93 …)` | `oklch(0.255 …)` | A rule that must be felt, not read. |
| `--rule-strong` | `oklch(0.82 …)` | `oklch(0.4 …)` | A control's edge, a scrollbar thumb, a blockquote rail, the floating ring. |

Adjacent surfaces differ by exactly one step. Two steps means something is wrong with
the hierarchy, not with the token.

## 2. Ink — four steps, no more

| Token | Value | Use |
| --- | --- | --- |
| `--ink` | `oklch(0.22 0.008 250)` / `oklch(0.92 0.006 255)` | The thing you are reading. Body text, an active row, a heading. |
| `--ink-2` | `ink` at 68% | Secondary prose: agent replies, descriptions, a tool row's target. |
| `--ink-3` | `ink` at 46% | Labels, section headings, inactive controls. |
| `--ink-4` | `ink` at 32% | Structure: gutter labels, timestamps, counts, keycaps, placeholders. |
| `--on-ink` | `= --bg` | Text on an inverted chip (an active tab, a primary button, the status-line mode cell). |

The steps are `color-mix(in oklab, var(--ink) N%, transparent)`, so they stay correct on
any of the four surfaces without a second set of values.

**Emphasis is inversion, never colour.** A primary button is `--ink` on `--on-ink`. An
active tab is the same. That is the only "loud" move the system has, and it is
achromatic on purpose: it survives being next to an amber status mark.

## 3. Hue is reserved for meaning

| Token | Means | Where it is allowed |
| --- | --- | --- |
| `--amber` / `--amber-ink` | working · needs input · queued | A status mark, the progress rule, the hot approval border, a "N queued" chip, a Paused badge. |
| `--red` / `--red-ink` / `--red-wash` | error · failed · removed | A failed tool line, `exit 1`, a destructive action, a removed diff line, a validation message. |
| `--green` / `--green-ink` / `--green-wash` | ok · added | A passing run, an added diff line, a checked task box. |
| `--accent` / `--accent-ink` / `--accent-wash` | the one accent | Focus ring, selection, links, file chips, the current search match. Never decoration. |
| `--done` | finished, unread | The `done` status mark only. |
| `--mark` | a search hit | `<mark>` in a snippet, the fading highlight on a jumped-to block. |
| `--select` | text selection | `::selection`. |

`working` and `needs-input` deliberately share the amber hue and differ in **shape** (a
marching bar cycle vs a still dot), so they are distinguishable without colour vision.

### Identity tints

An avatar or a provider monogram gets its **hue from the seed** (`identityFor(name).hue`)
and every other channel from a token, so a generated mark can never fight the palette:

```
--id-l    0.42 / 0.82   foreground lightness
--id-c    0.10 / 0.09   chroma
--id-bg-l 0.68 / 0.60   tile lightness
--id-bg-a 0.20 / 0.22   tile alpha
```

```css
background: oklch(var(--id-bg-l) var(--id-c) <hue> / var(--id-bg-a));
color:      oklch(var(--id-l)    var(--id-c) <hue>);
```

### Syntax — code only

`--syn-kw · --syn-str · --syn-num · --syn-com · --syn-fn · --syn-type · --syn-punct ·
--syn-attr · --syn-meta`, exposed as the classes `.tok-kw`, `.tok-str`, … A token class
appears inside a `<pre>`, a diff line, or a terminal buffer. Nowhere else.

Diff tints are separate so they can sit under syntax without muddying it:
`--add-bg`, `--add-gut`, `--del-bg`, `--del-gut`.

Terminal tones are aliases, not new colours: `--term-prompt`, `--term-path`, `--term-ok`,
`--term-warn`, `--term-error`, `--term-accent`.

## 4. Type — mono is a semantic role

Two families, and the split is semantic, not aesthetic.

```
--font-sans  ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, …
--font-mono  ui-monospace, "SF Mono", Menlo, "Cascadia Mono", Consolas, …
```

- **Sans** — prose. Agent replies, descriptions, empty states, option labels, button
  labels.
- **Mono** — *everything structural*: paths, commands, keys, identifiers, numbers,
  timestamps, tool lines, sidebar metadata, table cells, column headers, section
  headings, tab labels, the status line, every chrome label.

If you cannot say which of those two a piece of text is, it is prose.

| Token | Size / line | Use |
| --- | --- | --- |
| `--t-xs` / `--lh-xs` | 11 / 15 | Keycaps, counts, gutter labels, section headings, badges. |
| `--t-sm` / `--lh-sm` | 12.5 / 18 | Mono body: tool lines, code, sidebar rows, tab labels. |
| `--t-md` / `--lh-md` | 13 / 18 | Sans body. The default. |
| `--t-lg` / `--lh-lg` | 15 / 22 | A page title, the palette input, an `h2`. |
| `--t-xl` / `--lh-xl` | 18 / 24 | An `h1`. Used about twice. |

Two weights: 400 and 600. No 500, no 700. `font-variant-numeric: tabular-nums` is set on
`body`, so every column of numbers lines up without asking.

## 5. Space and radius

4px grid: `--s1 4 · --s2 8 · --s3 12 · --s4 16 · --s5 24 · --s6 32`.

`--r: 3px`. A component is allowed `var(--r)` or `0`. The base layer sets
`border-radius: 0` on `*` so a stray `rounded-lg` from a copied snippet cannot land
silently. The only round thing in the app is a 6px status dot and an avatar corner.

## 6. Density

One token changes, and everything derived from it follows:

| Token | Comfortable | Compact |
| --- | --- | --- |
| `--row-h` | 28px | 22px |
| `--row-pad-x` | 8px | 6px |
| `--control-h` | 26px | 22px |
| `--log-lead` | 6px | 4px |
| `--log-gutter` | 164px | 146px |
| `--log-measure` | 600px | 560px |
| `--log-pad` | 16px | 12px |
| `--t-md` / `--lh-md` | 13 / 18 | 12.5 / 17 |

Set with `data-density="compact"` on `<html>`. Compact fits ~45 sidebar rows in a
900px-tall window. Nothing else in the app knows density exists — that is the test.

## 7. Chrome sizes

```
--h-header  28px    the workspace crumb strip, which also holds the traffic-light reserve
--h-tabs    26px    the numbered tab strip, the chat header, a dialog header
--h-status  22px    the permanent status line
--traffic   78px    macOS traffic-light reserve
--sidebar-w 268px   default; resizable 200–560 and persisted
```

## 8. Elevation — the one exception

There is no elevation scale, because there is no elevation. Separation is:

1. a 1px `--rule`,
2. a tone step between adjacent surfaces,
3. the gap.

A **floating layer** — a menu, a popover, the palette, a dialog, the agent sheet — is the
only thing allowed to leave the plane, and it gets exactly one treatment:

```css
--float-ring:   0 0 0 1px var(--rule-strong);
--float-shadow: 0 4px 16px rgb(0 0 0 / 0.12);   /* 0 6px 20px / 0.5 in dark */
--float: var(--float-ring), var(--float-shadow);
```

applied through the `.float` class. Enough to say "this is above". Not enough to look
glossy. Nothing else in `src/` may set `box-shadow`.

## 9. Focus

One treatment, defined once in the base layer and never overridden:

```css
:focus-visible {
  outline: 1px solid var(--accent);
  outline-offset: 1px;
  border-radius: var(--r);
}
```

A 1px accent ring at radius 3 with a 1px offset. Visible on grey, never glowing. No
component ships its own focus style; if one is invisible, the fix is the layout, not a
second ring.

## 10. Motion

```
--fast 90ms    a hover, a colour change
--base 140ms   a popover appearing, a switch
--slow 220ms   the sidebar sliding between its two views, the agent sheet
--ease cubic-bezier(0.32, 0.72, 0.3, 1)
```

Named animations: `fade-word` (streaming), `bar-march` (the working mark),
`rule-fill` (the sidebar busy rule), `blink` (a terminal cursor), `hl-flash` (a search
hit landing), `slide-up`, `slide-left`.

`prefers-reduced-motion: reduce` clamps every animation and transition to 1ms globally
and freezes the working mark at its middle frame, so it still reads as a mark.

## 11. Icons

Prefer a **letter, a number, or a keycap** over a glyph:

- A provider is a two-letter mono monogram in a tinted box: `cl`, `cx`, `cd`, `oc`.
- A terminal is `›_`.
- A file type is its extension, two characters.
- A tab's binding is its number.
- A fold is `▸` / `▾`. A direction is `←` / `→`. A thought is `···`.

Where an icon genuinely carries meaning that no word can, it is `lucide-react` at
`size={13}`–`14`, `strokeWidth={1.25}`, and never beside text that already says the same
thing. One icon set, one weight, one size — the two-sets-fighting problem does not
recur because there is only one.

## 12. What earns what — the short version

| Move | Earned by |
| --- | --- |
| A tone step | Two regions that must be told apart and are adjacent. |
| A 1px rule | Two regions that must be told apart and are not adjacent. |
| A shadow | Being a floating layer. Nothing else, ever. |
| Colour | Being information: a state, a delta, a match, a link, a focus. |
| Inversion (`--ink` background) | Being the one active thing in a set: the active tab, the primary action, the status-line mode. |
| Mono | Being structural rather than prose. |
| An icon | Having no word short enough. |
| Motion | Being live. Not being new. |

## 13. Porting into the app

1. Copy `src/styles/tokens.css` verbatim. It has no dependencies.
2. Copy the `@theme inline` block from `src/styles/index.css`. It maps every token onto
   a Tailwind utility name (`bg-raised`, `text-ink-3`, `border-rule`, `text-md`, …), so
   components never write `var(--…)` for anything the utility layer covers.
3. Copy the `@layer base` block. The base reset is load-bearing: the global
   `border-color`, the `border-radius: 0`, the single `:focus-visible`, `tabular-nums`.
4. Copy the `@layer components` block for `.float`, `.scroll`, `.grouprule`,
   `.tok-*`, `.bars`, `.progress-rule`, `.caret`, `.fade-word`, `.hl-flash`.
5. Resolve the theme in JS before first paint and set `data-theme` / `data-density` on
   `<html>` — `system` resolves through `matchMedia`, so a headless screenshot with
   `colorScheme: "dark"` gets the dark palette without any extra wiring.

The grep that keeps it honest:

```bash
grep -rnE '#[0-9a-fA-F]{3,8}\b|rgba?\(|box-shadow' src/ui src/chrome src/surfaces
```

It should return nothing.
