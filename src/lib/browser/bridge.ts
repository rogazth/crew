/**
 * What the window and the main process agree on about pages. Imported by both
 * sides (esbuild bundles it into main and the preload), so it stays free of
 * DOM and Electron.
 */

/** The session every page lives in. Main refuses a webview that asks for another. */
export const PARTITION = "persist:crew-browser";

/** A webview whose src starts with this asks main to restore a saved back/forward stack instead of loading. */
export const RESTORE_PREFIX = "about:blank#crew-restore=";

export const CHANNELS = {
  /** window → main: the commands the window can run right now, so a focused page can forward them. */
  commands: "browser:commands",
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
} as const;

export type DownloadActivity = { webContentsId: number; active: boolean };

export type OpenTabRequest = { url: string; background: boolean; openerId: number };
