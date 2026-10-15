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
//
// Once the specs end, the run fails if it left anything outside its
// sandboxes: a process, a sandbox, a workspace in a real app's database, a
// worktree in a real build's folder (scripts/e2e-leaks.mjs). A process is
// killed and a sandbox deleted as they are reported.
import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
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
// Every sandbox the harness makes is written here, so what the run left
// behind can be told from other runs and from the user's own apps.
const runDir = mkdtempSync(path.join(tmpdir(), "crew-e2e-run-"));
process.env.CREW_E2E_RUN_LOG = path.join(runDir, "sandboxes");
const code = headless
  ? await run("xvfb-run", ["-a", "-s", "-screen 0 1920x1080x24", process.execPath, ...test])
  : await run(process.execPath, test);
const leaks = await checkLeaks();
rmSync(runDir, { recursive: true, force: true });
process.exit(code !== 0 ? code : leaks ? 1 : 0);

/** Reports and ends what the run left outside its sandboxes. True when there was any. */
async function checkLeaks() {
  const { findLeaks, sandboxesIn } = await import("./e2e-leaks.mjs");
  const { DatabaseSync } = await import("node:sqlite");
  const roots = sandboxesIn(existsSync(process.env.CREW_E2E_RUN_LOG) ? readFileSync(process.env.CREW_E2E_RUN_LOG, "utf8") : "");
  if (roots.length === 0) return false;
  // A daemon the run left may still be stopping on its own: give it a moment.
  const ps = () => execFileSync("ps", ["-axo", "pid=,command="], { encoding: "utf8" });
  const settle = Date.now() + 5000;
  const find = () =>
    findLeaks({
      roots,
      ps: ps(),
      home: homedir(),
      appSupport: path.join(homedir(), "Library", "Application Support"),
      keep: process.env.E2E_KEEP === "1",
      open: (file) => new DatabaseSync(file, { readOnly: true }),
    });
  let found = find();
  while (found.processes.length > 0 && Date.now() < settle) {
    await new Promise((resolve) => setTimeout(resolve, 250));
    found = find();
  }
  const { processes, sandboxes, elsewhere } = found;
  if (processes.length + sandboxes.length + elsewhere.length === 0) return false;
  console.error("\ne2e: the run left these outside its sandboxes:");
  for (const { pid, command } of processes) {
    console.error(`  process ${pid}: ${command.slice(0, 200)} (killed)`);
    try {
      process.kill(pid, "SIGKILL");
    } catch {}
  }
  for (const root of sandboxes) {
    console.error(`  sandbox ${root} (deleted)`);
    rmSync(root, { recursive: true, force: true });
  }
  for (const line of elsewhere) console.error(`  ${line}`);
  return true;
}
