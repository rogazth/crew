// A page can take the whole app down (a CHECK in Chromium aborts the process).
// Its tab is saved as the active one, so the next launch shows it, and dies the
// same way, for good. A marker on disk tells a launch that the one before it
// never settled: that launch leaves the saved pages alone until they are opened.

import { existsSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";

const MARKER = "launch-in-progress";

/** A run that lasted this long got past whatever it restored at launch. */
export const SETTLED_MS = 30_000;

export type LaunchGuard = {
  /** The launch before this one died before it settled. */
  safeStart: boolean;
  /** This run got through: quit cleanly, or lasted long enough. */
  settle(): void;
};

/** A marker that can't be read or written only costs the protection, never the launch. */
export function beginLaunch(dataDir: string): LaunchGuard {
  const marker = path.join(dataDir, MARKER);
  const safeStart = existsSync(marker);
  try {
    writeFileSync(marker, String(process.pid));
  } catch {
    // Launches as if nothing had happened.
  }
  return {
    safeStart,
    settle: () => rmSync(marker, { force: true }),
  };
}
