import { execFileSync } from "node:child_process";
import { build } from "esbuild";

function sha() {
  try {
    return execFileSync("git", ["rev-parse", "--short", "HEAD"], { encoding: "utf8" }).trim();
  } catch {
    return "unknown";
  }
}

export async function compileElectron() {
  await build({
    entryPoints: [
      { in: "electron/main.ts", out: "main" },
      { in: "electron/preload.ts", out: "preload" },
    ],
    outdir: "electron-dist",
    outExtension: { ".js": ".cjs" },
    bundle: true,
    platform: "node",
    format: "cjs",
    target: "node20",
    external: ["electron"],
    define: { __CREW_SHA__: JSON.stringify(sha()) },
    logLevel: "warning",
  });
}

if (import.meta.url === new URL(process.argv[1] ?? "", "file:").href) {
  await compileElectron();
}
