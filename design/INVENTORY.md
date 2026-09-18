# Crew renderer — functional inventory

The contract every prototype must satisfy. Read this before writing a line of UI.

Source of truth: `/home/agent/crew/src` (~15.5k lines, React 19 + Tailwind v4 + Kumo +
Base UI). Prototypes **do not import from it and do not modify it**. They reimplement
this behaviour against `design/shared` fixtures.

---

## 0. Ground rules for a prototype

- No backend. No `fetch`, no websocket, no Electron IPC. Everything comes from
  `@crew/fixtures`.
- The demo must be *complete*: every surface below reachable, every state visible.
- Keyboard bindings must actually fire.
- Light and dark must both work.
- Different layout/composition/typography is the point. Different **capability** is not:
  if the real app can do it, the prototype shows it.

---

## 1. Shell

```
┌──────────┬──────────────────────────────────────────┐
│ sidebar  │ tab bar (40px)                           │
│ (resize  ├──────────────────────────────────────────┤
│  200-560)│ surface: chat | terminal | file | diff   │
│          │                                          │
└──────────┴──────────────────────────────────────────┘
```

- Sidebar: collapsible (`Mod+B`), resizable by drag, width persisted.
- Sidebar has **two sliding views**: sessions (default) and settings. Settings slides
  over the session list; it never opens a tab.
- "Pages" (Settings, Routines, Search) cover the main area *over* the tabs. Tabs stay
  mounted underneath — opening a tab leaves the page first.
- macOS traffic-light reserve: 78px in the top-left. When the sidebar is hidden the
  reserve moves to the tab strip.

## 2. Workspaces

- A workspace is `{ id, name, path, createdAt }`. One is active.
- Workspace picker lives at the top of the sidebar: switch, create, rename, delete,
  reorder (drag).
- Sessions, tabs and files are all scoped to the active workspace.
- Bindings: `Mod+O` open, `Mod+Shift+O` switch picker, `Ctrl+Mod+[`/`]` step,
  `Ctrl+Mod+1..9` jump.

## 3. Sessions (the sidebar list)

Two kinds: `agent` (a chat with a provider) and `terminal` (a PTY).

Each row shows, subject to preferences: avatar, name, elapsed-since-updated,
provider+model line, status dot.

**Status** — `idle | working | needs-input | done | error`.
`idle` draws nothing. `working` is animated. `needs-input` and `working` share a colour
and differ in shape. `done` means "finished, unread". Ordering when grouped by status:
needs-input, error, working, done, idle.

**Sidebar preferences menu** (lives inside the search field):
- grouping: `none | kind | provider | status`
- ordering: `manual | updated | name`
- show: `provider`, `updated`, `status`, `avatar` (multi)
- hide kinds / hide providers
- Drag-reorder is only offered when ordering=manual AND grouping=kind AND not filtering.

**Selection**: click selects+opens. Cmd/Ctrl-click toggles, Shift-click ranges. A
multi-selection is held against the active tab and dropped when the tab changes.
Context menu on a row: Edit (agents) / Rename (terminals), Delete. With a
multi-selection: "Delete N items".
Keys on a focused row: `F2` rename, `Escape` clear selection, `Mod+Backspace` delete.

Search field filters the list live. Groups render as collapsible sections with a
hover-revealed `+`.

Fixed action rows above the list: New agent (`Mod+N`), New session (`Mod+Shift+N`),
Routines (`Mod+Shift+R`). Footer row: Settings (`Mod+,`).

## 4. Tabs

Three kinds: `session` (agent or terminal), `file`, `stub` (terminal / browser /
sidechat placeholders).

- Pill tabs, single 40px row, horizontal scroll with fade + caret controls at the edges.
- Each pill: icon (provider / robot / file-type / stub), title, and **one fixed
  trailing slot** holding three mutually exclusive things — status dot, close button
  (on hover), hotkey hint (while the modifier is held). Stacked so nothing resizes.
- Middle-click closes. Closing the active tab focuses the right neighbour, else left.
- Reopen closed tab (`Mod+Shift+T`), stack of 10.
- `Mod+1..8` jump, `Mod+9` last tab, `Mod+Shift+[`/`]` step (wrapping).
- `Mod+T` opens a **tab launcher** popover: new agent, new session, stubs, existing
  sessions.
- Closing a tab whose session is live raises a confirm dialog.

## 5. Chat (the big one)

### 5.1 Block model

```ts
Block = {
  id, role, text, at?, hidden?, streaming?,
  files?: AttachedFile[],
  tool?:     { callId, name, title, status: pending|completed|failed|interrupted, detail? },
  approval?: { requestId, name, input?, decided?: allow|always|deny },
  question?: { requestId, questions: Question[], answers?, dismissed? },
  usage?:    { inputTokens?, outputTokens?, costUsd?, durationMs? },
  fromAgent?: { id, name },      // another agent wrote this line
}
role = user | assistant | reasoning | tool | approval | question | system
```

`ToolDetail` is normalized across providers — this is what the row renders:
`command{command,exitCode?,output?}` · `file{path,lineStart?,lineEnd?,preview?}` ·
`edit{path,added?,removed?}` · `search{query,matches?}` · `fetch{url,title?}` ·
`message{to,text}` · `output{text}`

### 5.2 Row grouping

`blocks → rows`:
- `tool`, `approval`, `question`, `reasoning` collapse into one **activity** row.
- `user`, `assistant`, `system` are **message** rows.
- A turn's `usage` becomes a **footer** row under whatever ended the turn.
- A gap > 30 min before a user message inserts a **date** row.
- Spacing: same speaker 6px, change of speaker 20px, meta 12px, footer hugs its reply.

### 5.3 Activity anatomy

Inside an activity group, consecutive tool calls of the same *kind* form a **phase**
(`edit | research | run | other`). A phase with one settled call renders as a bare row.

- Phase folded line: "Editing 3 files", "Read tabs.ts", "Ran 8 commands", present
  tense while live, past once settled.
- ≥3 items in a group folds the whole run behind one **digest** line built from the two
  biggest kinds: "Ran 8 commands, read 2 files".
- Folded things open while live or while something inside needs an answer; a click pins
  them either way; moving to the next turn clears the pin.
- A failure inside a folded phase must still be visible on the folded line.
- Reasoning rows fold to their first line ("Thought" / the summary); open while
  streaming.

**Tool row body** (when opened): command output in a plain `<pre>` box with a head
("output" / "exit 1") and copy button; file preview syntax-highlighted; message to
another agent as a quoted box. Clipped output says "N more bytes not kept".

> **Known defect to fix, do not reproduce:** when a provider sends no `detail`, the row
> falls back to raw tool input and prints `{`. Every tool row must produce a human line
> — worst case "Used <tool name>".

### 5.4 Message rows

- **User**: right-aligned bubble, ink-on-canvas. `@path` runs render as file pills that
  open the file. Attachments are a separate strip *below* the bubble, never inside.
  Copy button appears on hover, outside the bubble.
- **Assistant**: full-width markdown. Prose sits in a bubble/column; code fences,
  tables, blockquotes and diffs break out to the full column width.
- **System note**: dim one-liner.
- **Date break**: centred, dim.
- **Turn footer**: "Worked for 3m 12s · 5:40 PM", tokens/cost in a tooltip.

### 5.5 Markdown requirements

Headings 1-6, bold/italic/strike, ordered/unordered/nested lists, task lists with a
custom check glyph, blockquotes (nested), tables **with internal horizontal scroll**,
horizontal rules, images, footnotes, inline code, links (with favicon, open external),
inline file paths as clickable chips, code fences with language label + copy, and
```diff fences rendered as a real diff.

Streaming: text fades in word by word, with the fade length adapting to how fast tokens
arrive. Settled paragraphs must not re-animate.

### 5.6 Agent-to-agent messages — **redesign this properly**

Today a message from another agent is `role=user` + `fromAgent`, rendered as a
one-line expandable "X messaged you". It was a patch. The target (per R3):

- Consecutive messages from the same agent **group**: "2 messages with Relay".
- Several agents in one run group as "3 messages with 2 agents".
- The line carries the sending agent's **avatar**.
- Clicking opens a thread view containing *only* the messages between those two agents,
  in chat form — not a generic collapsible.
- The sender's name opens that agent's tab.
- Outbound (`ToolDetail.kind === "message"`) and inbound (`fromAgent`) are two halves of
  the same conversation and should read as one thing.

### 5.7 Approval card

Raised when a tool needs permission. Shows what it *will* do: a diff for an edit, the
command for a shell call, raw input otherwise. Three actions: Deny, Always allow, Allow
(primary). Only the newest open card is "hot" and takes `Enter` (allow) / `Escape`
(deny). Once decided the row collapses to a normal tool line; denied rows read
struck-through.

### 5.8 Question card

`AskUserQuestion`. Multiple questions, one at a time, with a header strip to jump
between them (answered ones struck through). Single-select = radios, multi = checkboxes.
Each option has a letter keycap (A, B, C…) that picks it. Free-text "Something else"
field. Dismiss / Next / Submit. `Enter` advances, `Escape` dismisses, letters pick.
Answered cards collapse to "Question: chosen answer".

### 5.9 Composer

- Auto-growing textarea capped at 160px, 2 rows minimum.
- Placeholder `Message <agent name>`.
- `@` triggers a file mention picker (arrow keys, Enter/Tab to complete, Escape
  cancels). Completed mentions are highlighted in an overlay behind the textarea.
- Attach button (plus), model picker chip, send button. Send becomes **stop** while
  working.
- `Enter` sends, `Shift+Enter` newline.
- Paste an image → it becomes an attachment. Drag files over the pane → drop overlay.
- Attachment strip above the field with per-file remove.
- Empty chat: the composer is centred in the page, not pinned to the bottom.

### 5.10 Transcript behaviour

- Stick-to-bottom scroller with a 16px threshold; content growing above the reader
  (images, highlighting, fonts) must not move their line.
- "Earlier messages" header + auto-prefetch 600px from the top.
- A search hit scrolls a specific block into view, opens the folded phase holding it,
  and marks it with a fading highlight.
- "Thinking" line fills the gap between send and first token.
- Text selection is scoped: dragging selects words, not rails/timestamps; `Cmd+A`
  scopes to the transcript.

## 6. Command palette (`Mod+K`)

**Keep the shape — the user likes it.**
- One palette, five filters: All, Agents, Sessions, Files, Actions.
- `Mod+K` → All, `Mod+P` → Files, `Mod+Shift+P` → Actions. `Tab`/`Shift+Tab` cycle
  filters. A leading `>` jumps to Actions.
- Empty "All" shows 5 recent sessions + 5 actions.
- Fuzzy ranking. Grouped results with uppercase group headers.
- Rows: icon, label, dim detail, trailing status dot (sessions) or keycap (actions).
- Footer hint bar: ↑↓ Select · ⏎ Open · ⇥ Change filter.
- Arrow keys move, hover moves the cursor, Enter picks, Escape closes.

## 7. Search page (`Mod+Shift+F`)

Full-text over every message of every agent. Query field, segmented time range
(Any time / Today / 7 days / 30 days), agent filter select, sort (Best / Newest),
result count. Hit rows: session name, role label, day label, 2-line snippet with
`<mark>`ed matches. Clicking opens the agent and scrolls to that block.
Empty state and no-match state both required.

## 8. File editor

Tab header: relative path, unsaved dot, "plain text" badge for very large files, save
keycap. Body: syntax-highlighted, line-numbered, editable, virtualized. `Mod+S` saves.
Dirty tracking.

## 9. Diff view

Unified diff with syntax highlighting, add/remove line tinting, hunk headers, and file
headers. Used in three places: a ```diff fence in markdown, an approval card for an
edit, and a standalone diff surface. A split view variant is welcome.

## 10. Terminal

A real terminal surface. In the prototypes it is **faked**: render a static-but-
believable session (prompt, command, colourized output, a running command with a
cursor). Must include the chrome that surrounds it:
- Find in terminal (`Mod+F`) with match count and prev/next.
- Font size zoom (`Mod+=`, `Mod+-`, `Mod+0`).
- Terminal settings page: font family picker (from a list of installed monos), font
  size, cursor style, and a live preview.
- Paths in output are clickable and open a file tab.

## 11. Routines

A routine = a standing order: an agent, a prompt, a schedule.

- **Grid page**: title, "New routine" primary button, segmented filter (All / Active /
  Paused), cards in a 2-column grid. Card: provider avatar, name, 2-line prompt
  summary, schedule → agent line, Paused badge, failed-run warning.
- **Editor page** (full screen): breadcrumb back-link, Run now, Save, Delete. Fields:
  Title, Triggers, Instructions (10-row textarea), Workspace select, Agent select,
  Enabled switch in a card with a description, and a run-history list.
- **Trigger control**: Every 30 minutes / Every hour / Every 3 hours / Every day /
  Every week / Custom cron. Daily and weekly expose a time picker; weekly exposes
  day-of-week toggles; cron exposes a validated expression field.
- **Run history rows**: status mark (running spinner / ok check / skipped dash / error
  cross), day label, "manual" tag, duration.

## 12. Agent sheet (drawer)

Right-side drawer, 380px, slides in with a backdrop. Create or edit an agent.
Avatar tile, Name (with duplicate-name validation), Model picker, Description
textarea, "Run autonomously" switch card, "Notifications" switch card, "New routine"
button (edit mode only). Footer: Cancel (`Esc`) and Save/Create (`⌘⏎`) with keycaps.

## 13. Settings

**Keep the content layout — the user likes it.** Centred column, max ~3xl, generous
top padding, a page title, then titled sections; each section is a rounded card of rows
separated by hairlines; each row is `label + description` on the left, control on the
right.

Sections: General, Appearance, Terminal, Providers, Keybindings, About.
- Appearance: agent theme select (and, in the prototypes, theme light/dark/system).
- Keybindings: every command with its chord; make them editable.
- Terminal: font family, font size, live preview.
- Sections with nothing yet say so rather than 404.

## 14. Model picker

Grouped by provider (Claude, Cursor, Codex, opencode), each model with a label and an
optional note ("Most capable", "Free"). Two trigger shapes: a full-width field (in the
sheet) and a compact chip (in the composer). Shows provider icon + model label.

## 15. Dialogs / menus

- Confirm dialog: title, description, cancel + destructive action.
- Context menu at a point (right-click), with icons and destructive styling.
- Tooltips with a delay.
- Popovers anchored to sidebar rows.

## 16. Commands (bind them all)

| Command | Key |
| --- | --- |
| New Tab | `Mod+T` |
| Close Tab | `Mod+W` |
| Reopen Closed Tab | `Mod+Shift+T` |
| Next / Previous Tab | `Mod+Shift+]` / `[` |
| Go to Tab 1-8 / Last | `Mod+1..8` / `Mod+9` |
| Command Palette | `Mod+K` |
| Go to File | `Mod+P` |
| Show All Actions | `Mod+Shift+P` |
| Open Workspace | `Mod+O` |
| Switch Workspace | `Mod+Shift+O` |
| Next / Prev Workspace | `Ctrl+Mod+]` / `[` |
| Go to Workspace 1-9 | `Ctrl+Mod+1..9` |
| New Agent | `Mod+N` |
| New Session | `Mod+Shift+N` |
| Find in Terminal | `Mod+F` |
| Terminal font +/-/reset | `Mod+=` / `Mod+-` / `Mod+0` |
| Toggle Sidebar | `Mod+B` |
| Routines | `Mod+Shift+R` |
| Search Messages | `Mod+Shift+F` |
| Settings | `Mod+,` |
| Save File | `Mod+S` |

## 17. What the user said about the current design

**Keep:** command palette; settings content layout ("simple, terminal-like, it works");
routine forms are acceptable.

**Like but improve:** chat bubbles; tables scroll internally; the message-in-a-bubble /
widget-outside-a-bubble split; tool call rows.

**Hate:** the icons (two sets fight each other — local `icons.tsx` at stroke 1.75 and
Phosphor at its own weights).

**Patches to redesign as first-class:** "agent created by" attribution; agent-to-agent
messaging; missing avatars.

**Broken:** tool calls that render `{`; the sidebar loading spinner ("too dated");
Kumo's embossed buttons against a flat sidebar — no elevation model.
