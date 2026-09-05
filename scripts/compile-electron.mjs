import { build } from "esbuild";

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
    logLevel: "warning",
  });
}

if (import.meta.url === new URL(process.argv[1] ?? "", "file:").href) {
  await compileElectron();
}
