// Runs the Electron e2e specs against the built renderer and the debug crewd.
// On macOS the window is not shown. Up to 3 spec files run at once.
//
//   npm run e2e                        → e2e/*.test.ts
//   npm run e2e -- smoke               → specs whose file name contains "smoke"
//   npm run e2e -- --stress            → e2e/stress/*.test.ts
//   E2E_SKIP_BUILD=1 npm run e2e       → reuse dist/ as it is
//   E2E_KEEP=1 npm run e2e             → leave each run's data directory behind
//   npm run e2e -- --test-concurrency=1  → one spec file at a time
//
// Other --flags go to `node --test` (e.g. --test-name-pattern=...).
import { spawn } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// compileElectron and the spec paths are relative to the repo, and esbuild
// reads the working directory as it loads, so the import waits for this.
process.chdir(fileURLToPath(new URL("..", import.meta.url)));
const { compileElectron } = await import("./compile-electron.mjs");

function run(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: "inherit" });
    child.on("error", reject);
    child.on("exit", (code, signal) => resolve(code ?? (signal ? 1 : 0)));
  });
}

const args = process.argv.slice(2);
const stress = args.includes("--stress");
const flags = args.filter((arg) => arg.startsWith("--") && arg !== "--stress");
const filters = args.filter((arg) => !arg.startsWith("--"));

const dir = stress ? "e2e/stress" : "e2e";
const all = existsSync(dir)
  ? readdirSync(dir).filter((name) => name.endsWith(".test.ts")).map((name) => path.join(dir, name))
  : [];
// A filter is a spec path, or a piece of a spec's file name.
const files = filters.length
  ? filters.flatMap((filter) =>
      existsSync(filter) ? [filter] : all.filter((file) => path.basename(file).includes(filter)),
    )
  : all;
if (files.length === 0) {
  console.error(`e2e: no specs in ${dir}/${filters.length ? ` match ${filters.join(", ")}` : ""}`);
  process.exit(1);
}

if (!existsSync("target/debug/crewd")) {
  console.error("e2e: target/debug/crewd is missing. Build it with: cargo build -p crewd");
  process.exit(1);
}

await compileElectron();
if (process.env.E2E_SKIP_BUILD !== "1") {
  const code = await run("npx", ["vite", "build", "--logLevel", "warn"]);
  if (code !== 0) process.exit(code);
}

// One flag: a --test-concurrency already passed wins. Otherwise three files
// at once. Tests inside a file stay serial.
const passedConcurrency = flags.some(
  (arg) => arg === "--test-concurrency" || arg.startsWith("--test-concurrency="),
);
const test = ["--test", ...(passedConcurrency ? [] : ["--test-concurrency=3"]), ...flags, ...files];
// Electron needs a display. xvfb-run's default screen is 640x480 at 8 bits,
// smaller than the window's minimum size.
const headless = process.platform === "linux" && !process.env.DISPLAY;
const code = headless
  ? await run("xvfb-run", ["-a", "-s", "-screen 0 1920x1080x24", process.execPath, ...test])
  : await run(process.execPath, test);
process.exit(code);
