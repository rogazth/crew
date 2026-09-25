/**
 * What the window and the main process agree on about pages. Imported by both
 * sides (esbuild bundles it into main and the preload), so it stays free of
 * DOM and Electron.
 */

/**
 * Where pages kept their cookies before each workspace had its own. A new
 * workspace session starts from a copy of it, so an upgrade keeps its sign-ins.
 */
export const LEGACY_PARTITION = "persist:crew-browser";

const PARTITION_PREFIX = "persist:crew-browser-ws-";
const WORKSPACE_ID = /^[A-Za-z0-9-]{1,64}$/;

/**
 * The session a workspace's pages live in: its own cookies and storage, so two
 * workspaces can be signed in as different people. Null for an id that could
 * not have come from the daemon.
 */
export function partitionFor(workspaceId: string): string | null {
  return WORKSPACE_ID.test(workspaceId) ? `${PARTITION_PREFIX}${workspaceId}` : null;
}

/** Main refuses a webview in any partition this doesn't recognize. */
export function isPagePartition(partition: unknown): partition is string {
  return (
    typeof partition === "string" &&
    partition.startsWith(PARTITION_PREFIX) &&
    WORKSPACE_ID.test(partition.slice(PARTITION_PREFIX.length))
  );
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
  devtools: "browser:devtools",
  snapshot: "browser:snapshot",
  prepareRestore: "browser:prepare-restore",
  /** The window's CSP keeps remote images out, so main fetches a page's icon and hands back a data: URL. */
  favicon: "browser:favicon",
  /** main → window: a page's download started or ended; its guest must not be discarded meanwhile. */
  download: "browser:download",
  /** window → main: cookies the daemon read from another browser, to write into one workspace's session. */
  importCookies: "browser:import-cookies",
} as const;

export type DownloadActivity = { webContentsId: number; active: boolean };

export type OpenTabRequest = { url: string; background: boolean; openerId: number };
