/** What About shows of the running build. Shared by main and the window. */
export const APP_INFO_CHANNEL = "app:info";
export const LICENSES_CHANNEL = "app:licenses";

export type AppInfo = {
  version: string;
  /** The commit this build was compiled from, or "unknown" for a build that did not record it. */
  commit: string;
  arch: string;
  electron: string;
  chrome: string;
  node: string;
  /** "macOS 14.6.1". */
  os: string;
  /** The version of the crewd this app talks to; null when its data directory has no daemon.json yet. */
  crewd: string | null;
  /** Packaged from the published release, as opposed to a local package or a checkout. */
  release: boolean;
};
