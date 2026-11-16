import { execFileSync } from "node:child_process";
import { build } from "esbuild";

function sha() {
  try {
    return execFileSync("git", ["rev-parse", "--short", "HEAD"], { encoding: "utf8" }).trim();
  } catch {
    return "unknown";
  }
}

/** `release` marks the published build, the only one on the installed app's data. */
/** `updateFeed` ({ releases, key }) and `outdir` are for scripts/update-e2e.mjs only: a local feed, its signing key, and a folder of its own. */
export async function compileElectron({ release = false, updateFeed = null, outdir = "electron-dist" } = {}) {
  await build({
    entryPoints: [
      { in: "electron/main.ts", out: "main" },
      { in: "electron/preload.ts", out: "preload" },
      { in: "electron/browser/guest-preload.ts", out: "guest-preload" },
      { in: "electron/browser/popup-preload.ts", out: "popup-preload" },
    ],
    outdir,
    outExtension: { ".js": ".cjs" },
    bundle: true,
    platform: "node",
    format: "cjs",
    target: "node20",
    external: ["electron"],
    define: {
      __CREW_SHA__: JSON.stringify(sha()),
      __CREW_RELEASE__: JSON.stringify(release),
      __CREW_UPDATE_FEED__: JSON.stringify(updateFeed),
    },
    logLevel: "warning",
  });
}

if (import.meta.url === new URL(process.argv[1] ?? "", "file:").href) {
  await compileElectron();
}
