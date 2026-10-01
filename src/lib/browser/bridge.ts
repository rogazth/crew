/**
 * What the window and the main process agree on about pages. Imported by both
 * sides (esbuild bundles it into main and the preload), so it stays free of
 * DOM and Electron.
 */

import type { SitePermission, SitePermissions } from "./permissions";

/**
 * The one session every page lives in, whatever its workspace: the app signs
 * in once. It is where pages kept their cookies before workspaces had their
 * own, so a sign-in from then is still there.
 */
const PAGE_PARTITION = "persist:crew-browser";
/**
 * No `persist:`: Electron keeps the session in memory, so nothing it stores
 * reaches the disk. Shared by every incognito tab and wiped once the last of
 * them closes.
 */
const INCOGNITO_PARTITION = "crew-incognito";

/** The session a page lives in: the app's own, or the in-memory one an incognito page gets. */
export function partitionFor(incognito = false): string {
  return incognito ? INCOGNITO_PARTITION : PAGE_PARTITION;
}

export function isIncognitoPartition(partition: unknown): partition is string {
  return partition === INCOGNITO_PARTITION;
}

/** Main refuses a webview in any partition this doesn't recognize. */
export function isPagePartition(partition: unknown): partition is string {
  return partition === PAGE_PARTITION || partition === INCOGNITO_PARTITION;
}

/** A webview whose src starts with this asks main to restore a saved back/forward stack instead of loading. */
export const RESTORE_PREFIX = "about:blank#crew-restore=";

export const CHANNELS = {
  /** window → main: the commands the window can run right now, so a focused page can forward them. */
  commands: "browser:commands",
  /** window → main: what each physical key types on the layout in use, for chords ⌥ or a dead key leave unnamed. */
  keyboardLayout: "browser:keyboard-layout",
  /** main → window: a chord pressed inside a page belongs to this command. */
  command: "browser:command",
  /** main → window: a page asked for a new tab (target=_blank, window.open, the context menu). */
  openTab: "browser:open-tab",
  /** Toggles a page's DevTools in a window of their own. */
  devtools: "browser:devtools",
  /** Opens a page's DevTools in a view of the window, over the pane's panel. */
  dockDevtools: "browser:dock-devtools",
  /** Moves docked DevTools with their panel, or hides them while something covers it. */
  placeDevtools: "browser:place-devtools",
  closeDevtools: "browser:close-devtools",
  snapshot: "browser:snapshot",
  prepareRestore: "browser:prepare-restore",
  /** The window's CSP keeps remote images out, so main fetches a page's icon and hands back a data: URL. */
  favicon: "browser:favicon",
  /** main → window: where a download is; a page with one in flight must not be discarded meanwhile. */
  downloads: "browser:downloads",
  /** window → main: cancel, open or show one of this window's downloads. */
  downloadAction: "browser:download-action",
  /** window → main: whether each download asks where to go. */
  downloadPrefs: "browser:download-prefs",
  /** main → window: a page is waiting on the person (a permission, a sign-in, another app). */
  prompt: "browser:prompt",
  /** main → window: a prompt nobody needs any more: its page navigated or closed. */
  promptGone: "browser:prompt-gone",
  /** window → main: what the person answered. */
  answer: "browser:answer",
  /** window → main: every remembered site permission, so main can answer Chromium without asking. */
  sitePermissions: "browser:site-permissions",
  /** main → window: a page stopped answering, or came back. */
  responsive: "browser:responsive",
  /** Ends a hung page's process so it can load again. */
  kill: "browser:kill",
  print: "browser:print",
  /** window → main: cookies the daemon read from another browser, to write into the pages' session. */
  importCookies: "browser:import-cookies",
  /** window → main: this guest is that tab's page, so an agent's call on the tab finds it. */
  pageGuest: "browser:page-guest",
  /** window → main: every other machine a workspace lives on, by the name its pages reach it at. */
  machines: "browser:machines",
  /** window → main: the machine a guest's workspace lives on, or null for this Mac. */
  guestMachine: "browser:guest-machine",
  /** main → window: an agent needs this tab live; mount it (hidden) and pin it, or add it first. */
  mount: "browser:mount",
} as const;

/**
 * `open`: a tab an agent just made, to add to its strip in the background.
 * Otherwise the tab is already in `context`'s strip, perhaps cold, perhaps in
 * a workspace this window has not shown yet.
 */
export type MountRequest = { tab: string; context: string; url: string; title: string; open: boolean };

/** Where the panel is in the window, in CSS pixels: main scales it by the window's zoom. */
export type DockBounds = { x: number; y: number; width: number; height: number };

/** What docked DevTools looked like as they were hidden, shown in their place meanwhile. */
export type DockSnapshot = { url: string; width: number; height: number };

export type DownloadState = "progressing" | "paused" | "completed" | "cancelled" | "interrupted";

/**
 * One download as the window shows it. `webContentsId` is the page it belongs
 * to (a popup's download belongs to the page that opened it), null when no
 * page of this window started it.
 */
export type DownloadInfo = {
  id: string;
  webContentsId: number | null;
  filename: string;
  url: string;
  /** Empty while a save dialog is still open. */
  path: string;
  received: number;
  /** 0 when the server didn't say. */
  total: number;
  state: DownloadState;
  startedAt: number;
};

export type DownloadAction = "cancel" | "open" | "reveal" | "resume";

/**
 * What a page waits on. `webContentsId` is the page it shows over. Answers:
 * a permission is `{ allow, remember }`, a sign-in `{ username, password }`
 * or null, another app `{ open }`, and a system block `{ settings }`.
 */
export type PagePrompt =
  | { kind: "permission"; id: string; webContentsId: number; origin: string; permissions: SitePermission[] }
  | { kind: "auth"; id: string; webContentsId: number; origin: string; realm: string; secure: boolean }
  | { kind: "external"; id: string; webContentsId: number; origin: string; app: string; scheme: string }
  | { kind: "system"; id: string; webContentsId: number; permissions: SitePermission[] };

export type PromptAnswer =
  | { allow: boolean; remember: boolean }
  | { username: string; password: string }
  | { open: boolean }
  | { settings: boolean }
  | null;

export type Responsiveness = { webContentsId: number; hung: boolean };

export type { SitePermissions };

/** `incognito`: the tab opens in the workspace's in-memory session, as every tab an incognito page opens does. */
export type OpenTabRequest = { url: string; background: boolean; openerId: number; incognito: boolean };
