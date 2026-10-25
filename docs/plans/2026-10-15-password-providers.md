# Password providers

Decided 2026-10-15; a kind of integration in `2026-10-23-integrations.md`,
which comes first. Crew's browser fills sign-ins from the person's own
password manager, the way it hosts AI providers: Crew finds the manager's
CLI, offers to install it, lets the manager unlock itself, and asks it for
one secret when the person picks an account. Crew stores no password and
keeps no vault. Update the status table at the bottom as each phase lands.

Extensions were the other road (Bitwarden from the Chrome Web Store). Electron
lacks most of what Bitwarden's MV3 manifest needs (`action` popups, `alarms`,
`offscreen`, `idle`, `contextMenus`, `notifications`, full `tabs`), so it would
install and break. A provider gives a native picker, works in remote
workspaces' tabs, and does not wait on Electron.

## What is there

- Tabs are `<webview>`s in two persistent sessions, normal and incognito
  (`electron/browser/guests.ts`, `pageSession`), hardened in `policy.ts`.
- Every guest runs `guest-preload.ts`, which today only patches
  `window.close` and Google sign-in.
- `prompts.ts` shows a page's questions over that page and waits for the
  window's answer: the picker reuses the path.
- Agents read pages through `agent-tools.ts`: `browser_snapshot` (the AX tree,
  input values included, `ax-snapshot.ts`), `browser_evaluate` (any JS in the
  main world), `browser_network` (method, status, URL; no bodies).
- Remote workspaces' tabs render in this Mac's Electron, so everything here
  runs on the Mac, whatever machine the workspace is on.

## The rules

1. **Secrets live in main and nowhere else.** Never in `crewd`, the window's
   renderer, the store, logs, or a tool result. They pass from the provider
   to the page's isolated world in one call and are dropped.
2. **The manager authenticates the person, not Crew.** Crew never persists a
   master password, a session key, or an item.
3. **Nothing waits on a CLI while a page loads.** Matching runs on an index in
   memory; the provider is called only when the person picks an account.
4. **Agents never receive a secret.** Not in a snapshot, an evaluate, or an
   error message.

## Design

**Provider.** One interface in `electron/passwords/`, one adapter per
manager:

```ts
interface PasswordProvider {
  id: "bitwarden" | "1password";
  detect(): Promise<{ installed: boolean; version?: string; path?: string }>;
  installCommand(): string | null;          // null: send to the download page
  state(): "missing" | "locked" | "unlocked";
  unlock(): Promise<void>;                  // the manager's own flow
  lock(): Promise<void>;
  index(): Promise<LoginEntry[]>;           // id, name, username, uris + match rule; no secrets
  secret(id: string): Promise<{ username: string; password: string }>;
  totp(id: string): Promise<string | null>;
}
```

Only one provider is active at a time; Settings chooses it.

**Detect and install.** The binary is looked up on the login shell's PATH (as
`shell_path.rs` does for agents). Missing → Settings and the picker offer
"Install": `brew install bitwarden-cli` / `brew install --cask
1password-cli`, run in a visible terminal on this Mac; with no brew, the
download page. Minimum versions are checked like opencode's `INSTALL`.

**Unlock — 1Password.** `op` with the desktop app integration: 1Password
shows its own Touch ID prompt, Crew sees nothing. A grant lasts 10 minutes
from last use, 12 hours at most, and dies when the app locks. Crew's calls run
without a TTY, so a grant may not carry over between them: the spike measures
how often the person is asked, and whether `op signin --raw` held in memory
is needed.

**Unlock — Bitwarden.** Vault decryption is client side, so unlocking takes
the master password (or the desktop app's biometrics, phase 2). Crew starts
`bw serve` on a Unix socket in the data dir's `tmp/` (CLI ≥ 2025.10; on older
CLIs, `--hostname 127.0.0.1` on a random port, and the picker says to update).
`bw login` (email, SSO, or API key) runs once in a terminal on this Mac. Unlock
is a sheet in Crew's window: the password goes from the field to main, to
`bw serve`'s `/unlock`, and is overwritten; it is never written anywhere. Crew
owns any terminal it would type into, so a terminal is no safer than the sheet,
only clumsier. The sheet says so in one line.

**Lock.** On screen lock, suspend (`powerMonitor`), quit, an idle timeout
(Settings, default 15 min), and on demand. Locking stops `bw serve` (it keeps
the vault in memory while it runs) and drops the index.

**Index and match.** Built on unlock, refreshed in the background (Bitwarden's
`/sync`, `op item list` every few minutes and on focus). Keyed by registrable
domain (eTLD+1, with the public suffix list); each entry keeps its provider's
match rule (domain, host, starts with, exact, regex, never) and is checked
against the frame's URL. Pure and unit tested.

**Detect forms.** `guest-preload.ts` finds sign-in fields: `autocomplete`
(`username`, `email`, `current-password`, `new-password`, `one-time-code`),
password inputs and the text input before them, open shadow roots, and
two-step flows (username page, then password page). A `MutationObserver`,
debounced, re-checks SPAs. It posts only the field's frame, a stable handle
and its kind to main. It runs in every frame; `webFrameMain` routes
cross-origin iframes.

**Picker.** Focusing a matched field shows Crew's picker over the page,
through the `prompts.ts` path: accounts for the frame's origin, "Fill",
"Copy TOTP", "Open in manager", "Lock". It is the window's UI, outside the
page, so the site's scripts cannot read or spoof it. A locked provider shows
"Unlock"; a missing one, "Install". Also on a toolbar key in the pane and a
shortcut.

**Fill.** Main asks `secret(id)`, then runs a fill in the frame's isolated
world (`executeJavaScriptInIsolatedWorld`): set the value through the native
setter, dispatch `input` and `change`, so React and friends see it. Only on a
person's gesture, only in the frame whose origin matched, never in a frame
that navigated since the picker opened. TOTP fills a `one-time-code` field or
goes to the clipboard, cleared after 30 s.

**Incognito.** Off by default; a setting turns it on.

**Agents.**
- `ax-snapshot.ts` prints password inputs as `value="••••"` always, filled by
  Crew or typed.
- `browser_evaluate` is refused on a page Crew filled, until it navigates to
  a new document.
- No tool asks for a secret. Phase 2: `browser_sign_in` — the agent asks to
  sign in on its tab, the person approves in the picker (Touch ID through the
  manager), Crew fills, the agent hears "signed in" or "declined".

**Settings.** A Passwords section: provider, state, version, Install / Sign in
/ Unlock / Lock, idle timeout, incognito, "Never offer on this site".

## Phases

**0. Spike (1 day).** Real `bw` against the person's vault: `bw serve` on a
socket (the 2026.8 help lists only `--hostname`), `/unlock`,
`/list/object/items?url=`, lock. `op` later, on its trial: how often it asks
for Touch ID from main without a TTY. No UI.

**1. Core.** Interface, both adapters, index and matcher, lock triggers.
Fakes for `bw` and `op` in `e2e/bin`, like the fake `claude`.

**2. Page.** Form detection in the preload, frame routing, isolated-world
fill, TOTP.

**3. Window.** Picker over the page, unlock sheet, install flow, Settings
section.

**4. Agents.** Snapshot masking, evaluate gate.

**5. e2e.** Local test pages (plain form, two-step, iframe login, SPA, shadow
DOM) against the fakes: install offered, unlock, fill, TOTP, lock on idle,
agent sees `••••`, evaluate refused.

**Later.** Save and update credentials (`bw create item`, `op item create`);
`browser_sign_in`; Bitwarden biometric unlock through the desktop app's
browser integration; passkeys and macOS AutoFill (`ASAuthorization`).

## How it is built

Bitwarden first, end to end; 1Password follows on a trial account once the
Bitwarden path is merged (1Password has no free plan, and the e2e runs on
fakes). Subagents build each part in its own worktree and do not commit. The
orchestrating session reviews each part against the rules above, runs the
checks, and makes every commit.

## Status

| Part | State |
| --- | --- |
| Spike: `bw serve` socket, `op` grants without a TTY | todo |
| Provider interface, Bitwarden and 1Password adapters, index, matcher, lock | todo |
| Preload detection, frames, isolated-world fill, TOTP | todo |
| Picker, unlock sheet, install, Settings | todo |
| Snapshot masking, evaluate gate | todo |
| e2e with fake `bw` / `op` | todo |
