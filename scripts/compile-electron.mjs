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
export async function compileElectron({ release = false } = {}) {
  await build({
    entryPoints: [
      { in: "electron/main.ts", out: "main" },
      { in: "electron/preload.ts", out: "preload" },
      { in: "electron/browser/guest-preload.ts", out: "guest-preload" },
      { in: "electron/browser/popup-preload.ts", out: "popup-preload" },
    ],
    outdir: "electron-dist",
    outExtension: { ".js": ".cjs" },
    bundle: true,
    platform: "node",
    format: "cjs",
    target: "node20",
    external: ["electron"],
    define: { __CREW_SHA__: JSON.stringify(sha()), __CREW_RELEASE__: JSON.stringify(release) },
    logLevel: "warning",
  });
}

if (import.meta.url === new URL(process.argv[1] ?? "", "file:").href) {
  await compileElectron();
}
