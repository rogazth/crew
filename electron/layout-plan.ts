import path from "node:path";

/**
 * Where an environment keeps what the user works in, as crewd reads it from
 * `<data dir>/layout.json` (crew_core::paths). The data dir is the
 * environment; this names its work dir (worktrees) and its Home folder.
 */
export type Layout = { workDir?: string; homeFolder?: string };

export const LAYOUT_FILE = "layout.json";

/**
 * The layout a build gives a data dir it is the first to open. The release
 * keeps the folders it always had; a dev or local build gets folders of its
 * own beside them. A data dir somebody pointed the app at (a seeded set, a
 * checkout's `.crew-dev`, an e2e sandbox) gets none, and crewd keeps
 * everything inside it, unless `CREW_WORK_DIR` names a work dir. The release
 * ignores both variables, as it ignores `CREW_USER_DATA`.
 */
export function layoutFor(build: {
  release: boolean;
  local: boolean;
  home: string;
  userData?: string | undefined;
  workDir?: string | undefined;
}): Layout | null {
  if (build.release) return { workDir: path.join(build.home, ".crew"), homeFolder: path.join(build.home, "Crew") };
  if (build.workDir) return { workDir: build.workDir };
  if (build.userData) return null;
  return { workDir: path.join(build.home, build.local ? ".crew-local" : ".crew-dev") };
}

/**
 * Why this launch must not start, or null. An e2e run that did not name its
 * data dir would open the developer's "Crew Dev" and fill it with sandboxes.
 */
export function refusal(e2e: boolean, userData: string | undefined): string | null {
  return e2e && !userData ? "CREW_E2E is set without CREW_USER_DATA: an e2e run needs a data dir of its own." : null;
}
