# Composer controls — model, effort and access

**Status:** built 2026-10-02 (phases 1–4, §5). Decisions in §6.

## 0. What is wanted

- Home's composer (`src/surfaces/HomeStart.tsx`) picks a provider with a plain
  `Select`. It should use the `ModelPicker` the agent sheet and Settings already
  use (`src/chrome/ModelPicker.tsx`, whose `chip` trigger was drawn for a
  composer and is used nowhere).
- Two new controls beside it: **effort** (how hard the model thinks) and
  **access** (what it may do without asking).
- The same three controls in the chat's composer (`src/surfaces/chat/Composer.tsx`),
  shared by sessions and agents through `DefaultChatSurface`.

## 1. What the references do

| | Model | Effort | Access | Mid-session change |
|---|---|---|---|---|
| **t3code** | chip, provider rail + list | "traits" chip, options from the model's metadata, `Default` badge | select: Supervised / Auto-accept edits / Auto / Full access, per thread; + Plan/Build toggle (⇧Tab) | saved on the thread, applied on next send: restart with resume |
| **monocode** | chip, provider tabs + search (⌘.) | chip per setting ("High") | chip: same four modes, same copy as t3code | next send respawns the CLI if any setting changed |
| **zeron** | one chip "Opus 5 · High", effort in a tray inside the popover | ladder per model, clamped on model change | none (always full) | next send replaces the runtime and resumes |
| **orca** | pill | pill ("High · Fast") | global Yolo / Manual in Settings | **types `/model` and `/effort` into the terminal** — the only one that, like Crew, drives a TUI |
| **cursor** | chip showing "High" (effort folded into the model) | — | Plan via ⇧Tab | — |
| opencodex, grok-bot | no composer controls | config / env | global or per-session form | — |

What they agree on, and Crew takes:

1. **Three chips in the composer's footer row**, left of send: model, effort,
   access. Compact chips (`h-7`, rounded-full, hairline), each opening upward.
2. **Access is four named modes** with one-line descriptions (t3code/monocode
   copy, rewritten in Crew's voice). Per session; new ones take the default.
3. **Effort options come from the provider/model**, with the CLI's own default
   first, and a value the new model does not offer falls back to Default.
4. **Provider is locked once a session has started** (t3code, zeron). Agents are
   the exception: Crew already lets them switch.
5. **A change mid-session applies on the next message**, never interrupts a turn.

## 2. The model

### Access

| Mode | Label | Description | Claude | Codex | Cursor | opencode |
|---|---|---|---|---|---|---|
| `ask` | Ask permission | Asks before every edit and command. | — | — | — | — |
| `edits` | Accept edits | Edits files on its own, asks before commands. | `--permission-mode acceptEdits` | ✗ | ✗ | ✗ |
| `auto` | Auto | Runs routine actions, asks only for risky ones. | `--permission-mode auto` | `--approve-for-me` | `--auto-review` | ✗ |
| `full` | Full access | Never asks. | `--dangerously-skip-permissions` | `--dangerously-bypass-approvals-and-sandbox` | `--force` | `--auto` |

✗ = the provider has no such mode: the option is not listed for it, and a
session moved to that provider falls back to `ask`. The table is a field on
`ProviderDef` (`accessArgs: Partial<Record<Access, string[]>>`), not an `if`.

It is the session's existing **`autonomy`** column, widened from `ask | full` to
`ask | edits | auto | full`. That keeps one notion: Crew's own tools already
gate on `autonomy === "full"` (`caller.rs`, `browser_tools.rs`), and agent turns
already map it to flags (`providers/*.rs`). Today the per-session value never
reaches a terminal session's CLI — only the global *Bypass permissions*
setting does (`Terminals.tsx` `launchCommand`). That gap closes here; the global
setting stays as an override that forces `full` everywhere.

### Effort

A new `effort` column on sessions (`''` = the CLI's own setting), like `model`.

| Provider | Levels | Flag |
|---|---|---|
| Claude | low, medium, high, xhigh, max | `--effort <level>` |
| Codex | low, medium, high, xhigh | `-c model_reasoning_effort=<level>` |
| Cursor | — (its model ids carry it: `…-high`) | hidden |
| opencode | — (`--variant` exists on `run` only) | hidden |

Levels live on `ProviderDef.efforts`, with an optional per-model override on
`Model.efforts` for models that stop lower. The chip is hidden when the
provider has none. Labels: Default, Low, Medium, High, Extra high, Max.

### Defaults

`providers:default` (`useDefaultAgent`) grows from `{provider, model}` to
`{provider, model, effort, access}`. What Home's chips show is that default,
and picking there updates it: the last choice is what the next session gets,
from Home or ⌘N, and Settings shows the same value. Settings › Sessions keeps
*Bypass permissions*; the default access sits beside the default model.

## 3. The UI

`src/chrome/ComposerControls.tsx` — one row used by both composers:

```
[📎] [◆ Opus 5.5 ⌄] [High ⌄]                 [🔒 Ask permission ⌄] [↑]
```

- `ModelPicker trigger="chip"`, unchanged except a `lockProvider` prop that
  shows only the session's provider (terminal sessions mid-conversation).
- `EffortPicker` — `Menu` chip with a radio list; `Default` row shows the
  CLI's own setting.
- `AccessPicker` — `Menu` chip with icon + label; rows have icon, label and the
  description. Icons: lock / pencil / sparkles / lock-open.
- Both reuse the `kit.tsx` chip and menu-item classes (`FilterChip`, `itemClass`).

Home: the `Select` goes; `onAsk(text, choice)` carries the whole
`{provider, model, effort, access}` to `useLaunch.newSession`, which writes it
to the session row.

Chat: the controls read and write the session row (`useSessions.update`).

## 4. Applying a change mid-session

Agents need nothing: every turn spawns a fresh CLI from the row
(`turns.rs`), so the next turn picks it up. Effort reaches
`ClaudeSpawn`/`CodexSpawn` as a new field.

Terminal sessions (the chat drawn over a running CLI) are **hybrid**, because
of what was measured against the real CLIs on 2026-10-02:

| CLI | Typed | Works live | Side effect |
|---|---|---|---|
| Claude 2.1.288 | `/model`, `/effort` | yes | writes `~/.claude/settings.json`: the user's default everywhere |
| Cursor | `/model <id>` | yes, model and effort | writes `~/.cursor/cli-config.json` `selectedModel` |
| Codex 0.159 | `/model` picker | yes, model and effort | writes `~/.codex/config.toml` `model` |
| Claude | ⇧Tab | yes | none: the session's mode only |

- **Access on Claude: ⇧Tab.** Its cycle (no bypass on offer) is
  manual → accept edits → plan → auto. Crew always starts Claude with an
  explicit `--permission-mode`, so it knows where the cycle starts, and
  counts presses from there (`src/lib/sessionOptions.ts`). Applied at once
  when the CLI is idle, else just before the next message. Into or out of
  Full access is a relaunch (bypass is not in the cycle).
- **Model and effort, every provider; access elsewhere: relaunch with
  resume.** The next message ends the CLI and starts it again on its
  conversation with the row's flags, the message as its first prompt
  (`claude -r <id> -- "msg"`, `codex resume <id> -- "msg"`, …). No keystroke
  timing; nothing written to the user's config. The composer says so under it
  while a change is pending.
- The chat's **⇧Tab** cycles the access chip (Ask → Accept edits → Auto, the
  provider's modes short of Full), and on Claude reaches the CLI the same way.

## 5. Phases

1. **Data.** Migration: `sessions.effort`, `agents.effort` (if the agent row
   owns model), `autonomy` accepts the two new values (`autonomy_or_default`).
   Protocol types, `api.ts`, `useSessions`. Rust `Autonomy` gets
   `Edits`/`Auto`; `full_autonomy()` unchanged.
2. **Launch.** `ProviderDef.accessArgs` + `efforts`; `sessionCommand` emits
   them; `launchCommand` uses the row's access unless global bypass is on.
   Agent spawns (`claude.rs`, `codex.rs`, `cursor.rs`, `opencode.rs`) map the
   new modes and effort. Unit tests per provider.
3. **Controls.** `EffortPicker`, `AccessPicker`, `ComposerControls`; Home
   switches to them; `useDefaultAgent` stores the four fields; Settings shows
   default effort/access. AgentSheet's "Run autonomously" toggle becomes the
   `AccessPicker`.
4. **Chat.** Controls in `Composer`; relaunch-on-send (§4) for terminal
   sessions; e2e: change effort in a chat, next send relaunches with `--effort`.

## 6. Decisions

- Mid-session apply: hybrid (§4).
- One default: Home's chips, ⌘N and Settings › New sessions share
  `providers:default`; a pick in Home is the next ⌘N's.
- A fresh install's access is **Full access**. A stored default from before
  this change that has no access reads as Full too; Settings' global *Bypass
  permissions* still forces Full on every session.
- Plan mode (⇧Tab, Claude/Codex/Cursor): out of scope, a natural fifth control
  later.
