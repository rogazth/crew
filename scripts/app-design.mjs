// The app on the seeded design profile, on a port of its own, so it runs next
// to a regular `npm run app` without sharing its data.
//
//   npm run app:design                              → seeds on first run, then opens the app
//   npm run app:design -- --reseed                  → wipes the profile and seeds it again
//   npm run app:design -- --missing=cursor,opencode → those CLIs read as not installed
//
// Next to the app it brings up what the seed cannot leave running
// (seed-live.json): devbox, a second crewd served the way a remote machine's
// is, and the crew workspace's process runs.
import { execFileSync, spawn } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import { createServer } from "node:net";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

const root = new URL("..", import.meta.url).pathname;
// A linked worktree keeps a design profile of its own and lets app.mjs take a free
// port, so it runs beside the main checkout's app:design instead of colliding on 1421.
const git = (...args) => resolve(root, execFileSync("git", ["rev-parse", ...args], { cwd: root, encoding: "utf8" }).trim());
const linked = git("--git-dir") !== git("--git-common-dir");
const data =
  process.env.CREW_USER_DATA ||
  (linked ? join(git("--show-toplevel"), ".crew-dev-design") : join(homedir(), "Library/Application Support/Crew Design"));
const env = { ...process.env, CREW_USER_DATA: data, CREW_KEEP_STATUS: "1" };
if (!linked) env.CREW_PORT ||= "1421";
// The seed's devbox takes 1431 in the main checkout, a free port in a worktree;
// seed-live.json keeps whichever it took for the runs after.
if (linked) env.CREW_DEVBOX_PORT ||= String(await freePort());

// Providers by id, as Settings names them; the daemon checks binaries.
const BINARIES = { claude: "claude", codex: "codex", cursor: "cursor-agent", opencode: "opencode", grok: "grok" };
const missing = process.argv.find((arg) => arg.startsWith("--missing="))?.slice("--missing=".length);
if (missing) env.CREW_MISSING_PROVIDERS = missing.split(",").map((id) => BINARIES[id.trim()] ?? id.trim()).join(",");

execFileSync("cargo", ["build", "-p", "crewd"], { cwd: root, stdio: "inherit" });
if (process.argv.includes("--reseed") || !existsSync(join(data, "crew.sqlite3"))) {
  execFileSync(process.execPath, [join(root, "scripts/seed.mjs")], { cwd: root, env, stdio: "inherit" });
}

const liveFile = join(data, "seed-live.json");
const live = existsSync(liveFile) ? JSON.parse(readFileSync(liveFile, "utf8")) : { machines: [], processes: [] };
const machines = live.machines.map(({ dir, listen }) =>
  spawn(join(root, "target/debug/crewd"), ["serve", `--listen=${listen}`, `--data-dir=${dir}`], { env, stdio: ["ignore", "ignore", "inherit"] }),
);

const launchedAt = Date.now();
const app = spawn(process.execPath, [join(root, "scripts/app.mjs")], { cwd: root, env, stdio: "inherit" });
app.on("exit", (code) => {
  for (const machine of machines) machine.kill("SIGTERM");
  process.exit(code ?? 0);
});
for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => app.kill(signal));

startRuns().catch((error) => console.warn(`app:design: the seeded processes did not start: ${error.message ?? error}`));

function freePort() {
  return new Promise((done, fail) => {
    const server = createServer().once("error", fail);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      server.close(() => done(port));
    });
  });
}

/** Starts the seeded process runs once the app's crewd is up, and stops the ones meant to read as stopped. */
async function startRuns() {
  if (live.processes.length === 0) return;
  const file = join(data, "daemon.json");
  const deadline = Date.now() + 90_000;
  while (!(existsSync(file) && statSync(file).mtimeMs >= launchedAt)) {
    if (Date.now() > deadline) throw new Error("crewd did not come up");
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  const { url, token } = JSON.parse(readFileSync(file, "utf8"));
  const socket = new WebSocket(url);
  await new Promise((resolve, reject) => {
    socket.addEventListener("open", resolve, { once: true });
    socket.addEventListener("error", reject, { once: true });
  });
  socket.send(JSON.stringify({ auth: token }));
  let nextId = 1;
  const pending = new Map();
  socket.addEventListener("message", (message) => {
    const parsed = JSON.parse(message.data);
    const call = pending.get(parsed.id);
    if (!call) return;
    pending.delete(parsed.id);
    parsed.ok ? call.resolve(parsed.result) : call.reject(new Error(parsed.error));
  });
  const rpc = (method, params) =>
    new Promise((resolve, reject) => {
      const id = nextId++;
      pending.set(id, { resolve, reject });
      socket.send(JSON.stringify({ id, method, params }));
    });
  const stops = live.processes.map(async ({ workspaceId, id, name, stopAfterMs }) => {
    try {
      await rpc("process_start", { workspaceId, id });
      if (stopAfterMs) {
        await new Promise((resolve) => setTimeout(resolve, stopAfterMs));
        await rpc("process_stop", { workspaceId, id });
      }
    } catch (error) {
      // Already running from before, or deleted since: the profile is the designer's to change.
      console.warn(`app:design: ${name}: ${error.message ?? error}`);
    }
  });
  await Promise.all(stops);
  socket.close();
}
