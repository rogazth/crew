/**
 * What the updater in main and the window's update dialog agree on. Imported by
 * both sides (esbuild bundles it into main and the preload), so it stays free of
 * DOM and Electron.
 */

export const UPDATE_CHANNELS = {
  /** main → window: the updater moved to a new phase, or a download advanced. */
  state: "update:state",
  /** window → main: the phase right now, for a window that opens mid-update. */
  current: "update:current",
  install: "update:install",
  /** window → main: the dialog was closed; an offered version is not offered again until asked. */
  dismiss: "update:dismiss",
  cancel: "update:cancel",
} as const;

export type UpdateState =
  | { phase: "idle" }
  | { phase: "checking" }
  | { phase: "latest"; version: string }
  /** A checkout build: there is no installed bundle to replace. */
  | { phase: "unpackaged" }
  | { phase: "available"; version: string; current: string }
  /** `total` is null when the server sends no length. */
  | { phase: "downloading"; version: string; received: number; total: number | null }
  | { phase: "installing"; version: string }
  | { phase: "restarting"; version: string }
  | { phase: "error"; message: string };
