# Finish the design system

The redesign in `src/prototype/design-system` runs behind a dev-only switch (`direction.ts`, `useRedesign`), and many of its screens run on mock data. This plan makes the redesign the only UI, deletes the prototype scaffolding, and gives every designed control a real backend. Nothing fake ships.

Decisions are final; the numbers match the review list they came from.

## Status

| Stream | Scope | Status |
| --- | --- | --- |
| S1 | Cleanup and promotion | done |
| S2 | Usage | pending |
| S3 | Providers | pending |
| S4 | Environments, metrics, add machine | pending |
| S5 | Updates, About, General | pending |
| S6 | Appearance, keybindings | pending |
| S7 | Sidebar, composer, first screens, misc | pending |
| S8 | Rebase `feat/bot-memory` | pending |

S1 lands first; S2–S7 build on it and touch mostly separate files; S8 runs after this branch reaches `master`.

## S1. Cleanup and promotion

1. Remove the `direction` / `useRedesign` switch. The redesign is the only UI; delete the old branches in `App.tsx`, `WorkspaceRail`, `SettingsSidebar`, `SettingsView`, `HomeStart`, `RoutineEditor`, `CommandsView`, `Composer`, `DefaultChatSurface`, `Orchestration`, `Panel`.
2. Styles (18): keep the three palettes as a persisted accent preference — Ink (default), **Teal** (was "Crew", direction b), Cobalt (direction c). Store it with `api.stateSet`, apply it to `<html>` at boot, and keep it separate from anything meaning "redesign on". Move the shared tokens and the three palettes from `directions.css` into `src/index.css`; drop the `[data-direction]` prefix everywhere (`directions.css`, `chat.css`, `work.css`); replace selectors that target Tailwind class names (e.g. `.rounded-tl-xl.border-t.border-l`, `div.min-h-0.flex-1:last-child`, `.bg-sidebar`) with data attributes; remove the `:has([data-file-drop])` rule re-added after b46ca1f.
3. Move what production uses out of `src/prototype/design-system` into `src/chrome` / `src/surfaces` / `src/lib` (sidebar, chat parts, work, routines BotPicker, settings pages, UpdateButton, UsageButton). Migrate `crew-proto-*` and `crew.proto.*` localStorage prefs to their real homes (S7 #72, S2 #55) so users keep them.
4. Delete: `DirectionBar`, `SystemPrototype`, `work/WorkGallery`, `settings/SettingsPrototype`, `review/ReviewPicker` + `review/states.ts` and their wiring in `App.tsx`, `src/prototype/chat-redesign`, `src/prototype/agent-header`, `PrototypeSwitcher`, the prototype routes in `src/main.tsx`, the `prototype:*` scripts in `package.json`, `settings/mock.ts`, `settings/envMock.ts`, `settings/envParts.tsx`, the readings in `usage.ts`, `ui.tsx` `wait()`, `.ds-raised`.
5. Delete dead code: `chrome/SessionSidebar.tsx` (keep only the props type if still needed, moved), `chrome/SidebarPrefsMenu.tsx`, the `PaneWorktree` component and `Place.hue`, the unused sidebar props (`commands`, `activeWorktree`, `onSelectWorktree`, `hues`), the `proto` prop.
6. Tests: trim `e2e/stress/many-tabs.test.ts` of the profiling knobs and `console.log`s; fix `e2e/worktree-tabs.test.ts` and `e2e/tab-pins.test.ts` for the removed per-worktree tab scope; update e2e selectors for the new UI (e2e runs on the production build, which now is the redesign).
7. Gate `CREW_KEEP_STATUS` (`background.rs`, `turns.rs`) to debug builds. Keep `scripts/seed.mjs` and `app:design --missing`; document `--missing` in the README.
8. Backdrops: one `--backdrop` token, clearly darker (about 40% black in light, 60% in dark, tune by eye), used by `chrome/kit.tsx` dialog and alert backdrops and `CommandPalette`.
9. Until S2 lands, the rail usage rings stay hidden; the hardcoded email in `usage.ts` goes.

## S2. Usage

Plan limits per provider, read through each CLI's supported channel.

- 48 Claude: parse `rate_limit_event` from stream-json (`rate_limit_info.unifiedWindows.five_hour|seven_day.{utilization,resetsAt}`, plus `status`, `overageStatus`). Verified on Claude Code 2.1.299. It only arrives with a turn, so keep the last reading with its time.
- 49 Codex: app-server `account/rateLimits/read` and the `account/rateLimits/updated` notification (`usedPercent`, `windowDurationMins`, `resetsAt`, `planType`); plan and account from `account/read`. Can be read at any time.
- 50 Cursor: best effort. `cursor-agent about --format json` gives tier and email. For percentages call `https://cursor.com/api/usage-summary` with the token `cursor-agent login` stored (find where it keeps it). Never read browser cookies. Isolate this in one adapter; on failure show plan and account without a ring.
- 51 opencode: tokens and cost from `opencode stats`; no plan windows.
- 52 Store readings and a daily history (7 days) in the daemon store; push updates as an event.
- 53 Usage is per account: dedupe readings across machines that share an account.
- 54 Refresh and "updated n ago" reflect real reads.
- 55 Ring setup (order, shown, colours) moves from localStorage to `api.stateSet`.
- 56 Alerts: notify at a threshold (via the notifications host), warn in the composer at a threshold, refresh interval. All persisted and applied.
- 57 The rail popover lists every provider with a reading, not only those with a ring on.

## S3. Providers

Each machine's crewd answers for its own CLIs.

- 36 Version of each CLI (`--version`).
- 37 Latest version: npm registry for `@anthropic-ai/claude-code`, `@openai/codex`, `opencode-ai`; Cursor from `cursor-agent about --format json` (`latestVersion`).
- 38 Account and plan: `claude auth status` (JSON), Codex `account/read`, `cursor-agent status --format json`, `opencode auth list`.
- 39 Real binary path, Reveal in Finder (`filesHost().reveal`), Open terminal (pass `onOpenTerminal` down).
- 40 Install, update, reinstall, uninstall as crewd jobs on the target machine, with progress events and cancel; the install method (npm / brew / script) is persisted. Update commands: `claude update`, `codex update`, `cursor-agent update`, `opencode upgrade`.
- 41 Sign in / out: run the CLI's login in a terminal tab on the target machine; Codex additionally gets the integrated device-code flow via app-server `account/login/start`.
- 42 No automatic Node install or fix-it diagnosis: show the real error and the command that failed.
- 43 Fix: picking the preferred agent must keep its model, effort and serviceTier (`useDefaultAgent` `lastOf`).
- 44 Add a default model and effort picker (model list from `api.listedModels`).
- 45 Confirm dialog before uninstall.
- 46 The Providers nav badge counts real updates and signed-out CLIs.
- 47 Keep the opencode "why none runs" note from the classic page.

## S4. Environments, metrics, add machine

The classic `src/surfaces/EnvironmentSettings.tsx` and `src/surfaces/AddMachine.tsx` already do most of this for real; port their logic into the redesigned pages, then delete the classic ones.

- 58 Cards from `useEnvLinks`; every action through `remotesHost()` / registry: reconnect, update crewd, restart, logs (with refresh), rename (`api.upsertRemote`), remove (with the wipe flag), open terminal, open workspace (`openWorkspaceOn`).
- 59 Metrics: `sysinfo` in crewd, a ring buffer sampling about every 30 s for about 2 h, a `machine_metrics` request, real CPU %, free memory on macOS; chart scrub times are real.
- 60 Track "last seen" per link.
- 61 This Mac: restart crewd and read its log (`crewd.log` in the app data dir) through new IPC.
- 62 Network: real Tailscale state; relay warnings write `WARN_RELAY`, reconnect on wake writes `WAKE_ON`.
- 63 Bring back everything the classic page had: "Starting the daemon", "Started with Crew", workspace count, live update step, version chip a.b.c → x.y.z, notice line, "Incompatible crewd" (and disabled actions on mismatch), Health details (Home, ssh command, address:port, SOCKS port), edit SSH host and user, "its N workspaces leave the rail", logs Copy / scroll to newest / error state, Tailscale "Checking…" and "Only in the app".
- 64 Add machine: real `sshHosts()` and `tailnet()` with `reason`, `relay`, ssh alias matching, "Look again".
- 65 Real install via `host.install` and `onProgress`; align step names with the backend.
- 66 Backend: report upload progress and add a "check for an existing crewd" step.
- 67 Name asked at the end: install with a derived name, then rename with `upsertRemote`.
- 68 The port field becomes the crewd port (with the "proxy on N+1" hint); add an SSH port under advanced options, end to end.
- 69 Cancel a running install (backend).
- 70 Structured errors with hint and fix for the common failures: SSH unreachable, auth refused, port in use.
- 71 Real done screen, including the lingering warning.

## S5. Updates, About, General

- 27 `appInfo` IPC: app version, commit (`electron/build-info.ts`), Electron / Chrome / Node versions, OS, crewd version. Feeds the About hero and build table.
- 28 "Check now" through a new `update:check` channel; show the last-checked time.
- 29 The rail UpdateButton, About and the nav pill all run on `useUpdateState` / `updateHost` (progress, cancel, skip = `dismiss`). Remove the old `UpdateDialog`.
- 30 Split the updater: download and stage, then "Restart to install" or install on quit.
- 31 `scripts/release-publish.mjs` adds notes, size and date to `latest.json`.
- 32 What's new from real release history (GitHub releases).
- 33 No beta channel: remove the selector.
- 34 Auto-download preference, persisted and honoured by the updater.
- 35 Links open with `openUrl` (website, GitHub, report an issue with build info, acknowledgements). Licenses: generate a third-party licenses file at build time and link it.
- 11 Retention: restore the classic stale-session count (`api.staleSessions`), skip the confirm at zero, save only after success.
- 12 Remove the Dock badge toggle from General (it lives in Notifications).
- 13 Open at login: `app.setLoginItemSettings`, consistent with the crewd LaunchAgent.
- 14 Reopen where you left off: restore the active workspace and its tabs at launch, behind a persisted preference.
- 15 `crew` command: the real `cliHost` status, channel-specific link path, "not on your PATH" and unavailable states, errors.
- 16 Settings search reaches rows on Notifications, Terminal and Browser (`data-setting` anchors); drop the "Tabs" entry.

## S6. Appearance, keybindings

- 17 Theme cards read `useColorMode().mode`; drop the proto theme mirror.
- 19 Remove Density.
- 20 Chat text size: slider plus stepper, persisted, applied as a CSS variable in the chat.
- 21 Reduced motion follows the OS (`prefers-reduced-motion`); no own control; remove the dead state.
- 22 The preview shows only real settings.
- 23 Keybinding overrides persisted with `api.stateSet`, applied by the command dispatcher and the Electron menu accelerators (`electron/menu.ts`); `src/lib/commands.ts:9` is where overrides land.
- 24 Clash, reset, reset all and remove work on the persisted overrides.
- 25 Import and export JSON through open and save dialogs.
- 26 Remove the seeded fake change; fix `Mod++` in `commandGroups` instead of in the page.

## S7. Sidebar, composer, first screens, misc

- 72 Sidebar prefs (grouping, show worktree, hidden worktrees per workspace) move to `useSidebarPrefs`.
- 73 Filters › Reset also resets grouping and ordering.
- 74 Replace `renameBus` with state.
- 75 Show the orphaned-commands warning again.
- 76 No "main" second line when a session has no worktree.
- 77 Running-commands icon tooltip lists the command names.
- 78 Per-worktree tab scope is gone for good: remove it and the race in `useTabScope` that can flip it back.
- 79 Restore: switch worktree with the current one visible (⌃⌘1-9 must show its effect), "New bot here", "Copy path" on worktrees, keyboard on worktree headings (←/→ fold, Delete). Not restored: kind and scope filters, bot names toggle.
- 80 Tab worktree groups stay off; the breadcrumb shows the real branch.
- 81 BotSheet's "Works in" picker stays removed.
- 82 Remove the fake context ring fallback (`ComposerParts`, `mock={!centered}`).
- 83 The work sheet (shells, processes, conversations) opens even without the agents clip.
- 84 ⇧Tab keeps stepping effort; add a visible hint.
- 85 "Paste a screenshot" names the platform's key.
- 86 `where.ts` subscribes to the real stores instead of caching for the window's life.
- 87 Session intro shows the model as a quiet fact.
- 88 Starters use the real default branch; no code starters for bots or Home.
- 89 Start screen gets the real mention and slash pickers (reuse Composer's).
- 90 Fix the start screen keeping the picked model and access forever.
- 91 ⌘N and the sidebar "+" go through the start screen.
- 92 No suggestion chips on Home.
- 93 Picking an agent on Home updates the preferred agent.
- 94 Moving a fresh session to another worktree keeps its draft and attachments.
- 95 A failed agent is not counted as finished.
- 96 Empty Commands shows a "New command" action instead of the fake examples.
- 97 Tab hover card: real branch; "Working for" from the turn start.
- 98 Explorer: persist the picked worktree, better label than "No branch", search placeholder matches what search does.

## S8. Bot memory

After this branch is on `master`, rebase `feat/bot-memory` (its own commits start at `e14a800`). Expected conflict: `src/chrome/BotSheet.tsx` only, where this branch removed "Works in" and bot-memory added the notes panel.
